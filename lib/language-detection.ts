import type { PageSnapshot } from './page-snapshot';
import type { SourceLanguagePreference } from './preferences';
import {
  canonicalizeLanguageTag,
  type SupportedLanguage,
} from './translation-provider';
import { strongScriptEvidence } from './ocr/auto-language-probe';

const MINIMUM_STRONG_PAGE_SCRIPT_CHARACTERS = 4;
const MINIMUM_STRONG_PAGE_SCRIPT_DOMINANCE = 0.6;

export interface DetectedLanguageCandidate {
  language: string;
  percentage: number;
}

export interface LanguageDetectionResult {
  language?: SupportedLanguage;
  source: 'manual' | 'html' | 'content' | 'unknown';
}

/**
 * Keeps one bounded image-language result behind any already-running page
 * resolution so stronger HTML/visible-text evidence wins regardless of which
 * asynchronous operation completes first.
 */
export class AutoLanguageEvidencePrecedence<T> {
  #activePageRevision: number | undefined;
  #pendingImageEvidence: T | undefined;

  get pageResolutionPending(): boolean {
    return this.#activePageRevision !== undefined;
  }

  beginPageResolution(revision: number): void {
    this.#activePageRevision = revision;
  }

  offerImageEvidence(evidence: T): T | undefined {
    if (this.#activePageRevision !== undefined) {
      this.#pendingImageEvidence = evidence;
      return undefined;
    }
    return evidence;
  }

  settlePageResolution(
    revision: number,
    pageLanguageResolved: boolean,
  ): T | undefined {
    if (this.#activePageRevision !== revision) return undefined;
    this.#activePageRevision = undefined;
    if (pageLanguageResolved) {
      this.#pendingImageEvidence = undefined;
      return undefined;
    }
    const pending = this.#pendingImageEvidence;
    this.#pendingImageEvidence = undefined;
    return pending;
  }

  cancelPageResolution(revision: number): void {
    if (this.#activePageRevision !== revision) return;
    this.invalidate();
  }

  invalidate(): void {
    this.#activePageRevision = undefined;
    this.#pendingImageEvidence = undefined;
  }
}

export type ResolvedSourceLanguageOrigin = 'page' | 'image' | undefined;

export function autoImageLanguageConfigurationKey(
  providerOrder: readonly string[],
  minimumConfidence: number,
): string {
  return JSON.stringify([
    [...providerOrder],
    Number.isFinite(minimumConfidence) ? minimumConfidence : null,
  ]);
}

export function shouldClearAutoImageLanguageResolution(
  origin: ResolvedSourceLanguageOrigin,
  resolvedConfigurationKey: string | undefined,
  nextConfigurationKey: string,
): boolean {
  return origin === 'image' && resolvedConfigurationKey !== nextConfigurationKey;
}

export function shouldClearAutoImageLanguageForDocument(
  origin: ResolvedSourceLanguageOrigin,
  exactDocumentMatches: boolean,
): boolean {
  return origin === 'image' && !exactDocumentMatches;
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
  const script = strongScriptEvidence(sample);
  const meaningfulCharacters = [...sample].filter((character) =>
    /[\p{L}\p{N}]/u.test(character)
  ).length;
  if (
    script &&
    script.characters >= MINIMUM_STRONG_PAGE_SCRIPT_CHARACTERS &&
    script.characters / Math.max(1, meaningfulCharacters) >=
      MINIMUM_STRONG_PAGE_SCRIPT_DOMINANCE
  ) {
    return { language: script.language, source: 'content' };
  }
  if (!detectLanguage) return { source: 'unknown' };
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
