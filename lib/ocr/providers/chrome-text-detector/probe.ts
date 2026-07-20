import {
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
  type TimeoutCanceller,
  type TimeoutScheduler,
} from '../../../browser-scheduling';
import type { ImageTextProviderCapability } from '../../contracts';

export const CHROME_TEXT_DETECTOR_PROBE_TIMEOUT_MS = 2_000;

export interface ChromeTextDetectorProbeEnvironment {
  readonly getApi?: () => TextDetectorConstructor | undefined;
  readonly createProbeSource?: () => ImageBitmapSource;
  readonly setTimer?: TimeoutScheduler;
  readonly clearTimer?: TimeoutCanceller;
  readonly timeoutMs?: number;
}

/** Constructor presence is insufficient; prove a local detect call settles. */
export async function probeChromeTextDetector(
  environment: ChromeTextDetectorProbeEnvironment = {},
): Promise<ImageTextProviderCapability> {
  const api = (environment.getApi ?? defaultTextDetectorApi)();
  if (!api) {
    return { status: 'unavailable', reason: 'TextDetector is not exposed.' };
  }
  const operation = new AbortController();
  try {
    await withTimeout((async () => {
      const detector = api.create
        ? await api.create({ signal: operation.signal })
        : new api();
      operation.signal.throwIfAborted();
      const source = (environment.createProbeSource ?? defaultProbeSource)();
      const result = await detector.detect(source);
      operation.signal.throwIfAborted();
      if (!Array.isArray(result)) {
        throw new TypeError('Invalid TextDetector result.');
      }
    })(), operation, environment);
    return { status: 'available' };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: readableProbeFailure(error),
    };
  }
}

function defaultTextDetectorApi(): TextDetectorConstructor | undefined {
  return (globalThis as typeof globalThis & {
    TextDetector?: TextDetectorConstructor;
  }).TextDetector;
}

function defaultProbeSource(): ImageBitmapSource {
  if (typeof ImageData !== 'function') {
    throw new Error('ImageDataUnavailable');
  }
  return new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
}

function withTimeout(
  promise: Promise<void>,
  operation: AbortController,
  environment: ChromeTextDetectorProbeEnvironment,
): Promise<void> {
  const setTimer = receiverSafeTimeoutScheduler(environment.setTimer);
  const clearTimer = receiverSafeTimeoutCanceller(environment.clearTimer);
  const milliseconds = Number.isFinite(environment.timeoutMs) &&
    Number(environment.timeoutMs) > 0
    ? Math.min(Number(environment.timeoutMs), 60_000)
    : CHROME_TEXT_DETECTOR_PROBE_TIMEOUT_MS;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      callback();
    };
    const timer = setTimer(() => {
      operation.abort();
      finish(() => reject(new Error('TextDetectorProbeTimeout')));
    }, milliseconds);
    promise.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function readableProbeFailure(error: unknown): string {
  if (error instanceof Error && error.name) {
    return `TextDetector probe failed (${error.name}).`;
  }
  return 'TextDetector probe failed.';
}
