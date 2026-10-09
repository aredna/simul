import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import type { RgbaPixels } from '../lib/pdf/colour-sample';
import {
  PDF_TOOLBAR_HEIGHT,
  composePdfPageBoxLine,
  findPdfPageBox,
  pdfPageFromBoxText,
  type PdfPageBoxLayout,
} from '../lib/pdf/pdf-page-box';

interface StripFixture {
  readonly file: string;
  readonly scale: number;
  readonly pageCount: number;
  /** The viewer's own page, and the text in its page box. */
  readonly page: number;
  readonly box: string;
  readonly chrome: string;
  readonly font?: string;
  readonly state?: string;
}

const directory = resolve('tests/fixtures/pdf-toolbar');
const { strips } = JSON.parse(readFileSync(resolve(directory, 'strips.json'), 'utf8')) as {
  strips: StripFixture[];
};
/** Strips whose page box shows a plain number, whatever else the toolbar shows. */
const plain = strips.filter((strip) =>
  !/selected|caret|more-menu/u.test(strip.file));

async function pixelsOf(file: string): Promise<RgbaPixels> {
  const image = await loadImage(resolve(directory, file));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height);
}

function layoutOf(pixels: RgbaPixels, strip: StripFixture): PdfPageBoxLayout {
  const search = findPdfPageBox(pixels, strip.scale, strip.pageCount);
  if (!search.found) throw new Error(`${strip.file}: no page box (${search.missing})`);
  return search.layout;
}

describe('the page box in pictures of Chrome\'s PDF toolbar (D133)', () => {
  it('has fixtures of Chrome 154 and 138, four device scales and other fonts', () => {
    expect(new Set(strips.map((strip) => strip.scale))).toEqual(new Set([1, 1.25, 1.5, 2]));
    expect(new Set(strips.map((strip) => strip.chrome))).toEqual(new Set(['154', '138']));
    expect(new Set(strips.map((strip) => strip.font))).toEqual(
      new Set([undefined, 'Selawik', 'Inter', 'Liberation Sans']),
    );
    expect(plain.length).toBeGreaterThanOrEqual(30);
  });

  it.each(plain.map((strip) => [strip.file, strip] as const))(
    'finds the box, its digits and the count in %s',
    async (_file, strip) => {
      const pixels = await pixelsOf(strip.file);
      expect(pixels.height).toBe(Math.round(PDF_TOOLBAR_HEIGHT * strip.scale));
      const layout = layoutOf(pixels, strip);
      // Chrome's page box is 20 CSS pixels tall, its digits about 10.
      const { box, number, count } = layout;
      expect((box.bottom - box.top) / strip.scale).toBeGreaterThan(17);
      expect((box.bottom - box.top) / strip.scale).toBeLessThan(23);
      expect(layout.digits).toBe(strip.box.length);
      expect(number.left).toBeGreaterThan(box.left);
      expect(number.right).toBeLessThan(box.right);
      expect(number.top).toBeGreaterThan(box.top);
      expect(number.bottom).toBeLessThan(box.bottom);
      expect(count.left).toBeGreaterThan(box.right);
      expect(layout.boxLuma).toBeLessThan(layout.barLuma);
    },
  );

  it.each([
    ['state-1x-selected.png', 'the number selected'],
    ['state-2x-selected.png', 'the number selected'],
    ['state-1x-typed-caret.png', 'a caret after typed digits'],
    ['state-2x-typed-caret.png', 'a caret after a typed digit'],
    ['state-1x-more-menu.png', 'the toolbar under an open menu'],
  ])('finds no plain number in %s (%s)', async (file) => {
    const strip = strips.find((entry) => entry.file === file)!;
    const search = findPdfPageBox(await pixelsOf(file), strip.scale, strip.pageCount);
    expect(search.found).toBe(false);
  });

  it('finds no page box in a narrow tab\'s toolbar, which has none', async () => {
    // A tab 374 CSS pixels wide: Chrome leaves the page selector out.
    expect(findPdfPageBox(await pixelsOf('no-page-box-narrow-tab.png'), 1, 300))
      .toEqual({ found: false, missing: 'box' });
  });

  it('finds no toolbar in the top of a PDF page', async () => {
    // What a capture shows where the toolbar would be when it is hidden.
    const search = findPdfPageBox(await pixelsOf('no-toolbar-page.png'), 1, 300);
    expect(search.found).toBe(false);
  });

  it('takes the box for another PDF\'s when the count has other digits', async () => {
    // "111 / 300" in a box sized for three digits; a PDF of 40 pages has a
    // box for two, so three digits do not fit it.
    const strip = strips.find((entry) => entry.file === 'own-1x-111-of-300.png')!;
    const pixels = await pixelsOf(strip.file);
    expect(findPdfPageBox(pixels, 1, 300).found).toBe(true);
    expect(findPdfPageBox(pixels, 1, 40)).toEqual({ found: false, missing: 'number' });
  });

  it('refuses a scale, a page count or pixels that are not what they say', async () => {
    const strip = strips.find((entry) => entry.file === 'own-1x-55-of-300.png')!;
    const pixels = await pixelsOf(strip.file);
    expect(findPdfPageBox(pixels, 0, 300).found).toBe(false);
    expect(findPdfPageBox(pixels, Number.NaN, 300).found).toBe(false);
    expect(findPdfPageBox(pixels, 1, 0).found).toBe(false);
    expect(findPdfPageBox(pixels, 1, 2.5).found).toBe(false);
    expect(findPdfPageBox({ ...pixels, height: pixels.height * 2 }, 1, 300).found).toBe(false);
    // Read at twice its scale the box is too small to be one.
    expect(findPdfPageBox(pixels, 2, 300).found).toBe(false);
  });
});

