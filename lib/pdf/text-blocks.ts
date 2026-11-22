import type { PdfTextContent, PdfTextItem, PdfTextStyle } from './pdfjs-runtime';

/**
 * Groups a page's pdf.js text runs into lines and the lines into blocks
 * (paragraphs, headings, list items), in the page's own content order. The
 * translation of a block is drawn over its lines, so a block is also the unit
 * of translation. Units are PDF points on the page at scale 1, y downwards.
 */

export type PdfFontFamily = 'serif' | 'sans-serif' | 'monospace';

/**
 * How a block's lines line up on the page. Physical, not start/end: the
 * translation's own direction must not flip it.
 */
export type PdfTextAlign = 'left' | 'center' | 'right';

export interface PdfTextRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfTextBlock {
  /** The block's text, lines joined, a word split by a hyphen rejoined. */
  readonly text: string;
  /** One box per line, from the fonts' ascent to their descent. */
  readonly lines: readonly PdfTextRect[];
  /** The union of the line boxes. */
  readonly box: PdfTextRect;
  /** The font size most of the text uses, in points. */
  readonly fontSize: number;
  /** The distance between baselines as a multiple of the font size. */
  readonly lineHeight: number;
  readonly fontFamily: PdfFontFamily;
  /** The pdf.js id of the font most of the text uses. */
  readonly fontId: string;
  readonly align: PdfTextAlign;
  /**
   * A piece of an OCR line cut around typed text (D121), with the other
   * pieces of its line (D184): `id` is shared by them, `part` counts from 0
   * in reading order. They are translated as one text, laid out across the
   * pieces. Absent on a line that was not cut, or kept one piece only. The
   * block below a cut line that runs on into it is the flow's last part
   * (D189).
   */
  readonly flow?: { readonly id: number; readonly part: number };
}

// A line breaks when the baseline moves more than this share of the font
// size. Half the size keeps superscripts and subscripts on their line.
const BASELINE_BREAK = 0.5;
// A gap wider than this share of the font size is a column or table gutter.
const GAP_BREAK = 1.5;
// A run starting this far left of where the line ends starts a new line.
const BACKWARDS_BREAK = 1;
// Two lines belong to one block when their sizes differ by at most this
// share and the next baseline is at most this many font sizes lower.
const SIZE_TOLERANCE = 0.15;
const MAX_LINE_PITCH = 1.6;
// An OCR line box is as tall as its tallest and lowest glyphs: "a new era"
// is about a third shorter than "Typography" in the same font.
const OCR_SIZE_TOLERANCE = 0.4;
// A cut line runs on into the block below it when that block starts within
// this share of the line's height below it, and starts and ends within this
// share of it of where the line does (D189).
const FLOW_ON_GAP = 0.8;
const FLOW_ON_EDGE = 2;
// OCR text has no pdf.js font; the empty id reads as a regular face.
const OCR_FONT_ID = '';
// An OCR line box this many times taller than wide is a vertical line.
const VERTICAL_LINE_RATIO = 1.5;
// An OCR line with this share of its box over the page's typed text only
// repeats that text.
const OCR_TYPED_OVERLAP = 0.5;
// Scripts written right to left, for OCR lines that carry no direction.
const RTL_CHARACTER = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const LETTERS_AND_DIGITS = /[\p{L}\p{N}]/gu;
// A gap between runs wider than this share of the font size reads as a space.
const SPACE_GAP = 0.25;
// Text turned by more than this (radians) is rotated and stays as drawn.
const ROTATION_TOLERANCE = 0.01;
const SINGLE_LINE_HEIGHT = 1.2;
// A run repeating one of its line's runs closer than this share of the font
// size is a second stroke of the same text (fake bold, a shadow, a line
// drawn twice).
const REPEAT_OFFSET = 0.2;
// Line edges within this share of the font size count as lined up.
const EDGE_TOLERANCE = 0.5;
// A single line is centred when its centre is within this share of the page
// width of the page's centre.
const PAGE_CENTRE_TOLERANCE = 0.015;

