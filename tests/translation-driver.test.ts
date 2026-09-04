import { describe, expect, it, vi } from 'vitest';

import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { Currency } from '../entrypoints/sidepanel/currency';
import { TranslationDriver } from '../entrypoints/sidepanel/translation-driver';
import { LatestWorkCoordinator } from '../lib/companion-lifecycle';
import { withViewSettings } from '../lib/preferences';
import { TranslationMemory } from '../lib/translation/translation-memory';
import type { TranslationAvailability, TranslationPair } from '../lib/translation-provider';
import {
  PAGE_IDENTITY,
  PAGE_URL,
  mountMirrorView,
  visualSnapshot,
} from './helpers/sidepanel-fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(options: { detected?: string; availability?: TranslationAvailability } = {}) {
  const state = new CompanionState({ isDetachedWindow: false });
  state.preferences = withViewSettings(state.preferences, {
    sourceLanguage: 'auto',
    targetLanguage: 'en',
  });
  const currency = new Currency();
  const captureCoordinator = new LatestWorkCoordinator<never>();
  captureCoordinator.invalidate(); // generation 1
  const mirror = mountMirrorView(() => state.preferences);
  mirror.view.renderSnapshot(visualSnapshot());
  state.snapshot = visualSnapshot();
  state.capturedPageIdentity = PAGE_IDENTITY;
  state.followedPageIdentity = PAGE_IDENTITY;
  const availabilityAnswers: Array<ReturnType<typeof deferred<TranslationAvailability>>> = [];
  const sessions: Array<{ pair: TranslationPair; destroy: ReturnType<typeof vi.fn> }> = [];
  const provider = {
    availability: vi.fn(async () => {
      if (options.availability) return options.availability;
      const answer = deferred<TranslationAvailability>();
      availabilityAnswers.push(answer);
      return answer.promise;
    }),
    createSession: vi.fn(async (pair: TranslationPair) => {
      const session = {
        pair,
        translate: async (text: string) => `[${pair.targetLanguage}:${text}]`,
        destroy: vi.fn(),
      };
      sessions.push(session);
      return session;
    }),
  };
  const statuses: string[] = [];
  const detectedLanguageTexts: string[] = [];
  let detected: string | undefined = options.detected ?? 'ja';
  const replicaTranslation = {
    selectPair: vi.fn(),
    translateCurrent: vi.fn(),
    isResultCurrent: vi.fn(() => true),
  };
  const environment = {
    queueCapture: vi.fn(),
    abortAndRequeueLiveDelta: vi.fn(),
    processPendingLiveUpdate: vi.fn(async () => undefined),
    onLanguageResolved: vi.fn(),
    invalidateComposer: vi.fn(),
    configureImageTranslation: vi.fn(),
    showProgress: vi.fn(),
    hideProgress: vi.fn(),
    updateControls: vi.fn(),
    logTranslationCache: vi.fn(),
  };
  const driver = new TranslationDriver({
    state,
    currency,
    captureCoordinator,
    provider,
    translationMemory: new TranslationMemory({ maxEntries: 64, maxCharacters: 10_000 }),
    mirrorView: mirror.view,
    replicaSurface: { snapshot: () => undefined },
    replicaTranslation,
    detectLanguage: async () => detected
      ? { isReliable: true, languages: [{ language: detected, percentage: 95 }] }
      : { isReliable: false, languages: [] },
    getTab: async () => ({ ...PAGE_IDENTITY, id: PAGE_IDENTITY.tabId, active: true }),
    usesReplicaTranslationProjection: () => false,
    releaseReplicaPresentationForLegacyWork: () => false,
    commitViewPreferencePatch: async (patch) => {
      state.preferences = withViewSettings(state.preferences, patch);
      return true;
    },
    renderDetectedLanguage: (text) => detectedLanguageTexts.push(text),
    setStatus: (message) => statuses.push(message),
    ...environment,
  });
  return {
    driver,
    state,
    mirror,
    provider,
    sessions,
    availabilityAnswers,
    statuses,
    detectedLanguageTexts,
    replicaTranslation,
    setDetected(next: string | undefined) {
      detected = next;
    },
    ...environment,
  };
}

describe('TranslationDriver language resolution', () => {
  it('detects the source language from visible text and reports it', async () => {
    const harness = setup();
    expect(await harness.driver.resolveSelectedSourceLanguage()).toBe(true);
    expect(harness.state.resolvedSourceLanguage).toBe('ja');
    expect(harness.detectedLanguageTexts.at(-1)).toBe('Detected Japanese from visible page text.');
    expect(harness.onLanguageResolved).toHaveBeenCalled();
    expect(harness.state.selectedPair()).toEqual({ sourceLanguage: 'ja', targetLanguage: 'en' });
  });

  it('keeps the previous language for a live refresh that detects nothing', async () => {
    const harness = setup();
    await harness.driver.resolveSelectedSourceLanguage();
    harness.setDetected(undefined);
    expect(
      await harness.driver.resolveSelectedSourceLanguage({
        visibleText: '',
        preserveOnUnknown: true,
      }),
    ).toBe(true);
    expect(harness.state.resolvedSourceLanguage).toBe('ja');
    expect(harness.detectedLanguageTexts.at(-1)).toContain('previously detected Japanese');
  });

  it('discards a resolution that a newer snapshot superseded', async () => {
    const harness = setup();
    const pending = harness.driver.resolveSelectedSourceLanguage();
    harness.state.snapshot = visualSnapshot('fr');
    expect(await pending).toBe(false);
    expect(harness.state.resolvedSourceLanguage).toBeUndefined();
  });
});

