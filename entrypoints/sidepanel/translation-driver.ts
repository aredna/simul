import {
  isAvailabilityRequestCurrent,
  replicaViewTranslationAction,
} from '../../lib/companion-lifecycle';
import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import { UI_STRINGS, formatUiTemplate } from '../../lib/companion-ui-strings';
import {
  resolveSourceLanguage,
  shouldClearAutoImageLanguageForDocument,
  type AutoLanguageEvidencePrecedence,
  type DetectedLanguageCandidate,
} from '../../lib/language-detection';
import type { AutoLanguageProbeEvidence } from '../../lib/ocr/auto-language-probe';
import type { AutoImageLanguageEvidenceOrigin } from '../../lib/ocr/image-translation-controller';
import {
  assertSourceTabIsCurrent,
  readableError,
  type CapturedPageIdentity,
  type PageTabLike,
} from '../../lib/page-identity';
import {
  isAutoTranslationEnabled,
  type ReplicaViewMode,
} from '../../lib/preferences';
import {
  sameSourceDocument,
  sameSourceReplicaLease,
  type ReplicaSourceDocumentIdentity,
} from '../../lib/replica/source-identity';
import { buildBoundedLanguageSample } from '../../lib/translation/language-sample';
import {
  isCompleteReplicaTranslationResult,
  type ReplicaSourceCommit,
  type ReplicaTranslationRunOptions,
  type ReplicaTranslationRunResult,
  type ReplicaTranslationSnapshot,
} from '../../lib/translation/replica-translation-coordinator';
import {
  type SupportedLanguage,
  type TranslationPair,
  type TranslationProvider,
} from '../../lib/translation-provider';
import {
  availabilityPairKey,
  sameTranslationPair,
  type CompanionState,
} from './companion-state';
import type { Currency, CurrencyToken } from './currency';

export interface LiveLanguageContext {
  documentLanguage?: string;
  visibleText: string;
  preserveOnUnknown: boolean;
}

export interface PendingAutoImageLanguageEvidence {
  readonly language: SupportedLanguage;
  readonly evidence: AutoLanguageProbeEvidence;
  readonly origin: AutoImageLanguageEvidenceOrigin;
  readonly document: ReplicaSourceDocumentIdentity;
  readonly replayLease: number | undefined;
  readonly identity: CapturedPageIdentity | undefined;
  readonly generation: number;
  readonly configurationKey: string;
}

/** The translation coordinator calls the driver makes. */
export interface DriverCoordinator {
  selectPair(pair: TranslationPair | undefined): void;
  translateCurrent(
    pair: TranslationPair,
    options: ReplicaTranslationRunOptions,
  ): Promise<ReplicaTranslationRunResult>;
  isResultCurrent(result: ReplicaTranslationRunResult): boolean;
}

/** The capture generation the driver checks currency against. */
export interface CaptureGeneration {
  readonly generation: number;
  isCurrent(generation: number): boolean;
}

export interface TranslationDriverEnvironment {
  readonly state: CompanionState;
  readonly currency: Currency;
  readonly provider: Pick<TranslationProvider, 'availability'>;
  readonly coordinator: DriverCoordinator;
  readonly captureCoordinator: CaptureGeneration;
  readonly evidence: AutoLanguageEvidencePrecedence<PendingAutoImageLanguageEvidence>;
  readonly detectLanguage: (
    text: string,
  ) => Promise<{ isReliable: boolean; languages: DetectedLanguageCandidate[] }>;
  readonly getTab: (tabId: number) => Promise<PageTabLike>;
  /** The auto-image language configuration key for the current settings. */
  readonly autoImageLanguageConfigurationKey: () => string;
  readonly configureImageTranslation: () => void;
  readonly setStatus: (
    message: string,
    tone?: CompanionStatusTone,
    englishMessage?: string,
  ) => void;
  /** Localizes one English catalogue string into the current UI language. */
  readonly localizeUi: (english: string) => string;
  /** Localizes a template frame and fills its numbered placeholders. */
  readonly localizeTemplate: (
    frame: string,
    ...args: readonly (string | number)[]
  ) => string;
  /** The language's display name in the current UI language. */
  readonly localizeLanguageName: (language: SupportedLanguage) => string;
  readonly updateControls: () => void;
  readonly showProgress: (
    label: string,
    value: number,
    max: number,
    labelArgs?: readonly (string | number)[],
  ) => void;
  readonly hideProgress: () => void;
  /** Renders the detected-language note; an empty string hides it. */
  readonly renderDetectedLanguage: (text: string) => void;
  readonly invalidateComposer: () => void;
  readonly syncComposerPanel: () => void;
  /** A page translation prepared the pair; dependent work may follow. */
  readonly onPairPrepared: () => void;
  readonly onTranslationSettled: () => void;
}

