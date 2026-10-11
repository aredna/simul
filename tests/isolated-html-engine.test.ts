import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import {
  HtmlMirrorClientError,
  type HtmlMirrorStreamLease,
  type HtmlMirrorStreamObserver,
} from '../lib/replica/html-mirror-client';
import {
  createHtmlMirrorCheckpoint,
  createHtmlMirrorPatch,
  createHtmlMirrorPatchFrame,
  createHtmlMirrorScrollUpdate,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPatchOperation,
} from '../lib/replica/html-mirror-protocol';
import {
  ISOLATED_HTML_LIMITED_QUIRKS_SHELL,
  ISOLATED_HTML_QUIRKS_SHELL,
  ISOLATED_HTML_SHELL,
  ISOLATED_MEDIA_CONTROLS_CSS,
  IsolatedHtmlReplicaEngine,
  canonicalSvgElementName,
  createMirrorElement,
  isTrustedIsolatedShellDocument,
  protectIsolatedOpaquePlaceholder,
  type IsolatedMirrorInfo,
} from '../lib/replica/isolated-html-engine';
import {
  clearReplicaAttributeOverride,
  pageAttribute,
  setReplicaAttributeOverride,
} from '../lib/replica/replica-attribute-override';
import { createReplicaIdentity } from '../lib/replica/replica-identity';
import {
  PAGE_LANGUAGE_ATTRIBUTE,
  XML_NAMESPACE,
  hideImageLanguage,
  pageXmlLanguage,
  showImageLanguage,
} from '../lib/replica/translated-language';
import {
  PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE,
  PAGE_XML_LANGUAGE_ATTRIBUTE,
} from '../lib/replica/html-mirror-sanitizer';
import {
  FULL_VISIBLE_REPLICA_READ_SCOPE,
  PAGE_ONLY_REPLICA_READ_SCOPE,
  type ReplicaReadScope,
} from '../lib/replica/read-scope-policy';
import {
  PAINTED_SEMANTIC_LABEL_ATTRIBUTE,
  PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE,
} from '../lib/replica/painted-semantic-label';
import type {
  SemanticSourceStreamLease,
  SemanticSourceStreamObserver,
} from '../lib/replica/semantic-source-client';
import {
  createSemanticSourceBatch,
  type SemanticSourceRecord,
} from '../lib/replica/semantic-source-protocol';
import {
  MAX_HTML_MIRROR_NODES,
  createHtmlMirrorRepresentabilityCollector,
  type HtmlMirrorNode,
} from '../lib/replica/html-mirror-sanitizer';
import { applyHtmlMirrorLimitSettings } from '../lib/replica/html-mirror-limits';
import {
  SOURCE_PRIVACY_FILTERS_OFF,
  applySourcePrivacyFiltersOff,
} from '../lib/replica/source-privacy-mode';
import { sourceSecretPlaceholderTagName } from '../lib/replica/source-secret-classifier';
import type {
  ReplayPresentationHost,
  VisibleReplayCandidateLease,
  VisibleReplayDimensions,
} from '../lib/replica/visible-replay-host';

