import type { CompanionLaunchStamp } from '../../lib/companion-surface';
import type { CompanionOverlay } from '../../lib/companion-ui-state';
import type { ImageTextProviderId } from '../../lib/ocr/known-provider-ids';
import type { OcrProviderRuntimeStatus } from '../../lib/ocr/provider-status-protocol';
import type { CapturedPageIdentity } from '../../lib/page-identity';
import {
  DEFAULT_COMPANION_PREFERENCES,
  parseCompanionPreferences,
  type CompanionPreferences,
  type CompanionViewSettingsPatch,
} from '../../lib/preferences';
import type { HtmlMirrorScrollState } from '../../lib/replica/html-mirror-protocol';
import {
  replicaReadScopeForProfile,
  type ReplicaReadScope,
} from '../../lib/replica/read-scope-policy';
import { RemoteReadScopeSafetyGates } from '../../lib/replica/read-scope-safety-gates';
import type { ReplicaSourceDocumentIdentity } from '../../lib/replica/source-identity';
import type { ReplicaTranslationSnapshot } from '../../lib/translation/replica-translation-coordinator';
import type {
  SupportedLanguage,
  TranslationAvailability,
  TranslationPair,
} from '../../lib/translation-provider';
import type { CurrencyToken } from './currency';

export type CaptureReason =
  | 'initial'
  | 'manual'
  | 'navigation'
  | 'authorized'
  | 'preference'
  | 'desynchronized';

export interface CaptureRequest {
  readonly identity: CapturedPageIdentity;
  readonly reason: CaptureReason;
}

export type ImageCaptureAccess = 'checking' | 'granted' | 'missing';

/** Where the resolved source language came from. */
export type SourceLanguageOrigin = 'page' | 'image' | 'explicit';

export interface LocalReadScopeNarrowingGate {
  readonly scope: ReplicaReadScope;
  failed: boolean;
}

export interface PendingZoomPatch {
  readonly requestId: number;
  readonly patch: CompanionViewSettingsPatch;
}

export interface CompanionActivity {
  readonly captureInFlight: boolean;
  readonly translationInFlight: boolean;
  readonly permissionInFlight: boolean;
  readonly imageTranslationInFlight: boolean;
  readonly surfaceTransitionInFlight: boolean;
}

export interface CompanionStateOptions {
  readonly isDetachedWindow: boolean;
  readonly detachedSourceWindowId?: number | undefined;
}

/**
 * The side panel's mutable runtime state in one place. Fields are grouped by
 * the lifetime they share, and the reset helpers below are the only way a
 * group is cleared, so a rebuild or an invalidation cannot forget a field.
 */
export class CompanionState {
  readonly isDetachedWindow: boolean;

  preferences: CompanionPreferences = parseCompanionPreferences(
    DEFAULT_COMPANION_PREFERENCES,
  );

  // Settings safety and the effective read policy.
  readonly localReadScopeNarrowingGates = new Map<number, LocalReadScopeNarrowingGate>();
  readonly remoteReadScopeNarrowingGates = new RemoteReadScopeSafetyGates();
  readScopeCommitSequence = 0;
  setupReadScopeDraft: ReplicaReadScope = replicaReadScopeForProfile('standard');
  preferenceSafetyConnectionReady = false;
  livePreferenceStorageFailClosed = false;
  setupCleanupWasPending = false;
  resetInFlight = false;

  // Followed page: which tab the companion mirrors and what it last read.
  followedPageIdentity: CapturedPageIdentity | undefined;
  capturedPageIdentity: CapturedPageIdentity | undefined;
  snapshot: ReplicaTranslationSnapshot | undefined;
  lastSourceScroll: HtmlMirrorScrollState | undefined;

  // Source-language resolution for the captured page.
  resolvedSourceLanguage: SupportedLanguage | undefined;
  resolvedSourceLanguageOrigin: SourceLanguageOrigin | undefined;
  resolvedImageLanguageConfigurationKey: string | undefined;
  resolvedImageLanguageDocument: ReplicaSourceDocumentIdentity | undefined;
  pageLanguageResolutionPending = false;

  // Translation intent for the captured page.
  availability: TranslationAvailability = 'unavailable';
  availabilityCheckedForPair: string | undefined;
  translationDesired = false;
  translationComplete = false;

