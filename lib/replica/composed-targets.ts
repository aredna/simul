/**
 * Removes disconnected and descendant targets while preserving insertion order.
 * Walking each target's ancestor chain avoids pairwise subtree containment scans.
 */
export function minimizeConnectedComposedTargets(
  targets: Iterable<Node>,
): Node[] {
  const connectedTargets = new Set<Node>();
  for (const target of targets) {
    if (target.isConnected) connectedTargets.add(target);
  }

  const minimal: Node[] = [];
  for (const target of connectedTargets) {
    // A shadow root is not among its host's children: reading those again
    // does not read the root, so its own host does not cover it (D132).
    const ownHost = 'host' in target ? (target as ShadowRoot).host : undefined;
    let covered = false;
    for (
      let ancestor = composedParent(target);
      ancestor;
      ancestor = composedParent(ancestor)
    ) {
      if (ancestor === ownHost || !connectedTargets.has(ancestor)) continue;
      covered = true;
      break;
    }
    if (!covered) minimal.push(target);
  }
  return minimal;
}

function composedParent(node: Node): Node | undefined {
  if (node.parentNode) return node.parentNode;
  if ('host' in node) return (node as ShadowRoot).host ?? undefined;
  return undefined;
}
