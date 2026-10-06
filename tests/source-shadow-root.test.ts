import { readFileSync } from 'node:fs';

import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  askAboutSourceShadowRootsAbove,
  askAboutSourceShadowRootsWithin,
  beginSourceShadowRootWalk,
  canHostAuthorShadowRoot,
  chromeSourceShadowRootReader,
  installSourceShadowRootReader,
  listenForSourceShadowRoots,
  isSourceShadowRoot,
  probeSourceShadowRoot,
  readSourceAssignedSlot,
  readSourceShadowRoot,
} from '../lib/replica/source-shadow-root';
import { closedRootReader } from './support/closed-shadow-roots';

function page(markup: string) {
  const { document } = parseHTML(
    `<!doctype html><html><body>${markup}</body></html>`,
  );
  return document;
}

describe('readSourceShadowRoot (D125)', () => {
  const installed: Document[] = [];
  const install = (
    document: Document,
    reader: Parameters<typeof installSourceShadowRootReader>[1],
  ) => {
    installSourceShadowRootReader(document, reader);
    installed.push(document);
  };
  afterEach(() => {
    for (const document of installed.splice(0)) {
      installSourceShadowRootReader(document, undefined);
    }
    vi.unstubAllGlobals();
  });

  it('reads only open roots where no reader is installed', () => {
    const document = page('<x-open></x-open><x-closed></x-closed>');
    const open = document.querySelector('x-open')!;
    const openRoot = open.attachShadow({ mode: 'open' });
    const closed = document.querySelector('x-closed')!;
    closed.attachShadow({ mode: 'closed' });

    expect(readSourceShadowRoot(open)).toBe(openRoot);
    expect(readSourceShadowRoot(closed)).toBeUndefined();
    expect(probeSourceShadowRoot(closed)).toBeUndefined();
  });

  it('reads a closed root through the installed reader and keeps it', () => {
    const document = page('<x-card></x-card>');
    const host = document.querySelector('x-card')!;
    const root = host.attachShadow({ mode: 'closed' });
    const reader = closedRootReader();
    reader.add(host, root);
    install(document, reader.read);

    expect(host.shadowRoot).toBeNull();
    expect(readSourceShadowRoot(host)).toBe(root);
    expect(readSourceShadowRoot(host)).toBe(root);
    expect(probeSourceShadowRoot(host)).toBe(root);
    // A root is never detached or replaced: asked once.
    expect(reader.calls).toEqual([host]);
  });

  it('prefers the open root on the element and never asks about it', () => {
    const document = page('<x-card></x-card>');
    const host = document.querySelector('x-card')!;
    const root = host.attachShadow({ mode: 'open' });
    const reader = closedRootReader();
    install(document, reader.read);

    expect(readSourceShadowRoot(host)).toBe(root);
    expect(reader.calls).toEqual([]);
  });

  it('remembers that an element has no root until it is asked about again', () => {
    const document = page('<div id="late"></div>');
    const host = document.querySelector('#late')!;
    const reader = closedRootReader();
    install(document, reader.read);

    expect(readSourceShadowRoot(host)).toBeUndefined();
    expect(readSourceShadowRoot(host)).toBeUndefined();
    expect(reader.calls).toHaveLength(1);

    // The root is attached later; nothing fires.
    const root = host.attachShadow({ mode: 'closed' });
    reader.add(host, root);
    expect(readSourceShadowRoot(host)).toBeUndefined();
    expect(reader.calls).toHaveLength(1);

    // The periodic discovery asks again, and then every reader sees it.
    expect(probeSourceShadowRoot(host)).toBe(root);
    expect(reader.calls).toHaveLength(2);
    expect(readSourceShadowRoot(host)).toBe(root);
    expect(reader.calls).toHaveLength(2);
  });

  it('asks about every element once more in a fresh walk', () => {
    const document = page('<div id="a"></div><div id="b"></div>');
    const a = document.querySelector('#a')!;
    const b = document.querySelector('#b')!;
    const reader = closedRootReader();
    install(document, reader.read);
    readSourceShadowRoot(a);
    readSourceShadowRoot(b);
    const root = b.attachShadow({ mode: 'closed' });
    reader.add(b, root);

    const walk = beginSourceShadowRootWalk({ fresh: true });
    try {
      expect(readSourceShadowRoot(a)).toBeUndefined();
      expect(readSourceShadowRoot(b)).toBe(root);
      // Once per walk: a second read trusts the answer just given.
      expect(readSourceShadowRoot(a)).toBeUndefined();
    } finally {
      walk.end();
    }
    expect(reader.calls).toEqual([a, b, a, b]);
    // After the walk the answers stand, until the next fresh one.
    expect(readSourceShadowRoot(a)).toBeUndefined();
    const plain = beginSourceShadowRootWalk();
    expect(readSourceShadowRoot(a)).toBeUndefined();
    plain.end();
    expect(reader.calls).toHaveLength(4);
  });

  it('never asks about an element the page cannot attach a root to', () => {
    const document = page(`
      <input id="input"><textarea id="textarea"></textarea>
      <select id="select"><option id="option">One</option></select>
      <details id="details"><summary id="summary">More</summary></details>
      <video id="video"></video><audio id="audio"></audio>
      <meter id="meter"></meter><progress id="progress"></progress>
      <img id="img" alt="alt"><marquee id="marquee"></marquee>
      <object id="object"></object><embed id="embed">
      <button id="button"></button><a id="a"></a><ul id="ul"><li id="li"></li></ul>
      <svg id="svg"><g id="x-g"></g></svg>
    `);
    // A reader that would hand out a browser-made root for anything.
    const asked: Element[] = [];
    install(document, (element) => {
      asked.push(element);
      const root = document.createDocumentFragment() as unknown as ShadowRoot;
      Object.defineProperty(root, 'host', { value: element });
      return root;
    });
    for (const element of document.querySelectorAll('body *')) {
      expect(canHostAuthorShadowRoot(element)).toBe(false);
      expect(readSourceShadowRoot(element)).toBeUndefined();
      expect(probeSourceShadowRoot(element)).toBeUndefined();
    }
    expect(asked).toEqual([]);
  });

  it('asks about custom elements and the tags attachShadow allows', () => {
    const tags = [
      'article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2',
      'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span',
      'x-card', 'my-very-own-element',
    ];
    const document = page('');
    for (const tag of tags) {
      expect(canHostAuthorShadowRoot(document.createElement(tag))).toBe(true);
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'x-shape');
    expect(canHostAuthorShadowRoot(svg)).toBe(false);
  });

  it('treats a reader that throws or answers wrongly as no root', () => {
    const document = page('<div id="a"></div><div id="b"></div><div id="c"></div><div id="d"></div>');
    const [a, b, c, d] = [...document.querySelectorAll('div')] as Element[];
    const foreign = b!.attachShadow({ mode: 'closed' });
    install(document, (element) => {
      if (element === a) throw new TypeError('Error in invocation of dom.openOrClosedShadowRoot');
      // Another host's root, a node that is no root, and a plain object.
      if (element === c) return foreign;
      if (element === d) return document.createDocumentFragment() as unknown as ShadowRoot;
      return { host: element } as unknown as ShadowRoot;
    });

    expect(readSourceShadowRoot(a!)).toBeUndefined();
    expect(readSourceShadowRoot(b!)).toBeUndefined();
    expect(readSourceShadowRoot(c!)).toBeUndefined();
    expect(readSourceShadowRoot(d!)).toBeUndefined();
  });

  it('leaves an unreadable shadowRoot property to its caller', () => {
    const document = page('<div id="host"></div>');
    const host = document.querySelector('#host')!;
    Object.defineProperty(host, 'shadowRoot', {
      get: () => {
        throw new Error('unreadable');
      },
    });
    install(document, closedRootReader().read);

    expect(() => readSourceShadowRoot(host)).toThrow('unreadable');
    expect(() => probeSourceShadowRoot(host)).toThrow('unreadable');
  });

  it('keeps each document to its own reader', () => {
    const first = page('<div id="host"></div>');
    const second = page('<div id="host"></div>');
    const firstHost = first.querySelector('#host')!;
    const secondHost = second.querySelector('#host')!;
    const firstRoot = firstHost.attachShadow({ mode: 'closed' });
    const secondRoot = secondHost.attachShadow({ mode: 'closed' });
    const firstReader = closedRootReader();
    firstReader.add(firstHost, firstRoot);
    const secondReader = closedRootReader();
    secondReader.add(secondHost, secondRoot);
    install(first, firstReader.read);
    install(second, secondReader.read);

    expect(readSourceShadowRoot(firstHost)).toBe(firstRoot);
    expect(readSourceShadowRoot(secondHost)).toBe(secondRoot);
    expect(readSourceShadowRoot(firstHost)).toBe(firstRoot);
    expect(firstReader.calls).toEqual([firstHost]);
    expect(secondReader.calls).toEqual([secondHost]);

    installSourceShadowRootReader(first, undefined);
    const other = first.createElement('div');
    expect(readSourceShadowRoot(other)).toBeUndefined();
    expect(firstReader.calls).toEqual([firstHost]);
  });

  it('tells a shadow root, open or closed, from other nodes', () => {
    const document = page('<div id="open"></div><div id="closed"></div>');
    const open = document.querySelector('#open')!.attachShadow({ mode: 'open' });
    const closed = document.querySelector('#closed')!.attachShadow({ mode: 'closed' });

    expect(isSourceShadowRoot(open)).toBe(true);
    expect(isSourceShadowRoot(closed)).toBe(true);
    expect(isSourceShadowRoot(document.createDocumentFragment())).toBe(false);
    expect(isSourceShadowRoot(document.body)).toBe(false);
    expect(isSourceShadowRoot(document)).toBe(false);
  });

  it('uses chrome.dom.openOrClosedShadowRoot when Chrome offers it', () => {
    expect(chromeSourceShadowRootReader()).toBeUndefined();
    const document = page('<div id="host"></div>');
    const host = document.querySelector('#host')!;
    const root = host.attachShadow({ mode: 'closed' });
    const openOrClosedShadowRoot = vi.fn(() => root);
    vi.stubGlobal('chrome', { dom: { openOrClosedShadowRoot } });

    const reader = chromeSourceShadowRootReader();
    expect(reader?.(host as HTMLElement)).toBe(root);
    expect(openOrClosedShadowRoot).toHaveBeenCalledWith(host);

    vi.stubGlobal('chrome', { runtime: {} });
    expect(chromeSourceShadowRootReader()).toBeUndefined();
  });
});

