import type { ImageTextProviderModule } from '../../contracts';

/** Compile-time seam for the future locally packaged Transformers.js engine. */
const transformersProviderModule: ImageTextProviderModule = Object.freeze({
  descriptor: Object.freeze({
    id: 'transformers',
    canDetectRegions: false,
    canRecognizeText: true,
    canReturnGeometry: false,
  }),
  probe: async () => ({
    status: 'unsupported' as const,
    reason: 'Transformers.js is not compiled into this build.',
  }),
  prepare: async () => {
    throw new Error('Transformers.js is not compiled into this build.');
  },
  recognize: async () => {
    throw new Error('Transformers.js is not compiled into this build.');
  },
  dispose: async () => undefined,
});

export default transformersProviderModule;
