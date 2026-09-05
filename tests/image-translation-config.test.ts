import { describe, expect, it, vi } from 'vitest';

import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { ImageTranslationConfig } from '../entrypoints/sidepanel/image-translation-config';
import type { ImageTranslationConfiguration } from '../lib/ocr/image-translation-controller';
import type { ImageTextProviderId } from '../lib/ocr/known-provider-ids';
import { createProbeOcrProviderResponse } from '../lib/ocr/provider-status-protocol';
import {
  DEFAULT_COMPANION_PREFERENCES,
  parseCompanionPreferences,
  withImageAnalysisSettings,
  withReadSettings,
} from '../lib/preferences';
import {
  REPLICA_READ_SCOPE_SETUP_VERSION,
  replicaReadScopeForProfile,
} from '../lib/replica/read-scope-policy';

const COMPILED: readonly ImageTextProviderId[] = ['chrome-text-detector', 'tesseract'];

function setup(options: {
  granted?: boolean;
  imageTranslationEnabled?: boolean;
  setupComplete?: boolean;
  probe?: (message: unknown) => Promise<unknown>;
} = {}) {
  const state = new CompanionState({ isDetachedWindow: false });
  // The parser keeps accessibility text off until the read-scope setup has
  // completed, so setup is marked complete before the method is enabled.
  let preferences = parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
  if (options.setupComplete ?? true) {
    preferences = withReadSettings(preferences, {
      replicaReadScope: replicaReadScopeForProfile('standard'),
      readScopeSetupVersion: REPLICA_READ_SCOPE_SETUP_VERSION,
    });
  }
  preferences = withImageAnalysisSettings(preferences, {
    imageTranslationEnabled: options.imageTranslationEnabled ?? true,
    disabledImageReadingMethodIds: [],
  });
  state.preferences = preferences;
  state.imageCaptureAccess = options.granted === false ? 'missing' : 'granted';
  const configurations: ImageTranslationConfiguration[] = [];
  const messages: unknown[] = [];
  const retries: Array<() => void> = [];
  const translationDriver = {
    currentReplicaDocumentMatches: vi.fn(() => true),
    clearAutoImageLanguageResolution: vi.fn(),
  };
  const renderImagePanel = vi.fn();
  const config = new ImageTranslationConfig({
    state,
    controller: { configure: (configuration) => configurations.push(configuration) },
    currentReplicaReadScope: () => replicaReadScopeForProfile('standard'),
    translationDriver,
    compiledProviderIds: COMPILED,
    compiledProviderOrder: (order, disabled = []) =>
      order.filter((id) => COMPILED.includes(id) && !disabled.includes(id)),
    renderImagePanel,
    sendMessage: vi.fn(async (message: unknown) => {
      messages.push(message);
      return options.probe
        ? options.probe(message)
        : Promise.reject(new Error('no host'));
    }),
    scheduleRetry: (callback) => retries.push(callback),
  });
  return { config, state, configurations, messages, retries, translationDriver, renderImagePanel };
}

describe('ImageTranslationConfig', () => {
  it('routes pixel providers only with the broad grant and keeps accessibility text on', () => {
    const harness = setup();
    harness.state.ocrProviderRuntimeStatuses.set('chrome-text-detector', 'checking');
    harness.config.configure();
    const configuration = harness.configurations.at(-1)!;
    expect(configuration.enabled).toBe(true);
    // A provider still being probed is not routed; Tesseract needs no probe.
    expect(configuration.providerOrder).toEqual(['tesseract']);
    expect(configuration.disabledMethodIds).toEqual([]);
    expect(configuration.translationIdle).toBe(true);
    expect(harness.config.usablePixelProviderOrder()).toEqual(['tesseract']);

    const missing = setup({ granted: false });
    missing.config.configure();
    expect(missing.configurations.at(-1)?.providerOrder).toEqual([]);
    expect(missing.configurations.at(-1)?.enabled).toBe(true);
  });

  it('keeps accessibility text off until the read-scope setup completes', () => {
    const harness = setup({ setupComplete: false });
    harness.config.configure();
    expect(harness.configurations.at(-1)?.disabledMethodIds).toEqual(['accessibility-text']);
    expect(harness.config.autoImageLanguageConfigurationKey())
      .not.toBe(setup().config.autoImageLanguageConfigurationKey());
  });

  it('disables image work when translation is off or the view is source only', () => {
    const off = setup({ imageTranslationEnabled: false });
    off.config.configure();
    expect(off.configurations.at(-1)?.enabled).toBe(false);

    const sourceOnly = setup();
    sourceOnly.state.preferences = { ...sourceOnly.state.preferences, replicaViewMode: 'source-only' };
    sourceOnly.config.configure();
    expect(sourceOnly.configurations.at(-1)?.enabled).toBe(false);
  });

  it('retires image-derived language evidence whose configuration key changed', () => {
    const harness = setup();
    harness.state.resolvedSourceLanguage = 'ja';
    harness.state.resolvedSourceLanguageOrigin = 'image';
    harness.state.resolvedImageLanguageDocument = {} as never;
    harness.state.resolvedImageLanguageConfigurationKey =
      harness.config.autoImageLanguageConfigurationKey();
    harness.config.configure();
    expect(harness.translationDriver.clearAutoImageLanguageResolution).not.toHaveBeenCalled();

    harness.state.preferences = withImageAnalysisSettings(harness.state.preferences, {
      ocrMinimumConfidence: 0.8,
    });
    harness.config.configure();
    expect(harness.translationDriver.clearAutoImageLanguageResolution).toHaveBeenCalledOnce();
  });

  it('probes the TextDetector runtime and retries a failed probe once', async () => {
    const failing = setup();
    await failing.config.refreshProviderRuntimeStatuses();
    expect(failing.messages[0]).toMatchObject({ kind: 'simul:ocr-v1:ensure-host', resetEpoch: 0 });
    expect(failing.state.ocrProviderRuntimeStatuses.get('chrome-text-detector'))
      .toEqual({ status: 'unavailable', providerId: 'chrome-text-detector', reason: 'probe-failed' });
    expect(failing.retries).toHaveLength(1);
    expect(failing.renderImagePanel).toHaveBeenCalledTimes(2);
    failing.retries.shift()?.();
    await vi.waitFor(() => expect(failing.messages).toHaveLength(2));
    expect(failing.retries).toHaveLength(0);

    const ready = setup({
      probe: async (message) => (message as { kind: string }).kind === 'simul:ocr-v1:ensure-host'
        ? { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true }
        : createProbeOcrProviderResponse({ status: 'available', providerId: 'chrome-text-detector' }),
    });
    await ready.config.refreshProviderRuntimeStatuses();
    expect(ready.state.ocrProviderRuntimeStatuses.get('chrome-text-detector'))
      .toEqual({ status: 'available', providerId: 'chrome-text-detector' });
    expect(ready.retries).toHaveLength(0);
    ready.config.configure();
    expect(ready.configurations.at(-1)?.providerOrder).toEqual(['chrome-text-detector', 'tesseract']);
  });
});