/**
 * Resolves the page's source language (from the page, from image evidence,
 * or from an explicit choice), checks translator availability for the
 * resulting pair, and runs page translations over the replica. Every
 * asynchronous step carries a currency token or the capture generation and
 * re-checks the snapshot and pair before it publishes a result, so a stale
 * answer can never overwrite a newer page, language or view mode.
 */
export class TranslationDriver {
  #detectedLanguageRender: (() => string) | undefined;

  constructor(private readonly environment: TranslationDriverEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  /**
   * Renders the detected-language note and remembers how to re-render it. The
   * note embeds a source-language name shown in the current UI language, so a
   * pure language switch must re-derive it; the stored thunk re-runs the whole
   * localization from the captured raw inputs (review finding F2).
   */
  #showDetectedLanguage(render: () => string): void {
    this.#detectedLanguageRender = render;
    this.environment.renderDetectedLanguage(render());
  }

  /** Re-renders the detected-language note in the language now current (F2). */
  relocalizeDetectedLanguage(): void {
    if (this.#detectedLanguageRender) {
      this.environment.renderDetectedLanguage(this.#detectedLanguageRender());
    }
  }

  // --- Snapshot currency.

  currentReplicaDocumentMatches(document: ReplicaSourceDocumentIdentity): boolean {
    const current = this.#state.snapshot?.document;
    return Boolean(current && sameSourceDocument(current, document));
  }

  currentReplicaSnapshotMatches(
    requested: Pick<ReplicaTranslationSnapshot, 'document' | 'replayLease'>,
  ): boolean {
    const current = this.#state.snapshot;
    return Boolean(current && sameSourceReplicaLease(current, requested));
  }

  currentReplicaLanguageContext(): LiveLanguageContext | undefined {
    const current = this.#state.snapshot;
    if (!current) return undefined;
    return {
      ...(current.documentLanguage
        ? { documentLanguage: current.documentLanguage }
        : {}),
      visibleText: buildBoundedLanguageSample(replicaRecordSources(current.records)),
      preserveOnUnknown: true,
    };
  }

  /** 1 when the replica has any translatable text, else 0. */
  currentTranslationFieldCount(): number {
    return this.#state.snapshot?.records.some(
      ({ source }) => source.trim().length > 0,
    ) ? 1 : 0;
  }

  // --- Source language resolution.

