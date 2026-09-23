import { describe, expect, it, vi } from 'vitest';

import {
  repairTranslatedFrame,
  resolveUiLabelTranslations,
  shouldRetryUiLabelLocalization,
  toolbarAttentionTarget,
} from '../lib/companion-ui-localization';

describe('companion UI localization', () => {
  it('keeps a translated frame only with the same placeholders (review L6)', async () => {
    const frame = 'Ready to translate {0} to {1} on-device.';
    expect(repairTranslatedFrame(frame, '{0}から{1}へ翻訳できます。'))
      .toBe('{0}から{1}へ翻訳できます。');
    expect(repairTranslatedFrame(frame, '{ 0 }から｛１｝へ翻訳できます。'))
      .toBe('{0}から{1}へ翻訳できます。');
    // A dropped placeholder keeps the English frame for this label only.
    expect(repairTranslatedFrame(frame, '{0}を翻訳できます。')).toBe(frame);
    expect(repairTranslatedFrame('Fit', 'Ajuster')).toBe('Ajuster');

    const result = await resolveUiLabelTranslations(
      [frame, 'Fit'],
      'ja',
      async (source) => source === frame ? '{0}を翻訳できます。' : 'フィット',
    );
    expect(result.localized).toBe(true);
    expect(result.labels.get(frame)).toBe(frame);
    expect(result.labels.get('Fit')).toBe('フィット');
  });

  it('attaches warning and error state to the action that can resolve it', () => {
    expect(toolbarAttentionTarget(
      'A live update was missed. Rebuilding the current mirror…',
      'warning',
    )).toBe('refresh');
    expect(toolbarAttentionTarget(
      'This language pair is unavailable on this device.',
      'error',
    )).toBe('settings');
    expect(toolbarAttentionTarget('Translation is complete.', 'success'))
      .toBeUndefined();
    expect(toolbarAttentionTarget('Reading the source page.', 'normal'))
      .toBeUndefined();
  });

  it('deduplicates exact labels and returns one complete localized set', async () => {
    const translate = vi.fn(async (source: string) => `ja:${source}`);
    const result = await resolveUiLabelTranslations(
      ['From', 'To', 'From'],
      'ja',
      translate,
    );

    expect(result.localized).toBe(true);
    expect([...result.labels]).toEqual([
      ['From', 'ja:From'],
      ['To', 'ja:To'],
    ]);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('uses the complete English set immediately when English is targeted', async () => {
    const translate = vi.fn(async (source: string) => `unused:${source}`);
    const result = await resolveUiLabelTranslations(
      ['Options', 'Rebuild mirror'],
      'en',
      translate,
    );

    expect(result).toEqual({
      localized: false,
      labels: new Map([
        ['Options', 'Options'],
        ['Rebuild mirror', 'Rebuild mirror'],
      ]),
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('falls back atomically to English when any runtime label fails', async () => {
    const translate = vi.fn(async (source: string) => {
      if (source === 'Size') throw new Error('Translator unavailable');
      return `ja:${source}`;
    });
    const result = await resolveUiLabelTranslations(
      ['From', 'Size', 'Settings'],
      'ja',
      translate,
    );

    expect(result.localized).toBe(false);
    expect([...result.labels.values()]).toEqual(['From', 'Size', 'Settings']);
  });

  it('allows one bounded retry after a transient non-English fallback', () => {
    const fallback = {
      localized: false,
      labels: new Map([['From', 'From']]),
    };

    expect(shouldRetryUiLabelLocalization('ja:From', '', 'ja', fallback))
      .toBe(true);
    expect(shouldRetryUiLabelLocalization(
      'ja:From',
      'ja:From',
      'ja',
      fallback,
    )).toBe(false);
    expect(shouldRetryUiLabelLocalization('en:From', '', 'en', fallback))
      .toBe(false);
    expect(shouldRetryUiLabelLocalization('ja:From', '', 'ja', {
      localized: true,
      labels: new Map([['From', 'から']]),
    })).toBe(false);
  });
});
