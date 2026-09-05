import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  hasProtectedSiblingOverlap,
  hasSafeCaptureGeometry,
  hasSourceAriaControlledRegionAncestor,
  ImageSourceSession,
  nearestValidElementLanguage,
  readDirectImageAccessibilityText,
} from '../lib/ocr/image-source-session';
import { normalizeAccessibilityImageText } from '../lib/ocr/accessibility-image-text';
import type { SourceImageDescriptor } from '../lib/ocr/contracts';
import { createImageSourcePortName } from '../lib/ocr/image-source-protocol';
import { SourceImageObserver } from '../lib/ocr/source-image-observer';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';
import { createSourceControlledContentPolicy } from '../lib/replica/source-privacy-policy';
import { sourceDocumentSecretClassifier } from '../lib/replica/source-secret-classifier';

const baseStyle = {
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  contentVisibility: 'visible',
  clipPath: 'none',
  maskImage: 'none',
  perspective: 'none',
  rotate: 'none',
  transform: 'none',
  overflowX: 'visible',
  overflowY: 'visible',
} as unknown as CSSStyleDeclaration;

describe('image source capture safety', () => {
  it('reports content-free initial candidate and observed image counts', () => {
    const { document, window } = parseHTML(
      '<html><body><img id="tracked"><button><img id="private"></button></body></html>',
    );
    const tracked = document.querySelector<HTMLImageElement>('#tracked')!;
    const privateImage = document.querySelector<HTMLImageElement>('#private')!;
    setImageFacts(tracked);
    setImageFacts(privateImage);
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'image-ready-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'image-ready-document',
      frameId: 0,
    };
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const session = new ImageSourceSession({
      port,
      document: document as unknown as Document,
      window: window as unknown as Window,
      resolveNode: () => null,
      getNodeId: (image) => image === tracked ? 7 : 9,
      createObserver: (environment) => new SourceImageObserver({
        ...environment,
        createIntersectionObserver: () => new NoopElementObserver(),
        createResizeObserver: () => new NoopElementObserver(),
        createMutationObserver: () => new NoopMutationObserver(),
      }),
    });

    port.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: identity,
    });

    expect(port.messages.at(-1)).toEqual({
      kind: 'simul:image-source-v2:ready',
      document: identity,
      summary: { candidateImages: 2, observedImages: 1 },
    });
    expect(JSON.stringify(port.messages.at(-1))).not.toMatch(
      /(?:src|url|pixels|text|hash|nodeId)/iu,
    );
    session.dispose();
  });

  it('refreshes only the requested image before validating its descriptor', () => {
    const { document, window } = parseHTML(
      '<html><body>' +
      '<img id="target"><img id="peer">' +
      '</body></html>',
    );
    const target = document.querySelector<HTMLImageElement>('#target')!;
    const peer = document.querySelector<HTMLImageElement>('#peer')!;
    setImageFacts(target);
    setImageFacts(peer);
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'targeted-image-refresh-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'targeted-image-refresh-document',
      frameId: 0,
    };
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    let globalRefreshes = 0;
    const session = new ImageSourceSession({
      port,
      document: document as unknown as Document,
      window: window as unknown as Window,
      resolveNode: (nodeId) => nodeId === 7 ? target : nodeId === 9 ? peer : null,
      getNodeId: (image) => image === target ? 7 : image === peer ? 9 : undefined,
      createObserver: (environment) => {
        const beforeRefreshAll = environment.beforeRefreshAll;
        return new SourceImageObserver({
          ...environment,
          beforeRefreshAll: () => {
            globalRefreshes += 1;
            beforeRefreshAll?.();
          },
          createIntersectionObserver: (callback) =>
            new ImmediateIntersectionObserver(callback),
          createResizeObserver: () => new NoopElementObserver(),
          createMutationObserver: () => new NoopMutationObserver(),
        });
      },
    });

    port.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: identity,
    });
    const initialTarget = lastUpsertDescriptorForNode(port.messages, 7)!;
    const initialPeer = lastUpsertDescriptorForNode(port.messages, 9)!;
    expect(initialTarget).toBeDefined();
    expect(initialPeer).toBeDefined();
    const refreshesAfterStart = globalRefreshes;
    const messagesBeforeRequest = port.messages.length;

    target.setAttribute('alt', 'Second label');
    port.emitMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'targeted-stale-measure',
      descriptor: initialTarget,
    });

    expect(globalRefreshes).toBe(refreshesAfterStart);
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:metrics',
      requestId: 'targeted-stale-measure',
      status: 'stale',
    });
    expect(lastUpsertDescriptorForNode(
      port.messages.slice(messagesBeforeRequest),
      7,
    )?.contentRevision).toBeGreaterThan(initialTarget.contentRevision);
    expect(lastUpsertDescriptorForNode(
      port.messages.slice(messagesBeforeRequest),
      9,
    )).toBeUndefined();
    expect(lastUpsertDescriptorForNode(port.messages, 9)).toEqual(initialPeer);
    session.dispose();
  });

  it('keeps credential ancestry sticky across image Port reconnects', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="secret" autocomplete="one-time-code">' +
      '<img id="image"></div></body></html>',
    );
    const image = document.querySelector<HTMLImageElement>('#image')!;
    const secret = document.querySelector('#secret')!;
    setImageFacts(image);
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'sticky-image-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'sticky-image-document',
      frameId: 0,
    };
    const startSession = (): {
      readonly port: FakeImageSourcePort;
      readonly session: ImageSourceSession;
    } => {
      const port = new FakeImageSourcePort(
        createImageSourcePortName(identity.sessionId),
      );
      const session = new ImageSourceSession({
        port,
        document: document as unknown as Document,
        window: window as unknown as Window,
        resolveNode: () => image,
        getNodeId: () => 7,
        createObserver: (environment) => new SourceImageObserver({
          ...environment,
          createIntersectionObserver: () => new NoopElementObserver(),
          createResizeObserver: () => new NoopElementObserver(),
          createMutationObserver: () => new NoopMutationObserver(),
        }),
      });
      port.emitMessage({
        kind: 'simul:image-source-v2:start',
        document: identity,
      });
      return { port, session };
    };

    const first = startSession();
    expect(first.port.messages.at(-1)).toMatchObject({
      summary: { candidateImages: 1, observedImages: 0 },
    });
    first.session.dispose();

    secret.removeAttribute('autocomplete');
    const second = startSession();
    expect(second.port.messages.at(-1)).toMatchObject({
      summary: { candidateImages: 1, observedImages: 0 },
    });
    second.session.dispose();
  });

  it('does not touch image labels or pixels when computed security is unreadable', () => {
    const { document, window } = parseHTML(
      '<html><body><img id="image" alt="must stay unread"></body></html>',
    );
    const image = document.querySelector<HTMLImageElement>('#image')!;
    setImageFacts(image);
    let altReads = 0;
    let pixelReads = 0;
    const getAttribute = image.getAttribute.bind(image);
    Object.defineProperty(image, 'getAttribute', {
      configurable: true,
      value: (name: string) => {
        if (name.toLowerCase() === 'alt' || name.toLowerCase() === 'aria-label') {
          altReads += 1;
        }
        return getAttribute(name);
      },
    });
    Object.defineProperty(image, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        pixelReads += 1;
        return rect(0, 0, 100, 40);
      },
    });
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: () => {
        throw new Error('computed security unavailable');
      },
    });
    const targetIdentity: ReplicaSourceDocumentIdentity = {
      sessionId: 'unreadable-image-security-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'unreadable-image-security-document',
      frameId: 0,
    };
    const port = new FakeImageSourcePort(
      createImageSourcePortName(targetIdentity.sessionId),
    );
    const session = new ImageSourceSession({
      port,
      document: document as unknown as Document,
      window: window as unknown as Window,
      resolveNode: () => image,
      getNodeId: () => 7,
      createObserver: (environment) => new SourceImageObserver({
        ...environment,
        createIntersectionObserver: (callback) =>
          new ImmediateIntersectionObserver(callback),
        createResizeObserver: () => new NoopElementObserver(),
        createMutationObserver: () => new NoopMutationObserver(),
      }),
    });

    port.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: targetIdentity,
      policyFingerprint: 'read-v1-111111',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    Reflect.deleteProperty(window, 'getComputedStyle');

    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:ready',
      summary: { candidateImages: 1, observedImages: 0 },
    });
    expect(altReads).toBe(0);
    expect(pixelReads).toBe(0);
    session.dispose();
  });

  it('skips an invalid closest lang and uses the nearest valid ancestor', () => {
    const { document } = parseHTML(
      '<html lang="ja"><body><section lang="not-a-language"><img></section></body></html>',
    );
    expect(nearestValidElementLanguage(document.querySelector('img')!)).toBe('ja');
  });

  it('rejects decorative and aria-hidden image accessibility evidence', () => {
    const { document } = parseHTML(
      '<html><body>' +
      '<img id="none" role="none" alt="Hidden label">' +
      '<img id="presentation" role="presentation" aria-label="Hidden label">' +
      '<img id="hidden" aria-hidden="true" alt="Hidden label">' +
      '<div aria-hidden="true"><img id="ancestor-hidden" alt="Hidden label"></div>' +
      '</body></html>',
    );
    expect(readDirectImageAccessibilityText(
      document.querySelector<HTMLImageElement>('#none')!,
    )).toBeUndefined();
    expect(readDirectImageAccessibilityText(
      document.querySelector<HTMLImageElement>('#presentation')!,
    )).toBeUndefined();
    expect(readDirectImageAccessibilityText(
      document.querySelector<HTMLImageElement>('#hidden')!,
    )).toBeUndefined();
    expect(readDirectImageAccessibilityText(
      document.querySelector<HTMLImageElement>('#ancestor-hidden')!,
    )).toBeUndefined();
  });

  it('rejects URL/file-only labels at both normalization and DOM read boundaries', () => {
    const rejected = [
      '/assets/logo.svg?rev=1',
      './assets/logo.svg',
      'assets/logo.svg?rev=1',
      'www.example.com/logo.png',
      'file:///tmp/a.png',
      '//host.example/a.jpg',
      'chrome-extension://extension-id/a.webp',
      'logo.gif#current',
    ];
    for (const value of rejected) {
      expect(normalizeAccessibilityImageText(value)).toBeUndefined();
    }
    expect(normalizeAccessibilityImageText('Open / close menu'))
      .toBe('Open / close menu');
    expect(normalizeAccessibilityImageText('Visit www.example.com for news'))
      .toBe('Visit www.example.com for news');

    const { document } = parseHTML(
      '<html><body><img alt="assets/logo.svg?rev=1"></body></html>',
    );
    expect(readDirectImageAccessibilityText(
      document.querySelector<HTMLImageElement>('img')!,
    )).toBeUndefined();
  });

  it('treats images in aria-controls targets as control images', () => {
    const { document } = parseHTML(
      '<html><body><button aria-controls="panel">Open</button>' +
      '<div id="panel" role="dialog"><img id="image" alt="Details"></div>' +
      '</body></html>',
    );
    const image = document.querySelector<HTMLImageElement>('#image')!;
    expect(hasSourceAriaControlledRegionAncestor(image)).toBe(true);
    document.querySelector('button')!.removeAttribute('aria-controls');
    expect(hasSourceAriaControlledRegionAncestor(image)).toBe(false);
  });

  it('uses bounded shared aria-controls rules for duplicate, cyclic, and cross-root targets', () => {
    const { document } = parseHTML(
      '<html><body>' +
      '<button aria-controls="duplicate">Duplicate</button>' +
      '<div id="duplicate"><img id="first"></div>' +
      '<div id="duplicate"><img id="second"></div>' +
      '<div id="cycle-a" aria-controls="cycle-b">' +
      '<div id="cycle-b" aria-controls="cycle-a"><img id="cycle"></div>' +
      '</div><button id="shadow-trigger" aria-controls="shadow-panel">Shadow</button>' +
      '<div id="host"></div><img id="unrelated"></body></html>',
    );
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    // linkedom does not currently expose ShadowRoot.mode, while browsers do.
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    shadow.innerHTML = '<div id="shadow-panel"><img id="shadow-image"></div>';
    const policy = createSourceControlledContentPolicy(
      document as unknown as Document,
      document.defaultView as unknown as Window,
    );

    expect(hasSourceAriaControlledRegionAncestor(
      document.querySelector<HTMLImageElement>('#first')!,
      policy,
    )).toBe(true);
    expect(hasSourceAriaControlledRegionAncestor(
      document.querySelector<HTMLImageElement>('#second')!,
      policy,
    )).toBe(true);
    expect(hasSourceAriaControlledRegionAncestor(
      document.querySelector<HTMLImageElement>('#cycle')!,
      policy,
    )).toBe(true);
    expect(hasSourceAriaControlledRegionAncestor(
      shadow.querySelector<HTMLImageElement>('#shadow-image')!,
      policy,
    )).toBe(true);
    expect(hasSourceAriaControlledRegionAncestor(
      document.querySelector<HTMLImageElement>('#unrelated')!,
      policy,
    )).toBe(false);

    const overflow = createSourceControlledContentPolicy(
      document as unknown as Document,
      document.defaultView as unknown as Window,
      1,
    );
    expect(overflow.overflow).toBe(true);
    expect(hasSourceAriaControlledRegionAncestor(
      document.querySelector<HTMLImageElement>('#unrelated')!,
      overflow,
    )).toBe(true);
  });

  it('refreshes tab image admission before A to B to A mutation reads', () => {
    const { document, window } = parseHTML(
      '<html><body>' +
      '<div id="tab-a" role="tab" aria-selected="true" aria-expanded="true" ' +
      'aria-controls="panel-a">A</div>' +
      '<div id="tab-b" role="tab" aria-selected="false" aria-expanded="false" ' +
      'aria-controls="panel-b">B</div>' +
      '<section id="panel-a" role="tabpanel"><img id="image-a" alt="A image"></section>' +
      '<section id="panel-b" role="tabpanel" hidden><img id="image-b" alt="B image"></section>' +
      '<section id="carousel"><img id="carousel-image" alt="Carousel"></section>' +
      '</body></html>',
    );
    const tabA = document.querySelector('#tab-a')!;
    const tabB = document.querySelector('#tab-b')!;
    const panelA = document.querySelector('#panel-a')!;
    const panelB = document.querySelector('#panel-b')!;
    const carousel = document.querySelector('#carousel')!;
    const imageA = document.querySelector<HTMLImageElement>('#image-a')!;
    const imageB = document.querySelector<HTMLImageElement>('#image-b')!;
    const carouselImage = document.querySelector<HTMLImageElement>(
      '#carousel-image',
    )!;
    for (const image of [imageA, imageB, carouselImage]) setImageFacts(image);
    for (const element of [
      document.documentElement,
      document.body,
      tabA,
      tabB,
      panelA,
      panelB,
    ]) setPaintFacts(element);
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 800 },
      innerHeight: { configurable: true, value: 600 },
      scrollX: { configurable: true, value: 0 },
      scrollY: { configurable: true, value: 0 },
      devicePixelRatio: { configurable: true, value: 1 },
    });
    let controlledStyleReads = 0;
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        if ([tabA, tabB, panelA, panelB].includes(element)) {
          controlledStyleReads += 1;
        }
        const hidden = element.hasAttribute('hidden');
        return {
          ...baseStyle,
          display: hidden ? 'none' : 'block',
          getPropertyValue: (name: string) => {
            if (name === 'content-visibility') return 'visible';
            if (name === 'clip' || name === 'clip-path') return 'none';
            if (name === 'overflow-x' || name === 'overflow-y') return 'visible';
            return '';
          },
        } as unknown as CSSStyleDeclaration;
      },
    });
    const readsA = observeImageContentReads(imageA);
    const readsB = observeImageContentReads(imageB);
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'controlled-image-transition-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'controlled-image-transition-document',
      frameId: 0,
    };
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const mutation = new NoopMutationObserver();
    const nodeIds = new Map<HTMLImageElement, number>([
      [imageA, 7],
      [imageB, 9],
      [carouselImage, 11],
    ]);
    const session = new ImageSourceSession({
      port,
      document: document as unknown as Document,
      window: window as unknown as Window,
      resolveNode: (nodeId) =>
        [...nodeIds].find(([, id]) => id === nodeId)?.[0] ?? null,
      getNodeId: (image) => nodeIds.get(image),
      createObserver: (environment) => new SourceImageObserver({
        ...environment,
        createIntersectionObserver: (callback) =>
          new ImmediateIntersectionObserver(callback),
        createResizeObserver: () => new NoopElementObserver(),
        createMutationObserver: (callback) => {
          mutation.callback = callback;
          return mutation;
        },
      }),
    });

    port.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: identity,
      policyFingerprint: 'read-v1-101000',
      controlImages: false,
      accessibilityTextEnabled: true,
    });
    const initialDescriptorA = lastUpsertDescriptorForNode(port.messages, 7)!;
    expect(initialDescriptorA).toBeDefined();
    expect(lastUpsertDescriptorForNode(port.messages, 9)).toBeUndefined();
    expect(lastUpsertDescriptorForNode(port.messages, 11)).toBeDefined();

    readsA.reset();
    readsB.reset();
    const beforeAtoB = port.messages.length;
    setTabSelection(tabA, panelA, false);
    setTabSelection(tabB, panelB, true);
    mutation.trigger([
      mutationAttributeRecord(tabA, 'aria-selected'),
      mutationAttributeRecord(tabA, 'aria-expanded'),
      mutationAttributeRecord(tabB, 'aria-selected'),
      mutationAttributeRecord(tabB, 'aria-expanded'),
      mutationAttributeRecord(panelA, 'hidden'),
      mutationAttributeRecord(panelB, 'hidden'),
    ]);

    expect(readsA.snapshot()).toEqual({ label: 0, geometry: 0 });
    expect(readsB.snapshot().label).toBeGreaterThan(0);
    expect(readsB.snapshot().geometry).toBeGreaterThan(0);
    expect(port.messages.slice(beforeAtoB)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'simul:image-source-v2:change',
        change: expect.objectContaining({ kind: 'remove', nodeId: 7 }),
      }),
      expect.objectContaining({
        kind: 'simul:image-source-v2:change',
        change: expect.objectContaining({
          kind: 'upsert',
          descriptor: expect.objectContaining({ nodeId: 9 }),
        }),
      }),
    ]));

    readsA.reset();
    port.emitMessage({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'inactive-a',
      descriptor: initialDescriptorA,
      policyFingerprint: 'read-v1-101000',
      controlImages: false,
    });
    expect(port.messages.at(-1)).toMatchObject({
      requestId: 'inactive-a',
      status: 'stale',
    });
    expect(readsA.snapshot()).toEqual({ label: 0, geometry: 0 });

    const controlledReadsBeforeCarouselChurn = controlledStyleReads;
    carousel.classList.add('moving');
    mutation.trigger([mutationAttributeRecord(carousel, 'class')]);
    // The carousel already contains an image, but its class remains arbitrary
    // CSS selector surface for remote controlled panels. One global,
    // content-free proof is required even when no descriptor ultimately
    // changes.
    expect(controlledStyleReads).toBeGreaterThan(
      controlledReadsBeforeCarouselChurn,
    );

    readsA.reset();
    readsB.reset();
    const beforeBtoA = port.messages.length;
    setTabSelection(tabA, panelA, true);
    setTabSelection(tabB, panelB, false);
    mutation.trigger([
      mutationAttributeRecord(tabA, 'aria-selected'),
      mutationAttributeRecord(tabA, 'aria-expanded'),
      mutationAttributeRecord(tabB, 'aria-selected'),
      mutationAttributeRecord(tabB, 'aria-expanded'),
      mutationAttributeRecord(panelA, 'hidden'),
      mutationAttributeRecord(panelB, 'hidden'),
    ]);

    expect(readsB.snapshot()).toEqual({ label: 0, geometry: 0 });
    expect(readsA.snapshot().label).toBeGreaterThan(0);
    expect(readsA.snapshot().geometry).toBeGreaterThan(0);
    expect(port.messages.slice(beforeBtoA)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'simul:image-source-v2:change',
        change: expect.objectContaining({ kind: 'remove', nodeId: 9 }),
      }),
      expect.objectContaining({
        kind: 'simul:image-source-v2:change',
        change: expect.objectContaining({
          kind: 'upsert',
          descriptor: expect.objectContaining({ nodeId: 7 }),
        }),
      }),
    ]));
    session.dispose();
  });

  it('coalesces relationship-selector reproof when control images are enabled', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="controller" aria-controls="panel"></div>' +
      '<section id="panel"><img id="image" alt="Public control image"></section>' +
      '</body></html>',
    );
    const controller = document.querySelector('#controller')!;
    const panel = document.querySelector('#panel')!;
    const image = document.querySelector<HTMLImageElement>('#image')!;
    setImageFacts(image);
    const reads = observeImageContentReads(image);
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'enabled-control-image-mutation-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'enabled-control-image-mutation-document',
      frameId: 0,
    };
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const mutation = new NoopMutationObserver();
    const session = new ImageSourceSession({
      port,
      document: document as unknown as Document,
      window: window as unknown as Window,
      resolveNode: (nodeId) => nodeId === 7 ? image : null,
      getNodeId: (candidate) => candidate === image ? 7 : undefined,
      createObserver: (environment) => new SourceImageObserver({
        ...environment,
        createIntersectionObserver: (callback) =>
          new ImmediateIntersectionObserver(callback),
        createResizeObserver: () => new NoopElementObserver(),
        createMutationObserver: (callback) => {
          mutation.callback = callback;
          return mutation;
        },
      }),
    });
    port.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: identity,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    expect(lastUpsertDescriptorForNode(port.messages, 7)).toBeDefined();

    reads.reset();
    const messagesBeforeMutation = port.messages.length;
    controller.setAttribute('aria-controls', 'renamed-panel');
    panel.setAttribute('id', 'renamed-panel');
    mutation.trigger([
      mutationAttributeRecord(controller, 'aria-controls'),
      mutationAttributeRecord(panel, 'id'),
    ]);

    expect(reads.snapshot().label).toBeGreaterThan(0);
    expect(reads.snapshot().geometry).toBeGreaterThan(0);
    expect(port.messages).toHaveLength(messagesBeforeMutation);
    session.dispose();
  });

  it('reads direct navigation-image alt text without pixels under the bound policy', () => {
    const { document } = parseHTML(
      '<html lang="ja"><body><a href="/oshirase/"><img id="image" ' +
      'src="/pc/images/gnav-news2.gif" width="136" height="70" ' +
      'alt="お知らせ"></a></body></html>',
    );
    const image = document.querySelector<HTMLImageElement>('#image')!;
    setImageFacts(image);
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'image-accessibility-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'image-accessibility-document',
      frameId: 0,
    };
    const createSession = (
      targetPort: FakeImageSourcePort,
      targetIdentity: ReplicaSourceDocumentIdentity,
    ) => new ImageSourceSession({
      port: targetPort,
      document: document as unknown as Document,
      window: {
        innerWidth: 800,
        innerHeight: 600,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        getComputedStyle: () => baseStyle,
      } as unknown as Window,
      resolveNode: (nodeId) => nodeId === 7 ? image : null,
      getNodeId: () => 7,
      createObserver: (environment) => new SourceImageObserver({
        ...environment,
        documentIdentity: targetIdentity,
        createIntersectionObserver: (callback) =>
          new ImmediateIntersectionObserver(callback),
        createResizeObserver: () => new NoopElementObserver(),
        createMutationObserver: () => new NoopMutationObserver(),
      }),
    });
    const blockedIdentity = {
      ...identity,
      sessionId: 'control-image-blocked-session',
      documentId: 'control-image-blocked-document',
    };
    const blockedPort = new FakeImageSourcePort(
      createImageSourcePortName(blockedIdentity.sessionId),
    );
    const blockedSession = createSession(blockedPort, blockedIdentity);
    blockedPort.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: blockedIdentity,
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
      accessibilityTextEnabled: true,
    });
    expect(blockedPort.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:ready',
      summary: { candidateImages: 1, observedImages: 0 },
    });
    blockedSession.dispose();
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const session = createSession(port, identity);
    port.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: identity,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    const sourceDescriptor = lastUpsertDescriptor(port.messages)!;
    port.emitMessage({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'alt-ready',
      descriptor: sourceDescriptor,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'alt-ready',
      status: 'ready',
      evidence: {
        text: 'お知らせ',
        source: 'alt',
        nearestElementLanguage: 'ja',
      },
    });
    port.emitMessage({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'alt-forged-policy',
      descriptor: sourceDescriptor,
      policyFingerprint: 'read-v1-011000',
      controlImages: true,
    });
    expect(port.messages.at(-1)).toMatchObject({
      requestId: 'alt-forged-policy',
      status: 'blocked',
    });
    session.dispose();
  });

  it('blocks accessibility evidence painted under an unrelated sibling control', () => {
    const { document } = parseHTML(
      '<html><body><img id="image" alt="Public label">' +
      '<input id="overlap" autocomplete="one-time-code"></body></html>',
    );
    const image = document.querySelector<HTMLImageElement>('#image')!;
    const overlap = document.querySelector<HTMLInputElement>('#overlap')!;
    setImageFacts(image);
    Object.defineProperty(overlap, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(20, 20, 80, 30),
    });
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'overlap-accessibility-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'overlap-accessibility-document',
      frameId: 0,
    };
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const session = new ImageSourceSession({
      port,
      document: document as unknown as Document,
      window: {
        innerWidth: 800,
        innerHeight: 600,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        getComputedStyle: () => baseStyle,
      } as unknown as Window,
      resolveNode: (nodeId) => nodeId === 7 ? image : null,
      getNodeId: () => 7,
      createObserver: (environment) => new SourceImageObserver({
        ...environment,
        createIntersectionObserver: (callback) =>
          new ImmediateIntersectionObserver(callback),
        createResizeObserver: () => new NoopElementObserver(),
        createMutationObserver: () => new NoopMutationObserver(),
      }),
    });
    port.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: identity,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    const sourceDescriptor = lastUpsertDescriptor(port.messages)!;
    port.emitMessage({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'overlapped-alt',
      descriptor: sourceDescriptor,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'overlapped-alt',
      status: 'blocked',
    });
    session.dispose();
  });

  it('gates non-activation control accessibility and pixels together', () => {
    const { document } = parseHTML(
      '<html><body><div role="textbox"><img id="image" alt="Open"></div></body></html>',
    );
    const image = document.querySelector<HTMLImageElement>('#image')!;
    setImageFacts(image);
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'control-image-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'control-image-document',
      frameId: 0,
    };
    const createSession = (
      targetPort: FakeImageSourcePort,
      targetIdentity: ReplicaSourceDocumentIdentity,
    ) => new ImageSourceSession({
      port: targetPort,
      document: document as unknown as Document,
      window: {
        innerWidth: 800,
        innerHeight: 600,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        getComputedStyle: () => baseStyle,
      } as unknown as Window,
      resolveNode: (nodeId) => nodeId === 7 ? image : null,
      getNodeId: () => 7,
      createObserver: (environment) => new SourceImageObserver({
        ...environment,
        documentIdentity: targetIdentity,
        createIntersectionObserver: (callback) =>
          new ImmediateIntersectionObserver(callback),
        createResizeObserver: () => new NoopElementObserver(),
        createMutationObserver: () => new NoopMutationObserver(),
      }),
    });
    const blockedIdentity = {
      ...identity,
      sessionId: 'control-image-disabled-session',
      documentId: 'control-image-disabled-document',
    };
    const blockedPort = new FakeImageSourcePort(
      createImageSourcePortName(blockedIdentity.sessionId),
    );
    const blockedSession = createSession(blockedPort, blockedIdentity);
    blockedPort.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: blockedIdentity,
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
      accessibilityTextEnabled: true,
    });
    expect(blockedPort.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:ready',
      summary: { candidateImages: 1, observedImages: 0 },
    });
    blockedSession.dispose();
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const session = createSession(port, identity);

    port.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: identity,
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    const sourceDescriptor = lastUpsertDescriptor(port.messages)!;
    port.emitMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'measure-control-image',
      descriptor: sourceDescriptor,
    });

    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:metrics',
      requestId: 'measure-control-image',
      status: 'ready',
    });
    port.emitMessage({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'read-control-image',
      descriptor: sourceDescriptor,
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'read-control-image',
      status: 'ready',
      evidence: { text: 'Open' },
    });
    session.dispose();
  });

  it('keeps a policy-approved navigation image measurable as control metadata changes', () => {
    const { document } = parseHTML(
      '<html><head><base href="https://page.example/root/"></head><body>' +
      '<a id="navigation" href="/news" role="button"><img id="image"></a>' +
      '</body></html>',
    );
    const image = document.querySelector<HTMLImageElement>('#image')!;
    const navigation = document.querySelector('#navigation')!;
    setImageFacts(image);
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'public-navigation-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'public-navigation-document',
      frameId: 0,
    };
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const sourceWindow = {
      innerWidth: 800,
      innerHeight: 600,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      getComputedStyle: () => baseStyle,
    } as unknown as Window;
    const session = new ImageSourceSession({
      port,
      document: document as unknown as Document,
      window: sourceWindow,
      resolveNode: (nodeId) => nodeId === 7 ? image : null,
      getNodeId: (candidate) => candidate === image ? 7 : undefined,
      createObserver: (environment) => new SourceImageObserver({
        ...environment,
        createIntersectionObserver: (callback) =>
          new ImmediateIntersectionObserver(callback),
        createResizeObserver: () => new NoopElementObserver(),
        createMutationObserver: () => new NoopMutationObserver(),
      }),
    });

    port.emitMessage({
      kind: 'simul:image-source-v2:start',
      document: identity,
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
      accessibilityTextEnabled: false,
    });
    const firstDescriptor = lastUpsertDescriptor(port.messages);
    expect(firstDescriptor).toBeDefined();
    port.emitMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'measure-public',
      descriptor: firstDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:metrics',
      requestId: 'measure-public',
      status: 'ready',
    });

    navigation.removeAttribute('href');
    port.emitMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'measure-without-href',
      descriptor: firstDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:metrics',
      requestId: 'measure-without-href',
      status: 'ready',
    });

    navigation.setAttribute('href', '/restored');
    port.emitMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'measure-old-revision',
      descriptor: firstDescriptor,
    });
    const restoredDescriptor = lastUpsertDescriptor(port.messages);
    expect(restoredDescriptor).toEqual(firstDescriptor);
    port.emitMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'measure-restored',
      descriptor: restoredDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:metrics',
      requestId: 'measure-restored',
      status: 'ready',
    });

    navigation.setAttribute('aria-expanded', 'false');
    port.emitMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'measure-stateful',
      descriptor: restoredDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:metrics',
      requestId: 'measure-stateful',
      status: 'ready',
    });

    navigation.removeAttribute('aria-expanded');
    port.emitMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'measure-stateful-old-revision',
      descriptor: restoredDescriptor,
    });
    const statelessDescriptor = lastUpsertDescriptor(port.messages);
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:metrics',
      requestId: 'measure-stateful-old-revision',
      status: 'ready',
    });
    port.emitMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'measure-stateless-restored',
      descriptor: statelessDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v2:metrics',
      requestId: 'measure-stateless-restored',
      status: 'ready',
    });
    session.dispose();
  });

  it('rejects hidden, rotated, and secret-control-overlapped pixels but allows public controls', () => {
    const { document } = parseHTML(
      '<html><body><img id="image"><input id="private">' +
      '<input id="public" type="search"><button id="button">Go</button>' +
      '</body></html>',
    );
    const image = document.querySelector('#image')! as unknown as HTMLImageElement;
    const control = document.querySelector('#private')!;
    const publicControl = document.querySelector('#public')!;
    const button = document.querySelector('#button')!;
    const imageRect = rect(10, 10, 200, 100);
    Object.defineProperty(image, 'getBoundingClientRect', {
      value: () => imageRect,
    });
    Object.defineProperty(control, 'getBoundingClientRect', {
      value: () => rect(50, 30, 80, 30),
    });
    Object.defineProperty(publicControl, 'getBoundingClientRect', {
      value: () => rect(120, 40, 60, 20),
    });
    Object.defineProperty(button, 'getBoundingClientRect', {
      value: () => rect(20, 80, 60, 20),
    });
    const styles = new Map<Element, CSSStyleDeclaration>();
    const sourceWindow = {
      getComputedStyle: (element: Element) => styles.get(element) ?? baseStyle,
    } as unknown as Window;

    // Public text controls and buttons may overlap: their text is already
    // readable in the replica, so their pixels expose nothing new.
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(true);
    // A password control overlapping the image blocks capture regardless of
    // the control-images switch.
    control.setAttribute('type', 'password');
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(false);
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
      { allowControlImages: true },
    )).toBe(false);

    control.remove();
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(true);
    styles.set(image, { ...baseStyle, visibility: 'hidden' });
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(false);

    styles.set(image, { ...baseStyle, transform: 'matrix(0, 1, -1, 0, 0, 0)' });
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(false);

    styles.set(image, baseStyle);
    styles.set(document.body, {
      ...baseStyle,
      transform: 'matrix3d(-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)',
    });
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(false);

    styles.delete(document.body);
    styles.set(image, {
      ...baseStyle,
      transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 10, 0, 1)',
    });
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(true);
  });

  it('allows a separate overlapping public navigation button', () => {
    const { document } = parseHTML(
      '<html><head><base href="https://page.example/"></head><body>' +
      '<img id="image"><a id="overlap" href="/news" role="button">News</a>' +
      '</body></html>',
    );
    const image = document.querySelector('#image')! as unknown as HTMLImageElement;
    const overlap = document.querySelector('#overlap')!;
    const imageRect = rect(10, 10, 200, 100);
    Object.defineProperty(image, 'getBoundingClientRect', {
      value: () => imageRect,
    });
    Object.defineProperty(overlap, 'getBoundingClientRect', {
      value: () => rect(50, 30, 80, 30),
    });
    const sourceWindow = {
      getComputedStyle: () => baseStyle,
    } as unknown as Window;

    // Only credential-secret overlaps block capture; a public link or button
    // is ordinary page text. Its painted label is handled by the text-cover
    // hit test, not by the overlap rule.
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(true);
  });

  it('blocks payment-card and one-time-code control overlaps under every profile', () => {
    for (const markup of [
      '<input id="overlap" autocomplete="cc-number">',
      '<input id="overlap" type="text" autocomplete="one-time-code">',
      '<input id="overlap" type="file">',
    ]) {
      const { document } = parseHTML(
        `<html><body><img id="image">${markup}</body></html>`,
      );
      const image = document.querySelector('#image')! as unknown as HTMLImageElement;
      const overlap = document.querySelector('#overlap')!;
      const imageRect = rect(10, 10, 200, 100);
      Object.defineProperty(image, 'getBoundingClientRect', {
        value: () => imageRect,
      });
      Object.defineProperty(overlap, 'getBoundingClientRect', {
        value: () => rect(50, 30, 80, 30),
      });
      const sourceWindow = {
        getComputedStyle: () => baseStyle,
      } as unknown as Window;
      expect(hasSafeCaptureGeometry(
        image,
        imageRect,
        document as unknown as Document,
        sourceWindow,
        { allowControlImages: true },
      )).toBe(false);
    }
  });

  it('blocks a generic painted secret overlay and keeps its decision sticky', () => {
    const { document } = parseHTML(
      '<html><body><img id="image">' +
      '<div id="overlay" autocomplete="one-time-code"></div></body></html>',
    );
    const image = document.querySelector('#image')! as unknown as HTMLImageElement;
    const overlay = document.querySelector('#overlay')!;
    const imageRect = rect(10, 10, 200, 100);
    Object.defineProperty(image, 'getBoundingClientRect', {
      value: () => imageRect,
    });
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      value: () => rect(40, 25, 100, 40),
    });
    const sourceWindow = {
      getComputedStyle: () => baseStyle,
    } as unknown as Window;
    Object.defineProperty(document, 'defaultView', {
      configurable: true,
      value: sourceWindow,
    });
    const classifier = sourceDocumentSecretClassifier(document);
    const isSecret = (element: Element) =>
      // Exercise the exact document-lifetime classifier used by the session.
      element.ownerDocument === document &&
      (element === overlay
        ? classifier.classify(element, {
            tagName: element.localName,
            autocomplete: element.getAttribute('autocomplete') ?? undefined,
          }) === 'secret'
        : false);

    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
      { isSecret },
    )).toBe(false);

    overlay.removeAttribute('autocomplete');
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
      { isSecret },
    )).toBe(false);
  });

  it('never treats a shadow host or its ancestors as a foreign overlay over the hosted image', () => {
    const { document } = parseHTML(
      '<html><body><section id="wrapper"><div id="host"></div>' +
      '<div id="overlay"></div></section></body></html>',
    );
    const host = document.querySelector('#host')!;
    const wrapper = document.querySelector('#wrapper')!;
    const overlay = document.querySelector('#overlay')!;
    const shadow = host.attachShadow({ mode: 'open' });
    // linkedom does not currently expose ShadowRoot.mode, while browsers do.
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    shadow.innerHTML = '<img id="image">';
    const image = shadow.querySelector('#image')! as unknown as HTMLImageElement;
    const imageRect = rect(10, 10, 200, 100);
    for (const element of [image, host, wrapper]) {
      Object.defineProperty(element, 'getBoundingClientRect', {
        value: () => imageRect,
      });
    }
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      value: () => rect(40, 25, 100, 40),
    });
    const sourceWindow = {
      getComputedStyle: () => baseStyle,
    } as unknown as Window;
    const flagged = new Set<Element>([host, wrapper]);
    const isSecret = (element: Element) => flagged.has(element);

    // The host and its ancestors are the image's own composed ancestry, not
    // elements painted over it, even though Element.contains() cannot see
    // through the shadow boundary.
    expect(host.contains(image)).toBe(false);
    expect(hasProtectedSiblingOverlap(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
      isSecret,
    )).toBe(false);

    // A genuinely foreign secret element painted over the image still blocks.
    flagged.add(overlay);
    expect(hasProtectedSiblingOverlap(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
      isSecret,
    )).toBe(true);
  });
});

