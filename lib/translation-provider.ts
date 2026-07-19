/** Chrome 138 Translator API language set. Runtime availability remains truth. */
export const SUPPORTED_LANGUAGES = [
  'ar',
  'bg',
  'bn',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'fi',
  'fr',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'he',
  'ja',
  'kn',
  'ko',
  'lt',
  'mr',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'vi',
  'zh',
  'zh-Hant',
] as const;

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
    isSupportedLanguage(pair.sourceLanguage) &&
    isSupportedLanguage(pair.targetLanguage)
  );
}

export function languageName(language: SupportedLanguage): string {
  return LANGUAGE_NAMES[language];
}

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  );
}

/** Normalize HTML/i18n BCP-47 tags into the codes accepted by Simul. */
export function canonicalizeLanguageTag(
  value: string | undefined,
): SupportedLanguage | undefined {
  if (!value?.trim()) return undefined;
  const raw = value.trim().replace(/_/gu, '-');
  const lower = raw.toLowerCase();
  if (lower === 'iw' || lower.startsWith('iw-')) return 'he';
  if (lower === 'nb' || lower === 'nn' || lower.startsWith('nb-') || lower.startsWith('nn-')) {
    return 'no';
  }
  if (
    lower === 'zh-hant' ||
    lower.startsWith('zh-hant-') ||
    /^zh-(?:tw|hk|mo)(?:-|$)/u.test(lower)
  ) {
    return 'zh-Hant';
  }
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh';

  let canonical = raw;
  try {
    canonical = Intl.getCanonicalLocales(raw)[0] ?? raw;
  } catch {
    // Malformed page metadata is simply not a usable detection signal.
  }
  if (isSupportedLanguage(canonical)) return canonical;
  const base = canonical.split('-')[0]?.toLowerCase();
  return isSupportedLanguage(base) ? base : undefined;
}

/** Chrome documents the legacy `iw` code for Hebrew in some API locales. */
export function chromeTranslatorLanguageCode(
  language: SupportedLanguage,
): string {
  return language === 'he' ? 'iw' : language;
}

const LANGUAGE_NAMES: Readonly<Record<SupportedLanguage, string>> = {
  ar: 'Arabic',
  bg: 'Bulgarian',
  bn: 'Bengali',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  fi: 'Finnish',
  fr: 'French',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  he: 'Hebrew',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  lt: 'Lithuanian',
  mr: 'Marathi',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  sl: 'Slovenian',
  sv: 'Swedish',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  zh: 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
};
