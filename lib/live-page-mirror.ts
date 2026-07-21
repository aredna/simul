import {
  VISUAL_STYLE_PROPERTIES,
  isSafeImageSource,
  type VisualControlShell,
  type VisualOptgroupState,
  type VisualOptionState,
  type VisualSelectState,
  type VisualStyle,
} from './page-snapshot';
import {
  isDocumentScrollTarget,
  nestedScrollerOrdinal,
  readDocumentScrollSnapshot,
  readNestedScrollSnapshot,
  type PrimaryScrollTarget,
} from './primary-scroll';

export const LIVE_MIRROR_VERSION = 1 as const;
export const LIVE_PAGE_OBSERVER_IMPLEMENTATION_REVISION = 5 as const;
export const LIVE_PAGE_OBSERVER_RUNTIME_MARKER = 'simul:live-observer-v5';

type LivePageObserverBridge = Readonly<{
  implementationRevision: typeof LIVE_PAGE_OBSERVER_IMPLEMENTATION_REVISION;
  runtimeMarker: typeof LIVE_PAGE_OBSERVER_RUNTIME_MARKER;
  install: typeof installLivePageObserver;
  captureDelta: typeof captureLivePageDelta;
  unregister: typeof unregisterLivePageObserver;
}>;

type LivePageObserverGlobal = typeof globalThis & {
  __simulLivePageObserverBridgeV4?: LivePageObserverBridge;
};

/** Installs the locally bundled bridge used by Chrome's isolated page world. */
export function installLivePageObserverBridge(): void {
  const target = globalThis as LivePageObserverGlobal;
  target.__simulLivePageObserverBridgeV4 = Object.freeze({
    implementationRevision: LIVE_PAGE_OBSERVER_IMPLEMENTATION_REVISION,
    runtimeMarker: LIVE_PAGE_OBSERVER_RUNTIME_MARKER,
    install: installLivePageObserver,
    captureDelta: captureLivePageDelta,
    unregister: unregisterLivePageObserver,
  });
}

/** Self-contained executeScript invoker; Chrome serializes only this body. */
export function invokeLivePageObserverBridge(
  sessionId: string,
  generation: number,
): LivePageObserverInstallation | undefined {
  const bridge = (
    globalThis as typeof globalThis & {
      __simulLivePageObserverBridgeV4?: {
        implementationRevision?: unknown;
        install?: unknown;
      };
    }
  ).__simulLivePageObserverBridgeV4;
  if (
    bridge?.implementationRevision !== 5 ||
    typeof bridge.install !== 'function'
  ) return undefined;
  return (bridge.install as (
    session: string,
    nextGeneration: number,
  ) => LivePageObserverInstallation)(sessionId, generation);
}

/** Self-contained best-effort teardown invoker for an installed page bridge. */
export function invokeLivePageObserverUnregisterBridge(sessionId: string): boolean {
  const bridge = (
    globalThis as typeof globalThis & {
      __simulLivePageObserverBridgeV4?: {
        implementationRevision?: unknown;
        unregister?: unknown;
      };
    }
  ).__simulLivePageObserverBridgeV4;
  if (
    bridge?.implementationRevision !== 5 ||
    typeof bridge.unregister !== 'function'
  ) return false;
  return (bridge.unregister as (session: string) => boolean)(sessionId);
}

/** Closure-free invoker for the bundled incremental DOM capture function. */
export function invokeLivePageDeltaCaptureBridge(
  sessionId: string,
  generation: number,
  sequence: number,
  requestedNodeIds: string[],
): LivePageDelta | undefined {
  const bridge = (
    globalThis as typeof globalThis & {
      __simulLivePageObserverBridgeV4?: {
        implementationRevision?: unknown;
        captureDelta?: unknown;
      };
    }
  ).__simulLivePageObserverBridgeV4;
  if (
    bridge?.implementationRevision !== 5 ||
    typeof bridge.captureDelta !== 'function'
  ) return undefined;
  return (bridge.captureDelta as (
    session: string,
    nextGeneration: number,
    nextSequence: number,
    nodeIds: string[],
  ) => LivePageDelta)(sessionId, generation, sequence, requestedNodeIds);
}

export interface LivePageDirtyMessage {
  type: 'simul:page-dirty';
  version: typeof LIVE_MIRROR_VERSION;
  generation: number;
  sessionId: string;
  sequence: number;
  url: string;
  nodeIds: string[];
}

export interface LivePageScrollMessage {
  type: 'simul:page-scroll';
  version: typeof LIVE_MIRROR_VERSION;
  generation: number;
  sessionId: string;
  url: string;
  scrollTarget: PrimaryScrollTarget;
  scrollX: number;
  scrollY: number;
  maxScrollX: number;
  maxScrollY: number;
  /** Opaque, content-free identity used only to retire stale replica panes. */
  nestedOwnerKey?: number;
  /** Ordinal among qualified panes; used when source/replica structure agrees. */
  nestedOwnerOrdinal?: number;
  /** Document-owner position retained when a nested viewport is active. */
  documentScrollX: number;
  documentScrollY: number;
  documentMaxScrollX: number;
  documentMaxScrollY: number;
}

export type LivePageObserverInstallation =
  | {
      installed: true;
      generation: number;
      sequence: number;
    }
  | {
      installed: false;
      generation: number;
      sequence: number;
      reason: 'session-limit';
    };

export interface LiveVisualTextNode {
  kind: 'text';
  nodeId: string;
  text: string;
}

export interface LiveVisualElementNode {
  kind: 'element';
  nodeId: string;
  tag: string;
  style: VisualStyle;
  controlShell?: VisualControlShell;
  selectState?: VisualSelectState;
  optionState?: VisualOptionState;
  optgroupState?: VisualOptgroupState;
  attributes?: Record<string, string>;
  children: LiveVisualNode[];
}

export interface LiveVisualPlaceholderNode {
  kind: 'placeholder';
  nodeId: string;
  style: VisualStyle;
  label: string;
}

export type LiveVisualNode =
  | LiveVisualTextNode
  | LiveVisualElementNode
  | LiveVisualPlaceholderNode;

export interface LivePageReplacement {
  targetId: string;
  node: LiveVisualNode | null;
}

export interface LivePageDelta {
  version: typeof LIVE_MIRROR_VERSION;
  generation: number;
  sequence: number;
  url: string;
  documentLanguage?: string;
  documentWidth: number;
  documentHeight: number;
  desynchronized: boolean;
  replacements: LivePageReplacement[];
}

const NODE_ID_PATTERN = /^n[1-9]\d{0,8}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;
const MAX_DIRTY_IDS = 48;
const MAX_DELTA_NODES = 6_000;
const MAX_DELTA_TEXT = 150_000;
const MAX_DELTA_STYLE_CHARACTERS = 1_000_000;
const MAX_DELTA_ATTRIBUTE_CHARACTERS = 300_000;
const MAX_DELTA_IMAGE_URL_CHARACTERS = 200_000;
const MAX_DOCUMENT_LANGUAGE_LENGTH = 35;
const MAX_TRACKED_SELECTS = 10_000;
const MAX_SELECT_POLL_WORK = 512;
const MAX_SELECT_FINGERPRINT_OPTIONS = 10_000;
const MAX_SELECT_POLL_OPTION_WORK = 20_000;
const SELECT_POLL_INTERVAL_MS = 250;

/**
 * Install one mutation/scroll bridge in the extension's isolated world. It
 * never annotates or otherwise changes the source DOM.
 */
