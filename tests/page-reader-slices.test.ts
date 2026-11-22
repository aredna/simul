import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { createSliceClock } from '../lib/browser-scheduling';
import { applyHtmlMirrorLimitSettings } from '../lib/replica/html-mirror-limits';
import {
  assembleHtmlMirrorCheckpoint,
  createHtmlMirrorCheckpoint,
  createHtmlMirrorCheckpointPart,
  decodeHtmlMirrorWireMessage,
  encodeHtmlMirrorWireMessage,
  HtmlMirrorCheckpointAssembly,
  readHtmlMirrorCheckpointPart,
  readHtmlMirrorSourceMessage,
  type HtmlMirrorCheckpointPart,
} from '../lib/replica/html-mirror-protocol';
import {
  beginSourceDocumentRead,
  createHtmlMirrorRepresentabilityCollector,
  sanitizeSourceDocument,
  sanitizeSourcePreview,
  type HtmlMirrorCheckpointFill,
  type HtmlMirrorElementNode,
  type HtmlMirrorNode,
  type HtmlMirrorRepresentabilityCollector,
  type SourceDocumentReadIndexRoot,
  type SourceDocumentReadValues,
} from '../lib/replica/html-mirror-sanitizer';
import { WeakNodeIdRegistry } from '../lib/replica/html-mirror-source';
import { createReplicaIdentity } from '../lib/replica/replica-identity';
import { createSourceControlledContentPolicy } from '../lib/replica/source-privacy-policy';
import {
  installSourceShadowRootReader,
  readSourceShadowRoot,
} from '../lib/replica/source-shadow-root';
import { SourceVisibilityBoundaryIndex } from '../lib/replica/source-visibility-boundary';
import { closedRootReader } from './support/closed-shadow-roots';

beforeEach(() => {
  // The readers ask `Node` for node types, as the page's own global.
  const { window } = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, {
    Node: window.Node,
    Element: window.Element,
    Text: window.Text,
  });
});

const IDENTITY = createReplicaIdentity({
  sessionId: 'slices-session', pageEpoch: 1, generation: 1,
  documentId: 'slices-document', frameId: 0, sequence: 3,
});

const LONG_ARTICLE = Array.from({ length: 12 }, (_, index) =>
  `<p id="para-${index}">Paragraph ${index} <b>bold ${index}</b> and <a href="/p${index}">a link</a></p>`).join('');

const PAGE = '<!doctype html><html lang="en"><head><title>Slices</title>' +
  '<style>p { color: red } .note::before { content: "n" }</style></head><body>' +
  '<header id="top"><nav><a href="/a">A</a> <a href="/b">B</a></nav></header>' +
  '<main id="main">' +
  '<section id="s1"><h2 id="s1-title">One</h2><p>First <b>bold</b> text</p>' +
  '<section id="s1a"><p>Nested <i>deep <u>deeper</u></i></p>' +
  '<ul><li>a</li><li>b</li><li>c</li></ul></section></section>' +
  '<section id="s2"><form id="form"><label>Name ' +
  '<input id="name" type="text" value="visible value"></label>' +
  '<input id="pw" type="password" value="hunter2">' +
  '<select id="sel"><option>One</option><optgroup label="g">' +
  '<option selected>Two</option></optgroup></select>' +
  '<textarea id="ta">typed</textarea></form></section>' +
  '<div id="hidden" hidden><p>Hidden text <b>x</b></p></div>' +
  '<div id="none" class="gone"><p>None text <i>y</i></p></div>' +
  '<button id="toggle" aria-controls="panel" aria-expanded="false">Toggle</button>' +
  '<div id="panel"><p>Panel text <b>z</b></p></div>' +
  '<x-open id="open"><span slot="a">slotted A</span><span>default slotted</span></x-open>' +
  '<x-closed id="closed"><em slot="b">slotted B</em><em>closed default</em></x-closed>' +
  '<section id="s3"><div id="later"><p>Before <input id="turn" type="text" value="swordfish"></p></div></section>' +
  `<article id="long">${LONG_ARTICLE}</article>` +
  '</main><footer id="foot"><p>Foot <a href="/c">C</a></p></footer></body></html>';

interface Page {
  readonly document: Document;
  readonly window: Window;
  readonly byId: (id: string) => Element;
}

/** Every element of the page, through open and closed roots. */
function allElements(document: Document): Element[] {
  const elements: Element[] = [];
  const visit = (parent: Node): void => {
    for (const child of parent.childNodes) {
      if (child.nodeType !== 1) continue;
      elements.push(child as Element);
      visit(child);
      const shadow = readSourceShadowRoot(child as Element);
      if (shadow) visit(shadow);
    }
  };
  visit(document);
  return elements;
}

/**
 * Gives every element a box (`data-top` and `data-height` place it, 40 px
 * high at the top otherwise) and the window a computed style: `hidden` and
 * `.gone` are `display: none`, `data-display` says the rest.
 */
function paint(document: Document, window: Window): void {
  for (const element of allElements(document)) {
    const top = Number(element.getAttribute('data-top') ?? 0);
    const height = Number(element.getAttribute('data-height') ?? 40);
    const rect = {
      x: 0, y: top, left: 0, top, right: 320, bottom: top + height,
      width: 320, height, toJSON: () => ({}),
    } as DOMRect;
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => Object.assign([rect], { item: (i: number) => i === 0 ? rect : null }),
    });
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect,
    });
  }
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => {
      const hidden = element.hasAttribute('hidden') ||
        element.getAttribute('class') === 'gone';
      const display = hidden
        ? 'none'
        : element.getAttribute('data-display') ??
          (['span', 'b', 'i', 'u', 'a', 'em', 'label'].includes(element.localName)
            ? 'inline'
            : 'block');
      return {
        display,
        visibility: 'visible',
        opacity: '1',
        overflowX: 'visible',
        overflowY: 'visible',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        getPropertyValue: (name: string) => {
          if (name === '-webkit-text-security') return 'none';
          if (name === 'content-visibility') return 'visible';
          if (name === 'clip') return 'auto';
          if (name === 'clip-path') return 'none';
          if (name.startsWith('overflow')) return 'visible';
          return '';
        },
      };
    },
  });
  onTestFinished(() => {
    // linkedom's windows share one object: leave none of this to the next.
    delete (window as unknown as Record<string, unknown>).getComputedStyle;
  });
}

