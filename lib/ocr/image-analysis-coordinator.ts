import {
  readImageTextResult,
  type ImageTextRegion,
  type ImageTextResult,
  type SourceImageDescriptor,
} from './contracts';
import type { ImageTextProviderId } from './known-provider-ids';
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
  readonly providerOrder?: readonly ImageTextProviderId[];
  readonly sourceLanguage?: string;
  readonly languageGroup?: string;
  readonly modelVersion?: string;
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
    const providers = effectiveRuntimeOrder(route);
    if (providers.length === 0) {
      return { status: 'failed', code: 'provider-unavailable' };
    }
    const inputKey = await this.environment.store.put(pixels.encoded);
    try {
      let lastFailure: OcrHostErrorCode = 'provider-unavailable';
      let lastEmptyResult: ImageTextResult | undefined;
      let hints: readonly ImageTextRegion[] = Object.freeze([]);
      for (const providerId of providers) {
        signal?.throwIfAborted();
        const jobId = crypto.randomUUID();
        const first = createJob(
          providerId,
          this.#clientId,
          jobId,
          0,
          inputKey,
          pixels,
          route,
          hints,
        );
        if (!first) continue;
        const firstResponse = await this.#run(first, signal);
        let response = firstResponse;
        if (shouldRetry(firstResponse)) {
          const retry = createJob(
            providerId,
            this.#clientId,
            jobId,
            1,
            inputKey,
            pixels,
            route,
            hints,
          );
          if (retry) response = await this.#run(retry, signal);
        }
        if (response.kind === 'simul:ocr-v1:error') {
          lastFailure = response.code;
          // A second host failure is shared infrastructure exhaustion, not a
          // provider-specific signal. Trying the remaining route would merely
          // repeat the same unavailable-host checks and exceed the one-retry
          // recovery boundary.
          if (response.code === 'host-unavailable' && response.attempt === 1) {
            return { status: 'failed', code: response.code };
          }
          continue;
        }
        const acceptable = acceptableSpatialResult(response.result);
        if (!acceptable) {
          hints = appendGeometryHints(hints, response.result.regions);
          lastEmptyResult = emptySpatialResult(response.result);
          lastFailure = 'recognition-failed';
          continue;
        }
        this.#remember(cacheKey, acceptable);
        return { status: 'complete', result: acceptable, cacheHit: false };
      }
      if (lastEmptyResult) {
        this.#remember(cacheKey, lastEmptyResult);
        return {
          status: 'complete',
          result: lastEmptyResult,
          cacheHit: false,
        };
      }
      return { status: 'failed', code: lastFailure };
    } finally {
      await this.environment.store.remove(inputKey).catch(() => undefined);
    }
  }

  clear(): void {
    this.#cache.clear();
  }

  #remember(cacheKey: string, result: ImageTextResult): void {
    this.#cache.delete(cacheKey);
    this.#cache.set(cacheKey, result);
    while (this.#cache.size > this.#maxCacheEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest);
    }
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
  providerId: Extract<ImageTextProviderId, 'chrome-text-detector' | 'tesseract'>,
  clientId: string,
  jobId: string,
  attempt: 0 | 1,
  inputKey: string,
  pixels: AcquiredImagePixels,
  route: ImageRecognitionRoute,
  hints: readonly ImageTextRegion[],
): OffscreenOcrJob | undefined {
  const descriptor: SourceImageDescriptor = pixels.descriptor;
  const base = {
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
    ...(hints.length > 0 ? { hints } : {}),
    preprocessingVersion: pixels.preprocessingVersion,
    schemaVersion: 1,
  } as const;
  if (providerId === 'chrome-text-detector') {
    if (!route.sourceLanguage) return undefined;
    return Object.freeze({
      ...base,
      providerId,
      languageGroup: route.sourceLanguage,
      providerVersion: 'chrome-text-detector-v1',
      modelVersion: 'platform',
    });
  }
  if (!route.languageGroup || !route.modelVersion) return undefined;
  return Object.freeze({
    ...base,
    providerId,
    languageGroup: route.languageGroup,
    providerVersion: 'tesseract.js-7.0.0',
    modelVersion: route.modelVersion,
  });
}

function recognitionCacheKey(
  pixels: AcquiredImagePixels,
  route: ImageRecognitionRoute,
): string {
  return [
    'image-text-v1',
    effectiveRuntimeOrder(route).join(','),
    route.sourceLanguage ?? '',
    route.modelVersion ?? '',
    route.languageGroup ?? '',
    pixels.preprocessingVersion,
    pixels.bitmapWidth,
    pixels.bitmapHeight,
    pixels.pixelHash,
  ].join(':');
}

function effectiveRuntimeOrder(
  route: ImageRecognitionRoute,
): readonly Extract<ImageTextProviderId, 'chrome-text-detector' | 'tesseract'>[] {
  const saved = route.providerOrder ?? ['tesseract'];
  const seen = new Set<string>();
  const result: Array<
    Extract<ImageTextProviderId, 'chrome-text-detector' | 'tesseract'>
  > = [];
  for (const providerId of saved) {
    if (
      (providerId === 'chrome-text-detector' || providerId === 'tesseract') &&
      !seen.has(providerId)
    ) {
      seen.add(providerId);
      result.push(providerId);
    }
  }
  return Object.freeze(result);
}

function acceptableSpatialResult(
  result: ImageTextResult,
): ImageTextResult | undefined {
  const regions = result.regions.filter((region) => region.text.trim().length > 0);
  if (regions.length === 0) return undefined;
  return readImageTextResult({
    ...result,
    regions,
  });
}

function emptySpatialResult(result: ImageTextResult): ImageTextResult {
  return readImageTextResult({
    ...result,
    transcript: '',
    regions: [],
  }) as ImageTextResult;
}

function appendGeometryHints(
  existing: readonly ImageTextRegion[],
  additions: readonly ImageTextRegion[],
): readonly ImageTextRegion[] {
  if (additions.length === 0 || existing.length >= 10_000) return existing;
  const result = [...existing];
  const seen = new Set(existing.map(regionGeometryKey));
  for (const region of additions) {
    const hint = Object.freeze({
      text: '',
      boundingBox: region.boundingBox,
      ...(region.polygon ? { polygon: region.polygon } : {}),
    });
    const key = regionGeometryKey(hint);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hint);
    if (result.length >= 10_000) break;
  }
  return Object.freeze(result);
}

function regionGeometryKey(region: ImageTextRegion): string {
  const box = region.boundingBox;
  return `${box.x},${box.y},${box.width},${box.height}`;
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