describe('readSourceAssignedSlot (D125)', () => {
  const installed: Document[] = [];
  afterEach(() => {
    for (const document of installed.splice(0)) {
      installSourceShadowRootReader(document, undefined);
    }
  });

  /** Chrome reads null for a node slotted into a closed root, and for none. */
  const unassigned = (...nodes: Node[]) => {
    for (const node of nodes) {
      Object.defineProperty(node, 'assignedSlot', {
        configurable: true,
        value: null,
      });
    }
  };

  function closedHost(markup: string, shadowMarkup: string) {
    const document = page(`<x-host>${markup}</x-host>`);
    const host = document.querySelector('x-host')!;
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = shadowMarkup;
    const reader = closedRootReader();
    reader.add(host, root);
    installSourceShadowRootReader(document, reader.read);
    installed.push(document);
    unassigned(...host.childNodes);
    return { document, host, root, reader };
  }

  it('returns what the browser reports for an open root', () => {
    const document = page('<div id="host"><b id="child"></b></div>');
    const child = document.querySelector('#child')!;
    const slot = document.createElement('slot');
    Object.defineProperty(child, 'assignedSlot', { value: slot });

    expect(readSourceAssignedSlot(child)).toBe(slot);
    // linkedom has no `assignedSlot`: unknown stays unknown.
    expect(readSourceAssignedSlot(document.querySelector('#host')!)).toBeUndefined();
  });

  it('finds the slots of a closed root by name, as the browser assigns them', () => {
    const { host, root } = closedHost(
      '<b id="title" slot="title">Title</b><i id="body">Body</i>text<u id="lost" slot="none">Lost</u>',
      '<header><slot id="named" name="title"></slot><slot id="second" name="title"></slot></header>' +
        '<main><slot id="default"></slot><slot id="late-default"></slot></main>',
    );
    const title = host.querySelector('#title')!;
    const body = host.querySelector('#body')!;
    const text = [...host.childNodes].find((node) => node.nodeType === 3)!;

    // The first slot of the name takes the node.
    expect(readSourceAssignedSlot(title)).toBe(root.querySelector('#named'));
    expect(readSourceAssignedSlot(body)).toBe(root.querySelector('#default'));
    // Text goes to the default slot.
    expect(readSourceAssignedSlot(text)).toBe(root.querySelector('#default'));
    // No slot of that name: not slotted, so not drawn.
    expect(readSourceAssignedSlot(host.querySelector('#lost')!)).toBeNull();
  });

  it('treats an empty name attribute as the default slot', () => {
    const { host, root } = closedHost(
      '<b id="child" slot="">Child</b>',
      '<slot id="default" name=""></slot>',
    );
    expect(readSourceAssignedSlot(host.querySelector('#child')!))
      .toBe(root.querySelector('#default'));
  });

  it('finds a manually assigned slot through the slot’s own list', () => {
    const { host, root } = closedHost(
      '<b id="one">One</b><b id="two">Two</b><b id="three">Three</b>',
      '<slot id="first"></slot><slot id="second"></slot>',
    );
    Object.defineProperty(root, 'slotAssignment', { value: 'manual' });
    const [one, two, three] = [...host.children];
    Object.defineProperty(root.querySelector('#first')!, 'assignedNodes', {
      value: () => [two],
    });
    Object.defineProperty(root.querySelector('#second')!, 'assignedNodes', {
      value: () => [one],
    });

    expect(readSourceAssignedSlot(one!)).toBe(root.querySelector('#second'));
    expect(readSourceAssignedSlot(two!)).toBe(root.querySelector('#first'));
    expect(readSourceAssignedSlot(three!)).toBeNull();
  });

  it('answers null for a child of an element with no closed root', () => {
    const document = page('<div id="plain"><b id="child"></b></div>');
    const reader = closedRootReader();
    installSourceShadowRootReader(document, reader.read);
    installed.push(document);
    const child = document.querySelector('#child')!;
    unassigned(child, document.body);

    expect(readSourceAssignedSlot(child)).toBeNull();
    expect(readSourceAssignedSlot(child)).toBeNull();
    // The parent is asked about once, then remembered.
    expect(reader.calls).toEqual([document.querySelector('#plain')]);
    expect(readSourceAssignedSlot(document.body)).toBeNull();
  });

  it('does not look into closed roots where no reader is installed', () => {
    const document = page('<x-host><b id="child"></b></x-host>');
    const host = document.querySelector('x-host')!;
    host.attachShadow({ mode: 'closed' }).innerHTML = '<slot></slot>';
    const child = document.querySelector('#child')!;
    unassigned(child);

    expect(readSourceAssignedSlot(child)).toBeNull();
  });

  it('fails instead of searching a root with too many slots', () => {
    const { host } = closedHost(
      '<b id="child">Child</b>',
      '<slot name="x"></slot>'.repeat(4_097),
    );
    expect(() => readSourceAssignedSlot(host.querySelector('#child')!))
      .toThrow('Too many slots');
  });
});

