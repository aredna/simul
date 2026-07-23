import type { SupportedLanguage } from '../translation-provider';

export const MAX_AUTO_LANGUAGE_PROBE_IMAGES = 3;
export const MAX_AUTO_LANGUAGE_PROBE_ATTEMPTS = 18;
export const MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE = 6;
export const MAX_AUTO_LANGUAGE_PROBE_MS = 20_000;
export const AUTO_LANGUAGE_PROBE_MINIMUM_CONFIDENCE = 0.8;
export const AUTO_LANGUAGE_PROBE_SINGLE_IMAGE_CONFIDENCE = 0.9;

/**
 * These are representative packaged OCR model routes rather than every
 * language Chrome can translate. The English route samples supported Latin
 * languages, Russian samples packaged Cyrillic languages, and Hindi samples
 * Devanagari. Greek and Thai can still be inferred from page text, but no
 * corresponding OCR model is packaged, so they are intentionally absent.
 * Latin, Han, Cyrillic, Devanagari, and Arabic are never promoted from script
 * shape alone because each maps to more than one language.
 */
export const AUTO_LANGUAGE_PROBE_CANDIDATES = Object.freeze([
  'ja',
  'en',
  'zh',
  'zh-Hant',
  'ko',
  'ru',
  'ar',
  'he',
  'hi',
  'bn',
  'kn',
  'ta',
  'te',
] as const satisfies readonly SupportedLanguage[]);

const AUTO_LANGUAGE_PROBE_ROUTE_WINDOWS = Object.freeze([
  Object.freeze(['ja', 'en', 'zh', 'zh-Hant', 'ko', 'ru']),
  Object.freeze(['ja', 'ar', 'he', 'hi', 'bn', 'en']),
  Object.freeze(['ja', 'kn', 'ta', 'te', 'ru', 'hi']),
] as const satisfies readonly (readonly SupportedLanguage[])[]);

export type AutoLanguageProbeEvidence =
  | 'single-strong-script'
  | 'distinct-images';

export type AutoLanguageProbeInconclusiveReason =
  | 'deadline'
  | 'image-budget'
  | 'route-budget'
  | 'no-evidence';

declare const autoLanguageProbeSampleIdentityBrand: unique symbol;

/**
 * Controller-owned, memory-only identity for one source image in one exact
 * document. It intentionally carries no source data and cannot be serialized.
 */
export type AutoLanguageProbeSampleIdentity = symbol & {
  readonly [autoLanguageProbeSampleIdentityBrand]: never;
};

export function createAutoLanguageProbeSampleIdentity():
  AutoLanguageProbeSampleIdentity {
  return Symbol() as AutoLanguageProbeSampleIdentity;
}

export interface StrongScriptEvidence {
  readonly language: SupportedLanguage;
  readonly characters: number;
}

export interface AutoLanguageProbeObservation {
  readonly sampleIdentity: AutoLanguageProbeSampleIdentity;
  readonly pixelHash: string;
  readonly routeLanguage: SupportedLanguage;
  readonly transcript: string;
  readonly confidence?: number;
  readonly detectedLanguage?: SupportedLanguage;
}

export interface AutoLanguageProbeSemanticObservation {
  readonly sampleIdentity: AutoLanguageProbeSampleIdentity;
  readonly text: string;
  readonly detectedLanguage: SupportedLanguage;
  readonly now: number;
}

export type AutoLanguageProbeObservationResult =
  | Readonly<{
      status: 'resolved';
      language: SupportedLanguage;
      evidence: AutoLanguageProbeEvidence;
      attempts: number;
      images: number;
    }>
  | Readonly<{ status: 'continue' | 'ignored' }>;

export type AutoLanguageProbeObservationInspection =
  | Readonly<{
      status: 'candidate';
      language: SupportedLanguage;
    }>
  | Readonly<{ status: 'ignored' }>;

interface LanguageVotes {
  readonly ocrSamples: Set<AutoLanguageProbeSampleIdentity>;
  readonly semanticLabels: Map<
    string,
    Set<AutoLanguageProbeSampleIdentity>
  >;
}

