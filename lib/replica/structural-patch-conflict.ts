export interface ReplicaPatchTarget {
  readonly target: Node;
  readonly structural: boolean;
}

/** Detects updates inside a subtree that the same batch replaces or
 * reconciles: the replacement removes or re-parents the descendant, so the
 * two cannot be applied atomically. An attribute update on an ancestor of a
 * structural target is not a conflict: the target stays in place, and the
 * engine separately refuses an attribute update that would change the privacy
 * context the new children are validated against unless that element's own
 * children are replaced too. A carousel move is the common case: a slide's
 * content is replaced while the wrapper's transform changes.
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

  for (const target of indexedTargets.keys()) {
    for (
      let ancestor = composedParent(target);
      ancestor;
      ancestor = composedParent(ancestor)
    ) {
      if (indexedTargets.get(ancestor) === true) return true;
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