export function installLivePageObserver(
  sessionId: string,
  generation: number,
): LivePageObserverInstallation {
  type Registry = {
    implementationRevision?: number;
    sessions: Map<string, number>;
    nodeIds: WeakMap<Node, string>;
    nodes: Map<string, Node>;
    idFor(node: Node): string;
    disconnect(): void;
    announceScroll(): void;
    currentSequence(): number;
  };
  const isolatedGlobal = globalThis as typeof globalThis & {
    __simulLiveMirrorV1?: Registry;
  };
  const staleRegistry = isolatedGlobal.__simulLiveMirrorV1;
  if (
    staleRegistry &&
    staleRegistry.implementationRevision !==
      LIVE_PAGE_OBSERVER_IMPLEMENTATION_REVISION
  ) {
    try {
      staleRegistry.disconnect();
    } catch {
      // A prior extension version may already have partially failed.
    }
    delete isolatedGlobal.__simulLiveMirrorV1;
  }
  const existingRegistry = isolatedGlobal.__simulLiveMirrorV1;
  if (existingRegistry) {
    if (
      !existingRegistry.sessions.has(sessionId) &&
      existingRegistry.sessions.size >= 16
    ) {
      return {
        installed: false,
        generation,
        sequence: existingRegistry.currentSequence(),
        reason: 'session-limit',
      };
    }
    existingRegistry.sessions.set(sessionId, generation);
    existingRegistry.announceScroll();
    setTimeout(() => existingRegistry.announceScroll(), 350);
    return {
      installed: true,
      generation,
      sequence: existingRegistry.currentSequence(),
    };
  }

  const nodeIds = new WeakMap<Node, string>();
  const nodes = new Map<string, Node>();
  let nextNodeId = 1;
  let sequence = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollFrame = 0;
  let activeNestedScroller: Element | undefined;
  let pendingNestedScroller: Element | undefined;
  const nestedOwnerKeys = new WeakMap<Element, number>();
  let nestedOwnerOrdinals = new WeakMap<Element, number>();
  let nextNestedOwnerKey = 1;
  let pendingDocumentScroll = false;
  let pendingScrollAnnouncement = false;
  let lastDocumentScroll:
    ReturnType<typeof readDocumentScrollSnapshot> | undefined;
  let stopped = false;
  let dimensionDirty = false;
  let resizeObserver: ResizeObserver | undefined;
  let initialScrollTimer: ReturnType<typeof setTimeout> | undefined;
  const dirtyIds = new Set<string>();
  const observers: MutationObserver[] = [];
  const observedRoots = new WeakSet<Document | ShadowRoot>();
  const observedRootList: Array<Document | ShadowRoot> = [];
  const pendingCustomElements = new Map<string, Set<Element>>();
  const sessions = new Map([[sessionId, generation]]);
  const selectCandidates: HTMLSelectElement[] = [];
  const selectFingerprints = new WeakMap<HTMLSelectElement, string>();
  let selectPollCursor = 0;
  let selectPollTimer: ReturnType<typeof setTimeout> | undefined;
  let selectTrackingOverflow = false;

  const selectIsOpen = (select: HTMLSelectElement): boolean => {
    try {
      return select.matches(':open');
    } catch {
      return false;
    }
  };

  const selectVisibilityFingerprint = (select: HTMLSelectElement): string => {
    try {
      const style = window.getComputedStyle(select);
      const overflow = `${style.overflow}:${style.overflowX}:${style.overflowY}`;
      const transform = style.transform || 'none';
      const rect = transform !== 'none' ? select.getBoundingClientRect() : undefined;
      return [
        style.display,
        style.visibility,
        style.opacity,
        style.getPropertyValue('content-visibility'),
        style.position,
        style.left,
        style.top,
        style.width,
        style.height,
        overflow,
        transform,
        rect?.width ?? '',
        rect?.height ?? '',
      ].join(':');
    } catch {
      return 'unreadable';
    }
  };

  const selectFingerprint = (select: HTMLSelectElement): string | undefined => {
    try {
      const options = select.options;
      const optionCount = options.length;
      const inspected = select.multiple
        ? Math.min(optionCount, MAX_SELECT_FINGERPRINT_OPTIONS)
        : 0;
      // FNV-1a keeps the retained state compact while observing every option
      // that the bounded live-delta graph can represent.
      let selectedHash = 0x811c9dc5;
      let selectedHash2 = 5381;
      let selectedCount = 0;
      for (let index = 0; index < inspected; index += 1) {
        const option = options.item(index);
        const selectedCode = option?.selected ? index + 1 : 0;
        if (selectedCode !== 0) selectedCount += 1;
        selectedHash ^= selectedCode;
        selectedHash = Math.imul(selectedHash, 0x01000193) >>> 0;
        selectedHash2 = (Math.imul(selectedHash2, 33) ^ selectedCode) >>> 0;
      }
      return [
        select.disabled ? 1 : 0,
        select.multiple ? 1 : 0,
        selectIsOpen(select) ? 1 : 0,
        selectVisibilityFingerprint(select),
        optionCount,
        select.selectedIndex,
        inspected,
        selectedHash,
        selectedHash2,
        selectedCount,
      ].join(':');
    } catch {
      return undefined;
    }
  };

  const pollSelectState = (): void => {
    selectPollTimer = undefined;
    if (stopped || selectCandidates.length === 0) return;
    let inspected = 0;
    let inspectedOptions = 0;
    while (inspected < MAX_SELECT_POLL_WORK && selectCandidates.length > 0) {
      if (selectPollCursor >= selectCandidates.length) selectPollCursor = 0;
      const select = selectCandidates[selectPollCursor];
      if (!select?.isConnected) {
        if (select) selectFingerprints.delete(select);
        selectCandidates.splice(selectPollCursor, 1);
        continue;
      }
      const optionWork = select.multiple
        ? Math.min(select.options.length, MAX_SELECT_FINGERPRINT_OPTIONS)
        : 0;
      if (
        inspected > 0 &&
        inspectedOptions + optionWork > MAX_SELECT_POLL_OPTION_WORK
      ) break;
      selectPollCursor += 1;
      inspected += 1;
      inspectedOptions += optionWork;
      const previous = selectFingerprints.get(select);
      const current = selectFingerprint(select);
      if (current === undefined) continue;
      selectFingerprints.set(select, current);
      if (previous === undefined || previous === current) continue;
      const nodeId = nodeIds.get(select);
      if (nodeId) dirtyIds.add(nodeId);
    }
    if (dirtyIds.size > 0) scheduleFlush();
    if (!stopped && selectCandidates.length > 0) {
      selectPollTimer = setTimeout(pollSelectState, SELECT_POLL_INTERVAL_MS);
    }
  };

  const scheduleSelectPoll = (): void => {
    if (stopped || selectPollTimer !== undefined || selectCandidates.length === 0) {
      return;
    }
    selectPollTimer = setTimeout(pollSelectState, SELECT_POLL_INTERVAL_MS);
  };

  const trackSelect = (node: Node): void => {
    if (!(node instanceof HTMLSelectElement) || selectFingerprints.has(node)) {
      return;
    }
    if (selectCandidates.length >= MAX_TRACKED_SELECTS) {
      // Never silently leave an untracked select stale. A root dirty signal
      // makes the bounded delta path declare desynchronization and request a
      // fresh snapshot when the page exceeds its representable envelope.
      if (!selectTrackingOverflow) {
        selectTrackingOverflow = true;
        dirtyIds.add(idFor(document.documentElement));
        scheduleFlush();
      }
      return;
    }
    const fingerprint = node.multiple ? 'pending' : selectFingerprint(node);
    if (fingerprint === undefined) return;
    selectCandidates.push(node);
    selectFingerprints.set(node, fingerprint);
    scheduleSelectPoll();
  };

  const idFor = (node: Node): string => {
    const existing = nodeIds.get(node);
    if (existing) {
      trackSelect(node);
      return existing;
    }
    const id = `n${nextNodeId}`;
    nextNodeId += 1;
    nodeIds.set(node, id);
    nodes.set(id, node);
    trackSelect(node);
    return id;
  };

  const pageUrl = (): string => {
    try {
      const url = new URL(window.location.href);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().slice(0, 2_048);
    } catch {
      return window.location.origin;
    }
  };

  const send = (message: Record<string, unknown>, attempt = 0): void => {
    try {
      const response = (
        globalThis as typeof globalThis & {
          chrome?: {
            runtime?: {
              sendMessage(value: Record<string, unknown>): Promise<unknown>;
            };
          };
        }
      ).chrome?.runtime?.sendMessage(message);
      if (response && typeof response.catch === 'function') {
        void response.catch(() => {
          if (!stopped && attempt < 2) {
            setTimeout(() => send(message, attempt + 1), 100 * (attempt + 1));
          }
        });
      }
    } catch {
      if (!stopped && attempt < 2) {
        setTimeout(() => send(message, attempt + 1), 100 * (attempt + 1));
      }
    }
  };

  const flush = (): void => {
    flushTimer = undefined;
    if (stopped || (dirtyIds.size === 0 && !dimensionDirty)) return;
    sequence += 1;
    const nodeIdsToSend = [...dirtyIds].slice(0, 48);
    for (const nodeId of nodeIdsToSend) dirtyIds.delete(nodeId);
    dimensionDirty = false;
    for (const [targetSessionId, targetGeneration] of sessions) {
      send({
        type: 'simul:page-dirty',
        version: 1,
        sessionId: targetSessionId,
        generation: targetGeneration,
        sequence,
        url: pageUrl(),
        nodeIds: nodeIdsToSend,
      });
    }
    if (dirtyIds.size > 0) flushTimer = setTimeout(flush, 0);
  };

  const scheduleFlush = (): void => {
    if (flushTimer === undefined) flushTimer = setTimeout(flush, 140);
  };

  const composedParent = (node: Node): Element | null => {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot
      ? root.host
      : null;
  };

  const nearestKnownElement = (node: Node): Element | null => {
    let current = node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : composedParent(node);
    for (let owner = current; owner; owner = composedParent(owner)) {
      const tagName = owner.localName.toLowerCase();
      if (tagName === 'datalist') break;
      if (tagName === 'select') {
        current = owner;
        break;
      }
    }
    if (
      current &&
      (current instanceof HTMLInputElement ||
        current instanceof HTMLTextAreaElement ||
        (
          current.hasAttribute('contenteditable') &&
          current.getAttribute('contenteditable')?.trim().toLowerCase() !== 'false'
        ))
    ) {
      current = composedParent(current);
    }
    while (current && !nodeIds.has(current)) {
      current = composedParent(current);
    }
    return current;
  };

  const observeOpenRoots = (root: Document | ShadowRoot | Element): void => {
    const candidates = root.querySelectorAll('*');
    for (const candidate of candidates) trackPotentialShadowHost(candidate);
  };

  const trackPotentialShadowHost = (element: Element): void => {
    if (element.shadowRoot) {
      observeRoot(element.shadowRoot);
      return;
    }
    const name = element.localName;
    if (
      !name.includes('-') ||
      typeof customElements === 'undefined' ||
      customElements.get(name) ||
      pendingCustomElements.size >= 64
    ) return;
    let hosts = pendingCustomElements.get(name);
    if (!hosts) {
      hosts = new Set<Element>();
      pendingCustomElements.set(name, hosts);
      void customElements.whenDefined(name).then(() => {
        const tracked = pendingCustomElements.get(name);
        pendingCustomElements.delete(name);
        if (stopped || !tracked) return;
        for (const host of tracked) {
          if (!host.isConnected || !host.shadowRoot) continue;
          observeRoot(host.shadowRoot);
          const known = nearestKnownElement(host);
          if (known) dirtyIds.add(idFor(known));
        }
        if (dirtyIds.size > 0) scheduleFlush();
      }).catch(() => pendingCustomElements.delete(name));
    }
    if (hosts.size < 128) hosts.add(element);
  };

  const forgetTree = (node: Node): void => {
    const id = nodeIds.get(node);
    if (id) {
      nodeIds.delete(node);
      nodes.delete(id);
    }
    for (const child of node.childNodes) forgetTree(child);
    if (node.nodeType === Node.ELEMENT_NODE) {
      const shadowRoot = (node as Element).shadowRoot;
      if (shadowRoot) for (const child of shadowRoot.childNodes) forgetTree(child);
    }
  };

  const onMutations = (records: MutationRecord[]): void => {
    if (records.length > 0) {
      // Qualification order is DOM-order dependent. Any observed change can
      // alter layout or insert a pane ahead of the active owner, so cached
      // ordinals must not survive the mutation batch.
      nestedOwnerOrdinals = new WeakMap<Element, number>();
    }
    for (const record of records) {
      if (record.type === 'childList') {
        for (const removed of record.removedNodes) forgetTree(removed);
        for (const added of record.addedNodes) {
          if (added.nodeType === Node.ELEMENT_NODE) {
            const element = added as Element;
            trackPotentialShadowHost(element);
            observeOpenRoots(element);
          }
        }
      }
      let target: Node = record.target instanceof ShadowRoot
        ? record.target.host
        : record.target;
      if (record.type === 'attributes' && target instanceof Element) {
        const attribute = record.attributeName ?? '';
        if (
          target.tagName === 'SOURCE' &&
          ['sizes', 'src', 'srcset'].includes(attribute)
        ) {
          target = target.parentElement ?? target;
        } else if (attribute === 'aria-expanded') {
          target = target.parentElement ?? target;
        } else if (attribute === 'slot') {
          target = target.parentElement ?? target;
        } else if (target.tagName === 'SLOT' && attribute === 'name') {
          const root = target.getRootNode();
          if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
            target = root.host;
          }
        }
      }
      const known = nearestKnownElement(target);
      if (known) dirtyIds.add(idFor(known));
    }
    if (dirtyIds.size > 0) scheduleFlush();
  };

  const onSlotChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    nestedOwnerOrdinals = new WeakMap<Element, number>();
    const root = target.getRootNode();
    const candidate = typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot
      ? root.host
      : target;
    const known = nearestKnownElement(candidate);
    if (!known) return;
    dirtyIds.add(idFor(known));
    scheduleFlush();
  };

  const onVisualStateEvent = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const known = nearestKnownElement(target);
    if (!known) return;
    dirtyIds.add(idFor(known));
    scheduleFlush();
  };

  const onSelectStateEvent = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    let select: Element | null = target;
    while (select && select.localName.toLowerCase() !== 'select') {
      select = composedParent(select);
    }
    if (!select) return;
    // Selection is reflected through IDL state rather than a DOM mutation,
    // and a customizable select's :open state is surfaced by toggle events.
    // Prefer the select itself so a live replacement carries the typed option
    // state without rebuilding an unrelated ancestor.
    const known = nodeIds.has(select) ? select : nearestKnownElement(select);
    if (!known) return;
    dirtyIds.add(idFor(known));
    scheduleFlush();
  };

  const observeRoot = (root: Document | ShadowRoot): void => {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observedRootList.push(root);
    const observer = new MutationObserver(onMutations);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    observers.push(observer);
    root.addEventListener('slotchange', onSlotChange);
    root.addEventListener('focusin', onVisualStateEvent, true);
    root.addEventListener('focusout', onVisualStateEvent, true);
    root.addEventListener('load', onVisualStateEvent, true);
    root.addEventListener('transitionend', onVisualStateEvent, true);
    root.addEventListener('animationend', onVisualStateEvent, true);
    root.addEventListener('input', onSelectStateEvent, true);
    root.addEventListener('change', onSelectStateEvent, true);
    root.addEventListener('beforetoggle', onSelectStateEvent, true);
    root.addEventListener('toggle', onSelectStateEvent, true);
    root.addEventListener('click', onSelectStateEvent, true);
    root.addEventListener('keydown', onSelectStateEvent, true);
    root.addEventListener('pointerdown', onSelectStateEvent, true);
    root.addEventListener('scroll', onScroll, true);
    observeOpenRoots(root);
  };

  const onScroll = (event?: Event): void => {
    if (event) {
      if (isDocumentScrollTarget(event.target, document, window)) {
        pendingDocumentScroll = true;
      } else if (
        event.target instanceof Element &&
        readNestedScrollSnapshot(event.target, document, window)
      ) {
        if (event.target !== activeNestedScroller) {
          nestedOwnerOrdinals.delete(event.target);
        }
        pendingNestedScroller = event.target;
      } else {
        // Ignore incidental inputs, carousels, and clipped regions. Scheduling
        // a frame for them would replay whichever primary target happened to
        // be active before this unrelated scroll event.
        return;
      }
    } else {
      // Rebuild/status announcements must describe the current DOM order,
      // not an ordinal retained from an earlier replica structure.
      nestedOwnerOrdinals = new WeakMap<Element, number>();
      pendingScrollAnnouncement = true;
    }
    if (scrollFrame || stopped) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const documentScroll = readDocumentScrollSnapshot(document, window);
      const documentMoved = lastDocumentScroll !== undefined &&
        !sameScrollPosition(documentScroll, lastDocumentScroll);
      let scroll = documentScroll;
      if (pendingDocumentScroll) {
        activeNestedScroller = undefined;
      } else if (pendingNestedScroller) {
        const nestedScroll = readNestedScrollSnapshot(
          pendingNestedScroller,
          document,
          window,
        );
        if (nestedScroll) {
          activeNestedScroller = pendingNestedScroller;
          scroll = nestedScroll;
        } else if (pendingNestedScroller === activeNestedScroller) {
          activeNestedScroller = undefined;
        }
      } else if (documentMoved) {
        // Programmatic scrolling can occur without a usable event target. A
        // changed document offset must retire a previously active nested pane
        // instead of allowing that stale pane to suppress ordinary scrolling.
        activeNestedScroller = undefined;
      } else {
        const nested = activeNestedScroller;
        const nestedScroll = nested
          ? readNestedScrollSnapshot(nested, document, window)
          : undefined;
        if (nestedScroll) {
          scroll = nestedScroll;
        } else if (nested) {
          activeNestedScroller = undefined;
        }
      }
      lastDocumentScroll = documentScroll;
      pendingNestedScroller = undefined;
      pendingDocumentScroll = false;
      pendingScrollAnnouncement = false;
      for (const [targetSessionId, targetGeneration] of sessions) {
        let nestedOwnerKey: number | undefined;
        if (scroll.scrollTarget === 'nested' && activeNestedScroller) {
          nestedOwnerKey = nestedOwnerKeys.get(activeNestedScroller);
          if (nestedOwnerKey === undefined) {
            nestedOwnerKey = nextNestedOwnerKey;
            nextNestedOwnerKey = nextNestedOwnerKey >= 1_000_000_000
              ? 1
              : nextNestedOwnerKey + 1;
            nestedOwnerKeys.set(activeNestedScroller, nestedOwnerKey);
          }
        }
        let nestedOwnerOrdinalValue: number | undefined;
        if (scroll.scrollTarget === 'nested' && activeNestedScroller) {
          nestedOwnerOrdinalValue = nestedOwnerOrdinals.get(activeNestedScroller);
          if (nestedOwnerOrdinalValue === undefined) {
            nestedOwnerOrdinalValue = nestedScrollerOrdinal(
              activeNestedScroller,
              document,
              window,
            );
            if (nestedOwnerOrdinalValue !== undefined) {
              nestedOwnerOrdinals.set(
                activeNestedScroller,
                nestedOwnerOrdinalValue,
              );
            }
          }
        }
        send({
          type: 'simul:page-scroll',
          version: 1,
          sessionId: targetSessionId,
          generation: targetGeneration,
          url: pageUrl(),
          ...scroll,
          ...(nestedOwnerKey !== undefined ? { nestedOwnerKey } : {}),
          ...(nestedOwnerOrdinalValue !== undefined
            ? { nestedOwnerOrdinal: nestedOwnerOrdinalValue }
            : {}),
          documentScrollX: documentScroll.scrollX,
          documentScrollY: documentScroll.scrollY,
          documentMaxScrollX: documentScroll.maxScrollX,
          documentMaxScrollY: documentScroll.maxScrollY,
        });
      }
    });
  };

  const onViewportResize = (): void => {
    if (stopped) return;
    nestedOwnerOrdinals = new WeakMap<Element, number>();
    dirtyIds.add(idFor(document.documentElement));
    dimensionDirty = true;
    scheduleFlush();
  };

  const registry: Registry = {
    implementationRevision: LIVE_PAGE_OBSERVER_IMPLEMENTATION_REVISION,
    sessions,
    nodeIds,
    nodes,
    idFor,
    disconnect() {
      stopped = true;
      for (const observer of observers) observer.disconnect();
      for (const root of observedRootList) {
        root.removeEventListener('slotchange', onSlotChange);
        root.removeEventListener('focusin', onVisualStateEvent, true);
        root.removeEventListener('focusout', onVisualStateEvent, true);
        root.removeEventListener('load', onVisualStateEvent, true);
        root.removeEventListener('transitionend', onVisualStateEvent, true);
        root.removeEventListener('animationend', onVisualStateEvent, true);
        root.removeEventListener('input', onSelectStateEvent, true);
        root.removeEventListener('change', onSelectStateEvent, true);
        root.removeEventListener('beforetoggle', onSelectStateEvent, true);
        root.removeEventListener('toggle', onSelectStateEvent, true);
        root.removeEventListener('click', onSelectStateEvent, true);
        root.removeEventListener('keydown', onSelectStateEvent, true);
        root.removeEventListener('pointerdown', onSelectStateEvent, true);
        root.removeEventListener('scroll', onScroll, true);
      }
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      if (selectPollTimer !== undefined) clearTimeout(selectPollTimer);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      if (initialScrollTimer !== undefined) clearTimeout(initialScrollTimer);
      resizeObserver?.disconnect();
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onViewportResize);
    },
    announceScroll: onScroll,
    currentSequence: () => sequence,
  };
  isolatedGlobal.__simulLiveMirrorV1 = registry;
  idFor(document.documentElement);
  observeRoot(document);
  if (typeof ResizeObserver === 'function') {
    let initialResize = true;
    resizeObserver = new ResizeObserver(() => {
      if (initialResize) {
        initialResize = false;
        return;
      }
      dimensionDirty = true;
      scheduleFlush();
    });
    resizeObserver.observe(document.documentElement);
    if (document.body) resizeObserver.observe(document.body);
  }
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onViewportResize, { passive: true });
  onScroll();
  initialScrollTimer = setTimeout(onScroll, 350);
  return { installed: true, generation, sequence };
}

