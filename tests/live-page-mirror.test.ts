import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

import {
  captureLivePageDelta,
  installLivePageObserverBridge,
  installLivePageObserver,
  invokeLivePageDeltaCaptureBridge,
  invokeLivePageObserverBridge,
  invokeLivePageObserverUnregisterBridge,
  parseLivePageDelta,
  readLivePageDirtyMessage,
  readLivePageObserverInstallation,
  readLivePageScrollMessage,
  type LiveVisualElementNode,
  type LiveVisualNode,
  unregisterLivePageObserver,
} from '../lib/live-page-mirror';
import {
  isDocumentScrollTarget,
  nestedScrollerOrdinal,
  readDocumentScrollSnapshot,
  readNestedScrollSnapshot,
} from '../lib/primary-scroll';
import { parsePageSnapshot } from '../lib/page-snapshot';
import {
  applyLivePageDelta,
  createVisualMirror,
  translateVisualMirror,
} from '../lib/visual-renderer';

afterEach(() => {
  unregisterLivePageObserver('session_1234');
  delete (
    globalThis as typeof globalThis & { __simulLiveMirrorV1?: unknown }
  ).__simulLiveMirrorV1;
  delete (
    globalThis as typeof globalThis & { __simulLivePageObserverBridgeV4?: unknown }
  ).__simulLivePageObserverBridgeV4;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live mirror boundary', () => {
  it('accepts bounded generation messages and normalizes private URL parts', () => {
    expect(
      readLivePageDirtyMessage({
        type: 'simul:page-dirty',
        version: 1,
        sessionId: 'session_1234',
        generation: 4,
        sequence: 8,
        url: 'https://user:secret@example.com/article?q=private#part',
        nodeIds: ['n2', 'n2', 'n9'],
      }),
    ).toEqual({
      type: 'simul:page-dirty',
      version: 1,
      sessionId: 'session_1234',
      generation: 4,
      sequence: 8,
      url: 'https://example.com/article',
      nodeIds: ['n2', 'n9'],
    });
    expect(
      readLivePageDirtyMessage({
        type: 'simul:page-dirty',
        version: 1,
        sessionId: 'session_1234',
        generation: 4,
        sequence: 8,
        url: 'https://example.com/',
        nodeIds: ['bad selector'],
      }),
    ).toBeUndefined();
  });

  it('validates the observer sequence baseline used for gap detection', () => {
    expect(
      readLivePageObserverInstallation({
        installed: true,
        generation: 7,
        sequence: 19,
      }),
    ).toEqual({ installed: true, generation: 7, sequence: 19 });
    expect(
      readLivePageObserverInstallation({
        installed: true,
        generation: 7,
        sequence: -1,
      }),
    ).toBeUndefined();
    expect(
      readLivePageObserverInstallation({
        installed: false,
        generation: 7,
        sequence: 19,
        reason: 'session-limit',
      }),
    ).toEqual({
      installed: false,
      generation: 7,
      sequence: 19,
      reason: 'session-limit',
    });
  });

  it('invokes the locally bundled observer through closure-free functions', () => {
    installLivePageObserverBridge();
    const bridge = (
      globalThis as typeof globalThis & {
        __simulLivePageObserverBridgeV4?: {
          implementationRevision: number;
          install: (sessionId: string, generation: number) => unknown;
          captureDelta: (
            sessionId: string,
            generation: number,
            sequence: number,
            nodeIds: string[],
          ) => unknown;
          unregister: (sessionId: string) => boolean;
        };
      }
    ).__simulLivePageObserverBridgeV4!;
    const install = vi.fn(() => ({ installed: true, generation: 7, sequence: 3 }));
    const captureDelta = vi.fn(() => ({ version: 1, sequence: 4 }));
    const unregister = vi.fn(() => true);
    expect(bridge.implementationRevision).toBe(5);
    (
      globalThis as typeof globalThis & {
        __simulLivePageObserverBridgeV4?: unknown;
      }
    ).__simulLivePageObserverBridgeV4 = {
      implementationRevision: 5,
      install,
      captureDelta,
      unregister,
    };

    const detachedInstall = Function(
      `return (${invokeLivePageObserverBridge.toString()})`,
    )() as typeof invokeLivePageObserverBridge;
    const detachedUnregister = Function(
      `return (${invokeLivePageObserverUnregisterBridge.toString()})`,
    )() as typeof invokeLivePageObserverUnregisterBridge;
    const detachedCapture = Function(
      `return (${invokeLivePageDeltaCaptureBridge.toString()})`,
    )() as typeof invokeLivePageDeltaCaptureBridge;

    expect(detachedInstall('session_1234', 7)).toEqual({
      installed: true, generation: 7, sequence: 3,
    });
    expect(detachedUnregister('session_1234')).toBe(true);
    expect(detachedCapture('session_1234', 7, 4, ['n1'])).toEqual({
      version: 1, sequence: 4,
    });
    expect(install).toHaveBeenCalledWith('session_1234', 7);
    expect(captureDelta).toHaveBeenCalledWith('session_1234', 7, 4, ['n1']);
    expect(unregister).toHaveBeenCalledWith('session_1234');
  });

  it('rejects a seventeenth observer session without evicting an active one', () => {
    const sessions = new Map(
      Array.from({ length: 16 }, (_, index) => [`existing_${index}`, index]),
    );
    const announceScroll = vi.fn();
    (
      globalThis as typeof globalThis & { __simulLiveMirrorV1?: unknown }
    ).__simulLiveMirrorV1 = {
      implementationRevision: 5,
      sessions,
      currentSequence: () => 12,
      announceScroll,
      disconnect: vi.fn(),
    };

    expect(installLivePageObserver('session_1234', 17)).toEqual({
      installed: false,
      generation: 17,
      sequence: 12,
      reason: 'session-limit',
    });
    expect(sessions.size).toBe(16);
    expect(sessions.has('existing_0')).toBe(true);
    expect(sessions.has('session_1234')).toBe(false);
    expect(announceScroll).not.toHaveBeenCalled();
  });

  it('observes every attribute while keeping observer output sanitized', () => {
    const { document, window } = parseHTML('<html><body><main></main></body></html>');
    let observerOptions: MutationObserverInit | undefined;
    class TestMutationObserver {
      observe(_target: Node, options: MutationObserverInit): void {
        observerOptions = options;
      }
      disconnect(): void {}
    }
    class TestResizeObserver {
      observe(): void {}
      disconnect(): void {}
    }
    installLiveDomGlobals(document, window);
    vi.stubGlobal('MutationObserver', TestMutationObserver);
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn(async () => undefined) },
    });
    const staleDisconnect = vi.fn();
    (
      globalThis as typeof globalThis & { __simulLiveMirrorV1?: unknown }
    ).__simulLiveMirrorV1 = {
      sessions: new Map([['stale_session', 1]]),
      disconnect: staleDisconnect,
    };

    expect(installLivePageObserver('session_1234', 1)).toMatchObject({
      installed: true,
    });
    expect(staleDisconnect).toHaveBeenCalledOnce();
    expect((
      globalThis as typeof globalThis & {
        __simulLiveMirrorV1?: { implementationRevision?: number };
      }
    ).__simulLiveMirrorV1?.implementationRevision).toBe(5);
    expect(observerOptions).toMatchObject({
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    expect(observerOptions).not.toHaveProperty('attributeFilter');

    const sanitized = parseLivePageDelta({
      version: 1,
      generation: 1,
      sequence: 1,
      url: 'https://example.com/',
      documentWidth: 800,
      documentHeight: 600,
      desynchronized: false,
      replacements: [{
        targetId: 'n1',
        node: {
          kind: 'element',
          nodeId: 'n1',
          tag: 'div',
          style: {},
          attributes: {
            'aria-expanded': 'true',
            'data-private-state': 'secret',
          },
          children: [],
        },
      }],
    });
    expect(sanitized.replacements[0]?.node).not.toHaveProperty('attributes');
  });

  it('coalesces native selection and customizable-picker events on the select', () => {
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><select><option>Tokyo</option></select></body></html>',
    );
    installLiveDomGlobals(document, window);
    let mutationListener: MutationCallback | undefined;
    class TestMutationObserver {
      constructor(listener: MutationCallback) { mutationListener = listener; }
      observe(): void {}
      disconnect(): void {}
    }
    class TestResizeObserver { observe(): void {} disconnect(): void {} }
    vi.stubGlobal('MutationObserver', TestMutationObserver);
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const listeners = new Map<string, (event: Event) => void>();
    Object.defineProperty(document, 'addEventListener', {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (typeof listener === 'function') listeners.set(type, listener);
      },
    });

    installLivePageObserver('session_1234', 1);
    const select = document.querySelector('select')!;
    const registry = (
      globalThis as typeof globalThis & {
        __simulLiveMirrorV1?: { idFor(node: Node): string };
      }
    ).__simulLiveMirrorV1!;
    const selectId = registry.idFor(select);
    expect([...listeners.keys()]).toEqual(expect.arrayContaining([
      'input',
      'change',
      'beforetoggle',
      'toggle',
      'click',
      'keydown',
      'pointerdown',
    ]));

    mutationListener?.([{
      type: 'characterData',
      target: select.querySelector('option')!.firstChild!,
    } as unknown as MutationRecord], {} as MutationObserver);
    vi.advanceTimersByTime(141);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'simul:page-dirty',
      nodeIds: [selectId],
    }));
    sendMessage.mockClear();

    for (const type of [
      'input', 'change', 'beforetoggle', 'toggle', 'click', 'keydown',
      'pointerdown',
    ]) {
      listeners.get(type)?.({
        target: type === 'toggle' ? select.querySelector('option')! : select,
      } as unknown as Event);
    }
    vi.advanceTimersByTime(141);

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'simul:page-dirty',
      nodeIds: [selectId],
    }));

    select.remove();
    vi.advanceTimersByTime(251);
    sendMessage.mockClear();
    (select as HTMLSelectElement).selectedIndex = 0;
    vi.advanceTimersByTime(1_000);
    const messages = sendMessage.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(messages.some(
      ([message]) => message.type === 'simul:page-dirty',
    )).toBe(false);
  });

  it('polls bounded native-select IDL state when scripts change selection without events', () => {
    vi.useFakeTimers();
    const { document, window } = parseHTML(`
      <html><body><select>
        <option selected>Tokyo</option>
        <option>Osaka</option>
      </select></body></html>
    `);
    installLiveDomGlobals(document, window);
    class TestMutationObserver { observe(): void {} disconnect(): void {} }
    class TestResizeObserver { observe(): void {} disconnect(): void {} }
    vi.stubGlobal('MutationObserver', TestMutationObserver);
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    installLivePageObserver('session_1234', 1);
    const select = document.querySelector('select')!;
    const registry = (
      globalThis as typeof globalThis & {
        __simulLiveMirrorV1?: { idFor(node: Node): string };
      }
    ).__simulLiveMirrorV1!;
    const selectId = registry.idFor(select);
    (select as HTMLSelectElement).selectedIndex = 1;

    vi.advanceTimersByTime(391);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'simul:page-dirty',
      nodeIds: [selectId],
    }));

    sendMessage.mockClear();
    (select as HTMLSelectElement).selectedIndex = 0;
    vi.advanceTimersByTime(391);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'simul:page-dirty',
      nodeIds: [selectId],
    }));
  });

  it('clamps scroll messages and rejects executable delta data', () => {
    expect(
      readLivePageScrollMessage({
        type: 'simul:page-scroll',
        version: 1,
        sessionId: 'session_1234',
        generation: 2,
        url: 'https://example.com/',
        scrollX: -10,
        scrollY: 250,
        maxScrollX: 0,
        maxScrollY: 1_000,
      }),
    ).toMatchObject({
      scrollTarget: 'document', scrollX: 0, scrollY: 250, maxScrollY: 1_000,
      documentScrollX: 0, documentScrollY: 250,
      documentMaxScrollX: 0, documentMaxScrollY: 1_000,
    });
    expect(readLivePageScrollMessage({
      type: 'simul:page-scroll',
      version: 1,
      sessionId: 'session_1234',
      generation: 2,
      url: 'https://example.com/',
      scrollTarget: 'nested',
      scrollX: 0,
      scrollY: 20,
      maxScrollX: 0,
      maxScrollY: 100,
      documentScrollY: 10,
    })).toBeUndefined();
    expect(readLivePageScrollMessage({
      type: 'simul:page-scroll',
      version: 1,
      sessionId: 'session_1234',
      generation: 2,
      url: 'https://example.com/',
      scrollTarget: 'nested',
      nestedOwnerKey: 7,
      nestedOwnerOrdinal: 1,
      scrollX: 0,
      scrollY: 20,
      maxScrollX: 0,
      maxScrollY: 100,
      documentScrollX: 0,
      documentScrollY: 10,
      documentMaxScrollX: 0,
      documentMaxScrollY: 200,
    })).toMatchObject({
      scrollTarget: 'nested', nestedOwnerKey: 7, nestedOwnerOrdinal: 1,
      documentScrollY: 10, documentMaxScrollY: 200,
    });
    expect(readLivePageScrollMessage({
      type: 'simul:page-scroll',
      version: 1,
      sessionId: 'session_1234',
      generation: 2,
      url: 'https://example.com/',
      scrollTarget: 'document',
      nestedOwnerKey: 7,
      scrollX: 0,
      scrollY: 20,
      maxScrollX: 0,
      maxScrollY: 100,
    })).toBeUndefined();
    expect(readLivePageScrollMessage({
      type: 'simul:page-scroll',
      version: 1,
      sessionId: 'session_1234',
      generation: 2,
      url: 'https://example.com/',
      scrollTarget: 'nested',
      nestedOwnerOrdinal: -1,
      scrollX: 0,
      scrollY: 20,
      maxScrollX: 0,
      maxScrollY: 100,
    })).toBeUndefined();

    const delta = parseLivePageDelta({
      version: 1,
      generation: 2,
      sequence: 3,
      url: 'https://example.com/page?secret=yes',
      documentLanguage: ' ja-JP ',
      documentWidth: 1_300,
      documentHeight: 2_400,
      desynchronized: false,
      replacements: [
        {
          targetId: 'n2',
          node: {
            kind: 'element',
            nodeId: 'n2',
            tag: 'div',
            style: { display: 'block', cursor: 'pointer' },
            attributes: { onclick: 'alert(1)' },
            children: [{ kind: 'text', nodeId: 'n3', text: 'New text' }],
          },
        },
      ],
    });
    expect(delta.url).toBe('https://example.com/page');
    expect(delta.documentLanguage).toBe('ja-JP');
    expect(delta.replacements[0]?.node).toMatchObject({
      kind: 'element',
      style: { display: 'block' },
      children: [{ kind: 'text', text: 'New text' }],
    });
    expect(JSON.stringify(delta)).not.toContain('onclick');
    expect(JSON.stringify(delta)).not.toContain('cursor');

    expect(() =>
      parseLivePageDelta({
        version: 1,
        generation: 2,
        sequence: 4,
        url: 'https://example.com/',
        documentLanguage: 'x'.repeat(36),
        documentWidth: 800,
        documentHeight: 600,
        desynchronized: false,
        replacements: [],
      }),
    ).toThrow(/language/iu);
  });

  it('reads standards and body document scrollers with bounded coordinates', () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    defineScrollBox(document.documentElement, {
      clientWidth: 1_200, clientHeight: 700,
      scrollWidth: 1_500, scrollHeight: 3_000,
      scrollLeft: 60, scrollTop: 900,
    });
    defineScrollBox(document.body, {
      clientWidth: 1_200, clientHeight: 700,
      scrollWidth: 1_400, scrollHeight: 2_800,
      scrollLeft: 0, scrollTop: 0,
    });
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 700 },
      scrollX: { configurable: true, value: 60 },
      scrollY: { configurable: true, value: 900 },
    });
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true, value: document.documentElement,
    });
    expect(readDocumentScrollSnapshot(document, window)).toEqual({
      scrollTarget: 'document', scrollX: 60, scrollY: 900,
      maxScrollX: 300, maxScrollY: 2_300,
    });

    // A previous body-owned layout can leave a non-authoritative offset
    // behind. The current scrollingElement must win instead of the largest
    // coordinate found anywhere in the document.
    (document.documentElement as Element & { scrollTop: number }).scrollTop = 300;
    (document.body as Element & { scrollTop: number }).scrollTop = 1_700;
    Object.defineProperty(window, 'scrollY', {
      configurable: true, value: 300,
    });
    expect(readDocumentScrollSnapshot(document, window)).toMatchObject({
      scrollTarget: 'document', scrollY: 300,
    });

    defineScrollBox(document.body, {
      clientWidth: 1_200, clientHeight: 700,
      scrollWidth: 1_200, scrollHeight: 2_000,
      scrollLeft: 0, scrollTop: 5_000,
    });
    Object.defineProperties(window, {
      scrollX: { configurable: true, value: 0 },
      scrollY: { configurable: true, value: 0 },
    });
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true, value: document.body,
    });
    expect(readDocumentScrollSnapshot(document, window)).toMatchObject({
      scrollTarget: 'document', scrollY: 2_300, maxScrollY: 2_300,
    });
  });

  it('accepts a Google-shaped large nested viewport and ignores incidental scrollers', () => {
    const { document, window } = parseHTML(`
      <html><body><main id="results" style="overflow-y:auto"></main><div id="carousel"></div>
      <textarea id="editor"></textarea></body></html>
    `);
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 800 },
    });
    const results = document.querySelector('#results')!;
    defineScrollBox(results, {
      clientWidth: 900, clientHeight: 720,
      scrollWidth: 900, scrollHeight: 5_000,
      scrollLeft: 0, scrollTop: 1_300,
    }, { left: 240, top: 60, right: 1_140, bottom: 780 });
    expect(readNestedScrollSnapshot(results, document, window)).toEqual({
      scrollTarget: 'nested', scrollX: 0, scrollY: 1_300,
      maxScrollX: 0, maxScrollY: 4_280,
    });
    results.setAttribute('style', 'overflow-y:hidden');
    expect(readNestedScrollSnapshot(results, document, window)).toBeUndefined();
    results.setAttribute('style', 'overflow-y:clip');
    expect(readNestedScrollSnapshot(results, document, window)).toBeUndefined();
    results.setAttribute('style', 'overflow-y:auto');

    const carousel = document.querySelector('#carousel')!;
    defineScrollBox(carousel, {
      clientWidth: 900, clientHeight: 160,
      scrollWidth: 4_000, scrollHeight: 160,
      scrollLeft: 300, scrollTop: 0,
    }, { left: 100, top: 300, right: 1_000, bottom: 460 });
    expect(readNestedScrollSnapshot(carousel, document, window)).toBeUndefined();

    const editor = document.querySelector('#editor')!;
    defineScrollBox(editor, {
      clientWidth: 900, clientHeight: 720,
      scrollWidth: 900, scrollHeight: 5_000,
      scrollLeft: 0, scrollTop: 900,
    }, { left: 100, top: 40, right: 1_000, bottom: 760 });
    expect(readNestedScrollSnapshot(editor, document, window)).toBeUndefined();

    const secondResults = document.createElement('section');
    secondResults.setAttribute('style', 'overflow-y:auto');
    document.body.append(secondResults);
    defineScrollBox(secondResults, {
      clientWidth: 880, clientHeight: 700,
      scrollWidth: 880, scrollHeight: 4_700,
      scrollLeft: 0, scrollTop: 600,
    }, { left: 260, top: 70, right: 1_140, bottom: 770 });
    expect(nestedScrollerOrdinal(results, document, window)).toBe(0);
    expect(nestedScrollerOrdinal(secondResults, document, window)).toBe(1);

    const editorHost = document.createElement('x-editor');
    editorHost.setAttribute('role', 'unknown-role textbox');
    document.body.append(editorHost);
    const editorShadow = editorHost.attachShadow({ mode: 'open' });
    const shadowPane = document.createElement('main');
    shadowPane.setAttribute('style', 'overflow-y:auto');
    editorShadow.append(shadowPane);
    defineScrollBox(shadowPane, {
      clientWidth: 900, clientHeight: 720,
      scrollWidth: 900, scrollHeight: 5_000,
      scrollLeft: 0, scrollTop: 900,
    }, { left: 100, top: 40, right: 1_000, bottom: 760 });
    expect(readNestedScrollSnapshot(shadowPane, document, window))
      .toBeUndefined();
  });

  it('treats an independently scrolling body as nested when html owns document scroll', () => {
    const { document, window } = parseHTML(
      '<html><body style="overflow-y:auto"></body></html>',
    );
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 800 },
    });
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      value: document.documentElement,
    });
    defineScrollBox(document.body, {
      clientWidth: 1_150, clientHeight: 760,
      scrollWidth: 1_150, scrollHeight: 4_760,
      scrollLeft: 0, scrollTop: 900,
    }, { left: 25, top: 20, right: 1_175, bottom: 780 });

    expect(readNestedScrollSnapshot(document.body, document, window)).toEqual({
      scrollTarget: 'nested', scrollX: 0, scrollY: 900,
      maxScrollX: 0, maxScrollY: 4_000,
    });
    expect(isDocumentScrollTarget(
      document.body,
      document,
      window as unknown as Window,
    )).toBe(false);
    expect(isDocumentScrollTarget(
      document.documentElement,
      document,
      window as unknown as Window,
    )).toBe(true);
  });

  it('coalesces rapid nested scrolling, prefers a simultaneous document scroll, and retains the active target', () => {
    const { document, window } = parseHTML(
      '<html><body><main id="results" style="overflow-y:auto"></main></body></html>',
    );
    installLiveDomGlobals(document, window);
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 800 },
      scrollX: { configurable: true, value: 0 },
      scrollY: { configurable: true, writable: true, value: 0 },
    });
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true, value: document.documentElement,
    });
    defineScrollBox(document.documentElement, {
      clientWidth: 1_200, clientHeight: 800,
      scrollWidth: 1_200, scrollHeight: 2_000,
      scrollLeft: 0, scrollTop: 0,
    });
    const results = document.querySelector('#results')!;
    defineScrollBox(results, {
      clientWidth: 900, clientHeight: 720,
      scrollWidth: 900, scrollHeight: 5_000,
      scrollLeft: 0, scrollTop: 100,
    }, { left: 200, top: 50, right: 1_100, bottom: 770 });

    let mutationListener: MutationCallback | undefined;
    class TestMutationObserver {
      constructor(callback: MutationCallback) {
        mutationListener = callback;
      }
      observe(): void {}
      disconnect(): void {}
    }
    class TestResizeObserver { observe(): void {} disconnect(): void {} }
    vi.stubGlobal('MutationObserver', TestMutationObserver);
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    let scrollListener: ((event: Event) => void) | undefined;
    const addEventListener = window.addEventListener.bind(window);
    const observedWindow = Object.create(window) as Window;
    Object.defineProperty(observedWindow, 'addEventListener', {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: unknown,
      ) => {
        if (type === 'scroll' && typeof listener === 'function') {
          scrollListener = listener;
        }
        addEventListener(type, listener, options as AddEventListenerOptions);
      },
    });
    vi.stubGlobal('window', observedWindow);

    installLivePageObserver('session_1234', 1);
    frames.shift()?.(0);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'document', scrollX: 0, scrollY: 0,
    }));
    sendMessage.mockClear();

    scrollListener?.({ target: results } as unknown as Event);
    (results as Element & { scrollTop: number }).scrollTop = 760;
    scrollListener?.({ target: results } as unknown as Event);
    expect(frames).toHaveLength(1);
    frames.shift()?.(16);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'nested', nestedOwnerKey: 1, nestedOwnerOrdinal: 0,
      scrollY: 760, maxScrollY: 4_280,
    }));

    sendMessage.mockClear();
    (results as Element & { scrollTop: number }).scrollTop = 900;
    scrollListener?.({ target: results } as unknown as Event);
    (window as Window & { scrollY: number }).scrollY = 500;
    scrollListener?.({ target: document } as unknown as Event);
    frames.shift()?.(32);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'document', scrollY: 500,
    }));

    sendMessage.mockClear();
    (results as Element & { scrollTop: number }).scrollTop = 1_100;
    scrollListener?.({ target: results } as unknown as Event);
    frames.shift()?.(48);
    sendMessage.mockClear();
    const registry = (
      globalThis as typeof globalThis & {
        __simulLiveMirrorV1?: { announceScroll(): void };
      }
    ).__simulLiveMirrorV1!;
    (results as Element & { scrollTop: number }).scrollTop = 1_400;
    registry.announceScroll();
    frames.shift()?.(64);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'nested', nestedOwnerKey: 1, nestedOwnerOrdinal: 0,
      scrollY: 1_400,
    }));

    const insertedBefore = document.createElement('aside');
    insertedBefore.setAttribute('style', 'overflow-y:auto');
    document.body.insertBefore(insertedBefore, results);
    defineScrollBox(insertedBefore, {
      clientWidth: 900, clientHeight: 720,
      scrollWidth: 900, scrollHeight: 3_720,
      scrollLeft: 0, scrollTop: 200,
    }, { left: 200, top: 50, right: 1_100, bottom: 770 });
    mutationListener?.([{
      type: 'childList',
      target: document.body,
      addedNodes: [insertedBefore],
      removedNodes: [],
    } as unknown as MutationRecord], {} as MutationObserver);
    sendMessage.mockClear();
    registry.announceScroll();
    frames.shift()?.(68);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'nested', nestedOwnerKey: 1, nestedOwnerOrdinal: 1,
      scrollY: 1_400,
    }));
    insertedBefore.remove();
    mutationListener?.([{
      type: 'childList',
      target: document.body,
      addedNodes: [],
      removedNodes: [insertedBefore],
    } as unknown as MutationRecord], {} as MutationObserver);

    sendMessage.mockClear();
    (window as Window & { scrollY: number }).scrollY = 650;
    registry.announceScroll();
    frames.shift()?.(72);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'document', scrollY: 650,
    }));

    // Once ordinary document scrolling takes ownership, a later status
    // announcement must not resurrect the old nested target merely because it
    // still has a non-zero offset.
    sendMessage.mockClear();
    registry.announceScroll();
    frames.shift()?.(76);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'document', scrollY: 650,
    }));

    sendMessage.mockClear();
    results.setAttribute('style', 'overflow-y:hidden');
    registry.announceScroll();
    frames.shift()?.(80);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'document', scrollY: 650,
    }));

    const next = document.createElement('main');
    next.setAttribute('style', 'overflow-y:auto');
    document.body.append(next);
    defineScrollBox(next, {
      clientWidth: 940, clientHeight: 730,
      scrollWidth: 940, scrollHeight: 4_730,
      scrollLeft: 0, scrollTop: 1_600,
    }, { left: 180, top: 35, right: 1_120, bottom: 765 });
    sendMessage.mockClear();
    scrollListener?.({ target: next } as unknown as Event);
    frames.shift()?.(96);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'nested', nestedOwnerKey: 2, nestedOwnerOrdinal: 0,
      scrollY: 1_600, maxScrollY: 4_000,
      documentScrollY: 650, documentMaxScrollY: 1_200,
    }));

    const carousel = document.createElement('aside');
    document.body.append(carousel);
    defineScrollBox(carousel, {
      clientWidth: 940, clientHeight: 120,
      scrollWidth: 4_000, scrollHeight: 120,
      scrollLeft: 700, scrollTop: 0,
    }, { left: 180, top: 300, right: 1_120, bottom: 420 });
    sendMessage.mockClear();
    scrollListener?.({ target: carousel } as unknown as Event);
    expect(frames).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();

    Object.defineProperties(next, {
      scrollHeight: { configurable: true, value: 1_100 },
      scrollTop: { configurable: true, writable: true, value: 1_600 },
    });
    registry.announceScroll();
    frames.shift()?.(112);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'nested', scrollY: 370, maxScrollY: 370,
    }));

    next.remove();
    sendMessage.mockClear();
    registry.announceScroll();
    frames.shift()?.(120);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'document', scrollY: 650,
    }));

    document.body.append(next);
    Object.defineProperty(next, 'scrollHeight', {
      configurable: true, value: 780,
    });
    sendMessage.mockClear();
    registry.announceScroll();
    frames.shift()?.(128);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'document', scrollY: 650,
    }));
  });

  it('listens for primary scrolling inside an already-open shadow root', () => {
    const { document, window } = parseHTML(
      '<html><body><x-feed></x-feed></body></html>',
    );
    const host = document.querySelector('x-feed')!;
    const shadow = host.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { configurable: true, value: 'open' });
    const results = document.createElement('main');
    results.setAttribute('style', 'overflow-y:auto');
    shadow.append(results);
    installLiveDomGlobals(document, window);
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1_200 },
      innerHeight: { configurable: true, value: 800 },
      scrollX: { configurable: true, value: 0 },
      scrollY: { configurable: true, value: 0 },
    });
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true, value: document.documentElement,
    });
    defineScrollBox(document.documentElement, {
      clientWidth: 1_200, clientHeight: 800,
      scrollWidth: 1_200, scrollHeight: 800,
      scrollLeft: 0, scrollTop: 0,
    });
    defineScrollBox(results, {
      clientWidth: 950, clientHeight: 720,
      scrollWidth: 950, scrollHeight: 5_720,
      scrollLeft: 0, scrollTop: 1_250,
    }, { left: 180, top: 40, right: 1_130, bottom: 760 });

    class TestMutationObserver { observe(): void {} disconnect(): void {} }
    class TestResizeObserver { observe(): void {} disconnect(): void {} }
    vi.stubGlobal('MutationObserver', TestMutationObserver);
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    let shadowScrollListener: ((event: Event) => void) | undefined;
    const addShadowListener = shadow.addEventListener.bind(shadow);
    Object.defineProperty(shadow, 'addEventListener', {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: unknown,
      ) => {
        if (type === 'scroll' && typeof listener === 'function') {
          shadowScrollListener = listener;
        }
        addShadowListener(type, listener, options as AddEventListenerOptions);
      },
    });

    installLivePageObserver('session_1234', 1);
    frames.shift()?.(0);
    sendMessage.mockClear();
    expect(shadowScrollListener).toBeTypeOf('function');

    shadowScrollListener?.({ target: results } as unknown as Event);
    frames.shift()?.(16);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      scrollTarget: 'nested', scrollY: 1_250, maxScrollY: 5_000,
    }));
  });

  it('captures form-derived live content as private shells and refreshes language', () => {
    const { document, window } = parseHTML(`
      <html lang="ja"><body>
        <p>Public content</p>
        <output>calculated private value</output>
        <option>selected private value</option>
        <optgroup>group private value</optgroup>
        <datalist>suggested private value</datalist>
      </body></html>
    `);
    installLiveDomGlobals(document, window);
    installLiveRegistry(document.body);

    const delta = captureLivePageDelta('session_1234', 1, 1, ['n1']);
    const serialized = JSON.stringify(delta);

    expect(delta.documentLanguage).toBe('ja');
    expect(serialized).toContain('Public content');
    expect(serialized).not.toContain('private value');
    expect(serialized.match(/"controlShell":"input"/gu)?.length).toBeGreaterThanOrEqual(4);
  });

  it('captures and validates only typed native-select presentation data', () => {
    const { document, window } = parseHTML(`
      <html><body>
        <select name="private-name" multiple disabled>
          <optgroup label="Regions" disabled data-private="group-secret">
            <option selected value="private-tokyo">Tokyo</option>
            <option disabled value="private-osaka">Osaka</option>
          </optgroup>
          <option selected value="private-seoul">Seoul</option>
          <option selected value="private-rich">
            <span role="textbox">private editable option</span>
          </option>
        </select>
      </body></html>
    `);
    installLiveDomGlobals(document, window, (property) =>
      property === 'display'
        ? 'block'
        : property === 'background-image'
          ? 'url("https://private.example/option-texture.png")'
          : '',
    );
    installLiveRegistry(document.body);
    const select = document.querySelector('select')!;
    Object.defineProperty(select, 'matches', {
      configurable: true,
      value: (selector: string) => selector === ':open',
    });

    const captured = captureLivePageDelta('session_1234', 1, 1, ['n1']);
    const delta = parseLivePageDelta(captured);
    const serialized = JSON.stringify(delta);
    const selectNode = findLiveElement(delta.replacements[0]?.node, 'select');
    const optionNode = findLiveElement(delta.replacements[0]?.node, 'option');
    const optgroupNode = findLiveElement(delta.replacements[0]?.node, 'optgroup');

    expect(selectNode?.controlShell).toBe('select');
    expect(selectNode?.selectState).toEqual({
      disabled: true,
      multiple: true,
      open: true,
    });
    expect(selectNode?.children).toHaveLength(3);
    expect(serialized).toContain('Regions');
    expect(serialized).toContain('Tokyo');
    expect(serialized).toContain('Osaka');
    expect(serialized).toContain('Seoul');
    expect(serialized).toContain('"selected":true');
    expect(serialized).not.toContain('private-name');
    expect(serialized).not.toContain('private-tokyo');
    expect(serialized).not.toContain('private-osaka');
    expect(serialized).not.toContain('private-seoul');
    expect(serialized).not.toContain('group-secret');
    expect(serialized).not.toContain('private editable option');
    expect(optionNode?.style).not.toHaveProperty('background-image');
    expect(optgroupNode?.style).not.toHaveProperty('background-image');
    expect(
      selectNode?.children.every((child) =>
        child.kind === 'element' && child.attributes === undefined,
      ),
    ).toBe(true);
  });

  it('masks native-select labels for explicit private roles and activation ancestors', () => {
    const { document, window } = parseHTML(`
      <html><body>
        <select role="combobox"><option>private role option</option></select>
        <div role="button">
          <select><option>private nested option</option></select>
        </div>
      </body></html>
    `);
    installLiveDomGlobals(document, window);
    installLiveRegistry(document.body);

    const delta = parseLivePageDelta(
      captureLivePageDelta('session_1234', 1, 1, ['n1']),
    );
    const serialized = JSON.stringify(delta);

    expect(serialized).not.toContain('private role option');
    expect(serialized).not.toContain('private nested option');
    expect(findLiveElement(delta.replacements[0]?.node, 'select')).toBeUndefined();
    expect(serialized.match(/"controlShell":"input"/gu)).toHaveLength(2);
  });

  it('omits positioned-offscreen native backing selects from live deltas', () => {
    const { document, window } = parseHTML(`
      <html><body><select><option>offscreen backing secret</option></select></body></html>
    `);
    installLiveDomGlobals(document, window, (property) => ({
      display: 'block',
      position: 'absolute',
      left: '-10000px',
      top: '0px',
      width: '100px',
      height: '24px',
    })[property] ?? '');
    installLiveRegistry(document.body);

    const delta = captureLivePageDelta('session_1234', 1, 1, ['n1']);
    const serialized = JSON.stringify(delta);

    expect(serialized).not.toContain('offscreen backing secret');
    expect(findLiveElement(delta.replacements[0]?.node, 'select')).toBeUndefined();
  });

  it('allows public ARIA menus in live deltas while masking editable controls', () => {
    const { document, window } = parseHTML(`
      <html><body>
        <section role="listbox"
          style="background-image:url('https://leak.invalid/menu-background.png')">
          <div role="option">Public Tokyo choice</div>
          <div role="option" contenteditable="false">
            <img src="https://leak.invalid/menu-icon.png" alt="menu icon">
            Public Osaka choice
          </div>
          <input role="combobox" value="private native combo value">
        </section>
        <nav role="menu"><div role="menuitem">Public account menu</div></nav>
        <div role="option textbox">Public ordered fallback option</div>
        <div role="textbox option">private ordered fallback textbox</div>
        <div role="combobox">private editable combo label</div>
        <div role="searchbox">private search value</div>
        <div role="textbox">private textbox value</div>
        <div contenteditable="true">private contenteditable value</div>
      </body></html>
    `);
    installLiveDomGlobals(document, window);
    installLiveRegistry(document.body);

    const delta = captureLivePageDelta('session_1234', 1, 1, ['n1']);
    const serialized = JSON.stringify(delta);

    expect(serialized).toContain('Public Tokyo choice');
    expect(serialized).toContain('Public Osaka choice');
    expect(serialized).toContain('Public account menu');
    expect(serialized).toContain('Public ordered fallback option');
    expect(serialized).not.toContain('leak.invalid');
    expect(serialized).not.toContain('private ordered fallback textbox');
    expect(serialized).not.toContain('private native combo value');
    expect(serialized).not.toContain('private editable combo label');
    expect(serialized).not.toContain('private search value');
    expect(serialized).not.toContain('private textbox value');
    expect(serialized).not.toContain('private contenteditable value');
  });

  it('rejects malformed live-select trees and strips all select attributes', () => {
    const base = {
      version: 1,
      generation: 1,
      sequence: 1,
      url: 'https://example.com/',
      documentWidth: 800,
      documentHeight: 600,
      desynchronized: false,
    };
    const valid = parseLivePageDelta({
      ...base,
      replacements: [{
        targetId: 'n1',
        node: {
          kind: 'element',
          nodeId: 'n1',
          tag: 'select',
          style: {},
          controlShell: 'select',
          selectState: { disabled: false, multiple: false, open: false },
          attributes: { name: 'private-name', value: 'private-value' },
          children: [{
            kind: 'element',
            nodeId: 'n2',
            tag: 'option',
            style: {},
            optionState: { disabled: false, selected: true },
            attributes: { value: 'private-option', onclick: 'attack()' },
            children: [{ kind: 'text', nodeId: 'n2', text: 'Public option' }],
          }],
        },
      }],
    });
    expect(JSON.stringify(valid)).toContain('Public option');
    expect(JSON.stringify(valid)).not.toContain('private-name');
    expect(JSON.stringify(valid)).not.toContain('private-option');

    expect(() => parseLivePageDelta({
      ...base,
      replacements: [{
        targetId: 'n1',
        node: {
          kind: 'element',
          nodeId: 'n1',
          tag: 'select',
          style: {},
          controlShell: 'select',
          selectState: { disabled: false, multiple: false, open: false },
          children: [{
            kind: 'element',
            nodeId: 'n2',
            tag: 'div',
            style: {},
            children: [{ kind: 'text', nodeId: 'n3', text: 'not an option' }],
          }],
        },
      }],
    })).toThrow(/invalid live mirror update/iu);

    for (const child of [
      {
        kind: 'placeholder',
        nodeId: 'n2',
        style: {},
        label: 'Canvas content omitted',
      },
      {
        kind: 'element',
        nodeId: 'n2',
        tag: 'optgroup',
        style: {},
        optgroupState: { disabled: false },
        children: [{
          kind: 'placeholder',
          nodeId: 'n3',
          style: {},
          label: 'Canvas content omitted',
        }],
      },
    ]) {
      expect(() => parseLivePageDelta({
        ...base,
        replacements: [{
          targetId: 'n1',
          node: {
            kind: 'element',
            nodeId: 'n1',
            tag: 'select',
            style: {},
            controlShell: 'select',
            selectState: { disabled: false, multiple: false, open: false },
            children: [child],
          },
        }],
      })).toThrow(/invalid live mirror update/iu);
    }
  });

  it('renders and translates a live select replacement through the disclosure facsimile', async () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('HTMLImageElement', window.HTMLImageElement);
    const snapshot = parsePageSnapshot({
      version: 1,
      title: 'Select update',
      url: 'https://example.com/',
      capturedAt: '2026-07-21T00:00:00.000Z',
      items: [],
      omissions: {},
      visual: {
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 900,
        styles: [{ display: 'block' }],
        root: {
          kind: 'element',
          nodeId: 'n1',
          tag: 'main',
          styleId: 0,
          children: [{
            kind: 'element',
            nodeId: 'n2',
            tag: 'select',
            styleId: 0,
            controlShell: 'select',
            selectState: { disabled: false, multiple: false, open: false },
            children: [{
              kind: 'element',
              nodeId: 'n3',
              tag: 'option',
              styleId: 0,
              optionState: { disabled: false, selected: true },
              children: [{ kind: 'text', nodeId: 'n3', text: 'Old choice' }],
            }],
          }],
        },
      },
    });
    const mirror = createVisualMirror(snapshot, undefined, document);
    if (!mirror) throw new Error('Expected mirror');
    document.body.append(mirror);
    const delta = parseLivePageDelta({
      version: 1,
      generation: 1,
      sequence: 1,
      url: 'https://example.com/',
      documentWidth: 800,
      documentHeight: 900,
      desynchronized: false,
      replacements: [{
        targetId: 'n2',
        node: {
          kind: 'element',
          nodeId: 'n2',
          tag: 'select',
          style: { display: 'inline-block', 'background-color': 'rgb(1, 2, 3)' },
          controlShell: 'select',
          selectState: { disabled: false, multiple: true, open: true },
          children: [{
            kind: 'element',
            nodeId: 'n4',
            tag: 'optgroup',
            style: {},
            optgroupState: { disabled: false },
            children: [
              { kind: 'text', nodeId: 'n4', text: 'Regions' },
              {
                kind: 'element',
                nodeId: 'n5',
                tag: 'option',
                style: {},
                optionState: { disabled: false, selected: true },
                children: [{ kind: 'text', nodeId: 'n5', text: 'Tokyo' }],
              },
              {
                kind: 'element',
                nodeId: 'n6',
                tag: 'option',
                style: {},
                optionState: { disabled: true, selected: false },
                children: [{ kind: 'text', nodeId: 'n6', text: 'Osaka' }],
              },
            ],
          }],
        },
      }],
    });
    const translated: string[] = [];

    const result = await applyLivePageDelta(mirror, delta, {
      textLayoutMode: 'adaptive',
      translate: async (source) => {
        translated.push(source);
        return `[${source}]`;
      },
    });

    const disclosure = result.root.querySelector<HTMLElement>(
      '[data-simul-node-id="n2"]',
    );
    const list = disclosure?.querySelector<HTMLElement>(
      '[data-simul-select-options]',
    );
    const options = [
      ...(disclosure?.querySelectorAll<HTMLElement>('[data-simul-select-option]') ?? []),
    ];
    expect(disclosure?.tagName).toBe('DETAILS');
    expect(disclosure?.hasAttribute('open')).toBe(true);
    expect(disclosure?.dataset.simulSelectMultiple).toBe('true');
    expect(list?.style.overflowY).toBe('auto');
    expect(options.map((option) => option.textContent)).toEqual([
      '[Tokyo]',
      '[Osaka]',
    ]);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('aria-disabled')).toBe('true');
    expect(translated).toEqual(['Regions', 'Tokyo', 'Osaka']);
    expect(disclosure?.querySelector('summary')?.textContent).toBe('[Tokyo]');
    expect(result.root.querySelector('select')).toBeNull();
    expect(result.root.querySelector('script')).toBeNull();
  });

  it('bounds aggregate styles, attributes, and image URLs while capturing', () => {
    const { document, window } = parseHTML(
      `<html><body>${'<div></div>'.repeat(2_100)}</body></html>`,
    );
    installLiveDomGlobals(document, window, (property) =>
      property === 'font-family'
        ? 'x'.repeat(500)
        : property === 'display'
          ? 'block'
          : '',
    );
    installLiveRegistry(document.body);

    const delta = captureLivePageDelta('session_1234', 1, 1, ['n1']);

    expect(delta.desynchronized).toBe(true);
    expect(countLiveStyleCharacters(delta.replacements[0]?.node ?? null)).toBeLessThanOrEqual(
      1_000_000,
    );

    const attributePage = parseHTML(
      `<html><body>${`<path d="${'x'.repeat(2_048)}"></path>`.repeat(160)}</body></html>`,
    );
    installLiveDomGlobals(attributePage.document, attributePage.window);
    installLiveRegistry(attributePage.document.body);
    const attributeDelta = captureLivePageDelta(
      'session_1234',
      1,
      1,
      ['n1'],
    );
    expect(attributeDelta.desynchronized).toBe(true);
    expect(
      countLiveAttributeCharacters(attributeDelta.replacements[0]?.node ?? null),
    ).toBeLessThanOrEqual(300_000);

    const largeImage = `data:image/png;base64,${'a'.repeat(79_000)}`;
    const imagePage = parseHTML(
      `<html><body>${`<img src="${largeImage}">`.repeat(3)}</body></html>`,
    );
    installLiveDomGlobals(imagePage.document, imagePage.window);
    installLiveRegistry(imagePage.document.body);
    const imageDelta = captureLivePageDelta('session_1234', 1, 1, ['n1']);
    expect(imageDelta.desynchronized).toBe(true);
    expect(
      countLiveImageUrlCharacters(imageDelta.replacements[0]?.node ?? null),
    ).toBeLessThanOrEqual(200_000);
  });

  it('rejects aggregate live style, attribute, and image URL payloads', () => {
    const base = {
      version: 1,
      generation: 1,
      sequence: 1,
      url: 'https://example.com/',
      documentWidth: 800,
      documentHeight: 600,
      desynchronized: false,
    };
    const replacement = (children: unknown[]) => [{
      targetId: 'n1',
      node: {
        kind: 'element',
        nodeId: 'n1',
        tag: 'div',
        style: {},
        children,
      },
    }];

    expect(() =>
      parseLivePageDelta({
        ...base,
        replacements: replacement(
          Array.from({ length: 2_100 }, (_, index) => ({
            kind: 'element',
            nodeId: `n${index + 2}`,
            tag: 'div',
            style: { 'font-family': 'x'.repeat(500) },
            children: [],
          })),
        ),
      }),
    ).toThrow(/style payload/iu);

    expect(() =>
      parseLivePageDelta({
        ...base,
        replacements: replacement(
          Array.from({ length: 160 }, (_, index) => ({
            kind: 'element',
            nodeId: `n${index + 2}`,
            tag: 'path',
            style: {},
            attributes: { d: 'x'.repeat(2_048) },
            children: [],
          })),
        ),
      }),
    ).toThrow(/attribute payload/iu);

    const largeImage = `data:image/png;base64,${'a'.repeat(79_000)}`;
    expect(() =>
      parseLivePageDelta({
        ...base,
        replacements: replacement(
          Array.from({ length: 3 }, (_, index) => ({
            kind: 'element',
            nodeId: `n${index + 2}`,
            tag: 'img',
            style: {},
            attributes: { src: largeImage },
            children: [],
          })),
        ),
      }),
    ).toThrow(/image payload/iu);
  });

  it('replaces one existing subtree and translates only its new text', async () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('HTMLImageElement', window.HTMLImageElement);
    const snapshot = parsePageSnapshot({
      version: 1,
      title: 'Live',
      url: 'https://example.com/',
      capturedAt: '2026-07-19T00:00:00.000Z',
      items: [{ id: 'raw', kind: 'text', role: 'paragraph', text: 'Old text' }],
      omissions: {},
      visual: {
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 900,
        styles: [{ display: 'block' }],
        root: {
          kind: 'element',
          nodeId: 'n1',
          tag: 'div',
          styleId: 0,
          children: [
            {
              kind: 'element',
              nodeId: 'n2',
              tag: 'p',
              styleId: 0,
              children: [{ kind: 'text', nodeId: 'n3', text: 'Old text', itemId: 'raw' }],
            },
          ],
        },
      },
    });
    const mirror = createVisualMirror(snapshot, undefined, document);
    if (!mirror) throw new Error('Expected mirror');
    document.body.append(mirror);
    const delta = parseLivePageDelta({
      version: 1,
      generation: 1,
      sequence: 1,
      url: 'https://example.com/',
      documentWidth: 800,
      documentHeight: 950,
      desynchronized: false,
      replacements: [
        {
          targetId: 'n2',
          node: {
            kind: 'element',
            nodeId: 'n2',
            tag: 'p',
            style: { display: 'block' },
            children: [{ kind: 'text', nodeId: 'n4', text: 'New text' }],
          },
        },
      ],
    });
    const translated: string[] = [];
    const result = await applyLivePageDelta(mirror, delta, {
      textLayoutMode: 'adaptive',
      translate: async (source) => {
        translated.push(source);
        return '新しいテキスト';
      },
    });
    expect(result.missingTarget).toBe(false);
    expect(result.applied).toBe(1);
    expect(translated).toEqual(['New text']);
    expect(result.root.textContent).toBe('新しいテキスト');

    await translateVisualMirror(result.root, async (source) => `[${source}]`);
    expect(result.root.textContent).toBe('[New text]');

    const imageDelta = parseLivePageDelta({
      version: 1,
      generation: 1,
      sequence: 2,
      url: 'https://example.com/',
      documentWidth: 800,
      documentHeight: 950,
      desynchronized: false,
      replacements: [
        {
          targetId: 'n2',
          node: {
            kind: 'element',
            nodeId: 'n2',
            tag: 'p',
            style: { display: 'block' },
            children: [
              {
                kind: 'element',
                nodeId: 'n5',
                tag: 'img',
                style: { display: 'block' },
                attributes: { alt: 'New diagram' },
                children: [],
              },
            ],
          },
        },
      ],
    });
    const imageResult = await applyLivePageDelta(result.root, imageDelta, {
      textLayoutMode: 'faithful',
      translate: async (source) => (source === 'New diagram' ? '新しい図' : source),
    });
    expect(imageResult.translation).toEqual({
      completed: 1,
      failed: 0,
      total: 1,
    });
    expect(imageResult.root.querySelector('img')?.getAttribute('alt')).toBe(
      '新しい図',
    );

    const failedImageResult = await applyLivePageDelta(
      imageResult.root,
      imageDelta,
      {
        textLayoutMode: 'faithful',
        translate: async () => {
          throw new Error('Temporary local model failure');
        },
      },
    );
    expect(failedImageResult.translation).toEqual({
      completed: 1,
      failed: 1,
      total: 1,
    });
    expect(
      failedImageResult.root.querySelector('img')?.getAttribute('alt'),
    ).toBe('New diagram');
  });
});

