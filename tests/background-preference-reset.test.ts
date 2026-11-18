import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const background = readFileSync(
  new URL('../entrypoints/background.ts', import.meta.url),
  'utf8',
);

describe('background preference reset wiring', () => {
  it('makes runtime cleanup part of the durable coordinator transaction', () => {
    expect(background).toContain(
      'clearTransientStore: () => transientImageStore.clearAll()',
    );
    expect(background).toContain(
      'closeOffscreenDocument: async () =>',
    );
    expect(background).toContain(
      'offscreenManager.advanceResetEpoch(',
    );
    expect(background).toContain(
      'await offscreenManager.close()',
    );
    expect(background).not.toContain(
      "command.type === 'simul:preferences:reset-all' ||",
    );
  });

  it('requires every live panel to purge before narrowing or reset commits', () => {
    expect(background).toContain('new PreferenceSafetyCoordinator(');
    expect(background).toContain('await safety.prepare(');
    expect(background).toContain("code: 'safety-ack-failed'");
  });

  it('journals unresolved read ceilings across service-worker restarts', () => {
    expect(background).toContain('PREFERENCE_SAFETY_JOURNAL_STORAGE_KEY');
    expect(background).toContain('preferenceSafetyJournal');
    expect(background).toContain('await safety.release(');
    expect(background).toContain('await safety.observeCommittedReadScope(');
  });

  it('fails closed when the live safety journal is deleted or replaced', () => {
    expect(background).toContain(
      'PREFERENCE_SAFETY_JOURNAL_STORAGE_KEY in changes',
    );
    expect(background).toContain(
      'preferenceSafety.observeJournalStorageChange(',
    );
  });

  it('does not treat invalid or stale live storage mutations as committed scope', () => {
    expect(background).toContain('selectLiveCompanionPreferenceChange(');
    expect(background).toContain('livePreferenceStorageFailClosed');
    expect(background).toContain(
      "if (liveChange.status !== 'accepted') return;",
    );
    expect(background).toContain('currentLaunchReadScope()');
  });

  it('fences OCR host creation to the committed reset epoch', () => {
    expect(background).toContain(
      'offscreenManager.ensure(ensureHost.resetEpoch)',
    );
    expect(background).toContain(
      'await offscreenManager.advanceResetEpoch(loaded.resetRevision)',
    );
    expect(background).toContain(
      'launchPreferences.resetRevision',
    );
  });

  it('reconciles a durable pending reset when the service worker restarts', () => {
    expect(background).toContain(
      'if (loaded.resetCleanupPendingRevision > 0)',
    );
    expect(background).toContain(
      "type: 'simul:preferences:reconcile'",
    );
  });

  it('keeps the ready promise settled when preference hydration fails (O1)', () => {
    const hydration = background.slice(
      background.indexOf('const launchPreferencesReady'),
      background.indexOf('function queueToolbarBehaviorSync'),
    );
    expect(hydration).toContain('try {');
    expect(hydration).toContain('} catch {');
    expect(hydration).toContain('} finally {');
    expect(hydration).toContain('launchPreferencesHydrated = true;');
    // The failure path still runs the toolbar behavior sync, and the
    // promise has no rejection path left.
    expect(hydration.slice(hydration.indexOf('} catch {')))
      .toContain('queueToolbarBehaviorSync();');
  });

  it('queues a permission-revocation reconcile behind the preference lock (O2)', () => {
    const listener = background.slice(
      background.indexOf('browser.permissions.onRemoved.addListener('),
      background.indexOf('browser.storage.onChanged.addListener('),
    );
    expect(listener).toContain('navigator.locks.request(');
    expect(listener).not.toContain('ifAvailable');
    expect(listener).toContain(
      "await coordinator.run({ type: 'simul:preferences:reconcile' });",
    );
    expect(listener).toContain('.catch(() => undefined)');
  });
});
