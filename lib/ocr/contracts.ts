import {
  readSourceDocumentIdentity,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';
import {
  isImageTextProviderId,
  type ImageTextProviderId,
} from './known-provider-ids';
import { hasExactKeysWithOptional } from '../exact-record';

export const IMAGE_SCAN_POLICIES = Object.freeze([
  'visible-first-background-prescan',
  'visible-only',
  'eager-all',
] as const);

export type ImageScanPolicy = (typeof IMAGE_SCAN_POLICIES)[number];

export const IMAGE_VISIBILITY_TIERS = Object.freeze([
  'visible',
  'near',
  'background',
] as const);

export type ImageVisibilityTier = (typeof IMAGE_VISIBILITY_TIERS)[number];
export type SourceImageKind = 'img';

export interface ImageDimensions {
  readonly renderedWidth: number;
  readonly renderedHeight: number;
  readonly intrinsicWidth?: number;
  readonly intrinsicHeight?: number;
}

/** Safe scheduling fact. It intentionally contains no URL, text, pixels, or hash. */
export interface SourceImageDescriptor extends ImageDimensions {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly sourceKind: SourceImageKind;
  readonly contentRevision: number;
  /**
   * Advances only when the captured crop may have different pixels. Visibility
   * and position-only observations deliberately leave it unchanged.
   */
  readonly captureRevision?: number;
  readonly observationRevision: number;
  readonly visibility: ImageVisibilityTier;
  readonly connected: true;
}

export type SourceImageChange =
  | {
      readonly kind: 'upsert';
      readonly descriptor: SourceImageDescriptor;
    }
  | {
      readonly kind: 'remove';
      readonly document: ReplicaSourceDocumentIdentity;
      readonly nodeId: number;
      readonly contentRevision: number;
      readonly observationRevision: number;
    };

export interface ImagePoint {
  readonly x: number;
  readonly y: number;
}

export interface ImageBoundingBox extends ImagePoint {
  readonly width: number;
  readonly height: number;
}

/** One word of a region's text, with its own box in the bitmap. */
export interface ImageTextWord {
  readonly text: string;
  readonly boundingBox: ImageBoundingBox;
}

export interface ImageTextRegion {
  readonly text: string;
  readonly confidence?: number;
  readonly boundingBox: ImageBoundingBox;
  readonly polygon?: readonly ImagePoint[];
  /**
   * The region's words in reading order, where the job asked for them, the
   * provider reports them and there are at least two (D121). A PDF page asks:
   * it cuts the words its typed text already shows out of a recognised line.
   * Image translation on web pages does not ask and gets none.
   */
  readonly words?: readonly ImageTextWord[];
}

/** A line of more words than this carries none. */
export const MAX_IMAGE_TEXT_REGION_WORDS = 512;
/** Words in one result; past it the remaining regions carry none. */
export const MAX_IMAGE_TEXT_RESULT_WORDS = 50_000;
export const MAX_IMAGE_TEXT_WORD_LENGTH = 1_000;

export interface ImageTextResult {
  readonly providerId: ImageTextProviderId;
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  readonly transcript: string;
  readonly transcriptConfidence?: number;
  readonly geometryConfidence?: number;
  readonly regions: readonly ImageTextRegion[];
}

export const MAX_OCR_BITMAP_DIMENSION = 32_768;
export const MAX_OCR_BITMAP_PIXELS = 64 * 1024 * 1024;

export interface ImageTextProviderDescriptor {
  readonly id: ImageTextProviderId;
  readonly canDetectRegions: boolean;
  readonly canRecognizeText: boolean;
  readonly canReturnGeometry: boolean;
}

export type ImageTextProviderCapability =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable' | 'unsupported'; readonly reason: string };

/** Provider-neutral future seam. E intentionally ships no implementation. */
export interface ImageTextProviderModule {
  readonly descriptor: ImageTextProviderDescriptor;
  probe(request: unknown): Promise<ImageTextProviderCapability>;
  prepare(request: unknown, signal: AbortSignal): Promise<void>;
  recognize(
    input: unknown,
    hints: readonly ImageTextRegion[],
    signal: AbortSignal,
  ): Promise<ImageTextResult>;
  dispose(): Promise<void>;
}

export function isImageScanPolicy(value: unknown): value is ImageScanPolicy {
  return IMAGE_SCAN_POLICIES.includes(value as ImageScanPolicy);
}

export function isImageVisibilityTier(
  value: unknown,
): value is ImageVisibilityTier {
  return IMAGE_VISIBILITY_TIERS.includes(value as ImageVisibilityTier);
}

export function isValidImageDimensions(value: ImageDimensions): boolean {
  if (
    !isFiniteNonNegative(value.renderedWidth) ||
    !isFiniteNonNegative(value.renderedHeight)
  ) return false;
  const hasIntrinsicWidth = value.intrinsicWidth !== undefined;
  const hasIntrinsicHeight = value.intrinsicHeight !== undefined;
  if (hasIntrinsicWidth !== hasIntrinsicHeight) return false;
  return !hasIntrinsicWidth || (
    isFiniteNonNegative(value.intrinsicWidth) &&
    isFiniteNonNegative(value.intrinsicHeight)
  );
}

export function readSourceImageDescriptor(
  input: unknown,
): SourceImageDescriptor | undefined {
  if (!isRecordWithExactKeys(input, [
    'document',
    'nodeId',
    'sourceKind',
    'contentRevision',
    'observationRevision',
    'visibility',
    'connected',
    'renderedWidth',
    'renderedHeight',
  ], ['intrinsicWidth', 'intrinsicHeight', 'captureRevision'])) return undefined;
  const document = readSourceDocumentIdentity(input.document);
  if (
    !document ||
    !isPositiveSafeInteger(input.nodeId) ||
    input.sourceKind !== 'img' ||
    !isPositiveSafeInteger(input.contentRevision) ||
    (Object.hasOwn(input, 'captureRevision') &&
      !isPositiveSafeInteger(input.captureRevision)) ||
    !isPositiveSafeInteger(input.observationRevision) ||
    !isImageVisibilityTier(input.visibility) ||
    input.connected !== true
  ) return undefined;
  const hasIntrinsicWidth = Object.hasOwn(input, 'intrinsicWidth');
  const hasIntrinsicHeight = Object.hasOwn(input, 'intrinsicHeight');
  if (hasIntrinsicWidth !== hasIntrinsicHeight) return undefined;
  const dimensions: ImageDimensions = {
    renderedWidth: input.renderedWidth as number,
    renderedHeight: input.renderedHeight as number,
    ...(hasIntrinsicWidth && hasIntrinsicHeight
      ? {
          intrinsicWidth: input.intrinsicWidth as number,
          intrinsicHeight: input.intrinsicHeight as number,
        }
      : {}),
  };
  if (!isValidImageDimensions(dimensions)) return undefined;
  return Object.freeze({
    document,
    nodeId: input.nodeId,
    sourceKind: 'img',
    contentRevision: input.contentRevision,
    ...(Object.hasOwn(input, 'captureRevision')
      ? { captureRevision: input.captureRevision as number }
      : {}),
    observationRevision: input.observationRevision,
    visibility: input.visibility,
    connected: true,
    renderedWidth: dimensions.renderedWidth,
    renderedHeight: dimensions.renderedHeight,
    ...(dimensions.intrinsicWidth !== undefined &&
    dimensions.intrinsicHeight !== undefined
      ? {
          intrinsicWidth: dimensions.intrinsicWidth,
          intrinsicHeight: dimensions.intrinsicHeight,
        }
      : {}),
  });
}

export function readSourceImageChange(
  input: unknown,
): SourceImageChange | undefined {
  if (!isRecord(input) || typeof input.kind !== 'string') return undefined;
  if (input.kind === 'upsert') {
    if (!isRecordWithExactKeys(input, ['kind', 'descriptor'])) return undefined;
    const descriptor = readSourceImageDescriptor(input.descriptor);
    return descriptor
      ? Object.freeze({ kind: 'upsert', descriptor })
      : undefined;
  }
  if (input.kind !== 'remove' || !isRecordWithExactKeys(input, [
    'kind',
    'document',
    'nodeId',
    'contentRevision',
    'observationRevision',
  ])) return undefined;
  const document = readSourceDocumentIdentity(input.document);
  if (
    !document ||
    !isPositiveSafeInteger(input.nodeId) ||
    !isPositiveSafeInteger(input.contentRevision) ||
    !isPositiveSafeInteger(input.observationRevision)
  ) return undefined;
  return Object.freeze({
    kind: 'remove',
    document,
    nodeId: input.nodeId,
    contentRevision: input.contentRevision,
    observationRevision: input.observationRevision,
  });
}

/**
 * Validate a provider result before it is ever eligible for projection.
 * `wordsAllowed` is whether the job asked for the regions' words: a result
 * that carries words nobody asked for is rejected.
 */
export function readImageTextResult(
  input: unknown,
  wordsAllowed = false,
): ImageTextResult | undefined {
  if (!isRecordWithExactKeys(input, [
    'providerId',
    'bitmapWidth',
    'bitmapHeight',
    'transcript',
    'regions',
  ], ['transcriptConfidence', 'geometryConfidence'])) return undefined;
  if (
    !isImageTextProviderId(input.providerId) ||
    !isBoundedBitmapDimension(input.bitmapWidth) ||
    !isBoundedBitmapDimension(input.bitmapHeight) ||
    input.bitmapWidth * input.bitmapHeight > MAX_OCR_BITMAP_PIXELS ||
    typeof input.transcript !== 'string' ||
    input.transcript.length > 1_000_000 ||
    !isOptionalConfidence(input.transcriptConfidence) ||
    !isOptionalConfidence(input.geometryConfidence) ||
    !Array.isArray(input.regions) ||
    input.regions.length > 10_000
  ) return undefined;
  const regions: ImageTextRegion[] = [];
  let words = 0;
  for (const candidate of input.regions) {
    const region = readRegion(
      candidate,
      input.bitmapWidth,
      input.bitmapHeight,
      wordsAllowed,
    );
    if (!region) return undefined;
    words += region.words?.length ?? 0;
    if (words > MAX_IMAGE_TEXT_RESULT_WORDS) return undefined;
    regions.push(region);
  }
  return Object.freeze({
    providerId: input.providerId,
    bitmapWidth: input.bitmapWidth,
    bitmapHeight: input.bitmapHeight,
    transcript: input.transcript,
    ...(typeof input.transcriptConfidence === 'number'
      ? { transcriptConfidence: input.transcriptConfidence }
      : {}),
    ...(typeof input.geometryConfidence === 'number'
      ? { geometryConfidence: input.geometryConfidence }
      : {}),
    regions: Object.freeze(regions),
  });
}

/** Validate geometry hints crossing the offscreen structured-clone boundary. */
export function readImageTextRegionHints(
  input: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): readonly ImageTextRegion[] | undefined {
  if (!Array.isArray(input) || input.length > 10_000) return undefined;
  const regions: ImageTextRegion[] = [];
  for (const candidate of input) {
    // A hint is geometry only: it never carries words.
    const region = readRegion(candidate, bitmapWidth, bitmapHeight, false);
    if (!region) return undefined;
    regions.push(region);
  }
  return Object.freeze(regions);
}

function readRegion(
  input: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
  wordsAllowed: boolean,
): ImageTextRegion | undefined {
  if (!isRecordWithExactKeys(
    input,
    ['text', 'boundingBox'],
    wordsAllowed ? ['confidence', 'polygon', 'words'] : ['confidence', 'polygon'],
  )) return undefined;
  if (
    typeof input.text !== 'string' ||
    input.text.length > 100_000 ||
    !isOptionalConfidence(input.confidence)
  ) return undefined;
  const boundingBox = readBoundingBox(
    input.boundingBox,
    bitmapWidth,
    bitmapHeight,
  );
  if (!boundingBox) return undefined;
  let polygon: readonly ImagePoint[] | undefined;
  if (input.polygon !== undefined) {
    if (!Array.isArray(input.polygon) || input.polygon.length < 3 || input.polygon.length > 16) {
      return undefined;
    }
    const points: ImagePoint[] = [];
    for (const candidate of input.polygon) {
      const point = readPoint(candidate, bitmapWidth, bitmapHeight);
      if (!point) return undefined;
      points.push(point);
    }
    polygon = Object.freeze(points);
  }
  let words: readonly ImageTextWord[] | undefined;
  if (input.words !== undefined) {
    if (
      !Array.isArray(input.words) ||
      input.words.length < 2 ||
      input.words.length > MAX_IMAGE_TEXT_REGION_WORDS
    ) return undefined;
    const read: ImageTextWord[] = [];
    for (const candidate of input.words) {
      const word = readWord(candidate, bitmapWidth, bitmapHeight);
      if (!word) return undefined;
      read.push(word);
    }
    words = Object.freeze(read);
  }
  return Object.freeze({
    text: input.text,
    ...(typeof input.confidence === 'number'
      ? { confidence: input.confidence }
      : {}),
    boundingBox,
    ...(polygon ? { polygon } : {}),
    ...(words ? { words } : {}),
  });
}

function readWord(
  input: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageTextWord | undefined {
  if (
    !isRecordWithExactKeys(input, ['text', 'boundingBox']) ||
    typeof input.text !== 'string' ||
    input.text.length === 0 ||
    input.text.length > MAX_IMAGE_TEXT_WORD_LENGTH
  ) return undefined;
  const boundingBox = readBoundingBox(
    input.boundingBox,
    bitmapWidth,
    bitmapHeight,
  );
  return boundingBox
    ? Object.freeze({ text: input.text, boundingBox })
    : undefined;
}

function readBoundingBox(
  input: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): ImageBoundingBox | undefined {
  if (!isRecordWithExactKeys(input, ['x', 'y', 'width', 'height'])) return undefined;
  if (
    !isFiniteNonNegative(input.x) ||
    !isFiniteNonNegative(input.y) ||
    !isFiniteNonNegative(input.width) ||
    !isFiniteNonNegative(input.height) ||
    input.x + input.width > bitmapWidth ||
    input.y + input.height > bitmapHeight
  ) return undefined;
  return Object.freeze({
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
  });
}

function readPoint(
  input: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): ImagePoint | undefined {
  if (
    !isRecordWithExactKeys(input, ['x', 'y']) ||
    !isFiniteNonNegative(input.x) ||
    !isFiniteNonNegative(input.y) ||
    input.x > bitmapWidth ||
    input.y > bitmapHeight
  ) return undefined;
  return Object.freeze({ x: input.x, y: input.y });
}

function isOptionalConfidence(value: unknown): boolean {
  return value === undefined || (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isBoundedBitmapDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    Number(value) > 0 &&
    Number(value) <= MAX_OCR_BITMAP_DIMENSION;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordWithExactKeys(
  value: unknown,
  required: readonly string[],
  optional?: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return hasExactKeysWithOptional(value, required, optional);
}
