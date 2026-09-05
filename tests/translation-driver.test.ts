import { describe, expect, it, vi } from 'vitest';

import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { Currency } from '../entrypoints/sidepanel/currency';
import {
  TranslationDriver,
  describePartialReplicaTranslation,
  type PendingAutoImageLanguageEvidence,
} from '../entrypoints/sidepanel/translation-driver';
import { AutoLanguageEvidencePrecedence } from '../lib/language-detection';
import { withViewSettings } from '../lib/preferences';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';
import type {
  ReplicaTranslationRunResult,
  ReplicaTranslationSnapshot,
} from '../lib/translation/replica-translation-coordinator';
import type { TranslationAvailability } from '../lib/translation-provider';

const DOCUMENT: ReplicaSourceDocumentIdentity = {
  sessionId: 'session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'doc-1',
  frameId: 0,
};
const IDENTITY = { tabId: 4, windowId: 1, url: 'https://example.com/a' };

function snapshot(options: { documentLanguage?: string; text?: string } = {}): ReplicaTranslationSnapshot {
  return {
    document: DOCUMENT,
    ...(options.documentLanguage ? { documentLanguage: options.documentLanguage } : {}),
    replayLease: 1,
    records: [{ source: options.text ?? 'Hello there' }] as never,
  };
}

const complete = (total = 2): ReplicaTranslationRunResult =>
  ({ translationEpoch: 1, total, completed: total, failed: 0, stale: 0, skipped: 0, overflow: 0 });

function setup(options: {
  availability?: TranslationAvailability;
  sourceLanguage?: 'auto' | 'ja' | 'de';
  documentLanguage?: string;
  text?: string;
  translate?: () => Promise<ReplicaTranslationRunResult>;
} = {}) {
  const state = new CompanionState({ isDetachedWindow: false });
  state.preferences = withViewSettings(state.preferences, {
    sourceLanguage: options.sourceLanguage ?? 'auto',
    targetLanguage: 'en',
  });
  state.snapshot = snapshot(options);
  state.capturedPageIdentity = IDENTITY;
  state.followedPageIdentity = IDENTITY;
  const currency = new Currency();
  const statuses: string[] = [];
  const notes: string[] = [];
  const events: string[] = [];
  const provider = {
    availability: vi.fn(async () => options.availability ?? 'available'),
  };
  const coordinator = {
    selectPair: vi.fn(),
    translateCurrent: vi.fn(options.translate ?? (async () => complete())),
    isResultCurrent: vi.fn(() => true),
  };
  const captureCoordinator = { generation: 1, isCurrent: (generation: number) => generation === 1 };
  const driver = new TranslationDriver({
    state,
    currency,
    provider,
    coordinator,
    captureCoordinator,
    evidence: new AutoLanguageEvidencePrecedence<PendingAutoImageLanguageEvidence>(),
    detectLanguage: vi.fn(async () => ({ isReliable: false, languages: [] })),
    getTab: vi.fn(async () => ({ id: 4, windowId: 1, url: IDENTITY.url, active: true })),
    autoImageLanguageConfigurationKey: () => 'configuration',
    configureImageTranslation: () => events.push('configure'),
    setStatus: (message) => statuses.push(message),
    updateControls: () => events.push('controls'),
    showProgress: (label) => events.push(`progress:${label}`),
    hideProgress: () => events.push('hide-progress'),
    renderDetectedLanguage: (text) => notes.push(text),
    invalidateComposer: () => events.push('composer-invalidated'),
    syncComposerPanel: () => events.push('composer-synced'),
    onPairPrepared: () => events.push('pair-prepared'),
    onTranslationSettled: () => events.push('settled'),
  });
  return { driver, state, currency, provider, coordinator, statuses, notes, events };
}

