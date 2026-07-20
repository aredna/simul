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

export function isCommittedShadowReplica(
  result: ReplicaRunResult,
  hasCommittedReplica: boolean,
): boolean {
  return (
    result.status === 'complete' &&
    result.diagnostics.engine === 'rrweb-shadow-v2' &&
    hasCommittedReplica
  );
}
