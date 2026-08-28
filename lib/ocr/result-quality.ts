import type {
  ImageBoundingBox,
  ImageTextRegion,
  ImageTextResult,
} from './contracts';

export const MIN_OCR_REGION_CONFIDENCE = 0.25;
export const DEFAULT_OCR_MINIMUM_CONFIDENCE = 0.65;
export const OCR_QUALITY_POLICY_VERSION = 'precision-v1';
export const OCR_MINIMUM_CONFIDENCE_OPTIONS = Object.freeze([
  0.25,
  0.3,
  0.35,
  0.4,
  0.45,
  0.5,
  0.55,
  0.6,
  0.65,
  0.7,
  0.75,
  0.8,
  0.85,
  0.9,
  0.95,
] as const);

export type OcrMinimumConfidence =
  (typeof OCR_MINIMUM_CONFIDENCE_OPTIONS)[number];

export interface ImageTextQualityPolicy {
  readonly minimumConfidence: OcrMinimumConfidence;
  readonly corroboratingResults?: readonly ImageTextResult[];
}

export interface ImageTextQualitySummary {
  readonly candidateRegions: number;
  readonly acceptedRegions: number;
  readonly corroboratedRegions: number;
  readonly uncertainRegions: number;
  readonly rejectedBlankRegions: number;
  readonly rejectedPunctuationRegions: number;
  readonly rejectedLowConfidenceRegions: number;
  readonly rejectedUncorroboratedRegions: number;
}

export interface FilteredImageTextResult {
  readonly result: ImageTextResult;
  readonly hasAcceptedText: boolean;
  readonly quality: ImageTextQualitySummary;
}

const MEANINGFUL_TEXT_PATTERN = /[\p{L}\p{N}]/u;
const CORROBORATION_IOU_THRESHOLD = 0.5;
const MAX_FILTERED_TRANSCRIPT_LENGTH = 1_000_000;

/**
 * Accept authoritative scored text and independently corroborated uncertain
 * text. Confidence-free or weak output can never become authoritative alone.
 */
export function filterImageTextResult(
  result: ImageTextResult,
  policy: ImageTextQualityPolicy = {
    minimumConfidence: DEFAULT_OCR_MINIMUM_CONFIDENCE,
  },
): FilteredImageTextResult {
  const minimumConfidence = isOcrMinimumConfidence(policy.minimumConfidence)
    ? policy.minimumConfidence
    : DEFAULT_OCR_MINIMUM_CONFIDENCE;
  const accepted: ImageTextRegion[] = [];
  let corroboratedRegions = 0;
  let uncertainRegions = 0;
  let rejectedBlankRegions = 0;
  let rejectedPunctuationRegions = 0;
  let rejectedLowConfidenceRegions = 0;
  let rejectedUncorroboratedRegions = 0;
  let corroborationIndex: ReadonlyMap<
    string,
    readonly ImageTextRegion[]
  > | undefined;

  for (const region of result.regions) {
    const text = region.text.trim();
    if (!text) {
      rejectedBlankRegions += 1;
      continue;
    }
    if (!MEANINGFUL_TEXT_PATTERN.test(text)) {
      rejectedPunctuationRegions += 1;
      continue;
    }
    if (
      typeof region.confidence === 'number' &&
      region.confidence < MIN_OCR_REGION_CONFIDENCE
    ) {
      rejectedLowConfidenceRegions += 1;
      continue;
    }
    if (
      typeof region.confidence === 'number' &&
      region.confidence >= minimumConfidence
    ) {
      accepted.push(Object.freeze({ ...region, text }));
      continue;
    }

    uncertainRegions += 1;
    corroborationIndex ??= indexCorroboratingRegions(
      result.providerId,
      policy.corroboratingResults,
    );
    if (isCorroborated(region, corroborationIndex)) {
      corroboratedRegions += 1;
      accepted.push(Object.freeze({ ...region, text }));
    } else {
      rejectedUncorroboratedRegions += 1;
    }
  }

  const quality = Object.freeze({
    candidateRegions: result.regions.length,
    acceptedRegions: accepted.length,
    corroboratedRegions,
    uncertainRegions,
    rejectedBlankRegions,
    rejectedPunctuationRegions,
    rejectedLowConfidenceRegions,
    rejectedUncorroboratedRegions,
  });
  const regions = Object.freeze(accepted);
  const transcriptConfidence = acceptedRegionConfidence(accepted);
  return Object.freeze({
    result: Object.freeze({
      providerId: result.providerId,
      bitmapWidth: result.bitmapWidth,
      bitmapHeight: result.bitmapHeight,
      transcript: boundedRegionTranscript(accepted),
      ...(transcriptConfidence !== undefined ? { transcriptConfidence } : {}),
      ...(result.geometryConfidence !== undefined
        ? { geometryConfidence: result.geometryConfidence }
        : {}),
      regions,
    }),
    hasAcceptedText: accepted.length > 0,
    quality,
  });
}

