import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { PreferenceClient } from '../entrypoints/sidepanel/preference-client';
import type { PreferenceCommand } from '../lib/preference-coordinator';
import {
  DEFAULT_COMPANION_PREFERENCES,
  STORAGE_KEY,
  advanceCompanionSettingsRevision,
  parseCompanionPreferences,
  withImageAnalysisSettings,
  withViewSettings,
  type CompanionPreferences,
} from '../lib/preferences';
import { ViewPreferencePatchLedger } from '../lib/view-preference-ledger';

function setup(options: {
  service?: (command: PreferenceCommand) => Promise<unknown>;
  storage?: () => Promise<Record<string, unknown> | undefined>;
} = {}) {
  let stored = parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
  const errors: string[] = [];
  const events: string[] = [];
  const commands: PreferenceCommand[] = [];
  const result = (preferences: CompanionPreferences, applied = true, code?: string) => ({
    type: 'simul:preferences:result',
    applied,
    preferences,
    ...(code ? { code } : {}),
  });
  const defaultService = async (command: PreferenceCommand) => {
    commands.push(command);
    if (command.type === 'simul:preferences:reconcile') return result(stored);
    if (command.type === 'simul:preferences:patch-view') {
      stored = advanceCompanionSettingsRevision(withViewSettings(stored, command.patch));
      return result(stored);
    }
    if (command.type === 'simul:preferences:patch-image-analysis') {
      if (command.expectedSettingsRevision !== stored.settingsRevision) {
        return result(stored, false, 'stale-settings-revision');
      }
      stored = advanceCompanionSettingsRevision(
        withImageAnalysisSettings(stored, command.patch),
      );
      return result(stored);
    }
    throw new Error(`unexpected ${command.type}`);
  };
  const sendMessage = vi.fn(options.service ?? defaultService);
  const readStorage = vi.fn(options.storage ?? (async () => ({ [STORAGE_KEY]: stored })));
  const state = new CompanionState({ isDetachedWindow: false });
  const ledger = new ViewPreferencePatchLedger();
  const client = new PreferenceClient({
    state,
    ledger,
    sendMessage,
    readStorage,
    onCommitted: (previous) => events.push(`committed:${previous.settingsRevision}`),
    onControlsChanged: () => events.push('controls'),
    onLayoutChanged: () => events.push('layout'),
    onZoomApplied: () => events.push('zoom'),
    onError: (message) => errors.push(message),
    zoomCommitDebounceMs: 150,
  });
  return {
    client,
    state,
    ledger,
    sendMessage,
    readStorage,
    errors,
    events,
    commands,
    get stored() {
      return stored;
    },
    setStored: (next: CompanionPreferences) => {
      stored = next;
    },
  };
}

