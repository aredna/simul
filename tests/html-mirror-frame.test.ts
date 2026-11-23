import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HTML_MIRROR_FRAME_TOKEN_KEY,
  MAX_HTML_MIRROR_FRAMES,
  createHtmlMirrorFramePortName,
  htmlMirrorFrameBoxCss,
  htmlMirrorFrameInsetNode,
  isHtmlMirrorFramesWanted,
  probeHtmlMirrorChildFrame,
  readHtmlMirrorFrameContent,
  readHtmlMirrorFrameControllerMessage,
  readHtmlMirrorFramePortSessionId,
  readHtmlMirrorFrameStart,
  type HtmlMirrorFrameGraph,
} from '../lib/replica/html-mirror-frame';
import {
  HtmlMirrorFrameSourceSession,
  listenForHtmlMirrorFrameToken,
  type HtmlMirrorFrameTokenListener,
} from '../lib/replica/html-mirror-frame-source';
import { HtmlMirrorFrameRelay } from '../lib/replica/html-mirror-frame-relay';
import {
  installHtmlMirrorFrameInsetReader,
  readHtmlMirrorNode,
  sanitizeSourceDocument,
  type HtmlMirrorElementNode,
  type HtmlMirrorNode,
} from '../lib/replica/html-mirror-sanitizer';
import { WeakNodeIdRegistry } from '../lib/replica/html-mirror-source';
import { sourceSecretPlaceholderTagName } from '../lib/replica/source-secret-classifier';
import { DEFAULT_HTML_MIRROR_LIMIT_SETTINGS } from '../lib/replica/html-mirror-limits';

const TOKEN = '6f1c2d3e-4b5a-4c6d-8e7f-001122334455';

beforeEach(() => {
  // The readers test nodes against the DOM's own classes.
  const { window } = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, { Node: window.Node, Element: window.Element, Text: window.Text });
});
const BOX = Object.freeze({ width: 388, height: 44, block: true, margin: [12, 0, 0, 0] as const });

