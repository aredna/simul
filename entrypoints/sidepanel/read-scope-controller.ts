import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import { readableError } from '../../lib/page-identity';
import type { PreferenceCommand, PreferenceCommandResult } from '../../lib/preference-coordinator';
import {
  PREFERENCE_SAFETY_PROTOCOL_VERSION,
  readPreferenceSafetyPrepareMessage,
  readPreferenceSafetyReleaseMessage,
} from '../../lib/preference-safety-coordinator';
import type { CompanionPreferences } from '../../lib/preferences';
import {
  PAGE_ONLY_REPLICA_READ_SCOPE,
  REPLICA_READ_SCOPE_KEYS,
  REPLICA_READ_SCOPE_SETUP_VERSION,
  deriveReplicaReadScopeProfile,
  effectiveReplicaReadScope,
  intersectReplicaReadScopes,
  replicaReadScopeFingerprint,
  replicaReadScopeForProfile,
  replicaReadScopeNarrows,
  type ReplicaReadScope,
  type ReplicaReadScopeKey,
  type ReplicaReadScopeProfileId,
} from '../../lib/replica/read-scope-policy';
import { installResetConfirmationController } from '../../lib/reset-confirmation-controller';
import type { CompanionState } from './companion-state';

export interface ReadScopeElements {
  readonly readScopeSetup: HTMLDialogElement;
  readonly setupReadProfile: HTMLSelectElement;
  readonly setupReadScopeControls: HTMLElement;
  readonly completeReadScopeSetupButton: HTMLButtonElement;
  readonly setupReadScopeStatus: HTMLElement;
  readonly setupResetCleanup: HTMLElement;
  readonly setupResetCleanupStatus: HTMLElement;
  readonly retrySetupResetCleanupButton: HTMLButtonElement;
  readonly readScopeProfile: HTMLSelectElement;
  readonly readScopeControls: HTMLElement;
  readonly resetAllSettingsButton: HTMLButtonElement;
  readonly resetSettingsDialog: HTMLDialogElement;
  readonly resetSettingsStatus: HTMLElement;
}

export interface ReadScopeControllerEnvironment {
  readonly state: CompanionState;
  readonly document: Document;
  readonly elements: ReadScopeElements;
  readonly preferenceClient: {
    send(command: PreferenceCommand): Promise<PreferenceCommandResult>;
    applyCommitted(value: unknown): boolean;
  };
  /** Drops everything derived from the source page under the old policy. */
  readonly purgeSourceDerivedRuntime: (message: string) => Promise<void>;
  /** Clears state that only a full reset may discard (drafts, diagnostics). */
  readonly clearResetOnlyRuntimeState: () => void;
  /** Rebuilds the replica and reconfigures image work under the new policy. */
  readonly restartReplica: () => void;
  readonly syncPreferenceControls: () => void;
  readonly setStatus: (message: string, tone?: CompanionStatusTone) => void;
}

const READ_SCOPE_COPY: Readonly<Record<
  ReplicaReadScopeKey,
  { readonly label: string; readonly description: string }
>> = Object.freeze({
  controlSemantics: {
    label: 'Control labels and semantics',
    description: 'Read public button, menu, field-label, and disabled-state text.',
  },
  controlImages: {
    label: 'Images inside controls',
    description: 'Read non-secret navigation and control images; actions stay disabled.',
  },
  disclosureContent: {
    label: 'Collapsed disclosure content',
    description: 'Read validated same-page menus and disclosures even while collapsed.',
  },
  formValues: {
    label: 'Ordinary visible form values',
    description: 'Read visible text, search, URL, textarea, and selection state.',
  },
  personalDataValues: {
    label: 'Personal and autofill values',
    description: 'Read visible email, telephone, name, address, and username fields. Credential and card data stay blocked.',
  },
  editableContent: {
    label: 'Editable page content',
    description: 'Read visible non-secret contenteditable and ARIA text editor drafts.',
  },
});

/**
 * The readable-content policy: the mandatory first-run setup, the live
 * profile and per-key toggles, the full reset, and the safety protocol that
 * keeps every companion window at or below a narrowing scope until the
 * background has committed it. Narrowing is a content-retention boundary,
 * so a purge runs before the save and a failed save keeps the ceiling.
 */
