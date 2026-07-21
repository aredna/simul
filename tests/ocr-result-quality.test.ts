import { describe, expect, it } from 'vitest';

import type { ImageTextResult } from '../lib/ocr/contracts';
import {
  filterImageTextResult,
  MIN_OCR_REGION_CONFIDENCE,
} from '../lib/ocr/result-quality';

describe('OCR result quality', () => {
  it('accepts meaningful multilingual text when confidence is absent', () => {
    const filtered = filterImageTextResult(result([
      region('English'),
      region('日本語'),
      region('한국어'),
      region('Русский'),
      region('العربية'),
      region('123'),
    ]));

    expect(filtered.hasAcceptedText).toBe(true);
    expect(filtered.result.regions.map(({ text }) => text)).toEqual([
      'English',
      '日本語',
      '한국어',
      'Русский',
      'العربية',
      '123',
    ]);
    expect(filtered.quality).toEqual({
      candidateRegions: 6,
      acceptedRegions: 6,
      rejectedBlankRegions: 0,
      rejectedPunctuationRegions: 0,
      rejectedLowConfidenceRegions: 0,
    });
  });

  it('rejects only blank, punctuation-only, and supplied low-confidence regions', () => {
    const filtered = filterImageTextResult(result([
      region('  '),
      region('…!?—'),
      region('©™'),
      region('uncertain', MIN_OCR_REGION_CONFIDENCE - 0.01),
      region('accepted', MIN_OCR_REGION_CONFIDENCE),
      region('$10', 0.9),
    ]));

    expect(filtered.result.regions.map(({ text }) => text)).toEqual([
      'accepted',
      '$10',
    ]);
    expect(filtered.result.transcript).toBe('accepted\n$10');
    expect(filtered.quality).toEqual({
      candidateRegions: 6,
      acceptedRegions: 2,
      rejectedBlankRegions: 1,
      rejectedPunctuationRegions: 2,
      rejectedLowConfidenceRegions: 1,
    });
  });

  it('returns a validated empty spatial result when every candidate is noise', () => {
    const filtered = filterImageTextResult(result([
      region('---'),
      region('noise', 0.01),
    ]));

    expect(filtered.hasAcceptedText).toBe(false);
    expect(filtered.result).toMatchObject({ transcript: '', regions: [] });
    expect(filtered.quality.acceptedRegions).toBe(0);
  });
});

function result(regions: ImageTextResult['regions']): ImageTextResult {
  return {
    providerId: 'tesseract',
    bitmapWidth: 400,
    bitmapHeight: 200,
    transcript: regions.map(({ text }) => text).join('\n'),
    regions,
  };
}

function region(text: string, confidence?: number) {
  return {
    text,
    ...(confidence !== undefined ? { confidence } : {}),
    boundingBox: { x: 10, y: 12, width: 80, height: 20 },
  };
}
