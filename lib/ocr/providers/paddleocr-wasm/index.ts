import type { ImageTextProviderModule } from '../../contracts';

/** Compile-time seam for the future locally packaged PaddleOCR-Wasm engine. */
const paddleOcrProviderModule: ImageTextProviderModule = Object.freeze({
  descriptor: Object.freeze({
    id: 'paddleocr-wasm',
    canDetectRegions: true,
    canRecognizeText: true,
    canReturnGeometry: true,
  }),
  probe: async () => ({
    status: 'unsupported' as const,
    reason: 'PaddleOCR-Wasm is not compiled into this build.',
  }),
  prepare: async () => {
    throw new Error('PaddleOCR-Wasm is not compiled into this build.');
  },
  recognize: async () => {
    throw new Error('PaddleOCR-Wasm is not compiled into this build.');
  },
  dispose: async () => undefined,
});

export default paddleOcrProviderModule;
