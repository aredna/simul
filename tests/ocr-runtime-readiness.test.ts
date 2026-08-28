import { describe, expect, it } from 'vitest';

import {
  hasOcrRuntimeProvider,
  runtimeReadyOcrProviderOrder,
  shouldRetryOcrProviderProbe,
} from '../lib/ocr/runtime-provider-readiness';

describe('OCR host readiness', () => {
  it('admits either production OCR provider profile', () => {
    expect(hasOcrRuntimeProvider(['chrome-text-detector'])).toBe(true);
    expect(hasOcrRuntimeProvider(['tesseract'])).toBe(true);
    expect(hasOcrRuntimeProvider([])).toBe(false);
  });

  it('skips TextDetector before capture until its platform probe succeeds', () => {
    const order = [
      'tesseract',
      'chrome-text-detector',
    ] as const;

    expect(runtimeReadyOcrProviderOrder(order, new Map([
      ['chrome-text-detector', 'checking'],
    ]))).toEqual(['tesseract']);
    expect(runtimeReadyOcrProviderOrder(order, new Map([
      ['chrome-text-detector', {
        status: 'unavailable',
        providerId: 'chrome-text-detector',
        reason: 'api-missing',
      }],
    ]))).toEqual(['tesseract']);
    expect(runtimeReadyOcrProviderOrder(order, new Map([
      ['chrome-text-detector', {
        status: 'available',
        providerId: 'chrome-text-detector',
      }],
    ]))).toEqual(order);
  });

  it('retries only one inconclusive TextDetector probe', () => {
    const failed = {
      status: 'unavailable' as const,
      providerId: 'chrome-text-detector' as const,
      reason: 'probe-failed' as const,
    };
    expect(shouldRetryOcrProviderProbe(failed, false)).toBe(true);
    expect(shouldRetryOcrProviderProbe(failed, true)).toBe(false);
    expect(shouldRetryOcrProviderProbe({
      ...failed,
      reason: 'api-missing',
    }, false)).toBe(false);
    expect(shouldRetryOcrProviderProbe({
      status: 'available',
      providerId: 'chrome-text-detector',
    }, false)).toBe(false);
  });
});
