import {
  type CreateTranslationSessionOptions,
  type SupportedLanguage,
  type TranslationAvailability,
  type TranslationPair,
  type TranslationProvider,
  TranslationProviderError,
  type TranslationSession,
  chromeTranslatorLanguageCodes,
  isSupportedTranslationPair,
} from './translation-provider';

interface BrowserLanguagePair {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

export interface BrowserTranslatorApi {
  availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<unknown>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    signal?: AbortSignal;
    monitor?: (monitor: BrowserTranslatorMonitor) => void;
  }): Promise<BrowserTranslatorInstance>;
}

export interface BrowserTranslatorMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: { loaded: number; total?: number }) => void,
  ): void;
}

export interface BrowserTranslatorInstance {
  readonly inputQuota?: number;
  measureInputUsage?(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<number>;
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

export class ChromeTranslatorProvider implements TranslationProvider {
  private readonly api: BrowserTranslatorApi | undefined;
  /** Language tags Chrome accepted in an availability probe, per language. */
  private readonly acceptedTags = new Map<SupportedLanguage, string>();

  constructor(api: BrowserTranslatorApi | undefined = readTranslatorApi()) {
    this.api = api;
  }

  async availability(
    pair: TranslationPair,
  ): Promise<TranslationAvailability> {
    this.assertPair(pair);
    if (pair.sourceLanguage === pair.targetLanguage) return 'available';
    const api = this.requireApi();

    try {
      return await this.probeAvailability(api, pair);
    } catch (error) {
      throw new TranslationProviderError(
        'api-unavailable',
        'Chrome could not check its local translation capability.',
        { cause: error },
      );
    }
  }

  async createSession(
    pair: TranslationPair,
    options: CreateTranslationSessionOptions = {},
  ): Promise<TranslationSession> {
    this.assertPair(pair);
    if (pair.sourceLanguage === pair.targetLanguage) {
      return new NoopTranslationSession();
    }
    const api = this.requireApi();
    options.signal?.throwIfAborted();
    // Only a language with alternative tags needs a probe before creation;
    // every other pair reaches Chrome synchronously, as before.
    const browserPair = this.browserPairCandidates(pair).length > 1
      ? await this.settleBrowserPair(api, pair)
      : this.firstBrowserPair(pair);
    options.signal?.throwIfAborted();

    try {
      const instance = await api.create({
        ...browserPair,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onDownloadProgress
          ? {
              monitor: (monitor: BrowserTranslatorMonitor) => {
                monitor.addEventListener('downloadprogress', (event) => {
                  options.onDownloadProgress?.(normalizeProgress(event));
                });
              },
            }
          : {}),
      });

      if (options.signal?.aborted) {
        instance.destroy();
        options.signal.throwIfAborted();
      }

      return new ChromeTranslationSession(instance);
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      // Chrome refuses to start a language-pack download without a recent
      // user activation and reports it as NotAllowedError.
      if (isDomExceptionNamed(error, 'NotAllowedError')) {
        throw new TranslationProviderError(
          'activation-required',
          'Chrome needs a click before it downloads this language pair. Select Translate page once.',
          { cause: error },
        );
      }
      throw new TranslationProviderError(
        'creation-failed',
        'Chrome could not prepare the local language pack. Try again.',
        { cause: error },
      );
    }
  }

  /**
   * Probes the candidate tag combinations in order and returns the first
   * result Chrome does not report as unavailable, remembering the tags that
   * worked so later probes and sessions use them directly. A probe that throws
   * for one tag counts as a refusal of that tag; only when every candidate
   * throws is the failure surfaced.
   */
  private async probeAvailability(
    api: BrowserTranslatorApi,
    pair: TranslationPair,
  ): Promise<TranslationAvailability> {
    const candidates = this.browserPairCandidates(pair);
    let refusedByError = 0;
    let lastError: unknown;
    for (const candidate of candidates) {
      let availability: TranslationAvailability;
      try {
        availability = normalizeAvailability(await api.availability(candidate));
      } catch (error) {
        refusedByError += 1;
        lastError = error;
        continue;
      }
      if (availability === 'unavailable') continue;
      this.acceptedTags.set(pair.sourceLanguage, candidate.sourceLanguage);
      this.acceptedTags.set(pair.targetLanguage, candidate.targetLanguage);
      return availability;
    }
    if (refusedByError > 0 && refusedByError === candidates.length) {
      throw lastError;
    }
    return 'unavailable';
  }

  /**
   * Chrome rejects the wrong tag at creation with a generic error, so a pair
   * with alternative tags is settled by an availability probe first; if
   * nothing was accepted, the documented tag goes through and Chrome reports
   * the failure.
   */
  private async settleBrowserPair(
    api: BrowserTranslatorApi,
    pair: TranslationPair,
  ): Promise<BrowserLanguagePair> {
    await this.probeAvailability(api, pair).catch(() => undefined);
    return this.firstBrowserPair(pair);
  }

  private firstBrowserPair(pair: TranslationPair): BrowserLanguagePair {
    const [first] = this.browserPairCandidates(pair);
    return first ?? {
      sourceLanguage: pair.sourceLanguage,
      targetLanguage: pair.targetLanguage,
    };
  }

  private browserPairCandidates(
    pair: TranslationPair,
  ): readonly BrowserLanguagePair[] {
    const candidates: BrowserLanguagePair[] = [];
    for (const sourceLanguage of this.tagCandidates(pair.sourceLanguage)) {
      for (const targetLanguage of this.tagCandidates(pair.targetLanguage)) {
        candidates.push({ sourceLanguage, targetLanguage });
      }
    }
    return candidates;
  }

  private tagCandidates(language: SupportedLanguage): readonly string[] {
    const accepted = this.acceptedTags.get(language);
    return accepted ? [accepted] : chromeTranslatorLanguageCodes(language);
  }

  private assertPair(pair: TranslationPair): void {
    if (!isSupportedTranslationPair(pair)) {
      throw new TranslationProviderError(
        'pair-unavailable',
        'Chrome does not support one of the selected languages.',
      );
    }
  }

  private requireApi(): BrowserTranslatorApi {
    if (!this.api) {
      throw new TranslationProviderError(
        'api-unavailable',
        'Chrome\'s built-in Translator API is unavailable. Use Chrome 138 or newer on a supported desktop device.',
      );
    }
    return this.api;
  }
}

class NoopTranslationSession implements TranslationSession {
  async translate(text: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return text;
  }

