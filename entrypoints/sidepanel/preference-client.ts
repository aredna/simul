import {
  readPreferenceCommandResult,
  type PreferenceCommand,
  type PreferenceCommandResult,
} from '../../lib/preference-coordinator';
import {
  DEFAULT_COMPANION_PREFERENCES,
  STORAGE_KEY,
  parseCompanionPreferences,
  withImageAnalysisSettings,
  withViewSettings,
  type CompanionImageAnalysisSettings,
  type CompanionImageAnalysisSettingsPatch,
  type CompanionPreferences,
  type CompanionViewSettings,
  type CompanionViewSettingsPatch,
} from '../../lib/preferences';

/** The side panel keeps the live preferences; the client reads and writes them here. */
export interface PreferenceStore {
  readonly get: () => CompanionPreferences;
  readonly set: (next: CompanionPreferences) => void;
}

export interface PreferenceClientEnvironment {
  readonly store: PreferenceStore;
  readonly sendMessage: (command: PreferenceCommand) => Promise<unknown>;
  readonly readStorage: () => Promise<unknown>;
  /** Runs after a view patch is confirmed or restored (layout follows it). */
  readonly onViewSettled?: () => void;
  readonly onError: (message: string) => void;
  readonly readableError: (error: unknown) => string;
}

interface PendingEntry<Value> {
  readonly revision: number;
  readonly value: Value;
}

/**
 * Optimistic preference writes through the background preference service.
 * A patch is applied locally at once, sent to the service, and reconciled
 * with the service's answer; while it is in flight, an unrelated storage
 * update from another companion window must not roll it back, so pending
 * values are re-applied over any incoming stored state until they settle.
 */
export class PreferenceClient {
  #viewRevision = 0;
  #imageRevision = 0;
  readonly #pendingView = new Map<
    keyof CompanionViewSettings,
    PendingEntry<CompanionViewSettings[keyof CompanionViewSettings]>
  >();
  readonly #pendingImage = new Map<
    keyof CompanionImageAnalysisSettings,
    PendingEntry<CompanionImageAnalysisSettings[keyof CompanionImageAnalysisSettings]>
  >();

  constructor(private readonly environment: PreferenceClientEnvironment) {}

  get current(): CompanionPreferences {
    return this.environment.store.get();
  }

  async send(command: PreferenceCommand): Promise<PreferenceCommandResult> {
    const response = await this.environment.sendMessage(command);
    const result = readPreferenceCommandResult(response);
    if (!result) throw new Error('The preference service returned an invalid response.');
    return result;
  }

  async readStored(): Promise<CompanionPreferences> {
    const stored = await this.environment.readStorage();
    return parseCompanionPreferences(
      (stored as Record<string, unknown> | undefined)?.[STORAGE_KEY],
    );
  }

  /** Reconciles through the service, else reads storage, else uses defaults. */
  async load(): Promise<void> {
    let next: CompanionPreferences;
    try {
      next = (await this.send({ type: 'simul:preferences:reconcile' })).preferences;
    } catch {
      try {
        next = await this.readStored();
      } catch {
        next = parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
      }
    }
    this.environment.store.set(next);
  }

  /** Re-applies in-flight patches over stored state from elsewhere. */
  mergePending(stored: CompanionPreferences): CompanionPreferences {
    const pendingView = Object.fromEntries(
      [...this.#pendingView].map(([key, entry]) => [key, entry.value]),
    ) as CompanionViewSettingsPatch;
    const pendingImage = Object.fromEntries(
      [...this.#pendingImage].map(([key, entry]) => [key, entry.value]),
    ) as CompanionImageAnalysisSettingsPatch;
    return withImageAnalysisSettings(withViewSettings(stored, pendingView), pendingImage);
  }

  async reloadFromStorage(): Promise<void> {
    let stored: CompanionPreferences;
    try {
      stored = await this.readStored();
    } catch {
      stored = parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
    }
    this.environment.store.set(this.mergePending(stored));
  }

  async commitView(patch: CompanionViewSettingsPatch): Promise<boolean> {
    const { store } = this.environment;
    store.set(withViewSettings(store.get(), patch));
    const revision = ++this.#viewRevision;
    for (const [key, value] of Object.entries(patch)) {
      this.#pendingView.set(key as keyof CompanionViewSettings, {
        revision,
        value: value as CompanionViewSettings[keyof CompanionViewSettings],
      });
    }
    try {
      const result = await this.send({ type: 'simul:preferences:patch-view', patch });
      this.#clearCommitted(this.#pendingView, patch, revision);
      store.set(this.mergePending(result.preferences));
      this.environment.onViewSettled?.();
      return true;
    } catch (error) {
      this.#clearCommitted(this.#pendingView, patch, revision);
      try {
        store.set(this.mergePending(await this.readStored()));
        this.environment.onViewSettled?.();
      } catch {
        // Keep the optimistic controls visible; a later storage event can repair them.
      }
      this.environment.onError(
        `Could not save options: ${this.environment.readableError(error)}`,
      );
      return false;
    }
  }

  async commitImageAnalysis(patch: CompanionImageAnalysisSettingsPatch): Promise<void> {
    const { store } = this.environment;
    store.set(withImageAnalysisSettings(store.get(), patch));
    const revision = ++this.#imageRevision;
    for (const [key, value] of Object.entries(patch)) {
      this.#pendingImage.set(key as keyof CompanionImageAnalysisSettings, {
        revision,
        value: value as CompanionImageAnalysisSettings[keyof CompanionImageAnalysisSettings],
      });
    }
    try {
      const result = await this.send({
        type: 'simul:preferences:patch-image-analysis',
        patch,
      });
      this.#clearCommitted(this.#pendingImage, patch, revision);
      store.set(this.mergePending(result.preferences));
    } catch (error) {
      this.#clearCommitted(this.#pendingImage, patch, revision);
      try {
        store.set(this.mergePending(await this.readStored()));
      } catch {
        // A later storage event can reconcile optimistic controls.
      }
      this.environment.onError(
        `Could not save image options: ${this.environment.readableError(error)}`,
      );
    }
  }

  #clearCommitted<Key extends string>(
    pending: Map<Key, PendingEntry<unknown>>,
    patch: Partial<Record<Key, unknown>>,
    revision: number,
  ): void {
    for (const key of Object.keys(patch) as Key[]) {
      if (pending.get(key)?.revision === revision) pending.delete(key);
    }
  }
}
