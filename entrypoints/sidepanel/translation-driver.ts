import {
  isAvailabilityRequestCurrent,
  replicaViewTranslationAction,
  type LatestWorkCoordinator,
} from '../../lib/companion-lifecycle';
import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import { resolveSourceLanguage } from '../../lib/language-detection';
import {
  assertSnapshotIsCurrent,
  readableError,
  type PageTabLike,
} from '../../lib/page-identity';
import type { PageSnapshot } from '../../lib/page-snapshot';
import {
  isAutoTranslationEnabled,
  type CompanionViewSettingsPatch,
  type ReplicaViewMode,
} from '../../lib/preferences';
import type { ReplicaSurfaceRouter } from '../../lib/replica/replica-surface-router';
import { buildBoundedLanguageSample } from '../../lib/translation/language-sample';
import { snapshotWithLiveDocumentLanguage } from '../../lib/translation/replica-translation-lifecycle';
import {
  isCompleteReplicaTranslationResult,
  splitBoundaryWhitespace,
  type ReplicaSourceCommit,
  type ReplicaTranslationCoordinator,
  type ReplicaTranslationRunResult,
} from '../../lib/translation/replica-translation-coordinator';
import type { TranslationMemory } from '../../lib/translation/translation-memory';
import { translateWithSession } from '../../lib/translation-pipeline';
import {
  languageName,
  type SupportedLanguage,
  type TranslationPair,
  type TranslationProvider,
  type TranslationSession,
} from '../../lib/translation-provider';
import { resetVisualMirrorText, translateVisualMirror } from '../../lib/visual-renderer';
import {
  availabilityPairKey,
  sameTranslationPair,
  type CaptureRequest,
  type CompanionState,
} from './companion-state';
import type { Currency, CurrencyToken } from './currency';
import type { MirrorView } from './mirror-view';

export interface LiveLanguageContext {
  documentLanguage?: string | undefined;
  visibleText: string;
  preserveOnUnknown: boolean;
}

export type LanguageDetector = NonNullable<Parameters<typeof resolveSourceLanguage>[2]>;

export interface TranslationDriverEnvironment {
  readonly state: CompanionState;
  readonly currency: Currency;
  readonly captureCoordinator: Pick<LatestWorkCoordinator<CaptureRequest>, 'generation' | 'isCurrent'>;
  readonly provider: TranslationProvider;
  readonly translationMemory: TranslationMemory;
  readonly mirrorView: Pick<
    MirrorView,
    'root' | 'languageSample' | 'translationFieldCount' | 'resetTextIfPresent'
  >;
  readonly replicaSurface: Pick<ReplicaSurfaceRouter, 'snapshot'>;
  readonly replicaTranslation: Pick<
    ReplicaTranslationCoordinator,
    'selectPair' | 'translateCurrent' | 'isResultCurrent'
  >;
  readonly detectLanguage: LanguageDetector;
  readonly getTab: (tabId: number) => Promise<PageTabLike>;
  readonly usesReplicaTranslationProjection: () => boolean;
  /** Hands presentation back to the legacy view; true when a rebuild is needed. */
  readonly releaseReplicaPresentationForLegacyWork: () => boolean;
  readonly queueCapture: (request: CaptureRequest) => void;
  readonly abortAndRequeueLiveDelta: () => void;
  readonly processPendingLiveUpdate: () => Promise<void>;
  readonly commitViewPreferencePatch: (patch: CompanionViewSettingsPatch) => Promise<boolean>;
  readonly renderDetectedLanguage: (text: string) => void;
  /** The resolved source language changed; dependent panels refresh. */
  readonly onLanguageResolved: () => void;
  readonly invalidateComposer: () => void;
  readonly configureImageTranslation: () => void;
  readonly setStatus: (message: string, tone?: CompanionStatusTone) => void;
  readonly showProgress: (label: string, value: number, max: number) => void;
  readonly hideProgress: () => void;
  readonly updateControls: () => void;
  readonly logTranslationCache: () => void;
}

