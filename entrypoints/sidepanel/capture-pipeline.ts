import {
  shouldResetReplicaScrollForCapture,
  type GenerationWork,
  type LatestWorkCoordinator,
} from '../../lib/companion-lifecycle';
import { sameCompanionSourcePage } from '../../lib/companion-surface';
import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import { UI_STRINGS } from '../../lib/companion-ui-strings';
import { normalizeZoomFactor } from '../../lib/display-scale';
import type { UiText } from '../../lib/ui-text';
import type { NavigationRefreshGate } from '../../lib/navigation-refresh-gate';
import type { ImageTranslationDiagnostic } from '../../lib/ocr/image-translation-controller';
import { isPdfContentType } from '../../lib/pdf/pdf-detection';
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
  sameSourceDocument,
  sameSourceReplicaLease,
  type ReplicaSourceDocumentIdentity,
} from '../../lib/replica/source-identity';
import { replicaSourceCommitAction } from '../../lib/translation/replica-translation-lifecycle';
import type {
  ReplicaSourceCommit,
  ReplicaTranslationSnapshot,
} from '../../lib/translation/replica-translation-coordinator';
import type { SupportedLanguage, TranslationPair } from '../../lib/translation-provider';
import type { CaptureRequest, CompanionState } from './companion-state';
import type { Currency } from './currency';
import type { PdfScannedPagesState } from './pdf-controller';
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

/**
 * The PDF view, a committed presentation like the replica: `shown` while a
 * document is on screen, which keeps the loading and error states away.
 */
export interface PipelinePdf {
  readonly shown: boolean;
  /**
   * Shows the PDF, with an empty translation surface for `document`. Rejects
   * with a `PageAccessError` status, or an `AbortError` when cancelled.
   */
  show(
    url: string,
    signal: AbortSignal,
    document: ReplicaSourceDocumentIdentity,
  ): Promise<{ readonly pageCount: number }>;
  /**
   * Reads every page's text of the shown PDF into its surface. Rejects with
   * an `AbortError` when cancelled or replaced.
   */
  readText(signal: AbortSignal): Promise<{ readonly hasText: boolean }>;
  /** The document the shown PDF's translation surface is for. */
  readonly textDocument: ReplicaSourceDocumentIdentity | undefined;
  close(): void;
  /**
   * Finds the language of the shown PDF's scanned pages with local OCR;
   * `undefined` when it cannot tell or cannot read them.
   */
  probeLanguage(signal: AbortSignal): Promise<SupportedLanguage | undefined>;
  /** The language the probe found; used when the PDF names none. */
  setLanguageHint(language: SupportedLanguage | undefined): void;
  /** Whether scanned pages remain that a run could read in `language`. */
  scannedPagesState(language: SupportedLanguage | undefined): PdfScannedPagesState;
  /** Why the shown PDF has nothing to translate. */
  noTextStatus(language: SupportedLanguage | undefined): UiText;
}

/** Which surface translation projects onto: the mirror or the PDF view. */
export type PipelineSurfaceKind = 'mirror' | 'pdf';

