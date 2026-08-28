import { describe, expect, it } from 'vitest';

import {
  ACCESSIBILITY_TEXT_METHOD_ID,
  IMAGE_READING_METHOD_IDS,
  enabledOcrProviderOrder,
  imageReadingExecutionPlan,
  readExactImageReadingMethodOrder,
  repairImageReadingMethodOrder,
  visibleImageReadingMethodOrder,
} from '../lib/ocr/image-reading-methods';

describe('image reading methods', () => {
  it('migrates an OCR-only order without changing provider-relative order', () => {
    expect(repairImageReadingMethodOrder(undefined, [
      'tesseract',
      'chrome-text-detector',
    ]).slice(0, 3)).toEqual([
      ACCESSIBILITY_TEXT_METHOD_ID,
      'tesseract',
      'chrome-text-detector',
    ]);
  });

  it('requires an exact complete permutation at command boundaries', () => {
    expect(readExactImageReadingMethodOrder(IMAGE_READING_METHOD_IDS))
      .toEqual(IMAGE_READING_METHOD_IDS);
    expect(readExactImageReadingMethodOrder([
      ACCESSIBILITY_TEXT_METHOD_ID,
      ACCESSIBILITY_TEXT_METHOD_ID,
    ])).toBeUndefined();
  });

  it('keeps accessibility text out of OCR runtime provider routing', () => {
    expect(enabledOcrProviderOrder(
      IMAGE_READING_METHOD_IDS,
      ['chrome-text-detector'],
    )).not.toContain(ACCESSIBILITY_TEXT_METHOD_ID);
  });

  it('renders accessibility text as the sole method in a zero-OCR build', () => {
    expect(visibleImageReadingMethodOrder(IMAGE_READING_METHOD_IDS, []))
      .toEqual([ACCESSIBILITY_TEXT_METHOD_ID]);
  });

  it('groups contiguous OCR providers without crossing semantic boundaries', () => {
    expect(imageReadingExecutionPlan([
      'chrome-text-detector',
      'tesseract',
      'accessibility-text',
      'transformers',
    ], [], [
      'chrome-text-detector',
      'tesseract',
      'transformers',
    ])).toEqual([
      {
        kind: 'ocr',
        providerOrder: ['chrome-text-detector', 'tesseract'],
      },
      { kind: 'accessibility-text' },
      {
        kind: 'ocr',
        providerOrder: ['transformers'],
      },
    ]);
  });

  it('removes disabled semantics before grouping enabled OCR methods', () => {
    expect(imageReadingExecutionPlan([
      'chrome-text-detector',
      'accessibility-text',
      'tesseract',
    ], ['accessibility-text'], [
      'chrome-text-detector',
      'tesseract',
    ])).toEqual([
      {
        kind: 'ocr',
        providerOrder: ['chrome-text-detector', 'tesseract'],
      },
    ]);
  });
});
