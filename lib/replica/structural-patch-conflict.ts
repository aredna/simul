export interface ReplicaPatchTarget {
  readonly target: Node;
  readonly structural: boolean;
}

/** Detects ancestor/descendant updates that cannot be applied atomically.
 * Indexing targets avoids pairwise tree walks for large live patch batches. */
export function hasStructuralPatchTargetConflict(
  targets: readonly ReplicaPatchTarget[],
): boolean {
  const indexedTargets = new Map<Node, boolean>();
  for (const { target, structural } of targets) {
    indexedTargets.set(
      target,
      structural || indexedTargets.get(target) === true,
    );
  }

  for (const [target, structural] of indexedTargets) {
    for (
      let ancestor = composedParent(target);
      ancestor;
      ancestor = composedParent(ancestor)
    ) {
      const ancestorStructural = indexedTargets.get(ancestor);
      if (
        ancestorStructural !== undefined &&
        (structural || ancestorStructural)
      ) return true;
    }
  }
  return false;
}

function composedParent(node: Node): Node | undefined {
  if (node.parentNode) return node.parentNode;
  if ('host' in node && (node as ShadowRoot).host) {
    return (node as ShadowRoot).host;
  }
  const root = node.getRootNode();
  return root !== node && 'host' in root
    ? (root as ShadowRoot).host
    : undefined;
}
