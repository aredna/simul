import { readSourceShadowRoot } from './replica/source-shadow-root';

export const PRIMARY_SCROLL_MAX = 100_000;
/**
 * Panes one scroll report names (D122). A page with more scrolled panes than
 * this keeps the most recently scrolled; the others show at their start.
 * More than this scrolling together (rows kept in step by script) are not
 * followed at all, so that they are never torn apart.
 */
export const MAX_SCROLL_PANES = 256;

export type PrimaryScrollTarget = 'document' | 'nested';

const EDITABLE_SCROLL_ROLE =
  /(?:^|\s)(?:combobox|searchbox|textbox)(?=\s|$)/iu;

export interface PrimaryScrollSnapshot {
  readonly scrollTarget: PrimaryScrollTarget;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly maxScrollX: number;
  readonly maxScrollY: number;
}

interface ViewportLike {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly getComputedStyle?: (element: Element) => CSSStyleDeclaration;
}

/** A pinch zoom: the magnification and the magnified view's corner. */
export interface VisualViewportSnapshot {
  readonly visualScale: number;
  readonly visualOffsetX: number;
  readonly visualOffsetY: number;
}

/**
 * Chrome magnifies a page up to 5 times. A larger value is cut here on the
 * page's side, and refused or cut on the panel's.
 */
export const VISUAL_SCALE_MAX = 10;
// A pinch that ends this close to no magnification is none.
const VISUAL_SCALE_NOISE = 0.001;

interface VisualViewportLike {
  readonly scale?: number;
  readonly offsetLeft?: number;
  readonly offsetTop?: number;
}

/**
 * Reads the tab's pinch zoom: the magnification on top of the browser zoom
 * and where the magnified view sits inside the layout viewport, in CSS
 * pixels. `undefined` while the page is not magnified, which is nearly
 * always. Page scroll offsets and the window's size do not change with it.
 */
export function readVisualViewportSnapshot(
  sourceWindow: { readonly visualViewport?: VisualViewportLike | null },
): VisualViewportSnapshot | undefined {
  let viewport: VisualViewportLike | null | undefined;
  try {
    viewport = sourceWindow.visualViewport;
  } catch {
    return undefined;
  }
  const scale = finite(viewport?.scale);
  if (!viewport || !(scale > 1 + VISUAL_SCALE_NOISE)) return undefined;
  return Object.freeze({
    visualScale: Math.min(VISUAL_SCALE_MAX, Math.round(scale * 1000) / 1000),
    visualOffsetX: visualOffset(viewport.offsetLeft),
    visualOffsetY: visualOffset(viewport.offsetTop),
  });
}

function visualOffset(value: unknown): number {
  return Math.round(clamp(finite(value), 0, PRIMARY_SCROLL_MAX) * 100) / 100;
}

type NestedViewportLike = Pick<ViewportLike, 'innerWidth' | 'innerHeight'> &
  Pick<Partial<ViewportLike>, 'getComputedStyle'>;

/** Reads the browser-owned page scroller across standards and body fallbacks. */
export function readDocumentScrollSnapshot(
  sourceDocument: Document,
  sourceWindow: ViewportLike,
): PrimaryScrollSnapshot {
  const root = sourceDocument.scrollingElement ??
    sourceDocument.documentElement ?? sourceDocument.body;
  const width = maximumFinite(
    root?.scrollWidth,
    sourceDocument.documentElement?.scrollWidth,
    sourceDocument.body?.scrollWidth,
  );
  const height = maximumFinite(
    root?.scrollHeight,
    sourceDocument.documentElement?.scrollHeight,
    sourceDocument.body?.scrollHeight,
  );
  const viewportWidth = positiveFinite(
    sourceWindow.innerWidth,
    root?.clientWidth,
    sourceDocument.documentElement?.clientWidth,
  );
  const viewportHeight = positiveFinite(
    sourceWindow.innerHeight,
    root?.clientHeight,
    sourceDocument.documentElement?.clientHeight,
  );
  // document.scrollingElement is the browser's authoritative owner. Do not
  // take the largest coordinate from body/html: a former scrolling element
  // can retain a stale offset after a responsive layout switches owners.
  const horizontal = boundedAxis(
    documentAxisPosition(root?.scrollLeft, sourceWindow.scrollX),
    Math.max(0, width - viewportWidth),
  );
  const vertical = boundedAxis(
    documentAxisPosition(root?.scrollTop, sourceWindow.scrollY),
    Math.max(0, height - viewportHeight),
  );
  return Object.freeze({
    scrollTarget: 'document',
    scrollX: horizontal.position,
    scrollY: vertical.position,
    maxScrollX: horizontal.maximum,
    maxScrollY: vertical.maximum,
  });
}

/**
 * Accepts only a visible, viewport-scale vertical overflow region: the pane
 * an app-style page scrolls in place of its document. Every pane is followed
 * by its own place (D122); this one's progress also moves the replica
 * document when the replica cannot scroll the pane itself, which text
 * controls, carousels, and incidental horizontal strips must never do.
 */
