import { describe, expect, it } from 'vitest';

import {
  IMAGE_SCAN_POLICIES,
  MAX_OCR_BITMAP_DIMENSION,
  MAX_OCR_BITMAP_PIXELS,
  readImageTextResult,
  readSourceImageChange,
  readSourceImageDescriptor,
} from '../lib/ocr/contracts';
import {
  IMAGE_TEXT_PROVIDER_IDS,
  readExactImageTextProviderOrder,
  repairImageTextProviderOrder,
} from '../lib/ocr/known-provider-ids';

describe('OCR foundation contracts', () => {
  it('keeps the five provider IDs unique and in their stable canonical order', () => {
    expect(IMAGE_TEXT_PROVIDER_IDS).toEqual([
      'chrome-text-detector',
      'tesseract',
      'transformers',
      'paddleocr-wasm',
      'chromium-screen-ai',
    ]);
    expect(new Set(IMAGE_TEXT_PROVIDER_IDS).size).toBe(5);
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
      'paddleocr-wasm',
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