// Bullets and numbers always start a block; dashes, letters and roman
// numerals only after a finished sentence or inside a list, so "J. Smith"
// or a dash wrapped to the start of a line stays in its paragraph.
// Office documents set bullets in Symbol or Wingdings, which pdf.js reports
// in the private-use range U+F000–U+F0FF.
const STRONG_MARKER = /^(?:[\u2022\u25e6\u25aa\u25ab\u2023\u2043\u25cf\u25cb\u25a0\u25a1*\uf000-\uf0ff]|\d{1,3}[.)]|\(\d{1,3}\))\s/u;
const WEAK_MARKER = /^(?:[\u2013\u2014-]|\(?(?:[a-z]|[ivxlcdm]{1,6})[.)])\s/iu;
const SENTENCE_END = /[.:;!?)]$/u;
// Scripts written without spaces between words: lines join with no space.
const NO_SPACE_SCRIPT =
  '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Bopomofo}' +
  '\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}' +
  '\\u3000-\\u303f\\uff00-\\uff9f\\uffe0-\\uffef]';
const ENDS_NO_SPACE_SCRIPT = new RegExp(`${NO_SPACE_SCRIPT}$`, 'u');
const STARTS_NO_SPACE_SCRIPT = new RegExp(`^${NO_SPACE_SCRIPT}`, 'u');
const LINE_END_HYPHEN = /\p{L}[-‐­]$/u;
const STARTS_LOWERCASE = /^\p{Ll}/u;

interface Run {
  readonly text: string;
  readonly left: number;
  readonly right: number;
  readonly baseline: number;
  readonly top: number;
  readonly bottom: number;
  readonly size: number;
  readonly fontId: string;
  readonly rtl: boolean;
}

interface Line {
  runs: Run[];
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  baseline: number;
  /** A piece of an OCR line cut around typed text: a block of its own. */
  alone?: boolean;
  /** Its line's other pieces share `id` (D184). */
  flow?: { readonly id: number; readonly part: number };
}

/**
 * `pageWidth` (points) lets a single line be recognised as centred on the
 * page; without it, single lines are aligned to their start.
 */
export function pdfTextBlocks(
  content: PdfTextContent,
  pageTransform: readonly number[],
  pageWidth?: number,
): PdfTextBlock[] {
  return blocksFromLines(
    textLines(content, pageTransform),
    content.styles,
    pageWidth,
    SIZE_TOLERANCE,
  );
}

interface PdfOcrBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One recognised line of a scanned page, in pixels of the bitmap OCR read. */
export interface PdfOcrLine {
  readonly text: string;
  readonly boundingBox: PdfOcrBox;
  /** The line's words in reading order, where OCR reports them (Tesseract). */
  readonly words?: readonly {
    readonly text: string;
    readonly boundingBox: PdfOcrBox;
  }[];
}

/**
 * Groups the lines OCR recognised on a scanned page into blocks, by the same
 * rules as pdf.js text, in the order OCR read them. `pixelsPerPoint` is the
 * bitmap's pixels per PDF point, so the blocks are in page points like
 * `pdfTextBlocks`. A line box runs from the tallest glyph to the lowest, so it
 * stands in for the font size; lines without ascenders or descenders are
 * shorter, which the wider size tolerance allows for. `typed` holds the line
 * boxes of the page's own text, in page points: OCR read the page as drawn,
 * that text included. A line whose words are known loses the words that lie
 * over typed text and keeps the rest, as a piece with its own box (D121): a
 * typed page number beside a scanned footer was shown twice, and a scan's few
 * words beside a long typed line were lost. A line without words, or whose
 * words are all clear of typed text, is judged as one piece: left out when it
 * lies mostly over typed text.
 */
