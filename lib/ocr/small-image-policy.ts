import {
  isValidImageDimensions,
  type ImageDimensions,
} from './contracts';

export type SmallImageDecisionReason =
  | 'invalid-dimensions'
  | 'manual-override'
  | 'filter-disabled'
  | 'zero-area'
  | 'tracking-pixel'
  | 'small-rendered'
  | 'small-intrinsic'
  | 'eligible';

export interface SmallImageDecision {
  readonly eligible: boolean;
  readonly reason: SmallImageDecisionReason;
}

export function decideSmallImageEligibility(
  dimensions: ImageDimensions,
  options: {
    readonly skipSmallImages: boolean;
    readonly manualOverride?: boolean;
  },
): SmallImageDecision {
  if (!isValidImageDimensions(dimensions)) {
    return { eligible: false, reason: 'invalid-dimensions' };
  }
  if (options.manualOverride === true) {
    return { eligible: true, reason: 'manual-override' };
  }
  if (dimensions.renderedWidth === 0 || dimensions.renderedHeight === 0) {
    return { eligible: false, reason: 'zero-area' };
  }
  if (
    dimensions.renderedWidth <= 1 &&
    dimensions.renderedHeight <= 1
  ) {
    return { eligible: false, reason: 'tracking-pixel' };
  }
  if (!options.skipSmallImages) {
    return { eligible: true, reason: 'filter-disabled' };
  }
  const area = dimensions.renderedWidth * dimensions.renderedHeight;
  const longest = Math.max(
    dimensions.renderedWidth,
    dimensions.renderedHeight,
  );
  if (area < 1_600 && longest < 96) {
    return { eligible: false, reason: 'small-rendered' };
  }
  if (
    dimensions.intrinsicWidth !== undefined &&
    dimensions.intrinsicHeight !== undefined &&
    dimensions.intrinsicWidth < 32 &&
    dimensions.intrinsicHeight < 32
  ) {
    return { eligible: false, reason: 'small-intrinsic' };
  }
  return { eligible: true, reason: 'eligible' };
}
