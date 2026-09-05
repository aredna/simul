import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import {
  ReadScopeController,
  committedReplicaReadScope,
  normalizeReadScopeToggle,
} from '../entrypoints/sidepanel/read-scope-controller';
import type { PreferenceCommand, PreferenceCommandResult } from '../lib/preference-coordinator';
import {
  DEFAULT_COMPANION_PREFERENCES,
  parseCompanionPreferences,
  withReadSettings,
  type CompanionPreferences,
} from '../lib/preferences';
import {
  REPLICA_READ_SCOPE_SETUP_VERSION,
  replicaReadScopeFingerprint,
  replicaReadScopeForProfile,
  sameReplicaReadScope,
} from '../lib/replica/read-scope-policy';

const MARKUP = `<html><body>
  <dialog id="setup">
    <select id="setup-profile"><option value="page-only"></option><option value="standard"></option><option value="full-visible"></option><option value="custom"></option></select>
    <div id="setup-controls"></div>
    <button id="complete"></button>
    <p id="setup-status"></p>
    <div id="setup-cleanup" hidden><p id="setup-cleanup-status"></p><button id="retry"></button></div>
  </dialog>
  <select id="profile"><option value="page-only"></option><option value="standard"></option><option value="full-visible"></option><option value="custom"></option></select>
  <div id="controls"></div>
  <button id="reset"></button>
  <dialog id="reset-dialog"></dialog>
  <p id="reset-status"></p>
</body></html>`;

function stubDialog(dialog: HTMLDialogElement): void {
  let open = false;
  Object.defineProperty(dialog, 'open', { get: () => open, configurable: true });
  Object.assign(dialog, {
    showModal: () => {
      open = true;
    },
    close: () => {
      open = false;
    },
  });
}

function setup(options: {
  stored?: CompanionPreferences;
  safetyReady?: boolean;
  failSaves?: boolean;
  cleanupRemaining?: number;
} = {}) {
  const { document, window } = parseHTML(MARKUP);
  const el = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
  const elements = {
    readScopeSetup: el<HTMLDialogElement>('setup'),
    setupReadProfile: el<HTMLSelectElement>('setup-profile'),
    setupReadScopeControls: el<HTMLElement>('setup-controls'),
    completeReadScopeSetupButton: el<HTMLButtonElement>('complete'),
    setupReadScopeStatus: el<HTMLElement>('setup-status'),
    setupResetCleanup: el<HTMLElement>('setup-cleanup'),
    setupResetCleanupStatus: el<HTMLElement>('setup-cleanup-status'),
    retrySetupResetCleanupButton: el<HTMLButtonElement>('retry'),
    readScopeProfile: el<HTMLSelectElement>('profile'),
    readScopeControls: el<HTMLElement>('controls'),
    resetAllSettingsButton: el<HTMLButtonElement>('reset'),
    resetSettingsDialog: el<HTMLDialogElement>('reset-dialog'),
    resetSettingsStatus: el<HTMLElement>('reset-status'),
  };
  stubDialog(elements.readScopeSetup);
  stubDialog(elements.resetSettingsDialog);
  for (const select of [elements.setupReadProfile, elements.readScopeProfile]) {
    let value = 'standard';
    Object.defineProperty(select, 'value', {
      get: () => value,
      set: (next: string) => {
        value = next;
      },
      configurable: true,
    });
  }
  let stored = options.stored ?? parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
  const state = new CompanionState({ isDetachedWindow: false });
  state.preferences = stored;
  state.preferenceSafetyConnectionReady = options.safetyReady ?? true;
  const events: string[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const commands: PreferenceCommand[] = [];
  const result = (
    preferences: CompanionPreferences,
    applied = true,
    extra: Partial<PreferenceCommandResult> = {},
  ): PreferenceCommandResult =>
    ({ type: 'simul:preferences:result', applied, preferences, ...extra });
  let controller!: ReadScopeController;
  const preferenceClient = {
    send: vi.fn(async (command: PreferenceCommand): Promise<PreferenceCommandResult> => {
      commands.push(command);
      events.push(`send:${command.type}`);
      switch (command.type) {
        case 'simul:preferences:patch-read-scope':
        case 'simul:preferences:complete-read-scope-setup':
          if (options.failSaves) return result(stored, false, { code: 'stale-read-scope' });
          stored = withReadSettings(stored, {
            replicaReadScope: command.patch.replicaReadScope,
            ...(command.type === 'simul:preferences:complete-read-scope-setup'
              ? { readScopeSetupVersion: REPLICA_READ_SCOPE_SETUP_VERSION }
              : {}),
          });
          return result(stored);
        case 'simul:preferences:reset-all':
        case 'simul:preferences:retry-reset-cleanup':
          stored = parseCompanionPreferences({
            ...DEFAULT_COMPANION_PREFERENCES,
            resetRevision: stored.resetRevision + 1,
            resetCleanupPendingRevision: options.cleanupRemaining ? stored.resetRevision + 1 : 0,
          });
          return result(stored, true, options.cleanupRemaining
            ? { cleanup: { status: 'pending', remainingManagedOrigins: options.cleanupRemaining } }
            : { cleanup: { status: 'complete', remainingManagedOrigins: 0 } });
        default:
          throw new Error(`unexpected ${command.type}`);
      }
    }),
    applyCommitted: vi.fn((value: unknown) => {
      const previous = state.preferences;
      state.preferences = parseCompanionPreferences(value);
      controller.handleCommittedPreferences(previous);
      return true;
    }),
  };
  controller = new ReadScopeController({
    state,
    document: document as unknown as Document,
    elements,
    preferenceClient,
    purgeSourceDerivedRuntime: async (message) => {
      events.push(`purge:${message}`);
    },
    clearResetOnlyRuntimeState: () => events.push('reset-only-cleared'),
    restartReplica: () => events.push('restart'),
    syncPreferenceControls: () => events.push('sync'),
    setStatus: (message, tone) => statuses.push([message, tone]),
  });
  return {
    window, controller, state, elements, events, statuses, commands, preferenceClient,
    get stored() {
      return stored;
    },
  };
}

const setupComplete = (profile: 'page-only' | 'standard' | 'full-visible') =>
  withReadSettings(parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES), {
    replicaReadScope: replicaReadScopeForProfile(profile),
    readScopeSetupVersion: REPLICA_READ_SCOPE_SETUP_VERSION,
  });

