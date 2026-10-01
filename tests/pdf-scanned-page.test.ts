import { describe, expect, it } from 'vitest';

import {
  PDF_SCAN_IMAGE_SHARE,
  PDF_SCAN_TEXT_SHARE,
  pdfImageCoverage,
  pdfTextShare,
  type PdfPaintOperator,
} from '../lib/pdf/pdf-scanned-page';

const LETTER = { width: 612, height: 792 };
const VIEW = [0, 0, 612, 792];

// Operator codes as a test's own: only the kinds matter.
const KINDS: readonly PdfPaintOperator[] = [
  'save', 'restore', 'transform', 'form-begin', 'annotation-begin',
  'image', 'image-repeat', 'mask-repeat', 'image-group', 'inline-group',
];
const CODES = new Map(KINDS.map((kind, index) => [index + 1, kind]));
const code = (kind: PdfPaintOperator) => KINDS.indexOf(kind) + 1;

function coverage(
  operators: readonly (readonly [PdfPaintOperator | 'other', unknown?])[],
  view: readonly number[] = VIEW,
): number {
  return pdfImageCoverage(
    {
      fnArray: operators.map(([kind]) => (kind === 'other' ? 99 : code(kind))),
      argsArray: operators.map(([, args]) => args ?? null),
    },
    CODES,
    view,
  );
}

const line = (str: string, width: number, height = 10) => ({ str, width, height });

describe('pdfTextShare', () => {
  it('adds up the boxes of the text runs over the page area', () => {
    // A header and a page number: far below the share of a scanned page.
    const stamped = pdfTextShare([line('Case 2:24-cv-01182', 300), line('Page 1 of 3', 50)], LETTER);
    expect(stamped).toBeCloseTo(3500 / (612 * 792), 6);
    expect(stamped).toBeLessThan(PDF_SCAN_TEXT_SHARE);

    // A page of body text: forty lines of 12 pt across the column.
    const body = Array.from({ length: 40 }, () => line('Body text.', 468, 12));
    expect(pdfTextShare(body, LETTER)).toBeGreaterThan(PDF_SCAN_TEXT_SHARE);
  });

  it('skips blank runs and counts rotated ones', () => {
    expect(pdfTextShare([line('   ', 500), line('', 500)], LETTER)).toBe(0);
    expect(pdfTextShare([line('Sideways', -100, 10)], LETTER)).toBeCloseTo(1000 / (612 * 792), 6);
  });

  it('calls a page it cannot measure full, so OCR leaves it alone', () => {
    expect(pdfTextShare([line('x', Number.NaN)], LETTER)).toBe(1);
    expect(pdfTextShare([line('x', 10)], { width: 0, height: 792 })).toBe(1);
    expect(pdfTextShare([line('x', 10)], { width: Number.NaN, height: 792 })).toBe(1);
  });
});

