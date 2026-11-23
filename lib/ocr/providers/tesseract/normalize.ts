import {
  MAX_IMAGE_TEXT_REGION_WORDS,
  MAX_IMAGE_TEXT_RESULT_WORDS,
  MAX_IMAGE_TEXT_WORD_LENGTH,
  readImageTextResult,
  type ImageTextResult,
  type ImageTextRegion,
  type ImageTextWord,
} from '../../contracts';

interface TesseractBbox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface TesseractWord {
  readonly text?: unknown;
  readonly bbox?: TesseractBbox;
}

interface TesseractLine {
  readonly text: string;
  readonly confidence?: unknown;
  readonly bbox: TesseractBbox;
  readonly words?: readonly TesseractWord[] | null;
}

interface TesseractPageLike {
  readonly text?: unknown;
  readonly confidence?: unknown;
  readonly blocks?: readonly {
    readonly paragraphs?: readonly {
      readonly lines?: readonly TesseractLine[];
    }[];
  }[] | null;
}

/** `withWords`: the job asked for each line's words (a PDF page, D121). */
export function normalizeTesseractPage(
  page: TesseractPageLike,
  bitmapWidth: number,
  bitmapHeight: number,
  withWords = false,
): ImageTextResult | undefined {
  const transcript = typeof page.text === 'string'
    ? page.text.slice(0, 1_000_000)
    : '';
  const regions: ImageTextRegion[] = [];
  let wordCount = 0;
  let confidenceTotal = 0;
  let confidenceCount = 0;
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        if (regions.length >= 10_000) return undefined;
        const text = typeof line.text === 'string'
          ? line.text.trim().slice(0, 100_000)
          : '';
        const boundingBox = normalizeBbox(line.bbox, bitmapWidth, bitmapHeight);
        if (!text || !boundingBox) continue;
        const confidence = normalizeOptionalConfidence(line.confidence);
        if (confidence !== undefined) {
          confidenceTotal += confidence;
          confidenceCount += 1;
        }
        const words = withWords
          ? normalizeWords(
              line.words,
              bitmapWidth,
              bitmapHeight,
              MAX_IMAGE_TEXT_RESULT_WORDS - wordCount,
            )
          : undefined;
        wordCount += words?.length ?? 0;
        // A web image's line that jumps across a wide gap is two texts side
        // by side (D235); a PDF page's lines are cut by its own rules (D184).
        const pieces = withWords
          ? undefined
          : splitLineAtWideGaps(line, text, bitmapWidth, bitmapHeight);
        if (pieces) {
          if (regions.length + pieces.length > 10_000) return undefined;
          for (const piece of pieces) {
            regions.push({
              text: piece.text,
              ...(confidence !== undefined ? { confidence } : {}),
              boundingBox: piece.boundingBox,
            });
          }
          continue;
        }
        regions.push({
          text,
          ...(confidence !== undefined ? { confidence } : {}),
          boundingBox,
          ...(words ? { words } : {}),
        });
      }
    }
  }
  const transcriptConfidence = normalizeOptionalConfidence(page.confidence);
  const candidate = {
    providerId: 'tesseract' as const,
    bitmapWidth,
    bitmapHeight,
    transcript,
    ...(transcriptConfidence !== undefined ? { transcriptConfidence } : {}),
    ...(confidenceCount > 0
      ? { geometryConfidence: confidenceTotal / confidenceCount }
      : {}),
    regions,
  };
  return readImageTextResult(candidate, withWords);
}

/**
 * The line's words with their boxes, which Tesseract reports under each line
 * (D121). All of them or none: a line whose words cannot all be placed, or
 * with a single word, or past the bounds, carries no words and is treated as
 * one piece.
 */
