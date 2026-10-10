import { describe, expect, it } from 'vitest';

import {
  imageTransformIsAxisAligned,
  styleReplacesImagePicture,
} from '../lib/ocr/image-capture-style';

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

describe('a picture that CSS alone decides', () => {
  const OWN = 'https://example.test/own.png';
  const picture = (
    content: string | undefined,
    viewBox: string | undefined,
  ): CSSStyleDeclaration => ({
    content,
    getPropertyValue: (name: string) =>
      name === 'object-view-box' ? viewBox ?? '' : '',
  }) as unknown as CSSStyleDeclaration;

  // Each value is as Chrome 154 and 138 compute it (the harness probe), and
  // each of these paints the image's own file.
  it.each([
    ['an ordinary image', 'normal', 'none'],
    ['content: none', 'none', 'none'],
    ['a style that reads nothing', '', ''],
    ['a style without the properties', undefined, undefined],
    ['an empty string', '""', 'none'],
    ['a string', '"x"', 'none'],
    ['attr(alt), computed to its string', '"alt"', 'none'],
    ['a counter', 'counter(c)', 'none'],
    ['counters', 'counters(c, ".")', 'none'],
    ['open-quote', 'open-quote', 'none'],
    ['close-quote', 'close-quote', 'none'],
    ['no-open-quote', 'no-open-quote', 'none'],
    ['no-close-quote', 'no-close-quote', 'none'],
    ['a string before an image', '"x" url("https://example.test/b.png")', 'none'],
    ['a counter before an image', 'counter(c) url("https://example.test/b.png")', 'none'],
    ['its own file', `url("${OWN}")`, 'none'],
    ['its own file with a text alternative', `url("${OWN}") / "alt"`, 'none'],
    ['a view box of no insets', 'normal', 'inset(0px)'],
    ['a view box of no insets, in percent', 'normal', 'inset(0%)'],
    ['a view box of four zero insets', 'normal', 'inset(0px 0% 0px 0px)'],
    ['xywh(0 0 100% 100%), as computed', 'normal', 'inset(0px 0% 0% 0px)'],
    ['zero insets with rounded corners', 'normal', 'inset(0px round 20px)'],
    ['its own file and a whole view box', `url("${OWN}")`, 'inset(0px)'],
  ])('is not %s', (_description, content, viewBox) => {
    expect(styleReplacesImagePicture(picture(content, viewBox), OWN)).toBe(false);
  });

  it.each([
    ['content: url() of another file', 'url("https://example.test/b.png")', 'none'],
    ['another file with a text alternative', 'url("https://example.test/b.png") / "alt"', 'none'],
    ['an image before a string', 'url("https://example.test/b.png") "x"', 'none'],
    ['its own file before a string', `url("${OWN}") "x"`, 'none'],
    ['another address of the same name', `url("${OWN}?v=2")`, 'none'],
    ['content: image-set()', 'image-set(url("https://example.test/b.png") 1dppx)', 'none'],
    ['a gradient', 'linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))', 'none'],
    ['a value this does not know', 'paint(worklet)', 'none'],
    ['half of the file', 'normal', 'inset(0px 50% 0px 0px)'],
    ['a pixel of the file cut off', 'normal', 'inset(1px)'],
    ['more than the file', 'normal', 'inset(-10px)'],
    ['xywh() in pixels, as computed', 'normal', 'inset(0px calc(100% - 280px) calc(100% - 150px) 0px)'],
    ['five insets', 'normal', 'inset(0px 0px 0px 0px 0px)'],
    ['a text content and a part of the file', '"x"', 'inset(0px 50% 0px 0px)'],
  ])('is an image with %s', (_description, content, viewBox) => {
    expect(styleReplacesImagePicture(picture(content, viewBox), OWN)).toBe(true);
  });

  it('takes a file for the image\'s own only when it is told which that is', () => {
    const own = picture(`url("${OWN}")`, 'none');
    expect(styleReplacesImagePicture(own, OWN)).toBe(false);
    expect(styleReplacesImagePicture(own)).toBe(true);
    expect(styleReplacesImagePicture(own, '')).toBe(true);
    expect(styleReplacesImagePicture(own, 'https://example.test/other.png'))
      .toBe(true);
    // An image that has loaded nothing has no file to be the same as.
    expect(styleReplacesImagePicture(picture('url("")', 'none'), '')).toBe(true);
  });

  it('reads a style object that has no getPropertyValue', () => {
    expect(styleReplacesImagePicture(
      { content: 'normal' } as unknown as CSSStyleDeclaration,
    )).toBe(false);
    expect(styleReplacesImagePicture(
      { content: 'url("b.png")' } as unknown as CSSStyleDeclaration,
    )).toBe(true);
  });
});
