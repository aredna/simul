export const IMAGE_TEXT_PROVIDER_IDS = Object.freeze([
  'chrome-text-detector',
  'tesseract',
  'transformers',
  'paddleocr-wasm',
  'chromium-screen-ai',
] as const);

export type ImageTextProviderId = (typeof IMAGE_TEXT_PROVIDER_IDS)[number];

const PROVIDER_ID_SET = new Set<string>(IMAGE_TEXT_PROVIDER_IDS);

export function isImageTextProviderId(
  value: unknown,
): value is ImageTextProviderId {
  return typeof value === 'string' && PROVIDER_ID_SET.has(value);
}

/** Repair persisted data into a fresh complete canonical permutation. */
export function repairImageTextProviderOrder(
  input: unknown,
): ImageTextProviderId[] {
  const result: ImageTextProviderId[] = [];
  const seen = new Set<ImageTextProviderId>();
  if (Array.isArray(input)) {
    for (const value of input) {
      if (!isImageTextProviderId(value) || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
  }
  for (const id of IMAGE_TEXT_PROVIDER_IDS) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}

/** Strict command-boundary parser: repair is reserved for persisted storage. */
export function readExactImageTextProviderOrder(
  input: unknown,
): ImageTextProviderId[] | undefined {
  if (
    !Array.isArray(input) ||
    input.length !== IMAGE_TEXT_PROVIDER_IDS.length
  ) return undefined;
  const result: ImageTextProviderId[] = [];
  const seen = new Set<ImageTextProviderId>();
  for (const value of input) {
    if (!isImageTextProviderId(value) || seen.has(value)) return undefined;
    seen.add(value);
    result.push(value);
  }
  return result;
}
