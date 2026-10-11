import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHtmlMirrorAck,
  createHtmlMirrorCheckpointRequest,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  decodeHtmlMirrorWireMessage,
} from '../lib/replica/html-mirror-protocol';
import {
  HtmlMirrorSourceSession,
  WeakNodeIdRegistry,
} from '../lib/replica/html-mirror-source';
import { createReplicaIdentity } from '../lib/replica/replica-identity';
import {
  beginSourceSecretAncestorWalk,
  createSourceControlledContentPolicy,
  createSourcePaintScanCache,
  hasSourceCredentialSecretAncestor,
  readSourceElementPathPaint,
  sourceControlledStringByteLength,
  sourceElementPathIsPaintedByPath,
} from '../lib/replica/source-privacy-policy';
import { SourceVisibilityBoundaryIndex } from
  '../lib/replica/source-visibility-boundary';

/**
 * What a change on a large page costs (D144): each rule here leaves an
 * answer as it was and takes reads away, so each test counts reads beside
 * checking the answer.
 */
describe('the page reader reads less at a change (D144)', () => {
  it('reads nothing of what is inside something not displayed, and only the display and the visibility inside something not shown', () => {
    const page = paintedPage(`
      <div id="open"><p id="seen">seen</p></div>
      <div id="closed" data-display="none"><ul id="menu"><li id="entry">entry</li></ul></div>
      <div id="veiled" data-visibility="hidden"><p id="behind">behind</p><p id="gone" data-display="none"><b id="deep">deep</b></p></div>`);
    const index = new SourceVisibilityBoundaryIndex(
      page.document, page.window, 1_000,
    );
    page.reset();
    expect(index.refreshAll()).toEqual({ changedTargets: [], overflow: false });

    // Shown: everything is read, once.
    expect(page.reads('seen')).toEqual({ styles: 1, rects: 1, properties: 8 });
    // The element that is not displayed is read; what it holds is not.
    expect(page.reads('closed')).toEqual({ styles: 1, rects: 1, properties: 8 });
    expect(page.reads('menu')).toEqual({ styles: 0, rects: 0, properties: 0 });
    expect(page.reads('entry')).toEqual({ styles: 0, rects: 0, properties: 0 });
    // Inside what is displayed and not shown: the display, and for what is
    // displayed its visibility.
    expect(page.reads('veiled')).toEqual({ styles: 1, rects: 1, properties: 8 });
    expect(page.reads('behind')).toEqual({ styles: 1, rects: 0, properties: 2 });
    expect(page.reads('gone')).toEqual({ styles: 1, rects: 0, properties: 1 });
    expect(page.reads('deep')).toEqual({ styles: 0, rects: 0, properties: 0 });

    // And the answers are the ones a reading of everything gives.
    const cache = createSourcePaintScanCache();
    const paint = (id: string) => {
      const { painted, pathVisible, pathDisplayed } = readSourceElementPathPaint(
        page.byId(id), page.window, cache,
      );
      return { painted, pathVisible, pathDisplayed };
    };
    expect(paint('seen')).toEqual({ painted: true, pathVisible: true, pathDisplayed: true });
    expect(paint('entry')).toEqual({ painted: false, pathVisible: false, pathDisplayed: false });
    expect(paint('behind')).toEqual({ painted: false, pathVisible: false, pathDisplayed: true });
    expect(paint('deep')).toEqual({ painted: false, pathVisible: false, pathDisplayed: false });
    index.dispose();
  });

  it('tells an element its visibility hides from one that is only faded out, inside what is shown and inside what is not', () => {
    // A menu at the first frame of its fade: a class has made it visible,
    // and its opacity is still 0 (the review of D144: its text came when
    // the fade ended).
    const page = paintedPage(`
      <div id="menu" data-visibility="hidden" data-opacity="0"><b id="item">item</b></div>
      <div id="faded" data-opacity="0"><p id="inner" data-visibility="hidden">inner</p></div>
      <div id="closed" data-display="none"><p id="shut" data-visibility="hidden">shut</p></div>
      <div id="none" data-display="none" data-visibility="hidden">none</div>`);
    const cache = createSourcePaintScanCache();
    const veiled = (id: string) =>
      readSourceElementPathPaint(page.byId(id), page.window, cache).visibilityHidden;
    expect(veiled('menu')).toBe(true);
    // What it holds inherits the visibility: the page's style says so.
    page.byId('item').setAttribute('data-visibility', 'hidden');
    expect(veiled('item')).toBe(true);
    expect(veiled('faded')).toBe(false);
    expect(veiled('inner')).toBe(true);
    // Not displayed, by itself or by what is above: nobody asks.
    expect(veiled('shut')).toBe(false);
    expect(veiled('none')).toBe(false);

    const index = new SourceVisibilityBoundaryIndex(
      page.document, page.window, 1_000,
    );
    page.byId('menu').removeAttribute('data-visibility');
    page.byId('item').removeAttribute('data-visibility');
    expect(index.refreshAll()).toEqual({
      changedTargets: [page.byId('menu')],
      overflow: false,
    });
    // And inside something that stays faded out.
    page.byId('inner').removeAttribute('data-visibility');
    expect(index.refreshAll()).toEqual({
      changedTargets: [page.byId('inner')],
      overflow: false,
    });
    page.byId('inner').setAttribute('data-visibility', 'collapse');
    expect(index.refreshAll()).toEqual({
      changedTargets: [page.byId('inner')],
      overflow: false,
    });
    // The fade itself is no change of what is read.
    page.byId('faded').setAttribute('data-opacity', '0');
    expect(index.refreshAll()).toEqual({ changedTargets: [], overflow: false });
    index.dispose();
  });

  it('walks the children of a form whose fields are named like the links between elements', () => {
    const page = paintedPage(`
      <div id="before" data-display="none"><b>before</b></div>
      <form id="form">
        <div id="first" data-display="none"><b>first</b></div>
        <input id="field">
        <div id="last" data-display="none"><b>last</b></div>
      </form>
      <div id="after" data-display="none"><b>after</b></div>`);
    const form = page.byId('form');
    // A form answers `form.<field name>` before its own properties.
    for (const name of ['lastElementChild', 'previousElementSibling', 'children', 'firstElementChild', 'nextElementSibling']) {
      Object.defineProperty(form, name, { configurable: true, value: page.byId('field') });
    }
    const index = new SourceVisibilityBoundaryIndex(
      page.document, page.window, 1_000,
    );
    for (const id of ['before', 'first', 'last', 'after']) {
      page.byId(id).removeAttribute('data-display');
    }
    expect(index.refreshAll()).toEqual({
      changedTargets: ['before', 'first', 'last', 'after'].map(page.byId),
      overflow: false,
    });
    index.dispose();
  });

  it('still notices what is shown later inside what it did not read', () => {
    const page = paintedPage(`
      <div id="closed" data-display="none"><ul id="menu"><li id="entry">entry</li></ul></div>
      <div id="veiled" data-visibility="hidden"><p id="behind">behind</p></div>`);
    const index = new SourceVisibilityBoundaryIndex(
      page.document, page.window, 1_000,
    );
    page.byId('closed').removeAttribute('data-display');
    expect(index.refreshAll()).toEqual({
      changedTargets: [page.byId('closed')],
      overflow: false,
    });
    expect(index.takeShownElements()).toEqual([
      page.byId('closed'), page.byId('menu'), page.byId('entry'),
    ]);
    page.byId('veiled').removeAttribute('data-visibility');
    expect(index.refreshAll()).toEqual({
      changedTargets: [page.byId('veiled')],
      overflow: false,
    });
    // One element inside what stays veiled is itself taken from the page.
    page.byId('veiled').setAttribute('data-visibility', 'hidden');
    index.refreshAll();
    page.byId('behind').setAttribute('data-display', 'none');
    expect(index.refreshAll()).toEqual({
      changedTargets: [page.byId('behind')],
      overflow: false,
    });
    index.dispose();
  });

  it('gives every element of random trees the answers a walk of its whole path gives', () => {
    let seed = 20261011;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 60; round += 1) {
      const build = (depth: number): string => {
        const count = depth > 4 ? 0 : Math.floor(random() * 4);
        const attributes = [
          random() < 0.12 ? ' data-display="none"' : '',
          random() < 0.12 ? ' data-visibility="hidden"' : '',
          random() < 0.08 ? ' data-opacity="0"' : '',
          random() < 0.12 ? ' data-box="none"' : '',
          random() < 0.1 ? ' data-overflow="hidden"' : '',
        ].join('');
        let children = '';
        for (let index = 0; index < count; index += 1) children += build(depth + 1);
        return `<div${attributes}>${children}</div>`;
      };
      const page = paintedPage(build(0) + build(0));
      const cache = createSourcePaintScanCache();
      const elements = [...page.document.querySelectorAll('*')];
      // In a shuffled order, so parents are not always met first.
      for (let index = elements.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [elements[index], elements[other]] = [elements[other]!, elements[index]!];
      }
      for (const element of elements) {
        const path: Element[] = [];
        for (let current: Element | null = element; current; current = current.parentElement) {
          path.push(current);
        }
        const displayed = path.every((current) => !current.hasAttribute('data-display'));
        const shown = displayed && path.every((current) =>
          !current.hasAttribute('data-visibility') && !current.hasAttribute('data-opacity'));
        const paint = readSourceElementPathPaint(element, page.window, cache);
        expect(paint.pathDisplayed).toBe(displayed);
        expect(paint.pathVisible).toBe(shown);
        expect(paint.painted).toBe(
          sourceElementPathIsPaintedByPath(element, page.window, createSourcePaintScanCache()),
        );
      }
    }
  });

  it('reads the padding box only of an element that clips', () => {
    const page = paintedPage(`
      <div id="plain"><p id="inside">inside</p></div>
      <div id="clipper" data-overflow="hidden"><p id="clipped">clipped</p></div>`);
    const index = new SourceVisibilityBoundaryIndex(
      page.document, page.window, 1_000,
    );
    page.reset();
    index.refreshAll();
    expect(page.clientReads('plain')).toBe(0);
    expect(page.clientReads('inside')).toBe(0);
    expect(page.clientReads('clipper')).toBeGreaterThan(0);
    // What the clipper clips away is still not painted.
    page.rects.set(page.byId('clipped'), { left: 500, right: 600 });
    expect(index.refreshAll().changedTargets).toEqual([page.byId('clipped')]);
    index.dispose();
  });

  it('takes a rectangle of no height or no width for no box', () => {
    const page = paintedPage('<p id="flat">flat</p><p id="thin">thin</p><p id="full">full</p>');
    page.rects.set(page.byId('flat'), { left: 0, right: 100, height: 0 });
    page.rects.set(page.byId('thin'), { left: 50, right: 50 });
    const cache = createSourcePaintScanCache();
    const paint = (id: string) => {
      const { painted, pathVisible } = readSourceElementPathPaint(
        page.byId(id), page.window, cache,
      );
      return { painted, pathVisible };
    };
    expect(paint('flat')).toEqual({ painted: false, pathVisible: true });
    expect(paint('thin')).toEqual({ painted: false, pathVisible: true });
    expect(paint('full')).toEqual({ painted: true, pathVisible: true });
  });

  it('tells what is shown without a box from what is only displayed', () => {
    const page = paintedPage(
      '<div id="flat" data-box="none" data-visibility="hidden">hangs out of a box of no height</div>',
    );
    const index = new SourceVisibilityBoundaryIndex(
      page.document, page.window, 1_000,
    );
    // Displayed and hidden from the eye; then shown, with no box to prove.
    page.byId('flat').removeAttribute('data-visibility');
    expect(index.refreshAll()).toEqual({
      changedTargets: [page.byId('flat')],
      overflow: false,
    });
    index.dispose();
  });

  it('compares an element\'s own children first, in the page\'s order, and then its root\'s', () => {
    const page = paintedPage(
      '<x-host id="host" data-display="none"><i id="one"></i><i id="two"></i></x-host>',
    );
    const root = page.byId('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<b id="inner-one"></b><b id="inner-two"></b>';
    const inner = [...root.children];
    for (const element of inner) page.install(element);
    const index = new SourceVisibilityBoundaryIndex(
      page.document, page.window, 1_000,
    );
    page.byId('host').removeAttribute('data-display');
    index.refreshAll();
    expect(index.takeShownElements()).toEqual([
      page.byId('host'), page.byId('one'), page.byId('two'), ...inner,
    ]);
    index.dispose();
  });

  it('counts the comparisons of the whole page, and not those of a part', () => {
    const page = paintedPage('<div id="a"><p id="b">b</p></div>');
    const index = new SourceVisibilityBoundaryIndex(
      page.document, page.window, 1_000,
    );
    expect(index.wholeComparisons).toBe(0);
    index.refreshAll();
    expect(index.wholeComparisons).toBe(1);
    index.refreshMutations([{
      type: 'attributes', target: page.byId('b'), attributeName: 'class',
    } as unknown as MutationRecord]);
    expect(index.wholeComparisons).toBe(2);
    index.refreshWithin([page.byId('a')]);
    index.refreshInteractionTargets([]);
    expect(index.wholeComparisons).toBe(2);
    index.refreshInteractionTargets([page.byId('a')]);
    expect(index.wholeComparisons).toBe(3);
    index.dispose();
  });

  it('counts the bytes of an id as an encoder does, without one', () => {
    const samples = [
      '', 'plain-id_42', 'é', 'Ω€', '日本語', '😀', 'a😀b',
      '\ud83d', '\ude00', 'x\ud83dy', '\ude00\ud83d', '߿ࠀ￿',
    ];
    for (const sample of samples) {
      expect(sourceControlledStringByteLength(sample))
        .toBe(new TextEncoder().encode(sample).byteLength);
    }
    const page = paintedPage('<div id="one"></div><div id="two" aria-controls="one"></div>');
    const encoder = vi.spyOn(globalThis, 'TextEncoder');
    try {
      const policy = createSourceControlledContentPolicy(page.document, page.window);
      expect(policy.targets.has(page.byId('one'))).toBe(true);
      expect(encoder).not.toHaveBeenCalled();
    } finally {
      encoder.mockRestore();
    }
  });
});

