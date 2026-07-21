import {
  VISUAL_STYLE_PROPERTIES,
  isSafeImageSource,
  type VisualControlShell,
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

/**
 * Install one mutation/scroll bridge in the extension's isolated world. It
 * never annotates or otherwise changes the source DOM.
 */
export function installLivePageObserver(
  sessionId: string,
  generation: number,
): LivePageObserverInstallation {
  type Registry = {
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

  const idFor = (node: Node): string => {
    const existing = nodeIds.get(node);
    if (existing) return existing;
    const id = `n${nextNodeId}`;
    nextNodeId += 1;
    nodeIds.set(node, id);
    nodes.set(id, node);
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
    if (
      current &&
      (current instanceof HTMLInputElement ||
        current instanceof HTMLTextAreaElement ||
        current instanceof HTMLSelectElement ||
        current.hasAttribute('contenteditable'))
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
        root.removeEventListener('scroll', onScroll, true);
      }
      if (flushTimer !== undefined) clearTimeout(flushTimer);
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
    'main', 'mark', 'nav', 'ol', 'p', 'path', 'picture', 'polygon',
    'polyline', 'pre', 'rect', 'section', 'small', 'source', 'span', 'strong',
    'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'tr', 'u', 'ul',
  ]);
  const publicRoles = new Set([
    'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem',
  ]);
  const privateRoles = new Set([
    'checkbox', 'combobox', 'listbox', 'option', 'radio', 'searchbox', 'slider',
    'spinbutton', 'switch', 'textbox',
  ]);

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
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    );
  };
  const readStyle = (element: Element): Record<string, string> => {
    const computed = window.getComputedStyle(element);
    const style: Record<string, string> = {};
    for (const property of styleProperties) {
      const value = computed.getPropertyValue(property).trim();
      if (!value || value.length > 500) continue;
      if (property === 'background-image' && !safeBackground(value)) continue;
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
  const shellFor = (element: Element): VisualControlShell | undefined => {
    if (['DATALIST', 'OPTION', 'OPTGROUP', 'OUTPUT'].includes(element.tagName)) {
      return 'input';
    }
    if (
      element instanceof HTMLInputElement ||
      element.hasAttribute('contenteditable')
    ) return 'input';
    if (element instanceof HTMLTextAreaElement) return 'textarea';
    if (element instanceof HTMLSelectElement) return 'select';
    if (element instanceof HTMLButtonElement) return 'button';
    const roles = element.getAttribute('role')?.trim().toLowerCase().split(/\s+/u) ?? [];
    if (roles.some((role) => privateRoles.has(role))) return 'input';
    return roles.some((role) => publicRoles.has(role)) ? 'button' : undefined;
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
    if (tag === 'img' && element instanceof HTMLImageElement) {
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
      if (value && value.length <= 2_048 && !/(?:javascript:|data:|url\s*\()/iu.test(value)) {
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
  const build = (node: Node, depth: number): LiveVisualNode | undefined => {
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
    if (['BASE', 'HEAD', 'LINK', 'META', 'NOSCRIPT', 'OBJECT', 'SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE'].includes(element.tagName)) {
      return undefined;
    }
    if (hidden(element)) return undefined;
    nodeCount += 1;
    const nodeId = registry.idFor(element);
    const style = readStyle(element);
    const label = placeholder(element);
    if (label) return { kind: 'placeholder', nodeId, style, label };
    const shell = shellFor(element);
    const tag = visualTag(element);
    const children: LiveVisualNode[] = [];
    if (!shell || shell === 'button') {
      for (const child of composedChildren(element)) {
        const built = build(child, depth + 1);
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
      ...(!shell ? { attributes: attributesFor(element, tag) } : {}),
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
  const parseNode = (raw: unknown, depth: number): LiveVisualNode | undefined => {
    if (!isRecord(raw) || depth > 80 || nodeCount >= MAX_DELTA_NODES) return undefined;
    if (typeof raw.nodeId !== 'string' || !NODE_ID_PATTERN.test(raw.nodeId)) return undefined;
    nodeCount += 1;
    if (raw.kind === 'text') {
      if (typeof raw.text !== 'string') return undefined;
      const remaining = MAX_DELTA_TEXT - textCharacters;
      if (remaining <= 0 || raw.text.length > remaining) return undefined;
      textCharacters += raw.text.length;
      return { kind: 'text', nodeId: raw.nodeId, text: raw.text };
    }
    const style = parseLiveStyle(raw.style, payloadBudget);
    if (raw.kind === 'placeholder') {
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
    const controlShell = readLiveControlShell(raw.controlShell);
    const children: LiveVisualNode[] = [];
    if ((!controlShell || controlShell === 'button') && Array.isArray(raw.children)) {
      for (const child of raw.children) {
        const parsed = parseNode(child, depth + 1);
        if (!parsed) return undefined;
        children.push(parsed);
      }
    }
    const attributes = controlShell
      ? undefined
      : parseLiveAttributes(raw.attributes, raw.tag, payloadBudget);
    return {
      kind: 'element',
      nodeId: raw.nodeId,
      tag: raw.tag,
      style,
      ...(controlShell ? { controlShell } : {}),
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
    'mark', 'nav', 'ol', 'p', 'path', 'picture', 'polygon', 'polyline', 'pre',
    'rect', 'section', 'small', 'source', 'span', 'strong', 'sub', 'summary',
    'sup', 'svg', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
  ]).has(value);
}

function readLiveControlShell(value: unknown): VisualControlShell | undefined {
  return value === 'button' || value === 'input' || value === 'select' || value === 'textarea'
    ? value
    : undefined;
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