describe('foreign text cover detection', () => {
  function geometryFixture(markup: string) {
    const { document } = parseHTML(`<html><body>${markup}</body></html>`);
    const image = document.querySelector('#image')! as unknown as HTMLImageElement;
    const imageRect = rect(10, 10, 200, 100);
    Object.defineProperty(image, 'getBoundingClientRect', { value: () => imageRect });
    const sourceWindow = {
      getComputedStyle: () => baseStyle,
    } as unknown as Window;
    const safe = () => hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    );
    const hitTest = (value: (x: number, y: number) => Element | null) => {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value,
      });
    };
    return { document, image, safe, hitTest };
  }

  it('defers capture while an element with its own text covers the image', () => {
    const { document, image, safe, hitTest } = geometryFixture(
      '<img id="image"><div id="caption">Sale ends Friday</div>',
    );
    const caption = document.querySelector('#caption')!;
    hitTest((x, y) => x > 100 && y > 60 ? caption : image);
    expect(safe()).toBe(false);
    // Once the caption moves away the same image becomes capturable again.
    hitTest(() => image);
    expect(safe()).toBe(true);
  });

  it('counts text nested one level inside the covering element', () => {
    const { document, safe, hitTest } = geometryFixture(
      '<img id="image"><header id="bar"><span>Sign in</span></header>',
    );
    hitTest(() => document.querySelector('#bar'));
    expect(safe()).toBe(false);
  });

  it('ignores transparent overlays and wrappers without text', () => {
    const { document, safe, hitTest } = geometryFixture(
      '<a id="link" href="/x"><span id="empty"></span></a>' +
      '<div id="layout"><div><p>Deep layout text</p></div></div><img id="image">',
    );
    hitTest(() => document.querySelector('#link'));
    expect(safe()).toBe(true);
    // Text two levels down is layout structure, not a text cover.
    hitTest(() => document.querySelector('#layout'));
    expect(safe()).toBe(true);
  });

  it('treats the image itself and its ancestors as safe', () => {
    const { document, image, safe, hitTest } = geometryFixture(
      '<figure id="figure"><img id="image"><figcaption>Below the image</figcaption></figure>',
    );
    const figure = document.querySelector('#figure')!;
    hitTest((x) => x < 60 ? image : figure);
    expect(safe()).toBe(true);
  });

  it('descends into an open shadow root to find a covering text overlay', () => {
    const { document, safe, hitTest } = geometryFixture(
      '<div id="host"></div><img id="image">',
    );
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    // linkedom does not currently expose ShadowRoot.mode, while browsers do.
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    shadow.innerHTML = '<div id="toast">Copied to clipboard</div>';
    hitTest(() => host);
    // A text-free host by itself is not a cover.
    expect(safe()).toBe(true);
    Object.defineProperty(shadow, 'elementFromPoint', {
      configurable: true,
      value: () => shadow.querySelector('#toast'),
    });
    expect(safe()).toBe(false);
  });

  it('fails closed when the hit test itself is unreadable', () => {
    const { safe, hitTest } = geometryFixture('<img id="image">');
    hitTest(() => {
      throw new Error('hostile elementFromPoint');
    });
    expect(safe()).toBe(false);
  });

  it('skips the heuristic on documents without a hit test', () => {
    const { safe } = geometryFixture('<img id="image"><div>Nearby text</div>');
    expect(safe()).toBe(true);
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setImageFacts(image: HTMLImageElement): void {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 200 },
    naturalHeight: { configurable: true, value: 100 },
    getBoundingClientRect: {
      configurable: true,
      value: () => rect(0, 0, 200, 100),
    },
  });
}

