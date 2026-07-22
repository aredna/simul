import type { OffscreenOcrProviderRunnerFactory } from '../../offscreen-host';
import { ChromeTextDetectorOffscreenRunner } from './runtime';
import { probeChromeTextDetector } from './probe';

const chromeTextDetectorOffscreenFactory: OffscreenOcrProviderRunnerFactory =
  Object.freeze({
    id: 'chrome-text-detector',
    create: () => new ChromeTextDetectorOffscreenRunner(),
    probe: async () => {
      const capability = await probeChromeTextDetector();
      return capability.status === 'available'
        ? Object.freeze({
            status: 'available' as const,
            providerId: 'chrome-text-detector' as const,
          })
        : Object.freeze({
            status: 'unavailable' as const,
            providerId: 'chrome-text-detector' as const,
            reason: capability.reason === 'TextDetector is not exposed.'
              ? 'api-missing' as const
              : 'probe-failed' as const,
          });
    },
  });

export default chromeTextDetectorOffscreenFactory;
