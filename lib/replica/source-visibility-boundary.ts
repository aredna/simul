import {
  createSourcePaintScanCache,
  readSourceFlatTreeElementPath,
  sourceElementPaintInputsAreReadable,
  sourceElementPathIsPainted,
  type SourcePaintScanCache,
} from './source-privacy-policy';

export interface SourceVisibilityBoundaryRefresh {
  readonly changedTargets: readonly Element[];
  readonly overflow: boolean;
}

/**
 * Content-free index of the visibility floor used by both source mirrors.
 * It reads structural attributes and computed presentation only; authored
 * text and values are never touched. A changed boundary tells a serializer to
 * re-run its existing privacy filter for that bounded subtree.
 */
export class SourceVisibilityBoundaryIndex {
  readonly #states = new Map<Element, boolean>();
  #complete = true;

  constructor(
    private readonly document: Document,
    private readonly sourceWindow: Window | null | undefined,
    private readonly maximumNodes: number,
  ) {
    this.#replaceAll();
  }

  refreshAll(): SourceVisibilityBoundaryRefresh {
    return this.#refreshAll(createSourcePaintScanCache());
  }

  #refreshAll(
    paintCache: SourcePaintScanCache,
  ): SourceVisibilityBoundaryRefresh {
    const previous = new Map(this.#states);
    this.#states.clear();
    const result = this.#scanRoots(
      this.document.documentElement ? [this.document.documentElement] : [],
      previous,
      paintCache,
    );
    this.#complete = !result.overflow;
    for (const element of previous.keys()) {
      if (!element.isConnected || element.ownerDocument !== this.document) {
        previous.delete(element);
      }
    }
    return Object.freeze({
      changedTargets: result.changedTargets,
      overflow: result.overflow,
    });
  }

  refreshMutations(
    records: readonly MutationRecord[],
  ): SourceVisibilityBoundaryRefresh {
    const roots: Element[] = [];
    let global = false;
    let imageSelectorSurface = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.nodeType !== 1) continue;
        // Every authored attribute is CSS selector surface. Attribute
        // selectors, sibling combinators, and :has() can rematerialize text
        // outside the mutated subtree, so bounded local ancestry is not an
        // adequate proof. The comparison remains content-free and emits a
        // rematerialization boundary only when painted state actually changes.
        global = true;
        imageSelectorSurface ||=
          (record.target as Element).localName.toLowerCase() === 'img';
        continue;
      }
      if (record.type === 'characterData') {
        // Text presence is arbitrary selector surface through :empty, sibling
        // combinators, and :has(), even when the changed text is not inside a
        // stylesheet. Compare the complete content-free paint index so a
        // local text edit cannot leave remote authored content stale.
        global = true;
        continue;
      }
      if (record.type !== 'childList') continue;
      for (const removed of record.removedNodes) this.#forgetSubtree(removed);
      // Child presence is arbitrary selector surface through :empty, sibling
      // combinators, and :has(). Compare the complete content-free paint
      // index so a local marker can reveal a remote text subtree.
      global = true;
    }
    if (global) {
      const paintCache = createSourcePaintScanCache();
      const result = this.#refreshAll(paintCache);
      if (
        !imageSelectorSurface || result.overflow ||
        this.#documentPaintInputsAreReadable(paintCache)
      ) return result;
      return Object.freeze({
        changedTargets: result.changedTargets,
        overflow: true,
      });
    }
    const result = this.#scanRoots(
      minimizeVisibilityRoots(roots),
      this.#states,
      createSourcePaintScanCache(),
    );
    this.#complete &&= !result.overflow;
    return Object.freeze({
      changedTargets: result.changedTargets,
      overflow: result.overflow || !this.#complete,
    });
  }

  refreshInteractionTargets(
    targets: readonly Element[],
  ): SourceVisibilityBoundaryRefresh {
    if (targets.length === 0) {
      return Object.freeze({
        changedTargets: Object.freeze([]),
        overflow: !this.#complete,
      });
    }
    // Pseudo-class state can be consumed remotely by :has() and sibling
    // selectors. Event bursts are frame-coalesced by each owning source.
    return this.refreshAll();
  }

  dispose(): void {
    this.#states.clear();
    this.#complete = false;
  }

  #replaceAll(): void {
    this.#states.clear();
    const root = this.document.documentElement;
    const result = this.#scanRoots(
      root ? [root] : [],
      this.#states,
      createSourcePaintScanCache(),
    );
    this.#complete = !result.overflow;
  }

  #scanRoots(
    roots: readonly Element[],
    previous: ReadonlyMap<Element, boolean>,
    paintCache: SourcePaintScanCache,
  ): SourceVisibilityBoundaryRefresh {
    const changedTargets: Element[] = [];
    let inspected = 0;
    let overflow = false;
    for (const root of roots) {
      if (
        !root.isConnected || root.ownerDocument !== this.document ||
        inspected >= this.maximumNodes
      ) {
        overflow ||= inspected >= this.maximumNodes;
        continue;
      }
      const pending: Array<{
        readonly element: Element;
        readonly changedAncestor: boolean;
      }> = [{ element: root, changedAncestor: false }];
      while (pending.length > 0) {
        if (++inspected > this.maximumNodes) {
          overflow = true;
          break;
        }
        const current = pending.pop();
        if (!current) break;
        const withheld = !sourceElementPathIsPainted(
          current.element,
          this.sourceWindow,
          paintCache,
        );
        const prior = previous.get(current.element);
        const changed = prior !== undefined && prior !== withheld;
        this.#states.set(current.element, withheld);
        let rematerializationBoundary = false;
        if (changed && !current.changedAncestor) {
          const textProof = subtreeMayContainAuthoredText(
            current.element,
            this.maximumNodes - inspected,
          );
          inspected += textProof.inspected;
          if (textProof.overflow) {
            overflow = true;
            break;
          }
          rematerializationBoundary = textProof.mayContainText;
          if (rematerializationBoundary) changedTargets.push(current.element);
        }
        const children = sourceVisibilityChildren(current.element);
        if (!children) {
          overflow = true;
          break;
        }
        for (let index = children.length - 1; index >= 0; index -= 1) {
          pending.push({
            element: children[index]!,
            changedAncestor: current.changedAncestor ||
              (changed && rematerializationBoundary),
          });
        }
      }
      if (overflow) break;
    }
    return Object.freeze({
      changedTargets: Object.freeze(minimizeVisibilityRoots(changedTargets)),
      overflow,
    });
  }

  #forgetSubtree(node: Node): void {
    const pending: Node[] = [node];
    let inspected = 0;
    while (pending.length > 0 && inspected < this.maximumNodes) {
      const current = pending.pop();
      if (!current) break;
      inspected += 1;
      if (current.nodeType === 11) {
        pending.push(...current.childNodes);
        continue;
      }
      if (current.nodeType !== 1) continue;
      const element = current as Element;
      this.#states.delete(element);
      pending.push(...element.childNodes);
      const shadow = readSourceVisibilityShadowRoot(element);
      if (shadow === UNREADABLE_VISIBILITY_SHADOW_ROOT) {
        this.#complete = false;
        return;
      }
      if (shadow) pending.push(shadow);
    }
    if (pending.length > 0) this.#complete = false;
  }

  #documentPaintInputsAreReadable(
    paintCache: SourcePaintScanCache,
  ): boolean {
    if (!this.#complete || this.#states.size > this.maximumNodes) return false;
    for (const element of this.#states.keys()) {
      if (!sourceElementPaintInputsAreReadable(
        element,
        this.sourceWindow,
        paintCache,
      )) {
        return false;
      }
    }
    return true;
  }
}

