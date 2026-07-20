import type { ImageTextProviderModule } from '../../contracts';
import { probeChromeTextDetector } from './probe';

/** Small descriptor/probe entry; recognition itself is offscreen-owned. */
const chromeTextDetectorProviderModule: ImageTextProviderModule = Object.freeze({
  descriptor: Object.freeze({
    id: 'chrome-text-detector',
    canDetectRegions: true,
    canRecognizeText: true,
    canReturnGeometry: true,
  }),
  probe: async () => probeChromeTextDetector(),
  prepare: async () => undefined,
  recognize: async () => {
    throw new Error(
      'Chrome TextDetector recognition is available only through the offscreen host.',
    );
  },
  dispose: async () => undefined,
});

export default chromeTextDetectorProviderModule;
