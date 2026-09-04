import { describe, expect, it, vi } from 'vitest';

import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { Currency } from '../entrypoints/sidepanel/currency';
import {
  PermissionFlows,
  type OriginPermissions,
  type PermissionApi,
} from '../entrypoints/sidepanel/permission-flows';
import { PreferenceClient } from '../entrypoints/sidepanel/preference-client';
import type { PreferenceCommand } from '../lib/preference-coordinator';
import {
  DEFAULT_COMPANION_PREFERENCES,
  STORAGE_KEY,
  parseCompanionPreferences,
  withAutoTranslationMode,
  withImageAnalysisSettings,
  withViewSettings,
  type CompanionPreferences,
} from '../lib/preferences';

interface Options {
  granted?: string[];
  requestAnswer?: boolean;
  lockAvailable?: boolean;
  userActivation?: boolean;
  stored?: CompanionPreferences;
  failPatch?: boolean;
  pageUrl?: string;
}

function setup(options: Options = {}) {
  const granted = new Set(options.granted ?? []);
  const permissions: PermissionApi = {
    contains: vi.fn(async ({ origins }: OriginPermissions) =>
      origins.every((origin) => granted.has(origin))),
    request: vi.fn(async ({ origins }: OriginPermissions) => {
      if (options.requestAnswer === false) return false;
      for (const origin of origins) granted.add(origin);
      return true;
    }),
    remove: vi.fn(async ({ origins }: OriginPermissions) => {
      for (const origin of origins) granted.delete(origin);
      return true;
    }),
    getAll: vi.fn(async () => ({ origins: [...granted] })),
  };
  let stored = options.stored ?? parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
  const commands: PreferenceCommand[] = [];
  const service = async (command: PreferenceCommand) => {
    commands.push(command);
    const result = (preferences: CompanionPreferences, applied = true) => ({
      type: 'simul:preferences:result',
      applied,
      preferences,
    });
    switch (command.type) {
      case 'simul:preferences:reconcile':
        return result(stored);
      case 'simul:preferences:patch-image-analysis':
        if (options.failPatch) throw new Error('service down');
        stored = withImageAnalysisSettings(stored, command.patch);
        return result(stored);
      case 'simul:preferences:patch-view':
        stored = withViewSettings(stored, command.patch);
        return result(stored);
      case 'simul:preferences:commit-auto':
        stored = withAutoTranslationMode(stored, command.pageUrl, command.mode);
        return result(stored);
      case 'simul:preferences:abort-auto':
        return result(stored);
      default:
        throw new Error(`unexpected ${command.type}`);
    }
  };
  const state = new CompanionState({ isDetachedWindow: false });
  state.preferences = stored;
  if (options.pageUrl) {
    state.followedPageIdentity = { tabId: 1, windowId: 1, url: options.pageUrl };
  }
  const statuses: string[] = [];
  const preferenceClient = new PreferenceClient({
    store: { get: () => state.preferences, set: (next) => { state.preferences = next; } },
    sendMessage: service,
    readStorage: async () => ({ [STORAGE_KEY]: stored }),
    onError: (message) => statuses.push(message),
    readableError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  const locks = {
    request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) =>
      callback(options.lockAvailable === false ? null : { name: 'lock' })),
  } as unknown as LockManager;
  const requestAutomaticTranslation = vi.fn(async () => undefined);
  const environment = {
    renderImagePanel: vi.fn(),
    configureImageTranslation: vi.fn(),
    updateControls: vi.fn(),
    syncPreferenceControls: vi.fn(),
  };
  const flows = new PermissionFlows({
    state,
    currency: new Currency(),
    permissions,
    locks: () => locks,
    isUserActivationActive: () => options.userActivation ?? true,
    preferenceClient,
    setStatus: (message) => statuses.push(message),
    requestAutomaticTranslation,
    ...environment,
  });
  return {
    flows,
    state,
    permissions,
    granted,
    statuses,
    commands,
    requestAutomaticTranslation,
    ...environment,
    get stored() {
      return stored;
    },
  };
}

