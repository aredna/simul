import {
  readImageTextResult,
  type ImageBoundingBox,
  type ImagePoint,
  type ImageTextRegion,
  type ImageTextResult,
} from '../../contracts';

const MAX_CHROME_TEXT_TRANSCRIPT_LENGTH = 1_000_000;

/** Normalize both the current WICG shape and legacy boxes-only Chrome output. */
export function normalizeChromeTextDetection(
  detections: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageTextResult | undefined {
  if (!Array.isArray(detections) || detections.length > 10_000) {
    return undefined;
  }
  const regions: ImageTextRegion[] = [];
  const transcriptParts: string[] = [];
  let transcriptLength = 0;
  for (const detection of detections) {
    if (!isRecord(detection)) return undefined;
    const boundingBox = normalizeBoundingBox(
      detection.boundingBox,
      bitmapWidth,
      bitmapHeight,
    );
    if (!boundingBox) continue;
    const text = typeof detection.rawValue === 'string'
      ? detection.rawValue.trim().slice(0, 100_000)
      : '';
    const polygon = normalizePolygon(
      detection.cornerPoints,
      bitmapWidth,
      bitmapHeight,
    );
    if (text && transcriptLength < MAX_CHROME_TEXT_TRANSCRIPT_LENGTH) {
      const separatorLength = transcriptParts.length === 0 ? 0 : 1;
      const remaining = MAX_CHROME_TEXT_TRANSCRIPT_LENGTH -
        transcriptLength - separatorLength;
      const part = text.slice(0, remaining);
      transcriptParts.push(part);
      transcriptLength += separatorLength + part.length;
    }
    regions.push({
      text,
      boundingBox,
      ...(polygon ? { polygon } : {}),
    });
  }
  return readImageTextResult({
    providerId: 'chrome-text-detector',
    bitmapWidth,
    bitmapHeight,
    transcript: transcriptParts.join('\n'),
    regions,
  });
}

function normalizeBoundingBox(
  value: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageBoundingBox | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return undefined;
  }
  const x0 = clamp(Math.floor(x), 0, bitmapWidth);
  const y0 = clamp(Math.floor(y), 0, bitmapHeight);
  const x1 = clamp(
    Math.ceil(x + width),
    0,
    bitmapWidth,
  );
  const y1 = clamp(
    Math.ceil(y + height),
    0,
    bitmapHeight,
  );
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function normalizePolygon(
  value: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): readonly ImagePoint[] | undefined {
  if (!Array.isArray(value) || value.length < 3 || value.length > 16) {
    return undefined;
  }
  const points: ImagePoint[] = [];
  for (const point of value) {
    if (!isRecord(point)) return undefined;
    const { x, y } = point;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      return undefined;
    }
    points.push({
      x: clamp(x, 0, bitmapWidth),
      y: clamp(y, 0, bitmapHeight),
    });
  }
  return points;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