function page(markup = PAGE): Page {
  const { document, window } = parseHTML(markup);
  void document.head;
  const open = document.querySelector('#open')!.attachShadow({ mode: 'open' });
  open.innerHTML =
    '<style>:host { display: block }</style><div class="wrap">' +
    '<slot name="a"></slot><p id="open-own">open own <b>text</b></p><slot></slot></div>';
  const reader = closedRootReader();
  reader.attach(
    document.querySelector('#closed')!,
    '<div hidden><slot name="b"></slot></div><p id="closed-own">closed own <b>b</b></p>' +
      '<slot></slot><input id="closed-pw" type="password" value="hush">',
  );
  installSourceShadowRootReader(document as unknown as Document, reader.read);
  paint(document as unknown as Document, window as unknown as Window);
  return {
    document: document as unknown as Document,
    window: window as unknown as Window,
    byId: (id: string) => allElements(document as unknown as Document)
      .find((element) => element.id === id)!,
  };
}

/** A clock that moves a millisecond each time it is read: see sliced-page-scans. */
function steppingClock(budgetMs: number, between: (turn: number) => void = () => {}) {
  let time = 0;
  let turns = 0;
  return createSliceClock({
    budgetMs,
    now: () => (time += 1),
    yield: async () => {
      turns += 1;
      between(turns);
    },
  });
}

interface SlicedRead {
  readonly outcome: 'done' | 'restart' | 'overflow' | 'failed';
  readonly root?: HtmlMirrorElementNode;
  readonly fills: HtmlMirrorCheckpointFill[];
  readonly steps: Array<{
    readonly fills: readonly HtmlMirrorCheckpointFill[];
    readonly indexRoots: readonly SourceDocumentReadIndexRoot[];
    readonly deferred: ReadonlySet<Element>;
    readonly skippedUnits: number;
  }>;
  readonly values?: SourceDocumentReadValues;
  readonly representability: HtmlMirrorRepresentabilityCollector;
  readonly yields: number;
}

async function readInSlices(
  target: Page,
  registry: WeakNodeIdRegistry,
  budgetMs: number,
  afterStep: (fills: readonly HtmlMirrorCheckpointFill[]) => void = () => {},
  between: (turn: number) => void = () => {},
): Promise<SlicedRead> {
  const clock = steppingClock(budgetMs, between);
  const read = beginSourceDocumentRead(target.document, target.window, registry, {
    controlledContent: createSourceControlledContentPolicy(
      target.document,
      target.window,
    ),
  });
  const fills: HtmlMirrorCheckpointFill[] = [];
  const steps: SlicedRead['steps'] = [];
  let root: HtmlMirrorElementNode | undefined;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const step = read.step(clock);
    if (step.outcome !== 'continue' && step.outcome !== 'done') {
      return {
        outcome: step.outcome, fills, steps,
        representability: read.representability, yields: clock.yields,
      };
    }
    root ??= step.root;
    fills.push(...step.fills);
    steps.push(step);
    afterStep(step.fills);
    if (step.outcome === 'done') {
      return {
        outcome: 'done', root, fills, steps, values: step.document,
        representability: read.representability, yields: clock.yields,
      };
    }
    await clock.next();
  }
  throw new Error('The read did not end.');
}

/** Puts each fill into its shell: what the panel's assembly does, on raw graphs. */
function fillGraph(
  root: HtmlMirrorElementNode,
  fills: readonly HtmlMirrorCheckpointFill[],
): HtmlMirrorElementNode {
  // A list read over several fills: each but the last says `more`.
  const byId = new Map<number, readonly HtmlMirrorNode[]>();
  const ended = new Set<number>();
  for (const fill of fills) {
    expect(ended.has(fill.nodeId), `filled after its end: ${fill.nodeId}`).toBe(false);
    if (!fill.more) ended.add(fill.nodeId);
    byId.set(fill.nodeId, [...byId.get(fill.nodeId) ?? [], ...fill.children]);
  }
  expect([...byId.keys()].every((id) => ended.has(id)), 'every list ends').toBe(true);
  const used = new Set<number>();
  const take = (id: number): readonly HtmlMirrorNode[] => {
    const children = byId.get(id);
    expect(children, `no fill for ${id}`).toBeDefined();
    used.add(id);
    return children!;
  };
  const visit = (node: HtmlMirrorNode): HtmlMirrorNode => {
    if (node.kind === 'text') return node;
    const { childrenFollow, shadowRoot, ...rest } = node;
    const children = (childrenFollow ? take(node.id) : node.children).map(visit);
    let filledRoot = shadowRoot;
    if (shadowRoot) {
      const { childrenFollow: rootFollows, ...rootRest } = shadowRoot;
      filledRoot = {
        ...rootRest,
        children: (rootFollows ? take(shadowRoot.id) : shadowRoot.children).map(visit),
      };
    }
    return { ...rest, children, ...(filledRoot ? { shadowRoot: filledRoot } : {}) };
  };
  const filled = visit(root) as HtmlMirrorElementNode;
  expect(used.size, 'every fill is used').toBe(byId.size);
  return filled;
}

function oneTaskRead(target: Page, registry: WeakNodeIdRegistry) {
  const representability = createHtmlMirrorRepresentabilityCollector();
  const graph = sanitizeSourceDocument(
    target.document,
    target.window,
    registry,
    representability,
    'conservative',
    createSourceControlledContentPolicy(target.document, target.window),
  )!;
  expect(graph).toBeDefined();
  return { graph, representability };
}

function countShells(node: HtmlMirrorNode): number {
  if (node.kind === 'text') return 0;
  return (node.childrenFollow ? 1 : 0) + (node.shadowRoot?.childrenFollow ? 1 : 0) +
    node.children.reduce((total, child) => total + countShells(child), 0) +
    (node.shadowRoot?.children ?? []).reduce((total, child) => total + countShells(child), 0);
}

