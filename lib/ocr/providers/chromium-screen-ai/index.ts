import type { ImageTextProviderModule } from '../../contracts';

/** Reserved seam; stock extensions do not currently have a public Screen AI API. */
const chromiumScreenAiProviderModule: ImageTextProviderModule = Object.freeze({
  descriptor: Object.freeze({
    id: 'chromium-screen-ai',
    canDetectRegions: true,
    canRecognizeText: true,
    canReturnGeometry: true,
  }),
  probe: async () => ({
    status: 'unsupported' as const,
    reason: 'Chromium Screen AI has no supported extension API in this build.',
  }),
  prepare: async () => {
    throw new Error('Chromium Screen AI has no supported extension API.');
  },
  recognize: async () => {
    throw new Error('Chromium Screen AI has no supported extension API.');
  },
  dispose: async () => undefined,
});

export default chromiumScreenAiProviderModule;