export function readNestedScrollSnapshot(
  candidate: Element,
  sourceDocument: Document,
  sourceWindow: NestedViewportLike,
): PrimaryScrollSnapshot | undefined {
  const documentScrollOwner = sourceDocument.scrollingElement ??
    sourceDocument.documentElement ?? sourceDocument.body;
  if (
    candidate.ownerDocument !== sourceDocument ||
    candidate === documentScrollOwner ||
    candidate.isConnected === false ||
    isEditableScrollOwner(candidate)
  ) return undefined;
  const viewportWidth = positiveFinite(sourceWindow.innerWidth, 1);
  const viewportHeight = positiveFinite(sourceWindow.innerHeight, 1);
  const clientWidth = positiveFinite(candidate.clientWidth, 0);
  const clientHeight = positiveFinite(candidate.clientHeight, 0);
  const horizontal = boundedAxis(
    finite(candidate.scrollLeft),
    Math.max(0, finite(candidate.scrollWidth) - clientWidth),
  );
  const vertical = boundedAxis(
    finite(candidate.scrollTop),
    Math.max(0, finite(candidate.scrollHeight) - clientHeight),
  );
  // The numbers first: every scrolled strip and carousel is asked each
  // frame it scrolls, and nearly all stop here without a style read.
  if (vertical.maximum < Math.max(96, viewportHeight * 0.2)) return undefined;
  const overflowY = readOverflowY(candidate, sourceWindow);
  if (overflowY === 'hidden' || overflowY === 'clip' || overflowY === 'visible') {
    return undefined;
  }

  const rect = safeRect(candidate);
  const visibleWidth = Math.max(
    0,
    Math.min(viewportWidth, rect.right) - Math.max(0, rect.left),
  );
  const visibleHeight = Math.max(
    0,
    Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top),
  );
  if (
    clientWidth < viewportWidth * 0.45 ||
    clientHeight < viewportHeight * 0.45 ||
    visibleWidth < viewportWidth * 0.4 ||
    visibleHeight < viewportHeight * 0.4
  ) return undefined;

  return Object.freeze({
    scrollTarget: 'nested',
    scrollX: horizontal.position,
    scrollY: vertical.position,
    maxScrollX: horizontal.maximum,
    maxScrollY: vertical.maximum,
  });
}

/** A pane's place: how far one element is scrolled inside its own range. */
export interface PaneScrollPlace {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly maxScrollX: number;
  readonly maxScrollY: number;
}

/**
 * Reads the place of an element that scrolls on its own, apart from the
 * document (D122): a board of columns, a wide table's wrapper, a carousel, a
 * chat log. Nothing for the document's own scroller or `html`, which follow
 * as the document, and nothing for a text field or anything inside one,
 * which keep their own scroll. Only the element's scroll numbers are read,
 * never its style: `body` is a pane when it scrolls apart from the document
 * and not because its `overflow` says so. Offsets keep their sign, so a
 * right-to-left strip or a reversed column, which count down from 0, land on
 * the same side in the replica.
 */
export function readPaneScrollPlace(
  candidate: Element,
  sourceDocument: Document,
): PaneScrollPlace | undefined {
  const documentScrollOwner = sourceDocument.scrollingElement ??
    sourceDocument.documentElement ?? sourceDocument.body;
  if (
    candidate.ownerDocument !== sourceDocument ||
    candidate === documentScrollOwner ||
    candidate === sourceDocument.documentElement ||
    candidate.isConnected === false ||
    isEditableScrollOwner(candidate)
  ) return undefined;
  const horizontal = signedBoundedAxis(
    finite(candidate.scrollLeft),
    finite(candidate.scrollWidth) - finite(candidate.clientWidth),
  );
  const vertical = signedBoundedAxis(
    finite(candidate.scrollTop),
    finite(candidate.scrollHeight) - finite(candidate.clientHeight),
  );
  return Object.freeze({
    scrollX: horizontal.position,
    scrollY: vertical.position,
    maxScrollX: horizontal.maximum,
    maxScrollY: vertical.maximum,
  });
}

/** Elements walked per scan; querySelectorAll('*') already materializes them. */
const MAX_SCROLLER_SCAN_ELEMENTS = 50_000;

/**
 * Walks the document and its shadow roots, open or closed, in order and
 * visits every element that is not at its scroll start (D122), so panes
 * scrolled before the mirror was built can be put at their place. Two number
 * reads an element, no style and no rectangle; the walk stops after
 * `MAX_SCROLLER_SCAN_ELEMENTS` elements, and a pane past that is picked up
 * when it next scrolls. Return false to stop.
 */
