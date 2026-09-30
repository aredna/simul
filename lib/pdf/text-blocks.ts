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
  const lines = textLines(content, pageTransform);
  const blocks: Line[][] = [];
  let current: Line[] | undefined;
  for (const line of lines) {
    const previous = current?.at(-1);
    if (current && previous && joinsBlock(current, previous, line)) {
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
    .map((block) => toBlock(block, content.styles, aligns.get(block), page))
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

function joinsBlock(block: readonly Line[], previous: Line, line: Line): boolean {
  const previousSize = dominantSize(previous.runs);
  const size = dominantSize(line.runs);
  const larger = Math.max(previousSize, size);
  if (Math.abs(previousSize - size) > SIZE_TOLERANCE * larger) return false;
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
  };
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
  const sorted = [...values].sort((left, right) => left - right);
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
