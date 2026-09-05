import {
  shouldResetReplicaScrollForCapture,
  type GenerationWork,
  type LatestWorkCoordinator,
} from '../../lib/companion-lifecycle';
import { sameCompanionSourcePage } from '../../lib/companion-surface';
import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import type { NavigationRefreshGate } from '../../lib/navigation-refresh-gate';
import type { ImageTranslationDiagnostic } from '../../lib/ocr/image-translation-controller';
import {
  activateImageReplicaAfterRun,
  imageReplicaActivationFailureReason,
} from '../../lib/ocr/replica-activation';
import {
  PageAccessError,
  assertSourceTabIsCurrent,
  navigationPageIdentityKey,
  navigationPageScopeKey,
  normalizedPageUrl,
  readPageError,
  withPageTimeout,
  type CapturedPageIdentity,
  type PageTabLike,
} from '../../lib/page-identity';
import type {
  ReplicaCaptureRequest,
  ReplicaDiagnosticCode,
  ReplicaRunResult,
} from '../../lib/replica/contracts';
import {
  isCommittedPrimaryReplica,
  shouldPreserveCommittedReplicaForCapture,
  type IsolatedReplicaFailureRecoveryGate,
} from '../../lib/replica/replica-recovery';
import {
  captureRequestMatchesSourceDocument,
  sameSourceReplicaLease,
  type ReplicaSourceDocumentIdentity,
} from '../../lib/replica/source-identity';
import { replicaSourceCommitAction } from '../../lib/translation/replica-translation-lifecycle';
import type {
  ReplicaSourceCommit,
  ReplicaTranslationSnapshot,
} from '../../lib/translation/replica-translation-coordinator';
import type { TranslationPair } from '../../lib/translation-provider';
import type { CaptureRequest, CompanionState } from './companion-state';
import type { Currency } from './currency';
import type { TranslationDriver } from './translation-driver';

/** The replica engine calls the pipeline makes. */
export interface PipelineEngine {
  run(request: ReplicaCaptureRequest, signal?: AbortSignal): Promise<ReplicaRunResult>;
  releasePresentation(): void;
}

export interface PipelinePresentation {
  readonly hasCommittedReplica: boolean;
  resetSourceScroll(): void;
}

export interface PipelineCoordinator {
  selectPair(pair: TranslationPair | undefined): void;
  handleSourceCommit(commit: ReplicaSourceCommit): void;
}

export interface PipelineImageController {
  setTopPageOrigin(pageUrl: string | undefined): void;
  releaseReplica(): void;
  activateReplica(
    request: ReplicaCaptureRequest,
    sourceWindowId: number,
    replayLease: number,
  ): boolean;
  notifyReplicaCommit(
    document: ReplicaSourceDocumentIdentity,
    replayLease: number,
  ): void;
}

export type PipelineTranslationDriver = Pick<
  TranslationDriver,
  | 'resolveSelectedSourceLanguage'
  | 'currentReplicaLanguageContext'
  | 'currentTranslationFieldCount'
  | 'checkAvailability'
  | 'maybeTranslateAutomatically'
  | 'clearAutoImageLanguageForDifferentDocument'
  | 'clearAutoImageLanguageResolution'
  | 'reconcileAfterCommit'
>;

export interface CapturePipelineEnvironment {
  readonly state: CompanionState;
  readonly currency: Currency;
  readonly captureCoordinator: LatestWorkCoordinator<CaptureRequest>;
  readonly navigationRefreshGate: Pick<NavigationRefreshGate, 'consumeCapture' | 'reset'>;
  readonly recoveryGate: Pick<
    IsolatedReplicaFailureRecoveryGate,
    'decide' | 'markCommitted' | 'reset'
  >;
  readonly engine: PipelineEngine;
  readonly surface: { snapshot(): ReplicaTranslationSnapshot | undefined };
  readonly presentation: PipelinePresentation;
  readonly coordinator: PipelineCoordinator;
  readonly imageController: PipelineImageController;
  readonly translationDriver: PipelineTranslationDriver;
  readonly evidence: { invalidate(): void };
  readonly mirrorSessionId: string;
  readonly captureTimeoutMs: number;
  /** Reads the top frame's current document id, or undefined when absent. */
  readonly readDocumentId: (tabId: number) => Promise<string | undefined>;
  readonly getTab: (tabId: number) => Promise<PageTabLike>;
  readonly reconcileAutomaticAccess: (pageUrl: string) => Promise<boolean>;
  readonly cancelNavigationRefresh: () => void;
  readonly invalidateComposer: () => void;
  readonly setStatus: (message: string, tone?: CompanionStatusTone) => void;
  readonly updateControls: () => void;
  readonly renderLoading: () => void;
  readonly renderError: (message: string) => void;
  readonly hideReplicaStatus: () => void;
  readonly clearCaptureNotes: () => void;
  readonly updateMirrorLayout: () => void;
  readonly logImageDiagnostic: (diagnostic: ImageTranslationDiagnostic) => void;
  readonly onEngineResult?: (result: ReplicaRunResult) => void;
}