  // In-flight work and its cancellation handles.
  captureInFlight = false;
  translationInFlight = false;
  permissionInFlight = false;
  imageTranslationInFlight = false;
  surfaceTransitionInFlight = false;
  replicaFidelityCommitInFlight = false;
  activeAbortController: AbortController | undefined;
  replicaShadowAbortController: AbortController | undefined;
  activeTranslationTask: Promise<void> | undefined;
  activeTranslationKey: string | undefined;
  /** The identity request of an active-tab follow still resolving. */
  activeFollowRequest: CurrencyToken | undefined;
  navigationTimer: ReturnType<typeof setTimeout> | undefined;
  zoomCommitTimer: ReturnType<typeof setTimeout> | undefined;
  pendingZoomPatch: PendingZoomPatch | undefined;

  // Device and window facts that outlive any page.
  imageCaptureAccess: ImageCaptureAccess = 'checking';
  panelWindowId: number | undefined;
  detachedSourceWindowId: number | undefined;
  latestToolbarLaunchStamp: CompanionLaunchStamp | undefined;
  openCompanionOverlay: CompanionOverlay | undefined;
  readonly ocrProviderRuntimeStatuses = new Map<
    ImageTextProviderId,
    OcrProviderRuntimeStatus | 'checking'
  >();
  textDetectorProbeRetryUsed = false;

  constructor(options: CompanionStateOptions) {
    this.isDetachedWindow = options.isDetachedWindow;
    this.detachedSourceWindowId = options.detachedSourceWindowId;
  }

  /** The page to rebuild: the followed tab, else the last captured one. */
  get followedOrCapturedIdentity(): CapturedPageIdentity | undefined {
    return this.followedPageIdentity ?? this.capturedPageIdentity;
  }

  /** The page to release: the captured tab, else the followed one. */
  get capturedOrFollowedIdentity(): CapturedPageIdentity | undefined {
    return this.capturedPageIdentity ?? this.followedPageIdentity;
  }

  get pageUrl(): string | undefined {
    return this.followedPageIdentity?.url ?? this.capturedPageIdentity?.url;
  }

  get isLiveSourceOnlyMode(): boolean {
    return this.preferences.replicaViewMode === 'source-only';
  }

  /** Side panels and active-following windows must read the active tab only. */
  get requiresActiveSourceTab(): boolean {
    return !this.isDetachedWindow || this.preferences.popoutTabMode === 'active';
  }

  get activity(): CompanionActivity {
    return {
      captureInFlight: this.captureInFlight,
      translationInFlight: this.translationInFlight,
      permissionInFlight: this.permissionInFlight,
      imageTranslationInFlight: this.imageTranslationInFlight,
      surfaceTransitionInFlight: this.surfaceTransitionInFlight,
    };
  }

  selectedPair(): TranslationPair | undefined {
    return this.resolvedSourceLanguage
      ? {
          sourceLanguage: this.resolvedSourceLanguage,
          targetLanguage: this.preferences.targetLanguage,
        }
      : undefined;
  }

  isCurrentTranslationPair(pair: TranslationPair): boolean {
    const current = this.selectedPair();
    return Boolean(
      current &&
        current.sourceLanguage === pair.sourceLanguage &&
        current.targetLanguage === pair.targetLanguage,
    );
  }

  currentTranslationTaskKey(generation: number): string {
    const pair = this.selectedPair();
    return pair
      ? availabilityPairKey(pair, generation)
      : `${generation}:unresolved`;
  }

  /** Aborts every cancellable unit of page work; handles clear themselves. */
  abortPageWork(): void {
    this.activeAbortController?.abort();
    this.replicaShadowAbortController?.abort();
  }

  /** Forgets that the user wanted this page translated. */
  resetTranslationIntent(): void {
    this.translationDesired = false;
    this.translationComplete = false;
    this.availabilityCheckedForPair = undefined;
  }

  /** Forgets the resolved source language and any image evidence behind it. */
  clearLanguageResolution(): void {
    this.pageLanguageResolutionPending = false;
    this.resolvedSourceLanguage = undefined;
    this.resolvedSourceLanguageOrigin = undefined;
    this.resolvedImageLanguageConfigurationKey = undefined;
    this.resolvedImageLanguageDocument = undefined;
  }

  /** Clears everything that described the followed page. */
  clearPage(): void {
    this.followedPageIdentity = undefined;
    this.snapshot = undefined;
    this.capturedPageIdentity = undefined;
    this.clearLanguageResolution();
    this.availability = 'unavailable';
    this.resetTranslationIntent();
    this.lastSourceScroll = undefined;
  }
}

export function availabilityPairKey(pair: TranslationPair, generation: number): string {
  return `${generation}:${pair.sourceLanguage}>${pair.targetLanguage}`;
}

export function sameTranslationPair(
  left: TranslationPair | undefined,
  right: TranslationPair | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.sourceLanguage === right.sourceLanguage &&
      left.targetLanguage === right.targetLanguage,
  ) || (!left && !right);
}
