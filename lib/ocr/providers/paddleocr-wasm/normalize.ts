import {
  readImageTextResult,
  type ImagePoint,
  type ImageTextRegion,
  type ImageTextResult,
} from '../../contracts';

const MAX_PADDLE_OCR_TRANSCRIPT_LENGTH = 1_000_000;
const MIN_PADDLE_OCR_POLYGON_EDGE_LENGTH_PX = 1;
const MIN_PADDLE_OCR_POLYGON_AREA_PX2 = 1;

export function normalizePaddleOcrResult(
  input: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageTextResult | undefined {
  if (!Array.isArray(input) || input.length !== 1) return undefined;
  const result = input[0];
  if (
    !isRecord(result) ||
    !isRecord(result.image) ||
    result.image.width !== bitmapWidth ||
    result.image.height !== bitmapHeight ||
    !Array.isArray(result.items) ||
    result.items.length > 10_000
  ) return undefined;

  const regions: ImageTextRegion[] = [];
  const transcriptParts: string[] = [];
  let transcriptLength = 0;
  let confidenceTotal = 0;
  for (const item of result.items) {
    if (
      !isRecord(item) ||
      typeof item.text !== 'string' ||
      item.text.length > 100_000 ||
      typeof item.score !== 'number' ||
      !Number.isFinite(item.score) ||
      item.score < 0 ||
      item.score > 1 ||
      !Array.isArray(item.poly) ||
      item.poly.length !== 4
    ) return undefined;
    const polygon: ImagePoint[] = [];
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const point of item.poly) {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !isBoundedCoordinate(point[0], bitmapWidth) ||
        !isBoundedCoordinate(point[1], bitmapHeight)
      ) return undefined;
      const x = point[0];
      const y = point[1];
      polygon.push({ x, y });
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (!isMeaningfulConvexQuadrilateral(polygon)) return undefined;
    if (x1 <= x0 || y1 <= y0) return undefined;
    const text = item.text.trim();
    const separatorLength = transcriptParts.length === 0 ? 0 : 1;
    if (
      transcriptLength + separatorLength + text.length >
        MAX_PADDLE_OCR_TRANSCRIPT_LENGTH
    ) return undefined;
    transcriptLength += separatorLength + text.length;
    transcriptParts.push(text);
    confidenceTotal += item.score;
    regions.push({
      text,
      confidence: item.score,
      boundingBox: {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
      },
      polygon,
    });
  }

  return readImageTextResult({
    providerId: 'paddleocr-wasm',
    bitmapWidth,
    bitmapHeight,
    transcript: transcriptParts.join('\n'),
    ...(regions.length > 0
      ? {
          transcriptConfidence: confidenceTotal / regions.length,
          geometryConfidence: 1,
        }
      : {}),
    regions,
  });
}

function isMeaningfulConvexQuadrilateral(
  points: readonly ImagePoint[],
): boolean {
  if (points.length !== 4) return false;
  let orientation = 0;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const after = points[(index + 2) % points.length];
    if (!current || !next || !after) return false;
    const edgeX = next.x - current.x;
    const edgeY = next.y - current.y;
    if (
      edgeX * edgeX + edgeY * edgeY <
        MIN_PADDLE_OCR_POLYGON_EDGE_LENGTH_PX ** 2
    ) return false;
    twiceArea += current.x * next.y - next.x * current.y;
    const cross =
      edgeX * (after.y - next.y) -
      edgeY * (after.x - next.x);
    if (!Number.isFinite(cross) || Math.abs(cross) <= Number.EPSILON) {
      return false;
    }
    const sign = Math.sign(cross);
    if (orientation === 0) orientation = sign;
    else if (sign !== orientation) return false;
  }
  return Math.abs(twiceArea) / 2 >= MIN_PADDLE_OCR_POLYGON_AREA_PX2;
}

function isBoundedCoordinate(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= 0 && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
