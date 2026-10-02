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