describe('the page reader does a frame\'s work once (D144)', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
    });
  });

  it('looks for roots and reads the relationships once a frame, however many events tell of a layout change', () => {
    const fixture = sessionFixture('<main><p id="probe">text</p><img id="picture"></main>');
    fixture.start();
    fixture.settle();
    const before = fixture.relationshipReads();
    const resize = () => fixture.window.dispatchEvent(fixture.event('resize'));
    resize();
    resize();
    fixture.byId('picture').dispatchEvent(
      fixture.event('load'),
    );
    // Nothing is read at the events.
    expect(fixture.relationshipReads()).toBe(before);
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.relationshipReads()).toBe(before + 1);
  });

  it('looks at once in a tab that is not shown, where no frame comes', () => {
    const fixture = sessionFixture('<main><p id="probe">text</p></main>');
    fixture.start();
    fixture.settle();
    let visibility = 'hidden';
    Object.defineProperty(fixture.document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    const resize = () => fixture.window.dispatchEvent(fixture.event('resize'));
    const before = fixture.relationshipReads();
    resize();
    expect(fixture.relationshipReads()).toBe(before + 1);
    resize();
    expect(fixture.relationshipReads()).toBe(before + 2);
    // Shown again: the frame's.
    visibility = 'visible';
    while (fixture.frames.length > 0) fixture.flushFrame();
    const shown = fixture.relationshipReads();
    resize();
    resize();
    expect(fixture.relationshipReads()).toBe(shown);
    fixture.flushFrame();
    expect(fixture.relationshipReads()).toBe(shown + 1);
  });

  it('reads the relationships once in a frame that has a layout change and the end of a transition', () => {
    const fixture = sessionFixture(
      '<main><button id="tab" aria-controls="panel">tab</button><div id="panel">panel</div><p id="probe">text</p></main>',
    );
    fixture.start();
    fixture.settle();
    const before = fixture.relationshipReads();
    fixture.byId('panel').dispatchEvent(
      fixture.event('transitionend'),
    );
    fixture.window.dispatchEvent(fixture.event('resize'));
    fixture.flushFrame();
    expect(fixture.relationshipReads()).toBe(before + 1);
  });

  it('does not compare the whole page again for a size the resize observer reports and the reader has compared at', () => {
    const fixture = sessionFixture('<main><p id="probe">text</p></main>');
    fixture.start();
    fixture.settle();
    const probe = fixture.byId('probe');

    // A change of the page: compared in its frame.
    let compared = fixture.comparisons();
    probe.setAttribute('class', 'changed');
    fixture.mutate({ type: 'attributes', target: probe, attributeName: 'class' });
    fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared + 1);

    // The observer reports the size that frame was compared at.
    compared = fixture.comparisons();
    fixture.resizeObserved();
    while (fixture.frames.length > 0) fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared);

    // It reports another size: news.
    fixture.size.height = 4_000;
    fixture.resizeObserved();
    fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared + 1);

    // Any other teller of a layout change is believed as before.
    compared = fixture.comparisons();
    fixture.window.dispatchEvent(fixture.event('resize'));
    fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared + 1);
  });

  it('compares when the resize observer reports and the page was not compared since it was read whole', () => {
    const fixture = sessionFixture('<main><p id="probe">text</p></main>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const compared = fixture.comparisons();
    fixture.resizeObserved();
    fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared + 1);
  });

  it('compares at the size it compared at once the page has been read whole outside a frame', () => {
    const fixture = sessionFixture('<main><p id="probe">text</p></main>');
    fixture.start();
    fixture.settle();
    const probe = fixture.byId('probe');
    probe.setAttribute('class', 'changed');
    fixture.mutate({ type: 'attributes', target: probe, attributeName: 'class' });
    fixture.flushFrame();
    // The mirror is built again: that read was no frame's, and the
    // observer's next report may tell of something later.
    const sent = (fixture.port.posts.at(-1) as {
      identity: { sequence: number };
    }).identity.sequence;
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, sent));
    fixture.port.emitMessage(createHtmlMirrorAck(identity, sent));
    while (fixture.frames.length > 0) fixture.flushFrame();
    const compared = fixture.comparisons();
    fixture.resizeObserved();
    fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared + 1);
  });

  it('notes the size only at a comparison of the whole page', () => {
    const fixture = sessionFixture('<main><p id="probe">text</p></main>');
    fixture.start();
    fixture.settle();
    const probe = fixture.byId('probe');
    probe.setAttribute('class', 'changed');
    fixture.mutate({ type: 'attributes', target: probe, attributeName: 'class' });
    fixture.flushFrame();
    // A report of the size compared at: its frame compares nothing. The
    // page grows before that frame.
    let compared = fixture.comparisons();
    fixture.resizeObserved();
    fixture.size.height = 5_000;
    fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared);
    // The observer's report of the new size is still news.
    compared = fixture.comparisons();
    fixture.resizeObserved();
    fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared + 1);
  });

  it('compares at every report of the resize observer while the size cannot be read', () => {
    const fixture = sessionFixture('<main><p id="probe">text</p></main>');
    fixture.size.width = Number.NaN;
    fixture.start();
    fixture.settle();
    const probe = fixture.byId('probe');
    for (const name of ['one', 'two']) {
      probe.setAttribute('class', name);
      fixture.mutate({ type: 'attributes', target: probe, attributeName: 'class' });
      fixture.flushFrame();
      const compared = fixture.comparisons();
      fixture.resizeObserved();
      fixture.flushFrame();
      expect(fixture.comparisons()).toBe(compared + 1);
    }
  });

  it('takes no size from a body whose properties something else answers for', () => {
    const fixture = sessionFixture('<main><p id="probe">text</p></main>');
    // A page can name a form `body`, and a field of it `clientWidth`.
    Object.defineProperty(fixture.document.body, 'clientWidth', {
      configurable: true,
      get: () => fixture.byId('probe'),
    });
    fixture.start();
    fixture.settle();
    const probe = fixture.byId('probe');
    probe.setAttribute('class', 'changed');
    fixture.mutate({ type: 'attributes', target: probe, attributeName: 'class' });
    fixture.flushFrame();
    const compared = fixture.comparisons();
    fixture.resizeObserved();
    fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared + 1);
  });

  it('takes no size from a style that gives no padding', () => {
    const fixture = sessionFixture('<main><p id="probe">text</p></main>');
    const read = fixture.window.getComputedStyle.bind(fixture.window);
    Object.defineProperty(fixture.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const style = read(element);
        if (element !== fixture.document.body) return style;
        return new Proxy(style, {
          get: (target, name) => (name === 'paddingTop' ? undefined : Reflect.get(target, name)),
        });
      },
    });
    fixture.start();
    fixture.settle();
    const probe = fixture.byId('probe');
    probe.setAttribute('class', 'changed');
    fixture.mutate({ type: 'attributes', target: probe, attributeName: 'class' });
    fixture.flushFrame();
    const compared = fixture.comparisons();
    fixture.resizeObserved();
    fixture.flushFrame();
    expect(fixture.comparisons()).toBe(compared + 1);
  });

  it('takes the load of a style that imports nothing for no change, and any other load for one', () => {
    const fixture = sessionFixture(
      '<main><p id="probe">text</p><img id="picture"></main>',
      '<style id="plain">p{color:red}</style><style id="importing">p{color:blue}</style><style id="layered">p{color:green}</style><style id="unread">p{color:gray}</style><link id="linked" rel="stylesheet" href="late.css">',
    );
    const sheet = (id: string, rules: readonly object[]) =>
      Object.defineProperty(fixture.byId(id), 'sheet', {
        configurable: true,
        value: { cssRules: rules },
      });
    sheet('plain', [{ type: 1 }]);
    sheet('importing', [{ type: 0, nameList: ['a'] }, { type: 3, styleSheet: {} }, { type: 1 }]);
    sheet('layered', [{ type: 0, nameList: ['a'] }, { type: 1 }]);
    // A linked sheet's rules arrive with its load, whatever they are.
    sheet('linked', [{ type: 1 }]);
    Object.defineProperty(fixture.byId('unread'), 'sheet', {
      configurable: true,
      value: null,
    });
    fixture.start();
    fixture.settle();
    const load = (id: string): number => {
      const compared = fixture.comparisons();
      fixture.byId(id).dispatchEvent(fixture.event('load'));
      while (fixture.frames.length > 0) fixture.flushFrame();
      return fixture.comparisons() - compared;
    };
    expect(load('plain')).toBe(0);
    expect(load('layered')).toBe(0);
    expect(load('importing')).toBe(1);
    // A style whose sheet cannot be looked at.
    expect(load('unread')).toBe(1);
    expect(load('linked')).toBe(1);
    expect(load('picture')).toBe(1);
  });

  it('shares what is known of the secrets above an element only while a walk is open', () => {
    const page = paintedPage('<div><div><p id="deep">deep</p></div></div>');
    const deep = page.byId('deep');
    const ask = (): number => {
      const before = page.securityReads();
      expect(hasSourceCredentialSecretAncestor(deep, undefined, page.window)).toBe(false);
      return page.securityReads() - before;
    };
    const whole = ask();
    expect(whole).toBeGreaterThan(2);
    const walk = beginSourceSecretAncestorWalk();
    const inner = beginSourceSecretAncestorWalk();
    expect(ask()).toBe(whole);
    expect(ask()).toBe(0);
    inner.end();
    inner.end();
    // The outer walk is still open.
    expect(ask()).toBe(0);
    walk.end();
    // The page may have run since: everything is asked again.
    expect(ask()).toBe(whole);
  });

  it('asks once about the secrets above an element in a batch of changes and in the patch that follows', () => {
    const depth = 40;
    const fixture = sessionFixture(
      `${'<div class="nest">'.repeat(depth)}<p id="probe">innermost</p>${'</div>'.repeat(depth)}`,
    );
    fixture.start();
    fixture.settle();
    const nest = [...fixture.document.querySelectorAll('.nest')];
    for (const element of nest) element.setAttribute('title', 'tip');
    let asked = fixture.securityReads();
    fixture.mutateAll(nest.map((target) => ({
      type: 'attributes', target, attributeName: 'title',
    })));
    // Each element of the nest once, with the few above the nest: not once
    // for every pair of them (820).
    expect(fixture.securityReads() - asked).toBeLessThanOrEqual(depth + 4);
    asked = fixture.securityReads();
    fixture.flushFrame();
    expect(fixture.securityReads() - asked).toBeLessThanOrEqual(depth + 4);
    const patch = fixture.port.posts.at(-1) as { kind?: string };
    expect(patch.kind).toBe('simul:html-mirror-v2:patch');
    expect(JSON.stringify(patch).match(/"title","tip"/g)).toHaveLength(depth);
  });
});

