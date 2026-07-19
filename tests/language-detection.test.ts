import { describe, expect, it, vi } from 'vitest';

import { resolveSourceLanguage } from '../lib/language-detection';
import { parsePageSnapshot } from '../lib/page-snapshot';
import {
  canonicalizeLanguageTag,
  SUPPORTED_LANGUAGES,
} from '../lib/translation-provider';

describe('language selection', () => {
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
    const snapshot = page(undefined, 'これは日本語の検出に十分な長さを持つ公開ページ文章です。');
    await expect(
      resolveSourceLanguage('auto', snapshot, async () => ({
        isReliable: true,
        languages: [{ language: 'ja', percentage: 97 }],
      })),
    ).resolves.toEqual({ language: 'ja', source: 'content' });

    await expect(
      resolveSourceLanguage('auto', snapshot, async () => ({
        isReliable: false,
        languages: [{ language: 'ja', percentage: 97 }],
      })),
    ).resolves.toEqual({ source: 'unknown' });
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