function sameScrollPosition(
  left: ReturnType<typeof readDocumentScrollSnapshot>,
  right: ReturnType<typeof readDocumentScrollSnapshot>,
): boolean {
  return left.scrollX === right.scrollX && left.scrollY === right.scrollY;
}

/** Best-effort cleanup when a side panel or detached companion closes. */
export function unregisterLivePageObserver(sessionId: string): boolean {
  type Registry = {
    sessions: Map<string, number>;
    disconnect(): void;
  };
  const isolatedGlobal = globalThis as typeof globalThis & {
    __simulLiveMirrorV1?: Registry;
  };
  const registry = isolatedGlobal.__simulLiveMirrorV1;
  if (!registry || !/^[A-Za-z0-9_-]{8,64}$/u.test(sessionId)) return false;
  const removed = registry.sessions.delete(sessionId);
  if (registry.sessions.size === 0) {
    registry.disconnect();
    delete isolatedGlobal.__simulLiveMirrorV1;
  }
  return removed;
}

/** Capture only coalesced dirty subtrees from the persistent isolated registry. */
export function captureLivePageDelta(
  sessionId: string,
  generation: number,
  sequence: number,
  requestedNodeIds: string[],
): LivePageDelta {
  type Registry = {
    generation: number;
    sessions: Map<string, number>;
    nodes: Map<string, Node>;
    idFor(node: Node): string;
  };
  const registry = (
    globalThis as typeof globalThis & { __simulLiveMirrorV1?: Registry }
  ).__simulLiveMirrorV1;
  const maxStyleCharacters = 1_000_000;
  const maxAttributeCharacters = 300_000;
  const maxImageUrlCharacters = 200_000;
  const maxImageUrlLength = 100_000;
  let nodeCount = 0;
  let textCharacters = 0;
  let styleCharacters = 0;
  let attributeCharacters = 0;
  let imageUrlCharacters = 0;
  let desynchronized =
    !registry ||
    registry.sessions.get(sessionId) !== generation ||
    requestedNodeIds.length > 48;

  const styleProperties = [
    'align-content', 'align-items', 'align-self', 'aspect-ratio',
    'background-attachment', 'background-clip', 'background-color',
    'background-image', 'background-origin', 'background-position',
    'background-repeat', 'background-size', 'border-bottom-color',
    'border-bottom-left-radius', 'border-bottom-right-radius',
    'border-bottom-style', 'border-bottom-width', 'border-collapse',
    'border-left-color', 'border-left-style', 'border-left-width',
    'border-right-color', 'border-right-style', 'border-right-width',
    'border-spacing', 'border-top-color', 'border-top-left-radius',
    'border-top-right-radius', 'border-top-style', 'border-top-width',
    'bottom', 'box-shadow', 'box-sizing', 'break-after', 'break-before',
    'break-inside', 'caption-side', 'clear', 'color', 'column-count',
    'column-fill', 'column-gap', 'column-rule-color', 'column-rule-style',
    'column-rule-width', 'column-width', 'direction', 'display', 'empty-cells', 'flex-basis',
    'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap', 'float',
    'font-family', 'font-size', 'font-style', 'font-weight', 'gap',
    'grid-auto-columns', 'grid-auto-flow', 'grid-auto-rows', 'grid-column',
    'grid-row', 'grid-template-columns', 'grid-template-areas',
    'grid-template-rows', 'height', 'hyphens', 'justify-content',
    'justify-items', 'justify-self', 'left', 'letter-spacing', 'line-height',
    'list-style-position', 'list-style-type', 'margin-bottom', 'margin-left',
    'margin-right', 'margin-top', 'max-height', 'max-width', 'min-height',
    'min-width', 'object-fit', 'object-position', 'opacity', 'order',
    'overflow-wrap', 'overflow-x', 'overflow-y', 'padding-bottom',
    'padding-left', 'padding-right', 'padding-top', 'position', 'right',
    'row-gap', 'table-layout', 'text-align', 'text-decoration-color',
    'text-decoration-line', 'text-decoration-style', 'text-decoration-thickness', 'text-indent',
    'text-overflow', 'text-shadow', 'text-transform', 'top', 'transform',
    'transform-origin', 'vertical-align', 'visibility', 'white-space',
    'width', 'word-break', 'word-spacing', 'writing-mode', 'z-index',
  ];
  const safeTags = new Set([
    'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption',
    'circle', 'code', 'col', 'colgroup', 'dd', 'details', 'div', 'dl', 'dt',
    'em', 'ellipse', 'figcaption', 'figure', 'footer', 'g', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'label', 'li', 'line',
    'main', 'mark', 'nav', 'ol', 'p', 'path', 'picture', 'polygon', 'polyline',
    'pre', 'rect', 'section', 'select', 'small', 'source', 'span', 'strong',
    'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'tr', 'u', 'ul',
  ]);
  const publicRoles = new Set([
    'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem',
  ]);
  const privateRoles = new Set([
    'checkbox', 'combobox', 'radio', 'searchbox', 'slider', 'spinbutton',
    'switch', 'textbox',
  ]);
  const publicMenuRoles = new Set(['listbox', 'menu', 'option']);
  type SourceRoleKind = 'private' | 'activation' | 'public-menu';

  const pageUrl = (): string => {
    try {
      const url = new URL(window.location.href);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().slice(0, 2_048);
    } catch {
      return window.location.origin;
    }
  };
  const safeImage = (value: string): boolean => {
    if (!value || value.length > maxImageUrlLength) return false;
    try {
      const url = new URL(value, document.baseURI);
      return (
        url.protocol === 'http:' ||
        url.protocol === 'https:' ||
        /^data:image\/(?:avif|gif|jpeg|png|webp);/iu.test(value)
      );
    } catch {
      return false;
    }
  };
  const safeBackground = (value: string): boolean => {
    if (/(?:javascript:|image-set|cross-fade|element)\s*\(/iu.test(value)) {
      return false;
    }
    for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
      if (!match[1] || !safeImage(match[1])) return false;
    }
    return true;
  };
  const composedChildren = (element: Element): Node[] => {
    if (
      element.tagName === 'SLOT' &&
      'assignedNodes' in element &&
      typeof element.assignedNodes === 'function'
    ) {
      const assigned = element.assignedNodes({ flatten: true });
      return assigned.length > 0 ? assigned : [...element.childNodes];
    }
    return element.shadowRoot
      ? [...element.shadowRoot.childNodes]
      : [...element.childNodes];
  };
  const hidden = (element: Element): boolean => {
    if (element.hasAttribute('hidden')) return true;
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    ) return true;
    if (element.tagName !== 'SELECT') return false;
    const value = (property: string): string => {
      try {
        return style.getPropertyValue(property).trim().toLowerCase();
      } catch {
        return '';
      }
    };
    const pixels = (property: string): number | undefined => {
      const match = /^(-?\d+(?:\.\d+)?)px$/u.exec(value(property));
      if (!match) return undefined;
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const overflow = `${value('overflow')} ${value('overflow-x')} ${
      value('overflow-y')
    }`;
    const width = pixels('width');
    const height = pixels('height');
    const position = value('position');
    const left = pixels('left');
    const top = pixels('top');
    const positionedOffscreen = (position === 'absolute' || position === 'fixed') &&
      (
        (left !== undefined && width !== undefined && left + width <= 0) ||
        (top !== undefined && height !== undefined && top + height <= 0)
      );
    const transform = value('transform');
    let collapsedTransform = false;
    if (transform && transform !== 'none') {
      try {
        const rect = element.getBoundingClientRect();
        collapsedTransform = rect.width <= 0 || rect.height <= 0;
      } catch {
        collapsedTransform = /(?:scale(?:3d|x|y)?\([^)]*\b0(?:[),]|\s))/u
          .test(transform);
      }
    }
    return value('content-visibility') === 'hidden' ||
      positionedOffscreen ||
      collapsedTransform ||
      (/(?:^|\s)(?:hidden|clip)(?:\s|$)/u.test(overflow) &&
        (width === 0 || height === 0));
  };
  const readStyle = (
    element: Element,
    includePassiveImages = true,
  ): Record<string, string> => {
    const computed = window.getComputedStyle(element);
    const style: Record<string, string> = {};
    for (const property of styleProperties) {
      const value = computed.getPropertyValue(property).trim();
      if (!value || value.length > 500) continue;
      if (
        property === 'background-image' &&
        (!includePassiveImages || !safeBackground(value))
      ) continue;
      const characters = property.length + value.length;
      if (styleCharacters + characters > maxStyleCharacters) {
        desynchronized = true;
        break;
      }
      style[property] = value;
      styleCharacters += characters;
    }
    return style;
  };
  const hasPrivateContentEditableState = (element: Element): boolean => {
    const value = element.getAttribute('contenteditable');
    return value !== null && value.trim().toLowerCase() !== 'false';
  };
  const roleTokens = (element: Element): string[] =>
    element.getAttribute('role')?.trim().toLowerCase().split(/\s+/u) ?? [];
  const roleKind = (element: Element): SourceRoleKind | undefined => {
    for (const role of roleTokens(element)) {
      if (privateRoles.has(role)) return 'private';
      if (publicRoles.has(role)) return 'activation';
      if (publicMenuRoles.has(role)) return 'public-menu';
    }
    return undefined;
  };
  const composedParent = (element: Element): Element | null => {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot
      ? root.host
      : null;
  };
  const isActivationElement = (element: Element): boolean =>
    element instanceof HTMLButtonElement ||
    roleKind(element) === 'activation';
  const hasPrivateOrActivationAncestor = (element: Element): boolean => {
    let ancestor = composedParent(element);
    for (let depth = 0; ancestor && depth < 128; depth += 1) {
      if (
        isActivationElement(ancestor) ||
        hasPrivateContentEditableState(ancestor) ||
        roleKind(ancestor) === 'private'
      ) return true;
      ancestor = composedParent(ancestor);
    }
    return ancestor !== null;
  };
  const shellFor = (element: Element): VisualControlShell | undefined => {
    if (['DATALIST', 'OPTION', 'OPTGROUP', 'OUTPUT'].includes(element.tagName)) {
      return 'input';
    }
    if (
      element instanceof HTMLInputElement ||
      hasPrivateContentEditableState(element)
    ) return 'input';
    if (element instanceof HTMLTextAreaElement) return 'textarea';
    if (element instanceof HTMLSelectElement) {
      return ['private', 'activation'].includes(roleKind(element) ?? '') ||
        hasPrivateOrActivationAncestor(element)
        ? 'input'
        : 'select';
    }
    if (element instanceof HTMLButtonElement) return 'button';
    if (roleKind(element) === 'private') return 'input';
    return roleKind(element) === 'activation' ? 'button' : undefined;
  };
  const visualTag = (element: Element): string => {
    const candidate = element.tagName.toLowerCase();
    if (safeTags.has(candidate)) return candidate;
    return window.getComputedStyle(element).display.startsWith('inline')
      ? 'span'
      : 'div';
  };
  const attributesFor = (
    element: Element,
    tag: string,
    omitResources = false,
  ): Record<string, string> | undefined => {
    const attributes: Record<string, string> = {};
    const addAttribute = (
      name: string,
      value: string,
      imageUrl = false,
    ): void => {
      const characters = name.length + value.length;
      if (
        attributeCharacters + characters > maxAttributeCharacters ||
        (imageUrl && imageUrlCharacters + value.length > maxImageUrlCharacters)
      ) {
        desynchronized = true;
        return;
      }
      attributes[name] = value;
      attributeCharacters += characters;
      if (imageUrl) imageUrlCharacters += value.length;
    };
    if (!omitResources && tag === 'img' && element instanceof HTMLImageElement) {
      const src = element.currentSrc || element.src;
      if (safeImage(src)) addAttribute('src', src, true);
      else if (src.length > maxImageUrlLength) desynchronized = true;
      const alt = element.getAttribute('alt')?.replace(/\s+/gu, ' ').trim();
      if (alt) addAttribute('alt', alt.slice(0, 2_048));
    }
    const safeNames = [
      'colspan', 'cx', 'cy', 'd', 'fill', 'height', 'points', 'r', 'rowspan',
      'rx', 'ry', 'start', 'stroke', 'stroke-linecap', 'stroke-linejoin',
      'stroke-width', 'transform', 'viewBox', 'width', 'x', 'x1', 'x2', 'y',
      'y1', 'y2',
    ];
    if (tag === 'details' && element.hasAttribute('open')) {
      addAttribute('open', '');
    }
    for (const name of safeNames) {
      const value = element.getAttribute(name);
      if (
        value &&
        value.length <= 2_048 &&
        !/(?:javascript:|data:|url\s*\()/iu.test(value) &&
        (!omitResources || !/(?:https?:|blob:)/iu.test(value))
      ) {
        addAttribute(name, value);
      }
    }
    return Object.keys(attributes).length > 0 ? attributes : undefined;
  };
  const containsText = (nodes: LiveVisualNode[]): boolean =>
    nodes.some((node) =>
      node.kind === 'text'
        ? node.text.trim().length > 0
        : node.kind === 'element' && containsText(node.children),
    );
  const publicControlLabel = (element: Element): string =>
    (element.getAttribute('aria-label') || element.getAttribute('title') || '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 2_048);
  const placeholder = (element: Element): string | undefined => {
    if (element instanceof HTMLIFrameElement) return 'Embedded frame omitted';
    if (element instanceof HTMLCanvasElement) return 'Canvas content omitted';
    if (element instanceof HTMLVideoElement) return 'Video content omitted';
    if (element instanceof HTMLAudioElement) return 'Audio content omitted';
    return undefined;
  };
  const currentBooleanProperty = (
    element: Element,
    property: 'disabled' | 'multiple' | 'selected',
  ): boolean => {
    const value = (element as unknown as Record<string, unknown>)[property];
    return typeof value === 'boolean' ? value : element.hasAttribute(property);
  };
  const selectPickerIsOpen = (element: Element): boolean => {
    try {
      return element.matches(':open');
    } catch {
      return false;
    }
  };
  const selectElementIsHidden = (element: Element): boolean => {
    if (element.hasAttribute('hidden')) return true;
    try {
      const style = window.getComputedStyle(element);
      return style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0' ||
        style.getPropertyValue('content-visibility').trim() === 'hidden';
    } catch {
      return true;
    }
  };
  const directOptgroupLegend = (element: Element): Element | undefined => {
    let inspected = 0;
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
      inspected += 1;
      if (inspected > 512) {
        desynchronized = true;
        return undefined;
      }
      if (child.tagName === 'LEGEND') return child;
    }
    return undefined;
  };
  const selectEntryLabel = (element: Element): string => {
    const rawAttributeLabel = element.getAttribute('label');
    const hasAuthoritativeAttributeLabel = rawAttributeLabel !== null &&
      rawAttributeLabel !== '';
    const attributeLabel = rawAttributeLabel?.trim() ?? '';
    const legend = element.tagName === 'OPTGROUP'
      ? directOptgroupLegend(element)
      : undefined;
    if (!legend && hasAuthoritativeAttributeLabel) {
      return attributeLabel.slice(0, 3_500).replace(/\s+/gu, ' ').trim();
    }
    if (element.tagName === 'OPTGROUP' && !legend) return '';
    const textRoot = legend ?? element;
    let source = '';
    let inspected = 0;
    let current: Node | null = textRoot.firstChild;
    while (current) {
      inspected += 1;
      if (inspected > 1_024) break;
      if (
        current.nodeType === Node.ELEMENT_NODE &&
        selectElementIsHidden(current as Element)
      ) {
        while (current && current !== textRoot && !current.nextSibling) {
          current = current.parentNode;
        }
        if (!current || current === textRoot) break;
        current = current.nextSibling;
        continue;
      }
      if (current.nodeType === Node.TEXT_NODE) {
        const value = current.textContent ?? '';
        const remaining = Math.max(0, 3_501 - source.length);
        source += value.slice(0, remaining);
        if (value.length > remaining || source.length > 3_500) break;
      }
      if (current.firstChild) {
        current = current.firstChild;
        continue;
      }
      while (current && current !== textRoot && !current.nextSibling) {
        current = current.parentNode;
      }
      if (!current || current === textRoot) break;
      current = current.nextSibling;
    }
    return source.slice(0, 3_500).replace(/\s+/gu, ' ').trim();
  };
  const selectElementHasPrivateState = (candidate: Element): boolean => {
      return hasPrivateContentEditableState(candidate) ||
        ['private', 'activation'].includes(roleKind(candidate) ?? '') ||
        [
          'INPUT', 'TEXTAREA', 'SELECT', 'DATALIST', 'OUTPUT', 'BUTTON', 'FORM',
          'EMBED', 'FRAME', 'IFRAME', 'NOSCRIPT', 'OBJECT', 'PORTAL',
          'SCRIPT', 'STYLE', 'TEMPLATE', 'WEBVIEW',
        ]
          .includes(candidate.tagName);
  };

  const selectEntryIsPrivate = (element: Element): boolean => {
    if (selectElementIsHidden(element)) return true;
    if (selectElementHasPrivateState(element)) return true;
    const privacyRoot = element.tagName === 'OPTION'
      ? element
      : element.tagName === 'OPTGROUP'
        ? directOptgroupLegend(element)
        : undefined;
    if (!privacyRoot) return false;
    if (
      privacyRoot !== element &&
      (selectElementIsHidden(privacyRoot) ||
        selectElementHasPrivateState(privacyRoot))
    ) return true;
    const pending: Element[] = [];
    for (
      let child = privacyRoot.firstElementChild;
      child;
      child = child.nextElementSibling
    ) {
      if (pending.length >= 512) return true;
      pending.push(child);
    }
    let inspected = 0;
    while (pending.length > 0) {
      const candidate = pending.pop();
      if (!candidate) continue;
      inspected += 1;
      // Customizable option content is expected to be shallow. Fail closed
      // instead of performing an unbounded privacy walk on hostile markup.
      if (inspected > 512) return true;
      if (selectElementIsHidden(candidate)) continue;
      if (selectElementHasPrivateState(candidate)) return true;
      for (
        let child = candidate.firstElementChild;
        child;
        child = child.nextElementSibling
      ) {
        if (inspected + pending.length >= 512) return true;
        pending.push(child);
      }
    }
    return false;
  };
  const buildSelectLabelNode = (
    label: string,
    owner: Element,
  ): LiveVisualTextNode | undefined => {
    if (!label) return undefined;
    if (!registry || nodeCount >= 6_000) {
      desynchronized = true;
      return undefined;
    }
    const remaining = 150_000 - textCharacters;
    if (remaining <= 0) {
      desynchronized = true;
      return undefined;
    }
    const text = label.slice(0, remaining);
    if (text.length < label.length) desynchronized = true;
    textCharacters += text.length;
    nodeCount += 1;
    return {
      kind: 'text',
      nodeId: registry.idFor(owner),
      text,
    };
  };
  const buildNativeSelectEntry = (
    element: Element,
    depth: number,
  ): LiveVisualElementNode | undefined => {
    if (
      !registry ||
      desynchronized ||
      nodeCount >= 6_000 ||
      depth > 80 ||
      (element.tagName !== 'OPTION' && element.tagName !== 'OPTGROUP')
    ) {
      desynchronized = true;
      return undefined;
    }
    if (selectElementIsHidden(element)) return undefined;
    nodeCount += 1;
    const nodeId = registry.idFor(element);
    // Option labels/state are typed presentation data. Source resource URLs
    // are not part of that release and must not hitchhike through CSS.
    const style = readStyle(element, false);
    const privateEntry = selectEntryIsPrivate(element);
    const children: LiveVisualNode[] = [];
    const label = privateEntry
      ? undefined
      : buildSelectLabelNode(selectEntryLabel(element), element);
    if (label) children.push(label);

    if (element.tagName === 'OPTGROUP') {
      if (selectElementHasPrivateState(element)) {
        return {
          kind: 'element',
          nodeId,
          tag: 'optgroup',
          style,
          optgroupState: { disabled: true },
          children,
        };
      }
      let inspectedChildren = 0;
      for (
        let child = element.firstElementChild;
        child;
        child = child.nextElementSibling
      ) {
        inspectedChildren += 1;
        if (inspectedChildren > 6_000) {
          desynchronized = true;
          break;
        }
        if (child.tagName !== 'OPTION') continue;
        const option = buildNativeSelectEntry(child, depth + 1);
        if (option) children.push(option);
        if (desynchronized || nodeCount >= 6_000) break;
      }
      return {
        kind: 'element',
        nodeId,
        tag: 'optgroup',
        style,
        optgroupState: {
          disabled: currentBooleanProperty(element, 'disabled'),
        },
        children,
      };
    }

    return {
      kind: 'element',
      nodeId,
      tag: 'option',
      style,
      optionState: {
        disabled: currentBooleanProperty(element, 'disabled'),
        selected: !privateEntry && currentBooleanProperty(element, 'selected'),
      },
      children,
    };
  };
  const build = (
    node: Node,
    depth: number,
    publicMenuRegion = false,
  ): LiveVisualNode | undefined => {
    if (!registry || desynchronized || nodeCount >= 6_000 || depth > 80) {
      desynchronized = true;
      return undefined;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? '';
      if (!raw) return undefined;
      const remaining = 150_000 - textCharacters;
      if (remaining <= 0) {
        desynchronized = true;
        return undefined;
      }
      const text = raw.slice(0, remaining);
      if (text.length < raw.length) desynchronized = true;
      textCharacters += text.length;
      nodeCount += 1;
      return { kind: 'text', nodeId: registry.idFor(node), text };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
    const element = node as Element;
    const transportedPublicMenuRegion =
      publicMenuRegion || roleKind(element) === 'public-menu';
    if (['BASE', 'HEAD', 'LINK', 'META', 'NOSCRIPT', 'OBJECT', 'SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE'].includes(element.tagName)) {
      return undefined;
    }
    if (hidden(element)) return undefined;
    if (
      transportedPublicMenuRegion &&
      ['AUDIO', 'CANVAS', 'IMG', 'PICTURE', 'SOURCE', 'VIDEO']
        .includes(element.tagName)
    ) return undefined;
    nodeCount += 1;
    const nodeId = registry.idFor(element);
    const shell = shellFor(element);
    const style = readStyle(
      element,
      shell !== 'select' && !transportedPublicMenuRegion,
    );
    const label = placeholder(element);
    if (label) return { kind: 'placeholder', nodeId, style, label };
    const tag = ['SELECT', 'OPTION', 'OPTGROUP'].includes(element.tagName) &&
      shell !== 'select'
      ? window.getComputedStyle(element).display.startsWith('inline')
        ? 'span'
        : 'div'
      : visualTag(element);
    const children: LiveVisualNode[] = [];
    if (shell === 'select') {
      let inspectedChildren = 0;
      for (
        let child = element.firstElementChild;
        child;
        child = child.nextElementSibling
      ) {
        inspectedChildren += 1;
        if (inspectedChildren > 6_000) {
          desynchronized = true;
          break;
        }
        if (!['OPTION', 'OPTGROUP'].includes(child.tagName)) continue;
        const entry = buildNativeSelectEntry(child, depth + 1);
        if (entry) children.push(entry);
        if (desynchronized || nodeCount >= 6_000) break;
      }
    } else if (!shell || shell === 'button') {
      for (const child of composedChildren(element)) {
        const built = build(child, depth + 1, transportedPublicMenuRegion);
        if (built) children.push(built);
        if (desynchronized) break;
      }
      if (shell === 'button' && !containsText(children)) {
        const label = publicControlLabel(element);
        if (label) {
          if (textCharacters + label.length > 150_000 || nodeCount >= 6_000) {
            desynchronized = true;
          } else {
            textCharacters += label.length;
            nodeCount += 1;
            children.push({
              kind: 'text',
              nodeId: registry.idFor(element),
              text: label,
            });
          }
        }
      }
    }
    return {
      kind: 'element',
      nodeId,
      tag,
      style,
      ...(shell ? { controlShell: shell } : {}),
      ...(shell === 'select'
        ? {
            selectState: {
              disabled: currentBooleanProperty(element, 'disabled'),
              multiple: currentBooleanProperty(element, 'multiple'),
              open: selectPickerIsOpen(element),
            },
          }
        : {}),
      ...(!shell
        ? {
            attributes: attributesFor(
              element,
              tag,
              transportedPublicMenuRegion,
            ),
          }
        : {}),
      children,
    };
  };

  const replacements: LivePageReplacement[] = [];
  const uniqueIds = [...new Set(requestedNodeIds)].slice(0, 48);
  for (const targetId of uniqueIds) {
    if (!registry || !/^n[1-9]\d{0,8}$/u.test(targetId)) {
      desynchronized = true;
      continue;
    }
    const target = registry.nodes.get(targetId);
    if (!target || !target.isConnected) {
      desynchronized = true;
      continue;
    }
    const node = build(target, 0) ?? null;
    replacements.push({ targetId, node });
    if (desynchronized) break;
  }
  const root = document.documentElement;
  const dimension = (value: number): number =>
    Math.min(100_000, Math.max(1, Number.isFinite(value) ? Math.round(value) : 1));
  const documentLanguage = document.documentElement.lang
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 35);
  return {
    version: 1,
    generation,
    sequence,
    url: pageUrl(),
    ...(documentLanguage ? { documentLanguage } : {}),
    documentWidth: dimension(Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0)),
    documentHeight: dimension(Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0)),
    desynchronized,
    replacements,
  };
}