describe('the picture made for reading (D133)', () => {
  /** Runs of columns that hold ink: [start, end). */
  function inkColumns(width: number, inked: (x: number) => boolean): [number, number][] {
    const found: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const on = x < width && inked(x);
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        found.push([start, x]);
        start = -1;
      }
    }
    return found;
  }

  it('is the number and the count as dark ink on white, and nothing else of the strip', async () => {
    const strip = strips.find((entry) => entry.file === 'own-2x-199-of-300.png')!;
    const pixels = await pixelsOf(strip.file);
    const layout = layoutOf(pixels, strip);
    const line = composePdfPageBoxLine(pixels, layout);
    const inkHeight = layout.number.bottom - layout.number.top;
    expect(line.inkHeight).toBe(inkHeight);
    expect(line.data).toHaveLength(line.width * line.height);
    // The two parts, a gap between them and a margin around: far narrower
    // than the toolbar.
    expect(line.width).toBeLessThan(pixels.width / 8);
    const at = (x: number, y: number) => line.data[y * line.width + x]!;
    // White all round.
    for (let x = 0; x < line.width; x += 1) {
      expect(at(x, 0)).toBe(255);
      expect(at(x, line.height - 1)).toBe(255);
    }
    for (let y = 0; y < line.height; y += 1) {
      expect(at(0, y)).toBe(255);
      expect(at(line.width - 1, y)).toBe(255);
    }
    // Seven glyphs: 1, 9, 9, the divider, 3, 0, 0.
    const glyphs = inkColumns(line.width, (x) => {
      for (let y = 0; y < line.height; y += 1) if (at(x, y) < 178) return true;
      return false;
    });
    expect(glyphs).toHaveLength(7);
    const white = [...line.data].filter((value) => value === 255).length;
    expect(white).toBeGreaterThan(line.data.length * 0.6);
  });

  it('lifts each part off its own ground and gives the glyphs more room', async () => {
    const strip = strips.find((entry) => entry.file === 'own-2x-199-of-300.png')!;
    const pixels = await pixelsOf(strip.file);
    const layout = layoutOf(pixels, strip);
    const line = composePdfPageBoxLine(pixels, layout);
    const lumaAt = (x: number, y: number) => {
      const index = (y * pixels.width + x) * 4;
      return 0.299 * pixels.data[index]! + 0.587 * pixels.data[index + 1]! +
        0.114 * pixels.data[index + 2]!;
    };
    const inkOver = (ground: number) => (x: number, y: number) =>
      Math.min(1, Math.max(0, (lumaAt(x, y) - ground) / (255 - ground)));
    const overBox = inkOver(layout.boxLuma);
    const { number } = layout;
    const digits = inkColumns(number.right - number.left, (offset) => {
      for (let y = number.top; y < number.bottom; y += 1) {
        if (overBox(number.left + offset, y) >= 0.3) return true;
      }
      return false;
    });
    expect(digits).toHaveLength(3);
    const top = Math.min(layout.number.top, layout.count.top);
    const margin = (line.height - (Math.max(layout.number.bottom, layout.count.bottom) - top)) / 2;
    const spread = Math.round(0.2 * line.inkHeight);
    expect(spread).toBeGreaterThan(0);
    let soft = 0;
    digits.forEach(([start, end], index) => {
      for (let y = number.top; y < number.bottom; y += 1) {
        for (let offset = start; offset < end; offset += 1) {
          const x = number.left + offset;
          // The soft edge of a digit, between the box's colour and the
          // bar's, is ink over the box and would be none over the bar.
          if (lumaAt(x, y) > layout.boxLuma + 4 && lumaAt(x, y) < layout.barLuma) soft += 1;
          expect(line.data[(margin + y - top) * line.width + margin + offset + index * spread])
            .toBe(Math.round(255 * (1 - overBox(x, y))));
        }
      }
    });
    expect(soft).toBeGreaterThan(0);
  });

  it('gives the glyphs no more room when asked for the number as it stands', async () => {
    const strip = strips.find((entry) => entry.file === 'own-2x-199-of-300.png')!;
    const pixels = await pixelsOf(strip.file);
    const layout = layoutOf(pixels, strip);
    const spaced = composePdfPageBoxLine(pixels, layout);
    const plain = composePdfPageBoxLine(pixels, layout, false);
    // Seven glyphs, three in the number and four after it: five gaps within
    // the two parts, each a fifth of the digits' height wider when spaced.
    const spread = Math.round(0.2 * spaced.inkHeight);
    expect(spaced.width - plain.width).toBe(5 * spread);
    expect(plain.height).toBe(spaced.height);
    expect(plain.inkHeight).toBe(spaced.inkHeight);
    // The same ink, column for column, where the strip has it.
    const { number } = layout;
    const top = Math.min(layout.number.top, layout.count.top);
    const margin = (plain.height - (Math.max(layout.number.bottom, layout.count.bottom) - top)) / 2;
    const lumaAt = (x: number, y: number) => {
      const index = (y * pixels.width + x) * 4;
      return 0.299 * pixels.data[index]! + 0.587 * pixels.data[index + 1]! +
        0.114 * pixels.data[index + 2]!;
    };
    for (let y = number.top; y < number.bottom; y += 1) {
      for (let x = number.left; x < number.right; x += 1) {
        const ink = Math.min(1, Math.max(0, (lumaAt(x, y) - layout.boxLuma) / (255 - layout.boxLuma)));
        const shown = plain.data[(margin + y - top) * plain.width + margin + x - number.left]!;
        // Between glyphs nothing is drawn: white.
        expect(shown === Math.round(255 * (1 - ink)) || shown === 255).toBe(true);
      }
    }
  });
});

