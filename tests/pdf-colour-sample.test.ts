import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BLOCK_COLOURS,
  sampleBlockColours,
  type PixelRect,
  type RgbaPixels,
} from '../lib/pdf/colour-sample';
import {
  MIN_PDF_FIT_SCALE,
  fitStep,
  fontFaceFromName,
} from '../lib/pdf/pdf-overlay-style';

type Rgba = readonly [number, number, number, number];

/** A page filled with `background`, with `ink` strokes inside each text rect. */
function page(
  width: number,
  height: number,
  background: Rgba,
  text: { rect: PixelRect; ink: Rgba }[] = [],
): RgbaPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(background, offset);
  for (const { rect, ink } of text) {
    for (let y = rect.top; y < rect.top + rect.height; y += 1) {
      for (let x = rect.left; x < rect.left + rect.width; x += 1) {
        // Glyph-like: every third column is ink, the others an antialiased
        // edge or background.
        const colour: Rgba = x % 3 === 0
          ? ink
          : x % 3 === 1
            ? [
                (ink[0] + background[0]) >> 1,
                (ink[1] + background[1]) >> 1,
                (ink[2] + background[2]) >> 1,
                (ink[3] + background[3]) >> 1,
              ]
            : background;
        data.set(colour, (y * width + x) * 4);
      }
    }
  }
  return { width, height, data };
}

const LINE = { left: 20, top: 20, width: 60, height: 12 };

