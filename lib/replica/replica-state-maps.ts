/**
 * The maps the isolated mirror keeps by node id, with what a live patch
 * needs of them kept up to date as they change, instead of read again from
 * every entry after every patch (D165).
 *
 * A patch is applied all or none: what it changed in these maps is put back
 * when it fails. Copying each map before every patch made a change of one
 * paragraph cost as much as the whole mirror; a journal keeps the value each
 * key had before the patch first touched it. A key the patch deletes that
 * was there before would come back at the end of the map's order if it were
 * only set again, and the order of the text maps is the order of the
 * mirror's records: at such a delete the journal takes one copy of the map
 * as the patch found it, and a failure puts that copy back whole, as before.
 * A map that puts its own order back (`keepsOwnOrder`) takes no copy: the
 * node map has no order anyone reads, and the text maps keep each key's
 * place (D178; the copy of the node map was most of what removing one node
 * cost on a large page).
 */

import {
  sourceCall,
  sourceLocalName,
  sourceNodeType,
} from './source-node-accessors';

const ABSENT: unique symbol = Symbol('absent');

export class JournaledMap<Key, Value> extends Map<Key, Value> {
  #journal: Map<Key, Value | typeof ABSENT> | undefined;
  #snapshot: Map<Key, Value> | undefined;
  /** A key the map held when the journal began was deleted since. */
  #reordered = false;

  /**
   * Whether the map puts its order back by itself after a rollback
   * (`restoreJournalOrder`), so that deleting a key takes no copy of it.
   */
  protected get keepsOwnOrder(): boolean {
    return false;
  }

  /** After a rollback that set keys deleted during the journal again. */
  protected restoreJournalOrder(): void {}

  /** Starts keeping what the map held, until `endJournal` or a rollback. */
  beginJournal(): void {
    this.#journal = new Map();
    this.#snapshot = undefined;
    this.#reordered = false;
  }

  get journaling(): boolean {
    return this.#journal !== undefined;
  }

  /** The changes since `beginJournal` stay. */
  endJournal(): void {
    this.#journal = undefined;
    this.#snapshot = undefined;
    this.#reordered = false;
  }

  /** Puts the map back as it was at `beginJournal`, in its order. */
  rollbackJournal(): void {
    const journal = this.#journal;
    const snapshot = this.#snapshot;
    const reordered = this.#reordered;
    this.#journal = undefined;
    this.#snapshot = undefined;
    this.#reordered = false;
    if (snapshot) {
      this.clear();
      for (const [key, value] of snapshot) this.set(key, value);
      return;
    }
    if (!journal) return;
    for (const [key, value] of journal) {
      if (value === ABSENT) this.delete(key);
      else this.set(key, value);
    }
    if (reordered) this.restoreJournalOrder();
  }