describe('IsolatedHtmlReplicaEngine', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
      HTMLImageElement: window.HTMLImageElement,
    });
  });

  it('leaves html and body at browser defaults apart from Chrome\'s extension font', () => {
    // A body centred by max-width and auto margins (Google's error page) must
    // keep its width, and pages that never reset body margin keep the
    // browser's 8px. Chrome injects body{font-size:75%} into extension-origin
    // documents, so the shell hands body font back to inheritance.
    const shell = parseHTML(ISOLATED_HTML_SHELL).document;
    const inert = shell.querySelector(
      'style[data-simul-owned-shell="inert"]',
    )?.textContent ?? '';
    expect(inert).not.toMatch(/margin|min-width|min-height/u);
    expect(inert).toContain('body{font-family:inherit;font-size:inherit}');
  });

  it('applies the panel size limits and sends them with the stream (D64)', async () => {
    const limits = { itemMegabytes: 2, pageMegabytes: 8, maxElements: 5_000 };
    const sent: unknown[] = [];
    const nodeCapsAtOpen: number[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: new FakePresentationHost(),
      getMirrorLimits: () => limits,
      openStream: async (_request, _policy, _signal, sentLimits) => {
        sent.push(sentLimits);
        nodeCapsAtOpen.push(MAX_HTML_MIRROR_NODES);
        throw new Error('The test stops at the stream.');
      },
    });
    try {
      await engine.run(request);
    } finally {
      applyHtmlMirrorLimitSettings();
    }
    expect(sent).toEqual([limits]);
    expect(nodeCapsAtOpen).toEqual([5_000]);
  });

  it('applies Show everything and sends it with the stream (D75)', async () => {
    const sent: unknown[] = [];
    const switchAtOpen: boolean[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: new FakePresentationHost(),
      getShowEverything: () => true,
      openStream: async (_request, _policy, _signal, _limits, showEverything) => {
        sent.push(showEverything);
        switchAtOpen.push(SOURCE_PRIVACY_FILTERS_OFF);
        throw new Error('The test stops at the stream.');
      },
    });
    try {
      await engine.run(request);
    } finally {
      applySourcePrivacyFiltersOff(false);
    }
    expect(sent).toEqual([true]);
    expect(switchAtOpen).toEqual([true]);
  });

  it('shows authored control values and reads at Full visible under Show everything (D75)', async () => {
    applySourcePrivacyFiltersOff(true);
    try {
      const checkpoint = createHtmlMirrorCheckpoint(
        createReplicaIdentity({ ...identityParts, sequence: 0 }),
        {
          root: {
            kind: 'element', id: 1, namespace: 'html', tagName: 'html',
            attributes: [], children: [
              { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
              { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
                kind: 'element', id: 4, namespace: 'html', tagName: 'input',
                attributes: [['type', 'date'], ['value', '2026-09-23']],
                children: [],
              }, {
                kind: 'element', id: 5, namespace: 'html', tagName: 'input',
                attributes: [['placeholder', 'Authored placeholder']],
                children: [],
              }] },
            ],
          },
          adoptedStyleSheets: [], captureMs: 1,
          viewportWidth: 800, viewportHeight: 600,
          documentWidth: 800, documentHeight: 1000,
        },
        'passive',
      )!;
      expect(checkpoint).toBeDefined();
      const scopes: ReplicaReadScope[] = [];
      const host = new FakePresentationHost();
      const engine = new IsolatedHtmlReplicaEngine({
        presentationHost: host,
        getShowEverything: () => true,
        openStream: async () => new FakeHtmlStream(checkpoint),
        openSemanticStream: async (_request, _bridge, scope) => {
          scopes.push(scope);
          return new FakeSemanticStream();
        },
        getReplicaReadScope: () => PAGE_ONLY_REPLICA_READ_SCOPE,
        initializeIframe: async (iframe, shell) => {
          const { document } = parseHTML(shell);
          Object.defineProperty(iframe, 'contentDocument', { value: document });
          return document;
        },
      });
      await engine.run(request);
      await Promise.resolve();
      const replica = host.iframe!.contentDocument!;
      const [date, text] = [...replica.querySelectorAll('input')];
      expect(date?.getAttribute('value')).toBe('2026-09-23');
      expect(text?.getAttribute('placeholder')).toBe('Authored placeholder');
      expect(scopes).toEqual([FULL_VISIBLE_REPLICA_READ_SCOPE]);
    } finally {
      applySourcePrivacyFiltersOff(false);
    }
  });

  it('rejects the initial about:blank document and accepts only the marked srcdoc shell', () => {
    const blank = parseHTML('<html><head></head><body></body></html>').document;
    expect(isTrustedIsolatedShellDocument(blank)).toBe(false);

    const shell = parseHTML(ISOLATED_HTML_SHELL).document;
    expect(isTrustedIsolatedShellDocument(shell)).toBe(true);
    Object.defineProperty(shell, 'location', {
      configurable: true,
      value: { href: 'about:blank' },
    });
    expect(isTrustedIsolatedShellDocument(shell)).toBe(false);
  });

  it('trusts a written quirks shell only at the panel URL that wrote it', () => {
    // D65: an srcdoc document is never in quirks mode, so a quirks shell is
    // written into a blank frame, which takes the writer's URL.
    expect(ISOLATED_HTML_QUIRKS_SHELL.startsWith('<!doctype')).toBe(false);
    const panelUrl = 'chrome-extension://simul/sidepanel.html';
    const written = parseHTML(ISOLATED_HTML_QUIRKS_SHELL).document;
    Object.defineProperty(written, 'location', {
      configurable: true,
      value: { href: panelUrl },
    });
    expect(isTrustedIsolatedShellDocument(written, panelUrl)).toBe(true);
    expect(isTrustedIsolatedShellDocument(written)).toBe(false);
    expect(isTrustedIsolatedShellDocument(
      written,
      'chrome-extension://simul/other.html',
    )).toBe(false);
    const unmarked = parseHTML('<html><head></head><body></body></html>').document;
    Object.defineProperty(unmarked, 'location', {
      configurable: true,
      value: { href: panelUrl },
    });
    expect(isTrustedIsolatedShellDocument(unmarked, panelUrl)).toBe(false);
  });

  it('suppresses universal pseudo-content and resource paint on opaque shells', () => {
    const { document } = parseHTML('<html><body></body></html>');
    const placeholder = document.createElementNS(
      'http://www.w3.org/1999/xhtml',
      sourceSecretPlaceholderTagName(41),
    );
    const attachShadow = placeholder.attachShadow.bind(placeholder);
    let protectedShadow: ShadowRoot | undefined;
    Object.defineProperty(placeholder, 'attachShadow', {
      configurable: true,
      value: (init: ShadowRootInit) => {
        protectedShadow = attachShadow(init);
        return protectedShadow;
      },
    });

    protectIsolatedOpaquePlaceholder(placeholder);

    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
    expect(placeholder.hasAttribute('inert')).toBe(true);
    expect(placeholder.shadowRoot).toBeNull();
    const blockerCss = protectedShadow?.firstChild?.textContent ?? '';
    expect(blockerCss).toContain(':host::before');
    expect(blockerCss).toContain('content:none!important');
    expect(blockerCss).toContain('background-image:none!important');
    expect(blockerCss).toContain('mask-image:none!important');
  });

  it('stages a doctype-free shell for a bounded quirks-mode checkpoint', async () => {
    const standard = makeCheckpoint('standards page', 0);
    const checkpoint = createHtmlMirrorCheckpoint(standard.identity, {
      root: standard.payload.root,
      adoptedStyleSheets: standard.payload.adoptedStyleSheets,
      documentMode: 'quirks',
      captureMs: standard.payload.captureMs,
      viewportWidth: standard.payload.viewportWidth,
      viewportHeight: standard.payload.viewportHeight,
      documentWidth: standard.payload.documentWidth,
      documentHeight: standard.payload.documentHeight,
      representability: standard.payload.representability,
    })!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    let stagedShell = '';
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        stagedShell = shell;
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    expect(stagedShell).toBe(ISOLATED_HTML_QUIRKS_SHELL);
    expect(stagedShell.trimStart().toLowerCase().startsWith('<!doctype'))
      .toBe(false);
    expect(isTrustedIsolatedShellDocument(
      host.iframe!.contentDocument!,
    )).toBe(true);
  });

  it('stages the XHTML Transitional shell for a limited-quirks checkpoint (D97)', async () => {
    const standard = makeCheckpoint('transitional page', 0);
    const checkpoint = createHtmlMirrorCheckpoint(standard.identity, {
      root: standard.payload.root,
      adoptedStyleSheets: standard.payload.adoptedStyleSheets,
      documentMode: 'limited-quirks',
      captureMs: standard.payload.captureMs,
      viewportWidth: standard.payload.viewportWidth,
      viewportHeight: standard.payload.viewportHeight,
      documentWidth: standard.payload.documentWidth,
      documentHeight: standard.payload.documentHeight,
      representability: standard.payload.representability,
    })!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    let stagedShell = '';
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        stagedShell = shell;
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    expect(stagedShell).toBe(ISOLATED_HTML_LIMITED_QUIRKS_SHELL);
    expect(stagedShell.startsWith(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"',
    )).toBe(true);
    expect(isTrustedIsolatedShellDocument(
      host.iframe!.contentDocument!,
    )).toBe(true);
  });

  it('forwards only current exact-document scroll state', async () => {
    const checkpoint = makeCheckpoint('scrolling', 0);
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const onSourceScroll = vi.fn();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
      onSourceScroll,
    });
    await engine.run(request);
    const update = createHtmlMirrorScrollUpdate(checkpoint.identity, {
      scrollX: 0,
      scrollY: 240,
      maxScrollX: 0,
      maxScrollY: 400,
    })!;

    stream.observer!.onScroll(update);
    stream.observer!.onScroll({
      ...update,
      identity: createReplicaIdentity({
        ...identityParts,
        documentId: 'stale-document',
        sequence: 0,
      }),
    });

    expect(onSourceScroll).toHaveBeenCalledOnce();
    expect(onSourceScroll).toHaveBeenCalledWith(update.scroll);
  });

  it('gives the host its node map at commit, so a pane is found by node id (D122)', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('pane text', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const replica = host.iframe!.contentDocument!;
    expect(host.resolveNode?.(1)).toBe(replica.documentElement);
    expect(host.resolveNode?.(3)).toBe(replica.body);
    expect(host.resolveNode?.(4)).toBe(replica.body.firstChild);
    expect(host.resolveNode?.(99)).toBeUndefined();

    // A patch makes the body's content again: the id of a new element finds
    // it, and the id of what was taken out finds nothing.
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'children', nodeId: 3, children: [{
          kind: 'element', id: 7, namespace: 'html', tagName: 'div',
          attributes: [], children: [],
        }],
      }],
    )!);
    expect(host.resolveNode?.(7)).toBe(replica.body.firstElementChild);
    expect(host.resolveNode?.(4)).toBeUndefined();
  });

  it('refreshes the host after a patch that leaves the page the size it was (D122)', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('pane text', 0));
    const host = new FakePresentationHost();
    const refreshes: (() => void)[] = [];
    const engine = makeEngine(
      stream,
      host,
      undefined,
      undefined,
      (refresh) => refreshes.push(() => refresh(0)),
    );
    await engine.run(request);
    for (const refresh of refreshes.splice(0)) refresh();
    host.refreshExtent.mockClear();

    // The host places the panes again from this call: a patch can make a
    // scrolled pane again, at its start, without changing the page's size.
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'children', nodeId: 3, children: [{
          kind: 'element', id: 7, namespace: 'html', tagName: 'div',
          attributes: [], children: [],
        }],
      }],
    )!);
    expect(host.refreshExtent).not.toHaveBeenCalled();
    expect(refreshes).toHaveLength(1);
    for (const refresh of refreshes.splice(0)) refresh();
    expect(host.refreshExtent).toHaveBeenCalledOnce();
    expect(host.refreshExtent.mock.lastCall?.[0]).toBe(host.iframe);
  });

  it('holds translated boxes at the page size with Keep geometry (D101)', async () => {
    const checkpoint = makeCheckpoint('hello', 0);
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    let mode: 'adaptive' | 'faithful' = 'faithful';
    const refreshes: (() => void)[] = [];
    const flush = (): void => {
      for (const refresh of refreshes.splice(0)) refresh();
    };
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      getTextLayoutMode: () => mode,
      scheduleLayoutRefresh: (callback) => refreshes.push(callback),
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        // The body is 20px tall around the page's text and 40px around the
        // longer translation.
        Object.defineProperty(iframe, 'contentWindow', {
          value: {
            getComputedStyle: (element: Element) => ({
              display: element.localName === 'body' ? 'block' : 'inline',
              boxSizing: 'border-box',
              width: '800px',
              height: element.textContent === 'hello' ? '20px' : '40px',
              fontSize: '16px',
              lineHeight: 'normal',
            }),
          },
        });
        return document;
      },
    });

    expect((await engine.run(request)).status).toBe('complete');
    const snapshot = engine.snapshot()!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      nodeId: 4,
      nodeType: 3,
      sourceRevision: 1,
      source: 'hello',
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: 'こんにちは、世界のみなさん',
    })).toBe(true);
    flush();

    const body = host.iframe!.contentDocument!.body;
    expect(body.textContent).toBe('こんにちは、世界のみなさん');
    expect(body.style.getPropertyValue('height')).toBe('20px');
    expect(body.style.getPropertyValue('width')).toBe('800px');

    mode = 'adaptive';
    engine.refreshTextLayout();
    flush();
    expect(body.getAttribute('style')).toBeNull();
    expect(body.textContent).toBe('こんにちは、世界のみなさん');
  });

  it('says which texts show their line breaks, from the mirror\'s computed style (D131)', async () => {
    const block = (id: number, name: string, text: string): HtmlMirrorNode => ({
      kind: 'element', id, namespace: 'html', tagName: 'div',
      attributes: [['id', name]],
      children: [{ kind: 'text', id: id + 1, text, translatable: true }],
    });
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html', attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [
              block(10, 'pre-wrap', '一行目\n二行目'),
              block(20, 'pre-line', '一行目\n二行目'),
              block(30, 'normal', '一行目\n二行目'),
            ] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    );
    if (!checkpoint) throw new Error('Line-break fixture checkpoint rejected.');
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => new FakeHtmlStream(checkpoint),
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    expect((await engine.run(request)).status).toBe('complete');
    // Chrome reads both properties; `pre-line` stands for a browser that
    // knows only the `white-space` shorthand.
    const styles: Record<string, Record<string, string>> = {
      'pre-wrap': { 'white-space-collapse': 'preserve', 'white-space': 'pre-wrap' },
      'pre-line': { 'white-space': 'pre-line' },
      normal: { 'white-space-collapse': 'collapse', 'white-space': 'normal' },
    };
    Object.defineProperty(host.iframe!.contentDocument!.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        getPropertyValue: (name: string) => styles[element.id]?.[name] ?? '',
      }),
    });

    expect(engine.showsLineBreaks(11)).toBe(true);
    expect(engine.showsLineBreaks(21)).toBe(true);
    expect(engine.showsLineBreaks(31)).toBe(false);
    expect(engine.showsLineBreaks(99)).toBe(false);
  });

  it('commits an inert real DOM, projects text, and applies a contiguous patch', async () => {
    const checkpoint = makeCheckpoint('hello', 0);
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const commits: string[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
      onSourceCommit: (commit) => commits.push(commit.reason),
    });

    const result = await engine.run(request);
    expect(result.status).toBe('complete');
    expect(host.iframe?.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(host.iframe?.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(host.iframe?.hasAttribute('inert')).toBe(false);
    expect(host.iframe?.style.pointerEvents).toBe('auto');
    expect(host.iframe?.getAttribute('data-simul-interaction-boundary'))
      .toBe('css-disclosure-v1');
    expect(host.iframe?.contentDocument?.querySelector('script')).toBeNull();
    expect(host.iframe?.contentDocument?.body.textContent).toBe('hello');
    const snapshot = engine.snapshot();
    expect(snapshot?.records.map(({ source }) => source)).toEqual(['hello']);
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: snapshot!.document,
      replayLease: snapshot!.replayLease,
      nodeId: 4,
      nodeType: 3,
      sourceRevision: 1,
      source: 'hello',
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: 'こんにちは',
    })).toBe(true);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('こんにちは');

    const patchIdentity = createReplicaIdentity({
      ...identityParts,
      sequence: 1,
    });
    stream.observer?.onPatch(createHtmlMirrorPatch(
      patchIdentity,
      1,
      1,
      [{
        kind: 'text',
        nodeId: 4,
        node: { kind: 'text', id: 4, text: 'world', translatable: true },
      }],
    )!);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('world');
    expect(stream.acknowledged).toContain(1);
    expect(commits).toEqual(['checkpoint', 'batch']);

    const replica = host.iframe!.contentDocument!;
    const forgedSurface = replica.createElement('div');
    forgedSurface.setAttribute(
      'data-simul-replica-disclosure-trigger',
      'v1',
    );
    const forgedControl = replica.createElement('input');
    forgedControl.type = 'checkbox';
    forgedControl.checked = false;
    forgedSurface.append(forgedControl);
    replica.body.append(forgedSurface);
    const forgedClick = new replica.defaultView!.Event('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    const forgedKey = new replica.defaultView!.Event('keydown', {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    expect(forgedControl.dispatchEvent(forgedClick)).toBe(false);
    expect(forgedClick.defaultPrevented).toBe(true);
    expect(forgedControl.checked).toBe(false);
    expect(forgedControl.dispatchEvent(forgedKey)).toBe(false);
    expect(forgedKey.defaultPrevented).toBe(true);
    expect(forgedControl.checked).toBe(false);

    // Focus can always leave the mirror: Tab is not cancelled (D118), while
    // the keys that act on a control still are.
    const key = (type: string, name: string) => {
      const event = new replica.defaultView!.Event(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      Object.defineProperty(event, 'key', { value: name });
      return event;
    };
    for (const type of ['keydown', 'keyup']) {
      const tab = key(type, 'Tab');
      expect(forgedControl.dispatchEvent(tab)).toBe(true);
      expect(tab.defaultPrevented).toBe(false);
    }
    for (const name of ['Enter', ' ', 'ArrowDown', 'a']) {
      const pressed = key('keydown', name);
      expect(forgedControl.dispatchEvent(pressed)).toBe(false);
      expect(pressed.defaultPrevented).toBe(true);
    }
    const tabClick = key('click', 'Tab');
    expect(forgedControl.dispatchEvent(tabClick)).toBe(false);
    expect(forgedControl.checked).toBe(false);
  });

  it('hands files dropped on the mirror to the panel, before the activation guard (D107)', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('hello', 0));
    const host = new FakePresentationHost();
    const dropped: string[][] = [];
    const droppedTypes: string[][] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
      onFileDrop: (files) => {
        dropped.push(files.map((file) => file.name));
        droppedTypes.push(files.map((file) => file.type));
      },
    });
    expect((await engine.run(request)).status).toBe('complete');
    const replica = host.iframe!.contentDocument!;
    const drag = (type: string, types: readonly string[], files: readonly File[]) => {
      const event = new replica.defaultView!.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types, files, dropEffect: 'none' },
      });
      return event as Event & { dataTransfer: { dropEffect: string } };
    };

    const over = drag('dragover', ['Files'], []);
    expect(replica.body.dispatchEvent(over)).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    const drop = drag('drop', ['Files'], [
      new File(['%PDF-'], 'a.pdf', { type: 'application/pdf' }),
      new File(['notes'], 'b.txt', { type: 'text/plain' }),
    ]);
    expect(replica.body.dispatchEvent(drop)).toBe(false);
    // Re-made as the panel's own files, with their names and types.
    expect(dropped).toEqual([['a.pdf', 'b.txt']]);
    expect(droppedTypes).toEqual([['application/pdf', 'text/plain']]);

    // A drag of text or a link is not a file: the guard alone handles it.
    const textDrop = drag('drop', ['text/plain'], []);
    expect(replica.body.dispatchEvent(textDrop)).toBe(false);
    expect(dropped).toHaveLength(1);
  });

  it('rebuilds the dark canvas and inline SVG logo with canonical SVG attributes', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], canvasBackgroundColor: 'rgb(0, 0, 0)', children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [],
            },
            {
              kind: 'element', id: 3, namespace: 'html', tagName: 'body',
              attributes: [], children: [{
                kind: 'element', id: 4, namespace: 'svg', tagName: 'svg',
                attributes: [
                  ['width', '118'], ['height', '32'],
                  ['viewbox', '0 0 118 32'],
                  ['preserveaspectratio', 'xMinYMid meet'],
                ],
                children: [{
                  kind: 'element', id: 5, namespace: 'svg', tagName: 'defs',
                  attributes: [], children: [{
                    kind: 'element', id: 6, namespace: 'svg', tagName: 'symbol',
                    attributes: [['id', 'wordmark']], children: [{
                    kind: 'element', id: 7, namespace: 'svg', tagName: 'path',
                      attributes: [
                        ['d', 'M0 0h118v32H0z'],
                        ['style', 'animation:swap 1s infinite;transition:fill 1s'],
                      ], children: [],
                    }],
                  }],
                }, {
                  kind: 'element', id: 8, namespace: 'svg', tagName: 'use',
                  attributes: [['href', '#wordmark']], children: [],
                }, {
                  kind: 'element', id: 9, namespace: 'svg', tagName: 'use',
                  attributes: [['xlink:href', '#wordmark']], children: [],
                }],
              }],
            },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 1_200, viewportHeight: 800,
        documentWidth: 1_200, documentHeight: 2_400,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);

    await engine.run(request);

    const replica = host.iframe!.contentDocument!;
    const logo = replica.querySelector('svg')!;
    const uses = replica.querySelectorAll('use');
    expect(replica.documentElement.style.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(replica.documentElement.dataset.simulCanvasBackground).toBe('v1');
    expect(host.dimensions?.canvasBackgroundColor).toBe('rgb(0, 0, 0)');
    expect(logo.getAttribute('width')).toBe('118');
    expect(logo.getAttribute('height')).toBe('32');
    expect(logo.getAttribute('viewBox')).toBe('0 0 118 32');
    expect(logo.getAttribute('preserveAspectRatio')).toBe('xMinYMid meet');
    expect(uses[0]?.getAttribute('href')).toBe('#wordmark');
    // Linkedom retains the qualified name but does not model attribute
    // namespaces; the engine uses setAttributeNS in Chrome.
    expect(uses[1]?.getAttribute('xlink:href')).toBe('#wordmark');
    const path = replica.querySelector('path') as SVGElement;
    expect(path.style.getPropertyValue('animation')).toBe('none');
    expect(path.style.getPropertyValue('transition')).toBe('none');

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'dimensions', viewportWidth: 1_200, viewportHeight: 800,
        documentWidth: 1_200, documentHeight: 2_400,
        canvasBackgroundColor: 'rgb(16, 16, 16)',
      }],
    )!);
    expect(replica.documentElement.style.backgroundColor).toBe('rgb(16, 16, 16)');
    expect(host.refreshDimensions).toHaveBeenLastCalledWith(
      host.iframe,
      expect.objectContaining({ canvasBackgroundColor: 'rgb(16, 16, 16)' }),
    );

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{
        kind: 'dimensions', viewportWidth: 1_200, viewportHeight: 800,
        documentWidth: 1_200, documentHeight: 2_400,
      }],
    )!);
    expect(replica.documentElement.style.backgroundColor).toBe('');
    expect(replica.documentElement.getAttribute('data-simul-canvas-background'))
      .toBeNull();

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 3 }),
      3,
      3,
      [{
        kind: 'attributes', nodeId: 7, namespace: 'svg', tagName: 'path',
        attributes: [
          ['d', 'M0 0h118v32H0z'],
          ['style', 'animation-name:swap!important;transition-property:fill!important'],
        ],
      }],
    )!);
    expect(path.style.getPropertyValue('animation')).toBe('none');
    expect(path.style.getPropertyValue('transition')).toBe('none');

    const forgedNamespace = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 4 }),
      4,
      4,
      [{
        kind: 'attributes',
        nodeId: 8,
        namespace: 'html',
        tagName: 'use',
        attributes: [['class', 'forged-namespace']],
      }],
      undefined,
      'passive',
    );
    expect(forgedNamespace).toBeDefined();
    stream.observer?.onPatch(forgedNamespace!);
    expect(uses[0]?.hasAttribute('class')).toBe(false);
    expect(stream.acknowledged).not.toContain(4);
    expect(stream.requested).toContain(3);
  });

  it('rejects optional control text carried by the Integrated base graph', () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'input',
              attributes: [['type', 'search']], children: [],
              controlText: { kind: 'value', text: 'public query', translatable: true },
            }] },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
    );
    expect(checkpoint).toBeUndefined();
  });

  it('applies, translates, and purges an exact-document semantic supplement', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'input',
              attributes: [['type', 'text']], children: [],
            }] },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1_000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const semantic = new FakeSemanticStream();
    const reconnectedSemantic = new FakeSemanticStream();
    const reconnectTimers: Array<() => void> = [];
    const reconnectDelays: number[] = [];
    let semanticOpens = 0;
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      openSemanticStream: async () =>
        semanticOpens++ === 0 ? semantic : reconnectedSemantic,
      getReplicaReadScope: () => FULL_VISIBLE_REPLICA_READ_SCOPE,
      setSemanticReconnectTimer: (callback, delayMs) => {
        reconnectTimers.push(callback);
        reconnectDelays.push(delayMs);
        return callback;
      },
      clearSemanticReconnectTimer: (timer) => {
        const index = reconnectTimers.indexOf(timer as () => void);
        if (index >= 0) reconnectTimers.splice(index, 1);
      },
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await engine.run(request);
    await Promise.resolve();
    const snapshot = engine.snapshot()!;
    const sourceRecord: SemanticSourceRecord = {
      bridge: 'isolated-html', recordId: 35, nodeId: 4, nodeRevision: 1,
      category: 'ordinary-form', gate: 'formValues', tagName: 'input',
      type: 'text', autocomplete: '', role: '', contentEditable: '',
      text: 'visible draft', presentation: 'value', classifierVersion: 1,
    };
    expect(semantic.emit(createSemanticSourceBatch(
      snapshot.document,
      'read-v1-111111',
      1,
      [sourceRecord],
    ))).toBe(true);
    const supplemented = engine.snapshot()!;
    const record = supplemented.records.find(({ nodeId }) => nodeId === -35)!;
    const input = host.iframe!.contentDocument!.querySelector('input')!;
    expect(input.value).toBe('visible draft');
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en>ja' });
    expect(engine.project({
      document: supplemented.document,
      replayLease: supplemented.replayLease,
      nodeId: record.nodeId,
      nodeType: 1,
      controlTarget: 'value',
      sourceRevision: record.revision,
      source: record.source,
      translationEpoch: 1,
      pairKey: 'en>ja',
      translated: '表示下書き',
    })).toBe(true);
    expect(input.value).toBe('表示下書き');
    semantic.fail();
    expect(engine.snapshot()?.records.some(({ nodeId }) => nodeId < 0)).toBe(false);
    expect(input.value).toBe('');
    expect(reconnectDelays).toEqual([250]);
    reconnectTimers.shift()?.();
    await Promise.resolve();
    expect(semanticOpens).toBe(2);
    expect(reconnectedSemantic.emit(createSemanticSourceBatch(
      snapshot.document,
      'read-v1-111111',
      1,
      [sourceRecord],
    ))).toBe(true);
    expect(engine.snapshot()?.records.some(({ nodeId }) => nodeId === -35))
      .toBe(true);
    expect(input.value).toBe('visible draft');
  });

  it('reconnects when a base patch cannot reapply dropdown presentation', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'select',
              attributes: [], children: [{
                kind: 'element', id: 5, namespace: 'html', tagName: 'option',
                attributes: [], children: [],
              }],
            }, {
              kind: 'text', id: 6, text: 'status', translatable: true,
            }] },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1_000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const semantic = new FakeSemanticStream();
    const reconnectedSemantic = new FakeSemanticStream();
    const reconnectTimers: Array<() => void> = [];
    const host = new FakePresentationHost();
    let semanticOpens = 0;
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      openSemanticStream: async () =>
        semanticOpens++ === 0 ? semantic : reconnectedSemantic,
      getReplicaReadScope: () => FULL_VISIBLE_REPLICA_READ_SCOPE,
      setSemanticReconnectTimer: (callback) => {
        reconnectTimers.push(callback);
        return callback;
      },
      clearSemanticReconnectTimer: (timer) => {
        const index = reconnectTimers.indexOf(timer as () => void);
        if (index >= 0) reconnectTimers.splice(index, 1);
      },
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await engine.run(request);
    await Promise.resolve();
    expect(semantic.emit(createSemanticSourceBatch(
      engine.snapshot()!.document,
      'read-v1-111111',
      1,
      [],
      [{
        kind: 'select-presentation', bridge: 'isolated-html', nodeId: 4,
        revision: 1, gate: 'controlSemantics', multiple: false, size: null,
        classifierVersion: 1,
      }],
    ))).toBe(true);
    const selectHost = host.iframe!.contentDocument!.body
      .firstElementChild as HTMLElement;
    const select = selectHost.shadowRoot!.querySelector('select')!;
    const trigger = selectHost.shadowRoot!.querySelector<HTMLElement>(
      '[data-simul-owned-select-trigger="v1"]',
    )!;
    const addedTriggerListener = vi.spyOn(trigger, 'addEventListener');
    expect(select.getAttribute('data-simul-source-select-presentation')).toBe('v1');

    host.setInteractiveAccessibility.mockImplementation((_iframe, accessible) =>
      !accessible);
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'dimensions', viewportWidth: 801, viewportHeight: 600,
        documentWidth: 801, documentHeight: 1_000,
      }],
      undefined,
      'passive',
    )!);

    expect(semantic.disposed).toBe(false);
    expect(select.getAttribute('data-simul-source-select-presentation')).toBe('v1');
    expect(reconnectTimers).toHaveLength(0);
    expect(addedTriggerListener).not.toHaveBeenCalled();
    host.refreshDimensions.mockClear();
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{
        kind: 'text', nodeId: 6,
        node: { kind: 'text', id: 6, text: 'updated', translatable: true },
      }],
      undefined,
      'passive',
    )!);
    expect(semantic.disposed).toBe(false);
    expect(select.getAttribute('data-simul-source-select-presentation')).toBe('v1');
    expect(reconnectTimers).toHaveLength(0);
    expect(addedTriggerListener).not.toHaveBeenCalled();
    expect(host.refreshDimensions).not.toHaveBeenCalled();
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 3 }),
      3,
      3,
      [{
        kind: 'attributes', nodeId: 3, namespace: 'html', tagName: 'body',
        attributes: [['class', 'settled-layout']],
      }],
      undefined,
      'passive',
    )!);

    expect(semantic.disposed).toBe(true);
    expect(select.hasAttribute('data-simul-source-select-presentation')).toBe(false);
    expect(reconnectTimers).toHaveLength(1);
    host.setInteractiveAccessibility.mockReturnValue(true);
    reconnectTimers.shift()?.();
    await Promise.resolve();
    expect(semanticOpens).toBe(2);
  });

  it('keeps a transparent source select as a clickable transparent trigger', async () => {
    // Wikipedia draws its own "EN" label under an opacity:0 select. The
    // replica keeps the select's box and click target, makes only the
    // trigger transparent, and leaves the options panel opaque.
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'select',
              attributes: [],
              selectPresentationStyle:
                'opacity:0;position:absolute;width:110px;height:24px',
              children: [{
                kind: 'element', id: 5, namespace: 'html', tagName: 'option',
                attributes: [], children: [],
              }],
            }] },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
    )!;
    expect(checkpoint).toBeDefined();
    // linkedom's style declaration has no item(); Chrome's does.
    const styleProto = Object.getPrototypeOf(
      parseHTML('<p></p>').document.createElement('p').style,
    ) as { item?: (this: Record<string, string>, index: number) => string };
    const hadItem = Object.prototype.hasOwnProperty.call(styleProto, 'item');
    if (!hadItem) {
      styleProto.item = function item(index) {
        return this[String(index)] ?? '';
      };
    }
    try {
      const host = new FakePresentationHost();
      const engine = makeEngine(new FakeHtmlStream(checkpoint), host);
      await engine.run(request);

      const selectHost = host.iframe!.contentDocument!.body
        .firstElementChild as HTMLElement;
      expect(selectHost.getAttribute('data-simul-select-transparent')).toBe('v1');
      expect(selectHost.style.getPropertyValue('opacity')).toBe('');
      expect(selectHost.style.getPropertyValue('width')).toBe('110px');
      expect(selectHost.style.getPropertyValue('display')).not.toBe('none');
      expect(selectHost.shadowRoot!.querySelector('style')?.textContent).toContain(
        ':host([data-simul-select-transparent="v1"]) [data-simul-owned-select-trigger="v1"]{opacity:0!important}',
      );
    } finally {
      if (!hadItem) delete styleProto.item;
    }
  });

  it('keeps a dropdown out of sight where its presentation says so, closes its open list, and keeps it through a tap\'s echo', async () => {
    // A dropdown under something hidden is not marked hidden: it keeps its
    // box for when the mirror opens what hides it (a site menu's panel).
    const tree = (selectPresentationStyle: string) => ({
      kind: 'element' as const, id: 1, namespace: 'html' as const, tagName: 'html',
      attributes: [], children: [
        { kind: 'element' as const, id: 2, namespace: 'html' as const, tagName: 'head', attributes: [], children: [] },
        { kind: 'element' as const, id: 3, namespace: 'html' as const, tagName: 'body', attributes: [], children: [{
          kind: 'element' as const, id: 4, namespace: 'html' as const, tagName: 'select',
          attributes: [], selectPresentationStyle,
          children: [{
            kind: 'element' as const, id: 5, namespace: 'html' as const, tagName: 'option',
            attributes: [], children: [],
          }],
        }] },
      ],
    });
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: tree('visibility:visible;width:110px'),
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
      'passive',
    )!;
    expect(checkpoint).toBeDefined();
    // linkedom's style declaration has no item(); Chrome's does.
    const styleProto = Object.getPrototypeOf(
      parseHTML('<p></p>').document.createElement('p').style,
    ) as { item?: (this: Record<string, string>, index: number) => string };
    const hadItem = Object.prototype.hasOwnProperty.call(styleProto, 'item');
    if (!hadItem) {
      styleProto.item = function item(index) {
        return this[String(index)] ?? '';
      };
    }
    try {
      const stream = new FakeHtmlStream(checkpoint);
      const semantic = new FakeSemanticStream();
      const host = new FakePresentationHost();
      const engine = makeEngine(stream, host, undefined, semantic);
      await engine.run(request);
      await Promise.resolve();
      expect(semantic.emit(createSemanticSourceBatch(
        engine.snapshot()!.document, 'read-v1-111111', 1, [],
        [{
          kind: 'select-presentation', bridge: 'isolated-html', nodeId: 4,
          revision: 1, gate: 'controlSemantics', multiple: false, size: null,
          classifierVersion: 1,
        }],
      ))).toBe(true);
      const selectHost = host.iframe!.contentDocument!.body
        .firstElementChild as HTMLElement;
      const trigger = selectHost.shadowRoot!.querySelector<HTMLButtonElement>(
        '[data-simul-owned-select-trigger="v1"]',
      )!;
      const click = () => trigger.dispatchEvent(
        new selectHost.ownerDocument.defaultView!.Event('click', {
          bubbles: true, cancelable: true, composed: true,
        }),
      );
      const patch = (sequence: number, style: string) => stream.observer?.onPatch(
        createHtmlMirrorPatch(
          createReplicaIdentity({ ...identityParts, sequence }),
          sequence,
          sequence,
          [{
            kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'select',
            attributes: [], selectPresentationStyle: style,
          }],
          undefined,
          'passive',
        )!,
      );
      expect(selectHost.style.getPropertyValue('visibility')).toBe('visible');
      click();
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      // Chrome 138 sends a tap again as `mousedown` and `mouseup`. On the
      // dropdown's own button that is the echo of a press it already had:
      // cancelled like any other, and it closes nothing. Anywhere else it
      // is an input from elsewhere and closes the reader's previews.
      const replica = selectHost.ownerDocument;
      const mouse = (type: string, path: EventTarget[]) => {
        const event = new replica.defaultView!.Event(type, {
          bubbles: true, cancelable: true, composed: true,
        });
        Object.defineProperty(event, 'composedPath', { value: () => path });
        replica.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(mouse('mousedown', [trigger, selectHost, replica.body, replica])).toBe(true);
      expect(mouse('mouseup', [trigger, selectHost, replica.body, replica])).toBe(true);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(mouse('mousedown', [replica.body, replica])).toBe(true);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      click();
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      // A change to the dropdown that leaves it in sight leaves its list.
      patch(1, 'visibility:visible;width:120px');
      expect(selectHost.style.getPropertyValue('width')).toBe('120px');
      expect(trigger.getAttribute('aria-expanded')).toBe('true');

      // The page hides what the dropdown sits in.
      patch(2, 'visibility:hidden;width:120px');
      expect(selectHost.style.getPropertyValue('visibility')).toBe('hidden');
      // Its box stays: no `display: none`, no hidden marker.
      expect(selectHost.style.getPropertyValue('display')).toBe('inline-block');
      expect(selectHost.hasAttribute('data-simul-select-hidden')).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      if (!hadItem) delete styleProto.item;
    }
  });

  it('renders and updates native select labels without transporting option values', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 10, namespace: 'html', tagName: 'div',
              attributes: [[
                'style',
                'overflow:hidden!important;clip-path:inset(0)!important;contain:paint!important',
              ]], children: [{
                kind: 'element', id: 4, namespace: 'html', tagName: 'select',
                attributes: [], children: [{
                kind: 'element', id: 5, namespace: 'html', tagName: 'option',
                attributes: [], children: [],
              }, {
                kind: 'element', id: 9, namespace: 'html', tagName: 'optgroup',
                attributes: [], children: [{
                  kind: 'element', id: 7, namespace: 'html', tagName: 'option',
                  attributes: [], children: [],
                }],
              }, ...Array.from({ length: 7 }, (_, index) => ({
                kind: 'element' as const,
                id: 20 + index,
                namespace: 'html' as const,
                tagName: 'option',
                attributes: [] as const,
                children: [] as const,
                }))],
              }],
            }] },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const semantic = new FakeSemanticStream();
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host, undefined, semantic);
    await engine.run(request);
    await Promise.resolve();
    const semanticRecords: SemanticSourceRecord[] = [
      [5, 'option', 'Choose'],
      [9, 'optgroup', 'District'],
      [7, 'option', 'Community center'],
      ...Array.from({ length: 7 }, (_, index) =>
        [20 + index, 'option', `Choice ${index + 3}`] as const),
    ].map(([nodeId, tagName, text]) => ({
      bridge: 'isolated-html',
      recordId: Number(nodeId) * 8 + 1,
      nodeId: Number(nodeId),
      nodeRevision: 1,
      category: 'public-semantic',
      gate: 'controlSemantics',
      tagName: String(tagName),
      type: '', autocomplete: '', role: '', contentEditable: '',
      text: String(text),
      presentation: 'label',
      classifierVersion: 1,
    }));
    semanticRecords.push({
      bridge: 'isolated-html', recordId: 37, nodeId: 4, nodeRevision: 1,
      category: 'ordinary-form', gate: 'formValues', tagName: 'select',
      type: '', autocomplete: '', role: '', contentEditable: '',
      text: 'Community center', presentation: 'selection', classifierVersion: 1,
    });
    expect(semantic.emit(createSemanticSourceBatch(
      engine.snapshot()!.document,
      'read-v1-111111',
      1,
      semanticRecords,
      [{
        kind: 'select-presentation', bridge: 'isolated-html', nodeId: 4,
        revision: 1, gate: 'controlSemantics', multiple: false, size: null,
        classifierVersion: 1,
      }, {
        kind: 'select-state', bridge: 'isolated-html', nodeId: 4,
        revision: 1, gate: 'formValues', selectedOptionNodeIds: [7],
        multiple: false, pickerOpen: false, classifierVersion: 1,
      }],
    ))).toBe(true);

    const replica = host.iframe!.contentDocument!;
    const clippingAncestor = replica.body.firstElementChild as HTMLElement;
    const selectHost = clippingAncestor.firstElementChild as HTMLElement;
    const select = selectHost.shadowRoot!.querySelector('select')!;
    const trigger = selectHost.shadowRoot!.querySelector<HTMLButtonElement>(
      '[data-simul-owned-select-trigger="v1"]',
    )!;
    const panel = selectHost.shadowRoot!.querySelector<HTMLElement>(
      '[data-simul-owned-select-options="v1"]',
    )!;
    expect(select.selectedIndex).toBe(1);
    expect([...select.options].map((option) => option.getAttribute('label')))
      .toEqual(expect.arrayContaining(['Choose', 'Community center', 'Choice 9']));
    expect(select.getAttribute('data-simul-select-facsimile')).toBe('v1');
    expect(select.hasAttribute('data-simul-source-picker-open')).toBe(false);
    expect(select.getAttribute('data-simul-source-selection-state')).toBe('v1');
    expect(select.hasAttribute('inert')).toBe(true);
    expect(select.getAttribute('aria-disabled')).toBe('true');
    expect(select.getAttribute('size')).toBeNull();
    expect(selectHost.dataset.simulSelectPresentation).toBe('popup');
    expect(selectHost.getAttribute('style')).toContain('pointer-events:auto');
    expect(selectHost.shadowRoot!.querySelector('style')?.textContent)
      .toContain('max-height:min(18rem,70vh)!important');
    expect(selectHost.shadowRoot!.querySelector('style')?.textContent)
      .toContain('width:100%!important');
    expect(selectHost.shadowRoot!.querySelector('style')?.textContent)
      .toContain('box-sizing:border-box!important');
    expect(clippingAncestor.getAttribute('style')).toContain(
      'overflow:hidden!important',
    );
    expect(clippingAncestor.getAttribute('style')).toContain(
      'clip-path:inset(0)!important',
    );
    expect(clippingAncestor.getAttribute('style')).toContain(
      'contain:paint!important',
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toBe('Community center');
    expect([...panel.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent === 'Community center',
    )?.getAttribute('aria-selected')).toBe('true');
    expect(panel.parentNode).toBe(selectHost.shadowRoot);
    expect(select.selectedIndex).toBe(1);
    expect(panel.style.position).toBe('fixed');
    trigger.dispatchEvent(new select.ownerDocument.defaultView!.Event('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(panel.parentElement).toBe(replica.body);
    trigger.dispatchEvent(new select.ownerDocument.defaultView!.Event('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel.parentNode).toBe(selectHost.shadowRoot);
    const activation = new select.ownerDocument.defaultView!.Event('pointerdown', {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    expect(select.dispatchEvent(activation)).toBe(false);
    expect(activation.defaultPrevented).toBe(true);
    const crossRealmActivation = new select.ownerDocument.defaultView!.Event(
      'click',
      { bubbles: true, cancelable: true, composed: true },
    );
    Object.defineProperty(crossRealmActivation, 'composedPath', {
      value: () => [{
        nodeType: 1,
        getAttribute: (name: string) =>
          name === 'data-simul-select-facsimile' ? 'v1' : null,
      }],
    });
    expect(select.ownerDocument.dispatchEvent(crossRealmActivation)).toBe(false);
    expect(crossRealmActivation.defaultPrevented).toBe(true);
    expect(engine.snapshot()?.records.map(({ source }) => source)).toEqual(
      expect.arrayContaining(['Choose', 'District', 'Community center', 'Choice 9']),
    );
    expect(select.querySelector('optgroup')?.hasAttribute('disabled')).toBe(false);
    const snapshot = engine.snapshot()!;
    const labelRecord = snapshot.records.find(({ source }) => source === 'District')!;
    expect(labelRecord.nodeType).toBe(1);
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      nodeId: labelRecord.nodeId,
      nodeType: 1,
      controlTarget: 'label',
      sourceRevision: labelRecord.revision,
      source: labelRecord.source,
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: '地区',
    })).toBe(true);
    expect(select.querySelector('optgroup')?.getAttribute('label')).toBe('地区');
    expect(panel.querySelector(
      '[data-simul-owned-select-optgroup-label="v1"]',
    )?.textContent).toBe('地区');
    replica.dispatchEvent(new select.ownerDocument.defaultView!.Event('scroll'));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hasAttribute('hidden')).toBe(true);

    const retainedSelectedRow = [...panel.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent === 'Community center');
    trigger.dispatchEvent(new select.ownerDocument.defaultView!.Event('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes', nodeId: 10, namespace: 'html', tagName: 'div',
        attributes: [[
          'style',
          'overflow:clip!important;clip-path:circle(50%)!important;contain:content!important',
        ]],
      }],
      undefined,
      'passive',
    )!);
    await Promise.resolve();
    expect([...panel.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent === 'Community center',
    )).toBe(retainedSelectedRow);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(panel.parentElement).toBe(replica.body);
    trigger.dispatchEvent(new select.ownerDocument.defaultView!.Event('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
    expect(select.selectedIndex).toBe(1);
    expect(select.hasAttribute('data-simul-source-picker-open')).toBe(false);
    expect(select.getAttribute('data-simul-select-facsimile')).toBe('v1');
    expect(clippingAncestor.getAttribute('style')).toContain(
      'overflow:clip!important',
    );
    expect(clippingAncestor.getAttribute('style')).toContain(
      'clip-path:circle(50%)!important',
    );
    expect(clippingAncestor.getAttribute('style')).toContain(
      'contain:content!important',
    );

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{
        kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'select',
        attributes: [],
      }],
      undefined,
      'passive',
    )!);
    expect(select.selectedIndex).toBe(1);
    expect(select.getAttribute('data-simul-select-facsimile')).toBe('v1');
    expect(select.getAttribute('aria-disabled')).toBe('true');

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 3 }),
      3,
      3,
      [{
        kind: 'reconcile-children', nodeId: 10, children: [
          { kind: 'retain', nodeId: 4 },
          {
            kind: 'graph',
            node: {
              kind: 'element', id: 100, namespace: 'html', tagName: 'p',
              attributes: [], children: [{
                kind: 'text', id: 101, text: 'After select', translatable: true,
              }],
            },
          },
        ],
      }],
      undefined,
      'passive',
    )!);
    expect(selectHost.isConnected).toBe(true);
    expect(selectHost.shadowRoot!.querySelector('select')).toBe(select);
    expect(host.iframe!.contentDocument!.body.textContent).toContain('After select');
    expect(stream.acknowledged).toContain(3);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 4 }),
      4,
      4,
      [{
        kind: 'children', nodeId: 4, children: [{
          kind: 'element', id: 109, namespace: 'html', tagName: 'option',
          attributes: [], children: [],
        }],
      }, {
        kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'select',
        attributes: [['role', 'textbox']],
      }],
      undefined,
      'passive',
    )!);
    expect(select.selectedIndex).toBe(-1);
    expect([...select.options].map((option) => option.label))
      .not.toContain('Choose');
    expect(engine.snapshot()?.records.map(({ source }) => source))
      .not.toContain('Choose');
    expect(stream.acknowledged).toContain(4);
    expect(stream.requested).not.toContain(3);

    const forgedBaseSelect = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 5 }),
      5,
      5,
      [{
        kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'select',
        attributes: [], selectedOptionIndexes: [0],
      }, {
        kind: 'children', nodeId: 4, children: [{
          kind: 'element', id: 110, namespace: 'html', tagName: 'option',
          attributes: [], children: [],
          controlText: {
            kind: 'label', text: 'Out-of-order option', translatable: true,
          },
        }],
      }],
      undefined,
      'passive',
    );
    expect(forgedBaseSelect).toBeUndefined();
    expect([...select.options].some(
      (option) => option.label === 'Out-of-order option',
    )).toBe(false);
    expect(stream.acknowledged).not.toContain(5);
    expect(stream.requested).not.toContain(4);
  });

  it('rejects ARIA menu state, relationships, and labels carried by the base graph', async () => {
    const canaryUrl = 'https://canary.invalid/public-menu-background.png';
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [{
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [{
              kind: 'element', id: 7, namespace: 'html', tagName: 'style',
              attributes: [], children: [{
                kind: 'text', id: 8,
                text: `[role="option"]{background-image:url("${canaryUrl}")}`,
                translatable: false,
              }],
            }],
          }, {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [{
              kind: 'element', id: 9, namespace: 'html', tagName: 'button',
              attributes: [
                ['role', 'button'],
                ['aria-controls', 'public-destinations'],
                ['aria-haspopup', 'listbox'],
                ['aria-expanded', 'false'],
              ], children: [{
                kind: 'text', id: 10, text: 'Destinations', translatable: true,
              }],
            }, {
              kind: 'element', id: 4, namespace: 'html', tagName: 'div',
              attributes: [
                ['id', 'public-destinations'],
                ['role', 'listbox'],
                ['class', 'source-menu'],
              ],
              children: [{
                kind: 'element', id: 5, namespace: 'html', tagName: 'div',
                attributes: [['role', 'option']], children: [{
                  kind: 'text', id: 6, text: 'Public destination',
                  translatable: true,
                }],
              }],
            }, {
              kind: 'element', id: 11, namespace: 'html', tagName: 'button',
              attributes: [
                ['role', 'button'],
                ['aria-controls', 'regional-destinations'],
                ['aria-haspopup', 'menu'],
              ], children: [{
                kind: 'text', id: 12, text: 'Regional destinations',
                translatable: true,
              }],
            }, {
              kind: 'element', id: 13, namespace: 'html', tagName: 'section',
              attributes: [['id', 'regional-destinations'], ['role', 'region']],
              children: [{
                kind: 'element', id: 14, namespace: 'html', tagName: 'div',
                attributes: [['role', 'menu']], children: [{
                  kind: 'element', id: 15, namespace: 'html', tagName: 'div',
                  attributes: [['role', 'option']], children: [{
                    kind: 'text', id: 16, text: 'Regional destination',
                    translatable: true,
                  }],
                }],
              }],
            }, {
              kind: 'element', id: 17, namespace: 'html', tagName: 'button',
              attributes: [
                ['role', 'button'],
                ['aria-controls', 'duplicate-target'],
                ['aria-haspopup', 'listbox'],
              ], children: [{
                kind: 'text', id: 18, text: 'Ambiguous destinations',
                translatable: true,
              }],
            }, ...[19, 20].map((id, index) => ({
              kind: 'element' as const,
              id,
              namespace: 'html' as const,
              tagName: 'div',
              attributes: [
                ['id', 'duplicate-target'],
                ['role', 'listbox'],
              ] as const,
              children: [{
                kind: 'element' as const,
                id: 21 + index * 2,
                namespace: 'html' as const,
                tagName: 'div',
                attributes: [['role', 'option']] as const,
                children: [{
                  kind: 'text' as const,
                  id: 22 + index * 2,
                  text: `Duplicate ${index + 1}`,
                  translatable: true as const,
                }],
              }],
            })),
            ],
          }],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
      'passive',
    );
    // ARIA state and relationships never travel in the base graph; the
    // replica's own preview gets them from the semantic channel.
    expect(checkpoint).toBeUndefined();
  });

  it('draws ARIA menus and listboxes with the page\'s own styles and images, and opens a menu in place (D88)', async () => {
    // Wise's currency list is a headless-UI listbox positioned by the page,
    // and account menus are menus positioned by their inline style. Both
    // were moved into an isolated facsimile that dropped the page's styles,
    // inline position and images.
    const option = (id: number, role: string, text: string) => ({
      kind: 'element' as const, id, namespace: 'html' as const, tagName: 'div',
      attributes: [['role', role], ['class', 'np-option']] as const,
      children: [{
        kind: 'element' as const, id: id + 1, namespace: 'html' as const,
        tagName: 'img',
        attributes: [
          ['src', `https://icons.example.test/${id}.svg`],
          ['alt', ''],
        ] as const,
        children: [],
      }, {
        kind: 'text' as const, id: id + 2, text, translatable: true as const,
      }],
    });
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [{
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [{
              kind: 'element', id: 7, namespace: 'html', tagName: 'style',
              attributes: [], children: [{
                kind: 'text', id: 8,
                text: '.np-option{display:flex;gap:8px}',
                translatable: false,
              }],
            }],
          }, {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [{
              kind: 'element', id: 10, namespace: 'html', tagName: 'button',
              attributes: [['class', 'np-button']], children: [{
                kind: 'text', id: 11, text: 'Account', translatable: true,
              }],
            }, {
              kind: 'element', id: 12, namespace: 'html', tagName: 'div',
              attributes: [
                ['role', 'menu'],
                ['class', 'np-menu'],
                ['style', 'position:absolute;left:10px;top:50px'],
              ],
              children: [option(13, 'menuitem', 'Settings')],
            }, {
              kind: 'element', id: 20, namespace: 'html', tagName: 'div',
              attributes: [
                ['role', 'listbox'],
                ['class', 'np-popover'],
                ['style', 'position:absolute;left:200px;top:50px'],
              ],
              children: [option(21, 'option', 'Japanese yen')],
            }],
          }],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
      'passive',
    );
    expect(checkpoint).toBeDefined();
    const stream = new FakeHtmlStream(checkpoint!);
    const semantic = new FakeSemanticStream();
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host, undefined, semantic);
    await engine.run(request);
    await Promise.resolve();

    const replica = host.iframe!.contentDocument!;
    const menu = replica.querySelector<HTMLElement>('[role="menu"]')!;
    const listbox = replica.querySelector<HTMLElement>('[role="listbox"]')!;
    const trigger = replica.querySelector<HTMLElement>('button')!;
    for (const [panel, style, icon, text] of [
      [menu, 'position:absolute;left:10px;top:50px', 13, 'Settings'],
      [listbox, 'position:absolute;left:200px;top:50px', 21, 'Japanese yen'],
    ] as const) {
      expect(panel.parentElement).toBe(replica.body);
      expect(panel.getAttribute('style')).toBe(style);
      expect(panel.firstElementChild?.getAttribute('class')).toBe('np-option');
      expect(panel.querySelector('img')?.getAttribute('src'))
        .toBe(`https://icons.example.test/${icon}.svg`);
      expect(panel.textContent).toBe(text);
    }
    expect([...replica.body.querySelectorAll('*')].some((element) =>
      element.localName.startsWith('simul-owned-menu-'))).toBe(false);

    // The page's own closed menu is the preview's panel, opened in place.
    const snapshot = engine.snapshot()!;
    expect(semantic.emit(createSemanticSourceBatch(
      snapshot.document,
      'read-v1-111111',
      1,
      [],
      [{
        kind: 'disclosure-state', bridge: 'isolated-html',
        relationId: 'semantic-relation-v1:10:12', revision: 1,
        gate: 'disclosureContent', triggerNodeId: 10, panelNodeId: 12,
        popupRole: 'menu', expanded: false, classifierVersion: 1,
      }],
    ))).toBe(true);
    expect(trigger.getAttribute('data-simul-replica-disclosure-trigger'))
      .toBe('v1');
    expect(menu.getAttribute('data-simul-replica-disclosure-panel'))
      .toBe('v1');
    trigger.dispatchEvent(new replica.defaultView!.Event('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    }));
    expect(trigger.getAttribute('data-simul-replica-disclosure-open'))
      .toBe('v1');
    expect(menu.parentElement).toBe(replica.body);
    expect(menu.hasAttribute('data-simul-replica-disclosure-overlay'))
      .toBe(false);
    expect(menu.style.getPropertyValue('visibility')).toBe('visible');
    expect(menu.style.getPropertyValue('left')).toBe('10px');
  });

  it('keeps sized and multiple lists bounded without rewriting shadow clipping ancestors', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'section',
              attributes: [['style', 'overflow:hidden!important']], children: [{
                kind: 'element', id: 5, namespace: 'html', tagName: 'x-menu',
                attributes: [], children: [], shadowRoot: {
                  id: 6, mode: 'open', adoptedStyleSheets: [], children: [{
                    kind: 'element', id: 7, namespace: 'html', tagName: 'div',
                    attributes: [['style', 'contain:paint!important']], children: [{
                      kind: 'element', id: 8, namespace: 'html', tagName: 'select',
                      attributes: [],
                      children: [{
                        kind: 'element', id: 9, namespace: 'html', tagName: 'option',
                        attributes: [], children: [],
                      }],
                    }],
                  }],
                },
              }],
            }] },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const semantic = new FakeSemanticStream();
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host, undefined, semantic);
    await engine.run(request);
    await Promise.resolve();
    const snapshot = engine.snapshot()!;
    expect(semantic.emit(createSemanticSourceBatch(
      snapshot.document,
      'read-v1-111111',
      1,
      [],
      [{
        kind: 'select-presentation', bridge: 'isolated-html', nodeId: 8,
        revision: 1, gate: 'controlSemantics', multiple: false, size: 4,
        classifierVersion: 1,
      }],
    ))).toBe(true);

    const replica = host.iframe!.contentDocument!;
    const outerClip = replica.querySelector('section') as HTMLElement;
    const shadow = replica.querySelector('x-menu')!.shadowRoot!;
    const innerClip = shadow.querySelector('div') as HTMLElement;
    const selectHost = innerClip.firstElementChild as HTMLElement;
    const select = selectHost.shadowRoot?.querySelector('select')!;
    const panel = selectHost.shadowRoot?.querySelector<HTMLElement>(
      '[data-simul-owned-select-options="v1"]',
    )!;
    const trigger = selectHost.shadowRoot?.querySelector<HTMLElement>(
      '[data-simul-owned-select-trigger="v1"]',
    )!;
    expect(select.getAttribute('size')).toBe('4');
    expect(selectHost.dataset.simulSelectPresentation).toBe('list');
    expect(panel.style.position).toBe('static');
    expect(panel.style.maxHeight).toBe('min(7em, 18rem, 70vh)');
    expect(trigger.hasAttribute('hidden')).toBe(true);
    expect(trigger.textContent).toBe('Options');
    expect(panel.querySelector('[aria-selected]')).toBeNull();
    expect(host.iframe!.hasAttribute('aria-hidden')).toBe(false);
    expect(outerClip.getAttribute('style')).toContain('overflow:hidden!important');
    expect(innerClip.getAttribute('style')).toContain('contain:paint!important');

    const stylePatch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes', nodeId: 7, namespace: 'html', tagName: 'div',
        attributes: [['style', 'contain:content!important']],
      }],
      undefined,
      'passive',
    );
    expect(stylePatch).toBeDefined();
    stream.observer?.onPatch(stylePatch!);
    const forgedMultiple = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{
        kind: 'attributes', nodeId: 8, namespace: 'html', tagName: 'select',
        attributes: [['multiple', '']],
      }],
      undefined,
      'passive',
    );
    expect(forgedMultiple).toBeUndefined();
    expect(outerClip.getAttribute('style')).toContain('overflow:hidden!important');
    expect(innerClip.getAttribute('style')).toContain('contain:content!important');
    expect(select.hasAttribute('multiple')).toBe(false);
    expect(selectHost.dataset.simulSelectPresentation).toBe('list');
    expect(stream.acknowledged).toContain(1);
    semantic.fail();
    // A failed semantic stream no longer hides the mirror (D118).
    expect(host.iframe!.hasAttribute('aria-hidden')).toBe(false);
  });

  it('rejects a forged select label outside a native select', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'optgroup',
              attributes: [], children: [],
            }] },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const forged = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'optgroup',
        attributes: [['label', 'Forged']],
        controlText: { kind: 'label', text: 'Forged', translatable: true },
      }],
      undefined,
      'passive',
    );
    expect(forged).toBeUndefined();

    expect(host.iframe!.contentDocument!.querySelector('optgroup')?.getAttribute('label'))
      .toBeNull();
    expect(stream.acknowledged).not.toContain(1);
    expect(stream.requested).toEqual([]);
  });

  it('rejects control text when an ancestor becomes private in the same batch', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'section',
              attributes: [], children: [{
                kind: 'element', id: 5, namespace: 'html', tagName: 'input',
                attributes: [['type', 'text']], children: [],
              }],
            }] },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);
    const input = host.iframe!.contentDocument!.querySelector('input') as
      HTMLInputElement;

    const malicious = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes', nodeId: 5, namespace: 'html', tagName: 'input',
        attributes: [['type', 'text']],
        controlText: { kind: 'value', text: 'must not apply', translatable: true },
      }, {
        kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'section',
        attributes: [['role', 'textbox']],
      }],
    );
    expect(malicious).toBeUndefined();

    expect(input.value).toBe('');
    expect(host.iframe!.contentDocument!.querySelector('section')?.hasAttribute('role'))
      .toBe(false);
    expect(stream.acknowledged).not.toContain(1);
    expect(stream.requested).toEqual([]);
  });

  it('restores source in place, rejects stale projections, and keeps live patches flowing', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('source label', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const snapshot = engine.snapshot()!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    const projection = {
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      nodeId: 4,
      nodeType: 3 as const,
      sourceRevision: 1,
      source: 'source label',
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: '翻訳済み',
    };
    expect(engine.project(projection)).toBe(true);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('翻訳済み');

    engine.beginProjection({ translationEpoch: 2, pairKey: undefined });
    expect(host.iframe?.contentDocument?.body.textContent).toBe('source label');
    expect(engine.project(projection)).toBe(false);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'text',
        nodeId: 4,
        node: {
          kind: 'text', id: 4, text: 'live source update', translatable: true,
        },
      }],
    )!);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('live source update');
    expect(engine.snapshot()?.records[0]).toMatchObject({
      source: 'live source update',
      revision: 2,
    });
    expect(stream.acknowledged).toContain(1);
  });

  it('coalesces translation layout refreshes within one frame', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('source label', 0));
    const host = new FakePresentationHost();
    const frames: FrameRequestCallback[] = [];
    const engine = makeEngine(
      stream,
      host,
      undefined,
      undefined,
      (callback) => frames.push(callback),
    );
    await engine.run(request);
    frames.splice(0).forEach((frame) => frame(0));
    host.refreshExtent.mockClear();

    const snapshot = engine.snapshot()!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    for (let index = 0; index < 20; index += 1) {
      expect(engine.project({
        document: snapshot.document,
        replayLease: snapshot.replayLease,
        nodeId: 4,
        nodeType: 3,
        sourceRevision: 1,
        source: 'source label',
        translationEpoch: 1,
        pairKey: 'en\0ja',
        translated: `translation ${index}`,
      })).toBe(true);
      await Promise.resolve();
    }

    expect(host.refreshExtent).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(host.refreshExtent).toHaveBeenCalledOnce();
  });

  it('retains translated projections across a same-document recovery checkpoint', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('hello', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const snapshot = engine.snapshot()!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      nodeId: 4,
      nodeType: 3,
      sourceRevision: 1,
      source: 'hello',
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: 'こんにちは',
    })).toBe(true);

    stream.observer?.onFailure('stream_overflow');
    stream.observer?.onCheckpoint(makeCheckpoint('hello', 0));

    await vi.waitFor(() => {
      expect(host.iframe?.contentDocument?.body.textContent).toBe('こんにちは');
    });
  });

  it('presents, invalidates, and recovers a Mainichi-style painted label', async () => {
    const initialSource = '毎日新聞デジタル 総合案内';
    const changedSource = '毎日新聞デジタル';
    const stream = new FakeHtmlStream(makePaintedLogoCheckpoint(initialSource, 0));
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const parsed = parseHTML(shell);
        installPaintedLogoLayout(parsed.document, false);
        Object.defineProperty(iframe, 'contentDocument', {
          configurable: true,
          value: parsed.document,
        });
        return parsed.document;
      },
    });

    await engine.run(request);
    const initial = engine.snapshot()!;
    const initialRecord = initial.records.find(({ nodeId }) => nodeId === 5)!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'ja\0en' });
    expect(engine.project({
      document: initial.document,
      replayLease: initial.replayLease,
      nodeId: 5,
      nodeType: 3,
      sourceRevision: initialRecord.revision,
      source: initialRecord.source,
      translationEpoch: 1,
      pairKey: 'ja\0en',
      translated: 'Mainichi Digital General Information',
    })).toBe(true);

    let logo = host.iframe!.contentDocument!.querySelector<HTMLElement>(
      '.header-logo',
    )!;
    // The label is drawn when the mirror's layout is next settled.
    expect(logo.hasAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE)).toBe(false);
    await Promise.resolve();
    expect(logo.getAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE)).toBe('v1');
    expect(logo.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )?.textContent).toBe('Mainichi Digital General Information');

    engine.beginProjection({ translationEpoch: 2, pairKey: 'ja\0en' });
    expect(logo.hasAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE)).toBe(false);
    expect(logo.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )).toBeNull();

    const restored = engine.snapshot()!;
    const restoredRecord = restored.records.find(({ nodeId }) => nodeId === 5)!;
    expect(engine.project({
      document: restored.document,
      replayLease: restored.replayLease,
      nodeId: 5,
      nodeType: 3,
      sourceRevision: restoredRecord.revision,
      source: restoredRecord.source,
      translationEpoch: 2,
      pairKey: 'ja\0en',
      translated: 'Mainichi Digital General Information',
    })).toBe(true);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'text',
        nodeId: 5,
        node: {
          kind: 'text', id: 5, text: changedSource, translatable: true,
        },
      }],
    )!);
    expect(logo.hasAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE)).toBe(false);

    const changed = engine.snapshot()!;
    const changedRecord = changed.records.find(({ nodeId }) => nodeId === 5)!;
    expect(engine.project({
      document: changed.document,
      replayLease: changed.replayLease,
      nodeId: 5,
      nodeType: 3,
      sourceRevision: changedRecord.revision,
      source: changedRecord.source,
      translationEpoch: 2,
      pairKey: 'ja\0en',
      translated: 'Mainichi Digital',
    })).toBe(true);

    stream.observer?.onFailure('stream_overflow');
    stream.observer?.onCheckpoint(makePaintedLogoCheckpoint(changedSource, 1));
    await vi.waitFor(() => {
      logo = host.iframe!.contentDocument!.querySelector<HTMLElement>(
        '.header-logo',
      )!;
      expect(logo.querySelector(
        `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
      )?.textContent).toBe('Mainichi Digital');
    });
  });

  it('presents every translated direct fragment of one painted label in order', async () => {
    const stream = new FakeHtmlStream(makePaintedLogoCheckpoint(
      ['毎日新聞デジタル ', '総合案内'],
      0,
    ));
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const parsed = parseHTML(shell);
        installPaintedLogoLayout(parsed.document, false);
        Object.defineProperty(iframe, 'contentDocument', {
          configurable: true,
          value: parsed.document,
        });
        return parsed.document;
      },
    });

    await engine.run(request);
    const snapshot = engine.snapshot()!;
    const first = snapshot.records.find(({ nodeId }) => nodeId === 5)!;
    const second = snapshot.records.find(({ nodeId }) => nodeId === 6)!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'ja\0en' });
    for (const [record, translated] of [
      [first, 'Mainichi Digital '],
      [second, 'General Information'],
    ] as const) {
      expect(engine.project({
        document: snapshot.document,
        replayLease: snapshot.replayLease,
        nodeId: record.nodeId,
        nodeType: 3,
        sourceRevision: record.revision,
        source: record.source,
        translationEpoch: 1,
        pairKey: 'ja\0en',
        translated,
      })).toBe(true);
    }

    const logo = host.iframe!.contentDocument!.querySelector<HTMLElement>(
      '.header-logo',
    )!;
    await Promise.resolve();
    expect(logo.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )?.textContent).toBe('Mainichi Digital General Information');
  });

  it('looks for painted labels once the layout is settled, not as each translation lands', async () => {
    const stream = new FakeHtmlStream(makePaintedLogoCheckpoint(
      ['毎日新聞デジタル ', '総合案内'],
      0,
    ));
    const host = new FakePresentationHost();
    const refreshes: (() => void)[] = [];
    let boxesRead = 0;
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      scheduleLayoutRefresh: (callback) => refreshes.push(callback),
      initializeIframe: async (iframe, shell) => {
        const parsed = parseHTML(shell);
        installPaintedLogoLayout(parsed.document, false);
        const prototype = parsed.document.defaultView!.HTMLElement.prototype;
        const read = prototype.getBoundingClientRect;
        Object.defineProperty(prototype, 'getBoundingClientRect', {
          configurable: true,
          value(this: HTMLElement): DOMRectReadOnly {
            boxesRead += 1;
            return read.call(this);
          },
        });
        Object.defineProperty(iframe, 'contentDocument', {
          configurable: true,
          value: parsed.document,
        });
        return parsed.document;
      },
    });

    await engine.run(request);
    for (const refresh of refreshes.splice(0)) refresh();
    const snapshot = engine.snapshot()!;
    const logo = host.iframe!.contentDocument!.querySelector<HTMLElement>(
      '.header-logo',
    )!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'ja\0en' });
    boxesRead = 0;
    const show = (nodeId: number, translated: string, epoch = 1): boolean => {
      const record = engine.snapshot()!.records.find(
        (candidate) => candidate.nodeId === nodeId,
      )!;
      return engine.project({
        document: snapshot.document,
        replayLease: snapshot.replayLease,
        nodeId,
        nodeType: 3,
        sourceRevision: record.revision,
        source: record.source,
        translationEpoch: epoch,
        pairKey: 'ja\0en',
        translated,
      });
    };
    expect(show(5, 'Mainichi Digital ')).toBe(true);
    expect(show(6, 'General Information')).toBe(true);
    // Reading a box makes Chrome lay the mirror out: none is read while
    // translations land, however many do.
    expect(boxesRead).toBe(0);
    expect(logo.hasAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE)).toBe(false);
    expect(refreshes.length).toBe(1);

    for (const refresh of refreshes.splice(0)) refresh();
    expect(boxesRead).toBeGreaterThan(0);
    expect(logo.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )?.textContent).toBe('Mainichi Digital General Information');
    // Each translation is looked at once: a later layout with nothing new
    // reads no box.
    boxesRead = 0;
    engine.refreshTextLayout();
    for (const refresh of refreshes.splice(0)) refresh();
    expect(boxesRead).toBe(0);

    // A translation that went before the layout settled leaves no label.
    engine.beginProjection({ translationEpoch: 2, pairKey: 'ja\0en' });
    expect(logo.hasAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE)).toBe(false);
    expect(show(5, 'Mainichi Digital ', 2)).toBe(true);
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'text',
        nodeId: 5,
        node: { kind: 'text', id: 5, text: '毎日', translatable: true },
      }],
    )!);
    for (const refresh of refreshes.splice(0)) refresh();
    expect(logo.hasAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE)).toBe(false);
    expect(logo.querySelector(
      `[${PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE}]`,
    )).toBeNull();
  });

  it('does not retain records or translated projections across source documents', async () => {
    const nextIdentityParts = {
      ...identityParts,
      pageEpoch: 2,
      generation: 2,
      documentId: 'next-document',
    };
    const first = new FakeHtmlStream(makeCheckpoint('hello', 0));
    const second = new FakeHtmlStream(
      makeCheckpoint('world', 0, nextIdentityParts),
    );
    const streams = [first, second];
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => streams.shift()!,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await engine.run(request);

    first.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'text', nodeId: 4,
        node: { kind: 'text', id: 4, text: 'world', translatable: true },
      }],
    )!);
    const firstSnapshot = engine.snapshot()!;
    expect(firstSnapshot.records[0]?.revision).toBe(2);
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: firstSnapshot.document,
      replayLease: firstSnapshot.replayLease,
      nodeId: 4,
      nodeType: 3,
      sourceRevision: 2,
      source: 'world',
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: '世界',
    })).toBe(true);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('世界');

    const nextRequest: ReplicaCaptureRequest = {
      ...nextIdentityParts,
      tabId: 1,
      isCurrent: () => true,
    };
    await engine.run(nextRequest);

    expect(host.iframe?.contentDocument?.body.textContent).toBe('world');
    expect(engine.snapshot()).toMatchObject({
      document: nextIdentityParts,
      records: [{ source: 'world', revision: 1 }],
    });
  });

  it('keeps last-good visible on a sequence gap and requests a checkpoint', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await engine.run(request);
    const gapIdentity = createReplicaIdentity({ ...identityParts, sequence: 2 });
    stream.observer?.onPatch(createHtmlMirrorPatch(
      gapIdentity,
      2,
      2,
      [{
        kind: 'text',
        nodeId: 4,
        node: { kind: 'text', id: 4, text: 'must not apply', translatable: true },
      }],
    )!);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('last good');
    expect(stream.requested).toEqual([0]);
  });

  it('does not report complete when a queued terminal failure drains on observer setup', async () => {
    const stream = new FakeHtmlStream(
      makeCheckpoint('briefly visible', 0),
      (observer) => observer.onFailure('stream_failed'),
    );
    const host = new FakePresentationHost();
    const infoCodes: Array<string | undefined> = [];
    const engine = makeEngine(
      stream,
      host,
      (info) => infoCodes.push(info.code),
    );

    await expect(engine.run(request)).resolves.toMatchObject({
      status: 'failed',
      diagnostics: { code: 'stream_failed' },
    });
    expect(stream.acknowledged).toEqual([]);
    expect(stream.dispose).toHaveBeenCalledOnce();
    expect(infoCodes).toContain('stream_failed');
  });

  it('reports capacity diagnostics when the initial source checkpoint fails', async () => {
    const representability = createHtmlMirrorRepresentabilityCollector();
    representability.capacityOmissionCount = 2;
    const stream: HtmlMirrorStreamLease = {
      initialCheckpoint: Promise.reject(new HtmlMirrorClientError(
        'stream_overflow',
        representability,
      )),
      setObserver: vi.fn(),
      acknowledge: vi.fn(),
      requestCheckpoint: vi.fn(),
      dispose: vi.fn(),
    };
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      onInfo: (info) => infos.push(info),
    });

    await expect(engine.run(request)).resolves.toMatchObject({
      status: 'failed',
      diagnostics: { code: 'stream_overflow' },
    });
    expect(infos.at(-1)).toMatchObject({
      stage: 'failed',
      code: 'stream_overflow',
      capacityOmissionCount: 0,
      eventRepresentability: { capacityOmissionCount: 2 },
    });
  });

  it('reports capacity diagnostics from a live source failure before recovery', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);
    const representability = createHtmlMirrorRepresentabilityCollector();
    representability.capacityOmissionCount = 3;

    stream.observer?.onFailure('stream_overflow', representability);

    expect(stream.requested).toEqual([0]);
    expect(infos.findLast(({ stage }) => stage === 'recovery')).toMatchObject({
      code: 'stream_overflow',
      capacityOmissionCount: 0,
      eventRepresentability: { capacityOmissionCount: 3 },
    });
  });

  it('releases an iframe lease immediately when presentation ends during staging', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('never committed', 0));
    const host = new FakePresentationHost();
    let finishInitialization!: (document: Document) => void;
    const initialization = new Promise<Document>((resolve) => {
      finishInitialization = resolve;
    });
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async () => initialization,
    });

    const run = engine.run(request);
    await vi.waitFor(() => expect(host.releases).toHaveLength(1));
    engine.releasePresentation();

    expect(host.releases[0]).toHaveBeenCalledOnce();
    finishInitialization(parseHTML(ISOLATED_HTML_SHELL).document);
    await expect(run).resolves.toMatchObject({
      status: 'skipped',
      diagnostics: { code: 'stale_identity' },
    });
    expect(host.iframe).toBeUndefined();
  });

  it('prevalidates a whole batch so a bad later operation cannot partially mutate', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [
        {
          kind: 'text',
          nodeId: 4,
          node: { kind: 'text', id: 4, text: 'partial leak', translatable: true },
        },
        {
          kind: 'attributes', nodeId: 999, namespace: 'html',
          tagName: 'div', attributes: [],
        },
      ],
    )!);

    expect(host.iframe?.contentDocument?.body.textContent).toBe('last good');
    expect(stream.requested).toEqual([0]);
  });

  it('retains text image and open-shadow identity while reconciling final child order', async () => {
    const stream = new FakeHtmlStream(makeReconciliationCheckpoint());
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const commits: Array<Parameters<NonNullable<
      ConstructorParameters<typeof IsolatedHtmlReplicaEngine>[0]['onSourceCommit']
    >>[0]> = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
      onInfo: (info) => infos.push(info),
      onSourceCommit: (commit) => commits.push(commit),
    });
    await engine.run(request);

    const replica = host.iframe!.contentDocument!;
    const body = replica.body;
    const card = replica.querySelector('x-card')!;
    const paragraph = replica.querySelector('p')!;
    const translatedText = paragraph.firstChild!;
    const image = replica.querySelector('img')! as HTMLImageElement;
    const shadow = card.shadowRoot!;
    const slot = shadow.querySelector('slot')!;
    expect(slot.assignedNodes()).toEqual([image]);
    const shadowStyle = shadow.querySelector('[data-simul-adopted-style="shadow"]');
    const imageAnchor = engine.resolveImageAnchor(engine.snapshot()!.document, 5)!;
    const snapshot = engine.snapshot()!;
    const paragraphRecord = snapshot.records.find(({ nodeId }) => nodeId === 7)!;
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
    expect(engine.project({
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      nodeId: 7,
      nodeType: 3,
      sourceRevision: paragraphRecord.revision,
      source: paragraphRecord.source,
      translationEpoch: 1,
      pairKey: 'en\0ja',
      translated: '翻訳を保持',
    })).toBe(true);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children',
        nodeId: 3,
        children: [
          { kind: 'retain', nodeId: 6 },
          { kind: 'retain', nodeId: 4 },
          {
            kind: 'graph',
            node: {
              kind: 'element', id: 10, namespace: 'html', tagName: 'aside',
              attributes: [], children: [{
                kind: 'text', id: 11, text: 'new content', translatable: true,
              }],
            },
          },
        ],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(body.querySelector('p')).toBe(paragraph);
    expect(paragraph.firstChild).toBe(translatedText);
    expect(translatedText.nodeValue).toBe('翻訳を保持');
    expect(body.querySelector('x-card')).toBe(card);
    expect(card.shadowRoot).toBe(shadow);
    expect(shadow.querySelector('slot')).toBe(slot);
    expect(slot.assignedNodes()).toEqual([image]);
    expect(shadow.querySelector('[data-simul-adopted-style="shadow"]')).toBe(
      shadowStyle,
    );
    expect(body.querySelector('img')).toBe(image);
    expect(engine.resolveImageAnchor(engine.snapshot()!.document, 5)?.image).toBe(
      imageAnchor.image,
    );
    expect([...body.children].map(({ localName }) => localName)).toEqual([
      'p', 'x-card', 'aside', 'style',
    ]);
    expect(commits.at(-1)?.changes).toEqual([
      expect.objectContaining({
        kind: 'upsert',
        record: expect.objectContaining({ nodeId: 11 }),
      }),
    ]);
    expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
      reconcileChildrenOperationCount: 1,
      childrenOperationCount: 0,
      retainedNodeCount: 6,
      insertedNodeCount: 2,
      movedNodeCount: 1,
      removedNodeCount: 0,
      replacementNodeCount: 0,
    });
  });

  it('hides Chrome video controls in the document and in each shadow root through patches (D87)', async () => {
    // A frame without scripts draws Chrome's own play bar on every video, and
    // the replica cannot play video. Document rules do not reach into shadow
    // trees, so each replica shadow root carries its own Simul-owned rule.
    const shell = parseHTML(ISOLATED_HTML_SHELL).document;
    expect(shell.querySelector('style[data-simul-owned-shell="inert"]')
      ?.textContent).toContain(ISOLATED_MEDIA_CONTROLS_CSS);
    expect(ISOLATED_MEDIA_CONTROLS_CSS).toContain(
      'video::-webkit-media-controls,',
    );

    const stream = new FakeHtmlStream(makeReconciliationCheckpoint());
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);
    const shadow = host.iframe!.contentDocument!.querySelector('x-card')!
      .shadowRoot!;
    const owned = () => shadow.querySelectorAll(
      'style[data-simul-owned-shadow-shell="v1"]',
    );
    expect(owned()).toHaveLength(1);
    const style = owned()[0]!;
    expect(style.textContent).toBe(ISOLATED_MEDIA_CONTROLS_CSS);
    expect(style.textContent).toContain(ISOLATED_MEDIA_CONTROLS_CSS);

    // A patch replacing the shadow root's children keeps the owned rule, as
    // it keeps the root's adopted sheets.
    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'children',
        nodeId: 8,
        children: [{
          kind: 'element', id: 20, namespace: 'html', tagName: 'p',
          attributes: [], children: [{
            kind: 'text', id: 21, text: 'new shadow content', translatable: true,
          }],
        }],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);
    expect(shadow.firstChild).toBe(shadow.querySelector('p'));
    expect(shadow.querySelector('slot')).toBeNull();
    expect(owned()).toHaveLength(1);
    expect(owned()[0]).toBe(style);
    expect(shadow.querySelector('[data-simul-adopted-style="shadow"]'))
      .not.toBeNull();
  });

  it('rejects cross-parent retain references before changing the last-good DOM', async () => {
    const stream = new FakeHtmlStream(makeCrossParentCheckpoint());
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);
    const body = host.iframe!.contentDocument!.body;
    const first = body.firstChild!;
    const secondParagraph = body.lastChild!.firstChild!;
    const eventRepresentability = createHtmlMirrorRepresentabilityCollector();
    eventRepresentability.capacityOmissionCount = 1;

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children',
        nodeId: 4,
        children: [{ kind: 'retain', nodeId: 8 }],
      }],
      eventRepresentability,
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(body.firstChild).toBe(first);
    expect(body.lastChild!.firstChild).toBe(secondParagraph);
    expect(body.textContent).toBe('firstsecond');
    expect(stream.acknowledged).not.toContain(1);
    expect(stream.requested).toEqual([0]);
    expect(infos.findLast(({ stage }) => stage === 'recovery')).toMatchObject({
      code: 'stream_gap',
      reconciliationRejectedCount: 1,
      capacityOmissionCount: 0,
      eventRepresentability: { capacityOmissionCount: 1 },
    });
  });

  it.each(['reconcile-children', 'children'] as const)(
    'rejects a disconnected %s target before mutating its detached tree',
    async (kind) => {
      const stream = new FakeHtmlStream(makeCrossParentCheckpoint());
      const host = new FakePresentationHost();
      const infos: IsolatedMirrorInfo[] = [];
      const engine = makeEngine(stream, host, (info) => infos.push(info));
      await engine.run(request);
      const body = host.iframe!.contentDocument!.body;
      const detached = body.firstChild! as Element;
      const retained = detached.firstChild!;
      detached.remove();

      const operation: HtmlMirrorPatchOperation = kind === 'reconcile-children'
        ? {
            kind,
            nodeId: 4,
            children: [{ kind: 'retain', nodeId: 5 }],
          }
        : { kind, nodeId: 4, children: [] };
      const patch = createHtmlMirrorPatch(
        createReplicaIdentity({ ...identityParts, sequence: 1 }),
        1,
        1,
        [operation],
      );
      expect(patch).toBeDefined();
      stream.observer?.onPatch(patch!);

      expect(detached.firstChild).toBe(retained);
      expect(detached.textContent).toBe('first');
      expect(body.textContent).toBe('second');
      expect(stream.acknowledged).not.toContain(1);
      expect(stream.requested).toEqual([0]);
      expect(infos.findLast(({ stage }) => stage === 'recovery')).toMatchObject({
        reconciliationRejectedCount: kind === 'reconcile-children' ? 1 : 0,
      });
    },
  );

  it.each(['source-first', 'destination-first'] as const)(
    'applies cross-parent full replacements safely in %s order',
    async (operationOrder) => {
      const stream = new FakeHtmlStream(makeCrossParentCheckpoint());
      const host = new FakePresentationHost();
      const infos: IsolatedMirrorInfo[] = [];
      const commits: Array<Parameters<NonNullable<
        ConstructorParameters<typeof IsolatedHtmlReplicaEngine>[0]['onSourceCommit']
      >>[0]> = [];
      const engine = new IsolatedHtmlReplicaEngine({
        presentationHost: host,
        openStream: async () => stream,
        initializeIframe: async (iframe, shell) => {
          const { document } = parseHTML(shell);
          Object.defineProperty(iframe, 'contentDocument', { value: document });
          return document;
        },
        onSourceCommit: (commit) => commits.push(commit),
        onInfo: (info) => infos.push(info),
      });
      await engine.run(request);
      const originalImage = engine.resolveImageAnchor(
        engine.snapshot()!.document,
        10,
      )!.image;

      const sourceReplacement: HtmlMirrorPatchOperation = {
        kind: 'children',
        nodeId: 4,
        children: [],
      };
      const destinationReplacement: HtmlMirrorPatchOperation = {
        kind: 'children',
        nodeId: 7,
        children: [
          {
            kind: 'element',
            id: 8,
            namespace: 'html',
            tagName: 'p',
            attributes: [],
            children: [{
              kind: 'text',
              id: 9,
              text: 'second',
              translatable: true,
            }],
          },
          {
            kind: 'element',
            id: 5,
            namespace: 'html',
            tagName: 'p',
            attributes: [],
            children: [{
              kind: 'text',
              id: 6,
              text: 'first',
              translatable: true,
            }, {
              kind: 'element',
              id: 10,
              namespace: 'html',
              tagName: 'img',
              attributes: [['src', 'https://images.example.test/moved.jpg']],
              children: [],
            }],
          },
        ],
      };
      const operations = operationOrder === 'source-first'
        ? [sourceReplacement, destinationReplacement]
        : [destinationReplacement, sourceReplacement];
      const patch = createHtmlMirrorPatch(
        createReplicaIdentity({ ...identityParts, sequence: 1 }),
        1,
        1,
        operations,
      );
      expect(patch).toBeDefined();
      stream.observer?.onPatch(patch!);

      const sections = host.iframe!.contentDocument!.body.querySelectorAll('section');
      expect(sections[0]!.childNodes).toHaveLength(0);
      expect([...sections[1]!.children].map(({ textContent }) => textContent))
        .toEqual(['second', 'first']);
      const movedImage = engine.resolveImageAnchor(
        engine.snapshot()!.document,
        10,
      );
      expect(movedImage?.image).not.toBe(originalImage);
      expect(movedImage?.image.parentElement).toBe(sections[1]!.children[1]);
      expect(movedImage?.image.getAttribute('src')).toBe(
        'https://images.example.test/moved.jpg',
      );
      expect(stream.acknowledged).toContain(1);
      expect(stream.requested).toEqual([]);
      expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
        childrenOperationCount: 2,
        removedNodeCount: 5,
      });
      expect(engine.snapshot()?.records).toHaveLength(2);
      expect(engine.snapshot()?.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: 9, source: 'second' }),
        expect.objectContaining({ nodeId: 6, source: 'first' }),
      ]));
      expect(commits.at(-1)?.changes).toHaveLength(2);
      expect(commits.at(-1)?.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'upsert',
          record: expect.objectContaining({ nodeId: 9, source: 'second' }),
        }),
        expect.objectContaining({
          kind: 'upsert',
          record: expect.objectContaining({ nodeId: 6, source: 'first' }),
        }),
      ]));

      const snapshot = engine.snapshot()!;
      engine.beginProjection({ translationEpoch: 1, pairKey: 'en\0ja' });
      for (const record of snapshot.records) {
        expect(engine.project({
          document: snapshot.document,
          replayLease: snapshot.replayLease,
          nodeId: record.nodeId,
          nodeType: 3,
          sourceRevision: record.revision,
          source: record.source,
          translationEpoch: 1,
          pairKey: 'en\0ja',
          translated: record.nodeId === 9 ? '二番' : '一番',
        })).toBe(true);
      }
      expect([...sections[1]!.children].map(({ textContent }) => textContent))
        .toEqual(['二番', '一番']);
    },
  );

  it('restores every independent rollback target after one restore operation throws', async () => {
    const stream = new FakeHtmlStream(makeCrossParentCheckpoint());
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);
    const body = host.iframe!.contentDocument!.body;
    const firstSection = body.children[0]!;
    const secondSection = body.children[1]!;
    const firstParagraph = firstSection.firstChild!;
    const secondText = secondSection.firstChild!.firstChild!;
    const originalInsertBefore = firstSection.insertBefore.bind(firstSection);
    const insert = vi.spyOn(firstSection, 'insertBefore').mockImplementationOnce(
      () => {
        throw new Error('synthetic commit failure');
      },
    );
    const replace = vi.spyOn(firstSection, 'replaceChildren').mockImplementationOnce(
      () => {
        throw new Error('synthetic rollback failure');
      },
    );

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes', nodeId: 7, namespace: 'html', tagName: 'section',
        attributes: [['class', 'changed']],
      }, {
        kind: 'text', nodeId: 9,
        node: { kind: 'text', id: 9, text: 'changed second', translatable: true },
      }, {
        kind: 'reconcile-children', nodeId: 4,
        children: [{
          kind: 'graph',
          node: {
            kind: 'element', id: 11, namespace: 'html', tagName: 'aside',
            attributes: [], children: [],
          },
        }, { kind: 'retain', nodeId: 5 }],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);
    insert.mockRestore();
    replace.mockRestore();
    firstSection.insertBefore = originalInsertBefore;

    expect(firstSection.firstChild).toBe(firstParagraph);
    expect(firstSection.textContent).toBe('first');
    expect(secondSection.hasAttribute('class')).toBe(false);
    expect(secondText.nodeValue).toBe('second');
    expect(engine.snapshot()?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 6, source: 'first' }),
      expect.objectContaining({ nodeId: 9, source: 'second' }),
    ]));
    expect(stream.acknowledged).not.toContain(1);
    expect(stream.requested).toEqual([0]);
  });

  it('moves only the non-LIS retained child while preserving final order and styles', async () => {
    const stream = new FakeHtmlStream(makeThreeChildCheckpoint());
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);
    const body = host.iframe!.contentDocument!.body;
    const [first, second, third] = [...body.children];
    const adoptedStyle = body.lastElementChild!;

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children', nodeId: 3,
        children: [
          { kind: 'retain', nodeId: 8 },
          { kind: 'retain', nodeId: 4 },
          { kind: 'retain', nodeId: 6 },
        ],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect([...body.children]).toEqual([third, first, second, adoptedStyle]);
    expect(body.lastElementChild).toBe(adoptedStyle);
    expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
      retainedNodeCount: 6,
      insertedNodeCount: 0,
      movedNodeCount: 1,
      removedNodeCount: 0,
    });
  });

  it('rolls back DOM maps and dimensions when reconciliation throws during commit', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);
    const body = host.iframe!.contentDocument!.body;
    const originalText = body.firstChild!;
    const originalInsertBefore = body.insertBefore.bind(body);
    const insert = vi.spyOn(body, 'insertBefore').mockImplementationOnce(() => {
      throw new Error('synthetic apply failure');
    });

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children',
        nodeId: 3,
        children: [{
          kind: 'graph',
          node: {
            kind: 'element', id: 5, namespace: 'html', tagName: 'p',
            attributes: [], children: [{
              kind: 'text', id: 6, text: 'partial', translatable: true,
            }],
          },
        }],
      }, {
        kind: 'dimensions',
        viewportWidth: 300,
        viewportHeight: 200,
        documentWidth: 400,
        documentHeight: 500,
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);
    insert.mockRestore();
    body.insertBefore = originalInsertBefore;

    expect(body.firstChild).toBe(originalText);
    expect(body.textContent).toBe('last good');
    expect(engine.snapshot()?.records).toEqual([
      expect.objectContaining({ nodeId: 4, source: 'last good', revision: 1 }),
    ]);
    expect(stream.acknowledged).not.toContain(1);
    expect(stream.requested).toEqual([0]);
  });

  it('allows privacy attributes and replacement children on one target atomically', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('public value', 0));
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [
        {
          kind: 'attributes',
          namespace: 'html',
          nodeId: 3,
          tagName: 'body',
          attributes: [['role', 'textbox']],
        },
        {
          kind: 'children',
          nodeId: 3,
          children: [{
            kind: 'text', id: 4, text: '', translatable: false,
          }],
        },
      ],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(host.iframe?.contentDocument?.body.getAttribute('role')).toBe('textbox');
    expect(host.iframe?.contentDocument?.body.textContent).toBe('');
    expect(stream.acknowledged).toContain(1);
    expect(infos.find(({ stage }) => stage === 'patch')).toMatchObject({
      operationCount: 2,
      attributeOperationCount: 1,
      childrenOperationCount: 1,
      textOperationCount: 0,
      dimensionOperationCount: 0,
      replacementNodeCount: 1,
      largestReplacementNodeCount: 1,
      fullReplacementFallbackCount: 1,
    });
  });

  it('reports outgoing replacement size when a children patch clears a subtree', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('removed value', 0));
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{ kind: 'children', nodeId: 3, children: [] }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(host.iframe?.contentDocument?.body.textContent).toBe('');
    expect(infos.find(({ stage }) => stage === 'patch')).toMatchObject({
      operationCount: 1,
      childrenOperationCount: 1,
      replacementNodeCount: 1,
      largestReplacementNodeCount: 1,
    });
  });

  it('keeps checkpoint representability separate from patch-event counters', async () => {
    const base = makeCheckpoint('source', 0);
    const baseline = createHtmlMirrorRepresentabilityCollector();
    baseline.unsafeElementOmissionCount = 2;
    const checkpoint = createHtmlMirrorCheckpoint(base.identity, {
      root: base.payload.root,
      adoptedStyleSheets: base.payload.adoptedStyleSheets,
      captureMs: base.payload.captureMs,
      viewportWidth: base.payload.viewportWidth,
      viewportHeight: base.payload.viewportHeight,
      documentWidth: base.payload.documentWidth,
      documentHeight: base.payload.documentHeight,
      representability: baseline,
    })!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);

    const event = createHtmlMirrorRepresentabilityCollector();
    event.unsafeElementOmissionCount = 3;
    event.replicaRequestCapableResourceCount = 1;
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'dimensions', viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      }],
      event,
    )!);
    expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
      fidelityPolicy: 'conservative',
      replicaRequestsMayOccur: true,
      unsafeElementOmissionCount: 2,
      eventRepresentability: {
        unsafeElementOmissionCount: 3,
        replicaRequestCapableResourceCount: 1,
      },
    });

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{
        kind: 'dimensions', viewportWidth: 801, viewportHeight: 600,
        documentWidth: 801, documentHeight: 1000,
      }],
    )!);
    expect(infos.findLast(({ stage }) => stage === 'patch')).toMatchObject({
      fidelityPolicy: 'conservative',
      replicaRequestsMayOccur: true,
      unsafeElementOmissionCount: 2,
      eventRepresentability: {
        unsafeElementOmissionCount: 0,
        replicaRequestCapableResourceCount: 0,
      },
    });
  });

  it('applies a carousel move that replaces a slide while the wrapper moves', async () => {
    // Swiper's move on freee.co.jp: the slide that comes into view has its
    // content re-sent while the wrapper's transform changes in the same batch.
    // Refusing the pair rebuilt the whole mirror on every move (D56).
    const stream = new FakeHtmlStream(makeCarouselCheckpoint());
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    const engine = makeEngine(stream, host, (info) => infos.push(info));
    await engine.run(request);
    const replica = host.iframe!.contentDocument!;
    const wrapper = replica.querySelector('.swiper-wrapper')!;
    const slide = replica.querySelector('.kvslide1')!;

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [
        {
          kind: 'children',
          nodeId: 5,
          children: [{
            kind: 'element', id: 6, namespace: 'html', tagName: 'div',
            attributes: [], children: [{
              kind: 'text', id: 7, text: 'slide one in view', translatable: true,
            }],
          }],
        },
        {
          kind: 'attributes',
          namespace: 'html',
          nodeId: 4,
          tagName: 'div',
          attributes: [
            ['class', 'swiper-wrapper'],
            ['style', 'transform: translate3d(-2136px, 0px, 0px)'],
          ],
        },
      ],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(stream.requested).toEqual([]);
    expect(stream.acknowledged).toContain(1);
    expect(infos.some(({ stage }) => stage === 'recovery')).toBe(false);
    expect(replica.querySelector('.swiper-wrapper')).toBe(wrapper);
    expect(replica.querySelector('.kvslide1')).toBe(slide);
    expect(wrapper.getAttribute('style')).toContain('-2136px');
    expect(slide.textContent).toBe('slide one in view');
    expect(replica.querySelector('.kvslide2')?.textContent).toBe('slide two');
  });

  it('still refuses a wrapper that turns private beside a slide replacement', async () => {
    const stream = new FakeHtmlStream(makeCarouselCheckpoint());
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);
    const replica = host.iframe!.contentDocument!;

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [
        {
          kind: 'children',
          nodeId: 5,
          children: [{
            kind: 'element', id: 6, namespace: 'html', tagName: 'div',
            attributes: [], children: [{
              kind: 'text', id: 7, text: 'value typed into the region', translatable: true,
            }],
          }],
        },
        {
          kind: 'attributes',
          namespace: 'html',
          nodeId: 4,
          tagName: 'div',
          attributes: [['class', 'swiper-wrapper'], ['role', 'textbox']],
        },
      ],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(stream.requested).toEqual([0]);
    expect(stream.acknowledged).not.toContain(1);
    expect(replica.querySelector('.swiper-wrapper')?.hasAttribute('role')).toBe(false);
    expect(replica.querySelector('.kvslide1')?.textContent).toBe('slide one');
  });

  it('rejects an activation transition that does not re-sanitize descendants', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('public value', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes',
        namespace: 'html',
        nodeId: 3,
        tagName: 'body',
        attributes: [['role', 'button']],
      }],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    expect(host.iframe?.contentDocument?.body.hasAttribute('role')).toBe(false);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('public value');
    expect(stream.requested).toEqual([0]);
  });

  it('requires checkpoint recovery when a shadow host tightens privacy', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'div',
              attributes: [], children: [], shadowRoot: {
                id: 5,
                mode: 'open',
                adoptedStyleSheets: [],
                children: [{
                  kind: 'text', id: 6, text: 'public shadow text', translatable: true,
                }],
              },
            }] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [
        {
          kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'div',
          attributes: [['role', 'textbox']],
        },
        { kind: 'children', nodeId: 4, children: [] },
      ],
    );
    expect(patch).toBeDefined();
    stream.observer?.onPatch(patch!);

    const replicaHost = host.iframe?.contentDocument?.querySelector('div');
    expect(replicaHost?.hasAttribute('role')).toBe(false);
    expect(replicaHost?.shadowRoot?.firstChild?.nodeValue).toBe(
      'public shadow text',
    );
    expect(stream.requested).toEqual([0]);
  });

  it('rejects private state before an activation-descendant patch is admitted', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'button',
              attributes: [], children: [{
                kind: 'element', id: 5, namespace: 'html', tagName: 'span',
                attributes: [], children: [{
                  kind: 'text', id: 6, text: 'public activation label', translatable: true,
                }],
              }],
            }],
          }],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const patch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes',
        namespace: 'html',
        nodeId: 5,
        tagName: 'span',
        // Control state travels only through the semantic channel; author
        // text such as `title` is page markup since D76.
        attributes: [['aria-checked', 'true']],
      }],
    );
    expect(patch).toBeUndefined();

    const span = host.iframe?.contentDocument?.querySelector('button span');
    expect(span?.textContent).toBe('public activation label');
    expect(span?.hasAttribute('aria-checked')).toBe(false);
    expect(stream.requested).toEqual([]);
  });

  it('preserves the owned CSP shell while replacing mirrored head children', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('hello', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'children',
        nodeId: 2,
        children: [{
          kind: 'element', id: 10, namespace: 'html', tagName: 'style',
          attributes: [], children: [{
            kind: 'text', id: 11, text: '.hero{color:red}', translatable: false,
          }],
        }],
      }],
    )!);

    const head = host.iframe?.contentDocument?.head;
    expect(head?.querySelector('[data-simul-owned-shell="csp"]')).not.toBeNull();
    expect(head?.querySelector('[data-simul-owned-shell="inert"]')).not.toBeNull();
    expect(head?.textContent).toContain('.hero{color:red}');
  });

  it('settles a Reddit-shaped three-column candidate and keeps accessibility labels hidden', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [
              {
                kind: 'element', id: 4, namespace: 'html', tagName: 'link',
                attributes: [['rel', 'stylesheet'], ['href', 'https://static.example.test/shell.css']],
                children: [],
              },
              {
                kind: 'element', id: 14, namespace: 'html', tagName: 'link',
                attributes: [['rel', 'stylesheet'], ['href', 'https://static.example.test/failing.css']],
                children: [],
              },
            ] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [
              { kind: 'element', id: 5, namespace: 'html', tagName: 'aside', attributes: [], children: [
                { kind: 'text', id: 6, text: 'left rail', translatable: true },
              ] },
              { kind: 'element', id: 7, namespace: 'html', tagName: 'main', attributes: [], children: [
                { kind: 'text', id: 8, text: 'center content', translatable: true },
                { kind: 'element', id: 9, namespace: 'html', tagName: 'faceplate-screen-reader-content',
                  attributes: [], visuallyHidden: true, children: [], shadowRoot: {
                    id: 10, mode: 'open', children: [
                      {
                        kind: 'text', id: 11, text: 'Vote', translatable: true,
                      },
                      {
                        kind: 'element', id: 16, namespace: 'html', tagName: 'link',
                        attributes: [['rel', 'stylesheet'], ['href', 'https://static.example.test/shadow.css']],
                        children: [],
                      },
                    ], adoptedStyleSheets: [':host{display:block}'],
                  } },
                { kind: 'element', id: 15, namespace: 'html', tagName: 'img',
                  attributes: [['src', 'https://static.example.test/fallback.jpg'], ['srcset', 'https://static.example.test/fallback@2x.jpg 2x']],
                  selectedImageSource: 'https://static.example.test/selected.jpg', children: [] },
              ] },
              { kind: 'element', id: 12, namespace: 'html', tagName: 'aside', attributes: [], children: [] },
            ] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 1200,
        viewportHeight: 800,
        documentWidth: 1200,
        documentHeight: 1600,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    let replicaDocument: Document | undefined;
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      styleSettleDeadlineMs: 1_000,
      initializeIframe: async (iframe, shell) => {
        const parsed = parseHTML(shell);
        replicaDocument = parsed.document;
        Object.defineProperty(iframe, 'contentDocument', { value: parsed.document });
        return parsed.document;
      },
      onInfo: (info) => infos.push(info),
    });

    const running = engine.run(request);
    await vi.waitFor(() => expect(
      replicaDocument?.querySelector('link[rel="stylesheet"]'),
    ).toBeTruthy());
    const links = [...replicaDocument!.querySelectorAll('link')];
    const loadEvent = replicaDocument!.createEvent('Event');
    loadEvent.initEvent('load', false, false);
    links[0]?.dispatchEvent(loadEvent);
    const errorEvent = replicaDocument!.createEvent('Event');
    errorEvent.initEvent('error', false, false);
    links[1]?.dispatchEvent(errorEvent);
    const shadowLink = replicaDocument!
      .querySelector('faceplate-screen-reader-content')
      ?.shadowRoot?.querySelector('link');
    shadowLink?.dispatchEvent(loadEvent);
    await expect(running).resolves.toMatchObject({ status: 'complete' });

    const body = host.iframe?.contentDocument?.body;
    expect(body?.textContent).toContain('left rail');
    expect(body?.textContent).toContain('center content');
    const hidden = body?.querySelector('faceplate-screen-reader-content') as
      HTMLElement | null;
    expect(hidden?.getAttribute('data-simul-visually-hidden')).toBe('v1');
    expect(hidden?.style.width).toBe('1px');
    expect(body?.querySelector('main')?.hasAttribute('data-simul-visually-hidden'))
      .toBe(false);
    const responsive = body?.querySelector('img');
    expect(responsive?.getAttribute('src'))
      .toBe('https://static.example.test/selected.jpg');
    expect(responsive?.hasAttribute('srcset')).toBe(false);
    expect(infos.find(({ stage }) => stage === 'checkpoint')).toMatchObject({
      openShadowRootCount: 1,
      adoptedStyleCount: 1,
      visuallyHiddenCount: 1,
      selectedImageSourceCount: 1,
      stylesheetLinkCount: 3,
      stylesheetLoadedCount: 2,
      stylesheetErrorCount: 1,
      stylesheetTimedOutCount: 0,
    });

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{ kind: 'children', nodeId: 12, children: [{
        kind: 'text', id: 13, text: 'late right rail', translatable: true,
      }] }],
    )!);
    expect(body?.textContent).toContain('late right rail');
  });

  it('defines only the custom elements the page has defined, with empty classes (D83)', async () => {
    const element = (
      id: number,
      tagName: string,
      customElementDefined: boolean,
    ): HtmlMirrorNode => ({
      kind: 'element', id, namespace: 'html', tagName, attributes: [],
      children: [],
      ...(customElementDefined ? { customElementDefined: true as const } : {}),
    });
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [
              element(4, 'shreddit-feed', true),
              element(5, 'shreddit-feed', true),
              element(6, 'faceplate-partial', false),
            ] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const defined = new Map<string, CustomElementConstructor>();
    let replicaHtmlElement: unknown;
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const parsed = parseHTML(shell);
        replicaHtmlElement = parsed.window.HTMLElement;
        // linkedom cannot match :defined; record what the engine registers.
        Object.defineProperty(parsed.document, 'defaultView', {
          value: {
            HTMLElement: parsed.window.HTMLElement,
            customElements: {
              get: (name: string) => defined.get(name),
              define: (name: string, constructor: CustomElementConstructor) => {
                if (defined.has(name)) throw new Error('already defined');
                defined.set(name, constructor);
              },
            },
          },
        });
        Object.defineProperty(iframe, 'contentDocument', { value: parsed.document });
        return parsed.document;
      },
    });

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    expect([...defined.keys()]).toEqual(['shreddit-feed']);
    const constructor = defined.get('shreddit-feed')!;
    expect(Object.getPrototypeOf(constructor)).toBe(replicaHtmlElement);
    expect(Object.getOwnPropertyNames(constructor.prototype)).toEqual(['constructor']);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes', nodeId: 6, namespace: 'html',
        tagName: 'faceplate-partial', attributes: [], customElementDefined: true,
      }],
    )!);
    expect([...defined.keys()]).toEqual(['shreddit-feed', 'faceplate-partial']);
  });

  it('rechecks stylesheet readiness after installing load listeners', async () => {
    const stream = new FakeHtmlStream(makeStylesheetCheckpoint());
    const host = new FakePresentationHost();
    const infos: IsolatedMirrorInfo[] = [];
    let sheetReads = 0;
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      styleSettleDeadlineMs: 100,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        // HTML mirror elements are created through createElement.
        const createElement = document.createElement.bind(document);
        Object.defineProperty(document, 'createElement', {
          configurable: true,
          value: (tagName: string) => {
            const element = createElement(tagName);
            if (tagName === 'link') {
              Object.defineProperty(element, 'sheet', {
                configurable: true,
                get: () => ++sheetReads >= 2 ? {} : null,
              });
            }
            return element;
          },
        });
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
      onInfo: (info) => infos.push(info),
    });

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    expect(sheetReads).toBe(2);
    expect(infos.find(({ stage }) => stage === 'checkpoint')).toMatchObject({
      stylesheetLinkCount: 1,
      stylesheetLoadedCount: 1,
      stylesheetErrorCount: 0,
      stylesheetTimedOutCount: 0,
    });
  });

  it('uses resolved passive CSSOM text instead of refetching the linked stylesheet', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [{
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [{
              kind: 'element', id: 5, namespace: 'html', tagName: 'link',
              attributes: [
                ['disabled', ''],
                ['rel', 'stylesheet'],
                ['href', 'https://cdn.example.test/theme.css'],
                ['integrity', 'sha384-source-response-hash'],
              ],
              resolvedStyleSheetText: '.page{display:grid;color:#fff}',
              children: [],
            }],
          }, {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [['class', 'page']], children: [{
              kind: 'text', id: 4, text: 'styled content', translatable: true,
            }],
          }],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
      'passive',
    );
    if (!checkpoint) throw new Error('Passive stylesheet fixture rejected.');
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const policies: string[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      getReplicaFidelityPolicy: () => 'passive',
      openStream: async (_request, policy) => {
        policies.push(policy);
        return stream;
      },
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        // HTML mirror elements are created through createElement.
        const createElement = document.createElement.bind(document);
        Object.defineProperty(document, 'createElement', {
          configurable: true,
          value: (tagName: string) => {
            const element = createElement(tagName);
            if (tagName === 'link') {
              Object.defineProperty(element, 'disabled', {
                configurable: true,
                writable: true,
                value: false,
              });
              Object.defineProperty(element, 'sheet', {
                configurable: true,
                value: {},
              });
            }
            return element;
          },
        });
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });

    expect(policies).toEqual(['passive']);
    const link = host.iframe?.contentDocument?.querySelector<HTMLLinkElement>(
      'link[data-simul-resolved-stylesheet="v1"]',
    );
    expect(link?.getAttribute('href')).toBe(
      `data:text/css;charset=utf-8,${encodeURIComponent(
        '.page{display:grid;color:#fff}',
      )}`,
    );
    expect(link?.getAttribute('href')).not.toContain('cdn.example.test');
    expect(link?.hasAttribute('disabled')).toBe(true);
    expect(link?.disabled).toBe(true);
    expect(link?.hasAttribute('integrity')).toBe(false);
  });

  it('uses one absolute style deadline for both paint waits', async () => {
    vi.useFakeTimers();
    try {
      const stream = new FakeHtmlStream(makeStylesheetCheckpoint());
      const host = new FakePresentationHost();
      const infos: IsolatedMirrorInfo[] = [];
      let paintRequests = 0;
      const engine = new IsolatedHtmlReplicaEngine({
        presentationHost: host,
        openStream: async () => stream,
        styleSettleDeadlineMs: 20,
        initializeIframe: async (iframe, shell) => {
          const { document, window } = parseHTML(shell);
          Object.defineProperties(window, {
            requestAnimationFrame: {
              configurable: true,
              value: () => {
                paintRequests += 1;
                return paintRequests;
              },
            },
            cancelAnimationFrame: { configurable: true, value: () => undefined },
          });
          Object.defineProperty(iframe, 'contentDocument', { value: document });
          return document;
        },
        onInfo: (info) => infos.push(info),
      });
      let settled = false;
      const running = engine.run(request).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(settled).toBe(true);
      expect(paintRequests).toBe(0);
      await expect(running).resolves.toMatchObject({ status: 'complete' });
      expect(infos.find(({ stage }) => stage === 'checkpoint')).toMatchObject({
        stylesheetLinkCount: 1,
        stylesheetTimedOutCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  describe('a root that assigns its slots by script', () => {
    /**
     * linkedom has no `slot.assign()`: a slot keeps what it is given, as
     * Chrome does, and says it holds those of them that are children of its
     * root's host. Every call and every `attachShadow` is recorded.
     */
    function installManualSlots() {
      const slotPrototype = Object.getPrototypeOf(
        parseHTML('<slot></slot>').document.querySelector('slot'),
      ) as object;
      const elementPrototype = Object.getPrototypeOf(Object.getPrototypeOf(slotPrototype)) as {
        attachShadow(init: ShadowRootInit): ShadowRoot;
      };
      const given = new WeakMap<object, Node[]>();
      const assigned: Array<{ slot: string | null; nodes: Node[] }> = [];
      const inits: ShadowRootInit[] = [];
      Object.defineProperties(slotPrototype, {
        assign: {
          configurable: true,
          value(this: Element, ...nodes: Node[]) {
            given.set(this, nodes);
            assigned.push({ slot: this.getAttribute('id'), nodes });
          },
        },
        assignedNodes: {
          configurable: true,
          value(this: Element) {
            const root = this.getRootNode() as ShadowRoot;
            return (given.get(this) ?? []).filter((node) => node.parentNode === root.host);
          },
        },
      });
      const attachShadow = elementPrototype.attachShadow;
      elementPrototype.attachShadow = function (init: ShadowRootInit) {
        inits.push(init);
        return attachShadow.call(this, init);
      };
      return {
        assigned,
        inits,
        restore: () => {
          delete (slotPrototype as { assign?: unknown }).assign;
          delete (slotPrototype as { assignedNodes?: unknown }).assignedNodes;
          elementPrototype.attachShadow = attachShadow;
        },
      };
    }
    const span = (id: number, text: string): HtmlMirrorNode => ({
      kind: 'element', id, namespace: 'html', tagName: 'span', attributes: [],
      children: [{ kind: 'text', id: id + 1, text, translatable: true }],
    });
    const slot = (id: number, name: string, assignedNodeIds?: number[]): HtmlMirrorNode => ({
      kind: 'element', id, namespace: 'html', tagName: 'slot',
      attributes: [['id', name]], children: [],
      ...(assignedNodeIds ? { assignedNodeIds } : {}),
    });
    function tabsCheckpoint(manual = true): HtmlMirrorCheckpoint {
      return createHtmlMirrorCheckpoint(
        createReplicaIdentity({ ...identityParts, sequence: 0 }),
        {
          root: {
            kind: 'element', id: 1, namespace: 'html', tagName: 'html',
            attributes: [], children: [
              { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
              { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [
                {
                  kind: 'element', id: 4, namespace: 'html', tagName: 'x-tabs',
                  attributes: [], children: [
                    span(5, 'one'), span(7, 'two'),
                    { kind: 'text', id: 9, text: 'direct', translatable: true },
                  ],
                  shadowRoot: {
                    id: 10, mode: 'open', adoptedStyleSheets: [],
                    ...(manual ? { slotAssignment: 'manual' as const } : {}),
                    children: [
                      // Not the page's order, not by name; one node is not
                      // a child of the host and one is not in the mirror.
                      slot(12, 'first', [7, 9, 3, 99]), slot(14, 'second', [5]),
                    ],
                  },
                },
                { kind: 'element', id: 30, namespace: 'html', tagName: 'p', attributes: [], children: [
                  { kind: 'text', id: 31, text: 'elsewhere', translatable: true },
                ] },
              ] },
            ],
          },
          adoptedStyleSheets: [],
          captureMs: 1,
          viewportWidth: 800,
          viewportHeight: 600,
          documentWidth: 800,
          documentHeight: 1000,
        },
      )!;
    }
    const patch = (
      sequence: number,
      operations: Parameters<typeof createHtmlMirrorPatch>[3],
    ) => createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence }), sequence, sequence, operations,
    )!;
    const texts = (nodes: readonly Node[]): string[] =>
      nodes.map((node) => node.textContent ?? '');

    it('builds the root that way and gives each slot the nodes the page\'s slot holds', async () => {
      const manual = installManualSlots();
      try {
        const stream = new FakeHtmlStream(tabsCheckpoint());
        const host = new FakePresentationHost();
        await expect(makeEngine(stream, host).run(request))
          .resolves.toMatchObject({ status: 'complete' });
        expect(manual.inits).toContainEqual({ mode: 'open', slotAssignment: 'manual' });
        expect(manual.assigned.map(({ slot: id, nodes }) => [id, texts(nodes)])).toEqual([
          ['first', ['two', 'direct']],
          ['second', ['one']],
        ]);
        const tabs = host.iframe!.contentDocument!.querySelector('x-tabs')!;
        expect(manual.assigned.flatMap(({ nodes }) => nodes)
          .every((node) => node.parentNode === tabs)).toBe(true);
      } finally {
        manual.restore();
      }
    });

    it('gives a slot other nodes when the page says it holds others', async () => {
      const manual = installManualSlots();
      try {
        const stream = new FakeHtmlStream(tabsCheckpoint());
        await makeEngine(stream, new FakePresentationHost()).run(request);
        manual.assigned.length = 0;
        stream.observer?.onPatch(patch(1, [
          { kind: 'attributes', nodeId: 12, namespace: 'html', tagName: 'slot', attributes: [['id', 'first']], assignedNodeIds: [5] },
          { kind: 'attributes', nodeId: 14, namespace: 'html', tagName: 'slot', attributes: [['id', 'second']], assignedNodeIds: [] },
        ]));
        expect(stream.requested).toEqual([]);
        expect(manual.assigned.map(({ slot: id, nodes }) => [id, texts(nodes)])).toEqual([
          ['first', ['one']],
          ['second', []],
        ]);
        // The same nodes in another order are another drawing.
        manual.assigned.length = 0;
        stream.observer?.onPatch(patch(2, [
          { kind: 'attributes', nodeId: 12, namespace: 'html', tagName: 'slot', attributes: [['id', 'first']], assignedNodeIds: [5, 7] },
        ]));
        stream.observer?.onPatch(patch(3, [
          { kind: 'attributes', nodeId: 12, namespace: 'html', tagName: 'slot', attributes: [['id', 'first']], assignedNodeIds: [7, 5] },
        ]));
        expect(manual.assigned.map(({ nodes }) => texts(nodes)))
          .toEqual([['one', 'two'], ['two', 'one']]);
      } finally {
        manual.restore();
      }
    });

    it('gives the slots their nodes again after a change that built those nodes anew', async () => {
      const manual = installManualSlots();
      try {
        const stream = new FakeHtmlStream(tabsCheckpoint());
        const host = new FakePresentationHost();
        await makeEngine(stream, host).run(request);
        const before = manual.assigned.flatMap(({ nodes }) => nodes);
        manual.assigned.length = 0;
        // Something elsewhere changes: nothing is assigned again.
        stream.observer?.onPatch(patch(1, [{
          kind: 'text', nodeId: 31,
          node: { kind: 'text', id: 31, text: 'elsewhere, changed', translatable: true },
        }]));
        expect(manual.assigned).toEqual([]);
        // The host's children are sent again whole: new nodes, the same ids.
        stream.observer?.onPatch(patch(2, [{
          kind: 'children', nodeId: 4,
          children: [
            span(5, 'one'), span(7, 'two'),
            { kind: 'text', id: 9, text: 'direct', translatable: true },
          ],
        }]));
        expect(stream.requested).toEqual([]);
        expect(manual.assigned.map(({ slot: id, nodes }) => [id, texts(nodes)])).toEqual([
          ['first', ['two', 'direct']],
          ['second', ['one']],
        ]);
        expect(manual.assigned.flatMap(({ nodes }) => nodes)
          .some((node) => before.includes(node))).toBe(false);
        manual.assigned.length = 0;
        // The root's own content is built anew, slots and all.
        stream.observer?.onPatch(patch(3, [{
          kind: 'children', nodeId: 10,
          children: [slot(20, 'first', [9]), slot(21, 'second', [7, 5])],
        }]));
        expect(manual.assigned.map(({ slot: id, nodes }) => [id, texts(nodes)])).toEqual([
          ['first', ['direct']],
          ['second', ['two', 'one']],
        ]);
      } finally {
        manual.restore();
      }
    });

    it('takes a slot\'s list in the batch that brings its host a new child', async () => {
      const manual = installManualSlots();
      try {
        const stream = new FakeHtmlStream(tabsCheckpoint());
        await makeEngine(stream, new FakePresentationHost()).run(request);
        manual.assigned.length = 0;
        // One more child for the host, kept children retained, and the slot
        // that takes it: a change of the host's children leaves its root.
        stream.observer?.onPatch(patch(1, [
          {
            kind: 'reconcile-children', nodeId: 4,
            children: [
              { kind: 'retain', nodeId: 5 }, { kind: 'retain', nodeId: 7 },
              { kind: 'retain', nodeId: 9 }, { kind: 'graph', node: span(40, 'three') },
            ],
          },
          { kind: 'attributes', nodeId: 14, namespace: 'html', tagName: 'slot', attributes: [['id', 'second']], assignedNodeIds: [5, 40] },
        ]));
        expect(stream.requested).toEqual([]);
        expect(manual.assigned.map(({ slot: id, nodes }) => [id, texts(nodes)]))
          .toEqual([['second', ['one', 'three']]]);
        // The same with the host's children sent whole.
        manual.assigned.length = 0;
        stream.observer?.onPatch(patch(2, [
          {
            kind: 'children', nodeId: 4,
            children: [span(5, 'one'), span(7, 'two'), span(40, 'three'), span(50, 'four')],
          },
          { kind: 'attributes', nodeId: 12, namespace: 'html', tagName: 'slot', attributes: [['id', 'first']], assignedNodeIds: [50] },
        ]));
        expect(stream.requested).toEqual([]);
        expect(manual.assigned.map(({ slot: id, nodes }) => [id, texts(nodes)])).toEqual([
          ['first', ['four']],
          ['second', ['one', 'three']],
        ]);
      } finally {
        manual.restore();
      }
    });

    it('forgets a root that has gone from the mirror', async () => {
      const manual = installManualSlots();
      try {
        const stream = new FakeHtmlStream(tabsCheckpoint());
        const host = new FakePresentationHost();
        await makeEngine(stream, host).run(request);
        const first = host.iframe!.contentDocument!.querySelector('x-tabs')!
          .shadowRoot!.querySelector('#first')!;
        const asked = vi.spyOn(first, 'getRootNode');
        stream.observer?.onPatch(patch(1, [{
          kind: 'children', nodeId: 3, children: [span(40, 'the host is gone')],
        }]));
        asked.mockClear();
        manual.assigned.length = 0;
        stream.observer?.onPatch(patch(2, [{
          kind: 'children', nodeId: 3, children: [span(42, 'changed again')],
        }]));
        expect(asked).not.toHaveBeenCalled();
        expect(manual.assigned).toEqual([]);
      } finally {
        manual.restore();
      }
    });

    it('gives a slot the box Simul draws a dropdown in, not the dropdown inside it', async () => {
      const manual = installManualSlots();
      try {
        const checkpoint = createHtmlMirrorCheckpoint(
          createReplicaIdentity({ ...identityParts, sequence: 0 }),
          {
            root: {
              kind: 'element', id: 1, namespace: 'html', tagName: 'html',
              attributes: [], children: [
                { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
                { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
                  kind: 'element', id: 4, namespace: 'html', tagName: 'x-tabs',
                  attributes: [], children: [{
                    kind: 'element', id: 5, namespace: 'html', tagName: 'select',
                    attributes: [], children: [{
                      kind: 'element', id: 6, namespace: 'html', tagName: 'option',
                      attributes: [], children: [],
                    }],
                  }],
                  shadowRoot: {
                    id: 10, mode: 'open', adoptedStyleSheets: [], slotAssignment: 'manual',
                    children: [slot(12, 'first', [5])],
                  },
                }] },
              ],
            },
            adoptedStyleSheets: [], captureMs: 1,
            viewportWidth: 800, viewportHeight: 600,
            documentWidth: 800, documentHeight: 1000,
          },
        )!;
        const host = new FakePresentationHost();
        await expect(makeEngine(new FakeHtmlStream(checkpoint), host).run(request))
          .resolves.toMatchObject({ status: 'complete' });
        const tabs = host.iframe!.contentDocument!.querySelector('x-tabs')!;
        expect(manual.assigned).toHaveLength(1);
        const [box] = manual.assigned[0]!.nodes as Element[];
        expect(box!.parentNode).toBe(tabs);
        expect(box!.localName).not.toBe('select');
        expect(box!.shadowRoot?.querySelector('select')).not.toBeNull();
      } finally {
        manual.restore();
      }
    });

    it('draws the page all the same when a slot cannot be given its nodes', async () => {
      const manual = installManualSlots();
      const slotPrototype = Object.getPrototypeOf(
        parseHTML('<slot></slot>').document.querySelector('slot'),
      ) as object;
      Object.defineProperty(slotPrototype, 'assign', {
        configurable: true,
        value() {
          throw new TypeError('cannot assign');
        },
      });
      try {
        const stream = new FakeHtmlStream(tabsCheckpoint());
        const host = new FakePresentationHost();
        await expect(makeEngine(stream, host).run(request))
          .resolves.toMatchObject({ status: 'complete' });
        expect(host.iframe!.contentDocument!.querySelector('p')?.textContent)
          .toBe('elsewhere');
        stream.observer?.onPatch(patch(1, [{
          kind: 'text', nodeId: 31,
          node: { kind: 'text', id: 31, text: 'elsewhere, changed', translatable: true },
        }]));
        expect(stream.requested).toEqual([]);
        expect(host.iframe!.contentDocument!.querySelector('p')?.textContent)
          .toBe('elsewhere, changed');
      } finally {
        manual.restore();
      }
    });

    it('assigns nothing by script where the browser assigns by name', async () => {
      const manual = installManualSlots();
      try {
        const stream = new FakeHtmlStream(tabsCheckpoint(false));
        await expect(makeEngine(stream, new FakePresentationHost()).run(request))
          .resolves.toMatchObject({ status: 'complete' });
        expect(manual.inits).toContainEqual({ mode: 'open' });
        expect(manual.inits.some((init) => 'slotAssignment' in init)).toBe(false);
        expect(manual.assigned).toEqual([]);
      } finally {
        manual.restore();
      }
    });
  });

  it('reconstructs accessible open shadow roots without definitions or scripts', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'x-site-card',
              attributes: [], children: [], shadowRoot: {
                id: 5, mode: 'open', children: [{
                  kind: 'text', id: 6, text: 'shadow text', translatable: true,
                }],
                adoptedStyleSheets: [':host{display:block}.card{display:grid}'],
              },
            }] },
          ],
        },
        adoptedStyleSheets: ['body{display:block}.page{display:flex}'],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const card = host.iframe?.contentDocument?.querySelector('x-site-card');
    expect(card?.shadowRoot?.firstChild?.nodeValue).toBe('shadow text');
    expect(card?.shadowRoot?.lastChild).toMatchObject({
      localName: 'style',
      textContent: ':host{display:block}.card{display:grid}',
    });
    expect(
      (card?.shadowRoot?.lastChild as Element | undefined)?.getAttribute(
        'data-simul-adopted-style',
      ),
    ).toBe('shadow');
    const body = host.iframe?.contentDocument?.body;
    expect(body?.lastElementChild).toMatchObject({
      localName: 'style',
      textContent: 'body{display:block}.page{display:flex}',
    });
    expect(body?.lastElementChild?.getAttribute('data-simul-adopted-style'))
      .toBe('document');
    expect(engine.snapshot()?.records.map(({ source }) => source)).toEqual([
      'shadow text',
    ]);

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'children',
        nodeId: 5,
        children: [{
          kind: 'text', id: 7, text: 'updated shadow', translatable: true,
        }],
      }],
    )!);
    expect(card?.shadowRoot?.firstChild?.nodeValue).toBe('updated shadow');
    expect(
      (card?.shadowRoot?.lastChild as Element | undefined)?.getAttribute(
        'data-simul-adopted-style',
      ),
    ).toBe('shadow');

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{
        kind: 'children',
        nodeId: 3,
        children: [{
          kind: 'element', id: 8, namespace: 'html', tagName: 'main',
          attributes: [['class', 'page']], children: [{
            kind: 'text', id: 9, text: 'new page', translatable: true,
          }],
        }],
      }],
    )!);
    expect(body?.firstElementChild?.localName).toBe('main');
    expect(body?.lastElementChild?.getAttribute('data-simul-adopted-style'))
      .toBe('document');
  });

  it('builds a shadow root on body and patches inside it (D135)', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            {
              kind: 'element', id: 3, namespace: 'html', tagName: 'body',
              attributes: [['class', 'app']],
              children: [{
                kind: 'element', id: 4, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 5, text: 'light child', translatable: true,
                }],
              }],
              shadowRoot: {
                id: 6, mode: 'open', children: [
                  {
                    kind: 'element', id: 7, namespace: 'html', tagName: 'h1',
                    attributes: [], children: [{
                      kind: 'text', id: 8, text: 'root heading', translatable: true,
                    }],
                  },
                  { kind: 'element', id: 9, namespace: 'html', tagName: 'slot', attributes: [], children: [] },
                ],
                adoptedStyleSheets: ['h1{color:red}'],
              },
            },
          ],
        },
        adoptedStyleSheets: ['body{margin:0}'],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const body = host.iframe?.contentDocument?.body;
    const shadow = body?.shadowRoot;
    expect(shadow?.firstElementChild?.localName).toBe('h1');
    expect(shadow?.firstElementChild?.textContent).toBe('root heading');
    expect(shadow?.querySelector('slot')).not.toBeNull();
    // The root's own adopted sheet is the root's; the document's stays a
    // child of body, where it styles the document.
    expect(
      [...shadow?.querySelectorAll('style[data-simul-adopted-style="shadow"]') ?? []]
        .map((style) => style.textContent),
    ).toEqual(['h1{color:red}']);
    expect(body?.lastElementChild).toMatchObject({
      localName: 'style',
      textContent: 'body{margin:0}',
    });
    expect(body?.querySelector('p')?.textContent).toBe('light child');
    expect(engine.snapshot()?.records.map(({ source }) => source).sort()).toEqual([
      'light child',
      'root heading',
    ]);

    // A change inside the root is a patch, not a new mirror.
    expect(stream.requested).toEqual([]);
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{ kind: 'text', nodeId: 8, node: { kind: 'text', id: 8, text: 'changed heading', translatable: true } }],
    )!);
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [
        {
          kind: 'reconcile-children',
          nodeId: 6,
          children: [
            { kind: 'retain', nodeId: 7 },
            { kind: 'retain', nodeId: 9 },
            {
              kind: 'graph',
              node: {
                kind: 'element', id: 10, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 11, text: 'root end', translatable: true,
                }],
              },
            },
          ],
        },
      ],
    )!);
    expect(stream.requested).toEqual([]);
    expect(host.iframe?.contentDocument?.body.shadowRoot).toBe(shadow);
    expect(shadow?.firstElementChild?.textContent).toBe('changed heading');
    expect(shadow?.querySelector('p')?.textContent).toBe('root end');
    expect(engine.snapshot()?.records.map(({ source }) => source).sort()).toEqual([
      'changed heading',
      'light child',
      'root end',
    ]);
  });

  it('builds what else sits under html, in the page\'s order, and patches it (D135)', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'text', id: 3, text: '\n', translatable: false },
            {
              kind: 'element', id: 4, namespace: 'html', tagName: 'div',
              attributes: [['id', 'between']], children: [{
                kind: 'text', id: 5, text: 'between head and body', translatable: true,
              }],
            },
            {
              kind: 'element', id: 6, namespace: 'html', tagName: 'body',
              attributes: [], children: [{
                kind: 'text', id: 7, text: 'in body', translatable: true,
              }],
            },
            {
              kind: 'element', id: 8, namespace: 'html', tagName: 'x-overlay',
              attributes: [['id', 'after']], children: [], shadowRoot: {
                id: 9, mode: 'open', children: [{
                  kind: 'text', id: 10, text: 'a dialog beside body', translatable: true,
                }],
                adoptedStyleSheets: [],
              },
            },
            // A second body is no part of the mirror's shell: it is built
            // like any other element, after the page's own (D143).
            {
              kind: 'element', id: 11, namespace: 'html', tagName: 'body',
              attributes: [], children: [{
                kind: 'text', id: 12, text: 'a second body', translatable: true,
              }],
            },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const html = host.iframe!.contentDocument!.documentElement;
    // The mirrored children of html, in order. (The test DOM takes whatever
    // follows head for the body and adds one when asked for `document.body`
    // after a reorder; Chrome takes the first body. So only mirrored nodes
    // are looked at.)
    const names = (): string[] => {
      const mirrored = new Set(
        Array.from({ length: 20 }, (_, id) => host.resolveNode?.(id)),
      );
      return [...html.childNodes].filter((node) => mirrored.has(node)).map(
        (node) => node.nodeType === 3 ? '#text' : (node as Element).localName,
      );
    };
    expect(names()).toEqual(['head', '#text', 'div', 'body', 'x-overlay', 'body']);
    expect(html.querySelector('#between')?.textContent).toBe('between head and body');
    expect(html.querySelector('#after')?.shadowRoot?.firstChild?.nodeValue)
      .toBe('a dialog beside body');
    // The shell's own head and body are the ones the page's became.
    expect(
      (host.resolveNode?.(2) as Element).querySelector(
        'meta[data-simul-owned-shell="csp"]',
      ),
    ).not.toBeNull();
    expect(host.resolveNode?.(6)?.textContent).toBe('in body');
    expect(host.resolveNode?.(11)?.textContent).toBe('a second body');
    expect(host.resolveNode?.(11)).not.toBe(host.resolveNode?.(6));
    expect(engine.snapshot()?.records.map(({ source }) => source).sort()).toEqual([
      'a dialog beside body',
      'a second body',
      'between head and body',
      'in body',
    ]);

    // A child added beside body later, and a change inside one that was
    // there, are patches: the mirror is not built again.
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{ kind: 'text', nodeId: 5, node: { kind: 'text', id: 5, text: 'changed', translatable: true } }],
    )!);
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [
        {
          kind: 'reconcile-children',
          nodeId: 1,
          children: [
            { kind: 'retain', nodeId: 2 },
            { kind: 'retain', nodeId: 3 },
            { kind: 'retain', nodeId: 4 },
            { kind: 'retain', nodeId: 6 },
            {
              kind: 'graph',
              node: {
                kind: 'element', id: 13, namespace: 'html', tagName: 'div',
                attributes: [['id', 'late']], children: [{
                  kind: 'text', id: 14, text: 'added later', translatable: true,
                }],
              },
            },
          ],
        },
      ],
    )!);
    expect(stream.requested).toEqual([]);
    expect(names()).toEqual(['head', '#text', 'div', 'body', 'div']);
    expect(html.querySelector('#between')?.textContent).toBe('changed');
    expect(html.querySelector('#late')?.textContent).toBe('added later');
    expect(html.querySelector('#after')).toBeNull();
    expect(engine.snapshot()?.records.map(({ source }) => source).sort()).toEqual([
      'added later',
      'changed',
      'in body',
    ]);
  });

  it('builds an html, head or body element that is not the document\'s own like any other (D143)', async () => {
    // One a script made inside a block, and a parsed document hung in a
    // shadow root (a mail reader's message). Refused, such a page had no
    // mirror at all.
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            {
              kind: 'element', id: 3, namespace: 'html', tagName: 'body',
              attributes: [], children: [
                {
                  kind: 'element', id: 4, namespace: 'html', tagName: 'div',
                  attributes: [['id', 'holder']], children: [{
                    kind: 'element', id: 5, namespace: 'html', tagName: 'body',
                    attributes: [['class', 'inner']], children: [{
                      kind: 'text', id: 6, text: 'a body inside a block', translatable: true,
                    }],
                  }],
                },
                {
                  kind: 'element', id: 7, namespace: 'html', tagName: 'x-mail',
                  attributes: [], children: [], shadowRoot: {
                    id: 8, mode: 'open', adoptedStyleSheets: [], children: [{
                      kind: 'element', id: 9, namespace: 'html', tagName: 'html',
                      attributes: [], children: [
                        {
                          kind: 'element', id: 10, namespace: 'html', tagName: 'head',
                          attributes: [], children: [{
                            kind: 'element', id: 11, namespace: 'html', tagName: 'title',
                            attributes: [], children: [{
                              kind: 'text', id: 12, text: 'a title', translatable: false,
                            }],
                          }],
                        },
                        {
                          kind: 'element', id: 13, namespace: 'html', tagName: 'body',
                          attributes: [], children: [{
                            kind: 'text', id: 14, text: 'a message', translatable: true,
                          }],
                        },
                      ],
                    }],
                  },
                },
              ],
            },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const inner = host.resolveNode?.(5) as Element;
    expect(inner.localName).toBe('body');
    expect(inner.parentNode).toBe(host.resolveNode?.(4));
    expect(inner.textContent).toBe('a body inside a block');
    expect(inner).not.toBe(host.resolveNode?.(3));
    const message = host.resolveNode?.(9) as Element;
    expect(message.localName).toBe('html');
    expect(message.parentNode).toBe(host.resolveNode?.(8));
    expect((host.resolveNode?.(13) as Element).textContent).toBe('a message');
    expect(engine.snapshot()?.records.map(({ source }) => source).sort()).toEqual([
      'a body inside a block',
      'a message',
    ]);

    // One added later, deep inside a patch, is built too.
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children',
        nodeId: 4,
        children: [
          { kind: 'retain', nodeId: 5 },
          {
            kind: 'graph',
            node: {
              kind: 'element', id: 20, namespace: 'html', tagName: 'section',
              attributes: [], children: [{
                kind: 'element', id: 21, namespace: 'html', tagName: 'body',
                attributes: [], children: [{
                  kind: 'text', id: 22, text: 'another, added later', translatable: true,
                }],
              }],
            },
          },
        ],
      }],
    )!);
    expect(stream.requested).toEqual([]);
    expect((host.resolveNode?.(21) as Element).localName).toBe('body');
    expect(host.resolveNode?.(21)?.textContent).toBe('another, added later');

    // And taken out like any other: only html keeps a head and a body.
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{ kind: 'reconcile-children', nodeId: 4, children: [{ kind: 'retain', nodeId: 20 }] }],
    )!);
    expect(stream.requested).toEqual([]);
    expect(host.resolveNode?.(5)).toBeUndefined();
    expect((host.resolveNode?.(4) as Element).textContent).toBe('another, added later');
  });

  it('keeps its own head and body under html, whatever a patch says (D143)', async () => {
    const start = async () => {
      const checkpoint = createHtmlMirrorCheckpoint(
        createReplicaIdentity({ ...identityParts, sequence: 0 }),
        {
          root: {
            kind: 'element', id: 1, namespace: 'html', tagName: 'html',
            attributes: [], children: [
              { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
              {
                kind: 'element', id: 3, namespace: 'html', tagName: 'body',
                attributes: [], children: [{
                  kind: 'text', id: 4, text: 'in body', translatable: true,
                }],
              },
              {
                kind: 'element', id: 5, namespace: 'html', tagName: 'body',
                attributes: [], children: [{
                  kind: 'text', id: 6, text: 'in a second body', translatable: true,
                }],
              },
            ],
          },
          adoptedStyleSheets: [],
          captureMs: 1,
          viewportWidth: 800,
          viewportHeight: 600,
          documentWidth: 800,
          documentHeight: 1000,
        },
      )!;
      const stream = new FakeHtmlStream(checkpoint);
      const host = new FakePresentationHost();
      const engine = makeEngine(stream, host);
      await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
      return { stream, host };
    };
    const patch = (operations: Parameters<typeof createHtmlMirrorPatch>[3]) =>
      createHtmlMirrorPatch(
        createReplicaIdentity({ ...identityParts, sequence: 1 }),
        1,
        1,
        operations,
      )!;
    const overlay = (id: number) => ({
      kind: 'graph' as const,
      node: {
        kind: 'element' as const, id, namespace: 'html' as const, tagName: 'div',
        attributes: [], children: [],
      },
    });

    // A child added beside them, and the second body taken out: a patch.
    let { stream, host } = await start();
    stream.observer?.onPatch(patch([{
      kind: 'reconcile-children',
      nodeId: 1,
      children: [
        { kind: 'retain', nodeId: 2 }, { kind: 'retain', nodeId: 3 }, overlay(10),
      ],
    }]));
    expect(stream.requested).toEqual([]);
    expect(host.resolveNode?.(10)?.parentNode).toBe(host.resolveNode?.(1));
    expect(host.resolveNode?.(5)).toBeUndefined();
    expect(host.resolveNode?.(3)?.textContent).toBe('in body');

    // The page's own body named no more: the mirror's stays, and the page
    // is read afresh.
    ({ stream, host } = await start());
    stream.observer?.onPatch(patch([{
      kind: 'reconcile-children',
      nodeId: 1,
      children: [{ kind: 'retain', nodeId: 2 }, { kind: 'retain', nodeId: 5 }],
    }]));
    expect(stream.requested).toEqual([0]);
    expect(host.resolveNode?.(3)?.parentNode).toBe(host.resolveNode?.(1));

    // Nor its own head.
    ({ stream, host } = await start());
    stream.observer?.onPatch(patch([{
      kind: 'reconcile-children',
      nodeId: 1,
      children: [{ kind: 'retain', nodeId: 3 }, { kind: 'retain', nodeId: 5 }],
    }]));
    expect(stream.requested).toEqual([0]);

    // Another head or body given to html by a patch: the page changed its
    // own, which is a whole read.
    for (const tagName of ['head', 'body']) {
      ({ stream, host } = await start());
      stream.observer?.onPatch(patch([{
        kind: 'reconcile-children',
        nodeId: 1,
        children: [
          { kind: 'retain', nodeId: 2 }, { kind: 'retain', nodeId: 3 },
          { kind: 'retain', nodeId: 5 },
          {
            kind: 'graph',
            node: {
              kind: 'element', id: 11, namespace: 'html', tagName,
              attributes: [], children: [],
            },
          },
        ],
      }]));
      expect(stream.requested).toEqual([0]);
      expect(host.resolveNode?.(11)).toBeUndefined();
    }

    // The whole list of html's children, with no head or body in it.
    ({ stream, host } = await start());
    stream.observer?.onPatch(patch([{
      kind: 'children',
      nodeId: 1,
      children: [overlay(12).node],
    }]));
    expect(stream.requested).toEqual([0]);
    expect(host.resolveNode?.(3)?.textContent).toBe('in body');
    expect(host.resolveNode?.(12)).toBeUndefined();
  });

  it('takes an element named head in another namespace for no head of the page (D143)', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'svg', tagName: 'head',
              attributes: [['id', 'drawn']], children: [],
            },
            {
              kind: 'element', id: 3, namespace: 'html', tagName: 'head',
              attributes: [['id', 'own']], children: [],
            },
            { kind: 'element', id: 4, namespace: 'html', tagName: 'body', attributes: [], children: [] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const own = host.resolveNode?.(3) as Element;
    expect(own.querySelector('meta[data-simul-owned-shell="csp"]')).not.toBeNull();
    expect(own.getAttribute('id')).toBe('own');
    const drawn = host.resolveNode?.(2) as Element;
    expect(drawn.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(drawn.querySelector('meta')).toBeNull();
  });

  it('leaves on a link what a patch does not change, and never gives a link with rules the page\'s address (D143)', async () => {
    // Taking `rel` and `href` off and putting them back makes the mirror
    // fetch the sheet again. A link whose rules came with it points at
    // those rules: the page's address, written first and replaced, was
    // asked for at every patch of the link.
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [{
                kind: 'element', id: 3, namespace: 'html', tagName: 'link',
                attributes: [['rel', 'stylesheet'], ['href', 'https://cdn.example.test/a.css']],
                children: [],
              }],
            },
            {
              kind: 'element', id: 4, namespace: 'html', tagName: 'body',
              attributes: [['class', 'page']], children: [],
            },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      getReplicaFidelityPolicy: () => 'passive',
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const link = host.resolveNode?.(3) as Element;
    const body = host.resolveNode?.(4) as Element;
    const writes: string[] = [];
    for (const element of [link, body]) {
      const set = element.setAttribute.bind(element);
      const remove = element.removeAttribute.bind(element);
      element.setAttribute = (name: string, value: string) => {
        writes.push(`${element.localName} set ${name}${name === 'href' ? `=${value.slice(0, 13)}` : ''}`);
        set(name, value);
      };
      element.removeAttribute = (name: string) => {
        writes.push(`${element.localName} remove ${name}`);
        remove(name);
      };
    }
    let sequence = 0;
    const send = (
      nodeId: number,
      tagName: string,
      attributes: [string, string][],
      resolvedStyleSheetText?: string,
    ): string[] => {
      sequence += 1;
      writes.length = 0;
      stream.observer?.onPatch(createHtmlMirrorPatch(
        createReplicaIdentity({ ...identityParts, sequence }),
        sequence,
        sequence,
        [{
          kind: 'attributes', nodeId, namespace: 'html', tagName, attributes,
          ...(resolvedStyleSheetText === undefined ? {} : { resolvedStyleSheetText }),
        }],
        undefined,
        'passive',
      )!);
      return writes.filter((write) => !write.includes('data-simul'));
    };
    const page: [string, string][] = [
      ['rel', 'stylesheet'], ['href', 'https://cdn.example.test/a.css'],
    ];

    // Another attribute: `rel` and `href` are not touched.
    expect(send(3, 'link', [...page, ['media', 'print']])).toEqual(['link set media']);
    expect(send(3, 'link', page)).toEqual(['link remove media']);
    // Its rules arrive: it points at them.
    expect(send(3, 'link', page, '.page{color:red}')).toEqual([
      'link remove href', 'link set href=data:text/css',
    ]);
    // Another attribute of a link with rules: nothing is asked for again,
    // and the page's address is not written.
    expect(send(3, 'link', [...page, ['media', 'print']], '.page{color:red}')).toEqual([
      'link set media',
    ]);
    expect(send(3, 'link', page, '.page{color:blue}').sort()).toEqual([
      'link remove href', 'link remove media', 'link set href=data:text/css',
    ]);
    expect(link.getAttribute('href')).toBe(
      `data:text/css;charset=utf-8,${encodeURIComponent('.page{color:blue}')}`,
    );
    expect(host.resolveNode?.(3)).toBe(link);
    expect(stream.requested).toEqual([]);
    // Any other element is written whole, as before.
    expect(send(4, 'body', [['class', 'page'], ['lang', 'en']])).toEqual([
      'body remove class', 'body set class', 'body set lang',
    ]);
  });

  it('puts a new element in the place of a link that is switched off (D143)', async () => {
    // The mirror asks for a sheet itself, later than the page did, and
    // Chrome applies a sheet that arrives after its link was switched off:
    // a theme a page loads from another site and switches off when it has
    // loaded stayed applied in the mirror. A link that is not in the
    // document applies nothing.
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [
                { kind: 'element', id: 5, namespace: 'html', tagName: 'style', attributes: [['id', 'a']], children: [] },
                {
                  kind: 'element', id: 3, namespace: 'html', tagName: 'link',
                  attributes: [['rel', 'stylesheet'], ['href', 'https://cdn.example.test/a.css']],
                  children: [],
                },
                { kind: 'element', id: 6, namespace: 'html', tagName: 'style', attributes: [['id', 'b']], children: [] },
              ],
            },
            { kind: 'element', id: 4, namespace: 'html', tagName: 'body', attributes: [], children: [] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      getReplicaFidelityPolicy: () => 'passive',
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const head = host.resolveNode?.(2) as Element;
    const first = host.resolveNode?.(3) as Element;
    // The page's three elements in the mirror's head, in the head's order.
    const order = (): string[] => {
      const mirrored = [5, 3, 6].map((id) => host.resolveNode?.(id));
      return [...head.children].filter((child) => mirrored.includes(child)).map(
        (child) => `${child.localName}:${child.getAttribute('id') ?? child.getAttribute('href') ?? ''}`,
      );
    };
    let sequence = 0;
    const send = (operations: HtmlMirrorPatchOperation[]): void => {
      sequence += 1;
      stream.observer?.onPatch(createHtmlMirrorPatch(
        createReplicaIdentity({ ...identityParts, sequence }),
        sequence,
        sequence,
        operations,
        undefined,
        'passive',
      )!);
    };
    const link = (attributes: [string, string][]): HtmlMirrorPatchOperation => ({
      kind: 'attributes', nodeId: 3, namespace: 'html', tagName: 'link', attributes,
    });
    const page: [string, string][] = [
      ['rel', 'stylesheet'], ['href', 'https://cdn.example.test/a.css'],
    ];

    send([link([...page, ['disabled', '']])]);
    const second = host.resolveNode?.(3) as Element;
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(second.hasAttribute('disabled')).toBe(true);
    expect(order()).toEqual(['style:a', 'link:https://cdn.example.test/a.css', 'style:b']);
    // A patch of a link that is off already changes it in place.
    send([link([...page, ['disabled', ''], ['media', 'print']])]);
    expect(host.resolveNode?.(3)).toBe(second);
    expect(second.getAttribute('media')).toBe('print');
    // Switched on: the same element asks for its sheet. Off again: a new one.
    send([link(page)]);
    expect(host.resolveNode?.(3)).toBe(second);
    expect(second.hasAttribute('disabled')).toBe(false);
    send([link([...page, ['disabled', '']])]);
    const third = host.resolveNode?.(3) as Element;
    expect(third).not.toBe(second);
    expect(second.isConnected).toBe(false);
    expect(stream.acknowledged).toEqual([0, 1, 2, 3, 4]);

    // A frame whose second patch is refused, after the first switched the
    // link off, leaves the link that was there, in its place.
    send([link(page)]);
    const patch = (operations: HtmlMirrorPatchOperation[]) => createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 6 }),
      6,
      6,
      operations,
      undefined,
      'passive',
    )!;
    stream.observer?.onPatch(createHtmlMirrorPatchFrame([
      patch([link([...page, ['disabled', '']])]),
      patch([{ kind: 'reconcile-children', nodeId: 4, children: [{ kind: 'retain', nodeId: 999 }] }]),
    ])!);
    expect(stream.requested).toEqual([5]);
    expect(host.resolveNode?.(3)).toBe(third);
    expect(third.isConnected).toBe(true);
    expect(third.hasAttribute('disabled')).toBe(false);
    expect(order()).toEqual(['style:a', 'link:https://cdn.example.test/a.css', 'style:b']);
  });

  it('applies the patches of one frame of the page in one step, all or none (D143)', async () => {
    // What a page changes in a frame can take up to three patches: applied
    // in tasks of their own, the panel drew between them a state the page
    // never showed.
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [{
                kind: 'element', id: 3, namespace: 'html', tagName: 'style',
                attributes: [],
                resolvedStyleSheetText: '.page{color:red}',
                children: [{ kind: 'text', id: 4, text: '', translatable: false }],
              }],
            },
            {
              kind: 'element', id: 5, namespace: 'html', tagName: 'body',
              attributes: [], children: [{
                kind: 'element', id: 6, namespace: 'html', tagName: 'p',
                attributes: [], children: [
                  { kind: 'text', id: 7, text: 'first words', translatable: true },
                ],
              }],
            },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const commits: number[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      getReplicaFidelityPolicy: () => 'passive',
      openStream: async () => stream,
      onSourceCommit: (commit) => { commits.push(commit.changes.length); },
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const html = host.resolveNode?.(1) as Element;
    const body = host.resolveNode?.(5) as Element;
    const style = host.resolveNode?.(3) as Element;
    const patch = (
      sequence: number,
      operations: HtmlMirrorPatchOperation[],
    ) => createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence }),
      sequence,
      sequence,
      operations,
      undefined,
      'passive',
    )!;
    const dialog: HtmlMirrorPatchOperation = {
      kind: 'reconcile-children', nodeId: 1, children: [
        { kind: 'retain', nodeId: 2 }, { kind: 'retain', nodeId: 5 },
        {
          kind: 'graph', node: {
            kind: 'element', id: 10, namespace: 'html', tagName: 'div',
            attributes: [], children: [
              { kind: 'text', id: 11, text: 'a dialog', translatable: true },
            ],
          },
        },
      ],
    };
    const commitsBefore = commits.length;

    // A dialog beside body; the lock on body and a class on the dialog,
    // which the second patch names though the first has only just brought
    // it; the sheet, with what was added to it; a text in the page.
    stream.observer?.onPatch(createHtmlMirrorPatchFrame([
      patch(1, [dialog]),
      patch(1, [
        { kind: 'attributes', nodeId: 5, namespace: 'html', tagName: 'body', attributes: [['class', 'lock']] },
        { kind: 'attributes', nodeId: 10, namespace: 'html', tagName: 'div', attributes: [['class', 'open']] },
        { kind: 'text', nodeId: 7, node: { kind: 'text', id: 7, text: 'second words', translatable: true } },
      ]),
      patch(1, [
        {
          kind: 'attributes', nodeId: 3, namespace: 'html', tagName: 'style', attributes: [],
          resolvedStyleSheetText: '\n.open{color:blue}',
          resolvedStyleSheetTextFrom: '.page{color:red}'.length,
        },
        // The list of the dialog itself: what the first patch put there
        // stays, and is known as the mirror's by now.
        {
          kind: 'reconcile-children', nodeId: 10, children: [
            { kind: 'retain', nodeId: 11 },
            { kind: 'graph', node: { kind: 'text', id: 12, text: ' with more', translatable: true } },
          ],
        },
      ]),
    ])!);
    const added = host.resolveNode?.(10) as Element;
    expect(added.parentNode).toBe(html);
    expect(added.textContent).toBe('a dialog with more');
    expect(added.getAttribute('class')).toBe('open');
    expect(body.getAttribute('class')).toBe('lock');
    expect(style.textContent).toBe('.page{color:red}\n.open{color:blue}');
    expect((host.resolveNode?.(7) as Text).data).toBe('second words');
    // One answer and one report of what changed, for the frame.
    expect(stream.acknowledged).toEqual([0, 1]);
    expect(commits.length).toBe(commitsBefore + 1);
    expect(stream.requested).toEqual([]);

    // A frame whose last patch the mirror refuses changes nothing: not the
    // dialog taken out, not the class, not the sheet. The page is read
    // afresh, once.
    stream.observer?.onPatch(createHtmlMirrorPatchFrame([
      patch(2, [{
        kind: 'reconcile-children', nodeId: 1,
        children: [{ kind: 'retain', nodeId: 2 }, { kind: 'retain', nodeId: 5 }],
      }]),
      patch(2, [
        { kind: 'attributes', nodeId: 5, namespace: 'html', tagName: 'body', attributes: [] },
        {
          kind: 'attributes', nodeId: 3, namespace: 'html', tagName: 'style', attributes: [],
          resolvedStyleSheetText: '.page{color:green}',
        },
      ]),
      patch(2, [{
        kind: 'attributes', nodeId: 3, namespace: 'html', tagName: 'style', attributes: [],
        resolvedStyleSheetText: '\n.late{color:blue}',
        // Not the length of what the mirror holds for the style.
        resolvedStyleSheetTextFrom: 3,
      }]),
    ])!);
    expect(stream.requested).toEqual([1]);
    expect(stream.acknowledged).toEqual([0, 1]);
    expect(host.resolveNode?.(10)).toBe(added);
    expect(added.parentNode).toBe(html);
    expect(body.getAttribute('class')).toBe('lock');
    expect(style.textContent).toBe('.page{color:red}\n.open{color:blue}');
    expect(commits.length).toBe(commitsBefore + 1);
  });

  it('adds to the sheet text a style holds only what fits it (D143)', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [
                {
                  kind: 'element', id: 3, namespace: 'html', tagName: 'style',
                  attributes: [],
                  resolvedStyleSheetText: '.a{color:red}',
                  children: [{ kind: 'text', id: 4, text: '', translatable: false }],
                },
                {
                  // One the mirror holds by its own text (another type).
                  kind: 'element', id: 6, namespace: 'html', tagName: 'style',
                  attributes: [['type', 'text/plain']],
                  children: [{ kind: 'text', id: 7, text: '.a{color:red}', translatable: false }],
                },
              ],
            },
            { kind: 'element', id: 5, namespace: 'html', tagName: 'body', attributes: [], children: [] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      getReplicaFidelityPolicy: () => 'passive',
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const style = host.resolveNode?.(3) as Element;
    const append = (
      sequence: number,
      nodeId: number,
      attributes: [string, string][],
      text: string,
      from: number,
    ): void => {
      stream.observer?.onPatch(createHtmlMirrorPatch(
        createReplicaIdentity({ ...identityParts, sequence }),
        sequence,
        sequence,
        [{
          kind: 'attributes', nodeId, namespace: 'html', tagName: 'style', attributes,
          resolvedStyleSheetText: text,
          resolvedStyleSheetTextFrom: from,
        }],
        undefined,
        'passive',
      )!);
    };

    append(1, 3, [], '\n.b{color:red}', 13);
    append(2, 3, [], '\n.c{color:red}/', 27);
    expect(style.textContent).toBe('.a{color:red}\n.b{color:red}\n.c{color:red}/');
    expect(style.getAttribute('data-simul-resolved-stylesheet')).toBe('v1');
    expect(stream.requested).toEqual([]);
    expect(stream.acknowledged).toEqual([0, 1, 2]);
    // Each of the two is taken as a sheet's text, and the two together are
    // not: they make a comment, which the page reader takes out of a sheet
    // it sends. What is held and what is added are checked as one text.
    append(3, 3, [], '* .d{color:red} */', 42);
    expect(stream.requested).toEqual([2]);
    expect(style.textContent).toBe('.a{color:red}\n.b{color:red}\n.c{color:red}/');
  });

  it('keeps a style\'s sheet text when its list of children is sent again (D143)', async () => {
    // A patch of a style's own list (an element put into it) brings the
    // style's text nodes with the page's own text. That is not always the
    // sheet's text, which the mirror holds: a rule a script put in through
    // the sheet is in the sheet only. The sheet is sent again only when it
    // changed, so the text the mirror holds stays.
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [{
                kind: 'element', id: 3, namespace: 'html', tagName: 'style',
                attributes: [],
                resolvedStyleSheetText: '.a{color:red}\n.put-in{color:blue}',
                children: [{ kind: 'text', id: 4, text: '', translatable: false }],
              }],
            },
            { kind: 'element', id: 5, namespace: 'html', tagName: 'body', attributes: [], children: [] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      getReplicaFidelityPolicy: () => 'passive',
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const style = host.resolveNode?.(3) as Element;
    const patch = (
      sequence: number,
      operations: HtmlMirrorPatchOperation[],
    ) => createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence }),
      sequence,
      sequence,
      operations,
      undefined,
      'passive',
    )!;
    const held = '.a{color:red}\n.put-in{color:blue}';

    // Its whole list, with the page's own text in new text nodes.
    stream.observer?.onPatch(patch(1, [{
      kind: 'children', nodeId: 3, children: [
        { kind: 'text', id: 6, text: '.a{color:red}', translatable: false },
        { kind: 'text', id: 7, text: '', translatable: false },
      ],
    }]));
    expect(style.textContent).toBe(held);
    // Its list as what stays and what is new (a text node with a rule),
    // and in the frame's next patch that rule as what was added to the
    // sheet: added to the text the mirror holds, not to the text nodes'.
    // Without the first, the two were not of the length the second names,
    // the frame was refused and the page read afresh.
    stream.observer?.onPatch(createHtmlMirrorPatchFrame([
      patch(2, [{
        kind: 'reconcile-children', nodeId: 3, children: [
          { kind: 'retain', nodeId: 7 },
          // An element inside the style: its text is no part of the sheet.
          {
            kind: 'graph', node: {
              kind: 'element', id: 10, namespace: 'html', tagName: 'b', attributes: [],
              children: [{ kind: 'text', id: 11, text: 'inside a style', translatable: false }],
            },
          },
          { kind: 'graph', node: { kind: 'text', id: 8, text: '.b{color:red}', translatable: false } },
        ],
      }]),
      patch(2, [{
        kind: 'attributes', nodeId: 3, namespace: 'html', tagName: 'style', attributes: [],
        resolvedStyleSheetText: '\n.b{color:red}',
        resolvedStyleSheetTextFrom: held.length,
      }]),
    ])!);
    const ownText = (): string => [...style.childNodes].filter(
      (child) => child.nodeType === 3,
    ).map((child) => child.nodeValue).join('');
    expect(ownText()).toBe(`${held}\n.b{color:red}`);
    expect(style.querySelector('b')?.textContent).toBe('inside a style');
    expect(stream.requested).toEqual([]);
    expect(stream.acknowledged).toEqual([0, 1, 2]);

    // Sent with its list and with no sheet (its type is no style sheet any
    // more): its own text is all it holds.
    stream.observer?.onPatch(patch(3, [
      {
        kind: 'children', nodeId: 3, children: [
          { kind: 'text', id: 9, text: 'not a sheet', translatable: false },
        ],
      },
      {
        kind: 'attributes', nodeId: 3, namespace: 'html', tagName: 'style',
        attributes: [['type', 'text/plain']],
      },
    ]));
    expect(stream.requested).toEqual([]);
    expect(style.textContent).toBe('not a sheet');
    expect(style.hasAttribute('data-simul-resolved-stylesheet')).toBe(false);
  });

  it('refuses text added to a style it does not hold by its sheet\'s text (D143)', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [{
                // The mirror holds this one by its own text (another type).
                kind: 'element', id: 6, namespace: 'html', tagName: 'style',
                attributes: [['type', 'text/plain']],
                children: [{ kind: 'text', id: 7, text: '.a{color:red}', translatable: false }],
              }],
            },
            { kind: 'element', id: 5, namespace: 'html', tagName: 'body', attributes: [], children: [] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      getReplicaFidelityPolicy: () => 'passive',
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes', nodeId: 6, namespace: 'html', tagName: 'style',
        attributes: [['type', 'text/plain']],
        resolvedStyleSheetText: '\n.b{color:red}',
        resolvedStyleSheetTextFrom: 13,
      }],
      undefined,
      'passive',
    )!);
    expect(stream.requested).toEqual([0]);
    expect((host.resolveNode?.(6) as Element).textContent).toBe('.a{color:red}');
  });

  it('writes a style element\'s sheet text when a patch sends the element again (D143)', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [
                {
                  kind: 'element', id: 3, namespace: 'html', tagName: 'style',
                  attributes: [['id', 'two']],
                  resolvedStyleSheetText: '.a{color:red}\n.b{color:red}',
                  children: [
                    { kind: 'text', id: 4, text: '', translatable: false },
                    { kind: 'text', id: 5, text: '', translatable: false },
                  ],
                },
                {
                  // Rules a script put into an element with no text.
                  kind: 'element', id: 6, namespace: 'html', tagName: 'style',
                  attributes: [['id', 'empty']],
                  resolvedStyleSheetText: '.c{color:red}',
                  children: [],
                },
                {
                  // One with no sheet yet (another type).
                  kind: 'element', id: 40, namespace: 'html', tagName: 'style',
                  attributes: [['id', 'bare'], ['type', 'text/plain']],
                  children: [],
                },
              ],
            },
            { kind: 'element', id: 7, namespace: 'html', tagName: 'body', attributes: [], children: [] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      getReplicaFidelityPolicy: () => 'passive',
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const two = host.resolveNode?.(3) as Element;
    const empty = host.resolveNode?.(6) as Element;
    expect(two.textContent).toBe('.a{color:red}\n.b{color:red}');
    expect(empty.textContent).toBe('.c{color:red}');
    let sequence = 0;
    const send = (operations: Parameters<typeof createHtmlMirrorPatch>[3]) => {
      sequence += 1;
      stream.observer?.onPatch(createHtmlMirrorPatch(
        createReplicaIdentity({ ...identityParts, sequence }),
        sequence,
        sequence,
        operations,
        undefined,
        'passive',
      )!);
    };
    const again = (nodeId: number, id: string, resolvedStyleSheetText: string) => ({
      kind: 'attributes' as const, nodeId, namespace: 'html' as const, tagName: 'style',
      attributes: [['id', id]] as [string, string][], resolvedStyleSheetText,
    });

    // The element alone: its sheet's text replaces what its text nodes
    // held, once, whichever node of the page changed.
    send([again(3, 'two', '.a{color:red}\n.b{color:green}')]);
    expect(stream.requested).toEqual([]);
    expect(two.textContent).toBe('.a{color:red}\n.b{color:green}');
    expect(two.getAttribute('data-simul-resolved-stylesheet')).toBe('v1');
    expect(host.resolveNode?.(5)?.nodeValue).toBe('');
    send([again(6, 'empty', '.c{color:green}')]);
    expect(empty.textContent).toBe('.c{color:green}');
    expect(empty.childNodes).toHaveLength(1);
    send([again(3, 'two', '')]);
    expect(two.textContent).toBe('');

    // With its text nodes read again in the same batch, in either order:
    // the sheet's text is written last.
    const fresh = (id: number) => ({ kind: 'text' as const, id, text: '', translatable: false });
    send([
      again(3, 'two', '.a{color:blue}'),
      { kind: 'children', nodeId: 3, children: [fresh(30)] },
    ]);
    expect(stream.requested).toEqual([]);
    expect(two.textContent).toBe('.a{color:blue}');
    expect(host.resolveNode?.(30)?.nodeValue).toBe('.a{color:blue}');
    send([
      { kind: 'children', nodeId: 3, children: [fresh(31), fresh(32)] },
      again(3, 'two', '.a{color:black}'),
    ]);
    expect(two.textContent).toBe('.a{color:black}');
    expect(host.resolveNode?.(31)?.nodeValue).toBe('.a{color:black}');
    expect(host.resolveNode?.(32)?.nodeValue).toBe('');

    // A batch that fails while it is written leaves every sheet as it was:
    // the text of one, and the text node another had not had.
    const bare = host.resolveNode?.(40) as Element;
    expect(bare.childNodes).toHaveLength(0);
    const held = empty.firstChild!;
    Object.defineProperty(held, 'nodeValue', {
      configurable: true,
      get: () => '.c{color:green}',
      set: () => {
        throw new Error('synthetic write failure');
      },
    });
    send([
      again(3, 'two', '.a{color:white}'),
      again(40, 'bare', '.d{color:white}'),
      again(6, 'empty', '.c{color:white}'),
    ]);
    expect(stream.requested).toHaveLength(1);
    expect(two.textContent).toBe('.a{color:black}');
    expect(host.resolveNode?.(31)?.nodeValue).toBe('.a{color:black}');
    expect(bare.childNodes).toHaveLength(0);
    expect(bare.getAttribute('type')).toBe('text/plain');
  });

  it('keeps the page\'s order when its body comes before its head (D135)', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'div',
              attributes: [['id', 'first']], children: [],
            },
            {
              kind: 'element', id: 3, namespace: 'html', tagName: 'body',
              attributes: [], children: [],
            },
            { kind: 'element', id: 4, namespace: 'html', tagName: 'head', attributes: [], children: [] },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    )!;
    const host = new FakePresentationHost();
    const engine = makeEngine(new FakeHtmlStream(checkpoint), host);

    await expect(engine.run(request)).resolves.toMatchObject({ status: 'complete' });
    const html = host.iframe!.contentDocument!.documentElement;
    const mirrored = [2, 3, 4].map((id) => host.resolveNode?.(id));
    expect(
      [...html.children].filter((child) => mirrored.includes(child))
        .map((child) => child.localName),
    ).toEqual(['div', 'body', 'head']);
    expect(
      (host.resolveNode?.(4) as Element).querySelector(
        'meta[data-simul-owned-shell="csp"]',
      ),
    ).not.toBeNull();
  });

  it('preserves passive image-only layout and resolves external SVG and JPEG anchors', async () => {
    const mediaCss = [
      '.viewer{display:flex;min-height:100vh;align-items:center;justify-content:center;',
      'scroll-behavior:smooth;overscroll-behavior-y:contain}',
      '.viewer img{display:block;max-width:100%;max-height:100vh;object-fit:contain}',
    ].join('');
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [{
                kind: 'element', id: 3, namespace: 'html', tagName: 'style',
                attributes: [], children: [{
                  kind: 'text', id: 4, text: mediaCss, translatable: false,
                }],
              }],
            },
            {
              kind: 'element', id: 5, namespace: 'html', tagName: 'body',
              attributes: [['class', 'viewer']], children: [
                {
                  kind: 'element', id: 6, namespace: 'html', tagName: 'img',
                  attributes: [
                    ['src', 'https://assets.example/header_logo.svg'],
                    ['width', '275'],
                    ['height', '30'],
                  ], children: [],
                },
                {
                  kind: 'element', id: 7, namespace: 'html', tagName: 'img',
                  attributes: [
                    ['src', 'https://images.example/media.jpeg'],
                    ['width', '1206'],
                    ['height', '761'],
                  ], children: [],
                },
              ],
            },
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 1206,
        viewportHeight: 761,
        documentWidth: 1206,
        documentHeight: 761,
      },
    );
    expect(checkpoint).toBeDefined();
    const stream = new FakeHtmlStream(checkpoint!);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);

    await expect(engine.run(request)).resolves.toMatchObject({
      status: 'complete',
    });
    const snapshot = engine.snapshot()!;
    const svgAnchor = engine.resolveImageAnchor(snapshot.document, 6);
    const jpegAnchor = engine.resolveImageAnchor(snapshot.document, 7);
    expect(svgAnchor?.image.getAttribute('src')).toBe(
      'https://assets.example/header_logo.svg',
    );
    expect(jpegAnchor?.image.getAttribute('src')).toBe(
      'https://images.example/media.jpeg',
    );
    expect(svgAnchor?.replayLease).toBe(snapshot.replayLease);
    expect(jpegAnchor?.replayLease).toBe(snapshot.replayLease);
    expect(host.iframe?.contentDocument?.head.textContent).toContain(mediaCss);
    expect(host.iframe?.contentDocument?.body.className).toBe('viewer');
  });

  it('buffers live patches until a recovery checkpoint commits and is acknowledged', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('last good', 0));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);
    stream.observer?.onFailure('stream_overflow');
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'text', nodeId: 4,
        node: { kind: 'text', id: 4, text: 'retained later change', translatable: true },
      }],
    )!);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('last good');

    stream.observer?.onCheckpoint(makeCheckpoint('checkpoint base', 0));
    await vi.waitFor(() => {
      expect(host.iframe?.contentDocument?.body.textContent)
        .toBe('retained later change');
    });
    expect(stream.acknowledged).toEqual(expect.arrayContaining([0, 1]));
  });

  it('never lets a stale recovery replace a newer successful run', async () => {
    const first = new FakeHtmlStream(makeCheckpoint('first', 0));
    const second = new FakeHtmlStream(makeCheckpoint('new current run', 0));
    const streams = [first, second];
    const host = new FakePresentationHost();
    let initializeCount = 0;
    let finishStaleRecovery!: () => void;
    const staleRecoveryGate = new Promise<void>((resolve) => {
      finishStaleRecovery = resolve;
    });
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => streams.shift()!,
      initializeIframe: async (iframe, shell) => {
        initializeCount += 1;
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        if (initializeCount === 2) await staleRecoveryGate;
        return document;
      },
    });
    await engine.run(request);
    first.observer?.onFailure('stream_overflow');
    first.observer?.onCheckpoint(makeCheckpoint('stale recovery', 0));
    await vi.waitFor(() => expect(initializeCount).toBe(2));

    await engine.run(request);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('new current run');
    finishStaleRecovery();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.iframe?.contentDocument?.body.textContent).toBe('new current run');
  });

  it('lets a superseded run skip without tearing down the current stream', async () => {
    const stream = new FakeHtmlStream(makeCheckpoint('hello', 0));
    const host = new FakePresentationHost();
    const openStream = vi.fn(async () => stream);
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    await engine.run(request);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('hello');

    const staleRequest: ReplicaCaptureRequest = {
      ...identityParts,
      pageEpoch: 2,
      tabId: 1,
      isCurrent: () => false,
    };
    await expect(engine.run(staleRequest)).resolves.toMatchObject({
      status: 'skipped',
      diagnostics: { code: 'stale_identity' },
    });
    expect(openStream).toHaveBeenCalledOnce();
    expect(stream.dispose).not.toHaveBeenCalled();
    expect(host.clearPresentation).not.toHaveBeenCalled();

    // The current replica keeps applying live patches from its own stream.
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'text',
        nodeId: 4,
        node: { kind: 'text', id: 4, text: 'world', translatable: true },
      }],
    )!);
    expect(host.iframe?.contentDocument?.body.textContent).toBe('world');
    expect(stream.acknowledged).toContain(1);
  });

  it('creates HTML names without prefix parsing and restores SVG element case', () => {
    expect(canonicalSvgElementName('lineargradient')).toBe('linearGradient');
    expect(canonicalSvgElementName('radialgradient')).toBe('radialGradient');
    expect(canonicalSvgElementName('clippath')).toBe('clipPath');
    expect(canonicalSvgElementName('foreignobject')).toBe('foreignObject');
    expect(canonicalSvgElementName('fegaussianblur')).toBe('feGaussianBlur');
    expect(canonicalSvgElementName('rect')).toBe('rect');

    const { document } = parseHTML('<html><body></body></html>');
    const createElementNS = vi.spyOn(document, 'createElementNS');
    const legacy = createMirrorElement(document, 'html', 'o:p');
    const disguised = createMirrorElement(document, 'html', 'x:iframe');
    expect(createElementNS).not.toHaveBeenCalled();
    expect(legacy.localName).toBe('o:p');
    expect(legacy.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    expect(disguised.localName).toBe('x:iframe');
    expect(disguised.tagName.toLowerCase()).not.toBe('iframe');
    expect(createMirrorElement(document, 'html', 'div').localName).toBe('div');

    const gradient = createMirrorElement(document, 'svg', 'lineargradient');
    expect(createElementNS).toHaveBeenCalledWith(
      'http://www.w3.org/2000/svg',
      'linearGradient',
    );
    expect(gradient.localName).toBe('linearGradient');
    expect(gradient.namespaceURI).toBe('http://www.w3.org/2000/svg');
    createMirrorElement(document, 'mathml', 'mi');
    expect(createElementNS).toHaveBeenLastCalledWith(
      'http://www.w3.org/1998/Math/MathML',
      'mi',
    );
  });

  it('never materializes a colon-prefixed name as the element it disguises', async () => {
    const identity = createReplicaIdentity({ ...identityParts, sequence: 0 });
    const content = (child: HtmlMirrorNode) => ({
      root: {
        kind: 'element' as const, id: 1, namespace: 'html' as const,
        tagName: 'html', attributes: [], children: [
          {
            kind: 'element' as const, id: 2, namespace: 'html' as const,
            tagName: 'head', attributes: [], children: [],
          },
          {
            kind: 'element' as const, id: 3, namespace: 'html' as const,
            tagName: 'body', attributes: [], children: [child],
          },
        ],
      },
      adoptedStyleSheets: [], captureMs: 1,
      viewportWidth: 800, viewportHeight: 600,
      documentWidth: 800, documentHeight: 1000,
    });
    // Outside the HTML namespace the prefix is rejected before any element.
    expect(createHtmlMirrorCheckpoint(identity, content({
      kind: 'element', id: 4, namespace: 'svg', tagName: 'svg',
      attributes: [], children: [{
        kind: 'element', id: 5, namespace: 'svg', tagName: 'svg:animate',
        attributes: [['attributename', 'x']], children: [],
      }],
    }))).toBeUndefined();
    expect(createHtmlMirrorCheckpoint(identity, content({
      kind: 'element', id: 4, namespace: 'svg', tagName: 'svg',
      attributes: [], children: [{
        kind: 'element', id: 5, namespace: 'svg', tagName: 'foo:bar',
        attributes: [], children: [],
      }],
    }))).toBeUndefined();

    // In the HTML namespace it stays one inert unknown element.
    const checkpoint = createHtmlMirrorCheckpoint(identity, content({
      kind: 'element', id: 4, namespace: 'html', tagName: 'x:iframe',
      attributes: [['id', 'disguised']], children: [],
    }));
    if (!checkpoint) throw new Error('Fixture checkpoint rejected.');
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const replica = host.iframe!.contentDocument!;
    expect(replica.querySelector('iframe')).toBeNull();
    const disguised = replica.getElementById('disguised')!;
    expect(disguised.localName).toBe('x:iframe');
    expect(disguised.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
  });

  it('creates SVG elements with their canonical case-sensitive names', async () => {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            {
              kind: 'element', id: 2, namespace: 'html', tagName: 'head',
              attributes: [], children: [],
            },
            {
              kind: 'element', id: 3, namespace: 'html', tagName: 'body',
              attributes: [], children: [{
                kind: 'element', id: 4, namespace: 'svg', tagName: 'svg',
                attributes: [], children: [{
                  kind: 'element', id: 5, namespace: 'svg', tagName: 'defs',
                  attributes: [], children: [{
                    kind: 'element', id: 6, namespace: 'svg',
                    tagName: 'lineargradient', attributes: [['id', 'fill']],
                    children: [{
                      kind: 'element', id: 7, namespace: 'svg',
                      tagName: 'stop', attributes: [['offset', '0']],
                      children: [],
                    }],
                  }, {
                    kind: 'element', id: 8, namespace: 'svg',
                    tagName: 'clippath', attributes: [['id', 'frame']],
                    children: [{
                      kind: 'element', id: 9, namespace: 'svg',
                      tagName: 'rect', attributes: [], children: [],
                    }],
                  }],
                }, {
                  kind: 'element', id: 10, namespace: 'svg', tagName: 'rect',
                  attributes: [], children: [],
                }],
              }],
            },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
    );
    if (!checkpoint) throw new Error('Fixture checkpoint rejected.');
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    await engine.run(request);

    const replica = host.iframe!.contentDocument!;
    const descendants = [...replica.querySelector('svg')!.querySelectorAll('*')];
    expect(descendants.map((element) => element.localName)).toEqual([
      'defs', 'linearGradient', 'stop', 'clipPath', 'rect', 'rect',
    ]);
    for (const element of descendants) {
      expect(element.namespaceURI).toBe('http://www.w3.org/2000/svg');
    }

    // A later attribute patch still addresses the canonical-cased node by
    // its lowercase wire name.
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'attributes', nodeId: 6, namespace: 'svg',
        tagName: 'lineargradient',
        attributes: [['id', 'fill'], ['gradientunits', 'userSpaceOnUse']],
      }],
    )!);
    expect(replica.getElementById('fill')?.getAttribute('gradientUnits'))
      .toBe('userSpaceOnUse');
    expect(stream.acknowledged).toContain(1);
  });

  it('fills a dropdown whose labels came before it, and takes a new list as a patch (D132)', async () => {
    const option = (id: number): HtmlMirrorNode => ({
      kind: 'element', id, namespace: 'html', tagName: 'option',
      attributes: [], children: [],
    });
    const label = (nodeId: number, text: string): SemanticSourceRecord => ({
      bridge: 'isolated-html', recordId: nodeId * 8 + 1, nodeId, nodeRevision: 1,
      category: 'public-semantic', gate: 'controlSemantics', tagName: 'option',
      type: '', autocomplete: '', role: '', contentEditable: '',
      text, presentation: 'label', classifierVersion: 1,
    });
    const selectProofs = (selected: number, revision: number) => [{
      kind: 'select-presentation' as const, bridge: 'isolated-html' as const,
      nodeId: 40, revision: 1, gate: 'controlSemantics' as const,
      multiple: false, size: null, classifierVersion: 1 as const,
    }, {
      kind: 'select-state' as const, bridge: 'isolated-html' as const,
      nodeId: 40, revision, gate: 'formValues' as const,
      selectedOptionNodeIds: [selected], multiple: false, pickerOpen: false,
      classifierVersion: 1 as const,
    }];
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [
            { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
            { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
              kind: 'element', id: 10, namespace: 'html', tagName: 'div',
              attributes: [], children: [],
            }] },
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
      'passive',
    )!;
    const stream = new FakeHtmlStream(checkpoint);
    const semantic = new FakeSemanticStream();
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host, undefined, semantic);
    await engine.run(request);
    await Promise.resolve();
    const sourceDocument = engine.snapshot()!.document;
    const replica = host.iframe!.contentDocument!;
    const rows = (): string[] => {
      const selectHost = replica.querySelector('[data-simul-owned-select-host]')!;
      return [...selectHost.shadowRoot!.querySelectorAll(
        '[data-simul-owned-select-option="v1"]',
      )].map((row) => row.textContent!.replace(/ /gu, ''));
    };
    const trigger = (): string => replica
      .querySelector('[data-simul-owned-select-host]')!.shadowRoot!
      .querySelector('[data-simul-owned-select-trigger="v1"]')!.textContent!;

    // The labels and the state of a dropdown the mirror does not have yet.
    expect(semantic.emit(createSemanticSourceBatch(
      sourceDocument, 'read-v1-111111', 1,
      [label(41, 'Tokyo'), label(42, 'Osaka')],
      selectProofs(41, 1),
    ))).toBe(true);
    expect(replica.querySelector('[data-simul-owned-select-host]')).toBeNull();

    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 1 }),
      1,
      1,
      [{
        kind: 'reconcile-children', nodeId: 10, children: [{
          kind: 'graph',
          node: {
            kind: 'element', id: 40, namespace: 'html', tagName: 'select',
            attributes: [], children: [option(41), option(42)],
          },
        }],
      }],
      undefined,
      'passive',
    )!);
    expect(rows()).toEqual(['Tokyo', 'Osaka']);
    expect(trigger()).toBe('Tokyo');
    expect(engine.snapshot()?.records.map(({ source }) => source))
      .toEqual(expect.arrayContaining(['Tokyo', 'Osaka']));

    // The page replaces the list. The new labels are here first again.
    const frame = host.iframe;
    expect(semantic.emit(createSemanticSourceBatch(
      sourceDocument, 'read-v1-111111', 2,
      [label(51, 'Sapporo'), label(52, 'Sendai'), label(53, 'Naha')],
      selectProofs(52, 2),
    ))).toBe(true);
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 2 }),
      2,
      2,
      [{ kind: 'children', nodeId: 40, children: [option(51), option(52), option(53)] }],
      undefined,
      'passive',
    )!);
    expect(stream.requested).toEqual([]);
    expect(stream.acknowledged).toContain(2);
    expect(host.iframe).toBe(frame);
    expect(rows()).toEqual(['Sapporo', 'Sendai', 'Naha']);
    expect(trigger()).toBe('Sendai');

    // And with the structure first, as it has always worked.
    stream.observer?.onPatch(createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence: 3 }),
      3,
      3,
      [{ kind: 'children', nodeId: 40, children: [option(61), option(62)] }],
      undefined,
      'passive',
    )!);
    expect(stream.requested).toEqual([]);
    expect(rows()).toEqual(['', '']);
    expect(semantic.emit(createSemanticSourceBatch(
      sourceDocument, 'read-v1-111111', 3,
      [label(61, 'Kobe'), label(62, 'Nara')],
      selectProofs(61, 3),
    ))).toBe(true);
    expect(rows()).toEqual(['Kobe', 'Nara']);
    expect(trigger()).toBe('Kobe');
  });
});

describe('IsolatedHtmlReplicaEngine for screen readers (D124)', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
      HTMLImageElement: window.HTMLImageElement,
    });
  });

  const text = (
    id: number,
    value: string,
  ): Extract<HtmlMirrorNode, { kind: 'text' }> => ({
    kind: 'text', id, text: value, translatable: true,
  });
  const element = (
    id: number,
    tagName: string,
    attributes: readonly (readonly [string, string])[],
    children: readonly HtmlMirrorNode[],
  ): HtmlMirrorNode => ({
    kind: 'element', id, namespace: 'html', tagName, attributes, children,
  });

  /** An English page: its own languages and a parent with mixed text. */
  function languageBody(): HtmlMirrorNode[] {
    return [
      element(4, 'p', [], [text(5, 'First.')]),
      element(6, 'p', [['lang', 'fr']], [text(7, 'Deuxième.')]),
      element(8, 'p', [['lang', 'ja']], [text(9, '三番目。')]),
      element(10, 'div', [['lang', 'ja-JP']], [
        element(11, 'p', [], [text(12, 'Fourth.')]),
      ]),
      element(13, 'p', [], [
        text(14, 'Mixed '),
        element(15, 'b', [], [text(16, '42')]),
        text(17, ' tail.'),
      ]),
    ];
  }

  function checkpointOf(
    body: readonly HtmlMirrorNode[],
    sequence = 0,
  ): HtmlMirrorCheckpoint {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [['lang', 'en']], children: [
            element(2, 'head', [], []),
            element(3, 'body', [], body),
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    );
    if (!checkpoint) throw new Error('Screen-reader fixture checkpoint rejected.');
    return checkpoint;
  }

  /** Where each text of `languageBody` sits in the replica. */
  const HOLDERS: Readonly<Record<number, string>> = {
    5: 'body > p:nth-of-type(1)',
    7: 'body > p:nth-of-type(2)',
    9: 'body > p:nth-of-type(3)',
    12: 'div > p',
    14: 'body > p:nth-of-type(4)',
    16: 'b',
    17: 'body > p:nth-of-type(4)',
  };
  function holder(replica: Document, nodeId: number): Element {
    const found = replica.querySelector(HOLDERS[nodeId]!);
    if (!found) throw new Error(`No element holds text ${nodeId}.`);
    return found;
  }

  async function start(body: readonly HtmlMirrorNode[] = languageBody()) {
    const stream = new FakeHtmlStream(checkpointOf(body));
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host);
    expect((await engine.run(request)).status).toBe('complete');
    const byText = (nodeId: number): Element =>
      holder(host.iframe!.contentDocument!, nodeId);
    return { stream, host, engine, byText };
  }

  const JA = { translationEpoch: 1, pairKey: 'en>ja', targetLanguage: 'ja' };
  const SOURCE_ONLY = { translationEpoch: 9, pairKey: undefined };

  function show(
    engine: IsolatedHtmlReplicaEngine,
    nodeId: number,
    context: { translationEpoch: number; pairKey: string } = JA,
    translated = `訳${nodeId}`,
  ): boolean {
    const snapshot = engine.snapshot()!;
    const record = snapshot.records.find((candidate) => candidate.nodeId === nodeId)!;
    return engine.project({
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      nodeId,
      nodeType: 3,
      sourceRevision: record.revision,
      source: record.source,
      translationEpoch: context.translationEpoch,
      pairKey: context.pairKey,
      translated,
    });
  }

  function patch(
    stream: FakeHtmlStream,
    sequence: number,
    operations: HtmlMirrorPatchOperation[],
  ): void {
    const batch = createHtmlMirrorPatch(
      createReplicaIdentity({ ...identityParts, sequence }),
      sequence,
      sequence,
      operations,
    );
    if (!batch) throw new Error('Screen-reader fixture patch rejected.');
    stream.observer!.onPatch(batch);
  }

  it('gives translated text its language and puts back exactly what the page had', async () => {
    const { engine, host, byText } = await start();
    engine.beginProjection(JA);
    for (const nodeId of [5, 7, 9, 12]) expect(show(engine, nodeId)).toBe(true);

    expect(byText(5).getAttribute('lang')).toBe('ja');
    expect(byText(5).textContent).toBe('訳5');
    // The page said French; while the translation shows it is Japanese.
    expect(byText(7).getAttribute('lang')).toBe('ja');
    // Each element is still drawn by the page's language for it.
    expect(byText(5).getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('en');
    expect(byText(7).getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('fr');
    expect(byText(9).hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);
    expect(byText(12).hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);
    // Already Japanese, by its own attribute and by an ancestor's `ja-JP`.
    expect(byText(9).getAttribute('lang')).toBe('ja');
    expect(byText(12).hasAttribute('lang')).toBe(false);
    // The document's language stays the page's, for detection and for
    // everything that is not translated.
    const replica = host.iframe!.contentDocument!;
    expect(replica.documentElement.getAttribute('lang')).toBe('en');
    expect(replica.body.hasAttribute('lang')).toBe(false);
    expect(engine.snapshot()?.documentLanguage).toBe('en');

    // Live source only.
    engine.beginProjection(SOURCE_ONLY);
    expect(byText(5).hasAttribute('lang')).toBe(false);
    expect(byText(5).textContent).toBe('First.');
    expect(byText(7).getAttribute('lang')).toBe('fr');
    expect(byText(9).getAttribute('lang')).toBe('ja');
    expect(byText(12).hasAttribute('lang')).toBe(false);
    expect(replica.querySelectorAll('[lang]').length).toBe(4);
    expect([...replica.querySelectorAll('*')].filter((candidate) =>
      candidate.hasAttribute(PAGE_LANGUAGE_ATTRIBUTE))).toEqual([]);
  });

  it('declares the page\'s language in the XML namespace, and adds no rule to the shell', async () => {
    const { engine, stream, byText } = await start();
    engine.beginProjection(JA);
    const french = byText(7);
    const written: (readonly [string | null, string, string])[] = [];
    const write = french.setAttributeNS.bind(french);
    french.setAttributeNS = (namespace, name, value): void => {
      written.push([namespace, name, value]);
      write(namespace, name, value);
    };
    expect(show(engine, 7)).toBe(true);
    // Chrome reads this one before `lang` for what it draws, and `lang`
    // alone for the accessibility tree.
    expect(written).toEqual([[XML_NAMESPACE, PAGE_LANGUAGE_ATTRIBUTE, 'fr']]);
    expect(XML_NAMESPACE).toBe('http://www.w3.org/XML/1998/namespace');
    expect(PAGE_LANGUAGE_ATTRIBUTE).toBe('simul:lang');

    // The page's patch takes every attribute off; both of Simul's come back.
    patch(stream, 1, [{
      kind: 'attributes', nodeId: 6, namespace: 'html', tagName: 'p',
      attributes: [['lang', 'de'], ['class', 'x']],
    }]);
    expect(written.at(-1)).toEqual([XML_NAMESPACE, PAGE_LANGUAGE_ATTRIBUTE, 'de']);
    expect(french.getAttribute('lang')).toBe('ja');

    const shell = parseHTML(ISOLATED_HTML_SHELL).document;
    expect(shell.querySelector('style[data-simul-owned-shell="inert"]')
      ?.textContent).not.toContain('lang');
  });

  it('adds no language when the pair does not name a usable one', async () => {
    const { engine, byText } = await start();
    engine.beginProjection({ translationEpoch: 1, pairKey: 'en>ja' });
    expect(show(engine, 5)).toBe(true);
    expect(byText(5).hasAttribute('lang')).toBe(false);

    engine.beginProjection({
      translationEpoch: 2, pairKey: 'en>ja', targetLanguage: 'ja" onload="x',
    });
    expect(show(engine, 5, { translationEpoch: 2, pairKey: 'en>ja' })).toBe(true);
    expect(byText(5).textContent).toBe('訳5');
    expect(byText(5).hasAttribute('lang')).toBe(false);
  });

  it('retags in the new language after a new pair', async () => {
    const { engine, byText } = await start();
    engine.beginProjection(JA);
    expect(show(engine, 5)).toBe(true);
    expect(show(engine, 7)).toBe(true);

    const french = { translationEpoch: 2, pairKey: 'en>fr', targetLanguage: 'fr' };
    engine.beginProjection(french);
    expect(byText(5).hasAttribute('lang')).toBe(false);
    expect(byText(7).getAttribute('lang')).toBe('fr');
    expect(show(engine, 5, french)).toBe(true);
    expect(show(engine, 7, french)).toBe(true);
    expect(byText(5).getAttribute('lang')).toBe('fr');
    // The page's own French paragraph needs nothing from Simul.
    expect(byText(7).getAttribute('lang')).toBe('fr');

    engine.beginProjection(SOURCE_ONLY);
    expect(byText(5).hasAttribute('lang')).toBe(false);
    expect(byText(7).getAttribute('lang')).toBe('fr');
  });

  it('tags a parent with translated and untranslated text until its last translation goes', async () => {
    const { engine, stream, byText } = await start();
    engine.beginProjection(JA);
    expect(show(engine, 14)).toBe(true);
    const mixed = byText(14);
    expect(mixed.getAttribute('lang')).toBe('ja');
    // The number in <b> was not translated: its own element is not tagged.
    expect(byText(16).hasAttribute('lang')).toBe(false);
    expect(show(engine, 17)).toBe(true);

    patch(stream, 1, [{ kind: 'text', nodeId: 14, node: text(14, 'Changed ') }]);
    expect(mixed.getAttribute('lang')).toBe('ja');
    expect(mixed.textContent).toBe('Changed 42訳17');
    patch(stream, 2, [{ kind: 'text', nodeId: 17, node: text(17, ' end.') }]);
    expect(mixed.hasAttribute('lang')).toBe(false);
    expect(mixed.textContent).toBe('Changed 42 end.');
  });

  it('keeps the tag through the page\'s attribute patches and restores the patched value', async () => {
    const { engine, stream, byText } = await start();
    engine.beginProjection(JA);
    expect(show(engine, 5)).toBe(true);
    expect(show(engine, 7)).toBe(true);
    const first = byText(5);
    const second = byText(7);

    patch(stream, 1, [{
      kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'p',
      attributes: [['lang', 'de'], ['class', 'patched']],
    }, {
      kind: 'attributes', nodeId: 6, namespace: 'html', tagName: 'p',
      attributes: [['class', 'no-language-now']],
    }]);
    // The translations still show, so both stay Japanese.
    expect(first.textContent).toBe('訳5');
    expect(first.getAttribute('lang')).toBe('ja');
    expect(first.getAttribute('class')).toBe('patched');
    expect(second.getAttribute('lang')).toBe('ja');
    expect(second.getAttribute('class')).toBe('no-language-now');
    // The fonts follow the page's new language for each.
    expect(first.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('de');
    expect(second.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('en');

    patch(stream, 2, [{
      kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'p',
      attributes: [['lang', 'de'], ['class', 'patched again']],
    }]);
    expect(first.getAttribute('lang')).toBe('ja');

    engine.beginProjection(SOURCE_ONLY);
    expect(first.getAttribute('lang')).toBe('de');
    expect(first.getAttribute('class')).toBe('patched again');
    expect(second.hasAttribute('lang')).toBe(false);
    expect(first.hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);
    expect(second.hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);
  });

  it('drops its tag when the page itself declares the language, and takes it up again', async () => {
    const { engine, stream, byText } = await start();
    engine.beginProjection(JA);
    expect(show(engine, 5)).toBe(true);
    expect(show(engine, 12)).toBe(true);
    const first = byText(5);
    const inner = byText(12);
    expect(inner.hasAttribute('lang')).toBe(false);

    // The wrapper turns English: the translated child needs the tag now.
    patch(stream, 1, [{
      kind: 'attributes', nodeId: 10, namespace: 'html', tagName: 'div',
      attributes: [['lang', 'en']],
    }]);
    expect(inner.getAttribute('lang')).toBe('ja');
    expect(inner.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('en');
    // And back: the page declares it, so Simul's attribute goes.
    patch(stream, 2, [{
      kind: 'attributes', nodeId: 10, namespace: 'html', tagName: 'div',
      attributes: [['lang', 'ja']],
    }]);
    expect(inner.hasAttribute('lang')).toBe(false);
    expect(inner.hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);

    // The page writes the target language on a tagged element itself.
    patch(stream, 3, [{
      kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'p',
      attributes: [['lang', 'ja']],
    }]);
    expect(first.getAttribute('lang')).toBe('ja');
    engine.beginProjection(SOURCE_ONLY);
    expect(first.getAttribute('lang')).toBe('ja');
    expect(inner.hasAttribute('lang')).toBe(false);
  });

  it('leaves no tag on rebuilt children and keeps it on retained ones', async () => {
    const { engine, stream, host, byText } = await start();
    engine.beginProjection(JA);
    for (const nodeId of [5, 14, 16, 17]) expect(show(engine, nodeId)).toBe(true);
    const first = byText(5);
    const mixed = byText(14);
    const bold = byText(16);

    // The paragraph's text node is replaced: the page's text shows again.
    patch(stream, 1, [{
      kind: 'children', nodeId: 4, children: [text(30, 'Rebuilt.')],
    }]);
    expect(first.textContent).toBe('Rebuilt.');
    expect(first.hasAttribute('lang')).toBe(false);

    // Reconciliation keeps two translated children and drops the third.
    patch(stream, 2, [{
      kind: 'reconcile-children', nodeId: 13, children: [
        { kind: 'retain', nodeId: 14 },
        { kind: 'retain', nodeId: 15 },
        { kind: 'graph', node: text(31, ' new tail.') },
      ],
    }]);
    expect(mixed.textContent).toBe('訳14訳16 new tail.');
    expect(mixed.getAttribute('lang')).toBe('ja');
    expect(bold.getAttribute('lang')).toBe('ja');

    // The mixed paragraph goes and a new one is built in its place.
    patch(stream, 3, [{
      kind: 'reconcile-children', nodeId: 3, children: [
        { kind: 'retain', nodeId: 4 },
        { kind: 'retain', nodeId: 6 },
        { kind: 'retain', nodeId: 8 },
        { kind: 'retain', nodeId: 10 },
        { kind: 'graph', node: element(40, 'p', [['lang', 'fr']], [text(41, 'Nouveau.')]) },
      ],
    }]);
    const replica = host.iframe!.contentDocument!;
    const rebuilt = replica.body.lastElementChild!;
    expect(rebuilt.textContent).toBe('Nouveau.');
    expect(rebuilt.getAttribute('lang')).toBe('fr');
    // The removed elements are not left tagged either.
    expect(mixed.hasAttribute('lang')).toBe(false);
    expect(bold.hasAttribute('lang')).toBe(false);
    expect(show(engine, 41)).toBe(true);
    expect(rebuilt.getAttribute('lang')).toBe('ja');
    engine.beginProjection(SOURCE_ONLY);
    expect(rebuilt.getAttribute('lang')).toBe('fr');
    expect(replica.querySelectorAll('[lang]').length).toBe(5);
  });

  it('keeps the tag and the page value when a patch is rolled back', async () => {
    const { engine, stream, host, byText } = await start();
    engine.beginProjection(JA);
    expect(show(engine, 7)).toBe(true);
    const second = byText(7);
    const wrapper = host.iframe!.contentDocument!.querySelector('div')!;
    const originalInsertBefore = wrapper.insertBefore.bind(wrapper);
    const insert = vi.spyOn(wrapper, 'insertBefore').mockImplementationOnce(() => {
      throw new Error('synthetic apply failure');
    });

    patch(stream, 1, [{
      kind: 'attributes', nodeId: 6, namespace: 'html', tagName: 'p',
      attributes: [['lang', 'es']],
    }, {
      kind: 'reconcile-children', nodeId: 10, children: [
        { kind: 'graph', node: element(50, 'p', [], [text(51, 'Partial.')]) },
        { kind: 'retain', nodeId: 11 },
      ],
    }]);
    insert.mockRestore();
    wrapper.insertBefore = originalInsertBefore;
    expect(stream.requested).toEqual([0]);
    expect(wrapper.children.length).toBe(1);

    // The failed patch changed nothing: Japanese while shown, French after.
    expect(second.textContent).toBe('訳7');
    expect(second.getAttribute('lang')).toBe('ja');
    engine.beginProjection(SOURCE_ONLY);
    expect(second.getAttribute('lang')).toBe('fr');
  });

  /** A page whose root, head and body are given: XHTML, or a pragma. */
  function pageCheckpoint(
    rootAttributes: readonly (readonly [string, string])[],
    head: readonly HtmlMirrorNode[],
    body: readonly HtmlMirrorNode[],
  ): HtmlMirrorCheckpoint {
    const checkpoint = createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: rootAttributes, children: [
            element(2, 'head', [], head),
            element(3, 'body', [], body),
          ],
        },
        adoptedStyleSheets: [],
        captureMs: 1,
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 1000,
      },
    );
    if (!checkpoint) throw new Error('Page fixture checkpoint rejected.');
    return checkpoint;
  }

  /** The engine over a replica whose namespaced attribute writes are kept. */
  async function startPage(checkpoint: HtmlMirrorCheckpoint) {
    const stream = new FakeHtmlStream(checkpoint);
    const host = new FakePresentationHost();
    const namespaced: string[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        const prototype = document.defaultView!.Element.prototype;
        const write = prototype.setAttributeNS;
        prototype.setAttributeNS = function (
          this: Element,
          namespace: string | null,
          name: string,
          value: string,
        ): void {
          const who = this.getAttribute('id') ?? this.localName;
          if (namespace === XML_NAMESPACE) namespaced.push(`${who} ${name}=${value}`);
          write.call(this, namespace, name, value);
        };
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        return document;
      },
    });
    expect((await engine.run(request)).status).toBe('complete');
    const replica = host.iframe!.contentDocument!;
    const byId = (id: string): Element => replica.getElementById(id)!;
    return { stream, engine, replica, byId, namespaced };
  }

  it('writes a page\'s xml:lang after an attribute that is only named so', async () => {
    // The page has both, the real one first: `setAttribute` finds an
    // attribute by its name alone, so the one written last is the one
    // Chrome would draw by. (linkedom holds one attribute of a name, and so
    // shows which write came last.)
    const { stream, byId } = await startPage(pageCheckpoint([], [], [
      element(4, 'p', [
        ['id', 'both'], [PAGE_XML_LANGUAGE_ATTRIBUTE, 'fr'], ['xml:lang', 'de'],
      ], [text(5, 'Deux.')]),
    ]));
    expect(byId('both').getAttribute('xml:lang')).toBe('fr');
    expect(pageXmlLanguage(byId('both'))).toBe('fr');
    patch(stream, 1, [{
      kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'p',
      attributes: [
        ['id', 'both'], [PAGE_XML_LANGUAGE_ATTRIBUTE, 'it'], ['xml:lang', 'es'],
        ['class', 'k'],
      ],
    }]);
    expect(byId('both').getAttribute('xml:lang')).toBe('it');
    expect(pageXmlLanguage(byId('both'))).toBe('it');
    expect(byId('both').getAttribute('class')).toBe('k');
  });

  it('writes a page\'s xml:lang into the XML namespace and tags by it', async () => {
    const { engine, replica, byId, namespaced } = await startPage(pageCheckpoint(
      [[PAGE_XML_LANGUAGE_ATTRIBUTE, 'de']],
      [],
      [
        element(4, 'p', [['id', 'a']], [text(5, 'Eins.')]),
        element(6, 'p', [
          ['id', 'own'], ['lang', 'en'], [PAGE_XML_LANGUAGE_ATTRIBUTE, 'fr'],
        ], [text(7, 'Deux.')]),
        // An HTML element's attribute that is only named so: left as it is.
        element(8, 'p', [['id', 'named'], ['xml:lang', 'it']], [text(9, 'Tre.')]),
        element(10, 'p', [
          ['id', 'same'], [PAGE_XML_LANGUAGE_ATTRIBUTE, 'ja'],
        ], [text(11, '四。')]),
      ],
    ));
    // Under the page's name, in the namespace Chrome draws by; the name it
    // travelled under is no attribute of the mirror.
    expect(namespaced).toEqual([
      'html xml:lang=de', 'own xml:lang=fr', 'same xml:lang=ja',
    ]);
    expect(pageXmlLanguage(replica.documentElement)).toBe('de');
    expect([...replica.querySelectorAll('*')].filter((candidate) =>
      candidate.hasAttribute(PAGE_XML_LANGUAGE_ATTRIBUTE))).toEqual([]);
    expect(byId('named').getAttribute('xml:lang')).toBe('it');
    expect(pageXmlLanguage(byId('named'))).toBeNull();
    // What the page's root says in plain `lang` is still all detection reads.
    expect(engine.snapshot()?.documentLanguage).toBeUndefined();

    namespaced.length = 0;
    engine.beginProjection(JA);
    for (const nodeId of [5, 7, 9, 11]) expect(show(engine, nodeId)).toBe(true);
    // The page's `xml:lang` on the root is the language of what declares none.
    expect(byId('a').getAttribute('lang')).toBe('ja');
    expect(byId('a').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('de');
    expect(byId('named').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('de');
    // Its own `xml:lang` stands where Simul's would: only the tag is added.
    expect(byId('own').getAttribute('lang')).toBe('ja');
    expect(byId('own').hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);
    expect(byId('own').getAttribute('xml:lang')).toBe('fr');
    // An `xml:lang` is drawn by and not heard: the one that names the
    // language translated to still gets the tag, and nothing beside it.
    expect(byId('same').getAttribute('lang')).toBe('ja');
    expect(byId('same').hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);
    expect(namespaced).toEqual(['a simul:lang=de', 'named simul:lang=de']);

    engine.beginProjection(SOURCE_ONLY);
    expect(byId('own').getAttribute('lang')).toBe('en');
    expect(byId('own').getAttribute('xml:lang')).toBe('fr');
    expect([...replica.querySelectorAll('*')].filter((candidate) =>
      candidate.hasAttribute(PAGE_LANGUAGE_ATTRIBUTE))).toEqual([]);
  });

  it('follows the page\'s patches of an xml:lang under a translation, and a rollback', async () => {
    const { engine, stream, replica, byId, namespaced } = await startPage(
      pageCheckpoint([['lang', 'en']], [], [
        element(4, 'div', [['id', 'wrap']], [
          element(5, 'p', [['id', 'a']], [text(6, 'One.')]),
        ]),
        element(7, 'p', [['id', 'b'], ['class', 'x']], [text(8, 'Two.')]),
      ]),
    );
    engine.beginProjection(JA);
    expect(show(engine, 6)).toBe(true);
    expect(show(engine, 8)).toBe(true);
    expect(byId('a').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('en');

    // An ancestor takes an `xml:lang`: what the tag keeps drawn follows.
    patch(stream, 1, [{
      kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'div',
      attributes: [['id', 'wrap'], [PAGE_XML_LANGUAGE_ATTRIBUTE, 'de']],
    }]);
    expect(byId('a').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('de');
    expect(byId('a').getAttribute('lang')).toBe('ja');

    // The tagged element takes its own: Simul's leaves the place, and is not
    // written back over the page's value.
    namespaced.length = 0;
    patch(stream, 2, [{
      kind: 'attributes', nodeId: 7, namespace: 'html', tagName: 'p',
      attributes: [['id', 'b'], [PAGE_XML_LANGUAGE_ATTRIBUTE, 'fr']],
    }]);
    // (Written twice: a patch is tried on a spare element first.)
    expect(namespaced).toEqual(['b xml:lang=fr', 'b xml:lang=fr']);
    expect(byId('b').hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);
    expect(byId('b').getAttribute('xml:lang')).toBe('fr');
    expect(byId('b').getAttribute('lang')).toBe('ja');

    // With a plain `lang` in the language translated to, nothing is left to
    // say; the page's `xml:lang` goes on drawing.
    patch(stream, 3, [{
      kind: 'attributes', nodeId: 7, namespace: 'html', tagName: 'p',
      attributes: [
        ['id', 'b'], ['lang', 'ja'], [PAGE_XML_LANGUAGE_ATTRIBUTE, 'fr'],
      ],
    }]);
    expect(byId('b').getAttribute('lang')).toBe('ja');
    expect(pageAttribute(byId('b'), 'lang')).toBe('ja');
    expect(byId('b').getAttribute('xml:lang')).toBe('fr');
    expect(byId('b').hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);

    // Taken away: the tag is back, with Simul's own beside it.
    patch(stream, 4, [{
      kind: 'attributes', nodeId: 7, namespace: 'html', tagName: 'p',
      attributes: [['id', 'b']],
    }]);
    expect(pageXmlLanguage(byId('b'))).toBeNull();
    expect(byId('b').hasAttribute('xml:lang')).toBe(false);
    expect(byId('b').getAttribute('lang')).toBe('ja');
    expect(byId('b').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('en');

    // A patch that fails after it rewrote the wrapper's attributes: the
    // page's `xml:lang` goes back into its namespace under its own name.
    const wrap = byId('wrap');
    const insert = vi.spyOn(wrap, 'insertBefore').mockImplementationOnce(() => {
      throw new Error('synthetic apply failure');
    });
    namespaced.length = 0;
    patch(stream, 5, [{
      kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'div',
      attributes: [['id', 'wrap'], ['lang', 'fr']],
    }, {
      kind: 'reconcile-children', nodeId: 4, children: [
        { kind: 'graph', node: element(50, 'p', [], [text(51, 'Partial.')]) },
        { kind: 'retain', nodeId: 5 },
      ],
    }]);
    insert.mockRestore();
    expect(stream.requested).toEqual([4]);
    expect(namespaced).toContain('wrap xml:lang=de');
    expect(pageXmlLanguage(wrap)).toBe('de');
    expect(wrap.getAttribute('xml:lang')).toBe('de');
    expect(wrap.hasAttribute('lang')).toBe(false);
    expect(wrap.hasAttribute(PAGE_XML_LANGUAGE_ATTRIBUTE)).toBe(false);
    expect(replica.querySelectorAll('p').length).toBe(2);
  });

  it('gives the mirror the document\'s language the root carries, and tags by it', async () => {
    const { engine, stream, replica, byId } = await startPage(pageCheckpoint(
      [[PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, 'de'], ['class', 'r']],
      // A page's own pragma arrives without what would act.
      [element(20, 'meta', [], [])],
      [
        element(4, 'p', [['id', 'a']], [text(5, 'Eins.')]),
        element(6, 'p', [['id', 'b'], ['lang', 'fr']], [text(7, 'Deux.')]),
      ],
    ));
    const pragmas = (): string[] =>
      [...replica.querySelectorAll('meta[http-equiv="content-language"]')].map(
        (meta) => `${meta.getAttribute('data-simul-owned-shell')}=${meta.getAttribute('content')}`,
      );
    // One pragma of Simul's own says it; it is no attribute of the root.
    expect(pragmas()).toEqual(['language=de']);
    expect(replica.documentElement.hasAttribute(PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE))
      .toBe(false);
    expect(replica.documentElement.getAttribute('class')).toBe('r');
    engine.beginProjection(JA);
    expect(show(engine, 5)).toBe(true);
    expect(show(engine, 7)).toBe(true);
    expect(byId('a').getAttribute('lang')).toBe('ja');
    expect(byId('a').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('de');
    expect(byId('b').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('fr');

    // The page's Chrome says another: the root's patch brings it, the
    // pragma is written again, and every tag that leaned on it follows.
    const rootPatch = (
      sequence: number,
      attributes: readonly (readonly [string, string])[],
    ): void => patch(stream, sequence, [{
      kind: 'attributes', nodeId: 1, namespace: 'html', tagName: 'html',
      attributes,
    }]);
    rootPatch(1, [[PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, 'it']]);
    expect(pragmas()).toEqual(['language=it']);
    expect(byId('a').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('it');
    expect(byId('b').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('fr');

    // To the language translated to: the page already says it.
    rootPatch(2, [[PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, 'ja']]);
    expect(byId('a').hasAttribute('lang')).toBe(false);

    // A patch of the root that names none (the root has taken a `lang`, and
    // the document's language can no longer be read): the mirror keeps what
    // it has, which the root's own language now covers.
    rootPatch(3, [['lang', 'en']]);
    expect(pragmas()).toEqual(['language=ja']);
    expect(byId('a').getAttribute('lang')).toBe('ja');
    expect(byId('a').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('en');

    // A language that names none.
    rootPatch(4, [[PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, '']]);
    expect(pragmas()).toEqual(['language=']);
    expect(byId('a').getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('');

    // A patch that fails after it rewrote the root: the language goes back.
    rootPatch(5, [[PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, 'de']]);
    const body = replica.body;
    const insert = vi.spyOn(body, 'insertBefore').mockImplementationOnce(() => {
      throw new Error('synthetic apply failure');
    });
    patch(stream, 6, [{
      kind: 'attributes', nodeId: 1, namespace: 'html', tagName: 'html',
      attributes: [[PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, 'es']],
    }, {
      kind: 'reconcile-children', nodeId: 3, children: [
        { kind: 'graph', node: element(50, 'p', [], [text(51, 'Partial.')]) },
        { kind: 'retain', nodeId: 4 },
        { kind: 'retain', nodeId: 6 },
      ],
    }]);
    insert.mockRestore();
    expect(stream.requested).toEqual([5]);
    expect(pragmas()).toEqual(['language=de']);
  });

  it('gives the mirror no language from a patch it then refuses', async () => {
    const { stream, replica } = await startPage(pageCheckpoint(
      [[PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, 'de']],
      [],
      [element(4, 'p', [['id', 'a']], [text(5, 'One.')])],
    ));
    const pragma = (): string | null | undefined =>
      replica.querySelector('meta[http-equiv="content-language"]')
        ?.getAttribute('content');
    expect(pragma()).toBe('de');
    // A patch is tried on a spare element before anything is touched; the
    // spare root is no document's root, and says nothing to the mirror. The
    // second change names a node the mirror does not hold: all is refused.
    patch(stream, 1, [{
      kind: 'attributes', nodeId: 1, namespace: 'html', tagName: 'html',
      attributes: [[PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, 'es']],
    }, {
      kind: 'text', nodeId: 999, node: text(999, 'Nowhere.'),
    }]);
    expect(stream.requested).toEqual([0]);
    expect(pragma()).toBe('de');
  });

  it('leaves text the translator gave back as it was in the page\'s language', async () => {
    const { engine, stream, byText } = await start();
    engine.beginProjection(JA);
    // A French sentence an English model returns untouched, a number, and a
    // text that only gained space around it.
    expect(show(engine, 7, JA, 'Deuxième.')).toBe(true);
    expect(show(engine, 16, JA, '42')).toBe(true);
    expect(show(engine, 5, JA, ' First.\n')).toBe(true);
    expect(byText(7).getAttribute('lang')).toBe('fr');
    expect(byText(7).attributes.length).toBe(1);
    expect(byText(16).attributes.length).toBe(0);
    expect(byText(5).attributes.length).toBe(0);
    expect(byText(5).textContent).toBe(' First.\n');

    // The page's French gives way only once the text really changes, and
    // comes back when a later answer is the page's text again.
    expect(show(engine, 7, JA, '二番目。')).toBe(true);
    expect(byText(7).getAttribute('lang')).toBe('ja');
    expect(show(engine, 7, JA, 'Deuxième.')).toBe(true);
    expect(byText(7).getAttribute('lang')).toBe('fr');
    expect(byText(7).attributes.length).toBe(1);

    // A parent is tagged by its text that changed, not by the text beside it.
    expect(show(engine, 17, JA, ' tail.')).toBe(true);
    expect(byText(14).hasAttribute('lang')).toBe(false);
    expect(show(engine, 14)).toBe(true);
    expect(byText(14).getAttribute('lang')).toBe('ja');
    patch(stream, 1, [{ kind: 'text', nodeId: 14, node: text(14, 'Changed ') }]);
    expect(byText(14).hasAttribute('lang')).toBe(false);
    expect(byText(14).textContent).toBe('Changed 42 tail.');
  });

  it('carries the tags onto the replica rebuilt by a recovery checkpoint', async () => {
    const { engine, stream, host } = await start();
    engine.beginProjection(JA);
    expect(show(engine, 5)).toBe(true);
    expect(show(engine, 7)).toBe(true);
    expect(show(engine, 16, JA, '42')).toBe(true);
    const before = host.iframe!.contentDocument!;

    stream.observer?.onFailure('stream_overflow');
    stream.observer?.onCheckpoint(checkpointOf(languageBody()));
    await vi.waitFor(() => {
      expect(host.iframe!.contentDocument).not.toBe(before);
    });
    const replica = host.iframe!.contentDocument!;
    expect(holder(replica, 5).textContent).toBe('訳5');
    expect(holder(replica, 5).getAttribute('lang')).toBe('ja');
    expect(holder(replica, 7).getAttribute('lang')).toBe('ja');
    expect(holder(replica, 9).getAttribute('lang')).toBe('ja');
    // Text the translator left alone is still untagged there.
    expect(holder(replica, 16).hasAttribute('lang')).toBe(false);

    engine.beginProjection(SOURCE_ONLY);
    expect(holder(replica, 5).hasAttribute('lang')).toBe(false);
    expect(holder(replica, 7).getAttribute('lang')).toBe('fr');
  });

  it('leaves the language tags alone while Keep geometry measures the page\'s text', async () => {
    const stream = new FakeHtmlStream(checkpointOf([
      element(4, 'p', [['lang', 'fr']], [text(5, 'Bonjour.')]),
    ]));
    const host = new FakePresentationHost();
    const refreshes: (() => void)[] = [];
    const measured: string[] = [];
    const engine = new IsolatedHtmlReplicaEngine({
      presentationHost: host,
      openStream: async () => stream,
      getTextLayoutMode: () => 'faithful',
      scheduleLayoutRefresh: (callback) => refreshes.push(callback),
      initializeIframe: async (iframe, shell) => {
        const { document } = parseHTML(shell);
        Object.defineProperty(iframe, 'contentDocument', { value: document });
        Object.defineProperty(iframe, 'contentWindow', {
          value: {
            getComputedStyle: (target: Element) => {
              if (target.localName === 'p') {
                measured.push([
                  target.textContent,
                  target.getAttribute('lang'),
                  target.getAttribute(PAGE_LANGUAGE_ATTRIBUTE),
                ].join('|'));
              }
              return {
                display: 'block', boxSizing: 'border-box', width: '800px',
                height: '20px', fontSize: '16px', lineHeight: 'normal',
              };
            },
          },
        });
        return document;
      },
    });
    expect((await engine.run(request)).status).toBe('complete');
    engine.beginProjection(JA);
    expect(show(engine, 5)).toBe(true);
    const paragraph = host.iframe!.contentDocument!.querySelector('p')!;
    // Every write to the element but the lock's own `style`.
    const writes: string[] = [];
    const setAttribute = paragraph.setAttribute.bind(paragraph);
    const setAttributeNS = paragraph.setAttributeNS.bind(paragraph);
    const removeAttribute = paragraph.removeAttribute.bind(paragraph);
    paragraph.setAttribute = (name: string, value: string): void => {
      if (name !== 'style') writes.push(name);
      setAttribute(name, value);
    };
    paragraph.setAttributeNS = (namespace, name, value): void => {
      writes.push(name);
      setAttributeNS(namespace, name, value);
    };
    paragraph.removeAttribute = (name: string): void => {
      if (name !== 'style') writes.push(name);
      removeAttribute(name);
    };
    measured.length = 0;
    for (const refresh of refreshes.splice(0)) refresh();

    // The page's text is measured with the tag on: the page's language
    // beside it is what Chrome draws by, so the box is the page's, and a
    // refresh costs the tagged elements nothing.
    expect(measured).toContain('Bonjour.|ja|fr');
    expect(measured.every((entry) => entry.endsWith('|ja|fr'))).toBe(true);
    expect(writes).toEqual([]);
    expect(paragraph.textContent).toBe('訳5');
    expect(paragraph.getAttribute('lang')).toBe('ja');
    expect(paragraph.style.getPropertyValue('height')).toBe('20px');

    engine.beginProjection(SOURCE_ONLY);
    for (const refresh of refreshes.splice(0)) refresh();
    expect(paragraph.getAttribute('lang')).toBe('fr');
    expect(paragraph.hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);
    expect(paragraph.getAttribute('style')).toBeNull();
  });

  it('still counts every attribute toward the size of the replica it keeps', async () => {
    // The panel keeps four times the page budget: 4 MiB at the smallest.
    const limits = { itemMegabytes: 1, pageMegabytes: 1, maxElements: 5_000 };
    try {
      applyHtmlMirrorLimitSettings(limits);
      const ids = [4, 6, 8, 10, 12, 14];
      const stream = new FakeHtmlStream(checkpointOf(
        ids.map((id) => element(id, 'p', [], [text(id + 1, `P${id}`)])),
      ));
      const engine = new IsolatedHtmlReplicaEngine({
        presentationHost: new FakePresentationHost(),
        getMirrorLimits: () => limits,
        openStream: async () => stream,
        initializeIframe: async (iframe, shell) => {
          const { document } = parseHTML(shell);
          Object.defineProperty(iframe, 'contentDocument', { value: document });
          return document;
        },
      });
      expect((await engine.run(request)).status).toBe('complete');
      // 400,000 characters count as 800,000 bytes, in the middle attribute.
      const long = 'x'.repeat(400_000);
      for (const [index, id] of ids.entries()) {
        patch(stream, index + 1, [{
          kind: 'attributes', nodeId: id, namespace: 'html', tagName: 'p',
          attributes: [['class', 'a'], ['title', long], ['dir', 'ltr']],
        }]);
      }
      // Five fit; the sixth takes the replica past what the panel keeps.
      expect(stream.acknowledged).toEqual([0, 1, 2, 3, 4, 5]);
      expect(stream.requested).toEqual([5]);
    } finally {
      applyHtmlMirrorLimitSettings();
    }
  });

  /**
   * An input and, inside a wrapper, a select with two options, with their
   * semantic records, a translation begun, and ways to translate them.
   */
  async function startControls(
    wrapper: readonly (readonly [string, string])[] = [],
  ) {
    const stream = new FakeHtmlStream(createHtmlMirrorCheckpoint(
      createReplicaIdentity({ ...identityParts, sequence: 0 }),
      {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [['lang', 'en']], children: [
            element(2, 'head', [], []),
            element(3, 'body', [], [
              element(4, 'input', [['type', 'text']], []),
              element(5, 'div', wrapper, [
                element(6, 'select', [], [
                  element(7, 'option', [], []),
                  element(8, 'option', [], []),
                ]),
              ]),
            ]),
          ],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 1000,
      },
      'passive',
    )!);
    const semantic = new FakeSemanticStream();
    const host = new FakePresentationHost();
    const engine = makeEngine(stream, host, undefined, semantic);
    await engine.run(request);
    await Promise.resolve();
    const record = (
      recordId: number,
      nodeId: number,
      tagName: string,
      value: string,
      presentation: SemanticSourceRecord['presentation'],
    ): SemanticSourceRecord => ({
      bridge: 'isolated-html', recordId, nodeId, nodeRevision: 1,
      category: presentation === 'label' ? 'public-semantic' : 'ordinary-form',
      gate: presentation === 'label' ? 'controlSemantics' : 'formValues',
      tagName, type: tagName === 'input' ? 'text' : '', autocomplete: '',
      role: '', contentEditable: '', text: value, presentation,
      classifierVersion: 1,
    });
    expect(semantic.emit(createSemanticSourceBatch(
      engine.snapshot()!.document,
      'read-v1-111111',
      1,
      [
        record(34, 4, 'input', 'Search here', 'placeholder'),
        record(57, 7, 'option', 'One', 'label'),
        record(65, 8, 'option', 'Two', 'label'),
        record(53, 6, 'select', 'One', 'selection'),
      ],
      [{
        kind: 'select-presentation', bridge: 'isolated-html', nodeId: 6,
        revision: 1, gate: 'controlSemantics', multiple: false, size: null,
        classifierVersion: 1,
      }, {
        kind: 'select-state', bridge: 'isolated-html', nodeId: 6,
        revision: 1, gate: 'formValues', selectedOptionNodeIds: [7],
        multiple: false, pickerOpen: false, classifierVersion: 1,
      }],
    ))).toBe(true);

    const replica = host.iframe!.contentDocument!;
    const input = replica.querySelector('input')!;
    const selectHost = replica.querySelector('[data-simul-owned-select-host]')!;
    const shadow = selectHost.shadowRoot!;
    const trigger = shadow.querySelector('[data-simul-owned-select-trigger="v1"]')!;
    const rowElements = (): Element[] => [...shadow.querySelectorAll(
      '[data-simul-owned-select-option="v1"]',
    )];
    const rows = (): string[] => rowElements()
      .map((row) => `${row.getAttribute('lang')}:${row.textContent}`);
    expect(rows()).toEqual(['null:One', 'null:Two']);
    expect(trigger.innerHTML).toBe('One');

    engine.beginProjection(JA);
    const snapshot = engine.snapshot()!;
    /** Shows `translated` for every record of this source text. */
    const translate = (source: string, translated: string): number => {
      const candidates = snapshot.records.filter((entry) =>
        entry.source === source && entry.nodeType === 1);
      for (const candidate of candidates) {
        if (candidate.nodeType !== 1) continue;
        expect(engine.project({
          document: snapshot.document, replayLease: snapshot.replayLease,
          nodeId: candidate.nodeId, nodeType: 1,
          controlTarget: candidate.controlTarget,
          sourceRevision: candidate.revision, source: candidate.source,
          translationEpoch: 1, pairKey: 'en>ja', translated,
        })).toBe(true);
      }
      return candidates.length;
    };
    return {
      stream, engine, replica, input, selectHost, shadow, trigger,
      rowElements, rows, translate,
    };
  }

  it('still counts every node toward the size of the replica it keeps', async () => {
    // The panel keeps three times the element limit: 3,032 nodes at the
    // smallest. Simul's own nodes count too: each shadow root of the mirror
    // holds a style element for the shell and one for each adopted sheet.
    const limits = { itemMegabytes: 1, pageMegabytes: 1, maxElements: 1_000 };
    const run = async (sheets: number) => {
      const stream = new FakeHtmlStream(checkpointOf(
        Array.from({ length: 200 }, (_, at): HtmlMirrorNode => ({
          kind: 'element', id: 10 + at * 2, namespace: 'html', tagName: 'div',
          attributes: [], children: [], shadowRoot: {
            id: 11 + at * 2, mode: 'open', children: [],
            adoptedStyleSheets: Array.from(
              { length: sheets },
              (_unused, sheet) => `.s${sheet}{color:red}`,
            ),
          },
        })),
      ));
      const host = new FakePresentationHost();
      const engine = new IsolatedHtmlReplicaEngine({
        presentationHost: host,
        getMirrorLimits: () => limits,
        openStream: async () => stream,
        initializeIframe: async (iframe, shell) => {
          const { document } = parseHTML(shell);
          Object.defineProperty(iframe, 'contentDocument', { value: document });
          return document;
        },
      });
      expect((await engine.run(request)).status).toBe('complete');
      // Any patch has the size looked at.
      patch(stream, 1, [{
        kind: 'attributes', nodeId: 3, namespace: 'html', tagName: 'body',
        attributes: [['class', 'a']],
      }]);
      return stream;
    };
    try {
      applyHtmlMirrorLimitSettings(limits);
      // 200 hosts and roots, and in each root a shell style and five sheets
      // with their text: about 2,800 nodes.
      const fits = await run(5);
      expect(fits.acknowledged).toEqual([0, 1]);
      expect(fits.requested).toEqual([]);
      // With six sheets a root: about 3,200.
      const tooMany = await run(6);
      expect(tooMany.acknowledged).toEqual([0]);
      expect(tooMany.requested).toEqual([0]);
    } finally {
      applyHtmlMirrorLimitSettings();
    }
  });

  it('tags a control\'s translated text and the select facsimile\'s translated text', async () => {
    const {
      engine, replica, input, selectHost, shadow, trigger, rowElements, rows,
      translate,
    } = await startControls();
    expect(translate('Search here', 'ここで検索')).toBe(1);
    expect(input.placeholder).toBe('ここで検索');
    expect(input.getAttribute('lang')).toBe('ja');

    // A label the translator gave back as it was is not a translation.
    expect(translate('Two', 'Two')).toBe(1);
    expect(rows()).toEqual(['null:One', 'null:Two']);
    expect(replica.querySelectorAll('option[lang]').length).toBe(0);
    // Only the translated option carries the language, on its row.
    expect(translate('Two', '二')).toBe(1);
    expect(rows()).toEqual(['null:One', 'ja:二']);

    // The option's label and the select's current choice.
    expect(translate('One', '一')).toBe(2);
    expect(rows()).toEqual(['ja:一', 'ja:二']);
    // The trigger's own name stays Simul's English label; its text is tagged.
    expect(trigger.getAttribute('aria-label')).toBe('Show translated options');
    expect(trigger.hasAttribute('lang')).toBe(false);
    expect(trigger.querySelector('span')?.getAttribute('lang')).toBe('ja');
    // Simul's own copies are drawn by no language, as they were before.
    expect(rowElements().map((row) => row.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)))
      .toEqual(['', '']);
    expect(trigger.querySelector('span')?.getAttribute(PAGE_LANGUAGE_ATTRIBUTE))
      .toBe('');
    expect(shadow.querySelector('[data-simul-owned-select-style="v1"]')?.textContent)
      .not.toContain('lang');
    expect(trigger.textContent).toBe('一');
    expect(selectHost.hasAttribute('lang')).toBe(false);

    engine.beginProjection(SOURCE_ONLY);
    expect(input.hasAttribute('lang')).toBe(false);
    expect(input.placeholder).toBe('Search here');
    expect(rows()).toEqual(['null:One', 'null:Two']);
    expect(trigger.innerHTML).toBe('One');
    expect(shadow.querySelectorAll('[lang]').length).toBe(0);
    expect([...shadow.querySelectorAll('*')].filter((candidate) =>
      candidate.hasAttribute(PAGE_LANGUAGE_ATTRIBUTE))).toEqual([]);
  });

  it('redraws the select facsimile at once when the page changes a language around it', async () => {
    const { stream, shadow, trigger, rowElements, rows, translate } =
      await startControls([['lang', 'de']]);
    expect(translate('One', '一')).toBe(2);
    expect(translate('Two', '二')).toBe(1);
    const options = (): string[] => [...shadow.querySelectorAll('option')]
      .map((option) => `${option.getAttribute('lang')}|${option.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)}`);
    const drawnBy = (): (string | null)[] => rowElements()
      .map((row) => row.getAttribute(PAGE_LANGUAGE_ATTRIBUTE));
    const wrap = (sequence: number, attributes: [string, string][]): void => {
      patch(stream, sequence, [{
        kind: 'attributes', nodeId: 5, namespace: 'html', tagName: 'div', attributes,
      }]);
      expect(stream.acknowledged).toContain(sequence);
    };
    expect(options()).toEqual(['ja|de', 'ja|de']);
    expect(rows()).toEqual(['ja:一', 'ja:二']);
    expect(drawnBy()).toEqual(['', '']);

    // The page now declares Japanese there: nothing is left to say.
    wrap(1, [['lang', 'ja']]);
    expect(options()).toEqual(['null|null', 'null|null']);
    expect(rows()).toEqual(['null:一', 'null:二']);
    expect(drawnBy()).toEqual([null, null]);
    expect(trigger.innerHTML).toBe('一');

    // And French: the options are tagged again, and the rows with them.
    wrap(2, [['lang', 'fr']]);
    expect(options()).toEqual(['ja|fr', 'ja|fr']);
    expect(rows()).toEqual(['ja:一', 'ja:二']);
    expect(drawnBy()).toEqual(['', '']);
    expect(trigger.querySelector('span')?.getAttribute('lang')).toBe('ja');
    expect(trigger.querySelector('span')?.getAttribute(PAGE_LANGUAGE_ATTRIBUTE))
      .toBe('');

    wrap(3, []);
    expect(options()).toEqual(['ja|en', 'ja|en']);
    expect(rows()).toEqual(['ja:一', 'ja:二']);
  });

  it('has the images named by a caption looked at again when the page changes a lang', async () => {
    const { stream, host } = await start([
      element(4, 'p', [], [element(5, 'img', [['alt', 'A harbour']], [])]),
    ]);
    const replica = host.iframe!.contentDocument!;
    const image = replica.querySelector('img')!;
    const state = (): string =>
      `${image.getAttribute('lang')}|${image.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)}`;
    const page = (sequence: number, nodeId: number, tagName: string, attributes: [string, string][]): void => {
      patch(stream, sequence, [{
        kind: 'attributes', nodeId, namespace: 'html', tagName, attributes,
      }]);
      expect(stream.acknowledged).toContain(sequence);
    };
    // The page says Japanese when the caption lands, as the image overlay
    // projector names the image: nothing to say. No text is translated.
    page(1, 1, 'html', [['lang', 'ja']]);
    setReplicaAttributeOverride(image, 'aria-label', '港');
    showImageLanguage(image, 'ja');
    expect(state()).toBe('null|null');

    // The page goes back to English: the Japanese name says its language.
    page(2, 1, 'html', [['lang', 'en']]);
    expect(state()).toBe('ja|en');
    // An ancestor's and the image's own `lang` are followed too.
    page(3, 4, 'p', [['lang', 'de']]);
    expect(state()).toBe('ja|de');
    page(4, 5, 'img', [['alt', 'A harbour'], ['lang', 'fr']]);
    expect(state()).toBe('ja|fr');
    page(5, 5, 'img', [['alt', 'A harbour']]);
    expect(state()).toBe('ja|de');
    page(6, 4, 'p', [['lang', 'ja-JP']]);
    expect(state()).toBe('null|null');
    expect(image.getAttribute('aria-label')).toBe('港');

    hideImageLanguage(image);
    clearReplicaAttributeOverride(image, 'aria-label');
    page(7, 4, 'p', []);
    expect(image.attributes.length).toBe(1);
  });

  it('keeps a translated image name through the page\'s patches and puts the page\'s label back', async () => {
    const { stream, host } = await start([
      element(4, 'p', [], [
        element(5, 'img', [['alt', 'A harbour'], ['aria-label', 'Page label']], []),
      ]),
      element(6, 'div', [], [text(7, 'Sibling.')]),
    ]);
    const replica = host.iframe!.contentDocument!;
    const image = replica.querySelector('img')!;
    // As the image overlay projector does while a caption shows.
    setReplicaAttributeOverride(image, 'aria-label', '港');

    patch(stream, 1, [{
      kind: 'attributes', nodeId: 5, namespace: 'html', tagName: 'img',
      attributes: [['alt', 'A changed harbour'], ['aria-label', 'Changed label'], ['class', 'hero']],
    }]);
    expect(stream.acknowledged).toContain(1);
    expect(image.getAttribute('aria-label')).toBe('港');
    expect(image.getAttribute('alt')).toBe('A changed harbour');
    expect(image.getAttribute('class')).toBe('hero');

    // A patch that fails elsewhere is rolled back: neither value moves.
    const sibling = replica.querySelector('div')!;
    const originalInsertBefore = sibling.insertBefore.bind(sibling);
    const insert = vi.spyOn(sibling, 'insertBefore').mockImplementationOnce(() => {
      throw new Error('synthetic apply failure');
    });
    patch(stream, 2, [{
      kind: 'attributes', nodeId: 5, namespace: 'html', tagName: 'img',
      attributes: [['alt', 'Never shown']],
    }, {
      kind: 'reconcile-children', nodeId: 6, children: [
        { kind: 'graph', node: element(50, 'span', [], [text(51, 'Partial.')]) },
        { kind: 'retain', nodeId: 7 },
      ],
    }]);
    insert.mockRestore();
    sibling.insertBefore = originalInsertBefore;
    expect(stream.acknowledged).not.toContain(2);
    expect(image.getAttribute('aria-label')).toBe('港');
    expect(image.getAttribute('alt')).toBe('A changed harbour');

    clearReplicaAttributeOverride(image, 'aria-label');
    expect(image.getAttribute('aria-label')).toBe('Changed label');
    expect(image.getAttribute('class')).toBe('hero');
  });

  /** Live regions the page marks, roles that are live by default, and others. */
  function liveBody(): HtmlMirrorNode[] {
    return [
      element(4, 'div', [
        ['aria-live', 'polite'], ['aria-atomic', 'true'],
        ['aria-relevant', 'additions text'],
      ], [text(5, 'Score 0')]),
      element(6, 'div', [['role', 'alert']], [text(7, 'Alert.')]),
      element(8, 'div', [['role', 'status']], [text(9, 'Status.')]),
      element(10, 'div', [['role', 'log']], [text(11, 'Log.')]),
      element(12, 'output', [], [text(13, 'Output.')]),
      element(14, 'div', [['role', 'marquee']], [text(15, 'Marquee.')]),
      element(16, 'div', [['role', 'timer']], [text(17, '00:10')]),
      element(18, 'p', [], [text(19, 'Plain.')]),
      element(20, 'div', [
        ['role', 'Alert presentation'], ['aria-live', 'assertive'],
      ], [text(21, 'Loud.')]),
    ];
  }

  const liveState = (replica: Document): string[] =>
    [...replica.body.children].map((child) =>
      `${child.localName}|${child.getAttribute('role')}|${child.getAttribute('aria-live')}`);

  it('builds no live region into the mirror and keeps every role', async () => {
    const { host } = await start(liveBody());
    const replica = host.iframe!.contentDocument!;
    expect(liveState(replica)).toEqual([
      'div|null|off',
      'div|alert|off',
      'div|status|off',
      'div|log|off',
      'output|null|off',
      // Off by default: nothing to add.
      'div|marquee|null',
      'div|timer|null',
      'p|null|null',
      'div|Alert presentation|off',
    ]);
    // What the page says beside aria-live stays for its CSS.
    expect(replica.body.firstElementChild?.getAttribute('aria-atomic')).toBe('true');
    expect(replica.body.firstElementChild?.getAttribute('aria-relevant'))
      .toBe('additions text');
  });

  it('keeps the mirror silent through attribute, text and translation changes', async () => {
    const { engine, stream, host } = await start(liveBody());
    const replica = host.iframe!.contentDocument!;
    patch(stream, 1, [{
      // The page raises a polite region to assertive.
      kind: 'attributes', nodeId: 4, namespace: 'html', tagName: 'div',
      attributes: [['aria-live', 'assertive']],
    }, {
      // A status becomes an alert.
      kind: 'attributes', nodeId: 8, namespace: 'html', tagName: 'div',
      attributes: [['role', 'alert'], ['class', 'urgent']],
    }, {
      // A plain paragraph becomes a live region.
      kind: 'attributes', nodeId: 18, namespace: 'html', tagName: 'p',
      attributes: [['aria-live', 'polite']],
    }, {
      // An alert stops being one: nothing of Simul's is left on it.
      kind: 'attributes', nodeId: 6, namespace: 'html', tagName: 'div',
      attributes: [['class', 'calm']],
    }, {
      kind: 'attributes', nodeId: 12, namespace: 'html', tagName: 'output',
      attributes: [['aria-live', 'assertive']],
    }, {
      kind: 'text', nodeId: 5, node: text(5, 'Score 1'),
    }]);
    expect(stream.acknowledged).toContain(1);
    expect(liveState(replica)).toEqual([
      'div|null|off',
      'div|null|null',
      'div|alert|off',
      'div|log|off',
      'output|null|off',
      'div|marquee|null',
      'div|timer|null',
      'p|null|off',
      'div|Alert presentation|off',
    ]);
    expect(replica.body.children[2]?.getAttribute('class')).toBe('urgent');

    // A translation lands in a live region and goes again.
    engine.beginProjection(JA);
    expect(show(engine, 9)).toBe(true);
    expect(replica.body.children[2]?.textContent).toBe('訳9');
    expect(replica.body.children[2]?.getAttribute('lang')).toBe('ja');
    expect(replica.body.children[2]?.getAttribute('aria-live')).toBe('off');
    engine.beginProjection(SOURCE_ONLY);
    expect(replica.body.children[2]?.hasAttribute('lang')).toBe(false);
    expect(replica.body.children[2]?.getAttribute('aria-live')).toBe('off');

    // An inserted live region is silent from the start.
    patch(stream, 2, [{
      kind: 'children', nodeId: 18, children: [
        element(30, 'span', [['role', 'alert']], [text(31, 'Late alert.')]),
        element(32, 'span', [['aria-live', 'polite']], [text(33, 'Late status.')]),
      ],
    }]);
    expect([...replica.body.children[7]!.children].map(
      (child) => `${child.getAttribute('role')}|${child.getAttribute('aria-live')}`,
    )).toEqual(['alert|off', 'null|off']);
  });

  it('stays silent after a patch is rolled back', async () => {
    const { stream, host } = await start(liveBody());
    const replica = host.iframe!.contentDocument!;
    const body = replica.body;
    const plain = replica.querySelector('p')!;
    const originalInsertBefore = plain.insertBefore.bind(plain);
    const insert = vi.spyOn(plain, 'insertBefore').mockImplementationOnce(() => {
      throw new Error('synthetic apply failure');
    });
    patch(stream, 1, [{
      kind: 'attributes', nodeId: 6, namespace: 'html', tagName: 'div',
      attributes: [['role', 'alert'], ['aria-live', 'assertive'], ['class', 'x']],
    }, {
      kind: 'reconcile-children', nodeId: 18, children: [
        { kind: 'graph', node: element(50, 'span', [], [text(51, 'Partial.')]) },
        { kind: 'retain', nodeId: 19 },
      ],
    }]);
    insert.mockRestore();
    plain.insertBefore = originalInsertBefore;
    expect(stream.requested).toEqual([0]);
    expect(plain.textContent).toBe('Plain.');
    expect(body.children[1]?.getAttribute('aria-live')).toBe('off');
    expect(body.children[1]?.hasAttribute('class')).toBe(false);
    expect(liveState(replica)[0]).toBe('div|null|off');
  });
});

const identityParts = {
  sessionId: 'session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'document',
  frameId: 0,
};

const request: ReplicaCaptureRequest = {
  ...identityParts,
  tabId: 1,
  isCurrent: () => true,
};

function makeCheckpoint(
  text: string,
  sequence: number,
  parts: typeof identityParts = identityParts,
): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...parts, sequence }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html', attributes: [['lang', 'en']], children: [
          { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
          { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [
            { kind: 'text', id: 4, text, translatable: true },
          ] },
        ],
      },
      adoptedStyleSheets: [],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Fixture checkpoint rejected.');
  return checkpoint;
}

function makeCarouselCheckpoint(): HtmlMirrorCheckpoint {
  const slide = (id: number, name: string, text: string): HtmlMirrorNode => ({
    kind: 'element', id, namespace: 'html', tagName: 'div',
    attributes: [['class', `swiper-slide ${name}`], ['role', 'group']],
    children: [{
      kind: 'element', id: id + 1, namespace: 'html', tagName: 'div',
      attributes: [], children: [{
        kind: 'text', id: id + 2, text, translatable: true,
      }],
    }],
  });
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence: 0 }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html',
        attributes: [], children: [
          { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [] },
          { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [{
            kind: 'element', id: 4, namespace: 'html', tagName: 'div',
            attributes: [
              ['class', 'swiper-wrapper'],
              ['style', 'transform: translate3d(-1068px, 0px, 0px)'],
            ],
            children: [
              slide(5, 'kvslide1', 'slide one'),
              slide(8, 'kvslide2', 'slide two'),
            ],
          }] },
        ],
      },
      adoptedStyleSheets: [],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Fixture checkpoint rejected.');
  return checkpoint;
}

function makePaintedLogoCheckpoint(
  text: string | readonly string[],
  sequence: number,
): HtmlMirrorCheckpoint {
  const fragments = typeof text === 'string' ? [text] : [...text];
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html',
        attributes: [['lang', 'ja']], children: [
          {
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [],
          },
          {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [{
              kind: 'element', id: 4, namespace: 'html', tagName: 'a',
              attributes: [['class', 'header-logo']],
              children: fragments.map((fragment, index) => ({
                kind: 'text' as const,
                id: 5 + index,
                text: fragment,
                translatable: true,
              })),
            }],
          },
        ],
      },
      adoptedStyleSheets: [],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Painted logo fixture checkpoint rejected.');
  return checkpoint;
}

function installPaintedLogoLayout(
  document: Document,
  sanitizedBackground: boolean,
): void {
  const view = document.defaultView!;
  Object.defineProperty(document, 'baseURI', {
    configurable: true,
    value: 'about:blank',
  });
  Object.defineProperty(view, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(view, 'innerHeight', { configurable: true, value: 600 });
  Object.defineProperty(view, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => paintedLogoStyle(element, sanitizedBackground),
  });
  Object.defineProperty(view.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRectReadOnly {
      const painted = this.classList.contains('header-logo');
      const width = painted ? 130 : 800;
      const height = painted ? 24 : 600;
      return {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRectReadOnly;
    },
  });
}

function paintedLogoStyle(
  element: Element,
  sanitizedBackground: boolean,
): CSSStyleDeclaration {
  const html = element as HTMLElement;
  const inline = html.style;
  const painted = element.classList.contains('header-logo');
  const values: Readonly<Record<string, string>> = painted
    ? {
        'background-image': sanitizedBackground
          ? 'url("about:blank")'
          : 'url("https://mainichi.example.test/logo.svg")',
        'content-visibility': 'visible',
        display: 'block',
        'font-size': '16px',
        opacity: '1',
        overflow: 'hidden',
        'overflow-x': 'hidden',
        position: 'static',
        'text-indent': '-99em',
        visibility: 'visible',
        '-webkit-text-security': 'none',
      }
    : {
        'content-visibility': 'visible',
        display: 'block',
        opacity: '1',
        visibility: 'visible',
        '-webkit-text-security': 'none',
      };
  return {
    getPropertyValue: (property: string) =>
      inline?.getPropertyValue(property) || values[property] || '',
  } as unknown as CSSStyleDeclaration;
}

function makeReconciliationCheckpoint(): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence: 0 }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html',
        attributes: [['lang', 'en']], children: [
          {
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [],
          },
          {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [
              {
                kind: 'element', id: 4, namespace: 'html', tagName: 'x-card',
                attributes: [], children: [{
                  kind: 'element', id: 5, namespace: 'html', tagName: 'img',
                  attributes: [
                    ['src', 'https://images.example.test/card.jpg'],
                    ['slot', 'media'],
                  ],
                  children: [],
                }],
                shadowRoot: {
                  id: 8, mode: 'open', adoptedStyleSheets: [
                    ':host{display:block}',
                  ],
                  children: [{
                    kind: 'element', id: 9, namespace: 'html', tagName: 'slot',
                    attributes: [['name', 'media']], children: [],
                  }],
                },
              },
              {
                kind: 'element', id: 6, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 7, text: 'translated source',
                  translatable: true,
                }],
              },
            ],
          },
        ],
      },
      adoptedStyleSheets: ['body{display:block}'],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Reconciliation fixture checkpoint rejected.');
  return checkpoint;
}

function makeCrossParentCheckpoint(): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence: 0 }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html',
        attributes: [], children: [
          {
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [],
          },
          {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [
              {
                kind: 'element', id: 4, namespace: 'html', tagName: 'section',
                attributes: [], children: [{
                  kind: 'element', id: 5, namespace: 'html', tagName: 'p',
                  attributes: [], children: [{
                    kind: 'text', id: 6, text: 'first', translatable: true,
                  }, {
                    kind: 'element', id: 10, namespace: 'html', tagName: 'img',
                    attributes: [['src', 'https://images.example.test/moved.jpg']],
                    children: [],
                  }],
                }],
              },
              {
                kind: 'element', id: 7, namespace: 'html', tagName: 'section',
                attributes: [], children: [{
                  kind: 'element', id: 8, namespace: 'html', tagName: 'p',
                  attributes: [], children: [{
                    kind: 'text', id: 9, text: 'second', translatable: true,
                  }],
                }],
              },
            ],
          },
        ],
      },
      adoptedStyleSheets: [],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Cross-parent fixture checkpoint rejected.');
  return checkpoint;
}

function makeThreeChildCheckpoint(): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence: 0 }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html',
        attributes: [], children: [
          {
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [],
          },
          {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [
              {
                kind: 'element', id: 4, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 5, text: 'first', translatable: true,
                }],
              },
              {
                kind: 'element', id: 6, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 7, text: 'second', translatable: true,
                }],
              },
              {
                kind: 'element', id: 8, namespace: 'html', tagName: 'p',
                attributes: [], children: [{
                  kind: 'text', id: 9, text: 'third', translatable: true,
                }],
              },
            ],
          },
        ],
      },
      adoptedStyleSheets: ['body{display:block}'],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Three-child fixture checkpoint rejected.');
  return checkpoint;
}

function makeStylesheetCheckpoint(): HtmlMirrorCheckpoint {
  const checkpoint = createHtmlMirrorCheckpoint(
    createReplicaIdentity({ ...identityParts, sequence: 0 }),
    {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html', attributes: [], children: [
          { kind: 'element', id: 2, namespace: 'html', tagName: 'head', attributes: [], children: [{
            kind: 'element', id: 5, namespace: 'html', tagName: 'link',
            attributes: [['rel', 'stylesheet'], ['href', 'https://static.example.test/race.css']],
            children: [],
          }] },
          { kind: 'element', id: 3, namespace: 'html', tagName: 'body', attributes: [], children: [
            { kind: 'text', id: 4, text: 'styled content', translatable: true },
          ] },
        ],
      },
      adoptedStyleSheets: [],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1000,
    },
  );
  if (!checkpoint) throw new Error('Stylesheet fixture checkpoint rejected.');
  return checkpoint;
}

class FakeHtmlStream implements HtmlMirrorStreamLease {
  readonly acknowledged: number[] = [];
  readonly requested: number[] = [];
  readonly initialCheckpoint: Promise<HtmlMirrorCheckpoint>;
  observer?: HtmlMirrorStreamObserver;

  constructor(
    checkpoint: HtmlMirrorCheckpoint,
    private readonly onObserve?: (observer: HtmlMirrorStreamObserver) => void,
  ) {
    this.initialCheckpoint = Promise.resolve(checkpoint);
  }

  setObserver(observer: HtmlMirrorStreamObserver): void {
    this.observer = observer;
    this.onObserve?.(observer);
  }

  acknowledge(sequence: number): void {
    this.acknowledged.push(sequence);
  }

  requestCheckpoint(sequence: number): void {
    this.requested.push(sequence);
  }

  dispose = vi.fn();
}

class FakeSemanticStream implements SemanticSourceStreamLease {
  observer?: SemanticSourceStreamObserver;
  disposed = false;

  setObserver(observer: SemanticSourceStreamObserver): void {
    this.observer = observer;
  }

  dispose(): void {
    this.disposed = true;
  }

  emit(batch: Parameters<SemanticSourceStreamObserver['onBatch']>[0]): boolean {
    return this.observer?.onBatch(batch) ?? false;
  }

  fail(): void {
    this.observer?.onFailure();
  }
}

class FakePresentationHost implements ReplayPresentationHost {
  readonly document = parseHTML('<html><body></body></html>').document;
  readonly releases: Array<ReturnType<typeof vi.fn>> = [];
  iframe?: HTMLIFrameElement;
  dimensions?: VisibleReplayDimensions;
  resolveNode?: (nodeId: number) => Node | undefined;

  createCandidate(dimensions: VisibleReplayDimensions): VisibleReplayCandidateLease {
    this.dimensions = dimensions;
    const mount = this.document.createElement('div') as unknown as HTMLElement;
    const release = vi.fn();
    this.releases.push(release);
    return {
      mount,
      commit: (iframe, _extent, resolveNode) => {
        this.iframe = iframe;
        if (resolveNode) this.resolveNode = resolveNode;
        // As the real host: the committed replica is exposed (D118).
        iframe.removeAttribute('aria-hidden');
      },
      release,
    };
  }

  markLive = vi.fn();
  refreshExtent = vi.fn();
  refreshDimensions = vi.fn();
  setInteractiveAccessibility = vi.fn((
    _iframe: HTMLIFrameElement,
    _accessible: boolean,
  ) => true);
  clearPresentation = vi.fn();
  dispose = vi.fn();
}

function makeEngine(
  stream: FakeHtmlStream,
  host: FakePresentationHost,
  onInfo?: ConstructorParameters<typeof IsolatedHtmlReplicaEngine>[0]['onInfo'],
  semantic?: FakeSemanticStream,
  scheduleLayoutRefresh?: (callback: FrameRequestCallback) => void,
): IsolatedHtmlReplicaEngine {
  return new IsolatedHtmlReplicaEngine({
    presentationHost: host,
    openStream: async () => stream,
    ...(semantic ? {
      openSemanticStream: async () => semantic,
      getReplicaReadScope: () => FULL_VISIBLE_REPLICA_READ_SCOPE,
    } : {}),
    initializeIframe: async (iframe, shell) => {
      const { document } = parseHTML(shell);
      Object.defineProperty(iframe, 'contentDocument', { value: document });
      return document;
    },
    ...(onInfo ? { onInfo } : {}),
    ...(scheduleLayoutRefresh ? { scheduleLayoutRefresh } : {}),
  });
}