describe('asking about roots before sending (D125)', () => {
  const installed: Document[] = [];
  const install = (
    document: Document,
    reader: Parameters<typeof installSourceShadowRootReader>[1],
  ) => {
    installSourceShadowRootReader(document, reader);
    installed.push(document);
  };
  afterEach(() => {
    for (const document of installed.splice(0)) {
      installSourceShadowRootReader(document, undefined);
    }
  });

  it('asks about every element above a node, through hosts, and returns the roots it finds', () => {
    const document = page('<main><x-outer id="outer"></x-outer><div id="side"></div></main>');
    const reader = closedRootReader();
    const outer = document.querySelector('#outer')!;
    const outerRoot = reader.attach(outer, '<section id="box"><x-inner id="inner"></x-inner></section>');
    const inner = outerRoot.querySelector('#inner')!;
    install(document, reader.read);
    expect(readSourceShadowRoot(outer)).toBe(outerRoot);
    // Read before its root was attached: "none" is kept for it.
    expect(readSourceShadowRoot(inner)).toBeUndefined();
    const innerRoot = reader.attach(inner, '<p id="leaf">leaf</p>');
    const leaf = innerRoot.querySelector('#leaf')!;
    reader.calls.length = 0;

    const asked = new Set<Node>();
    expect(askAboutSourceShadowRootsAbove(leaf.firstChild!, asked)).toEqual([innerRoot]);
    // The known outer root is not asked about again; <html> is never asked.
    expect(reader.calls).toEqual([
      leaf,
      inner,
      outerRoot.querySelector('#box'),
      document.querySelector('main'),
      document.body,
    ]);
    expect(readSourceShadowRoot(inner)).toBe(innerRoot);

    // A second climb in the same run stops where the first one passed.
    reader.calls.length = 0;
    expect(askAboutSourceShadowRootsAbove(document.querySelector('#side')!, asked))
      .toEqual([]);
    expect(reader.calls).toEqual([document.querySelector('#side')]);
  });

  it('does not ask twice about an element inside a fresh walk', () => {
    const document = page('<main><div id="box"><b id="leaf">leaf</b></div></main>');
    const reader = closedRootReader();
    install(document, reader.read);
    const box = document.querySelector('#box')!;
    readSourceShadowRoot(box);
    const walk = beginSourceShadowRootWalk({ fresh: true });
    try {
      expect(readSourceShadowRoot(box)).toBeUndefined();
      reader.calls.length = 0;
      askAboutSourceShadowRootsAbove(document.querySelector('#leaf')!, new Set());
      expect(reader.calls).not.toContain(box);
    } finally {
      walk.end();
    }
    reader.calls.length = 0;
    askAboutSourceShadowRootsAbove(document.querySelector('#leaf')!, new Set());
    expect(reader.calls).toContain(box);
  });

  it('fails instead of climbing a chain it cannot finish', () => {
    const document = page('<div id="top"></div>');
    install(document, closedRootReader().read);
    let current = document.querySelector('#top')!;
    for (let depth = 0; depth < 4_100; depth += 1) {
      const next = document.createElement('div');
      current.append(next);
      current = next;
    }
    expect(() => askAboutSourceShadowRootsAbove(current, new Set()))
      .toThrow('too deep');
  });

  it('asks about every element within a subtree, through its roots', () => {
    const document = page('<main id="main"><div id="a"><x-card id="card"></x-card></div><div id="b"></div></main>');
    const reader = closedRootReader();
    const card = document.querySelector('#card')!;
    const cardRoot = reader.attach(card, '<div id="in-card"></div>');
    const a = document.querySelector('#a')!;
    const open = document.querySelector('#b')!.attachShadow({ mode: 'open' });
    open.innerHTML = '<span id="in-open"></span>';
    install(document, reader.read);
    expect(readSourceShadowRoot(card)).toBe(cardRoot);
    // Remembered without roots, then given one each.
    for (const element of [a, cardRoot.querySelector('#in-card')!]) {
      expect(readSourceShadowRoot(element)).toBeUndefined();
    }
    const aRoot = reader.attach(a, '<slot></slot>');
    const deepRoot = reader.attach(cardRoot.querySelector('#in-card')!, '<i>deep</i>');
    reader.calls.length = 0;

    const asked = new Set<Node>();
    const budget = { nodes: 100 };
    expect(askAboutSourceShadowRootsWithin(document.querySelector('#main')!, asked, budget))
      .toEqual(expect.arrayContaining([aRoot, deepRoot]));
    expect(reader.calls).toEqual(expect.arrayContaining([
      document.querySelector('#main'), a, cardRoot.querySelector('#in-card'),
      open.querySelector('#in-open'),
    ]));
    // The open root's host is never asked; the closed root's host is known.
    expect(reader.calls).not.toContain(document.querySelector('#b'));
    expect(reader.calls.filter((element) => element === card)).toHaveLength(0);

    // Elements asked in this run are not asked again, and the budget holds.
    reader.calls.length = 0;
    expect(askAboutSourceShadowRootsWithin(a, asked, budget)).toEqual([]);
    expect(reader.calls).toEqual([]);
    expect(askAboutSourceShadowRootsWithin(document.body, new Set(), { nodes: 3 }))
      .toBeUndefined();
  });

  it('tells listeners about each root once, and which were attached since', () => {
    const document = page('<x-open id="open"></x-open><x-card id="card"></x-card><div id="late"></div>');
    const reader = closedRootReader();
    const open = document.querySelector('#open')!.attachShadow({ mode: 'open' });
    const card = reader.attach(document.querySelector('#card')!);
    install(document, reader.read);
    const told: Array<[ShadowRoot, boolean]> = [];
    const stop = listenForSourceShadowRoots(document, (root, late) => {
      told.push([root, late]);
    });
    const failing = listenForSourceShadowRoots(document, () => {
      throw new Error('a listener failed');
    });
    const late = document.querySelector('#late')!;
    expect(readSourceShadowRoot(late)).toBeUndefined();
    const lateRoot = reader.attach(late);

    expect(readSourceShadowRoot(document.querySelector('#open')!)).toBe(open);
    expect(readSourceShadowRoot(document.querySelector('#open')!)).toBe(open);
    expect(readSourceShadowRoot(document.querySelector('#card')!)).toBe(card);
    expect(probeSourceShadowRoot(late)).toBe(lateRoot);
    expect(told).toEqual([[open, false], [card, false], [lateRoot, true]]);

    stop();
    failing();
    const another = document.createElement('x-new');
    document.body.append(another);
    reader.attach(another);
    readSourceShadowRoot(another);
    expect(told).toHaveLength(3);
  });

  it('tells no one where nothing was installed', () => {
    const document = page('<x-open id="open"></x-open>');
    const open = document.querySelector('#open')!.attachShadow({ mode: 'open' });
    const told: ShadowRoot[] = [];
    listenForSourceShadowRoots(document, (root) => told.push(root));
    expect(readSourceShadowRoot(document.querySelector('#open')!)).toBe(open);
    expect(told).toEqual([]);
  });

  it('never asks about the body of a PDF document: its root is Chrome\'s viewer', () => {
    const document = page('<embed id="plugin" type="application/pdf">');
    Object.defineProperty(document, 'contentType', { value: 'application/pdf' });
    const reader = closedRootReader();
    reader.attach(document.body);
    install(document, reader.read);

    expect(canHostAuthorShadowRoot(document.body)).toBe(false);
    expect(readSourceShadowRoot(document.body)).toBeUndefined();
    expect(probeSourceShadowRoot(document.body)).toBeUndefined();
    expect(askAboutSourceShadowRootsAbove(document.body, new Set())).toEqual([]);
    expect(reader.calls).toEqual([]);
    // An HTML page's body may hold a page's own root.
    expect(canHostAuthorShadowRoot(page('').body)).toBe(true);
  });
});