describe('TranslationDriver language resolution', () => {
  it('resolves the page language from the document and reports it', async () => {
    const harness = setup({ documentLanguage: 'ja' });
    await expect(harness.driver.resolveSelectedSourceLanguage(
      harness.driver.currentReplicaLanguageContext(),
    )).resolves.toBe(true);
    expect(harness.state.resolvedSourceLanguage).toBe('ja');
    expect(harness.state.resolvedSourceLanguageOrigin).toBe('page');
    expect(harness.state.pageLanguageResolutionPending).toBe(false);
    expect(harness.notes.at(-1)).toBe('Detected Japanese from the page language.');
    expect(harness.state.selectedPair()).toEqual({ sourceLanguage: 'ja', targetLanguage: 'en' });
  });

  it('treats an explicit From choice as authoritative', async () => {
    const harness = setup({ sourceLanguage: 'de', documentLanguage: 'ja' });
    await harness.driver.resolveSelectedSourceLanguage();
    expect(harness.state.resolvedSourceLanguage).toBe('de');
    expect(harness.state.resolvedSourceLanguageOrigin).toBe('explicit');
    expect(harness.notes.at(-1)).toBe('');
  });

  it('asks for a From choice when nothing is detected and drops a superseded resolution', async () => {
    const harness = setup();
    await harness.driver.resolveSelectedSourceLanguage();
    expect(harness.state.resolvedSourceLanguage).toBeUndefined();
    expect(harness.notes.at(-1)).toContain('Choose a From language');

    const resolving = harness.driver.resolveSelectedSourceLanguage({
      documentLanguage: 'fr',
      visibleText: '',
      preserveOnUnknown: true,
    });
    harness.currency.supersede('language-resolution');
    await expect(resolving).resolves.toBe(false);
    expect(harness.state.resolvedSourceLanguage).toBeUndefined();
  });

  it('adopts image evidence in Auto mode when page evidence is settled, and clears it on invalidation', async () => {
    const harness = setup();
    await harness.driver.resolveSelectedSourceLanguage();
    harness.driver.offerImageLanguageEvidence(
      'ja',
      'script-majority' as never,
      DOCUMENT,
      'accessibility-text' as never,
    );
    expect(harness.state.resolvedSourceLanguage).toBe('ja');
    expect(harness.state.resolvedSourceLanguageOrigin).toBe('image');
    expect(harness.notes.at(-1)).toBe(
      'Detected Japanese from accessibility image text (script majority).',
    );
    await vi.waitFor(() => expect(harness.provider.availability).toHaveBeenCalled());
    await vi.waitFor(() => expect(harness.state.availability).toBe('available'));

    harness.driver.handleAutoImageLanguageInvalidated({ ...DOCUMENT, documentId: 'other' });
    expect(harness.state.resolvedSourceLanguage).toBe('ja');
    harness.driver.handleAutoImageLanguageInvalidated(DOCUMENT);
    expect(harness.state.resolvedSourceLanguage).toBeUndefined();
    expect(harness.state.availability).toBe('unavailable');
    expect(harness.notes.at(-1)).toContain('Image-derived language evidence was cleared');
  });

  it('keeps an explicit language when image evidence behind it is invalidated', async () => {
    const harness = setup({ sourceLanguage: 'ja' });
    harness.state.resolvedSourceLanguage = 'ja';
    harness.state.resolvedSourceLanguageOrigin = 'image';
    harness.state.resolvedImageLanguageDocument = DOCUMENT;
    harness.driver.handleAutoImageLanguageInvalidated(DOCUMENT);
    expect(harness.state.resolvedSourceLanguage).toBe('ja');
    expect(harness.state.resolvedSourceLanguageOrigin).toBe('explicit');
    expect(harness.state.resolvedImageLanguageDocument).toBeUndefined();
  });
});

