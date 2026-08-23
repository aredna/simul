import {
  readImageTextResult,
  type ImageTextRegion,
  type ImageTextResult,
} from '../../contracts';

interface DirectTesseractRectLike {
  readonly left?: unknown;
  readonly top?: unknown;
  readonly right?: unknown;
  readonly bottom?: unknown;
}

export interface DirectTesseractTextItemLike {
  readonly text?: unknown;
  readonly confidence?: unknown;
  readonly rect?: DirectTesseractRectLike;
}

const MAX_DIRECT_TESSERACT_REGIONS = 10_000;
const MAX_DIRECT_TESSERACT_REGION_TEXT = 100_000;
const MAX_DIRECT_TESSERACT_TRANSCRIPT = 1_000_000;

export function normalizeDirectTesseractTextItems(
  items: readonly DirectTesseractTextItemLike[],
  bitmapWidth: number,
  bitmapHeight: number,
): ImageTextResult | undefined {
  if (!Array.isArray(items) || items.length > MAX_DIRECT_TESSERACT_REGIONS) {
    return undefined;
  }
  const regions: ImageTextRegion[] = [];
  const transcriptParts: string[] = [];
  let transcriptLength = 0;
  let confidenceTotal = 0;
  let confidenceCount = 0;
  for (const item of items) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.text !== 'string' ||
      item.text.length > MAX_DIRECT_TESSERACT_REGION_TEXT
    ) return undefined;
    const text = item.text.trim();
    if (!text) continue;
    const boundingBox = normalizeRect(item?.rect, bitmapWidth, bitmapHeight);
    if (!boundingBox) return undefined;
    const confidence = normalizeConfidence(item.confidence);
    if (confidence === undefined) return undefined;
    const separatorLength = transcriptParts.length > 0 ? 1 : 0;
    if (
      transcriptLength + separatorLength + text.length >
      MAX_DIRECT_TESSERACT_TRANSCRIPT
    ) return undefined;
    transcriptLength += separatorLength + text.length;
    transcriptParts.push(text);
    confidenceTotal += confidence;
    confidenceCount += 1;
    regions.push({
      text,
      confidence,
      boundingBox,
    });
  }
  const aggregateConfidence = confidenceCount > 0
    ? confidenceTotal / confidenceCount
    : undefined;
  return readImageTextResult({
    providerId: 'tesseract-wasm-direct',
    bitmapWidth,
    bitmapHeight,
    transcript: transcriptParts.join('\n'),
    ...(aggregateConfidence !== undefined
      ? {
          transcriptConfidence: aggregateConfidence,
          geometryConfidence: aggregateConfidence,
        }
      : {}),
    regions,
  });
}

function normalizeRect(
  rect: DirectTesseractRectLike | undefined,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageTextRegion['boundingBox'] | undefined {
  if (!rect) return undefined;
  const { left, top, right, bottom } = rect;
  if (
    typeof left !== 'number' || !Number.isFinite(left) ||
    typeof top !== 'number' || !Number.isFinite(top) ||
    typeof right !== 'number' || !Number.isFinite(right) ||
    typeof bottom !== 'number' || !Number.isFinite(bottom)
  ) {
    return undefined;
  }
  const x0 = clamp(Math.floor(left), 0, bitmapWidth);
  const y0 = clamp(Math.floor(top), 0, bitmapHeight);
  const x1 = clamp(Math.ceil(right), 0, bitmapWidth);
  const y1 = clamp(Math.ceil(bottom), 0, bitmapHeight);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function normalizeConfidence(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