export function readLivePageDirtyMessage(
  input: unknown,
): LivePageDirtyMessage | undefined {
  if (!isRecord(input) || input.type !== 'simul:page-dirty' || input.version !== 1) {
    return undefined;
  }
  if (
    !isSafeInteger(input.generation) ||
    typeof input.sessionId !== 'string' ||
    !SESSION_ID_PATTERN.test(input.sessionId) ||
    !isSafeInteger(input.sequence) ||
    typeof input.url !== 'string' ||
    !isHttpUrl(input.url) ||
    !Array.isArray(input.nodeIds) ||
    input.nodeIds.length > MAX_DIRTY_IDS
  ) return undefined;
  const nodeIds = input.nodeIds.filter(
    (value): value is string => typeof value === 'string' && NODE_ID_PATTERN.test(value),
  );
  if (nodeIds.length !== input.nodeIds.length) return undefined;
  return {
    type: input.type,
    version: 1,
    generation: input.generation,
    sessionId: input.sessionId,
    sequence: input.sequence,
    url: normalizeHttpUrl(input.url),
    nodeIds: [...new Set(nodeIds)],
  };
}

export function readLivePageObserverInstallation(
  input: unknown,
): LivePageObserverInstallation | undefined {
  if (
    !isRecord(input) ||
    !isSafeInteger(input.generation) ||
    !isSafeInteger(input.sequence)
  ) return undefined;
  if (input.installed === false && input.reason === 'session-limit') {
    return {
      installed: false,
      generation: input.generation,
      sequence: input.sequence,
      reason: 'session-limit',
    };
  }
  if (input.installed !== true) return undefined;
  return {
    installed: true,
    generation: input.generation,
    sequence: input.sequence,
  };
}

