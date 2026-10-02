import { describe, expect, it } from 'vitest';

import {
  IMAGE_SCAN_POLICIES,
  MAX_IMAGE_TEXT_REGION_WORDS,
  MAX_IMAGE_TEXT_RESULT_WORDS,
  MAX_IMAGE_TEXT_WORD_LENGTH,
  MAX_OCR_BITMAP_DIMENSION,
  MAX_OCR_BITMAP_PIXELS,
  readImageTextRegionHints,
  readImageTextResult,
  readSourceImageChange,
  readSourceImageDescriptor,
} from '../lib/ocr/contracts';
import {
  IMAGE_TEXT_PROVIDER_IDS,
  readExactDisabledImageTextProviderIds,
  readExactImageTextProviderOrder,
  repairDisabledImageTextProviderIds,
  repairImageTextProviderOrder,
} from '../lib/ocr/known-provider-ids';

describe('OCR foundation contracts', () => {
  it('keeps provider IDs unique and in their stable production priority order', () => {
    expect(IMAGE_TEXT_PROVIDER_IDS).toEqual([
      'chrome-text-detector',
      'tesseract',
      'transformers',
      'chromium-screen-ai',
    ]);
    expect(new Set(IMAGE_TEXT_PROVIDER_IDS).size).toBe(4);
    expect(IMAGE_SCAN_POLICIES).toEqual([
      'visible-first-background-prescan',
      'visible-only',
      'eager-all',
    ]);
  });

  it('repairs persisted order but rejects malformed command order', () => {
    expect(repairImageTextProviderOrder([
      'transformers',
      'unknown',
      'transformers',
      'tesseract',
    ])).toEqual([
      'transformers',
      'tesseract',
      'chrome-text-detector',
      'chromium-screen-ai',
    ]);
    expect(repairImageTextProviderOrder(undefined)).toEqual(
      IMAGE_TEXT_PROVIDER_IDS,
    );
    expect(readExactImageTextProviderOrder(IMAGE_TEXT_PROVIDER_IDS)).toEqual(
      IMAGE_TEXT_PROVIDER_IDS,
    );
    expect(readExactImageTextProviderOrder([
      ...IMAGE_TEXT_PROVIDER_IDS.slice(0, -1),
      'tesseract',
    ])).toBeUndefined();
    expect(repairDisabledImageTextProviderIds([
      'tesseract',
      'unknown',
      'tesseract',
      'chrome-text-detector',
    ])).toEqual(['tesseract', 'chrome-text-detector']);
    expect(readExactDisabledImageTextProviderIds([])).toEqual([]);
    expect(readExactDisabledImageTextProviderIds([
      'tesseract',
      'tesseract',
    ])).toBeUndefined();
  });

  it('normalizes bounded spatial output and rejects extras or out-of-bitmap geometry', () => {
    const valid = {
      providerId: 'tesseract',
      bitmapWidth: 200,
      bitmapHeight: 100,
      transcript: 'hello',
      transcriptConfidence: 0.9,
      geometryConfidence: 0.8,
      regions: [{
        text: 'hello',
        confidence: 0.9,
        boundingBox: { x: 10, y: 20, width: 80, height: 30 },
        polygon: [
          { x: 10, y: 20 },
          { x: 90, y: 20 },
          { x: 90, y: 50 },
          { x: 10, y: 50 },
        ],
      }],
    };

    expect(readImageTextResult(valid)).toEqual(valid);
    expect(readImageTextResult({ ...valid, pixels: 'forbidden' })).toBeUndefined();
    expect(readImageTextResult({
      ...valid,
      regions: [{
        text: 'bad',
        boundingBox: { x: 190, y: 20, width: 20, height: 10 },
      }],
    })).toBeUndefined();
    expect(readImageTextResult({ ...valid, bitmapWidth: 200.5 })).toBeUndefined();
    expect(readImageTextResult({
      ...valid,
      bitmapWidth: MAX_OCR_BITMAP_DIMENSION + 1,
    })).toBeUndefined();
    expect(readImageTextResult({
      ...valid,
      bitmapWidth: Math.sqrt(MAX_OCR_BITMAP_PIXELS) + 1,
      bitmapHeight: Math.sqrt(MAX_OCR_BITMAP_PIXELS),
    })).toBeUndefined();
  });

  it('carries a region\'s words with bounded boxes and rejects malformed ones (D121)', () => {
    const word = (text: string, x: number) => ({
      text,
      boundingBox: { x, y: 20, width: 30, height: 20 },
    });
    const region = (words: unknown) => ({
      text: 'hello world',
      confidence: 0.9,
      boundingBox: { x: 10, y: 20, width: 80, height: 20 },
      words,
    });
    const result = (regions: readonly unknown[]) => ({
      providerId: 'tesseract',
      bitmapWidth: 200,
      bitmapHeight: 100,
      transcript: 'hello world',
      regions,
    });
    const valid = result([region([word('hello', 10), word('world', 50)])]);

    const read = readImageTextResult(valid, true);
    expect(read).toEqual(valid);
    // Words nobody asked for: the result is not accepted.
    expect(readImageTextResult(valid)).toBeUndefined();
    expect(Object.isFrozen(read?.regions[0]?.words)).toBe(true);
    expect(Object.isFrozen(read?.regions[0]?.words?.[0])).toBe(true);
    // A region without words is as before; other providers send none.
    expect(readImageTextResult(result([{
      text: 'hello world',
      boundingBox: { x: 10, y: 20, width: 80, height: 20 },
    }]))?.regions[0]).not.toHaveProperty('words');

    for (const words of [
      'hello world',
      [],
      // One word says nothing a line does not.
      [word('hello', 10)],
      [word('hello', 10), word('', 50)],
      [word('hello', 10), word('x'.repeat(MAX_IMAGE_TEXT_WORD_LENGTH + 1), 50)],
      // Outside the bitmap.
      [word('hello', 10), word('world', 190)],
      [word('hello', 10), { ...word('world', 50), confidence: 0.9 }],
      [word('hello', 10), { text: 'world' }],
      Array.from({ length: MAX_IMAGE_TEXT_REGION_WORDS + 1 }, () => word('a', 10)),
    ]) {
      expect(readImageTextResult(result([region(words)]), true)).toBeUndefined();
    }

    // The words of one result are bounded too.
    const full = Array.from({ length: MAX_IMAGE_TEXT_REGION_WORDS }, () => word('a', 10));
    const regions = Math.ceil(MAX_IMAGE_TEXT_RESULT_WORDS / MAX_IMAGE_TEXT_REGION_WORDS);
    expect(readImageTextResult(result(
      Array.from({ length: regions - 1 }, () => region(full)),
    ), true)).toBeDefined();
    expect(readImageTextResult(result(
      Array.from({ length: regions }, () => region(full)),
    ), true)).toBeUndefined();

    // A geometry hint never carries words.
    expect(readImageTextRegionHints([{
      text: '',
      boundingBox: { x: 10, y: 20, width: 80, height: 20 },
    }], 200, 100)).toHaveLength(1);
    expect(readImageTextRegionHints(
      [region([word('hello', 10), word('world', 50)])],
      200,
      100,
    )).toBeUndefined();
  });

  it('strictly copies source descriptors and rejects malformed change envelopes', () => {
    const descriptor = {
      document: {
        sessionId: 'session-a',
        pageEpoch: 1,
        generation: 1,
        documentId: 'document-a',
        frameId: 0,
      },
      nodeId: 7,
      sourceKind: 'img',
      contentRevision: 1,
      observationRevision: 1,
      visibility: 'visible',
      connected: true,
      renderedWidth: 200,
      renderedHeight: 100,
    };

    expect(readSourceImageDescriptor(descriptor)).toEqual(descriptor);
    expect(readSourceImageDescriptor({ ...descriptor, src: 'private' }))
      .toBeUndefined();
    expect(readSourceImageDescriptor({
      ...descriptor,
      document: { ...descriptor.document, generation: 2 },
    })).toBeUndefined();
    expect(readSourceImageChange({ kind: 'upsert', descriptor })).toEqual({
      kind: 'upsert',
      descriptor,
    });
    expect(readSourceImageChange({
      kind: 'remove',
      document: descriptor.document,
      nodeId: 7,
      contentRevision: 2,
      observationRevision: 2,
      extra: true,
    })).toBeUndefined();
  });
});