describe('sampleBlockColours', () => {
  it('reads a white page with black text', () => {
    const pixels = page(100, 60, [255, 255, 255, 255], [{ rect: LINE, ink: [0, 0, 0, 255] }]);
    expect(sampleBlockColours(pixels, [LINE])).toEqual({
      background: 'rgb(255, 255, 255)',
      ink: 'rgb(0, 0, 0)',
    });
  });

  it('reads coloured text on a tinted band', () => {
    const pixels = page(100, 60, [250, 240, 200, 255], [{ rect: LINE, ink: [180, 20, 30, 255] }]);
    expect(sampleBlockColours(pixels, [LINE])).toEqual({
      background: 'rgb(250, 240, 200)',
      ink: 'rgb(180, 20, 30)',
    });
  });

  it('reads light text on a dark background', () => {
    const pixels = page(100, 60, [20, 30, 60, 255], [{ rect: LINE, ink: [240, 240, 240, 255] }]);
    const colours = sampleBlockColours(pixels, [LINE]);
    expect(colours.background).toBe('rgb(20, 30, 60)');
    expect(colours.ink).toBe('rgb(240, 240, 240)');
  });

  it('treats transparent pixels as the white page', () => {
    const pixels = page(100, 60, [0, 0, 0, 0], [{ rect: LINE, ink: [0, 0, 255, 255] }]);
    expect(sampleBlockColours(pixels, [LINE])).toEqual({
      background: 'rgb(255, 255, 255)',
      ink: 'rgb(0, 0, 255)',
    });
  });

  it('takes the text colour from its farthest pixels, never past them', () => {
    // Grey text stays grey: nothing pushes it towards black.
    const grey = page(100, 60, [255, 255, 255, 255], [{ rect: LINE, ink: [119, 119, 119, 255] }]);
    expect(sampleBlockColours(grey, [LINE]).ink).toBe('rgb(119, 119, 119)');
    // Light pink stays light pink.
    const pink = page(100, 60, [255, 255, 255, 255], [{ rect: LINE, ink: [245, 170, 190, 255] }]);
    expect(sampleBlockColours(pink, [LINE]).ink).toBe('rgb(245, 170, 190)');
  });

  it('takes a nearly grey colour, tinted by antialiasing fringes, as grey', () => {
    const fringed = page(100, 60, [255, 255, 255, 255], [{ rect: LINE, ink: [60, 50, 64, 255] }]);
    expect(sampleBlockColours(fringed, [LINE]).ink).toBe('rgb(58, 58, 58)');
    // A real tint is kept: dark navy is not grey.
    const navy = page(100, 60, [255, 255, 255, 255], [{ rect: LINE, ink: [20, 40, 90, 255] }]);
    expect(sampleBlockColours(navy, [LINE]).ink).toBe('rgb(20, 40, 90)');
  });

  it('clips lines to the pixels, however far outside they reach', () => {
    const pixels = page(100, 60, [255, 255, 255, 255], [{ rect: LINE, ink: [0, 0, 0, 255] }]);
    const started = Date.now();
    expect(sampleBlockColours(pixels, [
      LINE,
      { left: -1e300, top: -1e300, width: 2e300, height: 2e300 },
      { left: 2 ** 60, top: 10, width: 2 ** 60, height: 10 },
    ]).ink).toBe('rgb(0, 0, 0)');
    expect(sampleBlockColours(pixels, [{ left: 500, top: 500, width: 10, height: 10 }]))
      .toEqual(DEFAULT_BLOCK_COLOURS);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps faint grey and pastel text faint', () => {
    const faint = page(100, 60, [255, 255, 255, 255], [{ rect: LINE, ink: [228, 228, 228, 255] }]);
    expect(sampleBlockColours(faint, [LINE]).ink).toBe('rgb(228, 228, 228)');
    const pastel = page(100, 60, [255, 255, 255, 255], [{ rect: LINE, ink: [250, 222, 232, 255] }]);
    expect(sampleBlockColours(pastel, [LINE]).ink).toBe('rgb(250, 222, 232)');
  });

  it('reads a grey caption set tight under black text as grey', () => {
    const upper = { left: 20, top: 20, width: 60, height: 12 };
    const caption = { left: 20, top: 33, width: 60, height: 10 };
    const pixels = page(100, 60, [255, 255, 255, 255], [
      { rect: upper, ink: [0, 0, 0, 255] },
      { rect: caption, ink: [120, 120, 120, 255] },
      // The upper line's descenders reach one pixel into the caption's box.
      { rect: { left: 20, top: 33, width: 60, height: 1 }, ink: [0, 0, 0, 255] },
    ]);

    expect(sampleBlockColours(pixels, [caption], { ringPadding: 1.2 })).toEqual({
      background: 'rgb(255, 255, 255)',
      ink: 'rgb(120, 120, 120)',
    });
    expect(sampleBlockColours(pixels, [upper], { ringPadding: 1.4 }).ink).toBe('rgb(0, 0, 0)');
  });

  it('covers text in a snug dark-blue header cell with the cell colour', () => {
    const cell = { left: 20, top: 20, width: 60, height: 12 };
    const pixels = page(100, 60, [255, 255, 255, 255]);
    const data = pixels.data as Uint8ClampedArray;
    for (let y = cell.top; y < cell.top + cell.height; y += 1) {
      for (let x = cell.left; x < cell.left + cell.width; x += 1) {
        // Dark blue fill, with white strokes where the letters are.
        data.set(x % 4 === 0 ? [255, 255, 255, 255] : [20, 40, 110, 255], (y * 100 + x) * 4);
      }
    }

    expect(sampleBlockColours(pixels, [cell], { ringPadding: 1.4 })).toEqual({
      background: 'rgb(20, 40, 110)',
      ink: 'rgb(255, 255, 255)',
    });
  });

  it('uses the ring when the lines hold too few pixels', () => {
    const tiny = { left: 20, top: 20, width: 3, height: 3 };
    const pixels = page(100, 60, [240, 250, 255, 255], [{ rect: tiny, ink: [0, 0, 0, 255] }]);
    expect(sampleBlockColours(pixels, [tiny]).background).toBe('rgb(240, 250, 255)');
  });

  it('picks a contrasting ink when the lines hold no visible text', () => {
    const pixels = page(100, 60, [10, 10, 10, 255]);
    expect(sampleBlockColours(pixels, [LINE]).ink).toBe('rgb(255, 255, 255)');
  });

  it('falls back to white and black without usable pixels or lines', () => {
    expect(sampleBlockColours({ width: 0, height: 0, data: [] }, [LINE]))
      .toEqual(DEFAULT_BLOCK_COLOURS);
    expect(sampleBlockColours(page(10, 10, [9, 9, 9, 255]), []))
      .toEqual(DEFAULT_BLOCK_COLOURS);
  });

  it('reads a bounded number of pixels from a large block', () => {
    let reads = 0;
    const pixels = page(2000, 1200, [255, 255, 255, 255]);
    const counted: RgbaPixels = {
      width: pixels.width,
      height: pixels.height,
      data: new Proxy(pixels.data as Uint8ClampedArray, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/u.test(property)) reads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    };
    sampleBlockColours(counted, [{ left: 10, top: 10, width: 1900, height: 1100 }]);
    // Four channels for at most about 12,500 pixels.
    expect(reads).toBeLessThan(4 * 13_000);
  });
});