describe('TranslationDriver availability', () => {
  it('short-circuits a matching pair and records other pairs only after the result', async () => {
    const same = setup({ sourceLanguage: 'ja' });
    same.state.preferences = withViewSettings(same.state.preferences, { targetLanguage: 'ja' });
    same.state.resolvedSourceLanguage = 'ja';
    await same.driver.checkAvailability(1);
    expect(same.state.availability).toBe('available');
    expect(same.state.translationComplete).toBe(true);
    expect(same.state.availabilityCheckedForPair).toBe('1:ja>ja');

    const harness = setup({ availability: 'downloadable' });
    harness.state.resolvedSourceLanguage = 'ja';
    await harness.driver.checkAvailability(1);
    expect(harness.state.availability).toBe('downloadable');
    expect(harness.state.availabilityCheckedForPair).toBe('1:ja>en');
    expect(harness.statuses.at(-1)).toContain('Choose Translate once');
    expect(harness.coordinator.selectPair).toHaveBeenCalledWith({ sourceLanguage: 'ja', targetLanguage: 'en' });
  });

  it('leaves a superseded check unrecorded so the next commit prepares the pair again', async () => {
    let answer!: (value: TranslationAvailability) => void;
    const harness = setup();
    harness.state.resolvedSourceLanguage = 'ja';
    harness.provider.availability.mockImplementationOnce(
      () => new Promise<TranslationAvailability>((resolve) => {
        answer = resolve;
      }),
    );
    const checking = harness.driver.checkAvailability(1);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    harness.currency.supersede('availability');
    answer('available');
    await checking;
    expect(harness.state.availability).toBe('unavailable');
    expect(harness.state.availabilityCheckedForPair).toBeUndefined();
  });

  it('reports a page without text or a pair as unavailable', async () => {
    const harness = setup({ text: '   ' });
    harness.state.resolvedSourceLanguage = 'ja';
    await harness.driver.checkAvailability(1);
    expect(harness.state.availability).toBe('unavailable');
    expect(harness.provider.availability).not.toHaveBeenCalled();

    const noPair = setup();
    await noPair.driver.checkAvailability(1);
    expect(noPair.statuses.at(-1)).toContain('Choose a From language');
  });
});

describe('TranslationDriver page translation', () => {
  it('translates the replica once per pair and reports completion', async () => {
    const harness = setup();
    harness.state.resolvedSourceLanguage = 'ja';
    harness.state.availability = 'available';
    const first = harness.driver.startTranslation(false, 1);
    const second = harness.driver.startTranslation(false, 1);
    expect(second).toBe(first);
    await first;
    expect(harness.coordinator.translateCurrent).toHaveBeenCalledTimes(1);
    expect(harness.state.translationComplete).toBe(true);
    expect(harness.state.translationDesired).toBe(true);
    expect(harness.state.translationInFlight).toBe(false);
    expect(harness.state.availabilityCheckedForPair).toBe('1:ja>en');
    expect(harness.events).toContain('pair-prepared');
    expect(harness.events).toContain('settled');
    expect(harness.statuses.at(-1)).toContain('Translation is complete');
    expect(harness.state.activeTranslationTask).toBeUndefined();
  });

  it('reports a partial translation and a cancellation', async () => {
    const partial = setup({
      translate: async () => ({ ...complete(3), completed: 1, failed: 2 }),
    });
    partial.state.resolvedSourceLanguage = 'ja';
    partial.state.availability = 'available';
    await partial.driver.startTranslation(false, 1);
    expect(partial.state.translationComplete).toBe(false);
    expect(partial.statuses.at(-1)).toBe(
      'Translation remains partial: 2 failed. Original text remains for those segments; choose Translate page to retry.',
    );

    const cancelled = setup({
      translate: () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 0);
      }),
    });
    cancelled.state.resolvedSourceLanguage = 'ja';
    cancelled.state.availability = 'available';
    const running = cancelled.driver.startTranslation(false, 1);
    cancelled.state.activeAbortController?.abort();
    await running;
    expect(cancelled.statuses.at(-1)).toBe('Translation cancelled. Existing translated text was kept.');
    expect(cancelled.state.translationInFlight).toBe(false);
  });

  it('runs automatic translation only when wanted and available', async () => {
    const harness = setup();
    harness.state.resolvedSourceLanguage = 'ja';
    harness.state.availability = 'available';
    await harness.driver.maybeTranslateAutomatically(1, IDENTITY.url);
    expect(harness.coordinator.translateCurrent).not.toHaveBeenCalled();

    harness.state.translationDesired = true;
    await harness.driver.maybeTranslateAutomatically(1, IDENTITY.url);
    expect(harness.coordinator.translateCurrent).toHaveBeenCalledTimes(1);

    harness.state.translationComplete = false;
    harness.state.availability = 'downloadable';
    await harness.driver.maybeTranslateAutomatically(1, IDENTITY.url);
    expect(harness.statuses.at(-1)).toContain('needs one Translate click');
  });

  it('applies language preferences without recording intent unless the user acted', async () => {
    const harness = setup({ documentLanguage: 'ja' });
    await harness.driver.applyLanguagePreferences(false);
    expect(harness.state.availability).toBe('available');
    expect(harness.coordinator.translateCurrent).not.toHaveBeenCalled();

    await harness.driver.applyLanguagePreferences(true, undefined);
    expect(harness.coordinator.translateCurrent).toHaveBeenCalledTimes(1);
  });
});

