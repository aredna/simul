import type { SupportedLanguage } from './translation-provider';

export type CompanionStatusTone = 'normal' | 'success' | 'warning' | 'error';
export type ToolbarAttentionTarget = 'refresh' | 'settings';

export interface UiLabelLocalizationResult {
  readonly localized: boolean;
  readonly labels: ReadonlyMap<string, string>;
}

/**
 * Permit one retry for an exact non-English label set. The caller retains the
 * returned key after scheduling so a persistently unavailable translator does
 * not create an idle retry loop.
 */
export function shouldRetryUiLabelLocalization(
  inputKey: string,
  retriedInputKey: string,
  targetLanguage: SupportedLanguage,
  result: UiLabelLocalizationResult,
): boolean {
  return targetLanguage !== 'en' && !result.localized &&
    inputKey !== retriedInputKey;
}

const REFRESH_ATTENTION_PATTERN =
  /\b(?:rebuild|refresh|mirror|replica|capture|source (?:page|tab)|page (?:is )?changing|live update|desynchron|missed)\b/iu;

/**
 * Warning and error state belongs to the action that can resolve it. Healthy
 * state deliberately has no marker, so the toolbar does not show an ambient
 * green status light.
 */
export function toolbarAttentionTarget(
  message: string,
  tone: CompanionStatusTone,
): ToolbarAttentionTarget | undefined {
  if (tone !== 'warning' && tone !== 'error') return undefined;
  return REFRESH_ATTENTION_PATTERN.test(message) ? 'refresh' : 'settings';
}

/**
 * Resolve one atomic UI-label set. Exact duplicate English labels are loaded
 * once. Any unavailable/failed/empty translation returns the complete English
 * set, never a partially localized interface.
 */
export async function resolveUiLabelTranslations(
  sources: readonly string[],
  targetLanguage: SupportedLanguage,
  translate: (source: string) => Promise<string>,
): Promise<UiLabelLocalizationResult> {
  const english = new Map<string, string>();
  for (const source of sources) {
    if (source.length > 0) english.set(source, source);
  }
  if (targetLanguage === 'en') {
    return { localized: false, labels: english };
  }

  const localized = new Map<string, string>();
  try {
    for (const source of english.keys()) {
      const translated = await translate(source);
      if (!translated.trim()) return { localized: false, labels: english };
      localized.set(source, repairTranslatedFrame(source, translated.trim()));
    }
    return { localized: true, labels: localized };
  } catch {
    return { localized: false, labels: english };
  }
}

const FRAME_PLACEHOLDER = /\{(\d+)\}/gu;
// Machine translation sometimes spaces the braces or makes them full-width.
const LOOSE_FRAME_PLACEHOLDER = /[{\uFF5B]\s*([0-9\uFF10-\uFF19]+)\s*[}\uFF5D]/gu;

/**
 * A translated template frame must keep exactly the English frame's numbered
 * placeholders, or the values could not be filled in. Loosely written ones
 * are normalized; if the set still differs, that label stays English
 * (review L6).
 */
export function repairTranslatedFrame(source: string, translated: string): string {
  const expected = framePlaceholderSignature(source);
  if (!expected) return translated;
  const repaired = translated.replace(
    LOOSE_FRAME_PLACEHOLDER,
    (_match, digits: string) => `{${Number(digits.replace(
      /[\uFF10-\uFF19]/gu,
      (digit) => String(digit.charCodeAt(0) - 0xff10),
    ))}}`,
  );
  return framePlaceholderSignature(repaired) === expected ? repaired : source;
}

function framePlaceholderSignature(text: string): string {
  return [...text.matchAll(FRAME_PLACEHOLDER)]
    .map((match) => match[1])
    .sort()
    .join(',');
}
