import { describe, expect, it, vi } from 'vitest';

import {
  AutoLanguageEvidencePrecedence,
  autoImageLanguageConfigurationKey,
  resolveSourceLanguage,
  shouldClearAutoImageLanguageForDocument,
  shouldClearAutoImageLanguageResolution,
} from '../lib/language-detection';
import { parsePageSnapshot } from '../lib/page-snapshot';
import {
  canonicalizeLanguageTag,
  SUPPORTED_LANGUAGES,
} from '../lib/translation-provider';

describe('language selection', () => {
  it('holds image evidence behind an active page resolution', () => {
    const gate = new AutoLanguageEvidencePrecedence<string>();
    gate.beginPageResolution(1);
    expect(gate.pageResolutionPending).toBe(true);
    expect(gate.offerImageEvidence('ocr-ja')).toBeUndefined();
    expect(gate.settlePageResolution(1, true)).toBeUndefined();
    expect(gate.pageResolutionPending).toBe(false);

    gate.beginPageResolution(2);
    expect(gate.offerImageEvidence('ocr-ja')).toBeUndefined();
    expect(gate.settlePageResolution(2, false)).toBe('ocr-ja');

    gate.beginPageResolution(3);
    expect(gate.offerImageEvidence('stale')).toBeUndefined();
    gate.beginPageResolution(4);
    expect(gate.settlePageResolution(3, false)).toBeUndefined();
    expect(gate.settlePageResolution(4, false)).toBe('stale');
    gate.beginPageResolution(5);
    expect(gate.offerImageEvidence('discarded')).toBeUndefined();
    gate.invalidate();
    expect(gate.settlePageResolution(5, false)).toBeUndefined();
  });

  it('retains image-derived language only with exact-document proof', () => {
    expect(shouldClearAutoImageLanguageForDocument('image', true)).toBe(false);
    expect(shouldClearAutoImageLanguageForDocument('image', false)).toBe(true);
    expect(shouldClearAutoImageLanguageForDocument('page', false)).toBe(false);
    expect(shouldClearAutoImageLanguageForDocument(undefined, false)).toBe(false);
  });

  it('invalidates only image-derived language when OCR route settings change', () => {
    const configuration = {
      providerOrder: ['tesseract'],
      enabledMethodOrder: ['accessibility-text', 'tesseract'],
      minimumConfidence: 0.65,
      policyFingerprint: 'read-v1-110000',
      controlImages: true,
    } as const;
    const first = autoImageLanguageConfigurationKey(configuration);
    // Target language is deliberately absent from this source-evidence key.
    const targetOnlyChange = autoImageLanguageConfigurationKey(configuration);
    const confidenceChange = autoImageLanguageConfigurationKey({
      ...configuration,
      minimumConfidence: 0.8,
    });
    const providerChange = autoImageLanguageConfigurationKey({
      ...configuration,
      providerOrder: ['paddleocr-wasm', 'tesseract'],
      enabledMethodOrder: [
        'accessibility-text',
        'paddleocr-wasm',
        'tesseract',
      ],
    });
    const semanticMethodChange = autoImageLanguageConfigurationKey({
      ...configuration,
      enabledMethodOrder: ['tesseract'],
    });
    const semanticOrderChange = autoImageLanguageConfigurationKey({
      ...configuration,
      enabledMethodOrder: ['tesseract', 'accessibility-text'],
    });
    const policyChange = autoImageLanguageConfigurationKey({
      ...configuration,
      policyFingerprint: 'read-v1-100000',
      controlImages: false,
    });
    expect(shouldClearAutoImageLanguageResolution(
      'image',
      first,
      targetOnlyChange,
    )).toBe(false);
    expect(shouldClearAutoImageLanguageResolution(
      'image',
      first,
      confidenceChange,
    )).toBe(true);
    expect(shouldClearAutoImageLanguageResolution(
      'image',
      first,
      providerChange,
    )).toBe(true);
    expect(shouldClearAutoImageLanguageResolution(
      'image',
      first,
      semanticMethodChange,
    )).toBe(true);
    expect(shouldClearAutoImageLanguageResolution(
      'image',
      first,
      semanticOrderChange,
    )).toBe(true);
    expect(shouldClearAutoImageLanguageResolution(
      'image',
      first,
      policyChange,
    )).toBe(true);
    expect(shouldClearAutoImageLanguageResolution(
      'page',
      first,
      providerChange,
    )).toBe(false);
  });

  it('normalizes HTML language tags supported by Chrome', () => {
    expect(canonicalizeLanguageTag('ja-JP')).toBe('ja');
    expect(canonicalizeLanguageTag('zh-TW')).toBe('zh-Hant');
    expect(canonicalizeLanguageTag('zh-CN')).toBe('zh');
    expect(canonicalizeLanguageTag('iw-IL')).toBe('he');
    expect(canonicalizeLanguageTag('xx-invalid')).toBeUndefined();
    expect(SUPPORTED_LANGUAGES).toContain('en');
    expect(SUPPORTED_LANGUAGES).toContain('ja');
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(30);
  });

  it('prefers manual then HTML language without invoking content detection', async () => {
    const snapshot = page('ja-JP', 'This sample is deliberately long enough.');
    const detect = vi.fn();

    await expect(resolveSourceLanguage('de', snapshot, detect)).resolves.toEqual({
      language: 'de',
      source: 'manual',
    });
    await expect(resolveSourceLanguage('auto', snapshot, detect)).resolves.toEqual({
      language: 'ja',
      source: 'html',
    });
    expect(detect).not.toHaveBeenCalled();
  });

  it('uses only a reliable, supported local content result as fallback', async () => {
    const snapshot = page(undefined, 'This sample is deliberately long enough for detection.');
    await expect(
      resolveSourceLanguage('auto', snapshot, async () => ({
        isReliable: true,
        languages: [{ language: 'en', percentage: 97 }],
      })),
    ).resolves.toEqual({ language: 'en', source: 'content' });

    await expect(
      resolveSourceLanguage('auto', snapshot, async () => ({
        isReliable: false,
        languages: [{ language: 'en', percentage: 97 }],
      })),
    ).resolves.toEqual({ source: 'unknown' });
  });

  it('requires dominant strong script evidence on short page samples', async () => {
    const detect = vi.fn();
    await expect(
      resolveSourceLanguage('auto', page(undefined, 'お知らせ'), detect),
    ).resolves.toEqual({ source: 'unknown' });
    await expect(
      resolveSourceLanguage(
        'auto',
        page(undefined, 'これはにほんごのおしらせです'),
        detect,
      ),
    ).resolves.toEqual({ language: 'ja', source: 'content' });
    await expect(
      resolveSourceLanguage('auto', page(undefined, '法人番号'), detect),
    ).resolves.toEqual({ source: 'unknown' });
    await expect(resolveSourceLanguage(
      'auto',
      page(undefined, 'This is a long English page with one お知らせ button.'),
      async () => ({
        isReliable: true,
        languages: [{ language: 'en', percentage: 98 }],
      }),
    )).resolves.toEqual({ language: 'en', source: 'content' });
    expect(detect).not.toHaveBeenCalled();
  });

  it('does not equate the shared Arabic script with Arabic language', async () => {
    const detect = vi.fn(async () => ({
      isReliable: true,
      languages: [{ language: 'fa', percentage: 99 }],
    }));
    await expect(resolveSourceLanguage(
      'auto',
      page(undefined, 'این یک متن فارسی طولانی برای تشخیص زبان محلی است'),
      detect,
    )).resolves.toEqual({ source: 'unknown' });
    expect(detect).toHaveBeenCalledOnce();

    await expect(resolveSourceLanguage(
      'auto',
      page(undefined, 'هذا نص عربي طويل بما يكفي لاكتشاف اللغة محليا'),
      async () => ({
        isReliable: true,
        languages: [{ language: 'ar', percentage: 99 }],
      }),
    )).resolves.toEqual({ language: 'ar', source: 'content' });
  });
});

function page(documentLanguage: string | undefined, text: string) {
  return parsePageSnapshot({
    version: 1,
    title: 'Page',
    url: 'https://example.com/',
    capturedAt: '2026-07-19T00:00:00.000Z',
    ...(documentLanguage ? { documentLanguage } : {}),
    items: [{ id: 'source', kind: 'text', role: 'paragraph', text }],
    omissions: {},
  });
}
