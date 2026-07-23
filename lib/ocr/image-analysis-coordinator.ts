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
  PADDLE_OCR_COMPILED,
  TESSERACT_WASM_DIRECT_COMPILED,
} from './compiled-provider-flags';
import {
  emptyImageTextQualitySummary,
  filterImageTextResult,
  mergeImageTextQualitySummaries,
  OCR_QUALITY_POLICY_VERSION,
  ocrQualityPolicyKey,
  repairOcrMinimumConfidence,
  type ImageTextQualitySummary,
  type OcrMinimumConfidence,
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
  readonly minimumConfidence?: OcrMinimumConfidence;
}

/** Opaque, coordinator-owned cursor for the next acceptable provider result. */
export interface ImageRecognitionContinuation {
  readonly kind: 'simul:image-recognition-continuation';
}

export type ImageRecognitionResult =
  | {
      readonly status: 'complete';
      readonly result: ImageTextResult;
      readonly cacheHit: boolean;
      readonly continuation?: ImageRecognitionContinuation;
      readonly cacheAccess?: ImageRecognitionCacheAccess;
      readonly cacheStats?: ImageRecognitionCacheStats;
      readonly quality?: ImageTextQualitySummary;
      /** Quality for the provider result selected in this response only. */
      readonly selectedQuality?: ImageTextQualitySummary;
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
  readonly resetEpoch: number;
  readonly maxCacheEntries?: number;
  readonly maxCacheWeight?: number;
  readonly maxInFlight?: number;
}

type UncachedImageRecognitionResult =
  | {
      readonly status: 'complete';
      readonly result: ImageTextResult;
      readonly quality: ImageTextQualitySummary;
      readonly selectedQuality: ImageTextQualitySummary;
      readonly continuation?: ImageRecognitionContinuation;
    }
  | { readonly status: 'failed'; readonly code: OcrHostErrorCode };

interface CachedImageRecognitionResult {
  readonly result: ImageTextResult;
  readonly quality: ImageTextQualitySummary;
  readonly selectedQuality: ImageTextQualitySummary;
  readonly continuation?: ImageRecognitionContinuation;
}

interface StoredImageRecognitionResult extends CachedImageRecognitionResult {
  readonly weight: number;
}

interface InFlightImageRecognition {
  readonly generation: number;
  readonly task: Promise<UncachedImageRecognitionResult>;
}

interface ImageRecognitionContinuationState {
  readonly generation: number;
  readonly resetEpoch: number;
  readonly lineageId: string;
  readonly pixelIdentity: string;
  readonly rootCacheKey: string;
  readonly cacheKey: string;
  readonly route: ImageRecognitionRoute;
  readonly providers: readonly RuntimeImageTextProviderId[];
  readonly nextProviderIndex: number;
  readonly hints: readonly ImageTextRegion[];
  readonly corroboratingResults: readonly ImageTextResult[];
  readonly quality: ImageTextQualitySummary;
  readonly weight: number;
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
  readonly #continuations = new Map<
    ImageRecognitionContinuation,
    ImageRecognitionContinuationState
  >();
  #generation = 0;
  #cacheWeight = 0;
  #hits = 0;
  #misses = 0;
  #inFlightJoins = 0;
  #loads = 0;
  #resetEpoch: number;

  constructor(private readonly environment: ImageRecognitionCoordinatorEnvironment) {
    this.#clientId = environment.clientId ?? crypto.randomUUID();
    if (!isResetEpoch(environment.resetEpoch)) {
      throw new Error('Invalid OCR reset epoch.');
    }
    this.#resetEpoch = environment.resetEpoch;
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
    return this.#recognizeWithContext(pixels, route, undefined, signal);
  }

  async continueRecognition(
    pixels: AcquiredImagePixels,
    continuation: ImageRecognitionContinuation,
    signal?: AbortSignal,
  ): Promise<ImageRecognitionResult> {
    signal?.throwIfAborted();
    const state = this.#continuations.get(continuation);
    if (!state) throw new TypeError('Invalid image recognition continuation.');
    if (
      state.generation !== this.#generation ||
      state.resetEpoch !== this.#resetEpoch
    ) {
      throw new DOMException('Image recognition reset advanced.', 'AbortError');
    }
    if (state.pixelIdentity !== recognitionPixelIdentity(pixels)) {
      throw new TypeError('Image recognition continuation pixels do not match.');
    }
    this.#touchContinuation(continuation, state);
    return this.#recognizeWithContext(pixels, state.route, state, signal);
  }

