import type { ImageTextProviderModule } from '../../contracts';

/** Descriptor-only registry entry; the local SDK/runtime stays offscreen-owned. */
const paddleOcrProviderModule: ImageTextProviderModule = Object.freeze({
  descriptor: Object.freeze({
    id: 'paddleocr-wasm',
    canDetectRegions: true,
    canRecognizeText: true,
    canReturnGeometry: true,
  }),
  probe: async () => ({ status: 'available' as const }),
  prepare: async () => undefined,
  recognize: async () => {
    throw new Error('PaddleOCR.js recognition is available only through the offscreen host.');
  },
  dispose: async () => undefined,
});

export default paddleOcrProviderModule;
