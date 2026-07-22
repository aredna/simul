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
    regions.push(Object.freeze({
      text,
      confidence,
      boundingBox,
    }));
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
  const values = [rect.left, rect.top, rect.right, rect.bottom];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return undefined;
  }
  const left = clamp(Math.floor(rect.left as number), 0, bitmapWidth);
  const top = clamp(Math.floor(rect.top as number), 0, bitmapHeight);
  const right = clamp(Math.ceil(rect.right as number), 0, bitmapWidth);
  const bottom = clamp(Math.ceil(rect.bottom as number), 0, bitmapHeight);
  if (right <= left || bottom <= top) return undefined;
  return Object.freeze({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
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
