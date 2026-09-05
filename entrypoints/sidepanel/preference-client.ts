import { readableError } from '../../lib/page-identity';
import {
  readPreferenceCommandResult,
  type PreferenceCommand,
  type PreferenceCommandResult,
} from '../../lib/preference-coordinator';
import {
  DEFAULT_COMPANION_PREFERENCES,
  STORAGE_KEY,
  clampZoomPercent,
  parseCompanionPreferences,
  selectLatestCompanionPreferences,
  type CompanionImageAnalysisSettingsPatch,
  type CompanionPreferences,
  type CompanionSurface,
  type CompanionViewSettingsPatch,
} from '../../lib/preferences';
import type { ViewPreferencePatchLedger } from '../../lib/view-preference-ledger';
import type { CompanionState } from './companion-state';

export const ZOOM_COMMIT_DEBOUNCE_MS = 150;

export interface PreferenceClientEnvironment {
  readonly state: CompanionState;
  readonly ledger: ViewPreferencePatchLedger;
  readonly sendMessage: (command: PreferenceCommand) => Promise<unknown>;
  /** The raw `storage.local` record holding the preferences key. */
  readonly readStorage: () => Promise<Record<string, unknown> | undefined>;
  /** A committed snapshot was accepted; `previous` is the one it replaced. */
  readonly onCommitted: (previous: CompanionPreferences) => void;
  /** The preference controls should re-read the state. */
  readonly onControlsChanged: () => void;
  /** The mirror layout should re-read the view settings. */
  readonly onLayoutChanged: () => void;
  /** Zoom was applied optimistically; the zoom controls should follow. */
  readonly onZoomApplied: () => void;
  readonly onError: (message: string) => void;
  readonly zoomCommitDebounceMs?: number;
}

/**
 * Preference reads and writes through the background preference service.
 * Committed snapshots stay authoritative and are accepted only when they
 * are not older than the current one; view patches are applied
 * optimistically through the ledger, which replays them over any committed
 * snapshot that arrives before the service answers.
 */
