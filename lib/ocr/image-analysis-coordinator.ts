import {
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
import {
  emptyImageTextQualitySummary,
  filterImageTextResult,
  mergeImageTextQualitySummaries,
  type ImageTextQualitySummary,
} from './result-quality';
import type { TransientImageInputStore } from './transient-image-store';

export const MAX_RECOGNITION_CACHE_ENTRIES = 128;
export const MAX_RECOGNITION_CACHE_WEIGHT = 1_000_000;
export const MAX_RECOGNITION_IN_FLIGHT = 2;
export const RECOGNITION_CACHE_REGION_OVERHEAD = 32;

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
      readonly cacheAccess?: ImageRecognitionCacheAccess;
      readonly cacheStats?: ImageRecognitionCacheStats;
      readonly quality?: ImageTextQualitySummary;
    }
  | {
      readonly status: 'failed';
      readonly code: OcrHostErrorCode;
      readonly cacheAccess?: ImageRecognitionCacheAccess;
      readonly cacheStats?: ImageRecognitionCacheStats;
    };

export type ImageRecognitionCacheAccess = 'hit' | 'miss' | 'join';

export interface ImageRecognitionCacheStats {
  readonly entries: number;
  readonly weight: number;
  readonly hits: number;
  readonly misses: number;
  readonly inFlightJoins: number;
  readonly loads: number;
}

export interface ImageRecognitionCoordinatorEnvironment {
  readonly store: TransientImageInputStore;
  readonly sendMessage: (message: unknown) => Promise<unknown>;
  readonly clientId?: string;
  readonly maxCacheEntries?: number;
  readonly maxCacheWeight?: number;
  readonly maxInFlight?: number;
}

type UncachedImageRecognitionResult =
  | {
      readonly status: 'complete';
      readonly result: ImageTextResult;
      readonly quality: ImageTextQualitySummary;
    }
  | { readonly status: 'failed'; readonly code: OcrHostErrorCode };

interface CachedImageRecognitionResult {
  readonly result: ImageTextResult;
  readonly quality: ImageTextQualitySummary;
}

interface StoredImageRecognitionResult extends CachedImageRecognitionResult {
  readonly weight: number;
}

interface InFlightImageRecognition {
  readonly generation: number;
  readonly task: Promise<UncachedImageRecognitionResult>;
}

/**
 * Owns transient pixel handoff, infrastructure retry, and the recognition-only
 * memory cache. Overlay translations remain in the separate text memory.
 */
export class ImageRecognitionCoordinator {
  readonly #clientId: string;
  readonly #maxCacheEntries: number;
  readonly #maxCacheWeight: number;
  readonly #maxInFlight: number;
  readonly #cache = new Map<string, StoredImageRecognitionResult>();
  readonly #emptyConfirmations = new Set<string>();
  readonly #inFlight = new Map<string, InFlightImageRecognition>();
  #generation = 0;
  #cacheWeight = 0;
  #hits = 0;
  #misses = 0;
  #inFlightJoins = 0;
  #loads = 0;

