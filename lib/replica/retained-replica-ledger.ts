/**
 * What the panel keeps of a mirror, counted as the page changes it (D165).
 *
 * The panel keeps the last good replica while it stages the next, so the
 * replica it keeps is held to a budget of bytes and nodes after every live
 * patch. That count was a walk of every node of the replica after every
 * patch: on a page of 50,000 elements a third of the panel's time while the
 * page changed one paragraph a frame. The ledger counts the replica once,
 * then follows it with a MutationObserver: a node added, removed, or whose
 * text or attributes changed is counted again, so a patch costs what it
 * changed. Simul writes to the replica outside patches too (translations,
 * language tags, dropdowns), and the observer sees those as well.
 *
 * Two things a MutationObserver does not see are counted when asked: the
 * value of an input or a textarea (a property, not an attribute), and the
 * text of the adopted sheets, which is counted once for every copy of one
 * sheet. Near the budget, and every so often, the full walk answers and the
 * ledger is counted again from it, so a count gone wrong can only make the
 * ledger slower, never let it keep a replica the walk would refuse.
 */

import {
  sourceAttributeList,
  sourceLocalName,
  sourceNodeType,
  sourceProperty,
} from './source-node-accessors';

/** The walk's measure of one node, without what is counted when asked. */
export function retainedNodeBytes(node: Node): number {
  let bytes = 48;
  const type = sourceNodeType(node);
  if (type === 3 || type === 8) {
    bytes += (node.nodeValue?.length ?? 0) * 2;
  } else if (type === 1) {
    const element = node as Element;
    bytes += sourceLocalName(element).length * 2;
    const attributes = sourceAttributeList(element);
    for (let index = 0; index < attributes.length; index += 1) {
      const { name, value } = attributes[index]!;
      bytes += (name.length + value.length) * 2 + 16;
    }
  }
  return bytes;
}

export function isRetainedTextControl(element: Element): boolean {
  const tagName = sourceLocalName(element).toLowerCase();
  return tagName === 'input' || tagName === 'textarea';
}

function controlBytes(element: Element): number {
  const control = element as HTMLInputElement;
  return (control.value.length + control.placeholder.length) * 2;
}

export interface RetainedReplicaTotals {
  /** Bytes of the nodes, without the mirror's text metadata. */
  readonly bytes: number;
  /** Nodes visited: every node of the replica and every open shadow root. */
  readonly nodes: number;
}

/**
 * The full walk: every node under `root`, into open shadow roots. Undefined
 * once it passes `maxNodes` nodes or `maxBytes` bytes, where it stops, as
 * the walk run after every patch did.
 */
export function walkRetainedReplica(
  root: Element,
  ownedAdoptedStyles: ReadonlySet<Node>,
  maxBytes: number,
  maxNodes: number,
  visit?: (node: Node, bytes: number) => void,
): RetainedReplicaTotals | undefined {
  // It walks by the tree's own links and keeps no set of the nodes it saw
  // (a tree meets each node once) and no copy of each child list.
  const pending: Node[] = [root];
  let visited = 0;
  // Every shadow root's copy of an adopted sheet is set from one string,
  // which the browser shares; count that text once (D84).
  const adoptedTexts = new Set<string>();
  let bytes = 0;
  while (pending.length > 0) {
    const node = pending.pop()!;
    visited += 1;
    if (visited > maxNodes) return undefined;
    const own = retainedNodeBytes(node);
    visit?.(node, own);
    if (
      sourceNodeType(node) === 3 &&
      ownedAdoptedStyles.has(sourceProperty(node, 'parentNode') as Node)
    ) {
      const text = node.nodeValue ?? '';
      bytes += 48;
      if (!adoptedTexts.has(text)) {
        adoptedTexts.add(text);
        bytes += text.length * 2;
      }
    } else {
      bytes += own;
    }
    if (sourceNodeType(node) === 1) {
      const element = node as Element;
      if (isRetainedTextControl(element)) bytes += controlBytes(element);
      const shadow = sourceProperty(element, 'shadowRoot');
      if (shadow) pending.push(shadow);
    }
    for (let child = sourceProperty(node, 'firstChild'); child; child = sourceProperty(child, 'nextSibling')) {
      pending.push(child);
    }
    if (bytes > maxBytes) return undefined;
  }
  return { bytes, nodes: visited };
}

type MutationObserverConstructor = new (
  callback: (records: MutationRecord[]) => void,
) => MutationObserver;

/** A fresh object each time: some DOM implementations write to it. */
function observed(): MutationObserverInit {
  return { childList: true, subtree: true, attributes: true, characterData: true };
}