  /**
   * Each key set or deleted since `beginJournal`, with what it held then
   * (undefined when it was not there); undefined once the map was cleared.
   */
  journalTouchedKeys(): readonly (readonly [Key, Value | undefined])[] | undefined {
    const journal = this.#journal;
    if (!journal || this.#snapshot) return undefined;
    const touched: (readonly [Key, Value | undefined])[] = [];
    for (const [key, start] of journal) {
      touched.push([key, start === ABSENT ? undefined : start] as const);
    }
    return touched;
  }

  /** What the key held at `beginJournal` (its current value without one). */
  journalStartValue(key: Key): Value | undefined {
    if (this.#snapshot) return this.#snapshot.get(key);
    const journal = this.#journal;
    if (journal?.has(key)) {
      const value = journal.get(key)!;
      return value === ABSENT ? undefined : value;
    }
    return super.get(key);
  }

  override set(key: Key, value: Value): this {
    const journal = this.#journal;
    if (journal && !this.#snapshot && !journal.has(key)) {
      journal.set(key, super.has(key) ? super.get(key)! : ABSENT);
    }
    const had = super.has(key);
    const previous = had ? super.get(key) : undefined;
    super.set(key, value);
    this.onSet(key, value, had, previous);
    return this;
  }

  override delete(key: Key): boolean {
    if (!super.has(key)) return false;
    const journal = this.#journal;
    if (journal && !this.#snapshot) {
      if (!this.keepsOwnOrder) {
        if (journal.get(key) !== ABSENT) this.#snapshot = this.#startCopy(journal);
      } else {
        if (!journal.has(key)) journal.set(key, super.get(key)!);
        if (journal.get(key) !== ABSENT) this.#reordered = true;
      }
    }
    const previous = super.get(key)!;
    super.delete(key);
    this.onDelete(key, previous);
    return true;
  }

  override clear(): void {
    const journal = this.#journal;
    if (journal && !this.#snapshot && this.size > 0) {
      this.#snapshot = this.#startCopy(journal);
    }
    super.clear();
    this.onClear();
  }

  /** Called after a key is set. */
  protected onSet(
    _key: Key,
    _value: Value,
    _had: boolean,
    _previous: Value | undefined,
  ): void {}

  /** Called after a key is deleted. */
  protected onDelete(_key: Key, _previous: Value): void {}

  /** Called after the map is cleared. */
  protected onClear(): void {}

  /**
   * The map as the journal began: until a key that was there is deleted,
   * keys there before keep their place and new keys come after them.
   */
  #startCopy(journal: Map<Key, Value | typeof ABSENT>): Map<Key, Value> {
    const copy = new Map<Key, Value>();
    for (const [key, value] of super.entries()) {
      if (!journal.has(key)) {
        copy.set(key, value);
        continue;
      }
      const start = journal.get(key)!;
      if (start !== ABSENT) copy.set(key, start);
    }
    return copy;
  }
}

/**
 * The mirror's nodes by id, and each node's id: a patch looks a node's id
 * up for every element it reads around its targets, and building that index
 * from every node was the largest part of a patch on a large page (D165).
 * It also keeps the counts the diagnostics report after every patch, which
 * were read from every node: images, shadow roots, and the elements Simul
 * marks as visually hidden or as showing a selected image source. Those two
 * marks are written with the element's attributes; the mirror says when it
 * wrote an element's attributes again (`reclassify`).
 */
export class ReplicaNodeMap extends JournaledMap<number, Node> {
  readonly #ids = new Map<Node, number>();
  readonly #kinds = new Map<Node, number>();
  #imageCount = 0;
  #shadowRootCount = 0;
  #visuallyHiddenCount = 0;
  #selectedImageSourceCount = 0;

  /** Nobody reads the order of the nodes (D178). */
  protected override get keepsOwnOrder(): boolean {
    return true;
  }

  /** Each node's id. */
  get ids(): ReadonlyMap<Node, number> {
    return this.#ids;
  }

  idOf(node: Node): number | undefined {
    return this.#ids.get(node);
  }

  hasNode(node: Node): boolean {
    return this.#ids.has(node);
  }

  /** Whether the node was the mirror's under its id when the journal began. */
  journalStartHasNode(node: Node): boolean {
    const id = this.#ids.get(node);
    return id !== undefined && this.journalStartValue(id) === node;
  }

  get imageCount(): number {
    return this.#imageCount;
  }

  get shadowRootCount(): number {
    return this.#shadowRootCount;
  }

  get visuallyHiddenCount(): number {
    return this.#visuallyHiddenCount;
  }

  get selectedImageSourceCount(): number {
    return this.#selectedImageSourceCount;
  }

  /** The node's attributes were written again: its counts are read again. */
  reclassify(node: Node): void {
    const before = this.#kinds.get(node);
    if (before === undefined) return;
    const after = nodeKinds(node);
    if (after === before) return;
    this.#add(before, -1);
    this.#add(after, 1);
    this.#kinds.set(node, after);
  }

