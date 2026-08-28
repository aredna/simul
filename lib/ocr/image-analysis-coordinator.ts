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
export const RECOGNITION_CACHE_TTL_MS = 15 * 60 * 1_000;

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
  /** Number of retained recognition-evidence records removed by TTL. */
  readonly expirations?: number;
  /** Number of explicit generation-fenced cache purges. */
  readonly purges?: number;
  /** Order-independent raw provider evidence retained for route recomposition. */
  readonly providerEntries?: number;
  readonly providerWeight?: number;
  readonly providerHits?: number;
  readonly providerMisses?: number;
}

export interface ImageRecognitionCoordinatorEnvironment {
  readonly store: TransientImageInputStore;
  readonly sendMessage: (message: unknown) => Promise<unknown>;
  readonly clientId?: string;
  readonly resetEpoch: number;
  readonly maxCacheEntries?: number;
  readonly maxCacheWeight?: number;
  readonly maxInFlight?: number;
  readonly maxCacheAgeMs?: number;
  readonly now?: () => number;
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
  readonly expiresAt: number;
  readonly recency: number;
}

interface StoredProviderRecognitionEvidence {
  readonly result: ImageTextResult;
  readonly weight: number;
  readonly expiresAt: number;
  readonly recency: number;
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
  readonly expiresAt: number;
  readonly recency: number;
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
  readonly #maxCacheAgeMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, StoredImageRecognitionResult>();
  readonly #providerEvidence = new Map<
    string,
    StoredProviderRecognitionEvidence
  >();
  readonly #emptyConfirmations = new Map<string, number>();
  readonly #inFlight = new Map<string, InFlightImageRecognition>();
  readonly #continuations = new Map<
    ImageRecognitionContinuation,
    ImageRecognitionContinuationState
  >();
  #generation = 0;
  #cacheWeight = 0;
  #providerEvidenceWeight = 0;
  #hits = 0;
  #misses = 0;
  #inFlightJoins = 0;
  #loads = 0;
  #activeRecognitionLoads = 0;
  #expirations = 0;
  #purges = 0;
  #providerHits = 0;
  #providerMisses = 0;
  #recency = 0;
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
    this.#maxCacheAgeMs = positiveDuration(
      environment.maxCacheAgeMs,
      RECOGNITION_CACHE_TTL_MS,
    );
    this.#now = environment.now ?? Date.now;
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
    if (state.expiresAt <= this.#now()) {
      this.#expireContinuation(continuation);
      throw new DOMException(
        'Image recognition continuation expired.',
        'AbortError',
      );
    }
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
    const cached = this.#readCachedResult(cacheKey);
    if (cached) {
      this.#hits += 1;
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
    if (this.#activeRecognitionLoads >= this.#maxInFlight) {
      return this.#withMetadata({
        status: 'failed',
        code: 'host-overflow',
      }, 'miss');
    }
    this.#loads += 1;
    this.#activeRecognitionLoads += 1;
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
      this.#activeRecognitionLoads -= 1;
    });
    this.#inFlight.set(cacheKey, { generation, task });
    return this.#withMetadata(await task, 'miss');
  }

  snapshotStats(): ImageRecognitionCacheStats {
    this.#expireRetained();
    return Object.freeze({
      entries: this.#cache.size + this.#continuations.size,
      weight: this.#cacheWeight,
      hits: this.#hits,
      misses: this.#misses,
      inFlightJoins: this.#inFlightJoins,
      loads: this.#loads,
      expirations: this.#expirations,
      purges: this.#purges,
      providerEntries: this.#providerEvidence.size,
      providerWeight: this.#providerEvidenceWeight,
      providerHits: this.#providerHits,
      providerMisses: this.#providerMisses,
    });
  }

  clear(): void {
    this.#generation += 1;
    this.#cache.clear();
    this.#providerEvidence.clear();
    this.#continuations.clear();
    this.#cacheWeight = 0;
    this.#providerEvidenceWeight = 0;
    this.#emptyConfirmations.clear();
    // Generation-scoped join keys are invalid after a purge, but their real
    // provider work remains capacity-bearing until each detached task settles.
    this.#inFlight.clear();
    this.#hits = 0;
    this.#misses = 0;
    this.#inFlightJoins = 0;
    this.#loads = 0;
    this.#expirations = 0;
    this.#providerHits = 0;
    this.#providerMisses = 0;
    this.#recency = 0;
    this.#purges += 1;
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
    let inputKey: string | undefined;
    const ensureInputKey = async (): Promise<string> => {
      if (inputKey) return inputKey;
      const stored = await this.environment.store.put(pixels.encoded);
      if (
        generation !== this.#generation ||
        resetEpoch !== this.#resetEpoch
      ) {
        await this.environment.store.remove(stored).catch(() => undefined);
        throw new DOMException('Image recognition reset advanced.', 'AbortError');
      }
      inputKey = stored;
      return stored;
    };
    try {
      let lastFailure: OcrHostErrorCode = 'provider-unavailable';
      let lastEmptyResult: CachedImageRecognitionResult | undefined;
      const confirmingEmptyRoute = this.#hasFreshEmptyConfirmation(cacheKey);
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
        const providerCacheKey = providerRecognitionCacheKey(
          pixels,
          route,
          providerId,
        );
        if (!providerCacheKey) continue;
        // An exact route still requires two real OCR passes before a blank
        // result becomes authoritative. Reordered routes may reuse the same
        // completed provider operations, but a pending confirmation deliberately
        // bypasses them for this one pass.
        const retainedProvider = confirmingEmptyRoute
          ? undefined
          : this.#readProviderEvidence(providerCacheKey);
        let rawResult: ImageTextResult | undefined = retainedProvider?.result;
        if (!rawResult) {
          const jobId = crypto.randomUUID();
          const first = createJob(
            providerId,
            this.#clientId,
            jobId,
            0,
            await ensureInputKey(),
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
              inputKey!,
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
          rawResult = response.result;
          // A validated provider response is one completed OCR operation even
          // when it contains no accepted text. Retain the raw result and
          // reapply current-route quality/corroboration below. Host and worker
          // errors never reach this write.
          this.#rememberProviderEvidence(
            providerCacheKey,
            rawResult,
            generation,
          );
        }
        const filtered = filterImageTextResult(rawResult, {
          minimumConfidence: repairOcrMinimumConfidence(
            route.minimumConfidence,
          ),
          corroboratingResults,
        });
        quality = mergeImageTextQualitySummaries(quality, filtered.quality);
        if (!filtered.hasAcceptedText) {
          hints = appendGeometryHints(hints, rawResult.regions);
          corroboratingResults.push(rawResult);
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
                    rawResult.regions,
                  ),
                  corroboratingResults: Object.freeze([
                    ...corroboratingResults,
                    rawResult,
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
        if (confirmingEmptyRoute) {
          this.#emptyConfirmations.delete(cacheKey);
          this.#remember(cacheKey, lastEmptyResult, generation);
        } else if (generation === this.#generation) {
          this.#emptyConfirmations.set(
            cacheKey,
            expiresAt(this.#now(), this.#maxCacheAgeMs),
          );
          this.#boundEmptyConfirmations();
        }
        return {
          status: 'complete',
          ...lastEmptyResult,
        };
      }
      return { status: 'failed', code: lastFailure };
    } finally {
      if (inputKey) {
        await this.environment.store.remove(inputKey).catch(() => undefined);
      }
    }
  }

  #createContinuation(
    state: Omit<
      ImageRecognitionContinuationState,
      'cacheKey' | 'weight' | 'expiresAt' | 'recency'
    >,
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
      expiresAt: expiresAt(this.#now(), this.#maxCacheAgeMs),
      recency: this.#nextRecency(),
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
    if (state.expiresAt <= this.#now()) {
      this.#expireContinuation(continuation);
      return;
    }
    const touched = Object.freeze({
      ...state,
      recency: this.#nextRecency(),
    });
    this.#continuations.delete(continuation);
    this.#continuations.set(continuation, touched);
  }

  #readCachedResult(
    cacheKey: string,
  ): StoredImageRecognitionResult | undefined {
    const cached = this.#cache.get(cacheKey);
    if (!cached) return undefined;
    const now = this.#now();
    if (cached.expiresAt <= now) {
      this.#expireCachedResult(cacheKey);
      return undefined;
    }
    if (cached.continuation) {
      const continuationState = this.#continuations.get(cached.continuation);
      if (!continuationState) {
        this.#deleteCachedResult(cacheKey);
        return undefined;
      }
      if (continuationState.expiresAt <= now) {
        this.#expireContinuation(cached.continuation);
        return undefined;
      }
      this.#touchContinuation(cached.continuation, continuationState);
    }
    const touched = Object.freeze({
      ...cached,
      recency: this.#nextRecency(),
    });
    this.#cache.delete(cacheKey);
    this.#cache.set(cacheKey, touched);
    return touched;
  }

  #readProviderEvidence(
    cacheKey: string,
  ): StoredProviderRecognitionEvidence | undefined {
    const cached = this.#providerEvidence.get(cacheKey);
    if (!cached) {
      this.#providerMisses += 1;
      return undefined;
    }
    if (cached.expiresAt <= this.#now()) {
      this.#expireProviderEvidence(cacheKey);
      this.#providerMisses += 1;
      return undefined;
    }
    this.#providerHits += 1;
    const touched = Object.freeze({
      ...cached,
      recency: this.#nextRecency(),
    });
    this.#providerEvidence.delete(cacheKey);
    this.#providerEvidence.set(cacheKey, touched);
    return touched;
  }

  #deleteCachedResult(cacheKey: string): boolean {
    const cached = this.#cache.get(cacheKey);
    if (!cached) return false;
    this.#cache.delete(cacheKey);
    this.#cacheWeight -= cached.weight;
    return true;
  }

  #deleteProviderEvidence(cacheKey: string): boolean {
    const cached = this.#providerEvidence.get(cacheKey);
    if (!cached) return false;
    this.#providerEvidence.delete(cacheKey);
    this.#providerEvidenceWeight -= cached.weight;
    return true;
  }

  #deleteContinuation(
    continuation: ImageRecognitionContinuation,
  ): number {
    const state = this.#continuations.get(continuation);
    if (!state) return 0;
    let deleted = 1;
    this.#continuations.delete(continuation);
    this.#cacheWeight -= state.weight;
    for (const [cacheKey, cached] of [...this.#cache]) {
      if (
        cacheKey === state.cacheKey ||
        cached.continuation === continuation
      ) {
        if (this.#deleteCachedResult(cacheKey)) deleted += 1;
      }
    }
    return deleted;
  }

  #expireCachedResult(cacheKey: string): void {
    const cached = this.#cache.get(cacheKey);
    if (!cached) return;
    let deleted = cached.continuation
      ? this.#deleteContinuation(cached.continuation)
      : Number(this.#deleteCachedResult(cacheKey));
    if (deleted === 0) deleted = Number(this.#deleteCachedResult(cacheKey));
    this.#expirations += deleted;
  }

  #expireProviderEvidence(cacheKey: string): void {
    this.#expirations += Number(this.#deleteProviderEvidence(cacheKey));
  }

  #expireContinuation(
    continuation: ImageRecognitionContinuation,
  ): void {
    this.#expirations += this.#deleteContinuation(continuation);
  }

  #expireRetained(): void {
    const now = this.#now();
    for (const [cacheKey, cached] of [...this.#cache]) {
      if (cached.expiresAt <= now) this.#expireCachedResult(cacheKey);
    }
    for (const [cacheKey, cached] of [...this.#providerEvidence]) {
      if (cached.expiresAt <= now) this.#expireProviderEvidence(cacheKey);
    }
    for (const [continuation, state] of [...this.#continuations]) {
      if (state.expiresAt <= now) this.#expireContinuation(continuation);
    }
    for (const [cacheKey, confirmationExpiresAt] of this.#emptyConfirmations) {
      if (confirmationExpiresAt <= now) {
        this.#emptyConfirmations.delete(cacheKey);
        this.#expirations += 1;
      }
    }
  }

  #boundRetainedRecognitionMemory(
    protectedContinuation?: ImageRecognitionContinuation,
  ): void {
    while (
      this.#cache.size +
          this.#continuations.size +
          this.#providerEvidence.size +
          this.#emptyConfirmations.size >
        this.#maxCacheEntries ||
      this.#cacheWeight + this.#providerEvidenceWeight >
        this.#maxCacheWeight
    ) {
      const oldestEmptyConfirmation = this.#emptyConfirmations.keys().next()
        .value as string | undefined;
      if (oldestEmptyConfirmation !== undefined) {
        this.#emptyConfirmations.delete(oldestEmptyConfirmation);
        continue;
      }
      const oldest = this.#oldestRetainedRecognitionRecord(
        protectedContinuation,
      );
      if (!oldest) break;
      if (oldest.kind === 'result') {
        // A protected continuation may still be returned to the caller even
        // when its optional route-result cache entry must be dropped.
        this.#deleteCachedResult(oldest.key);
      } else if (oldest.kind === 'provider') {
        this.#deleteProviderEvidence(oldest.key);
      } else {
        this.#deleteContinuation(oldest.key);
      }
    }
  }

  #oldestRetainedRecognitionRecord(
    protectedContinuation?: ImageRecognitionContinuation,
  ):
    | { readonly kind: 'result'; readonly key: string; readonly recency: number }
    | { readonly kind: 'provider'; readonly key: string; readonly recency: number }
    | {
        readonly kind: 'continuation';
        readonly key: ImageRecognitionContinuation;
        readonly recency: number;
      }
    | undefined {
    // Raw provider evidence is a recomposition accelerator; a completed route
    // result is the directly reusable answer. Shed the accelerator first when
    // an intentionally tiny test/user budget cannot hold both representations.
    let oldestProvider:
      | { readonly kind: 'provider'; readonly key: string; readonly recency: number }
      | undefined;
    for (const [key, value] of this.#providerEvidence) {
      if (!oldestProvider || value.recency < oldestProvider.recency) {
        oldestProvider = { kind: 'provider', key, recency: value.recency };
      }
    }
    if (oldestProvider) return oldestProvider;

    let oldest:
      | { readonly kind: 'result'; readonly key: string; readonly recency: number }
      | {
          readonly kind: 'continuation';
          readonly key: ImageRecognitionContinuation;
          readonly recency: number;
        }
      | undefined;
    for (const [key, value] of this.#cache) {
      if (!oldest || value.recency < oldest.recency) {
        oldest = { kind: 'result', key, recency: value.recency };
      }
    }
    for (const [key, value] of this.#continuations) {
      if (
        key !== protectedContinuation &&
        (!oldest || value.recency < oldest.recency)
      ) {
        oldest = { kind: 'continuation', key, recency: value.recency };
      }
    }
    return oldest;
  }

  #nextRecency(): number {
    this.#recency += 1;
    return this.#recency;
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
    if (
      replaced?.continuation &&
      replaced.continuation !== result.continuation
    ) {
      this.#deleteContinuation(replaced.continuation);
    } else if (replaced) {
      this.#deleteCachedResult(cacheKey);
    }
    this.#cache.set(cacheKey, {
      ...result,
      weight,
      expiresAt: expiresAt(this.#now(), this.#maxCacheAgeMs),
      recency: this.#nextRecency(),
    });
    this.#cacheWeight += weight;
    this.#boundRetainedRecognitionMemory(result.continuation);
  }

  #rememberProviderEvidence(
    cacheKey: string,
    result: ImageTextResult,
    generation: number,
  ): void {
    if (generation !== this.#generation) return;
    const weight = imageRecognitionCacheWeight(result);
    if (weight > this.#maxCacheWeight) return;
    this.#deleteProviderEvidence(cacheKey);
    this.#providerEvidence.set(cacheKey, Object.freeze({
      result,
      weight,
      expiresAt: expiresAt(this.#now(), this.#maxCacheAgeMs),
      recency: this.#nextRecency(),
    }));
    this.#providerEvidenceWeight += weight;
    this.#boundRetainedRecognitionMemory();
  }

  #boundEmptyConfirmations(): void {
    this.#boundRetainedRecognitionMemory();
  }

  #hasFreshEmptyConfirmation(cacheKey: string): boolean {
    const confirmationExpiresAt = this.#emptyConfirmations.get(cacheKey);
    if (confirmationExpiresAt === undefined) return false;
    if (confirmationExpiresAt > this.#now()) return true;
    this.#emptyConfirmations.delete(cacheKey);
    this.#expirations += 1;
    return false;
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
  if (!route.languageGroup || !route.modelVersion) return undefined;
  return Object.freeze({
    ...base,
    providerId,
    languageGroup: route.languageGroup,
    providerVersion: 'tesseract.js-7.0.0',
    modelVersion: route.modelVersion,
  });
}