/**
 * Resolves the source language, checks translator availability for the pair,
 * and runs page translation over either the isolated replica or the legacy
 * mirror. Every asynchronous step re-validates the capture generation, the
 * snapshot identity, the pair and the view mode before touching state.
 */
export class TranslationDriver {
  constructor(private readonly environment: TranslationDriverEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  /** Re-detects the source language; false when a newer snapshot or preference superseded it. */
  async resolveSelectedSourceLanguage(liveContext?: LiveLanguageContext): Promise<boolean> {
    const state = this.#state;
    if (!state.snapshot) {
      state.resolvedSourceLanguage = undefined;
      this.environment.onLanguageResolved();
      return true;
    }
    if (liveContext) {
      // Keep the snapshot identity stable unless the language really changed;
      // an in-flight availability check is discarded when the identity moves.
      state.snapshot = snapshotWithLiveDocumentLanguage(
        state.snapshot,
        liveContext.documentLanguage,
      );
    }
    const requestedSnapshot = state.snapshot;
    const requestedPreference = state.preferences.sourceLanguage;
    const previousLanguage = state.resolvedSourceLanguage;
    const detectionSnapshot = liveContext
      ? { ...requestedSnapshot, items: [] }
      : requestedSnapshot;
    const detected = await resolveSourceLanguage(
      requestedPreference,
      detectionSnapshot,
      this.environment.detectLanguage,
      liveContext?.visibleText ?? this.#mirrorLanguageSample(),
    );
    if (
      state.snapshot !== requestedSnapshot ||
      state.preferences.sourceLanguage !== requestedPreference
    ) return false;
    state.resolvedSourceLanguage =
      detected.language ??
      (liveContext?.preserveOnUnknown ? previousLanguage : undefined);
    this.environment.renderDetectedLanguage(
      state.resolvedSourceLanguage
        ? requestedPreference === 'auto'
          ? detected.language
            ? `Detected ${languageName(state.resolvedSourceLanguage)} from ${detected.source === 'html' ? 'the page language' : 'visible page text'}.`
            : `Using the previously detected ${languageName(state.resolvedSourceLanguage)} source language.`
          : ''
        : 'The page language could not be detected. Choose a From language.',
    );
    this.environment.onLanguageResolved();
    return true;
  }

  #mirrorLanguageSample(): string {
    if (this.environment.usesReplicaTranslationProjection()) {
      return buildBoundedLanguageSample(
        replicaRecordSources(this.environment.replicaSurface.snapshot()?.records ?? []),
      );
    }
    return this.environment.mirrorView.languageSample();
  }

  currentTranslationFieldCount(): number {
    return this.environment.usesReplicaTranslationProjection()
      ? this.environment.replicaSurface.snapshot()?.records.filter(
        ({ source }) => source.trim().length > 0,
      ).length ?? 0
      : this.environment.mirrorView.translationFieldCount();
  }

  /** A replica commit changed the page text or its language. */
  async reconcileReplicaTranslationAfterCommit(
    commit: ReplicaSourceCommit,
    refresh: CurrencyToken,
    refreshDetectedLanguage: boolean,
    prepareForNewText: boolean,
  ): Promise<void> {
    const state = this.#state;
    const { currency, captureCoordinator } = this.environment;
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
      this.environment.replicaTranslation.selectPair(nextPair);
    }
    const expectedAvailabilityKey = nextPair
      ? availabilityPairKey(nextPair, generation)
      : undefined;
    // A language refresh can replace the snapshot identity and discard an
    // in-flight availability check, so any refreshing commit re-establishes
    // the pair's availability when it is not yet recorded for this generation.
    const needsPreparation =
      (prepareForNewText || refreshDetectedLanguage) &&
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

