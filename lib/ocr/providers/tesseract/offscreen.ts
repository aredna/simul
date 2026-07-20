import type { OffscreenOcrProviderRunnerFactory } from '../../offscreen-host';
import { TesseractOffscreenRunner } from './runtime';

const tesseractOffscreenFactory: OffscreenOcrProviderRunnerFactory =
  Object.freeze({
    id: 'tesseract',
    create: () => new TesseractOffscreenRunner(),
  });

export default tesseractOffscreenFactory;
