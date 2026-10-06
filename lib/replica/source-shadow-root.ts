/**
 * The one way the page script reaches a shadow root (D125).
 *
 * `element.shadowRoot` is null for a root its component closed, so such a
 * component used to be an empty box in the mirror. Chrome gives an
 * extension's page script `chrome.dom.openOrClosedShadowRoot(element)`
 * without a permission; it returns the page's own root, open or closed, and
 * null for the roots of the browser's controls (a text field's inner editor,
 * a video's buttons). It does return Chrome's own viewer root for the `body`
 * of a PDF document, which is never asked about here. Every reader of the
 * page goes through this module, so all of them, the credential classifier
 * above all, read the same roots; one that only indexes the page may still
 * hold an older "none" than one about to send something, which asks again.
 *
 * The call is about a hundred times dearer than reading the property, and
 * the page is walked many times, so answers are kept. A root is never
 * detached or replaced: one found is kept for good. "None" holds only until
 * a root is attached, and nothing fires when one is, so whatever is about to
 * send something asks again first. A checkpoint is read in a fresh walk
 * (`beginSourceShadowRootWalk`), which asks about every element once. A
 * sender of anything less asks about every element above what it sends
 * (`askAboutSourceShadowRootsAbove`) and within it
 * (`askAboutSourceShadowRootsWithin`); an image capture also asks about what
 * is painted over the image, and a person's input about the elements around
 * it. The rest trusts the answers kept: the walks that index the page, and
 * the mirror's periodic discovery, which asks about waiting hosts in turn
 * (`probeSourceShadowRoot`).
 */

/** `chrome.dom.openOrClosedShadowRoot`, or a stand-in under test. */
export type SourceShadowRootReader = (
  element: HTMLElement,
) => ShadowRoot | null | undefined;

/**
 * Told about every root a reader of the document meets, once. `late` is
 * true for a closed root found on an element that had been asked about
 * before without one: whatever was read beside it then did not know it.
 */
export type SourceShadowRootListener = (root: ShadowRoot, late: boolean) => void;

interface SourceShadowRootLedger {
  readonly document: Document;
  readonly reader: SourceShadowRootReader | undefined;
  /** Closed roots found, by host. */
  readonly closed: WeakMap<Element, ShadowRoot>;
  /** When an element was last found without a closed root (see `clock`). */
  readonly absent: WeakMap<Element, number>;
  /** Roots the listeners have been told about. */
  readonly noted: WeakSet<ShadowRoot>;
  readonly listeners: Set<SourceShadowRootListener>;
}

const LEDGERS = new WeakMap<Document, SourceShadowRootLedger>();
/** Ledgers installed in this script. None in the panel: it reads open roots only. */
let installedLedgers = 0;
/** The ledger last used. The page script has one document and one ledger. */
let activeLedger: SourceShadowRootLedger | undefined;

/** Counts up with every fresh walk; "none" is stamped with it. */
let clock = 1;
/** Inside a fresh walk, the reading it began at: older answers are asked again. */
let freshSince = 0;
/** Open walks; the slot lists of closed roots are kept while one is open. */
let openWalks = 0;
let walkSlotLists: Map<ShadowRoot, readonly HTMLSlotElement[]> | undefined;

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** The tags `attachShadow` accepts besides custom elements. */
const AUTHOR_SHADOW_HOST_TAGS = new Set([
  'article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span',
]);

/**
 * A closed root with more slots than this is not searched: the slot lookup
 * fails and its callers treat the node's ancestry as unreadable.
 */
const MAX_SOURCE_CLOSED_ROOT_SLOTS = 4_096;
/** Ancestors climbed above a node that is about to be sent. */
const MAX_SOURCE_ROOT_CHAIN = 4_096;

/**
 * Starts keeping the roots of `sourceDocument`: its closed roots become
 * readable when a reader is given, and listeners can be told about the
 * roots met there. Without a reader (a script that is not an extension's)
 * only open roots are read; in a document nobody installed this for
 * (Simul's own replica in the panel) nothing is kept at all.
 */
