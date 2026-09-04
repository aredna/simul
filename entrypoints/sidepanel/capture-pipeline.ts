import type { GenerationWork, LatestWorkCoordinator } from '../../lib/companion-lifecycle';
import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import { sameCompanionSourcePage } from '../../lib/companion-surface';
import {
  invokeLivePageObserverBridge,
  invokeLivePageObserverUnregisterBridge,
  readLivePageObserverInstallation,
} from '../../lib/live-page-mirror';
import type { ImageTranslationController } from '../../lib/ocr/image-translation-controller';
import {
  PageAccessError,
  assertSnapshotIsCurrent,
  normalizedPageUrl,
  readPageError,
  withPageTimeout,
  type CapturedPageIdentity,
  type PageTabLike,
} from '../../lib/page-identity';
import {
  capturePageSnapshot,
  parsePageSnapshot,
  type PageSnapshot,
} from '../../lib/page-snapshot';
import type {
  ReplicaCaptureRequest,
  ReplicaDiagnosticCode,
} from '../../lib/replica/contracts';
import type { ReplicaEngineController } from '../../lib/replica/engine-selection';
import {
  isCommittedShadowReplica,
  shouldPreserveCommittedReplicaForCapture,
  shouldReleaseReplicaAfterCaptureFailure,
  type LegacyTransitionGate,
  type LiveReplicaFailureRecoveryGate,
} from '../../lib/replica/legacy-transition-gate';
import type { ReplicaSurfaceRouter } from '../../lib/replica/replica-surface-router';
import {
  captureRequestMatchesSourceDocument,
  sameSourceReplicaLease,
} from '../../lib/replica/source-identity';
import type { VisibleReplayHost } from '../../lib/replica/visible-replay-host';
import { replicaSourceCommitAction } from '../../lib/translation/replica-translation-lifecycle';
import type {
  ReplicaSourceCommit,
  ReplicaTranslationCoordinator,
} from '../../lib/translation/replica-translation-coordinator';
import type {
  CaptureRequest,
  CompanionState,
  PendingImageReplicaActivation,
} from './companion-state';
import type { Currency } from './currency';
import type { LiveUpdateDriver } from './live-update-driver';
import type { MirrorView } from './mirror-view';
import type { PageScripting } from './page-scripting';
import type { TranslationDriver } from './translation-driver';

export interface CapturePipelineEnvironment {
  readonly state: CompanionState;
  readonly currency: Currency;
  readonly captureCoordinator: LatestWorkCoordinator<CaptureRequest>;
  readonly liveSessionId: string;
  readonly scripting: PageScripting;
  readonly captureTimeoutMs: number;
  readonly getTab: (tabId: number) => Promise<PageTabLike>;
  readonly mirrorView: Pick<
    MirrorView,
    'renderSnapshot' | 'renderLoading' | 'renderError' | 'disconnect' | 'updateLayout'
  >;
  readonly replayHost: Pick<VisibleReplayHost, 'hasCommittedReplica' | 'resetSourceScroll'>;
  readonly engineController: Pick<
    ReplicaEngineController,
    'selectedAvailable' | 'run' | 'releasePresentation' | 'disableSelected'
  >;
  readonly replicaSurface: Pick<ReplicaSurfaceRouter, 'snapshot'>;
  readonly replicaTranslation: Pick<ReplicaTranslationCoordinator, 'selectPair' | 'handleSourceCommit'>;
  readonly imageTranslation: Pick<
    ImageTranslationController,
    'releaseReplica' | 'activateReplica' | 'notifyReplicaCommit'
  >;
  readonly legacyTransitionGate: LegacyTransitionGate;
  readonly failureRecoveryGate: LiveReplicaFailureRecoveryGate;
  readonly translation: Pick<
    TranslationDriver,
    | 'resolveSelectedSourceLanguage'
    | 'currentTranslationFieldCount'
    | 'checkAvailability'
    | 'maybeTranslateAutomatically'
    | 'reconcileReplicaTranslationAfterCommit'
  >;
  readonly liveUpdates: Pick<LiveUpdateDriver, 'initializeSequenceBaseline' | 'processPending'>;
  readonly reconcileAutomaticAccess: (pageUrl: string) => Promise<boolean>;
  readonly invalidateComposer: () => void;
  readonly renderCaptureNotes: (page: PageSnapshot) => void;
  readonly setStatus: (message: string, tone?: CompanionStatusTone) => void;
  readonly updateControls: () => void;
}