  async resolveSelectedSourceLanguage(liveContext?: LiveLanguageContext): Promise<boolean> {
    const state = this.#state;
    const { currency, evidence } = this.environment;
    if (shouldClearAutoImageLanguageForDocument(
      state.resolvedSourceLanguageOrigin,
      state.resolvedImageLanguageDocument !== undefined &&
        this.currentReplicaDocumentMatches(state.resolvedImageLanguageDocument),
    )) {
      this.clearAutoImageLanguageResolution();
    }
    const resolution = currency.begin('language-resolution');
    const resolutionRevision = resolution.id;
    if (!state.snapshot) {
      evidence.invalidate();
      state.clearLanguageResolution();
      this.environment.syncComposerPanel();
      this.environment.configureImageTranslation();
      return true;
    }
    const requestedSnapshot = state.snapshot;
    const requestedPreference = state.preferences.sourceLanguage;
    const previousLanguage = state.resolvedSourceLanguage;
    const previousOrigin = state.resolvedSourceLanguageOrigin;
    const previousImageConfigurationKey = state.resolvedImageLanguageConfigurationKey;
    const previousImageDocument = state.resolvedImageLanguageDocument;
    if (requestedPreference !== 'auto') evidence.invalidate();
    evidence.beginPageResolution(resolutionRevision);
    state.pageLanguageResolutionPending = evidence.pageResolutionPending;
    // This controller gate is raised before page detection yields. It prevents
    // image probing from adopting a language while stronger page evidence is
    // unresolved, instead of trying to undo a projection afterward.
    this.environment.configureImageTranslation();
    const detected = await resolveSourceLanguage(
      requestedPreference,
      {
        documentLanguage:
          liveContext?.documentLanguage ?? requestedSnapshot.documentLanguage,
        visibleText: liveContext?.visibleText ?? this.#mirrorLanguageSample(),
      },
      this.environment.detectLanguage,
    );
    if (
      !currency.isCurrent(resolution) ||
      !this.currentReplicaSnapshotMatches(requestedSnapshot) ||
      state.preferences.sourceLanguage !== requestedPreference
    ) {
      evidence.cancelPageResolution(resolutionRevision);
      state.pageLanguageResolutionPending = evidence.pageResolutionPending;
      this.environment.configureImageTranslation();
      return false;
    }
    const previousImageDocumentIsCurrent = previousOrigin === 'image' &&
      previousImageDocument !== undefined &&
      this.currentReplicaDocumentMatches(previousImageDocument);
    const preservePreviousLanguage = previousOrigin === 'image'
      ? previousImageDocumentIsCurrent
      : previousOrigin === 'page' && Boolean(liveContext?.preserveOnUnknown);
    state.resolvedSourceLanguage =
      detected.language ??
      (preservePreviousLanguage ? previousLanguage : undefined);
    if (detected.language) {
      const unchangedExplicitImageLanguage =
        requestedPreference !== 'auto' &&
        previousOrigin === 'image' &&
        previousLanguage === detected.language &&
        previousImageDocumentIsCurrent;
      state.resolvedSourceLanguageOrigin = unchangedExplicitImageLanguage
        ? 'image'
        : requestedPreference === 'auto'
          ? 'page'
          : 'explicit';
      state.resolvedImageLanguageConfigurationKey = unchangedExplicitImageLanguage
        ? previousImageConfigurationKey
        : undefined;
      state.resolvedImageLanguageDocument = unchangedExplicitImageLanguage
        ? previousImageDocument
        : undefined;
    } else if (state.resolvedSourceLanguage) {
      state.resolvedSourceLanguageOrigin = previousOrigin;
      state.resolvedImageLanguageConfigurationKey = previousImageConfigurationKey;
      state.resolvedImageLanguageDocument = previousOrigin === 'image'
        ? previousImageDocument
        : undefined;
    } else {
      state.resolvedSourceLanguageOrigin = undefined;
      state.resolvedImageLanguageConfigurationKey = undefined;
      state.resolvedImageLanguageDocument = undefined;
    }
    const pendingImageEvidence = evidence.settlePageResolution(
      resolutionRevision,
      Boolean(state.resolvedSourceLanguage),
    );
    state.pageLanguageResolutionPending = evidence.pageResolutionPending;
    if (pendingImageEvidence && this.#pendingImageEvidenceIsCurrent(pendingImageEvidence)) {
      this.commitAutoDetectedImageLanguage(pendingImageEvidence);
      return true;
    }
    const resolvedLanguage = state.resolvedSourceLanguage;
    this.#showDetectedLanguage(() =>
      resolvedLanguage
        ? requestedPreference === 'auto'
          ? detected.language
            ? this.environment.localizeTemplate(
                detected.source === 'html'
                  ? UI_STRINGS.statusDetectedFromPageLanguage
                  : UI_STRINGS.statusDetectedFromVisibleText,
                this.environment.localizeLanguageName(resolvedLanguage),
              )
            : this.environment.localizeTemplate(
                UI_STRINGS.statusPreviouslyDetectedSource,
                this.environment.localizeLanguageName(resolvedLanguage),
              )
          : ''
        : this.environment.localizeTemplate(UI_STRINGS.statusCouldNotDetect),
    );
    this.environment.syncComposerPanel();
    this.environment.configureImageTranslation();
    return true;
  }

  /** Image analysis found language evidence; adopt it if page evidence is settled. */
  offerImageLanguageEvidence(
    language: SupportedLanguage,
    evidence: AutoLanguageProbeEvidence,
    document: ReplicaSourceDocumentIdentity,
    origin: AutoImageLanguageEvidenceOrigin,
  ): void {
    const state = this.#state;
    if (state.preferences.sourceLanguage !== 'auto' || state.resolvedSourceLanguage) return;
    const ready = this.environment.evidence.offerImageEvidence({
      language,
      evidence,
      document,
      origin,
      replayLease: state.snapshot?.replayLease,
      identity: state.capturedPageIdentity,
      generation: this.environment.captureCoordinator.generation,
      configurationKey: this.environment.autoImageLanguageConfigurationKey(),
    });
    if (ready) this.commitAutoDetectedImageLanguage(ready);
  }

  commitAutoDetectedImageLanguage(proposal: PendingAutoImageLanguageEvidence): void {
    const state = this.#state;
    const { currency } = this.environment;
    if (
      state.preferences.sourceLanguage !== 'auto' ||
      state.resolvedSourceLanguage ||
      !this.#pendingImageEvidenceIsCurrent(proposal)
    ) return;
    const resolution = currency.begin('language-resolution');
    state.resolvedSourceLanguage = proposal.language;
    state.resolvedSourceLanguageOrigin = 'image';
    state.resolvedImageLanguageConfigurationKey = proposal.configurationKey;
    state.resolvedImageLanguageDocument = proposal.document;
    currency.supersede('availability');
    state.availabilityCheckedForPair = undefined;
    state.translationComplete = false;
    this.environment.invalidateComposer();
    this.#showDetectedLanguage(() =>
      this.environment.localizeTemplate(
        UI_STRINGS.statusDetectedFromImage,
        this.environment.localizeLanguageName(proposal.language),
        this.environment.localizeTemplate(
          proposal.origin === 'accessibility-text'
            ? UI_STRINGS.imageAccessibilityText
            : UI_STRINGS.imageBoundedOcr,
        ),
        proposal.evidence.replaceAll('-', ' '),
      ),
    );
    this.environment.syncComposerPanel();
    this.environment.updateControls();
    queueMicrotask(() => {
      void this.#reconcileAutoDetectedImageLanguage(proposal.language, resolution);
    });
  }

  /** The image evidence behind the resolved language no longer holds. */
  handleAutoImageLanguageInvalidated(document: ReplicaSourceDocumentIdentity): void {
    const state = this.#state;
    if (
      state.resolvedSourceLanguageOrigin !== 'image' ||
      !state.resolvedImageLanguageDocument ||
      !sameSourceDocument(state.resolvedImageLanguageDocument, document) ||
      !this.currentReplicaDocumentMatches(document)
    ) return;
    if (state.preferences.sourceLanguage !== 'auto') {
      // Explicit selection remains authoritative and keeps the effective pair
      // running, but the dormant image contributor must not be resurrected if
      // the user later returns to Auto.
      this.environment.currency.supersede('language-resolution');
      this.environment.evidence.invalidate();
      state.pageLanguageResolutionPending = false;
      state.resolvedSourceLanguageOrigin = 'explicit';
      state.resolvedImageLanguageConfigurationKey = undefined;
      state.resolvedImageLanguageDocument = undefined;
      return;
    }
    this.clearAutoImageLanguageResolution();
    queueMicrotask(() => {
      if (
        state.preferences.sourceLanguage !== 'auto' ||
        !this.currentReplicaDocumentMatches(document)
      ) return;
      this.environment.configureImageTranslation();
      void this.applyLanguagePreferences(false);
    });
  }

  /** Forgets image-derived language evidence and the pair built on it. */
  clearAutoImageLanguageResolution(): void {
    const state = this.#state;
    const { currency } = this.environment;
    currency.supersede('language-resolution');
    this.environment.evidence.invalidate();
    state.clearLanguageResolution();
    currency.supersede('availability');
    state.availability = 'unavailable';
    state.availabilityCheckedForPair = undefined;
    state.translationComplete = false;
    state.activeAbortController?.abort();
    this.environment.invalidateComposer();
    this.environment.coordinator.selectPair(undefined);
    this.#showDetectedLanguage(() =>
      this.environment.localizeTemplate(UI_STRINGS.statusImageEvidenceCleared),
    );
    this.environment.syncComposerPanel();
  }

  /** A commit for another document retires image evidence bound to the old one. */
  clearAutoImageLanguageForDifferentDocument(document: ReplicaSourceDocumentIdentity): void {
    const state = this.#state;
    if (!shouldClearAutoImageLanguageForDocument(
      state.resolvedSourceLanguageOrigin,
      Boolean(
        state.resolvedImageLanguageDocument &&
        sameSourceDocument(state.resolvedImageLanguageDocument, document),
      ),
    )) return;
    this.clearAutoImageLanguageResolution();
    this.environment.configureImageTranslation();
  }

  // --- Commits, language preferences and availability.

  async reconcileAfterCommit(
    commit: ReplicaSourceCommit,
    refresh: CurrencyToken,
    refreshDetectedLanguage: boolean,
    prepareForNewText: boolean,
  ): Promise<void> {
    const state = this.#state;
    const { currency, captureCoordinator, coordinator } = this.environment;
    if (state.isLiveSourceOnlyMode) return;
    const generation = commit.document.generation;
    const identity = state.capturedPageIdentity;
    if (!identity || !state.snapshot || !captureCoordinator.isCurrent(generation)) return;
    const previousPair = state.selectedPair();
    if (refreshDetectedLanguage) {
      const committed = await this.resolveSelectedSourceLanguage({
        documentLanguage: commit.documentLanguage,
        visibleText: buildBoundedLanguageSample(replicaRecordSources(commit.records)),
        preserveOnUnknown: true,
      });
      if (!committed) return;
    }
    if (
      !currency.isCurrent(refresh) ||
      !captureCoordinator.isCurrent(generation) ||
      state.capturedPageIdentity !== identity ||
      (state.preferences.sourceLanguage === 'auto') !== refreshDetectedLanguage
    ) return;
    const nextPair = state.selectedPair();
    const pairChanged = !sameTranslationPair(previousPair, nextPair);
    if (pairChanged) {
      state.activeAbortController?.abort();
      state.translationComplete = false;
      state.availabilityCheckedForPair = undefined;
      this.environment.invalidateComposer();
      coordinator.selectPair(nextPair);
    }
    const expectedAvailabilityKey = nextPair
      ? availabilityPairKey(nextPair, generation)
      : undefined;
    const needsPreparation =
      prepareForNewText &&
      this.currentTranslationFieldCount() > 0 &&
      (!expectedAvailabilityKey ||
        state.availabilityCheckedForPair !== expectedAvailabilityKey);
    if (!pairChanged && !needsPreparation) return;
    await this.checkAvailability(generation);
    if (
      currency.isCurrent(refresh) &&
      captureCoordinator.isCurrent(generation) &&
      state.capturedPageIdentity === identity &&
      sameTranslationPair(nextPair, state.selectedPair())
    ) {
      await this.maybeTranslateAutomatically(generation, identity.url);
    }
  }

  async applyLanguagePreferences(
    fromUserAction: boolean,
    previousPair = this.#state.selectedPair(),
  ): Promise<void> {
    const state = this.#state;
    const { captureCoordinator, coordinator, setStatus } = this.environment;
    if (!state.snapshot) return;
    await this.resolveSelectedSourceLanguage(this.currentReplicaLanguageContext());
    if (state.isLiveSourceOnlyMode) {
      coordinator.selectPair(undefined);
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      setStatus(UI_STRINGS.statusLiveSourceLanguagesSaved, 'success');
      this.environment.updateControls();
      return;
    }
    const nextPair = state.selectedPair();
    const effectivePairChanged = !sameTranslationPair(previousPair, nextPair);
    if (effectivePairChanged) {
      state.activeAbortController?.abort();
      this.environment.invalidateComposer();
      state.translationComplete = false;
      state.availabilityCheckedForPair = undefined;
    }
    coordinator.selectPair(nextPair);
    if (!effectivePairChanged && state.translationComplete) {
      this.environment.updateControls();
      return;
    }
    await this.checkAvailability(captureCoordinator.generation);
    if (!fromUserAction) {
      // A change saved by another companion window, or a re-resolved automatic
      // language, re-establishes availability here but only resumes a
      // translation this window already wanted; it records no new intent.
      await this.maybeTranslateAutomatically(
        captureCoordinator.generation,
        state.capturedPageIdentity?.url ?? '',
      );
      return;
    }
    if (state.availability === 'available') {
      await this.startTranslation(false, captureCoordinator.generation);
    } else if (state.availability === 'downloadable' || state.availability === 'downloading') {
      setStatus(UI_STRINGS.statusPairNeedsPack, 'warning');
    }
  }

  async checkAvailability(generation: number): Promise<void> {
    const state = this.#state;
    const { currency, coordinator, provider, setStatus, updateControls } = this.environment;
    const request = currency.begin('availability');
    const requestedSnapshot = state.snapshot;
    const pair = state.selectedPair();
    if (state.isLiveSourceOnlyMode) {
      coordinator.selectPair(undefined);
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      updateControls();
      return;
    }
    coordinator.selectPair(pair);
    if (!requestedSnapshot || !pair || this.currentTranslationFieldCount() === 0) {
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      if (!pair && requestedSnapshot) {
        setStatus(UI_STRINGS.statusChooseFromInconclusive, 'warning');
      }
      updateControls();
      return;
    }
    const checkedPairKey = availabilityPairKey(pair, generation);
    // The pair is recorded as checked only once a result passes the currency
    // guard. Recording it before the await let a superseded request leave the
    // pair marked as checked while availability stayed 'unavailable', which
    // disabled Translate and skipped automatic translation for that generation
    // because reconcileAfterCommit saw nothing to prepare.
    state.availabilityCheckedForPair = undefined;
    state.availability = 'unavailable';
    updateControls();
    if (pair.sourceLanguage === pair.targetLanguage) {
      state.availabilityCheckedForPair = checkedPairKey;
      state.availability = 'available';
      state.translationComplete = true;
      setStatus(UI_STRINGS.statusLanguagesMatchUnchanged, 'success');
      updateControls();
      return;
    }
    const isCurrent = () => this.#isCurrentAvailabilityRequest(
      request,
      requestedSnapshot,
      pair,
      generation,
    );
    try {
      const next = await provider.availability(pair);
      if (!isCurrent()) return;
      state.availabilityCheckedForPair = checkedPairKey;
      state.availability = next;
      switch (next) {
        case 'available':
          setStatus(this.environment.localizeTemplate(
            UI_STRINGS.statusReadyToTranslate,
            this.environment.localizeLanguageName(pair.sourceLanguage),
            this.environment.localizeLanguageName(pair.targetLanguage),
          ));
          break;
        case 'downloadable':
        case 'downloading':
          setStatus(UI_STRINGS.statusChooseTranslateOnce, 'warning');
          break;
        default:
          setStatus(this.environment.localizeTemplate(
            UI_STRINGS.statusPairUnavailable,
            this.environment.localizeLanguageName(pair.sourceLanguage),
            this.environment.localizeLanguageName(pair.targetLanguage),
          ), 'error');
      }
    } catch (error) {
      if (!isCurrent()) return;
      state.availabilityCheckedForPair = checkedPairKey;
      state.availability = 'unavailable';
      setStatus(readableError(error), 'error');
    } finally {
      if (isCurrent()) updateControls();
    }
  }

  async maybeTranslateAutomatically(generation: number, pageUrl: string): Promise<void> {
    const state = this.#state;
    const action = replicaViewTranslationAction(
      state.preferences.replicaViewMode,
      isAutoTranslationEnabled(state.preferences, pageUrl),
      state.translationDesired,
      state.availability,
    );
    if (action === 'translate') {
      await this.startTranslation(true, generation);
    } else if (action === 'needs-user-action') {
      this.environment.setStatus(UI_STRINGS.statusAutomaticNeedsOneClick, 'warning');
    }
  }

  // --- Page translation.

  startTranslation(automatic: boolean, generation: number): Promise<void> {
    const state = this.#state;
    if (state.isLiveSourceOnlyMode) return Promise.resolve();
    const requestedKey = state.currentTranslationTaskKey(generation);
    if (state.activeTranslationTask) {
      if (state.activeTranslationKey === requestedKey) return state.activeTranslationTask;
      state.activeAbortController?.abort();
      const previousTask = state.activeTranslationTask;
      return previousTask.catch(() => undefined).then(async () => {
        if (
          !this.environment.captureCoordinator.isCurrent(generation) ||
          state.currentTranslationTaskKey(generation) !== requestedKey
        ) return;
        await this.startTranslation(automatic, generation);
      });
    }
    const task = this.#runTranslation(automatic, generation);
    state.activeTranslationTask = task;
    state.activeTranslationKey = requestedKey;
    const settle = () => {
      if (state.activeTranslationTask === task) {
        state.activeTranslationTask = undefined;
        state.activeTranslationKey = undefined;
      }
    };
    void task.then(settle, settle);
    return task;
  }

  async #runTranslation(automatic: boolean, generation: number): Promise<void> {
    const state = this.#state;
    const { captureCoordinator, coordinator, setStatus, updateControls } = this.environment;
    const pair = state.selectedPair();
    const requestedSnapshot = state.snapshot;
    const identity = state.capturedPageIdentity;
    if (
      !pair ||
      !requestedSnapshot ||
      !identity ||
      state.isLiveSourceOnlyMode ||
      state.translationInFlight ||
      state.availability === 'unavailable' ||
      (automatic && state.availability !== 'available')
    ) return;
    if (pair.sourceLanguage === pair.targetLanguage) {
      coordinator.selectPair(pair);
      state.translationComplete = true;
      updateControls();
      return;
    }

    const abortController = new AbortController();
    state.activeAbortController = abortController;
    state.translationInFlight = true;
    this.environment.configureImageTranslation();
    state.translationDesired = true;
    state.translationComplete = false;
    this.environment.showProgress(UI_STRINGS.progressPreparingModel, 0, 1);
    updateControls();
    const stillCurrent = () =>
      captureCoordinator.isCurrent(generation) &&
      this.currentReplicaSnapshotMatches(requestedSnapshot) &&
      state.isCurrentTranslationPair(pair) &&
      !state.isLiveSourceOnlyMode;
    try {
      const tab = await this.environment.getTab(identity.tabId);
      assertSourceTabIsCurrent(tab, identity, state.requiresActiveSourceTab);
      if (!stillCurrent()) return;
      state.availability = 'available';
      state.availabilityCheckedForPair = availabilityPairKey(pair, generation);
      const result = await coordinator.translateCurrent(pair, {
        signal: abortController.signal,
        onDownloadProgress: (progress) =>
          this.environment.showProgress(
            UI_STRINGS.progressDownloadingPack,
            progress,
            1,
            [Math.round(progress * 100)],
          ),
        onProgress: (completed, total) =>
          this.environment.showProgress(
            UI_STRINGS.progressTranslating,
            completed,
            Math.max(1, total),
            [completed, total],
          ),
      });
      if (!stillCurrent()) return;
      state.translationComplete =
        result.total > 0 &&
        coordinator.isResultCurrent(result) &&
        isCompleteReplicaTranslationResult(result);
      this.environment.onPairPrepared();
      if (state.translationComplete) {
        setStatus(
          automatic
            ? UI_STRINGS.statusAutomaticComplete
            : UI_STRINGS.statusTranslationComplete,
          'success',
        );
      } else {
        // A partial summary is assembled from several catalogue entries, so it
        // cannot round-trip through the single-key localizer. Localize it for
        // display, but hand setStatus the English assembly for attention
        // routing and statusText (review findings F4/F7).
        setStatus(
          describePartialReplicaTranslation(
            result,
            UI_STRINGS.partialPrefixRemainsPartial,
            this.environment.localizeUi,
          ),
          'warning',
          describePartialReplicaTranslation(result, UI_STRINGS.partialPrefixRemainsPartial),
        );
      }
    } catch (error) {
      if (isAbortError(error) || abortController.signal.aborted) {
        if (stillCurrent()) {
          setStatus(UI_STRINGS.statusTranslationCancelledKept, 'warning');
        }
      } else if (!state.isLiveSourceOnlyMode) {
        setStatus(readableError(error), 'error');
      }
    } finally {
      this.environment.onTranslationSettled();
      if (state.activeAbortController === abortController) {
        state.activeAbortController = undefined;
      }
      state.translationInFlight = false;
      this.environment.configureImageTranslation();
      this.environment.hideProgress();
      updateControls();
    }
  }

  // --- Replica view mode.

  applyReplicaViewMode(previousMode: ReplicaViewMode, resumeTranslated = true): void {
    const state = this.#state;
    const { currency, coordinator, setStatus } = this.environment;
    if (previousMode === state.preferences.replicaViewMode) return;
    currency.supersede('availability');
    state.activeAbortController?.abort();
    coordinator.selectPair(undefined);
    state.translationComplete = false;
    state.availabilityCheckedForPair = undefined;
    this.environment.configureImageTranslation();
    if (state.isLiveSourceOnlyMode) {
      state.availability = 'unavailable';
      setStatus(UI_STRINGS.statusLiveSourceRestored, 'success');
    } else {
      setStatus(UI_STRINGS.statusTranslatedModeRestored);
      if (resumeTranslated) void this.resumeTranslatedReplicaMode();
    }
    this.environment.updateControls();
  }

  async resumeTranslatedReplicaMode(): Promise<void> {
    const state = this.#state;
    const { captureCoordinator, coordinator } = this.environment;
    const interrupted = state.activeTranslationTask;
    if (interrupted) await interrupted.catch(() => undefined);
    const identity = state.capturedPageIdentity;
    const generation = captureCoordinator.generation;
    if (state.isLiveSourceOnlyMode || !state.snapshot || !identity) return;
    const resolved = await this.resolveSelectedSourceLanguage(
      this.currentReplicaLanguageContext(),
    );
    const requestedSnapshot = state.snapshot;
    const stillCurrent = () =>
      !state.isLiveSourceOnlyMode &&
      requestedSnapshot !== undefined &&
      this.currentReplicaSnapshotMatches(requestedSnapshot) &&
      state.capturedPageIdentity === identity &&
      captureCoordinator.isCurrent(generation);
    if (!resolved || !stillCurrent()) return;
    const pair = state.selectedPair();
    coordinator.selectPair(pair);
    await this.checkAvailability(generation);
    if (!pair || !state.isCurrentTranslationPair(pair) || !stillCurrent()) return;
    await this.maybeTranslateAutomatically(generation, identity.url);
  }

  // --- Private.

  #mirrorLanguageSample(): string {
    return buildBoundedLanguageSample(
      replicaRecordSources(this.#state.snapshot?.records ?? []),
    );
  }

  #pendingImageEvidenceIsCurrent(proposal: PendingAutoImageLanguageEvidence): boolean {
    const state = this.#state;
    return (
      proposal.configurationKey === this.environment.autoImageLanguageConfigurationKey() &&
      this.currentReplicaDocumentMatches(proposal.document) &&
      proposal.replayLease === state.snapshot?.replayLease &&
      proposal.identity === state.capturedPageIdentity &&
      this.environment.captureCoordinator.isCurrent(proposal.generation)
    );
  }

  async #reconcileAutoDetectedImageLanguage(
    language: SupportedLanguage,
    resolution: CurrencyToken,
  ): Promise<void> {
    const state = this.#state;
    const { currency, captureCoordinator, coordinator } = this.environment;
    const imageLanguageStands = () =>
      currency.isCurrent(resolution) &&
      state.preferences.sourceLanguage === 'auto' &&
      state.resolvedSourceLanguage === language &&
      state.resolvedImageLanguageDocument !== undefined &&
      this.currentReplicaDocumentMatches(state.resolvedImageLanguageDocument);
    if (!imageLanguageStands()) return;
    const generation = captureCoordinator.generation;
    const identity = state.capturedPageIdentity;
    const requestedSnapshot = state.snapshot;
    const pair = state.selectedPair();
    if (!state.isLiveSourceOnlyMode) coordinator.selectPair(pair);
    this.environment.configureImageTranslation();
    if (
      !currency.isCurrent(resolution) ||
      !requestedSnapshot ||
      !identity ||
      !pair ||
      !captureCoordinator.isCurrent(generation)
    ) {
      this.environment.updateControls();
      return;
    }
    await this.checkAvailability(generation);
    if (
      !imageLanguageStands() ||
      !this.currentReplicaSnapshotMatches(requestedSnapshot) ||
      state.capturedPageIdentity !== identity ||
      !captureCoordinator.isCurrent(generation) ||
      !state.isCurrentTranslationPair(pair)
    ) return;
    await this.maybeTranslateAutomatically(generation, identity.url);
  }

  #isCurrentAvailabilityRequest(
    request: CurrencyToken,
    requestedSnapshot: ReplicaTranslationSnapshot,
    pair: TranslationPair,
    generation: number,
  ): boolean {
    const state = this.#state;
    const currentPair = state.selectedPair();
    return isAvailabilityRequestCurrent({
      replicaViewMode: state.preferences.replicaViewMode,
      requestMatches: this.environment.currency.isCurrent(request),
      generationMatches: this.environment.captureCoordinator.isCurrent(generation),
      snapshotMatches: this.currentReplicaSnapshotMatches(requestedSnapshot),
      pairMatches: Boolean(
        currentPair &&
          currentPair.sourceLanguage === pair.sourceLanguage &&
          currentPair.targetLanguage === pair.targetLanguage,
      ),
    });
  }
}

