import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
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
      kind: 'simul:image-source-v1:start',
      document: identity,
    });

    expect(port.messages.at(-1)).toEqual({
      kind: 'simul:image-source-v1:ready',
      document: identity,
      summary: { candidateImages: 2, observedImages: 1 },
    });
    expect(JSON.stringify(port.messages.at(-1))).not.toMatch(
      /(?:src|url|pixels|text|hash|nodeId)/iu,
    );
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
        kind: 'simul:image-source-v1:start',
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
      kind: 'simul:image-source-v1:start',
      document: targetIdentity,
      policyFingerprint: 'read-v1-111111',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    Reflect.deleteProperty(window, 'getComputedStyle');

    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:ready',
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
      kind: 'simul:image-source-v1:start',
      document: blockedIdentity,
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
      accessibilityTextEnabled: true,
    });
    expect(blockedPort.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:ready',
      summary: { candidateImages: 1, observedImages: 0 },
    });
    blockedSession.dispose();
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const session = createSession(port, identity);
    port.emitMessage({
      kind: 'simul:image-source-v1:start',
      document: identity,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    const sourceDescriptor = lastUpsertDescriptor(port.messages)!;
    port.emitMessage({
      kind: 'simul:image-source-v1:accessibility-text',
      requestId: 'alt-ready',
      descriptor: sourceDescriptor,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:accessibility-text',
      requestId: 'alt-ready',
      status: 'ready',
      evidence: {
        text: 'お知らせ',
        source: 'alt',
        nearestElementLanguage: 'ja',
      },
    });
    port.emitMessage({
      kind: 'simul:image-source-v1:accessibility-text',
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
      kind: 'simul:image-source-v1:start',
      document: identity,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    const sourceDescriptor = lastUpsertDescriptor(port.messages)!;
    port.emitMessage({
      kind: 'simul:image-source-v1:accessibility-text',
      requestId: 'overlapped-alt',
      descriptor: sourceDescriptor,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:accessibility-text',
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
      kind: 'simul:image-source-v1:start',
      document: blockedIdentity,
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
      accessibilityTextEnabled: true,
    });
    expect(blockedPort.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:ready',
      summary: { candidateImages: 1, observedImages: 0 },
    });
    blockedSession.dispose();
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const session = createSession(port, identity);

    port.emitMessage({
      kind: 'simul:image-source-v1:start',
      document: identity,
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    const sourceDescriptor = lastUpsertDescriptor(port.messages)!;
    port.emitMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'measure-control-image',
      descriptor: sourceDescriptor,
    });

    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:metrics',
      requestId: 'measure-control-image',
      status: 'ready',
    });
    port.emitMessage({
      kind: 'simul:image-source-v1:accessibility-text',
      requestId: 'read-control-image',
      descriptor: sourceDescriptor,
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:accessibility-text',
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
      kind: 'simul:image-source-v1:start',
      document: identity,
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
      accessibilityTextEnabled: false,
    });
    const firstDescriptor = lastUpsertDescriptor(port.messages);
    expect(firstDescriptor).toBeDefined();
    port.emitMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'measure-public',
      descriptor: firstDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:metrics',
      requestId: 'measure-public',
      status: 'ready',
    });

    navigation.removeAttribute('href');
    port.emitMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'measure-without-href',
      descriptor: firstDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:metrics',
      requestId: 'measure-without-href',
      status: 'ready',
    });

    navigation.setAttribute('href', '/restored');
    port.emitMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'measure-old-revision',
      descriptor: firstDescriptor,
    });
    const restoredDescriptor = lastUpsertDescriptor(port.messages);
    expect(restoredDescriptor).toEqual(firstDescriptor);
    port.emitMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'measure-restored',
      descriptor: restoredDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:metrics',
      requestId: 'measure-restored',
      status: 'ready',
    });

    navigation.setAttribute('aria-expanded', 'false');
    port.emitMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'measure-stateful',
      descriptor: restoredDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:metrics',
      requestId: 'measure-stateful',
      status: 'ready',
    });

    navigation.removeAttribute('aria-expanded');
    port.emitMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'measure-stateful-old-revision',
      descriptor: restoredDescriptor,
    });
    const statelessDescriptor = lastUpsertDescriptor(port.messages);
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:metrics',
      requestId: 'measure-stateful-old-revision',
      status: 'ready',
    });
    port.emitMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'measure-stateless-restored',
      descriptor: statelessDescriptor,
    });
    expect(port.messages.at(-1)).toMatchObject({
      kind: 'simul:image-source-v1:metrics',
      requestId: 'measure-stateless-restored',
      status: 'ready',
    });
    session.dispose();
  });

  it('rejects hidden, rotated, and private-control-overlapped pixels', () => {
    const { document } = parseHTML(
      '<html><body><img id="image"><input id="private"></body></html>',
    );
    const image = document.querySelector('#image')! as unknown as HTMLImageElement;
    const control = document.querySelector('#private')!;
    const imageRect = rect(10, 10, 200, 100);
    Object.defineProperty(image, 'getBoundingClientRect', {
      value: () => imageRect,
    });
    Object.defineProperty(control, 'getBoundingClientRect', {
      value: () => rect(50, 30, 80, 30),
    });
    const styles = new Map<Element, CSSStyleDeclaration>();
    const sourceWindow = {
      getComputedStyle: (element: Element) => styles.get(element) ?? baseStyle,
    } as unknown as Window;

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
    control.setAttribute('type', 'password');
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
      { allowControlImages: true },
    )).toBe(false);

    control.remove();
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
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(true);
  });

  it('keeps a separate overlapping navigation button protected', () => {
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

    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(false);
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
      candidate.kind === 'simul:image-source-v1:change' &&
      candidate.change?.kind === 'upsert'
    ) return candidate.change.descriptor as SourceImageDescriptor;
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
  observe(): void {}
  disconnect(): void {}
}
