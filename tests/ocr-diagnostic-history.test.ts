import { describe, expect, it } from 'vitest';

import {
  ImageTranslationDiagnosticHistory,
  MAX_IMAGE_TRANSLATION_DIAGNOSTICS,
  formatImageTranslationDiagnostic,
} from '../lib/ocr/diagnostic-history';

describe('ImageTranslationDiagnosticHistory', () => {
  it('formats only the allowlisted content-free diagnostic fields', () => {
    expect(formatImageTranslationDiagnostic({
      stage: 'source-summary',
      candidateImages: 7,
      observedImages: 3,
    })).toBe('source scan: candidates=7; observed=3');
    expect(formatImageTranslationDiagnostic({
      stage: 'recognition-failed',
      code: 'provider-unavailable',
      ordinal: 7,
      renderedWidth: 603,
      renderedHeight: 381,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 7 recognition failed: code=provider-unavailable; rendered=603x381; bitmap=1206x761');
    expect(formatImageTranslationDiagnostic({
      stage: 'recognition-complete',
      provider: 'tesseract',
      regions: 4,
      cacheHit: true,
      ordinal: 2,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 2 recognition complete: provider=tesseract; regions=4; bitmap=1206x761; cache=hit');
    expect(formatImageTranslationDiagnostic({
      stage: 'translation-started',
      ordinal: 2,
      renderedWidth: 603,
      renderedHeight: 381,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 2 translation started: rendered=603x381; bitmap=1206x761');
    expect(formatImageTranslationDiagnostic({
      stage: 'translation-failed',
      ordinal: 2,
      renderedWidth: 603,
      renderedHeight: 381,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 2 translation failed: rendered=603x381; bitmap=1206x761');
    expect(formatImageTranslationDiagnostic({
      stage: 'translation-empty',
      ordinal: 2,
      renderedWidth: 603,
      renderedHeight: 381,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 2 translation empty: rendered=603x381; bitmap=1206x761');
  });

  it('keeps only the newest bounded in-memory entries', () => {
    const history = new ImageTranslationDiagnosticHistory();
    for (let index = 0; index < MAX_IMAGE_TRANSLATION_DIAGNOSTICS + 2; index += 1) {
      history.append('image-discovered');
    }

    expect(history.entries).toHaveLength(MAX_IMAGE_TRANSLATION_DIAGNOSTICS);
    expect(history.entries[0]).toMatch(/^3\. image discovered$/u);
    expect(history.entries.at(-1)).toMatch(
      new RegExp(`^${MAX_IMAGE_TRANSLATION_DIAGNOSTICS + 2}\\. image discovered$`, 'u'),
    );

    history.clear();
    expect(history.entries).toEqual([]);
    expect(history.append('disabled')).toEqual(['1. disabled']);
  });
});
