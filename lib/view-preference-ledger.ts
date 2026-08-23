import {
  withViewSettings,
  type CompanionPreferences,
  type CompanionViewSettingsPatch,
} from './preferences';

export interface OptimisticViewPreferencePatch {
  readonly requestId: number;
  readonly expectedResetRevision: number;
  readonly preferences: CompanionPreferences;
}

interface PendingViewPreferencePatch {
  readonly expectedResetRevision: number;
  readonly patch: CompanionViewSettingsPatch;
}

/**
 * Keeps local view controls responsive while serialized background writes are
 * pending. Committed snapshots remain authoritative; newer local patches are
 * replayed over them until their individual requests settle.
 */
export class ViewPreferencePatchLedger {
  #requestSequence = 0;
  readonly #pending = new Map<number, PendingViewPreferencePatch>();

  begin(
    current: CompanionPreferences,
    patch: CompanionViewSettingsPatch,
  ): OptimisticViewPreferencePatch {
    const requestId = ++this.#requestSequence;
    const expectedResetRevision = current.resetRevision;
    this.#pending.set(requestId, {
      expectedResetRevision,
      patch: Object.freeze({ ...patch }),
    });
    return Object.freeze({
      requestId,
      expectedResetRevision,
      preferences: withViewSettings(current, patch),
    });
  }

  settle(requestId: number): void {
    this.#pending.delete(requestId);
  }

  project(committed: CompanionPreferences): CompanionPreferences {
    let projected = committed;
    for (const pending of this.#pending.values()) {
      if (pending.expectedResetRevision !== committed.resetRevision) continue;
      projected = withViewSettings(projected, pending.patch);
    }
    return projected;
  }
}