/**
 * Builds the mirror for a page: installs the live observer, reads the v1
 * snapshot, runs the isolated replica checkpoint, resolves the language and
 * hands over to translation. One capture runs at a time; the coordinator's
 * generation is the currency every step checks, and a newer request replaces
 * whatever is queued.
 */
export class CapturePipeline {
  constructor(private readonly environment: CapturePipelineEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  queueCapture(request: CaptureRequest): void {
    const state = this.#state;
    const {
      captureCoordinator,
      failureRecoveryGate,
      replayHost,
      replicaTranslation,
      imageTranslation,
      setStatus,
      updateControls,
    } = this.environment;
    const previousIdentity = state.capturedOrFollowedIdentity;
    const samePage = sameCompanionSourcePage(previousIdentity, request.identity, normalizedPageUrl);
    if (!samePage) failureRecoveryGate.reset();
    if (!samePage || request.reason === 'navigation') {
      state.lastSourceScroll = undefined;
      replayHost.resetSourceScroll();
    }
    const retainTranslationIntent =
      samePage &&
      (request.reason === 'manual' ||
        request.reason === 'desynchronized' ||
        request.reason === 'preference');
    if (!retainTranslationIntent) {
      replicaTranslation.selectPair(undefined);
      state.resetTranslationIntent();
      this.environment.invalidateComposer();
    }
    if (previousIdentity && previousIdentity.tabId !== request.identity.tabId) {
      this.releaseLiveSession(previousIdentity);
    }
    state.abortPageWork();
    state.pendingImageReplicaActivation = undefined;
    imageTranslation.releaseReplica();
    this.environment.currency.supersede('availability');
    state.resetLiveSequence();
    state.followedPageIdentity = request.identity;
    if (!state.snapshot) this.environment.mirrorView.renderLoading();
    setStatus(
      request.reason === 'desynchronized'
        ? 'A live update could not be reconciled. Rebuilding once while keeping the current mirror visible…'
        : request.reason === 'navigation'
          ? 'Building the live mirror for the newly loaded page…'
          : 'Building the initial live read-only mirror…',
    );
    const enqueued = captureCoordinator.enqueue(request);
    updateControls();
    if (enqueued.startNow) void this.#runCaptureWork(enqueued.work);
  }

  /** Drops the followed page entirely and shows `message` in its place. */
  invalidateCompanion(message: string): void {
    const state = this.#state;
    this.releaseLiveSession(state.capturedOrFollowedIdentity);
    this.environment.captureCoordinator.invalidate();
    this.environment.currency.supersedePage();
    state.abortPageWork();
    this.environment.imageTranslation.releaseReplica();
    this.environment.engineController.releasePresentation(false);
    this.environment.invalidateComposer();
    this.environment.replicaTranslation.selectPair(undefined);
    state.clearPage();
    this.environment.legacyTransitionGate.reset();
    this.environment.failureRecoveryGate.reset();
    this.environment.replayHost.resetSourceScroll();
    this.environment.mirrorView.disconnect();
    this.environment.mirrorView.renderError(message);
    this.environment.setStatus(message, 'warning');
    this.environment.updateControls();
  }

  /** True while the committed isolated replica is the translation surface. */
  usesReplicaTranslationProjection(): boolean {
    return (
      this.environment.legacyTransitionGate.shadowOwnsPage &&
      this.environment.replayHost.hasCommittedReplica
    );
  }

  /**
   * Hands presentation back to the legacy view so legacy work (a live delta,
   * a legacy translation) can run. Returns true when live dirtiness was
   * coalesced meanwhile and a fresh capture is required.
   */
  releaseReplicaPresentationForLegacyWork(force = false, showFallbackLabel = true): boolean {
    const state = this.#state;
    const { legacyTransitionGate } = this.environment;
    if (!force && this.usesReplicaTranslationProjection()) return false;
    if (!legacyTransitionGate.shadowOwnsPage) return false;
    const needsFreshCapture = legacyTransitionGate.release();
    state.pendingLiveUpdate = undefined;
    state.replicaShadowAbortController?.abort();
    this.environment.imageTranslation.releaseReplica();
    this.environment.engineController.releasePresentation(showFallbackLabel);
    return needsFreshCapture;
  }

  /** Unregisters this companion's live observer session from the page. */
  releaseLiveSession(
    identity: CapturedPageIdentity | undefined = this.#state.capturedOrFollowedIdentity,
  ): void {
    if (!identity) return;
    void this.environment.scripting.runFunction(
      identity.tabId,
      invokeLivePageObserverUnregisterBridge,
      [this.environment.liveSessionId],
    ).catch(() => undefined);
  }

  /** The isolated engine committed a checkpoint, batch or recovery. */
  handleReplicaSourceCommit(commit: ReplicaSourceCommit): void {
    const state = this.#state;
    const { replicaSurface, imageTranslation, replicaTranslation } = this.environment;
    const pending = state.pendingImageReplicaActivation;
    const selectedSnapshot = replicaSurface.snapshot();
    if (
      pending &&
      !pending.activated &&
      !pending.signal.aborted &&
      pending.request.isCurrent() &&
      captureRequestMatchesSourceDocument(pending.request, commit.document) &&
      selectedSnapshot &&
      captureRequestMatchesSourceDocument(pending.request, selectedSnapshot.document) &&
      sameSourceReplicaLease(selectedSnapshot, commit)
    ) {
      pending.activated = imageTranslation.activateReplica(
        pending.request,
        pending.sourceWindowId,
        commit.replayLease,
      );
    } else if (selectedSnapshot && sameSourceReplicaLease(selectedSnapshot, commit)) {
      imageTranslation.notifyReplicaCommit(commit.document, commit.replayLease);
    }
    if (state.isLiveSourceOnlyMode) return;
    replicaTranslation.handleSourceCommit(commit);
    const action = replicaSourceCommitAction(commit, state.preferences.sourceLanguage === 'auto');
    if (!action.prepareForNewText && !action.refreshDetectedLanguage) return;
    const refresh = this.environment.currency.begin('language-refresh');
    void this.environment.translation.reconcileReplicaTranslationAfterCommit(
      commit,
      refresh,
      action.refreshDetectedLanguage,
      action.prepareForNewText,
    );
  }

  /** The isolated engine's live stream failed after a commit. */
  handleReplicaLiveFailure(code: ReplicaDiagnosticCode): void {
    const state = this.#state;
    const { failureRecoveryGate, replayHost, setStatus } = this.environment;
    const identity = state.followedOrCapturedIdentity;
    const action = identity
      ? failureRecoveryGate.decide(replayHost.hasCommittedReplica)
      : 'fallback';
    // Content-free by construction: bounded enums only, with no page identity,
    // source text, URL, DOM identifier, pixels, or resource metadata.
    console.info('[Simul replica live failure]', {
      engine: 'isolated-html',
      code,
      state: action,
    });
    if (action === 'rebuild-last-good' && identity) {
      setStatus(
        'The live mirror disconnected. Rebuilding once while keeping the last good replica visible…',
        'warning',
      );
      this.queueCapture({ identity, reason: 'desynchronized' });
      return;
    }

    failureRecoveryGate.reset();
    this.environment.imageTranslation.releaseReplica();
    this.environment.replicaTranslation.selectPair(undefined);
    this.environment.legacyTransitionGate.release();
    this.environment.engineController.disableSelected(code);
    if (identity) this.queueCapture({ identity, reason: 'desynchronized' });
  }

  async #runCaptureWork(work: GenerationWork<CaptureRequest>): Promise<void> {
    const state = this.#state;
    state.captureInFlight = true;
    this.environment.updateControls();
    try {
      await this.#capturePage(work);
    } finally {
      const next = this.environment.captureCoordinator.finish(work.generation);
      if (next) {
        void this.#runCaptureWork(next);
        return;
      }
      state.captureInFlight = false;
      this.environment.updateControls();
      void this.environment.liveUpdates.processPending();
    }
  }