export function installSourceShadowRootReader(
  sourceDocument: Document,
  reader: SourceShadowRootReader | undefined,
): void {
  if (LEDGERS.delete(sourceDocument)) installedLedgers -= 1;
  if (activeLedger?.document === sourceDocument) activeLedger = undefined;
  LEDGERS.set(sourceDocument, {
    document: sourceDocument,
    reader,
    closed: new WeakMap(),
    absent: new WeakMap(),
    noted: new WeakSet(),
    listeners: new Set(),
  });
  installedLedgers += 1;
}

/**
 * Tells `listener` about every root met in `sourceDocument` from now on;
 * returns how to stop. Nothing is told where no reader was installed.
 */
export function listenForSourceShadowRoots(
  sourceDocument: Document,
  listener: SourceShadowRootListener,
): () => void {
  const ledger = LEDGERS.get(sourceDocument);
  if (!ledger) return () => undefined;
  ledger.listeners.add(listener);
  return () => {
    ledger.listeners.delete(listener);
  };
}

/** Chrome's own call, when this script runs as an extension's page script. */
export function chromeSourceShadowRootReader(): SourceShadowRootReader | undefined {
  try {
    const dom = (globalThis as {
      chrome?: {
        dom?: { openOrClosedShadowRoot?: SourceShadowRootReader };
      };
    }).chrome?.dom;
    return typeof dom?.openOrClosedShadowRoot === 'function'
      ? (element) => dom.openOrClosedShadowRoot?.(element)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the page could have attached a root to this element: a custom
 * element, or one of the few tags `attachShadow` allows. The browser's own
 * roots sit on other elements (`input`, `textarea`, `select`, `details`,
 * `video`, `meter`...), which are never asked about, so the mirror cannot
 * walk a control's internals whatever the call returns for them. Nor is the
 * `body` of a PDF document: its closed root is Chrome's PDF viewer.
 */
export function canHostAuthorShadowRoot(element: Element): boolean {
  if (element.namespaceURI !== HTML_NAMESPACE) return false;
  const name = element.localName;
  if (name === 'body') {
    return element.ownerDocument?.contentType !== 'application/pdf';
  }
  return AUTHOR_SHADOW_HOST_TAGS.has(name) || name.includes('-');
}

/**
 * An element's shadow root, open or closed. Reading the element's own
 * property may throw on a hostile object; that is left to the caller, which
 * fails closed as it did before. The extension call is guarded here.
 */
export function readSourceShadowRoot(element: Element): ShadowRoot | undefined {
  const own = element.shadowRoot;
  if (own) {
    if (installedLedgers !== 0 && !activeLedger?.noted.has(own)) {
      noteOwnSourceShadowRoot(element, own);
    }
    return own;
  }
  if (installedLedgers === 0) return undefined;
  // The common case: this element is known to have none.
  const at = activeLedger?.absent.get(element);
  if (at !== undefined && at >= freshSince) return undefined;
  return readClosedSourceShadowRoot(element, false);
}

/**
 * The same, asking Chrome again about an element remembered as having no
 * root: a root can be attached later, once. For the periodic discovery.
 */
export function probeSourceShadowRoot(element: Element): ShadowRoot | undefined {
  const own = element.shadowRoot;
  if (own) {
    if (installedLedgers !== 0 && !activeLedger?.noted.has(own)) {
      noteOwnSourceShadowRoot(element, own);
    }
    return own;
  }
  return installedLedgers === 0
    ? undefined
    : readClosedSourceShadowRoot(element, true);
}

/** A walk of the page by one of its readers; see `beginSourceShadowRootWalk`. */
export interface SourceShadowRootWalk {
  end(): void;
}

/**
 * Opens a walk: one run of a reader that the page cannot interrupt. While a
 * walk is open the slot list of each closed root is read once. A `fresh`
 * walk also asks about every element again the first time it meets it,
 * whatever was kept: it is for what is about to be sent. Walks nest; end
 * each in a `finally`.
 */
export function beginSourceShadowRootWalk(
  options: { readonly fresh?: boolean } = {},
): SourceShadowRootWalk {
  const outerFresh = freshSince;
  openWalks += 1;
  walkSlotLists ??= new Map();
  if (options.fresh) freshSince = clock += 1;
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      freshSince = outerFresh;
      openWalks -= 1;
      if (openWalks === 0) walkSlotLists = undefined;
    },
  };
}

