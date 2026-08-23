export type ReplicaDisclosurePresentation = 'list' | 'popup';

export interface ReplicaDisclosurePlacementInput {
  readonly anchor: Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'>;
  readonly panelHeight: number;
  readonly panelWidth: number;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  readonly gap?: number;
  readonly margin?: number;
}

export interface ReplicaDisclosurePlacement {
  readonly left: number;
  readonly maxHeight: number;
  readonly maxWidth: number;
  readonly minWidth: number;
  readonly placement: 'above' | 'below';
  readonly top: number;
}

export interface ReadOnlyReplicaDisclosureOptions {
  readonly anchor: HTMLElement;
  /**
   * Updates aria-expanded only for an extension-created trigger. Source ARIA
   * state must remain an authored replica value, separate from preview state.
   */
  readonly manageTriggerExpanded?: boolean;
  readonly panel: HTMLElement;
  readonly presentation: ReplicaDisclosurePresentation;
  readonly trigger?: HTMLElement;
  readonly initiallyOpen?: boolean;
  readonly visibleRows?: number;
}

export interface ReadOnlyReplicaDisclosure {
  readonly presentation: ReplicaDisclosurePresentation;
  close(): void;
  dispose(): void;
  isAnchoredWithin(root: Node): boolean;
  isOpen(): boolean;
  open(): void;
  sync(): void;
}

const DISCLOSURE_MARKER = 'v1';
const MIN_POPUP_HEIGHT = 48;
const DEFAULT_POPUP_HEIGHT = 320;
const PANEL_ATTRIBUTES = Object.freeze([
  'data-simul-replica-disclosure-overlay',
  'data-simul-replica-disclosure-panel',
  'data-simul-replica-disclosure-placement',
  'hidden',
  'popover',
]);
const TRIGGER_PREVIEW_EVENTS = new Set([
  'click', 'focusin', 'focusout', 'keydown', 'pointerdown', 'pointerenter',
  'pointerleave',
]);
const PANEL_PREVIEW_EVENTS = new Set([
  'auxclick',
  'click',
  'contextmenu',
  'dblclick',
  'focusin',
  'focusout',
  'keydown',
  'pointerdown',
  'pointerenter',
  'pointerleave',
  'scroll',
  'wheel',
]);
const DISCLOSURE_LEAVE_GRACE_MS = 100;
const MAX_DISCLOSURE_FOCUS_CANDIDATES = 256;
const DISCLOSURE_FOCUS_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[tabindex]',
].join(',');
const KEYBOARD_ACTIVATION_ROLES = new Set([
  'button',
  'checkbox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'switch',
  'tab',
]);
const OWNED_DISCLOSURE_TRIGGERS = new WeakSet<object>();
const OWNED_DISCLOSURE_PANELS = new WeakSet<object>();

interface DocumentDisclosureState {
  readonly controllers: Set<ReplicaDisclosureController>;
  readonly dispose: () => void;
}

const DOCUMENT_DISCLOSURES = new WeakMap<Document, DocumentDisclosureState>();

/**
 * Computes a viewport-clamped popup position without depending on DOM state.
 * The result flips above the trigger only when that side has more usable room.
 */