describe('the page a reading names (D133)', () => {
  const two = { digits: 2 };

  it('takes a number of as many digits as the box holds, a divider and the PDF\'s own count', () => {
    expect(pdfPageFromBoxText('12 / 300', two, 300)).toBe(12);
    expect(pdfPageFromBoxText('12/300', two, 300)).toBe(12);
    expect(pdfPageFromBoxText(' 12 /300\n', two, 300)).toBe(12);
    expect(pdfPageFromBoxText('300 / 300', { digits: 3 }, 300)).toBe(300);
    expect(pdfPageFromBoxText('1 / 4', { digits: 1 }, 4)).toBe(1);
  });

  it('takes nothing when the count is another PDF\'s', () => {
    expect(pdfPageFromBoxText('12 / 308', two, 300)).toBeUndefined();
    expect(pdfPageFromBoxText('12 / 30', two, 300)).toBeUndefined();
    expect(pdfPageFromBoxText('12 / 3000', two, 300)).toBeUndefined();
  });

  it('takes nothing when a digit was dropped or doubled in reading', () => {
    // "11" read as "1": the box holds two digits.
    expect(pdfPageFromBoxText('1 / 300', two, 300)).toBeUndefined();
    expect(pdfPageFromBoxText('112 / 300', two, 300)).toBeUndefined();
  });

  it('takes nothing that is not a page of the PDF', () => {
    expect(pdfPageFromBoxText('0 / 300', { digits: 1 }, 300)).toBeUndefined();
    expect(pdfPageFromBoxText('07 / 300', two, 300)).toBeUndefined();
    expect(pdfPageFromBoxText('301 / 300', { digits: 3 }, 300)).toBeUndefined();
  });

  it('takes nothing when anything but digits and the divider was read', () => {
    for (const text of [
      '', '12', '12 300', '12 | 300', 'l2 / 300', '12 / 3OO', '12 / 300 86%', '- 12 / 300',
      '12 // 300', '1 2 / 3 0 0 x', '12 {300', '12 =/ 300',
    ]) {
      expect(pdfPageFromBoxText(text, two, 300), text).toBeUndefined();
    }
  });
});