function findElement(
  node: HtmlMirrorNode,
  sourceId: string,
): HtmlMirrorElementNode | undefined {
  if (node.kind === 'text') return undefined;
  if (node.attributes.some(([name, value]) => name === 'id' && value === sourceId)) {
    return node;
  }
  for (const child of [...node.children, ...(node.shadowRoot?.children ?? [])]) {
    const found = findElement(child, sourceId);
    if (found) return found;
  }
  return undefined;
}

/** The parts a page would send for a read: one part per step that filled. */
function partsOf(read: SlicedRead): HtmlMirrorCheckpointPart[] {
  const parts: HtmlMirrorCheckpointPart[] = [];
  for (const step of read.steps) {
    if (step.fills.length === 0) continue;
    const part = createHtmlMirrorCheckpointPart(IDENTITY, parts.length, step.fills);
    expect(part).toBeDefined();
    parts.push(part!);
  }
  return parts;
}

describe('the page read in slices (D163)', () => {
  it('reads in units what the one-task read reads, at every forced boundary', async () => {
    for (const budget of [1, 2, 3, 7, 40]) {
      const target = page();
      const registry = new WeakNodeIdRegistry();
      const sliced = await readInSlices(target, registry, budget);
      expect(sliced.outcome).toBe('done');
      const assembled = fillGraph(sliced.root!, sliced.fills);
      const reference = oneTaskRead(target, registry);
      expect(assembled, `budget ${budget}`).toEqual(reference.graph.root);
      expect(sliced.values!.adoptedStyleSheets).toEqual(reference.graph.adoptedStyleSheets);
      expect(sliced.values!.documentMode).toBe(reference.graph.documentMode);
      expect(sliced.representability, `budget ${budget}`)
        .toEqual(reference.representability);
      if (budget < 40) {
        expect(sliced.yields, `budget ${budget}`).toBeGreaterThan(3);
        expect(countShells(sliced.root!)).toBeGreaterThan(0);
      }
      if (budget === 1) {
        // Both roots, open and closed, came as units of their own.
        for (const host of ['open', 'closed']) {
          const shadow = readSourceShadowRoot(target.byId(host))!;
          const shadowId = registry.getId(shadow);
          expect(sliced.fills.some((fill) => fill.nodeId === shadowId), host).toBe(true);
        }
      }
    }
  });

  it('keeps every privacy decision of the one-task read in the parts', async () => {
    const target = page();
    const registry = new WeakNodeIdRegistry();
    const sliced = await readInSlices(target, registry, 1);
    const json = JSON.stringify([sliced.root, sliced.fills]);
    for (const text of ['hunter2', 'hush', 'Hidden text', 'None text', 'typed']) {
      expect(json, text).not.toContain(text);
    }
    for (const text of ['Nested', 'deeper', 'open own', 'closed own', 'Paragraph 11']) {
      expect(json, text).toContain(text);
    }
    // A dropdown and a style sheet are never cut, nor anything in them.
    const root = fillGraph(sliced.root!, sliced.fills);
    const form = findElement(root, 'form')!;
    const select = form.children.find((child) =>
      child.kind === 'element' && child.tagName === 'select') as HtmlMirrorElementNode;
    expect(select.children.length).toBeGreaterThan(0);
    const shellIds = new Set(sliced.fills.map((fill) => fill.nodeId));
    const neverCut = (node: HtmlMirrorNode, inside: boolean): void => {
      if (node.kind === 'text') return;
      const protectedHere = inside || node.tagName === 'select' || node.tagName === 'style';
      if (protectedHere) expect(shellIds.has(node.id), node.tagName).toBe(false);
      for (const child of node.children) neverCut(child, protectedHere);
      for (const child of node.shadowRoot?.children ?? []) neverCut(child, protectedHere);
    };
    neverCut(root, false);
  });

  it('gives fills and shells that pass the checks, and assembles to the one-task checkpoint', async () => {
    for (const budget of [1, 3]) {
      const target = page();
      const registry = new WeakNodeIdRegistry();
      const sliced = await readInSlices(target, registry, budget);
      const reference = oneTaskRead(target, registry);
      const values = {
        captureMs: 1,
        viewportWidth: sliced.values!.viewportWidth,
        viewportHeight: sliced.values!.viewportHeight,
        documentWidth: sliced.values!.documentWidth,
        documentHeight: sliced.values!.documentHeight,
        documentMode: sliced.values!.documentMode,
      };
      const expected = createHtmlMirrorCheckpoint(IDENTITY, {
        root: reference.graph.root,
        adoptedStyleSheets: reference.graph.adoptedStyleSheets,
        ...values,
        representability: reference.representability,
      })!;
      expect(expected).toBeDefined();

      // The page's own check, part by part, with totals.
      const assembly = new HtmlMirrorCheckpointAssembly();
      expect(assembly.readRoot(sliced.root)).toBeDefined();
      const checkedParts: HtmlMirrorCheckpointPart[] = [];
      for (const step of sliced.steps) {
        if (step.fills.length === 0) continue;
        const part = createHtmlMirrorCheckpointPart(
          IDENTITY, checkedParts.length, step.fills, 'conservative', assembly,
        );
        expect(part).toBeDefined();
        checkedParts.push(part!);
      }
      expect(assembly.readAdoptedStyleSheets(sliced.values!.adoptedStyleSheets)).toBeDefined();
      expect(assembly.pendingShells).toBe(0);
      const shell = assembly.shellCheckpoint(IDENTITY, {
        ...values,
        representability: sliced.representability,
      }, checkedParts.length)!;
      expect(shell).toBeDefined();
      expect(shell.payload.partCount).toBe(checkedParts.length);
      expect(assembly.assembledCheckpoint(IDENTITY, {
        ...values,
        representability: sliced.representability,
      })).toEqual(expected);

      // The panel: each message checked as it arrives, over the wire, and
      // assembled whatever the order of the parts.
      const overWire = <T,>(message: T): unknown =>
        decodeHtmlMirrorWireMessage(JSON.parse(JSON.stringify(
          encodeHtmlMirrorWireMessage(message),
        )));
      const received = readHtmlMirrorSourceMessage(overWire(shell), IDENTITY);
      expect(received?.kind).toBe('simul:html-mirror-v2:checkpoint');
      const parts = partsOf(sliced).map((part) =>
        readHtmlMirrorCheckpointPart(overWire(part), IDENTITY)!);
      expect(parts.every(Boolean)).toBe(true);
      const assembled = assembleHtmlMirrorCheckpoint(
        received as Extract<typeof received, { kind: 'simul:html-mirror-v2:checkpoint' }>,
        [...parts].reverse(),
      );
      expect(assembled).toEqual(expected);
    }
  });

  it('builds the index of what is painted in the same pieces, equal to the whole build', async () => {
    for (const budget of [1, 2, 7]) {
      const target = page();
      const registry = new WeakNodeIdRegistry();
      const build = SourceVisibilityBoundaryIndex.beginBuild(
        target.document, target.window, 10_000,
      );
      const sliced = await readInSlices(target, registry, budget);
      for (const step of sliced.steps) {
        for (const indexRoot of step.indexRoots) {
          build.add(indexRoot.element, {
            includeSelf: indexRoot.includeSelf,
            stopAt: step.deferred,
          });
        }
      }
      const built = build.finish();
      const whole = new SourceVisibilityBoundaryIndex(
        target.document, target.window, 10_000,
      );
      expect(built.hasSameStatesAs(whole), `budget ${budget}`).toBe(true);
      // And it is no copy that agrees with anything: a page without the
      // last section differs.
      const shorter = new SourceVisibilityBoundaryIndex(
        target.document, target.window, 10_000,
      );
      target.byId('foot').remove();
      shorter.refreshAll();
      expect(built.hasSameStatesAs(shorter)).toBe(false);
    }
  });

  it('stops the index at the node bound, as the whole build does', () => {
    const target = page();
    const build = SourceVisibilityBoundaryIndex.beginBuild(target.document, target.window, 20);
    build.add(target.document.documentElement, { stopAt: new Set([target.byId('main')]) });
    build.add(target.byId('main'), { includeSelf: false });
    expect(build.overflow).toBe(true);
    const whole = new SourceVisibilityBoundaryIndex(target.document, target.window, 20);
    expect(build.finish().hasSameStatesAs(whole)).toBe(false);
    expect(whole.refreshWithin([]).overflow).toBe(true);
  });

  it('restarts when a node read already moves into a part not read yet', async () => {
    const target = page();
    const registry = new WeakNodeIdRegistry();
    const s1 = registry.getId(target.byId('s1'));
    const long = registry.getId(target.byId('long'));
    let moved = false;
    const sliced = await readInSlices(target, registry, 1, (fills) => {
      if (moved || !fills.some((fill) => fill.nodeId === s1)) return;
      // The heading was read with #s1; #long is not read yet.
      expect(fills.some((fill) => fill.nodeId === long)).toBe(false);
      target.byId('long').append(target.byId('s1-title'));
      moved = true;
    });
    expect(moved).toBe(true);
    expect(sliced.outcome).toBe('restart');
  });

  it('skips a unit whose element left, and reads what changed before its turn as it is', async () => {
    const target = page();
    const registry = new WeakNodeIdRegistry();
    const s3 = registry.getId(target.byId('s3'));
    const later = registry.getId(target.byId('later'));
    const long = registry.getId(target.byId('long'));
    let changed = false;
    let removed = false;
    const sliced = await readInSlices(target, registry, 1, (fills) => {
      if (!changed && fills.some((fill) => fill.nodeId === s3)) {
        expect(fills.some((fill) => fill.nodeId === later)).toBe(false);
        // #later is a shell not read yet: its field becomes a password field.
        target.byId('turn').setAttribute('type', 'password');
        changed = true;
      }
      const longShell = fills.some((fill) => fill.children.some((child) =>
        child.kind === 'element' && child.id === long && child.childrenFollow));
      if (!removed && longShell) {
        expect(fills.some((fill) => fill.nodeId === long)).toBe(false);
        // And the article, a shell already, leaves the page before its turn.
        target.byId('long').remove();
        removed = true;
      }
    });
    expect(changed).toBe(true);
    expect(removed).toBe(true);
    expect(sliced.outcome).toBe('done');
    const root = fillGraph(sliced.root!, sliced.fills);
    const field = findElement(root, 'turn')!;
    expect(Object.fromEntries(field.attributes)).toMatchObject({ type: 'password' });
    expect(field.attributes.some(([name]) => name === 'value')).toBe(false);
    expect(JSON.stringify([sliced.root, sliced.fills])).not.toContain('swordfish');
    // The article's shell is filled empty; the live path patches its parent.
    expect(findElement(root, 'long')!.children).toEqual([]);
    expect(sliced.steps.reduce((total, step) => total + step.skippedUnits, 0))
      .toBe(1);
    expect(JSON.stringify([sliced.root, sliced.fills])).not.toContain('Paragraph');
  });

  it('gives the capacity omission of the one-task read over the node limit', async () => {
    const markup = '<html><body><main>' +
      Array.from({ length: 700 }, (_, index) => `<p>row ${index}</p>`).join('') +
      '</main></body></html>';
    const target = page(markup.replace('<main>', '<main><x-open id="open"></x-open><x-closed id="closed"></x-closed>'));
    applyHtmlMirrorLimitSettings({ itemMegabytes: 10, pageMegabytes: 60, maxElements: 1_000 });
    try {
      const registry = new WeakNodeIdRegistry();
      const clock = steppingClock(3);
      const read = beginSourceDocumentRead(target.document, target.window, registry, {
        controlledContent: createSourceControlledContentPolicy(
          target.document, target.window, 100_000,
        ),
      });
      let outcome = 'continue';
      for (let guard = 0; guard < 10_000 && (outcome === 'continue'); guard += 1) {
        outcome = read.step(clock).outcome;
        await clock.next();
      }
      expect(outcome).toBe('overflow');
      expect(read.representability.capacityOmissionCount).toBeGreaterThan(0);
      expect(read.finished).toBe(true);
      expect(read.step(clock).outcome).toBe('failed');
    } finally {
      applyHtmlMirrorLimitSettings();
    }
  });

  it('reads a small page in one step when the slice does not run out', () => {
    const target = page();
    const registry = new WeakNodeIdRegistry();
    const read = beginSourceDocumentRead(target.document, target.window, registry);
    const step = read.step({ expired: () => false });
    expect(step.outcome).toBe('done');
    if (step.outcome !== 'done') return;
    expect(step.fills).toEqual([]);
    expect(countShells(step.root!)).toBe(0);
    expect(step.root).toEqual(oneTaskRead(target, registry).graph.root);
  });
});

