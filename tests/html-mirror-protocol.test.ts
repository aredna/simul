import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHtmlMirrorCheckpoint,
  createHtmlMirrorPatch,
  readHtmlMirrorSourceMessage,
} from '../lib/replica/html-mirror-protocol';
import {
  htmlMirrorJsonBytes,
  readHtmlMirrorNode,
  sanitizeCss,
  sanitizeSourceDocument,
} from '../lib/replica/html-mirror-sanitizer';
import { WeakNodeIdRegistry } from '../lib/replica/html-mirror-source';
import { createReplicaIdentity } from '../lib/replica/protocol-v2';

describe('isolated HTML sanitizer and protocol', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
    });
  });

  it('deep-clones into a passive typed graph while masking private text', () => {
    const { document, window } = parseHTML(`<!doctype html><html lang="ja"><head>
      <style>@import "https://tracker.invalid/a.css"; .hero{background:url('/hero.png')}</style>
      <script>globalThis.compromised = true</script>
    </head><body onclick="steal()">
      <a href="javascript:steal()">safe label</a>
      <input value="secret" placeholder="private"><button>private button</button>
      <img src="/photo.png" onload="steal()">
    </body></html>`);
    Object.defineProperty(document, 'baseURI', {
      value: 'https://example.com/path/',
    });
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );

    expect(graph?.root.tagName).toBe('html');
    expect(JSON.stringify(graph)).not.toContain('script');
    expect(JSON.stringify(graph)).not.toContain('onclick');
    expect(JSON.stringify(graph)).not.toContain('secret');
    expect(JSON.stringify(graph)).not.toContain('private button');
    expect(JSON.stringify(graph)).not.toContain('@import');
    expect(JSON.stringify(graph)).toContain('https://example.com/hero.png');
    expect(JSON.stringify(graph)).toContain('https://example.com/photo.png');
    expect(JSON.stringify(graph)).not.toContain('javascript:');
  });

  it('keeps data-image commas inside srcset URLs and sanitizes mixed candidates', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <img srcset="data:image/png;base64,AAAA 1x, /safe.png 2x, javascript:steal() 3x">
    </body></html>`);
    Object.defineProperty(document, 'baseURI', {
      value: 'https://example.test/gallery/',
    });

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const json = JSON.stringify(graph);

    expect(json).toContain(
      'data:image/png;base64,AAAA 1x, https://example.test/safe.png 2x',
    );
    expect(json).not.toContain('https://example.test/gallery/AAAA');
    expect(json).not.toContain('javascript:');
    expect(readHtmlMirrorNode(graph?.root)).toBeDefined();

    expect(readHtmlMirrorNode({
      kind: 'element',
      id: 99,
      namespace: 'html',
      tagName: 'img',
      attributes: [['srcset', 'AAAA 1x']],
      children: [],
    })).toBeUndefined();
  });

  it('revalidates both checkpoints and patches and rejects active attributes', () => {
    const identity = createReplicaIdentity({
      sessionId: 'session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'document',
      frameId: 0,
      sequence: 0,
    });
    const root = {
      kind: 'element' as const,
      id: 1,
      namespace: 'html' as const,
      tagName: 'html',
      attributes: [],
      children: [{
        kind: 'element' as const,
        id: 2,
        namespace: 'html' as const,
        tagName: 'body',
        attributes: [],
        children: [{ kind: 'text' as const, id: 3, text: 'hello', translatable: true }],
      }],
    };
    const checkpoint = createHtmlMirrorCheckpoint(identity, {
      root,
      adoptedStyleSheets: [],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1200,
    });
    expect(checkpoint).toBeDefined();
    expect(readHtmlMirrorSourceMessage(checkpoint, identity)).toEqual(checkpoint);

    const patchIdentity = { ...identity, sequence: 1 };
    const patch = createHtmlMirrorPatch(patchIdentity, 1, 1, [{
      kind: 'text',
      nodeId: 3,
      node: { kind: 'text', id: 3, text: 'updated', translatable: true },
    }]);
    expect(patch?.lastSequence).toBe(1);
    expect(readHtmlMirrorNode({
      kind: 'element',
      id: 9,
      namespace: 'html',
      tagName: 'img',
      attributes: [['onerror', 'steal()']],
      children: [],
    })).toBeUndefined();
    expect(readHtmlMirrorSourceMessage({
      ...checkpoint,
      payload: { ...checkpoint?.payload, byteLength: 1 },
    }, identity)).toBeUndefined();
  });

  it('masks private ancestors and rejects malicious private transport canaries', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <section role="textbox"><span title="secret title" data-secret="secret data">secret text</span></section>
    </body></html>`);
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    expect(JSON.stringify(graph)).not.toContain('secret');

    expect(readHtmlMirrorNode({
      kind: 'element', id: 1, namespace: 'html', tagName: 'section',
      attributes: [['role', 'textbox']], children: [{
        kind: 'element', id: 2, namespace: 'html', tagName: 'span',
        attributes: [['title', 'secret title']], children: [{
          kind: 'text', id: 3, text: 'secret text', translatable: true,
        }],
      }],
    })).toBeUndefined();
  });

  it('never invokes cloneNode and captures only accessible open shadow roots', () => {
    const { document, window } = parseHTML('<!doctype html><html><body><div id="open"></div><div id="closed"></div></body></html>');
    const openHost = document.querySelector('#open')!;
    const openShadow = openHost.attachShadow({ mode: 'open' });
    Object.defineProperty(openShadow, 'mode', { value: 'open' });
    openShadow.append(document.createTextNode('open shadow'));
    document.querySelector('#closed')!.attachShadow({ mode: 'closed' })
      .append(document.createTextNode('closed shadow'));
    const clone = vi.spyOn(window.Node.prototype, 'cloneNode')
      .mockImplementation(() => {
        throw new Error('cloneNode must not run');
      });

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );

    expect(clone).not.toHaveBeenCalled();
    expect(JSON.stringify(graph)).toContain('open shadow');
    expect(JSON.stringify(graph)).not.toContain('closed shadow');
    clone.mockRestore();
  });

  it('captures and validates ordered document and shadow adopted stylesheets', () => {
    const { document, window } = parseHTML(
      '<!doctype html><html><head></head><body><x-card></x-card></body></html>',
    );
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://www.reddit.com/r/example/',
    });
    const card = document.querySelector('x-card')!;
    const shadow = card.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    shadow.append(document.createElement('slot'));
    const sharedPageSheet = fakeStyleSheet(
      '.page{display:grid;background:url("/tile.png")}',
    );
    Object.defineProperty(document, 'adoptedStyleSheets', {
      configurable: true,
      value: [
        sharedPageSheet,
        sharedPageSheet,
        fakeStyleSheet('.disabled{display:none}', true),
      ],
    });
    Object.defineProperty(shadow, 'adoptedStyleSheets', {
      configurable: true,
      value: [fakeStyleSheet(
        ':host{display:block}.card{contain:layout}',
        false,
        '(min-width: 40rem)',
      )],
    });

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    expect(graph?.adoptedStyleSheets).toEqual([
      '.page{display:grid;background:url("https://www.reddit.com/tile.png")}',
      '.page{display:grid;background:url("https://www.reddit.com/tile.png")}',
    ]);
    const graphJson = JSON.stringify(graph);
    expect(graphJson).toContain(
      '@media (min-width: 40rem){:host{display:block}.card{contain:layout}}',
    );
    expect(graphJson).not.toContain('.disabled');

    const identity = createReplicaIdentity({
      sessionId: 'adopted-style-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'adopted-style-document',
      frameId: 0,
      sequence: 0,
    });
    const checkpoint = graph && createHtmlMirrorCheckpoint(identity, {
      root: graph.root,
      adoptedStyleSheets: graph.adoptedStyleSheets,
      captureMs: 1,
      viewportWidth: graph.viewportWidth,
      viewportHeight: graph.viewportHeight,
      documentWidth: graph.documentWidth,
      documentHeight: graph.documentHeight,
    });
    expect(checkpoint?.payload.byteLength).toBe(htmlMirrorJsonBytes({
      root: checkpoint?.payload.root,
      adoptedStyleSheets: checkpoint?.payload.adoptedStyleSheets,
    }));
    expect(readHtmlMirrorSourceMessage(checkpoint, identity)).toEqual(checkpoint);
    expect(createHtmlMirrorCheckpoint(identity, {
      root: graph!.root,
      adoptedStyleSheets: ['@import "https://tracker.invalid/styles.css";'],
      captureMs: 1,
      viewportWidth: 1,
      viewportHeight: 1,
      documentWidth: 1,
      documentHeight: 1,
    })).toBeUndefined();
  });

  it('omits an inaccessible adopted stylesheet without losing readable styles', () => {
    const { document, window } = parseHTML(
      '<!doctype html><html><head></head><body><main>content</main></body></html>',
    );
    const unreadable = {};
    Object.defineProperty(unreadable, 'cssRules', {
      get: () => {
        throw new DOMException('Stylesheet is inaccessible.', 'SecurityError');
      },
    });
    Object.defineProperty(document, 'adoptedStyleSheets', {
      configurable: true,
      value: [unreadable, fakeStyleSheet('main{display:block}')],
    });

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    expect(graph?.adoptedStyleSheets).toEqual(['main{display:block}']);
    expect(JSON.stringify(graph)).toContain('content');
  });

  it('fails closed when one owner exceeds the adopted stylesheet count limit', () => {
    const { document, window } = parseHTML(
      '<!doctype html><html><head></head><body></body></html>',
    );
    Object.defineProperty(document, 'adoptedStyleSheets', {
      configurable: true,
      value: Array.from({ length: 257 }, () => fakeStyleSheet('')),
    });

    expect(sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    )).toBeUndefined();
  });

  it('revalidates aggregate adopted stylesheet and CSS-rule limits', () => {
    const identity = createReplicaIdentity({
      sessionId: 'style-limit-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'style-limit-document',
      frameId: 0,
      sequence: 0,
    });
    const root = {
      kind: 'element' as const,
      id: 1,
      namespace: 'html' as const,
      tagName: 'html',
      attributes: [],
      children: [],
    };
    expect(createHtmlMirrorCheckpoint(identity, {
      root,
      adoptedStyleSheets: ['.a{}'.repeat(20_001)],
      captureMs: 1,
      viewportWidth: 1,
      viewportHeight: 1,
      documentWidth: 1,
      documentHeight: 1,
    })).toBeUndefined();

    const children = Array.from({ length: 17 }, (_, index) => ({
      kind: 'element' as const,
      id: 10 + index * 2,
      namespace: 'html' as const,
      tagName: 'x-card',
      attributes: [],
      children: [],
      shadowRoot: {
        id: 11 + index * 2,
        mode: 'open' as const,
        children: [],
        adoptedStyleSheets: Array.from({ length: 256 }, () => ''),
      },
    }));
    expect(createHtmlMirrorPatch(
      { ...identity, sequence: 1 },
      1,
      1,
      [{ kind: 'children', nodeId: 2, children }],
    )).toBeUndefined();
  });

  it('removes comment/escape-obfuscated CSS imports but preserves passive rules', () => {
    const { document, window } = parseHTML(`<!doctype html><html><head><style>
      @\\69m/**/port url("https://tracker.invalid/a.css");
      .hero{background:url('/hero.png')}
    </style></head><body></body></html>`);
    Object.defineProperty(document, 'baseURI', { value: 'https://example.com/' });

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const json = JSON.stringify(graph);
    expect(json).not.toContain('tracker.invalid');
    expect(json).not.toMatch(/@\s*import/iu);
    expect(json).toContain('https://example.com/hero.png');
  });

  it('preserves meaningful CSS escapes while still removing escaped imports', () => {
    const css = '@\\69m/**/port url("https://tracker.invalid/a.css");' +
      '.sm\\:hidden{display:none}.bullet::before{content:"\\2022"}';

    expect(sanitizeCss(css, 'https://example.com/')).toBe(
      '.sm\\:hidden{display:none}.bullet::before{content:"\\2022"}',
    );
  });
});

function fakeStyleSheet(
  cssText: string,
  disabled = false,
  mediaText = '',
): CSSStyleSheet {
  const rule = { cssText };
  return {
    disabled,
    media: { mediaText },
    cssRules: {
      0: rule,
      length: 1,
      item: (index: number) => index === 0 ? rule : null,
    },
  } as unknown as CSSStyleSheet;
}
