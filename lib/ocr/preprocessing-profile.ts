import { MAX_OCR_BITMAP_DIMENSION } from './contracts';

export const OCR_NATIVE_PREPROCESSING_VERSION = 'visible-crop-v2-native';
export const OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION =
  'visible-crop-v2-shallow-banner-native';
export const OCR_SHALLOW_BANNER_PREPROCESSING_VERSION =
  'visible-crop-v2-shallow-banner-2x';
export const OCR_DOWNSCALED_PREPROCESSING_VERSION =
  'visible-crop-v2-downscaled-4mp';
export const OCR_SHALLOW_BANNER_DOWNSCALED_PREPROCESSING_VERSION =
  'visible-crop-v2-shallow-banner-downscaled-4mp';

export const OCR_PREPROCESSING_VERSIONS = Object.freeze([
  OCR_NATIVE_PREPROCESSING_VERSION,
  OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION,
  OCR_SHALLOW_BANNER_PREPROCESSING_VERSION,
  OCR_DOWNSCALED_PREPROCESSING_VERSION,
  OCR_SHALLOW_BANNER_DOWNSCALED_PREPROCESSING_VERSION,
] as const);

export type OcrPreprocessingVersion =
  (typeof OCR_PREPROCESSING_VERSIONS)[number];

export const SHALLOW_BANNER_MIN_WIDTH_PX = 96;
export const SHALLOW_BANNER_MAX_HEIGHT_PX = 48;
export const SHALLOW_BANNER_MIN_ASPECT_RATIO = 4;
export const SHALLOW_BANNER_UPSCALE = 2;

export interface OcrPreprocessingPlan {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly version: OcrPreprocessingVersion;
}

/**
 * Classify shallow horizontal crops from CSS geometry so device pixel ratio
 * cannot change OCR mode. Give low-resolution banner captures more pixels,
 * while never exceeding the caller's pixel budget or protocol axis bound.
 */
export function selectOcrPreprocessingPlan(
  width: number,
  height: number,
  maxPixels: number,
  cssWidth = width,
  cssHeight = height,
): OcrPreprocessingPlan | undefined {
  if (
    !isPositiveSafeInteger(width) ||
    !isPositiveSafeInteger(height) ||
    !isPositiveSafeInteger(maxPixels)
  ) return undefined;
  const shallowBanner = isShallowBannerGeometry(cssWidth, cssHeight);
  const bounded = fitWithinOcrLimits(width, height, maxPixels);
  if (!bounded) return undefined;
  if (bounded.width !== width || bounded.height !== height) {
    return Object.freeze({
      ...bounded,
      scale: bounded.width / width,
      version: shallowBanner
        ? OCR_SHALLOW_BANNER_DOWNSCALED_PREPROCESSING_VERSION
        : OCR_DOWNSCALED_PREPROCESSING_VERSION,
    });
  }
  const native = Object.freeze({
    width,
    height,
    scale: 1 as const,
    version: shallowBanner
      ? OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION
      : OCR_NATIVE_PREPROCESSING_VERSION,
  });
  if (
    !shallowBanner ||
    width < SHALLOW_BANNER_MIN_WIDTH_PX ||
    height > SHALLOW_BANNER_MAX_HEIGHT_PX ||
    width / height < SHALLOW_BANNER_MIN_ASPECT_RATIO
  ) return native;

  const scaledWidth = width * SHALLOW_BANNER_UPSCALE;
  const scaledHeight = height * SHALLOW_BANNER_UPSCALE;
  if (
    scaledWidth > MAX_OCR_BITMAP_DIMENSION ||
    scaledHeight > MAX_OCR_BITMAP_DIMENSION ||
    scaledWidth * scaledHeight > maxPixels
  ) return native;

  return Object.freeze({
    width: scaledWidth,
    height: scaledHeight,
    scale: SHALLOW_BANNER_UPSCALE,
    version: OCR_SHALLOW_BANNER_PREPROCESSING_VERSION,
  });
}

function fitWithinOcrLimits(
  width: number,
  height: number,
  maxPixels: number,
): { readonly width: number; readonly height: number } | undefined {
  const area = width * height;
  if (!Number.isSafeInteger(area) || area < 1) return undefined;
  const factor = Math.min(
    1,
    MAX_OCR_BITMAP_DIMENSION / width,
    MAX_OCR_BITMAP_DIMENSION / height,
    Math.sqrt(maxPixels / area),
  );
  if (!Number.isFinite(factor) || factor <= 0) return undefined;
  let outputWidth = Math.max(1, Math.floor(width * factor));
  let outputHeight = Math.max(1, Math.floor(height * factor));
  while (outputWidth * outputHeight > maxPixels) {
    if (outputWidth >= outputHeight) outputWidth -= 1;
    else outputHeight -= 1;
  }
  return outputWidth <= MAX_OCR_BITMAP_DIMENSION &&
      outputHeight <= MAX_OCR_BITMAP_DIMENSION
    ? Object.freeze({ width: outputWidth, height: outputHeight })
    : undefined;
}

/** Use banner segmentation only when the acquisition profile classified it. */
export function isTesseractBannerPreprocessingVersion(
  value: OcrPreprocessingVersion,
): boolean {
  return value === OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION ||
    value === OCR_SHALLOW_BANNER_PREPROCESSING_VERSION ||
    value === OCR_SHALLOW_BANNER_DOWNSCALED_PREPROCESSING_VERSION;
}

export function readOcrPreprocessingVersion(
  value: unknown,
): OcrPreprocessingVersion | undefined {
  return OCR_PREPROCESSING_VERSIONS.includes(
    value as OcrPreprocessingVersion,
  )
    ? value as OcrPreprocessingVersion
    : undefined;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isShallowBannerGeometry(width: number, height: number): boolean {
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= SHALLOW_BANNER_MIN_WIDTH_PX &&
    height > 0 &&
    height <= SHALLOW_BANNER_MAX_HEIGHT_PX &&
    width / height >= SHALLOW_BANNER_MIN_ASPECT_RATIO;
}
