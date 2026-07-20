import type { ReplicaRunResult } from './contracts';

/**
 * Coalesces legacy v1 dirtiness while the live rrweb replica is authoritative.
 * Releasing the preview consumes at most one fresh-capture requirement.
 */
export class LegacyTransitionGate {
  #shadowOwnsPage = false;
  #dirtyWhileLive = false;

  get shadowOwnsPage(): boolean {
    return this.#shadowOwnsPage;
  }

  beginShadowOwnership(): void {
    this.#shadowOwnsPage = true;
  }

  markDirty(): boolean {
    if (!this.#shadowOwnsPage) return false;
    this.#dirtyWhileLive = true;
    return true;
  }

  release(): boolean {
    const needsFreshCapture = this.#dirtyWhileLive;
    this.#shadowOwnsPage = false;
    this.#dirtyWhileLive = false;
    return needsFreshCapture;
  }

  reset(): void {
    this.#shadowOwnsPage = false;
    this.#dirtyWhileLive = false;
  }
}

export type LiveReplicaFailureAction = 'rebuild-last-good' | 'fallback';

/**
 * Allows one hidden-staging rebuild while a committed replica remains visible.
 * A second live failure before a successful commit falls back, preventing a
 * broken stream from creating an unbounded rebuild loop.
 */
export class LiveReplicaFailureRecoveryGate {
  #retryPending = false;

  decide(hasCommittedReplica: boolean): LiveReplicaFailureAction {
    if (hasCommittedReplica && !this.#retryPending) {
      this.#retryPending = true;
      return 'rebuild-last-good';
    }
    return 'fallback';
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

/** Keep a valid last-good/just-committed presentation when derived work fails. */
export function shouldReleaseReplicaAfterCaptureFailure(
  legacySnapshotReady: boolean,
  sameCaptureIdentity: boolean,
  hasCommittedReplica: boolean,
): boolean {
  return legacySnapshotReady && sameCaptureIdentity && !hasCommittedReplica;
}

export function isCommittedShadowReplica(
  result: ReplicaRunResult,
  hasCommittedReplica: boolean,
): boolean {
  return (
    result.status === 'complete' &&
    (result.diagnostics.engine === 'rrweb-shadow-v2' ||
      result.diagnostics.engine === 'isolated-html-v1') &&
    hasCommittedReplica
  );
}
