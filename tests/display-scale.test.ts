import { describe, expect, it } from 'vitest';

import { displayScale, normalizeZoomFactor } from '../lib/display-scale';

describe('display scale (D104)', () => {
  it('keeps a valid tab zoom and replaces anything else with 1', () => {
    expect(normalizeZoomFactor(1.25)).toBe(1.25);
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1.5', undefined, null]) {
      expect(normalizeZoomFactor(value)).toBe(1);
    }
  });

  it('fits by the given ratio, growing or shrinking, whatever the tab zoom', () => {
    expect(displayScale('fit', 0.5, 100, 2)).toBe(0.5);
    expect(displayScale('fit', 1.75, 100, 1)).toBe(1.75);
    expect(displayScale('fit', Number.NaN, 100, 1)).toBe(1);
    expect(displayScale('fit', 0, 100, 1)).toBe(1);
  });

  it('stops Fit at 5, however narrow the source', () => {
    expect(displayScale('fit', 4.9, 100, 1)).toBe(4.9);
    expect(displayScale('fit', 345, 100, 1)).toBe(5);
  });

  it('shows 1:1 at the tab zoom and multiplies custom zoom by it within 0.25–5', () => {
    expect(displayScale('actual', 3, 250, 1.25)).toBe(1.25);
    expect(displayScale('custom', 3, 200, 1.25)).toBe(2.5);
    expect(displayScale('custom', 3, 300, 5)).toBe(5);
    expect(displayScale('custom', 3, 25, 0.25)).toBe(0.25);
    expect(displayScale('custom', 3, Number.NaN, 1.5)).toBe(1.5);
  });
});
