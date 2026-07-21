export const REPLICA_FIDELITY_POLICIES = [
  'passive',
  'conservative',
  'strict-local',
] as const;

export type ReplicaFidelityPolicy =
  (typeof REPLICA_FIDELITY_POLICIES)[number];

export const SELECTABLE_REPLICA_FIDELITY_POLICIES = [
  'passive',
  'conservative',
] as const satisfies readonly ReplicaFidelityPolicy[];

export type SelectableReplicaFidelityPolicy =
  (typeof SELECTABLE_REPLICA_FIDELITY_POLICIES)[number];

export function isReplicaFidelityPolicy(
  value: unknown,
): value is ReplicaFidelityPolicy {
  return REPLICA_FIDELITY_POLICIES.includes(value as ReplicaFidelityPolicy);
}

export function isSelectableReplicaFidelityPolicy(
  value: unknown,
): value is SelectableReplicaFidelityPolicy {
  return SELECTABLE_REPLICA_FIDELITY_POLICIES.includes(
    value as SelectableReplicaFidelityPolicy,
  );
}
