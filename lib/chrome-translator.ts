import {
  type CreateTranslationSessionOptions,
  type TranslationAvailability,
  type TranslationPair,
  type TranslationProvider,
  TranslationProviderError,
  type TranslationSession,
  isSupportedTranslationPair,
} from './translation-provider';

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

  constructor(api: BrowserTranslatorApi | undefined = readTranslatorApi()) {
    this.api = api;
  }

  async availability(
    pair: TranslationPair,
  ): Promise<TranslationAvailability> {
    this.assertPair(pair);
    const api = this.requireApi();

    try {
      const availability = await api.availability(pair);
      return normalizeAvailability(availability);
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
    const api = this.requireApi();
    options.signal?.throwIfAborted();

    try {
      const instance = await api.create({
        ...pair,
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

      return new ChromeTranslationSession(instance);
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      throw new TranslationProviderError(
        'creation-failed',
        'Chrome could not prepare the local language pack. Try again.',
        { cause: error },
      );
    }
  }

  private assertPair(pair: TranslationPair): void {
    if (!isSupportedTranslationPair(pair)) {
      throw new TranslationProviderError(
        'pair-unavailable',
        'This version supports only Japanese and English in opposite directions.',
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
    if (this.destroyed) {
      throw new TranslationProviderError(
        'translation-failed',
        'The local translation session is no longer available.',
      );
    }

    signal?.throwIfAborted();
    try {
      return await this.instance.translate(
        text,
        signal ? { signal } : undefined,
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
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
  return [...value].length;
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
  return error instanceof DOMException && error.name === 'AbortError';
}
