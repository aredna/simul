import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import {
  beginSourceWithheldAncestorWalk,
  createHtmlMirrorRepresentabilityCollector,
  createSourceBaseReadPolicy,
  noteSourceEditingTarget,
  readHtmlMirrorNode,
  readSourceSkippedContentState,
  sanitizeCss,
  sanitizeSourceAttributes,
  sanitizeSourceDocument,
  sourceAttributeList,
  sourceBaseTextIsPublic,
  sourceChildNodeList,
  sourceLocalName,
  sourceNodeType,
  type HtmlMirrorDocumentGraph,
  type HtmlMirrorElementNode,
  type HtmlMirrorNode,
} from '../lib/replica/html-mirror-sanitizer';
import { WeakNodeIdRegistry } from '../lib/replica/html-mirror-source';
import {
  beginSourceSecretAncestorWalk,
  createSourceControlledContentPolicy,
} from '../lib/replica/source-privacy-policy';
import { applySourcePrivacyFiltersOff } from '../lib/replica/source-privacy-mode';
import { installSourceShadowRootReader } from '../lib/replica/source-shadow-root';
import { closedRootReader } from './support/closed-shadow-roots';

/** The open items of D181 on the page side of the mirror channel. */
describe('the mirror channel\'s reading of the page (D181)', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
    });
  });
  afterEach(() => applySourcePrivacyFiltersOff(false));

  function read(markup: string, prepare?: (document: Document) => void) {
    const { document, window } = parseHTML(markup);
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://example.test/app/page',
    });
    prepare?.(document as unknown as Document);
    const graph = sanitizeSourceDocument(
      document as unknown as Document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      createHtmlMirrorRepresentabilityCollector(),
      'passive',
    );
    if (!graph) throw new Error('Expected the test mirror graph to serialize.');
    const at = (id: string) =>
      document.getElementById(id) as unknown as Element;
    const sent = (id: string) =>
      Object.fromEntries(graphElementBySourceId(graph, id)?.attributes ?? []);
    return { document: document as unknown as Document, window, graph, at, sent };
  }

  it('carries the state a component reflects on an element that is no form control and holds no value', () => {
    const { graph, at, sent } = read(`<!doctype html><html><body>
      <sp-tab-panel id="panel" role="tabpanel" selected>Panel text</sp-tab-panel>
      <x-check id="check" checked></x-check>
      <x-button id="off" disabled>Off</x-button>
      <nav><a id="current" aria-current="page" href="/a">Here</a></nav>
      <ul><li id="item" selected>Item</li></ul>
      <x-slider id="valued" selected value="3"></x-slider>
      <x-meter id="aria-valued" disabled aria-valuenow="4"></x-meter>
      <input id="box" type="checkbox" checked disabled>
      <fieldset id="set" disabled><legend>Set</legend></fieldset>
      <div id="tab" role="tab" selected aria-current="true">Tab</div>
      <div role="listbox"><div id="in-menu" selected aria-current="true">Row</div></div>
      <div contenteditable="true"><span id="edited" selected>Draft</span></div>
      <p id="aria" aria-selected="true" aria-checked="true" aria-pressed="true">Words</p>
    </body></html>`);
    expect(sent('panel')).toMatchObject({ selected: '' });
    expect(sent('check')).toMatchObject({ checked: '' });
    expect(sent('off')).toMatchObject({ disabled: '' });
    expect(sent('current')).toMatchObject({ 'aria-current': 'page' });
    expect(sent('item')).toMatchObject({ selected: '' });
    // A native control, an element that holds a value, and a region whose
    // attributes are private keep them withheld.
    expect(sent('valued')).not.toHaveProperty('selected');
    expect(sent('aria-valued')).not.toHaveProperty('disabled');
    expect(sent('box')).not.toHaveProperty('checked');
    expect(sent('box')).not.toHaveProperty('disabled');
    expect(sent('set')).not.toHaveProperty('disabled');
    expect(sent('tab')).not.toHaveProperty('selected');
    expect(sent('tab')).not.toHaveProperty('aria-current');
    expect(sent('in-menu')).not.toHaveProperty('selected');
    expect(sent('in-menu')).not.toHaveProperty('aria-current');
    expect(sent('edited')).not.toHaveProperty('selected');
    // The rest of ARIA's state stays the semantic channel's.
    expect(Object.keys(sent('aria'))).toEqual(['id']);
    // The panel takes the graph, and refuses the state where it is private.
    expect(readHtmlMirrorNode(graph.root, new Set(), 0, undefined, false,
      false, false, false, false, 'passive')).toBeDefined();
    const node = (tagName: string, attributes: [string, string][]) => ({
      kind: 'element', id: 7, namespace: 'html', tagName, attributes, children: [],
    });
    expect(readHtmlMirrorNode(node('x-tab', [['selected', '']]))).toBeDefined();
    expect(readHtmlMirrorNode(node('input', [['checked', '']]))).toBeUndefined();
    expect(readHtmlMirrorNode(node('div', [['role', 'tab'], ['selected', '']])))
      .toBeUndefined();
    // An attribute patch reads the same.
    expect(Object.fromEntries(sanitizeSourceAttributes(at('panel'))!))
      .toMatchObject({ selected: '' });
    expect(Object.fromEntries(sanitizeSourceAttributes(at('box'))!))
      .not.toHaveProperty('checked');
  });

  describe('an attribute Chrome does not read', () => {
    /**
     * linkedom holds one attribute of a name and no namespace: a second one
     * is put on under another spelling and then named as the page has it.
     */
    function put(
      element: Element,
      name: string,
      value: string,
      namespace: string | null,
      localName = name,
    ): void {
      const spelling = `${name.toUpperCase()}-${Math.random().toString(36).slice(2)}`;
      element.setAttribute(spelling, value);
      const attribute = element.getAttributeNode(spelling)!;
      Object.defineProperty(attribute, 'name', { value: name });
      Object.defineProperty(attribute, 'namespaceURI', { value: namespace });
      Object.defineProperty(attribute, 'localName', { value: localName });
      element.hasAttributeNS = (ns: string | null, local: string): boolean =>
        [...element.attributes].some((each) =>
          (each.namespaceURI ?? null) === ns && each.localName === local);
    }
    const markup = `<!doctype html><html><body>
      <p id="upper">Upper</p>
      <p id="spaced">Spaced</p>
      <p id="plain" class="k" title="T">Plain</p>
      <svg><use id="script-href"></use><use id="real-href"></use><rect id="rect"></rect></svg>
    </body></html>`;
    function prepare(document: Document): void {
      const at = (id: string) => document.getElementById(id)!;
      // `setAttributeNS(null, 'CLASS', …)`
      put(at('upper'), 'CLASS', 'x', null);
      // Beside the one Chrome reads, as before.
      put(at('plain'), 'CLASS', 'y', null);
      put(at('spaced'), 'class', 'q', 'urn:x');
      // `setAttribute('xlink:href', …)` on an SVG element: no namespace.
      put(at('script-href'), 'xlink:href', '#shape', null);
      put(at('real-href'), 'xlink:href', '#shape', 'http://www.w3.org/1999/xlink', 'href');
      // `setAttribute('viewbox', …)` on an SVG element keeps the lowercase.
      put(at('rect'), 'viewbox', '0 0 1 1', null);
      put(at('rect'), 'xml:space', 'preserve', 'http://www.w3.org/XML/1998/namespace', 'space');
    }

    it('stays behind in an HTML document', () => {
      const { sent } = read(markup, prepare);
      expect(sent('upper')).toEqual({ id: 'upper' });
      expect(sent('spaced')).toEqual({ id: 'spaced' });
      expect(sent('plain')).toEqual({ id: 'plain', class: 'k', title: 'T' });
      expect(sent('script-href')).toEqual({ id: 'script-href' });
      expect(sent('real-href')).toEqual({ id: 'real-href', 'xlink:href': '#shape' });
      // An attribute of the XML namespace keeps its old way.
      expect(sent('rect')).toEqual({ id: 'rect', 'xml:space': 'preserve' });
    });

    it('travels as it did in an XHTML document', () => {
      const { sent } = read(markup, (document) => {
        Object.defineProperty(document, 'contentType', {
          configurable: true,
          value: 'application/xhtml+xml',
        });
        prepare(document);
      });
      expect(sent('upper')).toEqual({ id: 'upper', class: 'x' });
      expect(sent('spaced')).toEqual({ id: 'spaced', class: 'q' });
      expect(sent('script-href')).toEqual({ id: 'script-href', 'xlink:href': '#shape' });
      expect(sent('rect')).toMatchObject({ viewbox: '0 0 1 1' });
    });
  });

  describe('a style text read as the browser reads it', () => {
    it('keeps a comment between `/` and `*` from opening another', () => {
      expect(sanitizeCss('*//**/*/ .a{color:red}', 'about:blank'))
        .toBe('*/ */ .a{color:red}');
    });

    it('ends a string at a line break in a style attribute and reads on', () => {
      const style = 'content: "a\ncolor: blue; background: url(x.png)';
      const sanitized = sanitizeCss(style, 'https://example.test/app/', true);
      // The address after the cut string is made absolute; the declaration
      // the string stood in stays invalid, as it is in the tab.
      expect(sanitized).toBe(
        'content: !\ncolor: blue; background: url("https://example.test/app/x.png")',
      );
      expect(sanitizeCss(sanitized!, 'about:blank', true)).toBe(sanitized);
      expect(sanitizeCss(
        "font-family: 'x\nwidth: 1px; background: expression(alert(1))",
        'about:blank',
        true,
      )).toBeUndefined();
      // A sheet that a line break cuts in a string is still refused whole.
      expect(sanitizeCss('.a{content:"a\n}', 'about:blank')).toBeUndefined();
    });

    it('closes a comment, a url( and a string that a style attribute ends in', () => {
      const cases: Array<[string, string]> = [
        ['color: rgb(0, 0, 200); /* note', 'color: rgb(0, 0, 200); '],
        ['color: blue; background: url(a.png',
          'color: blue; background: url("https://example.test/app/a.png")'],
        ['color: blue; content: "abc', 'color: blue; content: "abc"'],
      ];
      for (const [style, expected] of cases) {
        const sanitized = sanitizeCss(style, 'https://example.test/app/', true);
        expect(sanitized, style).toBe(expected);
        expect(sanitizeCss(sanitized!, 'about:blank', true), style).toBe(sanitized);
      }
      // A sheet is read as before.
      expect(sanitizeCss('.a{color:red} /* note', 'about:blank')).toBeUndefined();
    });
  });

  it('asks about the regions above an element once for a flush', () => {
    const depth = 60;
    const { document, window } = parseHTML(
      `<!doctype html><html><body>${'<div>'.repeat(depth)}x${'</div>'.repeat(depth)}</body></html>`,
    );
    restoreComputedStyle(window);
    let asked = 0;
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        asked += 1;
        return {
          display: 'block',
          visibility: 'visible',
          getPropertyValue: () => '',
        } as unknown as CSSStyleDeclaration;
      },
    });
    const policy = createSourceControlledContentPolicy(
      document as unknown as Document,
    );
    const nest = [...document.querySelectorAll('div')] as unknown as Element[];
    // As the flush does: one answer an element about secrets, too.
    const secretWalk = beginSourceSecretAncestorWalk();
    const walk = beginSourceWithheldAncestorWalk();
    try {
      for (const element of nest) {
        element.setAttribute('title', 'T');
        expect(sanitizeSourceAttributes(
          element,
          'https://example.test/',
          undefined,
          'passive',
          policy,
        )).toEqual([['title', 'T']]);
      }
    } finally {
      walk.end();
      secretWalk.end();
    }
    // Each element, and the two above the nest, once: not once for every
    // element below it.
    expect(asked).toBeLessThanOrEqual(3 * depth);
    // Outside a walk nothing is kept.
    asked = 0;
    sanitizeSourceAttributes(nest.at(-1)!, 'https://example.test/', undefined, 'passive', policy);
    expect(asked).toBeGreaterThanOrEqual(depth);
  });

  it('withholds title, alt and aria-label inside a closed panel with a control', () => {
    const markup = (expanded: boolean) => `<!doctype html><html><body>
      <button aria-expanded="${expanded}" aria-controls="panel">Open</button>
      <div id="panel">
        <img id="picture" src="https://example.test/a.png" alt="Alt words" title="Title words">
        <span id="named" aria-label="Label words" class="c">x</span>
      </div>
      <img id="outside" alt="Outside words">
    </body></html>`;
    const closed = read(markup(false));
    expect(closed.sent('picture')).not.toHaveProperty('alt');
    expect(closed.sent('picture')).not.toHaveProperty('title');
    expect(closed.sent('named')).toEqual({ id: 'named', class: 'c' });
    expect(closed.sent('outside')).toMatchObject({ alt: 'Outside words' });
    for (const words of ['Alt words', 'Title words', 'Label words']) {
      expect(JSON.stringify(closed.graph)).not.toContain(words);
    }
    // An attribute patch inside the closed panel reads the same.
    closed.at('named').setAttribute('aria-label', 'Later words');
    expect(Object.fromEntries(sanitizeSourceAttributes(closed.at('named'))!))
      .toEqual({ id: 'named', class: 'c' });
    // With no control around them, they travel.
    const free = read(markup(false).replace(' aria-controls="panel"', ''));
    expect(free.sent('picture')).toMatchObject({ alt: 'Alt words', title: 'Title words' });
    expect(free.sent('named')).toMatchObject({ 'aria-label': 'Label words' });
  });

  describe('an editor made without the contenteditable attribute', () => {
    it('withholds what a document in design mode holds', () => {
      const { graph } = read(`<!doctype html><html><body><p>Typed in design mode</p></body></html>`,
        (document) => {
          Object.defineProperty(document, 'designMode', { configurable: true, value: 'on' });
        });
      expect(JSON.stringify(graph)).not.toContain('Typed in design mode');
    });

    it('withholds what an element typed into without the attribute holds', () => {
      const { document, window } = parseHTML(`<!doctype html><html><body>
        <main><div id="editor"><p id="line">Typed text</p></div><p>Page text</p></main>
        <div id="attributed" contenteditable="true"><p id="inside">Draft</p></div>
        <p id="plain">Plain</p>
      </body></html>`);
      const at = (id: string) => document.getElementById(id) as unknown as Element;
      const serialize = () => JSON.stringify(sanitizeSourceDocument(
        document as unknown as Document,
        window as unknown as Window,
        new WeakNodeIdRegistry(),
      ));
      expect(serialize()).toContain('Typed text');
      // `-webkit-user-modify: read-write` in a page's style: Chrome 158
      // answers `isContentEditable` false there, and takes typing.
      restoreComputedStyle(window);
      const computed = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
      Object.defineProperty(window, 'getComputedStyle', {
        configurable: true,
        value: (element: Element) => ({
          getPropertyValue: (name: string) =>
            name === '-webkit-user-modify' &&
              (element === at('editor') || element === at('line'))
              ? 'read-write'
              : '',
        }),
      });
      // Not editable, or an editor the attribute makes: nothing new.
      expect(noteSourceEditingTarget(at('plain'))).toBeUndefined();
      expect(noteSourceEditingTarget(at('inside'))).toBeUndefined();
      // The outermost element of the editable run is the editor.
      expect(noteSourceEditingTarget(at('line'))).toBe(at('editor'));
      expect(noteSourceEditingTarget(at('line'))).toBeUndefined();
      if (computed) Object.defineProperty(window, 'getComputedStyle', computed);
      else Reflect.deleteProperty(window, 'getComputedStyle');
      const after = serialize();
      expect(after).not.toContain('Typed text');
      expect(after).toContain('Page text');
      const policy = createSourceBaseReadPolicy(document as unknown as Document);
      expect(sourceBaseTextIsPublic(at('line').firstChild!, policy)).toBe(false);
      // "Show everything (testing)" reads it.
      applySourcePrivacyFiltersOff(true);
      expect(serialize()).toContain('Typed text');
    });
  });

  describe('an element\'s own properties, past a form\'s field names', () => {
    /**
     * A form answers `form.<name of one of its fields>` before its own DOM
     * properties. Chrome reads `localName` and `nodeType` through the
     * prototype's accessors, where linkedom keeps them on the element.
     */
    function shadowedForm(name: string) {
      const { document, window } = parseHTML(`<!doctype html><html><body>
        <form id="booking" class="f"><input name="first"><p id="note">Form text</p><input id="field"></form>
        <p id="after">After text</p>
      </body></html>`);
      const form = document.getElementById('booking')!;
      const field = document.getElementById('field')!;
      field.setAttribute('name', name);
      const prototype = Object.getPrototypeOf(form) as object;
      Object.setPrototypeOf(form, Object.create(prototype, {
        localName: { configurable: true, get: () => 'form' },
        nodeType: { configurable: true, get: () => 1 },
      }));
      delete (form as { localName?: string }).localName;
      delete (form as { nodeType?: number }).nodeType;
      Object.defineProperty(form, name, { configurable: true, value: field });
      return { document, window, form: form as unknown as Element };
    }

    it('reads them by the prototypes\' accessors', () => {
      for (const name of ['attributes', 'localName', 'childNodes', 'nodeType']) {
        const { form } = shadowedForm(name);
        expect(sourceNodeType(form), name).toBe(1);
        expect(sourceLocalName(form), name).toBe('form');
        expect([...sourceAttributeList(form)].map(({ name: each }) => each), name)
          .toEqual(['id', 'class']);
        expect(sourceChildNodeList(form).length, name).toBe(3);
      }
    });

    it('reads a form with a field named attributes', () => {
      const { document, window, form } = shadowedForm('attributes');
      const graph = sanitizeSourceDocument(
        document as unknown as Document,
        window as unknown as Window,
        new WeakNodeIdRegistry(),
        createHtmlMirrorRepresentabilityCollector(),
        'passive',
      )!;
      const serialized = JSON.stringify(graph);
      expect(serialized).toContain('Form text');
      expect(serialized).toContain('After text');
      expect(graphElementBySourceId(graph, 'booking')?.attributes)
        .toEqual([['id', 'booking'], ['class', 'f']]);
      expect(sanitizeSourceAttributes(form))
        .toEqual([['id', 'booking'], ['class', 'f']]);
    });
  });

  describe('a child that no slot takes', () => {
    function component(mode: 'open' | 'closed' | 'unknown', slotted: boolean) {
      const { document, window } = parseHTML(`<!doctype html><html><body>
        <x-card id="host"><p id="child">child text</p>direct text</x-card>
        <p>page text</p>
      </body></html>`);
      const host = document.getElementById('host')!;
      const reader = closedRootReader();
      const markup = '<div><slot name="title"></slot></div><p>root text</p>';
      const root = mode === 'open'
        ? host.attachShadow({ mode: 'open' })
        : reader.attach(host, markup);
      if (mode === 'open') root.innerHTML = markup;
      if (mode !== 'unknown') installSourceShadowRootReader(document, reader.read);
      const slot = root.querySelector('slot')!;
      if (slotted) document.getElementById('child')!.setAttribute('slot', 'title');
      for (const node of host.childNodes) {
        // Chrome reads null for a node slotted into a closed root too.
        const assigned = mode === 'open' && slotted &&
          (node as Element).getAttribute?.('slot') === 'title';
        Object.defineProperty(node, 'assignedSlot', {
          configurable: true,
          value: assigned ? slot : null,
        });
      }
      const serialized = JSON.stringify(sanitizeSourceDocument(
        document as unknown as Document,
        window as unknown as Window,
        new WeakNodeIdRegistry(),
      ));
      const policy = createSourceBaseReadPolicy(document as unknown as Document);
      return {
        serialized,
        childIsPublic: sourceBaseTextIsPublic(
          document.getElementById('child')!.firstChild as unknown as Node,
          policy,
        ),
      };
    }

    it('is withheld where an open root says so', () => {
      const none = component('open', false);
      expect(none.serialized).not.toContain('child text');
      expect(none.serialized).not.toContain('direct text');
      expect(none.serialized).toContain('root text');
      expect(none.serialized).toContain('page text');
      expect(none.childIsPublic).toBe(false);
      const taken = component('open', true);
      expect(taken.serialized).toContain('child text');
      expect(taken.serialized).not.toContain('direct text');
      expect(taken.childIsPublic).toBe(true);
    });

    it('is withheld where the slot of a closed root is worked out', () => {
      const none = component('closed', false);
      expect(none.serialized).not.toContain('child text');
      expect(none.serialized).not.toContain('direct text');
      expect(none.childIsPublic).toBe(false);
      const taken = component('closed', true);
      expect(taken.serialized).toContain('child text');
      expect(taken.childIsPublic).toBe(true);
    });

    it('is read as its host is where no reader knows the root', () => {
      const unknown = component('unknown', false);
      expect(unknown.serialized).toContain('child text');
      expect(unknown.serialized).toContain('direct text');
      expect(unknown.childIsPublic).toBe(true);
    });
  });

  it('sends a dropdown\'s class and id for the panel\'s stand-in', () => {
    const { graph, sent } = read(`<!doctype html><html><body>
      <div class="form-floating"><select id="pick" class="form-select" name="n"><option>A</option></select></div>
    </body></html>`);
    expect(sent('pick')).toEqual({ id: 'pick', class: 'form-select' });
    expect(readHtmlMirrorNode(graph.root, new Set(), 0, undefined, false,
      false, false, false, false, 'passive')).toBeDefined();
  });

  it('holds a place for what the reader leaves out, so siblings count as in the tab', () => {
    const { graph } = read(`<!doctype html><html><head><script>var head = 1;</script></head><body>
      <ul id="list"><script>var inline = 2;</script><li id="first">One</li><template><p>kept for later</p></template><li>Two</li></ul>
      <p id="framed"><iframe src="https://example.test/ad"></iframe><object data="x.swf">fallback words</object><embed src="x"><audio src="a.mp3"></audio><noscript><b>no scripts</b></noscript></p>
    </body></html>`);
    const serialized = JSON.stringify(graph);
    for (const words of ['var head', 'var inline', 'kept for later', 'fallback words', 'no scripts', 'example.test/ad']) {
      expect(serialized, words).not.toContain(words);
    }
    const list = graphElementBySourceId(graph, 'list')!;
    const elements = list.children.filter((child) => child.kind === 'element') as HtmlMirrorElementNode[];
    expect(elements).toHaveLength(4);
    expect(elements[0]).toMatchObject({ opaquePlaceholder: true, attributes: [], children: [] });
    expect(elements[0]!.tagName).toMatch(/^simul-/u);
    expect(elements[2]).toMatchObject({ opaquePlaceholder: true });
    const framed = graphElementBySourceId(graph, 'framed')!;
    expect(framed.children.filter((child) =>
      child.kind === 'element' && child.opaquePlaceholder)).toHaveLength(5);
    expect(readHtmlMirrorNode(graph.root, new Set(), 0, undefined, false,
      false, false, false, false, 'passive')).toBeDefined();
  });

  it('holds no place in a dropdown or a drawing', () => {
    const { graph } = read(`<!doctype html><html><body>
      <select id="s"><script>1</script><option>A</option><optgroup label="g"><template>t</template><option>B</option></optgroup></select>
      <svg id="g"><script>2</script><circle r="1"/></svg>
    </body></html>`);
    const held: string[] = [];
    const walk = (node: HtmlMirrorNode, path: string): void => {
      if (node.kind !== 'element') return;
      if (node.opaquePlaceholder) held.push(path);
      for (const child of node.children) walk(child, `${path}>${node.tagName}`);
    };
    walk(graph.root, '');
    expect(held).toEqual([]);
    expect(readHtmlMirrorNode(graph.root, new Set(), 0, undefined, false,
      false, false, false, false, 'passive')).toBeDefined();
  });

  it('reads <noscript> as an ordinary element where the tab runs no scripts', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
    onTestFinished(() => {
      if (previous) Object.defineProperty(globalThis, 'matchMedia', previous);
      else Reflect.deleteProperty(globalThis, 'matchMedia');
    });
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query.includes('scripting: none') }),
    });
    const { graph } = read(`<!doctype html><html><body>
      <noscript id="ns"><p>Turn scripts on</p></noscript>
    </body></html>`);
    expect(graphElementBySourceId(graph, 'ns')?.tagName).toBe('noscript');
    expect(JSON.stringify(graph)).toContain('Turn scripts on');
    expect(readHtmlMirrorNode(graph.root, new Set(), 0, undefined, false,
      false, false, false, false, 'passive')).toBeDefined();
  });

  it('lets a page\'s rules for its alerts match the role the mirror keeps', () => {
    const cases: Array<[string, string]> = [
      ['[role="alert"]{color:red}',
        ':is([role="alert"],[data-simul-page-role="alert"]){color:red}'],
      ['.a[role=alertdialog] > p{x:1}',
        '.a:is([role=alertdialog],[data-simul-page-role=alertdialog]) > p{x:1}'],
      ['div:not([role~=alert i]){x:1}',
        'div:not(:is([role~=alert i],[data-simul-page-role~=alert i])){x:1}'],
      ['[role]{x:1}', ':is([role],[data-simul-page-role]){x:1}'],
      // Not a selector, another role, or a string: as it was.
      ['.g{grid-template-columns:[role] 1fr}', '.g{grid-template-columns:[role] 1fr}'],
      ['[role=button]{x:1}', '[role=button]{x:1}'],
      ['.x{content:"[role=alert]{"}', '.x{content:"[role=alert]{"}'],
    ];
    for (const [css, expected] of cases) {
      const sanitized = sanitizeCss(css, 'about:blank', false, undefined, 'passive');
      expect(sanitized, css).toBe(expected);
      expect(sanitizeCss(sanitized!, 'about:blank', false, undefined, 'passive'), css)
        .toBe(sanitized);
    }
  });

  it('tells what a closed details or content-visibility: hidden draws nothing of', () => {
    const { document, window } = parseHTML(`<!doctype html><html><body>
      <details id="closed"><summary id="summary">Sum</summary><p id="inner">In</p><input id="field"></details>
      <details id="open" open><summary>Sum</summary><p id="open-inner">In</p></details>
      <div id="skipping"><span id="skipped">S</span></div>
      <p id="plain">P</p>
    </body></html>`);
    // The page's own text in a closed details keeps travelling.
    const graph = sanitizeSourceDocument(
      document as unknown as Document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      createHtmlMirrorRepresentabilityCollector(),
      'passive',
    );
    expect(JSON.stringify(graph)).toContain('"In"');
    restoreComputedStyle(window);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        getPropertyValue: (name: string) =>
          name === 'content-visibility' && element.id === 'skipping' ? 'hidden' : 'visible',
      }),
    });
    const state = (id: string) =>
      readSourceSkippedContentState(document.getElementById(id) as unknown as Element);
    expect(state('closed')).toEqual({ skipped: false, skipsText: true });
    expect(state('summary')).toEqual({ skipped: false, skipsText: false });
    expect(state('inner')).toEqual({ skipped: true, skipsText: false });
    expect(state('field')).toEqual({ skipped: true, skipsText: false });
    expect(state('open')).toEqual({ skipped: false, skipsText: false });
    expect(state('open-inner')).toEqual({ skipped: false, skipsText: false });
    expect(state('skipping')).toEqual({ skipped: false, skipsText: true });
    expect(state('skipped')).toEqual({ skipped: true, skipsText: false });
    expect(state('plain')).toEqual({ skipped: false, skipsText: false });
  });
});

/** linkedom's windows share their properties: put the page's style back. */
function restoreComputedStyle(window: object): void {
  const previous = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
  onTestFinished(() => {
    if (previous) Object.defineProperty(window, 'getComputedStyle', previous);
    else Reflect.deleteProperty(window, 'getComputedStyle');
  });
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