export function pdfOcrBlocks(
  lines: readonly PdfOcrLine[],
  pixelsPerPoint: number,
  pageWidth?: number,
  typed: readonly PdfTextRect[] = [],
): PdfTextBlock[] {
  if (!(pixelsPerPoint > 0) || !Number.isFinite(pixelsPerPoint)) return [];
  const converted: Line[] = [];
  let flows = 0;
  for (const line of lines) {
    const text = line.text.replace(/\s+/gu, ' ').trim();
    const { x, y, width, height } = line.boundingBox;
    if (
      text.length === 0 ||
      ![x, y, width, height].every(Number.isFinite) ||
      width <= 0 ||
      height <= 0
    ) continue;
    // A line much taller than wide is vertical text (a Japanese column); it
    // stays as drawn, like pdf.js's vertical runs. One character may be
    // taller than wide on its own.
    if (height > VERTICAL_LINE_RATIO * width && [...text].length > 1) continue;
    const left = x / pixelsPerPoint;
    const top = y / pixelsPerPoint;
    const right = (x + width) / pixelsPerPoint;
    const bottom = (y + height) / pixelsPerPoint;
    const pieces = typed.length > 0
      ? piecesClearOfTypedText(text, line.words, pixelsPerPoint, typed)
      : undefined;
    const mostlyTyped = overTypedText(
      { left, top, width: right - left, height: bottom - top },
      typed,
    );
    if (pieces) {
      // Each piece keeps the line's own height, which stands for its font
      // size, and the span of its words. It joins no other line: a block is
      // drawn as one box, and the box of a piece with the line above or
      // below it would lie over the typed text the piece was cut around.
      // Beside a line that is mostly typed text, a single character is a
      // box border or a speck read as a letter, not the scan's own text.
      const kept = pieces.filter((piece) => !mostlyTyped || lettersAndDigits(piece.text) >= 2);
      // The pieces of one line are one text to translate (D184).
      const flow = kept.length > 1 ? (flows += 1) : undefined;
      kept.forEach((piece, part) => {
        converted.push({
          ...ocrLine(piece.text, piece.left, top, piece.right, bottom),
          alone: true,
          ...(flow === undefined ? {} : { flow: { id: flow, part } }),
        });
      });
      continue;
    }
    if (mostlyTyped) continue;
    converted.push(ocrLine(text, left, top, right, bottom));
  }
  // The tallest line comes nearest the font size: shorter lines lack
  // ascenders or descenders. The line pitch in points stays as measured.
  const blocks = blocksFromLines(converted, {}, pageWidth, OCR_SIZE_TOLERANCE).map((block) => {
    const size = Math.max(...block.lines.map((line) => line.height));
    return size > block.fontSize
      ? { ...block, fontSize: size, lineHeight: (block.lineHeight * block.fontSize) / size }
      : block;
  });
  return flowOn(blocks, flows);
}

/**
 * Makes the block below a line cut around typed text the last part of the
 * line's flow, where the line runs on into it (D189): the line does not
 * end a sentence and reaches the right of that block, which starts at once
 * below it where the line starts. Only one block may fit: two (columns, a
 * caption beside) leave the reading order open, and the line stays alone.
 */
function flowOn(blocks: PdfTextBlock[], flows: number): PdfTextBlock[] {
  for (let id = 1; id <= flows; id += 1) {
    const pieces = blocks.filter((block) => block.flow?.id === id);
    if (pieces.length < 2) continue;
    const last = pieces.reduce((a, b) => (b.flow!.part > a.flow!.part ? b : a));
    if (SENTENCE_END.test(last.text.trim())) continue;
    const top = Math.min(...pieces.map((piece) => piece.box.top));
    const bottom = Math.max(...pieces.map((piece) => piece.box.top + piece.box.height));
    const left = Math.min(...pieces.map((piece) => piece.box.left));
    const right = Math.max(...pieces.map((piece) => piece.box.left + piece.box.width));
    const height = bottom - top;
    const below = blocks.filter((block) => {
      if (block.flow) return false;
      const gap = block.box.top - bottom;
      return gap >= -FLOW_ON_GAP * height / 2 &&
        gap <= FLOW_ON_GAP * height &&
        block.box.left < right &&
        block.box.left + block.box.width > left;
    });
    if (below.length !== 1) continue;
    const next = below[0]!;
    const nextRight = next.box.left + next.box.width;
    if (
      Math.abs(next.box.left - left) > FLOW_ON_EDGE * height ||
      nextRight > right + FLOW_ON_EDGE * height
    ) continue;
    const index = blocks.indexOf(next);
    blocks[index] = { ...next, flow: { id, part: last.flow!.part + 1 } };
  }
  return blocks;
}