function setPaintFacts(element: Element): void {
  Object.defineProperty(element, 'getClientRects', {
    configurable: true,
    value: () => {
      const paint = rect(0, 0, 200, 40);
      return {
        0: paint,
        length: 1,
        item: (index: number) => index === 0 ? paint : null,
      } as unknown as DOMRectList;
    },
  });
}

function observeImageContentReads(image: HTMLImageElement): {
  readonly reset: () => void;
  readonly snapshot: () => { readonly label: number; readonly geometry: number };
} {
  let label = 0;
  let geometry = 0;
  const getAttribute = image.getAttribute.bind(image);
  const getBoundingClientRect = image.getBoundingClientRect.bind(image);
  Object.defineProperties(image, {
    getAttribute: {
      configurable: true,
      value: (name: string) => {
        if (name === 'alt' || name === 'aria-label') label += 1;
        return getAttribute(name);
      },
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => {
        geometry += 1;
        return getBoundingClientRect();
      },
    },
  });
  return Object.freeze({
    reset: () => {
      label = 0;
      geometry = 0;
    },
    snapshot: () => Object.freeze({ label, geometry }),
  });
}

function setTabSelection(
  trigger: Element,
  panel: Element,
  selected: boolean,
): void {
  trigger.setAttribute('aria-selected', String(selected));
  trigger.setAttribute('aria-expanded', String(selected));
  if (selected) panel.removeAttribute('hidden');
  else panel.setAttribute('hidden', '');
}