/**
 * The coordinator's route order is execution semantics because it returns the
 * first acceptable result. Callers that retain per-provider evidence should
 * submit singleton routes so saved UI priority never enters that evidence key.
 */
function recognitionCacheKey(
  pixels: AcquiredImagePixels,
  route: ImageRecognitionRoute,
): string {
  const providers = effectiveRuntimeOrder(route).map((providerId) =>
    providerRecognitionIdentity(providerId, route)
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

/**
 * Raw provider evidence is order-independent. Every compiled provider runtime
 * currently recognizes the complete bitmap and ignores advisory geometry
 * hints; hints affect only coordinator-side corroboration. The key therefore
 * describes the actual provider operation rather than the preceding route.
 * Quality filtering and corroboration are reapplied whenever a route is
 * composed, so priority or threshold changes can reuse each completed OCR
 * operation without treating the old route as final.
 */
function providerRecognitionCacheKey(
  pixels: AcquiredImagePixels,
  route: ImageRecognitionRoute,
  providerId: RuntimeImageTextProviderId,
): string | undefined {
  const provider = providerRecognitionIdentity(providerId, route);
  if (!provider) return undefined;
  return JSON.stringify([
    'image-text-provider-v2-complete-bitmap',
    provider,
    pixels.preprocessingVersion,
    pixels.bitmapWidth,
    pixels.bitmapHeight,
    pixels.pixelHash,
  ]);
}

function providerRecognitionIdentity(
  providerId: RuntimeImageTextProviderId,
  route: ImageRecognitionRoute,
): readonly string[] | undefined {
  if (providerId === 'chrome-text-detector') {
    if (!route.sourceLanguage) return undefined;
    return Object.freeze([
      providerId,
      'chrome-text-detector-v1',
      'platform',
      route.sourceLanguage,
    ]);
  }
  if (!route.languageGroup || !route.modelVersion) return undefined;
  return Object.freeze([
    providerId,
    'tesseract.js-7.0.0',
    route.modelVersion,
    route.sourceLanguage ?? '',
    route.languageGroup,
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
        providerId === 'tesseract'
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
  'chrome-text-detector' | 'tesseract'
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

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function expiresAt(now: number, maxAgeMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + maxAgeMs);
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