describe('PreferenceClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('loads through the service and falls back to storage, then defaults', async () => {
    const viaService = setup();
    await viaService.client.load();
    expect(viaService.sendMessage).toHaveBeenCalledWith({ type: 'simul:preferences:reconcile' });
    expect(viaService.events).toEqual(['committed:0', 'controls']);

    const viaStorage = setup({
      service: async () => {
        throw new Error('no service');
      },
      storage: async () => ({ [STORAGE_KEY]: { targetLanguage: 'ja' } }),
    });
    await viaStorage.client.load();
    expect(viaStorage.state.preferences.targetLanguage).toBe('ja');

    const viaDefaults = setup({
      service: async () => {
        throw new Error('no service');
      },
      storage: async () => {
        throw new Error('no storage');
      },
    });
    await viaDefaults.client.load();
    expect(viaDefaults.state.preferences)
      .toEqual(parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES));
  });

  it('accepts a committed snapshot only when it is not older than the current one', () => {
    const harness = setup();
    const newer = advanceCompanionSettingsRevision(
      withViewSettings(harness.state.preferences, { targetLanguage: 'fr' }),
    );
    expect(harness.client.applyCommitted(newer)).toBe(true);
    expect(harness.state.preferences.targetLanguage).toBe('fr');
    expect(harness.client.applyCommitted(DEFAULT_COMPANION_PREFERENCES)).toBe(false);
    expect(harness.state.preferences.targetLanguage).toBe('fr');
    expect(harness.events).toEqual(['committed:0']);
  });

  it('applies a view patch optimistically and confirms it with the service', async () => {
    const harness = setup();
    const saved = harness.client.commitView({ zoomPercent: 150, displayMode: 'custom' });
    // Optimistic state is visible before the service answers.
    expect(harness.state.preferences.zoomPercent).toBe(150);
    expect(harness.events).toEqual(['controls', 'layout']);
    await expect(saved).resolves.toBe(true);
    expect(harness.commands[0]).toMatchObject({
      type: 'simul:preferences:patch-view',
      expectedResetRevision: 0,
      patch: { zoomPercent: 150, displayMode: 'custom' },
    });
    expect(harness.state.preferences.displayMode).toBe('custom');
    expect(harness.state.preferences.settingsRevision).toBe(1);
    expect(harness.errors).toEqual([]);
  });

  it('keeps an in-flight patch over a committed snapshot from another window', async () => {
    let answer!: (value: unknown) => void;
    const harness = setup({
      service: (command) => command.type === 'simul:preferences:patch-view'
        ? new Promise((resolve) => {
          answer = resolve;
        })
        : Promise.reject(new Error('unexpected')),
    });
    const saving = harness.client.commitView({ syncScroll: false });
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));

    // Another window saved a different setting meanwhile; ours must survive.
    const external = advanceCompanionSettingsRevision(withViewSettings(
      parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      { targetLanguage: 'fr' },
    ));
    expect(harness.client.applyCommitted(external)).toBe(true);
    expect(harness.state.preferences.syncScroll).toBe(false);
    expect(harness.state.preferences.targetLanguage).toBe('fr');

    answer({
      type: 'simul:preferences:result',
      applied: true,
      preferences: advanceCompanionSettingsRevision(
        withViewSettings(external, { syncScroll: false }),
      ),
    });
    await expect(saving).resolves.toBe(true);
    // Once settled, the pending value no longer overrides committed state.
    expect(harness.client.applyCommitted(
      advanceCompanionSettingsRevision(harness.state.preferences),
    )).toBe(true);
    expect(harness.ledger.project(external).syncScroll).toBe(true);
  });

  it('restores stored state and reports a failed or refused save', async () => {
    const stored = withViewSettings(parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES), {
      zoomPercent: 80,
    });
    const harness = setup({
      service: async () => {
        throw new Error('service down');
      },
      storage: async () => ({ [STORAGE_KEY]: stored }),
    });
    await expect(harness.client.commitView({ zoomPercent: 200 })).resolves.toBe(false);
    expect(harness.state.preferences.zoomPercent).toBe(80);
    expect(harness.errors).toEqual(['Could not save options: service down']);

    await harness.client.commitImageAnalysis({ skipSmallImages: false });
    expect(harness.errors.at(-1)).toBe('Could not save image options: service down');
    expect(harness.state.preferences.skipSmallImages).toBe(stored.skipSmallImages);

    const refused = setup({
      service: async (command) => ({
        type: 'simul:preferences:result',
        applied: false,
        preferences: command.type === 'simul:preferences:patch-view'
          ? parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES)
          : parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      }),
    });
    await expect(refused.client.commitView({ syncScroll: false })).resolves.toBe(false);
    expect(refused.errors.at(-1)).toContain('Settings were reset in another companion');
  });

  it('binds image-option writes to the current settings revision', async () => {
    const harness = setup();
    await harness.client.commitImageAnalysis({ skipSmallImages: false });
    expect(harness.commands[0]).toMatchObject({
      type: 'simul:preferences:patch-image-analysis',
      expectedResetRevision: 0,
      expectedSettingsRevision: 0,
      patch: { skipSmallImages: false },
    });
    expect(harness.state.preferences.skipSmallImages).toBe(false);
    expect(harness.errors).toEqual([]);

    // Another companion advanced the revision first.
    harness.setStored(advanceCompanionSettingsRevision(harness.stored));
    await harness.client.commitImageAnalysis({ skipSmallImages: true });
    expect(harness.errors.at(-1)).toContain('Image options changed in another companion');
  });

  it('applies zoom at once and saves once per drag, flushing on demand', async () => {
    const harness = setup();
    harness.client.setZoom(120);
    harness.client.setZoom(130);
    harness.client.setZoom(999);
    expect(harness.state.preferences.zoomPercent).toBe(300);
    expect(harness.state.preferences.displayMode).toBe('custom');
    expect(harness.events).toEqual(['zoom', 'zoom', 'zoom']);
    expect(harness.commands).toEqual([]);

    // A committed snapshot arriving mid-drag keeps the slider where it is.
    harness.client.applyCommitted(advanceCompanionSettingsRevision(harness.stored));
    expect(harness.state.preferences.zoomPercent).toBe(300);

    vi.advanceTimersByTime(150);
    await vi.waitFor(() => expect(harness.commands).toHaveLength(1));
    expect(harness.commands[0]).toMatchObject({
      type: 'simul:preferences:patch-view',
      patch: { displayMode: 'custom', zoomPercent: 300 },
    });
    expect(harness.state.pendingZoomPatch).toBeUndefined();

    harness.client.setZoom(50);
    harness.client.flushPendingZoom();
    await vi.waitFor(() => expect(harness.commands).toHaveLength(2));
    expect(harness.state.zoomCommitTimer).toBeUndefined();
    harness.client.flushPendingZoom();
    expect(harness.commands).toHaveLength(2);
  });

  it('remembers the launch surface through a view patch', async () => {
    const harness = setup();
    await expect(harness.client.rememberSurface('popout')).resolves.toBe(true);
    expect(harness.state.preferences.lastLaunchSurface).toBe('popout');
  });
});