  async #recognizeWithContext(
    pixels: AcquiredImagePixels,
    route: ImageRecognitionRoute,
    context: ImageRecognitionContinuationState | undefined,
    signal?: AbortSignal,
  ): Promise<ImageRecognitionResult> {
    signal?.throwIfAborted();
    const cacheKey = context?.cacheKey ?? recognitionCacheKey(pixels, route);
    const cached = this.#cache.get(cacheKey);
    if (cached) {
      this.#hits += 1;
      this.#cache.delete(cacheKey);
      this.#cache.set(cacheKey, cached);
      if (cached.continuation) this.#touchContinuation(cached.continuation);
      return this.#withMetadata({
        status: 'complete',
        result: cached.result,
        quality: cached.quality,
        selectedQuality: cached.selectedQuality,
        ...(cached.continuation
          ? { continuation: cached.continuation }
          : {}),
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
          return this.#recognizeWithContext(pixels, route, context, signal);
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
      context,
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
      entries: this.#cache.size + this.#continuations.size,
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
    this.#continuations.clear();
    this.#cacheWeight = 0;
    this.#emptyConfirmations.clear();
    this.#inFlight.clear();
    this.#hits = 0;
    this.#misses = 0;
    this.#inFlightJoins = 0;
    this.#loads = 0;
  }

  /** Fence every cache, transient write, and host request from older resets. */
  advanceResetEpoch(resetEpoch: number): boolean {
    if (!isResetEpoch(resetEpoch) || resetEpoch < this.#resetEpoch) return false;
    if (resetEpoch === this.#resetEpoch) return true;
    this.#resetEpoch = resetEpoch;
    this.clear();
    return true;
  }

  async #recognizeUncached(
    cacheKey: string,
    pixels: AcquiredImagePixels,
    route: ImageRecognitionRoute,
    generation: number,
    context?: ImageRecognitionContinuationState,
    signal?: AbortSignal,
  ): Promise<UncachedImageRecognitionResult> {
    const providers = context?.providers ?? effectiveRuntimeOrder(route);
    const startProviderIndex = context?.nextProviderIndex ?? 0;
    if (startProviderIndex >= providers.length) {
      return { status: 'failed', code: 'provider-unavailable' };
    }
    const resetEpoch = this.#resetEpoch;
    const inputKey = await this.environment.store.put(pixels.encoded);
    if (
      generation !== this.#generation ||
      resetEpoch !== this.#resetEpoch
    ) {
      await this.environment.store.remove(inputKey).catch(() => undefined);
      throw new DOMException('Image recognition reset advanced.', 'AbortError');
    }
    try {
      let lastFailure: OcrHostErrorCode = 'provider-unavailable';
      let lastEmptyResult: CachedImageRecognitionResult | undefined;
      let hints: readonly ImageTextRegion[] = context?.hints ?? Object.freeze([]);
      const corroboratingResults: ImageTextResult[] = [
        ...(context?.corroboratingResults ?? []),
      ];
      let quality = context?.quality ?? emptyImageTextQualitySummary();
      for (
        let providerIndex = startProviderIndex;
        providerIndex < providers.length;
        providerIndex += 1
      ) {
        const providerId = providers[providerIndex] as RuntimeImageTextProviderId;
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
        const firstResponse = await this.#run(
          first,
          generation,
          resetEpoch,
          signal,
        );
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
          if (retry) response = await this.#run(
            retry,
            generation,
            resetEpoch,
            signal,
          );
        }
        if (response.kind === 'simul:ocr-v1:error') {
          lastFailure = response.code;
          continue;
        }
        const filtered = filterImageTextResult(response.result, {
          minimumConfidence: repairOcrMinimumConfidence(
            route.minimumConfidence,
          ),
          corroboratingResults,
        });
        quality = mergeImageTextQualitySummaries(quality, filtered.quality);
        if (!filtered.hasAcceptedText) {
          hints = appendGeometryHints(hints, response.result.regions);
          corroboratingResults.push(response.result);
          lastEmptyResult = {
            result: filtered.result,
            quality,
            selectedQuality: filtered.quality,
          };
          lastFailure = 'recognition-failed';
          continue;
        }
        const accepted = {
          result: filtered.result,
          quality,
          selectedQuality: filtered.quality,
          ...(providerIndex + 1 < providers.length
            ? {
                continuation: this.#createContinuation({
                  generation,
                  resetEpoch,
                  lineageId: context?.lineageId ?? crypto.randomUUID(),
                  pixelIdentity: context?.pixelIdentity ??
                    recognitionPixelIdentity(pixels),
                  rootCacheKey: context?.rootCacheKey ?? cacheKey,
                  route: context?.route ?? snapshotRecognitionRoute(
                    route,
                    providers,
                  ),
                  providers,
                  nextProviderIndex: providerIndex + 1,
                  hints: appendGeometryHints(
                    hints,
                    response.result.regions,
                  ),
                  corroboratingResults: Object.freeze([
                    ...corroboratingResults,
                    response.result,
                  ]),
                  quality,
                }),
              }
            : {}),
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

  #createContinuation(
    state: Omit<ImageRecognitionContinuationState, 'cacheKey' | 'weight'>,
  ): ImageRecognitionContinuation {
    const evidence = boundedImageRecognitionContinuationEvidence(
      state.hints,
      state.corroboratingResults,
      this.#maxCacheWeight,
    );
    const continuation = Object.freeze({
      kind: 'simul:image-recognition-continuation' as const,
    });
    const storedState = Object.freeze({
      ...state,
      cacheKey: recognitionContinuationCacheKey(
        state.rootCacheKey,
        state.nextProviderIndex,
        state.lineageId,
      ),
      hints: evidence.hints,
      corroboratingResults: evidence.corroboratingResults,
      weight: evidence.weight,
    });
    this.#continuations.set(continuation, storedState);
    this.#cacheWeight += storedState.weight;
    this.#boundRetainedRecognitionMemory(continuation);
    return continuation;
  }

  #touchContinuation(
    continuation: ImageRecognitionContinuation,
    knownState?: ImageRecognitionContinuationState,
  ): void {
    const state = knownState ?? this.#continuations.get(continuation);
    if (!state) return;
    this.#continuations.delete(continuation);
    this.#continuations.set(continuation, state);
  }

  #deleteCachedResult(cacheKey: string): void {
    const cached = this.#cache.get(cacheKey);
    if (!cached) return;
    this.#cache.delete(cacheKey);
    this.#cacheWeight -= cached.weight;
  }

  #deleteContinuation(continuation: ImageRecognitionContinuation): void {
    const state = this.#continuations.get(continuation);
    if (!state) return;
    this.#continuations.delete(continuation);
    this.#cacheWeight -= state.weight;
    for (const [cacheKey, cached] of [...this.#cache]) {
      if (
        cacheKey === state.cacheKey ||
        cached.continuation === continuation
      ) this.#deleteCachedResult(cacheKey);
    }
  }

  #boundRetainedRecognitionMemory(
    protectedContinuation?: ImageRecognitionContinuation,
  ): void {
    while (
      this.#cache.size + this.#continuations.size > this.#maxCacheEntries ||
      this.#cacheWeight > this.#maxCacheWeight
    ) {
      const oldestCacheKey = this.#cache.keys().next().value as
        | string
        | undefined;
      if (oldestCacheKey !== undefined) {
        this.#deleteCachedResult(oldestCacheKey);
        continue;
      }
      const oldestContinuation = [...this.#continuations.keys()].find(
        (candidate) => candidate !== protectedContinuation,
      );
      if (!oldestContinuation) break;
      this.#deleteContinuation(oldestContinuation);
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
    this.#boundRetainedRecognitionMemory(result.continuation);
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
    generation: number,
    resetEpoch: number,
    signal?: AbortSignal,
  ): Promise<OffscreenOcrResponse> {
    signal?.throwIfAborted();
    if (
      generation !== this.#generation ||
      resetEpoch !== this.#resetEpoch
    ) throw new DOMException('Image recognition reset advanced.', 'AbortError');
    let readyMessage: unknown;
    try {
      readyMessage = await raceAbort(
        this.environment.sendMessage({
          kind: 'simul:ocr-v1:ensure-host',
          version: 1,
          resetEpoch,
        }),
        signal,
      );
    } catch (error) {
      if (
        generation !== this.#generation ||
        resetEpoch !== this.#resetEpoch
      ) throw new DOMException('Image recognition reset advanced.', 'AbortError');
      if (signal?.aborted) throw error;
      return hostError(job, 'host-unavailable');
    }
    if (
      generation !== this.#generation ||
      resetEpoch !== this.#resetEpoch
    ) throw new DOMException('Image recognition reset advanced.', 'AbortError');
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
        if (
          generation !== this.#generation ||
          resetEpoch !== this.#resetEpoch
        ) throw new DOMException(
          'Image recognition reset advanced.',
          'AbortError',
        );
        return hostError(job, 'host-unavailable');
      }
      if (abortSent || signal?.aborted) {
        throw new DOMException('Image recognition cancelled.', 'AbortError');
      }
      if (
        generation !== this.#generation ||
        resetEpoch !== this.#resetEpoch
      ) throw new DOMException('Image recognition reset advanced.', 'AbortError');
      return readOffscreenOcrResponse(raw, job) ?? hostError(job, 'host-unavailable');
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function createBrowserImageRecognitionCoordinator(
  store: TransientImageInputStore,
  resetEpoch: number,
): ImageRecognitionCoordinator {
  return new ImageRecognitionCoordinator({
    store,
    resetEpoch,
    sendMessage: (message) => browser.runtime.sendMessage(message),
  });
}

function isResetEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function createJob(
  providerId: RuntimeImageTextProviderId,
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
    qualityPolicyVersion: OCR_QUALITY_POLICY_VERSION,
    minimumConfidence: repairOcrMinimumConfidence(route.minimumConfidence),
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
  if (providerId === 'paddleocr-wasm') {
    if (!PADDLE_OCR_COMPILED || !route.sourceLanguage) return undefined;
    return Object.freeze({
      ...base,
      providerId,
      languageGroup: route.sourceLanguage,
      providerVersion: 'paddleocr-js-0.4.2',
      modelVersion: 'PP-OCRv6_tiny_det+PP-OCRv6_tiny_rec',
    });
  }
  if (providerId === 'tesseract-wasm-direct') {
    const languageGroup = tesseractLanguageGroupForProvider(providerId, route);
    if (
      !TESSERACT_WASM_DIRECT_COMPILED ||
      !languageGroup ||
      !route.modelVersion
    ) return undefined;
    return Object.freeze({
      ...base,
      providerId,
      languageGroup,
      providerVersion: 'tesseract-wasm-0.11.0',
      modelVersion: route.modelVersion,
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
      : PADDLE_OCR_COMPILED && providerId === 'paddleocr-wasm'
        ? [
            providerId,
            'paddleocr-js-0.4.2',
            'PP-OCRv6_tiny_det+PP-OCRv6_tiny_rec',
            route.sourceLanguage ?? '',
          ]
        : TESSERACT_WASM_DIRECT_COMPILED &&
            providerId === 'tesseract-wasm-direct'
          ? [
              providerId,
              'tesseract-wasm-0.11.0',
              route.modelVersion ?? '',
              route.sourceLanguage ?? '',
              tesseractLanguageGroupForProvider(providerId, route) ?? '',
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
    'image-text-v3',
    providers,
    ocrQualityPolicyKey(repairOcrMinimumConfidence(route.minimumConfidence)),
    pixels.preprocessingVersion,
    pixels.bitmapWidth,
    pixels.bitmapHeight,
    pixels.pixelHash,
  ]);
}

function recognitionContinuationCacheKey(
  rootCacheKey: string,
  nextProviderIndex: number,
  lineageId: string,
): string {
  return JSON.stringify([
    'image-text-continuation-v1',
    rootCacheKey,
    nextProviderIndex,
    lineageId,
  ]);
}

function recognitionPixelIdentity(pixels: AcquiredImagePixels): string {
  return JSON.stringify([
    pixels.preprocessingVersion,
    pixels.bitmapWidth,
    pixels.bitmapHeight,
    pixels.pixelHash,
  ]);
}

function snapshotRecognitionRoute(
  route: ImageRecognitionRoute,
  providers: readonly RuntimeImageTextProviderId[],
): ImageRecognitionRoute {
  return Object.freeze({
    providerOrder: Object.freeze([...providers]),
    ...(route.sourceLanguage !== undefined
      ? { sourceLanguage: route.sourceLanguage }
      : {}),
    ...(route.languageGroup !== undefined
      ? { languageGroup: route.languageGroup }
      : {}),
    ...(route.modelVersion !== undefined
      ? { modelVersion: route.modelVersion }
      : {}),
    ...(route.minimumConfidence !== undefined
      ? { minimumConfidence: route.minimumConfidence }
      : {}),
  });
}

/** The direct runtime loads one model; the wrapper can combine horizontal/vertical Japanese. */
function tesseractLanguageGroupForProvider(
  providerId: RuntimeImageTextProviderId,
  route: ImageRecognitionRoute,
): string | undefined {
  return providerId === 'tesseract-wasm-direct' &&
      route.languageGroup === 'jpn+jpn_vert'
    ? 'jpn'
    : route.languageGroup;
}

function effectiveRuntimeOrder(
  route: ImageRecognitionRoute,
): readonly RuntimeImageTextProviderId[] {
  const saved = route.providerOrder ?? ['tesseract'];
  const seen = new Set<string>();
  const result: RuntimeImageTextProviderId[] = [];
  for (const providerId of saved) {
    if (
      (
        providerId === 'chrome-text-detector' ||
        providerId === 'tesseract' ||
        (PADDLE_OCR_COMPILED && providerId === 'paddleocr-wasm') ||
        (
          TESSERACT_WASM_DIRECT_COMPILED &&
          providerId === 'tesseract-wasm-direct'
        )
      ) &&
      !seen.has(providerId)
    ) {
      seen.add(providerId);
      result.push(providerId);
    }
  }
  return Object.freeze(result);
}

type RuntimeImageTextProviderId = Extract<
  ImageTextProviderId,
  | 'chrome-text-detector'
  | 'tesseract'
  | 'paddleocr-wasm'
  | 'tesseract-wasm-direct'
>;

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

function imageRecognitionContinuationWeight(
  hints: readonly ImageTextRegion[],
  corroboratingResults: readonly ImageTextResult[],
): number {
  let weight = hints.length * RECOGNITION_CACHE_REGION_OVERHEAD;
  for (const result of corroboratingResults) {
    weight += imageRecognitionCacheWeight(result);
    if (weight > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  }
  return weight;
}

interface BoundedImageRecognitionContinuationEvidence {
  readonly hints: readonly ImageTextRegion[];
  readonly corroboratingResults: readonly ImageTextResult[];
  readonly weight: number;
}

/** Retain only exact, bounded evidence needed by later providers. */
function boundedImageRecognitionContinuationEvidence(
  hints: readonly ImageTextRegion[],
  corroboratingResults: readonly ImageTextResult[],
  maximumWeight: number,
): BoundedImageRecognitionContinuationEvidence {
  const initialHintLimit = Math.floor(
    maximumWeight / (2 * RECOGNITION_CACHE_REGION_OVERHEAD),
  );
  const retainedHints = hints.slice(0, initialHintLimit);
  let weight = retainedHints.length * RECOGNITION_CACHE_REGION_OVERHEAD;
  const retainedResults: ImageTextResult[] = [];
  for (const result of corroboratingResults) {
    const regions: ImageTextRegion[] = [];
    for (const region of result.regions) {
      const regionWeight = region.text.length + RECOGNITION_CACHE_REGION_OVERHEAD;
      if (regionWeight > maximumWeight - weight) continue;
      regions.push(region);
      weight += regionWeight;
    }
    if (regions.length === 0) continue;
    retainedResults.push(Object.freeze({
      providerId: result.providerId,
      bitmapWidth: result.bitmapWidth,
      bitmapHeight: result.bitmapHeight,
      transcript: '',
      regions: Object.freeze(regions),
    }));
  }
  const remainingHintCapacity = Math.floor(
    (maximumWeight - weight) / RECOGNITION_CACHE_REGION_OVERHEAD,
  );
  if (remainingHintCapacity > 0) {
    const previousHintCount = retainedHints.length;
    retainedHints.push(...hints.slice(
      retainedHints.length,
      retainedHints.length + remainingHintCapacity,
    ));
    weight += (retainedHints.length - previousHintCount) *
      RECOGNITION_CACHE_REGION_OVERHEAD;
  }
  const frozenHints = Object.freeze(retainedHints);
  const frozenResults = Object.freeze(retainedResults);
  return Object.freeze({
    hints: frozenHints,
    corroboratingResults: frozenResults,
    weight: imageRecognitionContinuationWeight(frozenHints, frozenResults),
  });
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