export function computeReplicaDisclosurePlacement(
  input: ReplicaDisclosurePlacementInput,
): ReplicaDisclosurePlacement {
  const finite = (value: number, fallback = 0): number =>
    Number.isFinite(value) ? value : fallback;
  const viewportWidth = Math.max(1, finite(input.viewportWidth, 1));
  const viewportHeight = Math.max(1, finite(input.viewportHeight, 1));
  const margin = Math.min(
    Math.max(0, finite(input.margin ?? 8)),
    Math.max(0, Math.min(viewportWidth, viewportHeight) / 2),
  );
  const gap = Math.max(0, finite(input.gap ?? 4));
  const anchorLeft = finite(input.anchor.left);
  const anchorTop = finite(input.anchor.top);
  const anchorRight = finite(
    input.anchor.right,
    anchorLeft + Math.max(0, finite(input.anchor.width)),
  );
  const anchorBottom = finite(
    input.anchor.bottom,
    anchorTop + Math.max(0, finite(input.anchor.height)),
  );
  const anchorWidth = Math.max(
    1,
    finite(input.anchor.width, anchorRight - anchorLeft),
  );
  const maxWidth = Math.max(1, viewportWidth - margin * 2);
  const minWidth = Math.min(anchorWidth, maxWidth);
  const requestedWidth = Math.max(
    minWidth,
    Math.max(1, finite(input.panelWidth, anchorWidth)),
  );
  const panelWidth = Math.min(requestedWidth, maxWidth);
  const requestedHeight = Math.max(
    MIN_POPUP_HEIGHT,
    finite(input.panelHeight, DEFAULT_POPUP_HEIGHT),
  );
  const below = Math.max(0, viewportHeight - margin - anchorBottom - gap);
  const above = Math.max(0, anchorTop - margin - gap);
  const placement = below >= Math.min(requestedHeight, MIN_POPUP_HEIGHT) ||
      below >= above
    ? 'below'
    : 'above';
  const availableHeight = Math.max(
    1,
    placement === 'below' ? below : above,
  );
  const maxHeight = Math.min(
    Math.max(1, viewportHeight - margin * 2),
    availableHeight,
  );
  const renderedHeight = Math.min(requestedHeight, maxHeight);
  const unclampedTop = placement === 'below'
    ? anchorBottom + gap
    : anchorTop - gap - renderedHeight;
  const top = clamp(
    unclampedTop,
    margin,
    Math.max(margin, viewportHeight - margin - renderedHeight),
  );
  const left = clamp(
    anchorLeft,
    margin,
    Math.max(margin, viewportWidth - margin - panelWidth),
  );
  return Object.freeze({
    left,
    maxHeight,
    maxWidth,
    minWidth,
    placement,
    top,
  });
}

/**
 * Installs extension-owned disclosure behavior. It never changes selection or
 * dispatches an event to a source document; its only mutable state lives in
 * the local replica DOM.
 */
export function installReadOnlyReplicaDisclosure(
  options: ReadOnlyReplicaDisclosureOptions,
): ReadOnlyReplicaDisclosure {
  if (
    options.presentation === 'popup' &&
    (!options.trigger || options.trigger.ownerDocument !== options.anchor.ownerDocument)
  ) {
    throw new Error('A popup disclosure requires a same-document trigger.');
  }
  if (options.panel.ownerDocument !== options.anchor.ownerDocument) {
    throw new Error('A replica disclosure must remain in one document.');
  }
  const controller = new ReplicaDisclosureController(options);
  registerController(controller);
  return controller;
}

export function closeReadOnlyReplicaDisclosures(document: Document): void {
  for (const controller of DOCUMENT_DISCLOSURES.get(document)?.controllers ?? []) {
    controller.close();
  }
}

/** Capture reader-owned preview state before a live patch restores the DOM. */
export function snapshotOpenReadOnlyReplicaDisclosures(
  document: Document,
): ReadonlySet<HTMLElement> {
  const anchors = new Set<HTMLElement>();
  for (const controller of DOCUMENT_DISCLOSURES.get(document)?.controllers ?? []) {
    if (controller.isOpen()) anchors.add(controller.anchor);
  }
  return anchors;
}

export function disposeReadOnlyReplicaDisclosures(document: Document): void {
  const state = DOCUMENT_DISCLOSURES.get(document);
  if (!state) return;
  for (const controller of [...state.controllers]) controller.dispose();
}

/**
 * True only for the small event/surface combinations owned by the local
 * preview controller. Markers never authorize source input/change/form events.
 */
export function isReadOnlyReplicaDisclosureEvent(event: Event): boolean {
  const path = disclosureEventPath(event);
  return path.some((candidate) => {
    if (isOwnedDisclosureSurface(
      candidate,
      OWNED_DISCLOSURE_TRIGGERS,
      'data-simul-replica-disclosure-trigger',
    )) return TRIGGER_PREVIEW_EVENTS.has(event.type);
    if (isOwnedDisclosureSurface(
      candidate,
      OWNED_DISCLOSURE_PANELS,
      'data-simul-replica-disclosure-panel',
    )) return PANEL_PREVIEW_EVENTS.has(event.type);
    return false;
  });
}

class ReplicaDisclosureController implements ReadOnlyReplicaDisclosure {
  readonly presentation: ReplicaDisclosurePresentation;
  readonly document: Document;
  readonly anchor: HTMLElement;
  readonly panel: HTMLElement;
  readonly trigger?: HTMLElement;
  readonly originalParent: ParentNode | null;
  readonly originalNextSibling: ChildNode | null;
  readonly manageTriggerExpanded: boolean;
  readonly originalTriggerExpanded: string | null;
  readonly originalTriggerStyle: string | null;
  readonly originalPanelAttributes: ReadonlyMap<string, string | null>;
  readonly originalPanelStyle: string | null;