const identity = createReplicaIdentity({
  sessionId: 'cost-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'cost-document',
  frameId: 0,
  sequence: 0,
});

interface Box {
  readonly left: number;
  readonly right: number;
  /** 20 when left out. */
  readonly height?: number;
}

/**
 * A page whose every element has a box and a style that shows it, unless
 * its `data-display`, `data-visibility`, `data-opacity`, `data-overflow` or
 * `data-box="none"` says otherwise. Every read of a style, of one of its
 * properties, of an element's rectangles and of its client box is counted.
 */
function paintedPage(body: string, head = '') {
  const { document, window } = parseHTML(
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
  );
  const styles = new Map<Element, number>();
  const properties = new Map<Element, number>();
  const rectReads = new Map<Element, number>();
  const clientReads = new Map<Element, number>();
  const securityReads = { count: 0 };
  const rects = new Map<Element, Box>();
  const bump = (counts: Map<Element, number>, element: Element) =>
    counts.set(element, (counts.get(element) ?? 0) + 1);
  const install = (element: Element) => {
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => {
        bump(rectReads, element);
        if (
          element.getAttribute('data-box') === 'none' ||
          element.getAttribute('data-display') === 'none'
        ) return rectList([]);
        return rectList([rects.get(element) ?? { left: 0, right: 100 }]);
      },
    });
    for (const name of ['clientLeft', 'clientTop', 'clientWidth', 'clientHeight']) {
      Object.defineProperty(element, name, {
        configurable: true,
        get: () => {
          bump(clientReads, element);
          return name === 'clientWidth' || name === 'clientHeight' ? 100 : 0;
        },
      });
    }
  };
  void document.head;
  for (const element of [...document.querySelectorAll('*')]) install(element);
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => {
      bump(styles, element);
      const values: Record<string, string> = {
        display: element.getAttribute('data-display') ?? 'block',
        visibility: element.getAttribute('data-visibility') ?? 'visible',
        opacity: element.getAttribute('data-opacity') ?? '1',
        'content-visibility': 'visible',
        clip: 'auto',
        'clip-path': 'none',
        'overflow-x': element.getAttribute('data-overflow') ?? 'visible',
        'overflow-y': element.getAttribute('data-overflow') ?? 'visible',
        'padding-top': '0px', 'padding-right': '0px',
        'padding-bottom': '0px', 'padding-left': '0px',
        'border-top-width': '0px', 'border-right-width': '0px',
        'border-bottom-width': '0px', 'border-left-width': '0px',
      };
      const read = (name: string): string => {
        if (name === '-webkit-text-security') {
          securityReads.count += 1;
          return 'none';
        }
        bump(properties, element);
        return values[name] ?? '';
      };
      const camel = (name: string) =>
        name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      const style: Record<string, unknown> = { getPropertyValue: read };
      for (const name of Object.keys(values)) {
        if (name === 'content-visibility' || name === 'clip' || name === 'clip-path') continue;
        Object.defineProperty(style, camel(name), { get: () => read(name) });
      }
      return style;
    },
  });
  const byId = (id: string) => document.querySelector(`#${id}`) as Element;
  return {
    document: document as unknown as Document,
    window: window as unknown as Window,
    /** An event of the page's own kind, which bubbles. */
    event: (type: string): Event => new window.Event(type, { bubbles: true }),
    rects,
    install,
    byId,
    securityReads: () => securityReads.count,
    rectReadsOf: (element: Element) => rectReads.get(element) ?? 0,
    reset: () => {
      styles.clear();
      properties.clear();
      rectReads.clear();
      clientReads.clear();
    },
    reads: (id: string) => ({
      styles: styles.get(byId(id)) ?? 0,
      rects: rectReads.get(byId(id)) ?? 0,
      properties: properties.get(byId(id)) ?? 0,
    }),
    clientReads: (id: string) => clientReads.get(byId(id)) ?? 0,
  };
}