export function readLivePageScrollMessage(
  input: unknown,
): LivePageScrollMessage | undefined {
  if (!isRecord(input) || input.type !== 'simul:page-scroll' || input.version !== 1) {
    return undefined;
  }
  if (
    !isSafeInteger(input.generation) ||
    typeof input.sessionId !== 'string' ||
    !SESSION_ID_PATTERN.test(input.sessionId) ||
    typeof input.url !== 'string' ||
    !isHttpUrl(input.url) ||
    (
      input.scrollTarget !== undefined &&
      input.scrollTarget !== 'document' && input.scrollTarget !== 'nested'
    )
  ) return undefined;
  if (
    input.nestedOwnerKey !== undefined &&
    (
      input.scrollTarget !== 'nested' ||
      !Number.isSafeInteger(input.nestedOwnerKey) ||
      Number(input.nestedOwnerKey) < 1 ||
      Number(input.nestedOwnerKey) > 1_000_000_000
    )
  ) return undefined;
  if (
    input.nestedOwnerOrdinal !== undefined &&
    (
      input.scrollTarget !== 'nested' ||
      !Number.isSafeInteger(input.nestedOwnerOrdinal) ||
      Number(input.nestedOwnerOrdinal) < 0 ||
      Number(input.nestedOwnerOrdinal) >= 5_000
    )
  ) return undefined;
  const values = [input.scrollX, input.scrollY, input.maxScrollX, input.maxScrollY];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return undefined;
  }
  const documentValues = [
    input.documentScrollX,
    input.documentScrollY,
    input.documentMaxScrollX,
    input.documentMaxScrollY,
  ];
  const hasDocumentValues = documentValues.some((value) => value !== undefined);
  if (
    hasDocumentValues &&
    documentValues.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value),
    )
  ) return undefined;
  const nested = input.scrollTarget === 'nested';
  const documentScrollX = hasDocumentValues
    ? input.documentScrollX as number
    : nested ? 0 : input.scrollX as number;
  const documentScrollY = hasDocumentValues
    ? input.documentScrollY as number
    : nested ? 0 : input.scrollY as number;
  const documentMaxScrollX = hasDocumentValues
    ? input.documentMaxScrollX as number
    : nested ? 0 : input.maxScrollX as number;
  const documentMaxScrollY = hasDocumentValues
    ? input.documentMaxScrollY as number
    : nested ? 0 : input.maxScrollY as number;
  return {
    type: input.type,
    version: 1,
    generation: input.generation,
    sessionId: input.sessionId,
    url: normalizeHttpUrl(input.url),
    scrollTarget: input.scrollTarget === 'nested' ? 'nested' : 'document',
    scrollX: clampDimension(input.scrollX as number),
    scrollY: clampDimension(input.scrollY as number),
    maxScrollX: clampDimension(input.maxScrollX as number),
    maxScrollY: clampDimension(input.maxScrollY as number),
    ...(input.scrollTarget === 'nested' && input.nestedOwnerKey !== undefined
      ? { nestedOwnerKey: input.nestedOwnerKey as number }
      : {}),
    ...(input.scrollTarget === 'nested' && input.nestedOwnerOrdinal !== undefined
      ? { nestedOwnerOrdinal: input.nestedOwnerOrdinal as number }
      : {}),
    documentScrollX: clampDimension(documentScrollX),
    documentScrollY: clampDimension(documentScrollY),
    documentMaxScrollX: clampDimension(documentMaxScrollX),
    documentMaxScrollY: clampDimension(documentMaxScrollY),
  };
}

