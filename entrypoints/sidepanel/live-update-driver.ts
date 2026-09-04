import {
  mergeLiveUpdateBatches,
  type LatestWorkCoordinator,
} from '../../lib/companion-lifecycle';
import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import {
  captureLivePageDelta,
  parseLivePageDelta,
  readLivePageDirtyMessage,
  readLivePageScrollMessage,
  type LivePageDelta,
  type LivePageDirtyMessage,
  type LivePageScrollMessage,
  type LiveVisualNode,
} from '../../lib/live-page-mirror';
import {
  normalizedPageUrl,
  readableError,
  withPageTimeout,
  type BrowserTabIdentity,
} from '../../lib/page-identity';
import { isAutoTranslationEnabled } from '../../lib/preferences';
import type { LegacyTransitionGate } from '../../lib/replica/legacy-transition-gate';
import type { TranslationProvider, TranslationSession } from '../../lib/translation-provider';
import { applyLivePageDelta, resetVisualMirrorText } from '../../lib/visual-renderer';
import {
  availabilityPairKey,
  sameTranslationPair,
  type CaptureRequest,
  type CompanionState,
  type PendingLiveUpdate,
} from './companion-state';
import type { MirrorView } from './mirror-view';
import type { PageScripting } from './page-scripting';
import type { TranslationDriver } from './translation-driver';

/** Node ids applied per live delta; the remainder is re-queued. */
const LIVE_DELTA_NODE_LIMIT = 48;
const LANGUAGE_SAMPLE_LIMIT = 20_000;

export interface LiveUpdateDriverEnvironment {
  readonly state: CompanionState;
  readonly captureCoordinator: Pick<LatestWorkCoordinator<CaptureRequest>, 'isCurrent'>;
  readonly liveSessionId: string;
  readonly scripting: PageScripting;
  readonly captureTimeoutMs: number;
  readonly mirrorView: Pick<MirrorView, 'root' | 'replaceRoot' | 'updateLayout' | 'followSourceScroll'>;
  readonly legacyTransitionGate: Pick<LegacyTransitionGate, 'markDirty' | 'shadowOwnsPage'>;
  readonly provider: Pick<TranslationProvider, 'createSession'>;
  readonly translation: Pick<
    TranslationDriver,
    | 'resolveSelectedSourceLanguage'
    | 'checkAvailability'
    | 'maybeTranslateAutomatically'
    | 'translateCached'
    | 'currentTranslationFieldCount'
  >;
  readonly queueCapture: (request: CaptureRequest) => void;
  readonly releaseReplicaPresentationForLegacyWork: () => boolean;
  readonly invalidateComposer: () => void;
  readonly setStatus: (message: string, tone?: CompanionStatusTone) => void;
  readonly updateControls: () => void;
}

/**
 * Applies the legacy mirror's live deltas. Dirty notices from the page are
 * coalesced by sequence; a gap in the sequence, a desynchronized delta, or a
 * failed application rebuilds the page once instead of drifting. While the
 * isolated replica owns the page, dirtiness is only recorded for the gate.
 */