function rectList(boxes: readonly Box[]): DOMRectList {
  const rects = boxes.map(({ left, right, height = 20 }) => ({
    left, right, top: 0, bottom: height, width: right - left, height,
  }));
  return {
    length: rects.length,
    item: (index: number) => rects[index] ?? null,
  } as unknown as DOMRectList;
}

/**
 * A page reader over `paintedPage`, with its frames, its mutation observer
 * and its resize observer in the test's hands. `size` is what the page and
 * its body measure.
 */
function sessionFixture(body: string, head = '') {
  const page = paintedPage(body, head);
  const { document, window } = page;
  Object.defineProperty(window, 'top', { configurable: true, value: window });
  Object.defineProperty(document, 'baseURI', {
    configurable: true,
    value: 'https://example.test/',
  });
  const size = { width: 1_000, height: 3_000 };
  for (const element of [document.documentElement, document.body]) {
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: size.width, height: size.height }),
    });
  }
  const posts: unknown[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const port = {
    name: createHtmlMirrorPortName(identity.sessionId),
    posts,
    onMessage: {
      addListener: (listener: (message: unknown) => void) => listeners.add(listener),
      removeListener: (listener: (message: unknown) => void) => listeners.delete(listener),
    },
    onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
    disconnect: () => undefined,
    postMessage: (message: unknown) => {
      posts.push(decodeHtmlMirrorWireMessage(message));
    },
    emitMessage: (message: unknown) => {
      for (const listener of [...listeners]) listener(message);
    },
  };
  const frames: Array<() => void> = [];
  let mutationCallback!: MutationCallback;
  let resizeCallback: (() => void) | undefined;
  const relationshipProbe = page.byId('probe');
  let relationshipReads = 0;
  const hasAttribute = relationshipProbe.hasAttribute.bind(relationshipProbe);
  Object.defineProperty(relationshipProbe, 'hasAttribute', {
    configurable: true,
    value: (name: string) => {
      // Each read of the relationships asks every element this, once.
      if (name === 'aria-controls') relationshipReads += 1;
      return hasAttribute(name);
    },
  });
  new HtmlMirrorSourceSession({
    port: port as never,
    document,
    window,
    registry: new WeakNodeIdRegistry(),
    now: () => 1,
    createMutationObserver: (callback) => {
      mutationCallback = callback;
      return { observe: () => undefined, disconnect: () => undefined };
    },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return callback;
    },
    cancelFrame: (handle) => {
      const index = frames.indexOf(handle as () => void);
      if (index >= 0) frames.splice(index, 1);
    },
    setTimer: () => 1,
    clearTimer: () => undefined,
    createResizeObserver: (callback) => {
      resizeCallback = callback as unknown as () => void;
      return { observe: () => undefined, disconnect: () => undefined };
    },
  });
  const flushFrame = () => {
    const frame = frames.shift();
    if (!frame) throw new Error('Expected a scheduled frame.');
    frame();
  };
  return {
    ...page,
    port,
    frames,
    size,
    flushFrame,
    start: () => port.emitMessage(createHtmlMirrorStart(identity, 'conservative')),
    /** The first mirror is acknowledged and what the start left is done. */
    settle: () => {
      port.emitMessage(createHtmlMirrorAck(identity, 0));
      resizeCallback?.();
      while (frames.length > 0) flushFrame();
    },
    mutate: (record: object) =>
      mutationCallback([record as MutationRecord], {} as MutationObserver),
    mutateAll: (records: readonly object[]) =>
      mutationCallback(records as MutationRecord[], {} as MutationObserver),
    resizeObserved: () => {
      if (!resizeCallback) throw new Error('No resize observer was made.');
      resizeCallback();
    },
    /** Whole comparisons so far: each reads the probe's rectangles once. */
    comparisons: () => page.rectReadsOf(relationshipProbe),
    relationshipReads: () => relationshipReads,
  };
}