  destroy(): void {}
}

class ChromeTranslationSession implements TranslationSession {
  private destroyed = false;

  constructor(private readonly instance: BrowserTranslatorInstance) {}

  get inputQuota(): number | undefined {
    const quota = this.instance.inputQuota;
    return typeof quota === 'number' && Number.isFinite(quota) && quota > 0
      ? quota
      : undefined;
  }

  async measureInputUsage(
    text: string,
    signal?: AbortSignal,
  ): Promise<number> {
    this.assertActive();
    signal?.throwIfAborted();
    if (typeof this.instance.measureInputUsage !== 'function') {
      return countCodePoints(text);
    }
    const usage = await this.instance.measureInputUsage(
      text,
      signal ? { signal } : undefined,
    );
    if (!Number.isFinite(usage) || usage < 0) {
      throw new TranslationProviderError(
        'translation-failed',
        'Chrome returned an invalid translation input measurement.',
      );
    }
    return usage;
  }

  async translate(text: string, signal?: AbortSignal): Promise<string> {
    this.assertActive();
    signal?.throwIfAborted();
    try {
      return await this.instance.translate(
        text,
        signal ? { signal } : undefined,
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      if (isDomExceptionNamed(error, 'QuotaExceededError')) {
        throw new TranslationProviderError(
          'quota-exceeded',
          'This passage is larger than Chrome can translate at once.',
          { cause: error },
        );
      }
      throw new TranslationProviderError(
        'translation-failed',
        'Chrome could not translate this part of the page.',
        { cause: error },
      );
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.instance.destroy();
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new TranslationProviderError(
        'translation-failed',
        'The local translation session is no longer available.',
      );
    }
  }
}

export function readTranslatorApi(): BrowserTranslatorApi | undefined {
  const candidate = (globalThis as { Translator?: unknown }).Translator;
  if (
    (typeof candidate === 'object' || typeof candidate === 'function') &&
    candidate !== null &&
    'availability' in candidate &&
    typeof candidate.availability === 'function' &&
    'create' in candidate &&
    typeof candidate.create === 'function'
  ) {
    return candidate as BrowserTranslatorApi;
  }
  return undefined;
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _point of value) count += 1;
  return count;
}

function normalizeAvailability(value: unknown): TranslationAvailability {
  switch (value) {
    case 'available':
    case 'downloadable':
    case 'downloading':
      return value;
    default:
      return 'unavailable';
  }
}

function normalizeProgress(event: {
  loaded: number;
  total?: number;
}): number {
  const total = event.total;
  const raw = total && total > 0 ? event.loaded / total : event.loaded;
  return Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));
}

function isAbortError(error: unknown): boolean {
  return isDomExceptionNamed(error, 'AbortError');
}

function isDomExceptionNamed(error: unknown, name: string): boolean {
  return error instanceof DOMException && error.name === name;
}
