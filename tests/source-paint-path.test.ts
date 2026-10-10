import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  createSourcePaintScanCache,
  sourceElementPathHoldsPaint,
  sourceElementPathIsDisplayed,
  sourceElementPathIsPainted,
  sourceElementPathIsPaintedByPath,
  sourceElementPathIsShown,
} from '../lib/replica/source-privacy-policy';

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface PaintFacts {
  readonly display: string;
  readonly visibility: string;
  readonly opacity: string;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly clip: string;
  readonly clipPath: string;
  readonly rects: readonly Box[];
  /** The box of the nearest ancestor that has one. */
  readonly around: Box | undefined;
  readonly client: { left: number; top: number; width: number; height: number };
}

/** A small seeded generator, so a failing tree can be rebuilt from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Builds a random tree (with open shadow roots) and paint facts for each
 * element: hidden, faded and clip-path elements, several fragments, empty
 * boxes, `display: contents` wrappers, and overflow clipping on one axis or
 * both.
 */
function randomPage(seed: number) {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(next() * values.length)]!;
  const { document, window } = parseHTML('<html><body></body></html>');
  const facts = new Map<Element, PaintFacts>();
  // A box mostly inside its parent's, sometimes spilling out or elsewhere.
  const box = (parent: Box | undefined): Box => {
    const within = parent ?? { left: 0, top: 0, width: 1_200, height: 1_200 };
    if (next() < 0.1) {
      return {
        left: Math.round(next() * 1_400) - 200,
        top: Math.round(next() * 1_400) - 200,
        width: Math.round(next() * 400),
        height: Math.round(next() * 400),
      };
    }
    const spill = next() < 0.2 ? 1.6 : 1;
    const left = within.left + Math.round(next() * within.width * 0.6 * spill);
    const top = within.top + Math.round(next() * within.height * 0.6 * spill);
    return {
      left,
      top,
      width: next() < 0.04 ? 0 : Math.round(next() * within.width * 0.8 * spill),
      height: next() < 0.04 ? 0 : Math.round(next() * within.height * 0.8 * spill),
    };
  };
  const describe = (element: Element, parent?: Element, root = false) => {
    // A box-less wrapper passes its parent's box on to its children.
    const parentBox = parent
      ? facts.get(parent)?.rects[0] ?? facts.get(parent)?.around
      : undefined;
    const contents = !root && next() < 0.08;
    const rectCount = root ? 1 : contents || next() < 0.05 ? 0 : next() < 0.15 ? 2 + Math.floor(next() * 3) : 1;
    const rects = root
      ? [{ left: 0, top: 0, width: 1_200, height: 1_200 }]
      : Array.from({ length: rectCount }, () => box(parentBox));
    const first = rects[0];
    facts.set(element, {
      around: parentBox,
      display: contents
        ? 'contents'
        : !root && next() < 0.03 ? 'none' : pick(['block', 'inline', 'flex']),
      visibility: !root && next() < 0.02 ? 'hidden' : 'visible',
      opacity: !root && next() < 0.02 ? '0' : '1',
      overflowX: pick(['visible', 'visible', 'visible', 'hidden', 'auto', 'clip', 'scroll']),
      overflowY: pick(['visible', 'visible', 'visible', 'hidden', 'auto', 'clip']),
      clip: !root && next() < 0.01 ? 'rect(0px, 1px, 1px, 0px)' : 'auto',
      clipPath: !root && next() < 0.01 ? 'inset(1px)' : 'none',
      rects,
      client: first && next() < 0.9
        ? {
            left: Math.round(next() * 4),
            top: Math.round(next() * 4),
            width: Math.max(0, first.width - Math.round(next() * 10)),
            height: Math.max(0, first.height - Math.round(next() * 10)),
          }
        : { left: 0, top: 0, width: 0, height: 0 },
    });
    if (!root && next() < 0.02) element.setAttribute('hidden', '');
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => {
        const list = facts.get(element)!.rects.map((rect) => ({
          ...rect,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height,
        }));
        return { length: list.length, item: (index: number) => list[index] ?? null };
      },
    });
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      Object.defineProperty(element, `client${key[0]!.toUpperCase()}${key.slice(1)}`, {
        configurable: true,
        get: () => facts.get(element)!.client[key],
      });
    }
  };
  describe(document.documentElement, undefined, true);
  describe(document.body, undefined, true);
  const elements: Element[] = [];
  const grow = (parent: Element | ShadowRoot, depth: number) => {
    const count = depth > 7 ? 0 : Math.floor(next() * 4);
    for (let index = 0; index < count; index += 1) {
      const child = document.createElement(pick(['div', 'span', 'section', 'p']));
      parent.append(child);
      describe(
        child,
        'host' in parent ? (parent as ShadowRoot).host : parent as Element,
      );
      elements.push(child);
      if (depth < 6 && next() < 0.08) {
        grow(child.attachShadow({ mode: 'open' }) as unknown as ShadowRoot, depth + 1);
      } else {
        grow(child, depth + 1);
      }
    }
  };
  grow(document.body, 0);
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => {
      const style = facts.get(element)!;
      const values: Record<string, string> = {
        'content-visibility': 'visible',
        clip: style.clip,
        'clip-path': style.clipPath,
        'overflow-x': style.overflowX,
        'overflow-y': style.overflowY,
      };
      return {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        getPropertyValue: (name: string) => values[name] ?? '',
      };
    },
  });
  return { window: window as unknown as Window, elements, next };
}

