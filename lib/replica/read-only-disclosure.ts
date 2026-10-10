/**
 * `popup` floats a copy-styled panel beside its trigger; `inline` reveals the
 * page's own panel where the page draws it, as a CSS or scripted hover menu
 * does; `list` keeps a select's options inline.
 */
export type ReplicaDisclosurePresentation = 'inline' | 'list' | 'popup';

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
  /**
   * More triggers for the same panel: the arrow button beside a menu's link
   * (D132). They open and close it as `trigger` does; only `trigger` carries
   * `aria-expanded`.
   */
  readonly additionalTriggers?: readonly HTMLElement[];
  readonly initiallyOpen?: boolean;
  /**
   * The page itself is showing this panel now. It is open from the start,
   * and the pointer leaving it in the replica does not close it: the leave
   * grace is for what the reader's own hover opened (D132).
   */
  readonly shownByPage?: boolean;
  readonly visibleRows?: number;
  /**
   * Menus preview on hover and close when the pointer leaves. A select opens
   * only on click or keyboard and stays open until a choice, Escape or an
   * outside click, as a native select does. Defaults to true.
   */
  readonly openOnHover?: boolean;
  /**
   * Every preview is taken down and put up again after each change to the
   * page. A controller on Simul's own elements (a select's button and list)
   * has nothing a page change can touch: it stays, so its open list keeps
   * its place while the page changes around it (D132).
   */
  readonly survivesRefresh?: boolean;
}

export interface ReadOnlyReplicaDisclosure {
  readonly presentation: ReplicaDisclosurePresentation;
  close(): void;
  dispose(): void;
  isAnchoredWithin(root: Node): boolean;
  isDisposed(): boolean;
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
// A press is more than its `pointerdown`, `click` and `keydown`. The frame
// cancels every input a preview does not own, and cancelling a tap's
// `touchstart` or `touchend` cancels its click: a tap opened nothing. For an
// input it does not own the frame also closes every preview, so the release
// of a key closed what the key had opened, and the release of the mouse
// closed an open dropdown just before the click that was to close it (D132).
const TRIGGER_PREVIEW_EVENTS = new Set([
  'click', 'focusin', 'focusout', 'keydown', 'keypress', 'keyup',
  'pointerdown', 'pointerenter', 'pointerleave', 'pointerup', 'touchend',
  'touchstart',
]);
const PANEL_PREVIEW_EVENTS = new Set([
  'auxclick',
  'click',
  'contextmenu',
  'dblclick',
  'focusin',
  'focusout',
  'keydown',
  'keypress',
  'keyup',
  'pointerdown',
  'pointerenter',
  'pointerleave',
  'pointerup',
  'scroll',
  'touchend',
  'touchstart',
  'wheel',
]);
const DISCLOSURE_LEAVE_GRACE_MS = 100;
const MAX_INLINE_REVEAL_DESCENDANTS = 2_000;
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
/** In-place panels scroll with the page, so the wheel is not theirs. */
const INLINE_DISCLOSURE_PANELS = new WeakSet<object>();
const PAGE_SCROLL_EVENTS = new Set(['scroll', 'wheel']);

interface DocumentDisclosureState {
  readonly controllers: Set<ReplicaDisclosureController>;
  readonly dispose: () => void;
}

const DOCUMENT_DISCLOSURES = new WeakMap<Document, DocumentDisclosureState>();

/**
 * What a preview the reader had opened was doing when a refresh took its
 * controller down: where the pointer and the focus were, and when its leave
 * grace would have run out.
 */
interface ReaderOpenedState {
  readonly triggerHovered: boolean;
  readonly panelHovered: boolean;
  readonly focusWithin: boolean;
  readonly closeAt: number | undefined;
}

/**
 * Anchors whose preview the reader had opened when a refresh took its
 * controller down. The refresh puts the new controller up in the same task,
 * and that one opens again and goes on where the old one was. A tap or the
 * keyboard leaves no hover to reopen a menu by; and a menu the pointer has
 * just left must still close when its grace runs out, though the refresh
 * came in between (D132).
 */
const READER_OPENED_BEFORE_REFRESH = new Map<HTMLElement, ReaderOpenedState>();
let readerOpenedExpiryQueued = false;

function rememberReaderOpened(
  anchor: HTMLElement,
  state: ReaderOpenedState,
): void {
  READER_OPENED_BEFORE_REFRESH.set(anchor, state);
  if (readerOpenedExpiryQueued) return;
  readerOpenedExpiryQueued = true;
  queueMicrotask(() => {
    readerOpenedExpiryQueued = false;
    READER_OPENED_BEFORE_REFRESH.clear();
  });
}

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
    options.presentation !== 'list' &&
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

/**
 * Closes the reader's previews. What the page itself shows stays: a press
 * elsewhere in the replica does not close it on the page.
 */
export function closeReadOnlyReplicaDisclosures(document: Document): void {
  for (const controller of DOCUMENT_DISCLOSURES.get(document)?.controllers ?? []) {
    if (!controller.shownByPage) controller.close();
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

/**
 * Takes every preview down. With `refresh`, those marked `survivesRefresh`
 * stay as long as their elements are still in the replica.
 */
export function disposeReadOnlyReplicaDisclosures(
  document: Document,
  refresh = false,
): void {
  const state = DOCUMENT_DISCLOSURES.get(document);
  if (!state) return;
  for (const controller of [...state.controllers]) {
    if (refresh && controller.survivesRefresh) controller.disposeIfIdentityLost();
    else controller.dispose();
  }
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
    )) {
      return PANEL_PREVIEW_EVENTS.has(event.type) &&
        !(INLINE_DISCLOSURE_PANELS.has(candidate as object) &&
          PAGE_SCROLL_EVENTS.has(event.type));
    }
    return false;
  });
}

