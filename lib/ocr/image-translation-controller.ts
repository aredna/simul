import type { ReplicaCaptureRequest } from '../replica/contracts';
import { createReplicaIdentity } from '../replica/protocol-v2';
import {
  sourceDocumentIdentity,
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';
import type { ReplicaImageAnchor } from '../replica/rrweb-shadow-engine';
import type { SourceLanguagePreference } from '../preferences';
import { translateWithSession } from '../translation-pipeline';
import { TranslationMemory } from '../translation/translation-memory';
import type {
  SupportedLanguage,
  TranslationPair,
  TranslationProvider,
  TranslationSession,
} from '../translation-provider';
import type {
  ImageScanPolicy,
  SourceImageChange,
  SourceImageDescriptor,
} from './contracts';
import {
  ImageRecognitionCoordinator,
  type ImageRecognitionRoute,
} from './image-analysis-coordinator';
import {
  ImageOverlayProjector,
  type ImageOverlayProjection,
  type ImageOverlayProjectorEnvironment,
  type TranslatedImageRegion,
} from './image-overlay-projector';
import {
  ImageScanScheduler,
  type ImageScanJob,
} from './image-scan-scheduler';
import {
  isImageSourceUnavailableError,
  type ImageSourceLease,
} from './image-source-client';
import type { ImageTextProviderId } from './known-provider-ids';
import {
  PixelAcquisitionCoordinator,
  type AcquiredImagePixels,
} from './pixel-acquisition';
import {
  resolveTesseractLanguageRoute,
  TESSERACT_MODEL_VERSION,
} from './providers/tesseract/language-catalog';

const MUTATION_QUIET_MS = 1_000;
const MAX_TRANSLATED_IMAGE_REGIONS = 512;

export interface ImageTranslationConfiguration {
  readonly enabled: boolean;
  readonly scanPolicy: ImageScanPolicy;
  readonly skipSmallImages: boolean;
  readonly providerOrder: readonly ImageTextProviderId[];
  readonly sourceLanguage: SourceLanguagePreference;
  readonly detectedSourceLanguage?: SupportedLanguage;
  readonly targetLanguage: SupportedLanguage;
  readonly translationIdle: boolean;
}

export type ImageTranslationDiagnostic =
  | 'source-unavailable'
  | 'capture-deferred'
  | 'unsupported-language'
  | 'recognition-failed'
  | 'translation-failed'
  | 'projected';

export interface ImageTranslationControllerEnvironment {
  readonly openSource: (
    request: ReplicaCaptureRequest,
    onChange: (change: SourceImageChange) => void,
    signal?: AbortSignal,
  ) => Promise<ImageSourceLease>;
  readonly createPixelCoordinator: (
    source: ImageSourceLease,
    sourceTabId: number,
    sourceWindowId: number,
  ) => PixelAcquisitionCoordinator;
  readonly createRecognitionCoordinator: () => ImageRecognitionCoordinator;
  readonly resolveAnchor: (
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
  ) => ReplicaImageAnchor | undefined;
  readonly translationProvider: TranslationProvider;
  readonly translationMemory?: TranslationMemory;
  readonly onDiagnostic?: (diagnostic: ImageTranslationDiagnostic) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
  readonly projector?: Partial<
    Pick<
      ImageOverlayProjectorEnvironment,
      'scheduleFrame' | 'cancelFrame' | 'createResizeObserver'
    >
  >;
}

/** Capacity-one, opt-in orchestration from source image facts to replay overlays. */
export class ImageTranslationController {
  readonly #projector: ImageOverlayProjector;
  readonly #translationMemory: TranslationMemory;
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  readonly #descriptors = new Map<number, SourceImageDescriptor>();
  readonly #projectedHashes = new Map<number, string>();
  #configuration: ImageTranslationConfiguration;
  #request: ReplicaCaptureRequest | undefined;
  #sourceWindowId: number | undefined;
  #document: ReplicaSourceDocumentIdentity | undefined;
  #source: ImageSourceLease | undefined;
  #pixels: PixelAcquisitionCoordinator | undefined;
  #recognition: ImageRecognitionCoordinator | undefined;
  #scheduler: ImageScanScheduler | undefined;
  #sourceAbortController: AbortController | undefined;
  #activeAbortController: AbortController | undefined;
  #quietTimer: ReturnType<typeof setTimeout> | undefined;
  #processing = false;
  #disposed = false;
  #sourceVersion = 0;
  #processingVersion = 0;
  #pairEpoch = 0;
  #pairKey: string | undefined;
  #mutationQuiet = false;
  #replayLease = 0;
  #sourceRecoveryKey: string | undefined;
  #sourceReconnectUsed = false;

  constructor(private readonly environment: ImageTranslationControllerEnvironment) {
    this.#translationMemory = environment.translationMemory ?? new TranslationMemory();
    this.#setTimer = environment.setTimer ?? setTimeout;
    this.#clearTimer = environment.clearTimer ?? clearTimeout;
    this.#configuration = {
      enabled: false,
      scanPolicy: 'visible-first-background-prescan',
      skipSmallImages: true,
      providerOrder: [],
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      translationIdle: true,
    };
    this.#projector = new ImageOverlayProjector({
      resolveAnchor: environment.resolveAnchor,
      isCurrent: (projection) => this.#isProjectionCurrent(projection),
      ...environment.projector,
    });
    this.#beginPair();
  }

  get busy(): boolean {
    return this.#processing;
  }

  configure(configuration: ImageTranslationConfiguration): void {
    if (this.#disposed) return;
    const previous = this.#configuration;
    this.#configuration = Object.freeze({
      ...configuration,
      providerOrder: Object.freeze([...configuration.providerOrder]),
    });
    const enabled = this.#isEnabled();
    const wasEnabled = previous.enabled &&
      previous.providerOrder.includes('tesseract');
    const pairChanged = pairConfigurationKey(previous) !==
      pairConfigurationKey(this.#configuration);
    if (!enabled) {
      if (wasEnabled || this.#source) this.#stopSource(false);
      this.#beginPair();
      return;
    }
    if (pairChanged) {
      this.#processingVersion += 1;
      this.#activeAbortController?.abort();
      this.#beginPair();
      this.#rebuildScheduler();
    } else {
      this.#scheduler?.configure({
        policy: configuration.scanPolicy,
        skipSmallImages: configuration.skipSmallImages,
      });
      this.#refreshGates();
    }
    if (!wasEnabled && this.#request && this.#sourceWindowId !== undefined) {
      void this.#startSource();
    } else {
      this.#kick();
    }
  }

  commitReplica(request: ReplicaCaptureRequest, sourceWindowId: number): void {
    if (this.#disposed) return;
    const recoveryKey = imageSourceRecoveryKey(request, sourceWindowId);
    if (recoveryKey !== this.#sourceRecoveryKey) {
      this.#sourceRecoveryKey = recoveryKey;
      this.#sourceReconnectUsed = false;
    }
    this.#request = request;
    this.#sourceWindowId = sourceWindowId;
    this.#document = sourceDocumentIdentity(createReplicaIdentity({
      sessionId: request.sessionId,
      pageEpoch: request.pageEpoch,
      generation: request.generation,
      documentId: request.documentId,
      frameId: request.frameId,
      sequence: 0,
    }));
    if (this.#isEnabled()) void this.#startSource();
  }

  notifyReplicaCommit(replayLease: number): void {
    if (!Number.isSafeInteger(replayLease) || replayLease < 1) return;
    if (this.#replayLease !== 0 && this.#replayLease !== replayLease) {
      this.#projectedHashes.clear();
      this.#projector.clear();
      this.#rebuildScheduler();
    } else {
      this.#projector.refresh();
    }
    this.#replayLease = replayLease;
    this.#refreshGates();
    this.#kick();
  }

  refreshOverlays(): void {
    this.#projector.refresh();
  }

  /** Cancel the current image job without immediately requeueing it. */
  cancelCurrent(): boolean {
    const job = this.#activeJob();
    const scheduler = this.#scheduler;
    const abortController = this.#activeAbortController;
    if (!job || !scheduler || !abortController) return false;
    this.#processingVersion += 1;
    scheduler.defer(job);
    abortController.abort();
    return true;
  }

  releaseReplica(): void {
    this.#request = undefined;
    this.#sourceWindowId = undefined;
    this.#document = undefined;
    this.#replayLease = 0;
    this.#sourceRecoveryKey = undefined;
    this.#sourceReconnectUsed = false;
    this.#stopSource(false);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.releaseReplica();
    this.#recognition?.clear();
    this.#recognition = undefined;
    this.#projector.dispose();
  }

  async #startSource(): Promise<void> {
    const request = this.#request;
    const sourceWindowId = this.#sourceWindowId;
    const document = this.#document;
    if (
      !request ||
      sourceWindowId === undefined ||
      !document ||
      !request.isCurrent() ||
      !this.#isEnabled()
    ) return;
    this.#stopSource(true);
    const version = ++this.#sourceVersion;
    const abortController = new AbortController();
    this.#sourceAbortController = abortController;
    this.#scheduler = this.#createScheduler(document);
    this.#setMutationQuiet(false);
    try {
      const source = await this.environment.openSource(
        request,
        (change) => this.#onSourceChange(change, version),
        abortController.signal,
      );
      if (
        version !== this.#sourceVersion ||
        abortController.signal.aborted ||
        !request.isCurrent() ||
        !this.#isEnabled()
      ) {
        source.dispose();
        return;
      }
      this.#source = source;
      if (source.unavailable) {
        void source.unavailable.then((error) => {
          this.#handleSourceUnavailable(error, version);
        });
      }
      this.#pixels = this.environment.createPixelCoordinator(
        source,
        request.tabId,
        sourceWindowId,
      );
      this.#refreshGates();
      this.#kick();
    } catch (error) {
      if (!abortController.signal.aborted && !isAbortError(error)) {
        this.#handleSourceUnavailable(error, version);
      }
    }
  }

  #handleSourceUnavailable(_error: unknown, sourceVersion: number): void {
    if (
      sourceVersion !== this.#sourceVersion ||
      this.#disposed ||
      !this.#isEnabled() ||
      !this.#request?.isCurrent() ||
      !this.#sourceRecoveryKey
    ) return;
    this.environment.onDiagnostic?.('source-unavailable');
    if (this.#sourceReconnectUsed) {
      this.#stopSource(true);
      return;
    }
    this.#sourceReconnectUsed = true;
    void this.#startSource();
  }

  #stopSource(retainRequest: boolean): void {
    this.#sourceVersion += 1;
    this.#processingVersion += 1;
    this.#sourceAbortController?.abort();
    this.#sourceAbortController = undefined;
    this.#activeAbortController?.abort();
    this.#activeAbortController = undefined;
    this.#source?.dispose();
    this.#source = undefined;
    this.#pixels = undefined;
    this.#scheduler?.clear();
    this.#scheduler = undefined;
    this.#descriptors.clear();
    this.#projectedHashes.clear();
    this.#projector.clear();
    this.#setMutationQuiet(false, false);
    this.#setProcessing(false);
    if (!retainRequest) {
      this.#document = this.#request
        ? sourceDocumentIdentity(createReplicaIdentity({
            sessionId: this.#request.sessionId,
            pageEpoch: this.#request.pageEpoch,
            generation: this.#request.generation,
            documentId: this.#request.documentId,
            frameId: this.#request.frameId,
            sequence: 0,
          }))
        : undefined;
    }
  }

  #onSourceChange(change: SourceImageChange, sourceVersion: number): void {
    if (
      sourceVersion !== this.#sourceVersion ||
      !this.#scheduler ||
      !this.#document ||
      !this.#isEnabled()
    ) return;
    if (change.kind === 'upsert') {
      const previous = this.#descriptors.get(change.descriptor.nodeId);
      this.#descriptors.set(change.descriptor.nodeId, change.descriptor);
      if (
        previous &&
        (previous.contentRevision !== change.descriptor.contentRevision ||
          previous.observationRevision !==
            change.descriptor.observationRevision)
      ) {
        this.#projectedHashes.delete(change.descriptor.nodeId);
        this.#projector.remove(change.descriptor.document, change.descriptor.nodeId);
      }
    } else {
      this.#descriptors.delete(change.nodeId);
      this.#projectedHashes.delete(change.nodeId);
      this.#projector.remove(change.document, change.nodeId);
    }
    this.#scheduler.apply(change);
    for (const cancellation of this.#scheduler.drainCancellations()) {
      if (
        cancellation.job.descriptor.nodeId ===
        this.#activeJob()?.descriptor.nodeId
      ) this.#activeAbortController?.abort();
    }
    this.#setMutationQuiet(false);
    this.#kick();
  }

  #activeJobValue: ImageScanJob | undefined;

  #activeJob(): ImageScanJob | undefined {
    return this.#activeJobValue;
  }

  #kick(): void {
    if (
      this.#processing ||
      !this.#isEnabled() ||
      !this.#source ||
      !this.#pixels ||
      !this.#scheduler ||
      this.#scheduler.queued === 0 ||
      !this.#request?.isCurrent()
    ) return;
    void this.#process();
  }

  async #process(): Promise<void> {
    const scheduler = this.#scheduler;
    const pixels = this.#pixels;
    const request = this.#request;
    if (!scheduler || !pixels || !request || this.#processing) return;
    const processingVersion = this.#processingVersion;
    const sourceVersion = this.#sourceVersion;
    this.#setProcessing(true);
    try {
      for (;;) {
        if (
          processingVersion !== this.#processingVersion ||
          scheduler !== this.#scheduler ||
          !request.isCurrent() ||
          !this.#isEnabled()
        ) return;
        const job = scheduler.takeNext();
        if (!job) return;
        this.#activeJobValue = job;
        const abortController = new AbortController();
        this.#activeAbortController = abortController;
        try {
          await this.#processJob(
            job,
            scheduler,
            pixels,
            processingVersion,
            abortController.signal,
          );
        } catch (error) {
          if (isImageSourceUnavailableError(error)) {
            scheduler.defer(job);
            this.#handleSourceUnavailable(error, sourceVersion);
            return;
          }
          if (!isAbortError(error) && !abortController.signal.aborted) {
            this.environment.onDiagnostic?.('translation-failed');
            scheduler.settle(job);
          } else if (
            processingVersion === this.#processingVersion &&
            scheduler === this.#scheduler
          ) {
            scheduler.retry(job);
          }
        } finally {
          if (this.#activeAbortController === abortController) {
            this.#activeAbortController = undefined;
          }
          this.#activeJobValue = undefined;
        }
      }
    } finally {
      this.#setProcessing(false);
      if (processingVersion === this.#processingVersion) this.#kick();
    }
  }

  async #processJob(
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    pixelCoordinator: PixelAcquisitionCoordinator,
    processingVersion: number,
    signal: AbortSignal,
  ): Promise<void> {
    const pairEpoch = this.#pairEpoch;
    const pairKey = this.#pairKey;
    const anchor = this.environment.resolveAnchor(
      job.descriptor.document,
      job.descriptor.nodeId,
    );
    if (!anchor || !pairKey) {
      scheduler.defer(job);
      return;
    }
    const replayLease = anchor.replayLease;
    const acquisition = await pixelCoordinator.acquire(job.descriptor, signal);
    if (acquisition.status !== 'ready') {
      scheduler.defer(job);
      this.environment.onDiagnostic?.('capture-deferred');
      return;
    }
    const pixels = acquisition.pixels;
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Image job became stale.', 'AbortError');
    }
    const languageRoute = resolveTesseractLanguageRoute({
      nearestElementLanguage: pixels.nearestElementLanguage,
      ...(this.#configuration.sourceLanguage === 'auto'
        ? {}
        : { explicitSourceLanguage: this.#configuration.sourceLanguage }),
      ...(this.#configuration.detectedSourceLanguage
        ? { detectedPageLanguage: this.#configuration.detectedSourceLanguage }
        : {}),
    });
    if (!languageRoute) {
      scheduler.settle(job);
      this.environment.onDiagnostic?.('unsupported-language');
      return;
    }
    const { sourceLanguage, languageGroup } = languageRoute;
    if (sourceLanguage === this.#configuration.targetLanguage) {
      this.#projectedHashes.delete(job.descriptor.nodeId);
      this.#projector.remove(job.descriptor.document, job.descriptor.nodeId);
      scheduler.settle(job);
      return;
    }
    const route: ImageRecognitionRoute = {
      languageGroup,
      modelVersion: TESSERACT_MODEL_VERSION,
    };
    const recognition = await this.#recognizer().recognize(pixels, route, signal);
    if (recognition.status !== 'complete') {
      scheduler.settle(job);
      this.environment.onDiagnostic?.('recognition-failed');
      return;
    }
    const pair: TranslationPair = {
      sourceLanguage,
      targetLanguage: this.#configuration.targetLanguage,
    };
    const regions = await this.#translateRegions(
      recognition.result.regions,
      pair,
      signal,
    );
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Image translation became stale.', 'AbortError');
    }
    const projection: ImageOverlayProjection = {
      document: job.descriptor.document,
      nodeId: job.descriptor.nodeId,
      contentRevision: job.descriptor.contentRevision,
      observationRevision: job.descriptor.observationRevision,
      replayLease,
      pairEpoch,
      pairKey,
      pixelHash: pixels.pixelHash,
      bitmapWidth: pixels.bitmapWidth,
      bitmapHeight: pixels.bitmapHeight,
      cropOffsetXCss: pixels.cropOffsetXCss,
      cropOffsetYCss: pixels.cropOffsetYCss,
      cropWidthCss: pixels.cropWidthCss,
      cropHeightCss: pixels.cropHeightCss,
      renderedWidthCss: pixels.renderedWidthCss,
      renderedHeightCss: pixels.renderedHeightCss,
      regions,
    };
    this.#projectedHashes.set(job.descriptor.nodeId, pixels.pixelHash);
    if (!this.#projector.project(projection)) {
      this.#projectedHashes.delete(job.descriptor.nodeId);
      scheduler.defer(job);
      return;
    }
    scheduler.settle(job);
    this.environment.onDiagnostic?.('projected');
  }

  async #translateRegions(
    regions: readonly {
      readonly text: string;
      readonly boundingBox: TranslatedImageRegion['boundingBox'];
    }[],
    pair: TranslationPair,
    signal: AbortSignal,
  ): Promise<readonly TranslatedImageRegion[]> {
    if (regions.length === 0) return Object.freeze([]);
    let session: TranslationSession | undefined;
    try {
      session = await this.environment.translationProvider.createSession(pair, {
        signal,
      });
      const translated: TranslatedImageRegion[] = [];
      for (const region of regions.slice(0, MAX_TRANSLATED_IMAGE_REGIONS)) {
        signal.throwIfAborted();
        const text = await this.#translationMemory.getOrCreate(
          { provider: 'chrome-translator-v1', pair },
          region.text,
          () => translateWithSession(session as TranslationSession, region.text, signal),
        );
        if (text.trim()) {
          translated.push(Object.freeze({
            text: text.trim(),
            boundingBox: region.boundingBox,
          }));
        }
      }
      return Object.freeze(translated);
    } finally {
      session?.destroy();
    }
  }

  #recognizer(): ImageRecognitionCoordinator {
    return this.#recognition ??= this.environment.createRecognitionCoordinator();
  }

  #isJobCurrent(
    job: ImageScanJob,
    processingVersion: number,
    pairEpoch: number,
    pairKey: string,
  ): boolean {
    const current = this.#descriptors.get(job.descriptor.nodeId);
    return Boolean(
      processingVersion === this.#processingVersion &&
      pairEpoch === this.#pairEpoch &&
      pairKey === this.#pairKey &&
      current &&
      sameSourceDocument(current.document, job.descriptor.document) &&
      current.contentRevision === job.descriptor.contentRevision &&
      current.observationRevision === job.descriptor.observationRevision &&
      this.#request?.isCurrent(),
    );
  }

  #isProjectionCurrent(projection: ImageOverlayProjection): boolean {
    const current = this.#descriptors.get(projection.nodeId);
    return Boolean(
      this.#isEnabled() &&
      projection.pairEpoch === this.#pairEpoch &&
      projection.pairKey === this.#pairKey &&
      this.#projectedHashes.get(projection.nodeId) === projection.pixelHash &&
      current &&
      sameSourceDocument(current.document, projection.document) &&
      current.contentRevision === projection.contentRevision &&
      current.observationRevision === projection.observationRevision &&
      this.#request?.isCurrent(),
    );
  }

  #createScheduler(
    document: ReplicaSourceDocumentIdentity,
  ): ImageScanScheduler {
    const scheduler = new ImageScanScheduler(document, {
      policy: this.#configuration.scanPolicy,
      skipSmallImages: this.#configuration.skipSmallImages,
    });
    scheduler.setGates(this.#gates());
    return scheduler;
  }

  #rebuildScheduler(): void {
    if (!this.#document || !this.#source) return;
    this.#scheduler?.clear();
    this.#scheduler = this.#createScheduler(this.#document);
    for (const descriptor of this.#descriptors.values()) {
      this.#scheduler.apply({ kind: 'upsert', descriptor });
    }
    this.#kick();
  }

  #refreshGates(): void {
    this.#scheduler?.setGates(this.#gates());
  }

  #gates() {
    return {
      replicaCommitted: this.#replayLease > 0,
      documentReady: Boolean(this.#request?.isCurrent()),
      translationIdle: this.#configuration.translationIdle,
      mutationQuiet: this.#mutationQuiet,
    } as const;
  }

  #setMutationQuiet(quiet: boolean, schedule = true): void {
    if (this.#quietTimer !== undefined) this.#clearTimer(this.#quietTimer);
    this.#quietTimer = undefined;
    this.#mutationQuiet = quiet;
    this.#refreshGates();
    if (!quiet && schedule && this.#isEnabled()) {
      this.#quietTimer = this.#setTimer(() => {
        this.#quietTimer = undefined;
        this.#mutationQuiet = true;
        this.#refreshGates();
        this.#kick();
      }, MUTATION_QUIET_MS);
    }
  }

  #beginPair(): void {
    this.#pairEpoch += 1;
    this.#pairKey = this.#isEnabled()
      ? `${this.#configuration.sourceLanguage === 'auto'
          ? this.#configuration.detectedSourceLanguage ?? 'auto'
          : this.#configuration.sourceLanguage}>${this.#configuration.targetLanguage}`
      : undefined;
    this.#projectedHashes.clear();
    this.#projector.beginPair(this.#pairEpoch, this.#pairKey);
  }

  #isEnabled(): boolean {
    return !this.#disposed &&
      this.#configuration.enabled &&
      this.#configuration.providerOrder.includes('tesseract');
  }

  #setProcessing(value: boolean): void {
    if (this.#processing === value) return;
    this.#processing = value;
    this.environment.onBusyChange?.(value);
  }
}

function pairConfigurationKey(
  configuration: ImageTranslationConfiguration,
): string {
  return [
    configuration.enabled ? '1' : '0',
    configuration.sourceLanguage,
    configuration.detectedSourceLanguage ?? '',
    configuration.targetLanguage,
    configuration.providerOrder.join(','),
  ].join(':');
}

function imageSourceRecoveryKey(
  request: ReplicaCaptureRequest,
  sourceWindowId: number,
): string {
  return JSON.stringify([
    request.tabId,
    sourceWindowId,
    request.sessionId,
    request.pageEpoch,
    request.generation,
    request.documentId,
    request.frameId,
  ]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
