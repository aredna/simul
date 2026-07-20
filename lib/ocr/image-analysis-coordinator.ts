import type { ImageTextResult, SourceImageDescriptor } from './contracts';
import {
  readEnsureOcrHostResponse,
  readOffscreenOcrResponse,
  type OffscreenOcrJob,
  type OffscreenOcrResponse,
  type OcrHostErrorCode,
} from './offscreen-protocol';
import type { AcquiredImagePixels } from './pixel-acquisition';
import type { TransientImageInputStore } from './transient-image-store';

export const MAX_RECOGNITION_CACHE_ENTRIES = 128;

export interface ImageRecognitionRoute {
  readonly languageGroup: string;
  readonly modelVersion: string;
}

export type ImageRecognitionResult =
  | {
      readonly status: 'complete';
      readonly result: ImageTextResult;
      readonly cacheHit: boolean;
    }
  | { readonly status: 'failed'; readonly code: OcrHostErrorCode };

export interface ImageRecognitionCoordinatorEnvironment {
  readonly store: TransientImageInputStore;
  readonly sendMessage: (message: unknown) => Promise<unknown>;
  readonly clientId?: string;
  readonly maxCacheEntries?: number;
}

/**
 * Owns transient pixel handoff, infrastructure retry, and the recognition-only
 * memory cache. Overlay translations remain in the separate text memory.
 */
export class ImageRecognitionCoordinator {
  readonly #clientId: string;
  readonly #maxCacheEntries: number;
  readonly #cache = new Map<string, ImageTextResult>();

  constructor(private readonly environment: ImageRecognitionCoordinatorEnvironment) {
    this.#clientId = environment.clientId ?? crypto.randomUUID();
    this.#maxCacheEntries = positiveInteger(
      environment.maxCacheEntries,
      MAX_RECOGNITION_CACHE_ENTRIES,
    );
  }

  async recognize(
    pixels: AcquiredImagePixels,
    route: ImageRecognitionRoute,
    signal?: AbortSignal,
  ): Promise<ImageRecognitionResult> {
    signal?.throwIfAborted();
    const cacheKey = recognitionCacheKey(pixels, route);
    const cached = this.#cache.get(cacheKey);
    if (cached) {
      this.#cache.delete(cacheKey);
      this.#cache.set(cacheKey, cached);
      return { status: 'complete', result: cached, cacheHit: true };
    }
    const inputKey = await this.environment.store.put(pixels.encoded);
    const jobId = crypto.randomUUID();
    try {
      const first = createJob(
        this.#clientId,
        jobId,
        0,
        inputKey,
        pixels,
        route,
      );
      const firstResponse = await this.#run(first, signal);
      const response = shouldRetry(firstResponse)
        ? await this.#run(createJob(
            this.#clientId,
            jobId,
            1,
            inputKey,
            pixels,
            route,
          ), signal)
        : firstResponse;
      if (response.kind === 'simul:ocr-v1:error') {
        return { status: 'failed', code: response.code };
      }
      this.#cache.set(cacheKey, response.result);
      while (this.#cache.size > this.#maxCacheEntries) {
        const oldest = this.#cache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.#cache.delete(oldest);
      }
      return { status: 'complete', result: response.result, cacheHit: false };
    } finally {
      await this.environment.store.remove(inputKey).catch(() => undefined);
    }
  }

  clear(): void {
    this.#cache.clear();
  }

  async #run(
    job: OffscreenOcrJob,
    signal?: AbortSignal,
  ): Promise<OffscreenOcrResponse> {
    signal?.throwIfAborted();
    let readyMessage: unknown;
    try {
      readyMessage = await raceAbort(
        this.environment.sendMessage({
          kind: 'simul:ocr-v1:ensure-host',
          version: 1,
        }),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return hostError(job, 'host-unavailable');
    }
    signal?.throwIfAborted();
    const ready = readEnsureOcrHostResponse(readyMessage);
    if (!ready?.ready) return hostError(job, 'host-unavailable');
    let abortSent = false;
    const onAbort = (): void => {
      abortSent = true;
      void this.environment.sendMessage({
        kind: 'simul:ocr-v1:cancel',
        version: 1,
        clientId: job.clientId,
        jobId: job.jobId,
      }).catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) {
        onAbort();
        signal.throwIfAborted();
      }
      let raw: unknown;
      try {
        raw = await this.environment.sendMessage({
          kind: 'simul:ocr-v1:run',
          version: 1,
          job,
        });
      } catch {
        return hostError(job, 'host-unavailable');
      }
      if (abortSent || signal?.aborted) {
        throw new DOMException('Image recognition cancelled.', 'AbortError');
      }
      return readOffscreenOcrResponse(raw, job) ?? hostError(job, 'host-unavailable');
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function createBrowserImageRecognitionCoordinator(
  store: TransientImageInputStore,
): ImageRecognitionCoordinator {
  return new ImageRecognitionCoordinator({
    store,
    sendMessage: (message) => browser.runtime.sendMessage(message),
  });
}

function createJob(
  clientId: string,
  jobId: string,
  attempt: 0 | 1,
  inputKey: string,
  pixels: AcquiredImagePixels,
  route: ImageRecognitionRoute,
): OffscreenOcrJob {
  const descriptor: SourceImageDescriptor = pixels.descriptor;
  return Object.freeze({
    jobId,
    clientId,
    attempt,
    document: descriptor.document,
    nodeId: descriptor.nodeId,
    contentRevision: descriptor.contentRevision,
    observationRevision: descriptor.observationRevision,
    inputKey,
    pixelHash: pixels.pixelHash,
    bitmapWidth: pixels.bitmapWidth,
    bitmapHeight: pixels.bitmapHeight,
    providerId: 'tesseract',
    languageGroup: route.languageGroup,
    providerVersion: 'tesseract.js-7.0.0',
    modelVersion: route.modelVersion,
    preprocessingVersion: 'visible-crop-v1',
    schemaVersion: 1,
  });
}

function recognitionCacheKey(
  pixels: AcquiredImagePixels,
  route: ImageRecognitionRoute,
): string {
  return [
    'image-text-v1',
    'tesseract.js-7.0.0',
    route.modelVersion,
    route.languageGroup,
    'visible-crop-v1',
    pixels.bitmapWidth,
    pixels.bitmapHeight,
    pixels.pixelHash,
  ].join(':');
}

function shouldRetry(response: OffscreenOcrResponse): boolean {
  return response.kind === 'simul:ocr-v1:error' &&
    (response.code === 'host-unavailable' || response.code === 'worker-lost');
}

function hostError(
  job: OffscreenOcrJob,
  code: OcrHostErrorCode,
): Extract<OffscreenOcrResponse, { kind: 'simul:ocr-v1:error' }> {
  return {
    kind: 'simul:ocr-v1:error',
    version: 1,
    jobId: job.jobId,
    clientId: job.clientId,
    attempt: job.attempt,
    code,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), 10_000)
    : fallback;
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(
      new DOMException('Image recognition cancelled.', 'AbortError'),
    ));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