  /** The user chose From and To languages in this window. */
  async changeLanguages(
    sourceLanguage: 'auto' | SupportedLanguage,
    targetLanguage: SupportedLanguage,
  ): Promise<void> {
    const state = this.#state;
    const needsFreshCapture = this.environment.releaseReplicaPresentationForLegacyWork();
    state.activeAbortController?.abort();
    this.environment.abortAndRequeueLiveDelta();
    this.environment.invalidateComposer();
    if (!state.isLiveSourceOnlyMode) state.translationDesired = true;
    state.translationComplete = false;
    state.availabilityCheckedForPair = undefined;
    this.environment.mirrorView.resetTextIfPresent();
    await this.environment.commitViewPreferencePatch({ sourceLanguage, targetLanguage });
    if (needsFreshCapture) {
      const identity = state.followedOrCapturedIdentity;
      if (identity) {
        this.environment.queueCapture({ identity, reason: 'preference' });
        return;
      }
    }
    await this.applyLanguagePreferences(true);
  }

  async applyLanguagePreferences(fromUserAction: boolean): Promise<void> {
    const state = this.#state;
    const { captureCoordinator, replicaTranslation, setStatus } = this.environment;
    if (!state.snapshot) return;
    await this.resolveSelectedSourceLanguage();
    if (state.isLiveSourceOnlyMode) {
      replicaTranslation.selectPair(undefined);
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      setStatus(
        'Live source only is active. Language choices are saved for translated mode.',
        'success',
      );
      this.environment.updateControls();
      return;
    }
    replicaTranslation.selectPair(state.selectedPair());
    await this.checkAvailability(captureCoordinator.generation);
    if (state.availability === 'available') {
      await this.startTranslation(!fromUserAction, captureCoordinator.generation);
    } else if (state.availability === 'downloadable' || state.availability === 'downloading') {
      setStatus('This language pair needs its on-device pack. Choose Translate once to prepare it.', 'warning');
    }
  }

  async checkAvailability(generation: number): Promise<void> {
    const state = this.#state;
    const { currency, provider, replicaTranslation, mirrorView, setStatus, updateControls } =
      this.environment;
    const request = currency.begin('availability');
    const requestedSnapshot = state.snapshot;
    const pair = state.selectedPair();
    if (state.isLiveSourceOnlyMode) {
      replicaTranslation.selectPair(undefined);
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      updateControls();
      return;
    }
    replicaTranslation.selectPair(pair);
    if (
      !requestedSnapshot ||
      !mirrorView.root ||
      !pair ||
      this.currentTranslationFieldCount() === 0
    ) {
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      if (!pair && requestedSnapshot) {
        setStatus('Choose a From language because automatic detection was inconclusive.', 'warning');
      }
      updateControls();
      return;
    }
    const checkedPairKey = availabilityPairKey(pair, generation);
    // The pair is recorded as checked only once a result is accepted. Recording
    // it before the await let a superseded request leave the pair marked as
    // checked while availability stayed 'unavailable', which disabled Translate
    // until a manual rebuild.
    state.availabilityCheckedForPair = undefined;
    state.availability = 'unavailable';
    updateControls();
    if (pair.sourceLanguage === pair.targetLanguage) {
      state.availabilityCheckedForPair = checkedPairKey;
      state.availability = 'available';
      mirrorView.resetTextIfPresent();
      state.translationComplete = true;
      setStatus('The source and target languages match, so the original text is unchanged.', 'success');
      updateControls();
      return;
    }
    try {
      const next = await provider.availability(pair);
      if (!this.#isCurrentAvailabilityRequest(request, requestedSnapshot, pair, generation)) return;
      state.availabilityCheckedForPair = checkedPairKey;
      state.availability = next;
      switch (next) {
        case 'available':
          setStatus(`Ready to translate ${languageName(pair.sourceLanguage)} to ${languageName(pair.targetLanguage)} on-device.`);
          break;
        case 'downloadable':
        case 'downloading':
          setStatus('Choose Translate once so Chrome can prepare this on-device language pair.', 'warning');
          break;
        default:
          setStatus(`${languageName(pair.sourceLanguage)} to ${languageName(pair.targetLanguage)} is unavailable on this device.`, 'error');
      }
    } catch (error) {
      if (!this.#isCurrentAvailabilityRequest(request, requestedSnapshot, pair, generation)) return;
      state.availabilityCheckedForPair = checkedPairKey;
      state.availability = 'unavailable';
      setStatus(readableError(error), 'error');
    } finally {
      if (this.#isCurrentAvailabilityRequest(request, requestedSnapshot, pair, generation)) {
        updateControls();
      }
    }
  }

  #isCurrentAvailabilityRequest(
    request: CurrencyToken,
    requestedSnapshot: PageSnapshot,
    pair: TranslationPair,
    generation: number,
  ): boolean {
    const state = this.#state;
    const currentPair = state.selectedPair();
    return isAvailabilityRequestCurrent({
      replicaViewMode: state.preferences.replicaViewMode,
      requestMatches: this.environment.currency.isCurrent(request),
      generationMatches: this.environment.captureCoordinator.isCurrent(generation),
      snapshotMatches: state.snapshot === requestedSnapshot,
      pairMatches: Boolean(
        currentPair &&
          currentPair.sourceLanguage === pair.sourceLanguage &&
          currentPair.targetLanguage === pair.targetLanguage,
      ),
    });
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
      this.environment.setStatus('Automatic translation is ready, but this pair needs one Translate click to prepare its local pack.', 'warning');
    }
  }

