import type { OffscreenOcrProviderRunnerFactory } from '../../offscreen-host';
import { PaddleOcrOffscreenRunner } from './runtime';

const paddleOcrOffscreenFactory: OffscreenOcrProviderRunnerFactory =
  Object.freeze({
    id: 'paddleocr-wasm',
    create: () => new PaddleOcrOffscreenRunner(),
  });

export default paddleOcrOffscreenFactory;