describe('ReadScopeController setup', () => {
  it('opens the mandatory setup dialog until a profile is committed', async () => {
    const harness = setup({ safetyReady: false });
    harness.controller.installListeners();
    harness.controller.renderControls();
    expect(harness.elements.readScopeSetup.open).toBe(true);
    expect(harness.elements.setupReadScopeControls.querySelectorAll('input')).toHaveLength(6);
    expect(harness.elements.readScopeControls.querySelectorAll('input')).toHaveLength(6);
    // Until setup completes and the safety connection is up, only Page-only applies.
    expect(sameReplicaReadScope(
      harness.controller.currentReplicaReadScope(),
      replicaReadScopeForProfile('page-only'),
    )).toBe(true);

    harness.elements.completeReadScopeSetupButton.dispatchEvent(new harness.window.Event('click'));
    await vi.waitFor(() => expect(harness.statuses.length).toBeGreaterThan(0));
    expect(harness.commands[0]).toMatchObject({
      type: 'simul:preferences:complete-read-scope-setup',
      expectedSetupVersion: 0,
      patch: { replicaReadScope: replicaReadScopeForProfile('standard') },
    });
    expect(harness.stored.readScopeSetupVersion).toBe(REPLICA_READ_SCOPE_SETUP_VERSION);
    expect(harness.statuses.at(-1)).toEqual([
      'Readable-content settings applied. The replica is rebuilding.',
      'success',
    ]);
    expect(harness.events).toContain('restart');
    harness.controller.renderControls();
    expect(harness.elements.readScopeSetup.open).toBe(false);
    harness.state.preferenceSafetyConnectionReady = true;
    expect(sameReplicaReadScope(
      harness.controller.currentReplicaReadScope(),
      replicaReadScopeForProfile('standard'),
    )).toBe(true);
  });

  it('keeps the personal-data toggle dependent on form values', () => {
    const standard = replicaReadScopeForProfile('standard');
    const noForms = normalizeReadScopeToggle({ ...standard, formValues: true, personalDataValues: true }, 'formValues', false);
    expect(noForms.personalDataValues).toBe(false);
    const withPersonal = normalizeReadScopeToggle({ ...standard, formValues: false }, 'personalDataValues', true);
    expect(withPersonal.formValues).toBe(true);
    expect(committedReplicaReadScope(setupComplete('full-visible')).formValues).toBe(true);
    expect(committedReplicaReadScope(parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES)))
      .toEqual(replicaReadScopeForProfile('page-only'));
  });
});