describe('a frame of another site in the mirror (D246)', () => {
  it('gives every node of a frame an ID of its own in the page, its placeholders and slots too', () => {
    const graph = sampleGraph('Sign in with Google');
    const inset = htmlMirrorFrameInsetNode(42, BOX, graph);
    expect(inset).toMatchObject({ id: 42, tagName: 'div', attributes: [], children: [] });
    const ids = allIds(inset).filter((id) => id !== 42);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id >= 2 ** 50)).toBe(true);
    const html = inset.shadowRoot!.children[0] as HtmlMirrorElementNode;
    const placeholder = findNode(html, (node) =>
      node.kind === 'element' && node.opaquePlaceholder === true) as HtmlMirrorElementNode;
    expect(placeholder.tagName).toBe(sourceSecretPlaceholderTagName(placeholder.id));
    const slot = findNode(html, (node) =>
      node.kind === 'element' && node.tagName === 'slot') as HtmlMirrorElementNode;
    const slotted = findNode(html, (node) =>
      node.kind === 'text' && node.text === 'slotted');
    expect(slot.assignedNodeIds).toEqual([slotted!.id]);
    // The panel takes it as it is.
    expect(readHtmlMirrorNode(inset)).toBeDefined();
    // A second copy gets new IDs: the mirror replaces the whole box.
    const again = htmlMirrorFrameInsetNode(42, BOX, graph);
    const againIds = new Set(allIds(again).filter((id) => id !== 42));
    expect(ids.some((id) => againIds.has(id))).toBe(false);
  });

  it('makes the box what the frame is in the tab, and nothing of the page\'s style', () => {
    const css = htmlMirrorFrameBoxCss(BOX);
    expect(css).toContain('all:initial!important');
    expect(css).toContain('width:388px!important');
    expect(css).toContain('height:44px!important');
    expect(css).toContain('margin:12px 0px 0px 0px!important');
    expect(css).toContain('contain:layout paint!important');
    // Not cut to its container: Google's button frame is wider (D247).
    expect(css).not.toContain('max-width');
    expect(htmlMirrorFrameBoxCss({ ...BOX, block: false })).toContain('display:inline-block');
  });

  it('reads only its own messages', () => {
    const name = createHtmlMirrorFramePortName('session-1');
    expect(readHtmlMirrorFramePortSessionId(name)).toBe('session-1');
    expect(readHtmlMirrorFramePortSessionId('simul:html-mirror-v2:session-1')).toBeUndefined();
    expect(readHtmlMirrorFrameStart({
      kind: 'simul:html-mirror-frame-v1:start', fidelityPolicy: 'conservative',
    })).toBeDefined();
    expect(readHtmlMirrorFrameStart({
      kind: 'simul:html-mirror-frame-v1:start', fidelityPolicy: 'anything',
    })).toBeUndefined();
    expect(readHtmlMirrorFrameContent({
      kind: 'simul:html-mirror-frame-v1:content', token: TOKEN, graph: null,
    })).toBeDefined();
    expect(readHtmlMirrorFrameContent({
      kind: 'simul:html-mirror-frame-v1:content', token: 'not a token', graph: null,
    })).toBeUndefined();
    expect(isHtmlMirrorFramesWanted({ protocolVersion: 2, kind: 'simul:html-mirror-v2:frames' })).toBe(true);
    const ready = { protocolVersion: 2, kind: 'simul:html-mirror-v2:frames-ready', sessionId: 's' };
    expect(readHtmlMirrorFrameControllerMessage(ready, 's')).toBeDefined();
    expect(readHtmlMirrorFrameControllerMessage(ready, 'other')).toBeUndefined();
    expect(readHtmlMirrorFrameControllerMessage({
      protocolVersion: 2, kind: 'simul:html-mirror-v2:frame-content', sessionId: 's', token: TOKEN, graph: 'x',
    }, 's')).toBeUndefined();
  });

  it('finds the page\'s own frames and no other', () => {
    const top = {} as Window;
    const own = { top, parent: top } as unknown as Window;
    const nested = { top, parent: own } as unknown as Window;
    const run = (self: Window) => {
      vi.stubGlobal('window', self);
      try {
        return probeHtmlMirrorChildFrame();
      } finally {
        vi.unstubAllGlobals();
      }
    };
    expect(run(own)).toBe(true);
    expect(run(nested)).toBe(false);
  });
});

describe('the frame inset in the page\'s read (D246)', () => {
  it('draws a frame its reader read in its box, and leaves a frame without one blank', () => {
    const { document, window } = frameFixture();
    const reader = vi.fn((frame: Element) =>
      frame.id === 'gsi' ? sampleGraph('Sign in with Google') : undefined);
    installHtmlMirrorFrameInsetReader(document, reader);
    try {
      const graph = sanitizeSourceDocument(document, window, new WeakNodeIdRegistry())!;
      const text = JSON.stringify(graph.root);
      expect(text).toContain('Sign in with Google');
      expect(text).not.toContain('accounts.google.com');
      const gsi = findNode(graph.root, (node) =>
        node.kind === 'element' && node.shadowRoot !== undefined) as HtmlMirrorElementNode;
      expect(gsi.tagName).toBe('div');
      expect(gsi.shadowRoot!.adoptedStyleSheets[0]).toContain('width:388px');
      const other = findNode(graph.root, (node) =>
        node.kind === 'element' && node.leftOutTagName === 'iframe') as HtmlMirrorElementNode;
      expect(other.opaquePlaceholder).toBe(true);
      expect(reader).toHaveBeenCalledTimes(2);
    } finally {
      installHtmlMirrorFrameInsetReader(document, undefined, reader);
    }
  });

  it('keeps a frame blank whose reading is too large or that sits where text is withheld', () => {
    const { document, window } = frameFixture('<div hidden><iframe id="hidden-frame"></iframe></div>');
    const large = sampleGraph('x'.repeat(10));
    const many = {
      ...large,
      root: {
        ...large.root,
        children: [...large.root.children, ...Array.from({ length: 4_100 }, (_, index) => ({
          kind: 'text' as const, id: 1_000 + index, text: 't', translatable: false,
        }))],
      },
    } as HtmlMirrorFrameGraph;
    const reader = vi.fn((frame: Element) => (
      frame.id === 'gsi' ? many : frame.id === 'hidden-frame' ? sampleGraph('hidden') : undefined));
    installHtmlMirrorFrameInsetReader(document, reader);
    try {
      const graph = sanitizeSourceDocument(document, window, new WeakNodeIdRegistry())!;
      expect(JSON.stringify(graph.root)).not.toContain('"shadowRoot"');
      expect(reader.mock.calls.map(([frame]) => frame.id)).not.toContain('hidden-frame');
    } finally {
      installHtmlMirrorFrameInsetReader(document, undefined, reader);
    }
  });
});

