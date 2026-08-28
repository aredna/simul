import type { SourceLanguagePreference } from './preferences';
import {
  canonicalizeLanguageTag,
  type SupportedLanguage,
} from './translation-provider';
import { strongAutoLanguageScriptEvidence } from './ocr/auto-language-probe';

const MINIMUM_STRONG_PAGE_SCRIPT_CHARACTERS = 4;

export interface DetectedLanguageCandidate {
  language: string;
  percentage: number;
}

export interface LanguageDetectionResult {
  language?: SupportedLanguage;
  source: 'manual' | 'html' | 'content' | 'unknown';
}

export interface LanguageDetectionInput {
  readonly documentLanguage?: string;
  readonly visibleText: string;
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

export type ResolvedSourceLanguageOrigin =
  | 'page'
  | 'image'
  | 'explicit'
  | undefined;

export interface AutoImageLanguageConfigurationIdentity {
  /** Effective provider membership; saved priority order is not identity. */
  readonly providerOrder: readonly string[];
  /** Effective method membership; saved priority order is not identity. */
  readonly enabledMethodOrder: readonly string[];
  readonly minimumConfidence: number;
  readonly policyFingerprint: string;
  readonly controlImages: boolean;
}

export function autoImageLanguageConfigurationKey(
  configuration: AutoImageLanguageConfigurationIdentity,
): string {
  return JSON.stringify([
    canonicalMembership(configuration.providerOrder),
    canonicalMembership(configuration.enabledMethodOrder),
    Number.isFinite(configuration.minimumConfidence)
      ? configuration.minimumConfidence
      : null,
    configuration.policyFingerprint,
    configuration.controlImages,
  ]);
}

function canonicalMembership(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
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
  input: LanguageDetectionInput,
  detectLanguage?: (
    text: string,
  ) => Promise<{ isReliable: boolean; languages: DetectedLanguageCandidate[] }>,
): Promise<LanguageDetectionResult> {
  if (preference !== 'auto') {
    return { language: preference, source: 'manual' };
  }

  const fromHtml = canonicalizeLanguageTag(input.documentLanguage);
  if (fromHtml) return { language: fromHtml, source: 'html' };

  const sample = input.visibleText.slice(0, 20_000);
  const script = strongAutoLanguageScriptEvidence(sample);
  if (
    script &&
    script.characters >= MINIMUM_STRONG_PAGE_SCRIPT_CHARACTERS
  ) {
    return { language: script.language, source: 'content' };
  }
  if (!detectLanguage) return { source: 'unknown' };
  if (sample.length < 20) return { source: 'unknown' };

  try {
    const detected = await detectLanguage(sample);
    if (!detected.isReliable) return { source: 'unknown' };
    let language: SupportedLanguage | undefined;
    let highestPercentage = Number.NEGATIVE_INFINITY;
    for (const candidate of detected.languages) {
      if (
        candidate.percentage < 55 ||
        candidate.percentage <= highestPercentage
      ) continue;
      const canonical = canonicalizeLanguageTag(candidate.language);
      if (!canonical) continue;
      language = canonical;
      highestPercentage = candidate.percentage;
    }
    return language
      ? { language, source: 'content' }
      : { source: 'unknown' };
  } catch {
    return { source: 'unknown' };
  }
}