/** Above this share of a limit, the full walk answers. */
const NEAR_LIMIT = 0.9;
/** Every so many answers, the full walk checks the ledger. */
const VERIFY_EVERY = 128;
/** More elements waiting for the ARIA index than this: it is rebuilt. */
const MAX_PENDING_ARIA_ELEMENTS = 20_000;

export interface RetainedReplicaLedgerOptions {
  readonly root: Element;
  readonly ownedAdoptedStyles: ReadonlySet<Node>;
  readonly MutationObserver: MutationObserverConstructor;
}

export class RetainedReplicaLedger {
  readonly #root: Element;
  readonly #ownedAdoptedStyles: ReadonlySet<Node>;
  readonly #observer: MutationObserver;
  /** Every node of the replica, with its own bytes. */
  readonly #counted = new Map<Node, number>();
  readonly #controls = new Set<Element>();
  #ownBytes = 0;
  #seeded = false;
  /** The last full count stopped over the budget, before every root. */
  #walkStopped = false;
  #answers = 0;
  #disposed = false;
  /** Elements added, removed, or whose `id` or `aria-controls` changed. */
  #ariaElements = new Set<Element>();
  #ariaOverflow = false;
  /** Full walks run, for tests. */
  fullWalks = 0;

  constructor(options: RetainedReplicaLedgerOptions) {
    this.#root = options.root;
    this.#ownedAdoptedStyles = options.ownedAdoptedStyles;
    this.#observer = new options.MutationObserver((records) => {
      // Taken as they come: a node removed from the replica is followed by
      // the observer only until its records are delivered, and its subtree
      // is read as it is now.
      if (!this.#disposed) this.#process(records);
    });
  }

  get root(): Element {
    return this.#root;
  }

  dispose(): void {
    this.#disposed = true;
    this.#observer.disconnect();
    this.#counted.clear();
    this.#controls.clear();
    this.#ariaElements.clear();
  }

  /** Reads the records the observer holds. */
  flush(): void {
    if (this.#disposed) return;
    const records = this.#observer.takeRecords();
    if (records.length > 0) this.#process(records);
  }

  /**
   * Whether the replica, with `extraBytes` more (the mirror's text
   * metadata), fits `maxBytes` and `maxNodes`: the full walk's answer.
   */
  fits(extraBytes: number, maxBytes: number, maxNodes: number): boolean {
    if (this.#disposed) return false;
    if (!this.#seeded) return this.#seed(extraBytes, maxBytes, maxNodes);
    this.flush();
    const totals = this.totals();
    this.#answers += 1;
    if (
      totals.bytes + extraBytes > maxBytes * NEAR_LIMIT ||
      totals.nodes > maxNodes * NEAR_LIMIT ||
      this.#answers % VERIFY_EVERY === 0
    ) {
      const walked = this.#walk(maxBytes, maxNodes);
      if (
        !walked || walked.bytes !== totals.bytes ||
        walked.nodes !== totals.nodes
      ) {
        // Over the budget, or a count gone wrong: the walk's answer, and
        // the ledger counted again.
        return this.#seed(extraBytes, maxBytes, maxNodes);
      }
    }
    return totals.bytes + extraBytes <= maxBytes && totals.nodes <= maxNodes;
  }

  /** The ledger's count; its records must have been read (`flush`). */
  totals(): RetainedReplicaTotals {
    let bytes = this.#ownBytes;
    for (const control of this.#controls) bytes += controlBytes(control);
    // The text of an adopted sheet: counted once for all its copies.
    const adoptedTexts = new Set<string>();
    for (const style of this.#ownedAdoptedStyles) {
      if (!this.#counted.has(style)) continue;
      for (let child = sourceProperty(style, 'firstChild'); child; child = sourceProperty(child, 'nextSibling')) {
        if (sourceNodeType(child) !== 3) continue;
        const text = child.nodeValue ?? '';
        bytes -= text.length * 2;
        if (!adoptedTexts.has(text)) {
          adoptedTexts.add(text);
          bytes += text.length * 2;
        }
      }
    }
    return { bytes, nodes: this.#counted.size };
  }

  /** Whether the node is in the replica: under its root, into open roots. */
  contains(node: Node): boolean {
    let current: Node = node;
    for (;;) {
      if (current === this.#root) return true;
      // A mirror form's field named `parentNode` would loop here (D195).
      const parent: Node | null = sourceProperty(current, 'parentNode');
      if (parent) {
        current = parent;
        continue;
      }
      if (sourceNodeType(current) !== 11 || !('host' in current)) return false;
      const host = (current as ShadowRoot).host;
      if (!host || sourceProperty(host, 'shadowRoot') !== current) return false;
      current = host;
    }
  }

  /**
   * The elements whose place in the ARIA index may have changed since the
   * last call, or undefined when too many changed and it must be rebuilt.
   */
  takeAriaElements(): ReadonlySet<Element> | undefined {
    this.flush();
    const elements = this.#ariaElements;
    const overflow = this.#ariaOverflow;
    this.#ariaElements = new Set();
    this.#ariaOverflow = false;
    return overflow ? undefined : elements;
  }

  #walk(maxBytes: number, maxNodes: number): RetainedReplicaTotals | undefined {
    this.fullWalks += 1;
    return walkRetainedReplica(
      this.#root,
      this.#ownedAdoptedStyles,
      maxBytes,
      maxNodes,
    );
  }

  /** Counts the replica again from a full walk, and answers from it. */
  #seed(extraBytes: number, maxBytes: number, maxNodes: number): boolean {
    this.flush();
    // A walk that stopped over the budget left roots past where it stopped
    // unobserved: what changed in them since is read by the ARIA index anew
    // (D165 review).
    if (this.#walkStopped) {
      this.#walkStopped = false;
      this.#noteAriaOverflow();
    }
    this.#counted.clear();
    this.#controls.clear();
    this.#ownBytes = 0;
    this.#seeded = false;
    this.fullWalks += 1;
    const walked = walkRetainedReplica(
      this.#root,
      this.#ownedAdoptedStyles,
      maxBytes,
      maxNodes,
      (node, bytes) => this.#count(node, bytes),
    );
    if (!walked) {
      // Over the budget: counted again from the next walk.
      this.#walkStopped = true;
      this.#counted.clear();
      this.#controls.clear();
      this.#ownBytes = 0;
      return false;
    }
    this.#seeded = true;
    return walked.bytes + extraBytes <= maxBytes && walked.nodes <= maxNodes;
  }

  #count(node: Node, bytes: number): void {
    const previous = this.#counted.get(node);
    if (previous === undefined) {
      if (sourceNodeType(node) === 11 || node === this.#root) {
        this.#observer.observe(node, observed());
      } else if (sourceNodeType(node) === 1 && isRetainedTextControl(node as Element)) {
        this.#controls.add(node as Element);
      }
    }
    this.#counted.set(node, bytes);
    this.#ownBytes += bytes - (previous ?? 0);
  }

  #process(records: readonly MutationRecord[]): void {
    if (!this.#seeded) {
      // Counted from scratch at the next answer.
      this.#noteAriaOverflow();
      return;
    }
    const placed = new Set<Node>();
    const changed = new Set<Node>();
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) placed.add(node);
        for (const node of record.removedNodes) placed.add(node);
        continue;
      }
      changed.add(record.target);
      if (
        record.type === 'attributes' &&
        (record.attributeName === 'id' || record.attributeName === 'aria-controls') &&
        sourceNodeType(record.target) === 1
      ) this.#noteAriaElement(record.target as Element);
    }
    // Where a node is now decides: one in the replica is counted with its
    // subtree, one out of it is taken out with its subtree.
    for (const node of placed) {
      if (this.contains(node)) this.#countSubtree(node);
      else this.#uncountSubtree(node);
    }
    for (const node of changed) {
      if (this.#counted.has(node)) this.#count(node, retainedNodeBytes(node));
    }
  }

  #countSubtree(root: Node): void {
    const pending: Node[] = [root];
    while (pending.length > 0) {
      const node = pending.pop()!;
      this.#count(node, retainedNodeBytes(node));
      if (sourceNodeType(node) === 1) {
        this.#noteAriaElement(node as Element);
        const shadow = sourceProperty((node as Element), 'shadowRoot');
        if (shadow) pending.push(shadow);
      }
      for (let child = sourceProperty(node, 'firstChild'); child; child = sourceProperty(child, 'nextSibling')) {
        pending.push(child);
      }
    }
  }

  #uncountSubtree(root: Node): void {
    const pending: Node[] = [root];
    while (pending.length > 0) {
      const node = pending.pop()!;
      const previous = this.#counted.get(node);
      if (previous !== undefined) {
        this.#counted.delete(node);
        this.#ownBytes -= previous;
        if (sourceNodeType(node) === 1) this.#controls.delete(node as Element);
      }
      if (sourceNodeType(node) === 1) {
        this.#noteAriaElement(node as Element);
        const shadow = sourceProperty((node as Element), 'shadowRoot');
        if (shadow) pending.push(shadow);
      }
      for (let child = sourceProperty(node, 'firstChild'); child; child = sourceProperty(child, 'nextSibling')) {
        pending.push(child);
      }
    }
  }

  #noteAriaElement(element: Element): void {
    if (this.#ariaOverflow) return;
    this.#ariaElements.add(element);
    if (this.#ariaElements.size > MAX_PENDING_ARIA_ELEMENTS) {
      this.#noteAriaOverflow();
    }
  }

  #noteAriaOverflow(): void {
    this.#ariaOverflow = true;
    this.#ariaElements.clear();
  }
}
