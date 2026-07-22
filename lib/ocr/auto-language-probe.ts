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

export type AutoLanguageProbeObservationResult =
  | Readonly<{
      status: 'resolved';
      language: SupportedLanguage;
      evidence: AutoLanguageProbeEvidence;
      attempts: number;
      images: number;
    }>
  | Readonly<{ status: 'continue' | 'ignored' }>;

interface LanguageVotes {
  readonly samples: Set<AutoLanguageProbeSampleIdentity>;
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
      votes.samples.has(sampleIdentity),
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
    ) return Object.freeze({ status: 'ignored' as const });

    const script = strongAutoLanguageScriptEvidence(transcript);
    const language = script?.language ?? observation.detectedLanguage;
    // A representative model may cover a bounded related-script family. A
    // result outside that family is cross-route gibberish, not evidence.
    if (
      !language ||
      !routeSupportsDetectedLanguage(observation.routeLanguage, language)
    ) {
      return Object.freeze({ status: 'ignored' as const });
    }
    if (
      script &&
      confidence !== undefined &&
      confidence >= AUTO_LANGUAGE_PROBE_SINGLE_IMAGE_CONFIDENCE
    ) {
      return this.#resolve(language, 'single-strong-script');
    }

    let votes = this.#votes.get(language);
    if (!votes) {
      votes = { samples: new Set() };
      this.#votes.set(language, votes);
    }
    votes.samples.add(observation.sampleIdentity);
    if (votes.samples.size >= 2) {
      return this.#resolve(language, 'distinct-images');
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
  ): Extract<AutoLanguageProbeObservationResult, { status: 'resolved' }> {
    this.#resolved = language;
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
      .find(([, votes]) => !votes.samples.has(sampleIdentity));
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
