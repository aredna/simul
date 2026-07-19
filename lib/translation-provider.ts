export const SUPPORTED_LANGUAGES = ['ja', 'en'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export interface TranslationPair {
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
}

export type TranslationAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

export type TranslationErrorCode =
  | 'api-unavailable'
  | 'pair-unavailable'
  | 'creation-failed'
  | 'translation-failed';

export class TranslationProviderError extends Error {
  constructor(
    public readonly code: TranslationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TranslationProviderError';
  }
}

export interface TranslationSession {
  readonly inputQuota?: number;
  measureInputUsage?(text: string, signal?: AbortSignal): Promise<number>;
  translate(text: string, signal?: AbortSignal): Promise<string>;
  destroy(): void;
}

export interface CreateTranslationSessionOptions {
  signal?: AbortSignal;
  onDownloadProgress?: (progress: number) => void;
}

export interface TranslationProvider {
  availability(pair: TranslationPair): Promise<TranslationAvailability>;
  createSession(
    pair: TranslationPair,
    options?: CreateTranslationSessionOptions,
  ): Promise<TranslationSession>;
}

export function isSupportedTranslationPair(
  pair: TranslationPair,
): boolean {
  return (
    SUPPORTED_LANGUAGES.includes(pair.sourceLanguage) &&
    SUPPORTED_LANGUAGES.includes(pair.targetLanguage) &&
    pair.sourceLanguage !== pair.targetLanguage
  );
}

export function languageName(language: SupportedLanguage): string {
  return language === 'ja' ? 'Japanese' : 'English';
}
