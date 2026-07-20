import {
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
  type TimeoutCanceller,
  type TimeoutScheduler,
} from '../../../browser-scheduling';
import type { ImageTextResult } from '../../contracts';
import type { OffscreenOcrProviderRunner } from '../../offscreen-host';
import type { OffscreenOcrJob } from '../../offscreen-protocol';
import { normalizeChromeTextDetection } from './normalize';

export const CHROME_TEXT_DETECTOR_JOB_TIMEOUT_MS = 10_000;
export const CHROME_TEXT_DETECTOR_RUNTIME_MARKER =
  'simul-chrome-text-detector-offscreen-v1';

export interface ChromeTextDetectorRuntimeEnvironment {
  readonly getApi?: () => TextDetectorConstructor | undefined;
  readonly decode?: (encoded: Blob) => Promise<ImageBitmap>;
  readonly setTimer?: TimeoutScheduler;
  readonly clearTimer?: TimeoutCanceller;
  readonly jobTimeoutMs?: number;
}

/** Window/offscreen adapter for Chrome's experimental Shape Detection API. */
export class ChromeTextDetectorOffscreenRunner
implements OffscreenOcrProviderRunner {
  readonly #getApi: () => TextDetectorConstructor | undefined;
  readonly #decode: (encoded: Blob) => Promise<ImageBitmap>;
  readonly #setTimer: TimeoutScheduler;
  readonly #clearTimer: TimeoutCanceller;
  readonly #jobTimeoutMs: number;
  #detector: TextDetectorInstance | undefined;
  #language: string | undefined;
  #disposed = false;

  constructor(environment: ChromeTextDetectorRuntimeEnvironment = {}) {
    this.#getApi = environment.getApi ?? defaultTextDetectorApi;
    this.#decode = environment.decode ?? ((encoded) => createImageBitmap(encoded));
    this.#setTimer = receiverSafeTimeoutScheduler(environment.setTimer);
    this.#clearTimer = receiverSafeTimeoutCanceller(environment.clearTimer);
    this.#jobTimeoutMs = positiveTimeout(environment.jobTimeoutMs);
  }

  async recognize(
    job: OffscreenOcrJob,
    encoded: Blob,
    signal: AbortSignal,
  ): Promise<ImageTextResult> {
    if (this.#disposed || job.providerId !== 'chrome-text-detector') {
      throw new ProviderUnavailableError();
    }
    signal.throwIfAborted();
    const operation = new AbortController();
    const onAbort = (): void => operation.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await withDeadline(
        this.#recognize(job, encoded, operation.signal),
        this.#jobTimeoutMs,
        signal,
        operation,
        this.#setTimer,
        this.#clearTimer,
      );
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  cancelActive(): Promise<void> {
    // detect() has no cancellation argument. The host aborts its bounded race
    // and ignores a late platform result.
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.#disposed = true;
    this.#detector = undefined;
    this.#language = undefined;
    return Promise.resolve();
  }

  async #recognize(
    job: Extract<OffscreenOcrJob, { providerId: 'chrome-text-detector' }>,
    encoded: Blob,
    signal: AbortSignal,
  ): Promise<ImageTextResult> {
    const detector = await this.#detectorFor(job.languageGroup, signal);
    signal.throwIfAborted();
    const bitmap = await this.#decode(encoded);
    let bitmapClosed = false;
    const closeBitmap = (): void => {
      if (bitmapClosed) return;
      bitmapClosed = true;
      bitmap.close();
    };
    const onAbort = (): void => {
      closeBitmap();
      // TextDetector.detect() exposes no cancellation primitive. Do not hand
      // its still-running instance to the next bounded job after this one has
      // been abandoned. A late result may finish, but it no longer owns the
      // provider cache.
      if (this.#detector === detector) {
        this.#detector = undefined;
        this.#language = undefined;
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      if (
        bitmap.width !== job.bitmapWidth ||
        bitmap.height !== job.bitmapHeight
      ) throw new InvalidTextDetectorOutputError();
      const detections = await detector.detect(bitmap);
      signal.throwIfAborted();
      const normalized = normalizeChromeTextDetection(
        detections,
        job.bitmapWidth,
        job.bitmapHeight,
      );
      if (!normalized) throw new InvalidTextDetectorOutputError();
      return normalized;
    } finally {
      signal.removeEventListener('abort', onAbort);
      closeBitmap();
    }
  }

  async #detectorFor(
    language: string,
    signal: AbortSignal,
  ): Promise<TextDetectorInstance> {
    if (this.#detector && this.#language === language) return this.#detector;
    const api = this.#getApi();
    if (!api) throw new ProviderUnavailableError();
    if (api.availability) {
      let availability: TextDetectorAvailability;
      try {
        availability = await api.availability({ languages: [language] });
      } catch {
        throw new ProviderUnavailableError();
      }
      signal.throwIfAborted();
      if (availability === 'unavailable') throw new UnsupportedLanguageError();
      if (![
        'available',
        'downloadable',
        'downloading',
      ].includes(availability)) throw new ProviderUnavailableError();
    }
    let detector: TextDetectorInstance;
    try {
      detector = await createDetector(api, [language], signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderUnavailableError();
    }
    signal.throwIfAborted();
    this.#detector = detector;
    this.#language = language;
    return detector;
  }
}

async function createDetector(
  api: TextDetectorConstructor,
  languages: readonly string[],
  signal: AbortSignal | undefined,
): Promise<TextDetectorInstance> {
  if (api.create) {
    return api.create({
      ...(languages.length > 0 ? { languages } : {}),
      ...(signal ? { signal } : {}),
    });
  }
  return new api();
}

function defaultTextDetectorApi(): TextDetectorConstructor | undefined {
  return (globalThis as typeof globalThis & {
    TextDetector?: TextDetectorConstructor;
  }).TextDetector;
}

function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  signal: AbortSignal,
  operation: AbortController,
  setTimer: TimeoutScheduler,
  clearTimer: TimeoutCanceller,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(
      new DOMException('Text detection cancelled.', 'AbortError'),
    ));
    const timer = setTimer(() => {
      operation.abort();
      finish(() => reject(new TextDetectorTimeoutError()));
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function positiveTimeout(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.min(Number(value), 10 * 60_000)
    : CHROME_TEXT_DETECTOR_JOB_TIMEOUT_MS;
}

export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';

  constructor() {
    super(`${CHROME_TEXT_DETECTOR_RUNTIME_MARKER} is unavailable.`);
  }
}

export class UnsupportedLanguageError extends Error {
  override readonly name = 'UnsupportedLanguageError';
}

class TextDetectorTimeoutError extends Error {
  override readonly name = 'TextDetectorTimeoutError';
}

class InvalidTextDetectorOutputError extends Error {
  override readonly name = 'InvalidTextDetectorOutputError';
}