function ocrLine(text: string, left: number, top: number, right: number, bottom: number): Line {
  const run: Run = {
    text,
    left,
    right,
    baseline: bottom,
    top,
    bottom,
    size: bottom - top,
    fontId: OCR_FONT_ID,
    rtl: mostlyRtlText(text),
  };
  return { runs: [run], text, left, right, top, bottom, baseline: bottom };
}

/**
 * The parts of an OCR line that typed text does not cover: each run of
 * neighbouring words that are clear of it, with the text between them as OCR
 * wrote it. Empty when typed text covers every word. `undefined` when the
 * words cannot say: there are none, they are not the line's text in its
 * order, or none of them lies over typed text.
 */
function piecesClearOfTypedText(
  text: string,
  words: PdfOcrLine['words'],
  pixelsPerPoint: number,
  typed: readonly PdfTextRect[],
): { readonly text: string; readonly left: number; readonly right: number }[] | undefined {
  if (!words || words.length === 0) return undefined;
  const pieces: { start: number; end: number; left: number; right: number }[] = [];
  let piece: (typeof pieces)[number] | undefined;
  let cursor = 0;
  let covered = 0;
  for (const word of words) {
    const wordText = word.text.replace(/\s+/gu, ' ').trim();
    const { x, y, width, height } = word.boundingBox;
    if (
      wordText.length === 0 ||
      ![x, y, width, height].every(Number.isFinite) ||
      width <= 0 ||
      height <= 0
    ) return undefined;
    // The words must make up the line's text, with only spaces between.
    const start = text.indexOf(wordText, cursor);
    if (start < 0 || text.slice(cursor, start).trim() !== '') return undefined;
    cursor = start + wordText.length;
    const left = x / pixelsPerPoint;
    const right = (x + width) / pixelsPerPoint;
    if (overTypedText({
      left,
      top: y / pixelsPerPoint,
      width: right - left,
      height: height / pixelsPerPoint,
    }, typed)) {
      covered += 1;
      piece = undefined;
      continue;
    }
    if (piece) {
      piece.end = cursor;
      piece.left = Math.min(piece.left, left);
      piece.right = Math.max(piece.right, right);
    } else {
      piece = { start, end: cursor, left, right };
      pieces.push(piece);
    }
  }
  if (text.slice(cursor).trim() !== '' || covered === 0) return undefined;
  return pieces
    .map(({ start, end, left, right }) => ({ text: text.slice(start, end), left, right }))
    // A dash or a bar left between typed words says nothing on its own.
    .filter((each) => LETTER_OR_DIGIT.test(each.text));
}

function lettersAndDigits(text: string): number {
  return text.match(LETTERS_AND_DIGITS)?.length ?? 0;
}

/** Whether typed line boxes cover `OCR_TYPED_OVERLAP` of the box. */
function overTypedText(line: PdfTextRect, typed: readonly PdfTextRect[]): boolean {
  let covered = 0;
  for (const box of typed) {
    const width = Math.min(line.left + line.width, box.left + box.width) -
      Math.max(line.left, box.left);
    const height = Math.min(line.top + line.height, box.top + box.height) -
      Math.max(line.top, box.top);
    if (width > 0 && height > 0) covered += width * height;
  }
  return covered >= OCR_TYPED_OVERLAP * line.width * line.height;
}