describe('the preview (D163)', () => {
  it('stands boxes of their height in for far blocks and reads the near ones', () => {
    const markup = PAGE
      .replace('<section id="s3">', '<section id="s3" data-top="5000" data-height="321.4">')
      .replace('<article id="long">', '<article id="long" data-top="9000" data-height="2000">')
      .replace('<footer id="foot">', '<footer id="foot" data-top="-3000" data-height="10">')
      .replace('<div id="hidden" hidden>', '<div id="hidden" hidden data-top="7000">');
    const target = page(markup);
    const viewport = {
      innerWidth: 1200,
      innerHeight: 800,
      getComputedStyle: target.window.getComputedStyle,
    } as unknown as Window;
    const registry = new WeakNodeIdRegistry();
    const preview = sanitizeSourcePreview(target.document, viewport, registry, {
      controlledContent: createSourceControlledContentPolicy(target.document, target.window),
    })!;
    expect(preview).toBeDefined();
    const s3 = findElement(preview.root, 's3')!;
    // One box for the far blocks in a row (D169): from the top of `s3` to
    // the bottom of the article after it.
    expect(s3.placeholder).toEqual({ height: 9000 + 2000 - 5000 });
    expect(s3.children).toEqual([]);
    expect(findElement(preview.root, 'long')).toBeUndefined();
    // Above the viewport by more than its height too.
    expect(findElement(preview.root, 'foot')!.placeholder).toEqual({ height: 10 });
    // Near blocks are read as the whole read reads them.
    const full = oneTaskRead(target, registry).graph;
    expect(findElement(preview.root, 's1')).toEqual(findElement(full.root, 's1'));
    expect(findElement(preview.root, 'open')).toEqual(findElement(full.root, 'open'));
    // `display: none` has no box: a box of no height, whose text the whole
    // read withholds anyway (D171).
    expect(findElement(preview.root, 'hidden')).toMatchObject({
      placeholder: { height: 0 },
      children: [],
    });
    expect(findElement(full.root, 'hidden')!.children.length).toBeGreaterThan(0);
    const json = JSON.stringify(preview);
    expect(json).not.toContain('swordfish');
    expect(json).not.toContain('Paragraph 3');
    expect(json).not.toContain('hunter2');
    // The checks accept it as a preview only.
    const values = {
      captureMs: 1, viewportWidth: preview.viewportWidth,
      viewportHeight: preview.viewportHeight, documentWidth: preview.documentWidth,
      documentHeight: preview.documentHeight,
    };
    expect(createHtmlMirrorCheckpoint(IDENTITY, {
      root: preview.root, adoptedStyleSheets: preview.adoptedStyleSheets, ...values,
    })).toBeUndefined();
    const checkpoint = createHtmlMirrorCheckpoint(IDENTITY, {
      root: preview.root, adoptedStyleSheets: preview.adoptedStyleSheets, ...values,
      preview: true,
    })!;
    expect(checkpoint?.payload.preview).toBe(true);
    expect(readHtmlMirrorSourceMessage(
      JSON.parse(JSON.stringify(checkpoint)),
      IDENTITY,
    )).toEqual(checkpoint);
  });

  it('keeps the preview small: past its read cap every box is a placeholder', () => {
    const target = page();
    const viewport = {
      innerWidth: 1200, innerHeight: 800,
      getComputedStyle: target.window.getComputedStyle,
    } as unknown as Window;
    const preview = sanitizeSourcePreview(target.document, viewport, new WeakNodeIdRegistry(), {
      maxReadNodes: 30,
    })!;
    expect(preview).toBeDefined();
    // The article is a box, or in the box of the block before it (D169).
    const long = findElement(preview.root, 'long');
    expect(long === undefined || long.placeholder !== undefined).toBe(true);
    const main = findElement(preview.root, 'main')!;
    expect(main.children.some((child) =>
      child.kind === 'element' && child.placeholder !== undefined)).toBe(true);
    expect(findElement(preview.root, 'para-0')).toBeUndefined();
    expect(sanitizeSourcePreview(target.document, viewport, new WeakNodeIdRegistry(), {
      maxReadNodes: 2, maxNodes: 3,
    })).toBeUndefined();
  });

  it('gives up a preview before it reads a list that cannot fit (D193)', () => {
    const target = page('<!doctype html><html lang="en"><head></head><body>' +
      `<div id="box">${'<b></b>'.repeat(300)}</div>` +
      '<x-open id="open"></x-open><x-closed id="closed"></x-closed></body></html>');
    let styleReads = 0;
    const viewport = {
      innerWidth: 1200, innerHeight: 800,
      getComputedStyle: (element: Element) => {
        if (element.localName === 'b') styleReads += 1;
        return target.window.getComputedStyle(element);
      },
    } as unknown as Window;
    // Elements that hold nothing are read whatever the preview does: 300
    // cannot fit in 100, so none of them is read.
    expect(sanitizeSourcePreview(target.document, viewport, new WeakNodeIdRegistry(), {
      maxReadNodes: 10, maxNodes: 100,
    })).toBeUndefined();
    expect(styleReads).toBe(0);
    // One that fits is read whole.
    const preview = sanitizeSourcePreview(target.document, viewport, new WeakNodeIdRegistry(), {
      maxReadNodes: 10, maxNodes: 400,
    })!;
    expect(findElement(preview.root, 'box')!.children).toHaveLength(300);
  });

});