describe('slots of a closed root (D125)', () => {
  const installed: Document[] = [];
  afterEach(() => {
    for (const document of installed.splice(0)) {
      installSourceShadowRootReader(document, undefined);
    }
  });

  it('does not search an open root: null already means not assigned', () => {
    const document = page('<x-host><b id="child"></b></x-host>');
    const host = document.querySelector('x-host')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<slot name="other"></slot>';
    const reader = closedRootReader();
    installSourceShadowRootReader(document, reader.read);
    installed.push(document);
    const child = document.querySelector('#child')!;
    Object.defineProperty(child, 'assignedSlot', { value: null });
    const querySelectorAll = vi.spyOn(root, 'querySelectorAll');

    expect(readSourceAssignedSlot(child)).toBeNull();
    expect(reader.calls).toEqual([]);
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it('reads the slots of a closed root once a walk', () => {
    const document = page('<x-host><b id="one">1</b><b id="two">2</b></x-host>');
    const host = document.querySelector('x-host')!;
    const reader = closedRootReader();
    const root = reader.attach(host, '<slot id="default"></slot>');
    installSourceShadowRootReader(document, reader.read);
    installed.push(document);
    const children = [...host.children];
    for (const child of children) {
      Object.defineProperty(child, 'assignedSlot', { value: null });
    }
    const querySelectorAll = vi.spyOn(root, 'querySelectorAll');

    const walk = beginSourceShadowRootWalk();
    try {
      for (const child of children) {
        expect(readSourceAssignedSlot(child)).toBe(root.querySelector('#default'));
      }
    } finally {
      walk.end();
    }
    expect(querySelectorAll).toHaveBeenCalledTimes(1);
    // Outside a walk the slots are read each time: the page may change them.
    readSourceAssignedSlot(children[0]!);
    expect(querySelectorAll).toHaveBeenCalledTimes(2);
  });
});

describe('one way to a shadow root (D125)', () => {
  const root = new URL('../', import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

  /** Every module the page script runs, followed through relative imports. */
  function pageScriptModules(entry: string): readonly string[] {
    const seen = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
      const path = pending.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const source = read(path);
      const specifiers = [
        ...source.matchAll(/^(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+'(\.[^']+)'/gmu),
        ...source.matchAll(/^import\s+'(\.[^']+)'/gmu),
      ].map((match) => match[1]!);
      for (const specifier of specifiers) {
        const resolved = new URL(specifier, new URL(path, root)).pathname
          .slice(root.pathname.length);
        pending.push(resolved.endsWith('.ts') ? resolved : `${resolved}.ts`);
      }
    }
    return [...seen].sort();
  }

  const modules = pageScriptModules('entrypoints/page-mirror.ts');

  // Lines that read the property of a node of the mirror's own graph (a
  // plain object sent to the panel), not of a page element.
  const graphLines: Readonly<Record<string, readonly string[]>> = {
    'lib/replica/html-mirror-protocol.ts': [
      'if (!node.shadowRoot) return;',
      'for (const cssText of node.shadowRoot.adoptedStyleSheets) {',
      'for (const child of node.shadowRoot.children) {',
    ],
    'lib/replica/html-mirror-source.ts': [
      'if (node.shadowRoot) {',
      'const shadow = this.environment.registry.getNode(node.shadowRoot.id);',
      'adoptedStyleSignature(node.shadowRoot.adoptedStyleSheets),',
      'for (const child of node.shadowRoot.children) this.#markMirroredGraph(child);',
      'if (shadow) this.#setEmittedChildren(shadow, node.shadowRoot.children);',
    ],
    'lib/replica/html-mirror-sanitizer.ts': [
      'input.shadowRoot !== undefined',
      '(isNativeSelectSemanticTag(input.tagName) && input.shadowRoot !== undefined) ||',
      'if (input.shadowRoot !== undefined) {',
      '!isRecord(input.shadowRoot) ||',
      '!hasExactKeys(input.shadowRoot, [',
      '!isNodeId(input.shadowRoot.id) ||',
      "input.shadowRoot.mode !== 'open' ||",
      '!Array.isArray(input.shadowRoot.children) ||',
      'budget.ids.has(input.shadowRoot.id)',
      'budget.ids.add(input.shadowRoot.id);',
      'for (const child of input.shadowRoot.children) {',
      'input.shadowRoot.adoptedStyleSheets,',
      'id: input.shadowRoot.id,',
    ],
  };
  const reach = new RegExp([
    // `x.shadowRoot`, `x?.shadowRoot`, `(x as Element).shadowRoot`
    String.raw`[\w$\])]\??\.(?:shadowRoot|assignedSlot)\b`,
    // `x['shadowRoot']`
    String.raw`\[\s*['"\x60](?:shadowRoot|assignedSlot)['"\x60]\s*\]`,
    // `const { shadowRoot } = x`
    String.raw`\{[^}]*\b(?:shadowRoot|assignedSlot)\b[^}]*\}\s*=[^=]`,
    String.raw`openOrClosedShadowRoot\s*\(`,
  ].join('|'), 'u');

  it('follows the whole page script', () => {
    expect(modules).toEqual(expect.arrayContaining([
      'entrypoints/page-mirror.ts',
      'lib/replica/html-mirror-source.ts',
      'lib/replica/html-mirror-sanitizer.ts',
      'lib/replica/source-privacy-policy.ts',
      'lib/replica/source-visibility-boundary.ts',
      'lib/replica/semantic-source-session.ts',
      'lib/replica/source-shadow-root.ts',
      'lib/ocr/source-image-observer.ts',
      'lib/ocr/image-source-session.ts',
      'lib/primary-scroll.ts',
    ]));
    expect(modules.length).toBeGreaterThan(30);
  });

  it.each(modules.filter((path) => path !== 'lib/replica/source-shadow-root.ts'))(
    '%s reaches a shadow root or slot only through source-shadow-root',
    (path) => {
      const allowed = new Set(graphLines[path] ?? []);
      const offending = read(path).split('\n')
        .map((line) => line.trim())
        .filter((line) => !line.startsWith('//') && !line.startsWith('*'))
        .filter((line) => reach.test(line) && !allowed.has(line));
      expect(offending).toEqual([]);
    },
  );

  it('notices a read on any name, by any syntax', () => {
    for (const line of [
      'const shadow = node.shadowRoot;',
      'const shadow = (current as Element).shadowRoot;',
      'const shadow = element?.shadowRoot;',
      "const shadow = element['shadowRoot'];",
      'const { shadowRoot } = element;',
      'const slot = child.assignedSlot;',
      'chrome.dom.openOrClosedShadowRoot(element);',
    ]) expect(reach.test(line), line).toBe(true);
    for (const line of [
      'children.push(...shadowRoot.childNodes);',
      'const shadowRoot = safelyReadShadowRoot(element);',
    ]) expect(reach.test(line), line).toBe(false);
  });

  it('keeps its list of allowed lines to lines that exist', () => {
    for (const [path, lines] of Object.entries(graphLines)) {
      const source = new Set(read(path).split('\n').map((line) => line.trim()));
      for (const line of lines) expect(source.has(line), `${path}: ${line}`).toBe(true);
    }
  });
});