interface AuthoredTextSubtreeProof {
  readonly mayContainText: boolean;
  readonly inspected: number;
  readonly overflow: boolean;
}

/**
 * Visibility rematerialization is needed only when a changed paint boundary
 * structurally owns authored text. The proof never reads text contents. An
 * unreadable or oversized subtree fails closed through the overflow result.
 */
function subtreeMayContainAuthoredText(
  root: Element,
  maximumNodes: number,
): AuthoredTextSubtreeProof {
  if (maximumNodes <= 0) {
    return Object.freeze({ mayContainText: true, inspected: 0, overflow: true });
  }
  const pending: Node[] = [];
  try {
    pending.push(...root.childNodes);
    const shadow = readSourceVisibilityShadowRoot(root);
    if (shadow === UNREADABLE_VISIBILITY_SHADOW_ROOT) {
      return Object.freeze({ mayContainText: true, inspected: 0, overflow: true });
    }
    if (shadow) pending.push(...shadow.childNodes);
  } catch {
    return Object.freeze({ mayContainText: true, inspected: 0, overflow: true });
  }
  let inspected = 0;
  while (pending.length > 0) {
    if (inspected >= maximumNodes) {
      return Object.freeze({ mayContainText: true, inspected, overflow: true });
    }
    const node = pending.pop();
    if (!node) break;
    inspected += 1;
    if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 5) {
      return Object.freeze({ mayContainText: true, inspected, overflow: false });
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) continue;
    try {
      pending.push(...node.childNodes);
      if (node.nodeType === 1) {
        const shadow = readSourceVisibilityShadowRoot(node as Element);
        if (shadow === UNREADABLE_VISIBILITY_SHADOW_ROOT) {
          return Object.freeze({
            mayContainText: true,
            inspected,
            overflow: true,
          });
        }
        if (shadow) pending.push(...shadow.childNodes);
      }
    } catch {
      return Object.freeze({ mayContainText: true, inspected, overflow: true });
    }
  }
  return Object.freeze({ mayContainText: false, inspected, overflow: false });
}

function sourceVisibilityChildren(
  element: Element,
): readonly Element[] | undefined {
  const children = [...element.children];
  const shadow = readSourceVisibilityShadowRoot(element);
  if (shadow === UNREADABLE_VISIBILITY_SHADOW_ROOT) return undefined;
  if (shadow) {
    for (const child of shadow.children) children.push(child);
  }
  return children;
}

const UNREADABLE_VISIBILITY_SHADOW_ROOT = Symbol(
  'unreadable-visibility-shadow-root',
);

function readSourceVisibilityShadowRoot(
  element: Element,
): ShadowRoot | undefined | typeof UNREADABLE_VISIBILITY_SHADOW_ROOT {
  try {
    const root = element.shadowRoot;
    return root?.mode === 'open' ? root : undefined;
  } catch {
    return UNREADABLE_VISIBILITY_SHADOW_ROOT;
  }
}

function minimizeVisibilityRoots(elements: readonly Element[]): Element[] {
  const unique = [...new Set(elements)].filter((element) => element.isConnected);
  return unique.filter((candidate) => !unique.some((other) =>
    other !== candidate && sourceElementContains(other, candidate)));
}

function sourceElementContains(ancestor: Element, descendant: Element): boolean {
  if (ancestor.contains(descendant)) return true;
  const path = readSourceFlatTreeElementPath(descendant);
  return Boolean(path?.includes(ancestor));
}
