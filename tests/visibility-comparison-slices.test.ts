import { parseHTML } from 'linkedom';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
  collectSourceStyleNames,
  createSourceStyleNames,
  sourceVisibilityEventMaySkip,
  sourceVisibilityMutationMaySkip,
  type SourceStyleNames,
} from '../lib/replica/source-style-names';
import {
  SourceVisibilityBoundaryIndex,
  type SourceVisibilityBoundaryRefresh,
  type SourceVisibilityComparison,
} from '../lib/replica/source-visibility-boundary';

/**
 * The comparison of what the page paints in slices (D164): for a page that
 * does not change while it runs it ends as the comparison in one task does,
 * wherever its slices end; a page that changes meanwhile loses no state.
 */

function paintedStyle(display = 'block', visibility = 'visible'): CSSStyleDeclaration {
  return {
    display,
    visibility,
    opacity: '1',
    overflowX: 'visible',
    overflowY: 'visible',
    getPropertyValue: (name: string) => ({
      'content-visibility': 'visible',
      clip: 'auto',
      'clip-path': 'none',
      'overflow-x': 'visible',
      'overflow-y': 'visible',
    })[name] ?? '',
  } as unknown as CSSStyleDeclaration;
}

function rectList(): DOMRectList {
  const rects = [{
    x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40,
    toJSON: () => ({}),
  } as DOMRect];
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
}

/**
 * A page whose style is a function of the test's choosing; every element
 * of it has a box.
 */
function page(markup: string, style: (element: Element) => CSSStyleDeclaration) {
  const { document, window } = parseHTML(`<html><head></head><body>${markup}</body></html>`);
  void document.head;
  for (const element of document.querySelectorAll('*')) {
    Object.defineProperty(element, 'getClientRects', { configurable: true, value: rectList });
  }
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: style });
  onTestFinished(() => {
    // linkedom's windows share one object: leave none of this to the next.
    delete (window as unknown as Record<string, unknown>).getComputedStyle;
  });
  return {
    document: document as unknown as Document,
    window: window as unknown as Window,
    byId: (id: string) => document.getElementById(id) as unknown as HTMLElement,
    index: (maximumNodes = 1_000) => new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      maximumNodes,
    ),
  };
}

/** Hidden by class `gone`, veiled by class `veil`. */
function classStyle(element: Element): CSSStyleDeclaration {
  return paintedStyle(
    element.classList.contains('gone') ? 'none' : 'block',
    element.classList.contains('veil') ? 'hidden' : 'visible',
  );
}

const SECTIONS = Array.from({ length: 6 }, (_, section) =>
  `<section id="s${section}"><h2>Title ${section}</h2>` +
  Array.from({ length: 4 }, (_, row) =>
    `<div id="r${section}-${row}" class="${row === 1 ? 'gone' : ''}">` +
    `<p id="p${section}-${row}">Row <b>${row}</b></p></div>`).join('') +
  `<img id="i${section}" alt="">` +
  '</section>').join('');

/** Runs `comparison` to its end, with a turn wherever `expired` says. */
function runToEnd(
  comparison: SourceVisibilityComparison,
  expired: () => boolean,
  between: (turn: number) => void = () => {},
): { refresh: SourceVisibilityBoundaryRefresh; turns: number } {
  for (let turn = 0; turn < 10_000; turn += 1) {
    const refresh = comparison.step(expired);
    if (refresh) return { refresh, turns: turn };
    between(turn);
  }
  throw new Error('The comparison does not end.');
}