class ReplicaDisclosureController implements ReadOnlyReplicaDisclosure {
  readonly presentation: ReplicaDisclosurePresentation;
  readonly document: Document;
  readonly anchor: HTMLElement;
  readonly panel: HTMLElement;
  readonly trigger?: HTMLElement;
  /** `trigger` and any additional ones, each with its style as it was. */
  readonly triggers: ReadonlyArray<readonly [HTMLElement, string | null]>;
  readonly originalParent: ParentNode | null;
  readonly originalNextSibling: ChildNode | null;
  readonly manageTriggerExpanded: boolean;
  readonly openOnHover: boolean;
  readonly survivesRefresh: boolean;
  readonly shownByPage: boolean;
  readonly originalTriggerExpanded: string | null;
  readonly originalPanelAttributes: ReadonlyMap<string, string | null>;
  readonly originalPanelStyle: string | null;

  #disposed = false;
  #open = false;
  /** Opened by the reader in the replica, not to match the page. */
  #openedByReader = false;
  #wasConnected = false;
  #triggerHovered = false;
  #openedFromTriggerHover = false;
  #panelHovered = false;
  #focusWithin = false;
  #suppressFocusOpen = false;
  #deferredCloseTimer: number | undefined;
  #deferredCloseAt: number | undefined;
  #resizeObserver?: ResizeObserver;
  #inlineRevealed: Array<readonly [HTMLElement, string | null]> = [];

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
    else this.#openForReader();
  };

  readonly #onTriggerPointerDown = (event: Event): void => {
    blockReplicaActivation(event);
  };

  // A finger does not hover: it enters with the press and leaves with the
  // lift. Taken as a hover, a tap opened a menu for the length of the leave
  // grace and closed it again. A tap opens and closes by its click (D132).
  readonly #onTriggerPointerEnter = (event: Event): void => {
    if (isTouchPointerEvent(event)) return;
    this.#triggerHovered = true;
    this.#cancelDeferredClose();
    if (!this.openOnHover) return;
    const wasOpen = this.#open;
    this.#openForReader();
    this.#openedFromTriggerHover = !wasOpen && this.#open;
  };

  readonly #onTriggerPointerLeave = (event: Event): void => {
    if (isTouchPointerEvent(event)) return;
    this.#triggerHovered = false;
    if (this.openOnHover) this.#scheduleDeferredClose();
  };

  readonly #onPanelPointerEnter = (event: Event): void => {
    if (isTouchPointerEvent(event)) return;
    this.#panelHovered = true;
    this.#cancelDeferredClose();
  };

  readonly #onPanelPointerLeave = (event: Event): void => {
    if (isTouchPointerEvent(event)) return;
    this.#panelHovered = false;
    if (this.openOnHover) this.#scheduleDeferredClose();
  };

  readonly #onFocusIn = (): void => {
    this.#focusWithin = true;
    this.#cancelDeferredClose();
    if (!this.#suppressFocusOpen) this.#openForReader();
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
      this.#openForReader();
      if (event.key === 'ArrowDown') this.#focusFirstPanelItem();
    }
  };

  readonly #onPanelActivation = (event: Event): void => {
    // A dropdown inside this panel answers for its own button and list. Its
    // button is not one of the menu's items: taken for one, a click on it
    // closed the menu and never reached the dropdown (D132).
    if (this.#heldDisclosureOwns(event)) return;
    blockReplicaActivation(event);
    // Choosing an option or a menu entry closes the popup, as on the page
    // (where the choice then changes the control or navigates). The replica
    // never acts on the choice itself.
    if (
      this.presentation !== 'list' &&
      this.#open &&
      clickChoosesPanelItem(event, this.panel)
    ) this.close();
  };

  readonly #onPanelKeyDown = (event: KeyboardEvent): void => {
    if (this.#heldDisclosureOwns(event)) return;
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
      return;
    }
    // A field inside a menu's panel takes no typing, as a field anywhere
    // else in the replica takes none; Tab still moves on (D132).
    if (event.key !== 'Tab' && keyboardTargetTakesText(event.target)) {
      blockReplicaActivation(event);
    }
  };

  constructor(options: ReadOnlyReplicaDisclosureOptions) {
    this.presentation = options.presentation;
    this.openOnHover = options.openOnHover !== false;
    this.survivesRefresh = options.survivesRefresh === true;
    this.shownByPage = options.shownByPage === true;
    this.document = options.anchor.ownerDocument;
    this.anchor = options.anchor;
    this.panel = options.panel;
    this.trigger = options.trigger;
    this.manageTriggerExpanded = options.manageTriggerExpanded === true;
    this.originalTriggerExpanded = this.manageTriggerExpanded
      ? options.trigger?.getAttribute('aria-expanded') ?? null
      : null;
    this.triggers = Object.freeze(
      (options.trigger
        ? [options.trigger, ...options.additionalTriggers ?? []]
        : []
      ).map((trigger) =>
        Object.freeze([trigger, trigger.getAttribute('style')] as const)),
    );
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
    if (this.presentation === 'inline') INLINE_DISCLOSURE_PANELS.add(this.panel);
    if (this.presentation !== 'inline') {
      setImportant(this.panel, 'box-sizing', 'border-box');
      setImportant(this.panel, 'overscroll-behavior', 'contain');
      setImportant(this.panel, 'overflow-x', 'hidden');
      setImportant(this.panel, 'overflow-y', 'auto');
    }
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

    if (this.manageTriggerExpanded) {
      this.trigger!.setAttribute('aria-expanded', 'false');
    }
    for (const [trigger] of this.triggers) {
      trigger.setAttribute('data-simul-replica-disclosure-trigger', DISCLOSURE_MARKER);
      OWNED_DISCLOSURE_TRIGGERS.add(trigger);
      setImportant(trigger, 'pointer-events', 'auto');
      trigger.addEventListener('click', this.#onTriggerClick, true);
      trigger.addEventListener('keydown', this.#onTriggerKeyDown, true);
      trigger.addEventListener('pointerdown', this.#onTriggerPointerDown, true);
      trigger.addEventListener('pointerenter', this.#onTriggerPointerEnter, true);
      trigger.addEventListener('pointerleave', this.#onTriggerPointerLeave, true);
      trigger.addEventListener('focusin', this.#onFocusIn, true);
      trigger.addEventListener('focusout', this.#onFocusOut, true);
    }
    if (this.presentation === 'inline') {
      // Closed, the panel keeps the page's own state (a scripted menu the
      // source opens shows through). It is not a pointer target then, so an
      // invisible panel cannot catch the pointer or the wheel.
      setImportant(this.panel, 'pointer-events', 'none');
    } else {
      this.panel.setAttribute('hidden', '');
      this.panel.setAttribute('popover', 'manual');
      setImportant(this.panel, 'display', 'none');
      setImportant(this.panel, 'pointer-events', 'auto');
      setImportant(this.panel, 'position', 'fixed');
      setImportant(this.panel, 'margin', '0');
      setImportant(this.panel, 'z-index', '2147483647');
    }

    const readerOpened = READER_OPENED_BEFORE_REFRESH.get(this.anchor);
    READER_OPENED_BEFORE_REFRESH.delete(this.anchor);
    if (options.initiallyOpen || this.shownByPage || readerOpened) {
      const openAgain = (): void => {
        this.open();
        if (!readerOpened || !this.#open) return;
        this.#openedByReader = true;
        this.#triggerHovered = readerOpened.triggerHovered;
        this.#panelHovered = readerOpened.panelHovered;
        this.#focusWithin = readerOpened.focusWithin;
        if (readerOpened.closeAt !== undefined) {
          this.#scheduleDeferredClose(Math.max(0, readerOpened.closeAt - Date.now()));
        }
      };
      if (this.#identityIsConnected() && this.document.body) {
        openAgain();
      } else {
        queueMicrotask(() => {
          if (!this.#disposed && isReplicaNodeConnected(this.anchor)) openAgain();
        });
      }
    }
  }

  isOpen(): boolean {
    return this.#open;
  }

  isDisposed(): boolean {
    return this.#disposed;
  }

  isAnchoredWithin(root: Node): boolean {
    return root === this.anchor || root.contains(this.anchor);
  }

  ownsEventPath(path: readonly EventTarget[]): boolean {
    return path.includes(this.panel) ||
      this.triggers.some(([trigger]) => path.includes(trigger));
  }

  identityIntersects(root: Node): boolean {
    return root === this.anchor || root === this.panel ||
      root.contains(this.anchor) || root.contains(this.panel) ||
      this.triggers.some(([trigger]) =>
        root === trigger || root.contains(trigger));
  }

  /**
   * Whether `other` sits inside this panel: a dropdown in a menu (D132).
   * Opening it must not close the menu around it, and the menu stays while
   * it is open.
   */
  holds(other: ReplicaDisclosureController): boolean {
    for (
      let current: Node | null = other.anchor, depth = 0;
      current && depth <= 128;
      depth += 1
    ) {
      if (current === this.panel) return true;
      if (current.parentNode) {
        current = current.parentNode;
        continue;
      }
      const root: Node = current.getRootNode();
      current = root !== current && root.nodeType === 11 && 'host' in root
        ? (root as ShadowRoot).host
        : null;
    }
    return false;
  }

  open(): void {
    this.#cancelDeferredClose();
    if (
      this.#disposed || this.presentation === 'list' || this.#open ||
      !this.#identityIsConnected()
    ) return;
    const body = this.document.body;
    if (!body) return;
    // One of the reader's previews at a time. What the page itself shows is
    // not one of them: the page may show several at once (rows of an
    // accordion), and each stays (D132).
    if (!this.shownByPage) {
      for (const sibling of DOCUMENT_DISCLOSURES.get(this.document)?.controllers ?? []) {
        if (sibling !== this && !sibling.shownByPage && !sibling.holds(this)) {
          sibling.close();
        }
      }
    }
    this.#open = true;
    if (this.manageTriggerExpanded) {
      this.trigger!.setAttribute('aria-expanded', 'true');
    }
    this.anchor.setAttribute('data-simul-replica-disclosure-open', DISCLOSURE_MARKER);
    if (this.presentation === 'inline') {
      this.#revealInline();
      return;
    }
    this.panel.setAttribute('data-simul-replica-disclosure-overlay', DISCLOSURE_MARKER);
    this.panel.removeAttribute('hidden');
    setImportant(this.panel, 'display', 'block');
    // A site that collapses its menu with opacity as well as display (freee's
    // header menus) would otherwise open an invisible panel.
    setImportant(this.panel, 'opacity', '1');
    // A page's own root on `<body>` draws only what it slots, and draws that
    // inside its own boxes: there the list hangs beside the body (D135).
    const overlayParent = body.shadowRoot
      ? this.document.documentElement ?? body
      : body;
    overlayParent.append(this.panel);
    tryShowPopover(this.panel);
    this.#position();
    this.#revealSelectedOption();
    this.#observeAnchorSize();
  }

  close(): void {
    this.#close(true);
  }

  /** Closes a dropdown whose own box is no longer drawn. */
  closeIfUnanchored(): void {
    if (this.#open && !this.#disposed && elementHasNoBox(this.anchor)) {
      this.close();
    }
  }

  #close(withWhatItHolds: boolean): void {
    this.#cancelDeferredClose();
    if (!this.#open) return;
    this.#open = false;
    this.#openedByReader = false;
    this.#openedFromTriggerHover = false;
    for (const other of DOCUMENT_DISCLOSURES.get(this.document)?.controllers ?? []) {
      if (other === this) continue;
      // What is open inside this panel closes with it; a hover menu left
      // open only for the dropdown inside it may now close too.
      if (this.holds(other)) {
        if (withWhatItHolds) other.close();
      } else if (other.openOnHover && other.holds(this)) {
        other.#scheduleDeferredClose();
      }
    }
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#cancelDeferredClose();
    if (this.manageTriggerExpanded) {
      this.trigger?.setAttribute('aria-expanded', 'false');
    }
    this.anchor.removeAttribute('data-simul-replica-disclosure-open');
    if (this.presentation === 'inline') {
      for (const [element, style] of this.#inlineRevealed) {
        restoreAttribute(element, 'style', style);
      }
      this.#inlineRevealed = [];
      restoreAttribute(this.panel, 'style', this.originalPanelStyle);
      setImportant(this.panel, 'pointer-events', 'none');
      return;
    }
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
    if (this.#open && this.presentation === 'popup') this.#position();
  }

  disposeIfIdentityLost(): void {
    if (this.#disposed) return;
    const connected = this.#identityIsConnected();
    this.#wasConnected ||= connected;
    if (!connected && this.#wasConnected) this.dispose();
  }

  dispose(): void {
    if (this.#disposed) return;
    if (this.#open && this.#openedByReader) {
      rememberReaderOpened(this.anchor, {
        triggerHovered: this.#triggerHovered,
        panelHovered: this.#panelHovered,
        focusWithin: this.#focusWithin,
        closeAt: this.#deferredCloseAt,
      });
    }
    // A dropdown open inside this panel stays through a refresh, which puts
    // this controller up again in the same task. If it does not, and the
    // dropdown is left without a box, the dropdown closes then (D132; closed
    // here, it closed at every change to the page).
    const held = this.#open
      ? [...DOCUMENT_DISCLOSURES.get(this.document)?.controllers ?? []].filter(
          (other) => other !== this && other.isOpen() && this.holds(other),
        )
      : [];
    if (held.length > 0) {
      queueMicrotask(() => {
        for (const other of held) other.closeIfUnanchored();
      });
    }
    this.#close(false);
    this.#disposed = true;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    for (const [trigger] of this.triggers) {
      trigger.removeEventListener('click', this.#onTriggerClick, true);
      trigger.removeEventListener('keydown', this.#onTriggerKeyDown, true);
      trigger.removeEventListener('pointerdown', this.#onTriggerPointerDown, true);
      trigger.removeEventListener('pointerenter', this.#onTriggerPointerEnter, true);
      trigger.removeEventListener('pointerleave', this.#onTriggerPointerLeave, true);
      trigger.removeEventListener('focusin', this.#onFocusIn, true);
      trigger.removeEventListener('focusout', this.#onFocusOut, true);
    }
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
    OWNED_DISCLOSURE_PANELS.delete(this.panel);
    INLINE_DISCLOSURE_PANELS.delete(this.panel);
    for (const [trigger] of this.triggers) {
      trigger.removeAttribute('data-simul-replica-disclosure-trigger');
      OWNED_DISCLOSURE_TRIGGERS.delete(trigger);
    }
    if (this.manageTriggerExpanded && this.trigger) {
      restoreAttribute(
        this.trigger,
        'aria-expanded',
        this.originalTriggerExpanded,
      );
    }
    for (const [trigger, style] of this.triggers) {
      restoreAttribute(trigger, 'style', style);
    }
    restoreAttributes(this.panel, this.originalPanelAttributes);
    restoreAttribute(this.panel, 'style', this.originalPanelStyle);
    unregisterController(this);
  }

  /**
   * Shows the page's own panel in place, as the page's hover does: collapsed
   * by display, visibility, opacity or content-visibility, it is uncollapsed
   * and drawn with the page's styles and position. Content the page fades in
   * once the menu is open (opacity 0 or visibility hidden until a script adds
   * a class) is shown too; content hidden with display none, such as a
   * mobile-only copy, stays hidden.
   */
  #revealInline(): void {
    const view = this.document.defaultView;
    let display = '';
    try {
      display = view?.getComputedStyle(this.panel).display ?? '';
    } catch {
      // An unreadable style still reveals with the block default below.
    }
    // Its display is pinned either way. The page's own `:hover` rule may be
    // what shows it at this moment, and that ends when the pointer moves on:
    // after a tap it ended at once, and the open menu went blank (D132).
    setImportant(
      this.panel,
      'display',
      display === '' || display === 'none' ? 'block' : display,
    );
    setImportant(this.panel, 'visibility', 'visible');
    setImportant(this.panel, 'opacity', '1');
    setImportant(this.panel, 'content-visibility', 'visible');
    setImportant(this.panel, 'pointer-events', 'auto');
    if (!view) return;
    let descendants: NodeListOf<Element>;
    try {
      descendants = this.panel.querySelectorAll('*');
    } catch {
      return;
    }
    const limit = Math.min(descendants.length, MAX_INLINE_REVEAL_DESCENDANTS);
    for (let index = 0; index < limit; index += 1) {
      const element = descendants.item(index) as HTMLElement | null;
      if (!element || !('style' in element)) continue;
      try {
        const style = view.getComputedStyle(element);
        const faded = style.opacity === '0';
        const hidden = style.visibility === 'hidden';
        if (!faded && !hidden) continue;
        this.#inlineRevealed.push([element, element.getAttribute('style')]);
        if (faded) setImportant(element, 'opacity', '1');
        if (hidden) setImportant(element, 'visibility', 'visible');
      } catch {
        // An unreadable descendant keeps the page's own presentation.
      }
    }
  }

  #openForReader(): void {
    this.open();
    if (this.#open) this.#openedByReader = true;
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
    return node === this.panel || this.panel.contains(node) ||
      this.triggers.some(([trigger]) =>
        node === trigger || trigger.contains(node));
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

  #scheduleDeferredClose(delayMs = DISCLOSURE_LEAVE_GRACE_MS): void {
    if (
      this.#disposed || this.presentation === 'list' || !this.#open ||
      this.#deferredCloseTimer !== undefined
    ) return;
    this.#deferredCloseAt = Date.now() + delayMs;
    // The timer of the realm this code runs in. The replica frame runs no
    // scripts, and a timer set on its window never fires: a menu opened by
    // hover stayed open after the pointer had left (D132).
    this.#deferredCloseTimer = globalThis.setTimeout(() => {
      this.#deferredCloseTimer = undefined;
      this.#deferredCloseAt = undefined;
      if (
        !this.shownByPage &&
        !this.#triggerHovered && !this.#panelHovered && !this.#focusWithin &&
        !this.#holdsAnOpenDisclosure()
      ) this.close();
    }, delayMs) as unknown as number;
  }

  #cancelDeferredClose(): void {
    if (this.#deferredCloseTimer === undefined) return;
    globalThis.clearTimeout(this.#deferredCloseTimer);
    this.#deferredCloseTimer = undefined;
    this.#deferredCloseAt = undefined;
  }

  #heldDisclosureOwns(event: Event): boolean {
    const path = disclosureEventPath(event);
    for (const other of DOCUMENT_DISCLOSURES.get(this.document)?.controllers ?? []) {
      if (other !== this && other.ownsEventPath(path) && this.holds(other)) {
        return true;
      }
    }
    return false;
  }

  #holdsAnOpenDisclosure(): boolean {
    for (const other of DOCUMENT_DISCLOSURES.get(this.document)?.controllers ?? []) {
      if (other !== this && other.isOpen() && this.holds(other)) return true;
    }
    return false;
  }

  #identityIsConnected(): boolean {
    return isReplicaNodeConnected(this.anchor) &&
      isReplicaNodeConnected(this.panel) &&
      this.triggers.every(([trigger]) => isReplicaNodeConnected(trigger));
  }

  #position(): void {
    // A dropdown that is not drawn at this moment (the menu around it is
    // being put up again) has nowhere to hang its list: the list keeps its
    // place.
    if (!this.#open || elementHasNoBox(this.anchor)) return;
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
    // A press on a dropdown's list is also a press inside the menu that
    // holds the dropdown, wherever the list is drawn (D132).
    const owners = ownedEvent
      ? [...controllers].filter((controller) => controller.ownsEventPath(path))
      : [];
    for (const controller of controllers) {
      if (
        !controller.shownByPage &&
        !owners.includes(controller) &&
        !owners.some((owner) => controller.holds(owner))
      ) controller.close();
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
      for (const controller of controllers) {
        let intersectsRemovedNode = false;
        for (const record of records) {
          for (const removedNode of record.removedNodes) {
            if (controller.identityIntersects(removedNode)) {
              intersectsRemovedNode = true;
              break;
            }
          }
          if (intersectsRemovedNode) break;
        }
        if (intersectsRemovedNode) controller.disposeIfIdentityLost();
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
  const snapshots = new Map<string, string | null>();
  for (const attribute of attributes) {
    snapshots.set(attribute, element.getAttribute(attribute));
  }
  return snapshots;
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

function elementHasNoBox(element: Element): boolean {
  try {
    return typeof element.getClientRects === 'function' &&
      element.getClientRects().length === 0;
  } catch {
    return false;
  }
}

function isTouchPointerEvent(event: Event): boolean {
  return (event as Partial<PointerEvent>).pointerType === 'touch';
}

const PANEL_ITEM_SELECTOR = [
  'a[href]',
  'button',
  'input[type="button"]',
  'input[type="submit"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
].join(',');

/**
 * A primary click on an item in an open panel: a link, button, menu item or
 * option, not empty space, a group label or a disabled option. Owned select
 * options ignore pointer input, so the click lands on their list and the
 * option is found under the pointer. Nodes belong to the replica frame, so
 * they are tested by `nodeType`, never `instanceof`.
 */
function clickChoosesPanelItem(event: Event, panel: HTMLElement): boolean {
  if (event.type !== 'click') return false;
  const mouse = event as MouseEvent;
  if (mouse.button !== 0) return false;
  for (const node of event.composedPath()) {
    if (node === panel) break;
    if (
      typeof node === 'object' && node !== null && 'nodeType' in node &&
      (node as Node).nodeType === 1 &&
      (node as Element).matches(PANEL_ITEM_SELECTOR)
    ) {
      return (node as Element).getAttribute('aria-disabled') !== 'true';
    }
  }
  for (const option of panel.querySelectorAll<HTMLElement>(
    '[data-simul-owned-select-option="v1"]',
  )) {
    const rect = option.getBoundingClientRect();
    if (
      rect.width > 0 && rect.height > 0 &&
      mouse.clientX >= rect.left && mouse.clientX < rect.right &&
      mouse.clientY >= rect.top && mouse.clientY < rect.bottom
    ) {
      return option.getAttribute('aria-disabled') !== 'true';
    }
  }
  return false;
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

function keyboardTargetTakesText(target: EventTarget | null): boolean {
  if (!target || !('nodeType' in target) || target.nodeType !== 1) return false;
  const element = target as Element;
  const tagName = element.localName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }
  const editable = element.getAttribute('contenteditable')?.trim().toLowerCase();
  return editable !== undefined && editable !== 'false';
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
