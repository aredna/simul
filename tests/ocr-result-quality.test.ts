import { describe, expect, it } from 'vitest';

import type { ImageTextResult } from '../lib/ocr/contracts';
import {
  DEFAULT_OCR_MINIMUM_CONFIDENCE,
  filterImageTextResult,
  isOcrMinimumConfidence,
  MIN_OCR_REGION_CONFIDENCE,
  OCR_MINIMUM_CONFIDENCE_OPTIONS,
  repairOcrMinimumConfidence,
} from '../lib/ocr/result-quality';

describe('OCR result quality', () => {
  it('does not accept confidence-free text without independent corroboration', () => {
    const filtered = filterImageTextResult(result([
      region('English'),
      region('日本語'),
      region('한국어'),
      region('Русский'),
      region('العربية'),
      region('123'),
    ]));

    expect(filtered.hasAcceptedText).toBe(false);
    expect(filtered.result.regions).toEqual([]);
    expect(filtered.quality).toEqual({
      candidateRegions: 6,
      acceptedRegions: 0,
      corroboratedRegions: 0,
      uncertainRegions: 6,
      rejectedBlankRegions: 0,
      rejectedPunctuationRegions: 0,
      rejectedLowConfidenceRegions: 0,
      rejectedUncorroboratedRegions: 6,
    });
  });

  it('accepts scored text at the selected threshold and rejects noise', () => {
    const filtered = filterImageTextResult(result([
      region('  '),
      region('…!?—'),
      region('©™'),
      region('uncertain', MIN_OCR_REGION_CONFIDENCE - 0.01),
      region('accepted', DEFAULT_OCR_MINIMUM_CONFIDENCE),
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
      corroboratedRegions: 0,
      uncertainRegions: 0,
      rejectedBlankRegions: 1,
      rejectedPunctuationRegions: 2,
      rejectedLowConfidenceRegions: 1,
      rejectedUncorroboratedRegions: 0,
    });
  });

  it('treats scored regions between 0.25 and the selected threshold as uncertain', () => {
    const filtered = filterImageTextResult(result([
      region('medium', 0.65),
      region('strong', 0.8),
    ]), { minimumConfidence: 0.8 });

    expect(filtered.result.regions.map(({ text }) => text)).toEqual(['strong']);
    expect(filtered.quality).toMatchObject({
      acceptedRegions: 1,
      uncertainRegions: 1,
      rejectedUncorroboratedRegions: 1,
    });
  });

  it('accepts uncertain text only when another provider agrees on text and geometry', () => {
    const primary = result([
      region('Ａ   B', undefined, { x: 10, y: 10, width: 80, height: 20 }),
    ], 'chrome-text-detector');
    const corroborator = result([
      region('A B', 0.9, { x: 12, y: 10, width: 78, height: 20 }),
    ], 'tesseract');
    const filtered = filterImageTextResult(primary, {
      minimumConfidence: 0.65,
      corroboratingResults: [corroborator],
    });

    expect(filtered.result.regions.map(({ text }) => text)).toEqual(['Ａ   B']);
    expect(filtered.quality).toMatchObject({
      acceptedRegions: 1,
      corroboratedRegions: 1,
      uncertainRegions: 1,
      rejectedUncorroboratedRegions: 0,
    });

    const sameProvider = filterImageTextResult(primary, {
      minimumConfidence: 0.65,
      corroboratingResults: [{ ...corroborator, providerId: 'chrome-text-detector' }],
    });
    const distantBox = filterImageTextResult(primary, {
      minimumConfidence: 0.65,
      corroboratingResults: [result([
        region('A B', 0.9, { x: 200, y: 100, width: 80, height: 20 }),
      ], 'tesseract')],
    });
    const belowFloor = filterImageTextResult(primary, {
      minimumConfidence: 0.65,
      corroboratingResults: [result([
        region(
          'A B',
          MIN_OCR_REGION_CONFIDENCE - 0.01,
          { x: 12, y: 10, width: 78, height: 20 },
        ),
      ], 'tesseract')],
    });
    const confidenceFree = filterImageTextResult(primary, {
      minimumConfidence: 0.65,
      corroboratingResults: [result([
        region('A B', undefined, { x: 12, y: 10, width: 78, height: 20 }),
      ], 'tesseract')],
    });
    expect(sameProvider.hasAcceptedText).toBe(false);
    expect(distantBox.hasAcceptedText).toBe(false);
    expect(belowFloor.hasAcceptedText).toBe(false);
    expect(confidenceFree.hasAcceptedText).toBe(true);
  });

  it('derives transcript confidence only from fully scored accepted regions', () => {
    const scored = filterImageTextResult({
      ...result([
        region('accepted one', 0.8),
        region('rejected', 0.1),
        region('accepted two', 0.9),
      ]),
      transcriptConfidence: 0.42,
    });

    expect(scored.result.transcriptConfidence).toBeCloseTo(0.85);

    const primary = {
      ...result([region('matched')], 'chrome-text-detector'),
      transcriptConfidence: 0.99,
    };
    const acceptedWithoutScores = filterImageTextResult(primary, {
      minimumConfidence: 0.65,
      corroboratingResults: [result([
        region('matched', 0.9),
      ], 'tesseract')],
    });

    expect(acceptedWithoutScores.hasAcceptedText).toBe(true);
    expect(acceptedWithoutScores.result).not.toHaveProperty(
      'transcriptConfidence',
    );
  });

  it('exposes only the persisted 0.25–0.95 threshold steps', () => {
    expect(OCR_MINIMUM_CONFIDENCE_OPTIONS).toHaveLength(15);
    expect(OCR_MINIMUM_CONFIDENCE_OPTIONS.at(0)).toBe(0.25);
    expect(OCR_MINIMUM_CONFIDENCE_OPTIONS.at(-1)).toBe(0.95);
    expect(isOcrMinimumConfidence(0.65)).toBe(true);
    expect(isOcrMinimumConfidence(0.66)).toBe(false);
    expect(repairOcrMinimumConfidence(0.66)).toBe(0.65);
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

  it('bounds accepted transcript construction at the protocol limit', () => {
    const filtered = filterImageTextResult(result([
      region('a'.repeat(999_999), 0.9),
      region('second region', 0.9),
    ]));

    expect(filtered.result.transcript).toHaveLength(1_000_000);
    expect(filtered.result.transcript.endsWith('\n')).toBe(true);
    expect(filtered.result.regions).toHaveLength(2);
  });
});

function result(
  regions: ImageTextResult['regions'],
  providerId: ImageTextResult['providerId'] = 'tesseract',
): ImageTextResult {
  return {
    providerId,
    bitmapWidth: 400,
    bitmapHeight: 200,
    transcript: regions.map(({ text }) => text).join('\n'),
    regions,
  };
}

function region(
  text: string,
  confidence?: number,
  boundingBox = { x: 10, y: 12, width: 80, height: 20 },
) {
  return {
    text,
    ...(confidence !== undefined ? { confidence } : {}),
    boundingBox,
  };
}
