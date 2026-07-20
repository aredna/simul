import {
  readImageTextResult,
  type ImageBoundingBox,
  type ImagePoint,
  type ImageTextRegion,
  type ImageTextResult,
} from '../../contracts';

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
  const transcript: string[] = [];
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
    if (text) transcript.push(text);
    regions.push(Object.freeze({
      text,
      boundingBox,
      ...(polygon ? { polygon } : {}),
    }));
  }
  return readImageTextResult({
    providerId: 'chrome-text-detector',
    bitmapWidth,
    bitmapHeight,
    transcript: transcript.join('\n').slice(0, 1_000_000),
    regions,
  });
}

function normalizeBoundingBox(
  value: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageBoundingBox | undefined {
  if (!isRecord(value)) return undefined;
  if (![value.x, value.y, value.width, value.height].every(isFiniteNumber)) {
    return undefined;
  }
  const x0 = clamp(Math.floor(Number(value.x)), 0, bitmapWidth);
  const y0 = clamp(Math.floor(Number(value.y)), 0, bitmapHeight);
  const x1 = clamp(
    Math.ceil(Number(value.x) + Number(value.width)),
    0,
    bitmapWidth,
  );
  const y1 = clamp(
    Math.ceil(Number(value.y) + Number(value.height)),
    0,
    bitmapHeight,
  );
  if (x1 <= x0 || y1 <= y0) return undefined;
  return Object.freeze({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
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
    if (!isRecord(point) || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
      return undefined;
    }
    points.push(Object.freeze({
      x: clamp(Number(point.x), 0, bitmapWidth),
      y: clamp(Number(point.y), 0, bitmapHeight),
    }));
  }
  return Object.freeze(points);
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
