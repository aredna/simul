import {
  autoImageLanguageConfigurationKey,
  shouldClearAutoImageLanguageForDocument,
  shouldClearAutoImageLanguageResolution,
} from '../../lib/language-detection';
import {
  ACCESSIBILITY_TEXT_METHOD_ID,
  enabledOcrProviderOrder,
  type ImageReadingMethodId,
} from '../../lib/ocr/image-reading-methods';
import type { ImageTranslationConfiguration } from '../../lib/ocr/image-translation-controller';
import type { ImageTextProviderId } from '../../lib/ocr/known-provider-ids';
import { readEnsureOcrHostResponse } from '../../lib/ocr/offscreen-protocol';
import {
  createProbeOcrProviderCommand,
  readProbeOcrProviderResponse,
  type OcrProviderRuntimeStatus,
} from '../../lib/ocr/provider-status-protocol';
import {
  runtimeReadyOcrProviderOrder,
  shouldRetryOcrProviderProbe,
} from '../../lib/ocr/runtime-provider-readiness';
import {
  REPLICA_READ_SCOPE_SETUP_VERSION,
  replicaReadScopeFingerprint,
  type ReplicaReadScope,
} from '../../lib/replica/read-scope-policy';
import type { CompanionState } from './companion-state';
import type { TranslationDriver } from './translation-driver';

export const OCR_PROBE_RETRY_DELAY_MS = 1_000;

export interface ImageTranslationConfigEnvironment {
  readonly state: CompanionState;
  readonly controller: {
    configure(configuration: ImageTranslationConfiguration): void;
  };
  readonly currentReplicaReadScope: () => ReplicaReadScope;
  readonly translationDriver: Pick<
    TranslationDriver,
    'currentReplicaDocumentMatches' | 'clearAutoImageLanguageResolution'
  >;
  /** Provider ids compiled into this build. */
  readonly compiledProviderIds: readonly ImageTextProviderId[];
  /** The saved provider order filtered to compiled, enabled providers. */
  readonly compiledProviderOrder: (
    order: readonly ImageTextProviderId[],
    disabledProviderIds?: readonly ImageTextProviderId[],
  ) => readonly ImageTextProviderId[];
  readonly renderImagePanel: () => void;
  /** Sends a runtime message to the background worker. */
  readonly sendMessage: (message: unknown) => Promise<unknown>;
  readonly scheduleRetry?: (callback: () => void, delayMs: number) => void;
}

/**
 * Derives the image-translation controller's configuration from the
 * preferences, the image-access grant, the runtime provider probes and the
 * effective read scope, and retires image-derived language evidence whose
 * configuration key no longer matches. Also owns the TextDetector probe.
 */
export class ImageTranslationConfig {
  constructor(private readonly environment: ImageTranslationConfigEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  configure(): void {
    const state = this.#state;
    const { translationDriver } = this.environment;
    const readScope = this.environment.currentReplicaReadScope();
    const disabledMethodIds = this.#disabledMethodIds();
    const enabledMethodIds = new Set(
      state.preferences.imageReadingMethodOrder.filter((method) =>
        !disabledMethodIds.includes(method),
      ),
    );
    const usableProviderOrder = this.#usableProviderOrder(disabledMethodIds);
    const routedProviderOrder = state.imageCaptureAccess === 'granted'
      ? usableProviderOrder
      : [];
    const nextAutoLanguageConfigurationKey = autoImageLanguageConfigurationKey({
      providerOrder: routedProviderOrder,
      enabledMethodOrder: this.#enabledAutoImageLanguageMethodOrder(
        disabledMethodIds,
        routedProviderOrder,
      ),
      minimumConfidence: state.preferences.ocrMinimumConfidence,
      policyFingerprint: replicaReadScopeFingerprint(readScope),
      controlImages: readScope.controlImages,
    });
    if (shouldClearAutoImageLanguageForDocument(
      state.resolvedSourceLanguageOrigin,
      state.resolvedImageLanguageDocument !== undefined &&
        translationDriver.currentReplicaDocumentMatches(state.resolvedImageLanguageDocument),
    )) {
      translationDriver.clearAutoImageLanguageResolution();
    }
    if (shouldClearAutoImageLanguageResolution(
      state.resolvedSourceLanguageOrigin,
      state.resolvedImageLanguageConfigurationKey,
      nextAutoLanguageConfigurationKey,
    )) {
      translationDriver.clearAutoImageLanguageResolution();
    }
    this.environment.controller.configure({
      enabled:
        state.preferences.imageTranslationEnabled &&
        !state.isLiveSourceOnlyMode &&
        (
          enabledMethodIds.has(ACCESSIBILITY_TEXT_METHOD_ID) ||
          (state.imageCaptureAccess === 'granted' && usableProviderOrder.length > 0)
        ),
      scanPolicy: state.preferences.imageScanPolicy,
      skipSmallImages: state.preferences.skipSmallImages,
      providerOrder: routedProviderOrder,
      methodOrder: state.preferences.imageReadingMethodOrder,
      disabledMethodIds,
      resetEpoch: state.preferences.resetRevision,
      policyFingerprint: replicaReadScopeFingerprint(readScope),
      controlImages: readScope.controlImages,
      ocrMinimumConfidence: state.preferences.ocrMinimumConfidence,
      sourceLanguage: state.preferences.sourceLanguage,
      ...(state.resolvedSourceLanguage
        ? { detectedSourceLanguage: state.resolvedSourceLanguage }
        : {}),
      pageLanguageResolutionPending: state.pageLanguageResolutionPending,
      targetLanguage: state.preferences.targetLanguage,
      translationIdle: !state.translationInFlight,
    });
  }