export class LiveUpdateDriver {
  constructor(private readonly environment: LiveUpdateDriverEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  /**
   * Routes a page-dirty or page-scroll message from the followed tab. Returns
   * true when the message was consumed, so the caller acknowledges it and
   * the page-side bridge does not resend it.
   */
  handleRuntimeMessage(message: unknown, senderTab: BrowserTabIdentity | undefined): boolean {
    const dirty = readLivePageDirtyMessage(message);
    if (dirty && this.isMessageFromFollowedTab(senderTab, dirty.sessionId, dirty.generation, dirty.url)) {
      this.queueUpdate(dirty);
      return true;
    }
    const scroll = readLivePageScrollMessage(message);
    if (
      scroll &&
      this.isMessageFromFollowedTab(senderTab, scroll.sessionId, scroll.generation, scroll.url)
    ) {
      this.#followScroll(scroll);
      return true;
    }
    return false;
  }

  isMessageFromFollowedTab(
    tab: BrowserTabIdentity | undefined,
    sessionId: string,
    generation: number,
    url: string,
  ): boolean {
    const followed = this.#state.followedOrCapturedIdentity;
    return Boolean(
      sessionId === this.environment.liveSessionId &&
        followed &&
        tab?.id === followed.tabId &&
        tab.windowId === followed.windowId &&
        this.environment.captureCoordinator.isCurrent(generation) &&
        normalizedPageUrl(url) === normalizedPageUrl(followed.url),
    );
  }

  #followScroll(scroll: LivePageScrollMessage): void {
    const state = this.#state;
    state.lastSourceScroll = scroll;
    state.acceptedScrollMessageCount += 1;
    const logScroll = state.acceptedScrollMessageCount <= 3 ||
      state.acceptedScrollMessageCount % 50 === 0;
    if (logScroll) {
      console.info(
        `[Simul scroll] received; count=${state.acceptedScrollMessageCount}; target=${scroll.scrollTarget}`,
      );
    }
    if (state.preferences.syncScroll) {
      this.environment.mirrorView.followSourceScroll(scroll);
      if (logScroll) {
        console.info(
          `[Simul scroll] projected; count=${state.acceptedScrollMessageCount}; target=${scroll.scrollTarget}`,
        );
      }
    }
  }

  /** The observer reported its sequence at install time for this generation. */
  initializeSequenceBaseline(generation: number, sequence: number): void {
    const state = this.#state;
    if (!this.environment.captureCoordinator.isCurrent(generation)) return;
    state.latestLiveSequence = sequence;
    state.highestReceivedLiveSequence = sequence;
    state.liveSequenceBaselineReady = true;
    if (!state.pendingLiveUpdate || state.pendingLiveUpdate.generation !== generation) return;
    if (state.pendingLiveUpdate.sequence <= sequence) {
      state.pendingLiveUpdate = undefined;
      return;
    }
    if (state.pendingLiveUpdate.firstSequence > sequence + 1) {
      state.pendingLiveUpdate = undefined;
      const identity = state.followedOrCapturedIdentity;
      if (identity) this.environment.queueCapture({ identity, reason: 'desynchronized' });
      return;
    }
    state.highestReceivedLiveSequence = state.pendingLiveUpdate.sequence;
  }

  queueUpdate(message: LivePageDirtyMessage): void {
    const state = this.#state;
    if (message.sequence <= state.latestLiveSequence) return;
    if (this.environment.legacyTransitionGate.markDirty()) return;
    if (
      state.liveSequenceBaselineReady &&
      state.highestReceivedLiveSequence > 0 &&
      message.sequence > state.highestReceivedLiveSequence + 1
    ) {
      this.environment.releaseReplicaPresentationForLegacyWork();
      const identity = state.followedOrCapturedIdentity;
      if (identity) {
        this.environment.setStatus('A live update was missed. Rebuilding once while keeping the current mirror visible…', 'warning');
        this.environment.queueCapture({ identity, reason: 'desynchronized' });
      }
      return;
    }
    if (message.sequence <= state.highestReceivedLiveSequence) return;
    state.highestReceivedLiveSequence = message.sequence;
    if (!state.pendingLiveUpdate || state.pendingLiveUpdate.generation !== message.generation) {
      state.pendingLiveUpdate = {
        generation: message.generation,
        firstSequence: message.sequence,
        sequence: message.sequence,
        nodeIds: new Set(message.nodeIds),
      };
    } else {
      state.pendingLiveUpdate.sequence = Math.max(state.pendingLiveUpdate.sequence, message.sequence);
      for (const nodeId of message.nodeIds) state.pendingLiveUpdate.nodeIds.add(nodeId);
    }
    this.environment.releaseReplicaPresentationForLegacyWork();
    void this.processPending();
  }

  /** Re-queues an interrupted delta so its node ids are not lost, then aborts it. */
  abortAndRequeue(): void {
    const state = this.#state;
    const interrupted = state.activeLiveUpdate;
    if (
      interrupted &&
      interrupted.sequence > state.latestLiveSequence &&
      this.environment.captureCoordinator.isCurrent(interrupted.generation)
    ) {
      const merged = mergeLiveUpdateBatches(state.pendingLiveUpdate, interrupted);
      state.pendingLiveUpdate = {
        ...merged,
        nodeIds: new Set(merged.nodeIds),
      };
    }
    state.liveDeltaAbortController?.abort();
  }