/** A toolbar strip painted with blocks: a bar, a box, and bars of ink for glyphs. */
function paintedStrip(options: {
  readonly width?: number;
  readonly box?: { left: number; top: number; width: number; height: number };
  /** Ink in the box: [left, width] of each run, from the box's left edge. */
  readonly digits?: readonly (readonly [number, number, number?, number?])[];
  /** Ink after the box: [distance from the box's right edge, width]. */
  readonly count?: readonly (readonly [number, number])[];
  readonly bar?: number;
}): RgbaPixels {
  const width = options.width ?? 400;
  const height = PDF_TOOLBAR_HEIGHT;
  const data = new Uint8ClampedArray(width * height * 4);
  const fill = (left: number, top: number, w: number, h: number, value: number) => {
    for (let y = top; y < top + h; y += 1) {
      for (let x = left; x < left + w; x += 1) {
        data.set([value, value, value, 255], (y * width + x) * 4);
      }
    }
  };
  fill(0, 0, width, height, options.bar ?? 60);
  const box = options.box ?? { left: 100, top: 18, width: 32, height: 20 };
  fill(box.left, box.top, box.width, box.height, 30);
  for (const [left, run, top = 5, tall = 10] of options.digits ?? []) {
    fill(box.left + left, box.top + top, run, tall, 255);
  }
  for (const [distance, run] of options.count ?? [[5, 3], [13, 6], [21, 6], [29, 6]]) {
    fill(box.left + box.width + distance, box.top + 5, run, 10, 255);
  }
  return { width, height, data };
}