describe('PermissionFlows image access', () => {
  it('reads the broad grant and reports a revocation while image translation is on', async () => {
    const harness = setup({
      granted: ['<all_urls>'],
      stored: withImageAnalysisSettings(
        parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
        { imageTranslationEnabled: true },
      ),
    });
    await harness.flows.refreshImageCaptureAccess();
    expect(harness.state.imageCaptureAccess).toBe('granted');
    expect(harness.renderImagePanel).toHaveBeenCalled();
    expect(harness.configureImageTranslation).toHaveBeenCalled();

    harness.granted.clear();
    await harness.flows.refreshImageCaptureAccess(true);
    expect(harness.state.imageCaptureAccess).toBe('missing');
    expect(harness.statuses.at(-1)).toContain('Image access was removed');
  });

  it('enables image translation by requesting the grant and saving the setting', async () => {
    const harness = setup();
    await harness.flows.changeImageTranslationEnabled(true);
    expect(harness.permissions.request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(harness.stored.imageTranslationEnabled).toBe(true);
    expect(harness.state.preferences.imageTranslationEnabled).toBe(true);
    expect(harness.state.imageCaptureAccess).toBe('granted');
    expect(harness.state.permissionInFlight).toBe(false);
    expect(harness.statuses.at(-1)).toBe('Image translation is enabled for visible page images.');
  });

  it('keeps the setting off when Chrome denies the grant', async () => {
    const harness = setup({ requestAnswer: false });
    await harness.flows.changeImageTranslationEnabled(true);
    expect(harness.stored.imageTranslationEnabled).toBe(false);
    expect(harness.statuses.at(-1)).toContain('Chrome did not grant image access');
  });

  it('asks for a second gesture without user activation and yields to a busy lock', async () => {
    const activation = setup({ userActivation: false });
    await activation.flows.changeImageTranslationEnabled(true);
    expect(activation.permissions.request).not.toHaveBeenCalled();
    expect(activation.statuses.at(-1)).toContain('Choose the image setting again');

    const busy = setup({ lockAvailable: false });
    await busy.flows.changeImageTranslationEnabled(true);
    expect(busy.statuses.at(-1)).toContain('Another companion window is saving image access');
  });

  it('rolls a fresh grant back when the save fails', async () => {
    const harness = setup({ failPatch: true });
    await harness.flows.changeImageTranslationEnabled(true);
    expect(harness.permissions.remove).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
    expect(harness.granted.has('<all_urls>')).toBe(false);
    expect(harness.statuses.at(-1)).toContain('Chrome could not update image access');
    expect(harness.state.permissionInFlight).toBe(false);
  });

  it('turns image translation off and drops the broad grant when automation does not need it', async () => {
    const harness = setup({
      granted: ['<all_urls>'],
      stored: withImageAnalysisSettings(
        parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
        { imageTranslationEnabled: true },
      ),
    });
    await harness.flows.changeImageTranslationEnabled(false);
    expect(harness.granted.has('<all_urls>')).toBe(false);
    expect(harness.stored.imageTranslationEnabled).toBe(false);
    expect(harness.statuses.at(-1)).toBe('Image translation is off.');
  });
});

describe('PermissionFlows automatic translation', () => {
  it('refuses this-site automation without a regular page', async () => {
    const harness = setup();
    await harness.flows.changeAutoTranslationMode('site');
    expect(harness.statuses.at(-1)).toContain('Open a regular HTTP or HTTPS page');
    expect(harness.commands).toEqual([]);
  });

  it('commits all-sites automation after the grant and starts translating', async () => {
    const harness = setup({ pageUrl: 'https://example.com/article' });
    await harness.flows.changeAutoTranslationMode('all');
    expect(harness.permissions.request).toHaveBeenCalled();
    expect(harness.commands.map((command) => command.type)).toContain('simul:preferences:commit-auto');
    expect(harness.state.preferences.autoTranslateAllSites).toBe(true);
    expect(harness.statuses.at(-1)).toBe('Automatic translation is enabled for regular web pages.');
    expect(harness.requestAutomaticTranslation).toHaveBeenCalledWith('https://example.com/article');
    expect(harness.state.permissionInFlight).toBe(false);
  });

  it('aborts the change when Chrome denies the site grant', async () => {
    const harness = setup({ pageUrl: 'https://example.com/article', requestAnswer: false });
    await harness.flows.changeAutoTranslationMode('site');
    expect(harness.commands.map((command) => command.type)).toContain('simul:preferences:abort-auto');
    expect(harness.statuses.at(-1)).toBe('Chrome did not retain the requested automatic-access scope.');
    expect(harness.requestAutomaticTranslation).not.toHaveBeenCalled();
  });

  it('reports whether reconciliation changed the page scope', async () => {
    const harness = setup({ pageUrl: 'https://example.com/article' });
    expect(await harness.flows.reconcileAutomaticAccess('https://example.com/article')).toBe(false);
    harness.state.preferences = withAutoTranslationMode(
      harness.state.preferences,
      'https://example.com/article',
      'site',
    );
    // The service still holds the stored (off) preferences, so the local
    // optimistic scope is reported as revoked.
    expect(await harness.flows.reconcileAutomaticAccess('https://example.com/article')).toBe(true);
    expect(harness.syncPreferenceControls).toHaveBeenCalled();
  });
});