/**
 * Asks Chrome again about every element from `node` up to the document,
 * through shadow hosts, and returns the roots this turned up that were not
 * known before: closed ones Chrome reports, and open ones no reader had met.
 * A sender calls it before it reads what it sends: content is classified by
 * what the roots above it wrap around it. `asked` holds the elements already
 * asked about by this sender's current run; the climb stops at the first of
 * them.
 */
export function askAboutSourceShadowRootsAbove(
  node: Node,
  asked: Set<Node>,
): readonly ShadowRoot[] {
  if (installedLedgers === 0) return [];
  const found: ShadowRoot[] = [];
  let current: Node | null = node;
  for (let steps = 0; current && steps < MAX_SOURCE_ROOT_CHAIN; steps += 1) {
    if (asked.has(current)) return found;
    asked.add(current);
    const own = current.nodeType === 1 ? (current as Element).shadowRoot : null;
    if (own) {
      if (!activeLedger?.noted.has(own) && noteOwnSourceShadowRoot(current as Element, own)) {
        found.push(own);
      }
    } else if (current.nodeType === 1) {
      const element = current as Element;
      const ledger = sourceShadowRootLedger(element.ownerDocument);
      const at = ledger?.absent.get(element);
      // Inside a fresh walk an element it has asked about needs no second call.
      const askedInThisWalk = freshSince !== 0 && at !== undefined &&
        at >= freshSince;
      if (ledger && !askedInThisWalk && !ledger.closed.has(element)) {
        const root = readClosedSourceShadowRoot(element, true);
        if (root) found.push(root);
      }
    }
    current = current.parentNode ??
      (isSourceShadowRoot(current) ? current.host : null);
  }
  // A chain this long is not climbed to its end: the sender treats it as
  // unreadable.
  if (current) throw new Error('Shadow-including ancestry too deep.');
  return found;
}

/**
 * Asks Chrome again about every element in `node`'s subtree, through the
 * roots it holds, before the subtree is sent: a root attached since an
 * element was last read may wrap its slotted children in a masking box.
 * Returns the closed roots this turned up that were not known before, or
 * undefined when the subtree holds more than `budget.nodes` nodes, which
 * is shared by the calls of one run.
 */
export function askAboutSourceShadowRootsWithin(
  node: Node,
  asked: Set<Node>,
  budget: { nodes: number },
): readonly ShadowRoot[] | undefined {
  if (installedLedgers === 0) return [];
  const found: ShadowRoot[] = [];
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as Node;
    if (asked.has(current)) continue;
    if (budget.nodes <= 0) return undefined;
    budget.nodes -= 1;
    asked.add(current);
    if (current.nodeType === 1) {
      const element = current as Element;
      let root = element.shadowRoot ?? undefined;
      if (root) {
        if (!activeLedger?.noted.has(root)) noteOwnSourceShadowRoot(element, root);
      } else {
        const ledger = sourceShadowRootLedger(element.ownerDocument);
        root = ledger?.closed.get(element);
        if (ledger && !root) {
          root = readClosedSourceShadowRoot(element, true);
          if (root) found.push(root);
        }
      }
      if (root) stack.push(root);
    }
    for (let child = current.lastChild; child; child = child.previousSibling) {
      stack.push(child);
    }
  }
  return found;
}

/** Whether a node is a shadow root, open or closed. */
export function isSourceShadowRoot(node: Node): node is ShadowRoot {
  return node.nodeType === 11 &&
    (node as ShadowRoot).host?.nodeType === 1;
}

/**
 * The slot a node is assigned to. `assignedSlot` reads null when the slot
 * is in a closed root, which would put a slotted node's flat-tree ancestry
 * at its host and skip whatever the root wraps around the slot (a masking
 * or hidden box). For a host with a closed root the slot is found the way
 * the browser assigns it: the first slot of that name in the root, or under
 * manual assignment the slot that lists the node. For a parent with an open
 * root, or none, null already means "not assigned". Throws when the root has
 * too many slots to search; callers treat that as an unreadable ancestry.
 */