describe('the rules of the page box, on painted strips (D133)', () => {
  it('counts the digits by their runs of ink', () => {
    const search = findPdfPageBox(paintedStrip({ digits: [[9, 6], [17, 6]] }), 1, 300);
    expect(search).toMatchObject({ found: true, layout: { digits: 2 } });
  });

  it('counts digits that touch by how wide a digit\'s place is', () => {
    // Three digits' worth of ink in one run and a half: 7.7 px a place.
    const search = findPdfPageBox(paintedStrip({ digits: [[5, 14], [20, 6]] }), 1, 300);
    expect(search).toMatchObject({ found: true, layout: { digits: 3 } });
  });

  it('takes no number with more digits than the count has', () => {
    const strip = paintedStrip({ digits: [[4, 5], [10, 5], [16, 5], [22, 5]] });
    expect(findPdfPageBox(strip, 1, 300)).toEqual({ found: false, missing: 'number' });
  });

  it('takes no number beside a caret: ink taller than the digits', () => {
    // A caret as tall as the line, and a mark as wide as a digit but taller.
    const caret = paintedStrip({ digits: [[9, 6], [17, 6], [24, 1, 2, 16]] });
    expect(findPdfPageBox(caret, 1, 300).found).toBe(false);
    const mark = paintedStrip({ digits: [[9, 6], [17, 6], [25, 3, 3, 14]] });
    expect(findPdfPageBox(mark, 1, 300)).toEqual({ found: false, missing: 'number' });
  });

  it('takes no number with a mark shorter than its digits', () => {
    // A dot at the foot of the line, a dash at its middle: no digits.
    const dot = paintedStrip({ digits: [[9, 6], [17, 3, 12, 3], [22, 6]] });
    expect(findPdfPageBox(dot, 1, 300)).toEqual({ found: false, missing: 'number' });
    const dash = paintedStrip({ digits: [[9, 6], [17, 4, 9, 2]] });
    expect(findPdfPageBox(dash, 1, 300)).toEqual({ found: false, missing: 'number' });
  });

  it('takes no number whose ink is thinner than a digit', () => {
    const strip = paintedStrip({ digits: [[9, 6], [17, 1]] });
    expect(findPdfPageBox(strip, 1, 300)).toEqual({ found: false, missing: 'number' });
  });

  it('takes no number that reaches into the box\'s padding', () => {
    const strip = paintedStrip({ digits: [[1, 6], [9, 6]] });
    expect(findPdfPageBox(strip, 1, 300).found).toBe(false);
  });

  it('takes an empty box for no number', () => {
    expect(findPdfPageBox(paintedStrip({ digits: [] }), 1, 300))
      .toEqual({ found: false, missing: 'number' });
  });

  it('takes a box with nothing after it for another box (the zoom box)', () => {
    const strip = paintedStrip({ digits: [[9, 6], [17, 6]], count: [] });
    expect(findPdfPageBox(strip, 1, 300)).toEqual({ found: false, missing: 'count' });
  });

  it('takes one mark after a box for no count: a divider and a digit at least', () => {
    const strip = paintedStrip({ digits: [[9, 6], [17, 6]], count: [[5, 3]] });
    expect(findPdfPageBox(strip, 1, 300)).toEqual({ found: false, missing: 'count' });
  });

  it('takes ink that starts far from the box for something else', () => {
    const strip = paintedStrip({ digits: [[9, 6], [17, 6]], count: [[20, 3], [28, 6], [36, 6]] });
    expect(findPdfPageBox(strip, 1, 300)).toEqual({ found: false, missing: 'count' });
  });

  it('ends the count at a wide gap: what follows is the next control', () => {
    const strip = paintedStrip({
      digits: [[9, 6], [17, 6]],
      count: [[5, 3], [13, 6], [21, 6], [29, 6], [60, 1], [80, 12]],
    });
    const search = findPdfPageBox(strip, 1, 300);
    expect(search.found).toBe(true);
    if (search.found) expect(search.layout.count.right).toBe(100 + 32 + 29 + 6);
  });

  it('takes a count whose digits are another size for something else', () => {
    const width = 400;
    const strip = paintedStrip({ digits: [[9, 6], [17, 6]], count: [] });
    // A divider and digits 16 px tall where the box's are 10.
    const data = new Uint8ClampedArray(strip.data);
    for (const [left, run] of [[137, 3], [145, 6], [153, 6]] as const) {
      for (let y = 20; y < 36; y += 1) {
        for (let x = left; x < left + run; x += 1) data.set([255, 255, 255, 255], (y * width + x) * 4);
      }
    }
    expect(findPdfPageBox({ ...strip, data }, 1, 300)).toEqual({ found: false, missing: 'number' });
  });

  it('wants a box of the page box\'s size', () => {
    const digits = [[9, 6], [17, 6]] as const;
    for (const box of [
      { left: 100, top: 18, width: 32, height: 10 },
      { left: 100, top: 10, width: 32, height: 40 },
      { left: 100, top: 18, width: 10, height: 20 },
      { left: 100, top: 18, width: 160, height: 20 },
    ]) {
      expect(findPdfPageBox(paintedStrip({ box, digits }), 1, 300).found, JSON.stringify(box)).toBe(false);
    }
  });

  it('wants a bar of one colour over most of the strip, and a darker box', () => {
    const noisy = paintedStrip({ digits: [[9, 6], [17, 6]] });
    const data = new Uint8ClampedArray(noisy.data);
    // Half the strip is something else: a page, not a toolbar.
    for (let index = 0; index < data.length / 2; index += 4) {
      const value = (index / 4) % 251;
      data.set([value, 255 - value, value, 255], index);
    }
    expect(findPdfPageBox({ ...noisy, data }, 1, 300)).toEqual({ found: false, missing: 'bar' });
    // A box lighter than its bar is not Chrome's page box.
    const light = paintedStrip({ digits: [[9, 6], [17, 6]], bar: 20 });
    expect(findPdfPageBox(light, 1, 300).found).toBe(false);
  });
});
