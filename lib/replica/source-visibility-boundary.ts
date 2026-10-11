import {
  createSourcePaintScanCache,
  readSourceElementPathPaint,
  readSourceFlatTreeElementPath,
  sourceElementPaintInputsAreReadable,
  type SourcePaintScanCache,
} from './source-privacy-policy';
import { readSourceShadowRoot } from './source-shadow-root';

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
  #states = new Map<Element, SourceVisibilityState>();
  #complete = true;
  /** Elements seen to get a box since `takeShownElements` last asked. */
  #shown: Element[] = [];
  #wholeComparisons = 0;

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

  /**
   * How many times every element of the page has been compared since this
   * index was made: a caller that sees the number grow knows its last
   * refresh was of the whole page.
   */
  get wholeComparisons(): number {
    return this.#wholeComparisons;
  }

  #refreshAll(
    paintCache: SourcePaintScanCache,
  ): SourceVisibilityBoundaryRefresh {
    // What was read last is compared with and then let go of; it was
    // copied, entry by entry, and each element of the copy then asked
    // whether it was still in the page, to no end.
    this.#wholeComparisons += 1;
    const previous = this.#states;
    this.#states = new Map();
    const result = this.#scanRoots(
      this.document.documentElement ? [this.document.documentElement] : [],
      previous,
      paintCache,
    );
    this.#complete = !result.overflow;
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

  /**
   * Compares afresh what `roots` hold and nothing else. For a change no
   * selector can carry elsewhere: the values a script animation holds, or
   * lets go of, are its element's own and reach only what the element holds.
   * A root inside another is the outer one's to walk: without that, a nest
   * of elements that all changed was walked once for each of them.
   */
  refreshWithin(roots: readonly Element[]): SourceVisibilityBoundaryRefresh {
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

  /**
   * Every element that was not displayed at one read and was at a later
   * one, since this was last asked: each has a box again, and with it what
   * only a box holds (Chrome gives a scrolled pane its offset back, with no
   * scroll event). Elements only; nothing of theirs is read here.
   */
  takeShownElements(): readonly Element[] {
    const shown = this.#shown;
    this.#shown = [];
    return shown;
  }

  dispose(): void {
    this.#states.clear();
    this.#shown = [];
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
    previous: ReadonlyMap<Element, SourceVisibilityState>,
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
      const links = sourceElementLinks(root);
      // Two lists side by side, an element and whether something above it
      // changed: one pair for every element of the page at every
      // comparison, which as objects was work for the garbage collector.
      const pending: Element[] = [root];
      const pendingChangedAncestor: boolean[] = [false];
      while (pending.length > 0) {
        if (++inspected > this.maximumNodes) {
          overflow = true;
          break;
        }
        const element = pending.pop();
        const changedAncestor = pendingChangedAncestor.pop() === true;
        if (!element) break;
        const paint = readSourceElementPathPaint(
          element,
          this.sourceWindow,
          paintCache,
        );
        const state: SourceVisibilityState = paint.painted
          ? 'painted'
          : paint.pathVisible
            ? 'shown'
            : paint.pathDisplayed
              ? paint.visibilityHidden ? 'veiled' : 'displayed'
              : 'hidden';
        const prior = previous.get(element);
        const changed = prior !== undefined && prior !== state;
        this.#states.set(element, state);
        if (prior === 'hidden' && changed && this.#shown.length < this.maximumNodes) {
          this.#shown.push(element);
        }
        let rematerializationBoundary = false;
        if (changed && !changedAncestor) {
          const textProof = subtreeMayContainAuthoredText(
            element,
            this.maximumNodes - inspected,
          );
          inspected += textProof.inspected;
          if (textProof.overflow) {
            overflow = true;
            break;
          }
          rematerializationBoundary = textProof.mayContainText;
          if (rematerializationBoundary) changedTargets.push(element);
        }
        if (!pushSourceVisibilityChildren(
          element,
          changedAncestor || (changed && rematerializationBoundary),
          pending,
          pendingChangedAncestor,
          links,
        )) {
          overflow = true;
          break;
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

/**
 * `painted`: a box of the element is proven painted. `shown`: nothing hides
 * it, and it has no box to prove: a block of no height, whose own text may
 * hang out of it and be drawn all the same. `displayed`: nothing is
 * `display: none`, and something else hides it or cannot be read: a dialog
 * at the first frame of its fade. `veiled`: the same, and the element's own
 * `visibility` hides it. `hidden`: not displayed. Each step between two of
 * them is a boundary (D135): the text of a block of no height that is shown
 * later was never read, nor that of a dialog a script fades in, which the
 * page reader reads as shown from that first frame and which nothing
 * reports when the fade ends.
 *
 * `veiled` is apart from `displayed` (D144) because the page reader is: it
 * withholds the text of an element whose `visibility` hides it and sends
 * that of one that is faded out. A menu that a class takes from
 * `visibility: hidden` to visible at `opacity: 0`, the first frame of its
 * fade, was `displayed` before and after: no change, and its text came
 * when the fade ended, 0.8 s later, unless another comparison happened by
 * in between.
 */
type SourceVisibilityState =
  | 'painted'
  | 'shown'
  | 'displayed'
  | 'veiled'
  | 'hidden';

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
    pending.push(...slottedNodes(root));
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
      if (node.nodeType === 1) pending.push(...slottedNodes(node as Element));
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

/**
 * What a shadow host holds is drawn in the slots of the host's root, so a
 * box that holds a slot owns what the slot holds, though none of it is
 * inside the box: the box is the change, and what its slots hold, which
 * changes with it, is left out as held by it (D135). Only the nodes are
 * read, never their text; only a slot has any.
 */
function slottedNodes(element: Element): readonly Node[] {
  return (element as Partial<HTMLSlotElement>).assignedNodes?.() ?? [];
}

/**
 * Puts what `element` holds on the list of what is still to compare, so
 * that its own children come off it first, in the page's order, and then
 * its root's. False when its root cannot be read. The children are walked
 * from the last one back, each a step from its neighbour: they were copied
 * into a list first, once for every element of the page.
 */
function pushSourceVisibilityChildren(
  element: Element,
  changedAncestor: boolean,
  pending: Element[],
  pendingChangedAncestor: boolean[],
  links: SourceElementLinks,
): boolean {
  const shadow = readSourceVisibilityShadowRoot(element);
  if (shadow === UNREADABLE_VISIBILITY_SHADOW_ROOT) return false;
  if (shadow) {
    // A root is no form: its own property is its last child.
    for (
      let child = shadow.lastElementChild;
      child;
      child = links.previous(child)
    ) {
      pending.push(child);
      pendingChangedAncestor.push(changedAncestor);
    }
  }
  for (
    let child = links.last(element);
    child;
    child = links.previous(child)
  ) {
    pending.push(child);
    pendingChangedAncestor.push(changedAncestor);
  }
  return true;
}

interface SourceElementLinks {
  last(element: Element): Element | null;
  previous(element: Element): Element | null;
}

const DIRECT_ELEMENT_LINKS: SourceElementLinks = Object.freeze({
  last: (element: Element) => element.lastElementChild,
  previous: (element: Element) => element.previousElementSibling,
});

const knownElementLinks = new WeakMap<object, SourceElementLinks>();

/**
 * How to step from an element to its last child and to the sibling before
 * it, by the accessors that the element's prototypes define and never by a
 * property read on the element itself (D144). A form answers
 * `form.<name of one of its fields>` before its own properties: with a
 * field named `lastElementChild` the form's children were that field and
 * nothing else, and with one named `previousElementSibling` the walk went
 * from the form to the field, so boxes shown later in or before such a form
 * stayed blank. (The list this walk replaced read `children`, which a
 * field named so, a likelier name, stood in for the same way.) Every
 * element of a document has the same two accessors, so they are looked up
 * once a scan, on the element the scan starts from. An object without them
 * (a test's stand-in) is read as it was.
 */
function sourceElementLinks(element: Element): SourceElementLinks {
  const prototype: object | null = Object.getPrototypeOf(element);
  if (!prototype) return DIRECT_ELEMENT_LINKS;
  const known = knownElementLinks.get(prototype);
  if (known) return known;
  const accessor = (name: string): ((this: Element) => Element | null) | undefined => {
    for (
      let current: object | null = prototype;
      current;
      current = Object.getPrototypeOf(current)
    ) {
      const getter = Object.getOwnPropertyDescriptor(current, name)?.get;
      if (getter) return getter as (this: Element) => Element | null;
    }
    return undefined;
  };
  const last = accessor('lastElementChild');
  const previous = accessor('previousElementSibling');
  const links: SourceElementLinks = last && previous
    ? Object.freeze({
        last: (target: Element) => last.call(target),
        previous: (target: Element) => previous.call(target),
      })
    : DIRECT_ELEMENT_LINKS;
  knownElementLinks.set(prototype, links);
  return links;
}

const UNREADABLE_VISIBILITY_SHADOW_ROOT = Symbol(
  'unreadable-visibility-shadow-root',
);

function readSourceVisibilityShadowRoot(
  element: Element,
): ShadowRoot | undefined | typeof UNREADABLE_VISIBILITY_SHADOW_ROOT {
  try {
    return readSourceShadowRoot(element);
  } catch {
    return UNREADABLE_VISIBILITY_SHADOW_ROOT;
  }
}

/**
 * Leaves out every element that another of them holds, in the page's own
 * tree or through a slot. Each element's path is read once and looked up in
 * the set: comparing them pair by pair read a path for every pair, and a
 * thousand elements shown at once stalled the page for a second (D135).
 */
function minimizeVisibilityRoots(elements: readonly Element[]): Element[] {
  const unique = [...new Set(elements)].filter((element) => element.isConnected);
  if (unique.length < 2) return unique;
  const candidates = new Set(unique);
  return unique.filter((candidate) => {
    const path = readSourceFlatTreeElementPath(candidate);
    // A path that cannot be read: the page's own tree still can.
    if (!path) {
      return !unique.some((other) => other !== candidate && other.contains(candidate));
    }
    for (let index = 1; index < path.length; index += 1) {
      if (candidates.has(path[index]!)) return false;
    }
    return true;
  });
}