describe('the preview stands one box for a run of boxes (D169)', () => {
  function runPage(between = ''): Page {
    const rows = Array.from({ length: 40 }, (_, index) =>
      `<section id="r-${index}" data-top="${3000 + index * 100}" data-height="90">` +
      `<p>Row ${index}</p></section>` + (index === 19 ? between : '')).join('\n');
    const target = page('<!doctype html><html lang="en"><head><title>Run</title></head><body>' +
      '<main id="main"><p id="near">Near text</p>' + rows + '</main>' +
      '<x-open id="open"></x-open><x-closed id="closed"></x-closed></body></html>');
    paint(target.document, target.window);
    return target;
  }

  function preview(target: Page) {
    const viewport = {
      innerWidth: 1200, innerHeight: 800,
      getComputedStyle: target.window.getComputedStyle,
    } as unknown as Window;
    return sanitizeSourcePreview(target.document, viewport, new WeakNodeIdRegistry())!;
  }

  it('makes one box as tall as the run, and leaves the rest of the run out', () => {
    const graph = preview(runPage());
    const first = findElement(graph.root, 'r-0')!;
    expect(first.placeholder).toEqual({ height: 3000 + 39 * 100 + 90 - 3000 });
    for (let index = 1; index < 40; index += 1) {
      expect(findElement(graph.root, `r-${index}`)).toBeUndefined();
    }
    expect(JSON.stringify(graph)).not.toContain('Row 3');
    // What is near is read as before.
    expect(findElement(graph.root, 'near')!.placeholder).toBeUndefined();
  });

  it('ends a run at text that shows and at a style sheet', () => {
    const text = preview(runPage('<b>shown words</b> loose text'));
    expect(findElement(text.root, 'r-0')!.placeholder).toEqual({ height: 19 * 100 + 90 });
    expect(findElement(text.root, 'r-20')!.placeholder).toEqual({ height: 19 * 100 + 90 });
    const sheet = preview(runPage('<style>p { color: blue }</style>'));
    expect(findElement(sheet.root, 'r-0')!.placeholder).toEqual({ height: 19 * 100 + 90 });
    expect(JSON.stringify(sheet)).toContain('color: blue');
    expect(findElement(sheet.root, 'r-20')!.placeholder).toBeDefined();
  });
});

