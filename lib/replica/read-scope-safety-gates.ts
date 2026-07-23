import {
  intersectReplicaReadScopes,
  readExactReplicaReadScope,
  replicaReadScopeFingerprint,
  type ReplicaReadScope,
} from './read-scope-policy';

/**
 * Panel-local leases imposed by the background safety barrier. A preference
 * snapshot can prove a ceiling is satisfied, but only a coordinator release
 * proves the matching journal deletion was durable. Both proofs are required.
 */
export class RemoteReadScopeSafetyGates {
  readonly #gates = new Map<string, ReplicaReadScope>();
  readonly #committedReleases = new Set<string>();

  prepare(requestId: string, scope: ReplicaReadScope): boolean {
    const exact = readExactReplicaReadScope(scope);
    if (!isRequestId(requestId) || !exact) return false;
    this.#gates.set(requestId, exact);
    this.#committedReleases.delete(requestId);
    return true;
  }

  authorizeCommittedRelease(requestId: string): boolean {
    if (!this.#gates.has(requestId)) return false;
    this.#committedReleases.add(requestId);
    return true;
  }

  releaseSatisfied(committedScope: ReplicaReadScope): number {
    const committed = readExactReplicaReadScope(committedScope);
    if (!committed) return 0;
    let released = 0;
    for (const [requestId, gate] of this.#gates) {
      if (
        !this.#committedReleases.has(requestId) ||
        !isNoBroaderThan(committed, gate)
      ) continue;
      this.#gates.delete(requestId);
      this.#committedReleases.delete(requestId);
      released += 1;
    }
    return released;
  }

  scopes(): readonly ReplicaReadScope[] {
    return Object.freeze([...this.#gates.values()]);
  }
}

function isNoBroaderThan(
  candidate: ReplicaReadScope,
  ceiling: ReplicaReadScope,
): boolean {
  return replicaReadScopeFingerprint(
    intersectReplicaReadScopes(candidate, ceiling),
  ) === replicaReadScopeFingerprint(candidate);
}

function isRequestId(value: string): boolean {
  return value.length > 0 && value.length <= 128;
}
