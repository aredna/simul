import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

import {
  captureLivePageDelta,
  installLivePageObserver,
  parseLivePageDelta,
  readLivePageDirtyMessage,
  readLivePageObserverInstallation,
  readLivePageScrollMessage,
  unregisterLivePageObserver,
} from '../lib/live-page-mirror';
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

  it('rejects a seventeenth observer session without evicting an active one', () => {
    const sessions = new Map(
      Array.from({ length: 16 }, (_, index) => [`existing_${index}`, index]),
    );
    const announceScroll = vi.fn();
    (
      globalThis as typeof globalThis & { __simulLiveMirrorV1?: unknown }
    ).__simulLiveMirrorV1 = {
      sessions,
      currentSequence: () => 12,
      announceScroll,
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

    expect(installLivePageObserver('session_1234', 1)).toMatchObject({
      installed: true,
    });
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
    ).toMatchObject({ scrollX: 0, scrollY: 250, maxScrollY: 1_000 });

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
