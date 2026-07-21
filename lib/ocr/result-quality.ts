import type {
  ImageTextRegion,
  ImageTextResult,
} from './contracts';

/** Reject only very-low-confidence provider output; missing confidence is valid. */
export const MIN_OCR_REGION_CONFIDENCE = 0.25;

export interface ImageTextQualitySummary {
  readonly candidateRegions: number;
  readonly acceptedRegions: number;
  readonly rejectedBlankRegions: number;
  readonly rejectedPunctuationRegions: number;
  readonly rejectedLowConfidenceRegions: number;
}

export interface FilteredImageTextResult {
  readonly result: ImageTextResult;
  readonly hasAcceptedText: boolean;
  readonly quality: ImageTextQualitySummary;
}

const MEANINGFUL_TEXT_PATTERN = /[\p{L}\p{N}]/u;

/**
 * Apply provider-neutral, deliberately conservative OCR noise filtering.
 * Geometry is retained only for accepted text in the returned result; callers
 * may still use the original provider regions as fallthrough geometry hints.
 */
export function filterImageTextResult(
  result: ImageTextResult,
): FilteredImageTextResult {
  const accepted: ImageTextRegion[] = [];
  let rejectedBlankRegions = 0;
  let rejectedPunctuationRegions = 0;
  let rejectedLowConfidenceRegions = 0;

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
    accepted.push(Object.freeze({
      ...region,
      text,
    }));
  }

  const quality = Object.freeze({
    candidateRegions: result.regions.length,
    acceptedRegions: accepted.length,
    rejectedBlankRegions,
    rejectedPunctuationRegions,
    rejectedLowConfidenceRegions,
  });
  const regions = Object.freeze(accepted);
  return Object.freeze({
    result: Object.freeze({
      ...result,
      transcript: accepted.map(({ text }) => text).join('\n').slice(0, 1_000_000),
      regions,
    }),
    hasAcceptedText: accepted.length > 0,
    quality,
  });
}

export function mergeImageTextQualitySummaries(
  left: ImageTextQualitySummary,
  right: ImageTextQualitySummary,
): ImageTextQualitySummary {
  return Object.freeze({
    candidateRegions: left.candidateRegions + right.candidateRegions,
    acceptedRegions: left.acceptedRegions + right.acceptedRegions,
    rejectedBlankRegions:
      left.rejectedBlankRegions + right.rejectedBlankRegions,
    rejectedPunctuationRegions:
      left.rejectedPunctuationRegions + right.rejectedPunctuationRegions,
    rejectedLowConfidenceRegions:
      left.rejectedLowConfidenceRegions + right.rejectedLowConfidenceRegions,
  });
}

export function emptyImageTextQualitySummary(): ImageTextQualitySummary {
  return Object.freeze({
    candidateRegions: 0,
    acceptedRegions: 0,
    rejectedBlankRegions: 0,
    rejectedPunctuationRegions: 0,
    rejectedLowConfidenceRegions: 0,
  });
}