describe('TranslationDriver replica view mode', () => {
  it('drops translation state in live source only mode and resumes in translated mode', async () => {
    const harness = setup({ documentLanguage: 'ja' });
    harness.state.availability = 'available';
    harness.state.translationComplete = true;
    harness.state.preferences = withViewSettings(harness.state.preferences, {
      replicaViewMode: 'source-only',
    });
    harness.driver.applyReplicaViewMode('translated');
    expect(harness.state.availability).toBe('unavailable');
    expect(harness.state.translationComplete).toBe(false);
    expect(harness.coordinator.selectPair).toHaveBeenCalledWith(undefined);
    expect(harness.statuses.at(-1)).toContain('Live source only is active');

    harness.state.preferences = withViewSettings(harness.state.preferences, {
      replicaViewMode: 'translated',
    });
    harness.driver.applyReplicaViewMode('source-only');
    expect(harness.statuses).toContain('Translated mode restored. Preparing the saved language settings…');
    await vi.waitFor(() => expect(harness.state.availability).toBe('available'));
    expect(harness.state.resolvedSourceLanguage).toBe('ja');
  });
});

describe('TranslationDriver commits', () => {
  it('prepares availability for new text and translates when the page wanted it', async () => {
    const harness = setup({ documentLanguage: 'ja' });
    harness.state.translationDesired = true;
    const refresh = harness.currency.begin('language-refresh');
    await harness.driver.reconcileAfterCommit(
      {
        document: DOCUMENT,
        documentLanguage: 'ja',
        documentLanguageChanged: false,
        replayLease: 1,
        records: [{ source: 'Hello there' }] as never,
        changes: [],
        reason: 'batch',
      },
      refresh,
      true,
      true,
    );
    expect(harness.state.availabilityCheckedForPair).toBe('1:ja>en');
    expect(harness.coordinator.translateCurrent).toHaveBeenCalledTimes(1);

    // Nothing to prepare once the pair is checked for this generation.
    harness.provider.availability.mockClear();
    await harness.driver.reconcileAfterCommit(
      {
        document: DOCUMENT,
        documentLanguage: 'ja',
        documentLanguageChanged: false,
        replayLease: 1,
        records: [{ source: 'Hello there' }] as never,
        changes: [],
        reason: 'batch',
      },
      harness.currency.begin('language-refresh'),
      true,
      true,
    );
    expect(harness.provider.availability).not.toHaveBeenCalled();
  });

  it('describes partial results', () => {
    expect(describePartialReplicaTranslation(
      { ...complete(5), completed: 2, failed: 1, stale: 1, skipped: 0, overflow: 1 },
      'Prefix',
    )).toBe('Prefix: 1 failed, 1 became stale, 1 exceeded the bounded local queue. Original text remains for those segments; choose Translate page to retry.');
    expect(describePartialReplicaTranslation({ ...complete(3), completed: 1 }, 'Prefix'))
      .toContain('2 were not projected');
  });
});