  /** Starts (or joins) the translation task for the current pair and generation. */
  startTranslation(automatic: boolean, generation: number): Promise<void> {
    const state = this.#state;
    const { captureCoordinator } = this.environment;
    if (state.isLiveSourceOnlyMode) return Promise.resolve();
    const needsFreshCapture = this.environment.releaseReplicaPresentationForLegacyWork();
    if (needsFreshCapture) {
      state.translationDesired = true;
      const identity = state.followedOrCapturedIdentity;
      if (identity) this.environment.queueCapture({ identity, reason: 'desynchronized' });
      return Promise.resolve();
    }
    const requestedKey = state.currentTranslationTaskKey(generation);
    if (state.activeTranslationTask) {
      if (state.activeTranslationKey === requestedKey) return state.activeTranslationTask;
      state.activeAbortController?.abort();
      const previousTask = state.activeTranslationTask;
      return previousTask.catch(() => undefined).then(async () => {
        if (
          !captureCoordinator.isCurrent(generation) ||
          state.currentTranslationTaskKey(generation) !== requestedKey
        ) return;
        await this.startTranslation(automatic, generation);
      });
    }
    const task = this.#runTranslation(automatic, generation);
    state.activeTranslationTask = task;
    state.activeTranslationKey = requestedKey;
    const settle = (): void => {
      if (state.activeTranslationTask === task) {
        state.activeTranslationTask = undefined;
        state.activeTranslationKey = undefined;
      }
      void this.environment.processPendingLiveUpdate();
    };
    void task.then(settle, settle);
    return task;
  }

