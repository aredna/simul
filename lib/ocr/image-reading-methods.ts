import {
  IMAGE_TEXT_PROVIDER_IDS,
  isImageTextProviderId,
  type ImageTextProviderId,
} from './known-provider-ids';

export const ACCESSIBILITY_TEXT_METHOD_ID = 'accessibility-text' as const;
export const IMAGE_READING_METHOD_IDS = Object.freeze([
  ACCESSIBILITY_TEXT_METHOD_ID,
  ...IMAGE_TEXT_PROVIDER_IDS,
] as const);

export type ImageReadingMethodId =
  | typeof ACCESSIBILITY_TEXT_METHOD_ID
  | ImageTextProviderId;

export type ImageReadingExecutionStep =
  | Readonly<{ readonly kind: 'accessibility-text' }>
  | Readonly<{
      readonly kind: 'ocr';
      readonly providerOrder: readonly ImageTextProviderId[];
    }>;

const METHOD_SET = new Set<string>(IMAGE_READING_METHOD_IDS);

export function isImageReadingMethodId(
  value: unknown,
): value is ImageReadingMethodId {
  return typeof value === 'string' && METHOD_SET.has(value);
}

export function isOcrImageReadingMethod(
  value: ImageReadingMethodId,
): value is ImageTextProviderId {
  return isImageTextProviderId(value);
}

/**
 * Repairs old OCR-only orders by prepending accessibility text while retaining
 * provider-relative order. Unknown and duplicate IDs never survive.
 */
export function repairImageReadingMethodOrder(
  input: unknown,
  legacyProviderOrder?: readonly ImageTextProviderId[],
): ImageReadingMethodId[] {
  const result: ImageReadingMethodId[] = [];
  const seen = new Set<ImageReadingMethodId>();
  const source = Array.isArray(input)
    ? input
    : [ACCESSIBILITY_TEXT_METHOD_ID, ...(legacyProviderOrder ?? [])];
  for (const value of source) {
    if (!isImageReadingMethodId(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  if (!seen.has(ACCESSIBILITY_TEXT_METHOD_ID)) {
    result.unshift(ACCESSIBILITY_TEXT_METHOD_ID);
    seen.add(ACCESSIBILITY_TEXT_METHOD_ID);
  }
  for (const id of IMAGE_TEXT_PROVIDER_IDS) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

export function readExactImageReadingMethodOrder(
  input: unknown,
): ImageReadingMethodId[] | undefined {
  if (!Array.isArray(input) || input.length !== IMAGE_READING_METHOD_IDS.length) {
    return undefined;
  }
  const result: ImageReadingMethodId[] = [];
  const seen = new Set<ImageReadingMethodId>();
  for (const value of input) {
    if (!isImageReadingMethodId(value) || seen.has(value)) return undefined;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function repairDisabledImageReadingMethodIds(
  input: unknown,
): ImageReadingMethodId[] {
  if (!Array.isArray(input)) return [];
  const result: ImageReadingMethodId[] = [];
  const seen = new Set<ImageReadingMethodId>();
  for (const value of input) {
    if (!isImageReadingMethodId(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function readExactDisabledImageReadingMethodIds(
  input: unknown,
): ImageReadingMethodId[] | undefined {
  if (!Array.isArray(input) || input.length > IMAGE_READING_METHOD_IDS.length) {
    return undefined;
  }
  const repaired = repairDisabledImageReadingMethodIds(input);
  return repaired.length === input.length ? repaired : undefined;
}

export function enabledOcrProviderOrder(
  order: readonly ImageReadingMethodId[],
  disabled: readonly ImageReadingMethodId[],
): ImageTextProviderId[] {
  const disabledSet = new Set(disabled);
  return order.filter(
    (id): id is ImageTextProviderId =>
      isOcrImageReadingMethod(id) && !disabledSet.has(id),
  );
}

/** Keep the built-in semantic method visible even when no pixel OCR is built. */
export function visibleImageReadingMethodOrder(
  order: readonly ImageReadingMethodId[],
  compiledProviders: readonly ImageTextProviderId[],
): ImageReadingMethodId[] {
  const compiled = new Set(compiledProviders);
  return order.filter((id) =>
    id === ACCESSIBILITY_TEXT_METHOD_ID ||
    (isOcrImageReadingMethod(id) && compiled.has(id)));
}

/**
 * Preserve the user's exact method order while allowing adjacent OCR runtimes
 * to share geometry and corroboration evidence. An enabled accessibility-text
 * method is a semantic boundary; disabled methods are removed before enabled
 * contiguity is determined.
 */
export function imageReadingExecutionPlan(
  order: readonly ImageReadingMethodId[],
  disabled: readonly ImageReadingMethodId[],
  availableProviders: readonly ImageTextProviderId[],
): readonly ImageReadingExecutionStep[] {
  const disabledSet = new Set(disabled);
  const availableSet = new Set(availableProviders);
  const steps: ImageReadingExecutionStep[] = [];
  let ocrGroup: ImageTextProviderId[] = [];
  const flushOcrGroup = (): void => {
    if (ocrGroup.length === 0) return;
    steps.push(Object.freeze({
      kind: 'ocr',
      providerOrder: Object.freeze(ocrGroup),
    }));
    ocrGroup = [];
  };
  for (const method of order) {
    if (disabledSet.has(method)) continue;
    if (method === ACCESSIBILITY_TEXT_METHOD_ID) {
      flushOcrGroup();
      steps.push(Object.freeze({ kind: 'accessibility-text' }));
      continue;
    }
    if (availableSet.has(method)) {
      ocrGroup.push(method);
    }
  }
  flushOcrGroup();
  return Object.freeze(steps);
}
