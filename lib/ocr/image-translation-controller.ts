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
import { createReplicaIdentity } from '../replica/replica-identity';
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
import { autoImageLanguageConfigurationKey } from '../language-detection';
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
  type ImageReadingExecutionStep,
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
const IMAGE_RESULT_CACHE_TTL_MS = 15 * 60 * 1_000;
const MAX_RETAINED_IMAGE_EVIDENCE = 512;
const MAX_RETAINED_IMAGE_EVIDENCE_WEIGHT = 1_000_000;
const MAX_ORIGIN_OCR_EVIDENCE_WEIGHT = 1_000_000;
const ORIGIN_OCR_EVIDENCE_SCHEMA_VERSION = 'origin-image-evidence-v2';
const ORIGIN_OCR_QUALITY_IDENTITY_VERSION = 'origin-image-quality-v1';
const ORIGIN_FINAL_ANALYSIS_SCHEMA_VERSION = 'origin-final-analysis-v1';
const UNINITIALIZED_TOP_PAGE_SCOPE = Symbol('uninitialized-top-page-scope');
const UNREUSABLE_TOP_PAGE_SCOPE = Symbol('unreusable-top-page-scope');

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
  | 'accessibility-text-provisional'
  | 'accessibility-text-complete'
  | 'auto-language-probe-reopened'
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
      stage: 'source-read-policy';
      controlImagesEnabled: false;
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
      expirations?: number;
      purges?: number;
      providerEntries?: number;
      providerWeight?: number;
      providerHits?: number;
      providerMisses?: number;
    }>
  | Readonly<{
      stage: 'image-evidence-cache';
      access: 'hit' | 'miss' | 'purge';
      entries: number;
      weight: number;
      hits: number;
      misses: number;
      expirations: number;
      purges: number;
      revalidations: number;
    }>
  | Readonly<{
      stage: 'image-final-cache';
      access: 'hit' | 'miss' | 'purge' | 'rebind';
      entries: number;
      weight: number;
      hits: number;
      misses: number;
      expirations: number;
      purges: number;
      rebinds: number;
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
  readonly onAutoLanguageInvalidated?: (
    document: ReplicaSourceDocumentIdentity,
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
  readonly completedProviders: Set<ImageTextProviderId>;
}

interface PendingSemanticImageEvidence {
  readonly evidence: SourceImageAccessibilityTextEvidence;
  readonly identity: string;
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

interface RetainedAutoLanguageEvidence {
  readonly resolution: Extract<AutoLanguageProbeObservationResult, {
    readonly status: 'resolved';
  }>;
  /** Present only when recognition used the user's current quality policy. */
  readonly recognition?: CompleteImageRecognition;
}

interface PendingOcrImageEvidence {
  readonly recognition: CompleteImageRecognition;
  readonly pixels: AcquiredImagePixels;
  readonly sourceLanguage: SupportedLanguage;
  readonly methodIndex: number;
  readonly providerOrder: readonly ImageTextProviderId[];
  readonly finalConfigurationKey?: string;
  readonly pendingAutoLanguageObservation?:
    PendingAutoLanguageOcrObservation;
  readonly autoLanguageVoteEligible?: boolean;
  /** Providers that still need a real pass after an origin-cache candidate. */
  readonly fallbackProviderOrder?: readonly ImageTextProviderId[];
}

interface RetainedPixelFacts {
  readonly pixelHash: string;
  readonly preprocessingVersion: AcquiredImagePixels['preprocessingVersion'];
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  readonly cropOffsetXCss: number;
  readonly cropOffsetYCss: number;
  readonly cropWidthCss: number;
  readonly cropHeightCss: number;
  readonly renderedWidthCss: number;
  readonly renderedHeightCss: number;
}

interface RetainedOcrImageEvidence {
  readonly recognition: CompleteImageRecognition;
  readonly pixels: RetainedPixelFacts;
  readonly sourceLanguage: SupportedLanguage;
  readonly precedingProviders: ReadonlySet<ImageTextProviderId>;
  readonly requiresPrecedingCorroboration: boolean;
}

interface RetainedOcrRouteOutcome {
  readonly providerOrder: readonly ImageTextProviderId[];
  readonly sourceLanguage: SupportedLanguage;
  readonly status: 'empty' | 'provider-unavailable';
}

interface RetainedImageEvidence {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly evidenceConfigurationKey: string;
  readonly contentRevision: number;
  readonly observationRevision: number;
  /** Capture revision that validates the retained OCR candidates. */
  readonly captureRevision: number;
  readonly expiresAt: number;
  readonly semanticAttempted: boolean;
  readonly semantic?: PendingSemanticImageEvidence;
  readonly ocr: ReadonlyMap<ImageTextProviderId, RetainedOcrImageEvidence>;
  readonly ocrRouteOutcomes: readonly RetainedOcrRouteOutcome[];
  readonly weight: number;
}

interface RetainedFinalImageAnalysis {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly contentRevision: number;
  readonly captureRevision: number;
  readonly finalConfigurationKey: string;
  readonly projection: ImageOverlayProjection;
  readonly expiresAt: number;
  readonly weight: number;
}

interface OriginFinalImageAnalysis {
  readonly methodId: ImageReadingMethodId;
  readonly evidenceKind: 'semantic' | 'ocr';
  readonly regions: readonly TranslatedImageRegion[];
  readonly expiresAt: number;
  readonly weight: number;
}

interface CommittedAutoLanguageResolution {
  readonly language: SupportedLanguage;
  readonly evidence: AutoLanguageProbeEvidence;
  readonly attempts: number;
  readonly images: number;
  readonly autoLanguageConfigurationIdentity: string;
  readonly precedingProviders: ReadonlySet<ImageTextProviderId>;
  readonly requiresPrecedingCorroboration: boolean;
}

interface OriginOcrImageEvidence {
  readonly providerId: ImageTextProviderId;
  readonly recognition: CompleteImageRecognition;
  readonly sourceLanguage: SupportedLanguage;
  readonly pixelIdentity: string;
  readonly qualityPolicyIdentity: string;
  readonly precedingProviders: ReadonlySet<ImageTextProviderId>;
  readonly requiresPrecedingCorroboration: boolean;
  readonly autoLanguageResolution?: CommittedAutoLanguageResolution;
  readonly expiresAt: number;
  readonly weight: number;
}

interface OriginOcrEvidenceReuse {
  readonly recognition: CompleteImageRecognition;
  readonly fallbackProviderOrder: readonly ImageTextProviderId[];
}

interface CachedLanguageDetection {
  readonly language?: SupportedLanguage;
  readonly expiresAt: number;
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
  readonly #retainedProjections = new Map<number, ImageOverlayProjection>();
  readonly #retainedEvidence = new Map<number, RetainedImageEvidence>();
  readonly #retainedFinalAnalyses = new Map<
    number,
    RetainedFinalImageAnalysis
  >();
  readonly #originOcrEvidence = new Map<string, OriginOcrImageEvidence>();
  readonly #originFinalAnalyses = new Map<string, OriginFinalImageAnalysis>();
  readonly #rerankRequestedNodeIds = new Set<number>();
  readonly #semanticRefreshRetainedOcrNodeIds = new Set<number>();
  readonly #languageDetections = new Map<string, CachedLanguageDetection>();
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
  #revokedProbeDetectedSourceLanguage: SupportedLanguage | undefined;
  #probeSchedulerRebuildRequested = false;
  #probeInconclusiveReported = false;
  #probeStartedReported = false;
  #autoLanguageRevalidationPending = false;
  #probeDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #probeLifetimeAbortController: AbortController | undefined;
  #topPageScopeIdentity: string |
    typeof UNINITIALIZED_TOP_PAGE_SCOPE |
    typeof UNREUSABLE_TOP_PAGE_SCOPE = UNINITIALIZED_TOP_PAGE_SCOPE;
  #retainedEvidenceWeight = 0;
  #retainedFinalAnalysisWeight = 0;
  #originOcrEvidenceWeight = 0;
  #originEvidenceHits = 0;
  #originEvidenceMisses = 0;
  #originEvidenceExpirations = 0;
  #originEvidencePurges = 0;
  #originEvidenceRevalidations = 0;
  #originFinalAnalysisWeight = 0;
  #originFinalHits = 0;
  #originFinalMisses = 0;
  #originFinalExpirations = 0;
  #originFinalPurges = 0;
  #originFinalRebinds = 0;
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
    const previousProbeDetectedSourceLanguage =
      this.#probeDetectedSourceLanguage;
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
    const wasEnabled = imageTranslationConfigurationEnabled(
      previous,
      previousProbeDetectedSourceLanguage,
    );
    const sameLanguagePause = imageTranslationSameLanguagePause(
      this.#configuration,
      this.#probeDetectedSourceLanguage,
    );
    const wasSameLanguagePause = imageTranslationSameLanguagePause(
      previous,
      previousProbeDetectedSourceLanguage,
    );
    const pairChanged = pairConfigurationKey(
      previous,
      previousProbeDetectedSourceLanguage,
    ) !== pairConfigurationKey(
      this.#configuration,
      this.#probeDetectedSourceLanguage,
    );
    const preserveCommittedProbeAcrossModeToggle =
      probeConfigurationChanged &&
      previous.sourceLanguage !== this.#configuration.sourceLanguage &&
      !pairChanged &&
      autoLanguageProbeRuntimeConfigurationKey(previous) ===
        autoLanguageProbeRuntimeConfigurationKey(this.#configuration);
    const targetOnlyEvidenceCompatibleChange =
      (wasEnabled || wasSameLanguagePause) && enabled &&
      previous.targetLanguage !== this.#configuration.targetLanguage &&
      sourceEvidenceConfigurationKey(
        previous,
        previousProbeDetectedSourceLanguage,
      ) === sourceEvidenceConfigurationKey(
        this.#configuration,
        this.#probeDetectedSourceLanguage,
      );
    const rankingOrderChanged = rankingOrderConfigurationKey(previous) !==
      rankingOrderConfigurationKey(this.#configuration);
    const schedulingPolicyChanged =
      previous.scanPolicy !== this.#configuration.scanPolicy ||
      schedulerSkipsSmallImages(previous) !==
        schedulerSkipsSmallImages(this.#configuration);
    const imageSourcePolicyChanged = imageSourcePolicyConfigurationKey(previous) !==
      imageSourcePolicyConfigurationKey(this.#configuration);
    const enabledMethodNarrowed = removedEnabledImageReadingMethod(
      previous,
      this.#configuration,
    );
    const imageContentRetentionBoundary =
      (wasEnabled || wasSameLanguagePause) &&
      ((!enabled && !sameLanguagePause) || imageSourcePolicyChanged ||
        enabledMethodNarrowed);
    if (resetEpochAdvanced) {
      this.#recognition?.advanceResetEpoch(resetEpoch);
    }
    if (resetEpochAdvanced || imageContentRetentionBoundary) {
      this.#purgeReusableResults();
      this.#projectedHashes.clear();
      this.#projectedOrdinals.clear();
      this.#projector.clear();
    }
    if (probeConfigurationChanged || resetEpochAdvanced) {
      if (preserveCommittedProbeAcrossModeToggle && !resetEpochAdvanced) {
        this.#suspendAutoLanguageProbeMode();
      } else {
        this.#resetAutoLanguageProbe();
      }
    }
    const pageResolutionGateChanged =
      imagePageLanguageResolutionBlocksWork(
        previous,
        previousProbeDetectedSourceLanguage,
      ) !== imagePageLanguageResolutionBlocksWork(
        this.#configuration,
        this.#probeDetectedSourceLanguage,
      );
    if (!enabled) {
      this.#reportConfigurationState();
      if (sameLanguagePause && !imageContentRetentionBoundary) {
        this.#processingVersion += 1;
        this.#activeAbortController?.abort();
        this.#beginPair(true);
        this.#queueRetainedRerank(true);
        this.#scheduler?.configure({
          policy: configuration.scanPolicy,
          skipSmallImages: schedulerSkipsSmallImages(configuration),
        });
        this.#refreshGates();
      } else {
        if (wasEnabled || wasSameLanguagePause || this.#source) {
          this.#stopSource(false);
        }
        this.#beginPair();
      }
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
      if (pairChanged || resetEpochAdvanced) {
        this.#beginPair(targetOnlyEvidenceCompatibleChange);
      }
      if (
        targetOnlyEvidenceCompatibleChange &&
        !pageResolutionGateChanged &&
        !resetEpochAdvanced
      ) {
        this.#queueRetainedRerank(true);
        this.#scheduler?.configure({
          policy: configuration.scanPolicy,
          skipSmallImages: schedulerSkipsSmallImages(configuration),
        });
        this.#refreshGates();
      } else {
        this.#rebuildScheduler();
      }
    } else if (schedulingPolicyChanged) {
      // A policy change can make the in-flight descriptor ineligible while
      // its asynchronous semantic translation or OCR is still resolving.
      // Release scheduler ownership before advancing the processing epoch so
      // the current run cannot paint stale work or strand the capacity slot.
      const activeJob = this.#activeJob();
      if (activeJob) this.#scheduler?.retry(activeJob);
      this.#processingVersion += 1;
      this.#activeAbortController?.abort();
      this.#scheduler?.configure({
        policy: configuration.scanPolicy,
        skipSmallImages: schedulerSkipsSmallImages(configuration),
      });
      this.#refreshGates();
    } else if (rankingOrderChanged) {
      this.#processingVersion += 1;
      this.#activeAbortController?.abort();
      // Retained evidence is reused in-place. A settled descriptor whose
      // bounded evidence expired or was evicted must still be requeued;
      // otherwise a pure priority change can leave its old winner projected
      // forever with no work capable of applying the new order.
      this.#queueRetainedRerank(true);
      this.#scheduler?.configure({
        policy: configuration.scanPolicy,
        skipSmallImages: schedulerSkipsSmallImages(configuration),
      });
      this.#refreshGates();
    } else {
      this.#scheduler?.configure({
        policy: configuration.scanPolicy,
        skipSmallImages: schedulerSkipsSmallImages(configuration),
      });
      this.#refreshGates();
    }
    if (
      !wasEnabled &&
      this.#request &&
      this.#sourceWindowId !== undefined &&
      !this.#source
    ) {
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
    if (replayLease === this.#replayLease) {
      // A live commit can add the replica node an earlier job was deferred
      // on because its anchor did not exist yet; give those another try.
      this.#reconsiderAnchorDeferred();
      return true;
    }
    this.#adoptReplayLease(replayLease);
    return true;
  }

  #adoptReplayLease(replayLease: number): void {
    const leaseChanged = this.#replayLease !== 0 &&
      this.#replayLease !== replayLease;
    this.#replayLease = replayLease;
    if (leaseChanged) {
      this.#projector.clear();
      this.#rebindRetainedProjections();
    } else {
      this.#projector.refresh();
    }
    this.#refreshGates();
    this.#scheduler?.reconsiderDeferred('anchor');
    this.#kick();
  }

  #reconsiderAnchorDeferred(): void {
    if (!this.#scheduler || !this.#isEnabled()) return;
    if (this.#scheduler.reconsiderDeferred('anchor') > 0) this.#kick();
  }

  /**
   * Re-queue images deferred while the source tab was inactive or the OCR
   * host was unavailable. Call it when the followed tab is activated and when
   * the companion document becomes visible again; a deferral otherwise waits
   * for the next observation of that image.
   */
  resume(): void {
    if (this.#disposed || !this.#scheduler || !this.#isEnabled()) return;
    if (this.#scheduler.reconsiderDeferred() > 0) this.#kick();
  }

  refreshOverlays(): void {
    this.#rebindRetainedProjections();
    this.#projector.refresh();
  }

  /** Cancel the current image job without immediately requeueing it. */
  cancelCurrent(): boolean {
    const job = this.#activeJob();
    const scheduler = this.#scheduler;
    const abortController = this.#activeAbortController;
    if (!job || !scheduler || !abortController) return false;
    if (!scheduler.defer(job)) return false;
    this.#processingVersion += 1;
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
    this.#reportConfigurationState();
  }

  /**
   * Restrict reusable source-derived results to one top-page source scope.
   * The identity is kept only in this controller's memory and never
   * diagnosed. HTTP(S) pages share one normalized origin scope; non-HTTP,
   * malformed, and unknown pages are deliberately uncacheable across calls.
   */
  setTopPageOrigin(pageUrl: string | undefined): void {
    const nextScopeIdentity = topPageSourceScopeIdentity(pageUrl);
    if (
      nextScopeIdentity !== undefined &&
      nextScopeIdentity === this.#topPageScopeIdentity
    ) return;
    this.purgeSourceDerivedCache();
    // Unsupported/opaque URLs do not expose a stable security origin. Never
    // retain their full URL (notably large data: payloads), and do not reuse
    // evidence across two calls that may represent distinct opaque documents.
    this.#topPageScopeIdentity = nextScopeIdentity ??
      UNREUSABLE_TOP_PAGE_SCOPE;
  }

  /** Security boundary used by reset, read narrowing, disable and revocation. */
  purgeSourceDerivedCache(): void {
    this.#processingVersion += 1;
    this.#activeAbortController?.abort();
    this.#purgeReusableResults();
    this.#projectedHashes.clear();
    this.#projectedOrdinals.clear();
    this.#retainedProjections.clear();
    this.#rerankRequestedNodeIds.clear();
    this.#semanticRefreshRetainedOcrNodeIds.clear();
    this.#projector.clear();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.releaseReplica();
    this.#purgeReusableResults();
    this.#recognition = undefined;
    this.#topPageScopeIdentity = UNINITIALIZED_TOP_PAGE_SCOPE;
    this.#projector.dispose();
  }

  #purgeReusableResults(): void {
    this.#recognition?.clear();
    this.#translationMemory.clear();
    this.#languageDetections.clear();
    this.#purgeOriginOcrEvidence();
    this.#purgeOriginFinalAnalyses();
    this.#clearRetainedEvidence();
    this.#clearRetainedFinalAnalyses();
    this.#retainedProjections.clear();
    this.#rerankRequestedNodeIds.clear();
    this.#semanticRefreshRetainedOcrNodeIds.clear();
    this.#captureRetries.clear();
    this.#emptyRetries.clear();
    this.#semanticEvidenceIndex.clear();
    this.#resetAutoLanguageProbe();
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
    const controlImages = this.#configuration.controlImages === true;
    if (!controlImages) {
      // This is deliberately content-free and precedes opening the source
      // channel: controls are withheld before ALT, pixels, or OCR providers
      // can observe them.
      this.environment.onDiagnostic?.(Object.freeze({
        stage: 'source-read-policy' as const,
        controlImagesEnabled: false as const,
      }));
    }
    try {
      const source = await this.environment.openSource(
        request,
        (change) => this.#onSourceChange(change, version),
        abortController.signal,
        {
          policyFingerprint:
            this.#configuration.policyFingerprint ?? 'read-v1-000000',
          controlImages,
          accessibilityTextEnabled: accessibilityMethodEnabled(
            this.#configuration,
          ),
        },
      );
      if (
        version !== this.#sourceVersion ||
        abortController.signal.aborted ||
        !request.isCurrent() ||
        !imageTranslationSourceObservationEnabled(this.#configuration)
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
      !this.#request?.isCurrent() ||
      !this.#sourceRecoveryKey
    ) return;
    if (!this.#isEnabled()) {
      if (imageTranslationSameLanguagePause(
        this.#configuration,
        this.#probeDetectedSourceLanguage,
      )) {
        this.environment.onDiagnostic?.('source-unavailable');
        this.#stopSource(true);
      }
      return;
    }
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
    this.#retainedProjections.clear();
    this.#clearRetainedFinalAnalyses();
    this.#clearRetainedEvidence();
    this.#rerankRequestedNodeIds.clear();
    this.#semanticRefreshRetainedOcrNodeIds.clear();
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
      !imageTranslationSourceObservationEnabled(this.#configuration)
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
    // Rejected changes never mutate controller state. Overflow records remain
    // scheduler-owned candidates and may be admitted later, so mirror their
    // exact descriptor and invalidate obsolete evidence without processing
    // them ahead of the bounded queue.
    if (scheduling.status === 'rejected') {
      this.#setMutationQuiet(false);
      this.#kick();
      return;
    }

    const semanticPeers = new Set<number>();
    let invalidatedAutoResolution = false;
    if (change.kind === 'upsert') {
      const previous = this.#descriptors.get(change.descriptor.nodeId);
      const contentChanged = Boolean(
        previous &&
        previous.contentRevision !== change.descriptor.contentRevision
      );
      const captureChanged = Boolean(
        previous &&
        descriptorCaptureRevision(previous) !==
          descriptorCaptureRevision(change.descriptor)
      );
      if (previous && contentChanged) {
        for (const nodeId of this.#semanticEvidenceIndex.unregister(
          change.descriptor.nodeId,
        ).reevaluateNodeIds) semanticPeers.add(nodeId);
      }
      if (previous && (contentChanged || captureChanged)) {
        invalidatedAutoResolution = this.#forgetAutoLanguageProbeSample(
          change.descriptor.nodeId,
        ) || invalidatedAutoResolution;
      }
      this.#descriptors.set(change.descriptor.nodeId, change.descriptor);
      if (
        previous &&
        previous.observationRevision !== change.descriptor.observationRevision
      ) {
        if (contentChanged) {
          const retainedProjection = this.#retainedProjections.get(
            change.descriptor.nodeId,
          );
          const retainOcrProjection = Boolean(
            !captureChanged &&
            retainedProjection?.evidenceKind === 'ocr' &&
            retainedProjection.pairEpoch === this.#pairEpoch &&
            retainedProjection.pairKey === this.#pairKey &&
            sameSourceDocument(
              retainedProjection.document,
              change.descriptor.document,
            ) &&
            this.#projectedHashes.get(change.descriptor.nodeId) ===
              retainedProjection.pixelHash,
          );
          if (!retainOcrProjection) {
            this.#projectedHashes.delete(change.descriptor.nodeId);
            this.#projectedOrdinals.delete(change.descriptor.nodeId);
            this.#retainedProjections.delete(change.descriptor.nodeId);
          }
          if (captureChanged) {
            this.#deleteRetainedEvidence(change.descriptor.nodeId);
            this.#semanticRefreshRetainedOcrNodeIds.delete(
              change.descriptor.nodeId,
            );
          } else {
            if (this.#rebaseRetainedCaptureEvidence(change.descriptor)) {
              this.#semanticRefreshRetainedOcrNodeIds.add(
                change.descriptor.nodeId,
              );
            } else {
              this.#semanticRefreshRetainedOcrNodeIds.delete(
                change.descriptor.nodeId,
              );
            }
          }
          this.#deleteRetainedFinalAnalysis(change.descriptor.nodeId);
          if (retainOcrProjection && retainedProjection) {
            const provisional: ImageOverlayProjection = Object.freeze({
              ...retainedProjection,
              contentRevision: change.descriptor.contentRevision,
              observationRevision: change.descriptor.observationRevision,
            });
            this.#retainedProjections.set(change.descriptor.nodeId, provisional);
            if (!this.#projector.project(provisional)) {
              this.#projectedHashes.delete(change.descriptor.nodeId);
              this.#projectedOrdinals.delete(change.descriptor.nodeId);
              this.#retainedProjections.delete(change.descriptor.nodeId);
              this.#projector.remove(
                change.descriptor.document,
                change.descriptor.nodeId,
              );
            }
          } else {
            this.#projector.remove(
              change.descriptor.document,
              change.descriptor.nodeId,
            );
          }
        } else {
          this.#semanticRefreshRetainedOcrNodeIds.delete(
            change.descriptor.nodeId,
          );
          if (captureChanged) {
            this.#projectedHashes.delete(change.descriptor.nodeId);
            this.#projectedOrdinals.delete(change.descriptor.nodeId);
            this.#retainedProjections.delete(change.descriptor.nodeId);
            this.#deleteRetainedFinalAnalysis(change.descriptor.nodeId);
            this.#projector.remove(
              change.descriptor.document,
              change.descriptor.nodeId,
            );
          } else if (!this.#rebaseRetainedObservation(change.descriptor)) {
            // A missing/replaced replay anchor cannot inherit projection
            // currency. Reopen only this exact image while every unrelated
            // settled completion remains carried by the scheduler.
            scheduler.requeueCurrent(change.descriptor);
          }
        }
        this.#rerankRequestedNodeIds.delete(change.descriptor.nodeId);
        this.#captureRetries.delete(change.descriptor.nodeId);
        this.#emptyRetries.delete(change.descriptor.nodeId);
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
      this.#retainedProjections.delete(change.nodeId);
      this.#deleteRetainedFinalAnalysis(change.nodeId);
      this.#deleteRetainedEvidence(change.nodeId);
      this.#rerankRequestedNodeIds.delete(change.nodeId);
      this.#semanticRefreshRetainedOcrNodeIds.delete(change.nodeId);
      this.#captureRetries.delete(change.nodeId);
      this.#emptyRetries.delete(change.nodeId);
      this.#projector.remove(change.document, change.nodeId);
    }
    for (const nodeId of semanticPeers) {
      const affected = this.#descriptors.get(nodeId);
      if (!affected) continue;
      invalidatedAutoResolution = this.#forgetAutoLanguageProbeSample(nodeId) ||
        invalidatedAutoResolution;
      if (!this.#requeueRetainedEvidence(affected, scheduler)) {
        this.#clearProjection(affected);
        scheduler.requeueCurrent(affected);
      }
    }
    for (const cancellation of scheduler.drainCancellations()) {
      if (
        cancellation.job.descriptor.nodeId ===
        this.#activeJob()?.descriptor.nodeId
      ) this.#activeAbortController?.abort();
    }
    if (invalidatedAutoResolution) {
      this.#reopenAutoLanguageAfterSampleInvalidation();
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
            this.#rebuildScheduler(true);
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
      // Configuration changes may advance processingVersion while reusing the
      // same scheduler. Any replacement queued before the active abort must be
      // allowed to start once this run releases the capacity-one processor.
      this.#kick();
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
      scheduler.defer(job, 'anchor');
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
    const semanticRefreshRetainedOcr =
      this.#semanticRefreshRetainedOcrNodeIds.delete(job.descriptor.nodeId);
    if (
      this.#rerankRequestedNodeIds.delete(job.descriptor.nodeId) &&
      await this.#commitRetainedWinner(
        job,
        scheduler,
        processingVersion,
        jobOrdinal,
        replayLease,
        pairEpoch,
        pairKey,
        steps,
        ocrEligibility.eligible,
        signal,
      )
    ) return;
    let pixels: AcquiredImagePixels | undefined;
    let captureDeferral: Extract<PixelAcquisitionResult, {
      readonly status: 'deferred';
    }> | undefined;
    let sourceLanguage: SupportedLanguage | undefined;
    let sawOcrStep = false;
    let sawEmptyRecognition = false;
    let transientRecognitionFailure = false;
    let unsupportedLanguage = false;
    let originFinalChecked = false;
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

    // Accessibility labels are cheap and useful as a progressive first paint.
    // Read and, when sufficiently specific, project them before entering the
    // saved ranking order. The later method loop still performs the ordinary
    // semantic/OCR comparison using the user's configured priority.
    const semanticStepIndex = steps.findIndex(
      (step) => step.kind === 'accessibility-text',
    );
    const retainedSemantic = semanticStepIndex >= 0
      ? this.#retainedEvidenceRecord(job.descriptor)
      : undefined;
    let eagerSemanticRead = semanticStepIndex >= 0;
    let eagerSemanticCandidate: PendingSemanticImageEvidence | undefined;
    let eagerSemanticProjectionAttempted = false;
    let eagerSemanticProjected = false;
    if (eagerSemanticRead) {
      try {
        eagerSemanticCandidate = retainedSemantic?.semanticAttempted
          ? retainedSemantic.semantic
            ? semanticCandidateAtMethodIndex(
                retainedSemantic.semantic,
                semanticStepIndex,
              )
            : undefined
          : await this.#readAccessibilityCandidate(
              job,
              scheduler,
              semanticStepIndex,
              processingVersion,
              pairEpoch,
              pairKey,
              signal,
            );
        if (
          eagerSemanticCandidate &&
          !eagerSemanticProjectionAttempted &&
          progressiveSemanticEvidence(eagerSemanticCandidate.rankable)
        ) {
          eagerSemanticProjectionAttempted = true;
          eagerSemanticProjected = await this.#commitAccessibilityCandidate(
            eagerSemanticCandidate,
            job,
            scheduler,
            processingVersion,
            jobOrdinal,
            replayLease,
            pairEpoch,
            pairKey,
            signal,
            true,
          );
        }
      } catch (error) {
        if (
          isAbortError(error) ||
          signal.aborted ||
          isImageSourceUnavailableError(error)
        ) throw error;
        // Isolate malformed source evidence to this exact revision. Retrying it
        // immediately would spin the capacity-one scheduler and starve later
        // images; a source revision or explicit rerun can try again.
        this.#rememberSemanticAbsence(job.descriptor);
        this.environment.onDiagnostic?.('accessibility-text-blocked');
      }
    }

    // A semantic-only revision can reuse capture-revision-bound OCR evidence.
    // Re-rank it only after the fresh accessibility label has been read.
    if (semanticRefreshRetainedOcr && await this.#commitRetainedWinner(
      job,
      scheduler,
      processingVersion,
      jobOrdinal,
      replayLease,
      pairEpoch,
      pairKey,
      steps,
      ocrEligibility.eligible,
      signal,
    )) return;

    if (this.#commitRetainedFinalAnalysis(
      job,
      scheduler,
      processingVersion,
      jobOrdinal,
      replayLease,
      pairEpoch,
      pairKey,
      this.#finalAnalysisConfigurationKey(steps, eagerSemanticCandidate),
      signal,
    )) return;

    methodLoop: for (const [methodIndex, step] of steps.entries()) {
      signal.throwIfAborted();
      if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
        throw new DOMException('Image job became stale.', 'AbortError');
      }
      try {
      if (step.kind === 'accessibility-text') {
        const candidate = eagerSemanticRead
          ? eagerSemanticCandidate
          : await this.#readAccessibilityCandidate(
              job,
              scheduler,
              methodIndex,
              processingVersion,
              pairEpoch,
              pairKey,
              signal,
            );
        eagerSemanticRead = false;
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
              if (
                isAbortError(error) ||
                signal.aborted ||
                isImageSourceUnavailableError(error)
              ) {
                this.#rollbackPendingOcrLanguageObservation(
                  ocr.pendingAutoLanguageObservation,
                );
                clearProvisionalSourceLanguage(
                  ocr.pendingAutoLanguageObservation,
                );
                throw error;
              }
              // A transient semantic projection failure must not discard the
              // already-ranked OCR fallback or force another provider route.
              this.environment.onDiagnostic?.('accessibility-text-blocked');
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
            if (this.#hasOcrAlternatives(ocr)) {
              this.#reportEvidenceSelection('ocr', 'ocr-fallback');
              if (await this.#commitOcrAlternatives(
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
        const canCompareWithLaterOcr = ocrEligibility.eligible &&
          steps.slice(methodIndex + 1).some(({ kind }) => kind === 'ocr');
        const awaitsEarlierOcrRetry = Boolean(
          captureDeferral && isTransientCaptureReason(captureDeferral.reason),
        );
        if (canCompareWithLaterOcr || awaitsEarlierOcrRetry) {
          heldSemantic = candidate;
          if (
            !eagerSemanticProjectionAttempted &&
            progressiveSemanticEvidence(candidate.rankable)
          ) {
            eagerSemanticProjectionAttempted = true;
            eagerSemanticProjected = await this.#commitAccessibilityCandidate(
              candidate,
              job,
              scheduler,
              processingVersion,
              jobOrdinal,
              replayLease,
              pairEpoch,
              pairKey,
              signal,
              true,
            );
          }
          continue;
        }
        const assessment = assessSemanticImageEvidence(candidate.rankable);
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
        const revalidateAutoLanguage =
          this.#autoLanguageRevalidationPending &&
          this.#configuration.sourceLanguage === 'auto' &&
          !pixels.nearestElementLanguage;
        sourceLanguage = resolveImageSourceLanguage({
          nearestElementLanguage: pixels.nearestElementLanguage,
          ...(this.#configuration.sourceLanguage === 'auto'
            ? {}
            : { explicitSourceLanguage: this.#configuration.sourceLanguage }),
          ...(!revalidateAutoLanguage && this.#effectiveDetectedSourceLanguage()
            ? { detectedPageLanguage: this.#effectiveDetectedSourceLanguage() }
            : {}),
        });
        if (!sourceLanguage) {
          const retainedAutoLanguage = this.#readOriginAutoLanguageEvidence(
            pixels,
            step.providerOrder,
          );
          if (retainedAutoLanguage) {
            if (retainedAutoLanguage.recognition) {
              this.#rememberOcrCandidate(job.descriptor, Object.freeze({
                recognition: retainedAutoLanguage.recognition,
                pixels,
                sourceLanguage: retainedAutoLanguage.resolution.language,
                methodIndex,
                providerOrder: step.providerOrder,
              }));
            }
            sourceLanguage = this.#restoreOriginAutoLanguageEvidence(
              retainedAutoLanguage,
              job.descriptor,
            );
            if (this.#pairEpoch !== pairEpoch) return;
            // A cached resolution that originally required distinct images is
            // only one current-document vote. Do not rerun OCR for that same
            // image merely to count the identical source twice.
            if (!sourceLanguage) {
              unsupportedLanguage = true;
              continue;
            }
          }
        }
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
            sourceLanguage = revalidateAutoLanguage
              ? this.#effectiveDetectedSourceLanguage()
              : undefined;
            if (!sourceLanguage) {
              unsupportedLanguage = true;
              continue;
            }
          }
        }
      }
      if (
        !originFinalChecked &&
        !stagedOcrLanguageObservation
      ) {
        originFinalChecked = true;
        const finalConfigurationKey = this.#finalAnalysisConfigurationKey(
          steps,
          eagerSemanticCandidate,
        );
        const retainedFinal = this.#readOriginFinalAnalysis(
          pixels,
          sourceLanguage,
          finalConfigurationKey,
        );
        if (retainedFinal && this.#commitOriginFinalAnalysis(
          retainedFinal,
          pixels,
          sourceLanguage,
          finalConfigurationKey,
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
      const retainedRecognition = this.#readOriginOcrEvidence(
        pixels,
        sourceLanguage,
        step.providerOrder,
      );
      const recognizer = retainedRecognition ? undefined : this.#recognizer();
      if (!retainedRecognition) {
        this.environment.onDiagnostic?.('recognition-started');
        this.#reportJobProgress(
          jobOrdinal,
          'recognition-started',
          job.descriptor,
          pixels,
        );
      }
      let recognition = retainedRecognition?.recognition ?? await recognizer!.recognize(
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
          if (recognition.code === 'provider-unavailable') {
            this.#rememberOcrRouteOutcome(
              job.descriptor,
              step.providerOrder,
              sourceLanguage,
              'provider-unavailable',
            );
          }
          if (isTransientRecognitionCode(recognition.code)) {
            transientRecognitionFailure = true;
          }
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
          if (!recognition.continuation) {
            this.#rememberOcrRouteOutcome(
              job.descriptor,
              step.providerOrder,
              sourceLanguage,
              'empty',
            );
          }
          sawEmptyRecognition = true;
          if (!recognition.continuation) break;
          recognition = await recognizer!.continueRecognition(
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
          recognition = await recognizer!.continueRecognition(
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
          providerOrder: step.providerOrder,
          finalConfigurationKey: this.#finalAnalysisConfigurationKey(
            steps,
            eagerSemanticCandidate,
          ),
          ...(selectedOcrLanguageObservation
            ? {
                pendingAutoLanguageObservation:
                  selectedOcrLanguageObservation.pendingObservation,
              }
            : {}),
          ...(retainedRecognition?.fallbackProviderOrder.length
            ? {
                fallbackProviderOrder:
                  retainedRecognition.fallbackProviderOrder,
              }
            : {}),
        });
        this.#rememberOcrCandidate(job.descriptor, ocrCandidate);
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
              if (
                isAbortError(error) ||
                signal.aborted ||
                isImageSourceUnavailableError(error)
              ) {
                this.#rollbackPendingOcrLanguageObservation(
                  ocrCandidate.pendingAutoLanguageObservation,
                );
                clearProvisionalSourceLanguage(
                  ocrCandidate.pendingAutoLanguageObservation,
                );
                throw error;
              }
              this.environment.onDiagnostic?.('accessibility-text-blocked');
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
            if (this.#hasOcrAlternatives(ocrCandidate)) {
              this.#reportEvidenceSelection('ocr', 'ocr-fallback');
              if (await this.#commitOcrAlternatives(
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
        if (error instanceof TransientRecognitionError) {
          transientRecognitionFailure = true;
        }
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
      // An inactive source tab is a deferral, not a completion: resume()
      // re-queues the image once the tab is active again.
      if (
        retryExhausted ||
        captureDeferral.reason === 'permission' ||
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

    if (transientRecognitionFailure) {
      // Host and worker outages are transient. Project any held label, then
      // defer the image so resume() or a later observation re-queues it
      // instead of marking it done for the session.
      if (await commitHeldSemantic()) return;
      scheduler.defer(job);
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
          candidate,
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
          candidate,
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
        this.#retainedProjections.set(job.descriptor.nodeId, projection);
        if (!this.#projector.project(projection)) {
          this.#projectedHashes.delete(job.descriptor.nodeId);
          this.#projectedOrdinals.delete(job.descriptor.nodeId);
          this.#retainedProjections.delete(job.descriptor.nodeId);
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
        const finalConfigurationKey = candidate.finalConfigurationKey ??
          this.#finalAnalysisConfigurationKey(
            imageReadingExecutionPlan(
              this.#configuration.methodOrder ??
                this.#configuration.providerOrder,
              this.#configuration.disabledMethodIds ?? [],
              this.#configuration.providerOrder,
            ),
          );
        this.#rememberFinalAnalysis(
          job.descriptor,
          projection,
          finalConfigurationKey,
        );
        this.#rememberOriginFinalAnalysis({
          pixels: candidate.pixels,
          sourceLanguage: candidate.sourceLanguage,
          methodId: candidate.recognition.result.providerId,
          finalConfigurationKey,
        }, regions);
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
      if (!allowContinuation || !this.#hasOcrAlternatives(candidate)) {
        return false;
      }
      return await this.#commitOcrAlternatives(
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

  #hasOcrAlternatives(candidate: PendingOcrImageEvidence): boolean {
    return Boolean(
      candidate.recognition.continuation ||
      candidate.fallbackProviderOrder?.length,
    );
  }

  async #commitOcrAlternatives(
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
    if (candidate.recognition.continuation) {
      return this.#commitOcrContinuations(
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
    }
    const providerOrder = candidate.fallbackProviderOrder;
    if (!providerOrder?.length) return false;
    signal.throwIfAborted();
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('OCR fallback became stale.', 'AbortError');
    }
    this.environment.onDiagnostic?.('recognition-started');
    this.#reportJobProgress(
      jobOrdinal,
      'recognition-started',
      job.descriptor,
      candidate.pixels,
    );
    const languageGroup = tesseractLanguageGroupFor(candidate.sourceLanguage);
    const recognition = await this.#recognizer().recognize(
      candidate.pixels,
      {
        providerOrder,
        sourceLanguage: candidate.sourceLanguage,
        minimumConfidence: repairOcrMinimumConfidence(
          this.#configuration.ocrMinimumConfidence,
        ),
        ...(languageGroup
          ? { languageGroup, modelVersion: TESSERACT_MODEL_VERSION }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('OCR fallback became stale.', 'AbortError');
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
    const fallbackCandidate: PendingOcrImageEvidence = Object.freeze({
      recognition,
      pixels: candidate.pixels,
      sourceLanguage: candidate.sourceLanguage,
      methodIndex: candidate.methodIndex,
      providerOrder: candidate.providerOrder,
      ...(candidate.finalConfigurationKey
        ? { finalConfigurationKey: candidate.finalConfigurationKey }
        : {}),
    });
    if (recognition.result.regions.length > 0) {
      this.#rememberOcrCandidate(job.descriptor, fallbackCandidate);
    }
    return this.#commitOcrCandidate(
      fallbackCandidate,
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
        if (recognition.result.regions.length === 0) {
          if (!recognition.continuation) {
            this.#rememberOcrRouteOutcome(
              job.descriptor,
              candidate.providerOrder,
              candidate.sourceLanguage,
              'empty',
            );
          }
          continue;
        }

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
        const continuationCandidate: PendingOcrImageEvidence = Object.freeze({
            recognition,
            pixels: candidate.pixels,
            sourceLanguage: selectedSourceLanguage,
            methodIndex: candidate.methodIndex,
            providerOrder: candidate.providerOrder,
            ...(candidate.finalConfigurationKey
              ? { finalConfigurationKey: candidate.finalConfigurationKey }
              : {}),
            ...(selectedPendingObservation
              ? {
                  pendingAutoLanguageObservation:
                    selectedPendingObservation,
                  autoLanguageVoteEligible:
                    selectedAutoLanguageVoteEligible ?? false,
                }
              : {}),
          });
        this.#rememberOcrCandidate(job.descriptor, continuationCandidate);
        return await this.#commitOcrCandidate(
          continuationCandidate,
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
    candidate?: PendingOcrImageEvidence,
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
    if (observed.status !== 'resolved') return false;
    const pairEpoch = this.#pairEpoch;
    this.#acceptAutoLanguageResolution(
      observed,
      descriptor.document,
      'ocr',
    );
    if (candidate) {
      this.#markOriginOcrAutoLanguageResolution(candidate, observed);
    }
    return this.#pairEpoch !== pairEpoch;
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
    if (!accessibilityMethodEnabled(this.#configuration)) return undefined;
    if (!read) {
      this.#rememberSemanticAbsence(job.descriptor);
      return undefined;
    }
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
      this.#rememberSemanticAbsence(job.descriptor);
      this.environment.onDiagnostic?.('accessibility-text-empty');
      return undefined;
    }
    if (
      evidence.nodeId !== job.descriptor.nodeId ||
      evidence.contentRevision !== job.descriptor.contentRevision ||
      evidence.observationRevision !== job.descriptor.observationRevision ||
      !sameSourceDocument(evidence.document, job.descriptor.document)
    ) throw new Error('Accessibility evidence did not match the requested image.');
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
      this.#rememberSemanticAbsence(job.descriptor);
      this.environment.onDiagnostic?.('accessibility-text-empty');
      return undefined;
    }
    const identity = await sha256Hex([
      'semantic-evidence-v1',
      evidence.source,
      evidence.text,
      sourceLanguage,
    ].join('\u0000'));
    signal.throwIfAborted();
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Accessibility evidence became stale.', 'AbortError');
    }
    // Only language-resolved evidence participates in repetition ranking.
    // Otherwise an attempted-but-unusable label could downgrade a valid peer.
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
      if (!this.#requeueRetainedEvidence(affected, scheduler)) {
        this.#clearProjection(affected);
        scheduler.requeueCurrent(affected);
      }
    }
    this.#abortCancelledActiveJob(scheduler);
    if (invalidatedAutoResolution) {
      this.#reopenAutoLanguageAfterSampleInvalidation();
      throw new DOMException(
        'Accessibility evidence changed Auto language.',
        'AbortError',
      );
    }
    const candidate = Object.freeze({
      evidence,
      identity,
      sourceLanguage,
      rankable: Object.freeze({
        kind: 'semantic' as const,
        text: evidence.text,
        source: evidence.source,
        methodIndex,
        repeated: registration.repeated,
      }),
    });
    this.#rememberSemanticCandidate(job.descriptor, candidate);
    return candidate;
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
    provisional = false,
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
      if (!provisional && this.#observeSemanticImageLanguage(
        evidence.text,
        sourceLanguage,
        job.descriptor,
      )) return true;
      if (!provisional) {
        this.#clearProjection(job.descriptor);
        scheduler.settle(job);
        this.environment.onDiagnostic?.('same-language');
      }
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
    const evidenceIdentity = candidate.identity;
    if (!provisional && this.#observeSemanticImageLanguage(
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
    this.#retainedProjections.set(job.descriptor.nodeId, projection);
    if (!this.#projector.project(projection)) {
      this.#projectedHashes.delete(job.descriptor.nodeId);
      this.#projectedOrdinals.delete(job.descriptor.nodeId);
      this.#retainedProjections.delete(job.descriptor.nodeId);
      if (!provisional) scheduler.defer(job);
      this.environment.onDiagnostic?.('projection-deferred');
      return !provisional;
    }
    if (provisional) {
      this.environment.onDiagnostic?.('accessibility-text-provisional');
      this.environment.onDiagnostic?.('projected');
      return true;
    }
    this.#rememberFinalAnalysis(
      job.descriptor,
      projection,
      this.#finalAnalysisConfigurationKey(
        imageReadingExecutionPlan(
          this.#configuration.methodOrder ?? this.#configuration.providerOrder,
          this.#configuration.disabledMethodIds ?? [],
          this.#configuration.providerOrder,
        ),
        candidate,
      ),
    );
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

  #rememberSemanticCandidate(
    descriptor: SourceImageDescriptor,
    semantic: PendingSemanticImageEvidence,
  ): void {
    const current = this.#retainedEvidenceRecord(descriptor);
    this.#rememberEvidence(descriptor, {
      captureRevision: current?.captureRevision ?? descriptorCaptureRevision(descriptor),
      semanticAttempted: true,
      semantic,
      ocr: current?.ocr ?? new Map(),
      ocrRouteOutcomes: current?.ocrRouteOutcomes ?? Object.freeze([]),
    });
  }

  #rememberSemanticAbsence(descriptor: SourceImageDescriptor): void {
    const current = this.#retainedEvidenceRecord(descriptor);
    this.#rememberEvidence(descriptor, {
      captureRevision: current?.captureRevision ?? descriptorCaptureRevision(descriptor),
      semanticAttempted: true,
      ocr: current?.ocr ?? new Map(),
      ocrRouteOutcomes: current?.ocrRouteOutcomes ?? Object.freeze([]),
    });
  }

  #hasCurrentSemanticProjection(descriptor: SourceImageDescriptor): boolean {
    const projection = this.#retainedProjections.get(descriptor.nodeId);
    return Boolean(
      projection &&
      projection.evidenceKind === 'semantic' &&
      projection.methodId === ACCESSIBILITY_TEXT_METHOD_ID &&
      sameSourceDocument(projection.document, descriptor.document) &&
      projection.contentRevision === descriptor.contentRevision &&
      projection.observationRevision === descriptor.observationRevision &&
      this.#isProjectionCurrent(projection),
    );
  }

  #hasCurrentProjection(descriptor: SourceImageDescriptor): boolean {
    const projection = this.#retainedProjections.get(descriptor.nodeId);
    return Boolean(
      projection &&
      sameSourceDocument(projection.document, descriptor.document) &&
      projection.contentRevision === descriptor.contentRevision &&
      projection.observationRevision === descriptor.observationRevision &&
      this.#isProjectionCurrent(projection),
    );
  }

  #rememberOcrCandidate(
    descriptor: SourceImageDescriptor,
    candidate: PendingOcrImageEvidence,
  ): void {
    const providerId = candidate.recognition.result.providerId;
    const context = retainedOcrProviderContext(
      candidate.providerOrder,
      providerId,
      candidate.recognition,
    );
    if (!context) return;
    const current = this.#retainedEvidenceRecord(descriptor);
    const ocr = new Map(current?.ocr ?? []);
    const { continuation: _continuation, ...recognition } =
      candidate.recognition;
    ocr.set(providerId, Object.freeze({
      recognition: Object.freeze(recognition) as CompleteImageRecognition,
      pixels: retainedPixelFacts(candidate.pixels),
      sourceLanguage: candidate.sourceLanguage,
      ...context,
    }));
    this.#rememberEvidence(descriptor, {
      captureRevision: descriptorCaptureRevision(descriptor),
      semanticAttempted: current?.semanticAttempted ?? false,
      ...(current?.semantic ? { semantic: current.semantic } : {}),
      ocr,
      ocrRouteOutcomes: current?.ocrRouteOutcomes ?? Object.freeze([]),
    });
    this.#rememberOriginOcrEvidence(candidate);
  }

  #rememberOcrRouteOutcome(
    descriptor: SourceImageDescriptor,
    providerOrder: readonly ImageTextProviderId[],
    sourceLanguage: SupportedLanguage,
    status: RetainedOcrRouteOutcome['status'],
  ): void {
    const current = this.#retainedEvidenceRecord(descriptor);
    if (providerOrder.length === 0) return;
    const routeKey = `${sourceLanguage}\u0001${providerOrder.join('\u0000')}`;
    const ocrRouteOutcomes = [
      ...(current?.ocrRouteOutcomes ?? []).filter((outcome) =>
        `${outcome.sourceLanguage}\u0001${
          outcome.providerOrder.join('\u0000')
        }` !== routeKey
      ),
      Object.freeze({
        providerOrder: Object.freeze([...providerOrder]),
        sourceLanguage,
        status,
      }),
    ].slice(-16);
    this.#rememberEvidence(descriptor, {
      captureRevision: current?.captureRevision ?? descriptorCaptureRevision(descriptor),
      semanticAttempted: current?.semanticAttempted ?? false,
      ...(current?.semantic ? { semantic: current.semantic } : {}),
      ocr: current?.ocr ?? new Map(),
      ocrRouteOutcomes: Object.freeze(ocrRouteOutcomes),
    });
  }

  #rememberOriginOcrEvidence(
    candidate: PendingOcrImageEvidence,
    autoLanguageResolution?: Extract<AutoLanguageProbeObservationResult, {
      readonly status: 'resolved';
    }>,
    recognitionMinimumConfidence = repairOcrMinimumConfidence(
      this.#configuration.ocrMinimumConfidence,
    ),
  ): void {
    const providerId = candidate.recognition.result.providerId;
    const context = retainedOcrProviderContext(
      candidate.providerOrder,
      providerId,
      candidate.recognition,
    );
    if (!context) return;
    const key = originOcrEvidenceKey(
      candidate.pixels,
      candidate.sourceLanguage,
      providerId,
      recognitionMinimumConfidence,
    );
    const qualityPolicyIdentity = originOcrQualityPolicyIdentity(
      recognitionMinimumConfidence,
    );
    const recognition = reusableCompleteRecognition(candidate.recognition);
    const existing = this.#originOcrEvidence.get(key);
    const pixelIdentity = originOcrPixelIdentity(candidate.pixels);
    const committedAutoLanguage = autoLanguageResolution &&
        autoLanguageResolution.language === candidate.sourceLanguage
      ? committedAutoLanguageResolution(
          autoLanguageResolution,
          context,
          originOcrQualityPolicyIdentity(
            repairOcrMinimumConfidence(
              this.#configuration.ocrMinimumConfidence,
            ),
          ),
        )
      : existing?.pixelIdentity === pixelIdentity
        ? existing.autoLanguageResolution
        : undefined;
    const weight = originOcrEvidenceWeight(
      key,
      recognition.result,
      context.precedingProviders,
      committedAutoLanguage,
      qualityPolicyIdentity,
    );
    if (weight > MAX_ORIGIN_OCR_EVIDENCE_WEIGHT) return;
    this.#deleteOriginOcrEvidence(key);
    this.#originOcrEvidence.set(key, Object.freeze({
      providerId,
      recognition,
      sourceLanguage: candidate.sourceLanguage,
      pixelIdentity,
      qualityPolicyIdentity,
      ...context,
      ...(committedAutoLanguage
        ? { autoLanguageResolution: committedAutoLanguage }
        : {}),
      expiresAt: this.#now() + IMAGE_RESULT_CACHE_TTL_MS,
      weight,
    }));
    this.#originOcrEvidenceWeight += weight;
    this.#boundOriginOcrEvidence();
  }

  #readOriginOcrEvidence(
    pixels: AcquiredImagePixels,
    sourceLanguage: SupportedLanguage,
    providers: readonly ImageTextProviderId[],
  ): OriginOcrEvidenceReuse | undefined {
    this.#expireOriginOcrEvidence();
    const preceding = new Set<ImageTextProviderId>();
    const enabledProviders = new Set(providers);
    for (const [providerIndex, providerId] of providers.entries()) {
      const key = originOcrEvidenceKey(
        pixels,
        sourceLanguage,
        providerId,
        repairOcrMinimumConfidence(this.#configuration.ocrMinimumConfidence),
      );
      const retained = this.#originOcrEvidence.get(key);
      if (
        retained &&
        providerContextAllowsReuse(retained, preceding, enabledProviders)
      ) {
        this.#originOcrEvidence.delete(key);
        this.#originOcrEvidence.set(key, retained);
        this.#originEvidenceHits += 1;
        this.#originEvidenceRevalidations += 1;
        this.#reportOriginEvidenceCache('hit');
        return Object.freeze({
          recognition: retained.recognition,
          fallbackProviderOrder: Object.freeze(
            providers.slice(providerIndex + 1),
          ),
        });
      }
      if (retained) break;
      preceding.add(providerId);
    }
    this.#originEvidenceMisses += 1;
    this.#reportOriginEvidenceCache('miss');
    return undefined;
  }

  #readOriginAutoLanguageEvidence(
    pixels: AcquiredImagePixels,
    providers: readonly ImageTextProviderId[],
  ): RetainedAutoLanguageEvidence | undefined {
    this.#expireOriginOcrEvidence();
    const pixelIdentity = originOcrPixelIdentity(pixels);
    const recognitionQualityPolicyIdentity = originOcrQualityPolicyIdentity(
      repairOcrMinimumConfidence(this.#configuration.ocrMinimumConfidence),
    );
    const autoLanguageConfigurationIdentity = originOcrQualityPolicyIdentity(
      repairOcrMinimumConfidence(
        this.#configuration.ocrMinimumConfidence,
      ),
    );
    const preceding = new Set<ImageTextProviderId>();
    const enabledProviders = new Set(providers);
    for (const providerId of providers) {
      const match = [...this.#originOcrEvidence.entries()].reverse().find(
        ([, retained]) => retained.providerId === providerId &&
          retained.pixelIdentity === pixelIdentity &&
          retained.autoLanguageResolution?.autoLanguageConfigurationIdentity ===
            autoLanguageConfigurationIdentity,
      );
      if (!match) {
        preceding.add(providerId);
        continue;
      }
      const [key, retained] = match;
      const resolution = retained.autoLanguageResolution!;
      if (!providerContextAllowsReuse(
        resolution,
        preceding,
        enabledProviders,
      )) break;
      this.#originOcrEvidence.delete(key);
      this.#originOcrEvidence.set(key, retained);
      this.#originEvidenceHits += 1;
      this.#originEvidenceRevalidations += 1;
      this.#reportOriginEvidenceCache('hit');
      return Object.freeze({
        resolution: Object.freeze({
          status: 'resolved' as const,
          language: resolution.language,
          evidence: resolution.evidence,
          attempts: resolution.attempts,
          images: resolution.images,
        }),
        ...(retained.qualityPolicyIdentity === recognitionQualityPolicyIdentity
          ? { recognition: retained.recognition }
          : {}),
      });
    }
    this.#originEvidenceMisses += 1;
    this.#reportOriginEvidenceCache('miss');
    return undefined;
  }

  #restoreOriginAutoLanguageEvidence(
    retained: RetainedAutoLanguageEvidence,
    descriptor: SourceImageDescriptor,
  ): SupportedLanguage | undefined {
    if (
      this.#configuration.sourceLanguage !== 'auto' ||
      this.#configuration.detectedSourceLanguage ||
      (this.#probeDetectedSourceLanguage &&
        !this.#autoLanguageRevalidationPending) ||
      this.#probeInconclusiveReported ||
      this.#configuration.pageLanguageResolutionPending
    ) return undefined;
    let probe = this.#autoLanguageProbe;
    if (!probe) {
      probe = new AutoImageLanguageProbe(
        this.#now(),
        autoLanguageProbeMinimumConfidence(
          this.#configuration.ocrMinimumConfidence,
        ),
      );
      this.#autoLanguageProbe = probe;
    }
    const sampleIdentity = this.#probeSampleIdentity(descriptor);
    const restored = retained.resolution.evidence === 'single-strong-script'
      ? probe.restoreSingleStrongVote(
          sampleIdentity,
          retained.resolution.language,
          this.#now(),
        )
      : probe.restoreDistinctImageVote(
          sampleIdentity,
          retained.resolution.language,
          this.#now(),
        );
    if (restored.status === 'resolved') {
      return this.#acceptAutoLanguageResolution(
        restored,
        descriptor.document,
        'ocr',
      );
    }
    // Weak cached evidence has reopened a live quorum. Start the ordinary
    // bounded deadline only when a second current image is still required.
    this.#ensureAutoLanguageProbe();
    return undefined;
  }

  #markOriginOcrAutoLanguageResolution(
    candidate: PendingOcrImageEvidence,
    observed: Extract<AutoLanguageProbeObservationResult, {
      readonly status: 'resolved';
    }>,
  ): void {
    if (
      observed.language !== candidate.sourceLanguage ||
      candidate.pendingAutoLanguageObservation?.observation.pixelHash !==
        candidate.pixels.pixelHash
    ) return;
    this.#rememberOriginOcrEvidence(candidate, observed);
  }

  #deleteOriginOcrEvidence(key: string): boolean {
    const retained = this.#originOcrEvidence.get(key);
    if (!retained) return false;
    this.#originOcrEvidence.delete(key);
    this.#originOcrEvidenceWeight -= retained.weight;
    return true;
  }

  #expireOriginOcrEvidence(): void {
    const now = this.#now();
    for (const [key, retained] of this.#originOcrEvidence) {
      if (retained.expiresAt > now) continue;
      if (this.#deleteOriginOcrEvidence(key)) {
        this.#originEvidenceExpirations += 1;
      }
    }
  }

  #boundOriginOcrEvidence(): void {
    while (
      this.#originOcrEvidence.size > MAX_RETAINED_IMAGE_EVIDENCE ||
      this.#originOcrEvidenceWeight > MAX_ORIGIN_OCR_EVIDENCE_WEIGHT
    ) {
      const oldest = this.#originOcrEvidence.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) return;
      this.#deleteOriginOcrEvidence(oldest);
    }
  }

  #purgeOriginOcrEvidence(): void {
    this.#originOcrEvidence.clear();
    this.#originOcrEvidenceWeight = 0;
    this.#originEvidenceHits = 0;
    this.#originEvidenceMisses = 0;
    this.#originEvidenceExpirations = 0;
    this.#originEvidenceRevalidations = 0;
    this.#originEvidencePurges += 1;
    this.#reportOriginEvidenceCache('purge');
  }

  #reportOriginEvidenceCache(
    access: 'hit' | 'miss' | 'purge',
  ): void {
    if (this.#disposed) return;
    this.environment.onDiagnostic?.(Object.freeze({
      stage: 'image-evidence-cache' as const,
      access,
      entries: this.#originOcrEvidence.size,
      weight: this.#originOcrEvidenceWeight,
      hits: this.#originEvidenceHits,
      misses: this.#originEvidenceMisses,
      expirations: this.#originEvidenceExpirations,
      purges: this.#originEvidencePurges,
      revalidations: this.#originEvidenceRevalidations,
    }));
  }

  #rememberOriginFinalAnalysis(
    input: Readonly<{
      pixels: RetainedPixelFacts | AcquiredImagePixels;
      sourceLanguage: SupportedLanguage;
      methodId: ImageReadingMethodId;
      finalConfigurationKey: string;
    }>,
    regions: readonly TranslatedImageRegion[],
  ): void {
    if (regions.length === 0) return;
    const key = originFinalAnalysisKey(
      input.pixels,
      input.sourceLanguage,
      input.finalConfigurationKey,
    );
    const weight = finalAnalysisWeight(key, regions);
    if (weight > MAX_ORIGIN_OCR_EVIDENCE_WEIGHT) return;
    this.#deleteOriginFinalAnalysis(key);
    this.#originFinalAnalyses.set(key, Object.freeze({
      methodId: input.methodId,
      evidenceKind: input.methodId === ACCESSIBILITY_TEXT_METHOD_ID
        ? 'semantic'
        : 'ocr',
      regions: freezeTranslatedRegions(regions),
      expiresAt: this.#now() + IMAGE_RESULT_CACHE_TTL_MS,
      weight,
    }));
    this.#originFinalAnalysisWeight += weight;
    this.#boundOriginFinalAnalyses();
  }

  #readOriginFinalAnalysis(
    pixels: AcquiredImagePixels,
    sourceLanguage: SupportedLanguage,
    finalConfigurationKey: string,
  ): OriginFinalImageAnalysis | undefined {
    this.#expireOriginFinalAnalyses();
    const key = originFinalAnalysisKey(
      pixels,
      sourceLanguage,
      finalConfigurationKey,
    );
    const retained = this.#originFinalAnalyses.get(key);
    if (!retained) {
      this.#originFinalMisses += 1;
      this.#reportOriginFinalCache('miss');
      return undefined;
    }
    this.#originFinalAnalyses.delete(key);
    this.#originFinalAnalyses.set(key, retained);
    this.#originFinalHits += 1;
    this.#reportOriginFinalCache('hit');
    return retained;
  }

  #deleteOriginFinalAnalysis(key: string): boolean {
    const retained = this.#originFinalAnalyses.get(key);
    if (!retained) return false;
    this.#originFinalAnalyses.delete(key);
    this.#originFinalAnalysisWeight -= retained.weight;
    return true;
  }

  #expireOriginFinalAnalyses(): void {
    const now = this.#now();
    for (const [key, retained] of this.#originFinalAnalyses) {
      if (retained.expiresAt > now) continue;
      if (this.#deleteOriginFinalAnalysis(key)) {
        this.#originFinalExpirations += 1;
      }
    }
  }

  #boundOriginFinalAnalyses(): void {
    while (
      this.#originFinalAnalyses.size > MAX_RETAINED_IMAGE_EVIDENCE ||
      this.#originFinalAnalysisWeight > MAX_ORIGIN_OCR_EVIDENCE_WEIGHT
    ) {
      const oldest = this.#originFinalAnalyses.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) return;
      this.#deleteOriginFinalAnalysis(oldest);
    }
  }

  #purgeOriginFinalAnalyses(): void {
    this.#originFinalAnalyses.clear();
    this.#originFinalAnalysisWeight = 0;
    this.#originFinalHits = 0;
    this.#originFinalMisses = 0;
    this.#originFinalExpirations = 0;
    this.#originFinalRebinds = 0;
    this.#originFinalPurges += 1;
    this.#reportOriginFinalCache('purge');
  }

  #reportOriginFinalCache(
    access: 'hit' | 'miss' | 'purge' | 'rebind',
  ): void {
    if (this.#disposed) return;
    this.environment.onDiagnostic?.(Object.freeze({
      stage: 'image-final-cache' as const,
      access,
      entries: this.#originFinalAnalyses.size,
      weight: this.#originFinalAnalysisWeight,
      hits: this.#originFinalHits,
      misses: this.#originFinalMisses,
      expirations: this.#originFinalExpirations,
      purges: this.#originFinalPurges,
      rebinds: this.#originFinalRebinds,
    }));
  }

  #rememberEvidence(
    descriptor: SourceImageDescriptor,
    evidence: Pick<
      RetainedImageEvidence,
      | 'semanticAttempted'
      | 'semantic'
      | 'ocr'
      | 'ocrRouteOutcomes'
      | 'captureRevision'
    >,
  ): void {
    const ocr = new Map(evidence.ocr);
    const ocrRouteOutcomes = Object.freeze(evidence.ocrRouteOutcomes.map(
      (outcome) => Object.freeze({
        providerOrder: Object.freeze([...outcome.providerOrder]),
        sourceLanguage: outcome.sourceLanguage,
        status: outcome.status,
      }),
    ));
    const evidenceConfigurationKey = this.#evidenceConfigurationKey();
    const weight = retainedImageEvidenceWeight(
      evidence.semantic,
      ocr,
      ocrRouteOutcomes,
    ) + evidenceConfigurationKey.length * 2;
    // Keep the previous bounded record intact when an individual replacement
    // is too large to admit. This avoids losing useful evidence merely because
    // a provider returned an unexpectedly large transcript.
    if (weight > MAX_RETAINED_IMAGE_EVIDENCE_WEIGHT) return;
    this.#deleteRetainedEvidence(descriptor.nodeId);
    this.#retainedEvidence.set(descriptor.nodeId, Object.freeze({
      document: descriptor.document,
      evidenceConfigurationKey,
      contentRevision: descriptor.contentRevision,
      observationRevision: descriptor.observationRevision,
      captureRevision: evidence.captureRevision,
      expiresAt: this.#now() + IMAGE_RESULT_CACHE_TTL_MS,
      semanticAttempted: evidence.semanticAttempted,
      ...(evidence.semantic ? { semantic: evidence.semantic } : {}),
      ocr,
      ocrRouteOutcomes,
      weight,
    }));
    this.#retainedEvidenceWeight += weight;
    while (
      this.#retainedEvidence.size > MAX_RETAINED_IMAGE_EVIDENCE ||
      this.#retainedEvidenceWeight > MAX_RETAINED_IMAGE_EVIDENCE_WEIGHT
    ) {
      const oldest = this.#retainedEvidence.keys().next().value as
        | number
        | undefined;
      if (oldest === undefined) break;
      this.#deleteRetainedEvidence(oldest);
      this.#rerankRequestedNodeIds.delete(oldest);
      this.#semanticRefreshRetainedOcrNodeIds.delete(oldest);
    }
  }

  #deleteRetainedEvidence(nodeId: number): boolean {
    const retained = this.#retainedEvidence.get(nodeId);
    if (!retained) return false;
    this.#retainedEvidence.delete(nodeId);
    this.#retainedEvidenceWeight -= retained.weight;
    return true;
  }

  #clearRetainedEvidence(): void {
    this.#retainedEvidence.clear();
    this.#retainedEvidenceWeight = 0;
  }

  #finalAnalysisConfigurationKey(
    steps: readonly ImageReadingExecutionStep[],
    semantic?: PendingSemanticImageEvidence,
  ): string {
    return [
      ORIGIN_FINAL_ANALYSIS_SCHEMA_VERSION,
      this.#pairKey ?? '',
      this.#evidenceConfigurationKey(),
      flattenedReadingMethods(steps).join(','),
      semantic?.identity ?? '',
      semantic?.rankable.repeated ? 'repeated' : 'unique',
    ].join('\u0001');
  }

  #rememberFinalAnalysis(
    descriptor: SourceImageDescriptor,
    projection: ImageOverlayProjection,
    finalConfigurationKey: string,
  ): void {
    const weight = finalAnalysisWeight(finalConfigurationKey, projection.regions);
    if (weight > MAX_RETAINED_IMAGE_EVIDENCE_WEIGHT) return;
    this.#deleteRetainedFinalAnalysis(descriptor.nodeId);
    this.#retainedFinalAnalyses.set(descriptor.nodeId, Object.freeze({
      document: descriptor.document,
      contentRevision: descriptor.contentRevision,
      captureRevision: descriptorCaptureRevision(descriptor),
      finalConfigurationKey,
      projection: Object.freeze({ ...projection }),
      expiresAt: this.#now() + IMAGE_RESULT_CACHE_TTL_MS,
      weight,
    }));
    this.#retainedFinalAnalysisWeight += weight;
    while (
      this.#retainedFinalAnalyses.size > MAX_RETAINED_IMAGE_EVIDENCE ||
      this.#retainedFinalAnalysisWeight > MAX_RETAINED_IMAGE_EVIDENCE_WEIGHT
    ) {
      const oldest = this.#retainedFinalAnalyses.keys().next().value as
        | number
        | undefined;
      if (oldest === undefined) break;
      this.#deleteRetainedFinalAnalysis(oldest);
    }
  }

  #deleteRetainedFinalAnalysis(nodeId: number): boolean {
    const retained = this.#retainedFinalAnalyses.get(nodeId);
    if (!retained) return false;
    this.#retainedFinalAnalyses.delete(nodeId);
    this.#retainedFinalAnalysisWeight -= retained.weight;
    return true;
  }

  #clearRetainedFinalAnalyses(): void {
    this.#retainedFinalAnalyses.clear();
    this.#retainedFinalAnalysisWeight = 0;
  }

  #commitRetainedFinalAnalysis(
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    processingVersion: number,
    jobOrdinal: number,
    replayLease: number,
    pairEpoch: number,
    pairKey: string,
    finalConfigurationKey: string,
    signal: AbortSignal,
  ): boolean {
    const retained = this.#retainedFinalAnalyses.get(job.descriptor.nodeId);
    if (!retained) return false;
    if (
      retained.expiresAt <= this.#now() ||
      !sameSourceDocument(retained.document, job.descriptor.document) ||
      retained.contentRevision !== job.descriptor.contentRevision ||
      retained.captureRevision !== descriptorCaptureRevision(job.descriptor) ||
      retained.finalConfigurationKey !== finalConfigurationKey
    ) {
      if (retained.expiresAt <= this.#now() ||
        retained.contentRevision !== job.descriptor.contentRevision) {
        this.#deleteRetainedFinalAnalysis(job.descriptor.nodeId);
      }
      return false;
    }
    signal.throwIfAborted();
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Final image analysis became stale.', 'AbortError');
    }
    const projection: ImageOverlayProjection = Object.freeze({
      ...retained.projection,
      jobOrdinal,
      document: job.descriptor.document,
      nodeId: job.descriptor.nodeId,
      contentRevision: job.descriptor.contentRevision,
      observationRevision: job.descriptor.observationRevision,
      replayLease,
      pairEpoch,
      pairKey,
    });
    this.#projectedHashes.set(job.descriptor.nodeId, projection.pixelHash);
    this.#projectedOrdinals.set(job.descriptor.nodeId, jobOrdinal);
    this.#retainedProjections.set(job.descriptor.nodeId, projection);
    if (!this.#projector.project(projection)) {
      this.#projectedHashes.delete(job.descriptor.nodeId);
      this.#projectedOrdinals.delete(job.descriptor.nodeId);
      this.#retainedProjections.delete(job.descriptor.nodeId);
      scheduler.defer(job);
      this.environment.onDiagnostic?.('projection-deferred');
      return true;
    }
    this.#rememberFinalAnalysis(
      job.descriptor,
      projection,
      finalConfigurationKey,
    );
    scheduler.settle(job);
    this.#originFinalRebinds += 1;
    this.#reportOriginFinalCache('rebind');
    this.environment.onDiagnostic?.('projected');
    return true;
  }

  #commitOriginFinalAnalysis(
    retained: OriginFinalImageAnalysis,
    pixels: AcquiredImagePixels,
    _sourceLanguage: SupportedLanguage,
    finalConfigurationKey: string,
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    processingVersion: number,
    jobOrdinal: number,
    replayLease: number,
    pairEpoch: number,
    pairKey: string,
    signal: AbortSignal,
  ): boolean {
    signal.throwIfAborted();
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Cached final image analysis became stale.', 'AbortError');
    }
    const projection: ImageOverlayProjection = Object.freeze({
      jobOrdinal,
      document: job.descriptor.document,
      nodeId: job.descriptor.nodeId,
      contentRevision: job.descriptor.contentRevision,
      observationRevision: job.descriptor.observationRevision,
      replayLease,
      pairEpoch,
      pairKey,
      ...retainedPixelFacts(pixels),
      methodId: retained.methodId,
      evidenceKind: retained.evidenceKind,
      regions: retained.regions,
    });
    this.#projectedHashes.set(job.descriptor.nodeId, projection.pixelHash);
    this.#projectedOrdinals.set(job.descriptor.nodeId, jobOrdinal);
    this.#retainedProjections.set(job.descriptor.nodeId, projection);
    if (!this.#projector.project(projection)) {
      this.#projectedHashes.delete(job.descriptor.nodeId);
      this.#projectedOrdinals.delete(job.descriptor.nodeId);
      this.#retainedProjections.delete(job.descriptor.nodeId);
      scheduler.defer(job);
      this.environment.onDiagnostic?.('projection-deferred');
      return true;
    }
    this.#rememberFinalAnalysis(
      job.descriptor,
      projection,
      finalConfigurationKey,
    );
    scheduler.settle(job);
    this.environment.onDiagnostic?.('projected');
    return true;
  }

  #retainedEvidenceRecord(
    descriptor: SourceImageDescriptor,
  ): RetainedImageEvidence | undefined {
    const retained = this.#retainedEvidence.get(descriptor.nodeId);
    if (!retained) return undefined;
    if (
      retained.expiresAt <= this.#now() ||
      !sameSourceDocument(retained.document, descriptor.document) ||
      retained.evidenceConfigurationKey !== this.#evidenceConfigurationKey() ||
      retained.contentRevision !== descriptor.contentRevision
    ) {
      this.#deleteRetainedEvidence(descriptor.nodeId);
      return undefined;
    }
    if (retained.observationRevision !== descriptor.observationRevision) {
      return undefined;
    }
    // LRU touch: ownership and aggregate weight are unchanged.
    this.#retainedEvidence.delete(descriptor.nodeId);
    this.#retainedEvidence.set(descriptor.nodeId, retained);
    return retained;
  }

  #rebaseRetainedObservation(descriptor: SourceImageDescriptor): boolean {
    const retained = this.#retainedEvidence.get(descriptor.nodeId);
    if (
      retained &&
      retained.expiresAt > this.#now() &&
      sameSourceDocument(retained.document, descriptor.document) &&
      retained.evidenceConfigurationKey === this.#evidenceConfigurationKey() &&
      retained.contentRevision === descriptor.contentRevision
    ) {
      const semantic = retained.semantic
        ? semanticCandidateForDescriptor(retained.semantic, descriptor)
        : undefined;
      this.#rememberEvidence(descriptor, {
        captureRevision: retained.captureRevision,
        semanticAttempted: retained.semanticAttempted,
        ...(semantic ? { semantic } : {}),
        ocr: retained.ocr,
        ocrRouteOutcomes: retained.ocrRouteOutcomes,
      });
    }
    const previousProjection = this.#retainedProjections.get(descriptor.nodeId);
    if (!previousProjection) {
      // No visible result is valid only when this descriptor has no mounted
      // projection. If bounded evidence metadata was evicted independently,
      // reopen the image instead of letting a stale projector entry strand.
      return !this.#projectedHashes.has(descriptor.nodeId);
    }
    if (
      !sameSourceDocument(previousProjection.document, descriptor.document) ||
      previousProjection.contentRevision !== descriptor.contentRevision ||
      previousProjection.pairEpoch !== this.#pairEpoch ||
      previousProjection.pairKey !== this.#pairKey
    ) return false;
    const projection: ImageOverlayProjection = Object.freeze({
      ...previousProjection,
      observationRevision: descriptor.observationRevision,
    });
    this.#retainedProjections.set(descriptor.nodeId, projection);
    const retainedFinal = this.#retainedFinalAnalyses.get(descriptor.nodeId);
    if (
      retainedFinal &&
      retainedFinal.expiresAt > this.#now() &&
      sameSourceDocument(retainedFinal.document, descriptor.document) &&
      retainedFinal.contentRevision === descriptor.contentRevision &&
      retainedFinal.captureRevision === descriptorCaptureRevision(descriptor)
    ) {
      this.#retainedFinalAnalyses.set(descriptor.nodeId, Object.freeze({
        ...retainedFinal,
        projection,
      }));
    }
    if (this.#projector.project(projection)) {
      this.#originFinalRebinds += 1;
      this.#reportOriginFinalCache('rebind');
      return true;
    }
    this.#projectedHashes.delete(descriptor.nodeId);
    this.#projectedOrdinals.delete(descriptor.nodeId);
    this.#retainedProjections.delete(descriptor.nodeId);
    this.#deleteRetainedFinalAnalysis(descriptor.nodeId);
    return false;
  }

  #rebaseRetainedCaptureEvidence(descriptor: SourceImageDescriptor): boolean {
    const retained = this.#retainedEvidence.get(descriptor.nodeId);
    if (
      !retained ||
      retained.expiresAt <= this.#now() ||
      !sameSourceDocument(retained.document, descriptor.document) ||
      retained.evidenceConfigurationKey !== this.#evidenceConfigurationKey() ||
      retained.captureRevision !== descriptorCaptureRevision(descriptor)
    ) {
      this.#deleteRetainedEvidence(descriptor.nodeId);
      return false;
    }
    // ALT/ARIA/lang changed, so semantic evidence must be read again. OCR and
    // negative route outcomes remain valid because their pixel revision did not.
    this.#rememberEvidence(descriptor, {
      captureRevision: retained.captureRevision,
      semanticAttempted: false,
      ocr: retained.ocr,
      ocrRouteOutcomes: retained.ocrRouteOutcomes,
    });
    return true;
  }

  #evidenceConfigurationKey(): string {
    return sourceEvidenceConfigurationKey(
      this.#configuration,
      this.#effectiveDetectedSourceLanguage(),
    );
  }

  #queueRetainedRerank(requeueMissing = false): void {
    const scheduler = this.#scheduler;
    if (!scheduler) return;
    const activeNodeId = this.#activeJob()?.descriptor.nodeId;
    for (const descriptor of this.#descriptors.values()) {
      const retained = this.#retainedEvidenceRecord(descriptor);
      if (retained) {
        this.#rerankRequestedNodeIds.add(descriptor.nodeId);
      }
      // Settled descriptors without retained evidence stay settled unless the
      // caller explicitly requests a fresh read (for example after a priority
      // change discovers that bounded evidence expired). The active job is
      // always requeued because configure() already advanced processingVersion
      // and its aborted run must not strand the descriptor permanently.
      if (retained || requeueMissing || descriptor.nodeId === activeNodeId) {
        scheduler.requeueCurrent(descriptor);
      }
    }
    for (const cancellation of scheduler.drainCancellations()) {
      if (
        cancellation.job.descriptor.nodeId ===
        this.#activeJob()?.descriptor.nodeId
      ) this.#activeAbortController?.abort();
    }
    this.#kick();
  }

  #requeueRetainedEvidence(
    descriptor: SourceImageDescriptor,
    scheduler: ImageScanScheduler,
  ): boolean {
    const retained = this.#retainedEvidenceRecord(descriptor);
    if (!retained) return false;
    if (retained.semantic) {
      const registration = this.#semanticEvidenceIndex.register(
        descriptor.nodeId,
        descriptor.contentRevision,
        retained.semantic.evidence.text,
      );
      const semantic = Object.freeze({
        ...retained.semantic,
        rankable: Object.freeze({
          ...retained.semantic.rankable,
          repeated: registration.repeated,
        }),
      });
      this.#rememberEvidence(descriptor, {
        captureRevision: retained.captureRevision,
        semanticAttempted: retained.semanticAttempted,
        semantic,
        ocr: retained.ocr,
        ocrRouteOutcomes: retained.ocrRouteOutcomes,
      });
      // A peer entering or leaving a repeated group changes whether its cheap
      // first paint is admissible. Revisit the preview and immediately remove
      // a provisional semantic overlay that is now known to be boilerplate.
      if (
        this.#hasCurrentSemanticProjection(descriptor) &&
        !progressiveSemanticEvidence(semantic.rankable)
      ) this.#clearProjection(descriptor);
    }
    this.#rerankRequestedNodeIds.add(descriptor.nodeId);
    return scheduler.requeueCurrent(descriptor);
  }

  async #commitRetainedWinner(
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    processingVersion: number,
    jobOrdinal: number,
    replayLease: number,
    pairEpoch: number,
    pairKey: string,
    steps: readonly ImageReadingExecutionStep[],
    ocrEligible: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    const retained = this.#retainedEvidenceRecord(job.descriptor);
    if (!retained) return false;
    const methods = flattenedReadingMethods(steps);
    const semanticIndex = methods.indexOf(ACCESSIBILITY_TEXT_METHOD_ID);
    const expectedSourceLanguage = this.#configuration.sourceLanguage === 'auto'
      ? this.#effectiveDetectedSourceLanguage()
      : this.#configuration.sourceLanguage;
    const hasOcr = ocrEligible && steps.some((step) => step.kind === 'ocr');
    const selectedOcr = hasOcr &&
        retained.captureRevision === descriptorCaptureRevision(job.descriptor)
      ? retainedOcrEvidenceForRoute(
          retained.ocr,
          retained.ocrRouteOutcomes,
          steps,
          expectedSourceLanguage,
        )
      : Object.freeze({
          status: hasOcr ? 'missing' as const : 'empty' as const,
        });
    const ocrIndex = selectedOcr.status === 'candidate'
      ? selectedOcr.methodIndex
      : -1;
    const retainedSemantic = semanticIndex >= 0
      ? retained.semantic
      : undefined;
    const semantic = retainedSemantic && (
        !expectedSourceLanguage ||
        retainedSemantic.sourceLanguage === expectedSourceLanguage
      )
      ? retainedSemantic
      : undefined;
    const ocr = selectedOcr.status === 'candidate'
      ? selectedOcr.candidate
      : undefined;
    // The normal pipeline computes only the missing evidence while the old
    // projection remains visible. A complete retained comparison never
    // reacquires source pixels.
    if (
      (semanticIndex >= 0 && !retained.semanticAttempted) ||
      (Boolean(retainedSemantic) && !semantic) ||
      (hasOcr && selectedOcr.status === 'missing')
    ) {
      return false;
    }
    if (semantic && ocr) {
      const decision = selectImageTextEvidence({
        ...semantic.rankable,
        methodIndex: semanticIndex,
      }, {
        kind: 'ocr',
        result: ocr.recognition.result,
        selectedQuality: selectedRecognitionQuality(ocr.recognition),
        methodIndex: ocrIndex,
        minimumConfidence: repairOcrMinimumConfidence(
          this.#configuration.ocrMinimumConfidence,
        ),
      });
      this.#reportEvidenceSelection(decision.selected, decision.reason);
      if (decision.selected === 'semantic') {
        return this.#commitAccessibilityCandidate(
          {
            ...semantic,
            rankable: Object.freeze({
              ...semantic.rankable,
              methodIndex: semanticIndex,
            }),
          },
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
      return this.#commitRetainedOcrCandidate(
        ocr,
        job,
        scheduler,
        processingVersion,
        jobOrdinal,
        replayLease,
        pairEpoch,
        pairKey,
        this.#finalAnalysisConfigurationKey(steps, semantic),
        signal,
      );
    }
    if (semantic) {
      this.#reportEvidenceSelection('semantic', 'semantic-fallback');
      return this.#commitAccessibilityCandidate(
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
    }
    if (ocr) {
      this.#reportEvidenceSelection('ocr', 'ocr-fallback');
      return this.#commitRetainedOcrCandidate(
        ocr,
        job,
        scheduler,
        processingVersion,
        jobOrdinal,
        replayLease,
        pairEpoch,
        pairKey,
        this.#finalAnalysisConfigurationKey(steps),
        signal,
      );
    }
    this.#clearProjection(job.descriptor);
    scheduler.settle(job);
    this.environment.onDiagnostic?.('no-text-found');
    return true;
  }

  async #commitRetainedOcrCandidate(
    candidate: RetainedOcrImageEvidence,
    job: ImageScanJob,
    scheduler: ImageScanScheduler,
    processingVersion: number,
    jobOrdinal: number,
    replayLease: number,
    pairEpoch: number,
    pairKey: string,
    finalConfigurationKey: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (candidate.sourceLanguage === this.#configuration.targetLanguage) {
      this.#clearProjection(job.descriptor);
      scheduler.settle(job);
      this.environment.onDiagnostic?.('same-language');
      return true;
    }
    let regions: readonly TranslatedImageRegion[];
    try {
      regions = await this.#translateRegions(
        candidate.recognition.result.regions,
        {
          sourceLanguage: candidate.sourceLanguage,
          targetLanguage: this.#configuration.targetLanguage,
        },
        signal,
        () => this.environment.onDiagnostic?.('translation-started'),
      );
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      this.environment.onDiagnostic?.('translation-failed');
      return false;
    }
    if (!this.#isJobCurrent(job, processingVersion, pairEpoch, pairKey)) {
      throw new DOMException('Retained image evidence became stale.', 'AbortError');
    }
    if (regions.length === 0) return false;
    const pixels = candidate.pixels;
    const projection: ImageOverlayProjection = {
      jobOrdinal,
      document: job.descriptor.document,
      nodeId: job.descriptor.nodeId,
      contentRevision: job.descriptor.contentRevision,
      observationRevision: job.descriptor.observationRevision,
      replayLease,
      pairEpoch,
      pairKey,
      ...pixels,
      methodId: candidate.recognition.result.providerId,
      evidenceKind: 'ocr',
      regions,
    };
    this.#projectedHashes.set(job.descriptor.nodeId, pixels.pixelHash);
    this.#projectedOrdinals.set(job.descriptor.nodeId, jobOrdinal);
    this.#retainedProjections.set(job.descriptor.nodeId, projection);
    if (!this.#projector.project(projection)) {
      this.#projectedHashes.delete(job.descriptor.nodeId);
      this.#projectedOrdinals.delete(job.descriptor.nodeId);
      this.#retainedProjections.delete(job.descriptor.nodeId);
      scheduler.defer(job);
      this.environment.onDiagnostic?.('projection-deferred');
      return true;
    }
    this.#rememberFinalAnalysis(
      job.descriptor,
      projection,
      finalConfigurationKey,
    );
    this.#rememberOriginFinalAnalysis({
      pixels: candidate.pixels,
      sourceLanguage: candidate.sourceLanguage,
      methodId: candidate.recognition.result.providerId,
      finalConfigurationKey,
    }, regions);
    scheduler.settle(job);
    this.environment.onDiagnostic?.('projected');
    return true;
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
    this.#retainedProjections.delete(descriptor.nodeId);
    this.#projector.remove(descriptor.document, descriptor.nodeId);
  }

  #rebindRetainedProjections(): void {
    if (this.#replayLease < 1 || !this.#pairKey) return;
    for (const [nodeId, retained] of this.#retainedProjections) {
      const descriptor = this.#descriptors.get(nodeId);
      if (
        !descriptor ||
        retained.pairEpoch !== this.#pairEpoch ||
        retained.pairKey !== this.#pairKey ||
        retained.contentRevision !== descriptor.contentRevision ||
        retained.observationRevision !== descriptor.observationRevision ||
        !sameSourceDocument(retained.document, descriptor.document)
      ) {
        this.#retainedProjections.delete(nodeId);
        continue;
      }
      const rebound: ImageOverlayProjection = Object.freeze({
        ...retained,
        document: descriptor.document,
        replayLease: this.#replayLease,
      });
      this.#retainedProjections.set(nodeId, rebound);
      this.#projectedHashes.set(nodeId, rebound.pixelHash);
      this.#projectedOrdinals.set(nodeId, rebound.jobOrdinal);
      this.#projector.project(rebound);
    }
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
      (this.#probeDetectedSourceLanguage &&
        !this.#autoLanguageRevalidationPending) ||
      this.#probeInconclusiveReported ||
      this.#configuration.pageLanguageResolutionPending
    ) return undefined;
    let probe = this.#autoLanguageProbe;
    if (!probe) {
      const minimumConfidence = autoLanguageProbeMinimumConfidence(
        this.#configuration.ocrMinimumConfidence,
      );
      probe = new AutoImageLanguageProbe(this.#now(), minimumConfidence);
      this.#autoLanguageProbe = probe;
    }
    if (
      !this.#probeLifetimeAbortController ||
      this.#probeLifetimeAbortController.signal.aborted
    ) {
      this.#probeLifetimeAbortController = new AbortController();
    }
    if (this.#probeDeadlineTimer === undefined) {
      const probeAtDeadline = probe;
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
  ): boolean {
    const probe = this.#ensureAutoLanguageProbe();
    if (!probe) return false;
    const observed = probe.observeSemantic({
      sampleIdentity: this.#probeSampleIdentity(descriptor),
      text,
      detectedLanguage,
      now: this.#now(),
    });
    if (observed.status !== 'resolved') return false;
    const pairEpoch = this.#pairEpoch;
    this.#acceptAutoLanguageResolution(
      observed,
      descriptor.document,
      'accessibility-text',
    );
    return this.#pairEpoch !== pairEpoch;
  }

  #acceptAutoLanguageResolution(
    observed: Extract<AutoLanguageProbeObservationResult, {
      readonly status: 'resolved';
    }>,
    document: ReplicaSourceDocumentIdentity,
    origin: AutoImageLanguageEvidenceOrigin,
  ): SupportedLanguage {
    const wasRevalidation = this.#autoLanguageRevalidationPending;
    const previousLanguage = this.#probeDetectedSourceLanguage ??
      this.#revokedProbeDetectedSourceLanguage;
    const sameLanguageRevalidation =
      wasRevalidation &&
      previousLanguage === observed.language;
    this.#probeDetectedSourceLanguage = observed.language;
    this.#revokedProbeDetectedSourceLanguage = undefined;
    this.#autoLanguageRevalidationPending = false;
    this.#probeInconclusiveReported = false;
    // Auto resolution changes the projection pair, not the exact-document
    // evidence epoch. Configured pair/reset transitions still clear the index.
    if (!sameLanguageRevalidation) this.#beginPair(true);
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
        !sameLanguageRevalidation &&
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
    const minimumConfidence = autoLanguageProbeMinimumConfidence(
      this.#configuration.ocrMinimumConfidence,
    );
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
        completedProviders: new Set(),
      };
      this.#probeOcrProgress.set(sampleIdentity, progress);
    }
    const remainingProviderOrder = providerOrder.filter((providerId) =>
      !progress.completedProviders.has(providerId)
    );
    if (remainingProviderOrder.length === 0) return undefined;
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
            providerOrder: remainingProviderOrder,
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
            // A host or worker outage says nothing about this candidate
            // language; roll the attempt back and defer the image instead of
            // treating the language as tried and empty.
            if (isTransientRecognitionCode(recognition.code)) {
              throw new TransientRecognitionError();
            }
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
              const sourceLanguage = this.#acceptAutoLanguageResolution(
                observed,
                descriptor.document,
                'ocr',
              );
              const resolvedCandidate = Object.freeze({
                recognition,
                pixels,
                sourceLanguage,
                methodIndex: 0,
                providerOrder,
              });
              if (minimumConfidence === configuredConfidence) {
                this.#rememberOcrCandidate(descriptor, resolvedCandidate);
              }
              this.#rememberOriginOcrEvidence(
                resolvedCandidate,
                observed,
                minimumConfidence,
              );
              return Object.freeze({
                sourceLanguage,
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
      for (const providerId of remainingProviderOrder) {
        progress.completedProviders.add(providerId);
      }
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
      const cacheKey = await sha256Hex(`language-v1\u0000${sample}`);
      signal.throwIfAborted();
      const cached = this.#languageDetections.get(cacheKey);
      if (cached && cached.expiresAt > this.#now()) {
        this.#languageDetections.delete(cacheKey);
        this.#languageDetections.set(cacheKey, cached);
        return cached.language;
      }
      if (cached) this.#languageDetections.delete(cacheKey);
      const detected = await raceAbortPromise(detectLanguage(sample), signal);
      const candidate = detected.isReliable
        ? [...detected.languages]
          .sort((left, right) => right.percentage - left.percentage)
          .find((entry) => entry.percentage >= 70 &&
            canonicalizeLanguageTag(entry.language))
        : undefined;
      const language = candidate
        ? canonicalizeLanguageTag(candidate.language)
        : undefined;
      this.#languageDetections.set(cacheKey, Object.freeze({
        ...(language ? { language } : {}),
        expiresAt: this.#now() + IMAGE_RESULT_CACHE_TTL_MS,
      }));
      while (this.#languageDetections.size > MAX_RETAINED_IMAGE_EVIDENCE) {
        const oldest = this.#languageDetections.keys().next().value as
          | string
          | undefined;
        if (!oldest) break;
        this.#languageDetections.delete(oldest);
      }
      return language;
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
    if (this.#autoLanguageRevalidationPending) return undefined;
    return this.#configuration.detectedSourceLanguage ??
      this.#probeDetectedSourceLanguage;
  }

  #pageLanguageResolutionBlocksWork(): boolean {
    return imagePageLanguageResolutionBlocksWork(
      this.#configuration,
      this.#probeDetectedSourceLanguage,
    );
  }

  #resetAutoLanguageProbe(): void {
    this.#clearAutoLanguageProbeDeadline();
    this.#probeLifetimeAbortController?.abort(
      new DOMException('Auto language probe reset.', 'AbortError'),
    );
    this.#probeLifetimeAbortController = undefined;
    this.#autoLanguageProbe = undefined;
    this.#probeDetectedSourceLanguage = undefined;
    this.#revokedProbeDetectedSourceLanguage = undefined;
    this.#autoLanguageRevalidationPending = false;
    this.#probeSchedulerRebuildRequested = false;
    this.#probeInconclusiveReported = false;
    this.#probeStartedReported = false;
    this.#probeSampleIdentities.clear();
    this.#probeOcrProgress.clear();
  }

  #suspendAutoLanguageProbeMode(): void {
    this.#clearAutoLanguageProbeDeadline();
    this.#probeLifetimeAbortController?.abort(
      new DOMException('Auto language probe mode changed.', 'AbortError'),
    );
    this.#probeLifetimeAbortController = undefined;
    this.#autoLanguageRevalidationPending = false;
    this.#probeSchedulerRebuildRequested = false;
    this.#probeInconclusiveReported = false;
    this.#probeStartedReported = false;
  }

  #reopenAutoLanguageAfterSampleInvalidation(): void {
    const probe = this.#autoLanguageProbe;
    if (!probe) return;
    const replacementResolution = probe.resolution;
    const revokedLanguage = this.#probeDetectedSourceLanguage;
    if (!revokedLanguage || !this.#document) return;
    if (this.#configuration.sourceLanguage !== 'auto') {
      // Explicit source language is authoritative. Retire the stale dormant
      // Auto promotion without cancelling unrelated explicit-pair work.
      this.#probeDetectedSourceLanguage = undefined;
      this.#revokedProbeDetectedSourceLanguage = undefined;
      try {
        this.environment.onAutoLanguageInvalidated?.(this.#document);
      } catch {
        // A UI observer cannot prevent the controller's revocation boundary.
      }
      return;
    }
    // Keep the last committed projection visible, but revoke its source
    // language synchronously so no new work can use an invalid contributor.
    // The current processor is retried under the revalidation gate.
    this.#autoLanguageRevalidationPending = true;
    this.#revokedProbeDetectedSourceLanguage = revokedLanguage;
    this.#probeDetectedSourceLanguage = undefined;
    this.#probeInconclusiveReported = false;
    this.#probeSchedulerRebuildRequested = false;
    const activeJob = this.#activeJob();
    if (activeJob) this.#scheduler?.retry(activeJob);
    this.#processingVersion += 1;
    this.#activeAbortController?.abort(
      new DOMException('Auto language evidence changed.', 'AbortError'),
    );
    this.environment.onDiagnostic?.('auto-language-probe-reopened');
    try {
      this.environment.onAutoLanguageInvalidated?.(this.#document);
    } catch {
      // A UI observer cannot prevent the controller's revocation boundary.
    }
    if (replacementResolution) {
      this.#acceptAutoLanguageResolution(
        replacementResolution,
        this.#document,
        'ocr',
      );
    }
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
    const resolvedAfter = probe?.resolvedLanguage;
    this.#probeOcrProgress.delete(identity);
    this.#probeSampleIdentities.delete(nodeId);
    return Boolean(resolvedBefore && resolvedBefore !== resolvedAfter);
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
      expirations: stats.expirations ?? 0,
      purges: stats.purges ?? 0,
      ...(stats.providerEntries !== undefined
        ? { providerEntries: stats.providerEntries }
        : {}),
      ...(stats.providerWeight !== undefined
        ? { providerWeight: stats.providerWeight }
        : {}),
      ...(stats.providerHits !== undefined
        ? { providerHits: stats.providerHits }
        : {}),
      ...(stats.providerMisses !== undefined
        ? { providerMisses: stats.providerMisses }
        : {}),
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

  #rebuildScheduler(reuseRetainedEvidence = false): void {
    if (!this.#document || !this.#source) return;
    this.#scheduler?.clear();
    this.#scheduler = this.#createScheduler(this.#document);
    for (const descriptor of this.#descriptors.values()) {
      this.#scheduler.apply({ kind: 'upsert', descriptor });
      if (reuseRetainedEvidence && this.#retainedEvidenceRecord(descriptor)) {
        this.#rerankRequestedNodeIds.add(descriptor.nodeId);
      }
    }
    this.#kick();
  }

  #refreshGates(): void {
    const scheduler = this.#scheduler;
    if (!scheduler) return;
    scheduler.setGates(this.#gates());
    this.#abortCancelledActiveJob(scheduler);
  }

  #abortCancelledActiveJob(scheduler: ImageScanScheduler): void {
    const activeNodeId = this.#activeJob()?.descriptor.nodeId;
    for (const cancellation of scheduler.drainCancellations()) {
      if (cancellation.job.descriptor.nodeId === activeNodeId) {
        this.#activeAbortController?.abort();
      }
    }
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
    // One continuously rotating image must not perpetually postpone unrelated
    // background work. A live quiet window is a bounded settle barrier, not a
    // debounce that every later mutation can restart.
    if (!quiet && schedule && this.#quietTimer !== undefined) {
      this.#mutationQuiet = false;
      this.#refreshGates();
      return;
    }
    if (this.#quietTimer !== undefined) this.#clearTimer(this.#quietTimer);
    this.#quietTimer = undefined;
    this.#mutationQuiet = quiet;
    this.#refreshGates();
    if (
      !quiet &&
      schedule &&
      imageTranslationSourceObservationEnabled(this.#configuration)
    ) {
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
    this.#retainedProjections.clear();
    this.#clearRetainedFinalAnalyses();
    this.#rerankRequestedNodeIds.clear();
    this.#semanticRefreshRetainedOcrNodeIds.clear();
    this.#captureRetries.clear();
    this.#emptyRetries.clear();
    if (!preserveSemanticEvidence) this.#semanticEvidenceIndex.clear();
    this.#projector.beginPair(this.#pairEpoch, this.#pairKey);
  }

  #isEnabled(): boolean {
    return !this.#disposed &&
      imageTranslationConfigurationEnabled(
        this.#configuration,
        this.#probeDetectedSourceLanguage,
      );
  }

  #reportConfigurationState(): void {
    if (this.#disposed) return;
    if (!this.#isEnabled()) {
      const reason = !hasEnabledImageReadingMethod(this.#configuration)
        ? 'provider-unavailable'
        : effectiveImageLanguagesMatch(
            this.#configuration,
            this.#probeDetectedSourceLanguage,
          )
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

const TRANSIENT_RECOGNITION_CODES: ReadonlySet<OcrHostErrorCode> = new Set<
  OcrHostErrorCode
>([
  'host-unavailable',
  'host-overflow',
  'input-missing',
  'worker-lost',
]);

/** Host and worker outages: the image is deferred rather than settled. */
function isTransientRecognitionCode(code: OcrHostErrorCode): boolean {
  return TRANSIENT_RECOGNITION_CODES.has(code);
}

class TransientRecognitionError extends Error {
  override readonly name = 'TransientRecognitionError';
}

function normalizeResetEpoch(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : Number.MAX_SAFE_INTEGER;
}

function imageTranslationConfigurationEnabled(
  configuration: ImageTranslationConfiguration,
  fallbackDetectedSourceLanguage?: SupportedLanguage,
): boolean {
  return configuration.enabled &&
    hasEnabledImageReadingMethod(configuration) &&
    !effectiveImageLanguagesMatch(
      configuration,
      fallbackDetectedSourceLanguage,
    );
}

function imageTranslationSameLanguagePause(
  configuration: ImageTranslationConfiguration,
  fallbackDetectedSourceLanguage?: SupportedLanguage,
): boolean {
  return configuration.enabled &&
    hasEnabledImageReadingMethod(configuration) &&
    effectiveImageLanguagesMatch(
      configuration,
      fallbackDetectedSourceLanguage,
    );
}

function imageTranslationSourceObservationEnabled(
  configuration: ImageTranslationConfiguration,
): boolean {
  return configuration.enabled && hasEnabledImageReadingMethod(configuration);
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

function removedEnabledImageReadingMethod(
  previous: ImageTranslationConfiguration,
  next: ImageTranslationConfiguration,
): boolean {
  const nextMethods = new Set(flattenedReadingMethods(imageReadingExecutionPlan(
    next.methodOrder ?? next.providerOrder,
    next.disabledMethodIds ?? [],
    next.providerOrder,
  )));
  return flattenedReadingMethods(imageReadingExecutionPlan(
    previous.methodOrder ?? previous.providerOrder,
    previous.disabledMethodIds ?? [],
    previous.providerOrder,
  )).some((method) => !nextMethods.has(method));
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

function effectiveImageLanguagesMatch(
  configuration: ImageTranslationConfiguration,
  fallbackDetectedSourceLanguage?: SupportedLanguage,
): boolean {
  const sourceLanguage = effectiveImageSourceLanguage(
    configuration,
    fallbackDetectedSourceLanguage,
  );
  return sourceLanguage !== 'auto' &&
    sourceLanguage === configuration.targetLanguage;
}

function effectiveImageSourceLanguage(
  configuration: ImageTranslationConfiguration,
  fallbackDetectedSourceLanguage?: SupportedLanguage,
): SupportedLanguage | 'auto' {
  return configuration.sourceLanguage === 'auto'
    ? configuration.detectedSourceLanguage ??
      fallbackDetectedSourceLanguage ??
      'auto'
    : configuration.sourceLanguage;
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
  fallbackDetectedSourceLanguage?: SupportedLanguage,
): string {
  return [
    imageTranslationConfigurationEnabled(
      configuration,
      fallbackDetectedSourceLanguage,
    ) ? '1' : '0',
    effectiveImageSourceLanguage(
      configuration,
      fallbackDetectedSourceLanguage,
    ),
    configuration.targetLanguage,
    configuration.policyFingerprint ?? '',
    configuration.controlImages ? '1' : '0',
    ocrQualityPolicyKey(repairOcrMinimumConfidence(
      configuration.ocrMinimumConfidence,
    )),
    IMAGE_EVIDENCE_RANKING_POLICY_VERSION,
  ].join(':');
}

function sourceEvidenceConfigurationKey(
  configuration: ImageTranslationConfiguration,
  fallbackDetectedSourceLanguage?: SupportedLanguage,
): string {
  return [
    configuration.enabled ? '1' : '0',
    effectiveImageSourceLanguage(
      configuration,
      fallbackDetectedSourceLanguage,
    ),
    imagePageLanguageResolutionBlocksWork(
      configuration,
      fallbackDetectedSourceLanguage,
    ) ? '1' : '0',
    configuration.policyFingerprint ?? '',
    configuration.controlImages ? '1' : '0',
    ocrQualityPolicyKey(repairOcrMinimumConfidence(
      configuration.ocrMinimumConfidence,
    )),
    IMAGE_EVIDENCE_RANKING_POLICY_VERSION,
    normalizeResetEpoch(configuration.resetEpoch),
  ].join(':');
}

function imagePageLanguageResolutionBlocksWork(
  configuration: ImageTranslationConfiguration,
  fallbackDetectedSourceLanguage?: SupportedLanguage,
): boolean {
  return configuration.sourceLanguage === 'auto' &&
    effectiveImageSourceLanguage(
      configuration,
      fallbackDetectedSourceLanguage,
    ) === 'auto' &&
    Boolean(configuration.pageLanguageResolutionPending);
}

function imageSourcePolicyConfigurationKey(
  configuration: ImageTranslationConfiguration,
): string {
  return [
    configuration.policyFingerprint ?? '',
    configuration.controlImages ? '1' : '0',
    accessibilityMethodEnabled(configuration) ? '1' : '0',
  ].join(':');
}

function rankingOrderConfigurationKey(
  configuration: ImageTranslationConfiguration,
): string {
  return flattenedReadingMethods(imageReadingExecutionPlan(
    configuration.methodOrder ?? configuration.providerOrder,
    configuration.disabledMethodIds ?? [],
    configuration.providerOrder,
  )).join(',');
}

function flattenedReadingMethods(
  steps: readonly ImageReadingExecutionStep[],
): readonly ImageReadingMethodId[] {
  return Object.freeze(steps.flatMap((step) =>
    step.kind === 'accessibility-text'
      ? [ACCESSIBILITY_TEXT_METHOD_ID]
      : [...step.providerOrder]
  ));
}

function retainedPixelFacts(pixels: AcquiredImagePixels): RetainedPixelFacts {
  return Object.freeze({
    pixelHash: pixels.pixelHash,
    preprocessingVersion: pixels.preprocessingVersion,
    bitmapWidth: pixels.bitmapWidth,
    bitmapHeight: pixels.bitmapHeight,
    cropOffsetXCss: pixels.cropOffsetXCss,
    cropOffsetYCss: pixels.cropOffsetYCss,
    cropWidthCss: pixels.cropWidthCss,
    cropHeightCss: pixels.cropHeightCss,
    renderedWidthCss: pixels.renderedWidthCss,
    renderedHeightCss: pixels.renderedHeightCss,
  });
}

function retainedOcrProviderContext(
  providerOrder: readonly ImageTextProviderId[],
  providerId: ImageTextProviderId,
  recognition: CompleteImageRecognition,
): Pick<
  RetainedOcrImageEvidence,
  'precedingProviders' | 'requiresPrecedingCorroboration'
> | undefined {
  const providerIndex = providerOrder.indexOf(providerId);
  if (providerIndex < 0) return undefined;
  return Object.freeze({
    precedingProviders: new Set(providerOrder.slice(0, providerIndex)),
    requiresPrecedingCorroboration:
      selectedRecognitionQuality(recognition).corroboratedRegions > 0,
  });
}

function providerContextAllowsReuse(
  retained: Readonly<{
    precedingProviders: ReadonlySet<ImageTextProviderId>;
    requiresPrecedingCorroboration: boolean;
  }>,
  currentPreceding: ReadonlySet<ImageTextProviderId>,
  currentProviders: ReadonlySet<ImageTextProviderId>,
): boolean {
  // A newly preceding provider must run because the retained selection never
  // established that it was unavailable or empty in this position.
  if ([...currentPreceding].some((providerId) =>
    !retained.precedingProviders.has(providerId)
  )) return false;
  // A filtered result that accepted corroborated regions remains valid while
  // every provider that supplied its original context is still enabled. Its
  // relative position can change without changing the retained pixel evidence.
  return !retained.requiresPrecedingCorroboration ||
    [...retained.precedingProviders].every((providerId) =>
      currentProviders.has(providerId)
    );
}

function retainedOcrEvidenceForRoute(
  retained: ReadonlyMap<ImageTextProviderId, RetainedOcrImageEvidence>,
  routeOutcomes: readonly RetainedOcrRouteOutcome[],
  steps: readonly ImageReadingExecutionStep[],
  expectedSourceLanguage: SupportedLanguage | undefined,
):
  | Readonly<{
      status: 'candidate';
      candidate: RetainedOcrImageEvidence;
      methodIndex: number;
    }>
  | Readonly<{ status: 'empty' | 'missing' }> {
  let methodIndex = 0;
  for (const step of steps) {
    if (step.kind === 'accessibility-text') {
      methodIndex += 1;
      continue;
    }
    const preceding = new Set<ImageTextProviderId>();
    const enabledProviders = new Set(step.providerOrder);
    for (const providerId of step.providerOrder) {
      const candidate = retained.get(providerId);
      if (candidate) {
        if (
          expectedSourceLanguage &&
          candidate.sourceLanguage !== expectedSourceLanguage
        ) return Object.freeze({ status: 'missing' as const });
        if (!providerContextAllowsReuse(
          candidate,
          preceding,
          enabledProviders,
        )) {
          return Object.freeze({ status: 'missing' as const });
        }
        return Object.freeze({
          status: 'candidate' as const,
          candidate,
          methodIndex,
        });
      }
      preceding.add(providerId);
      methodIndex += 1;
    }
    if (!expectedSourceLanguage || !routeOutcomes.some((outcome) =>
      outcome.status === 'empty' &&
      outcome.sourceLanguage === expectedSourceLanguage &&
      providerRoutePrefixMatches(step.providerOrder, outcome.providerOrder)
    )) return Object.freeze({ status: 'missing' as const });
  }
  return Object.freeze({ status: 'empty' as const });
}

function committedAutoLanguageResolution(
  observed: Extract<AutoLanguageProbeObservationResult, {
    readonly status: 'resolved';
  }>,
  context: Pick<
    RetainedOcrImageEvidence,
    'precedingProviders' | 'requiresPrecedingCorroboration'
  >,
  autoLanguageConfigurationIdentity: string,
): CommittedAutoLanguageResolution {
  return Object.freeze({
    language: observed.language,
    evidence: observed.evidence,
    attempts: observed.attempts,
    images: observed.images,
    autoLanguageConfigurationIdentity,
    precedingProviders: new Set(context.precedingProviders),
    requiresPrecedingCorroboration:
      context.requiresPrecedingCorroboration,
  });
}

function retainedImageEvidenceWeight(
  semantic: PendingSemanticImageEvidence | undefined,
  ocr: ReadonlyMap<ImageTextProviderId, RetainedOcrImageEvidence>,
  routeOutcomes: readonly RetainedOcrRouteOutcome[],
): number {
  let weight = 128;
  if (semantic) weight += 256 + semantic.evidence.text.length * 2;
  for (const [providerId, candidate] of ocr) {
    weight += 384 + providerId.length * 2 +
      candidate.sourceLanguage.length * 2 +
      originOcrEvidenceWeight(
        '',
        candidate.recognition.result,
        candidate.precedingProviders,
      );
  }
  for (const outcome of routeOutcomes) {
    weight += 96 + outcome.status.length * 2 +
      outcome.sourceLanguage.length * 2 +
      outcome.providerOrder.reduce(
        (total, providerId) => total + providerId.length * 2 + 24,
        0,
      );
  }
  return weight;
}

function providerRoutePrefixMatches(
  current: readonly ImageTextProviderId[],
  retained: readonly ImageTextProviderId[],
): boolean {
  return current.length <= retained.length && current.every(
    (providerId, index) => retained[index] === providerId,
  );
}

function progressiveSemanticEvidence(
  evidence: RankableSemanticImageEvidence,
): boolean {
  return !assessSemanticImageEvidence(evidence).provisional;
}

function semanticCandidateAtMethodIndex(
  candidate: PendingSemanticImageEvidence,
  methodIndex: number,
): PendingSemanticImageEvidence {
  if (candidate.rankable.methodIndex === methodIndex) return candidate;
  return Object.freeze({
    ...candidate,
    rankable: Object.freeze({
      ...candidate.rankable,
      methodIndex,
    }),
  });
}

function semanticCandidateForDescriptor(
  candidate: PendingSemanticImageEvidence,
  descriptor: SourceImageDescriptor,
): PendingSemanticImageEvidence {
  return Object.freeze({
    ...candidate,
    evidence: Object.freeze({
      ...candidate.evidence,
      document: descriptor.document,
      nodeId: descriptor.nodeId,
      contentRevision: descriptor.contentRevision,
      observationRevision: descriptor.observationRevision,
    }),
  });
}

function descriptorCaptureRevision(
  descriptor: SourceImageDescriptor,
): number {
  // Protocol-v1 fixtures and older in-memory callers have no separate capture
  // revision. Content revision is the conservative stable fallback.
  return descriptor.captureRevision ?? descriptor.contentRevision;
}

function reusableCompleteRecognition(
  recognition: CompleteImageRecognition,
): CompleteImageRecognition {
  const {
    continuation: _continuation,
    cacheAccess: _cacheAccess,
    cacheStats: _cacheStats,
    ...reusable
  } = recognition;
  return Object.freeze({ ...reusable, cacheHit: true });
}

function originOcrEvidenceKey(
  pixels: AcquiredImagePixels,
  sourceLanguage: SupportedLanguage,
  providerId: ImageTextProviderId,
  minimumConfidence: OcrMinimumConfidence,
): string {
  return JSON.stringify([
    ORIGIN_OCR_EVIDENCE_SCHEMA_VERSION,
    providerId,
    sourceLanguage,
    tesseractLanguageGroupFor(sourceLanguage) ?? '',
    providerId.includes('tesseract') ? TESSERACT_MODEL_VERSION : '',
    originOcrQualityPolicyIdentity(minimumConfidence),
    pixels.preprocessingVersion,
    pixels.bitmapWidth,
    pixels.bitmapHeight,
    pixels.pixelHash,
  ]);
}

function originOcrQualityPolicyIdentity(
  minimumConfidence: OcrMinimumConfidence,
): string {
  return JSON.stringify([
    ORIGIN_OCR_EVIDENCE_SCHEMA_VERSION,
    ORIGIN_OCR_QUALITY_IDENTITY_VERSION,
    ocrQualityPolicyKey(minimumConfidence),
    IMAGE_EVIDENCE_RANKING_POLICY_VERSION,
  ]);
}

type PixelIdentityFacts = Pick<
  AcquiredImagePixels,
  'preprocessingVersion' | 'bitmapWidth' | 'bitmapHeight' | 'pixelHash'
>;

function originOcrPixelIdentity(pixels: PixelIdentityFacts): string {
  return JSON.stringify([
    'origin-image-pixels-v1',
    pixels.preprocessingVersion,
    pixels.bitmapWidth,
    pixels.bitmapHeight,
    pixels.pixelHash,
  ]);
}

function originFinalAnalysisKey(
  pixels: PixelIdentityFacts,
  sourceLanguage: SupportedLanguage,
  finalConfigurationKey: string,
): string {
  return JSON.stringify([
    ORIGIN_FINAL_ANALYSIS_SCHEMA_VERSION,
    originOcrPixelIdentity(pixels),
    sourceLanguage,
    finalConfigurationKey,
  ]);
}

function freezeTranslatedRegions(
  regions: readonly TranslatedImageRegion[],
): readonly TranslatedImageRegion[] {
  return Object.freeze(regions.map((region) => Object.freeze({
    ...region,
    boundingBox: Object.freeze({ ...region.boundingBox }),
  })));
}

function finalAnalysisWeight(
  key: string,
  regions: readonly TranslatedImageRegion[],
): number {
  return 256 + key.length * 2 + regions.reduce(
    (weight, region) => weight + region.text.length * 2 + 96,
    0,
  );
}

function originOcrEvidenceWeight(
  key: string,
  result: ImageTextResult,
  precedingProviders: ReadonlySet<ImageTextProviderId> = new Set(),
  autoLanguageResolution?: CommittedAutoLanguageResolution,
  qualityPolicyIdentity = '',
): number {
  return 256 + key.length * 2 + result.transcript.length * 2 +
    result.regions.reduce(
      (weight, region) => weight + region.text.length * 2 + 64,
      0,
    ) + [...precedingProviders].reduce(
      (weight, providerId) => weight + providerId.length * 2 + 24,
      0,
    ) + (autoLanguageResolution
      ? 128 + autoLanguageResolution.language.length * 2 +
        autoLanguageResolution.evidence.length * 2 +
        autoLanguageResolution.autoLanguageConfigurationIdentity.length * 2 +
        [...autoLanguageResolution.precedingProviders].reduce(
          (weight, providerId) => weight + providerId.length * 2 + 24,
          0,
        )
      : 0) + qualityPolicyIdentity.length * 2;
}

function autoLanguageProbeMinimumConfidence(
  configured: OcrMinimumConfidence | undefined,
): OcrMinimumConfidence {
  const repaired = repairOcrMinimumConfidence(configured);
  return repaired < AUTO_LANGUAGE_PROBE_MINIMUM_CONFIDENCE
    ? AUTO_LANGUAGE_PROBE_MINIMUM_CONFIDENCE
    : repaired;
}

function topPageSourceScopeIdentity(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `origin:${url.origin}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
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
    configuration.sourceLanguage,
    autoLanguageProbeRuntimeConfigurationKey(configuration),
  ].join(':');
}

function autoLanguageProbeRuntimeConfigurationKey(
  configuration: ImageTranslationConfiguration,
): string {
  const enabledMethods = flattenedReadingMethods(imageReadingExecutionPlan(
    configuration.methodOrder ?? configuration.providerOrder,
    configuration.disabledMethodIds ?? [],
    configuration.providerOrder,
  ));
  const enabledProviders = enabledMethods.filter(
    (method): method is ImageTextProviderId =>
      method !== ACCESSIBILITY_TEXT_METHOD_ID,
  );
  return [
    configuration.enabled ? '1' : '0',
    autoImageLanguageConfigurationKey({
      providerOrder: enabledProviders,
      enabledMethodOrder: enabledMethods,
      minimumConfidence: repairOcrMinimumConfidence(
        configuration.ocrMinimumConfidence,
      ),
      policyFingerprint: configuration.policyFingerprint ?? '',
      controlImages: configuration.controlImages === true,
    }),
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