export function forEachScrolledElement(
  sourceDocument: Document,
  visit: (candidate: Element) => boolean,
): void {
  const roots: ParentNode[] = [sourceDocument];
  let rootIndex = 0;
  let walked = 0;
  while (rootIndex < roots.length) {
    const root = roots[rootIndex];
    rootIndex += 1;
    if (!root) continue;
    let candidates: NodeListOf<Element>;
    try {
      candidates = root.querySelectorAll('*');
    } catch {
      continue;
    }
    for (let index = 0; index < candidates.length; index += 1) {
      if (walked >= MAX_SCROLLER_SCAN_ELEMENTS) return;
      const candidate = candidates[index];
      if (!candidate) continue;
      walked += 1;
      const shadow = readSourceShadowRoot(candidate);
      if (shadow) roots.push(shadow);
      if (
        finite(candidate.scrollTop) === 0 && finite(candidate.scrollLeft) === 0
      ) continue;
      if (!visit(candidate)) return;
    }
  }
}

export function isDocumentScrollTarget(
  target: EventTarget | null | undefined,
  sourceDocument: Document,
  sourceWindow: Window,
): boolean {
  const documentScrollOwner = sourceDocument.scrollingElement ??
    sourceDocument.documentElement ?? sourceDocument.body;
  return target === sourceWindow || target === sourceDocument ||
    target === documentScrollOwner;
}

function isEditableScrollOwner(element: Element): boolean {
  for (
    let current: Element | null = element;
    current;
    current = composedParentElement(current)
  ) {
    const tag = current.localName.toLowerCase();
    if (tag === 'textarea' || tag === 'input' || tag === 'select') return true;
    const editable = current.getAttribute('contenteditable');
    if (editable !== null && editable.trim().toLowerCase() !== 'false') return true;
    const role = current.getAttribute('role');
    if (role && EDITABLE_SCROLL_ROLE.test(role)) return true;
    if (current === element.ownerDocument.body) break;
  }
  return false;
}

function composedParentElement(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  if (root.nodeType === 11 && 'host' in root) {
    const host = (root as ShadowRoot).host;
    if (host?.nodeType === 1) return host;
  }
  return null;
}

function safeRect(element: Element): DOMRect {
  try {
    const rect = element.getBoundingClientRect();
    if (
      Number.isFinite(rect.left) && Number.isFinite(rect.top) &&
      Number.isFinite(rect.right) && Number.isFinite(rect.bottom)
    ) return rect;
  } catch {
    // Fall back to the bounded client box below.
  }
  const width = positiveFinite(element.clientWidth, 0);
  const height = positiveFinite(element.clientHeight, 0);
  return {
    x: 0, y: 0, left: 0, top: 0, width, height,
    right: width, bottom: height, toJSON: () => ({}),
  };
}

function readOverflowY(
  element: Element,
  sourceWindow: NestedViewportLike,
): string | undefined {
  try {
    const value = sourceWindow.getComputedStyle?.(element).overflowY
      ?.trim().toLowerCase();
    if (value) return value;
  } catch {
    // Fall through to an explicit inline declaration.
  }
  const inline = element.getAttribute('style') ?? '';
  const longhand = /(?:^|;)\s*overflow-y\s*:\s*([^;!]+)/iu.exec(inline)?.[1];
  if (longhand) return longhand.trim().toLowerCase();
  const shorthand = /(?:^|;)\s*overflow\s*:\s*([^;!]+)/iu.exec(inline)?.[1];
  return shorthand?.trim().toLowerCase().split(/\s+/u).at(-1);
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function maximumFinite(...values: readonly unknown[]): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, finite(value));
  return maximum;
}

function documentAxisPosition(
  scrollingElementValue: unknown,
  windowValue: unknown,
): number {
  // Window and its current scrollingElement are two views of the same owner;
  // either can lag briefly during layout. Other, non-owning body/html nodes
  // are deliberately excluded.
  return Math.max(0, finite(scrollingElementValue), finite(windowValue));
}

function positiveFinite(...values: readonly unknown[]): number {
  for (const value of values) {
    const numeric = finite(value);
    if (numeric > 0) return numeric;
  }
  return 1;
}

/**
 * Keeps one axis inside the protocol bound without losing progress. Within the
 * bound, coordinates are exact CSS pixels. Beyond it, position and maximum are
 * scaled together, so a very long document still reports where the reader is
 * instead of pinning every later offset to the maximum.
 */
function boundedAxis(
  position: number,
  maximum: number,
): { readonly position: number; readonly maximum: number } {
  const rawMaximum = Math.max(0, maximum);
  const rawPosition = clamp(position, 0, rawMaximum);
  if (rawMaximum <= PRIMARY_SCROLL_MAX) {
    return { position: rawPosition, maximum: rawMaximum };
  }
  const scale = PRIMARY_SCROLL_MAX / rawMaximum;
  return {
    position: Math.round(rawPosition * scale),
    maximum: PRIMARY_SCROLL_MAX,
  };
}

/** A pane's axis: the sign of the offset is kept, its size is bounded. */
function signedBoundedAxis(
  position: number,
  maximum: number,
): { readonly position: number; readonly maximum: number } {
  const axis = boundedAxis(Math.abs(position), maximum);
  const rounded = Math.round(axis.position * 100) / 100;
  return {
    position: position < 0 && rounded > 0 ? -rounded : rounded,
    maximum: Math.round(axis.maximum * 100) / 100,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
