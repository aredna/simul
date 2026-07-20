import type { OffscreenOcrProviderRunnerFactory } from '../../offscreen-host';
import { ChromeTextDetectorOffscreenRunner } from './runtime';

const chromeTextDetectorOffscreenFactory: OffscreenOcrProviderRunnerFactory =
  Object.freeze({
    id: 'chrome-text-detector',
    create: () => new ChromeTextDetectorOffscreenRunner(),
  });

export default chromeTextDetectorOffscreenFactory;
