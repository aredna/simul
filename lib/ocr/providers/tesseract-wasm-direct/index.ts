import type { ImageTextProviderModule } from '../../contracts';

/** Descriptor-only registry entry; the direct runtime stays offscreen-owned. */
const tesseractWasmDirectProviderModule: ImageTextProviderModule = Object.freeze({
  descriptor: Object.freeze({
    id: 'tesseract-wasm-direct',
    canDetectRegions: true,
    canRecognizeText: true,
    canReturnGeometry: true,
  }),
  probe: async () => ({ status: 'available' as const }),
  prepare: async () => undefined,
  recognize: async () => {
    throw new Error(
      'Direct Tesseract-Wasm recognition is available only through the offscreen host.',
    );
  },
  dispose: async () => undefined,
});

export default tesseractWasmDirectProviderModule;
