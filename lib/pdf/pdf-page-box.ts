import type { RgbaPixels } from './colour-sample';

/**
 * Finds the page box of Chrome's PDF toolbar in a picture of the top of the
 * tab, and checks what was read from it (D133). The viewer never says which
 * page it shows (D108); its toolbar does, as "12 / 300": the page number in
 * a darker box, then the PDF's page count. Works on plain RGBA pixels, so it
 * runs the same on a canvas's `ImageData` and in tests.
 *
 * Nothing here knows a font. The digits are read by Simul's local text
 * recognition from the picture `composePdfPageBoxLine` makes; what this
 * module adds is everything that can be checked without reading: that the
 * strip is a toolbar, where the box is, how many digits it holds, and that
 * the count beside it is the PDF's own. A page number is taken only when
 * every check holds, so a toolbar that looks different (another Chrome, a
 * selected number, a caret) gives no page rather than a wrong one. In forced
 * colours Chrome draws no box, and the number is found by the "/" after it
 * (D177, measured with Chrome's `--force-high-contrast`, light and dark).
 * What the box shows is what is read: a number typed and not yet entered,
 * once its caret has blinked off, is a plain number here; the reader tells
 * it by a later capture (D220, D224).
 */

/** Chrome's PDF toolbar is this tall, in CSS pixels (Chrome 138 to 158, D177). */
export const PDF_TOOLBAR_HEIGHT = 56;

/**
 * The picture is read twice, its digits scaled to these heights in pixels,
 * and both readings must name the same page. Measured 2026-10-09 on 16,119
 * pictures of Chrome's toolbar (thirteen fonts, device scales 1 to 2, PDFs
 * of 2 to 3,000 pages): at 20 to 30 pixels no reading alone named a wrong
 * page; at 33 three did and at 36 fourteen, a 5 taken for a 9 or a 3, and
 * more the taller the digits (109 of 9,754 at 56). The two readings here
 * named the right page for 16,065 pictures and none for 54.
 */
export const PDF_PAGE_BOX_INK_HEIGHTS = [24, 30] as const;

/** A rectangle of device pixels in the strip; `right` and `bottom` are exclusive. */
export interface PdfToolbarRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** What the strip shows around the page box. */
export interface PdfPageBoxLayout {
  /** The box's own colour, edge to edge. */
  readonly box: PdfToolbarRect;
  /** The ink inside the box: the page number. */
  readonly number: PdfToolbarRect;
  /** How many digits the page number has, told from the ink alone. */
  readonly digits: number;
  /**
   * The ink after the box: the divider and the page count. The count comes
   * after the number in a right-to-left Chrome too (Hebrew, Arabic).
   */
  readonly count: PdfToolbarRect;
  /** The luma of the box and of the bar around it, 0 to 255. */
  readonly boxLuma: number;
  readonly barLuma: number;
  /**
   * The text is darker than its ground: Chrome's toolbar in forced colours
   * on a light theme (black on white). Absent, it is lighter (D177).
   */
  readonly darkInk?: true;
}

/**
 * What the strip lacks, content-free: a bar of one colour, a darker box in
 * it, a count beside a box, or a plain number in that box.
 */
export type PdfPageBoxMissing = 'bar' | 'box' | 'count' | 'number';

export type PdfPageBoxSearch =
  | { readonly found: true; readonly layout: PdfPageBoxLayout }
  | { readonly found: false; readonly missing: PdfPageBoxMissing };

/** A grey picture, one byte a pixel: dark ink on white. */
export interface PdfPageBoxLine {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  /** The ink's height in the picture: the digits' height. */
  readonly inkHeight: number;
}