export function parseLivePageDelta(input: unknown): LivePageDelta {
  if (!isRecord(input) || input.version !== 1) {
    throw new Error('The page returned an invalid live mirror update.');
  }
  if (
    !isSafeInteger(input.generation) ||
    !isSafeInteger(input.sequence) ||
    typeof input.url !== 'string' ||
    !isHttpUrl(input.url) ||
    typeof input.desynchronized !== 'boolean' ||
    !Array.isArray(input.replacements) ||
    input.replacements.length > MAX_DIRTY_IDS
  ) {
    throw new Error('The page returned an invalid live mirror update.');
  }
  let nodeCount = 0;
  let textCharacters = 0;
  const payloadBudget = {
    styleCharacters: 0,
    attributeCharacters: 0,
    imageUrlCharacters: 0,
  };
  type ParseContext = 'normal' | 'select' | 'optgroup' | 'option';
  const parseNode = (
    raw: unknown,
    depth: number,
    context: ParseContext = 'normal',
  ): LiveVisualNode | undefined => {
    if (!isRecord(raw) || depth > 80 || nodeCount >= MAX_DELTA_NODES) return undefined;
    if (typeof raw.nodeId !== 'string' || !NODE_ID_PATTERN.test(raw.nodeId)) return undefined;
    nodeCount += 1;
    if (raw.kind === 'text') {
      if (typeof raw.text !== 'string' || context === 'select') return undefined;
      const remaining = MAX_DELTA_TEXT - textCharacters;
      if (remaining <= 0 || raw.text.length > remaining) return undefined;
      textCharacters += raw.text.length;
      return { kind: 'text', nodeId: raw.nodeId, text: raw.text };
    }
    const style = parseLiveStyle(raw.style, payloadBudget);
    if (raw.kind === 'placeholder') {
      if (context !== 'normal') return undefined;
      const labels = new Set([
        'Audio content omitted', 'Canvas content omitted',
        'Embedded frame omitted', 'Video content omitted',
      ]);
      if (typeof raw.label !== 'string' || !labels.has(raw.label)) return undefined;
      return { kind: 'placeholder', nodeId: raw.nodeId, style, label: raw.label };
    }
    if (raw.kind !== 'element' || typeof raw.tag !== 'string' || !isSafeLiveTag(raw.tag)) {
      return undefined;
    }
    const isOption = raw.tag === 'option';
    const isOptgroup = raw.tag === 'optgroup';
    if (
      (context === 'normal' && (isOption || isOptgroup)) ||
      (context === 'select' && !isOption && !isOptgroup) ||
      (context === 'optgroup' && !isOption) ||
      context === 'option'
    ) return undefined;
    const controlShell = readLiveControlShell(raw.controlShell);
    if (
      (raw.controlShell !== undefined && !controlShell) ||
      ((isOption || isOptgroup) && controlShell !== undefined) ||
      (controlShell === 'select' && raw.tag !== 'select') ||
      (raw.tag === 'select' && controlShell !== 'select')
    ) return undefined;
    const selectState = controlShell === 'select'
      ? readLiveSelectState(raw.selectState)
      : undefined;
    const optionState = isOption
      ? readLiveOptionState(raw.optionState)
      : undefined;
    const optgroupState = isOptgroup
      ? readLiveOptgroupState(raw.optgroupState)
      : undefined;
    if (
      (controlShell === 'select' && !selectState) ||
      (isOption && !optionState) ||
      (isOptgroup && !optgroupState) ||
      (!Array.isArray(raw.children) &&
        (controlShell === 'select' || isOption || isOptgroup))
    ) return undefined;
    const children: LiveVisualNode[] = [];
    const childContext: ParseContext | undefined = controlShell === 'select'
      ? 'select'
      : isOptgroup
        ? 'optgroup'
        : isOption
          ? 'option'
          : !controlShell || controlShell === 'button'
            ? 'normal'
            : undefined;
    if (childContext && Array.isArray(raw.children)) {
      for (const child of raw.children) {
        const parsed = parseNode(child, depth + 1, childContext);
        if (!parsed) return undefined;
        children.push(parsed);
      }
    }
    if (
      isOption && children.filter((child) => child.kind === 'text').length > 1
    ) return undefined;
    if (isOptgroup) {
      const labelIndexes = children
        .map((child, index) => child.kind === 'text' ? index : -1)
        .filter((index) => index >= 0);
      if (labelIndexes.length > 1 || labelIndexes.some((index) => index !== 0)) {
        return undefined;
      }
    }
    if (
      selectState &&
      !selectState.multiple &&
      countSelectedLiveOptions(children) > 1
    ) return undefined;
    const attributes = controlShell || isOption || isOptgroup
      ? undefined
      : parseLiveAttributes(raw.attributes, raw.tag, payloadBudget);
    return {
      kind: 'element',
      nodeId: raw.nodeId,
      tag: raw.tag,
      style,
      ...(controlShell ? { controlShell } : {}),
      ...(selectState ? { selectState } : {}),
      ...(optionState ? { optionState } : {}),
      ...(optgroupState ? { optgroupState } : {}),
      ...(attributes ? { attributes } : {}),
      children,
    };
  };
  const replacements: LivePageReplacement[] = [];
  for (const rawReplacement of input.replacements) {
    if (
      !isRecord(rawReplacement) ||
      typeof rawReplacement.targetId !== 'string' ||
      !NODE_ID_PATTERN.test(rawReplacement.targetId)
    ) throw new Error('The page returned an invalid live mirror update.');
    if (rawReplacement.node === null) {
      replacements.push({ targetId: rawReplacement.targetId, node: null });
      continue;
    }
    const node = parseNode(rawReplacement.node, 0);
    if (!node || node.nodeId !== rawReplacement.targetId) {
      throw new Error('The page returned an invalid live mirror update.');
    }
    replacements.push({ targetId: rawReplacement.targetId, node });
  }
  const documentLanguage = readLiveDocumentLanguage(input.documentLanguage);
  return {
    version: 1,
    generation: input.generation,
    sequence: input.sequence,
    url: normalizeHttpUrl(input.url),
    ...(documentLanguage ? { documentLanguage } : {}),
    documentWidth: readDimension(input.documentWidth),
    documentHeight: readDimension(input.documentHeight),
    desynchronized: input.desynchronized,
    replacements,
  };
}

