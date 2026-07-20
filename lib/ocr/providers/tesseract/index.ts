import type { ImageTextProviderModule } from '../../contracts';

/** Descriptor-only registry entry; heavy runtime is offscreen-owned. */
const tesseractProviderModule: ImageTextProviderModule = Object.freeze({
  descriptor: Object.freeze({
    id: 'tesseract',
    canDetectRegions: true,
    canRecognizeText: true,
    canReturnGeometry: true,
  }),
  probe: async () => ({ status: 'available' as const }),
  prepare: async () => undefined,
  recognize: async () => {
    throw new Error('Tesseract recognition is available only through the offscreen host.');
  },
  dispose: async () => undefined,
});

export default tesseractProviderModule;
