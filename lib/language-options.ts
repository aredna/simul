import {
  languageName,
  type SupportedLanguage,
} from './translation-provider';

/** Stable product order, sorted by the English reference language name. */
export const LANGUAGE_OPTION_ORDER = Object.freeze([
  'ar',
  'bn',
  'bg',
  'zh',
  'zh-Hant',
  'hr',
  'cs',
  'da',
  'nl',
  'en',
  'fi',
  'fr',
  'de',
  'el',
  'he',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'kn',
  'ko',
  'lt',
  'mr',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'es',
  'sv',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'vi',
] as const satisfies readonly SupportedLanguage[]);

export const LANGUAGE_ENDONYMS = Object.freeze({
  ar: 'العربية',
  bg: 'Български',
  bn: 'বাংলা',
  cs: 'Čeština',
  da: 'Dansk',
  de: 'Deutsch',
  el: 'Ελληνικά',
  en: 'English',
  es: 'Español',
  fi: 'Suomi',
  fr: 'Français',
  he: 'עברית',
  hi: 'हिन्दी',
  hr: 'Hrvatski',
  hu: 'Magyar',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  kn: 'ಕನ್ನಡ',
  ko: '한국어',
  lt: 'Lietuvių',
  mr: 'मराठी',
  nl: 'Nederlands',
  no: 'Norsk',
  pl: 'Polski',
  pt: 'Português',
  ro: 'Română',
  ru: 'Русский',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  sv: 'Svenska',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  th: 'ไทย',
  tr: 'Türkçe',
  uk: 'Українська',
  vi: 'Tiếng Việt',
  zh: '简体中文',
  'zh-Hant': '繁體中文',
} satisfies Readonly<Record<SupportedLanguage, string>>);

export interface LanguageDisplayNames {
  of(languageCode: string): string | undefined;
}

export type LanguageDisplayNamesFactory = (
  locale: SupportedLanguage,
) => LanguageDisplayNames;

export function createSourceLanguageLabeler(
  locale: SupportedLanguage,
  createDisplayNames: LanguageDisplayNamesFactory = defaultDisplayNamesFactory,
): (language: SupportedLanguage) => string {
  let displayNames: LanguageDisplayNames | undefined;
  try {
    displayNames = createDisplayNames(locale);
  } catch {
    displayNames = undefined;
  }
  return (language) => {
    try {
      const localized = displayNames?.of(language)?.trim();
      return localized || languageName(language);
    } catch {
      return languageName(language);
    }
  };
}

export function languageEndonym(language: SupportedLanguage): string {
  return LANGUAGE_ENDONYMS[language];
}

function defaultDisplayNamesFactory(
  locale: SupportedLanguage,
): LanguageDisplayNames {
  return new Intl.DisplayNames([locale], { type: 'language' });
}