function countSelectedLiveOptions(nodes: readonly LiveVisualNode[]): number {
  let selected = 0;
  for (const node of nodes) {
    if (node.kind !== 'element') continue;
    if (node.tag === 'option') {
      if (node.optionState?.selected) selected += 1;
    } else if (node.tag === 'optgroup') {
      selected += countSelectedLiveOptions(node.children);
    }
    if (selected > 1) return selected;
  }
  return selected;
}

interface LivePayloadBudget {
  styleCharacters: number;
  attributeCharacters: number;
  imageUrlCharacters: number;
}

function parseLiveStyle(
  input: unknown,
  budget: LivePayloadBudget,
): VisualStyle {
  if (!isRecord(input)) return {};
  const allowed = new Set<string>(VISUAL_STYLE_PROPERTIES);
  const style: VisualStyle = {};
  for (const [property, value] of Object.entries(input)) {
    if (
      !allowed.has(property) ||
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 500
    ) continue;
    if (property === 'background-image' && !isSafeBackgroundImage(value)) continue;
    const characters = property.length + value.length;
    if (
      budget.styleCharacters + characters >
      MAX_DELTA_STYLE_CHARACTERS
    ) {
      throw new Error('The page returned an oversized live mirror style payload.');
    }
    style[property as keyof VisualStyle] = value;
    budget.styleCharacters += characters;
  }
  return style;
}