  async #runTranslation(automatic: boolean, generation: number): Promise<void> {
    const state = this.#state;
    const {
      captureCoordinator,
      provider,
      replicaTranslation,
      mirrorView,
      setStatus,
      showProgress,
      updateControls,
    } = this.environment;
    const pair = state.selectedPair();
    const root = mirrorView.root;
    const identity = state.capturedPageIdentity;
    if (
      !pair ||
      !root ||
      !identity ||
      state.isLiveSourceOnlyMode ||
      state.translationInFlight ||
      state.availability === 'unavailable' ||
      (automatic && state.availability !== 'available')
    ) return;
    if (pair.sourceLanguage === pair.targetLanguage) {
      if (this.environment.usesReplicaTranslationProjection()) {
        replicaTranslation.selectPair(pair);
      }
      resetVisualMirrorText(root);
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
    showProgress('Preparing Chrome\'s on-device language model…', 0, 1);
    updateControls();
    let session: TranslationSession | undefined;
    try {
      const tab = await this.environment.getTab(identity.tabId);
      assertSnapshotIsCurrent(tab, identity, state.requiresActiveSourceTab);
      if (
        !captureCoordinator.isCurrent(generation) ||
        mirrorView.root !== root ||
        !state.isCurrentTranslationPair(pair) ||
        state.isLiveSourceOnlyMode
      ) return;
      state.availability = 'available';
      state.availabilityCheckedForPair = availabilityPairKey(pair, generation);
      const result = this.environment.usesReplicaTranslationProjection()
        ? await replicaTranslation.translateCurrent(pair, {
          signal: abortController.signal,
          onDownloadProgress: (progress) =>
            showProgress(`Downloading language pack… ${Math.round(progress * 100)}%`, progress, 1),
          onProgress: (completed, total) =>
            showProgress(`Translating ${completed} of ${total}…`, completed, Math.max(1, total)),
        })
        : await (async () => {
          session = await provider.createSession(pair, {
            signal: abortController.signal,
            onDownloadProgress: (progress) =>
              showProgress(`Downloading language pack… ${Math.round(progress * 100)}%`, progress, 1),
          });
          abortController.signal.throwIfAborted();
          return translateVisualMirror(
            root,
            (source, signal) => this.translateCached(
              pair,
              session as TranslationSession,
              source,
              signal,
            ),
            {
              signal: abortController.signal,
              onProgress: (completed, total) =>
                showProgress(`Translating ${completed} of ${total}…`, completed, Math.max(1, total)),
            },
          );
        })();
      if (
        !captureCoordinator.isCurrent(generation) ||
        mirrorView.root !== root ||
        !state.isCurrentTranslationPair(pair) ||
        state.isLiveSourceOnlyMode
      ) return;
      if (this.environment.usesReplicaTranslationProjection()) {
        const replicaResult = result as ReplicaTranslationRunResult;
        state.translationComplete =
          replicaResult.total > 0 &&
          replicaTranslation.isResultCurrent(replicaResult) &&
          isCompleteReplicaTranslationResult(replicaResult);
        setStatus(
          state.translationComplete
            ? automatic
              ? 'Automatic translation is complete and live updates will translate as they arrive.'
              : 'Translation is complete and live updates will translate as they arrive.'
            : describePartialReplicaTranslation(replicaResult, 'Translation remains partial'),
          state.translationComplete ? 'success' : 'warning',
        );
      } else {
        state.translationComplete = result.failed === 0;
        setStatus(
          result.failed
            ? `${result.failed} text segment(s) could not be translated; the original remains for those parts.`
            : automatic
              ? 'Automatic translation is complete and live updates will translate as they arrive.'
              : 'Translation is complete and live updates will translate as they arrive.',
          result.failed ? 'warning' : 'success',
        );
      }
    } catch (error) {
      if (isAbortError(error) || abortController.signal.aborted) {
        if (
          !state.isLiveSourceOnlyMode &&
          captureCoordinator.isCurrent(generation) &&
          mirrorView.root === root &&
          state.isCurrentTranslationPair(pair)
        ) {
          setStatus('Translation cancelled. Existing translated text was kept.', 'warning');
        }
      } else if (!state.isLiveSourceOnlyMode) {
        setStatus(readableError(error), 'error');
      }
    } finally {
      session?.destroy();
      this.environment.logTranslationCache();
      if (state.activeAbortController === abortController) state.activeAbortController = undefined;
      state.translationInFlight = false;
      this.environment.configureImageTranslation();
      this.environment.hideProgress();
      updateControls();
    }
  }

  async translateCached(
    pair: TranslationPair,
    session: TranslationSession,
    source: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.translateRemembered(
      pair,
      source,
      (core) => translateWithSession(session, core, signal),
    );
  }

  /** Translates through the memory, keeping the segment's boundary whitespace. */
  async translateRemembered(
    pair: TranslationPair,
    source: string,
    load: (core: string) => Promise<string>,
  ): Promise<string> {
    const boundary = splitBoundaryWhitespace(source);
    if (!boundary.core) return source;
    const translated = await this.environment.translationMemory.getOrCreate(
      {
        provider: 'chrome-translator-v1',
        pair,
      },
      boundary.core,
      () => load(boundary.core),
    );
    return `${boundary.leading}${translated.trim()}${boundary.trailing}`;
  }

  // --- Replica view mode.

