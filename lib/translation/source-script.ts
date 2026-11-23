import type { SupportedLanguage } from '../translation-provider';

/**
 * The letters a text in each source language is written with (D234). A text
 * holding none of them cannot be in that language: an English label on a
 * page translated from Japanese ("Choose an account") was sent to the
 * translator as Japanese and came back as "House an account". Such a text
 * is left as the page wrote it. The check is per text, so a page that mixes
 * languages keeps translating every text that holds any letter of its source
 * language, and costs about 0.03 µs a text (0.5 ms for Wikipedia's 16,000).
 *
 * Wide on purpose: a script a language borrows (Han in Korean) counts, so a
 * text is only left alone when it certainly is not in the source language.
 */
const SOURCE_SCRIPT_PATTERNS: Readonly<Record<SupportedLanguage, RegExp>> =
  Object.freeze({
    ar: /\p{Script=Arabic}/u,
    bg: /\p{Script=Cyrillic}/u,
    bn: /\p{Script=Bengali}/u,
    cs: /\p{Script=Latin}/u,
    da: /\p{Script=Latin}/u,
    de: /\p{Script=Latin}/u,
    el: /\p{Script=Greek}/u,
    en: /\p{Script=Latin}/u,
    es: /\p{Script=Latin}/u,
    fi: /\p{Script=Latin}/u,
    fr: /\p{Script=Latin}/u,
    he: /\p{Script=Hebrew}/u,
    hi: /\p{Script=Devanagari}/u,
    hr: /\p{Script=Latin}/u,
    hu: /\p{Script=Latin}/u,
    id: /\p{Script=Latin}/u,
    it: /\p{Script=Latin}/u,
    ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
    kn: /\p{Script=Kannada}/u,
    ko: /[\p{Script=Hangul}\p{Script=Han}]/u,
    lt: /\p{Script=Latin}/u,
    mr: /\p{Script=Devanagari}/u,
    nl: /\p{Script=Latin}/u,
    no: /\p{Script=Latin}/u,
    pl: /\p{Script=Latin}/u,
    pt: /\p{Script=Latin}/u,
    ro: /\p{Script=Latin}/u,
    ru: /\p{Script=Cyrillic}/u,
    sk: /\p{Script=Latin}/u,
    sl: /\p{Script=Latin}/u,
    sv: /\p{Script=Latin}/u,
    ta: /\p{Script=Tamil}/u,
    te: /\p{Script=Telugu}/u,
    th: /\p{Script=Thai}/u,
    tr: /\p{Script=Latin}/u,
    uk: /\p{Script=Cyrillic}/u,
    vi: /\p{Script=Latin}/u,
    zh: /\p{Script=Han}/u,
    'zh-Hant': /\p{Script=Han}/u,
  });

/**
 * Whether `text` holds a letter of the script `sourceLanguage` is written
 * in, so that it may be in that language and is worth translating. A
 * language without a known script is always worth it.
 */
export function textMayBeInSourceLanguage(
  text: string,
  sourceLanguage: SupportedLanguage,
): boolean {
  const pattern = SOURCE_SCRIPT_PATTERNS[sourceLanguage] as RegExp | undefined;
  return pattern ? pattern.test(text) : true;
}
