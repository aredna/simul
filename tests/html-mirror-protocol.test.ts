import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHtmlMirrorCheckpoint,
  createHtmlMirrorError,
  createHtmlMirrorPatch,
  readHtmlMirrorSourceMessage,
} from '../lib/replica/html-mirror-protocol';
import {
  MAX_HTML_MIRROR_BYTES,
  createHtmlMirrorReadBudget,
  createHtmlMirrorRepresentabilityCollector,
  htmlMirrorJsonBytes,
  readHtmlMirrorNode,
  sanitizeCss,
  sanitizeSourceDocument,
  snapshotHtmlMirrorRepresentability,
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
      <input value="secret" placeholder="private"><button>public button</button>
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
    expect(JSON.stringify(graph)).toContain('public button');
    expect(JSON.stringify(graph)).not.toContain('@import');
    expect(JSON.stringify(graph)).toContain('https://example.com/hero.png');
    expect(JSON.stringify(graph)).toContain('https://example.com/photo.png');
    expect(JSON.stringify(graph)).not.toContain('javascript:');
  });

  it('preserves native and ARIA activation labels while masking nested values', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <button data-account="private-button-state">
        <span title="private-descendant-title" data-user="private-descendant-data">D-U-N-S® Numberを検索・取得する</span>
        <span>（当社サイト）</span>
        <span>ここをクリック　＞</span>
        <input value="nested-private-value">
      </button>
      <article role="button" aria-label="private-aria-label">
        <span>Airbnb</span><span>Coinbase</span>
      </article>
    </body></html>`);
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain('D-U-N-S® Numberを検索・取得する');
    expect(serialized).toContain('（当社サイト）');
    expect(serialized).toContain('ここをクリック　＞');
    expect(serialized).toContain('Airbnb');
    expect(serialized).toContain('Coinbase');
    expect(serialized).not.toContain('nested-private-value');
    expect(serialized).not.toContain('private-button-state');
    expect(serialized).not.toContain('private-aria-label');
    expect(serialized).not.toContain('private-descendant-title');
    expect(serialized).not.toContain('private-descendant-data');
    expect(readHtmlMirrorNode(graph?.root)).toBeDefined();
    expect(readHtmlMirrorNode({
      kind: 'element', id: 91, namespace: 'html', tagName: 'button',
      attributes: [], children: [{
        kind: 'element', id: 92, namespace: 'html', tagName: 'span',
        attributes: [['title', 'transported descendant secret']], children: [{
          kind: 'text', id: 93, text: 'public activation label', translatable: true,
        }],
      }],
    })).toBeUndefined();
  });

  it('carries only canonical hidden/source hints and blanks a broken control icon alt', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <button><img id="control" alt="Vote" width="24" height="24"><faceplate-screen-reader-content>Vote</faceplate-screen-reader-content></button>
      <button><img id="large-control" alt="Card illustration" width="24" height="24"></button>
      <article><img id="article" alt="Article illustration"><span>normal small text</span></article>
      <img id="responsive" src="/fallback.jpg" srcset="/selected.jpg 2x">
    </body></html>`);
    Object.defineProperty(document, 'baseURI', {
      value: 'https://example.test/feed/',
    });
    const control = document.querySelector('#control')!;
    Object.defineProperties(control, {
      complete: { value: true },
      naturalWidth: { value: 0 },
      naturalHeight: { value: 0 },
    });
    const largeControl = document.querySelector('#large-control')!;
    Object.defineProperties(largeControl, {
      complete: { value: true },
      naturalWidth: { value: 0 },
      naturalHeight: { value: 0 },
      getBoundingClientRect: {
        value: () => ({ width: 1200, height: 761 }),
      },
    });
    const responsive = document.querySelector('#responsive')!;
    Object.defineProperty(responsive, 'currentSrc', {
      value: 'https://example.test/selected.jpg',
    });
    Object.defineProperty(window, 'getComputedStyle', {
      value: (element: Element) => element.localName ===
          'faceplate-screen-reader-content'
        ? {
            position: 'absolute', overflow: 'hidden', overflowX: 'hidden',
            overflowY: 'hidden', clip: 'rect(1px, 1px, 1px, 1px)',
            clipPath: 'inset(50%)', width: '1px', height: '1px',
          }
        : {
            position: 'static', overflow: 'visible', overflowX: 'visible',
            overflowY: 'visible', clip: 'auto', clipPath: 'none',
            width: 'auto', height: 'auto',
          },
    });

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const serialized = JSON.stringify(graph);

    expect(serialized.match(/"visuallyHidden":true/gu)).toHaveLength(1);
    expect(serialized).toContain('normal small text');
    expect(serialized).toContain('["alt",""]');
    expect(serialized).toContain('Card illustration');
    expect(serialized).toContain('Article illustration');
    expect(serialized).toContain(
      '"selectedImageSource":"https://example.test/selected.jpg"',
    );
    expect(readHtmlMirrorNode(graph?.root)).toBeDefined();
  });

  it('rejects malformed live presentation hints instead of dropping them', () => {
    const patchIdentity = createReplicaIdentity({
      sessionId: 'hint-validation', pageEpoch: 1, generation: 1,
      documentId: 'hint-document', frameId: 0, sequence: 1,
    });
    const base = {
      kind: 'attributes', nodeId: 7, tagName: 'img', attributes: [],
    } as const;

    expect(createHtmlMirrorPatch(patchIdentity, 1, 1, [{
      ...base,
      visuallyHidden: false,
    } as unknown as Parameters<typeof createHtmlMirrorPatch>[3][number]]))
      .toBeUndefined();
    expect(createHtmlMirrorPatch(patchIdentity, 1, 1, [{
      ...base,
      selectedImageSource: 7,
    } as unknown as Parameters<typeof createHtmlMirrorPatch>[3][number]]))
      .toBeUndefined();
  });

  it('charges selected image sources to source and receiver budgets', () => {
    const longSource = `https://example.test/${'a'.repeat(180)}`;
    const withoutHintBudget = createHtmlMirrorReadBudget();
    withoutHintBudget.bytes = MAX_HTML_MIRROR_BYTES - 100;
    expect(readHtmlMirrorNode({
      kind: 'element', id: 1, namespace: 'html', tagName: 'img',
      attributes: [], children: [],
    }, new Set(), 0, withoutHintBudget)).toBeDefined();

    const withHintBudget = createHtmlMirrorReadBudget();
    withHintBudget.bytes = MAX_HTML_MIRROR_BYTES - 100;
    expect(readHtmlMirrorNode({
      kind: 'element', id: 1, namespace: 'html', tagName: 'img',
      attributes: [], children: [], selectedImageSource: longSource,
    }, new Set(), 0, withHintBudget)).toBeUndefined();

    const { document, window } = parseHTML(
      '<!doctype html><html><body>' +
      Array.from({ length: 9 }, (_, index) => `<img id="image-${index}">`).join('') +
      '</body></html>',
    );
    for (const image of document.querySelectorAll('img')) {
      Object.defineProperty(image, 'currentSrc', {
        value: `data:image/png;base64,${'A'.repeat(500_000)}`,
      });
    }
    expect(() => sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    )).toThrow('HTML mirror budget exceeded.');
  });

  it('uses the first recognized sensitive role token as the privacy fallback', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <section role="button textbox"><span>public activation fallback</span></section>
      <section role="textbox button"><span>private input fallback</span></section>
    </body></html>`);
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain('public activation fallback');
    expect(serialized).not.toContain('private input fallback');
    expect(readHtmlMirrorNode(graph?.root)).toBeDefined();
  });

  it('admits YC static SVG data images symmetrically and rejects active SVG', () => {
    const ycLogo = "data:image/svg+xml,%3csvg%20width='48'%20height='48'%20viewBox='0%200%2048%2048'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M47.9985%2047.9994H0V8.61853e-07H47.9985V47.9994Z'%20fill='%23FF6600'/%3e%3cpath%20d='M13.9012%2011.7843H17.6595L22.4961%2021.5325C23.203%2022.9836%2023.7984%2024.3976%2023.7984%2024.3976C23.7984%2024.3976%2024.4313%2023.021%2025.175%2021.5325L30.0868%2011.7843H33.5843L25.2865%2027.3746V37.309H22.1244V27.1884L13.9012%2011.7843Z'%20fill='white'/%3e%3c/svg%3e";
    const hostile = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.invalid/a.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://tracker.invalid/p)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\\72l(h\\74tps://tracker.invalid/p)"/></svg>',
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "https://tracker.invalid/x">]><svg xmlns="http://www.w3.org/2000/svg"/>',
    ].map((svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`);
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <img id="logo" src="${ycLogo}">
      ${hostile.map((src, index) => `<img id="bad-${index}" src="${src}">`).join('')}
    </body></html>`);
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain(ycLogo);
    for (const src of hostile) expect(serialized).not.toContain(src);
    expect(readHtmlMirrorNode(graph?.root)).toBeDefined();
    expect(readHtmlMirrorNode({
      kind: 'element',
      id: 100_000,
      namespace: 'html',
      tagName: 'img',
      attributes: [['src', hostile[0]]],
      children: [],
    })).toBeUndefined();
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
      representability: checkpoint?.payload.representability,
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

  it('validates bounded final-order child reconciliation entries exactly', () => {
    const identity = createReplicaIdentity({
      sessionId: 'reconcile-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'reconcile-document',
      frameId: 0,
      sequence: 1,
    });
    const patch = createHtmlMirrorPatch(identity, 1, 1, [{
      kind: 'reconcile-children',
      nodeId: 3,
      children: [
        { kind: 'retain', nodeId: 4 },
        {
          kind: 'graph',
          node: {
            kind: 'element', id: 5, namespace: 'html', tagName: 'p',
            attributes: [], children: [{
              kind: 'text', id: 6, text: 'new child', translatable: true,
            }],
          },
        },
      ],
    }]);

    expect(patch).toBeDefined();
    expect(readHtmlMirrorSourceMessage(patch, identity)).toEqual(patch);
    expect(createHtmlMirrorPatch(identity, 1, 1, [{
      kind: 'reconcile-children',
      nodeId: 3,
      children: [
        { kind: 'retain', nodeId: 4 },
        { kind: 'retain', nodeId: 4 },
      ],
    }])).toBeUndefined();
    expect(readHtmlMirrorSourceMessage({
      ...patch,
      operations: [{
        kind: 'reconcile-children',
        nodeId: 3,
        children: [{ kind: 'retain', nodeId: 4, sourceText: 'private' }],
      }],
    }, identity)).toBeUndefined();
  });

  it('applies one global node budget across reconciliation operations', () => {
    const identity = createReplicaIdentity({
      sessionId: 'reconcile-budget-session', pageEpoch: 1, generation: 1,
      documentId: 'reconcile-budget-document', frameId: 0, sequence: 1,
    });
    const operations = [0, 1].map((group) => ({
      kind: 'reconcile-children' as const,
      nodeId: group + 1,
      children: Array.from({ length: 25_001 }, (_, index) => ({
        kind: 'retain' as const,
        nodeId: group * 25_001 + index + 10,
      })),
    }));

    expect(createHtmlMirrorPatch(identity, 1, 1, operations)).toBeUndefined();
  });

  it('transports only bounded aggregate representability diagnostics', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <script>private script text</script>
      <button onclick="private-handler()" data-account="private-state">label</button>
      <a href="javascript:private-url()">link</a>
      <div role="textbox">private editable text</div>
      <x-open></x-open><x-opaque></x-opaque>
    </body></html>`);
    const openHost = document.querySelector('x-open')!;
    const shadow = openHost.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    shadow.append(document.createElement('slot'));
    const diagnostics = createHtmlMirrorRepresentabilityCollector();
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      diagnostics,
    );
    const summary = snapshotHtmlMirrorRepresentability(diagnostics);

    expect(graph).toBeDefined();
    expect(summary).toMatchObject({
      unsafeElementOmissionCount: 1,
      privateTextRedactionCount: 1,
      accessibleOpenShadowRootCount: 1,
      customElementHostCount: 2,
      customElementHostWithoutAccessibleOpenRootCount: 1,
    });
    expect(summary.strippedActiveAttributeCount).toBeGreaterThanOrEqual(2);
    expect(summary.strippedUnsafeResourceCount).toBeGreaterThanOrEqual(1);
    const identity = createReplicaIdentity({
      sessionId: 'diagnostic-session', pageEpoch: 1, generation: 1,
      documentId: 'diagnostic-document', frameId: 0, sequence: 0,
    });
    const checkpoint = graph && createHtmlMirrorCheckpoint(identity, {
      root: graph.root,
      adoptedStyleSheets: graph.adoptedStyleSheets,
      captureMs: 1,
      viewportWidth: graph.viewportWidth,
      viewportHeight: graph.viewportHeight,
      documentWidth: graph.documentWidth,
      documentHeight: graph.documentHeight,
      representability: summary,
    });
    expect(checkpoint?.payload.representability).toEqual(summary);
    const diagnosticJson = JSON.stringify(checkpoint?.payload.representability);
    expect(diagnosticJson).not.toContain('private script text');
    expect(diagnosticJson).not.toContain('private-handler');
    expect(diagnosticJson).not.toContain('private-url');
    expect(readHtmlMirrorSourceMessage({
      ...checkpoint,
      payload: {
        ...checkpoint?.payload,
        representability: {
          ...checkpoint?.payload.representability,
          unsafeElementOmissionCount: -1,
        },
      },
    }, identity)).toBeUndefined();
    expect(readHtmlMirrorSourceMessage({
      ...checkpoint,
      payload: {
        ...checkpoint?.payload,
        representability: {
          ...checkpoint?.payload.representability,
          sourceNodeId: 4,
        },
      },
    }, identity)).toBeUndefined();

    const deep = parseHTML(
      `<html><body>${'<div>'.repeat(66)}deep${'</div>'.repeat(66)}</body></html>`,
    );
    const depthDiagnostics = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeSourceDocument(
      deep.document,
      deep.window as unknown as Window,
      new WeakNodeIdRegistry(),
      depthDiagnostics,
    )).toBeDefined();
    expect(depthDiagnostics.depthBoundaryOmissionCount).toBeGreaterThan(0);

    const capacity = createHtmlMirrorRepresentabilityCollector();
    capacity.capacityOmissionCount = 1;
    const error = createHtmlMirrorError(
      identity,
      'stream_overflow',
      capacity,
    );
    expect(readHtmlMirrorSourceMessage(error, identity)).toEqual(error);
    expect(readHtmlMirrorSourceMessage({
      ...error,
      representability: {
        ...error.representability,
        sourceNodeId: 99,
      },
    }, identity)).toBeUndefined();
    expect(readHtmlMirrorSourceMessage({
      ...error,
      representability: {
        ...error.representability,
        capacityOmissionCount: -1,
      },
    }, identity)).toBeUndefined();
  });

  it('counts removed CSS resources and custom built-ins without false style risks', () => {
    const { document, window } = parseHTML(`<!doctype html><html><head><style>
      @import "https://tracker.invalid/theme.css";
      .hero{background-image:url("data:text/plain,unsafe")}
    </style></head><body>
      <button is="x-action" style="">label</button>
    </body></html>`);
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://example.test/',
    });
    Object.defineProperty(document, 'adoptedStyleSheets', {
      configurable: true,
      value: [fakeStyleSheet('.disabled{background:url("/ignored.png")}', true)],
    });
    const diagnostics = createHtmlMirrorRepresentabilityCollector();
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      diagnostics,
    );

    expect(graph).toBeDefined();
    expect(JSON.stringify(graph)).not.toContain('tracker.invalid');
    expect(JSON.stringify(graph)).not.toContain('data:text/plain');
    expect(diagnostics).toMatchObject({
      strippedUnsafeResourceCount: 2,
      unreadableStyleCount: 0,
      customElementHostCount: 1,
      customElementHostWithoutAccessibleOpenRootCount: 1,
    });
    expect(graph?.adoptedStyleSheets).toEqual([]);
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

  it('keeps behavior-suffixed layout properties but blocks legacy behavior declarations', () => {
    const redditUtilityCss = [
      'html{scroll-behavior:smooth}',
      '.viewport{overscroll-behavior-y:contain;display:flex;min-height:100vh}',
      '.media{max-width:100%;object-fit:contain}',
    ].join('');

    expect(sanitizeCss(redditUtilityCss, 'https://example.com/')).toBe(
      redditUtilityCss,
    );
    expect(sanitizeCss(
      'behavior:hover { color: red }',
      'https://example.com/',
    )).toBe('behavior:hover { color: red }');
    expect(sanitizeCss(
      'behavior:url("legacy.htc")',
      'https://example.com/',
      true,
    )).toBeUndefined();
    expect(sanitizeCss(
      '.unsafe{behavior:url("legacy.htc")}',
      'https://example.com/',
    )).toBeUndefined();
    expect(sanitizeCss(
      String.raw`.unsafe{be\68 avior:url("legacy.htc")}`,
      'https://example.com/',
    )).toBeUndefined();
    expect(sanitizeCss(
      '.unsafe{/**/ *behavior:url("legacy.htc")}',
      'https://example.com/',
    )).toBeUndefined();
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