function normalizeWords(
  words: readonly TesseractWord[] | null | undefined,
  bitmapWidth: number,
  bitmapHeight: number,
  remaining: number,
): ImageTextWord[] | undefined {
  if (!Array.isArray(words)) return undefined;
  const normalized: ImageTextWord[] = [];
  for (const word of words as readonly TesseractWord[]) {
    const text = typeof word?.text === 'string' ? word.text.trim() : '';
    if (!text) continue;
    const boundingBox = normalizeBbox(word.bbox, bitmapWidth, bitmapHeight);
    if (
      !boundingBox ||
      text.length > MAX_IMAGE_TEXT_WORD_LENGTH ||
      normalized.length >= MAX_IMAGE_TEXT_REGION_WORDS ||
      normalized.length >= remaining
    ) return undefined;
    normalized.push({ text, boundingBox });
  }
  return normalized.length >= 2 ? normalized : undefined;
}

/**
 * How much wider than the line is tall a gap between two of its words must
 * be before the line counts as two texts (D235).
 */
const WIDE_GAP_LINE_HEIGHTS = 2.5;

/**
 * Tesseract reads an image as one block, so text set side by side (one
 * picture of four cards, a label beside a price far to its right) comes out
 * as one line running across the space between them, and its translation was
 * drawn over both as one box (backmarket.co.jp, D235). Where two words of a
 * line lie further apart than `WIDE_GAP_LINE_HEIGHTS` times the line's
 * height, the line is cut there: each piece is the line's own text from its
 * first word to its last, with the box of its words. Nothing is cut when a
 * word cannot be placed or found in the line's text in order.
 */
function splitLineAtWideGaps(
  line: TesseractLine,
  text: string,
  bitmapWidth: number,
  bitmapHeight: number,
): { text: string; boundingBox: ImageTextRegion['boundingBox'] }[] | undefined {
  if (!Array.isArray(line.words) || line.words.length < 2) return undefined;
  const lineBox = normalizeBbox(line.bbox, bitmapWidth, bitmapHeight);
  if (!lineBox) return undefined;
  const placed: { start: number; end: number; box: ImageTextRegion['boundingBox'] }[] = [];
  let cursor = 0;
  for (const word of line.words as readonly TesseractWord[]) {
    const wordText = typeof word?.text === 'string' ? word.text.trim() : '';
    if (!wordText) continue;
    const box = normalizeBbox(word.bbox, bitmapWidth, bitmapHeight);
    const start = text.indexOf(wordText, cursor);
    if (!box || start < 0) return undefined;
    cursor = start + wordText.length;
    placed.push({ start, end: cursor, box });
  }
  if (placed.length < 2) return undefined;
  const gap = lineBox.height * WIDE_GAP_LINE_HEIGHTS;
  const groups: (typeof placed)[] = [[placed[0]!]];
  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1]!;
    const current = placed[index]!;
    const apart = current.box.x - (previous.box.x + previous.box.width);
    if (apart > gap) groups.push([current]);
    else groups.at(-1)!.push(current);
  }
  if (groups.length < 2) return undefined;
  const pieces = [];
  for (const group of groups) {
    const first = group[0]!;
    const last = group.at(-1)!;
    const pieceText = text.slice(first.start, last.end).trim();
    if (!pieceText) return undefined;
    const x0 = Math.min(...group.map((word) => word.box.x));
    const y0 = Math.min(...group.map((word) => word.box.y));
    const x1 = Math.max(...group.map((word) => word.box.x + word.box.width));
    const y1 = Math.max(...group.map((word) => word.box.y + word.box.height));
    pieces.push({
      text: pieceText,
      boundingBox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    });
  }
  return pieces;
}

function normalizeBbox(
  bbox: TesseractBbox | undefined,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageTextRegion['boundingBox'] | undefined {
  if (
    !bbox ||
    !Number.isFinite(bbox.x0) ||
    !Number.isFinite(bbox.y0) ||
    !Number.isFinite(bbox.x1) ||
    !Number.isFinite(bbox.y1)
  ) {
    return undefined;
  }
  const x0 = clamp(Math.floor(bbox.x0), 0, bitmapWidth);
  const y0 = clamp(Math.floor(bbox.y0), 0, bitmapHeight);
  const x1 = clamp(Math.ceil(bbox.x1), 0, bitmapWidth);
  const y1 = clamp(Math.ceil(bbox.y1), 0, bitmapHeight);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function normalizeOptionalConfidence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value / 100, 0, 1)
    : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
