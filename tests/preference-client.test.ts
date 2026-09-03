import { describe, expect, it, vi } from 'vitest';

import { PreferenceClient } from '../entrypoints/sidepanel/preference-client';
import type { PreferenceCommand } from '../lib/preference-coordinator';
import {
  DEFAULT_COMPANION_PREFERENCES,
  STORAGE_KEY,
  parseCompanionPreferences,
  withViewSettings,
  type CompanionPreferences,
} from '../lib/preferences';

function setup(options: {
  service?: (command: PreferenceCommand) => Promise<unknown>;
  storage?: () => Promise<unknown>;
} = {}) {
  let current = parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
  const errors: string[] = [];
  let settled = 0;
  const defaultService = async (command: PreferenceCommand) => {
    if (command.type === 'simul:preferences:reconcile') {
      return { type: 'simul:preferences:result', applied: true, preferences: current };
    }
    if (command.type === 'simul:preferences:patch-view') {
      current = withViewSettings(current, command.patch);
      return { type: 'simul:preferences:result', applied: true, preferences: current };
    }
    if (command.type === 'simul:preferences:patch-image-analysis') {
      current = { ...current, ...command.patch };
      return { type: 'simul:preferences:result', applied: true, preferences: current };
    }
    throw new Error(`unexpected ${command.type}`);
  };
  const sendMessage = vi.fn(options.service ?? defaultService);
  const readStorage = vi.fn(options.storage ?? (async () => ({ [STORAGE_KEY]: current })));
  const store = {
    get: () => current,
    set: (next: CompanionPreferences) => {
      current = next;
    },
  };
  const client = new PreferenceClient({
    store,
    sendMessage,
    readStorage,
    onViewSettled: () => {
      settled += 1;
    },
    onError: (message) => errors.push(message),
    readableError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return {
    client,
    sendMessage,
    readStorage,
    errors,
    get current() {
      return current;
    },
    get settled() {
      return settled;
    },
  };
}

describe('PreferenceClient', () => {
  it('loads through the service and falls back to storage, then defaults', async () => {
    const viaService = setup();
    await viaService.client.load();
    expect(viaService.sendMessage).toHaveBeenCalledWith({ type: 'simul:preferences:reconcile' });

    const viaStorage = setup({
      service: async () => {
        throw new Error('no service');
      },
      storage: async () => ({ [STORAGE_KEY]: { targetLanguage: 'ja' } }),
    });
    await viaStorage.client.load();
    expect(viaStorage.current.targetLanguage).toBe('ja');

    const viaDefaults = setup({
      service: async () => {
        throw new Error('no service');
      },
      storage: async () => {
        throw new Error('no storage');
      },
    });
    await viaDefaults.client.load();
    expect(viaDefaults.current).toEqual(parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES));
  });

  it('applies a view patch optimistically and confirms it with the service', async () => {
    const harness = setup();
    const saved = harness.client.commitView({ zoomPercent: 150, displayMode: 'custom' });
    // Optimistic state is visible before the service answers.
    expect(harness.current.zoomPercent).toBe(150);
    await expect(saved).resolves.toBe(true);
    expect(harness.current.displayMode).toBe('custom');
    expect(harness.settled).toBe(1);
    expect(harness.errors).toEqual([]);
  });

  it('keeps an in-flight patch over a stored update from another window', async () => {
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
    const external = withViewSettings(parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES), {
      targetLanguage: 'fr',
    });
    const merged = harness.client.mergePending(external);
    expect(merged.syncScroll).toBe(false);
    expect(merged.targetLanguage).toBe('fr');

    answer({
      type: 'simul:preferences:result',
      applied: true,
      preferences: withViewSettings(external, { syncScroll: false }),
    });
    await expect(saving).resolves.toBe(true);
    // Once settled, the pending value no longer overrides stored state.
    expect(harness.client.mergePending(external).syncScroll).toBe(true);
  });

  it('restores stored state and reports a failed save', async () => {
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
    expect(harness.current.zoomPercent).toBe(80);
    expect(harness.errors).toEqual(['Could not save options: service down']);
    expect(harness.settled).toBe(1);

    await harness.client.commitImageAnalysis({ skipSmallImages: false });
    expect(harness.errors.at(-1)).toBe('Could not save image options: service down');
    expect(harness.current.skipSmallImages).toBe(stored.skipSmallImages);
  });

  it('reloads from storage while keeping pending values', async () => {
    const harness = setup({
      storage: async () => ({ [STORAGE_KEY]: { targetLanguage: 'de' } }),
    });
    await harness.client.reloadFromStorage();
    expect(harness.current.targetLanguage).toBe('de');
  });
});