/**
 * Builds the partial-projection status from catalogue frames. `prefix` is a
 * catalogue string; `localize` returns the localized frame for each piece,
 * which `formatUiTemplate` then fills with the counts.
 */
export function describePartialReplicaTranslation(
  result: ReplicaTranslationRunResult,
  prefix: string,
  localize: (english: string) => string = (english) => english,
): string {
  const details: string[] = [];
  if (result.failed > 0) {
    details.push(formatUiTemplate(localize(UI_STRINGS.partialFailed), [result.failed]));
  }
  if (result.stale > 0) {
    details.push(formatUiTemplate(localize(UI_STRINGS.partialStale), [result.stale]));
  }
  if (result.skipped > 0) {
    details.push(formatUiTemplate(localize(UI_STRINGS.partialSuperseded), [result.skipped]));
  }
  if (result.overflow > 0) {
    details.push(formatUiTemplate(localize(UI_STRINGS.partialOverflow), [result.overflow]));
  }
  if (result.completed < result.total && details.length === 0) {
    details.push(formatUiTemplate(
      localize(UI_STRINGS.partialNotProjected),
      [result.total - result.completed],
    ));
  }
  const summary = details.join(', ') || localize(UI_STRINGS.partialNoneProjected);
  return formatUiTemplate(localize(UI_STRINGS.partialSummary), [localize(prefix), summary]);
}

function* replicaRecordSources(
  records: readonly { readonly source: string }[],
): Generator<string> {
  for (const record of records) yield record.source;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
