import type { SupportedLanguage } from './translation-provider';

export type CompanionStatusTone = 'normal' | 'success' | 'warning' | 'error';
export type ToolbarAttentionTarget = 'refresh' | 'settings';

export interface UiLabelLocalizationResult {
  readonly localized: boolean;
  readonly labels: ReadonlyMap<string, string>;
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
  const uniqueSources = [...new Set(sources.filter((source) => source.length > 0))];
  const english = new Map(uniqueSources.map((source) => [source, source]));
  if (targetLanguage === 'en') {
    return { localized: false, labels: english };
  }

  const localized = new Map<string, string>();
  try {
    for (const source of uniqueSources) {
      const translated = await translate(source);
      if (!translated.trim()) return { localized: false, labels: english };
      localized.set(source, translated.trim());
    }
    return { localized: true, labels: localized };
  } catch {
    return { localized: false, labels: english };
  }
}
