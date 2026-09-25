import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  createSourcePaintScanCache,
  sourceElementPathIsPainted,
  sourceElementPathIsPaintedByPath,
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
 * boxes, and overflow clipping on one axis or both.
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
    const parentBox = parent ? facts.get(parent)?.rects[0] : undefined;
    const rectCount = root ? 1 : next() < 0.05 ? 0 : next() < 0.15 ? 2 + Math.floor(next() * 3) : 1;
    const rects = root
      ? [{ left: 0, top: 0, width: 1_200, height: 1_200 }]
      : Array.from({ length: rectCount }, () => box(parentBox));
    const first = rects[0];
    facts.set(element, {
      display: !root && next() < 0.03 ? 'none' : pick(['block', 'inline', 'flex']),
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
});