export class ReadScopeController {
  constructor(private readonly environment: ReadScopeControllerEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  /** Wires the setup dialog, the profile menus and the reset confirmation. */
  installListeners(): void {
    const { elements, state } = this.environment;
    elements.readScopeProfile.addEventListener('change', () => {
      if (!isReplicaReadScopeProfileId(elements.readScopeProfile.value)) return;
      void this.commitReplicaReadScope(
        replicaReadScopeForProfile(elements.readScopeProfile.value),
        false,
      );
    });
    elements.setupReadProfile.addEventListener('change', () => {
      if (!isReplicaReadScopeProfileId(elements.setupReadProfile.value)) return;
      state.setupReadScopeDraft = replicaReadScopeForProfile(elements.setupReadProfile.value);
      this.renderControls();
    });
    elements.completeReadScopeSetupButton.addEventListener('click', () => {
      void this.commitReplicaReadScope(state.setupReadScopeDraft, true);
    });
    elements.retrySetupResetCleanupButton.addEventListener('click', () => {
      void this.resetAllExtensionSettings();
    });
    elements.readScopeSetup.addEventListener('cancel', (event) => {
      // Choosing a read scope is mandatory. Keep the effective policy at
      // Page-only until a setup choice has been committed successfully.
      event.preventDefault();
    });
    installResetConfirmationController({
      dialog: elements.resetSettingsDialog,
      trigger: elements.resetAllSettingsButton,
      shouldBypassConfirmation: () => state.preferences.resetCleanupPendingRevision > 0,
      onConfirm: () => this.resetAllExtensionSettings(),
    });
  }

  /** The committed scope narrowed by every ceiling still in force. */
  currentReplicaReadScope(): ReplicaReadScope {
    const state = this.#state;
    let scope = committedReplicaReadScope(state.preferences);
    if (!state.preferenceSafetyConnectionReady || state.livePreferenceStorageFailClosed) {
      scope = intersectReplicaReadScopes(scope, PAGE_ONLY_REPLICA_READ_SCOPE);
    }
    for (const gate of state.localReadScopeNarrowingGates.values()) {
      scope = intersectReplicaReadScopes(scope, gate.scope);
    }
    for (const gate of state.remoteReadScopeNarrowingGates.scopes()) {
      scope = intersectReplicaReadScopes(scope, gate);
    }
    return scope;
  }

  /** A committed snapshot arrived; keep the setup draft and gates in step. */
  handleCommittedPreferences(previous: CompanionPreferences): void {
    const state = this.#state;
    if (
      state.preferences.readScopeSetupVersion !== REPLICA_READ_SCOPE_SETUP_VERSION &&
      (
        previous.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION ||
        state.preferences.resetRevision > previous.resetRevision
      )
    ) {
      state.setupReadScopeDraft = replicaReadScopeForProfile('standard');
    }
    this.releaseSatisfiedGates();
  }

  /** Whether a stored change moved the read policy or reset revision. */
  readPolicyChanged(previous: CompanionPreferences, wasStorageFailClosed: boolean): boolean {
    const state = this.#state;
    return (
      wasStorageFailClosed ||
      replicaReadScopeFingerprint(committedReplicaReadScope(previous)) !==
        replicaReadScopeFingerprint(committedReplicaReadScope(state.preferences)) ||
      previous.resetRevision !== state.preferences.resetRevision
    );
  }

  async commitReplicaReadScope(scope: ReplicaReadScope, completeSetup: boolean): Promise<void> {
    const state = this.#state;
    const { elements, preferenceClient, setStatus } = this.environment;
    const sequence = ++state.readScopeCommitSequence;
    const committedAtDispatch = committedReplicaReadScope(state.preferences);
    const current = this.currentReplicaReadScope();
    const narrowing = replicaReadScopeNarrows(current, scope);
    if (narrowing) {
      state.localReadScopeNarrowingGates.set(sequence, {
        scope: intersectReplicaReadScopes(current, scope),
        failed: false,
      });
      void this.environment.purgeSourceDerivedRuntime('Applying narrower read settings…');
    }
    elements.completeReadScopeSetupButton.disabled = completeSetup;
    elements.setupReadScopeStatus.textContent = completeSetup ? 'Saving…' : '';
    try {
      const result = await preferenceClient.send(completeSetup
        ? {
            type: 'simul:preferences:complete-read-scope-setup',
            expectedResetRevision: state.preferences.resetRevision,
            expectedSetupVersion: state.preferences.readScopeSetupVersion,
            expectedReadScopeFingerprint: replicaReadScopeFingerprint(committedAtDispatch),
            patch: { replicaReadScope: scope },
          }
        : {
            type: 'simul:preferences:patch-read-scope',
            expectedResetRevision: state.preferences.resetRevision,
            expectedReadScopeFingerprint: replicaReadScopeFingerprint(committedAtDispatch),
            patch: { replicaReadScope: scope },
          });
      preferenceClient.applyCommitted(result.preferences);
      if (!result.applied) {
        const gate = state.localReadScopeNarrowingGates.get(sequence);
        if (gate) gate.failed = true;
        throw new Error(result.code === 'stale-reset-revision'
          ? 'Settings changed in another companion. Review the current choices and try again.'
          : result.code === 'stale-read-scope'
            ? 'Readable-content settings changed in another companion. Review the current choices and try again.'
            : result.code === 'safety-ack-failed'
              ? 'Another companion could not confirm its safety purge. Close it or retry the change.'
          : 'The read settings were not applied.');
      }
      for (const pendingSequence of [...state.localReadScopeNarrowingGates.keys()]) {
        if (pendingSequence <= sequence) {
          state.localReadScopeNarrowingGates.delete(pendingSequence);
        }
      }
      state.setupReadScopeDraft = { ...state.preferences.replicaReadScope };
      this.environment.syncPreferenceControls();
      this.environment.restartReplica();
      elements.setupReadScopeStatus.textContent = '';
      setStatus('Readable-content settings applied. The replica is rebuilding.', 'success');
    } catch (error) {
      const gate = state.localReadScopeNarrowingGates.get(sequence);
      if (gate) gate.failed = true;
      elements.setupReadScopeStatus.textContent = readableError(error);
      elements.setupReadScopeStatus.dataset.tone = 'error';
      this.environment.syncPreferenceControls();
      if (state.localReadScopeNarrowingGates.has(sequence)) {
        this.environment.restartReplica();
      }
      setStatus(`Could not save readable-content settings: ${readableError(error)}`, 'error');
    } finally {
      elements.completeReadScopeSetupButton.disabled = false;
    }
  }

  async resetAllExtensionSettings(): Promise<void> {
    const state = this.#state;
    const { elements, preferenceClient } = this.environment;
    if (state.resetInFlight) return;
    state.resetInFlight = true;
    elements.resetAllSettingsButton.disabled = true;
    elements.retrySetupResetCleanupButton.disabled = true;
    elements.resetSettingsStatus.textContent = 'Resetting settings and optional permissions…';
    if (state.preferences.resetCleanupPendingRevision > 0) {
      elements.setupResetCleanupStatus.textContent =
        'Retrying optional permission and runtime cleanup…';
    }
    try {
      const retry = state.preferences.resetCleanupPendingRevision > 0;
      const result = await preferenceClient.send(retry
        ? {
            type: 'simul:preferences:retry-reset-cleanup',
            expectedResetRevision: state.preferences.resetRevision,
          }
        : {
            type: 'simul:preferences:reset-all',
            expectedResetRevision: state.preferences.resetRevision,
          });
      preferenceClient.applyCommitted(result.preferences);
      if (!result.applied && result.code === 'stale-reset-revision') {
        this.environment.syncPreferenceControls();
        elements.resetSettingsStatus.textContent =
          'Settings changed in another companion. Review the current state before resetting.';
        if (state.preferences.resetCleanupPendingRevision > 0) {
          elements.setupResetCleanupStatus.textContent = elements.resetSettingsStatus.textContent;
        }
        return;
      }
      if (!result.applied && result.code === 'safety-ack-failed') {
        this.environment.syncPreferenceControls();
        elements.resetSettingsStatus.textContent =
          'Another companion could not confirm its safety purge. Close it or retry the reset.';
        return;
      }
      void this.environment.purgeSourceDerivedRuntime('Resetting extension settings…');
      this.environment.clearResetOnlyRuntimeState();
      state.setupReadScopeDraft = replicaReadScopeForProfile('standard');
      this.environment.syncPreferenceControls();
      if (result.cleanup?.status === 'pending') {
        const cleanupMessage =
          result.cleanup.remainingManagedOrigins > 0
            ? `Core settings are reset. ${result.cleanup.remainingManagedOrigins} optional permission entr${result.cleanup.remainingManagedOrigins === 1 ? 'y remains' : 'ies remain'} and cleanup is still pending; choose Retry cleanup.`
            : 'Core settings are reset, but permission or runtime cleanup is still pending; choose Retry cleanup.';
        elements.resetSettingsStatus.textContent = cleanupMessage;
        elements.setupResetCleanupStatus.textContent = cleanupMessage;
      } else {
        elements.resetSettingsStatus.textContent =
          'Settings and optional permissions were reset. Choose a read profile to continue.';
      }
    } catch (error) {
      elements.resetSettingsStatus.textContent = `Reset could not finish: ${readableError(error)}`;
      if (state.preferences.resetCleanupPendingRevision > 0) {
        elements.setupResetCleanupStatus.textContent = elements.resetSettingsStatus.textContent;
      }
    } finally {
      state.resetInFlight = false;
      elements.resetAllSettingsButton.disabled = false;
      elements.retrySetupResetCleanupButton.disabled = false;
      this.renderControls();
    }
  }

  /** The background asks this window to purge before a narrowing or reset. */
  async handleSafetyMessage(
    value: unknown,
    reply: (message: unknown) => void,
  ): Promise<void> {
    const state = this.#state;
    const prepare = readPreferenceSafetyPrepareMessage(value);
    if (prepare) {
      state.remoteReadScopeNarrowingGates.prepare(prepare.requestId, prepare.targetReadScope);
      if (prepare.operation === 'reset') state.localReadScopeNarrowingGates.clear();
      const purge = this.environment.purgeSourceDerivedRuntime(
        prepare.operation === 'reset'
          ? 'Preparing a safe settings reset…'
          : 'Preparing narrower read settings…',
      );
      if (prepare.operation === 'reset') this.environment.clearResetOnlyRuntimeState();
      await purge;
      reply({
        kind: 'simul:preference-safety-v1:ack',
        version: PREFERENCE_SAFETY_PROTOCOL_VERSION,
        requestId: prepare.requestId,
      });
      return;
    }

    const release = readPreferenceSafetyReleaseMessage(value);
    if (!release) return;
    if (
      release.committed &&
      state.remoteReadScopeNarrowingGates.authorizeCommittedRelease(release.requestId)
    ) {
      this.releaseSatisfiedGates();
    }
  }

  /** Drops every ceiling the committed policy already satisfies. */
  releaseSatisfiedGates(): void {
    const state = this.#state;
    const committed = committedReplicaReadScope(state.preferences);
    state.remoteReadScopeNarrowingGates.releaseSatisfied(committed);
    for (const [sequence, gate] of state.localReadScopeNarrowingGates) {
      if (gate.failed && readScopeIsNoBroaderThan(committed, gate.scope)) {
        state.localReadScopeNarrowingGates.delete(sequence);
      }
    }
  }

  renderControls(): void {
    const state = this.#state;
    const { elements, document } = this.environment;
    const setupComplete =
      state.preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION;
    const cleanupPending = state.preferences.resetCleanupPendingRevision > 0;
    const setupDialogWasOpen = elements.readScopeSetup.open;
    if (setupComplete) {
      if (elements.readScopeSetup.open) elements.readScopeSetup.close();
    } else if (!elements.readScopeSetup.open) {
      // A reset committed in another companion can arrive while this panel's
      // reset confirmation is open. Do not leave a stale modal underneath the
      // mandatory setup dialog.
      if (elements.resetSettingsDialog.open) elements.resetSettingsDialog.close('cancel');
      elements.readScopeSetup.showModal();
    }
    const configuredScope = setupComplete
      ? state.preferences.replicaReadScope
      : replicaReadScopeForProfile('page-only');
    elements.readScopeProfile.value = deriveReplicaReadScopeProfile(configuredScope);
    elements.setupReadProfile.value = deriveReplicaReadScopeProfile(state.setupReadScopeDraft);
    this.#renderToggleSet(elements.readScopeControls, configuredScope, (key, checked) => {
      const next = normalizeReadScopeToggle(configuredScope, key, checked);
      void this.commitReplicaReadScope(next, false);
    });
    this.#renderToggleSet(
      elements.setupReadScopeControls,
      state.setupReadScopeDraft,
      (key, checked) => {
        state.setupReadScopeDraft = normalizeReadScopeToggle(
          state.setupReadScopeDraft,
          key,
          checked,
        );
        this.renderControls();
      },
    );
    elements.setupResetCleanup.hidden = !cleanupPending;
    elements.retrySetupResetCleanupButton.disabled = state.resetInFlight;
    if (cleanupPending && !state.setupCleanupWasPending && !state.resetInFlight) {
      elements.setupResetCleanupStatus.textContent =
        'Core settings are already safe, but optional permission or runtime cleanup is still pending.';
    }
    if (
      cleanupPending &&
      !setupComplete &&
      (!setupDialogWasOpen || !state.setupCleanupWasPending)
    ) {
      elements.retrySetupResetCleanupButton.focus();
    } else if (
      !cleanupPending &&
      state.setupCleanupWasPending &&
      elements.readScopeSetup.open &&
      document.activeElement === elements.retrySetupResetCleanupButton
    ) {
      elements.setupReadProfile.focus();
    }
    state.setupCleanupWasPending = cleanupPending;
    elements.resetAllSettingsButton.textContent = cleanupPending
      ? 'Retry reset cleanup'
      : 'Reset all extension settings…';
  }

  #renderToggleSet(
    host: HTMLElement,
    scope: ReplicaReadScope,
    onChange: (key: ReplicaReadScopeKey, checked: boolean) => void,
  ): void {
    const { document } = this.environment;
    const fragment = document.createDocumentFragment();
    for (const key of REPLICA_READ_SCOPE_KEYS) {
      const label = document.createElement('label');
      label.className = 'read-scope-control';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = scope[key];
      input.disabled = key === 'personalDataValues' && !scope.formValues;
      input.dataset.readScopeKey = key;
      const text = document.createElement('span');
      text.textContent = READ_SCOPE_COPY[key].label;
      const description = document.createElement('small');
      description.textContent = READ_SCOPE_COPY[key].description;
      text.append(description);
      label.append(input, text);
      input.addEventListener('change', () => onChange(key, input.checked));
      fragment.append(label);
    }
    host.replaceChildren(fragment);
  }
}

/** The scope a snapshot commits to, or Page-only until setup completes. */
export function committedReplicaReadScope(candidate: CompanionPreferences): ReplicaReadScope {
  return effectiveReplicaReadScope(candidate.replicaReadScope, candidate.readScopeSetupVersion);
}

export function normalizeReadScopeToggle(
  scope: ReplicaReadScope,
  key: ReplicaReadScopeKey,
  checked: boolean,
): ReplicaReadScope {
  const next = { ...scope, [key]: checked };
  if (key === 'formValues' && !checked) next.personalDataValues = false;
  if (key === 'personalDataValues' && checked) next.formValues = true;
  return next;
}

export function isReplicaReadScopeProfileId(value: string): value is ReplicaReadScopeProfileId {
  return value === 'page-only' || value === 'standard' || value === 'full-visible';
}

function readScopeIsNoBroaderThan(candidate: ReplicaReadScope, ceiling: ReplicaReadScope): boolean {
  return replicaReadScopeFingerprint(intersectReplicaReadScopes(candidate, ceiling)) ===
    replicaReadScopeFingerprint(candidate);
}
