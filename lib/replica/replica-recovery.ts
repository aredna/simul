import type { ReplicaRunResult } from './contracts';

export type IsolatedReplicaFailureAction =
  | 'rebuild-last-good'
  | 'terminal-error';

export interface IsolatedReplicaFailureRecoveryOptions {
  /** Rebuilds allowed per window before a page surfaces a terminal error. */
  readonly maxRebuilds?: number;
  /** Sliding window for the rebuild budget in milliseconds. */
  readonly windowMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_REPLICA_REBUILD_BUDGET = 3;
export const DEFAULT_REPLICA_REBUILD_WINDOW_MS = 60_000;

/**
 * Allows one hidden-staging rebuild while a committed replica remains visible.
 * A second live failure before a successful commit surfaces a terminal error.
 * A commit re-arms that single retry, so a stream that dies after every
 * successful commit also draws on a bounded sliding budget of rebuilds per
 * page; once it is spent the failure is terminal until the gate is reset,
 * preventing a broken stream from rebuilding the page forever while the
 * last-good replica stays committed.
 */
export class IsolatedReplicaFailureRecoveryGate {
  readonly #maxRebuilds: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #retryPending = false;
  #rebuildTimes: number[] = [];

  constructor(options: IsolatedReplicaFailureRecoveryOptions = {}) {
    this.#maxRebuilds = boundedPositiveInteger(
      options.maxRebuilds,
      DEFAULT_REPLICA_REBUILD_BUDGET,
    );
    this.#windowMs = boundedPositiveInteger(
      options.windowMs,
      DEFAULT_REPLICA_REBUILD_WINDOW_MS,
    );
    this.#now = options.now ?? (() => Date.now());
  }

  decide(hasCommittedReplica: boolean): IsolatedReplicaFailureAction {
    const now = this.#now();
    this.#rebuildTimes = this.#rebuildTimes.filter(
      (time) => now - time < this.#windowMs,
    );
    if (
      hasCommittedReplica &&
      !this.#retryPending &&
      this.#rebuildTimes.length < this.#maxRebuilds
    ) {
      this.#retryPending = true;
      this.#rebuildTimes.push(now);
      return 'rebuild-last-good';
    }
    return 'terminal-error';
  }

  markCommitted(): void {
    this.#retryPending = false;
  }

  reset(): void {
    this.#retryPending = false;
    this.#rebuildTimes = [];
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

export function shouldPreserveCommittedReplicaForCapture(
  reason: string,
  samePage: boolean,
  hasCommittedReplica: boolean,
): boolean {
  return (
    hasCommittedReplica &&
    samePage &&
    (reason === 'manual' || reason === 'desynchronized')
  );
}

export function isCommittedPrimaryReplica(
  result: ReplicaRunResult,
  hasCommittedReplica: boolean,
): boolean {
  return (
    result.status === 'complete' &&
    result.diagnostics.engine === 'isolated-html-v1' &&
    hasCommittedReplica
  );
}