describe('the comparison in slices (D164)', () => {
  it('ends as the comparison in one task does, wherever a slice ends', () => {
    const target = page(SECTIONS, classStyle);
    const change = () => {
      target.byId('r0-1').classList.remove('gone');
      target.byId('r2-2').classList.add('gone');
      target.byId('r4-0').classList.add('veil');
      target.byId('s5').classList.add('gone');
    };
    const undo = () => {
      target.byId('r0-1').classList.add('gone');
      target.byId('r2-2').classList.remove('gone');
      target.byId('r4-0').classList.remove('veil');
      target.byId('s5').classList.remove('gone');
    };
    const reference = target.index();
    change();
    const expected = reference.refreshAll();
    const expectedShown = reference.takeShownElements();
    expect(expected.changedTargets.length).toBeGreaterThan(0);
    undo();
    const elements = target.document.querySelectorAll('*').length;
    // One turn after the k-th element, for every k; and a turn after each.
    const boundaries: Array<() => () => boolean> = [
      ...Array.from({ length: elements + 2 }, (_, k) => () => {
        let asked = 0;
        return () => (asked += 1) === k + 1;
      }),
      () => () => true,
    ];
    for (const boundary of boundaries) {
      const sliced = target.index();
      change();
      const { refresh } = runToEnd(sliced.beginRefreshAll(), boundary());
      expect(refresh).toEqual(expected);
      expect(sliced.hasSameStatesAs(reference)).toBe(true);
      expect(sliced.takeShownElements()).toEqual(expectedShown);
      expect(sliced.wholeComparisons).toBe(1);
      undo();
    }
  });

  it('proves the paint inputs an image change asks for in slices too', () => {
    const target = page(SECTIONS, classStyle);
    const record = {
      type: 'attributes',
      target: target.byId('i3'),
      attributeName: 'alt',
      attributeNamespace: null,
      oldValue: '',
    } as unknown as MutationRecord;
    const reference = target.index();
    const expected = reference.refreshMutations([record]);
    expect(expected).toEqual({ changedTargets: [], overflow: false });
    const sliced = target.index();
    const { refresh, turns } = runToEnd(sliced.beginRefreshMutations([record]), () => true);
    // A turn every other element of the walk and every other element whose
    // inputs are proven: more turns than a comparison without the proof.
    const whole = runToEnd(target.index().beginRefreshAll(), () => true).turns;
    expect(turns).toBeGreaterThan(whole + 20);
    expect(refresh).toEqual(expected);
    expect(sliced.hasSameStatesAs(reference)).toBe(true);
  });

  it('keeps the state of an element moved into what was compared, and the next comparison sees it change', () => {
    const target = page(
      '<div id="first"><p>first</p></div><div id="middle"><p>middle</p></div>' +
      '<div id="last"><p id="mover" class="gone">moved text</p></div>',
      classStyle,
    );
    const index = target.index();
    const comparison = index.beginRefreshAll();
    let asked = 0;
    const { turns } = runToEnd(comparison, () => (asked += 1) === 6, () => {
      // Compared so far: <html>, <head>, <body>, #first and what it holds.
      target.byId('first').prepend(target.byId('mover'));
    });
    expect(turns).toBe(1);
    // It was compared before as hidden: shown now, it is a change.
    target.byId('mover').classList.remove('gone');
    expect(index.refreshAll().changedTargets).toEqual([target.byId('mover')]);
  });

  it('does not read an element that left the page while it waited', () => {
    let removed: Element | undefined;
    const target = page(
      '<div id="a"><p>a</p></div><div id="b"><p>b</p></div><div id="c"><p>c</p></div>',
      (element) => {
        if (element === removed) throw new Error('read after it left the page');
        return classStyle(element);
      },
    );
    const index = target.index();
    let asked = 0;
    const { refresh } = runToEnd(index.beginRefreshAll(), () => (asked += 1) === 4, () => {
      removed = target.byId('c');
      removed.remove();
    });
    expect(refresh).toEqual({ changedTargets: [], overflow: false });
  });

  it('drops an element read before the page took it away: no false overflow, and the index does not keep it', () => {
    // Eight elements, the index's limit: html, head, body, #first, #gone,
    // #slide, #last, #mover.
    const markup = '<div id="first"><p id="gone">read, then removed</p></div>' +
      '<img id="slide" alt=""><div id="last"><p id="mover">moved</p></div>';
    const target = page(markup, classStyle);
    expect(target.document.querySelectorAll('*').length).toBe(8);
    const index = target.index(8);
    const record = {
      type: 'attributes',
      target: target.byId('slide'),
      attributeName: 'alt',
      attributeNamespace: null,
      oldValue: '',
    } as unknown as MutationRecord;
    let asked = 0;
    const { refresh, turns } = runToEnd(
      index.beginRefreshMutations([record]),
      () => (asked += 1) === 6,
      () => {
        // Compared so far: <html>, <head>, <body>, #first and #gone. The
        // page takes #gone away, moves #mover into what was compared (its
        // state is carried over) and adds an element the walk meets.
        target.byId('gone').remove();
        target.byId('first').prepend(target.byId('mover'));
        const added = target.document.createElement('span');
        Object.defineProperty(added, 'getClientRects', { configurable: true, value: rectList });
        target.byId('last').append(added);
      },
    );
    expect(turns).toBe(1);
    // Nine states were counted against a limit of eight before.
    expect(refresh).toEqual({ changedTargets: [], overflow: false });
    // The index holds what a fresh one of the page as it is now holds.
    expect(index.hasSameStatesAs(target.index(8))).toBe(true);
  });

  it('leaves the index as it was when cancelled, or when another begins', () => {
    const target = page(SECTIONS, classStyle);
    const reference = target.index();
    const index = target.index();
    target.byId('r1-1').classList.remove('gone');
    const first = index.beginRefreshAll();
    expect(first.step(() => true)).toBeUndefined();
    first.cancel();
    expect(first.step(() => false)).toBeUndefined();
    expect(index.hasSameStatesAs(reference)).toBe(true);
    expect(index.wholeComparisons).toBe(0);
    const second = index.beginRefreshAll();
    expect(second.step(() => true)).toBeUndefined();
    const third = index.beginRefreshAll();
    expect(second.step(() => false)).toBeUndefined();
    expect(index.hasSameStatesAs(reference)).toBe(true);
    expect(third.step(() => false)?.changedTargets).toEqual([target.byId('r1-1')]);
    expect(index.wholeComparisons).toBe(1);
    // Disposed: nothing goes on.
    const fourth = index.beginRefreshAll();
    expect(fourth.step(() => true)).toBeUndefined();
    index.dispose();
    expect(fourth.step(() => false)).toBeUndefined();
  });
});

