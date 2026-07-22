import type { OffscreenOcrProviderRunnerFactory } from '../../offscreen-host';
import { TesseractWasmDirectOffscreenRunner } from './runtime';

const tesseractWasmDirectOffscreenFactory: OffscreenOcrProviderRunnerFactory =
  Object.freeze({
    id: 'tesseract-wasm-direct',
    create: () => new TesseractWasmDirectOffscreenRunner(),
  });

export default tesseractWasmDirectOffscreenFactory;
