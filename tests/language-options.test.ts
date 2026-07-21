import { describe, expect, it, vi } from 'vitest';

import {
  LANGUAGE_ENDONYMS,
  LANGUAGE_OPTION_ORDER,
  createSourceLanguageLabeler,
  languageEndonym,
} from '../lib/language-options';
import {
  SUPPORTED_LANGUAGES,
  languageName,
} from '../lib/translation-provider';

describe('language options', () => {
  it('uses one exact complete order by English reference name', () => {
    expect(LANGUAGE_OPTION_ORDER).toEqual([
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
    ]);
    expect(new Set(LANGUAGE_OPTION_ORDER).size).toBe(
      LANGUAGE_OPTION_ORDER.length,
    );
    expect(new Set(LANGUAGE_OPTION_ORDER)).toEqual(
      new Set(SUPPORTED_LANGUAGES),
    );
    expect(LANGUAGE_OPTION_ORDER.map(languageName)).toEqual(
      [...LANGUAGE_OPTION_ORDER.map(languageName)].sort((left, right) =>
        left.localeCompare(right, 'en')
      ),
    );
    expect(LANGUAGE_OPTION_ORDER.slice(3, 5)).toEqual(['zh', 'zh-Hant']);
  });

  it('localizes From labels into the selected target language', () => {
    const createDisplayNames = vi.fn((locale: string) => ({
      of: (language: string) => `${locale}:${language}`,
    }));
    const label = createSourceLanguageLabeler('ja', createDisplayNames);

    expect(label('de')).toBe('ja:de');
    expect(label('zh-Hant')).toBe('ja:zh-Hant');
    expect(createDisplayNames).toHaveBeenCalledOnce();
    expect(createDisplayNames).toHaveBeenCalledWith('ja');
  });

  it('falls back to stable English names when localized display names fail', () => {
    const unavailable = createSourceLanguageLabeler('ja', () => {
      throw new Error('DisplayNames unavailable');
    });
    const partial = createSourceLanguageLabeler('ja', () => ({
      of: () => undefined,
    }));
    const throwing = createSourceLanguageLabeler('ja', () => ({
      of: () => {
        throw new Error('Unsupported language');
      },
    }));

    expect(unavailable('de')).toBe('German');
    expect(partial('zh-Hant')).toBe('Chinese (Traditional)');
    expect(throwing('fr')).toBe('French');
  });

  it('uses deterministic native To endonyms for every supported code', () => {
    expect(Object.keys(LANGUAGE_ENDONYMS)).toHaveLength(
      SUPPORTED_LANGUAGES.length,
    );
    expect(languageEndonym('de')).toBe('Deutsch');
    expect(languageEndonym('ja')).toBe('日本語');
    expect(languageEndonym('zh')).toBe('简体中文');
    expect(languageEndonym('zh-Hant')).toBe('繁體中文');
    expect(LANGUAGE_OPTION_ORDER.every(
      (language) => languageEndonym(language).trim().length > 0,
    )).toBe(true);
  });
});