  #disposed = false;
  #open = false;
  #wasConnected = false;
  #triggerHovered = false;
  #openedFromTriggerHover = false;
  #panelHovered = false;
  #focusWithin = false;
  #suppressFocusOpen = false;
  #deferredCloseTimer: number | undefined;
  #resizeObserver?: ResizeObserver;

  readonly #onTriggerClick = (event: Event): void => {
    blockReplicaActivation(event);
    if (this.#open && this.#openedFromTriggerHover) {
      // Pointer entry precedes click in the ordinary mouse sequence. Treat
      // that first click as adopting the hover preview instead of immediately
      // toggling it closed again.
      this.#openedFromTriggerHover = false;
      return;
    }
    if (this.#open) this.close();
    else this.open();
  };

  readonly #onTriggerPointerDown = (event: Event): void => {
    blockReplicaActivation(event);
  };

  readonly #onTriggerPointerEnter = (): void => {
    this.#triggerHovered = true;
    this.#cancelDeferredClose();
    const wasOpen = this.#open;
    this.open();
    this.#openedFromTriggerHover = !wasOpen && this.#open;
  };

  readonly #onTriggerPointerLeave = (): void => {
    this.#triggerHovered = false;
    this.#scheduleDeferredClose();
  };

  readonly #onPanelPointerEnter = (): void => {
    this.#panelHovered = true;
    this.#cancelDeferredClose();
  };

  readonly #onPanelPointerLeave = (): void => {
    this.#panelHovered = false;
    this.#scheduleDeferredClose();
  };

  readonly #onFocusIn = (): void => {
    this.#focusWithin = true;
    this.#cancelDeferredClose();
    if (!this.#suppressFocusOpen) this.open();
  };

  readonly #onFocusOut = (event: FocusEvent): void => {
    if (this.#containsInteractiveNode(event.relatedTarget)) {
      this.#focusWithin = true;
      this.#cancelDeferredClose();
      return;
    }
    this.#focusWithin = false;
    this.#scheduleDeferredClose();
  };

  readonly #onTriggerKeyDown = (event: KeyboardEvent): void => {
    if (![' ', 'Enter', 'ArrowDown', 'Escape'].includes(event.key)) return;
    blockReplicaActivation(event);
    if (event.key === 'Escape') this.close();
    else {
      this.open();
      if (event.key === 'ArrowDown') this.#focusFirstPanelItem();
    }
  };

  readonly #onPanelActivation = (event: Event): void => {
    blockReplicaActivation(event);
  };

  readonly #onPanelKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      blockReplicaActivation(event);
      this.#suppressFocusOpen = true;
      try {
        this.close();
        this.trigger?.focus({ preventScroll: true });
      } catch {
        // Focus restoration is optional; the disclosure is already closed.
      } finally {
        this.#suppressFocusOpen = false;
      }
      return;
    }
    if (
      event.key === 'Enter' ||
      (event.key === ' ' && keyboardTargetCanActivate(event.target))
    ) {
      blockReplicaActivation(event);
    }
  };

  constructor(options: ReadOnlyReplicaDisclosureOptions) {
    this.presentation = options.presentation;
    this.document = options.anchor.ownerDocument;
    this.anchor = options.anchor;
    this.panel = options.panel;
    this.trigger = options.trigger;
    this.manageTriggerExpanded = options.manageTriggerExpanded === true;
    this.originalTriggerExpanded = this.manageTriggerExpanded
      ? options.trigger?.getAttribute('aria-expanded') ?? null
      : null;
    this.originalTriggerStyle = options.trigger?.getAttribute('style') ?? null;
    this.originalParent = options.panel.parentNode;
    this.originalNextSibling = options.panel.nextSibling;
    this.originalPanelAttributes = snapshotAttributes(
      options.panel,
      PANEL_ATTRIBUTES,
    );
    this.originalPanelStyle = options.panel.getAttribute('style');
    this.#wasConnected = this.#identityIsConnected();

    this.anchor.setAttribute('data-simul-replica-disclosure-anchor', DISCLOSURE_MARKER);
    this.panel.setAttribute('data-simul-replica-disclosure-panel', DISCLOSURE_MARKER);
    OWNED_DISCLOSURE_PANELS.add(this.panel);
    setImportant(this.panel, 'box-sizing', 'border-box');
    setImportant(this.panel, 'overscroll-behavior', 'contain');
    setImportant(this.panel, 'overflow-x', 'hidden');
    setImportant(this.panel, 'overflow-y', 'auto');
    this.panel.addEventListener('auxclick', this.#onPanelActivation, true);
    this.panel.addEventListener('click', this.#onPanelActivation, true);
    this.panel.addEventListener('contextmenu', this.#onPanelActivation, true);
    this.panel.addEventListener('dblclick', this.#onPanelActivation, true);
    this.panel.addEventListener('keydown', this.#onPanelKeyDown, true);
    this.panel.addEventListener('pointerdown', this.#onPanelActivation, true);
    this.panel.addEventListener('pointerenter', this.#onPanelPointerEnter, true);
    this.panel.addEventListener('pointerleave', this.#onPanelPointerLeave, true);
    this.panel.addEventListener('focusin', this.#onFocusIn, true);
    this.panel.addEventListener('focusout', this.#onFocusOut, true);

    if (this.presentation === 'list') {
      const rows = clamp(Math.trunc(options.visibleRows ?? 8), 2, 20);
      this.panel.removeAttribute('hidden');
      this.panel.removeAttribute('popover');
      setImportant(this.panel, 'display', 'block');
      setImportant(this.panel, 'max-height', `min(${rows * 1.75}em, 18rem, 70vh)`);
      setImportant(this.panel, 'position', 'static');
      setImportant(this.panel, 'pointer-events', 'auto');
      setImportant(this.panel, 'width', '100%');
      queueMicrotask(() => this.#revealSelectedOption());
      return;
    }

    const trigger = this.trigger!;
    trigger.setAttribute('data-simul-replica-disclosure-trigger', DISCLOSURE_MARKER);
    OWNED_DISCLOSURE_TRIGGERS.add(trigger);
    if (this.manageTriggerExpanded) trigger.setAttribute('aria-expanded', 'false');
    setImportant(trigger, 'pointer-events', 'auto');
    trigger.addEventListener('click', this.#onTriggerClick, true);
    trigger.addEventListener('keydown', this.#onTriggerKeyDown, true);
    trigger.addEventListener('pointerdown', this.#onTriggerPointerDown, true);
    trigger.addEventListener('pointerenter', this.#onTriggerPointerEnter, true);
    trigger.addEventListener('pointerleave', this.#onTriggerPointerLeave, true);
    trigger.addEventListener('focusin', this.#onFocusIn, true);
    trigger.addEventListener('focusout', this.#onFocusOut, true);
    this.panel.setAttribute('hidden', '');
    this.panel.setAttribute('popover', 'manual');
    setImportant(this.panel, 'display', 'none');
    setImportant(this.panel, 'pointer-events', 'auto');
    setImportant(this.panel, 'position', 'fixed');
    setImportant(this.panel, 'margin', '0');
    setImportant(this.panel, 'z-index', '2147483647');

    if (options.initiallyOpen) {
      if (this.#identityIsConnected() && this.document.body) {
        this.open();
      } else {
        queueMicrotask(() => {
          if (!this.#disposed && isReplicaNodeConnected(this.anchor)) this.open();
        });
      }
    }
  }

  isOpen(): boolean {
    return this.#open;
  }

  isAnchoredWithin(root: Node): boolean {
    return root === this.anchor || root.contains(this.anchor);
  }

  ownsEventPath(path: readonly EventTarget[]): boolean {
    return path.includes(this.panel) || Boolean(
      this.trigger && path.includes(this.trigger),
    );
  }

  identityIntersects(root: Node): boolean {
    return root === this.anchor || root === this.panel || root === this.trigger ||
      root.contains(this.anchor) || root.contains(this.panel) ||
      Boolean(this.trigger && root.contains(this.trigger));
  }

  open(): void {
    this.#cancelDeferredClose();
    if (
      this.#disposed || this.presentation !== 'popup' || this.#open ||
      !this.#identityIsConnected()
    ) return;
    const body = this.document.body;
    if (!body) return;
    for (const sibling of DOCUMENT_DISCLOSURES.get(this.document)?.controllers ?? []) {
      if (sibling !== this) sibling.close();
    }
    this.#open = true;
    if (this.manageTriggerExpanded) {
      this.trigger!.setAttribute('aria-expanded', 'true');
    }
    this.anchor.setAttribute('data-simul-replica-disclosure-open', DISCLOSURE_MARKER);
    this.panel.setAttribute('data-simul-replica-disclosure-overlay', DISCLOSURE_MARKER);
    this.panel.removeAttribute('hidden');
    setImportant(this.panel, 'display', 'block');
    body.append(this.panel);
    tryShowPopover(this.panel);
    this.#position();
    this.#revealSelectedOption();
    this.#observeAnchorSize();
  }

  close(): void {
    this.#cancelDeferredClose();
    if (!this.#open) return;
    this.#open = false;
    this.#openedFromTriggerHover = false;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#cancelDeferredClose();
    if (this.manageTriggerExpanded) {
      this.trigger?.setAttribute('aria-expanded', 'false');
    }
    this.anchor.removeAttribute('data-simul-replica-disclosure-open');
    this.panel.removeAttribute('data-simul-replica-disclosure-overlay');
    this.panel.removeAttribute('data-simul-replica-disclosure-placement');
    tryHidePopover(this.panel);
    this.panel.setAttribute('hidden', '');
    setImportant(this.panel, 'display', 'none');
    restorePanelPosition(this.panel, this.originalParent, this.originalNextSibling);
  }

  sync(): void {
    if (this.#disposed) return;
    const connected = this.#identityIsConnected();
    this.#wasConnected ||= connected;
    if (!connected && this.#wasConnected) {
      this.dispose();
      return;
    }
    if (this.#open) this.#position();
  }

  disposeIfIdentityLost(): void {
    if (this.#disposed) return;
    const connected = this.#identityIsConnected();
    this.#wasConnected ||= connected;
    if (!connected && this.#wasConnected) this.dispose();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.close();
    this.#disposed = true;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.trigger?.removeEventListener('click', this.#onTriggerClick, true);
    this.trigger?.removeEventListener('keydown', this.#onTriggerKeyDown, true);
    this.trigger?.removeEventListener(
      'pointerdown',
      this.#onTriggerPointerDown,
      true,
    );
    this.trigger?.removeEventListener(
      'pointerenter',
      this.#onTriggerPointerEnter,
      true,
    );
    this.trigger?.removeEventListener(
      'pointerleave',
      this.#onTriggerPointerLeave,
      true,
    );
    this.trigger?.removeEventListener('focusin', this.#onFocusIn, true);
    this.trigger?.removeEventListener('focusout', this.#onFocusOut, true);
    this.panel.removeEventListener('auxclick', this.#onPanelActivation, true);
    this.panel.removeEventListener('click', this.#onPanelActivation, true);
    this.panel.removeEventListener('contextmenu', this.#onPanelActivation, true);
    this.panel.removeEventListener('dblclick', this.#onPanelActivation, true);
    this.panel.removeEventListener('keydown', this.#onPanelKeyDown, true);
    this.panel.removeEventListener('pointerdown', this.#onPanelActivation, true);
    this.panel.removeEventListener('pointerenter', this.#onPanelPointerEnter, true);
    this.panel.removeEventListener('pointerleave', this.#onPanelPointerLeave, true);
    this.panel.removeEventListener('focusin', this.#onFocusIn, true);
    this.panel.removeEventListener('focusout', this.#onFocusOut, true);
    this.anchor.removeAttribute('data-simul-replica-disclosure-anchor');
    this.anchor.removeAttribute('data-simul-replica-disclosure-open');
    this.trigger?.removeAttribute('data-simul-replica-disclosure-trigger');
    OWNED_DISCLOSURE_PANELS.delete(this.panel);
    if (this.trigger) OWNED_DISCLOSURE_TRIGGERS.delete(this.trigger);
    if (this.manageTriggerExpanded && this.trigger) {
      restoreAttribute(
        this.trigger,
        'aria-expanded',
        this.originalTriggerExpanded,
      );
    }
    if (this.trigger) restoreAttribute(this.trigger, 'style', this.originalTriggerStyle);
    restoreAttributes(this.panel, this.originalPanelAttributes);
    restoreAttribute(this.panel, 'style', this.originalPanelStyle);
    unregisterController(this);
  }

  #observeAnchorSize(): void {
    const ResizeObserverConstructor = this.document.defaultView?.ResizeObserver;
    if (!ResizeObserverConstructor) return;
    this.#resizeObserver = new ResizeObserverConstructor(() => {
      if (this.#open) this.#position();
    });
    this.#resizeObserver.observe(this.anchor);
  }

  #containsInteractiveNode(candidate: EventTarget | null): boolean {
    if (!candidate || !('nodeType' in candidate)) return false;
    const node = candidate as Node;
    return node === this.trigger || node === this.panel ||
      Boolean(this.trigger?.contains(node)) || this.panel.contains(node);
  }

  #focusFirstPanelItem(): void {
    let candidates: NodeListOf<HTMLElement>;
    try {
      candidates = this.panel.querySelectorAll<HTMLElement>(
        DISCLOSURE_FOCUS_SELECTOR,
      );
    } catch {
      return;
    }
    const limit = Math.min(candidates.length, MAX_DISCLOSURE_FOCUS_CANDIDATES);
    for (let index = 0; index < limit; index += 1) {
      const candidate = candidates.item(index);
      if (!candidate || !replicaFocusTargetIsSafe(candidate, this.panel)) continue;
      try {
        candidate.focus({ preventScroll: true });
        return;
      } catch {
        // Continue to the next bounded candidate.
      }
    }
  }

  #revealSelectedOption(): void {
    if (this.#disposed || !isReplicaNodeConnected(this.panel)) return;
    try {
      const selected = this.panel.querySelector<HTMLElement>(
        '[role="option"][aria-selected="true"]',
      );
      if (typeof selected?.scrollIntoView !== 'function') return;
      selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      // Selection remains readable even when synthetic layout APIs fail.
    }
  }

  #scheduleDeferredClose(): void {
    if (
      this.#disposed || this.presentation !== 'popup' || !this.#open ||
      this.#deferredCloseTimer !== undefined
    ) return;
    const view = this.document.defaultView;
    const schedule = view?.setTimeout?.bind(view) ?? globalThis.setTimeout;
    this.#deferredCloseTimer = schedule(() => {
      this.#deferredCloseTimer = undefined;
      if (!this.#triggerHovered && !this.#panelHovered && !this.#focusWithin) {
        this.close();
      }
    }, DISCLOSURE_LEAVE_GRACE_MS) as unknown as number;
  }

  #cancelDeferredClose(): void {
    if (this.#deferredCloseTimer === undefined) return;
    const view = this.document.defaultView;
    const cancel = view?.clearTimeout?.bind(view) ?? globalThis.clearTimeout;
    cancel(this.#deferredCloseTimer);
    this.#deferredCloseTimer = undefined;
  }

  #identityIsConnected(): boolean {
    return isReplicaNodeConnected(this.anchor) &&
      isReplicaNodeConnected(this.panel) &&
      (!this.trigger || isReplicaNodeConnected(this.trigger));
  }

  #position(): void {
    if (!this.#open) return;
    const view = this.document.defaultView;
    const documentElement = this.document.documentElement;
    let anchorRect: DOMRect;
    try {
      anchorRect = this.anchor.getBoundingClientRect();
    } catch {
      this.close();
      return;
    }
    setImportant(this.panel, 'visibility', 'hidden');
    setImportant(
      this.panel,
      '--simul-replica-disclosure-visibility',
      'hidden',
    );
    setImportant(this.panel, 'max-height', 'min(20rem, 70vh)');
    setImportant(this.panel, 'max-width', 'calc(100vw - 16px)');
    let panelRect: DOMRect;
    try {
      panelRect = this.panel.getBoundingClientRect();
    } catch {
      panelRect = anchorRect;
    }
    const placement = computeReplicaDisclosurePlacement({
      anchor: anchorRect,
      panelHeight: panelRect.height || this.panel.scrollHeight || DEFAULT_POPUP_HEIGHT,
      panelWidth: panelRect.width || this.panel.scrollWidth || anchorRect.width,
      viewportHeight: view?.innerHeight || documentElement?.clientHeight || 1,
      viewportWidth: view?.innerWidth || documentElement?.clientWidth || 1,
    });
    setImportant(this.panel, 'inset', 'auto');
    setImportant(this.panel, 'left', `${placement.left}px`);
    setImportant(this.panel, 'top', `${placement.top}px`);
    setImportant(this.panel, 'min-width', `${placement.minWidth}px`);
    setImportant(this.panel, 'max-width', `${placement.maxWidth}px`);
    setImportant(this.panel, 'max-height', `${placement.maxHeight}px`);
    setImportant(this.panel, 'visibility', 'visible');
    setImportant(
      this.panel,
      '--simul-replica-disclosure-left',
      `${placement.left}px`,
    );
    setImportant(
      this.panel,
      '--simul-replica-disclosure-top',
      `${placement.top}px`,
    );
    setImportant(
      this.panel,
      '--simul-replica-disclosure-min-width',
      `${placement.minWidth}px`,
    );
    setImportant(
      this.panel,
      '--simul-replica-disclosure-max-width',
      `${placement.maxWidth}px`,
    );
    setImportant(
      this.panel,
      '--simul-replica-disclosure-max-height',
      `${placement.maxHeight}px`,
    );
    setImportant(
      this.panel,
      '--simul-replica-disclosure-visibility',
      'visible',
    );
    this.panel.setAttribute(
      'data-simul-replica-disclosure-placement',
      placement.placement,
    );
  }
}

function registerController(controller: ReplicaDisclosureController): void {
  const document = controller.document;
  let state = DOCUMENT_DISCLOSURES.get(document);
  if (!state) {
    state = installDocumentDisclosureState(document);
    DOCUMENT_DISCLOSURES.set(document, state);
  }
  state.controllers.add(controller);
}

function unregisterController(controller: ReplicaDisclosureController): void {
  const state = DOCUMENT_DISCLOSURES.get(controller.document);
  if (!state) return;
  state.controllers.delete(controller);
  if (state.controllers.size > 0) return;
  state.dispose();
  DOCUMENT_DISCLOSURES.delete(controller.document);
}

function installDocumentDisclosureState(
  document: Document,
): DocumentDisclosureState {
  const controllers = new Set<ReplicaDisclosureController>();
  const onPointerDown = (event: Event): void => {
    const path = disclosureEventPath(event);
    const ownedEvent = isReadOnlyReplicaDisclosureEvent(event);
    for (const controller of controllers) {
      if (!ownedEvent || !controller.ownsEventPath(path)) controller.close();
    }
  };
  const syncOpenControllers = (): void => {
    for (const controller of controllers) {
      if (controller.isOpen()) controller.sync();
    }
  };
  const MutationObserverConstructor = document.defaultView?.MutationObserver;
  const observer = MutationObserverConstructor
    ? new MutationObserverConstructor((records) => {
      const candidates = new Set<ReplicaDisclosureController>();
      for (const record of records) {
        for (const removedNode of record.removedNodes) {
          for (const controller of controllers) {
            if (controller.identityIntersects(removedNode)) {
              candidates.add(controller);
            }
          }
        }
      }
      for (const controller of candidates) {
        controller.disposeIfIdentityLost();
      }
    })
    : undefined;
  if (observer && document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('scroll', syncOpenControllers, true);
  document.defaultView?.addEventListener('resize', syncOpenControllers);

  const frameElement = document.defaultView?.frameElement;
  const outerDocument = frameElement?.ownerDocument;
  const outerWindow = outerDocument?.defaultView;
  outerDocument?.addEventListener('scroll', syncOpenControllers, true);
  outerWindow?.addEventListener('resize', syncOpenControllers);

  return {
    controllers,
    dispose: () => {
      observer?.disconnect();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', syncOpenControllers, true);
      document.defaultView?.removeEventListener('resize', syncOpenControllers);
      outerDocument?.removeEventListener('scroll', syncOpenControllers, true);
      outerWindow?.removeEventListener('resize', syncOpenControllers);
    },
  };
}

function isOwnedDisclosureSurface(
  candidate: unknown,
  owned: WeakSet<object>,
  attribute: string,
): boolean {
  if (
    !candidate || typeof candidate !== 'object' ||
    !owned.has(candidate) ||
    !('nodeType' in candidate) || candidate.nodeType !== 1 ||
    !('getAttribute' in candidate) ||
    typeof candidate.getAttribute !== 'function'
  ) return false;
  return candidate.getAttribute(attribute) === DISCLOSURE_MARKER;
}

function disclosureEventPath(event: Event): readonly EventTarget[] {
  return typeof event.composedPath === 'function'
    ? event.composedPath()
    : event.target
      ? [event.target]
      : [];
}

function snapshotAttributes(
  element: HTMLElement,
  attributes: readonly string[],
): ReadonlyMap<string, string | null> {
  return new Map(attributes.map((attribute) => [
    attribute,
    element.getAttribute(attribute),
  ]));
}

function restoreAttributes(
  element: HTMLElement,
  snapshots: ReadonlyMap<string, string | null>,
): void {
  for (const [attribute, value] of snapshots) {
    restoreAttribute(element, attribute, value);
  }
}

function restoreAttribute(
  element: HTMLElement,
  attribute: string,
  value: string | null,
): void {
  if (value === null) element.removeAttribute(attribute);
  else element.setAttribute(attribute, value);
}

function blockReplicaActivation(event: Event): void {
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

function keyboardTargetCanActivate(target: EventTarget | null): boolean {
  if (!target || !('nodeType' in target) || target.nodeType !== 1) return false;
  const element = target as Element;
  const tagName = element.localName.toLowerCase();
  if (
    tagName === 'button' || tagName === 'input' || tagName === 'select' ||
    tagName === 'summary' || tagName === 'textarea'
  ) return true;
  const role = element.getAttribute('role')?.trim().toLowerCase() ?? '';
  return KEYBOARD_ACTIVATION_ROLES.has(role);
}

function replicaFocusTargetIsSafe(
  candidate: HTMLElement,
  panel: HTMLElement,
): boolean {
  if (
    !candidate.isConnected ||
    typeof candidate.focus !== 'function' ||
    candidate.hasAttribute('disabled') ||
    safelyMatches(candidate, ':disabled')
  ) return false;
  const rawTabIndex = candidate.getAttribute('tabindex');
  if (rawTabIndex !== null) {
    const tabIndex = Number(rawTabIndex.trim());
    if (!Number.isInteger(tabIndex) || tabIndex < 0) return false;
  }
  let current: Element | null = candidate;
  let inspected = 0;
  while (current) {
    inspected += 1;
    if (inspected > 64) return false;
    if (
      current.hasAttribute('hidden') || current.hasAttribute('inert') ||
      current.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true' ||
      elementHasCollapsedPaint(current)
    ) return false;
    if (current === panel) return true;
    current = current.parentElement;
  }
  return false;
}

function elementHasCollapsedPaint(element: Element): boolean {
  const getComputedStyle = element.ownerDocument.defaultView?.getComputedStyle;
  if (typeof getComputedStyle !== 'function') return false;
  try {
    const style = getComputedStyle.call(element.ownerDocument.defaultView, element);
    const contentVisibility = style.getPropertyValue('content-visibility')
      .trim().toLowerCase();
    const opacity = style.opacity.trim();
    return style.display.trim().toLowerCase() === 'none' ||
      ['hidden', 'collapse'].includes(style.visibility.trim().toLowerCase()) ||
      contentVisibility === 'hidden' ||
      (opacity !== '' && Number(opacity) <= 0);
  } catch {
    return true;
  }
}

function safelyMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return true;
  }
}

function setImportant(
  element: HTMLElement,
  property: string,
  value: string,
): void {
  element.style.setProperty(property, value, 'important');
}

function isReplicaNodeConnected(node: Node): boolean {
  if (node.isConnected) return true;
  const document = node.ownerDocument;
  return Boolean(document?.documentElement?.contains(node));
}

function restorePanelPosition(
  panel: HTMLElement,
  parent: ParentNode | null,
  nextSibling: ChildNode | null,
): void {
  if (!parent) return;
  try {
    if (nextSibling?.parentNode === parent) parent.insertBefore(panel, nextSibling);
    else parent.appendChild(panel);
  } catch {
    panel.remove();
  }
}

function tryShowPopover(panel: HTMLElement): void {
  try {
    const candidate = panel as HTMLElement & { showPopover?: () => void };
    candidate.showPopover?.();
  } catch {
    // A fixed body child remains the clipping-independent fallback.
  }
}

function tryHidePopover(panel: HTMLElement): void {
  try {
    const candidate = panel as HTMLElement & { hidePopover?: () => void };
    candidate.hidePopover?.();
  } catch {
    // The fallback is hidden and restored below regardless of top-layer state.
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