  protected override onSet(
    key: number,
    value: Node,
    had: boolean,
    previous: Node | undefined,
  ): void {
    if (had && previous !== undefined) {
      this.#add(this.#kinds.get(previous) ?? nodeKinds(previous), -1);
      if (previous !== value && this.#ids.get(previous) === key) {
        this.#ids.delete(previous);
      }
      if (!this.#ids.has(previous)) this.#kinds.delete(previous);
    }
    this.#ids.set(value, key);
    const kinds = nodeKinds(value);
    this.#kinds.set(value, kinds);
    this.#add(kinds, 1);
  }

  protected override onDelete(key: number, previous: Node): void {
    this.#add(this.#kinds.get(previous) ?? nodeKinds(previous), -1);
    if (this.#ids.get(previous) === key) this.#ids.delete(previous);
    if (!this.#ids.has(previous)) this.#kinds.delete(previous);
  }

  protected override onClear(): void {
    this.#ids.clear();
    this.#kinds.clear();
    this.#imageCount = 0;
    this.#shadowRootCount = 0;
    this.#visuallyHiddenCount = 0;
    this.#selectedImageSourceCount = 0;
  }

  #add(kinds: number, sign: 1 | -1): void {
    if (kinds & IMAGE) this.#imageCount += sign;
    if (kinds & SHADOW_ROOT) this.#shadowRootCount += sign;
    if (kinds & VISUALLY_HIDDEN) this.#visuallyHiddenCount += sign;
    if (kinds & SELECTED_IMAGE_SOURCE) this.#selectedImageSourceCount += sign;
  }
}

const IMAGE = 1;
const SHADOW_ROOT = 2;
const VISUALLY_HIDDEN = 4;
const SELECTED_IMAGE_SOURCE = 8;

function nodeKinds(node: Node): number {
  if (sourceNodeType(node) === 11) return 'host' in node ? SHADOW_ROOT : 0;
  if (sourceNodeType(node) !== 1) return 0;
  const element = node as Element;
  let kinds = sourceLocalName(element).toLowerCase() === 'img' ? IMAGE : 0;
  if (sourceCall(element, 'getAttribute', 'data-simul-visually-hidden') === 'v1') {
    kinds |= VISUALLY_HIDDEN;
  }
  if (sourceCall(element, 'getAttribute', 'data-simul-selected-image-source') === 'v1') {
    kinds |= SELECTED_IMAGE_SOURCE;
  }
  return kinds;
}

/**
 * Text kept by node id, with the bytes it counts toward the mirror's
 * budget kept as a running total: two bytes a character and 32 for the
 * entry, the measure the budget has always used (D165).
 */
export class ReplicaTextMap<Value extends { readonly text: string }>
  extends JournaledMap<number, Value> {
  #bytes = 0;
  /** Each key's place in the map's order: larger is later. */
  readonly #places = new Map<number, number>();
  #nextPlace = 0;
  /** The place a key had when the journal began, kept when it is deleted. */
  readonly #startPlaces = new Map<number, number>();

  protected override get keepsOwnOrder(): boolean {
    return true;
  }

  override beginJournal(): void {
    super.beginJournal();
    this.#startPlaces.clear();
  }

  override endJournal(): void {
    super.endJournal();
    this.#startPlaces.clear();
  }

  /** Where the key came in the map's order when the journal began. */
  journalStartPlace(key: number): number | undefined {
    const kept = this.#startPlaces.get(key);
    if (kept !== undefined) return kept;
    return this.journalStartValue(key) === undefined
      ? undefined
      : this.#places.get(key);
  }

  override delete(key: number): boolean {
    if (
      this.journaling && !this.#startPlaces.has(key) && super.has(key) &&
      this.journalStartValue(key) !== undefined
    ) this.#startPlaces.set(key, this.#places.get(key)!);
    return super.delete(key);
  }

  /** Each key back in its place, and the map in the order of its places. */
  protected override restoreJournalOrder(): void {
    for (const [key, place] of this.#startPlaces) {
      if (super.has(key)) this.#places.set(key, place);
    }
    this.#startPlaces.clear();
    const entries = [...super.entries()].sort(
      ([left], [right]) => this.#places.get(left)! - this.#places.get(right)!,
    );
    Map.prototype.clear.call(this);
    for (const [key, value] of entries) Map.prototype.set.call(this, key, value);
  }

  /** The sum of `text.length * 2 + 32` over the map's values. */
  get bytes(): number {
    return this.#bytes;
  }

  /**
   * Where the key comes in the map's order, as a number that only compares:
   * the mirror's records follow this order (D165).
   */
  placeOf(key: number): number | undefined {
    return this.#places.get(key);
  }

  protected override onSet(
    key: number,
    value: Value,
    had: boolean,
    previous: Value | undefined,
  ): void {
    if (had && previous !== undefined) this.#bytes -= replicaTextBytes(previous);
    else this.#places.set(key, this.#nextPlace++);
    this.#bytes += replicaTextBytes(value);
  }

  protected override onDelete(key: number, previous: Value): void {
    this.#bytes -= replicaTextBytes(previous);
    this.#places.delete(key);
  }

  protected override onClear(): void {
    this.#bytes = 0;
    this.#places.clear();
  }
}

export function replicaTextBytes(value: { readonly text: string }): number {
  return value.text.length * 2 + 32;
}