  #withCaptureTimeout<T>(operation: Promise<T>): Promise<T> {
    return withPageTimeout(operation, this.environment.captureTimeoutMs);
  }

  async #capturePage(work: GenerationWork<CaptureRequest>): Promise<void> {
    const state = this.#state;
    const {
      captureCoordinator,
      scripting,
      liveSessionId,
      mirrorView,
      replayHost,
      engineController,
      imageTranslation,
      translation,
      setStatus,
    } = this.environment;
    const identity = work.value.identity;
    let currentLegacyReady = false;
    try {
      const observerBundleResults = await this.#withCaptureTimeout(
        scripting.runFile(identity.tabId, '/page-live-observer.js'),
      );
      if (observerBundleResults.length === 0) {
        throw new PageAccessError('The page could not load its live update bridge.');
      }
      const observerResults = await this.#withCaptureTimeout(
        scripting.runFunction(
          identity.tabId,
          invokeLivePageObserverBridge,
          [liveSessionId, work.generation],
        ),
      );
      const observerInstallation = readLivePageObserverInstallation(observerResults[0]?.result);
      if (!observerInstallation || observerInstallation.generation !== work.generation) {
        throw new PageAccessError('The page could not start its live update bridge.');
      }
      state.liveObservationAvailable = observerInstallation.installed;
      console.info(
        `[Simul scroll] observer-${observerInstallation.installed ? 'installed' : 'limited'}; generation=${work.generation}`,
      );
      if (observerInstallation.installed) {
        this.environment.liveUpdates.initializeSequenceBaseline(
          work.generation,
          observerInstallation.sequence,
        );
      }
      const sameCapturedPage = Boolean(
        state.capturedPageIdentity &&
          state.capturedPageIdentity.tabId === identity.tabId &&
          state.capturedPageIdentity.windowId === identity.windowId &&
          normalizedPageUrl(state.capturedPageIdentity.url) === normalizedPageUrl(identity.url),
      );
      const preserveLastGoodReplica = shouldPreserveCommittedReplicaForCapture(
        work.value.reason,
        sameCapturedPage,
        replayHost.hasCommittedReplica,
      );
      // New identities hand authority back to v1 before serialization. A
      // same-page manual/recovery rebuild keeps last-good visible while the
      // selected engine stages its replacement offscreen and swaps atomically.
      if (!preserveLastGoodReplica) {
        // A new page is being built, not a fallback: no "fallback" badge.
        this.releaseReplicaPresentationForLegacyWork(true, false);
      }
      const results = await this.#withCaptureTimeout(
        scripting.runFunction(identity.tabId, capturePageSnapshot, []),
      );
      const snapshotInjection = results[0];
      const nextSnapshot = parsePageSnapshot(snapshotInjection?.result);
      const currentTab = await this.environment.getTab(identity.tabId);
      assertSnapshotIsCurrent(currentTab, identity, state.requiresActiveSourceTab);
      if (!captureCoordinator.isCurrent(work.generation)) return;

      state.translationComplete = false;
      mirrorView.renderSnapshot(nextSnapshot);
      state.snapshot = nextSnapshot;
      state.capturedPageIdentity = identity;
      state.capturedPageDocumentId = typeof snapshotInjection?.documentId === 'string'
        ? snapshotInjection.documentId
        : undefined;
      state.followedPageIdentity = identity;
      currentLegacyReady = true;
      this.environment.renderCaptureNotes(nextSnapshot);
      if (snapshotInjection?.documentId) {
        await this.#runReplicaEngineCheckpoint(work, identity, snapshotInjection.documentId);
        if (!captureCoordinator.isCurrent(work.generation)) return;
      } else {
        imageTranslation.releaseReplica();
        engineController.releasePresentation(true);
      }
      await translation.resolveSelectedSourceLanguage();

      if (state.isLiveSourceOnlyMode) {
        state.availability = 'unavailable';
        state.availabilityCheckedForPair = undefined;
        setStatus(
          'Live source only is active. The sanitized mirror keeps updating without text or image translation.',
          'success',
        );
        return;
      }

      if (translation.currentTranslationFieldCount() === 0) {
        state.availability = 'unavailable';
        state.availabilityCheckedForPair = undefined;
        const accessWasRevoked = await this.environment.reconcileAutomaticAccess(identity.url);
        if (!captureCoordinator.isCurrent(work.generation)) return;
        setStatus(
          accessWasRevoked
            ? 'Chrome removed a saved automatic-access grant. The mirror is waiting for page text.'
            : state.liveObservationAvailable
              ? 'The page mirror is live and will prepare translation when visible text arrives.'
              : 'The page was captured, but live updates are unavailable because too many companion views are open. Close one and refresh.',
          'warning',
        );
        return;
      }
      await translation.checkAvailability(work.generation);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      const accessWasRevoked = await this.environment.reconcileAutomaticAccess(identity.url);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      if (accessWasRevoked) {
        setStatus('Chrome removed a saved automatic-access grant, so that scope was turned off.', 'warning');
        return;
      }
      await translation.maybeTranslateAutomatically(work.generation, identity.url);
      if (!state.liveObservationAvailable && captureCoordinator.isCurrent(work.generation)) {
        setStatus(
          'The page was captured, but live updates are unavailable because too many companion views are open. Close one and refresh.',
          'warning',
        );
      }
    } catch (error) {
      if (!captureCoordinator.isCurrent(work.generation)) return;
      if (shouldReleaseReplicaAfterCaptureFailure(
        currentLegacyReady,
        state.capturedPageIdentity === identity,
        replayHost.hasCommittedReplica,
      )) {
        imageTranslation.releaseReplica();
        engineController.releasePresentation(true);
      }
      const message = readPageError(error);
      if (!state.snapshot) mirrorView.renderError(message);
      setStatus(message, 'error');
    } finally {
      this.environment.updateControls();
    }
  }

  async #runReplicaEngineCheckpoint(
    work: GenerationWork<CaptureRequest>,
    identity: CapturedPageIdentity,
    documentId: string,
  ): Promise<void> {
    const state = this.#state;
    const {
      captureCoordinator,
      engineController,
      replayHost,
      replicaSurface,
      imageTranslation,
      legacyTransitionGate,
      failureRecoveryGate,
    } = this.environment;
    state.replicaShadowAbortController?.abort();
    const abortController = new AbortController();
    state.replicaShadowAbortController = abortController;
    const request: ReplicaCaptureRequest = {
      sessionId: this.environment.liveSessionId,
      pageEpoch: work.generation,
      generation: work.generation,
      tabId: identity.tabId,
      frameId: 0,
      documentId,
      isCurrent: () =>
        captureCoordinator.isCurrent(work.generation) &&
        state.capturedPageIdentity === identity &&
        state.followedPageIdentity?.tabId === identity.tabId &&
        normalizedPageUrl(state.followedPageIdentity.url) === normalizedPageUrl(identity.url),
    };
    let shadowCommitted = false;
    const imageActivation: PendingImageReplicaActivation = {
      request,
      sourceWindowId: identity.windowId,
      signal: abortController.signal,
      activated: false,
    };
    state.pendingImageReplicaActivation = imageActivation;
    const shadowOwnershipStarted = engineController.selectedAvailable;
    if (shadowOwnershipStarted) {
      legacyTransitionGate.beginShadowOwnership();
    }
    try {
      const result = await engineController.run(request, abortController.signal);
      shadowCommitted = isCommittedShadowReplica(result, replayHost.hasCommittedReplica);
      if (shadowCommitted) {
        failureRecoveryGate.markCommitted();
        if (!imageActivation.activated) {
          const selectedSnapshot = replicaSurface.snapshot();
          if (
            state.pendingImageReplicaActivation === imageActivation &&
            !imageActivation.signal.aborted &&
            request.isCurrent() &&
            selectedSnapshot &&
            captureRequestMatchesSourceDocument(request, selectedSnapshot.document)
          ) {
            imageActivation.activated = imageTranslation.activateReplica(
              request,
              identity.windowId,
              selectedSnapshot.replayLease,
            );
          }
        }
        this.environment.mirrorView.updateLayout();
      }
    } finally {
      if (state.pendingImageReplicaActivation === imageActivation) {
        state.pendingImageReplicaActivation = undefined;
      }
      if (shadowOwnershipStarted && !shadowCommitted) {
        const needsFreshCapture = legacyTransitionGate.release();
        if (needsFreshCapture && request.isCurrent()) {
          this.queueCapture({ identity, reason: 'desynchronized' });
        }
      }
      if (
        state.replicaShadowAbortController === abortController &&
        !replayHost.hasCommittedReplica
      ) {
        state.replicaShadowAbortController = undefined;
      }
    }
  }
}