describe('a long list read over several fills (D163)', () => {
  const ROWS = 150;
  const ROOT_ROWS = 60;

  /** A container of many sections, and a root of many paragraphs. */
  function widePage(): Page {
    const rows = Array.from({ length: ROWS }, (_, index) =>
      `<section id="w-${index}"><h3>Row ${index}</h3><p>Text ${index} <b>bold</b></p></section>`).join('');
    const target = page('<!doctype html><html lang="en"><head><title>Wide</title></head><body>' +
      `<main id="wide">${rows}</main>` +
      '<x-open id="open"></x-open><x-closed id="closed"></x-closed></body></html>');
    readSourceShadowRoot(target.byId('open'))!.innerHTML = Array.from(
      { length: ROOT_ROWS },
      (_, index) => `<p>root ${index} <b>b</b></p>`,
    ).join('');
    paint(target.document, target.window);
    return target;
  }

  function countNodes(nodes: readonly HtmlMirrorNode[]): number {
    return nodes.reduce((total, node) => total + 1 + (node.kind === 'text'
      ? 0
      : countNodes(node.children) + countNodes(node.shadowRoot?.children ?? [])), 0);
  }

  it('assembles to the one-task read, its checkpoint and its index, at every forced boundary', async () => {
    for (const budget of [1, 3, 10]) {
      const target = widePage();
      const registry = new WeakNodeIdRegistry();
      const wideId = registry.getId(target.byId('wide'));
      const rootId = registry.getId(readSourceShadowRoot(target.byId('open'))!);
      const sliced = await readInSlices(target, registry, budget);
      expect(sliced.outcome, `budget ${budget}`).toBe('done');
      const reference = oneTaskRead(target, registry);
      expect(fillGraph(sliced.root!, sliced.fills), `budget ${budget}`)
        .toEqual(reference.graph.root);
      expect(sliced.representability, `budget ${budget}`).toEqual(reference.representability);
      // The container and the root came in several fills each.
      const wideFills = sliced.fills.filter((fill) => fill.nodeId === wideId);
      expect(wideFills.length, `budget ${budget}`).toBeGreaterThan(1);
      expect(wideFills.slice(0, -1).every((fill) => fill.more)).toBe(true);
      expect(wideFills.at(-1)!.more).toBeUndefined();
      expect(sliced.fills.filter((fill) => fill.nodeId === rootId).length, `budget ${budget}`)
        .toBeGreaterThan(1);
      // No step reads much more than its slice allows: the whole page is
      // more than a thousand nodes.
      const largest = Math.max(...sliced.steps.map((step) =>
        countNodes(step.fills.flatMap((fill) => fill.children))));
      expect(largest, `budget ${budget}`).toBeLessThan(10 * budget + 20);

      // The page's check and the panel's assembly give the one-task checkpoint.
      const values = {
        captureMs: 1,
        viewportWidth: sliced.values!.viewportWidth,
        viewportHeight: sliced.values!.viewportHeight,
        documentWidth: sliced.values!.documentWidth,
        documentHeight: sliced.values!.documentHeight,
        documentMode: sliced.values!.documentMode,
        representability: reference.representability,
      };
      const expected = createHtmlMirrorCheckpoint(IDENTITY, {
        root: reference.graph.root,
        adoptedStyleSheets: reference.graph.adoptedStyleSheets,
        ...values,
      })!;
      const assembly = new HtmlMirrorCheckpointAssembly();
      expect(assembly.readRoot(sliced.root)).toBeDefined();
      for (const [index, step] of sliced.steps.filter((one) => one.fills.length > 0).entries()) {
        expect(createHtmlMirrorCheckpointPart(
          IDENTITY, index, step.fills, 'conservative', assembly,
        ), `budget ${budget} part ${index}`).toBeDefined();
      }
      expect(assembly.readAdoptedStyleSheets(sliced.values!.adoptedStyleSheets)).toBeDefined();
      expect(assembly.pendingShells).toBe(0);
      expect(assembly.assembledCheckpoint(IDENTITY, values)).toEqual(expected);
      const parts = partsOf(sliced);
      const shell = assembly.shellCheckpoint(IDENTITY, values, parts.length)!;
      const overWire = <T,>(message: T): unknown =>
        decodeHtmlMirrorWireMessage(JSON.parse(JSON.stringify(
          encodeHtmlMirrorWireMessage(message),
        )));
      const received = readHtmlMirrorSourceMessage(overWire(shell), IDENTITY);
      expect(received?.kind).toBe('simul:html-mirror-v2:checkpoint');
      expect(assembleHtmlMirrorCheckpoint(
        received as Extract<typeof received, { kind: 'simul:html-mirror-v2:checkpoint' }>,
        parts.map((part) => readHtmlMirrorCheckpointPart(overWire(part), IDENTITY)!).reverse(),
      ), `budget ${budget}`).toEqual(expected);

      // The index of what is painted, built in the same pieces.
      const build = SourceVisibilityBoundaryIndex.beginBuild(
        target.document, target.window, 10_000,
      );
      for (const step of sliced.steps) {
        for (const indexRoot of step.indexRoots) {
          build.add(indexRoot.element, {
            includeSelf: indexRoot.includeSelf,
            stopAt: step.deferred,
          });
        }
      }
      const whole = new SourceVisibilityBoundaryIndex(target.document, target.window, 10_000);
      expect(build.finish().hasSameStatesAs(whole), `budget ${budget}`).toBe(true);
    }
  });

  /** Reads at the smallest slice and changes the page at the container's first fill. */
  async function changeAtFirstFill(
    change: (target: Page, lastRead: Element, next: Element) => void,
  ): Promise<SlicedRead> {
    const target = widePage();
    const registry = new WeakNodeIdRegistry();
    const wideId = registry.getId(target.byId('wide'));
    let changed = false;
    const sliced = await readInSlices(target, registry, 1, (fills) => {
      const first = fills.find((fill) => fill.nodeId === wideId && fill.more);
      if (changed || !first) return;
      const lastRead = registry.getNode(first.children.at(-1)!.id) as Element;
      change(target, lastRead, lastRead.nextElementSibling!);
      changed = true;
    });
    expect(changed).toBe(true);
    return sliced;
  }

  it('starts again when the child it goes on from left the list', async () => {
    expect((await changeAtFirstFill((_, __, next) => next.remove())).outcome)
      .toBe('restart');
    expect((await changeAtFirstFill((target, __, next) => {
      target.byId('w-100').append(next);
    })).outcome).toBe('restart');
  });

  it('leaves to the live path a child put in before it, or taken out of what was read', async () => {
    const sliced = await changeAtFirstFill((target, lastRead, next) => {
      const added = target.document.createElement('section');
      added.textContent = 'added';
      lastRead.parentNode!.insertBefore(added, next);
      lastRead.remove();
    });
    expect(sliced.outcome).toBe('done');
    // The read keeps the list it read (the shell of the child taken out
    // is filled empty); the container's childList record is replayed
    // after the copy is acknowledged.
    const json = JSON.stringify([sliced.root, sliced.fills]);
    expect(json).toContain('"w-0"');
    expect(json).not.toContain('Row 0');
    expect(sliced.steps.reduce((total, step) => total + step.skippedUnits, 0)).toBe(1);
    expect(json).not.toContain('added');
    expect(json).toContain(`Row ${ROWS - 1}`);
  });
});