describe('the reader in a frame (D246)', () => {
  it('takes the token only from the top page, its parent', () => {
    const top = new FakeWindow();
    const frame = new FakeWindow(top, top);
    const tokens = listenForHtmlMirrorFrameToken(frame as unknown as Window)!;
    const heard = vi.fn();
    tokens.listen(heard);
    frame.emit({ source: {}, data: { [HTML_MIRROR_FRAME_TOKEN_KEY]: TOKEN } });
    frame.emit({ source: top, data: { [HTML_MIRROR_FRAME_TOKEN_KEY]: TOKEN, more: 1 } });
    frame.emit({ source: top, data: { [HTML_MIRROR_FRAME_TOKEN_KEY]: 'short' } });
    expect(tokens.token()).toBeUndefined();
    frame.emit({ source: top, data: { [HTML_MIRROR_FRAME_TOKEN_KEY]: TOKEN } });
    expect(tokens.token()).toBe(TOKEN);
    expect(heard).toHaveBeenCalledTimes(1);
    // Not in the top page, nor in a frame inside a frame.
    expect(listenForHtmlMirrorFrameToken(top as unknown as Window)).toBeUndefined();
    expect(listenForHtmlMirrorFrameToken(new FakeWindow(top, frame) as unknown as Window)).toBeUndefined();
  });

  it('reads its document once it has the token, and again only what changed', () => {
    const { document, window } = parseHTML(
      '<!doctype html><html><head></head><body><div id="b">Sign in with Google</div><script>x()</script></body></html>',
    );
    const port = new FakePort(createHtmlMirrorFramePortName('session-1'));
    let token: string | undefined;
    const listeners = new Set<() => void>();
    const tokens: HtmlMirrorFrameTokenListener = {
      token: () => token,
      listen: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    };
    const timers: Array<() => void> = [];
    let mutated!: MutationCallback;
    const session = new HtmlMirrorFrameSourceSession({
      port: port as unknown as Browser.runtime.Port,
      document,
      window: window as unknown as Window,
      registry: new WeakNodeIdRegistry(),
      tokens,
      now: () => 0,
      createMutationObserver: (callback) => {
        mutated = callback;
        return { observe: vi.fn(), disconnect: vi.fn() };
      },
      setTimer: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimer: (handle) => {
        const index = timers.indexOf(handle as () => void);
        if (index >= 0) timers.splice(index, 1);
      },
    });
    port.emitMessage({
      kind: 'simul:html-mirror-frame-v1:start',
      fidelityPolicy: 'conservative',
      limits: DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
    });
    expect(port.posts).toHaveLength(0);
    token = TOKEN;
    for (const listener of listeners) listener();
    expect(port.posts).toHaveLength(1);
    const first = readHtmlMirrorFrameContent(port.posts[0])!;
    expect(first.token).toBe(TOKEN);
    expect(first.graph!.root.tagName).toBe('html');
    expect(JSON.stringify(first.graph)).toContain('Sign in with Google');
    expect(JSON.stringify(first.graph)).not.toContain('x()');

    // A change with nothing new sends nothing; a new text is sent.
    // The read's timer and the poll the first read set; each read sets the
    // poll again, so these two only.
    mutated([], {} as MutationObserver);
    expect(timers).toHaveLength(2);
    timers.splice(0).forEach((timer) => timer());
    expect(port.posts).toHaveLength(1);
    timers.splice(0);
    document.querySelector('#b')!.textContent = 'Continue as Joe';
    mutated([], {} as MutationObserver);
    timers.shift()!();
    expect(port.posts).toHaveLength(2);
    expect(JSON.stringify(port.posts[1])).toContain('Continue as Joe');

    session.dispose();
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('closes on a message that is not its start', () => {
    const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
    const port = new FakePort(createHtmlMirrorFramePortName('session-1'));
    new HtmlMirrorFrameSourceSession({
      port: port as unknown as Browser.runtime.Port,
      document,
      window: window as unknown as Window,
      registry: new WeakNodeIdRegistry(),
      tokens: { token: () => TOKEN, listen: () => () => undefined },
      now: () => 0,
      createMutationObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
      setTimer: () => undefined,
      clearTimer: () => undefined,
    });
    port.emitMessage({ kind: 'simul:html-mirror-frame-v1:content' });
    expect(port.disconnect).toHaveBeenCalled();
    expect(port.posts).toHaveLength(0);
  });
});

describe('the panel\'s relay of frames (D246)', () => {
  it('runs the reader in the page\'s own frames, hands their readings on, and blanks a frame that went', async () => {
    const posted: unknown[] = [];
    const ports: FakePort[] = [];
    const injected: string[] = [];
    const timers: Array<() => void> = [];
    const relay = new HtmlMirrorFrameRelay({
      tabId: 7,
      sessionId: 'session-1',
      fidelityPolicy: 'conservative',
      limits: DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
      showEverything: false,
      post: (message) => posted.push(message),
      listFrames: async () => [
        { frameId: 0, documentId: 'top', result: false },
        { frameId: 3, documentId: 'gsi', result: true },
        { frameId: 4, documentId: 'nested', result: false },
      ],
      injectReader: async (_tabId, documentId) => {
        injected.push(documentId);
      },
      connect: (_tabId, _frameId, _documentId, name) => {
        const port = new FakePort(name);
        ports.push(port);
        return port as unknown as Browser.runtime.Port;
      },
      setTimer: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimer: () => undefined,
    });
    relay.look();
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(injected).toEqual(['gsi']);
    expect(ports).toHaveLength(1);
    expect(ports[0]!.posts[0]).toMatchObject({
      kind: 'simul:html-mirror-frame-v1:start', fidelityPolicy: 'conservative', showEverything: false,
    });
    expect(posted[0]).toEqual({
      protocolVersion: 2, kind: 'simul:html-mirror-v2:frames-ready', sessionId: 'session-1',
    });

    const graph = sampleGraph('Sign in with Google');
    ports[0]!.emitMessage({ kind: 'simul:html-mirror-frame-v1:content', token: TOKEN, graph });
    expect(posted[1]).toEqual({
      protocolVersion: 2,
      kind: 'simul:html-mirror-v2:frame-content',
      sessionId: 'session-1',
      token: TOKEN,
      graph,
    });

    // A second look runs nothing again in a frame that has its reader.
    relay.look();
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(injected).toEqual(['gsi']);

    ports[0]!.onDisconnect.emit();
    expect(posted[3]).toMatchObject({ kind: 'simul:html-mirror-v2:frame-content', token: TOKEN, graph: null });
    expect(timers).toHaveLength(1);

    relay.dispose();
    timers.shift()!();
    await Promise.resolve();
    expect(injected).toEqual(['gsi']);
  });

  it('reads at most a dozen frames of a page', async () => {
    const ports: FakePort[] = [];
    const relay = new HtmlMirrorFrameRelay({
      tabId: 7,
      sessionId: 'session-1',
      fidelityPolicy: 'conservative',
      limits: DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
      showEverything: false,
      post: () => undefined,
      listFrames: async () => Array.from({ length: 20 }, (_, index) => ({
        frameId: index + 1, documentId: `frame-${index}`, result: true,
      })),
      injectReader: async () => undefined,
      connect: (_tabId, _frameId, _documentId, name) => {
        const port = new FakePort(name);
        ports.push(port);
        return port as unknown as Browser.runtime.Port;
      },
    });
    relay.look();
    await vi.waitFor(() => expect(ports).toHaveLength(MAX_HTML_MIRROR_FRAMES));
    relay.dispose();
    expect(ports.every((port) => port.disconnect.mock.calls.length === 1)).toBe(true);
  });
});

function sampleGraph(text: string): HtmlMirrorFrameGraph {
  const element = (id: number, tagName: string, children: HtmlMirrorNode[] = []) => ({
    kind: 'element' as const,
    id,
    namespace: 'html' as const,
    tagName,
    attributes: [] as (readonly [string, string])[],
    children,
  });
  const host = {
    ...element(7, 'x-card'),
    shadowRoot: {
      id: 8,
      mode: 'open' as const,
      slotAssignment: 'manual' as const,
      children: [{ ...element(9, 'slot'), assignedNodeIds: [10] }],
      adoptedStyleSheets: [],
    },
    children: [{ kind: 'text' as const, id: 10, text: 'slotted', translatable: true }],
  };
  return {
    root: element(1, 'html', [
      element(2, 'head'),
      element(3, 'body', [
        element(4, 'div', [{ kind: 'text', id: 5, text, translatable: true }]),
        {
          ...element(6, sourceSecretPlaceholderTagName(6)),
          opaquePlaceholder: true,
          leftOutTagName: 'script',
        },
        host,
      ]),
    ]) as HtmlMirrorElementNode,
    adoptedStyleSheets: [],
  };
}

function frameFixture(extra = '') {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>
    <iframe id="gsi" src="https://accounts.google.com/gsi/button?token=abc"></iframe>
    <iframe id="other" src="https://example.test/"></iframe>
    ${extra}
    <p>After the frames</p>
  </body></html>`);
  for (const frame of document.querySelectorAll('iframe')) {
    Object.defineProperty(frame, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 388, height: 44, right: 388, bottom: 44 }),
    });
  }
  const view = Object.create(window) as Window;
  Object.defineProperty(view, 'getComputedStyle', {
    value: (element: Element) => ({
      display: element.closest('[hidden]') ? 'none' : 'block',
      position: 'static',
      visibility: 'visible',
      opacity: '1',
      getPropertyValue: (name: string) => {
        if (name === 'margin-top') return element.localName === 'iframe' ? '12px' : '0px';
        if (name.startsWith('margin-')) return '0px';
        if (name === 'float') return 'none';
        if (name === '-webkit-text-security') return 'none';
        return '';
      },
    }),
  });
  Object.defineProperty(document, 'defaultView', { configurable: true, value: view });
  return { document: document as unknown as Document, window: view };
}

function allIds(node: HtmlMirrorNode): number[] {
  if (node.kind === 'text') return [node.id];
  return [
    node.id,
    ...node.children.flatMap(allIds),
    ...(node.shadowRoot ? [node.shadowRoot.id, ...node.shadowRoot.children.flatMap(allIds)] : []),
  ];
}

function findNode(
  node: HtmlMirrorNode,
  test: (node: HtmlMirrorNode) => boolean,
): HtmlMirrorNode | undefined {
  if (test(node)) return node;
  if (node.kind === 'text') return undefined;
  for (const child of [...node.children, ...(node.shadowRoot?.children ?? [])]) {
    const found = findNode(child, test);
    if (found) return found;
  }
  return undefined;
}

class FakeWindow {
  readonly #listeners = new Set<(event: MessageEvent) => void>();
  readonly top: unknown;
  readonly parent: unknown;

  constructor(top?: unknown, parent?: unknown) {
    this.top = top ?? this;
    this.parent = parent ?? this;
  }

  addEventListener(_type: string, listener: (event: MessageEvent) => void): void {
    this.#listeners.add(listener);
  }

  emit(event: { source: unknown; data: unknown }): void {
    for (const listener of this.#listeners) listener(event as MessageEvent);
  }
}

class FakePort {
  readonly posts: unknown[] = [];
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly disconnect = vi.fn();

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    this.posts.push(message);
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

class FakeEvent<T extends (...arguments_: never[]) => void> {
  readonly #listeners = new Set<T>();

  addListener(listener: T): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }

  emit(...arguments_: Parameters<T>): void {
    for (const listener of [...this.#listeners]) listener(...arguments_);
  }
}