  constructor(private readonly environment: ImageRecognitionCoordinatorEnvironment) {
    this.#clientId = environment.clientId ?? crypto.randomUUID();
    this.#maxCacheEntries = positiveInteger(
      environment.maxCacheEntries,
      MAX_RECOGNITION_CACHE_ENTRIES,
    );
    this.#maxCacheWeight = positiveInteger(
      environment.maxCacheWeight,
      MAX_RECOGNITION_CACHE_WEIGHT,
      10_000_000,
    );
    this.#maxInFlight = positiveInteger(
      environment.maxInFlight,
      MAX_RECOGNITION_IN_FLIGHT,
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
      this.#hits += 1;
      this.#cache.delete(cacheKey);
      this.#cache.set(cacheKey, cached);
      return this.#withMetadata({
        status: 'complete',
        result: cached.result,
        quality: cached.quality,
      }, 'hit');
    }
    this.#misses += 1;
    const generation = this.#generation;
    const running = this.#inFlight.get(cacheKey);
    if (running?.generation === generation) {
      this.#inFlightJoins += 1;
      try {
        const result = await raceAbort(running.task, signal);
        return this.#withMetadata(result, 'join');
      } catch (error) {
        if (
          !signal?.aborted &&
          generation === this.#generation &&
          isAbortError(error)
        ) {
          return this.recognize(pixels, route, signal);
        }
        throw error;
      }
    }
    if (generation !== this.#generation) {
      throw new DOMException('Image recognition cache was cleared.', 'AbortError');
    }
    if (this.#inFlight.size >= this.#maxInFlight) {
      return this.#withMetadata({
        status: 'failed',
        code: 'host-overflow',
      }, 'miss');
    }
    this.#loads += 1;
    const task = this.#recognizeUncached(
      cacheKey,
      pixels,
      route,
      generation,
      signal,
    ).finally(() => {
      if (this.#inFlight.get(cacheKey)?.task === task) {
        this.#inFlight.delete(cacheKey);
      }
    });
    this.#inFlight.set(cacheKey, { generation, task });
    return this.#withMetadata(await task, 'miss');
  }

  snapshotStats(): ImageRecognitionCacheStats {
    return Object.freeze({
      entries: this.#cache.size,
      weight: this.#cacheWeight,
      hits: this.#hits,
      misses: this.#misses,
      inFlightJoins: this.#inFlightJoins,
      loads: this.#loads,
    });
  }

  clear(): void {
    this.#generation += 1;
    this.#cache.clear();
    this.#cacheWeight = 0;
    this.#emptyConfirmations.clear();
    this.#inFlight.clear();
    this.#hits = 0;
    this.#misses = 0;
    this.#inFlightJoins = 0;
    this.#loads = 0;
  }

  async #recognizeUncached(
    cacheKey: string,
    pixels: AcquiredImagePixels,
    route: ImageRecognitionRoute,
    generation: number,
    signal?: AbortSignal,
  ): Promise<UncachedImageRecognitionResult> {
    const providers = effectiveRuntimeOrder(route);
    if (providers.length === 0) {
      return { status: 'failed', code: 'provider-unavailable' };
    }
    const inputKey = await this.environment.store.put(pixels.encoded);
    try {
      let lastFailure: OcrHostErrorCode = 'provider-unavailable';
      let lastEmptyResult: CachedImageRecognitionResult | undefined;
      let hints: readonly ImageTextRegion[] = Object.freeze([]);
      let quality = emptyImageTextQualitySummary();
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
        const filtered = filterImageTextResult(response.result);
        quality = mergeImageTextQualitySummaries(quality, filtered.quality);
        if (!filtered.hasAcceptedText) {
          hints = appendGeometryHints(hints, response.result.regions);
          lastEmptyResult = {
            result: filtered.result,
            quality,
          };
          lastFailure = 'recognition-failed';
          continue;
        }
        const accepted = {
          result: filtered.result,
          quality,
        };
        this.#remember(cacheKey, accepted, generation);
        return { status: 'complete', ...accepted };
      }
      if (lastEmptyResult) {
        if (this.#emptyConfirmations.has(cacheKey)) {
          this.#emptyConfirmations.delete(cacheKey);
          this.#remember(cacheKey, lastEmptyResult, generation);
        } else if (generation === this.#generation) {
          this.#emptyConfirmations.add(cacheKey);
          this.#boundEmptyConfirmations();
        }
        return {
          status: 'complete',
          ...lastEmptyResult,
        };
      }
      return { status: 'failed', code: lastFailure };
    } finally {
      await this.environment.store.remove(inputKey).catch(() => undefined);
    }
  }

  #withMetadata(
    result: UncachedImageRecognitionResult,
    cacheAccess: ImageRecognitionCacheAccess,
  ): ImageRecognitionResult {
    const metadata = {
      cacheAccess,
      cacheStats: this.snapshotStats(),
    } as const;
    return result.status === 'complete'
      ? {
          ...result,
          cacheHit: cacheAccess === 'hit',
          ...metadata,
        }
      : { ...result, ...metadata };
  }

  #remember(
    cacheKey: string,
    result: CachedImageRecognitionResult,
    generation: number,
  ): void {
    if (generation !== this.#generation) return;
    this.#emptyConfirmations.delete(cacheKey);
    const weight = imageRecognitionCacheWeight(result.result);
    if (weight > this.#maxCacheWeight) return;
    const replaced = this.#cache.get(cacheKey);
    if (replaced) this.#cacheWeight -= replaced.weight;
    this.#cache.delete(cacheKey);
    this.#cache.set(cacheKey, { ...result, weight });
    this.#cacheWeight += weight;
    while (
      this.#cache.size > this.#maxCacheEntries ||
      this.#cacheWeight > this.#maxCacheWeight
    ) {
      const oldest = this.#cache.entries().next().value as
        | [string, StoredImageRecognitionResult]
        | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest[0]);
      this.#cacheWeight -= oldest[1].weight;
    }
  }

  #boundEmptyConfirmations(): void {
    while (this.#emptyConfirmations.size > this.#maxCacheEntries) {
      const oldest = this.#emptyConfirmations.values().next().value as
        | string
        | undefined;
      if (!oldest) return;
      this.#emptyConfirmations.delete(oldest);
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
  const providers = effectiveRuntimeOrder(route).map((providerId) =>
    providerId === 'chrome-text-detector'
      ? [
          providerId,
          'chrome-text-detector-v1',
          'platform',
          route.sourceLanguage ?? '',
        ]
      : [
          providerId,
          'tesseract.js-7.0.0',
          route.modelVersion ?? '',
          route.sourceLanguage ?? '',
          route.languageGroup ?? '',
        ]
  );
  return JSON.stringify([
    'image-text-v2',
    providers,
    pixels.preprocessingVersion,
    pixels.bitmapWidth,
    pixels.bitmapHeight,
    pixels.pixelHash,
  ]);
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

export function imageRecognitionCacheWeight(result: ImageTextResult): number {
  let weight = result.transcript.length;
  for (const region of result.regions) {
    weight += region.text.length + RECOGNITION_CACHE_REGION_OVERHEAD;
  }
  return weight;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum = 10_000,
): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), maximum)
    : fallback;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'AbortError',
  );
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
