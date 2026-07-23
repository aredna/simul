import type {
  ReplicaCaptureRequest,
  ReplicaImageAnchor,
} from '../replica/contracts';
import {
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
  type TimeoutCanceller,
  type TimeoutScheduler,
} from '../browser-scheduling';
import { createReplicaIdentity } from '../replica/protocol-v2';
import {
  sourceDocumentIdentity,
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';
import type { SourceLanguagePreference } from '../preferences';
import { translateWithSession } from '../translation-pipeline';
import { TranslationMemory } from '../translation/translation-memory';
import type {
  SupportedLanguage,
  TranslationPair,
  TranslationProvider,
  TranslationSession,
} from '../translation-provider';
import { canonicalizeLanguageTag } from '../translation-provider';
import {
  AUTO_LANGUAGE_PROBE_MINIMUM_CONFIDENCE,
  AutoImageLanguageProbe,
  createAutoLanguageProbeSampleIdentity,
  MAX_AUTO_LANGUAGE_PROBE_ATTEMPTS,
  MAX_AUTO_LANGUAGE_PROBE_IMAGES,
  strongAutoLanguageScriptEvidence,
  type AutoLanguageProbeObservation,
  type AutoLanguageProbeEvidence,
  type AutoLanguageProbeInconclusiveReason,
  type AutoLanguageProbeObservationResult,
  type AutoLanguageProbeSampleIdentity,
} from './auto-language-probe';
import type {
  ImageScanPolicy,
  ImageTextResult,
  SourceImageChange,
  SourceImageDescriptor,
} from './contracts';
import {
  ImageRecognitionCoordinator,
  type ImageRecognitionCacheAccess,
  type ImageRecognitionCacheStats,
  type ImageRecognitionResult,
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
  type ImageScanUpdateResult,
} from './image-scan-scheduler';
import { decideSmallImageEligibility } from './small-image-policy';
import {
  isImageSourceUnavailableError,
  type ImageSourceLease,
} from './image-source-client';
import type { ImageTextProviderId } from './known-provider-ids';
import type { SourceImageAccessibilityTextEvidence } from './image-source-protocol';
import {
  assessSemanticImageEvidence,
  IMAGE_EVIDENCE_RANKING_POLICY_VERSION,
  ImageSemanticEvidenceIndex,
  selectImageTextEvidence,
  type ImageEvidenceSelectionReason,
  type RankableSemanticImageEvidence,
} from './image-evidence-ranker';
import {
  ACCESSIBILITY_TEXT_METHOD_ID,
  imageReadingExecutionPlan,
  type ImageReadingMethodId,
} from './image-reading-methods';
import type { ImageSourceReadPolicy } from './image-source-client';
import {
  PixelAcquisitionCoordinator,
  type AcquiredImagePixels,
  type PixelAcquisitionResult,
} from './pixel-acquisition';
import type { OcrHostErrorCode } from './offscreen-protocol';
import type { ImageReplicaNotActivatedReason } from './replica-activation';
import {
  resolveImageSourceLanguage,
  tesseractLanguageGroupFor,
  TESSERACT_MODEL_VERSION,
} from './providers/tesseract/language-catalog';
import type { ImageTextQualitySummary } from './result-quality';
import {
  emptyImageTextQualitySummary,
  ocrQualityPolicyKey,
  repairOcrMinimumConfidence,
  type OcrMinimumConfidence,
} from './result-quality';

const MUTATION_QUIET_MS = 1_000;
const MAX_TRANSLATED_IMAGE_REGIONS = 512;
const MAX_TRANSIENT_CAPTURE_RETRIES = 1;
const MAX_UNCHANGED_EMPTY_RETRIES = 2;

export interface ImageTranslationConfiguration {
  readonly enabled: boolean;
  readonly scanPolicy: ImageScanPolicy;
  readonly skipSmallImages: boolean;
  readonly providerOrder: readonly ImageTextProviderId[];
  readonly methodOrder?: readonly ImageReadingMethodId[];
  readonly disabledMethodIds?: readonly ImageReadingMethodId[];
  readonly policyFingerprint?: string;
  readonly controlImages?: boolean;
  readonly ocrMinimumConfidence?: OcrMinimumConfidence;
  readonly sourceLanguage: SourceLanguagePreference;
  readonly detectedSourceLanguage?: SupportedLanguage;
  readonly pageLanguageResolutionPending?: boolean;
  readonly targetLanguage: SupportedLanguage;
  readonly translationIdle: boolean;
  readonly resetEpoch: number;
}

export type AutoImageLanguageEvidenceOrigin =
  | 'accessibility-text'
  | 'ocr';

export type ImageTranslationDiagnosticStage =
  | 'disabled'
  | 'waiting-for-replica'
  | 'replica-ready'
  | 'source-connecting'
  | 'source-connected'
  | 'source-empty'
  | 'image-discovered'
  | 'image-queued'
  | 'image-coalesced'
  | 'image-skipped'
  | 'anchor-deferred'
  | 'capture-started'
  | 'source-unavailable'
  | 'capture-deferred'
  | 'unsupported-language'
  | 'same-language'
  | 'recognition-started'
  | 'recognition-failed'
  | 'no-text-found'
  | 'translation-started'
  | 'translation-failed'
  | 'translation-empty'
  | 'projection-deferred'
  | 'accessibility-text-started'
  | 'accessibility-text-empty'
  | 'accessibility-text-blocked'
  | 'accessibility-text-complete'
  | 'projected';

type ImageCaptureDeferralReason = Extract<
  PixelAcquisitionResult,
  { readonly status: 'deferred' }
>['reason'];

/**
 * Console-only, content-free details. These deliberately exclude URLs, text,
 * pixels, hashes, source node IDs, and document identifiers.
 */
export type ImageTranslationDiagnostic =
  | ImageTranslationDiagnosticStage
  | Readonly<{
      stage: 'configuration';
      status: 'disabled' | 'waiting-for-replica';
      reason?: 'feature-off' | 'provider-unavailable' | 'same-language';
    }>
  | Readonly<{
      stage: 'replica-not-activated';
      reason: ImageReplicaNotActivatedReason;
    }>
  | Readonly<{
      stage: 'source-summary';
      candidateImages: number;
      observedImages: number;
    }>
  | Readonly<{
      stage: 'image-scheduling';
      status: ImageScanUpdateResult['status'];
      reason?: string;
      visibility: SourceImageDescriptor['visibility'];
      renderedWidth: number;
      renderedHeight: number;
    }>
  | Readonly<{
      stage: 'capture-deferred';
      ordinal: number;
      reason: ImageCaptureDeferralReason;
      renderedWidth: number;
      renderedHeight: number;
    }>
  | Readonly<{
      stage: 'recognition-failed';
      code: OcrHostErrorCode;
      ordinal: number;
      renderedWidth: number;
      renderedHeight: number;
      bitmapWidth: number;
      bitmapHeight: number;
    }>
  | Readonly<{
      stage: 'recognition-complete';
      provider: ImageTextProviderId;
      regions: number;
      cacheHit: boolean;
      ordinal: number;
      bitmapWidth: number;
      bitmapHeight: number;
    }>
  | Readonly<{
      stage: 'recognition-cache';
      access: ImageRecognitionCacheAccess;
      entries: number;
      weight: number;
      hits: number;
      misses: number;
      joins: number;
      loads: number;
    }>
  | Readonly<{
      stage: 'recognition-quality';
      candidateRegions: number;
      acceptedRegions: number;
      rejectedBlankRegions: number;
      rejectedPunctuationRegions: number;
      rejectedLowConfidenceRegions: number;
      rejectedUncorroboratedRegions: number;
      uncertainRegions: number;
      corroboratedRegions: number;
    }>
  | Readonly<{
      stage: 'evidence-selection';
      selected: 'semantic' | 'ocr';
      reason:
        | ImageEvidenceSelectionReason
        | 'semantic-fallback'
        | 'ocr-fallback';
    }>
  | Readonly<{
      stage: 'translation-started' | 'translation-failed' | 'translation-empty';
      ordinal: number;
      renderedWidth: number;
      renderedHeight: number;
      bitmapWidth: number;
      bitmapHeight: number;
    }>
  | Readonly<{
      stage: 'job-progress';
      ordinal: number;
      status:
        | 'capture-started'
        | 'capture-retry'
        | 'capture-retry-exhausted'
        | 'recognition-started'
        | 'no-text-retry'
        | 'no-text-changed'
        | 'projection-deferred'
        | 'projected'
        | 'anchor-rebound';
      renderedWidth: number;
      renderedHeight: number;
      bitmapWidth?: number;
      bitmapHeight?: number;
      attempt?: number;
    }>
  | Readonly<{
      stage: 'auto-language-probe-started';
      maxImages: number;
      maxAttempts: number;
    }>
  | Readonly<{
      stage: 'auto-language-probe-attempt';
      attempt: number;
      sample: number;
      candidateLanguage: SupportedLanguage;
    }>
  | Readonly<{
      stage: 'auto-language-probe-resolved';
      language: SupportedLanguage;
      evidence: AutoLanguageProbeEvidence;
      attempts: number;
      samples: number;
    }>
  | Readonly<{
      stage: 'auto-language-probe-inconclusive';
      reason: AutoLanguageProbeInconclusiveReason;
      attempts: number;
      samples: number;
    }>;

export interface ImageTranslationControllerEnvironment {
  readonly openSource: (
    request: ReplicaCaptureRequest,
    onChange: (change: SourceImageChange) => void,
    signal?: AbortSignal,
    policy?: ImageSourceReadPolicy,
  ) => Promise<ImageSourceLease>;
  readonly createPixelCoordinator: (
    source: ImageSourceLease,
    sourceTabId: number,
    sourceWindowId: number,
  ) => PixelAcquisitionCoordinator;
  readonly createRecognitionCoordinator: (
    resetEpoch: number,
  ) => ImageRecognitionCoordinator;
  readonly resolveAnchor: (
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
  ) => ReplicaImageAnchor | undefined;
  readonly translationProvider: TranslationProvider;
  readonly translationMemory?: TranslationMemory;
  readonly onDiagnostic?: (diagnostic: ImageTranslationDiagnostic) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly detectLanguage?: (
    text: string,
  ) => Promise<{
    isReliable: boolean;
    languages: readonly { language: string; percentage: number }[];
  }>;
  readonly onAutoLanguageDetected?: (
    language: SupportedLanguage,
    evidence: AutoLanguageProbeEvidence,
    document: ReplicaSourceDocumentIdentity,
    origin: AutoImageLanguageEvidenceOrigin,
  ) => void;
  readonly now?: () => number;
  readonly setTimer?: TimeoutScheduler;
  readonly clearTimer?: TimeoutCanceller;
  readonly projector?: Partial<
    Pick<
      ImageOverlayProjectorEnvironment,
      'scheduleFrame' | 'cancelFrame' | 'createResizeObserver'
    >
  >;
}

interface AutoLanguageProbeOcrProgress {
  readonly routes: readonly SupportedLanguage[];
  readonly completedOcrGroups: Set<number>;
}

interface PendingSemanticImageEvidence {
  readonly evidence: SourceImageAccessibilityTextEvidence;
  readonly sourceLanguage: SupportedLanguage;
  readonly rankable: RankableSemanticImageEvidence;
}

type CompleteImageRecognition = Extract<
  ImageRecognitionResult,
  { readonly status: 'complete' }
>;

interface PendingAutoLanguageOcrObservation {
  readonly probe: AutoImageLanguageProbe;
  readonly observation: AutoLanguageProbeObservation;
}

interface SelectedAutoLanguageOcrObservation {
  readonly sourceLanguage: SupportedLanguage;
  readonly pendingObservation: PendingAutoLanguageOcrObservation;
}

interface ProbedImageLanguage {
  readonly sourceLanguage: SupportedLanguage;
  readonly pendingObservation?: PendingAutoLanguageOcrObservation;
}

interface PendingOcrImageEvidence {
  readonly recognition: CompleteImageRecognition;
  readonly pixels: AcquiredImagePixels;
  readonly sourceLanguage: SupportedLanguage;
  readonly methodIndex: number;
  readonly pendingAutoLanguageObservation?:
    PendingAutoLanguageOcrObservation;
  readonly autoLanguageVoteEligible?: boolean;
}

/** Capacity-one, opt-in orchestration from source image facts to replay overlays. */
export class ImageTranslationController {
  readonly #projector: ImageOverlayProjector;
  readonly #translationMemory: TranslationMemory;
  readonly #setTimer: TimeoutScheduler;
  readonly #clearTimer: TimeoutCanceller;
  readonly #descriptors = new Map<number, SourceImageDescriptor>();
  readonly #projectedHashes = new Map<number, string>();
  readonly #projectedOrdinals = new Map<number, number>();
  readonly #captureRetries = new Map<number, {
    readonly contentRevision: number;
    readonly observationRevision: number;
    attempts: number;
  }>();
  readonly #emptyRetries = new Map<number, {
    readonly contentRevision: number;
    readonly observationRevision: number;
    pixelHash: string;
    attempts: number;
  }>();
  readonly #probeSampleIdentities = new Map<
    number,
    AutoLanguageProbeSampleIdentity
  >();
  readonly #probeOcrProgress = new Map<
    AutoLanguageProbeSampleIdentity,
    AutoLanguageProbeOcrProgress
  >();
  readonly #semanticEvidenceIndex = new ImageSemanticEvidenceIndex();
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
  #configurationDiagnosticKey: string | undefined;
  #nextJobOrdinal = 0;
  #autoLanguageProbe: AutoImageLanguageProbe | undefined;
  #probeDetectedSourceLanguage: SupportedLanguage | undefined;
  #probeSchedulerRebuildRequested = false;
  #probeInconclusiveReported = false;
  #probeStartedReported = false;
  #probeDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #probeLifetimeAbortController: AbortController | undefined;
  readonly #now: () => number;

  constructor(private readonly environment: ImageTranslationControllerEnvironment) {
    this.#translationMemory = environment.translationMemory ?? new TranslationMemory();
    this.#setTimer = receiverSafeTimeoutScheduler(environment.setTimer);
    this.#clearTimer = receiverSafeTimeoutCanceller(environment.clearTimer);
    this.#now = environment.now ?? (() => Date.now());
    this.#configuration = {
      enabled: false,
      scanPolicy: 'visible-first-background-prescan',
      skipSmallImages: true,
      providerOrder: [],
      methodOrder: [],
      disabledMethodIds: [],
      policyFingerprint: 'read-v1-000000',
      controlImages: false,
      ocrMinimumConfidence: repairOcrMinimumConfidence(undefined),
      sourceLanguage: 'auto',
      pageLanguageResolutionPending: false,
      targetLanguage: 'en',
      translationIdle: true,
      resetEpoch: 0,
    };
    this.#projector = new ImageOverlayProjector({
      resolveAnchor: environment.resolveAnchor,
      isCurrent: (projection) => this.#isProjectionCurrent(projection),
      onAnchorRebound: (ordinal) => {
        const descriptor = this.#descriptorForProjectedOrdinal(ordinal);
        if (!descriptor) return;
        this.#reportJobProgress(
          ordinal,
          'anchor-rebound',
          descriptor,
        );
      },
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
    const requestedResetEpoch = normalizeResetEpoch(configuration.resetEpoch);
    const resetEpoch = Math.max(previous.resetEpoch, requestedResetEpoch);
    const resetEpochAdvanced = resetEpoch > previous.resetEpoch;
    const probeConfigurationChanged = autoLanguageProbeConfigurationKey(previous) !==
      autoLanguageProbeConfigurationKey(configuration);
    this.#configuration = Object.freeze({
      ...configuration,
      resetEpoch,
      providerOrder: Object.freeze([...configuration.providerOrder]),
      methodOrder: Object.freeze([...(configuration.methodOrder ??
        configuration.providerOrder)]),
      disabledMethodIds: Object.freeze([
        ...(configuration.disabledMethodIds ?? []),
      ]),
    });
    const enabled = this.#isEnabled();
    const wasEnabled = imageTranslationConfigurationEnabled(previous);
    const pairChanged = pairConfigurationKey(previous) !==
      pairConfigurationKey(this.#configuration);
    const imageSourcePolicyChanged = imageSourcePolicyConfigurationKey(previous) !==
      imageSourcePolicyConfigurationKey(this.#configuration);
    const imageContentRetentionBoundary = wasEnabled &&
      (!enabled || imageSourcePolicyChanged);
    if (resetEpochAdvanced) {
      this.#recognition?.advanceResetEpoch(resetEpoch);
    }
    if (resetEpochAdvanced || imageContentRetentionBoundary) {
      this.#translationMemory.clear();
    }
    if (imageContentRetentionBoundary) this.#recognition?.clear();
    if (probeConfigurationChanged || resetEpochAdvanced) {
      this.#resetAutoLanguageProbe();
    }
    const pageResolutionGateChanged =
      Boolean(previous.pageLanguageResolutionPending) !==
      Boolean(this.#configuration.pageLanguageResolutionPending);
    if (!enabled) {
      this.#reportConfigurationState();
      if (wasEnabled || this.#source) this.#stopSource(false);
      this.#beginPair();
      return;
    }
    if (
      wasEnabled &&
      imageSourcePolicyChanged &&
      this.#request &&
      this.#sourceWindowId !== undefined
    ) {
      this.#processingVersion += 1;
      this.#activeAbortController?.abort();
      if (pairChanged || resetEpochAdvanced) this.#beginPair();
      void this.#startSource();
      this.#reportConfigurationState();
      return;
    }
    if (pairChanged || pageResolutionGateChanged || resetEpochAdvanced) {
      this.#processingVersion += 1;
      this.#activeAbortController?.abort();
      if (pairChanged || resetEpochAdvanced) this.#beginPair();
      this.#rebuildScheduler();
    } else {
      this.#scheduler?.configure({
        policy: configuration.scanPolicy,
        skipSmallImages: schedulerSkipsSmallImages(configuration),
      });
      this.#refreshGates();
    }
    if (!wasEnabled && this.#request && this.#sourceWindowId !== undefined) {
      void this.#startSource();
    } else {
      this.#kick();
    }
    this.#reportConfigurationState();
  }

  /**
   * Atomically binds one exact source document to its committed replay lease.
   * A source Port is never opened from a partial request/window/lease handoff.
   */
  activateReplica(
    request: ReplicaCaptureRequest,
    sourceWindowId: number,
    replayLease: number,
  ): boolean {
    if (
      this.#disposed ||
      !Number.isSafeInteger(sourceWindowId) ||
      sourceWindowId < 0 ||
      !isReplayLease(replayLease) ||
      !request.isCurrent()
    ) return false;
    let document: ReplicaSourceDocumentIdentity;
    try {
      document = sourceDocumentIdentity(createReplicaIdentity({
        sessionId: request.sessionId,
        pageEpoch: request.pageEpoch,
        generation: request.generation,
        documentId: request.documentId,
        frameId: request.frameId,
        sequence: 0,
      }));
    } catch {
      return false;
    }
    const sameContext = Boolean(
      this.#request &&
      this.#document &&
      this.#request.tabId === request.tabId &&
      this.#sourceWindowId === sourceWindowId &&
      sameSourceDocument(this.#document, document),
    );
    if (
      sameContext &&
      this.#replayLease === replayLease
    ) {
      // Refresh the currency closure without reopening the exact-document Port
      // when the source-commit callback and post-run backstop report the same
      // authoritative replica.
      this.#request = request;
      this.#projector.refresh();
      this.#refreshGates();
      this.#kick();
      return true;
    }
    if (!sameContext) {
      this.#stopSource(true);
      this.#replayLease = 0;
    }
    const recoveryKey = imageSourceRecoveryKey(request, sourceWindowId);
    if (recoveryKey !== this.#sourceRecoveryKey) {
      this.#sourceRecoveryKey = recoveryKey;
      this.#sourceReconnectUsed = false;
    }
    this.#request = request;
    this.#sourceWindowId = sourceWindowId;
    this.#document = document;
    this.#adoptReplayLease(replayLease);
    this.#reportConfigurationState();
    this.environment.onDiagnostic?.('replica-ready');
    if (this.#isEnabled() && !this.#source && !this.#sourceAbortController) {
      void this.#startSource();
    } else {
      this.#kick();
    }
    return true;
  }

  /** Adopt a live/recovery lease only for the already-active exact document. */
  notifyReplicaCommit(
    document: ReplicaSourceDocumentIdentity,
    replayLease: number,
  ): boolean {
    if (
      !this.#request?.isCurrent() ||
      !this.#document ||
      !sameSourceDocument(this.#document, document) ||
      !isReplayLease(replayLease) ||
      replayLease < this.#replayLease
    ) return false;
    if (replayLease === this.#replayLease) return true;
    this.#adoptReplayLease(replayLease);
    return true;
  }

  #adoptReplayLease(replayLease: number): void {
    if (this.#replayLease !== 0 && this.#replayLease !== replayLease) {
      this.#projectedHashes.clear();
      this.#projectedOrdinals.clear();
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
    this.#recognition?.clear();
    this.#translationMemory.clear();
    this.#reportConfigurationState();
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
    this.environment.onDiagnostic?.('source-connecting');
    try {
      const source = await this.environment.openSource(
        request,
        (change) => this.#onSourceChange(change, version),
        abortController.signal,
        {
          policyFingerprint:
            this.#configuration.policyFingerprint ?? 'read-v1-000000',
          controlImages: this.#configuration.controlImages === true,
          accessibilityTextEnabled: accessibilityMethodEnabled(
            this.#configuration,
          ),
        },
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
      this.environment.onDiagnostic?.('source-connected');
      if (source.ready) {
        void source.ready.then(
          (summary) => {
            if (
              !summary ||
              version !== this.#sourceVersion ||
              source !== this.#source ||
              abortController.signal.aborted ||
              !request.isCurrent()
            ) return;
            this.environment.onDiagnostic?.(Object.freeze({
              stage: 'source-summary' as const,
              candidateImages: summary.candidateImages,
              observedImages: summary.observedImages,
            }));
            if (summary.observedImages === 0) {
              this.environment.onDiagnostic?.('source-empty');
            }
          },
          (error: unknown) => this.#handleSourceUnavailable(error, version),
        );
      }
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
    this.#projectedOrdinals.clear();
    this.#captureRetries.clear();
    this.#emptyRetries.clear();
    this.#semanticEvidenceIndex.clear();
    this.#projector.clear();
    this.#resetAutoLanguageProbe();
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
    const scheduler = this.#scheduler;
    const scheduling = scheduler.apply(change);
    if (change.kind === 'upsert') {
      this.environment.onDiagnostic?.('image-discovered');
      const schedulingStage = scheduling.status === 'queued'
        ? 'image-queued'
        : scheduling.status === 'coalesced'
          ? 'image-coalesced'
          : 'image-skipped';
      this.environment.onDiagnostic?.(schedulingStage);
      const reason = imageSchedulingReason(scheduling);
      this.environment.onDiagnostic?.(Object.freeze({
        stage: 'image-scheduling' as const,
        status: scheduling.status,
        ...(reason ? { reason } : {}),
        visibility: change.descriptor.visibility,
        renderedWidth: change.descriptor.renderedWidth,
        renderedHeight: change.descriptor.renderedHeight,
      }));
    }
    // The scheduler owns exact-document and monotonic-revision validation.
    // Rejected/overflowing changes must not mutate controller-owned evidence,
    // descriptors, projections, or Auto-language votes.
    if (scheduling.status === 'rejected' || scheduling.status === 'overflow') {
      this.#setMutationQuiet(false);
      this.#kick();
      return;
    }

    const semanticPeers = new Set<number>();
    let invalidatedAutoResolution = false;
    if (change.kind === 'upsert') {
      const previous = this.#descriptors.get(change.descriptor.nodeId);
      if (
        previous &&
        previous.contentRevision !== change.descriptor.contentRevision
      ) {
        for (const nodeId of this.#semanticEvidenceIndex.unregister(
          change.descriptor.nodeId,
        ).reevaluateNodeIds) semanticPeers.add(nodeId);
        invalidatedAutoResolution = this.#forgetAutoLanguageProbeSample(
          change.descriptor.nodeId,
        ) || invalidatedAutoResolution;
      }
      this.#descriptors.set(change.descriptor.nodeId, change.descriptor);
      if (
        previous &&
        (previous.contentRevision !== change.descriptor.contentRevision ||
          previous.observationRevision !==
            change.descriptor.observationRevision)
      ) {
        this.#projectedHashes.delete(change.descriptor.nodeId);
        this.#projectedOrdinals.delete(change.descriptor.nodeId);
        this.#captureRetries.delete(change.descriptor.nodeId);
        this.#emptyRetries.delete(change.descriptor.nodeId);
        this.#projector.remove(change.descriptor.document, change.descriptor.nodeId);
      }
    } else {
      for (const nodeId of this.#semanticEvidenceIndex.unregister(
        change.nodeId,
      ).reevaluateNodeIds) semanticPeers.add(nodeId);
      invalidatedAutoResolution = this.#forgetAutoLanguageProbeSample(
        change.nodeId,
      ) || invalidatedAutoResolution;
      this.#descriptors.delete(change.nodeId);
      this.#projectedHashes.delete(change.nodeId);
      this.#projectedOrdinals.delete(change.nodeId);
      this.#captureRetries.delete(change.nodeId);
      this.#emptyRetries.delete(change.nodeId);
      this.#projector.remove(change.document, change.nodeId);
    }
    for (const nodeId of semanticPeers) {
      const affected = this.#descriptors.get(nodeId);
      if (!affected) continue;
      invalidatedAutoResolution = this.#forgetAutoLanguageProbeSample(nodeId) ||
        invalidatedAutoResolution;
      this.#clearProjection(affected);
      scheduler.requeueCurrent(affected);
    }
    for (const cancellation of scheduler.drainCancellations()) {
      if (
        cancellation.job.descriptor.nodeId ===
        this.#activeJob()?.descriptor.nodeId
      ) this.#activeAbortController?.abort();
    }
    if (invalidatedAutoResolution) {
      this.#restartAfterAutoLanguageEvidenceInvalidation();
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
      !this.#request?.isCurrent() ||
      this.#pageLanguageResolutionBlocksWork()
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
          !this.#isEnabled() ||
          this.#pageLanguageResolutionBlocksWork()
        ) return;
        const job = scheduler.takeNext();
        if (!job) return;
        const jobOrdinal = this.#nextOrdinal();
        this.#activeJobValue = job;
        const abortController = new AbortController();
        this.#activeAbortController = abortController;
        try {
          await this.#processJob(
            job,
            scheduler,
            pixels,
            processingVersion,
            jobOrdinal,
            abortController.signal,
          );
          if (this.#probeSchedulerRebuildRequested) {
            this.#probeSchedulerRebuildRequested = false;
            this.#rebuildScheduler();
            return;
          }
        } catch (error) {
          if (isImageSourceUnavailableError(error)) {
            scheduler.defer(job);
            this.#handleSourceUnavailable(error, sourceVersion);
            return;
          }
          if (!isAbortError(error) && !abortController.signal.aborted) {
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
      if (
        processingVersion === this.#processingVersion ||
        scheduler !== this.#scheduler
      ) {
        this.#kick();
      }
    }
  }

  async #processJob(
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    pixelCoordinator: PixelAcquisitionCoordinator,
    processingVersion: number,
    jobOrdinal: number,
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
      this.environment.onDiagnostic?.('anchor-deferred');
      return;
    }
    const replayLease = anchor.replayLease;
    const steps = imageReadingExecutionPlan(
      this.#configuration.methodOrder ?? this.#configuration.providerOrder,
      this.#configuration.disabledMethodIds ?? [],
      this.#configuration.providerOrder,
    );
    const ocrStepCount = steps.filter(({ kind }) => kind === 'ocr').length;
    const ocrEligibility = decideSmallImageEligibility(job.descriptor, {
      skipSmallImages: this.#configuration.skipSmallImages,
      manualOverride: job.manualOverride,
    });
    let pixels: AcquiredImagePixels | undefined;
    let captureDeferral: Extract<PixelAcquisitionResult, {
      readonly status: 'deferred';
    }> | undefined;
    let sourceLanguage: SupportedLanguage | undefined;
    let sawOcrStep = false;
    let sawEmptyRecognition = false;
    let unsupportedLanguage = false;
    let ocrStepIndex = 0;
    let heldSemantic: PendingSemanticImageEvidence | undefined;
    let heldOcr: PendingOcrImageEvidence | undefined;
    let stagedOcrLanguageObservation:
      PendingAutoLanguageOcrObservation | undefined;
    const clearProvisionalSourceLanguage = (
      pending: PendingAutoLanguageOcrObservation | undefined,
    ): void => {
      if (
        pending &&
        this.#configuration.sourceLanguage === 'auto' &&
        !this.#effectiveDetectedSourceLanguage()
      ) sourceLanguage = undefined;
    };
    const commitOcrCandidate = async (
      candidate: PendingOcrImageEvidence,
      allowContinuation = true,
    ): Promise<boolean> => {
      try {
        const committed = await this.#commitOcrCandidate(
          candidate,
          job,
          scheduler,
          processingVersion,
          jobOrdinal,
          replayLease,
          pairEpoch,
          pairKey,
          signal,
          allowContinuation,
        );
        if (!committed) {
          clearProvisionalSourceLanguage(
            candidate.pendingAutoLanguageObservation,
          );
        }
        return committed;
      } catch (error) {
        clearProvisionalSourceLanguage(
          candidate.pendingAutoLanguageObservation,
        );
        throw error;
      }
    };
    const commitHeldSemantic = async (): Promise<boolean> => {
      const candidate = heldSemantic;
      if (!candidate) return false;
      heldSemantic = undefined;
      this.#reportEvidenceSelection('semantic', 'semantic-fallback');
      return this.#commitAccessibilityCandidate(
        candidate,
        job,
        scheduler,
        processingVersion,
        jobOrdinal,
        replayLease,
        pairEpoch,
        pairKey,
        signal,
      );
    };
    const commitHeldOcr = async (): Promise<boolean> => {
      const candidate = heldOcr;
      if (!candidate) return false;
      heldOcr = undefined;
      this.#reportEvidenceSelection('ocr', 'ocr-fallback');
      return commitOcrCandidate(candidate);
    };

    methodLoop: for (const [methodIndex, step] of steps.entries()) {
      signal.throwIfAborted();
      if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
        throw new DOMException('Image job became stale.', 'AbortError');
      }
      try {
      if (step.kind === 'accessibility-text') {
        const candidate = await this.#readAccessibilityCandidate(
          job,
          scheduler,
          methodIndex,
          processingVersion,
          pairEpoch,
          pairKey,
          signal,
        );
        if (!candidate) {
          if (heldOcr && await commitHeldOcr()) return;
          continue;
        }
        if (heldOcr) {
          const ocr = heldOcr;
          heldOcr = undefined;
          const decision = selectImageTextEvidence(candidate.rankable, {
            kind: 'ocr',
            result: ocr.recognition.result,
            selectedQuality: selectedRecognitionQuality(ocr.recognition),
            methodIndex: ocr.methodIndex,
            minimumConfidence: repairOcrMinimumConfidence(
              this.#configuration.ocrMinimumConfidence,
            ),
          });
          this.#reportEvidenceSelection(decision.selected, decision.reason);
          if (decision.selected === 'semantic') {
            let committed = false;
            try {
              committed = await this.#commitAccessibilityCandidate(
                candidate,
                job,
                scheduler,
                processingVersion,
                jobOrdinal,
                replayLease,
                pairEpoch,
                pairKey,
                signal,
              );
            } catch (error) {
              this.#rollbackPendingOcrLanguageObservation(
                ocr.pendingAutoLanguageObservation,
              );
              clearProvisionalSourceLanguage(
                ocr.pendingAutoLanguageObservation,
              );
              throw error;
            }
            if (committed) {
              this.#discardPendingOcrLanguageObservation(
                ocr.pendingAutoLanguageObservation,
              );
              return;
            }
            this.#reportEvidenceSelection('ocr', 'ocr-fallback');
            if (await commitOcrCandidate(ocr)) return;
          } else {
            if (await commitOcrCandidate(ocr, false)) return;
            this.#reportEvidenceSelection('semantic', 'semantic-fallback');
            if (await this.#commitAccessibilityCandidate(
              candidate,
              job,
              scheduler,
              processingVersion,
              jobOrdinal,
              replayLease,
              pairEpoch,
              pairKey,
              signal,
            )) return;
            if (ocr.recognition.continuation) {
              this.#reportEvidenceSelection('ocr', 'ocr-fallback');
              if (await this.#commitOcrContinuations(
                ocr,
                job,
                scheduler,
                processingVersion,
                jobOrdinal,
                replayLease,
                pairEpoch,
                pairKey,
                signal,
              )) return;
            }
          }
          continue;
        }
        const assessment = assessSemanticImageEvidence(candidate.rankable);
        const canCompareWithLaterOcr = ocrEligibility.eligible &&
          steps.slice(methodIndex + 1).some(({ kind }) => kind === 'ocr');
        const awaitsEarlierOcrRetry = Boolean(
          captureDeferral && isTransientCaptureReason(captureDeferral.reason),
        );
        if (
          assessment.provisional &&
          (canCompareWithLaterOcr || awaitsEarlierOcrRetry)
        ) {
          heldSemantic = candidate;
          continue;
        }
        this.#reportEvidenceSelection(
          'semantic',
          assessment.provisional ? 'semantic-fallback' : 'semantic-decisive',
        );
        if (await this.#commitAccessibilityCandidate(
          candidate,
          job,
          scheduler,
          processingVersion,
          jobOrdinal,
          replayLease,
          pairEpoch,
          pairKey,
          signal,
        )) return;
        continue;
      }

      const currentOcrStepIndex = ocrStepIndex;
      ocrStepIndex += 1;
      sawOcrStep = true;
      const hasLaterSemantic = steps.slice(methodIndex + 1)
        .some(({ kind }) => kind === 'accessibility-text');
      if (!ocrEligibility.eligible || captureDeferral) continue;
      if (!pixels) {
        this.environment.onDiagnostic?.('capture-started');
        this.#reportJobProgress(jobOrdinal, 'capture-started', job.descriptor);
        const acquisition = await pixelCoordinator.acquire(job.descriptor, signal);
        if (acquisition.status !== 'ready') {
          captureDeferral = acquisition;
          this.environment.onDiagnostic?.('capture-deferred');
          this.environment.onDiagnostic?.(Object.freeze({
            stage: 'capture-deferred' as const,
            ordinal: jobOrdinal,
            reason: acquisition.reason,
            renderedWidth: job.descriptor.renderedWidth,
            renderedHeight: job.descriptor.renderedHeight,
          }));
          // A pixel failure applies only to OCR. Continue through the exact
          // method plan so a later accessibility-text step still runs.
          continue;
        }
        this.#captureRetries.delete(job.descriptor.nodeId);
        pixels = acquisition.pixels;
        if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
          throw new DOMException('Image job became stale.', 'AbortError');
        }
      }

      if (!sourceLanguage) {
        sourceLanguage = resolveImageSourceLanguage({
          nearestElementLanguage: pixels.nearestElementLanguage,
          ...(this.#configuration.sourceLanguage === 'auto'
            ? {}
            : { explicitSourceLanguage: this.#configuration.sourceLanguage }),
          ...(this.#effectiveDetectedSourceLanguage()
            ? { detectedPageLanguage: this.#effectiveDetectedSourceLanguage() }
            : {}),
        });
        if (!sourceLanguage) {
          const probed = await this.#probeImageLanguage(
            pixels,
            job.descriptor,
            jobOrdinal,
            step.providerOrder,
            currentOcrStepIndex,
            ocrStepCount,
            Boolean(heldSemantic) || hasLaterSemantic,
            signal,
          );
          sourceLanguage = probed?.sourceLanguage;
          stagedOcrLanguageObservation = probed?.pendingObservation;
          if (this.#pairEpoch !== pairEpoch) return;
          if (!sourceLanguage) {
            unsupportedLanguage = true;
            continue;
          }
        }
      }
      const languageGroup = tesseractLanguageGroupFor(sourceLanguage);
      if (
        sourceLanguage === this.#configuration.targetLanguage &&
        !heldSemantic &&
        !hasLaterSemantic
      ) {
        if (this.#commitPendingOcrLanguageObservation(
          stagedOcrLanguageObservation,
          job.descriptor,
        )) return;
        stagedOcrLanguageObservation = undefined;
        this.#clearProjection(job.descriptor);
        scheduler.settle(job);
        this.environment.onDiagnostic?.('same-language');
        return;
      }
      const route: ImageRecognitionRoute = {
        providerOrder: step.providerOrder,
        sourceLanguage,
        minimumConfidence: repairOcrMinimumConfidence(
          this.#configuration.ocrMinimumConfidence,
        ),
        ...(languageGroup
          ? {
              languageGroup,
              modelVersion: TESSERACT_MODEL_VERSION,
            }
          : {}),
      };
      this.environment.onDiagnostic?.('recognition-started');
      this.#reportJobProgress(
        jobOrdinal,
        'recognition-started',
        job.descriptor,
        pixels,
      );
      const recognizer = this.#recognizer();
      let recognition = await recognizer.recognize(
        pixels,
        route,
        signal,
      );
      while (true) {
        if (recognition.cacheAccess && recognition.cacheStats) {
          this.#reportRecognitionCache(
            recognition.cacheAccess,
            recognition.cacheStats,
          );
        }
        if (recognition.status !== 'complete') {
          this.environment.onDiagnostic?.(Object.freeze({
            stage: 'recognition-failed' as const,
            code: recognition.code,
            ordinal: jobOrdinal,
            renderedWidth: job.descriptor.renderedWidth,
            renderedHeight: job.descriptor.renderedHeight,
            bitmapWidth: pixels.bitmapWidth,
            bitmapHeight: pixels.bitmapHeight,
          }));
          break;
        }
        if (recognition.quality) {
          this.#reportRecognitionQuality(recognition.quality);
        }
        this.environment.onDiagnostic?.(Object.freeze({
          stage: 'recognition-complete' as const,
          provider: recognition.result.providerId,
          regions: recognition.result.regions.length,
          cacheHit: recognition.cacheHit,
          ordinal: jobOrdinal,
          bitmapWidth: pixels.bitmapWidth,
          bitmapHeight: pixels.bitmapHeight,
        }));
        if (recognition.result.regions.length === 0) {
          sawEmptyRecognition = true;
          if (!recognition.continuation) break;
          recognition = await recognizer.continueRecognition(
            pixels,
            recognition.continuation,
            signal,
          );
          continue;
        }

        this.#emptyRetries.delete(job.descriptor.nodeId);
        const selectedOcrLanguageObservation =
          await this.#selectedOcrLanguageObservation(
            stagedOcrLanguageObservation,
            recognition.result,
            signal,
          );
        signal.throwIfAborted();
        if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
          throw new DOMException('OCR evidence became stale.', 'AbortError');
        }
        if (stagedOcrLanguageObservation && !selectedOcrLanguageObservation) {
          if (!recognition.continuation) break;
          recognition = await recognizer.continueRecognition(
            pixels,
            recognition.continuation,
            signal,
          );
          continue;
        }
        sourceLanguage = selectedOcrLanguageObservation?.sourceLanguage ??
          sourceLanguage;
        const ocrCandidate: PendingOcrImageEvidence = Object.freeze({
          recognition,
          pixels,
          sourceLanguage,
          methodIndex,
          ...(selectedOcrLanguageObservation
            ? {
                pendingAutoLanguageObservation:
                  selectedOcrLanguageObservation.pendingObservation,
              }
            : {}),
        });
        stagedOcrLanguageObservation = undefined;
        if (heldSemantic) {
          const semantic = heldSemantic;
          const decision = selectImageTextEvidence(semantic.rankable, {
            kind: 'ocr',
            result: recognition.result,
            selectedQuality: selectedRecognitionQuality(recognition),
            methodIndex,
            minimumConfidence: repairOcrMinimumConfidence(
              this.#configuration.ocrMinimumConfidence,
            ),
          });
          this.#reportEvidenceSelection(decision.selected, decision.reason);
          if (decision.selected === 'semantic') {
            heldSemantic = undefined;
            let committed = false;
            try {
              committed = await this.#commitAccessibilityCandidate(
                semantic,
                job,
                scheduler,
                processingVersion,
                jobOrdinal,
                replayLease,
                pairEpoch,
                pairKey,
                signal,
              );
            } catch (error) {
              this.#rollbackPendingOcrLanguageObservation(
                ocrCandidate.pendingAutoLanguageObservation,
              );
              clearProvisionalSourceLanguage(
                ocrCandidate.pendingAutoLanguageObservation,
              );
              throw error;
            }
            if (committed) {
              this.#discardPendingOcrLanguageObservation(
                ocrCandidate.pendingAutoLanguageObservation,
              );
              return;
            }
            this.#reportEvidenceSelection('ocr', 'ocr-fallback');
            if (await commitOcrCandidate(ocrCandidate)) return;
          } else {
            heldSemantic = undefined;
            if (await commitOcrCandidate(ocrCandidate, false)) return;
            this.#reportEvidenceSelection('semantic', 'semantic-fallback');
            if (await this.#commitAccessibilityCandidate(
              semantic,
              job,
              scheduler,
              processingVersion,
              jobOrdinal,
              replayLease,
              pairEpoch,
              pairKey,
              signal,
            )) return;
            if (ocrCandidate.recognition.continuation) {
              this.#reportEvidenceSelection('ocr', 'ocr-fallback');
              if (await this.#commitOcrContinuations(
                ocrCandidate,
                job,
                scheduler,
                processingVersion,
                jobOrdinal,
                replayLease,
                pairEpoch,
                pairKey,
                signal,
              )) return;
            }
          }
          continue methodLoop;
        }
        if (hasLaterSemantic) {
          heldOcr = ocrCandidate;
          continue methodLoop;
        }
        this.#reportEvidenceSelection('ocr', 'ocr-decisive');
        if (await commitOcrCandidate(ocrCandidate)) return;
        continue methodLoop;
      }
      const discardedProvisionalSourceLanguage = Boolean(
        stagedOcrLanguageObservation,
      );
      this.#discardPendingOcrLanguageObservation(stagedOcrLanguageObservation);
      stagedOcrLanguageObservation = undefined;
      if (
        discardedProvisionalSourceLanguage &&
        this.#configuration.sourceLanguage === 'auto' &&
        !this.#effectiveDetectedSourceLanguage()
      ) sourceLanguage = undefined;
      continue;
      } catch (error) {
        if (
          isAbortError(error) ||
          signal.aborted ||
          isImageSourceUnavailableError(error)
        ) {
          this.#rollbackPendingOcrLanguageObservation(
            stagedOcrLanguageObservation,
          );
          this.#rollbackPendingOcrLanguageObservation(
            heldOcr?.pendingAutoLanguageObservation,
          );
          throw error;
        }
        this.#projectedHashes.delete(job.descriptor.nodeId);
        this.#projectedOrdinals.delete(job.descriptor.nodeId);
        this.environment.onDiagnostic?.(
          step.kind === 'accessibility-text'
            ? 'accessibility-text-blocked'
            : 'recognition-failed',
        );
        if (step.kind === 'ocr') {
          const discardedProvisionalSourceLanguage = Boolean(
            stagedOcrLanguageObservation,
          );
          this.#discardPendingOcrLanguageObservation(
            stagedOcrLanguageObservation,
          );
          stagedOcrLanguageObservation = undefined;
          if (
            discardedProvisionalSourceLanguage &&
            this.#configuration.sourceLanguage === 'auto' &&
            !this.#effectiveDetectedSourceLanguage()
          ) sourceLanguage = undefined;
        } else if (heldOcr && await commitHeldOcr()) {
          return;
        }
        continue;
      }
    }

    this.#discardPendingOcrLanguageObservation(stagedOcrLanguageObservation);
    stagedOcrLanguageObservation = undefined;
    if (heldOcr && await commitHeldOcr()) return;

    if (captureDeferral) {
      const transient = isTransientCaptureReason(captureDeferral.reason);
      const retryAttempt = transient
        ? this.#takeCaptureRetry(job)
        : undefined;
      const retryExhausted = transient && retryAttempt === undefined;
      if (retryAttempt !== undefined) {
        scheduler.retry(job);
        this.#reportJobProgress(
          jobOrdinal,
          'capture-retry',
          job.descriptor,
          undefined,
          retryAttempt,
        );
        return;
      }
      if (!transient) this.#captureRetries.delete(job.descriptor.nodeId);
      if (retryExhausted) {
        this.#reportJobProgress(
          jobOrdinal,
          'capture-retry-exhausted',
          job.descriptor,
          undefined,
          MAX_TRANSIENT_CAPTURE_RETRIES,
        );
      }
      if (await commitHeldSemantic()) return;
      if (
        retryExhausted ||
        captureDeferral.reason === 'permission' ||
        captureDeferral.reason === 'inactive' ||
        captureDeferral.reason === 'oversized'
      ) scheduler.settle(job);
      else scheduler.defer(job);
      return;
    }

    if (sawEmptyRecognition && pixels) {
      const emptyDecision = this.#emptyRetryDecision(job, pixels.pixelHash);
      if (emptyDecision.status === 'retry') {
        scheduler.retry(job);
        this.#reportJobProgress(
          jobOrdinal,
          'no-text-retry',
          job.descriptor,
          pixels,
          emptyDecision.attempt,
        );
      } else if (emptyDecision.status === 'changed') {
        scheduler.defer(job);
        this.#emptyRetries.delete(job.descriptor.nodeId);
        this.#clearProjection(job.descriptor);
        this.#reportJobProgress(
          jobOrdinal,
          'no-text-changed',
          job.descriptor,
          pixels,
        );
      } else {
        this.#emptyRetries.delete(job.descriptor.nodeId);
        if (await commitHeldSemantic()) return;
        scheduler.settle(job);
        this.#clearProjection(job.descriptor);
        this.environment.onDiagnostic?.('no-text-found');
      }
      return;
    }

    if (await commitHeldSemantic()) return;
    scheduler.settle(job);
    if (sawOcrStep && !ocrEligibility.eligible) {
      this.environment.onDiagnostic?.('image-skipped');
      this.environment.onDiagnostic?.(Object.freeze({
        stage: 'image-scheduling' as const,
        status: 'skipped' as const,
        reason: ocrEligibility.reason,
        visibility: job.descriptor.visibility,
        renderedWidth: job.descriptor.renderedWidth,
        renderedHeight: job.descriptor.renderedHeight,
      }));
    } else if (unsupportedLanguage) {
      this.environment.onDiagnostic?.('unsupported-language');
    }
  }

  async #commitOcrCandidate(
    candidate: PendingOcrImageEvidence,
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    processingVersion: number,
    jobOrdinal: number,
    replayLease: number,
    pairEpoch: number,
    pairKey: string,
    signal: AbortSignal,
    allowContinuation = true,
  ): Promise<boolean> {
    const { pixels, sourceLanguage, recognition } = candidate;
    let pendingObservation = candidate.autoLanguageVoteEligible === false
      ? undefined
      : candidate.pendingAutoLanguageObservation;
    try {
      signal.throwIfAborted();
      if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
        throw new DOMException('Image selection became stale.', 'AbortError');
      }
      if (sourceLanguage === this.#configuration.targetLanguage) {
        if (this.#commitPendingOcrLanguageObservation(
          pendingObservation,
          job.descriptor,
        )) {
          pendingObservation = undefined;
          return true;
        }
        pendingObservation = undefined;
        this.#clearProjection(job.descriptor);
        scheduler.settle(job);
        this.environment.onDiagnostic?.('same-language');
        return true;
      }

      let regions: readonly TranslatedImageRegion[] = Object.freeze([]);
      let translationFailed = false;
      try {
        regions = await this.#translateRegions(
          recognition.result.regions,
          {
            sourceLanguage,
            targetLanguage: this.#configuration.targetLanguage,
          },
          signal,
          () => this.#reportTranslationStage(
            'translation-started',
            jobOrdinal,
            job.descriptor,
            pixels,
          ),
        );
      } catch (error) {
        if (
          isAbortError(error) ||
          signal.aborted ||
          isImageSourceUnavailableError(error)
        ) throw error;
        this.#reportTranslationStage(
          'translation-failed',
          jobOrdinal,
          job.descriptor,
          pixels,
        );
        translationFailed = true;
      }
      if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
        throw new DOMException('Image translation became stale.', 'AbortError');
      }
      if (!translationFailed && regions.length > 0) {
        if (this.#commitPendingOcrLanguageObservation(
          pendingObservation,
          job.descriptor,
        )) {
          pendingObservation = undefined;
          return true;
        }
        pendingObservation = undefined;
        const projection: ImageOverlayProjection = {
          jobOrdinal,
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
          methodId: recognition.result.providerId,
          evidenceKind: 'ocr',
          regions,
        };
        this.#projectedHashes.set(job.descriptor.nodeId, pixels.pixelHash);
        this.#projectedOrdinals.set(job.descriptor.nodeId, jobOrdinal);
        if (!this.#projector.project(projection)) {
          this.#projectedHashes.delete(job.descriptor.nodeId);
          this.#projectedOrdinals.delete(job.descriptor.nodeId);
          scheduler.defer(job);
          this.environment.onDiagnostic?.('projection-deferred');
          this.#reportJobProgress(
            jobOrdinal,
            'projection-deferred',
            job.descriptor,
            pixels,
          );
          return true;
        }
        scheduler.settle(job);
        this.environment.onDiagnostic?.('projected');
        this.#reportJobProgress(
          jobOrdinal,
          'projected',
          job.descriptor,
          pixels,
        );
        return true;
      }
      if (!translationFailed) {
        this.#reportTranslationStage(
          'translation-empty',
          jobOrdinal,
          job.descriptor,
          pixels,
        );
      }
      this.#discardPendingOcrLanguageObservation(pendingObservation);
      pendingObservation = undefined;
      if (!recognition.continuation || !allowContinuation) return false;
      return await this.#commitOcrContinuations(
        candidate,
        job,
        scheduler,
        processingVersion,
        jobOrdinal,
        replayLease,
        pairEpoch,
        pairKey,
        signal,
      );
    } catch (error) {
      this.#rollbackPendingOcrLanguageObservation(pendingObservation);
      pendingObservation = undefined;
      throw error;
    } finally {
      this.#discardPendingOcrLanguageObservation(pendingObservation);
    }
  }

  async #commitOcrContinuations(
    candidate: PendingOcrImageEvidence,
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    processingVersion: number,
    jobOrdinal: number,
    replayLease: number,
    pairEpoch: number,
    pairKey: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    let continuation = candidate.recognition.continuation;
    let activePendingObservation:
      PendingAutoLanguageOcrObservation | undefined;
    try {
      while (continuation) {
        signal.throwIfAborted();
        if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
          throw new DOMException(
            'OCR continuation became stale.',
            'AbortError',
          );
        }
        const recognition = await this.#recognizer().continueRecognition(
          candidate.pixels,
          continuation,
          signal,
        );
        signal.throwIfAborted();
        if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
          throw new DOMException(
            'OCR continuation became stale.',
            'AbortError',
          );
        }
        if (recognition.cacheAccess && recognition.cacheStats) {
          this.#reportRecognitionCache(
            recognition.cacheAccess,
            recognition.cacheStats,
          );
        }
        if (recognition.status !== 'complete') {
          this.environment.onDiagnostic?.(Object.freeze({
            stage: 'recognition-failed' as const,
            code: recognition.code,
            ordinal: jobOrdinal,
            renderedWidth: job.descriptor.renderedWidth,
            renderedHeight: job.descriptor.renderedHeight,
            bitmapWidth: candidate.pixels.bitmapWidth,
            bitmapHeight: candidate.pixels.bitmapHeight,
          }));
          return false;
        }
        if (recognition.quality) {
          this.#reportRecognitionQuality(recognition.quality);
        }
        this.environment.onDiagnostic?.(Object.freeze({
          stage: 'recognition-complete' as const,
          provider: recognition.result.providerId,
          regions: recognition.result.regions.length,
          cacheHit: recognition.cacheHit,
          ordinal: jobOrdinal,
          bitmapWidth: candidate.pixels.bitmapWidth,
          bitmapHeight: candidate.pixels.bitmapHeight,
        }));
        continuation = recognition.continuation;
        if (recognition.result.regions.length === 0) continue;

        let selectedSourceLanguage = candidate.sourceLanguage;
        let selectedPendingObservation:
          PendingAutoLanguageOcrObservation | undefined;
        let selectedAutoLanguageVoteEligible: boolean | undefined;
        if (candidate.pendingAutoLanguageObservation) {
          const pending = candidate.pendingAutoLanguageObservation;
          if (pending.probe !== this.#autoLanguageProbe) {
            throw new DOMException(
              'OCR continuation language evidence became stale.',
              'AbortError',
            );
          }
          let canVote = candidate.autoLanguageVoteEligible !== false &&
            !this.#probeInconclusiveReported &&
            pending.probe.remainingMs(this.#now()) > 0;
          if (canVote) {
            activePendingObservation =
              this.#resumePendingOcrLanguageObservation(pending);
            if (!activePendingObservation) {
              if (
                pending.probe === this.#autoLanguageProbe &&
                (this.#probeInconclusiveReported ||
                  pending.probe.remainingMs(this.#now()) <= 0)
              ) canVote = false;
              else {
                throw new DOMException(
                  'OCR continuation language route became stale.',
                  'AbortError',
                );
              }
            }
          }
          if (!canVote) this.#discardPendingOcrLanguageObservation(pending);
          const selected = await this.#selectedOcrLanguageObservation(
            pending,
            recognition.result,
            signal,
            canVote,
          );
          if (!selected) continue;
          selectedSourceLanguage = selected.sourceLanguage;
          selectedPendingObservation = selected.pendingObservation;
          selectedAutoLanguageVoteEligible = canVote;
          activePendingObservation = undefined;
        }
        return await this.#commitOcrCandidate(
          Object.freeze({
            recognition,
            pixels: candidate.pixels,
            sourceLanguage: selectedSourceLanguage,
            methodIndex: candidate.methodIndex,
            ...(selectedPendingObservation
              ? {
                  pendingAutoLanguageObservation:
                    selectedPendingObservation,
                  autoLanguageVoteEligible:
                    selectedAutoLanguageVoteEligible ?? false,
                }
              : {}),
          }),
          job,
          scheduler,
          processingVersion,
          jobOrdinal,
          replayLease,
          pairEpoch,
          pairKey,
          signal,
        );
      }
      return false;
    } catch (error) {
      this.#rollbackPendingOcrLanguageObservation(activePendingObservation);
      activePendingObservation = undefined;
      throw error;
    } finally {
      this.#discardPendingOcrLanguageObservation(activePendingObservation);
    }
  }

  async #selectedOcrLanguageObservation(
    pending: PendingAutoLanguageOcrObservation | undefined,
    result: ImageTextResult,
    signal: AbortSignal,
    attachPendingObservation = true,
  ): Promise<SelectedAutoLanguageOcrObservation | undefined> {
    if (!pending) return undefined;
    const transcriptChanged = result.transcript !==
      pending.observation.transcript;
    let detectedLanguage = pending.observation.detectedLanguage;
    if (transcriptChanged) {
      detectedLanguage = strongAutoLanguageScriptEvidence(result.transcript)
        ? undefined
        : await this.#detectTranscriptLanguage(result.transcript, signal);
    }
    const selectedPending = Object.freeze({
      probe: pending.probe,
      observation: Object.freeze({
        sampleIdentity: pending.observation.sampleIdentity,
        pixelHash: pending.observation.pixelHash,
        routeLanguage: pending.observation.routeLanguage,
        transcript: result.transcript,
        ...(result.transcriptConfidence !== undefined
          ? { confidence: result.transcriptConfidence }
          : {}),
        ...(detectedLanguage ? { detectedLanguage } : {}),
      }),
    });
    const inspected = attachPendingObservation
      ? pending.probe.inspectOcrObservation(selectedPending.observation)
      : pending.probe.classifyOcrObservation(selectedPending.observation);
    return inspected.status === 'candidate'
      ? Object.freeze({
          sourceLanguage: inspected.language,
          pendingObservation: selectedPending,
        })
      : undefined;
  }

  #commitPendingOcrLanguageObservation(
    pending: PendingAutoLanguageOcrObservation | undefined,
    descriptor: SourceImageDescriptor,
  ): boolean {
    if (!pending) return false;
    if (
      pending.probe !== this.#autoLanguageProbe ||
      this.#probeInconclusiveReported ||
      pending.probe.remainingMs(this.#now()) <= 0
    ) {
      this.#discardPendingOcrLanguageObservation(pending);
      return false;
    }
    const observed = pending.probe.observe(pending.observation);
    return observed.status === 'resolved'
      ? Boolean(this.#acceptAutoLanguageResolution(
          observed,
          descriptor.document,
          'ocr',
        ))
      : false;
  }

  #discardPendingOcrLanguageObservation(
    pending: PendingAutoLanguageOcrObservation | undefined,
  ): void {
    if (!pending) return;
    pending.probe.completeAttempt(
      pending.observation.sampleIdentity,
      pending.observation.pixelHash,
      pending.observation.routeLanguage,
    );
  }

  #rollbackPendingOcrLanguageObservation(
    pending: PendingAutoLanguageOcrObservation | undefined,
  ): void {
    if (!pending) return;
    pending.probe.rollbackAttempt(
      pending.observation.sampleIdentity,
      pending.observation.pixelHash,
      pending.observation.routeLanguage,
    );
  }

  #resumePendingOcrLanguageObservation(
    pending: PendingAutoLanguageOcrObservation | undefined,
  ): PendingAutoLanguageOcrObservation | undefined {
    if (!pending) return undefined;
    if (
      pending.probe !== this.#autoLanguageProbe ||
      this.#probeInconclusiveReported ||
      pending.probe.remainingMs(this.#now()) <= 0 ||
      !pending.probe.resumeAttempt(
        pending.observation.sampleIdentity,
        pending.observation.pixelHash,
        pending.observation.routeLanguage,
        this.#now(),
      )
    ) {
      this.#discardPendingOcrLanguageObservation(pending);
      return undefined;
    }
    return pending;
  }

  async #readAccessibilityCandidate(
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    methodIndex: number,
    processingVersion: number,
    pairEpoch: number,
    pairKey: string,
    signal: AbortSignal,
  ): Promise<PendingSemanticImageEvidence | undefined> {
    const read = this.#source?.readAccessibilityText;
    if (!read || !accessibilityMethodEnabled(this.#configuration)) return undefined;
    this.environment.onDiagnostic?.('accessibility-text-started');
    const evidence = await read.call(
      this.#source,
      job.descriptor,
      this.#configuration.policyFingerprint ?? 'read-v1-000000',
      this.#configuration.controlImages === true,
      signal,
    );
    signal.throwIfAborted();
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Accessibility evidence became stale.', 'AbortError');
    }
    if (!evidence) {
      this.environment.onDiagnostic?.('accessibility-text-empty');
      return undefined;
    }
    if (
      evidence.nodeId !== job.descriptor.nodeId ||
      evidence.contentRevision !== job.descriptor.contentRevision ||
      evidence.observationRevision !== job.descriptor.observationRevision ||
      !sameSourceDocument(evidence.document, job.descriptor.document)
    ) throw new DOMException('Accessibility evidence became stale.', 'AbortError');
    const registration = this.#semanticEvidenceIndex.register(
      job.descriptor.nodeId,
      job.descriptor.contentRevision,
      evidence.text,
    );
    let invalidatedAutoResolution = false;
    for (const nodeId of registration.reevaluateNodeIds) {
      if (nodeId === job.descriptor.nodeId) continue;
      const affected = this.#descriptors.get(nodeId);
      if (!affected) continue;
      invalidatedAutoResolution = this.#forgetAutoLanguageProbeSample(nodeId) ||
        invalidatedAutoResolution;
      this.#clearProjection(affected);
      scheduler.requeueCurrent(affected);
    }
    for (const cancellation of scheduler.drainCancellations()) {
      if (
        cancellation.job.descriptor.nodeId ===
        this.#activeJob()?.descriptor.nodeId
      ) this.#activeAbortController?.abort();
    }
    if (invalidatedAutoResolution) {
      this.#restartAfterAutoLanguageEvidenceInvalidation();
      throw new DOMException(
        'Accessibility evidence changed Auto language.',
        'AbortError',
      );
    }
    const sourceLanguage = await this.#resolveAccessibilitySourceLanguage(
      evidence.text,
      evidence.nearestElementLanguage,
      signal,
    );
    signal.throwIfAborted();
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Accessibility evidence became stale.', 'AbortError');
    }
    if (!sourceLanguage) {
      this.environment.onDiagnostic?.('accessibility-text-empty');
      return undefined;
    }
    return Object.freeze({
      evidence,
      sourceLanguage,
      rankable: Object.freeze({
        kind: 'semantic' as const,
        text: evidence.text,
        source: evidence.source,
        methodIndex,
        repeated: registration.repeated,
      }),
    });
  }

  async #commitAccessibilityCandidate(
    candidate: PendingSemanticImageEvidence,
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    processingVersion: number,
    jobOrdinal: number,
    replayLease: number,
    pairEpoch: number,
    pairKey: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { evidence, sourceLanguage } = candidate;
    if (sourceLanguage === this.#configuration.targetLanguage) {
      signal.throwIfAborted();
      if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
        throw new DOMException(
          'Accessibility selection became stale.',
          'AbortError',
        );
      }
      if (this.#observeSemanticImageLanguage(
        evidence.text,
        sourceLanguage,
        job.descriptor,
      )) return true;
      this.#clearProjection(job.descriptor);
      scheduler.settle(job);
      this.environment.onDiagnostic?.('same-language');
      return true;
    }
    const width = Math.max(1, job.descriptor.renderedWidth);
    const height = Math.max(1, job.descriptor.renderedHeight);
    let regions: readonly TranslatedImageRegion[];
    try {
      regions = await this.#translateRegions([
        {
          text: evidence.text,
          boundingBox: { x: 0, y: 0, width, height },
          placement: 'whole-image',
        },
      ], {
        sourceLanguage,
        targetLanguage: this.#configuration.targetLanguage,
      }, signal, () => this.environment.onDiagnostic?.('translation-started'));
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      this.environment.onDiagnostic?.('accessibility-text-blocked');
      return false;
    }
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Accessibility translation became stale.', 'AbortError');
    }
    if (regions.length === 0) {
      this.environment.onDiagnostic?.('translation-empty');
      return false;
    }
    const evidenceIdentity = await sha256Hex([
      'accessibility-text',
      evidence.source,
      evidence.text,
      String(evidence.contentRevision),
    ].join('\u0000'));
    signal.throwIfAborted();
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Accessibility selection became stale.', 'AbortError');
    }
    if (this.#observeSemanticImageLanguage(
      evidence.text,
      sourceLanguage,
      job.descriptor,
    )) return true;
    const projection: ImageOverlayProjection = {
      jobOrdinal,
      document: job.descriptor.document,
      nodeId: job.descriptor.nodeId,
      contentRevision: job.descriptor.contentRevision,
      observationRevision: job.descriptor.observationRevision,
      replayLease,
      pairEpoch,
      pairKey,
      pixelHash: evidenceIdentity,
      bitmapWidth: width,
      bitmapHeight: height,
      cropOffsetXCss: 0,
      cropOffsetYCss: 0,
      cropWidthCss: width,
      cropHeightCss: height,
      renderedWidthCss: width,
      renderedHeightCss: height,
      methodId: ACCESSIBILITY_TEXT_METHOD_ID,
      evidenceKind: 'semantic',
      regions,
    };
    this.#projectedHashes.set(job.descriptor.nodeId, evidenceIdentity);
    this.#projectedOrdinals.set(job.descriptor.nodeId, jobOrdinal);
    if (!this.#projector.project(projection)) {
      this.#projectedHashes.delete(job.descriptor.nodeId);
      this.#projectedOrdinals.delete(job.descriptor.nodeId);
      scheduler.defer(job);
      this.environment.onDiagnostic?.('projection-deferred');
      return true;
    }
    scheduler.settle(job);
    this.environment.onDiagnostic?.('accessibility-text-complete');
    this.environment.onDiagnostic?.('projected');
    return true;
  }

  async #resolveAccessibilitySourceLanguage(
    text: string,
    nearestElementLanguage: SupportedLanguage | undefined,
    signal: AbortSignal,
  ): Promise<SupportedLanguage | undefined> {
    const resolved = resolveImageSourceLanguage({
      ...(nearestElementLanguage ? { nearestElementLanguage } : {}),
      ...(this.#configuration.sourceLanguage === 'auto'
        ? {}
        : { explicitSourceLanguage: this.#configuration.sourceLanguage }),
      ...(this.#effectiveDetectedSourceLanguage()
        ? { detectedPageLanguage: this.#effectiveDetectedSourceLanguage() }
        : {}),
    });
    if (resolved) return resolved;
    return this.#detectTranscriptLanguage(text, signal);
  }

  async #translateRegions(
    regions: readonly TranslatedImageRegion[],
    pair: TranslationPair,
    signal: AbortSignal,
    onTranslationStarted: () => void,
  ): Promise<readonly TranslatedImageRegion[]> {
    if (regions.length === 0) return Object.freeze([]);
    let session: TranslationSession | undefined;
    try {
      const translated: TranslatedImageRegion[] = [];
      for (const region of regions.slice(0, MAX_TRANSLATED_IMAGE_REGIONS)) {
        signal.throwIfAborted();
        const source = region.text.trim();
        if (!source) continue;
        const text = await this.#translationMemory.getOrCreate(
          { provider: 'chrome-translator-v1', pair },
          source,
          async () => {
            if (!session) {
              onTranslationStarted();
              session = await this.environment.translationProvider.createSession(pair, {
                signal,
              });
            }
            return translateWithSession(session, source, signal);
          },
        );
        if (text.trim()) {
          translated.push(Object.freeze({
            text: text.trim(),
            boundingBox: region.boundingBox,
            ...(region.placement ? { placement: region.placement } : {}),
          }));
        }
      }
      return Object.freeze(translated);
    } finally {
      session?.destroy();
    }
  }

  #takeCaptureRetry(job: ImageScanJob): number | undefined {
    const descriptor = job.descriptor;
    const previous = this.#captureRetries.get(descriptor.nodeId);
    const record = previous &&
        previous.contentRevision === descriptor.contentRevision &&
        previous.observationRevision === descriptor.observationRevision
      ? previous
      : {
          contentRevision: descriptor.contentRevision,
          observationRevision: descriptor.observationRevision,
          attempts: 0,
        };
    if (record.attempts >= MAX_TRANSIENT_CAPTURE_RETRIES) return undefined;
    record.attempts += 1;
    this.#captureRetries.set(descriptor.nodeId, record);
    return record.attempts;
  }

  #emptyRetryDecision(
    job: ImageScanJob,
    pixelHash: string,
  ): { readonly status: 'retry'; readonly attempt: number } |
      { readonly status: 'confirmed' | 'changed' } {
    const descriptor = job.descriptor;
    const previous = this.#emptyRetries.get(descriptor.nodeId);
    if (
      previous &&
      previous.contentRevision === descriptor.contentRevision &&
      previous.observationRevision === descriptor.observationRevision
    ) {
      if (
        previous.pixelHash !== pixelHash &&
        previous.attempts < MAX_UNCHANGED_EMPTY_RETRIES
      ) {
        previous.pixelHash = pixelHash;
        previous.attempts += 1;
        return Object.freeze({
          status: 'retry' as const,
          attempt: previous.attempts,
        });
      }
      return Object.freeze({
        status: previous.pixelHash === pixelHash ? 'confirmed' : 'changed',
      });
    }
    const record = {
      contentRevision: descriptor.contentRevision,
      observationRevision: descriptor.observationRevision,
      pixelHash,
      attempts: 1,
    };
    this.#emptyRetries.set(descriptor.nodeId, record);
    return Object.freeze({ status: 'retry', attempt: record.attempts });
  }

  #reportJobProgress(
    ordinal: number,
    status: Extract<
      ImageTranslationDiagnostic,
      { readonly stage: 'job-progress' }
    >['status'],
    descriptor: SourceImageDescriptor,
    pixels?: AcquiredImagePixels,
    attempt?: number,
  ): void {
    this.environment.onDiagnostic?.(Object.freeze({
      stage: 'job-progress' as const,
      ordinal,
      status,
      renderedWidth: descriptor.renderedWidth,
      renderedHeight: descriptor.renderedHeight,
      ...(pixels
        ? {
            bitmapWidth: pixels.bitmapWidth,
            bitmapHeight: pixels.bitmapHeight,
          }
        : {}),
      ...(attempt !== undefined ? { attempt } : {}),
    }));
  }

  #reportTranslationStage(
    stage: 'translation-started' | 'translation-failed' | 'translation-empty',
    ordinal: number,
    descriptor: SourceImageDescriptor,
    pixels: AcquiredImagePixels,
  ): void {
    this.environment.onDiagnostic?.(Object.freeze({
      stage,
      ordinal,
      renderedWidth: descriptor.renderedWidth,
      renderedHeight: descriptor.renderedHeight,
      bitmapWidth: pixels.bitmapWidth,
      bitmapHeight: pixels.bitmapHeight,
    }));
  }

  #clearProjection(descriptor: SourceImageDescriptor): void {
    this.#projectedHashes.delete(descriptor.nodeId);
    this.#projectedOrdinals.delete(descriptor.nodeId);
    this.#projector.remove(descriptor.document, descriptor.nodeId);
  }

  #descriptorForProjectedOrdinal(
    ordinal: number,
  ): SourceImageDescriptor | undefined {
    for (const [nodeId, projectedOrdinal] of this.#projectedOrdinals) {
      if (projectedOrdinal === ordinal) return this.#descriptors.get(nodeId);
    }
    return undefined;
  }

  #nextOrdinal(): number {
    this.#nextJobOrdinal = this.#nextJobOrdinal >= Number.MAX_SAFE_INTEGER
      ? 1
      : this.#nextJobOrdinal + 1;
    return this.#nextJobOrdinal;
  }

  #recognizer(): ImageRecognitionCoordinator {
    if (!this.#recognition) {
      this.#recognition = this.environment.createRecognitionCoordinator(
        this.#configuration.resetEpoch,
      );
    }
    this.#recognition.advanceResetEpoch(this.#configuration.resetEpoch);
    return this.#recognition;
  }

  #ensureAutoLanguageProbe(): AutoImageLanguageProbe | undefined {
    if (
      this.#configuration.sourceLanguage !== 'auto' ||
      this.#configuration.detectedSourceLanguage ||
      this.#probeDetectedSourceLanguage ||
      this.#probeInconclusiveReported ||
      this.#configuration.pageLanguageResolutionPending
    ) return undefined;
    let probe = this.#autoLanguageProbe;
    if (!probe) {
      const minimumConfidence = Math.max(
        AUTO_LANGUAGE_PROBE_MINIMUM_CONFIDENCE,
        repairOcrMinimumConfidence(this.#configuration.ocrMinimumConfidence),
      );
      probe = new AutoImageLanguageProbe(this.#now(), minimumConfidence);
      this.#autoLanguageProbe = probe;
      const probeAtDeadline = probe;
      this.#probeLifetimeAbortController = new AbortController();
      this.#probeDeadlineTimer = this.#setTimer(() => {
        if (
          this.#autoLanguageProbe !== probeAtDeadline ||
          probeAtDeadline.resolvedLanguage ||
          this.#probeInconclusiveReported
        ) return;
        this.#reportProbeInconclusive(probeAtDeadline, 'deadline');
      }, probe.remainingMs(this.#now()));
    }
    if (!this.#probeStartedReported) {
      this.#probeStartedReported = true;
      this.environment.onDiagnostic?.(Object.freeze({
        stage: 'auto-language-probe-started' as const,
        maxImages: MAX_AUTO_LANGUAGE_PROBE_IMAGES,
        maxAttempts: MAX_AUTO_LANGUAGE_PROBE_ATTEMPTS,
      }));
    }
    if (probe.remainingMs(this.#now()) <= 0) {
      this.#reportProbeInconclusive(probe, 'deadline');
      return undefined;
    }
    return probe;
  }

  #observeSemanticImageLanguage(
    text: string,
    detectedLanguage: SupportedLanguage,
    descriptor: SourceImageDescriptor,
  ): SupportedLanguage | undefined {
    const probe = this.#ensureAutoLanguageProbe();
    if (!probe) return undefined;
    const observed = probe.observeSemantic({
      sampleIdentity: this.#probeSampleIdentity(descriptor),
      text,
      detectedLanguage,
      now: this.#now(),
    });
    return observed.status === 'resolved'
      ? this.#acceptAutoLanguageResolution(
          observed,
          descriptor.document,
          'accessibility-text',
        )
      : undefined;
  }

  #acceptAutoLanguageResolution(
    observed: Extract<AutoLanguageProbeObservationResult, {
      readonly status: 'resolved';
    }>,
    document: ReplicaSourceDocumentIdentity,
    origin: AutoImageLanguageEvidenceOrigin,
  ): SupportedLanguage {
    this.#probeDetectedSourceLanguage = observed.language;
    this.#probeInconclusiveReported = false;
    // Auto resolution changes the projection pair, not the exact-document
    // evidence epoch. Configured pair/reset transitions still clear the index.
    this.#beginPair(true);
    this.#clearAutoLanguageProbeDeadline();
    this.environment.onDiagnostic?.(Object.freeze({
      stage: 'auto-language-probe-resolved' as const,
      language: observed.language,
      evidence: observed.evidence,
      attempts: observed.attempts,
      samples: observed.images,
    }));
    try {
      this.environment.onAutoLanguageDetected?.(
        observed.language,
        observed.evidence,
        document,
        origin,
      );
    } catch {
      // A UI observer cannot prevent the controller's pair transition.
    } finally {
      if (
        this.#isEnabled() &&
        this.#configuration.sourceLanguage === 'auto' &&
        this.#effectiveDetectedSourceLanguage() === observed.language
      ) this.#probeSchedulerRebuildRequested = true;
    }
    return observed.language;
  }

  async #probeImageLanguage(
    pixels: AcquiredImagePixels,
    descriptor: SourceImageDescriptor,
    jobOrdinal: number,
    providerOrder: readonly ImageTextProviderId[],
    ocrGroupIndex: number,
    ocrGroupCount: number,
    deferObservation: boolean,
    signal: AbortSignal,
  ): Promise<ProbedImageLanguage | undefined> {
    const probe = this.#ensureAutoLanguageProbe();
    if (!probe) return undefined;
    const configuredConfidence = repairOcrMinimumConfidence(
      this.#configuration.ocrMinimumConfidence,
    );
    const minimumConfidence = configuredConfidence <
        AUTO_LANGUAGE_PROBE_MINIMUM_CONFIDENCE
      ? AUTO_LANGUAGE_PROBE_MINIMUM_CONFIDENCE
      : configuredConfidence;
    const now = this.#now();
    if (probe.remainingMs(now) <= 0) {
      this.#reportProbeInconclusive(probe, 'deadline');
      return undefined;
    }
    const sampleIdentity = this.#probeSampleIdentity(descriptor);
    let progress = this.#probeOcrProgress.get(sampleIdentity);
    if (!progress) {
      const wasKnownImage = probe.hasSample(sampleIdentity);
      const candidates = probe.candidateLanguages(
        sampleIdentity,
        pixels.pixelHash,
      );
      if (candidates.length === 0 && !wasKnownImage &&
          probe.images >= MAX_AUTO_LANGUAGE_PROBE_IMAGES) {
        this.#reportProbeInconclusive(probe, probe.finalReason());
        return undefined;
      }
      if (candidates.length === 0) return undefined;
      progress = {
        routes: candidates,
        completedOcrGroups: new Set(),
      };
      this.#probeOcrProgress.set(sampleIdentity, progress);
    }
    if (progress.completedOcrGroups.has(ocrGroupIndex)) return undefined;
    const candidates = progress.routes;
    const lifetimeSignal = this.#probeLifetimeAbortController?.signal;
    if (!lifetimeSignal) return undefined;
    const probeAbortController = new AbortController();
    const relayJobAbort = (): void => probeAbortController.abort(signal.reason);
    const relayLifetimeAbort = (): void =>
      probeAbortController.abort(lifetimeSignal.reason);
    if (signal.aborted) relayJobAbort();
    else signal.addEventListener('abort', relayJobAbort, { once: true });
    if (lifetimeSignal.aborted) relayLifetimeAbort();
    else lifetimeSignal.addEventListener('abort', relayLifetimeAbort, { once: true });
    let activeCandidate: SupportedLanguage | undefined;
    let activeCandidateWasNew = false;
    try {
      for (const candidateLanguage of candidates) {
        probeAbortController.signal.throwIfAborted();
        const attemptCountBefore = probe.attempts;
        const resumed = probe.resumeAttempt(
          sampleIdentity,
          pixels.pixelHash,
          candidateLanguage,
          this.#now(),
        );
        if (!resumed && !probe.beginAttempt(
          sampleIdentity,
          pixels.pixelHash,
          candidateLanguage,
          this.#now(),
        )) continue;
        activeCandidateWasNew = probe.attempts > attemptCountBefore;
        if (activeCandidateWasNew) {
          this.environment.onDiagnostic?.(Object.freeze({
            stage: 'auto-language-probe-attempt' as const,
            attempt: probe.attempts,
            sample: probe.images,
            candidateLanguage,
          }));
        }
        activeCandidate = candidateLanguage;
        const languageGroup = tesseractLanguageGroupFor(candidateLanguage);
        let recognition = await raceAbortPromise(
          this.#recognizer().recognize(pixels, {
            providerOrder,
            sourceLanguage: candidateLanguage,
            minimumConfidence,
            ...(languageGroup
              ? {
                  languageGroup,
                  modelVersion: TESSERACT_MODEL_VERSION,
                }
              : {}),
          }, probeAbortController.signal),
          probeAbortController.signal,
        );
        while (true) {
          if (recognition.cacheAccess && recognition.cacheStats) {
            this.#reportRecognitionCache(
              recognition.cacheAccess,
              recognition.cacheStats,
            );
          }
          if (recognition.status !== 'complete') {
            this.environment.onDiagnostic?.(Object.freeze({
              stage: 'recognition-failed' as const,
              code: recognition.code,
              ordinal: jobOrdinal,
              renderedWidth: descriptor.renderedWidth,
              renderedHeight: descriptor.renderedHeight,
              bitmapWidth: pixels.bitmapWidth,
              bitmapHeight: pixels.bitmapHeight,
            }));
            break;
          }
          if (recognition.result.regions.length > 0) {
            const detectedLanguage = strongAutoLanguageScriptEvidence(
              recognition.result.transcript,
            )
              ? undefined
              : await this.#detectTranscriptLanguage(
                  recognition.result.transcript,
                  probeAbortController.signal,
                );
            probeAbortController.signal.throwIfAborted();
            const observation: AutoLanguageProbeObservation = Object.freeze({
              sampleIdentity,
              pixelHash: pixels.pixelHash,
              routeLanguage: candidateLanguage,
              transcript: recognition.result.transcript,
              confidence: recognition.result.transcriptConfidence,
              ...(detectedLanguage ? { detectedLanguage } : {}),
            });
            if (deferObservation) {
              const inspected = probe.inspectOcrObservation(observation);
              if (inspected.status === 'candidate') {
                activeCandidate = undefined;
                return Object.freeze({
                  sourceLanguage: inspected.language,
                  pendingObservation: Object.freeze({
                    probe,
                    observation,
                  }),
                });
              }
            }
            const observed = probe.observe(observation);
            if (observed.status === 'resolved') {
              activeCandidate = undefined;
              return Object.freeze({
                sourceLanguage: this.#acceptAutoLanguageResolution(
                  observed,
                  descriptor.document,
                  'ocr',
                ),
              });
            }
          }
          if (!recognition.continuation) break;
          if (!probe.resumeAttempt(
            sampleIdentity,
            pixels.pixelHash,
            candidateLanguage,
            this.#now(),
          )) break;
          recognition = await raceAbortPromise(
            this.#recognizer().continueRecognition(
              pixels,
              recognition.continuation,
              probeAbortController.signal,
            ),
            probeAbortController.signal,
          );
        }
        probe.completeAttempt(
          sampleIdentity,
          pixels.pixelHash,
          candidateLanguage,
        );
        activeCandidate = undefined;
        activeCandidateWasNew = false;
      }
      progress.completedOcrGroups.add(ocrGroupIndex);
    } catch (error) {
      if (activeCandidate) {
        if (activeCandidateWasNew) {
          probe.rollbackAttempt(
            sampleIdentity,
            pixels.pixelHash,
            activeCandidate,
          );
        } else {
          probe.completeAttempt(
            sampleIdentity,
            pixels.pixelHash,
            activeCandidate,
          );
        }
        activeCandidate = undefined;
      }
      if (this.#probeInconclusiveReported) return undefined;
      throw error;
    } finally {
      signal.removeEventListener('abort', relayJobAbort);
      lifetimeSignal.removeEventListener('abort', relayLifetimeAbort);
    }
    const reason = probe.inconclusiveReason(this.#now());
    if (reason === 'deadline' || (reason && ocrGroupIndex + 1 >= ocrGroupCount)) {
      this.#reportProbeInconclusive(probe, reason);
    } else if (
      ocrGroupIndex + 1 >= ocrGroupCount &&
      probe.images >= MAX_AUTO_LANGUAGE_PROBE_IMAGES
    ) {
      this.#reportProbeInconclusive(probe, probe.finalReason());
    }
    return undefined;
  }

  async #detectTranscriptLanguage(
    transcript: string,
    signal: AbortSignal,
  ): Promise<SupportedLanguage | undefined> {
    const detectLanguage = this.environment.detectLanguage;
    const sample = transcript.replace(/\s+/gu, ' ').trim().slice(0, 4_000);
    if (!detectLanguage || sample.length < 3) return undefined;
    try {
      const detected = await raceAbortPromise(detectLanguage(sample), signal);
      if (!detected.isReliable) return undefined;
      const candidate = [...detected.languages]
        .sort((left, right) => right.percentage - left.percentage)
        .find((entry) => entry.percentage >= 70 &&
          canonicalizeLanguageTag(entry.language));
      return candidate
        ? canonicalizeLanguageTag(candidate.language)
        : undefined;
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  }

  #reportProbeInconclusive(
    probe: AutoImageLanguageProbe,
    reason: AutoLanguageProbeInconclusiveReason,
  ): void {
    if (
      this.#probeInconclusiveReported ||
      this.#autoLanguageProbe !== probe
    ) return;
    this.#probeInconclusiveReported = true;
    this.environment.onDiagnostic?.(Object.freeze({
      stage: 'auto-language-probe-inconclusive' as const,
      reason,
      attempts: probe.attempts,
      samples: probe.images,
    }));
    this.#clearAutoLanguageProbeDeadline();
    this.#probeLifetimeAbortController?.abort(
      new DOMException('Auto language probe finished.', 'AbortError'),
    );
  }

  #effectiveDetectedSourceLanguage(): SupportedLanguage | undefined {
    return this.#configuration.detectedSourceLanguage ??
      this.#probeDetectedSourceLanguage;
  }

  #pageLanguageResolutionBlocksWork(): boolean {
    return this.#configuration.sourceLanguage === 'auto' &&
      !this.#effectiveDetectedSourceLanguage() &&
      Boolean(this.#configuration.pageLanguageResolutionPending);
  }

  #resetAutoLanguageProbe(): void {
    this.#clearAutoLanguageProbeDeadline();
    this.#probeLifetimeAbortController?.abort(
      new DOMException('Auto language probe reset.', 'AbortError'),
    );
    this.#probeLifetimeAbortController = undefined;
    this.#autoLanguageProbe = undefined;
    this.#probeDetectedSourceLanguage = undefined;
    this.#probeSchedulerRebuildRequested = false;
    this.#probeInconclusiveReported = false;
    this.#probeStartedReported = false;
    this.#probeSampleIdentities.clear();
    this.#probeOcrProgress.clear();
  }

  #restartAfterAutoLanguageEvidenceInvalidation(): void {
    this.#processingVersion += 1;
    this.#activeAbortController?.abort();
    this.#resetAutoLanguageProbe();
    // The source evidence is unchanged; preserve its bounded ranking index so
    // an Auto invalidation cannot repeatedly rediscover the same saturation.
    this.#beginPair(true);
    this.#rebuildScheduler();
  }

  #probeSampleIdentity(
    descriptor: SourceImageDescriptor,
  ): AutoLanguageProbeSampleIdentity {
    let identity = this.#probeSampleIdentities.get(descriptor.nodeId);
    if (!identity) {
      identity = createAutoLanguageProbeSampleIdentity();
      this.#probeSampleIdentities.set(descriptor.nodeId, identity);
    }
    return identity;
  }

  #forgetAutoLanguageProbeSample(nodeId: number): boolean {
    const identity = this.#probeSampleIdentities.get(nodeId);
    if (!identity) return false;
    const probe = this.#autoLanguageProbe;
    const resolvedBefore = probe?.resolvedLanguage;
    probe?.forgetSample(identity);
    this.#probeOcrProgress.delete(identity);
    this.#probeSampleIdentities.delete(nodeId);
    return Boolean(resolvedBefore && !probe?.resolvedLanguage);
  }

  #clearAutoLanguageProbeDeadline(): void {
    if (this.#probeDeadlineTimer === undefined) return;
    this.#clearTimer(this.#probeDeadlineTimer);
    this.#probeDeadlineTimer = undefined;
  }

  #reportRecognitionCache(
    access: ImageRecognitionCacheAccess,
    stats: ImageRecognitionCacheStats,
  ): void {
    this.environment.onDiagnostic?.(Object.freeze({
      stage: 'recognition-cache' as const,
      access,
      entries: stats.entries,
      weight: stats.weight,
      hits: stats.hits,
      misses: stats.misses,
      joins: stats.inFlightJoins,
      loads: stats.loads,
    }));
  }

  #reportRecognitionQuality(quality: ImageTextQualitySummary): void {
    this.environment.onDiagnostic?.(Object.freeze({
      stage: 'recognition-quality' as const,
      candidateRegions: quality.candidateRegions,
      acceptedRegions: quality.acceptedRegions,
      rejectedBlankRegions: quality.rejectedBlankRegions,
      rejectedPunctuationRegions: quality.rejectedPunctuationRegions,
      rejectedLowConfidenceRegions: quality.rejectedLowConfidenceRegions,
      rejectedUncorroboratedRegions:
        quality.rejectedUncorroboratedRegions,
      uncertainRegions: quality.uncertainRegions,
      corroboratedRegions: quality.corroboratedRegions,
    }));
  }

  #reportEvidenceSelection(
    selected: 'semantic' | 'ocr',
    reason:
      | ImageEvidenceSelectionReason
      | 'semantic-fallback'
      | 'ocr-fallback',
  ): void {
    this.environment.onDiagnostic?.(Object.freeze({
      stage: 'evidence-selection' as const,
      selected,
      reason,
    }));
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
      // Positive-area accessibility labels are admitted before pixel OCR's
      // size filter. Tracking/zero-area images remain rejected by the
      // scheduler even when the size filter is disabled here.
      skipSmallImages: schedulerSkipsSmallImages(this.#configuration),
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

  #beginPair(preserveSemanticEvidence = false): void {
    this.#pairEpoch += 1;
    this.#pairKey = this.#isEnabled()
      ? `${this.#configuration.sourceLanguage === 'auto'
          ? this.#effectiveDetectedSourceLanguage() ?? 'auto'
          : this.#configuration.sourceLanguage}>${this.#configuration.targetLanguage}` +
          `|${ocrQualityPolicyKey(repairOcrMinimumConfidence(
            this.#configuration.ocrMinimumConfidence,
          ))}|${IMAGE_EVIDENCE_RANKING_POLICY_VERSION}`
      : undefined;
    this.#projectedHashes.clear();
    this.#projectedOrdinals.clear();
    this.#captureRetries.clear();
    this.#emptyRetries.clear();
    if (!preserveSemanticEvidence) this.#semanticEvidenceIndex.clear();
    this.#projector.beginPair(this.#pairEpoch, this.#pairKey);
  }

  #isEnabled(): boolean {
    return !this.#disposed &&
      imageTranslationConfigurationEnabled(this.#configuration);
  }

  #reportConfigurationState(): void {
    if (this.#disposed) return;
    if (!this.#isEnabled()) {
      const reason = !hasEnabledImageReadingMethod(this.#configuration)
        ? 'provider-unavailable'
        : explicitImageLanguagesMatch(this.#configuration)
          ? 'same-language'
          : 'feature-off';
      const key = `disabled:${reason}`;
      if (key === this.#configurationDiagnosticKey) return;
      this.#configurationDiagnosticKey = key;
      this.environment.onDiagnostic?.('disabled');
      this.environment.onDiagnostic?.(Object.freeze({
        stage: 'configuration' as const,
        status: 'disabled' as const,
        reason,
      }));
      return;
    }
    if (!this.#request || this.#sourceWindowId === undefined) {
      const key = 'waiting-for-replica';
      if (key === this.#configurationDiagnosticKey) return;
      this.#configurationDiagnosticKey = key;
      this.environment.onDiagnostic?.('waiting-for-replica');
      this.environment.onDiagnostic?.(Object.freeze({
        stage: 'configuration' as const,
        status: 'waiting-for-replica' as const,
      }));
      return;
    }
    this.#configurationDiagnosticKey = 'active';
  }

  #setProcessing(value: boolean): void {
    if (this.#processing === value) return;
    this.#processing = value;
    this.environment.onBusyChange?.(value);
  }
}

function isTransientCaptureReason(
  reason: ImageCaptureDeferralReason,
): boolean {
  return reason === 'unstable' || reason === 'quota' || reason === 'api' ||
    reason === 'data' || reason === 'decode' || reason === 'surface' ||
    reason === 'encode' || reason === 'digest';
}

function normalizeResetEpoch(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : Number.MAX_SAFE_INTEGER;
}

function imageTranslationConfigurationEnabled(
  configuration: ImageTranslationConfiguration,
): boolean {
  return configuration.enabled &&
    hasEnabledImageReadingMethod(configuration) &&
    !explicitImageLanguagesMatch(configuration);
}

function hasEnabledImageReadingMethod(
  configuration: ImageTranslationConfiguration,
): boolean {
  return imageReadingExecutionPlan(
    configuration.methodOrder ?? configuration.providerOrder,
    configuration.disabledMethodIds ?? [],
    configuration.providerOrder,
  ).length > 0;
}

function accessibilityMethodEnabled(
  configuration: ImageTranslationConfiguration,
): boolean {
  const order = configuration.methodOrder ?? configuration.providerOrder;
  const disabled = new Set(configuration.disabledMethodIds ?? []);
  return order.includes(ACCESSIBILITY_TEXT_METHOD_ID) &&
    !disabled.has(ACCESSIBILITY_TEXT_METHOD_ID);
}

function schedulerSkipsSmallImages(
  configuration: ImageTranslationConfiguration,
): boolean {
  // Accessibility text does not require pixel OCR, so positive-area semantic
  // candidates stay schedulable even when the user filters small OCR images.
  return accessibilityMethodEnabled(configuration)
    ? false
    : configuration.skipSmallImages;
}

function explicitImageLanguagesMatch(
  configuration: ImageTranslationConfiguration,
): boolean {
  return configuration.sourceLanguage !== 'auto' &&
    configuration.sourceLanguage === configuration.targetLanguage;
}

function imageSchedulingReason(
  result: ImageScanUpdateResult,
): string | undefined {
  if (result.status === 'skipped') return result.reason;
  if (result.status === 'overflow') return 'queue-overflow';
  if (result.status === 'rejected') return 'invalid-or-stale-change';
  return undefined;
}

function selectedRecognitionQuality(recognition: Readonly<{
  result: ImageTextResult;
  selectedQuality?: ImageTextQualitySummary;
  quality?: ImageTextQualitySummary;
}>): ImageTextQualitySummary {
  if (recognition.selectedQuality) return recognition.selectedQuality;
  if (recognition.quality) return recognition.quality;
  return Object.freeze({
    ...emptyImageTextQualitySummary(),
    candidateRegions: recognition.result.regions.length,
    acceptedRegions: recognition.result.regions.length,
  });
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
    (configuration.methodOrder ?? []).join(','),
    (configuration.disabledMethodIds ?? []).join(','),
    configuration.policyFingerprint ?? '',
    configuration.controlImages ? '1' : '0',
    ocrQualityPolicyKey(repairOcrMinimumConfidence(
      configuration.ocrMinimumConfidence,
    )),
    IMAGE_EVIDENCE_RANKING_POLICY_VERSION,
  ].join(':');
}

function imageSourcePolicyConfigurationKey(
  configuration: ImageTranslationConfiguration,
): string {
  return [
    configuration.providerOrder.join(','),
    (configuration.methodOrder ?? configuration.providerOrder).join(','),
    (configuration.disabledMethodIds ?? []).join(','),
    configuration.policyFingerprint ?? '',
    configuration.controlImages ? '1' : '0',
    accessibilityMethodEnabled(configuration) ? '1' : '0',
  ].join(':');
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function autoLanguageProbeConfigurationKey(
  configuration: ImageTranslationConfiguration,
): string {
  return [
    configuration.enabled ? '1' : '0',
    configuration.sourceLanguage,
    configuration.detectedSourceLanguage ?? '',
    configuration.providerOrder.join(','),
    (configuration.methodOrder ?? configuration.providerOrder).join(','),
    (configuration.disabledMethodIds ?? []).join(','),
    configuration.policyFingerprint ?? '',
    configuration.controlImages ? '1' : '0',
    accessibilityMethodEnabled(configuration) ? '1' : '0',
    ocrQualityPolicyKey(repairOcrMinimumConfidence(
      configuration.ocrMinimumConfidence,
    )),
    IMAGE_EVIDENCE_RANKING_POLICY_VERSION,
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

function isReplayLease(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function raceAbortPromise<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