export class PreferenceClient {
  constructor(private readonly environment: PreferenceClientEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  async send(command: PreferenceCommand): Promise<PreferenceCommandResult> {
    const response = await this.environment.sendMessage(command);
    const result = readPreferenceCommandResult(response);
    if (!result) throw new Error('The preference service returned an invalid response.');
    return result;
  }

  async readStored(): Promise<CompanionPreferences> {
    const stored = await this.environment.readStorage();
    return parseCompanionPreferences(stored?.[STORAGE_KEY]);
  }

  /** Reconciles through the service, else reads storage, else uses defaults. */
  async load(): Promise<void> {
    try {
      this.applyCommitted(
        (await this.send({ type: 'simul:preferences:reconcile' })).preferences,
      );
    } catch {
      try {
        this.applyCommitted((await this.readStored()));
      } catch {
        this.applyCommitted(DEFAULT_COMPANION_PREFERENCES);
      }
    }
    this.environment.onControlsChanged();
  }

  async reloadFromStorage(): Promise<void> {
    try {
      this.applyCommitted(await this.readStored());
    } catch {
      this.applyCommitted(DEFAULT_COMPANION_PREFERENCES);
    }
    this.environment.onControlsChanged();
  }

  /**
   * Accepts a committed snapshot unless it is older than the current one,
   * then projects the in-flight view patches over it.
   */
  applyCommitted(value: unknown): boolean {
    const state = this.#state;
    const candidate = parseCompanionPreferences(value);
    const previous = state.preferences;
    const selected = selectLatestCompanionPreferences(previous, candidate);
    const candidateIsOlder =
      candidate.resetRevision < previous.resetRevision ||
      (
        candidate.resetRevision === previous.resetRevision &&
        candidate.settingsRevision < previous.settingsRevision
      );
    if (candidateIsOlder) return false;
    state.preferences = this.environment.ledger.project(selected);
    this.environment.onCommitted(previous);
    return true;
  }

  async commitView(patch: CompanionViewSettingsPatch): Promise<boolean> {
    const state = this.#state;
    const { ledger } = this.environment;
    const pending = ledger.begin(state.preferences, patch);
    state.preferences = pending.preferences;
    this.environment.onControlsChanged();
    this.environment.onLayoutChanged();
    try {
      const result = await this.send({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: pending.expectedResetRevision,
        patch,
      });
      ledger.settle(pending.requestId);
      this.applyCommitted(result.preferences);
      if (!result.applied) {
        throw new Error(
          'Settings were reset in another companion. Review the current choices and try again.',
        );
      }
      this.environment.onControlsChanged();
      this.environment.onLayoutChanged();
      return true;
    } catch (error) {
      ledger.settle(pending.requestId);
      try {
        this.applyCommitted(await this.readStored());
        this.environment.onControlsChanged();
        this.environment.onLayoutChanged();
      } catch {
        // Keep the optimistic controls visible; a later storage event can repair them.
      }
      this.environment.onError(`Could not save options: ${readableError(error)}`);
      return false;
    }
  }

  async commitImageAnalysis(patch: CompanionImageAnalysisSettingsPatch): Promise<void> {
    const state = this.#state;
    const expectedResetRevision = state.preferences.resetRevision;
    const expectedSettingsRevision = state.preferences.settingsRevision;
    try {
      const result = await this.send({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision,
        expectedSettingsRevision,
        patch,
      });
      this.applyCommitted(result.preferences);
      if (!result.applied) {
        throw new Error(
          result.code === 'stale-settings-revision'
            ? 'Image options changed in another companion. Review the current choices and try again.'
            : 'Settings were reset in another companion. Review the current choices and try again.',
        );
      }
      this.environment.onControlsChanged();
    } catch (error) {
      try {
        this.applyCommitted(await this.readStored());
        this.environment.onControlsChanged();
      } catch {
        // A later storage event can reconcile optimistic controls.
      }
      this.environment.onError(`Could not save image options: ${readableError(error)}`);
    }
  }

  /** Records the surface the companion last opened on. */
  rememberSurface(surface: CompanionSurface): Promise<boolean> {
    return this.commitView({ lastLaunchSurface: surface });
  }

  /**
   * Applies zoom immediately and saves it once the slider settles. Saving on
   * every input tick sent one storage write per tick, each of which fanned a
   * storage change to every companion view and rebuilt the settings controls.
   * One optimistic ledger entry covers the whole drag, so a committed snapshot
   * arriving mid-drag keeps the slider where the user left it.
   */
  setZoom(value: number): void {
    const state = this.#state;
    const { ledger } = this.environment;
    const patch: CompanionViewSettingsPatch = {
      displayMode: 'custom',
      zoomPercent: clampZoomPercent(value),
    };
    if (state.pendingZoomPatch) ledger.settle(state.pendingZoomPatch.requestId);
    const pending = ledger.begin(state.preferences, patch);
    state.pendingZoomPatch = { requestId: pending.requestId, patch };
    state.preferences = pending.preferences;
    this.environment.onZoomApplied();
    if (state.zoomCommitTimer !== undefined) clearTimeout(state.zoomCommitTimer);
    state.zoomCommitTimer = setTimeout(
      () => this.flushPendingZoom(),
      this.environment.zoomCommitDebounceMs ?? ZOOM_COMMIT_DEBOUNCE_MS,
    );
  }

  /** Saves a zoom drag that has not settled yet, e.g. when the page unloads. */
  flushPendingZoom(): void {
    const state = this.#state;
    if (state.zoomCommitTimer !== undefined) clearTimeout(state.zoomCommitTimer);
    state.zoomCommitTimer = undefined;
    const pending = state.pendingZoomPatch;
    if (!pending) return;
    state.pendingZoomPatch = undefined;
    // commitView opens its own ledger entry synchronously, so the drag's
    // entry can be released without a gap in the projection.
    this.environment.ledger.settle(pending.requestId);
    void this.commitView(pending.patch);
  }
}
