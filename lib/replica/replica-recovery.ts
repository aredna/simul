import type { ReplicaRunResult } from './contracts';

export type IsolatedReplicaFailureAction =
  | 'rebuild-last-good'
  | 'terminal-error';

/**
 * Allows one hidden-staging rebuild while a committed replica remains visible.
 * A second live failure before a successful commit surfaces a terminal error,
 * preventing a broken stream from creating an unbounded rebuild loop while
 * the last-good replica stays committed.
 */
export class IsolatedReplicaFailureRecoveryGate {
  #retryPending = false;

  decide(hasCommittedReplica: boolean): IsolatedReplicaFailureAction {
    if (hasCommittedReplica && !this.#retryPending) {
      this.#retryPending = true;
      return 'rebuild-last-good';
    }
    return 'terminal-error';
  }

  markCommitted(): void {
    this.#retryPending = false;
  }

  reset(): void {
    this.#retryPending = false;
  }
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
