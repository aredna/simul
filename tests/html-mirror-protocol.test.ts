import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHtmlMirrorCheckpoint,
  createHtmlMirrorError,
  createHtmlMirrorPatch,
  createHtmlMirrorStart,
  readHtmlMirrorControllerMessage,
  readHtmlMirrorSourceMessage,
} from '../lib/replica/html-mirror-protocol';
import {
  MAX_HTML_MIRROR_BYTES,
  createHtmlMirrorReadBudget,
  createHtmlMirrorRepresentabilityCollector,
  createHtmlMirrorStyleWorkBudget,
  htmlMirrorJsonBytes,
  type HtmlMirrorDocumentGraph,
  type HtmlMirrorElementNode,
  readHtmlMirrorNode,
  sanitizeCss,
  sanitizeSourceDocument,
  sanitizeSourceElementHints,
  sanitizeSourceSubtrees,
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

  it('binds one selectable fidelity policy to the start handshake', () => {
    const identity = createReplicaIdentity({
      sessionId: 'policy-session', pageEpoch: 1, generation: 1,
      documentId: 'policy-document', frameId: 0, sequence: 0,
    });
    const passive = createHtmlMirrorStart(identity, 'passive');

    expect(readHtmlMirrorControllerMessage(
      passive,
      identity.sessionId,
      identity,
    )).toEqual(passive);
    expect(readHtmlMirrorControllerMessage({
      ...passive,
      fidelityPolicy: 'conservative',
    }, identity.sessionId, identity)).toMatchObject({
      fidelityPolicy: 'conservative',
    });
    expect(readHtmlMirrorControllerMessage({
      ...passive,
      fidelityPolicy: 'strict-local',
    }, identity.sessionId, identity)).toBeUndefined();
    expect(readHtmlMirrorControllerMessage({
      ...passive,
      fidelityPolicy: 'future-policy',
    }, identity.sessionId, identity)).toBeUndefined();
    expect(readHtmlMirrorControllerMessage(
      {
        protocolVersion: passive.protocolVersion,
        kind: 'simul:html-mirror-v1:start',
        identity,
      },
      identity.sessionId,
      identity,
    )).toBeUndefined();
    expect(readHtmlMirrorControllerMessage({
      protocolVersion: passive.protocolVersion,
      kind: 'simul:html-mirror-v1:ack',
      identity,
      fidelityPolicy: 'passive',
    }, identity.sessionId, identity)).toBeUndefined();
  });

  it('applies passive HTML resource semantics symmetrically at both boundaries', () => {
    const markup = `<!doctype html><html><body>
      <a id="docs" href="../guide?topic=mirror#passive">Guide</a>
      <picture id="art">
        <source id="wide" media="(min-width: 50rem)"
          srcset="../wide.webp 1200w, ../wide@2x.webp 2x">
        <img id="fallback" src="../fallback.jpg" alt="Artwork">
      </picture>
      <video id="demo" poster="../poster.jpg" src="../movie.mp4"
        autoplay controls loop muted playsinline preload="auto">fallback</video>
    </body></html>`;
    const passive = sanitizeMarkup(markup, 'passive');
    const conservative = sanitizeMarkup(markup, 'conservative');

    expect(attributesOf(passive, 'docs')).toMatchObject({
      href: 'https://example.test/guide?topic=mirror#passive',
    });
    expect(attributesOf(conservative, 'docs')).not.toHaveProperty('href');
    expect(attributesOf(passive, 'wide')).toMatchObject({
      srcset: 'https://example.test/wide.webp 1200w, https://example.test/wide@2x.webp 2x',
    });
    expect(attributesOf(conservative, 'wide')).not.toHaveProperty('srcset');

    const passiveVideo = graphElementBySourceId(passive, 'demo');
    expect(passiveVideo).toBeDefined();
    expect(Object.fromEntries(passiveVideo!.attributes)).toMatchObject({
      poster: 'https://example.test/poster.jpg',
    });
    for (const active of [
      'src', 'autoplay', 'controls', 'loop', 'muted', 'playsinline', 'preload',
    ]) {
      expect(Object.fromEntries(passiveVideo!.attributes)).not.toHaveProperty(active);
    }
    expect(graphElementBySourceId(conservative, 'demo')).toBeUndefined();

    const identity = createReplicaIdentity({
      sessionId: 'passive-graph', pageEpoch: 1, generation: 1,
      documentId: 'passive-document', frameId: 0, sequence: 0,
    });
    expect(checkpointFor(identity, passive, 'passive')).toBeDefined();
    expect(checkpointFor(identity, passive, 'conservative')).toBeUndefined();
  });

  it('omits posterless video shells while preserving a passive fallback image', () => {
    const graph = sanitizeMarkup(`<!doctype html><html><body>
      <section>
        <video id="blank-video" src="../movie.mp4">Video fallback text</video>
        <img id="static-fallback" src="../fallback.jpg" alt="Static fallback">
      </section>
    </body></html>`, 'passive');

    expect(graphElementBySourceId(graph, 'blank-video')).toBeUndefined();
    expect(attributesOf(graph, 'static-fallback')).toMatchObject({
      src: 'https://example.test/fallback.jpg',
      alt: 'Static fallback',
    });
    expect(JSON.stringify(graph)).not.toContain('movie.mp4');
  });

  it('carries native select labels and selected indices without submission data', () => {
    const graph = sanitizeMarkup(`<!doctype html><html><body>
      <select id="facility" name="private-name" data-account="private-data">
        <option value="private-1">選択してください。</option>
        <optgroup id="area" label="麻布地区">
          <option value="private-2" data-code="private-code" title="private-title" selected>麻布区民センター</option>
          <option role="textbox" label="private role label">private role choice</option>
          <option id="rich"><img src="https://leak.invalid/option.png"><span name="private-rich-name" data-secret="private-rich-data">Visible rich choice</span></option>
        </optgroup>
      </select>
      <select id="private-selection"><option role="textbox" selected label="selected secret">selected secret text</option></select>
      <datalist id="private-suggestions"><option value="secret" label="secret datalist label">secret suggestion</option></datalist>
    </body></html>`, 'passive');
    const selects = graphElementsByTag(graph, 'select');
    const select = selects[0];
    const area = graphElementsByTag(graph, 'optgroup')[0];
    const privateSelection = selects[1];
    const serialized = JSON.stringify(graph);

    expect(select?.selectedOptionIndexes).toEqual([1]);
    expect(area?.controlText).toEqual({
      kind: 'label', text: '麻布地区', translatable: true,
    });
    expect(privateSelection?.selectedOptionIndexes).toEqual([]);
    expect(Object.fromEntries(select?.attributes ?? [])).not.toHaveProperty('name');
    expect(serialized).toContain('選択してください。');
    expect(serialized).toContain('麻布区民センター');
    expect(serialized).toContain('麻布地区');
    expect(serialized).not.toContain('private-name');
    expect(serialized).not.toContain('private-data');
    expect(serialized).not.toContain('private-1');
    expect(serialized).not.toContain('private-2');
    expect(serialized).not.toContain('private-code');
    expect(serialized).not.toContain('private-title');
    expect(serialized).not.toContain('private role choice');
    expect(serialized).not.toContain('private role label');
    expect(serialized).toContain('Visible rich choice');
    expect(serialized).not.toContain('leak.invalid');
    expect(serialized).not.toContain('private-rich-name');
    expect(serialized).not.toContain('private-rich-data');
    expect(serialized).not.toContain('secret suggestion');
    expect(serialized).not.toContain('secret datalist label');
    expect(serialized).not.toContain('selected secret');
    expect(readHtmlMirrorNode(graph.root, new Set(), 0, undefined, false,
      false, false, false, false, 'passive')).toBeDefined();
    expect(readHtmlMirrorNode({
      kind: 'element', id: 900, namespace: 'html', tagName: 'div',
      attributes: [], children: [], selectedOptionIndexes: [0],
    }, new Set(), 0, undefined, false, false, false, false, false, 'passive'))
      .toBeUndefined();
    expect(readHtmlMirrorNode({
      kind: 'element', id: 901, namespace: 'html', tagName: 'select',
      attributes: [], selectedOptionIndexes: [50_000], children: [{
        kind: 'element', id: 902, namespace: 'html', tagName: 'option',
        attributes: [], children: [{
          kind: 'text', id: 903, text: 'Only choice', translatable: true,
        }],
      }],
    }, new Set(), 0, undefined, false, false, false, false, false, 'passive'))
      .toBeUndefined();
    expect(readHtmlMirrorNode({
      kind: 'element', id: 904, namespace: 'html', tagName: 'select',
      attributes: [], selectedOptionIndexes: [1], children: [{
        kind: 'element', id: 905, namespace: 'html', tagName: 'option',
        attributes: [], children: [],
        controlText: { kind: 'label', text: 'Only choice', translatable: true },
      }],
    }, new Set(), 0, undefined, false, false, false, false, false, 'passive'))
      .toBeUndefined();
    expect(readHtmlMirrorNode({
      kind: 'element', id: 906, namespace: 'html', tagName: 'select',
      attributes: [], children: [{
        kind: 'element', id: 907, namespace: 'html', tagName: 'img',
        attributes: [['src', 'https://leak.invalid/forged.png']], children: [],
      }],
    }, new Set(), 0, undefined, false, false, false, false, false, 'passive'))
      .toBeUndefined();
    expect(readHtmlMirrorNode({
      kind: 'element', id: 908, namespace: 'html', tagName: 'select',
      attributes: [['role', 'combobox']], children: [{
        kind: 'element', id: 909, namespace: 'html', tagName: 'img',
        attributes: [['src', 'https://leak.invalid/private-select.png']],
        children: [],
      }],
    }, new Set(), 0, undefined, false, false, false, false, false, 'passive'))
      .toBeUndefined();
  });

  it('keeps public menu labels while removing request-capable descendants', () => {
    const graph = sanitizeMarkup(`<!doctype html><html><body>
      <section role="listbox">
        <div role="option">
          <img src="https://leak.invalid/menu.png"
            style="background-image:url('https://leak.invalid/background.png')">
          <video poster="https://leak.invalid/menu-poster.png"></video>
          <span>Public menu choice</span>
        </div>
      </section>
    </body></html>`, 'passive');
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain('Public menu choice');
    expect(serialized).not.toContain('leak.invalid');
    expect(graphElementsByTag(graph, 'video')).toEqual([]);
    expect(readHtmlMirrorNode(graph.root, new Set(), 0, undefined, false,
      false, false, false, false, 'passive')).toBeDefined();
    expect(readHtmlMirrorNode({
      kind: 'element', id: 920, namespace: 'html', tagName: 'div',
      attributes: [['role', 'menu']], children: [{
        kind: 'element', id: 921, namespace: 'html', tagName: 'img',
        attributes: [['src', 'https://leak.invalid/forged-menu.png']],
        children: [],
      }],
    }, new Set(), 0, undefined, false, false, false, false, false, 'passive'))
      .toBeUndefined();
  });

  it('preserves bounded multiple-selection state beyond the former 512 entry cap', () => {
    const options = Array.from(
      { length: 513 },
      (_, index) => `<option selected>Choice ${index}</option>`,
    ).join('');
    const graph = sanitizeMarkup(
      `<!doctype html><html><body><select id="many" multiple>${options}</select></body></html>`,
      'passive',
    );
    const select = graphElementsByTag(graph, 'select')[0];

    expect(select?.selectedOptionIndexes).toHaveLength(513);
    expect(select?.selectedOptionIndexes?.at(-1)).toBe(512);
  });

  it('keeps blank, hidden, and private select-entry labels out of transport', () => {
    const graph = sanitizeMarkup(`<!doctype html><html><body>
      <select>
        <option label="   ">whitespace fallback secret</option>
        <optgroup hidden label="hidden group secret">
          <option selected>hidden selected secret</option>
        </optgroup>
        <optgroup role="combobox" label="private group secret">
          <option selected>private selected secret</option>
        </optgroup>
        <optgroup label="Public group">
          <legend hidden>hidden legend secret</legend>
          <option>Public child</option>
        </optgroup>
      </select>
      <section hidden>
        <select id="hidden-owner">
          <option selected>ancestor-hidden selected secret</option>
        </select>
      </section>
    </body></html>`, 'passive');
    const select = graphElementsByTag(graph, 'select')[0];
    const hiddenSelect = graphElementBySourceId(graph, 'hidden-owner');
    const serialized = JSON.stringify(graph);

    expect(select?.selectedOptionIndexes).toEqual([]);
    expect(serialized).toContain('Public child');
    expect(serialized).not.toContain('whitespace fallback secret');
    expect(serialized).not.toContain('hidden group secret');
    expect(serialized).not.toContain('hidden selected secret');
    expect(serialized).not.toContain('private group secret');
    expect(serialized).not.toContain('private selected secret');
    expect(serialized).not.toContain('hidden legend secret');
    expect(serialized).not.toContain('ancestor-hidden selected secret');
    expect(hiddenSelect).toBeUndefined();
  });

  it('rejects noncanonical native-select presentation attributes', () => {
    const node = {
      kind: 'element', id: 900, namespace: 'html', tagName: 'select',
      attributes: [['disabled', 'private-token']],
      selectedOptionIndexes: [], children: [],
    };
    expect(readHtmlMirrorNode(node)).toBeUndefined();
    expect(readHtmlMirrorNode({
      ...node,
      attributes: [['role', 'private-token']],
    })).toBeUndefined();
    expect(readHtmlMirrorNode({
      ...node,
      attributes: [['disabled', '']],
    })).toBeDefined();
    const { selectedOptionIndexes: _selected, ...privateNode } = node;
    expect(readHtmlMirrorNode({
      ...privateNode,
      attributes: [['role', 'combobox']],
    })).toBeDefined();
  });

  it('canonicalizes an already-inert form for source-to-receiver transport', () => {
    const graph = sanitizeMarkup(
      '<!doctype html><html><body><form id="account" inert><input></form></body></html>',
      'passive',
    );
    const form = graphElementBySourceId(graph, 'account');

    expect(form?.attributes.filter(([name]) => name === 'inert')).toEqual([
      ['inert', ''],
    ]);
    expect(readHtmlMirrorNode(graph.root)).toBeDefined();
    const identity = createReplicaIdentity({
      sessionId: 'inert-form', pageEpoch: 1, generation: 1,
      documentId: 'inert-form-document', frameId: 0, sequence: 0,
    });
    expect(checkpointFor(identity, graph, 'passive')).toBeDefined();
  });

  it('retains normalized passive imports and rejects conservative or unsafe imports', () => {
    const css = [
      '@import "../theme/base.css" layer(theme) screen and (min-width: 30rem);',
      '.hero{background-image:url("../hero.png")}',
    ].join('');
    const passive = sanitizeCss(
      css,
      'https://example.test/app/page',
      false,
      undefined,
      'passive',
    );
    const conservative = sanitizeCss(
      css,
      'https://example.test/app/page',
      false,
      undefined,
      'conservative',
    );

    expect(passive).toContain(
      '@import url("https://example.test/theme/base.css") layer(theme) screen and (min-width: 30rem);',
    );
    expect(passive).toContain(
      'url("https://example.test/hero.png")',
    );
    expect(conservative).not.toContain('@import');
    expect(conservative).toContain(
      'url("https://example.test/hero.png")',
    );
    expect(sanitizeCss(
      '@import "data:text/css,body{color:red}";.safe{display:block}',
      'https://example.test/',
      false,
      undefined,
      'passive',
    )).toBe('.safe{display:block}');
    expect(sanitizeCss(
      '@import "javascript:alert(1)";.safe{display:block}',
      'https://example.test/',
      false,
      undefined,
      'passive',
    )).toBeUndefined();
  });

  it('reports content-free fidelity outcomes and block reasons', () => {
    const passive = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeCss(
      '@import "/theme.css";.hero{background:url("/hero.png")}',
      'https://example.test/page',
      false,
      passive,
      'passive',
    )).toContain('@import url("https://example.test/theme.css")');
    expect(passive.preservedStyleSheetCount).toBeGreaterThanOrEqual(1);
    expect(passive.replicaRequestCapableResourceCount).toBeGreaterThanOrEqual(2);

    const conservative = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeCss(
      '@import "/theme.css";.safe{display:block}',
      'https://example.test/page',
      false,
      conservative,
      'conservative',
    )).toBe('.safe{display:block}');
    expect(conservative.omittedStyleSheetCount).toBe(1);
    expect(conservative.strictResourcePolicyBlockCount).toBe(1);

    const executable = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeCss(
      '.unsafe{behavior:url("legacy.htc")}',
      'https://example.test/page',
      false,
      executable,
      'passive',
    )).toBeUndefined();
    expect(executable.executionRiskBlockCount).toBe(1);

    const unsupportedImportConditions = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeCss(
      '@import "https://cdn.example.test/theme.css" supports(url("/probe"));',
      'https://example.test/page',
      false,
      unsupportedImportConditions,
      'passive',
    )).toBe('');
    expect(unsupportedImportConditions.omittedStyleSheetCount).toBe(1);
    expect(unsupportedImportConditions.strictResourcePolicyBlockCount).toBe(1);
    expect(unsupportedImportConditions.executionRiskBlockCount).toBe(0);

    const capacity = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeCss(
      `.too-large{content:"${'x'.repeat(1_100_000)}"}`,
      'https://example.test/page',
      false,
      capacity,
      'passive',
    )).toBeUndefined();
    expect(capacity.capacityOmissionCount).toBe(1);
    expect(capacity.executionRiskBlockCount).toBe(0);

    const { document, window } = parseHTML(`<!doctype html><html><body>
      <img src="blob:https://example.test/opaque">
      <svg><use href="https://assets.example.test/icons.svg#mark"></use></svg>
    </body></html>`);
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://example.test/page',
    });
    const blocked = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      blocked,
      'conservative',
    )).toBeDefined();
    expect(blocked.browserInaccessibleResourceCount).toBeGreaterThanOrEqual(1);
    expect(blocked.blockedSvgResourceCount).toBeGreaterThanOrEqual(1);
    expect(blocked.strictResourcePolicyBlockCount).toBeGreaterThanOrEqual(1);
  });

  it('does not misreport intentionally blocked CSS as browser-unreadable', () => {
    const { document, window } = parseHTML(`<!doctype html><html><head>
      <style id="blocked-sheet">a{background:url(javascript:steal())}</style>
    </head><body>
      <div id="blocked-inline"
        style="background:url(javascript:steal())">visible</div>
    </body></html>`);
    Object.defineProperty(document, 'baseURI', {
      value: 'https://example.test/page',
    });
    Object.defineProperty(document, 'adoptedStyleSheets', {
      value: [],
    });
    const representability = createHtmlMirrorRepresentabilityCollector();

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      representability,
      'conservative',
    );

    expect(attributesOf(graph!, 'blocked-inline')).not.toHaveProperty('style');
    expect(JSON.stringify(graph)).not.toContain('javascript:');
    expect(representability.strippedUnsafeResourceCount).toBe(2);
    expect(representability.executionRiskBlockCount).toBe(2);
    expect(representability.omittedStyleSheetCount).toBe(1);
    expect(representability.unreadableStyleCount).toBe(0);
    expect(representability.browserInaccessibleResourceCount).toBe(0);
  });

  it('normalizes image-set string URLs and rejects indirect or unsafe candidates', () => {
    const counters = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeCss(
      '.hero{background-image:image-set("../hero.png" 1x, url("../hero@2x.png") 2x)}',
      'https://example.test/app/page',
      false,
      counters,
      'passive',
    )).toBe(
      '.hero{background-image:image-set(url("https://example.test/hero.png") 1x, url("https://example.test/hero@2x.png") 2x)}',
    );
    expect(counters.replicaRequestCapableResourceCount).toBe(2);

    const blob = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeCss(
      '.hero{background-image:image-set("blob:https://example.test/opaque" 1x)}',
      'https://example.test/app/page',
      false,
      blob,
      'passive',
    )).toBeUndefined();
    expect(blob.browserInaccessibleResourceCount).toBe(1);

    const escapedJavascript = '.hero{background-image:image-set("java' +
      '\\' + '\n' + 'script:alert(1)" 1x)}';
    const executable = createHtmlMirrorRepresentabilityCollector();
    expect(sanitizeCss(
      escapedJavascript,
      'https://example.test/app/page',
      false,
      executable,
      'passive',
    )).toBeUndefined();
    expect(executable.executionRiskBlockCount).toBe(1);

    expect(sanitizeCss(
      '.hero{--candidate:"https://tracker.invalid/pixel";' +
      'background-image:image-set(var(--candidate) 1x)}',
      'https://example.test/app/page',
      false,
      undefined,
      'passive',
    )).toBeUndefined();
  });

  it('keeps legacy backgrounds passive and rejects forged active head resources', () => {
    const passive = sanitizeMarkup(`<!doctype html><html><head>
      <meta id="refresh" http-equiv="refresh" content="0;url=https://tracker.invalid">
      <link id="preload" rel="preload" as="image" href="https://tracker.invalid/pixel"
        imagesrcset="https://tracker.invalid/pixel-2x 2x">
    </head><body id="legacy" background="../paper.png"></body></html>`, 'passive');
    const conservative = sanitizeMarkup(
      '<!doctype html><html><body id="legacy" background="../paper.png"></body></html>',
      'conservative',
    );
    expect(attributesOf(passive, 'legacy').background).toBe(
      'https://example.test/paper.png',
    );
    expect(attributesOf(conservative, 'legacy')).not.toHaveProperty('background');
    expect(attributesOf(passive, 'refresh')).not.toHaveProperty('http-equiv');
    expect(attributesOf(passive, 'refresh')).not.toHaveProperty('content');
    expect(attributesOf(passive, 'preload')).not.toHaveProperty('rel');
    expect(attributesOf(passive, 'preload')).not.toHaveProperty('href');
    expect(attributesOf(passive, 'preload')).not.toHaveProperty('imagesrcset');

    const forgedIdentity = createReplicaIdentity({
      sessionId: 'forged-head', pageEpoch: 1, generation: 1,
      documentId: 'forged-document', frameId: 0, sequence: 0,
    });
    const checkpointWith = (child: HtmlMirrorElementNode) =>
      createHtmlMirrorCheckpoint(forgedIdentity, {
        root: {
          kind: 'element', id: 1, namespace: 'html', tagName: 'html',
          attributes: [], children: [{
            kind: 'element', id: 2, namespace: 'html', tagName: 'head',
            attributes: [], children: [child],
          }, {
            kind: 'element', id: 3, namespace: 'html', tagName: 'body',
            attributes: [], children: [],
          }],
        },
        adoptedStyleSheets: [], captureMs: 1,
        viewportWidth: 800, viewportHeight: 600,
        documentWidth: 800, documentHeight: 600,
      }, 'passive');
    expect(checkpointWith({
      kind: 'element', id: 4, namespace: 'html', tagName: 'meta',
      attributes: [
        ['http-equiv', 'refresh'],
        ['content', '0;url=https://tracker.invalid'],
      ], children: [],
    })).toBeUndefined();
    expect(checkpointWith({
      kind: 'element', id: 5, namespace: 'html', tagName: 'link',
      attributes: [
        ['rel', 'preload'],
        ['as', 'image'],
        ['href', 'https://tracker.invalid/pixel'],
      ], children: [],
    })).toBeUndefined();
    expect(checkpointWith({
      kind: 'element', id: 6, namespace: 'html', tagName: 'table',
      attributes: [['background', 'blob:https://example.test/opaque']],
      children: [],
    })).toBeUndefined();
  });

  it('preserves bounded static SVG paint servers while omitting active content', () => {
    const staticSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <defs>
        <linearGradient id="gradient"><stop offset="0" stop-color="#fff"/></linearGradient>
        <mask id="mask"><rect width="32" height="32" fill="#fff"/></mask>
        <filter id="blur"><feGaussianBlur stdDeviation="1"/></filter>
        <symbol id="glyph" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></symbol>
      </defs>
      <rect id="paint" width="32" height="32" fill="url(#gradient)" mask="url(#mask)" filter="url(#blur)"/>
      <use href="#glyph"/>
    </svg>`;
    const staticData = `data:image/svg+xml,${encodeURIComponent(staticSvg)}`;
    const activeData = `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href"/></svg>',
    )}`;
    const graph = sanitizeMarkup(`<!doctype html><html><body>
      ${staticSvg}
      <svg id="active">
        <script>globalThis.compromised=true</script>
        <foreignObject><p>active foreign content</p></foreignObject>
        <animate attributeName="href" values="#a;https://tracker.invalid/x"/>
      </svg>
      <img id="static-data" src="${staticData}">
      <img id="active-data" src="${activeData}">
    </body></html>`, 'passive');
    const json = JSON.stringify(graph);

    for (const id of ['gradient', 'mask', 'blur', 'glyph']) {
      expect(graphElementBySourceId(graph, id)).toBeDefined();
    }
    expect(attributesOf(graph, 'paint')).toMatchObject({
      fill: 'url("#gradient")',
      mask: 'url("#mask")',
      filter: 'url("#blur")',
    });
    expect(json).toContain('["href","#glyph"]');
    expect(json).not.toContain('globalThis.compromised');
    expect(json).not.toContain('active foreign content');
    expect(json).not.toContain('tracker.invalid');
    expect(attributesOf(graph, 'static-data').src).toBe(staticData);
    expect(attributesOf(graph, 'active-data')).not.toHaveProperty('src');
  });

  it('admits external SVG visuals only under Passive Fidelity', () => {
    const markup = `<!doctype html><html><body><svg>
      <defs>
        <linearGradient id="base-gradient"><stop offset="0" stop-color="#fff"/></linearGradient>
        <linearGradient id="derived-gradient" href="#base-gradient"/>
        <pattern id="base-pattern" width="1" height="1"/>
        <pattern id="derived-pattern" href="#base-pattern"/>
        <path id="label-path" d="M0 0h10"/>
        <filter id="remote-filter">
        <feImage id="remote-fe" href="https://cdn.example.test/filter.png"/>
        <feImage id="local-fe" href="#local-symbol"/>
      </filter></defs>
      <image id="remote-image" href="../art/hero.svg" width="100" height="50"/>
      <image id="local-image" href="#local-symbol" width="100" height="50"/>
      <text><textPath id="local-text-path" href="#label-path">Label</textPath></text>
      <use id="remote-use" href="https://cdn.example.test/sprite.svg#mark"/>
      <use id="local-use" href="#local-symbol"/>
      <symbol id="local-symbol"><path d="M0 0h1v1H0z"/></symbol>
    </svg></body></html>`;
    const passive = sanitizeMarkup(markup, 'passive');
    const conservative = sanitizeMarkup(markup, 'conservative');

    expect(attributesOf(passive, 'remote-fe').href)
      .toBe('https://cdn.example.test/filter.png');
    expect(attributesOf(passive, 'remote-image').href)
      .toBe('https://example.test/art/hero.svg');
    expect(attributesOf(passive, 'remote-use').href)
      .toBe('https://cdn.example.test/sprite.svg#mark');
    for (const id of ['remote-fe', 'remote-image', 'remote-use']) {
      expect(attributesOf(conservative, id)).not.toHaveProperty('href');
    }
    expect(attributesOf(passive, 'local-use').href).toBe('#local-symbol');
    expect(attributesOf(conservative, 'local-use').href).toBe('#local-symbol');
    for (const [id, reference] of [
      ['derived-gradient', '#base-gradient'],
      ['derived-pattern', '#base-pattern'],
      ['local-fe', '#local-symbol'],
      ['local-image', '#local-symbol'],
      ['local-text-path', '#label-path'],
    ] as const) {
      expect(attributesOf(passive, id).href).toBe(reference);
      expect(attributesOf(conservative, id).href).toBe(reference);
    }
    const identity = createReplicaIdentity({
      sessionId: 'svg-fragments', pageEpoch: 1, generation: 1,
      documentId: 'svg-fragments-document', frameId: 0, sequence: 0,
    });
    expect(checkpointFor(identity, passive, 'passive')).toBeDefined();
    expect(checkpointFor(identity, conservative, 'conservative')).toBeDefined();
  });

  it('flattens readable linked CSSOM into a bounded passive stylesheet hint', () => {
    const { document, window } = parseHTML(`<!doctype html><html><head>
      <link id="theme" rel="stylesheet" href="https://cdn.example.test/theme.css">
    </head><body class="page">styled</body></html>`);
    Object.defineProperty(document, 'baseURI', {
      value: 'https://example.test/app/',
    });
    const nested = fakeStyleSheet('.tokens{--surface:#111}');
    Object.defineProperty(nested, 'href', {
      value: 'https://cdn.example.test/tokens.css',
    });
    const imported = {
      cssText: '@import "./tokens.css" layer(tokens);',
      styleSheet: nested,
      layerName: 'tokens',
    };
    const pageRule = { cssText: '.page{color:var(--surface)}' };
    const outer = fakeStyleSheetRules([imported, pageRule]);
    Object.defineProperty(outer, 'href', {
      value: 'https://cdn.example.test/theme.css',
    });
    Object.defineProperty(document.querySelector('#theme')!, 'sheet', {
      configurable: true,
      value: outer,
    });

    const passive = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      createHtmlMirrorRepresentabilityCollector(),
      'passive',
    )!;
    const conservative = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      createHtmlMirrorRepresentabilityCollector(),
      'conservative',
    )!;

    expect(graphElementBySourceId(passive, 'theme')?.resolvedStyleSheetText)
      .toBe('@layer tokens{.tokens{--surface:#111}}\n.page{color:var(--surface)}');
    expect(graphElementBySourceId(conservative, 'theme')?.resolvedStyleSheetText)
      .toBeUndefined();
  });

  it('omits cyclic readable CSSOM imports instead of restoring a live request', () => {
    const { document, window } = parseHTML(
      '<!doctype html><html><head></head><body class="page">styled</body></html>',
    );
    const rootImport: { cssText: string; styleSheet?: CSSStyleSheet } = {
      cssText: '@import "https://cdn.example.test/nested.css";',
    };
    const nestedImport: { cssText: string; styleSheet?: CSSStyleSheet } = {
      cssText: '@import "https://cdn.example.test/root.css";',
    };
    const root = fakeStyleSheetRules([
      rootImport,
      { cssText: '.page{display:grid}' },
    ]);
    const nested = fakeStyleSheetRules([
      nestedImport,
      { cssText: '.nested{color:green}' },
    ]);
    rootImport.styleSheet = nested;
    nestedImport.styleSheet = root;
    Object.defineProperty(document, 'adoptedStyleSheets', {
      configurable: true,
      value: [root],
    });
    const representability = createHtmlMirrorRepresentabilityCollector();

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      representability,
      'passive',
    )!;
    const css = graph.adoptedStyleSheets.join('\n');

    expect(css).toContain('.nested{color:green}');
    expect(css).toContain('.page{display:grid}');
    expect(css).not.toContain('@import');
    expect(css).not.toContain('cdn.example.test');
    expect(representability.omittedStyleSheetCount).toBe(1);
    expect(representability.capacityOmissionCount).toBe(1);
    expect(representability.replicaRequestCapableResourceCount).toBe(0);
  });

  it('retains a normalized passive import when only nested CSSOM is unreadable', () => {
    const { document, window } = parseHTML(
      '<!doctype html><html><head></head><body class="page">styled</body></html>',
    );
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://example.test/app/',
    });
    const unreadable = {} as CSSStyleSheet;
    Object.defineProperty(unreadable, 'cssRules', {
      get: () => {
        throw new DOMException('Cross-origin CSSOM', 'SecurityError');
      },
    });
    const imported = {
      cssText: '@import "https://cdn.example.test/theme.css";',
      styleSheet: unreadable,
    };
    const root = fakeStyleSheetRules([
      imported,
      { cssText: '.page{display:grid}' },
    ]);
    Object.defineProperty(document, 'adoptedStyleSheets', {
      configurable: true,
      value: [root],
    });
    const representability = createHtmlMirrorRepresentabilityCollector();

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      representability,
      'passive',
    )!;
    const css = graph.adoptedStyleSheets.join('\n');

    expect(css).toContain(
      '@import url("https://cdn.example.test/theme.css");',
    );
    expect(css).toContain('.page{display:grid}');
    expect(representability.browserInaccessibleResourceCount).toBe(1);
    expect(representability.replicaRequestCapableResourceCount).toBe(1);
    expect(representability.omittedStyleSheetCount).toBe(0);
  });

  it('does not restore a passive import after the shared CSSOM budget exhausts', () => {
    const { document } = parseHTML(`<!doctype html><html><head>
      <style id="overflow">@import "https://cdn.example.test/overflow.css";.safe{display:grid}</style>
    </head><body></body></html>`);
    const style = document.querySelector('#overflow')!;
    Object.defineProperty(style, 'sheet', {
      configurable: true,
      value: fakeStyleSheet(
        '@import "https://cdn.example.test/overflow.css";.safe{display:grid}',
      ),
    });
    const representability = createHtmlMirrorRepresentabilityCollector();
    const styleWork = createHtmlMirrorStyleWorkBudget({ maxSheets: 1 });
    styleWork.sheets = 1;

    const [node] = sanitizeSourceSubtrees(
      [style],
      new WeakNodeIdRegistry(),
      'https://example.test/app/',
      representability,
      createHtmlMirrorReadBudget(),
      styleWork,
      'passive',
    )!;
    const serialized = JSON.stringify(node);

    expect(serialized).toContain('.safe{display:grid}');
    expect(serialized).not.toContain('@import');
    expect(serialized).not.toContain('cdn.example.test');
    expect(styleWork.exhausted).toBe(true);
    expect(representability.capacityOmissionCount).toBe(1);
    expect(representability.replicaRequestCapableResourceCount).toBe(0);
  });

  it('deep-clones into a passive typed graph while masking private text', () => {
    const { document, window } = parseHTML(`<!doctype html><html lang="ja"><head>
      <style>@import "https://tracker.invalid/a.css"; .hero{background:url('/hero.png')}</style>
      <script>globalThis.compromised = true</script>
    </head><body onclick="steal()">
      <a href="javascript:steal()">safe label</a>
      <input type="password" value="secret" placeholder="private"><button>public button</button>
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

  it('preserves a synthetic dark canvas and same-document SVG logo only', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <header>
        <svg id="brand" width="118" height="32" viewBox="0 0 118 32"
          preserveAspectRatio="xMinYMid meet" aria-hidden="true">
          <defs><linearGradient id="brand-gradient"></linearGradient><symbol id="wordmark" viewBox="0 0 118 32">
            <path d="M0 0h118v32H0z"></path>
          </symbol></defs>
          <rect id="paint" fill="url(#brand-gradient)" width="118" height="32"></rect>
          <use id="local" href="#wordmark"></use>
          <use id="legacy" xlink:href="#wordmark"></use>
          <use id="remote" href="https://tracker.invalid/sprite.svg#wordmark"></use>
        </svg>
      </header>
      <main style="overflow-y:auto"><h1>Ask anything</h1></main>
    </body></html>`);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        backgroundColor: element === document.documentElement
          ? 'rgb(0, 0, 0)'
          : 'rgba(0, 0, 0, 0)',
      }),
    });

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const serialized = JSON.stringify(graph);

    expect(graph?.root.canvasBackgroundColor).toBe('rgb(0, 0, 0)');
    expect(serialized).toContain('["width","118"]');
    expect(serialized).toContain('["height","32"]');
    expect(serialized).toContain('["viewbox","0 0 118 32"]');
    expect(serialized).toContain('["href","#wordmark"]');
    expect(serialized).toContain('["xlink:href","#wordmark"]');
    expect(serialized).toContain('["fill","url(\\"#brand-gradient\\")"]');
    expect(serialized).not.toContain('tracker.invalid');
    expect(readHtmlMirrorNode(graph?.root)).toBeDefined();

    expect(readHtmlMirrorNode({
      kind: 'element', id: 120, namespace: 'html', tagName: 'html',
      attributes: [], children: [],
      canvasBackgroundColor: 'url(https://tracker.invalid/pixel)',
    })).toBeUndefined();
    expect(readHtmlMirrorNode({
      kind: 'element', id: 121, namespace: 'svg', tagName: 'use',
      attributes: [['href', 'https://tracker.invalid/sprite.svg#wordmark']],
      children: [],
    })).toBeUndefined();
    expect(readHtmlMirrorNode({
      kind: 'element', id: 122, namespace: 'svg', tagName: 'rect',
      attributes: [['fill', 'url(javascript:alert(1))']], children: [],
    })).toBeUndefined();
  });

  it('transports only approved live native control text as typed metadata', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <input id="missing" class="query" style="width: 20rem" value="Search me"
        placeholder="ignored" name="private-name" autocomplete="off"
        title="private-title" data-account="private-data">
      <input id="search" type="search" placeholder="Search this site">
      <input id="password" type="password" value="never transport me">
      <input id="password-auto" autocomplete="section-login current-password" value="nor me">
      <input id="checkbox" type="checkbox" value="checked secret">
      <input id="aria-combobox" type="text" role="combobox" value="private combo value">
      <input id="aria-searchbox" type="search" role="searchbox" value="private search value">
      <textarea id="aria-textbox" role="textbox">private aria native value</textarea>
      <input id="aria-button" type="text" role="button" value="private activation value">
      <input id="aria-option-input" type="text" role="option" value="private menu input value">
      <textarea id="notes" placeholder="Write a note"></textarea>
      <select><option>private choice</option></select>
      <div contenteditable="true">private editor</div>
      <div role="textbox">private aria editor</div>
    </body></html>`);
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain(
      '"controlText":{"kind":"value","text":"Search me","translatable":true}',
    );
    expect(serialized).toContain(
      '"controlText":{"kind":"placeholder","text":"Search this site","translatable":true}',
    );
    expect(serialized).toContain(
      '"controlText":{"kind":"placeholder","text":"Write a note","translatable":true}',
    );
    expect(serialized).not.toContain('never transport me');
    expect(serialized).not.toContain('nor me');
    expect(serialized).not.toContain('checked secret');
    expect(serialized).not.toContain('private combo value');
    expect(serialized).not.toContain('private search value');
    expect(serialized).not.toContain('private aria native value');
    expect(serialized).not.toContain('private activation value');
    expect(serialized).not.toContain('private menu input value');
    expect(serialized).toContain('private choice');
    expect(serialized).not.toContain('private editor');
    expect(serialized).not.toContain('private aria editor');
    expect(serialized).toContain('["id","missing"]');
    expect(serialized).toContain('["class","query"]');
    expect(serialized).toContain('["style","width: 20rem"]');
    expect(serialized).not.toContain('private-name');
    expect(serialized).not.toContain('private-title');
    expect(serialized).not.toContain('private-data');
    expect(serialized).not.toContain('["autocomplete"');
    expect(serialized).not.toContain('["value"');
    expect(serialized).not.toContain('["placeholder"');
    expect(readHtmlMirrorNode(graph?.root)).toBeDefined();
    for (const role of ['combobox', 'searchbox', 'textbox', 'button']) {
      expect(readHtmlMirrorNode({
        kind: 'element', id: 80, namespace: 'html', tagName: 'input',
        attributes: [['type', 'text'], ['role', role]], children: [],
        controlText: {
          kind: 'value', text: 'forged private value', translatable: true,
        },
      })).toBeUndefined();
    }
  });

  it('leaves oversize approved control text blank and records the omission', () => {
    const { document, window } = parseHTML(
      '<!doctype html><html><body><input id="oversize" type="text" placeholder=""></body></html>',
    );
    const control = document.querySelector<HTMLInputElement>('#oversize')!;
    control.value = 'x'.repeat(MAX_HTML_MIRROR_BYTES / 8 + 1);
    const representability = createHtmlMirrorRepresentabilityCollector();
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      representability,
    );

    expect(graph).toBeDefined();
    expect(JSON.stringify(graph)).not.toContain('controlText');
    expect(representability.capacityOmissionCount).toBe(1);
  });

  it('preserves native and ARIA activation labels while masking nested values', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <button data-account="private-button-state">
        <span title="private-descendant-title" data-user="private-descendant-data">公開資料を検索する</span>
        <span>（このサイト）</span>
        <span>詳細を見る　＞</span>
        <input value="nested-private-value">
      </button>
      <article role="button" aria-label="private-aria-label">
        <span>Sample Studio</span><span>Example Workshop</span>
      </article>
    </body></html>`);
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain('公開資料を検索する');
    expect(serialized).toContain('（このサイト）');
    expect(serialized).toContain('詳細を見る　＞');
    expect(serialized).toContain('Sample Studio');
    expect(serialized).toContain('Example Workshop');
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
    expect(readHtmlMirrorNode({
      kind: 'element', id: 94, namespace: 'html', tagName: 'section',
      attributes: [['role', 'textbox']], children: [{
        kind: 'element', id: 95, namespace: 'html', tagName: 'input',
        attributes: [['type', 'text']], children: [],
        controlText: {
          kind: 'value', text: 'malicious private value', translatable: true,
        },
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
      kind: 'attributes', nodeId: 7, namespace: 'html', tagName: 'img', attributes: [],
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

  it('requires and enforces the namespace on SVG attribute patches', () => {
    const patchIdentity = createReplicaIdentity({
      sessionId: 'svg-attribute-patch', pageEpoch: 1, generation: 1,
      documentId: 'svg-attribute-document', frameId: 0, sequence: 1,
    });
    const patch = (attributes: readonly (readonly [string, string])[]) =>
      createHtmlMirrorPatch(patchIdentity, 1, 1, [{
        kind: 'attributes',
        nodeId: 7,
        namespace: 'svg',
        tagName: 'rect',
        attributes,
      }], undefined, 'passive');

    expect(patch([['fill', 'url("#gradient")']])).toBeDefined();
    for (const attributes of [
      [['filter', 'url(javascript:alert(1))']],
      [['clip-path', 'url(blob:https://example.test/opaque)']],
      [['fill', 'https://tracker.invalid/paint.svg#gradient']],
    ] as const) {
      expect(patch(attributes)).toBeUndefined();
    }
    expect(createHtmlMirrorPatch(patchIdentity, 1, 1, [{
      kind: 'attributes', nodeId: 7, tagName: 'rect', attributes: [],
    } as unknown as Parameters<typeof createHtmlMirrorPatch>[3][number]],
    undefined, 'passive')).toBeUndefined();
  });

  it('derives request-capable diagnostics again at the receiver boundary', () => {
    const identity = createReplicaIdentity({
      sessionId: 'receiver-inventory', pageEpoch: 1, generation: 1,
      documentId: 'receiver-inventory-document', frameId: 0, sequence: 0,
    });
    const checkpoint = createHtmlMirrorCheckpoint(identity, {
      root: {
        kind: 'element', id: 1, namespace: 'html', tagName: 'html',
        attributes: [], children: [{
          kind: 'element', id: 2, namespace: 'html', tagName: 'body',
          attributes: [], children: [{
            kind: 'element', id: 3, namespace: 'html', tagName: 'img',
            attributes: [['src', 'https://cdn.example.test/image.png']],
            children: [],
          }],
        }],
      },
      adoptedStyleSheets: [],
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 600,
    });
    expect(checkpoint?.payload.representability)
      .toMatchObject({ replicaRequestCapableResourceCount: 1 });
    const forgedZero = {
      ...checkpoint!,
      payload: {
        ...checkpoint!.payload,
        representability: {
          ...checkpoint!.payload.representability,
          replicaRequestCapableResourceCount: 0,
        },
      },
    };
    expect(readHtmlMirrorSourceMessage(forgedZero, identity, 'conservative'))
      .toMatchObject({
        payload: {
          representability: { replicaRequestCapableResourceCount: 1 },
        },
      });
  });

  it('transports a bounded standards-or-quirks document mode', () => {
    const { document, window } = parseHTML('<html><body>legacy</body></html>');
    Object.defineProperty(document, 'compatMode', {
      configurable: true,
      value: 'BackCompat',
    });
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    )!;
    expect(graph.documentMode).toBe('quirks');
    const identity = createReplicaIdentity({
      sessionId: 'quirks-mode', pageEpoch: 1, generation: 1,
      documentId: 'quirks-mode-document', frameId: 0, sequence: 0,
    });
    const checkpoint = createHtmlMirrorCheckpoint(identity, {
      root: graph.root,
      adoptedStyleSheets: graph.adoptedStyleSheets,
      documentMode: graph.documentMode,
      captureMs: 1,
      viewportWidth: graph.viewportWidth,
      viewportHeight: graph.viewportHeight,
      documentWidth: graph.documentWidth,
      documentHeight: graph.documentHeight,
    });
    expect(checkpoint?.payload.documentMode).toBe('quirks');
    expect(readHtmlMirrorSourceMessage({
      ...checkpoint!,
      payload: { ...checkpoint!.payload, documentMode: 'standards' },
    }, identity)).toBeUndefined();
    expect(createHtmlMirrorCheckpoint(identity, {
      root: graph.root,
      adoptedStyleSheets: graph.adoptedStyleSheets,
      documentMode: 'limited-quirks' as unknown as 'standards',
      captureMs: 1,
      viewportWidth: graph.viewportWidth,
      viewportHeight: graph.viewportHeight,
      documentWidth: graph.documentWidth,
      documentHeight: graph.documentHeight,
    })).toBeUndefined();
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
      <section role="option textbox"><span>public menu fallback</span></section>
      <section role="textbox option"><span>private menu fallback</span></section>
    </body></html>`);
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain('public activation fallback');
    expect(serialized).not.toContain('private input fallback');
    expect(serialized).toContain('public menu fallback');
    expect(serialized).not.toContain('private menu fallback');
    expect(readHtmlMirrorNode(graph?.root)).toBeDefined();
  });

  it('admits synthetic static SVG data images symmetrically and rejects active SVG', () => {
    const syntheticLogo = "data:image/svg+xml,%3csvg%20width='48'%20height='48'%20viewBox='0%200%2048%2048'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M4.25%204.25H43.75V43.75H4.25Z'%20fill='%236C5CE7'/%3e%3cpath%20d='M12.5%2034C15.5%2024.25%2019.75%201.2e1%2024%2012C28.25%2012%2032.5%2024.25%2035.5%2034Z'%20fill='white'/%3e%3c/svg%3e";
    const hostile = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.invalid/a.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://tracker.invalid/p)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\\72l(h\\74tps://tracker.invalid/p)"/></svg>',
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "https://tracker.invalid/x">]><svg xmlns="http://www.w3.org/2000/svg"/>',
      `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(65)}${'</g>'.repeat(65)}</svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(513)}</svg>`,
      '<svg xmlns="http://www.w3.org/2000/svg" width="999999999999999999999" height="48"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><filter><feTurbulence numOctaves="999999999"/></filter></svg>',
      `<svg xmlns="http://www.w3.org/2000/svg"><filter>${'<feFlood/>'.repeat(65)}</filter></svg>`,
    ].map((svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`);
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <img id="logo" src="${syntheticLogo}">
      ${hostile.map((src, index) => `<img id="bad-${index}" src="${src}">`).join('')}
    </body></html>`);
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    );
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain(syntheticLogo);
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

    const representability = createHtmlMirrorRepresentabilityCollector();
    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      representability,
    );
    const json = JSON.stringify(graph);

    expect(json).toContain(
      'data:image/png;base64,AAAA 1x, https://example.test/safe.png 2x',
    );
    expect(json).not.toContain('https://example.test/gallery/AAAA');
    expect(json).not.toContain('javascript:');
    expect(representability.replicaRequestCapableResourceCount).toBe(1);
    expect(representability.executionRiskBlockCount).toBe(1);
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

  it('diagnoses every rejected responsive-image candidate without content', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <img id="responsive-mixed" srcset="/safe.png 1x, blob:https://example.test/opaque 2x,
        javascript:steal() 3x, /bad.png nonsense">
    </body></html>`);
    Object.defineProperty(document, 'baseURI', {
      value: 'https://example.test/gallery/',
    });
    const representability = createHtmlMirrorRepresentabilityCollector();

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      representability,
    );
    const srcset = Object.fromEntries(
      graphElementBySourceId(graph!, 'responsive-mixed')?.attributes ?? [],
    ).srcset;
    const serialized = JSON.stringify(graph);

    expect(srcset).toBe('https://example.test/safe.png 1x');
    expect(serialized).toContain('https://example.test/safe.png 1x');
    expect(serialized).not.toContain('opaque');
    expect(serialized).not.toContain('javascript:');
    expect(serialized).not.toContain('bad.png');
    expect(representability.replicaRequestCapableResourceCount).toBe(1);
    expect(representability.browserInaccessibleResourceCount).toBe(1);
    expect(representability.executionRiskBlockCount).toBe(1);
    expect(representability.strictResourcePolicyBlockCount).toBe(1);
    expect(representability.strippedUnsafeResourceCount).toBe(3);
  });

  it('blocks request-bearing attribution and legacy image attributes twice', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <img id="tracked" src="/safe.png"
        attributionsrc="https://tracker-a.invalid/ https://tracker-b.invalid/"
        lowsrc="https://tracker-c.invalid/low.gif"
        sharedstoragewritable browsingtopics>
    </body></html>`);
    Object.defineProperty(document, 'baseURI', {
      value: 'https://example.test/page',
    });
    const representability = createHtmlMirrorRepresentabilityCollector();

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      representability,
      'passive',
    );
    const attributes = attributesOf(graph!, 'tracked');

    expect(attributes.src).toBe('https://example.test/safe.png');
    expect(attributes).not.toHaveProperty('attributionsrc');
    expect(attributes).not.toHaveProperty('lowsrc');
    expect(attributes).not.toHaveProperty('sharedstoragewritable');
    expect(attributes).not.toHaveProperty('browsingtopics');
    expect(representability.replicaRequestCapableResourceCount).toBe(1);
    expect(representability.strippedActiveAttributeCount).toBe(4);
    expect(representability.strictResourcePolicyBlockCount).toBe(4);
    for (const name of [
      'attributionsrc',
      'browsingtopics',
      'lowsrc',
      'sharedstoragewritable',
    ]) {
      expect(readHtmlMirrorNode({
        kind: 'element', id: 90, namespace: 'html', tagName: 'img',
        attributes: [[name, 'https://tracker.invalid/pixel']], children: [],
      })).toBeUndefined();
    }
  });

  it('strips SVG base-URL overrides before preserving local fragments', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <svg id="icon" xml:base="https://tracker.invalid/assets/">
        <defs><symbol id="mark"><path d="M0 0h1v1z"/></symbol></defs>
        <use href="#mark"/>
      </svg>
    </body></html>`);
    Object.defineProperty(document, 'baseURI', {
      value: 'https://example.test/page',
    });
    const representability = createHtmlMirrorRepresentabilityCollector();

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      representability,
      'passive',
    );
    const serialized = JSON.stringify(graph);

    expect(serialized).not.toContain('xml:base');
    expect(serialized).not.toContain('tracker.invalid');
    expect(serialized).toContain('#mark');
    expect(representability.strictResourcePolicyBlockCount).toBe(1);
    expect(readHtmlMirrorNode({
      kind: 'element', id: 91, namespace: 'svg', tagName: 'svg',
      attributes: [['xml:base', 'https://tracker.invalid/assets/']],
      children: [],
    }, undefined, 0, undefined, false, false, false, false, false, 'passive'))
      .toBeUndefined();
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
    const validAttributePatch = createHtmlMirrorPatch(
      patchIdentity,
      1,
      1,
      [{
        kind: 'attributes', nodeId: 2, namespace: 'html', tagName: 'body',
        attributes: [['class', 'page']],
      }],
    );
    expect(validAttributePatch).toBeDefined();
    expect(readHtmlMirrorSourceMessage({
      ...validAttributePatch,
      operations: [{
        kind: 'attributes', nodeId: 2, namespace: 'html', tagName: 'body',
        attributes: [['sharedstoragewritable', '']],
      }],
    }, identity))
      .toBeUndefined();
    expect(readHtmlMirrorSourceMessage({
      ...checkpoint,
      payload: { ...checkpoint?.payload, byteLength: 1 },
    }, identity)).toBeUndefined();
  });

  it('masks private ancestors and rejects malicious private transport canaries', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <section role="textbox"><span title="secret title" data-secret="secret data">secret text</span></section>
      <section contenteditable="true"><select><option label="secret label">secret choice</option></select></section>
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
      documentMode: checkpoint?.payload.documentMode,
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

  it('validates resolved canvas colors on live dimension patches', () => {
    const identity = createReplicaIdentity({
      sessionId: 'canvas-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'canvas-document',
      frameId: 0,
      sequence: 1,
    });
    const dimensions = {
      kind: 'dimensions' as const,
      viewportWidth: 1200,
      viewportHeight: 700,
      documentWidth: 1200,
      documentHeight: 2400,
      canvasBackgroundColor: 'rgb(0, 0, 0)',
    };

    expect(createHtmlMirrorPatch(identity, 1, 1, [dimensions])?.operations)
      .toEqual([dimensions]);
    expect(createHtmlMirrorPatch(identity, 1, 1, [{
      ...dimensions,
      canvasBackgroundColor: 'url(https://tracker.invalid/canvas.png)',
    }])).toBeUndefined();
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

  it('counts the emitted resolved stylesheet resource exactly once', () => {
    const { document, window } = parseHTML(`<!doctype html><html><head>
      <style id="theme">.x{background:url('/x.png')}</style>
    </head><body class="x"></body></html>`);
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://example.test/app/',
    });
    Object.defineProperty(document.querySelector('#theme'), 'sheet', {
      configurable: true,
      value: fakeStyleSheet('.x{background:url("/x.png")}'),
    });
    const representability = createHtmlMirrorRepresentabilityCollector();

    const graph = sanitizeSourceDocument(
      document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      representability,
      'passive',
    );

    expect(graphElementBySourceId(graph!, 'theme')?.resolvedStyleSheetText)
      .toContain('https://example.test/x.png');
    expect(representability.replicaRequestCapableResourceCount).toBe(1);
    expect(representability.preservedStyleSheetCount).toBe(1);
  });

  it('shares one bounded CSSOM work budget across ordinary style elements', () => {
    const { document } = parseHTML(`<!doctype html><html><head>
      <style id="first">.first{color:red}</style>
      <style id="second">.second{color:blue}</style>
    </head><body></body></html>`);
    const first = document.querySelector('#first')!;
    const second = document.querySelector('#second')!;
    Object.defineProperty(first, 'sheet', {
      configurable: true,
      value: fakeStyleSheet('.first{color:red}'),
    });
    Object.defineProperty(second, 'sheet', {
      configurable: true,
      value: fakeStyleSheet('.second{color:blue}'),
    });
    const work = createHtmlMirrorStyleWorkBudget({
      maxSheets: 1,
      maxRules: 10,
      maxCharacters: 1_000,
    });
    const representability = createHtmlMirrorRepresentabilityCollector();

    expect(sanitizeSourceElementHints(
      first,
      'https://example.test/',
      representability,
      'passive',
      work,
    ).resolvedStyleSheetText).toBe('.first{color:red}');
    expect(sanitizeSourceElementHints(
      second,
      'https://example.test/',
      representability,
      'passive',
      work,
    ).resolvedStyleSheetText).toBeUndefined();
    expect(work.sheets).toBe(1);
    expect(representability.capacityOmissionCount).toBe(1);
  });

  it('preserves meaningful CSS escapes while still removing escaped imports', () => {
    const css = '@\\69m/**/port url("https://tracker.invalid/a.css");' +
      '.sm\\:hidden{display:none}.bullet::before{content:"\\2022"}';

    expect(sanitizeCss(css, 'https://example.com/')).toBe(
      '.sm\\:hidden{display:none}.bullet::before{content:"\\2022"}',
    );
  });

  it('rewrites executable CSS URLs without altering quoted strings', () => {
    const css = [
      '.help::before{content:"url(https://example.test/help) /* literal */ javascript:"}',
      '[data-example="javascript:alert(1)"]{content:"/* still text */"}',
      '.hero{background-image:url("/hero.png")}',
    ].join('');

    expect(sanitizeCss(css, 'https://example.test/app/')).toBe([
      '.help::before{content:"url(https://example.test/help) /* literal */ javascript:"}',
      '[data-example="javascript:alert(1)"]{content:"/* still text */"}',
      '.hero{background-image:url("https://example.test/hero.png")}',
    ].join(''));
  });

  it('keeps bounded same-document CSS fragments local without weakening URL checks', () => {
    const css = [
      '.logo{fill:url(#brand-gradient)}',
      '.masked{mask:url("#brand-mask");clip-path:url(\'#brand-clip\')}',
      String.raw`.filtered{filter:url(\23 brand-filter)}`,
      '.remote{filter:url("https://assets.example.test/icons.svg#shadow")}',
    ].join('');

    const sanitized = sanitizeCss(css, 'https://source.example.test/page');
    expect(sanitized).toBe([
      '.logo{fill:url("#brand-gradient")}',
      '.masked{mask:url("#brand-mask");clip-path:url("#brand-clip")}',
      '.filtered{filter:url("#brand-filter")}',
      '.remote{filter:url("https://assets.example.test/icons.svg#shadow")}',
    ].join(''));
    expect(sanitizeCss(sanitized!, 'about:blank')).toBe(sanitized);
    expect(sanitizeCss(
      '.invalid{fill:url("#bad fragment")}',
      'https://source.example.test/page',
    )).toBe('.invalid{fill:none}');
  });

  it('keeps behavior-suffixed layout properties but blocks legacy behavior declarations', () => {
    const layoutUtilityCss = [
      'html{scroll-behavior:smooth}',
      '.viewport{overscroll-behavior-y:contain;display:flex;min-height:100vh}',
      '.media{max-width:100%;object-fit:contain}',
    ].join('');

    expect(sanitizeCss(layoutUtilityCss, 'https://example.com/')).toBe(
      layoutUtilityCss,
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

function fakeStyleSheetRules(
  rules: readonly { readonly cssText: string }[],
  disabled = false,
  mediaText = '',
): CSSStyleSheet {
  return {
    disabled,
    media: { mediaText },
    cssRules: {
      ...Object.fromEntries(rules.map((rule, index) => [index, rule])),
      length: rules.length,
      item: (index: number) => rules[index] ?? null,
    },
  } as unknown as CSSStyleSheet;
}

function sanitizeMarkup(
  markup: string,
  fidelityPolicy: 'passive' | 'conservative',
): HtmlMirrorDocumentGraph {
  const { document, window } = parseHTML(markup);
  Object.defineProperty(document, 'baseURI', {
    configurable: true,
    value: 'https://example.test/app/page',
  });
  const graph = sanitizeSourceDocument(
    document,
    window as unknown as Window,
    new WeakNodeIdRegistry(),
    createHtmlMirrorRepresentabilityCollector(),
    fidelityPolicy,
  );
  if (!graph) throw new Error('Expected the test mirror graph to serialize.');
  return graph;
}

function graphElementBySourceId(
  graph: HtmlMirrorDocumentGraph,
  sourceId: string,
): HtmlMirrorElementNode | undefined {
  const stack: HtmlMirrorElementNode[] = [graph.root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.attributes.some(
      ([name, value]) => name === 'id' && value === sourceId,
    )) return current;
    for (const child of current.children) {
      if (child.kind === 'element') stack.push(child);
    }
    for (const child of current.shadowRoot?.children ?? []) {
      if (child.kind === 'element') stack.push(child);
    }
  }
  return undefined;
}

function graphElementsByTag(
  graph: HtmlMirrorDocumentGraph,
  tagName: string,
): HtmlMirrorElementNode[] {
  const matches: HtmlMirrorElementNode[] = [];
  const pending: HtmlMirrorElementNode[] = [graph.root];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (current.tagName === tagName) matches.push(current);
    for (const child of current.children) {
      if (child.kind === 'element') pending.push(child);
    }
    for (const child of current.shadowRoot?.children ?? []) {
      if (child.kind === 'element') pending.push(child);
    }
  }
  return matches;
}

function attributesOf(
  graph: HtmlMirrorDocumentGraph,
  sourceId: string,
): Record<string, string> {
  return Object.fromEntries(
    graphElementBySourceId(graph, sourceId)?.attributes ?? [],
  );
}

function checkpointFor(
  identity: Parameters<typeof createHtmlMirrorCheckpoint>[0],
  graph: HtmlMirrorDocumentGraph,
  fidelityPolicy: 'passive' | 'conservative',
) {
  return createHtmlMirrorCheckpoint(identity, {
    root: graph.root,
    adoptedStyleSheets: graph.adoptedStyleSheets,
    captureMs: 1,
    viewportWidth: graph.viewportWidth,
    viewportHeight: graph.viewportHeight,
    documentWidth: graph.documentWidth,
    documentHeight: graph.documentHeight,
  }, fidelityPolicy);
}