// The bar's own colour fills at least this share of a toolbar's strip.
const MIN_BAR_SHARE = 0.5;
// The box is darker than the bar by at least this much luma.
const MIN_BOX_CONTRAST = 12;
// A pixel is the box's (or the bar's) colour within this, each channel.
const COLOUR_TOLERANCE = 3;
// The box's size, in CSS pixels: 20 tall in Chrome 138 to 158, and wide
// enough for two digits to six with its padding.
const MIN_BOX_HEIGHT = 14;
const MAX_BOX_HEIGHT = 28;
const MIN_BOX_WIDTH = 14;
const MAX_BOX_WIDTH = 96;
// The box's padding and border beside its digits: 4 + 4 + 1 CSS pixels.
const BOX_PADDING = 9;
// This much of the box at each end (CSS pixels) is padding in every row.
const BOX_CLEAR_ENDS = 2;
// A column belongs to a box when this many CSS pixels of it have the box's
// colour: the digits leave more than that above and below them.
const MIN_BOX_COLUMN = 5;
// Ink is this share of the way from the ground to white, or more.
const INK = 0.3;
// A digit is at least this wide (CSS pixels); a caret is narrower.
const MIN_DIGIT_WIDTH = 2.2;
// Digits that touch are told apart by their width: wider than this many
// times a digit's place, a run of ink is more than one.
const TOUCHING_RUN = 1.3;
// The count starts within this of the box and ends at a gap this wide (CSS pixels).
const COUNT_REACH = 12;
const COUNT_GAP = 14;
// The count's digits are as tall as the box's, within this share and a pixel.
const SAME_HEIGHT_SHARE = 0.12;
// The picture for reading, in shares of the digits' height: white around
// the ink and between the two parts, and this much more between glyphs.
const LINE_MARGIN = 0.9;
const LINE_GAP = 0.9;
const LINE_SPREAD = 0.2;

/**
 * Where the page box is in `strip`, the top `PDF_TOOLBAR_HEIGHT` CSS pixels
 * of a capture of the tab at `scale` device pixels a CSS pixel, for a PDF of
 * `pageCount` pages; or what the strip lacks when it does not show it plainly.
 */
export function findPdfPageBox(
  strip: RgbaPixels,
  scale: number,
  pageCount: number,
): PdfPageBoxSearch {
  const { width, height, data } = strip;
  if (
    !(scale > 0) || !Number.isFinite(scale) ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || data.length < width * height * 4 ||
    !Number.isSafeInteger(pageCount) || pageCount < 1
  ) return { found: false, missing: 'bar' };
  const colours = barAndBoxColours(strip);
  if (!colours) return { found: false, missing: 'bar' };
  const { bar, box } = colours;
  // The toolbar of a tab under about 420 CSS pixels wide has no page box,
  // and in forced colours Chrome draws the box in the bar's own colour.
  if (!box) return boxlessPageBox(strip, bar, scale, pageCount) ?? { found: false, missing: 'box' };
  const boxLuma = lumaOf(box[0], box[1], box[2]);
  const barLuma = lumaOf(bar[0], bar[1], bar[2]);

  // Columns that hold enough of the box's colour, in runs.
  const filled = new Uint16Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isColour(data, (y * width + x) * 4, box)) filled[x]! += 1;
    }
  }
  const minimum = Math.max(2, Math.round(MIN_BOX_COLUMN * scale));
  const countDigits = String(pageCount).length;
  // How far the search got: the zoom box, a box too, has no count after it.
  let missing: PdfPageBoxMissing = 'box';
  const boxColumns = runs(width, (x) => filled[x]! >= minimum);
  for (const [left, right] of boxColumns) {
    const boxWidth = (right - left) / scale;
    if (boxWidth < MIN_BOX_WIDTH || boxWidth > MAX_BOX_WIDTH) continue;
    const rows = boxRows(strip, left, right, box, scale);
    if (!rows) continue;
    const [top, bottom] = rows;
    const boxHeight = (bottom - top) / scale;
    if (boxHeight < MIN_BOX_HEIGHT || boxHeight > MAX_BOX_HEIGHT) continue;
    const rect = { left, top, right, bottom };
    // A digit's place: the box is as wide as the count has digits (two at
    // least), each one `ch` wide, and its padding.
    const place = (boxWidth - BOX_PADDING) / Math.max(2, countDigits) * scale;
    if (!(place > 0)) continue;
    const count = countBeside(strip, rect, barLuma, scale, place, countDigits);
    if (!count) {
      if (missing === 'box') missing = 'count';
      continue;
    }
    const number = numberInBox(strip, rect, boxLuma, scale, place, countDigits);
    // The count's digits are the size of the box's (0.81rem and 13.33px).
    const numberHeight = number ? number.rect.bottom - number.rect.top : 0;
    if (
      !number ||
      Math.abs(count.digitHeight - numberHeight) > 1 + SAME_HEIGHT_SHARE * numberHeight
    ) {
      missing = 'number';
      continue;
    }
    return {
      found: true,
      layout: {
        box: rect,
        number: number.rect,
        digits: number.digits,
        count: count.rect,
        boxLuma,
        barLuma,
      },
    };
  }
  if (missing === 'number') return { found: false, missing };
  // A selected number or a caret splits the box's columns: the highlight and
  // the caret fill whole columns of it with their own colour. Its parts
  // with a count beside them are the page box with a number that is not
  // plain, which is looked at again later, not taken for no box (D177).
  if (splitPageBox(strip, boxColumns, bar, box, scale, countDigits)) {
    return { found: false, missing: 'number' };
  }
  // Forced colours on a theme whose box Chrome still draws darker than the
  // bar is not known; a toolbar with no box at all may still be one (D177).
  return boxlessPageBox(strip, bar, scale, pageCount) ?? { found: false, missing };
}