describe('memoized painted-path proof', () => {
  it('matches the full path walk on random trees, in any visiting order', () => {
    let painted = 0;
    let checked = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const { window, elements, next } = randomPage(seed);
      // Visit in a shuffled order so memoized ancestors are sometimes
      // filled in from below and sometimes already known.
      const order = [...elements].sort(() => next() - 0.5);
      const memoized = createSourcePaintScanCache();
      for (const element of order) {
        const expected = sourceElementPathIsPaintedByPath(
          element,
          window,
          createSourcePaintScanCache(),
        );
        const actual = sourceElementPathIsPainted(element, window, memoized);
        if (actual !== expected) {
          throw new Error(`seed ${seed}: memoized ${actual}, path walk ${expected}`);
        }
        checked += 1;
        if (actual) painted += 1;
      }
    }
    // Both outcomes are well represented.
    expect(checked).toBeGreaterThan(5_000);
    expect(painted).toBeGreaterThan(checked * 0.05);
    expect(painted).toBeLessThan(checked * 0.9);
  });

  it('proves what a box-less ancestor holds, and not what a clip of no size holds (D135)', () => {
    const { document, window } = parseHTML(`<html><body>
      <div id="contents"><p id="in-contents">a</p></div>
      <div id="zero"><p id="in-zero">b</p></div>
      <div id="zero-clip"><p id="in-zero-clip">c</p><div id="contents-in-zero-clip"></div></div>
      <div id="contents-clip"><p id="in-contents-clip">d</p></div>
      <div id="hidden-contents"><p id="in-hidden-contents">e</p></div>
      <div id="declared-hidden" hidden><p id="in-declared-hidden">g</p><div id="zero-in-hidden"></div></div>
      <div id="faded-contents"><p id="in-faded-contents">h</p></div>
      <div id="said-hidden-contents" aria-hidden="true"><p id="in-said-hidden-contents">i</p></div>
      <div id="faded-block"><p id="in-faded-block">j</p></div>
      <div id="small-clip"><div id="contents-inside"><p id="outside-the-clip">f</p></div><div id="zero-in-clip"></div></div>
    </body></html>`);
    const byId = (id: string): HTMLElement => document.getElementById(id)!;
    const rect = (left: number, top: number, width: number, height: number) => ({
      left, top, width, height, right: left + width, bottom: top + height,
    });
    const rects = new Map<Element, ReturnType<typeof rect>[]>([
      [byId('contents'), []],
      [byId('zero'), []],
      [byId('zero-clip'), []],
      [byId('contents-clip'), []],
      [byId('contents-in-zero-clip'), []],
      [byId('hidden-contents'), []],
      [byId('declared-hidden'), []],
      [byId('faded-contents'), []],
      [byId('said-hidden-contents'), []],
      [byId('small-clip'), [rect(0, 0, 50, 50)]],
      [byId('contents-inside'), []],
      [byId('zero-in-clip'), []],
      [byId('zero-in-hidden'), []],
      [byId('outside-the-clip'), [rect(200, 200, 100, 20)]],
    ]);
    const styles = new Map<Element, Record<string, string>>([
      [byId('contents'), { display: 'contents' }],
      [byId('zero-clip'), { overflowX: 'hidden', overflowY: 'hidden' }],
      // A box-less wrapper clips nothing, whatever its overflow says.
      [byId('contents-clip'), { display: 'contents', overflowX: 'hidden', overflowY: 'hidden' }],
      [byId('hidden-contents'), { display: 'contents', visibility: 'hidden' }],
      [byId('declared-hidden'), { display: 'none' }],
      // What fades or clips a box does nothing to an element that has none,
      // and a declared `aria-hidden` has no box there to be checked against.
      [byId('faded-contents'), { display: 'contents', opacity: '0', clipPath: 'inset(50%)' }],
      [byId('said-hidden-contents'), { display: 'contents' }],
      [byId('faded-block'), { opacity: '0' }],
      [byId('small-clip'), { overflowX: 'hidden', overflowY: 'hidden' }],
      [byId('contents-inside'), { display: 'contents' }],
      [byId('contents-in-zero-clip'), { display: 'contents' }],
    ]);
    for (const element of document.querySelectorAll('*')) {
      Object.defineProperty(element, 'getClientRects', {
        configurable: true,
        value: () => {
          const list = rects.get(element) ?? [rect(0, 0, 100, 20)];
          return { length: list.length, item: (index: number) => list[index] ?? null };
        },
      });
      for (const name of ['clientLeft', 'clientTop']) {
        Object.defineProperty(element, name, { configurable: true, value: 0 });
      }
      Object.defineProperty(element, 'clientWidth', {
        configurable: true, value: (rects.get(element) ?? [rect(0, 0, 100, 20)])[0]?.width ?? 0,
      });
      Object.defineProperty(element, 'clientHeight', {
        configurable: true, value: (rects.get(element) ?? [rect(0, 0, 100, 20)])[0]?.height ?? 0,
      });
    }
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const style = {
          display: 'block', visibility: 'visible', opacity: '1',
          overflowX: 'visible', overflowY: 'visible', clipPath: 'none',
          ...styles.get(element),
        };
        return {
          ...style,
          getPropertyValue: (name: string) => ({
            'content-visibility': 'visible', clip: 'auto', 'clip-path': style.clipPath,
            'overflow-x': style.overflowX, 'overflow-y': style.overflowY,
          } as Record<string, string>)[name] ?? '',
        };
      },
    });
    const proofs = (id: string): [boolean, boolean] => [
      sourceElementPathIsPainted(byId(id), window as unknown as Window),
      sourceElementPathIsPaintedByPath(byId(id), window as unknown as Window),
    ];
    // Inside a `display: contents` wrapper, and inside a block of no height.
    expect(proofs('in-contents')).toEqual([true, true]);
    expect(proofs('in-zero')).toEqual([true, true]);
    expect(proofs('in-contents-clip')).toEqual([true, true]);
    // The wrapper itself: painted where its children could be; a block of
    // no size paints nothing of its own, though nothing hides it.
    expect(proofs('contents')).toEqual([true, true]);
    expect(proofs('contents-clip')).toEqual([true, true]);
    expect(proofs('zero')).toEqual([false, false]);
    const shown = (id: string): boolean =>
      sourceElementPathIsShown(byId(id), window as unknown as Window);
    expect(['zero', 'zero-clip', 'in-zero', 'in-zero-clip', 'contents'].map(shown))
      .toEqual([true, true, true, true, true]);
    expect(['hidden-contents', 'in-hidden-contents', 'in-declared-hidden'].map(shown))
      .toEqual([false, false, false]);
    // A box of no size that clips leaves nothing; a hidden wrapper hides.
    expect(proofs('in-zero-clip')).toEqual([false, false]);
    expect(proofs('in-hidden-contents')).toEqual([false, false]);
    expect(proofs('contents-in-zero-clip')).toEqual([false, false]);
    // Hidden by the page's own word and by its style: hidden, not box-less.
    expect(proofs('in-declared-hidden')).toEqual([false, false]);
    expect(proofs('in-faded-contents')).toEqual([true, true]);
    expect(proofs('in-said-hidden-contents')).toEqual([true, true]);
    expect(proofs('in-faded-block')).toEqual([false, false]);
    expect(sourceElementPathIsDisplayed(byId('in-faded-block'), window as unknown as Window))
      .toBe(true);
    expect(sourceElementPathIsDisplayed(byId('in-declared-hidden'), window as unknown as Window))
      .toBe(false);
    // A clip above a box-less wrapper still clips what the wrapper holds.
    expect(proofs('outside-the-clip')).toEqual([false, false]);
    expect(proofs('contents-inside')).toEqual([true, true]);
    // What an element holds may be painted: when it is painted itself, and
    // when it is shown, has no box of its own and clips nothing away (a
    // wrapper of no height around a positioned menu).
    const holds = (id: string): boolean =>
      sourceElementPathHoldsPaint(byId(id), window as unknown as Window);
    expect(['in-zero', 'zero', 'contents', 'contents-clip', 'zero-in-clip'].map(holds))
      .toEqual([true, true, true, true, true]);
    // Not one that clips with no size, sits in one, is hidden or sits in
    // something hidden; and one that has a box must prove it painted.
    expect([
      'zero-clip', 'contents-in-zero-clip', 'hidden-contents',
      'in-hidden-contents', 'declared-hidden', 'in-declared-hidden',
      'zero-in-hidden', 'faded-block', 'outside-the-clip',
    ].map(holds)).toEqual(Array.from({ length: 9 }, () => false));
  });
});
