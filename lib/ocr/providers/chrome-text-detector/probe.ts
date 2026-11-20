import {
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
  type TimeoutCanceller,
  type TimeoutScheduler,
} from '../../../browser-scheduling';
import type { ImageTextProviderCapability } from '../../contracts';
import { settle } from '../../../settle';

export const CHROME_TEXT_DETECTOR_PROBE_TIMEOUT_MS = 2_000;
/**
 * The representative model the capability probe asks about. Availability is
 * queried for exactly these languages and create() is given the same list, so
 * the probe never downloads a model. The platform cannot enumerate installed
 * languages, so a build with only other languages installed probes unavailable;
 * the runner re-checks each job's own language before create().
 */
const PROBE_LANGUAGES: readonly string[] = Object.freeze(['en']);

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
      // Only an installed model may reach create(): `downloadable` and
      // `downloading` would start a platform model download on create(),
      // which the project rules out (C4). A constructor without create() has
      // no download step and is admitted by `new api()` below.
      if (api.create) {
        if (!api.availability) throw new TextDetectorModelUnavailableError();
        const availability = await api.availability({
          languages: PROBE_LANGUAGES,
        });
        operation.signal.throwIfAborted();
        if (availability !== 'available') {
          throw new TextDetectorModelUnavailableError();
        }
      }
      const detector = api.create
        ? await api.create({
            languages: PROBE_LANGUAGES,
            signal: operation.signal,
          })
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
    void (async () => {
      const result = await settle(promise);
      if (result.ok) finish(resolve);
      else finish(() => reject(result.error));
    })();
  });
}

function readableProbeFailure(error: unknown): string {
  if (error instanceof TextDetectorModelUnavailableError) {
    return 'TextDetector model is not installed.';
  }
  if (error instanceof Error && error.name) {
    return `TextDetector probe failed (${error.name}).`;
  }
  return 'TextDetector probe failed.';
}

class TextDetectorModelUnavailableError extends Error {
  override readonly name = 'TextDetectorModelUnavailableError';
}