/**
 * Whether runs of the box's columns that stand apart are one box split by
 * a highlight or a caret: between them no column of the box's rows shows
 * the bar, the whole is a box's size, and a count is beside it.
 */
function splitPageBox(
  strip: RgbaPixels,
  boxColumns: readonly (readonly [number, number])[],
  bar: Rgb,
  box: Rgb,
  scale: number,
  countDigits: number,
): boolean {
  const barLuma = lumaOf(bar[0], bar[1], bar[2]);
  for (let first = 0; first < boxColumns.length; first += 1) {
    for (let last = first + 1; last < boxColumns.length; last += 1) {
      const left = boxColumns[first]![0];
      const right = boxColumns[last]![1];
      const boxWidth = (right - left) / scale;
      if (boxWidth > MAX_BOX_WIDTH) break;
      if (boxWidth < MIN_BOX_WIDTH) continue;
      const rows = boxRows(strip, left, right, box, scale);
      if (!rows) continue;
      const [top, bottom] = rows;
      const boxHeight = (bottom - top) / scale;
      if (boxHeight < MIN_BOX_HEIGHT || boxHeight > MAX_BOX_HEIGHT) continue;
      // Every column between the parts holds no pixel of the bar's colour.
      let joined = true;
      for (let part = first; part < last && joined; part += 1) {
        for (let x = boxColumns[part]![1]; x < boxColumns[part + 1]![0] && joined; x += 1) {
          for (let y = top; y < bottom; y += 1) {
            if (isColour(strip.data, (y * strip.width + x) * 4, bar)) {
              joined = false;
              break;
            }
          }
        }
      }
      if (!joined) break;
      const place = (boxWidth - BOX_PADDING) / Math.max(2, countDigits) * scale;
      if (!(place > 0)) continue;
      if (countBeside(strip, { left, top, right, bottom }, barLuma, scale, place, countDigits)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The page selector as Chrome draws it in forced colours (D177): no box of
 * its own colour, only the number, a "/" and the count in the text colour
 * on the bar, dark on light or light on dark. Found by the divider, a glyph
 * that slants, with a word of digits before it and the count after it,
 * all of one height; and only where the number stands on the bar's own
 * colour, so a box Chrome does draw (an ordinary toolbar the search above
 * could not read, under an open menu) is not read this way.
 */
function boxlessPageBox(
  strip: RgbaPixels,
  bar: Rgb,
  scale: number,
  pageCount: number,
): PdfPageBoxSearch | undefined {
  const barLuma = lumaOf(bar[0], bar[1], bar[2]);
  const dark = barLuma > 127;
  const whole = { left: 0, top: 0, right: strip.width, bottom: strip.height };
  const glyphs = inkRuns(strip, whole, barLuma, dark)
    .map(([left, right]) => {
      const rows = inkRows(strip, { ...whole, left, right }, barLuma, dark);
      return rows ? { left, right, top: rows[0], bottom: rows[1] } : undefined;
    })
    .filter((glyph) => glyph !== undefined);
  const countDigits = String(pageCount).length;
  const reach = COUNT_REACH * scale;
  const gap = COUNT_GAP * scale;
  for (let index = 1; index < glyphs.length - 1; index += 1) {
    const divider = glyphs[index]!;
    if (!slants(strip, divider, barLuma, dark)) continue;
    // The count: glyphs after the divider up to a wide gap, digits of one height.
    const count = [glyphs[index + 1]!];
    if (count[0]!.left - divider.right > reach) continue;
    for (let next = index + 2; next < glyphs.length; next += 1) {
      if (glyphs[next]!.left - count.at(-1)!.right >= gap) break;
      count.push(glyphs[next]!);
    }
    const countTop = count[0]!.top;
    const countBottom = count[0]!.bottom;
    const digitHeight = countBottom - countTop;
    if (digitHeight < 4 * scale) continue;
    if (count.some((glyph) => Math.abs(glyph.top - countTop) > 1 || Math.abs(glyph.bottom - countBottom) > 1)) {
      continue;
    }
    const place = (count.at(-1)!.right - count[0]!.left) / countDigits;
    // The number: the glyphs before the divider, close together, within
    // the box's padding and a reach of the divider.
    const number = [glyphs[index - 1]!];
    const before = BOX_PADDING * scale + reach + countDigits * place;
    if (divider.left - number[0]!.right > before) continue;
    for (let previous = index - 2; previous >= 0; previous -= 1) {
      if (number[0]!.left - glyphs[previous]!.right > place) break;
      number.unshift(glyphs[previous]!);
    }
    const top = number[0]!.top;
    const bottom = number[0]!.bottom;
    let digits = 0;
    let plain = true;
    for (const glyph of number) {
      if (
        Math.abs(glyph.top - top) > 1 || Math.abs(glyph.bottom - bottom) > 1 ||
        glyph.right - glyph.left < MIN_DIGIT_WIDTH * scale
      ) {
        plain = false;
        break;
      }
      digits += glyph.right - glyph.left > TOUCHING_RUN * place
        ? Math.round((glyph.right - glyph.left) / place)
        : 1;
    }
    if (!plain || digits < 1 || digits > countDigits) continue;
    if (Math.abs(digitHeight - (bottom - top)) > 1 + SAME_HEIGHT_SHARE * (bottom - top)) continue;
    const rect = { left: number[0]!.left, top, right: number.at(-1)!.right, bottom };
    // The number stands on the bar: a box drawn behind it is not this case.
    if (!onBar(strip, rect, barLuma, dark, scale)) continue;
    return {
      found: true,
      layout: {
        box: rect,
        number: rect,
        digits,
        count: {
          left: divider.left,
          top: Math.min(divider.top, countTop),
          right: count.at(-1)!.right,
          bottom: Math.max(divider.bottom, countBottom),
        },
        boxLuma: barLuma,
        barLuma,
        ...(dark ? { darkInk: true as const } : {}),
      },
    };
  }
  return undefined;
}

/** Whether a glyph is a "/": its top row of ink well right of its bottom row's, each narrow. */
function slants(strip: RgbaPixels, glyph: PdfToolbarRect, ground: number, dark: boolean): boolean {
  const width = glyph.right - glyph.left;
  const height = glyph.bottom - glyph.top;
  if (width < 2 || height < 4 || width > height) return false;
  const rowInk = (y: number) => {
    let sum = 0;
    let weight = 0;
    let first = -1;
    let last = -1;
    for (let x = glyph.left; x < glyph.right; x += 1) {
      const ink = inkAt(strip, x, y, ground, dark);
      if (ink < INK) continue;
      sum += x * ink;
      weight += ink;
      if (first < 0) first = x;
      last = x + 1;
    }
    return weight > 0 ? { centre: sum / weight, span: last - first } : undefined;
  };
  const top = rowInk(glyph.top);
  const bottom = rowInk(glyph.bottom - 1);
  return top !== undefined && bottom !== undefined &&
    top.span <= 0.6 * width && bottom.span <= 0.6 * width &&
    top.centre - bottom.centre >= 0.4 * width;
}

/**
 * Whether the number stands on the bar, not in a box: nothing around it
 * within the box's padding is off the bar's colour the other way from the
 * ink (a box darker than the bar behind light digits) by a box's contrast.
 */
function onBar(
  strip: RgbaPixels,
  rect: PdfToolbarRect,
  barLuma: number,
  dark: boolean,
  scale: number,
): boolean {
  const pad = Math.max(1, Math.round(3 * scale));
  const top = Math.max(0, rect.top - pad);
  const bottom = Math.min(strip.height, rect.bottom + pad);
  for (const [from, to] of [
    [Math.max(0, rect.left - pad), rect.left],
    [rect.right, Math.min(strip.width, rect.right + pad)],
  ] as const) {
    for (let x = from; x < to; x += 1) {
      for (let y = top; y < bottom; y += 1) {
        const at = (y * strip.width + x) * 4;
        const luma = lumaOf(strip.data[at]!, strip.data[at + 1]!, strip.data[at + 2]!);
        if ((dark ? luma - barLuma : barLuma - luma) >= MIN_BOX_CONTRAST) return false;
      }
    }
  }
  return true;
}

/**
 * The picture Simul's text recognition reads: the page number and the count
 * as dark ink on white, side by side as the toolbar has them, each lifted
 * off its own ground. `spaced` gives their glyphs a little more room:
 * Tesseract reads two thin digits that stand close ("11") as one, and now
 * and then cannot read a number so spaced that it reads as it stands
 * ("5 / 12" in Chrome's own font), so the reader tries one, then the
 * other. Pixels of the strip only; nothing else of the capture is in it.
 */
export function composePdfPageBoxLine(
  strip: RgbaPixels,
  layout: PdfPageBoxLayout,
  spaced = true,
): PdfPageBoxLine {
  const { number, count } = layout;
  const top = Math.min(number.top, count.top);
  const bottom = Math.max(number.bottom, count.bottom);
  const inkHeight = number.bottom - number.top;
  const margin = Math.max(2, Math.round(LINE_MARGIN * inkHeight));
  const gap = Math.max(2, Math.round(LINE_GAP * inkHeight));
  const spread = spaced ? Math.round(LINE_SPREAD * inkHeight) : 0;
  const dark = layout.darkInk === true;
  const parts = [
    { rect: number, ground: layout.boxLuma },
    { rect: count, ground: layout.barLuma },
  ].map((part) => ({ ...part, glyphs: inkRuns(strip, part.rect, part.ground, dark) }));
  const spreads = parts.reduce((sum, part) => sum + Math.max(0, part.glyphs.length - 1), 0);
  const width = margin * 2 + gap + spreads * spread +
    (number.right - number.left) + (count.right - count.left);
  const height = margin * 2 + (bottom - top);
  const data = new Uint8ClampedArray(width * height).fill(255);
  let offset = margin;
  for (const { rect, ground, glyphs } of parts) {
    // Each glyph as far from the part's start as in the strip, and `spread`
    // more for every glyph before it.
    glyphs.forEach(([left, right], index) => {
      const shift = offset + index * spread - rect.left;
      for (let y = rect.top; y < rect.bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const ink = inkAt(strip, x, y, ground, dark);
          data[(margin + y - top) * width + shift + x] = Math.round(255 * (1 - ink));
        }
      }
    });
    offset += rect.right - rect.left + Math.max(0, glyphs.length - 1) * spread + gap;
  }
  return { width, height, data, inkHeight };
}

/**
 * The page (1-based) that `text`, as read from the composed picture, says
 * the viewer shows; `undefined` unless it reads as a page number of as many
 * digits as the box holds, a divider, and the PDF's own page count.
 */
export function pdfPageFromBoxText(
  text: string,
  layout: Pick<PdfPageBoxLayout, 'digits'>,
  pageCount: number,
): number | undefined {
  const squeezed = text.replace(/\s+/gu, '');
  const match = /^(\d{1,9})\/(\d{1,9})$/u.exec(squeezed);
  if (!match) return undefined;
  const [number, count] = [match[1]!, match[2]!];
  if (count !== String(pageCount)) return undefined;
  if (number.length !== layout.digits || number.startsWith('0')) return undefined;
  const page = Number(number);
  return page >= 1 && page <= pageCount ? page : undefined;
}

// Two captures of an unchanged toolbar give the same pixels; this much a
// channel may differ all the same (D220).
const SAME_BOX_TOLERANCE = 24;

/**
 * Whether two strips show the same page box with the same number in it:
 * the box and its ink where they were, and every pixel of them alike. A
 * number typed on, or a caret back, is another picture (D220).
 */
export function samePdfPageBox(
  first: RgbaPixels,
  firstLayout: PdfPageBoxLayout,
  second: RgbaPixels,
  secondLayout: PdfPageBoxLayout,
): boolean {
  const sameRect = (a: PdfToolbarRect, b: PdfToolbarRect) =>
    a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
  if (
    first.width !== second.width ||
    first.height !== second.height ||
    firstLayout.digits !== secondLayout.digits ||
    !sameRect(firstLayout.box, secondLayout.box) ||
    !sameRect(firstLayout.number, secondLayout.number)
  ) return false;
  const { box, number } = firstLayout;
  const left = Math.max(0, Math.min(box.left, number.left));
  const right = Math.min(first.width, Math.max(box.right, number.right));
  const top = Math.max(0, Math.min(box.top, number.top));
  const bottom = Math.min(first.height, Math.max(box.bottom, number.bottom));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const at = (y * first.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        if (Math.abs(first.data[at + channel]! - second.data[at + channel]!) > SAME_BOX_TOLERANCE) {
          return false;
        }
      }
    }
  }
  return true;
}

type Rgb = readonly [number, number, number];

/** The strip's commonest colour (the bar) and the commonest darker one (the box), if any. */
function barAndBoxColours(strip: RgbaPixels): { bar: Rgb; box: Rgb | undefined } | undefined {
  const { width, height, data } = strip;
  const counts = new Map<number, number>();
  const total = width * height;
  for (let index = 0; index < total; index += 1) {
    const at = index * 4;
    const key = (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let barKey = -1;
  let barCount = 0;
  for (const [key, count] of counts) {
    if (count > barCount) {
      barKey = key;
      barCount = count;
    }
  }
  if (barKey < 0 || barCount < MIN_BAR_SHARE * total) return undefined;
  const bar = unpack(barKey);
  const barLuma = lumaOf(bar[0], bar[1], bar[2]);
  let boxKey = -1;
  let boxCount = 0;
  for (const [key, count] of counts) {
    if (count <= boxCount) continue;
    const colour = unpack(key);
    if (lumaOf(colour[0], colour[1], colour[2]) > barLuma - MIN_BOX_CONTRAST) continue;
    boxKey = key;
    boxCount = count;
  }
  return { bar, box: boxKey < 0 ? undefined : unpack(boxKey) };
}

/**
 * The rows of a box between two columns: the longest run of rows whose ends
 * (the box's padding, clear of the digits) are the box's colour.
 */
function boxRows(
  strip: RgbaPixels,
  left: number,
  right: number,
  box: Rgb,
  scale: number,
): readonly [number, number] | undefined {
  const { width, height, data } = strip;
  const ends = Math.max(1, Math.floor(BOX_CLEAR_ENDS * scale));
  if (right - left < ends * 2) return undefined;
  const whole = (y: number, from: number, to: number) => {
    for (let x = from; x < to; x += 1) {
      if (!isColour(data, (y * width + x) * 4, box)) return false;
    }
    return true;
  };
  let best: readonly [number, number] | undefined;
  const inBox = (y: number) => whole(y, left, left + ends) && whole(y, right - ends, right);
  for (const run of runs(height, inBox)) {
    if (!best || run[1] - run[0] > best[1] - best[0]) best = run;
  }
  return best;
}

/** The ink inside the box and how many digits it is. */
function numberInBox(
  strip: RgbaPixels,
  box: PdfToolbarRect,
  boxLuma: number,
  scale: number,
  place: number,
  countDigits: number,
): { rect: PdfToolbarRect; digits: number } | undefined {
  const columns = inkRuns(strip, box, boxLuma);
  if (columns.length === 0) return undefined;
  const left = columns[0]![0];
  const right = columns.at(-1)![1];
  const rows = inkRows(strip, { ...box, left, right }, boxLuma);
  if (!rows) return undefined;
  const [top, bottom] = rows;
  let digits = 0;
  for (const [start, end] of columns) {
    const run = { left: start, top: box.top, right: end, bottom: box.bottom };
    const runRows = inkRows(strip, run, boxLuma);
    // Every digit is as tall as the others: a caret or a mark is not.
    if (!runRows || Math.abs(runRows[0] - top) > 1 || Math.abs(runRows[1] - bottom) > 1) {
      return undefined;
    }
    if (end - start < MIN_DIGIT_WIDTH * scale) return undefined;
    digits += end - start > TOUCHING_RUN * place
      ? Math.round((end - start) / place)
      : 1;
  }
  if (digits < 1 || digits > countDigits) return undefined;
  return { rect: { left, top, right, bottom }, digits };
}

/** The divider and the count after the box: the ink that starts near it. */
function countBeside(
  strip: RgbaPixels,
  box: PdfToolbarRect,
  barLuma: number,
  scale: number,
  place: number,
  countDigits: number,
): { rect: PdfToolbarRect; digitHeight: number } | undefined {
  const reach = COUNT_REACH * scale;
  const gap = COUNT_GAP * scale;
  // The divider, the count's digits and the spaces between them.
  const widest = (countDigits + 3) * place * 1.5;
  // A pixel past the box's own edge, which may be blended with the bar.
  const from = box.right + Math.max(1, Math.ceil(scale));
  const to = Math.min(strip.width, Math.ceil(from + reach + widest));
  if (to <= from) return undefined;
  const found = inkRuns(strip, { left: from, top: box.top, right: to, bottom: box.bottom }, barLuma);
  const first = found[0];
  if (!first || first[0] - box.right > reach) return undefined;
  const parts = [first];
  for (const run of found.slice(1)) {
    if (run[0] - parts.at(-1)![1] >= gap) break;
    parts.push(run);
  }
  // The divider, then at least one digit.
  const last = parts.at(-1)!;
  if (parts.length < 2) return undefined;
  const whole = { left: first[0], top: box.top, right: last[1], bottom: box.bottom };
  const rows = inkRows(strip, whole, barLuma);
  // The run farthest from the box is a digit of the count.
  const digitRows = inkRows(strip, { ...whole, left: last[0] }, barLuma);
  if (!rows || !digitRows) return undefined;
  return {
    rect: { ...whole, top: rows[0], bottom: rows[1] },
    digitHeight: digitRows[1] - digitRows[0],
  };
}

/** Runs of columns in `rect` that hold ink over `ground`. */
function inkRuns(
  strip: RgbaPixels,
  rect: PdfToolbarRect,
  ground: number,
  dark = false,
): (readonly [number, number])[] {
  const inked = (x: number) => {
    for (let y = rect.top; y < rect.bottom; y += 1) {
      if (inkAt(strip, x, y, ground, dark) >= INK) return true;
    }
    return false;
  };
  return runs(rect.right - rect.left, (offset) => inked(rect.left + offset))
    .map(([start, end]) => [rect.left + start, rect.left + end] as const);
}

/** The first and last rows of `rect` that hold ink over `ground`. */
function inkRows(
  strip: RgbaPixels,
  rect: PdfToolbarRect,
  ground: number,
  dark = false,
): readonly [number, number] | undefined {
  let top = -1;
  let bottom = -1;
  for (let y = rect.top; y < rect.bottom; y += 1) {
    for (let x = rect.left; x < rect.right; x += 1) {
      if (inkAt(strip, x, y, ground, dark) < INK) continue;
      if (top < 0) top = y;
      bottom = y + 1;
      break;
    }
  }
  return top < 0 ? undefined : [top, bottom];
}

/**
 * How much of the way from `ground` to white the pixel is, 0 to 1; to black
 * for `dark` ink (forced colours on a light theme, D177).
 */
function inkAt(strip: RgbaPixels, x: number, y: number, ground: number, dark = false): number {
  const at = (y * strip.width + x) * 4;
  const luma = lumaOf(strip.data[at]!, strip.data[at + 1]!, strip.data[at + 2]!);
  const share = dark ? (ground - luma) / Math.max(1, ground) : (luma - ground) / Math.max(1, 255 - ground);
  return Math.min(1, Math.max(0, share));
}

/** Runs of indexes below `length` where `test` holds: [start, end). */
function runs(length: number, test: (index: number) => boolean): (readonly [number, number])[] {
  const found: (readonly [number, number])[] = [];
  let start = -1;
  for (let index = 0; index < length; index += 1) {
    if (test(index)) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      found.push([start, index]);
      start = -1;
    }
  }
  if (start >= 0) found.push([start, length]);
  return found;
}

function isColour(data: ArrayLike<number>, at: number, colour: Rgb): boolean {
  return Math.abs(data[at]! - colour[0]) <= COLOUR_TOLERANCE &&
    Math.abs(data[at + 1]! - colour[1]) <= COLOUR_TOLERANCE &&
    Math.abs(data[at + 2]! - colour[2]) <= COLOUR_TOLERANCE;
}

function unpack(key: number): Rgb {
  return [(key >> 16) & 255, (key >> 8) & 255, key & 255];
}

function lumaOf(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}
