/**
 * Mutation observers that deliver a record the way the browser does
 * (D125): only to an observer watching the record's target, or an ancestor
 * of it with `subtree`, within one tree. A record never crosses a shadow
 * root, so a change inside a root reaches only those who observe that
 * root, an old value only those who asked for old values, and an attribute
 * only those whose filter names it. linkedom's own observer does none of
 * this, which let a test pass whatever was observed.
 */
export function scopedMutationObservers() {
  interface Registration {
    readonly observer: object;
    readonly callback: MutationCallback;
    readonly target: Node;
    readonly options: MutationObserverInit;
  }
  let registrations: Registration[] = [];
  const create = (
    callback: MutationCallback,
  ): Pick<MutationObserver, 'observe' | 'disconnect'> => {
    const observer = {
      observe(target: Node, options: MutationObserverInit = {}) {
        registrations = registrations.filter(
          (entry) => entry.observer !== observer || entry.target !== target,
        );
        registrations.push({ observer, callback, target, options });
      },
      disconnect() {
        registrations = registrations.filter((entry) => entry.observer !== observer);
      },
    };
    return observer;
  };
  /**
   * Delivers the changes of one task: each observer gets, in one call, the
   * records it watches. Returns how many observers received any.
   */
  const deliverAll = (records: readonly ScopedRecord[]): number => {
    const batches = new Map<object, { callback: MutationCallback; records: MutationRecord[] }>();
    for (const record of records) {
      const seen = new Set<object>();
      for (const entry of registrations) {
        // One record per observer, however many of its registrations match.
        if (seen.has(entry.observer)) continue;
        if (!watches(entry.target, entry.options, record)) continue;
        seen.add(entry.observer);
        const wantsOldValue = record.type === 'attributes'
          ? entry.options.attributeOldValue === true
          : record.type === 'characterData'
            ? entry.options.characterDataOldValue === true
            : false;
        const batch = batches.get(entry.observer) ??
          { callback: entry.callback, records: [] };
        batch.records.push({
          type: record.type,
          target: record.target,
          attributeName: record.attributeName ?? null,
          oldValue: wantsOldValue ? record.oldValue ?? null : null,
          addedNodes: record.addedNodes ?? [],
          removedNodes: record.removedNodes ?? [],
        } as unknown as MutationRecord);
        batches.set(entry.observer, batch);
      }
    }
    for (const [observer, batch] of batches) {
      batch.callback(batch.records, observer as MutationObserver);
    }
    return batches.size;
  };
  return {
    create,
    deliverAll,
    /** Delivers one change; returns how many observers received it. */
    deliver: (record: ScopedRecord): number => deliverAll([record]),
    observedTargets: () => registrations.map((entry) => entry.target),
  };
}

interface ScopedRecord {
  readonly type: MutationRecordType;
  readonly target: Node;
  readonly attributeName?: string;
  readonly oldValue?: string | null;
  readonly addedNodes?: readonly Node[];
  readonly removedNodes?: readonly Node[];
}

function watches(
  observed: Node,
  options: MutationObserverInit,
  { type, target, attributeName }: ScopedRecord,
): boolean {
  if (type === 'attributes' && !options.attributes && !options.attributeOldValue) {
    return false;
  }
  if (
    type === 'attributes' && options.attributeFilter &&
    !options.attributeFilter.includes(attributeName ?? '')
  ) return false;
  if (
    type === 'characterData' &&
    !options.characterData &&
    !options.characterDataOldValue
  ) return false;
  if (type === 'childList' && !options.childList) return false;
  // `parentNode` of a shadow root is null: the climb stops at the root.
  for (let node: Node | null = target; node; node = node.parentNode) {
    if (node === observed) return node === target || options.subtree === true;
  }
  return false;
}

export type ScopedMutationObservers = ReturnType<typeof scopedMutationObservers>;