  async processPending(): Promise<void> {
    const state = this.#state;
    const {
      captureCoordinator,
      mirrorView,
      translation,
      provider,
      queueCapture,
      setStatus,
      updateControls,
    } = this.environment;
    if (
      state.liveDeltaInFlight ||
      state.captureInFlight ||
      state.translationInFlight ||
      !state.pendingLiveUpdate ||
      !state.capturedPageIdentity ||
      !mirrorView.root ||
      this.environment.legacyTransitionGate.shadowOwnsPage
    ) return;
    const update = state.pendingLiveUpdate;
    state.pendingLiveUpdate = undefined;
    const requestedNodeIds = [...update.nodeIds];
    const nodeIds = requestedNodeIds.slice(0, LIVE_DELTA_NODE_LIMIT);
    if (requestedNodeIds.length > nodeIds.length) {
      state.pendingLiveUpdate = {
        generation: update.generation,
        firstSequence: update.firstSequence,
        sequence: update.sequence,
        nodeIds: new Set(requestedNodeIds.slice(LIVE_DELTA_NODE_LIMIT)),
      };
    }
    if (!captureCoordinator.isCurrent(update.generation)) return;
    const identity = state.capturedPageIdentity;
    const beforeRoot = mirrorView.root;
    const abortController = new AbortController();
    const activeUpdate: PendingLiveUpdate = {
      generation: update.generation,
      firstSequence: update.firstSequence,
      sequence: update.sequence,
      nodeIds: new Set(nodeIds),
    };
    state.activeLiveUpdate = activeUpdate;
    state.liveDeltaAbortController = abortController;
    state.liveDeltaInFlight = true;
    updateControls();
    let session: TranslationSession | undefined;
    try {
      const results = await withPageTimeout(
        this.environment.scripting.runFunction(
          identity.tabId,
          captureLivePageDelta,
          [this.environment.liveSessionId, update.generation, update.sequence, nodeIds],
        ),
        this.environment.captureTimeoutMs,
      );
      const delta = parseLivePageDelta(results[0]?.result);
      if (
        !captureCoordinator.isCurrent(delta.generation) ||
        delta.sequence < state.latestLiveSequence ||
        normalizedPageUrl(delta.url) !== normalizedPageUrl(identity.url)
      ) return;
      if (delta.desynchronized) {
        queueCapture({ identity: state.capturedPageIdentity, reason: 'desynchronized' });
        return;
      }
      const pairBeforeRefresh = state.selectedPair();
      let pairChanged = false;
      const visibleLanguageText = liveDeltaLanguageSample(delta);
      if (state.preferences.sourceLanguage === 'auto') {
        const resolutionCommitted = await translation.resolveSelectedSourceLanguage({
          documentLanguage: delta.documentLanguage,
          visibleText: visibleLanguageText,
          preserveOnUnknown: true,
        });
        if (
          !resolutionCommitted ||
          abortController.signal.aborted ||
          mirrorView.root !== beforeRoot ||
          !captureCoordinator.isCurrent(delta.generation)
        ) return;
        const refreshedPair = state.selectedPair();
        pairChanged = !sameTranslationPair(pairBeforeRefresh, refreshedPair);
        if (pairChanged) {
          state.availabilityCheckedForPair = undefined;
          state.translationComplete = false;
          this.environment.invalidateComposer();
          resetVisualMirrorText(beforeRoot);
        }
        await translation.checkAvailability(delta.generation);
        if (
          abortController.signal.aborted ||
          mirrorView.root !== beforeRoot ||
          !captureCoordinator.isCurrent(delta.generation) ||
          (refreshedPair && !state.isCurrentTranslationPair(refreshedPair))
        ) return;
      }

      const pair = state.selectedPair();
      const wantsTranslation =
        !state.isLiveSourceOnlyMode &&
        (state.translationDesired || isAutoTranslationEnabled(state.preferences, identity.url));
      const shouldTranslate = Boolean(
        pair &&
        pair.sourceLanguage !== pair.targetLanguage &&
        wantsTranslation &&
        !pairChanged &&
        state.availability === 'available',
      );
      if (shouldTranslate && pair) {
        session = await provider.createSession(pair, { signal: abortController.signal });
      }
      const applied = await applyLivePageDelta(beforeRoot, delta, {
        textLayoutMode: state.preferences.textLayoutMode,
        signal: abortController.signal,
        ...(shouldTranslate && pair && session
          ? {
              translate: (source: string, signal?: AbortSignal) =>
                translation.translateCached(pair, session as TranslationSession, source, signal),
            }
          : {}),
      });
      if (
        abortController.signal.aborted ||
        mirrorView.root !== beforeRoot ||
        !captureCoordinator.isCurrent(delta.generation) ||
        (pair && !state.isCurrentTranslationPair(pair))
      ) return;
      mirrorView.replaceRoot(applied.root, delta.documentWidth, delta.documentHeight);
      state.latestLiveSequence = delta.sequence;
      if (state.activeLiveUpdate === activeUpdate) state.activeLiveUpdate = undefined;
      mirrorView.updateLayout();
      if (applied.missingTarget) {
        queueCapture({ identity, reason: 'desynchronized' });
        return;
      }
      if (applied.translation.failed > 0) {
        state.translationComplete = false;
        setStatus(
          `${applied.translation.failed} changed text segment(s) could not be translated; their original text remains.`,
          'warning',
        );
        return;
      }

      let translationStatusWasHandled = shouldTranslate;
      if (shouldTranslate && applied.applied > 0) {
        setStatus('Live page changes were mirrored and translated.', 'success');
      }
      if (translation.currentTranslationFieldCount() > 0) {
        const currentPair = state.selectedPair();
        const pairKey = currentPair
          ? availabilityPairKey(currentPair, update.generation)
          : undefined;
        if (!currentPair || state.availabilityCheckedForPair !== pairKey) {
          await translation.checkAvailability(update.generation);
        }
        if ((!shouldTranslate || pairChanged) && wantsTranslation) {
          translationStatusWasHandled = true;
          await translation.maybeTranslateAutomatically(update.generation, identity.url);
        }
      }
      if (applied.applied > 0 && !translationStatusWasHandled) {
        setStatus('Live page changes were mirrored.', 'success');
      }
    } catch (error) {
      if (!abortController.signal.aborted && state.capturedPageIdentity) {
        setStatus(`A live update could not be applied: ${readableError(error)}`, 'warning');
        queueCapture({ identity: state.capturedPageIdentity, reason: 'desynchronized' });
      }
    } finally {
      session?.destroy();
      if (state.liveDeltaAbortController === abortController) {
        state.liveDeltaAbortController = undefined;
      }
      if (state.activeLiveUpdate === activeUpdate) state.activeLiveUpdate = undefined;
      state.liveDeltaInFlight = false;
      updateControls();
      void this.processPending();
    }
  }
}

/** Bounded text of the replaced nodes, for language detection only. */
export function liveDeltaLanguageSample(delta: LivePageDelta): string {
  const parts: string[] = [];
  let characters = 0;
  const append = (value: string | undefined): void => {
    if (!value || characters >= LANGUAGE_SAMPLE_LIMIT) return;
    const remaining = LANGUAGE_SAMPLE_LIMIT - characters;
    const text = value.replace(/\s+/gu, ' ').trim().slice(0, remaining);
    if (!text) return;
    parts.push(text);
    characters += text.length + 1;
  };
  const visit = (node: LiveVisualNode): void => {
    if (characters >= LANGUAGE_SAMPLE_LIMIT) return;
    if (node.kind === 'text') {
      append(node.text);
      return;
    }
    if (node.kind === 'placeholder') return;
    append(node.attributes?.alt);
    for (const child of node.children) visit(child);
  };
  for (const replacement of delta.replacements) {
    if (replacement.node) visit(replacement.node);
  }
  return parts.join(' ');
}