describe('the preview\'s budget and boxes (D171)', () => {
  function viewportOf(target: Page): Window {
    return {
      innerWidth: 1200,
      innerHeight: 800,
      getComputedStyle: target.window.getComputedStyle,
    } as unknown as Window;
  }

  function placeholders(node: HtmlMirrorNode, found: HtmlMirrorElementNode[] = []) {
    if (node.kind === 'text') return found;
    if (node.placeholder) found.push(node);
    for (const child of [...node.children, ...(node.shadowRoot?.children ?? [])]) {
      placeholders(child, found);
    }
    return found;
  }

  it('spends nothing of its read on menus that are not displayed', () => {
    const menu = Array.from({ length: 300 }, (_, index) =>
      `<li><a href="/m${index}">Menu ${index}</a></li>`).join('');
    const target = page('<!doctype html><html lang="en"><head><title>Menus</title></head><body>' +
      `<header id="top"><ul id="menu" class="gone">${menu}</ul>` +
      '<div id="sprites" class="gone"><style>.near { color: green }</style></div></header>' +
      '<main id="main"><p id="near">Near text <b>in view</b></p></main>' +
      '<x-open id="open"></x-open><x-closed id="closed"></x-closed></body></html>');
    const preview = sanitizeSourcePreview(target.document, viewportOf(target), new WeakNodeIdRegistry(), {
      maxReadNodes: 40,
    })!;
    expect(preview).toBeDefined();
    // The closed menu is one box of no height; what is in view is read.
    expect(findElement(preview.root, 'menu')).toMatchObject({
      placeholder: { height: 0 }, children: [],
    });
    expect(JSON.stringify(preview)).not.toContain('Menu 1');
    expect(findElement(preview.root, 'near')!.placeholder).toBeUndefined();
    expect(JSON.stringify(findElement(preview.root, 'near'))).toContain('in view');
    // One that holds a style sheet is read: the sheet paints the page.
    expect(findElement(preview.root, 'sprites')!.placeholder).toBeUndefined();
    expect(JSON.stringify(preview)).toContain('color: green');
  });

  it('reads an inline element on past its read cap, and boxes only what keeps a height', () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      `<p id="row-${index}">Row <a href="/r${index}">link ${index}</a> and ` +
      `<span id="span-${index}">span <b>${index}</b></span></p>`).join('');
    const target = page('<!doctype html><html lang="en"><head><title>Inline</title></head><body>' +
      `<main id="main">${rows}</main><x-open id="open"></x-open><x-closed id="closed"></x-closed>` +
      '</body></html>');
    const preview = sanitizeSourcePreview(target.document, viewportOf(target), new WeakNodeIdRegistry(), {
      maxReadNodes: 30,
    })!;
    expect(preview).toBeDefined();
    const boxes = placeholders(preview.root);
    expect(boxes.length).toBeGreaterThan(0);
    // No inline element is a box: its height would be ignored.
    expect(boxes.filter((box) => ['a', 'span', 'b'].includes(box.tagName))).toEqual([]);
    expect(boxes.some((box) => box.tagName === 'p')).toBe(true);
  });

  it('stands a box in for a dropdown that would pass what is left of its limit', () => {
    const options = Array.from({ length: 120 }, (_, index) =>
      `<option${index === 7 ? ' selected' : ''}>Choice ${index}</option>`).join('');
    const target = page('<!doctype html><html lang="en"><head><title>Select</title></head><body>' +
      '<main id="main"><p id="near">Near</p>' +
      `<select id="big" data-height="24">${options}</select>` +
      '<select id="small"><option>A</option><option selected>B</option></select></main>' +
      '<x-open id="open"></x-open><x-closed id="closed"></x-closed></body></html>');
    const registry = new WeakNodeIdRegistry();
    const preview = sanitizeSourcePreview(target.document, viewportOf(target), registry, {
      maxReadNodes: 60,
      maxNodes: 100,
    })!;
    // Read whole, the dropdown passed the limit and there was no preview.
    expect(preview).toBeDefined();
    // A dropdown's own attributes are private: found by their place.
    const selects = findElement(preview.root, 'main')!.children.filter((child) =>
      child.kind === 'element' && child.tagName === 'select') as HtmlMirrorElementNode[];
    expect(selects).toHaveLength(2);
    const [big, small] = selects as [HtmlMirrorElementNode, HtmlMirrorElementNode];
    expect(big).toMatchObject({ tagName: 'select', placeholder: { height: 24 }, children: [] });
    expect(big.selectedOptionIndexes).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain('Choice');
    // One that fits is read whole, as always.
    expect(small.placeholder).toBeUndefined();
    expect(small.children).toHaveLength(2);
    // The checks take it as a preview, and only as one.
    const values = {
      captureMs: 1, viewportWidth: preview.viewportWidth,
      viewportHeight: preview.viewportHeight, documentWidth: preview.documentWidth,
      documentHeight: preview.documentHeight,
    };
    const checkpoint = createHtmlMirrorCheckpoint(IDENTITY, {
      root: preview.root, adoptedStyleSheets: preview.adoptedStyleSheets, ...values,
      preview: true,
    })!;
    expect(checkpoint).toBeDefined();
    expect(readHtmlMirrorSourceMessage(JSON.parse(JSON.stringify(checkpoint)), IDENTITY))
      .toEqual(checkpoint);
    expect(createHtmlMirrorCheckpoint(IDENTITY, {
      root: preview.root, adoptedStyleSheets: preview.adoptedStyleSheets, ...values,
    })).toBeUndefined();
  });
});

