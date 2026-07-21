import {
  readImageTextResult,
  type ImageTextResult,
  type ImageTextRegion,
} from '../../contracts';

interface TesseractBbox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface TesseractLine {
  readonly text: string;
  readonly confidence?: unknown;
  readonly bbox: TesseractBbox;
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

export function normalizeTesseractPage(
  page: TesseractPageLike,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageTextResult | undefined {
  const transcript = typeof page.text === 'string'
    ? page.text.slice(0, 1_000_000)
    : '';
  const regions: ImageTextRegion[] = [];
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
        regions.push(Object.freeze({
          text,
          ...(confidence !== undefined ? { confidence } : {}),
          boundingBox,
        }));
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
  return readImageTextResult(candidate);
}

function normalizeBbox(
  bbox: TesseractBbox | undefined,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageTextRegion['boundingBox'] | undefined {
  if (!bbox || ![bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)) {
    return undefined;
  }
  const x0 = clamp(Math.floor(bbox.x0), 0, bitmapWidth);
  const y0 = clamp(Math.floor(bbox.y0), 0, bitmapHeight);
  const x1 = clamp(Math.ceil(bbox.x1), 0, bitmapWidth);
  const y1 = clamp(Math.ceil(bbox.y1), 0, bitmapHeight);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return Object.freeze({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

function normalizeOptionalConfidence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value / 100, 0, 1)
    : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