export function isOcrMinimumConfidence(
  value: unknown,
): value is OcrMinimumConfidence {
  return typeof value === 'number' &&
    OCR_MINIMUM_CONFIDENCE_OPTIONS.includes(value as OcrMinimumConfidence);
}

export function repairOcrMinimumConfidence(
  value: unknown,
): OcrMinimumConfidence {
  return isOcrMinimumConfidence(value)
    ? value
    : DEFAULT_OCR_MINIMUM_CONFIDENCE;
}

export function ocrQualityPolicyKey(
  minimumConfidence: OcrMinimumConfidence,
): string {
  return `${OCR_QUALITY_POLICY_VERSION}:${minimumConfidence.toFixed(2)}`;
}

export function mergeImageTextQualitySummaries(
  left: ImageTextQualitySummary,
  right: ImageTextQualitySummary,
): ImageTextQualitySummary {
  return Object.freeze({
    candidateRegions: left.candidateRegions + right.candidateRegions,
    acceptedRegions: left.acceptedRegions + right.acceptedRegions,
    corroboratedRegions: left.corroboratedRegions + right.corroboratedRegions,
    uncertainRegions: left.uncertainRegions + right.uncertainRegions,
    rejectedBlankRegions:
      left.rejectedBlankRegions + right.rejectedBlankRegions,
    rejectedPunctuationRegions:
      left.rejectedPunctuationRegions + right.rejectedPunctuationRegions,
    rejectedLowConfidenceRegions:
      left.rejectedLowConfidenceRegions + right.rejectedLowConfidenceRegions,
    rejectedUncorroboratedRegions:
      left.rejectedUncorroboratedRegions + right.rejectedUncorroboratedRegions,
  });
}

export function emptyImageTextQualitySummary(): ImageTextQualitySummary {
  return Object.freeze({
    candidateRegions: 0,
    acceptedRegions: 0,
    corroboratedRegions: 0,
    uncertainRegions: 0,
    rejectedBlankRegions: 0,
    rejectedPunctuationRegions: 0,
    rejectedLowConfidenceRegions: 0,
    rejectedUncorroboratedRegions: 0,
  });
}

function indexCorroboratingRegions(
  providerId: ImageTextResult['providerId'],
  results: readonly ImageTextResult[] | undefined,
): ReadonlyMap<string, readonly ImageTextRegion[]> {
  const index = new Map<string, ImageTextRegion[]>();
  if (!results) return index;
  const primaryFamily = imageTextProviderFamily(providerId);
  for (const result of results) {
    if (imageTextProviderFamily(result.providerId) === primaryFamily) continue;
    for (const candidate of result.regions) {
      if (
        candidate.confidence !== undefined &&
        candidate.confidence < MIN_OCR_REGION_CONFIDENCE
      ) continue;
      const normalized = normalizeCorroborationText(candidate.text);
      if (!normalized) continue;
      const matching = index.get(normalized);
      if (matching) matching.push(candidate);
      else index.set(normalized, [candidate]);
    }
  }
  return index;
}

function isCorroborated(
  region: ImageTextRegion,
  index: ReadonlyMap<string, readonly ImageTextRegion[]>,
): boolean {
  const normalized = normalizeCorroborationText(region.text);
  if (!normalized) return false;
  return index.get(normalized)?.some((candidate) =>
    boundingBoxIou(region.boundingBox, candidate.boundingBox) >=
      CORROBORATION_IOU_THRESHOLD
  ) ?? false;
}

export function imageTextProviderFamily(
  providerId: ImageTextResult['providerId'],
): ImageTextResult['providerId'] {
  return providerId;
}

function acceptedRegionConfidence(
  regions: readonly ImageTextRegion[],
): number | undefined {
  if (regions.length === 0) return undefined;
  let confidenceTotal = 0;
  for (const region of regions) {
    if (
      typeof region.confidence !== 'number' ||
      !Number.isFinite(region.confidence)
    ) return undefined;
    confidenceTotal += region.confidence;
  }
  return confidenceTotal / regions.length;
}

function boundedRegionTranscript(
  regions: readonly ImageTextRegion[],
): string {
  const parts: string[] = [];
  let length = 0;
  for (let index = 0; index < regions.length; index += 1) {
    const text = regions[index]?.text ?? '';
    if (index > 0) {
      if (length >= MAX_FILTERED_TRANSCRIPT_LENGTH) break;
      parts.push('\n');
      length += 1;
    }
    const remaining = MAX_FILTERED_TRANSCRIPT_LENGTH - length;
    if (text.length <= remaining) {
      parts.push(text);
      length += text.length;
      continue;
    }
    parts.push(text.slice(0, remaining));
    break;
  }
  return parts.join('');
}

function normalizeCorroborationText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function boundingBoxIou(
  left: ImageBoundingBox,
  right: ImageBoundingBox,
): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  const intersection = intersectionWidth * intersectionHeight;
  if (intersection <= 0) return 0;
  const union = left.width * left.height + right.width * right.height -
    intersection;
  return union > 0 ? intersection / union : 0;
}