  /** Pixel OCR providers that are enabled and ready in this runtime. */
  usablePixelProviderOrder(): readonly ImageTextProviderId[] {
    const state = this.#state;
    return runtimeReadyOcrProviderOrder(
      this.environment.compiledProviderOrder(
        enabledOcrProviderOrder(
          state.preferences.imageReadingMethodOrder,
          state.preferences.disabledImageReadingMethodIds,
        ),
        state.preferences.disabledImageTextProviderIds,
      ),
      state.ocrProviderRuntimeStatuses,
    );
  }

  /** The key image-derived language evidence is bound to. */
  autoImageLanguageConfigurationKey(): string {
    const state = this.#state;
    const readScope = this.environment.currentReplicaReadScope();
    const disabledMethodIds = this.#disabledMethodIds();
    const usableProviderOrder = state.imageCaptureAccess === 'granted'
      ? this.#usableProviderOrder(disabledMethodIds)
      : [];
    return autoImageLanguageConfigurationKey({
      providerOrder: usableProviderOrder,
      enabledMethodOrder: this.#enabledAutoImageLanguageMethodOrder(
        disabledMethodIds,
        usableProviderOrder,
      ),
      minimumConfidence: state.preferences.ocrMinimumConfidence,
      policyFingerprint: replicaReadScopeFingerprint(readScope),
      controlImages: readScope.controlImages,
    });
  }

  /** Probes the TextDetector runtime once, with a single delayed retry. */
  async refreshProviderRuntimeStatuses(): Promise<void> {
    const state = this.#state;
    if (!this.environment.compiledProviderIds.includes('chrome-text-detector')) return;
    state.ocrProviderRuntimeStatuses.set('chrome-text-detector', 'checking');
    this.environment.renderImagePanel();
    this.configure();
    let status: OcrProviderRuntimeStatus;
    try {
      const ensureRaw = await this.environment.sendMessage({
        kind: 'simul:ocr-v1:ensure-host',
        version: 1,
        resetEpoch: state.preferences.resetRevision,
      });
      const ready = readEnsureOcrHostResponse(ensureRaw);
      if (!ready?.ready) throw new Error('OCR host unavailable.');
      const raw = await this.environment.sendMessage(
        createProbeOcrProviderCommand('chrome-text-detector'),
      );
      const response = readProbeOcrProviderResponse(raw, 'chrome-text-detector');
      if (!response) throw new Error('Invalid OCR provider probe response.');
      status = response.provider;
    } catch {
      status = Object.freeze({
        status: 'unavailable',
        providerId: 'chrome-text-detector',
        reason: 'probe-failed',
      });
    }
    state.ocrProviderRuntimeStatuses.set('chrome-text-detector', status);
    this.environment.renderImagePanel();
    this.configure();
    if (shouldRetryOcrProviderProbe(status, state.textDetectorProbeRetryUsed)) {
      state.textDetectorProbeRetryUsed = true;
      (this.environment.scheduleRetry ?? setTimeout)(() => {
        void this.refreshProviderRuntimeStatuses();
      }, OCR_PROBE_RETRY_DELAY_MS);
    }
  }

  /** Accessibility text stays off until the read-scope setup has completed. */
  #disabledMethodIds(): readonly ImageReadingMethodId[] {
    const { preferences } = this.#state;
    return preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION ||
      preferences.disabledImageReadingMethodIds.includes(ACCESSIBILITY_TEXT_METHOD_ID)
      ? preferences.disabledImageReadingMethodIds
      : [ACCESSIBILITY_TEXT_METHOD_ID, ...preferences.disabledImageReadingMethodIds];
  }

  #usableProviderOrder(
    disabledMethodIds: readonly ImageReadingMethodId[],
  ): readonly ImageTextProviderId[] {
    const state = this.#state;
    return runtimeReadyOcrProviderOrder(
      this.environment.compiledProviderOrder(
        enabledOcrProviderOrder(state.preferences.imageReadingMethodOrder, disabledMethodIds),
        state.preferences.disabledImageTextProviderIds,
      ),
      state.ocrProviderRuntimeStatuses,
    );
  }

  #enabledAutoImageLanguageMethodOrder(
    disabledMethodIds: readonly ImageReadingMethodId[],
    providerOrder: readonly ImageTextProviderId[],
  ): ImageReadingMethodId[] {
    const disabled = new Set(disabledMethodIds);
    const providers = new Set<ImageReadingMethodId>(providerOrder);
    return this.#state.preferences.imageReadingMethodOrder.filter((method) =>
      !disabled.has(method) &&
      (method === ACCESSIBILITY_TEXT_METHOD_ID || providers.has(method)),
    );
  }
}