describe('pdfImageCoverage', () => {
  it('is 1 for a picture placed over the whole page', () => {
    expect(coverage([
      ['save'],
      ['transform', [612, 0, 0, 792, 0, 0]],
      ['image', ['img_p0_1', 1700, 2200]],
      ['restore'],
    ])).toBe(1);
    expect(1).toBeGreaterThanOrEqual(PDF_SCAN_IMAGE_SHARE);
  });

  it('is 0 without pictures, and small for a figure', () => {
    expect(coverage([['save'], ['transform', [612, 0, 0, 792, 0, 0]], ['restore']])).toBe(0);
    // A 480 by 120 point banner.
    const banner = coverage([
      ['save'], ['transform', [480, 0, 0, 120, 66, 600]], ['image'], ['restore'],
    ]);
    expect(banner).toBeGreaterThan(0.05);
    expect(banner).toBeLessThan(0.2);
  });

  it('follows nested transforms, as a scanner writes them', () => {
    // 0.24 points a pixel, y flipped, then the picture's size in pixels.
    expect(coverage([
      ['transform', [0.24, 0, 0, -0.24, 0, 792]],
      ['save'],
      ['save'],
      ['transform', [2550, 0, 0, -3300, 0, 3300]],
      ['image'],
      ['restore'],
      ['restore'],
    ])).toBe(1);
  });

  it('restores the place a save kept', () => {
    // The second picture is drawn after the restore, on the unit square.
    expect(coverage([
      ['save'],
      ['transform', [612, 0, 0, 396, 0, 0]],
      ['restore'],
      ['image'],
    ])).toBe(0);
    // A restore with nothing saved changes nothing.
    expect(coverage([['restore'], ['transform', [612, 0, 0, 792, 0, 0]], ['image']])).toBe(1);
  });

  it('adds up strips and tiles, counting overlaps once', () => {
    const strip = (index: number): readonly [PdfPaintOperator, unknown?][] => [
      ['save'], ['transform', [612, 0, 0, 198, 0, 198 * index]], ['image'], ['restore'],
    ];
    expect(coverage([...strip(0), ...strip(1)])).toBe(0.5);
    expect(coverage([...strip(0), ...strip(1), ...strip(2), ...strip(3)])).toBe(1);
    expect(coverage([...strip(0), ...strip(0), ...strip(0)])).toBe(0.25);
  });

  it('clips a picture to the page, and measures within a crop box', () => {
    // Twice the page, centred: still the whole page.
    expect(coverage([['transform', [1224, 0, 0, 1584, -306, -396]], ['image']])).toBe(1);
    // A crop box away from the origin.
    const crop = [100, 100, 400, 500];
    expect(coverage([['transform', [300, 0, 0, 400, 100, 100]], ['image']], crop)).toBe(1);
    expect(coverage([['transform', [300, 0, 0, 400, 0, 0]], ['image']], crop)).toBeLessThan(0.6);
    // A box given upside down is the same box.
    expect(coverage([['transform', [300, 0, 0, 400, 100, 100]], ['image']], [400, 500, 100, 100]))
      .toBe(1);
  });

  it('uses the box of a rotated picture', () => {
    // A quarter turn: the unit square goes to x in [-792, 0] before the shift.
    expect(coverage([['transform', [0, 792, -612, 0, 612, 0]], ['image']])).toBe(1);
  });

  it('applies a form\'s matrix and leaves it at the form\'s end', () => {
    expect(coverage([
      ['form-begin', [[612, 0, 0, 792, 0, 0], [0, 0, 1, 1]]],
      ['image'],
      ['restore'],
      ['image'],
    ])).toBe(1);
    // A form without a matrix keeps the place it is drawn at.
    expect(coverage([
      ['transform', [612, 0, 0, 792, 0, 0]],
      ['form-begin', [null, null]],
      ['image'],
      ['restore'],
    ])).toBe(1);
  });

  it('places an annotation on the page, not within the content', () => {
    expect(coverage([
      ['transform', [0.001, 0, 0, 0.001, 0, 0]],
      ['annotation-begin', ['id', [0, 0, 612, 792], [1, 0, 0, 1, 0, 0], [612, 0, 0, 792, 0, 0], false]],
      ['image'],
      ['restore'],
    ])).toBe(1);
  });

  it('counts repeated and grouped pictures', () => {
    // Four tiles of half the page each way.
    expect(coverage([['image-repeat', ['img', 306, 396, [0, 0, 306, 0, 0, 396, 306, 396]]]]))
      .toBe(1);
    expect(coverage([['mask-repeat', [{}, 306, 0, 0, 396, [0, 0, 306, 396]]]])).toBe(0.5);
    expect(coverage([['image-group', [[
      { transform: [612, 0, 0, 396, 0, 0] },
      { transform: [612, 0, 0, 396, 0, 396] },
    ]]]])).toBe(1);
    expect(coverage([['inline-group', [{}, [{ transform: [612, 0, 0, 396, 0, 0] }]]]])).toBe(0.5);
    // Typed arrays, as pdf.js sends positions.
    expect(coverage([['image-repeat', ['img', 612, 792, new Float32Array([0, 0])]]])).toBe(1);
  });

  it('ignores operators it does not know and arguments it cannot read', () => {
    expect(coverage([
      ['other', [1, 2, 3]],
      ['transform', ['a', 0, 0, 1, 0, 0]],
      ['transform', [1, 0, 0]],
      ['transform', null],
      ['image-repeat', ['img', 1, 1, 'nowhere']],
      ['image-group', ['not a list']],
      ['image-group', [[null, { transform: [Number.NaN, 0, 0, 1, 0, 0] }]]],
      ['transform', [612, 0, 0, 792, 0, 0]],
      ['image'],
    ])).toBe(1);
  });

  it('is 0 for a page box without an area', () => {
    const page: readonly (readonly [PdfPaintOperator, unknown?])[] = [
      ['transform', [612, 0, 0, 792, 0, 0]], ['image'],
    ];
    expect(coverage(page, [0, 0, 0, 792])).toBe(0);
    expect(coverage(page, [0, 0, Number.NaN, 792])).toBe(0);
    expect(coverage(page, [])).toBe(0);
  });
});
