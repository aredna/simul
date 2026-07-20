import { describe, expect, it } from 'vitest';

import { decideSmallImageEligibility } from '../lib/ocr/small-image-policy';

describe('small image policy', () => {
  it.each([
    [0, 100, 'zero-area'],
    [1, 1, 'tracking-pixel'],
    [39, 40, 'small-rendered'],
    [40, 40, 'eligible'],
    [95, 16, 'small-rendered'],
    [96, 2, 'eligible'],
    [2, 200, 'eligible'],
  ] as const)('classifies %sx%s at the exact rendered boundary', (width, height, reason) => {
    expect(decideSmallImageEligibility({
      renderedWidth: width,
      renderedHeight: height,
      intrinsicWidth: 100,
      intrinsicHeight: 100,
    }, { skipSmallImages: true })).toMatchObject({ reason });
  });

  it('uses strict intrinsic boundaries and lets an override bypass valid small dimensions', () => {
    expect(decideSmallImageEligibility({
      renderedWidth: 200,
      renderedHeight: 40,
      intrinsicWidth: 31,
      intrinsicHeight: 31,
    }, { skipSmallImages: true })).toEqual({
      eligible: false,
      reason: 'small-intrinsic',
    });
    expect(decideSmallImageEligibility({
      renderedWidth: 200,
      renderedHeight: 40,
      intrinsicWidth: 32,
      intrinsicHeight: 32,
    }, { skipSmallImages: true })).toEqual({
      eligible: true,
      reason: 'eligible',
    });
    expect(decideSmallImageEligibility({
      renderedWidth: 10,
      renderedHeight: 10,
    }, { skipSmallImages: true, manualOverride: true })).toEqual({
      eligible: true,
      reason: 'manual-override',
    });
  });

  it('rejects malformed dimensions even for an override and bypasses heuristics when disabled', () => {
    expect(decideSmallImageEligibility({
      renderedWidth: Number.NaN,
      renderedHeight: 10,
    }, { skipSmallImages: false, manualOverride: true })).toEqual({
      eligible: false,
      reason: 'invalid-dimensions',
    });
    expect(decideSmallImageEligibility({
      renderedWidth: 10,
      renderedHeight: 10,
    }, { skipSmallImages: false })).toEqual({
      eligible: true,
      reason: 'filter-disabled',
    });
  });
});
