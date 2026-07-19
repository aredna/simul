import type { PageSnapshot } from './page-snapshot';
import type { SourceLanguagePreference } from './preferences';
import {
  canonicalizeLanguageTag,
  type SupportedLanguage,
} from './translation-provider';

export interface DetectedLanguageCandidate {
  language: string;
  percentage: number;
}

export interface LanguageDetectionResult {
  language?: SupportedLanguage;
  source: 'manual' | 'html' | 'content' | 'unknown';
}

export async function resolveSourceLanguage(
  preference: SourceLanguagePreference,
  snapshot: PageSnapshot,
  detectLanguage?: (
    text: string,
  ) => Promise<{ isReliable: boolean; languages: DetectedLanguageCandidate[] }>,
  additionalVisibleText = '',
): Promise<LanguageDetectionResult> {
  if (preference !== 'auto') {
    return { language: preference, source: 'manual' };
  }

  const fromHtml = canonicalizeLanguageTag(snapshot.documentLanguage);
  if (fromHtml) return { language: fromHtml, source: 'html' };
  if (!detectLanguage) return { source: 'unknown' };

  const sample = snapshot.items
    .flatMap((item) =>
      item.kind === 'text'
        ? [item.text]
        : [item.altText, item.caption].filter(
            (value): value is string => Boolean(value),
          ),
    )
    .concat(additionalVisibleText)
    .join(' ')
    .slice(0, 20_000);
  if (sample.length < 20) return { source: 'unknown' };

  try {
    const detected = await detectLanguage(sample);
    const candidate = [...detected.languages]
      .sort((left, right) => right.percentage - left.percentage)
      .find(
        (entry) =>
          entry.percentage >= 55 &&
          canonicalizeLanguageTag(entry.language) !== undefined,
      );
    const language = candidate
      ? canonicalizeLanguageTag(candidate.language)
      : undefined;
    return detected.isReliable && language
      ? { language, source: 'content' }
      : { source: 'unknown' };
  } catch {
    return { source: 'unknown' };
  }
}