function blocksFromLines(
  lines: readonly Line[],
  styles: PdfTextContent['styles'],
  pageWidth: number | undefined,
  sizeTolerance: number,
): PdfTextBlock[] {
  const blocks: Line[][] = [];
  let current: Line[] | undefined;
  for (const line of lines) {
    const previous = current?.at(-1);
    if (current && previous && joinsBlock(current, previous, line, sizeTolerance)) {
      current.push(line);
    } else {
      current = [line];
      blocks.push(current);
    }
  }
  // Blocks of several lines first: the left-aligned ones give the page's
  // left margin, which tells a centred single line from a short one.
  const aligns = new Map<Line[], PdfTextAlign>();
  let margin: number | undefined;
  for (const block of blocks) {
    if (block.length < 2) continue;
    const align = linesAlign(block, dominantSize(block.flatMap((line) => line.runs)), mostlyRtl(block));
    aligns.set(block, align);
    if (align === 'left') {
      const left = Math.min(...block.map((line) => line.left));
      margin = margin === undefined ? left : Math.min(margin, left);
    }
  }
  const page = {
    width: Number.isFinite(pageWidth) && pageWidth! > 0 ? pageWidth : undefined,
    margin,
  };
  return blocks
    .map((block) => toBlock(block, styles, aligns.get(block), page))
    // A block with no area has nothing to cover; it stays as drawn.
    .filter(({ box }) =>
      Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0);
}

/** The page's lines of text, in content order, with rotated runs left out. */
function textLines(content: PdfTextContent, pageTransform: readonly number[]): Line[] {
  const lines: Line[] = [];
  let line: Line | undefined;
  let lineEnded = false;
  let previous: Run | undefined;
  for (const item of content.items) {
    const style = content.styles[item.fontName];
    const run = textRun(item, style, pageTransform);
    if (!run) {
      // A rotated or vertical run ends the line it interrupts.
      lineEnded = true;
      continue;
    }
    if (
      (previous && repeats(previous, run)) ||
      line?.runs.some((earlier) => repeats(earlier, run))
    ) {
      if (item.hasEOL) lineEnded = true;
      continue;
    }
    if (run.text.trim() === '') {
      // Spaces and empty runs place no text; a space between two runs on
      // one line becomes a space in it.
      if (line && !lineEnded && run.text.length > 0 && !breaksLine(line, run)) {
        if (!/\s$/u.test(line.text)) line.text += ' ';
      }
      if (item.hasEOL) lineEnded = true;
      continue;
    }
    if (!line || lineEnded || breaksLine(line, run)) {
      line = {
        runs: [],
        text: '',
        left: run.left,
        right: run.right,
        top: run.top,
        bottom: run.bottom,
        baseline: run.baseline,
      };
      lines.push(line);
    } else if (
      line.text.length > 0 &&
      !/\s$/u.test(line.text) &&
      !/^\s/u.test(run.text) &&
      gap(line, run) > SPACE_GAP * Math.max(run.size, dominantSize(line.runs))
    ) {
      line.text += ' ';
    }
    previous = run;
    line.runs.push(run);
    line.text += run.text;
    line.left = Math.min(line.left, run.left);
    line.right = Math.max(line.right, run.right);
    line.top = Math.min(line.top, run.top);
    line.bottom = Math.max(line.bottom, run.bottom);
    lineEnded = item.hasEOL;
  }
  for (const each of lines) each.text = each.text.replace(/\s+/gu, ' ').trim();
  return lines.filter((each) => each.text.length > 0);
}