function installLiveDomGlobals(
  document: Document,
  window: Window,
  styleValue: (property: string) => string = (property) =>
    property === 'display' ? 'block' : '',
): void {
  Object.defineProperty(document, 'baseURI', {
    configurable: true,
    value: 'https://example.com/page',
  });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL('https://example.com/page?private=yes'),
  });
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: () => ({
      display: styleValue('display') || 'block',
      visibility: 'visible',
      opacity: '1',
      getPropertyValue: styleValue,
    }),
  });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  for (const constructorName of [
    'Node',
    'Element',
    'ShadowRoot',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLButtonElement',
    'HTMLImageElement',
    'HTMLIFrameElement',
    'HTMLCanvasElement',
    'HTMLVideoElement',
    'HTMLAudioElement',
  ] as const) {
    vi.stubGlobal(
      constructorName,
      (window as unknown as Record<string, unknown>)[constructorName],
    );
  }
}

function installLiveRegistry(root: Node): void {
  const nodeIds = new WeakMap<Node, string>();
  const nodes = new Map<string, Node>();
  let nextId = 1;
  const idFor = (node: Node): string => {
    const known = nodeIds.get(node);
    if (known) return known;
    const nodeId = `n${nextId}`;
    nextId += 1;
    nodeIds.set(node, nodeId);
    nodes.set(nodeId, node);
    return nodeId;
  };
  idFor(root);
  (
    globalThis as typeof globalThis & { __simulLiveMirrorV1?: unknown }
  ).__simulLiveMirrorV1 = {
    sessions: new Map([['session_1234', 1]]),
    nodes,
    nodeIds,
    idFor,
    disconnect: vi.fn(),
  };
}