export function readSourceAssignedSlot(node: Node): Element | null | undefined {
  const own = (node as Node & {
    readonly assignedSlot?: Element | null;
  }).assignedSlot;
  if (own !== null || installedLedgers === 0) return own;
  const parent = node.parentNode;
  if (!parent || parent.nodeType !== 1) return null;
  const host = parent as Element;
  // The common case: the parent is known to have no closed root.
  const at = activeLedger?.absent.get(host);
  if (at !== undefined && at >= freshSince) return null;
  if (host.shadowRoot) return null;
  const root = readClosedSourceShadowRoot(host, false);
  if (!root) return null;
  const slots = readClosedRootSlots(root);
  if (root.slotAssignment === 'manual') {
    for (const slot of slots) {
      if (slot.assignedNodes().includes(node as ChildNode)) return slot;
    }
    return null;
  }
  const name = node.nodeType === 1
    ? (node as Element).getAttribute('slot') ?? ''
    : '';
  for (const slot of slots) {
    if ((slot.getAttribute('name') ?? '') === name) return slot;
  }
  return null;
}

/** The slots of a closed root in tree order, read once while a walk is open. */
function readClosedRootSlots(root: ShadowRoot): readonly HTMLSlotElement[] {
  const kept = walkSlotLists?.get(root);
  if (kept) return kept;
  const found = root.querySelectorAll('slot');
  if (found.length > MAX_SOURCE_CLOSED_ROOT_SLOTS) {
    throw new Error('Too many slots in a closed shadow root.');
  }
  const slots: HTMLSlotElement[] = [];
  for (const slot of found) {
    if (
      slot.namespaceURI === HTML_NAMESPACE &&
      typeof (slot as HTMLSlotElement).assignedNodes === 'function'
    ) slots.push(slot as HTMLSlotElement);
  }
  walkSlotLists?.set(root, slots);
  return slots;
}

function sourceShadowRootLedger(
  sourceDocument: Document | null,
): SourceShadowRootLedger | undefined {
  if (!sourceDocument) return undefined;
  if (activeLedger?.document === sourceDocument) return activeLedger;
  const ledger = LEDGERS.get(sourceDocument);
  if (ledger) activeLedger = ledger;
  return ledger;
}

/** Tells the document's listeners about a root, once; true if this did. */
function noteSourceShadowRoot(root: ShadowRoot, late: boolean): boolean {
  const ledger = sourceShadowRootLedger(root.ownerDocument);
  if (!ledger || ledger.noted.has(root)) return false;
  ledger.noted.add(root);
  for (const listener of ledger.listeners) {
    try {
      listener(root, late);
    } catch {
      // A listener's failure is its own; the read goes on.
    }
  }
  return true;
}

/**
 * The same for an element's own (open) root: late when the element was read
 * before without one, as for a closed root.
 */
function noteOwnSourceShadowRoot(element: Element, root: ShadowRoot): boolean {
  const ledger = sourceShadowRootLedger(element.ownerDocument);
  if (!ledger) return false;
  const late = ledger.absent.has(element);
  if (late) ledger.absent.delete(element);
  return noteSourceShadowRoot(root, late);
}

function readClosedSourceShadowRoot(
  element: Element,
  askAgain: boolean,
): ShadowRoot | undefined {
  const ledger = sourceShadowRootLedger(element.ownerDocument);
  if (!ledger) return undefined;
  const known = ledger.closed.get(element);
  if (known) return known;
  const at = ledger.absent.get(element);
  if (!askAgain && at !== undefined && at >= freshSince) return undefined;
  if (ledger.reader && canHostAuthorShadowRoot(element)) {
    let root: ShadowRoot | null | undefined;
    try {
      root = ledger.reader(element as HTMLElement);
    } catch {
      // The call throws outside an extension context and on what it does
      // not take for an HTML element: the same as no root.
      root = undefined;
    }
    if (root && isSourceShadowRoot(root) && root.host === element) {
      ledger.closed.set(element, root);
      ledger.absent.delete(element);
      noteSourceShadowRoot(root, at !== undefined);
      return root;
    }
  }
  ledger.absent.set(element, clock);
  return undefined;
}