function textRun(
  item: PdfTextItem,
  style: PdfTextStyle | undefined,
  pageTransform: readonly number[],
): Run | undefined {
  if (style?.vertical || item.dir === 'ttb') return undefined;
  const tx = multiply(pageTransform, item.transform);
  const size = Math.hypot(tx[2]!, tx[3]!);
  if (!(size > 0) || !Number.isFinite(size)) return undefined;
  if (Math.abs(Math.atan2(tx[1]!, tx[0]!)) > ROTATION_TOLERANCE) return undefined;
  const ascent = fontAscent(style);
  const descent = fontDescent(style, ascent);
  const left = tx[4]!;
  const baseline = tx[5]!;
  const width = Number.isFinite(item.width) && item.width > 0 ? item.width : 0;
  if (!Number.isFinite(left) || !Number.isFinite(baseline)) return undefined;
  return {
    text: item.str,
    left,
    right: left + width,
    baseline,
    top: baseline - ascent * size,
    bottom: baseline + descent * size,
    size,
    fontId: item.fontName,
    rtl: item.dir === 'rtl',
  };
}

/** Same fallbacks as pdf.js's own text layer. */
function fontAscent(style: PdfTextStyle | undefined): number {
  if (style?.ascent) return style.ascent;
  if (style?.descent) return 1 + style.descent;
  return 0.8;
}

/** How far below the baseline the font reaches, as a positive share. */
function fontDescent(style: PdfTextStyle | undefined, ascent: number): number {
  if (style?.descent) return Math.abs(style.descent);
  return Math.max(0.2, 1 - ascent);
}

/** The same text again at almost the same place. */
function repeats(previous: Run, run: Run): boolean {
  const offset = REPEAT_OFFSET * Math.max(previous.size, run.size);
  return run.text === previous.text &&
    Math.abs(run.left - previous.left) < offset &&
    Math.abs(run.baseline - previous.baseline) < offset;
}

/**
 * The space between the line and a run that follows it, in reading
 * direction: leftwards in a right-to-left line, whatever the run's own
 * direction (a number or a Latin word inside Hebrew or Arabic).
 */
function gap(line: Line, run: Run): number {
  return run.rtl || mostlyRtl([line]) ? line.left - run.right : run.left - line.right;
}

function breaksLine(line: Line, run: Run): boolean {
  const size = Math.max(run.size, dominantSize(line.runs));
  if (Math.abs(run.baseline - line.baseline) > BASELINE_BREAK * size) return true;
  if (gap(line, run) > GAP_BREAK * size) return true;
  // Moving left is how a right-to-left line goes on, so only a left-to-right
  // line breaks there.
  return !run.rtl && !mostlyRtl([line]) &&
    run.left < line.right - BACKWARDS_BREAK * size && run.left < line.left;
}

/** Whether most of the lines' characters are in right-to-left runs. */
function mostlyRtl(lines: readonly Line[]): boolean {
  let rtl = 0;
  let ltr = 0;
  for (const line of lines) {
    for (const run of line.runs) {
      const length = run.text.trim().length;
      if (run.rtl) rtl += length;
      else ltr += length;
    }
  }
  return rtl > ltr;
}

/** Whether most of the text's letters are in a right-to-left script. */
function mostlyRtlText(text: string): boolean {
  let rtl = 0;
  let letters = 0;
  for (const character of text) {
    if (!LETTER.test(character)) continue;
    letters += 1;
    if (RTL_CHARACTER.test(character)) rtl += 1;
  }
  return rtl * 2 > letters;
}

function joinsBlock(
  block: readonly Line[],
  previous: Line,
  line: Line,
  sizeTolerance: number,
): boolean {
  if (previous.alone || line.alone) return false;
  const previousSize = dominantSize(previous.runs);
  const size = dominantSize(line.runs);
  const larger = Math.max(previousSize, size);
  if (Math.abs(previousSize - size) > sizeTolerance * larger) return false;
  const pitch = line.baseline - previous.baseline;
  if (pitch <= BASELINE_BREAK * larger || pitch > MAX_LINE_PITCH * larger) return false;
  const left = Math.min(...block.map((each) => each.left));
  const right = Math.max(...block.map((each) => each.right));
  if (line.right < left || line.left > right) return false;
  if (STRONG_MARKER.test(line.text)) return false;
  if (!WEAK_MARKER.test(line.text)) return true;
  const inList = STRONG_MARKER.test(block[0]!.text) || WEAK_MARKER.test(block[0]!.text);
  return !inList && !SENTENCE_END.test(previous.text);
}