describe('fontFaceFromName', () => {
  it.each([
    ['AAAAAA+DejaVuSerif-Bold', true, false],
    ['Helvetica-BoldOblique', true, true],
    ['BCDEEE+Calibri-Italic', false, true],
    ['Arial-Black', true, false],
    ['MyriadPro-Semibold', true, false],
    ['Times-Roman', false, false],
    ['Boldoni-Regular', false, false],
    ['MinionPro-It', false, true],
    ['HelveticaNeueLTStd-BdIt', true, true],
    ['FrutigerLTStd-Blk', true, false],
    ['HelveticaNeue-HvObl', true, true],
    ['Arial,BoldItalic', true, true],
    ['Arial-BoldMT', true, false],
    ['ArialMT', false, false],
    ['Bitstream', false, false],
    ['Garamond-LightItalic', false, true],
    ['CMBX10', true, false],
    ['ABCDEF+CMB10', true, false],
    ['CMSSBX10', true, false],
    ['SFBX1200', true, false],
    ['ECBX1000', true, false],
    ['LMRoman10-Bold', true, false],
    ['CMTI10', false, true],
    ['CMSL10', false, true],
    ['CMBXTI10', true, true],
    ['CMSSI10', false, true],
    ['SFTI1000', false, true],
    ['SFSL1000', false, true],
    ['CMR10', false, false],
    ['CMSS10', false, false],
    ['NimbusRomNo9L-Medi', true, false],
    ['NimbusRomNo9L-MediItal', true, true],
    ['NimbusRomNo9L-ReguItal', false, true],
    ['NimbusRomNo9L-Regu', false, false],
    ['Roboto-Medium', false, false],
  ])('reads %s', (name, bold, italic) => {
    expect(fontFaceFromName(name)).toEqual({ bold, italic });
  });

  it('reads a missing name as regular', () => {
    expect(fontFaceFromName(undefined)).toEqual({ bold: false, italic: false });
    expect(fontFaceFromName('')).toEqual({ bold: false, italic: false });
  });
});

describe('fitStep', () => {
  const box = { width: 200, height: 100 };

  it('says a translation that fits fits', () => {
    expect(fitStep(1, { width: 200, height: 90 }, box)).toEqual({
      fits: true,
      next: 1,
      overflowsAtMinimum: false,
    });
    expect(fitStep(0.8, { width: 200, height: 100.4 }, box).fits).toBe(true);
  });

  it('suggests the square root of a height overflow for wrapping text', () => {
    expect(fitStep(1, { width: 200, height: 400 }, box).next).toBeCloseTo(0.5);
    expect(fitStep(1, { width: 200, height: 144 }, box).next).toBeCloseTo(1 / 1.2);
    expect(fitStep(1, { width: 200, height: 144 }, box).fits).toBe(false);
  });

  it('suggests the width ratio for a line that cannot wrap', () => {
    expect(fitStep(1, { width: 250, height: 50 }, box).next).toBeCloseTo(0.8);
  });

  it('stays within half and full size, and says when half size still overflows', () => {
    expect(fitStep(1, { width: 200, height: 10_000 }, box)).toEqual({
      fits: false,
      next: MIN_PDF_FIT_SCALE,
      overflowsAtMinimum: false,
    });
    expect(fitStep(0.5, { width: 200, height: 10_000 }, box).overflowsAtMinimum).toBe(true);
    expect(fitStep(0.5, { width: 200, height: 50 }, box).overflowsAtMinimum).toBe(false);
    expect(fitStep(3, { width: 10, height: 10 }, box).next).toBe(1);
    expect(fitStep(Number.NaN, { width: 10, height: 10 }, box).next).toBe(1);
  });
});