/** The followed tab's top document: its id and `document.contentType`. */
export interface SourceDocumentFacts {
  readonly documentId: string | undefined;
  readonly contentType: unknown;
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
  | 'pageLanguageResolves'
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
  readonly pdf: PipelinePdf;
  readonly coordinator: PipelineCoordinator;
  readonly imageController: PipelineImageController;
  readonly translationDriver: PipelineTranslationDriver;
  readonly evidence: { invalidate(): void };
  readonly mirrorSessionId: string;
  readonly captureTimeoutMs: number;
  /** Reads the top frame's current document id and content type. */
  readonly readDocument: (tabId: number) => Promise<SourceDocumentFacts | undefined>;
  /** The tab's browser zoom factor; 1 when Chrome cannot say. */
  readonly readZoom: (tabId: number) => Promise<number>;
  readonly getTab: (tabId: number) => Promise<PageTabLike>;
  readonly reconcileAutomaticAccess: (pageUrl: string) => Promise<boolean>;
  readonly cancelNavigationRefresh: () => void;
  readonly invalidateComposer: () => void;
  readonly setStatus: (message: UiText, tone?: CompanionStatusTone) => void;
  readonly updateControls: () => void;
  readonly renderLoading: (message?: UiText) => void;
  readonly renderError: (message: UiText) => void;
  readonly hideReplicaStatus: () => void;
  readonly clearCaptureNotes: () => void;
  readonly updateMirrorLayout: () => void;
  /** Routes translation to the mirror or to the PDF view. */
  readonly selectSurface: (kind: PipelineSurfaceKind) => void;
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
  // Counts the followed tab's zoom changes, so a capture's own zoom read,
  // answered before a change that arrives while it waits, cannot undo it.
  #zoomChanges = 0;

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
    if (!state.snapshot && !presentation.hasCommittedReplica && !this.environment.pdf.shown) {
      this.environment.renderLoading();
    }
    this.environment.setStatus(
      request.reason === 'desynchronized'
        ? UI_STRINGS.statusReconcileRebuild
        : request.reason === 'navigation'
          ? UI_STRINGS.statusBuildingNewPage
          : UI_STRINGS.statusBuildingInitial,
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
  invalidateCompanion(message: UiText): void {
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
    this.environment.pdf.close();
    this.environment.invalidateComposer();
    state.clearPage();
    this.environment.coordinator.selectPair(undefined);
    this.environment.recoveryGate.reset();
    this.environment.presentation.resetSourceScroll();
    this.environment.renderError(message);
    this.environment.setStatus(message, 'warning');
    this.environment.updateControls();
  }

  /** Chrome changed a tab's zoom; the followed tab's zoom sizes 1:1 and custom zoom. */
  handleSourceZoomChange(tabId: number, zoomFactor: number): void {
    const state = this.#state;
    if (state.followedOrCapturedIdentity?.tabId !== tabId) return;
    this.#zoomChanges += 1;
    const factor = normalizeZoomFactor(zoomFactor);
    if (factor === state.sourceZoomFactor) return;
    state.sourceZoomFactor = factor;
    this.environment.updateMirrorLayout();
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

  /**
   * With From = Auto and no language in the shown PDF's /Lang or text, the
   * scanned pages may tell: the language probe reads them (a run needs the
   * language to read them) and the snapshot is published again with its
   * answer. The controller keeps that answer, so asking again for the same
   * PDF and reading methods reads nothing. Used when the PDF's text is read,
   * when From becomes Auto and when Translated mode resumes.
   */
  async probePdfLanguage(signal: AbortSignal): Promise<void> {
    const state = this.#state;
    const { pdf, translationDriver } = this.environment;
    const requested = state.snapshot;
    if (
      !requested ||
      !pdf.shown ||
      signal.aborted ||
      state.preferences.sourceLanguage !== 'auto' ||
      state.isLiveSourceOnlyMode ||
      pdf.scannedPagesState(undefined) !== 'readable' ||
      await translationDriver.pageLanguageResolves()
    ) return;
    const language = await pdf.probeLanguage(signal);
    const published = state.snapshot;
    if (
      !language ||
      signal.aborted ||
      !pdf.shown ||
      !published ||
      published.replayLease !== requested.replayLease ||
      !sameSourceDocument(published.document, requested.document)
    ) return;
    pdf.setLanguageHint(language);
    this.adoptReadPdfText();
  }

  /**
   * A translation run over a PDF may have read scanned pages into its
   * surface; the published snapshot takes them, so later pair and language
   * decisions see that text. Only for the same shown document and lease.
   */
  adoptReadPdfText(): void {
    const state = this.#state;
    const { pdf, surface } = this.environment;
    const published = state.snapshot;
    if (!pdf.shown || !published) return;
    const latest = surface.snapshot();
    if (
      latest &&
      latest !== published &&
      latest.replayLease === published.replayLease &&
      sameSourceDocument(latest.document, published.document)
    ) {
      state.snapshot = latest;
    }
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
        UI_STRINGS.statusLiveDisconnectedRebuild,
        'warning',
      );
      this.queueCapture({ identity, reason: 'desynchronized' });
      return;
    }
    recoveryGate.reset();
    this.environment.setStatus(
      UI_STRINGS.statusLiveDisconnectedAgain,
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
      pdf,
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
      // A shown PDF follows the same last-good rule as the replica.
      if (
        pdf.shown &&
        !shouldPreserveCommittedReplicaForCapture(work.value.reason, sameCapturedPage, true)
      ) {
        pdf.close();
        if (!presentation.hasCommittedReplica) this.environment.renderLoading();
      }
      const sourceDocument = await withPageTimeout(
        this.environment.readDocument(identity.tabId),
        this.environment.captureTimeoutMs,
      );
      if (!captureCoordinator.isCurrent(work.generation)) return;
      const documentId = sourceDocument?.documentId;
      if (typeof documentId !== 'string' || documentId.length === 0) {
        throw new PageAccessError(UI_STRINGS.statusNoDocumentBoundary);
      }
      const currentTab = await this.environment.getTab(identity.tabId);
      assertSourceTabIsCurrent(currentTab, identity, state.requiresActiveSourceTab);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      const zoomChangesBefore = this.#zoomChanges;
      const zoomFactor = await this.#readZoom(identity.tabId);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      if (this.#zoomChanges === zoomChangesBefore) state.sourceZoomFactor = zoomFactor;
      this.environment.updateMirrorLayout();

      if (isPdfContentType(sourceDocument?.contentType)) {
        engine.releasePresentation();
        state.snapshot = undefined;
        await this.#capturePdf(work, identity, documentId);
        return;
      }
      pdf.close();
      this.environment.selectSurface('mirror');

      state.translationComplete = false;
      this.environment.clearCaptureNotes();
      await this.#runReplicaEngineCheckpoint(work, identity, documentId);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      state.snapshot = surface.snapshot();
      if (!state.snapshot) {
        throw new PageAccessError(UI_STRINGS.statusNoCommittedDocument);
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
      await this.#prepareTranslation(work, committedIdentity, {
        sourceOnly: UI_STRINGS.statusLiveSourceKeepsUpdating,
        noText: () => [UI_STRINGS.statusMirrorLiveWaiting, 'warning'],
      });
    } catch (error) {
      if (!captureCoordinator.isCurrent(work.generation)) return;
      const message = readPageError(error);
      state.snapshot = surface.snapshot();
      if (!state.snapshot && !presentation.hasCommittedReplica && !pdf.shown) {
        this.environment.renderError(message);
      }
      setStatus(message, 'error');
    } finally {
      this.environment.updateControls();
    }
  }

  /**
   * Once a page (mirror or PDF) is published: resolve its language, check the
   * pair and translate automatically when the rules say so. The statuses for
   * Live source only and for a page without text differ per surface.
   */
  async #prepareTranslation(
    work: GenerationWork<CaptureRequest>,
    identity: CapturedPageIdentity,
    statuses: {
      readonly sourceOnly: UiText;
      readonly noText: () => readonly [UiText, CompanionStatusTone];
    },
  ): Promise<void> {
    const state = this.#state;
    const { captureCoordinator, translationDriver, setStatus } = this.environment;
    await translationDriver.resolveSelectedSourceLanguage(
      translationDriver.currentReplicaLanguageContext(),
    );
    if (!captureCoordinator.isCurrent(work.generation)) return;

    if (state.isLiveSourceOnlyMode) {
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      setStatus(statuses.sourceOnly, 'success');
      return;
    }

    if (translationDriver.currentTranslationFieldCount() === 0) {
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      const accessWasRevoked = await this.environment.reconcileAutomaticAccess(identity.url);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      if (accessWasRevoked) setStatus(UI_STRINGS.statusGrantRemovedWaiting, 'warning');
      else setStatus(...statuses.noText());
      return;
    }
    await translationDriver.checkAvailability(work.generation);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const accessWasRevoked = await this.environment.reconcileAutomaticAccess(identity.url);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    if (accessWasRevoked) {
      setStatus(UI_STRINGS.statusGrantRemovedScopeOff, 'warning');
      return;
    }
    await translationDriver.maybeTranslateAutomatically(work.generation, identity.url);
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
      throw new PageAccessError(UI_STRINGS.statusReplicaNotPrepared);
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

  /**
   * The followed tab shows a PDF: the replica engine never runs. The PDF is
   * downloaded and shown, published like a committed replica, and the
   * capture ends. Its text is read after that (`#readPdfText`), while the
   * pages show; only then can it be translated.
   */
  async #capturePdf(
    work: GenerationWork<CaptureRequest>,
    identity: CapturedPageIdentity,
    documentId: string,
  ): Promise<void> {
    const state = this.#state;
    const { captureCoordinator, pdf, translationDriver, setStatus } = this.environment;
    state.translationComplete = false;
    this.environment.clearCaptureNotes();
    setStatus(UI_STRINGS.statusPdfReading);
    if (!pdf.shown) this.environment.renderLoading(UI_STRINGS.statusPdfReading);
    this.environment.selectSurface('pdf');
    state.pdfAbortController?.abort();
    const abortController = new AbortController();
    state.pdfAbortController = abortController;
    const document: ReplicaSourceDocumentIdentity = {
      sessionId: this.environment.mirrorSessionId,
      pageEpoch: work.generation,
      generation: work.generation,
      documentId,
      frameId: 0,
    };
    try {
      await pdf.show(identity.url, abortController.signal, document);
    } catch (error) {
      // Superseded or cancelled: whatever replaced this load reports instead.
      if (abortController.signal.aborted) return;
      throw error;
    } finally {
      if (state.pdfAbortController === abortController) {
        state.pdfAbortController = undefined;
      }
    }
    if (!captureCoordinator.isCurrent(work.generation)) return;
    this.environment.hideReplicaStatus();
    // As for the replica: a newer history URL of this same page wins.
    const shownIdentity = state.followedPageIdentity && sameCompanionSourcePage(
        state.followedPageIdentity,
        identity,
        normalizedPageUrl,
      )
      ? state.followedPageIdentity
      : identity;
    state.capturedPageIdentity = shownIdentity;
    state.followedPageIdentity = shownIdentity;
    // No text yet, so nothing to translate: this clears the page's language.
    state.snapshot = undefined;
    await translationDriver.resolveSelectedSourceLanguage(undefined);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    state.availability = 'unavailable';
    state.availabilityCheckedForPair = undefined;
    // The pages show; the text is read next, and the status says so until
    // the translation rules take over.
    setStatus(UI_STRINGS.statusPdfReading);
    void this.#readPdfText(work, shownIdentity, document);
  }

  /**
   * Reads all of the shown PDF's text, then publishes its full snapshot and
   * prepares it for translation by the page rules. Reading all of it first
   * means one translation run holds every block (and its Cancel), and a
   * Refresh queues everything from the reading page again. A newer capture,
   * navigation or close abandons it silently.
   */
  async #readPdfText(
    work: GenerationWork<CaptureRequest>,
    identity: CapturedPageIdentity,
    document: ReplicaSourceDocumentIdentity,
  ): Promise<void> {
    const state = this.#state;
    const { captureCoordinator, pdf, surface, setStatus } = this.environment;
    state.pdfTextAbortController?.abort();
    const abortController = new AbortController();
    state.pdfTextAbortController = abortController;
    const current = () => {
      const shown = pdf.textDocument;
      return !abortController.signal.aborted &&
        captureCoordinator.isCurrent(work.generation) &&
        pdf.shown &&
        shown !== undefined &&
        sameSourceDocument(shown, document);
    };
    try {
      await pdf.readText(abortController.signal);
    } catch {
      // Cancelled or replaced: the newer page reports instead.
      this.#finishPdfText(abortController);
      return;
    }
    try {
      if (!current()) return;
      state.snapshot = surface.snapshot();
      if (!state.snapshot) return;
      await this.probePdfLanguage(abortController.signal);
      if (!current() || !state.snapshot) return;
      await this.#prepareTranslation(work, identity, {
        sourceOnly: UI_STRINGS.statusPdfSourceOnly,
        noText: () => [
          pdf.noTextStatus(state.selectedPair()?.sourceLanguage ?? state.resolvedSourceLanguage),
          'warning',
        ],
      });
    } catch (error) {
      if (captureCoordinator.isCurrent(work.generation)) {
        setStatus(readPageError(error), 'error');
      }
    } finally {
      this.#finishPdfText(abortController);
    }
  }

  #finishPdfText(abortController: AbortController): void {
    if (this.#state.pdfTextAbortController === abortController) {
      this.#state.pdfTextAbortController = undefined;
    }
    this.environment.updateControls();
  }

  async #readZoom(tabId: number): Promise<number> {
    try {
      return normalizeZoomFactor(await this.environment.readZoom(tabId));
    } catch {
      return 1;
    }
  }
}