interface ProbeSampleState {
  readonly slot: number;
  readonly routePlan: readonly SupportedLanguage[];
  readonly attemptedRoutes: Set<SupportedLanguage>;
  readonly activePixels: Map<SupportedLanguage, string>;
}

/** Memory-only, exact-document probe budget and conservative vote reducer. */
export class AutoImageLanguageProbe {
  readonly #startedAt: number;
  readonly #minimumConfidence: number;
  readonly #samples = new Map<
    AutoLanguageProbeSampleIdentity,
    ProbeSampleState
  >();
  readonly #votes = new Map<SupportedLanguage, LanguageVotes>();
  readonly #resolvedSamples = new Set<AutoLanguageProbeSampleIdentity>();
  #attempts = 0;
  #resolved: SupportedLanguage | undefined;

  constructor(
    startedAt: number,
    minimumConfidence = AUTO_LANGUAGE_PROBE_MINIMUM_CONFIDENCE,
  ) {
    this.#startedAt = finiteTime(startedAt);
    this.#minimumConfidence = Math.max(
      AUTO_LANGUAGE_PROBE_MINIMUM_CONFIDENCE,
      Math.min(1, Number.isFinite(minimumConfidence) ? minimumConfidence : 0),
    );
  }

  get attempts(): number {
    return this.#attempts;
  }

  get images(): number {
    return this.#samples.size;
  }

  get resolvedLanguage(): SupportedLanguage | undefined {
    return this.#resolved;
  }

  remainingMs(now: number): number {
    return Math.max(
      0,
      MAX_AUTO_LANGUAGE_PROBE_MS - (finiteTime(now) - this.#startedAt),
    );
  }

  hasSample(sampleIdentity: AutoLanguageProbeSampleIdentity): boolean {
    return this.#samples.has(sampleIdentity);
  }

  /** Remove every vote owned by one changed or removed exact image. */
  forgetSample(sampleIdentity: AutoLanguageProbeSampleIdentity): boolean {
    if (!isSampleIdentity(sampleIdentity)) return false;
    if (this.#resolvedSamples.has(sampleIdentity)) {
      this.#resolved = undefined;
      this.#resolvedSamples.clear();
    }
    const sample = this.#samples.get(sampleIdentity);
    const removed = this.#samples.delete(sampleIdentity);
    if (sample) {
      this.#attempts = Math.max(
        0,
        this.#attempts - sample.attemptedRoutes.size,
      );
    }
    for (const [language, votes] of this.#votes) {
      votes.ocrSamples.delete(sampleIdentity);
      for (const [label, owners] of votes.semanticLabels) {
        owners.delete(sampleIdentity);
        if (owners.size === 0) votes.semanticLabels.delete(label);
      }
      if (voteSampleCount(votes) === 0) this.#votes.delete(language);
    }
    return removed;
  }

  candidateLanguages(
    sampleIdentity: AutoLanguageProbeSampleIdentity,
    pixelHash: string,
    limit = MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE,
  ): readonly SupportedLanguage[] {
    const hash = boundedPixelKey(pixelHash);
    if (!isSampleIdentity(sampleIdentity) || !hash || this.#resolved) {
      return Object.freeze([]);
    }
    const existing = this.#samples.get(sampleIdentity);
    const slot = existing?.slot ?? this.#firstAvailableImageSlot();
    if (slot === undefined) return Object.freeze([]);
    const routePlan = existing?.routePlan ??
      this.#routePlan(slot, sampleIdentity);
    const attempted = existing?.attemptedRoutes;
    const remainingBudget = MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE -
      (attempted?.size ?? 0);
    const requestedLimit = Math.max(
      1,
      Math.min(MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE, Math.trunc(limit)),
    );
    return Object.freeze(routePlan
      .filter((language) => !attempted?.has(language))
      .slice(0, Math.min(remainingBudget, requestedLimit)));
  }

  beginAttempt(
    sampleIdentity: AutoLanguageProbeSampleIdentity,
    pixelHash: string,
    routeLanguage: SupportedLanguage,
    now: number,
  ): boolean {
    if (this.#resolved || this.inconclusiveReason(now)) return false;
    const hash = boundedPixelKey(pixelHash);
    if (
      !isSampleIdentity(sampleIdentity) ||
      !hash ||
      !(AUTO_LANGUAGE_PROBE_CANDIDATES as readonly SupportedLanguage[]).includes(
        routeLanguage,
      )
    ) return false;
    let sample = this.#samples.get(sampleIdentity);
    if (!sample) {
      const slot = this.#firstAvailableImageSlot();
      if (slot === undefined) return false;
      const routePlan = this.#routePlan(slot, sampleIdentity);
      if (!routePlan.includes(routeLanguage)) return false;
      sample = {
        slot,
        routePlan,
        attemptedRoutes: new Set(),
        activePixels: new Map(),
      };
      this.#samples.set(sampleIdentity, sample);
    }
    if (
      !sample.routePlan.includes(routeLanguage) ||
      sample.attemptedRoutes.has(routeLanguage) ||
      sample.attemptedRoutes.size >= MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE ||
      this.#attempts >= MAX_AUTO_LANGUAGE_PROBE_ATTEMPTS
    ) return false;
    sample.attemptedRoutes.add(routeLanguage);
    sample.activePixels.set(routeLanguage, hash);
    this.#attempts += 1;
    return true;
  }

  /**
   * Reopens one already-budgeted language route for a later OCR provider group
   * without consuming another image or route slot.
   */
  resumeAttempt(
    sampleIdentity: AutoLanguageProbeSampleIdentity,
    pixelHash: string,
    routeLanguage: SupportedLanguage,
    now: number,
  ): boolean {
    if (this.#resolved || this.remainingMs(now) <= 0) return false;
    const hash = boundedPixelKey(pixelHash);
    const sample = this.#samples.get(sampleIdentity);
    if (
      !hash ||
      !sample ||
      !sample.routePlan.includes(routeLanguage) ||
      !sample.attemptedRoutes.has(routeLanguage)
    ) return false;
    const activePixelHash = sample.activePixels.get(routeLanguage);
    if (activePixelHash !== undefined) return activePixelHash === hash;
    sample.activePixels.set(routeLanguage, hash);
    return true;
  }

  /** Mark a completed route that yielded no usable observation. */
  completeAttempt(
    sampleIdentity: AutoLanguageProbeSampleIdentity,
    pixelHash: string,
    routeLanguage: SupportedLanguage,
  ): boolean {
    const hash = boundedPixelKey(pixelHash);
    const sample = this.#samples.get(sampleIdentity);
    if (!hash || sample?.activePixels.get(routeLanguage) !== hash) return false;
    sample.activePixels.delete(routeLanguage);
    return true;
  }

  /** Undo only work that never produced a completed route observation. */
  rollbackAttempt(
    sampleIdentity: AutoLanguageProbeSampleIdentity,
    pixelHash: string,
    routeLanguage: SupportedLanguage,
  ): boolean {
    const hash = boundedPixelKey(pixelHash);
    const sample = this.#samples.get(sampleIdentity);
    if (!hash || sample?.activePixels.get(routeLanguage) !== hash) return false;
    sample.activePixels.delete(routeLanguage);
    sample.attemptedRoutes.delete(routeLanguage);
    this.#attempts = Math.max(0, this.#attempts - 1);
    const hasVote = [...this.#votes.values()].some((votes) =>
      voteHasSample(votes, sampleIdentity)
    );
    if (sample.attemptedRoutes.size === 0 && !hasVote) {
      this.#samples.delete(sampleIdentity);
    }
    return true;
  }

  observe(
    observation: AutoLanguageProbeObservation,
  ): AutoLanguageProbeObservationResult {
    if (this.#resolved) return Object.freeze({ status: 'ignored' as const });
    const hash = boundedPixelKey(observation.pixelHash);
    const sample = this.#samples.get(observation.sampleIdentity);
    if (
      !hash ||
      sample?.activePixels.get(observation.routeLanguage) !== hash
    ) return Object.freeze({ status: 'ignored' as const });
    sample.activePixels.delete(observation.routeLanguage);
    const inspected = this.#inspectOcrCandidate(observation);
    if (!inspected) {
      return Object.freeze({ status: 'ignored' as const });
    }
    const { language, singleStrong } = inspected;
    if (singleStrong) {
      return this.#resolve(
        language,
        'single-strong-script',
        [observation.sampleIdentity],
      );
    }

    let votes = this.#votes.get(language);
    if (!votes) {
      votes = { ocrSamples: new Set(), semanticLabels: new Map() };
      this.#votes.set(language, votes);
    }
    votes.ocrSamples.add(observation.sampleIdentity);
    const contributors = new Set(votes.ocrSamples);
    if (contributors.size >= 2) {
      return this.#resolve(language, 'distinct-images', contributors);
    }
    return Object.freeze({ status: 'continue' as const });
  }

  /**
   * Validate an active OCR observation without consuming its route or adding
   * a language vote. The caller can rank the returned source language against
   * other image-text evidence, then either call observe() or completeAttempt().
   */
  inspectOcrObservation(
    observation: AutoLanguageProbeObservation,
  ): AutoLanguageProbeObservationInspection {
    if (this.#resolved) return Object.freeze({ status: 'ignored' as const });
    const hash = boundedPixelKey(observation.pixelHash);
    const sample = this.#samples.get(observation.sampleIdentity);
    if (
      !hash ||
      sample?.activePixels.get(observation.routeLanguage) !== hash
    ) return Object.freeze({ status: 'ignored' as const });
    return this.classifyOcrObservation(observation);
  }

  /** Validate transcript/language quality without reading or mutating vote state. */
  classifyOcrObservation(
    observation: AutoLanguageProbeObservation,
  ): AutoLanguageProbeObservationInspection {
    if (
      !isSampleIdentity(observation.sampleIdentity) ||
      !boundedPixelKey(observation.pixelHash)
    ) return Object.freeze({ status: 'ignored' as const });
    const inspected = this.#inspectOcrCandidate(observation);
    return inspected
      ? Object.freeze({
          status: 'candidate' as const,
          language: inspected.language,
        })
      : Object.freeze({ status: 'ignored' as const });
  }

  /**
   * Accessibility text is useful language evidence, but one authored label is
   * not authoritative for the page. It can only resolve after the same
   * language is observed on two distinct source images inside this probe's
   * existing image and lifetime bounds.
   */
  observeSemantic(
    observation: AutoLanguageProbeSemanticObservation,
  ): AutoLanguageProbeObservationResult {
    if (
      this.#resolved ||
      this.remainingMs(observation.now) <= 0 ||
      !isSampleIdentity(observation.sampleIdentity)
    ) return Object.freeze({ status: 'ignored' as const });
    const text = observation.text
      .normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 4_000);
    const meaningfulCharacters = [...text].filter((character) =>
      /[\p{L}\p{N}]/u.test(character)
    ).length;
    if (meaningfulCharacters < 1) {
      return Object.freeze({ status: 'ignored' as const });
    }
    const normalizedLabel = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    let sample = this.#samples.get(observation.sampleIdentity);
    if (!sample) {
      const slot = this.#firstAvailableImageSlot();
      if (slot === undefined) {
        return Object.freeze({ status: 'ignored' as const });
      }
      sample = {
        slot,
        routePlan: this.#routePlan(slot, observation.sampleIdentity),
        attemptedRoutes: new Set(),
        activePixels: new Map(),
      };
      this.#samples.set(observation.sampleIdentity, sample);
    }
    let votes = this.#votes.get(observation.detectedLanguage);
    if (!votes) {
      votes = { ocrSamples: new Set(), semanticLabels: new Map() };
      this.#votes.set(observation.detectedLanguage, votes);
    }
    let labelOwners = votes.semanticLabels.get(normalizedLabel);
    if (!labelOwners) {
      labelOwners = new Set();
      votes.semanticLabels.set(normalizedLabel, labelOwners);
    }
    labelOwners.add(observation.sampleIdentity);
    const contributors = semanticVoteSampleIdentities(votes);
    if (contributors.size >= 2) {
      return this.#resolve(
        observation.detectedLanguage,
        'distinct-images',
        contributors,
      );
    }
    return Object.freeze({ status: 'continue' as const });
  }

  inconclusiveReason(now: number): AutoLanguageProbeInconclusiveReason | undefined {
    if (this.#resolved) return undefined;
    if (this.remainingMs(now) <= 0) {
      return 'deadline';
    }
    if (this.#attempts >= MAX_AUTO_LANGUAGE_PROBE_ATTEMPTS) {
      return 'route-budget';
    }
    return undefined;
  }

  finalReason(): AutoLanguageProbeInconclusiveReason {
    if (this.#attempts >= MAX_AUTO_LANGUAGE_PROBE_ATTEMPTS) {
      return 'route-budget';
    }
    if (this.#samples.size >= MAX_AUTO_LANGUAGE_PROBE_IMAGES) return 'image-budget';
    return 'no-evidence';
  }

  #resolve(
    language: SupportedLanguage,
    evidence: AutoLanguageProbeEvidence,
    contributors: Iterable<AutoLanguageProbeSampleIdentity>,
  ): Extract<AutoLanguageProbeObservationResult, { status: 'resolved' }> {
    this.#resolved = language;
    this.#resolvedSamples.clear();
    for (const identity of contributors) this.#resolvedSamples.add(identity);
    return Object.freeze({
      status: 'resolved' as const,
      language,
      evidence,
      attempts: this.#attempts,
      images: this.#samples.size,
    });
  }

  #firstAvailableImageSlot(): number | undefined {
    const occupied = new Set([...this.#samples.values()].map(({ slot }) => slot));
    for (let slot = 0; slot < MAX_AUTO_LANGUAGE_PROBE_IMAGES; slot += 1) {
      if (!occupied.has(slot)) return slot;
    }
    return undefined;
  }

  #routePlan(
    slot: number,
    sampleIdentity: AutoLanguageProbeSampleIdentity,
  ): readonly SupportedLanguage[] {
    const pendingRoute = [...this.#votes.entries()]
      .find(([, votes]) => !voteHasSample(votes, sampleIdentity));
    const primary: SupportedLanguage[] = [
      ...AUTO_LANGUAGE_PROBE_ROUTE_WINDOWS[slot]!,
    ];
    const pending = pendingRoute
      ? representativeProbeRoute(pendingRoute[0])
      : undefined;
    if (pending && !primary.includes(pending)) {
      // Slots 1 and 2 reserve their final route as an earlier-window
      // duplicate. Replace only that duplicate, then freeze this sample's
      // six-route plan so later votes cannot expand or crowd its budget.
      primary.pop();
    }
    return Object.freeze([...new Set([
      ...(pending ? [pending] : []),
      ...primary,
    ])].slice(0, MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE));
  }

  #inspectOcrCandidate(
    observation: AutoLanguageProbeObservation,
  ): Readonly<{
    language: SupportedLanguage;
    singleStrong: boolean;
  }> | undefined {
    const transcript = observation.transcript
      .normalize('NFKC')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 4_000);
    const meaningfulCharacters = [...transcript].filter((character) =>
      /[\p{L}\p{N}]/u.test(character)
    ).length;
    const confidence = Number.isFinite(observation.confidence)
      ? Math.max(0, Math.min(1, Number(observation.confidence)))
      : undefined;
    if (
      meaningfulCharacters < 3 ||
      (confidence !== undefined && confidence < this.#minimumConfidence)
    ) return undefined;

    const script = strongAutoLanguageScriptEvidence(transcript);
    const language = script?.language ?? observation.detectedLanguage;
    // A representative model may cover a bounded related-script family. A
    // result outside that family is cross-route gibberish, not evidence.
    if (
      !language ||
      !routeSupportsDetectedLanguage(observation.routeLanguage, language)
    ) return undefined;
    return Object.freeze({
      language,
      singleStrong: Boolean(
        script &&
        confidence !== undefined &&
        confidence >= AUTO_LANGUAGE_PROBE_SINGLE_IMAGE_CONFIDENCE
      ),
    });
  }
}

function voteSampleCount(votes: LanguageVotes): number {
  return votes.ocrSamples.size + votes.semanticLabels.size;
}

function semanticVoteSampleIdentities(
  votes: LanguageVotes,
): Set<AutoLanguageProbeSampleIdentity> {
  const identities = new Set<AutoLanguageProbeSampleIdentity>();
  for (const owners of votes.semanticLabels.values()) {
    const owner = [...owners].find((identity) => !identities.has(identity)) ??
      owners.values().next().value;
    if (owner) identities.add(owner);
  }
  return identities;
}

function voteHasSample(
  votes: LanguageVotes,
  sampleIdentity: AutoLanguageProbeSampleIdentity,
): boolean {
  return votes.ocrSamples.has(sampleIdentity) ||
    [...votes.semanticLabels.values()].some((owners) =>
      owners.has(sampleIdentity)
    );
}

export function strongScriptEvidence(
  text: string,
): StrongScriptEvidence | undefined {
  const scripts: readonly [SupportedLanguage, RegExp][] = [
    ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
    ['ko', /\p{Script=Hangul}/u],
    ['he', /\p{Script=Hebrew}/u],
    ['el', /\p{Script=Greek}/u],
    ['th', /\p{Script=Thai}/u],
    ['bn', /\p{Script=Bengali}/u],
    ['kn', /\p{Script=Kannada}/u],
    ['ta', /\p{Script=Tamil}/u],
    ['te', /\p{Script=Telugu}/u],
  ];
  let winner: StrongScriptEvidence | undefined;
  for (const [language, pattern] of scripts) {
    const characters = [...text].filter((character) => pattern.test(character)).length;
    if (characters === 0) continue;
    if (winner) return undefined;
    winner = Object.freeze({ language, characters });
  }
  return winner;
}

export function strongAutoLanguageScriptEvidence(
  text: string,
): StrongScriptEvidence | undefined {
  const script = strongScriptEvidence(text);
  if (!script || script.characters < 3) return undefined;
  const meaningfulCharacters = [...text].filter((character) =>
    /[\p{L}\p{N}]/u.test(character)
  ).length;
  return script.characters / Math.max(1, meaningfulCharacters) >= 0.6
    ? script
    : undefined;
}

const LATIN_REPRESENTATIVE_LANGUAGES = new Set<SupportedLanguage>([
  'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'hr', 'hu', 'id', 'it', 'lt',
  'nl', 'no', 'pl', 'pt', 'ro', 'sk', 'sl', 'sv', 'tr', 'vi',
]);

function routeSupportsDetectedLanguage(
  routeLanguage: SupportedLanguage,
  detectedLanguage: SupportedLanguage,
): boolean {
  if (routeLanguage === 'en') {
    return LATIN_REPRESENTATIVE_LANGUAGES.has(detectedLanguage);
  }
  if (routeLanguage === 'ru') {
    return detectedLanguage === 'ru' || detectedLanguage === 'uk' ||
      detectedLanguage === 'bg';
  }
  if (routeLanguage === 'hi') {
    return detectedLanguage === 'hi' || detectedLanguage === 'mr';
  }
  return routeLanguage === detectedLanguage;
}

function representativeProbeRoute(
  detectedLanguage: SupportedLanguage,
): SupportedLanguage {
  if (LATIN_REPRESENTATIVE_LANGUAGES.has(detectedLanguage)) return 'en';
  if (
    detectedLanguage === 'ru' ||
    detectedLanguage === 'uk' ||
    detectedLanguage === 'bg'
  ) return 'ru';
  if (detectedLanguage === 'hi' || detectedLanguage === 'mr') return 'hi';
  return detectedLanguage;
}

function boundedPixelKey(value: string): string | undefined {
  return typeof value === 'string' && value.length >= 16 && value.length <= 256
    ? value
    : undefined;
}

function isSampleIdentity(
  value: AutoLanguageProbeSampleIdentity,
): boolean {
  return typeof value === 'symbol';
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
