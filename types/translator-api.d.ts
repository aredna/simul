/**
 * Chrome's built-in Translator API became stable for desktop extensions in
 * Chrome 138. These declarations intentionally cover only the surface Simul
 * uses so that runtime feature detection remains the source of truth.
 */
type TranslatorAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

interface TranslatorOptions {
  sourceLanguage: string;
  targetLanguage: string;
}

interface TranslatorDownloadProgressEvent extends Event {
  readonly loaded: number;
  readonly total: number;
}

interface TranslatorCreateMonitor extends EventTarget {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: TranslatorDownloadProgressEvent) => void,
  ): void;
}

interface TranslatorCreateOptions extends TranslatorOptions {
  signal?: AbortSignal;
  monitor?: (monitor: TranslatorCreateMonitor) => void;
}

interface TranslatorTranslateOptions {
  signal?: AbortSignal;
}

interface TranslatorInstance {
  readonly inputQuota?: number;
  measureInputUsage?(
    input: string,
    options?: TranslatorTranslateOptions,
  ): Promise<number>;
  translate(
    input: string,
    options?: TranslatorTranslateOptions,
  ): Promise<string>;
  destroy(): void;
}

interface TranslatorApi {
  availability(options: TranslatorOptions): Promise<TranslatorAvailability>;
  create(options: TranslatorCreateOptions): Promise<TranslatorInstance>;
}

declare const Translator: TranslatorApi | undefined;