/**
 * How several lines line up. Centred when their centres line up and their
 * left edges do not. Right-aligned when their right edges line up and their
 * left edges vary beyond a first-line indent. Otherwise the text's own
 * side: left, or right for right-to-left text (mirrored the same way).
 */
function linesAlign(lines: readonly Line[], fontSize: number, rtl: boolean): PdfTextAlign {
  const tolerance = EDGE_TOLERANCE * fontSize;
  const spread = (values: readonly number[]) => Math.max(...values) - Math.min(...values);
  const lefts = lines.map((line) => line.left);
  const rights = lines.map((line) => line.right);
  const centres = lines.map((line) => (line.left + line.right) / 2);
  if (spread(lefts) > tolerance && spread(rights) > tolerance && spread(centres) <= tolerance) {
    return 'center';
  }
  const [first, ...rest] = lines;
  if (!rtl) {
    const indented = first!.left > Math.max(...rest.map((line) => line.left)) + tolerance;
    const leftsVary = spread(lefts.slice(1)) > tolerance ||
      (spread(lefts) > tolerance && !indented);
    return spread(rights) <= tolerance && leftsVary ? 'right' : 'left';
  }
  const indented = first!.right < Math.min(...rest.map((line) => line.right)) - tolerance;
  const rightsVary = spread(rights.slice(1)) > tolerance ||
    (spread(rights) > tolerance && !indented);
  return spread(lefts) <= tolerance && rightsVary ? 'left' : 'right';
}

/**
 * A single line is centred when it sits in the middle of the page and, if
 * the page has left-aligned paragraphs, away from their left margin.
 */
function lineAlign(
  line: Line,
  fontSize: number,
  rtl: boolean,
  page: { readonly width: number | undefined; readonly margin: number | undefined },
): PdfTextAlign {
  const natural = rtl ? 'right' : 'left';
  if (page.width === undefined) return natural;
  if (page.margin !== undefined && line.left <= page.margin + EDGE_TOLERANCE * fontSize) {
    return natural;
  }
  const centre = (line.left + line.right) / 2;
  return Math.abs(centre - page.width / 2) <= PAGE_CENTRE_TOLERANCE * page.width
    ? 'center'
    : natural;
}

function toBlock(
  lines: readonly Line[],
  styles: PdfTextContent['styles'],
  align: PdfTextAlign | undefined,
  page: { readonly width: number | undefined; readonly margin: number | undefined },
): PdfTextBlock {
  let text = '';
  for (const line of lines) text = joinLines(text, line.text);
  const runs = lines.flatMap((line) => line.runs);
  const fontSize = dominantSize(runs);
  const fontId = dominant(runs, (run) => run.fontId);
  const pitches = lines.slice(1).map((line, index) => line.baseline - lines[index]!.baseline);
  const lineHeight = pitches.length > 0 && fontSize > 0
    ? median(pitches) / fontSize
    : SINGLE_LINE_HEIGHT;
  const rects = lines.map((line) => rect(line.left, line.top, line.right, line.bottom));
  return {
    text,
    lines: rects,
    box: rect(
      Math.min(...lines.map((line) => line.left)),
      Math.min(...lines.map((line) => line.top)),
      Math.max(...lines.map((line) => line.right)),
      Math.max(...lines.map((line) => line.bottom)),
    ),
    fontSize,
    lineHeight,
    fontFamily: genericFamily(styles[fontId]?.fontFamily),
    fontId,
    align: align ?? lineAlign(lines[0]!, fontSize, mostlyRtl(lines), page),
    // A piece joins no other line, so its block is that one line.
    ...(lines.length === 1 && lines[0]!.flow ? { flow: lines[0]!.flow } : {}),
  };
}