describe('TranslationDriver availability', () => {
  it('records the checked pair only for the accepted request', async () => {
    const harness = setup();
    await harness.driver.resolveSelectedSourceLanguage();
    const first = harness.driver.checkAvailability(1);
    const second = harness.driver.checkAvailability(1);
    await vi.waitFor(() => expect(harness.availabilityAnswers).toHaveLength(2));
    // The first request is superseded; its late answer must not be recorded.
    harness.availabilityAnswers[0]?.resolve('downloadable');
    await first;
    expect(harness.state.availability).toBe('unavailable');
    expect(harness.state.availabilityCheckedForPair).toBeUndefined();
    harness.availabilityAnswers[1]?.resolve('available');
    await second;
    expect(harness.state.availability).toBe('available');
    expect(harness.state.availabilityCheckedForPair).toBe('1:ja>en');
    expect(harness.statuses.at(-1)).toBe('Ready to translate Japanese to English on-device.');
    expect(harness.replicaTranslation.selectPair).toHaveBeenLastCalledWith({
      sourceLanguage: 'ja',
      targetLanguage: 'en',
    });
  });

  it('treats a matching pair as already translated', async () => {
    const harness = setup({ detected: 'en' });
    await harness.driver.resolveSelectedSourceLanguage();
    await harness.driver.checkAvailability(1);
    expect(harness.provider.availability).not.toHaveBeenCalled();
    expect(harness.state.availability).toBe('available');
    expect(harness.state.translationComplete).toBe(true);
    expect(harness.statuses.at(-1)).toContain('languages match');
  });

  it('asks for a From language when detection is inconclusive', async () => {
    const harness = setup();
    await harness.driver.checkAvailability(1);
    expect(harness.state.availability).toBe('unavailable');
    expect(harness.statuses.at(-1)).toContain('Choose a From language');
  });
});

describe('TranslationDriver page translation', () => {
  it('translates the legacy mirror and joins a duplicate request', async () => {
    const harness = setup({ availability: 'available' });
    await harness.driver.resolveSelectedSourceLanguage();
    await harness.driver.checkAvailability(1);
    const first = harness.driver.startTranslation(false, 1);
    const joined = harness.driver.startTranslation(false, 1);
    expect(joined).toBe(first);
    expect(harness.state.translationInFlight).toBe(true);
    await first;
    expect(harness.provider.createSession).toHaveBeenCalledTimes(1);
    expect(harness.sessions[0]?.destroy).toHaveBeenCalled();
    expect(harness.state.translationInFlight).toBe(false);
    expect(harness.state.translationComplete).toBe(true);
    expect(harness.state.translationDesired).toBe(true);
    expect(harness.mirror.view.root?.textContent).toContain('[en:こんにちは 世界]');
    expect(harness.statuses.at(-1)).toBe(
      'Translation is complete and live updates will translate as they arrive.',
    );
    expect(harness.hideProgress).toHaveBeenCalled();
    expect(harness.processPendingLiveUpdate).toHaveBeenCalled();
  });

  it('applies a language choice, saves it, and translates when available', async () => {
    const harness = setup({ availability: 'available' });
    await harness.driver.changeLanguages('fr', 'en');
    expect(harness.state.preferences.sourceLanguage).toBe('fr');
    expect(harness.state.resolvedSourceLanguage).toBe('fr');
    expect(harness.abortAndRequeueLiveDelta).toHaveBeenCalled();
    expect(harness.provider.createSession).toHaveBeenCalledWith(
      { sourceLanguage: 'fr', targetLanguage: 'en' },
      expect.anything(),
    );
    expect(harness.state.translationComplete).toBe(true);
  });

  it('skips automatic translation unless the page or the user asked for it', async () => {
    const harness = setup({ availability: 'available' });
    await harness.driver.resolveSelectedSourceLanguage();
    await harness.driver.checkAvailability(1);
    await harness.driver.maybeTranslateAutomatically(1, PAGE_URL);
    expect(harness.provider.createSession).not.toHaveBeenCalled();
    harness.state.translationDesired = true;
    await harness.driver.maybeTranslateAutomatically(1, PAGE_URL);
    expect(harness.provider.createSession).toHaveBeenCalledTimes(1);
  });
});

describe('TranslationDriver replica view mode', () => {
  it('drops translation for live source only and resumes it for translated', async () => {
    const harness = setup({ availability: 'available' });
    await harness.driver.resolveSelectedSourceLanguage();
    await harness.driver.checkAvailability(1);
    await harness.driver.changeReplicaViewMode('source-only');
    expect(harness.state.preferences.replicaViewMode).toBe('source-only');
    expect(harness.state.availability).toBe('unavailable');
    expect(harness.replicaTranslation.selectPair).toHaveBeenLastCalledWith(undefined);
    expect(harness.statuses.at(-1)).toContain('Live source only is active');
    expect(harness.configureImageTranslation).toHaveBeenCalled();

    harness.provider.availability.mockClear();
    await harness.driver.changeReplicaViewMode('translated');
    expect(harness.state.preferences.replicaViewMode).toBe('translated');
    expect(harness.provider.availability).toHaveBeenCalledWith({
      sourceLanguage: 'ja',
      targetLanguage: 'en',
    });
    expect(harness.state.availability).toBe('available');
  });
});
