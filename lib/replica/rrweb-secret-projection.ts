import {
  MAX_REPLICA_NODE_DEPTH,
  MAX_REPLICA_NODES,
  createRrwebOpaquePlaceholderNode,
} from './protocol-v2';
import { hasSourceCredentialSecretAncestor } from './source-privacy-policy';

interface ProjectionBudget {
  nodes: number;
}

/**
 * Uses rrweb's document-local mirror IDs to apply the shared sticky/computed
 * secret classifier before a full snapshot reaches the typed wire sanitizer.
 */
export function projectRrwebSourceSecretsInCheckpoint(
  events: readonly unknown[],
  resolveNode: (nodeId: number) => Node | null,
): readonly unknown[] | undefined {
  try {
    const budget: ProjectionBudget = { nodes: 0 };
    return Object.freeze(events.map((event) => {
      if (!isRecord(event) || event.type !== 2 || !isRecord(event.data)) {
        return event;
      }
      const node = projectSerializedNode(event.data.node, resolveNode, budget, 0);
      if (!node) throw new Error('rrweb secret projection failed');
      return { ...event, data: { ...event.data, node } };
    }));
  } catch {
    return undefined;
  }
}

/** Applies the same source classifier to newly added rrweb mutation trees. */
export function projectRrwebSourceSecretsInIncrementalEvent(
  event: Record<string, unknown>,
  resolveNode: (nodeId: number) => Node | null,
): Record<string, unknown> | undefined {
  try {
    if (!isRecord(event.data) || event.data.source !== 0) return event;
    if (!Array.isArray(event.data.adds)) return event;
    const budget: ProjectionBudget = { nodes: 0 };
    const adds = event.data.adds.map((addition) => {
      if (!isRecord(addition) || !('node' in addition)) return addition;
      const node = projectSerializedNode(
        addition.node,
        resolveNode,
        budget,
        0,
      );
      if (!node) throw new Error('rrweb incremental secret projection failed');
      return { ...addition, node };
    });
    return { ...event, data: { ...event.data, adds } };
  } catch {
    return undefined;
  }
}

/**
 * Existing replica nodes cannot be rewritten in place when their source-side
 * selector/computed-style state becomes secret. Request one atomic checkpoint
 * before any text or attribute mutation at such an ID is sequenced.
 */
export function rrwebMutationTouchesSourceSecret(
  event: unknown,
  resolveNode: (nodeId: number) => Node | null,
): boolean {
  try {
    if (
      !isRecord(event) || event.type !== 3 || !isRecord(event.data) ||
      event.data.source !== 0
    ) return false;
    const candidateIds: number[] = [];
    for (const key of ['texts', 'attributes'] as const) {
      const entries = event.data[key];
      if (!Array.isArray(entries) || entries.length > MAX_REPLICA_NODES) {
        return true;
      }
      for (const entry of entries) {
        if (!isRecord(entry) || !Number.isSafeInteger(entry.id)) return true;
        candidateIds.push(Number(entry.id));
      }
    }
    const adds = event.data.adds;
    if (!Array.isArray(adds) || adds.length > MAX_REPLICA_NODES) return true;
    for (const addition of adds) {
      if (!isRecord(addition) || !Number.isSafeInteger(addition.parentId)) {
        return true;
      }
      candidateIds.push(Number(addition.parentId));
    }
    if (candidateIds.length > MAX_REPLICA_NODES) return true;
    return candidateIds.some((id) => {
      const node = resolveNode(id);
      return node ? hasSourceCredentialSecretAncestor(node) : false;
    });
  } catch {
    return true;
  }
}

function projectSerializedNode(
  input: unknown,
  resolveNode: (nodeId: number) => Node | null,
  budget: ProjectionBudget,
  depth: number,
): Record<string, unknown> | undefined {
  if (
    !isRecord(input) || depth > MAX_REPLICA_NODE_DEPTH ||
    !Number.isSafeInteger(input.id) || Number(input.id) < 1 ||
    ++budget.nodes > MAX_REPLICA_NODES
  ) return undefined;
  const source = resolveNode(Number(input.id));
  if (source && hasSourceCredentialSecretAncestor(source)) {
    return createRrwebOpaquePlaceholderForSourceNode(input);
  }
  if (!('childNodes' in input)) return { ...input };
  if (!Array.isArray(input.childNodes)) return undefined;
  const children = input.childNodes.map((child) =>
    projectSerializedNode(child, resolveNode, budget, depth + 1),
  );
  if (children.some((child) => !child)) return undefined;
  return { ...input, childNodes: children };
}

function createRrwebOpaquePlaceholderForSourceNode(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (input.type === 2) return createRrwebOpaquePlaceholderNode(input);
  // rrweb Text nodes cannot carry the canonical opaque-element fields. Keep
  // only their mirror/placement identity and deliberately normalize the wire
  // shape before the protocol helper validates it.
  return createRrwebOpaquePlaceholderNode({
    type: 2,
    id: input.id,
    rootId: input.rootId,
    isShadow: input.isShadow,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