/**
 * Splits a translation across the pieces of a line cut around typed text
 * (D184), in reading order, at word boundaries: each piece takes words
 * while the text measured so far stays within its share of the pieces'
 * room (`capacities`, a piece's width on the page). `measure` gives a
 * text's length in the units the shares are counted in; by default its
 * characters, which a block's font then fits to its box. Every piece gets
 * at least one word while words are left, and the last takes the rest.
 * Text written without spaces is split between characters.
 */
export function splitAcrossPieces(
  text: string,
  capacities: readonly number[],
  measure: (text: string) => number = (each) => [...each].length,
): string[] {
  const count = capacities.length;
  if (count === 0) return [];
  const trimmed = text.replace(/\s+/gu, ' ').trim();
  const spaced = trimmed.includes(' ');
  const words = spaced ? trimmed.split(' ') : [...trimmed];
  const join = (parts: readonly string[]) => parts.join(spaced ? ' ' : '');
  const room = capacities.map((capacity) => (Number.isFinite(capacity) && capacity > 0 ? capacity : 0));
  const totalRoom = room.reduce((sum, each) => sum + each, 0);
  const total = measure(join(words));
  const parts: string[] = [];
  let next = 0;
  let roomBefore = 0;
  for (let index = 0; index < count; index += 1) {
    if (index === count - 1) {
      parts.push(join(words.slice(next)));
      break;
    }
    roomBefore += room[index]!;
    // Where this piece's share of the room ends, measured in text.
    const end = totalRoom > 0 ? (total * roomBefore) / totalRoom : (total * (index + 1)) / count;
    // Leave a word for each piece after this one, where there are enough:
    // with too few, the pieces take one each in reading order.
    const last = Math.max(Math.min(next + 1, words.length), words.length - (count - 1 - index));
    let taken = next;
    if (taken < last) taken += 1;
    while (taken < last) {
      const withNext = measure(join(words.slice(0, taken + 1)));
      const without = measure(join(words.slice(0, taken)));
      // Take the next word when the share ends nearer after it than before.
      if (end - without <= withNext - end) break;
      taken += 1;
    }
    parts.push(join(words.slice(next, taken)));
    next = taken;
  }
  return parts;
}

/**
 * Joins a line to the text before it: a word broken by a hyphen rejoins, and
 * scripts written without spaces (Chinese, Japanese, Thai, Lao, Khmer,
 * Myanmar) take none. Korean takes a space.
 */
export function joinLines(before: string, next: string): string {
  if (!before) return next;
  if (!next) return before;
  if (LINE_END_HYPHEN.test(before)) {
    // A word broken at the line end rejoins; a compound keeps its hyphen.
    return STARTS_LOWERCASE.test(next) ? before.slice(0, -1) + next : before + next;
  }
  if (ENDS_NO_SPACE_SCRIPT.test(before) || STARTS_NO_SPACE_SCRIPT.test(next)) {
    return before + next;
  }
  return `${before} ${next}`;
}

function genericFamily(family: string | undefined): PdfFontFamily {
  return family === 'serif' || family === 'monospace' ? family : 'sans-serif';
}

/** The size of the runs holding the most characters. */
function dominantSize(runs: readonly Run[]): number {
  if (runs.length === 0) return 0;
  return Number(dominant(runs, (run) => String(Math.round(run.size * 100) / 100)));
}

function dominant(runs: readonly Run[], key: (run: Run) => string): string {
  const weights = new Map<string, number>();
  for (const run of runs) {
    const value = key(run);
    weights.set(value, (weights.get(value) ?? 0) + Math.max(1, run.text.trim().length));
  }
  let best = '';
  let bestWeight = -1;
  for (const [value, weight] of weights) {
    if (weight > bestWeight) {
      best = value;
      bestWeight = weight;
    }
  }
  return best;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function rect(left: number, top: number, right: number, bottom: number): PdfTextRect {
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** `Util.transform` from pdf.js: the 2D matrix product `m1 × m2`. */
function multiply(m1: readonly number[], m2: readonly number[]): number[] {
  const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = m1;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}
