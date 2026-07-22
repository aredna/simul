import { describe, expect, it } from 'vitest';

import { hasOcrRuntimeProvider } from '../lib/ocr/runtime-provider-readiness';

describe('OCR host readiness', () => {
  it('admits Paddle-only and direct-Wasm-only compiled profiles', () => {
    expect(hasOcrRuntimeProvider(['paddleocr-wasm'])).toBe(true);
    expect(hasOcrRuntimeProvider(['tesseract-wasm-direct'])).toBe(true);
    expect(hasOcrRuntimeProvider([])).toBe(false);
  });
});