/**
 * The shadow check of the skip rule (D164): on pages like those of
 * `source-visibility-boundary.test.ts`, each with the sheet that paints it as
 * its style function does, every change the rule leaves out is followed by
 * a comparison of the whole page, which must find nothing changed.
 */
describe('the changes the comparison leaves out change nothing it would find (D164)', () => {
  function namesOf(cssText: string): SourceStyleNames {
    const names = createSourceStyleNames();
    collectSourceStyleNames(cssText, names);
    return names;
  }

  function attribute(target: Element, name: string, value: string | null): MutationRecord {
    const oldValue = target.getAttribute(name);
    if (value === null) target.removeAttribute(name);
    else target.setAttribute(name, value);
    return {
      type: 'attributes',
      target,
      attributeName: name,
      attributeNamespace: null,
      oldValue,
    } as unknown as MutationRecord;
  }

  /**
   * Applies each change; one the rule leaves out is checked by a whole
   * comparison. Returns how many were left out and the names of those that
   * were compared.
   */
  function shadowCheck(
    index: SourceVisibilityBoundaryIndex,
    names: SourceStyleNames,
    changes: ReadonlyArray<readonly [string, () => MutationRecord | string]>,
  ): { skipped: string[]; compared: string[] } {
    const skipped: string[] = [];
    const compared: string[] = [];
    for (const [label, apply] of changes) {
      const change = apply();
      const skip = typeof change === 'string'
        ? sourceVisibilityEventMaySkip(change, () => names)
        : sourceVisibilityMutationMaySkip(change, () => names);
      if (skip) {
        skipped.push(label);
        expect(index.refreshAll(), label).toEqual({ changedTargets: [], overflow: false });
      } else {
        compared.push(label);
        // What a comparison would have done: the next skip starts from it.
        index.refreshAll();
      }
    }
    return { skipped, compared };
  }

  it('a panel hidden by its class', () => {
    const css = '.hidden { display: none } nav .panel { padding: 4px }';
    const target = page(
      `<div id="ordinary" class="one">ordinary</div><nav><div id="wrapper">
        <a id="trigger" title="About">About</a>
        <div id="panel" class="panel hidden">Private until painted</div></div></nav>`,
      (element) => paintedStyle(element.classList.contains('hidden') ? 'none' : 'block'),
    );
    const index = target.index();
    const { skipped, compared } = shadowCheck(index, namesOf(css), [
      ['class one to two', () => attribute(target.byId('ordinary'), 'class', 'two')],
      ['data-track', () => attribute(target.byId('panel'), 'data-track', 'menu')],
      ['aria-label', () => attribute(target.byId('trigger'), 'aria-label', 'Open')],
      ['title', () => attribute(target.byId('trigger'), 'title', 'More')],
      ['an unnamed token beside a named one', () =>
        attribute(target.byId('panel'), 'class', 'panel hidden is-open')],
      ['hidden token taken away', () => attribute(target.byId('panel'), 'class', 'panel is-open')],
      ['pointerover', () => 'pointerover'],
      ['focusin', () => 'focusin'],
    ]);
    expect(skipped).toEqual([
      'class one to two', 'data-track', 'aria-label', 'title',
      'an unnamed token beside a named one', 'pointerover', 'focusin',
    ]);
    expect(compared).toEqual(['hidden token taken away']);
  });

  it('a remote panel revealed by a data-state selector', () => {
    const css = 'button[data-state="open"] ~ aside { display: block } aside { display: none }';
    const target = page(
      `<button id="trigger" data-state="closed">Menu</button>
        <aside id="remote-panel">Remote authored menu text</aside>`,
      (element) => paintedStyle(
        element.id === 'remote-panel' &&
          target.byId('trigger').getAttribute('data-state') !== 'open'
          ? 'none'
          : 'block',
      ),
    );
    const index = target.index();
    const { skipped, compared } = shadowCheck(index, namesOf(css), [
      ['data-analytics', () => attribute(target.byId('trigger'), 'data-analytics', 'x')],
      ['data-state', () => attribute(target.byId('trigger'), 'data-state', 'open')],
      ['aria-expanded', () => attribute(target.byId('trigger'), 'aria-expanded', 'true')],
      ['aria-hidden', () => attribute(target.byId('remote-panel'), 'aria-hidden', 'false')],
    ]);
    expect(skipped).toEqual(['data-analytics', 'aria-expanded']);
    expect(compared).toEqual(['data-state', 'aria-hidden']);
  });

  it('text and children read through :has() and :empty are never left out', () => {
    const names = namesOf('section:has(.marker) ~ aside, span:empty ~ aside { display: block }');
    const target = page('<section id="local"></section><span id="m">x</span><aside>p</aside>', () =>
      paintedStyle());
    const childList = {
      type: 'childList',
      target: target.byId('local'),
      addedNodes: [],
      removedNodes: [],
    } as unknown as MutationRecord;
    const characterData = {
      type: 'characterData',
      target: target.byId('m').firstChild,
    } as unknown as MutationRecord;
    expect(sourceVisibilityMutationMaySkip(childList, () => names)).toBe(false);
    expect(sourceVisibilityMutationMaySkip(characterData, () => names)).toBe(false);
  });

  it('a hover or press that reveals text, and a page that reads neither', () => {
    let hover = false;
    let active = false;
    const css = '#wrapper.open #panel, #wrapper:hover #panel { display: block } ' +
      'nav button:active ~ aside { display: block } #panel, aside { display: none }';
    const target = page(
      `<nav><div id="wrapper"><a id="trigger">Company</a><div id="panel">Team</div></div>
        <button id="press">Products</button></nav><aside id="remote">Remote submenu</aside>`,
      (element) => paintedStyle(
        (element.id === 'panel' && !hover &&
          !target.byId('wrapper').classList.contains('open')) ||
          (element.id === 'remote' && !active)
          ? 'none'
          : 'block',
      ),
    );
    const index = target.index();
    const { skipped, compared } = shadowCheck(index, namesOf(css), [
      ['focusin', () => 'focusin'],
      ['pointerover', () => {
        hover = true;
        return 'pointerover';
      }],
      ['pointerdown', () => {
        active = true;
        return 'pointerdown';
      }],
      ['keyup', () => {
        active = false;
        return 'keyup';
      }],
      ['data-x on the wrapper', () => attribute(target.byId('wrapper'), 'data-x', '1')],
      ['class open', () => attribute(target.byId('wrapper'), 'class', 'open')],
    ]);
    // A sheet that reads the hover has a focus compared too (D164): a key
    // that scrolls the page moves the hover with no pointer event.
    expect(skipped).toEqual(['data-x on the wrapper']);
    expect(compared).toEqual(['focusin', 'pointerover', 'pointerdown', 'keyup', 'class open']);

    // The same page with no rule that reads the pointer: it paints the
    // same at a hover, and the hover is left out.
    hover = false;
    const still = namesOf('#panel { display: block }');
    const result = shadowCheck(index, still, [
      ['pointerover', () => 'pointerover'],
      ['pointerout', () => 'pointerout'],
      ['click', () => 'click'],
    ]);
    expect(result.skipped).toEqual(['pointerover', 'pointerout']);
    expect(result.compared).toEqual(['click']);
  });

  it('an image attribute selector, and an attribute read by attr()', () => {
    const css = 'img[alt="show"] ~ aside { display: block } aside { display: none } ' +
      '.tip::after { content: attr(data-tip) }';
    const target = page(
      `<section id="carousel"><img id="slide" alt="hide" data-src="a.png"></section>
        <aside id="remote-panel" class="tip" data-tip="x">Remote authored text</aside>`,
      (element) => paintedStyle(
        element.id === 'remote-panel' && target.byId('slide').getAttribute('alt') !== 'show'
          ? 'none'
          : 'block',
      ),
    );
    const index = target.index();
    const { skipped, compared } = shadowCheck(index, namesOf(css), [
      ['data-src', () => attribute(target.byId('slide'), 'data-src', 'b.png')],
      ['alt', () => attribute(target.byId('slide'), 'alt', 'show')],
      ['data-tip', () => attribute(target.byId('remote-panel'), 'data-tip', 'y')],
    ]);
    expect(skipped).toEqual(['data-src']);
    expect(compared).toEqual(['alt', 'data-tip']);
  });
});
