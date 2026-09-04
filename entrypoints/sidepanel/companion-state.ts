import type { CompanionLaunchStamp } from '../../lib/companion-surface';
import type { CompanionOverlay } from '../../lib/companion-ui-state';
import type { LivePageScrollMessage } from '../../lib/live-page-mirror';
import type { CapturedPageIdentity } from '../../lib/page-identity';
import type { PageSnapshot } from '../../lib/page-snapshot';
import {
  DEFAULT_COMPANION_PREFERENCES,
  parseCompanionPreferences,
  type CompanionPreferences,
} from '../../lib/preferences';
import type { ReplicaCaptureRequest } from '../../lib/replica/contracts';
import type {
  SupportedLanguage,
  TranslationAvailability,
  TranslationPair,
} from '../../lib/translation-provider';

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

export interface PendingLiveUpdate {
  generation: number;
  firstSequence: number;
  sequence: number;
  nodeIds: Set<string>;
}

export interface PendingImageReplicaActivation {
  readonly request: ReplicaCaptureRequest;
  readonly sourceWindowId: number;
  readonly signal: AbortSignal;
  activated: boolean;
}

export type ImageCaptureAccess = 'checking' | 'granted' | 'missing';

export interface CompanionActivity {
  readonly captureInFlight: boolean;
  readonly translationInFlight: boolean;
  readonly permissionInFlight: boolean;
  readonly liveDeltaInFlight: boolean;
  readonly imageTranslationInFlight: boolean;
  readonly surfaceTransitionInFlight: boolean;
}

export interface CompanionStateOptions {
  readonly isDetachedWindow: boolean;
  readonly detachedSourceWindowId?: number;
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

  // Followed page: which tab the companion mirrors and what it last read.
  followedPageIdentity: CapturedPageIdentity | undefined;
  capturedPageIdentity: CapturedPageIdentity | undefined;
  capturedPageDocumentId: string | undefined;
  snapshot: PageSnapshot | undefined;

  // Language and translation intent for the captured page.
  resolvedSourceLanguage: SupportedLanguage | undefined;
  availability: TranslationAvailability = 'unavailable';
  availabilityCheckedForPair: string | undefined;
  translationDesired = false;
  translationComplete = false;

  // Live observation of the captured page.
  latestLiveSequence = 0;
  highestReceivedLiveSequence = 0;
  liveSequenceBaselineReady = false;
  liveObservationAvailable = true;
  pendingLiveUpdate: PendingLiveUpdate | undefined;
  activeLiveUpdate: PendingLiveUpdate | undefined;
  lastSourceScroll: LivePageScrollMessage | undefined;
  acceptedScrollMessageCount = 0;

  // In-flight work and its cancellation handles.
  captureInFlight = false;
  translationInFlight = false;
  permissionInFlight = false;
  liveDeltaInFlight = false;
  imageTranslationInFlight = false;
  surfaceTransitionInFlight = false;
  replicaFidelityCommitInFlight = false;
  activeAbortController: AbortController | undefined;
  liveDeltaAbortController: AbortController | undefined;
  replicaShadowAbortController: AbortController | undefined;
  activeTranslationTask: Promise<void> | undefined;
  activeTranslationKey: string | undefined;
  pendingImageReplicaActivation: PendingImageReplicaActivation | undefined;

  // Device and window facts that outlive any page.
  imageCaptureAccess: ImageCaptureAccess = 'checking';
  panelWindowId: number | undefined;
  detachedSourceWindowId: number | undefined;
  latestToolbarLaunchStamp: CompanionLaunchStamp | undefined;
  openCompanionOverlay: CompanionOverlay | undefined;

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
      liveDeltaInFlight: this.liveDeltaInFlight,
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
    this.liveDeltaAbortController?.abort();
    this.replicaShadowAbortController?.abort();
  }

  /** Forgets that the user wanted this page translated. */
  resetTranslationIntent(): void {
    this.translationDesired = false;
    this.translationComplete = false;
    this.availabilityCheckedForPair = undefined;
  }

  /** Forgets the live sequence baseline; the next capture re-establishes it. */
  resetLiveSequence(): void {
    this.pendingLiveUpdate = undefined;
    this.latestLiveSequence = 0;
    this.highestReceivedLiveSequence = 0;
    this.liveSequenceBaselineReady = false;
  }

  /** Clears everything that described the followed page. */
  clearPage(): void {
    this.followedPageIdentity = undefined;
    this.snapshot = undefined;
    this.capturedPageIdentity = undefined;
    this.capturedPageDocumentId = undefined;
    this.resolvedSourceLanguage = undefined;
    this.availability = 'unavailable';
    this.resetTranslationIntent();
    this.resetLiveSequence();
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