/**
 * Builds the isolated replica for the followed page and keeps it current:
 * one capture runs at a time under the capture coordinator, a same-page
 * rebuild keeps the last good replica visible while its replacement stages,
 * live commits feed the translation driver, and a live failure rebuilds
 * once within the recovery budget. Invalidation clears the page as one unit.
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
      navigationRefreshGate,
      recoveryGate,
      presentation,
      coordinator,
      imageController,
    } = this.environment;
    this.environment.cancelNavigationRefresh();
    navigationRefreshGate.consumeCapture(
      navigationPageScopeKey(request.identity),
      navigationPageIdentityKey(request.identity),
    );
    const previousIdentity = state.capturedOrFollowedIdentity;
    const samePage = sameCompanionSourcePage(
      previousIdentity,
      request.identity,
      normalizedPageUrl,
    );
    if (!samePage) recoveryGate.reset();
    if (shouldResetReplicaScrollForCapture(request.reason, samePage)) {
      state.lastSourceScroll = undefined;
      presentation.resetSourceScroll();
    }
    const retainTranslationIntent =
      samePage &&
      (request.reason === 'manual' ||
        request.reason === 'desynchronized' ||
        request.reason === 'preference');
    if (!retainTranslationIntent) {
      coordinator.selectPair(undefined);
      state.resetTranslationIntent();
      this.environment.invalidateComposer();
    }
    state.abortPageWork();
    imageController.setTopPageOrigin(request.identity.url);
    imageController.releaseReplica();
    this.environment.currency.supersede('availability');
    state.followedPageIdentity = request.identity;
    if (!state.snapshot && !presentation.hasCommittedReplica) {
      this.environment.renderLoading();
    }
    this.environment.setStatus(
      request.reason === 'desynchronized'
        ? 'A live update could not be reconciled. Rebuilding once while keeping the current mirror visible…'
        : request.reason === 'navigation'
          ? 'Building the live mirror for the newly loaded page…'
          : 'Building the initial live read-only mirror…',
    );
    const enqueued = captureCoordinator.enqueue(request);
    this.environment.updateControls();
    if (enqueued.startNow) void this.#runCaptureWork(enqueued.work);
  }

  /** The source tab started loading another document; page work is stale. */
  beginSourceNavigation(next: CapturedPageIdentity): void {
    const state = this.#state;
    this.environment.imageController.setTopPageOrigin(next.url);
    this.environment.currency.supersedePage();
    this.environment.evidence.invalidate();
    state.pageLanguageResolutionPending = false;
    if (state.resolvedSourceLanguageOrigin === 'image') {
      this.environment.translationDriver.clearAutoImageLanguageResolution();
    }
    this.environment.captureCoordinator.invalidate();
    state.abortPageWork();
    this.environment.imageController.releaseReplica();
    this.environment.invalidateComposer();
  }

  /** The followed page is gone; clear everything that described it. */
  invalidateCompanion(message: string): void {
    const state = this.#state;
    this.environment.navigationRefreshGate.reset();
    this.environment.currency.supersedePage();
    state.activeFollowRequest = undefined;
    this.environment.evidence.invalidate();
    state.pageLanguageResolutionPending = false;
    this.environment.captureCoordinator.invalidate();
    state.abortPageWork();
    this.environment.imageController.setTopPageOrigin(undefined);
    this.environment.imageController.releaseReplica();
    this.environment.engine.releasePresentation();
    this.environment.invalidateComposer();
    state.clearPage();
    this.environment.coordinator.selectPair(undefined);
    this.environment.recoveryGate.reset();
    this.environment.presentation.resetSourceScroll();
    this.environment.renderError(message);
    this.environment.setStatus(message, 'warning');
    this.environment.updateControls();
  }

  /** The engine committed a checkpoint or a live batch for the replica. */
  handleReplicaSourceCommit(commit: ReplicaSourceCommit): void {
    const state = this.#state;
    const { surface, coordinator, imageController, translationDriver } = this.environment;
    const selectedSnapshot = surface.snapshot();
    if (selectedSnapshot && sameSourceReplicaLease(selectedSnapshot, commit)) {
      state.snapshot = selectedSnapshot;
      this.environment.hideReplicaStatus();
      translationDriver.clearAutoImageLanguageForDifferentDocument(commit.document);
      // Initial activation is deliberately deferred until the engine run has
      // settled. Checkpoint/live callbacks can only advance an existing lease.
      imageController.notifyReplicaCommit(commit.document, commit.replayLease);
    }
    if (state.isLiveSourceOnlyMode) return;
    coordinator.handleSourceCommit(commit);
    const action = replicaSourceCommitAction(
      commit,
      state.preferences.sourceLanguage === 'auto',
    );
    if (!action.prepareForNewText && !action.refreshDetectedLanguage) return;
    const refresh = this.environment.currency.begin('language-refresh');
    void translationDriver.reconcileAfterCommit(
      commit,
      refresh,
      action.refreshDetectedLanguage,
      action.prepareForNewText,
    );
  }

  /** The live stream died; rebuild once within the budget, else report. */
  handleReplicaLiveFailure(code: ReplicaDiagnosticCode): void {
    const state = this.#state;
    const { recoveryGate, presentation } = this.environment;
    const identity = state.followedOrCapturedIdentity;
    const action = identity
      ? recoveryGate.decide(presentation.hasCommittedReplica)
      : 'terminal-error';
    // Content-free by construction: bounded enums only, with no page identity,
    // source text, URL, DOM identifier, pixels, or resource metadata.
    if (import.meta.env.DEV) {
      console.info('[Simul replica live failure]', {
        engine: 'isolated-html',
        code,
        state: action,
      });
    }
    if (action === 'rebuild-last-good' && identity) {
      this.environment.setStatus(
        'The live mirror disconnected. Rebuilding once while keeping the last good replica visible…',
        'warning',
      );
      this.queueCapture({ identity, reason: 'desynchronized' });
      return;
    }
    recoveryGate.reset();
    this.environment.setStatus(
      'The live replica disconnected again. The last good replica is preserved; choose Refresh to retry.',
      'error',
    );
    this.environment.updateControls();
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
    }
  }

  async #capturePage(work: GenerationWork<CaptureRequest>): Promise<void> {
    const state = this.#state;
    const {
      captureCoordinator,
      engine,
      surface,
      presentation,
      translationDriver,
      setStatus,
    } = this.environment;
    const identity = work.value.identity;
    try {
      const sameCapturedPage = Boolean(
        state.capturedPageIdentity &&
          state.capturedPageIdentity.tabId === identity.tabId &&
          state.capturedPageIdentity.windowId === identity.windowId &&
          normalizedPageUrl(state.capturedPageIdentity.url) ===
            normalizedPageUrl(identity.url),
      );
      const preserveLastGoodReplica = shouldPreserveCommittedReplicaForCapture(
        work.value.reason,
        sameCapturedPage,
        presentation.hasCommittedReplica,
      );
      // A same-page manual/recovery rebuild keeps last-good visible while the
      // isolated engine stages its replacement offscreen and swaps atomically.
      if (!preserveLastGoodReplica) {
        engine.releasePresentation();
        state.snapshot = undefined;
      }
      const documentId = await withPageTimeout(
        this.environment.readDocumentId(identity.tabId),
        this.environment.captureTimeoutMs,
      );
      if (!captureCoordinator.isCurrent(work.generation)) return;
      if (typeof documentId !== 'string' || documentId.length === 0) {
        throw new PageAccessError('The page did not expose a current document boundary.');
      }
      const currentTab = await this.environment.getTab(identity.tabId);
      assertSourceTabIsCurrent(currentTab, identity, state.requiresActiveSourceTab);
      if (!captureCoordinator.isCurrent(work.generation)) return;

      state.translationComplete = false;
      this.environment.clearCaptureNotes();
      await this.#runReplicaEngineCheckpoint(work, identity, documentId);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      state.snapshot = surface.snapshot();
      if (!state.snapshot) {
        throw new PageAccessError('The isolated replica did not commit a current document.');
      }
      // Only published replica state is captured state. Keeping the candidate
      // identity in followedPageIdentity lets a failed replacement retain an
      // accurate last-good identity instead of pretending the failed page won.
      // A history/replaceState URL can arrive while this same document is
      // staging. Preserve that newer identity instead of writing the capture's
      // older request URL back over it after the replica commits.
      const committedIdentity = state.followedPageIdentity && sameCompanionSourcePage(
          state.followedPageIdentity,
          identity,
          normalizedPageUrl,
        )
        ? state.followedPageIdentity
        : identity;
      state.capturedPageIdentity = committedIdentity;
      state.followedPageIdentity = committedIdentity;
      await translationDriver.resolveSelectedSourceLanguage(
        translationDriver.currentReplicaLanguageContext(),
      );

      if (state.isLiveSourceOnlyMode) {
        state.availability = 'unavailable';
        state.availabilityCheckedForPair = undefined;
        setStatus(
          'Live source only is active. The isolated mirror keeps updating without text or image translation.',
          'success',
        );
        return;
      }

      if (translationDriver.currentTranslationFieldCount() === 0) {
        state.availability = 'unavailable';
        state.availabilityCheckedForPair = undefined;
        const accessWasRevoked = await this.environment.reconcileAutomaticAccess(
          committedIdentity.url,
        );
        if (!captureCoordinator.isCurrent(work.generation)) return;
        setStatus(
          accessWasRevoked
            ? 'Chrome removed a saved automatic-access grant. The mirror is waiting for page text.'
            : 'The page mirror is live and will prepare translation when visible text arrives.',
          'warning',
        );
        return;
      }
      await translationDriver.checkAvailability(work.generation);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      const accessWasRevoked = await this.environment.reconcileAutomaticAccess(
        committedIdentity.url,
      );
      if (!captureCoordinator.isCurrent(work.generation)) return;
      if (accessWasRevoked) {
        setStatus('Chrome removed a saved automatic-access grant, so that scope was turned off.', 'warning');
        return;
      }
      await translationDriver.maybeTranslateAutomatically(work.generation, committedIdentity.url);
    } catch (error) {
      if (!captureCoordinator.isCurrent(work.generation)) return;
      const message = readPageError(error);
      state.snapshot = surface.snapshot();
      if (!state.snapshot && !presentation.hasCommittedReplica) {
        this.environment.renderError(message);
      }
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
    const { captureCoordinator, engine, presentation, imageController, recoveryGate } =
      this.environment;
    state.replicaShadowAbortController?.abort();
    const abortController = new AbortController();
    state.replicaShadowAbortController = abortController;
    const request: ReplicaCaptureRequest = {
      sessionId: this.environment.mirrorSessionId,
      pageEpoch: work.generation,
      generation: work.generation,
      tabId: identity.tabId,
      frameId: 0,
      documentId,
      isCurrent: () =>
        captureCoordinator.isCurrent(work.generation) &&
        sameCompanionSourcePage(state.followedPageIdentity, identity, normalizedPageUrl),
    };
    let replicaCommitted = false;
    let engineRunSettled = false;
    let activationDecisionSettled = false;
    try {
      const result = await engine.run(request, abortController.signal);
      this.environment.onEngineResult?.(result);
      engineRunSettled = true;
      replicaCommitted = isCommittedPrimaryReplica(result, presentation.hasCommittedReplica);
      const selectedSnapshot = state.snapshot;
      const activation = activateImageReplicaAfterRun({
        runStatus: result.status,
        hasCommittedReplica: replicaCommitted,
        aborted: abortController.signal.aborted,
        modeMatches: true,
        requestCurrent: request.isCurrent(),
        snapshotAvailable: selectedSnapshot !== undefined,
        snapshotMatches: Boolean(
          selectedSnapshot &&
          captureRequestMatchesSourceDocument(request, selectedSnapshot.document),
        ),
        activate: () => Boolean(
          selectedSnapshot &&
          imageController.activateReplica(
            request,
            identity.windowId,
            selectedSnapshot.replayLease,
          ),
        ),
      });
      if (activation.status === 'not-activated') {
        this.environment.logImageDiagnostic(Object.freeze({
          stage: 'replica-not-activated' as const,
          reason: activation.reason,
        }));
      }
      activationDecisionSettled = true;
      if (replicaCommitted) {
        recoveryGate.markCommitted();
        this.environment.updateMirrorLayout();
        return;
      }
      throw new PageAccessError('The isolated replica could not be prepared. Retry the current page.');
    } catch (error) {
      if (!activationDecisionSettled) {
        const reason = imageReplicaActivationFailureReason({
          aborted: abortController.signal.aborted,
          requestCurrent: request.isCurrent(),
          modeMatches: true,
          engineRunSettled,
        });
        this.environment.logImageDiagnostic(Object.freeze({
          stage: 'replica-not-activated' as const,
          reason,
        }));
      }
      throw error;
    } finally {
      if (
        state.replicaShadowAbortController === abortController &&
        !presentation.hasCommittedReplica
      ) {
        state.replicaShadowAbortController = undefined;
      }
    }
  }
}
