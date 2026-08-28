import { describe, expect, it } from 'vitest';

import { imageTransformIsAxisAligned } from '../lib/ocr/image-capture-style';

function style(
  transform = 'none',
  scale = 'none',
  rotate = 'none',
): CSSStyleDeclaration {
  return { transform, scale, rotate } as unknown as CSSStyleDeclaration;
}

describe('image capture transform safety', () => {
  it.each([
    ['none', 'none'],
    ['positive uniform number', '2'],
    ['positive independent numbers', '2 0.5'],
    ['positive percentages', '125% 80%'],
    ['neutral z scale', '2 0.5 1'],
  ])('accepts %s scale', (_description, scale) => {
    expect(imageTransformIsAxisAligned(style('none', scale))).toBe(true);
  });

  it.each([
    ['x reflection', '-1 1'],
    ['y reflection', '1 -1'],
    ['zero scale', '0'],
    ['non-neutral z scale', '1 1 2'],
    ['z reflection', '1 1 -1'],
    ['malformed scale', 'calc(1)'],
    ['too many components', '1 1 1 1'],
  ])('rejects %s', (_description, scale) => {
    expect(imageTransformIsAxisAligned(style('none', scale))).toBe(false);
  });

  it.each([
    ['2d translation and positive scale', 'matrix(2, 0, 0, 0.5, 20, -4)'],
    [
      '3d translation in the 2d plane',
      'matrix3d(2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 20, -4, 0, 1)',
    ],
  ])('accepts %s', (_description, transform) => {
    expect(imageTransformIsAxisAligned(style(transform, '125% 80%'))).toBe(true);
  });

  it.each([
    ['2d reflection', 'matrix(-1, 0, 0, 1, 0, 0)'],
    ['2d rotation', 'matrix(0, 1, -1, 0, 0, 0)'],
    [
      '3d perspective',
      'matrix3d(1, 0, 0, 0.01, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)',
    ],
  ])('rejects %s', (_description, transform) => {
    expect(imageTransformIsAxisAligned(style(transform))).toBe(false);
  });
});