function defineScrollBox(
  element: Element,
  dimensions: Readonly<{
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    scrollLeft: number;
    scrollTop: number;
  }>,
  rect: Readonly<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  }> = {
    left: 0,
    top: 0,
    right: dimensions.clientWidth,
    bottom: dimensions.clientHeight,
  },
): void {
  for (const [name, value] of Object.entries(dimensions)) {
    Object.defineProperty(element, name, {
      configurable: true,
      writable: name === 'scrollLeft' || name === 'scrollTop',
      value,
    });
  }
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => ({}),
    }),
  });
}

function countLiveStyleCharacters(
  node: ReturnType<typeof parseLivePageDelta>['replacements'][number]['node'],
): number {
  if (!node) return 0;
  if (node.kind === 'text') return 0;
  const own = Object.entries(node.style).reduce(
    (total, [property, value]) => total + property.length + (value?.length ?? 0),
    0,
  );
  return node.kind === 'element'
    ? own + node.children.reduce(
        (total, child) => total + countLiveStyleCharacters(child),
        0,
      )
    : own;
}

function countLiveAttributeCharacters(
  node: ReturnType<typeof parseLivePageDelta>['replacements'][number]['node'],
): number {
  if (!node || node.kind !== 'element') return 0;
  const own = Object.entries(node.attributes ?? {}).reduce(
    (total, [name, value]) => total + name.length + value.length,
    0,
  );
  return own + node.children.reduce(
    (total, child) => total + countLiveAttributeCharacters(child),
    0,
  );
}

function countLiveImageUrlCharacters(
  node: ReturnType<typeof parseLivePageDelta>['replacements'][number]['node'],
): number {
  if (!node || node.kind !== 'element') return 0;
  const own = node.tag === 'img' ? node.attributes?.src?.length ?? 0 : 0;
  return own + node.children.reduce(
    (total, child) => total + countLiveImageUrlCharacters(child),
    0,
  );
}

function findLiveElement(
  node: LiveVisualNode | null | undefined,
  tag: string,
): LiveVisualElementNode | undefined {
  if (!node || node.kind !== 'element') return undefined;
  if (node.tag === tag) return node;
  for (const child of node.children) {
    const match = findLiveElement(child, tag);
    if (match) return match;
  }
  return undefined;
}