describe('an element left out after its content was cut (D171)', () => {
  /** A registry that cannot give the open root an id: the host is left out. */
  class RootlessRegistry extends WeakNodeIdRegistry {
    constructor(private readonly lost: () => Node | undefined) {
      super();
    }

    override getId(node: Node): number {
      return node === this.lost() ? 0 : super.getId(node);
    }
  }

  const MARKUP = '<!doctype html><html lang="en"><head><title>Left out</title></head><body>' +
    '<main id="main"><p id="before">Before <b>bold</b></p>' +
    '<x-open id="open">' + Array.from({ length: 8 }, (_, index) =>
      `<span id="light-${index}">light ${index} <b>deep <i>deeper ${index}</i></b></span>`).join('') +
    '</x-open><p id="after">After <i>it</i></p></main>' +
    '<x-closed id="closed"></x-closed></body></html>';

  it('leaves out the element alone, as the one-task read does, at every forced boundary', async () => {
    let cutInside = 0;
    for (let budget = 1; budget <= 24; budget += 1) {
      const target = page(MARKUP);
      const shadow = readSourceShadowRoot(target.byId('open'))!;
      const registry = new RootlessRegistry(() => shadow);
      const sliced = await readInSlices(target, registry, budget);
      expect(sliced.outcome, `budget ${budget}`).toBe('done');
      // A slice stopped in the host's own children: cuts in it were taken back.
      const hostId = registry.getId(target.byId('open'));
      if (!JSON.stringify(sliced.root).includes(`"id":${hostId},`) &&
        sliced.steps.length > 1) cutInside += 1;
      const reference = oneTaskRead(target, registry);
      expect(findElement(reference.graph.root, 'open')).toBeUndefined();
      expect(fillGraph(sliced.root!, sliced.fills), `budget ${budget}`)
        .toEqual(reference.graph.root);
      // And the page's own check takes every part.
      const assembly = new HtmlMirrorCheckpointAssembly();
      expect(assembly.readRoot(sliced.root)).toBeDefined();
      let index = 0;
      for (const step of sliced.steps) {
        if (step.fills.length === 0) continue;
        expect(createHtmlMirrorCheckpointPart(
          IDENTITY, index, step.fills, 'conservative', assembly,
        ), `budget ${budget} part ${index}`).toBeDefined();
        index += 1;
      }
      expect(assembly.readAdoptedStyleSheets(sliced.values!.adoptedStyleSheets)).toBeDefined();
      expect(assembly.pendingShells, `budget ${budget}`).toBe(0);
      expect(JSON.stringify([sliced.root, sliced.fills])).not.toContain('deeper');
    }
    expect(cutInside).toBeGreaterThan(0);
  });
});