function parseLiveAttributes(
  input: unknown,
  tag: string,
  budget: LivePayloadBudget,
): Record<string, string> | undefined {
  if (!isRecord(input)) return undefined;
  const allowed = new Set([
    'alt', 'colspan', 'cx', 'cy', 'd', 'fill', 'height', 'open', 'points',
    'preserveAspectRatio', 'r', 'rowspan', 'rx', 'ry', 'src', 'start', 'stroke',
    'stroke-linecap', 'stroke-linejoin', 'stroke-width', 'transform', 'viewBox',
    'width', 'x', 'x1', 'x2', 'y', 'y1', 'y2',
  ]);
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (
      !allowed.has(name) ||
      typeof value !== 'string' ||
      value.length > (name === 'src' ? 100_000 : 2_048)
    ) continue;
    if (name === 'src' && (tag !== 'img' || !isSafeImageSource(value))) continue;
    if (name === 'alt' && tag !== 'img') continue;
    if (/(?:javascript:|data:(?!image\/)|url\s*\()/iu.test(value)) continue;
    const characters = name.length + value.length;
    if (
      budget.attributeCharacters + characters >
      MAX_DELTA_ATTRIBUTE_CHARACTERS
    ) {
      throw new Error('The page returned an oversized live mirror attribute payload.');
    }
    if (
      name === 'src' &&
      budget.imageUrlCharacters + value.length >
        MAX_DELTA_IMAGE_URL_CHARACTERS
    ) {
      throw new Error('The page returned an oversized live mirror image payload.');
    }
    attributes[name] = value;
    budget.attributeCharacters += characters;
    if (name === 'src') budget.imageUrlCharacters += value.length;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function readLiveDocumentLanguage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256) {
    throw new Error('The page returned an invalid live mirror language.');
  }
  const language = value.replace(/\s+/gu, ' ').trim();
  if (language.length > MAX_DOCUMENT_LANGUAGE_LENGTH) {
    throw new Error('The page returned an invalid live mirror language.');
  }
  return language || undefined;
}

function isSafeLiveTag(value: string): boolean {
  return new Set([
    'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'circle',
    'code', 'col', 'colgroup', 'dd', 'details', 'div', 'dl', 'dt', 'em',
    'ellipse', 'figcaption', 'figure', 'footer', 'g', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'header', 'hr', 'i', 'img', 'label', 'li', 'line', 'main',
    'mark', 'nav', 'ol', 'optgroup', 'option', 'p', 'path', 'picture',
    'polygon', 'polyline', 'pre', 'rect', 'section', 'select', 'small', 'source',
    'span', 'strong', 'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
  ]).has(value);
}

function readLiveControlShell(value: unknown): VisualControlShell | undefined {
  return value === 'button' || value === 'input' || value === 'select' || value === 'textarea'
    ? value
    : undefined;
}

function readLiveSelectState(value: unknown): VisualSelectState | undefined {
  if (
    !isRecord(value) ||
    typeof value.disabled !== 'boolean' ||
    typeof value.multiple !== 'boolean' ||
    typeof value.open !== 'boolean'
  ) return undefined;
  return {
    disabled: value.disabled,
    multiple: value.multiple,
    open: value.open,
  };
}

function readLiveOptionState(value: unknown): VisualOptionState | undefined {
  if (
    !isRecord(value) ||
    typeof value.disabled !== 'boolean' ||
    typeof value.selected !== 'boolean'
  ) return undefined;
  return { disabled: value.disabled, selected: value.selected };
}

function readLiveOptgroupState(
  value: unknown,
): VisualOptgroupState | undefined {
  if (!isRecord(value) || typeof value.disabled !== 'boolean') return undefined;
  return { disabled: value.disabled };
}

function isSafeBackgroundImage(value: string): boolean {
  if (/(?:javascript:|image-set|cross-fade|element)\s*\(/iu.test(value)) return false;
  for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    if (!match[1] || !isSafeImageSource(match[1])) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().slice(0, 2_048);
}

function readDimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('The page returned an invalid live mirror dimension.');
  }
  return Math.min(100_000, Math.max(1, Math.round(value)));
}

function clampDimension(value: number): number {
  return Math.min(100_000, Math.max(0, value));
}