function mutationAttributeRecord(
  target: Element,
  attributeName: string,
): MutationRecord {
  return {
    type: 'attributes',
    target,
    attributeName,
  } as unknown as MutationRecord;
}

function lastUpsertDescriptor(
  messages: readonly unknown[],
): SourceImageDescriptor | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index] as {
      readonly kind?: unknown;
      readonly change?: {
        readonly kind?: unknown;
        readonly descriptor?: unknown;
      };
    };
    if (
      candidate.kind === 'simul:image-source-v2:change' &&
      candidate.change?.kind === 'upsert'
    ) return candidate.change.descriptor as SourceImageDescriptor;
  }
  return undefined;
}

function lastUpsertDescriptorForNode(
  messages: readonly unknown[],
  nodeId: number,
): SourceImageDescriptor | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index] as {
      readonly kind?: unknown;
      readonly change?: {
        readonly kind?: unknown;
        readonly descriptor?: SourceImageDescriptor;
      };
    };
    if (
      candidate.kind === 'simul:image-source-v2:change' &&
      candidate.change?.kind === 'upsert' &&
      candidate.change.descriptor?.nodeId === nodeId
    ) return candidate.change.descriptor;
  }
  return undefined;
}

class FakeImageSourcePort {
  readonly messages: unknown[] = [];
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  disconnect(): void {}

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

class FakeEvent<T extends (...args: never[]) => void> {
  readonly #listeners = new Set<T>();

  addListener(listener: T): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }

  emit(...args: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...args);
  }
}

class NoopElementObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class ImmediateIntersectionObserver {
  constructor(
    private readonly callback: (
      entries: readonly IntersectionObserverEntry[],
    ) => void,
  ) {}

  observe(target: Element): void {
    this.callback([{
      target,
      isIntersecting: true,
    } as IntersectionObserverEntry]);
  }

  unobserve(): void {}
  disconnect(): void {}
}

class NoopMutationObserver {
  callback: (records: readonly MutationRecord[]) => void = () => undefined;
  observe(): void {}
  disconnect(): void {}

  trigger(records: readonly MutationRecord[]): void {
    this.callback(records);
  }
}