  async changeReplicaViewMode(replicaViewMode: ReplicaViewMode): Promise<void> {
    const state = this.#state;
    if (replicaViewMode === state.preferences.replicaViewMode) return;
    const previousMode = state.preferences.replicaViewMode;
    // commitViewPreferencePatch applies the validated preference optimistically
    // before its first await, so projection gates close immediately.
    const save = this.environment.commitViewPreferencePatch({ replicaViewMode });
    this.applyReplicaViewMode(previousMode, false);
    await save;
    if (state.preferences.replicaViewMode !== replicaViewMode) {
      this.applyReplicaViewMode(replicaViewMode);
      return;
    }
    if (replicaViewMode === 'translated' && !state.isLiveSourceOnlyMode) {
      await this.resumeTranslatedReplicaMode();
    }
  }

  applyReplicaViewMode(previousMode: ReplicaViewMode, resumeTranslated = true): void {
    const state = this.#state;
    const { setStatus } = this.environment;
    if (previousMode === state.preferences.replicaViewMode) return;
    this.environment.currency.supersede('availability');
    state.activeAbortController?.abort();
    this.environment.abortAndRequeueLiveDelta();
    this.environment.replicaTranslation.selectPair(undefined);
    this.environment.mirrorView.resetTextIfPresent();
    state.translationComplete = false;
    state.availabilityCheckedForPair = undefined;
    this.environment.configureImageTranslation();
    if (state.isLiveSourceOnlyMode) {
      state.availability = 'unavailable';
      setStatus(
        'Live source only is active. The current mirror remains live and all translation overlays were removed.',
        'success',
      );
    } else {
      setStatus('Translated mode restored. Preparing the saved language settings…');
      if (resumeTranslated) void this.resumeTranslatedReplicaMode();
    }
    this.environment.updateControls();
  }

  async resumeTranslatedReplicaMode(): Promise<void> {
    const state = this.#state;
    const { captureCoordinator } = this.environment;
    const interrupted = state.activeTranslationTask;
    if (interrupted) await interrupted.catch(() => undefined);
    const identity = state.capturedPageIdentity;
    const generation = captureCoordinator.generation;
    if (state.isLiveSourceOnlyMode || !state.snapshot || !identity) return;
    const resolved = await this.resolveSelectedSourceLanguage(this.#currentReplicaLanguageContext());
    const requestedSnapshot = state.snapshot;
    if (
      !resolved ||
      state.isLiveSourceOnlyMode ||
      !requestedSnapshot ||
      state.snapshot !== requestedSnapshot ||
      state.capturedPageIdentity !== identity ||
      !captureCoordinator.isCurrent(generation)
    ) return;
    const pair = state.selectedPair();
    this.environment.replicaTranslation.selectPair(pair);
    await this.checkAvailability(generation);
    if (
      state.isLiveSourceOnlyMode ||
      !pair ||
      !state.isCurrentTranslationPair(pair) ||
      state.snapshot !== requestedSnapshot ||
      state.capturedPageIdentity !== identity ||
      !captureCoordinator.isCurrent(generation)
    ) return;
    await this.maybeTranslateAutomatically(generation, identity.url);
  }

  #currentReplicaLanguageContext(): LiveLanguageContext | undefined {
    const current = this.environment.replicaSurface.snapshot();
    if (!current) return undefined;
    return {
      ...(current.documentLanguage ? { documentLanguage: current.documentLanguage } : {}),
      visibleText: buildBoundedLanguageSample(replicaRecordSources(current.records)),
      preserveOnUnknown: true,
    };
  }
}

export function describePartialReplicaTranslation(
  result: ReplicaTranslationRunResult,
  prefix: string,
): string {
  const details: string[] = [];
  if (result.failed > 0) details.push(`${result.failed} failed`);
  if (result.stale > 0) details.push(`${result.stale} became stale`);
  if (result.skipped > 0) details.push(`${result.skipped} were superseded`);
  if (result.overflow > 0) {
    details.push(`${result.overflow} exceeded the bounded local queue`);
  }
  if (result.completed < result.total && details.length === 0) {
    details.push(`${result.total - result.completed} were not projected`);
  }
  return `${prefix}: ${details.join(', ') || 'no current text was projected'}. Original text remains for those segments; choose Translate page to retry.`;
}

function* replicaRecordSources(
  records: readonly { readonly source: string }[],
): Generator<string> {
  for (const record of records) yield record.source;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