describe('ReadScopeController narrowing', () => {
  it('purges before a narrowing save and widens without one', async () => {
    const harness = setup({ stored: setupComplete('full-visible') });
    await harness.controller.commitReplicaReadScope(replicaReadScopeForProfile('page-only'), false);
    expect(harness.events.indexOf('purge:Applying narrower read settings…'))
      .toBeLessThan(harness.events.indexOf('send:simul:preferences:patch-read-scope'));
    expect(harness.commands[0]).toMatchObject({
      type: 'simul:preferences:patch-read-scope',
      expectedReadScopeFingerprint: replicaReadScopeFingerprint(replicaReadScopeForProfile('full-visible')),
    });
    expect(harness.state.localReadScopeNarrowingGates.size).toBe(0);
    expect(harness.events).toContain('restart');

    harness.events.length = 0;
    await harness.controller.commitReplicaReadScope(replicaReadScopeForProfile('full-visible'), false);
    expect(harness.events.some((event) => event.startsWith('purge:'))).toBe(false);
    expect(harness.stored.replicaReadScope).toEqual(replicaReadScopeForProfile('full-visible'));
  });

  it('keeps the narrower ceiling when the save is refused, until a matching commit arrives', async () => {
    const harness = setup({ stored: setupComplete('full-visible'), failSaves: true });
    await harness.controller.commitReplicaReadScope(replicaReadScopeForProfile('page-only'), false);
    expect(harness.statuses.at(-1)?.[0]).toContain('Could not save readable-content settings');
    expect(harness.elements.setupReadScopeStatus.dataset.tone).toBe('error');
    expect(harness.state.localReadScopeNarrowingGates.get(1)?.failed).toBe(true);
    expect(sameReplicaReadScope(
      harness.controller.currentReplicaReadScope(),
      replicaReadScopeForProfile('page-only'),
    )).toBe(true);
    expect(harness.events).toContain('restart');

    // A committed snapshot at or below the ceiling releases it.
    harness.preferenceClient.applyCommitted(setupComplete('page-only'));
    expect(harness.state.localReadScopeNarrowingGates.size).toBe(0);
  });

  it('reports stored changes that move the policy or the reset revision', () => {
    const harness = setup({ stored: setupComplete('standard') });
    const previous = harness.state.preferences;
    expect(harness.controller.readPolicyChanged(previous, false)).toBe(false);
    expect(harness.controller.readPolicyChanged(previous, true)).toBe(true);
    harness.state.preferences = setupComplete('page-only');
    expect(harness.controller.readPolicyChanged(previous, false)).toBe(true);
    harness.state.preferences = parseCompanionPreferences({ ...previous, resetRevision: previous.resetRevision + 1 });
    expect(harness.controller.readPolicyChanged(previous, false)).toBe(true);
  });
});

describe('ReadScopeController reset and safety', () => {
  it('resets everything, clears reset-only state and reports pending cleanup', async () => {
    const harness = setup({ stored: setupComplete('standard'), cleanupRemaining: 2 });
    await harness.controller.resetAllExtensionSettings();
    expect(harness.commands[0]).toMatchObject({ type: 'simul:preferences:reset-all', expectedResetRevision: 0 });
    expect(harness.events).toContain('purge:Resetting extension settings…');
    expect(harness.events).toContain('reset-only-cleared');
    expect(harness.state.setupReadScopeDraft).toEqual(replicaReadScopeForProfile('standard'));
    expect(harness.elements.resetSettingsStatus.textContent)
      .toContain('2 optional permission entries remain');
    expect(harness.state.resetInFlight).toBe(false);
    expect(harness.elements.readScopeSetup.open).toBe(true);
    expect(harness.elements.setupResetCleanup.hidden).toBe(false);
    expect(harness.elements.resetAllSettingsButton.textContent).toBe('Retry reset cleanup');

    await harness.controller.resetAllExtensionSettings();
    expect(harness.commands[1]?.type).toBe('simul:preferences:retry-reset-cleanup');
  });

  it('purges and acknowledges a safety prepare, then releases on the committed release', async () => {
    const harness = setup({ stored: setupComplete('full-visible') });
    const target = replicaReadScopeForProfile('page-only');
    const replies: unknown[] = [];
    await harness.controller.handleSafetyMessage({
      kind: 'simul:preference-safety-v1:prepare',
      version: 1,
      requestId: 'r1',
      operation: 'read-narrow',
      targetReadScope: target,
      targetFingerprint: replicaReadScopeFingerprint(target),
    }, (message) => replies.push(message));
    expect(harness.events).toContain('purge:Preparing narrower read settings…');
    expect(replies).toEqual([
      { kind: 'simul:preference-safety-v1:ack', version: 1, requestId: 'r1' },
    ]);
    expect(sameReplicaReadScope(harness.controller.currentReplicaReadScope(), target)).toBe(true);

    harness.state.preferences = setupComplete('page-only');
    await harness.controller.handleSafetyMessage({
      kind: 'simul:preference-safety-v1:release',
      version: 1,
      requestId: 'r1',
      committed: true,
    }, () => undefined);
    expect(harness.state.remoteReadScopeNarrowingGates.scopes()).toHaveLength(0);
    await harness.controller.handleSafetyMessage({ kind: 'other' }, () => undefined);
    expect(replies).toHaveLength(1);
  });
});
