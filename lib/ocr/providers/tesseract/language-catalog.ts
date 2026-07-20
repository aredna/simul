import {
  canonicalizeLanguageTag,
  type SupportedLanguage,
} from '../../../translation-provider';

export const TESSERACT_VERSION = '7.0.0';
export const TESSDATA_FAST_COMMIT =
  '87416418657359cb625c412a48b6e1d6d41c29bd';
export const TESSERACT_MODEL_VERSION =
  `tessdata-fast-${TESSDATA_FAST_COMMIT}`;

export const TESSERACT_LANGUAGE_CODES = Object.freeze([
  'eng', 'spa', 'fra', 'deu', 'por', 'ita', 'vie',
  'jpn', 'jpn_vert', 'kor', 'chi_sim', 'chi_tra',
  'rus', 'ukr', 'ara', 'heb',
  'hin', 'mar', 'ben', 'kan', 'tam', 'tel',
] as const);

export type TesseractLanguageCode =
  (typeof TESSERACT_LANGUAGE_CODES)[number];

const ROUTES: Readonly<Partial<Record<SupportedLanguage, string>>> = Object.freeze({
  en: 'eng',
  es: 'spa',
  fr: 'fra',
  de: 'deu',
  pt: 'por',
  it: 'ita',
  vi: 'vie',
  ja: 'jpn+jpn_vert',
  ko: 'kor',
  zh: 'chi_sim',
  'zh-Hant': 'chi_tra',
  ru: 'rus',
  uk: 'ukr',
  ar: 'ara',
  he: 'heb',
  hi: 'hin',
  mr: 'mar',
  bn: 'ben',
  kn: 'kan',
  ta: 'tam',
  te: 'tel',
});

export interface TesseractLanguageHints {
  readonly nearestElementLanguage?: string;
  readonly explicitSourceLanguage?: SupportedLanguage;
  readonly detectedPageLanguage?: SupportedLanguage;
}

export interface ResolvedTesseractLanguageRoute {
  readonly sourceLanguage: SupportedLanguage;
  readonly languageGroup: string;
}

/** Nearest valid lang, explicit From, then detected page language. */
export function resolveTesseractLanguageRoute(
  hints: TesseractLanguageHints,
): ResolvedTesseractLanguageRoute | undefined {
  const candidates = [
    canonicalizeLanguageTag(hints.nearestElementLanguage),
    hints.explicitSourceLanguage,
    hints.detectedPageLanguage,
  ];
  for (const language of candidates) {
    if (!language) continue;
    const languageGroup = ROUTES[language];
    if (languageGroup) return Object.freeze({ sourceLanguage: language, languageGroup });
  }
  return undefined;
}

export function routeTesseractLanguage(
  hints: TesseractLanguageHints,
): string | undefined {
  return resolveTesseractLanguageRoute(hints)?.languageGroup;
}

export function isPackagedTesseractLanguageGroup(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 64) {
    return false;
  }
  const codes = value.split('+');
  return codes.length >= 1 && codes.length <= 2 &&
    codes.every((code) =>
      (TESSERACT_LANGUAGE_CODES as readonly string[]).includes(code),
    );
}
