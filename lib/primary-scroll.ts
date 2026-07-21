export const PRIMARY_SCROLL_MAX = 100_000;

export type PrimaryScrollTarget = 'document' | 'nested';

const EDITABLE_SCROLL_ROLES = new Set(['combobox', 'searchbox', 'textbox']);

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
  const maxScrollX = bounded(Math.max(0, width - viewportWidth));
  const maxScrollY = bounded(Math.max(0, height - viewportHeight));
  return Object.freeze({
    scrollTarget: 'document',
    // document.scrollingElement is the browser's authoritative owner. Do not
    // take the largest coordinate from body/html: a former scrolling element
    // can retain a stale offset after a responsive layout switches owners.
    scrollX: clamp(
      documentAxisPosition(root?.scrollLeft, sourceWindow.scrollX),
      0,
      maxScrollX,
    ),
    scrollY: clamp(
      documentAxisPosition(root?.scrollTop, sourceWindow.scrollY),
      0,
      maxScrollY,
    ),
    maxScrollX,
    maxScrollY,
  });
}

/**
 * Accepts only a visible, viewport-scale vertical overflow region. This keeps
 * text controls, carousels, and incidental horizontal strips from taking over
 * source-scroll synchronization.
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
  const overflowY = readOverflowY(candidate, sourceWindow);
  if (overflowY === 'hidden' || overflowY === 'clip' || overflowY === 'visible') {
    return undefined;
  }

  const viewportWidth = positiveFinite(sourceWindow.innerWidth, 1);
  const viewportHeight = positiveFinite(sourceWindow.innerHeight, 1);
  const clientWidth = positiveFinite(candidate.clientWidth, 0);
  const clientHeight = positiveFinite(candidate.clientHeight, 0);
  const maxScrollX = bounded(Math.max(
    0,
    finite(candidate.scrollWidth) - clientWidth,
  ));
  const maxScrollY = bounded(Math.max(
    0,
    finite(candidate.scrollHeight) - clientHeight,
  ));
  if (maxScrollY < Math.max(96, viewportHeight * 0.2)) return undefined;

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
    scrollX: clamp(finite(candidate.scrollLeft), 0, maxScrollX),
    scrollY: clamp(finite(candidate.scrollTop), 0, maxScrollY),
    maxScrollX,
    maxScrollY,
  });
}

/** Finds the strongest generic replica/source candidate without site rules. */
export function findPrimaryNestedScroller(
  sourceDocument: Document,
  sourceWindow: NestedViewportLike,
  preferredOrdinal?: number,
): Element | undefined {
  let best: Element | undefined;
  let bestScore = -1;
  let preferred: Element | undefined;
  let qualifiedOrdinal = 0;
  const roots: ParentNode[] = [sourceDocument];
  let rootIndex = 0;
  let inspected = 0;
  while (rootIndex < roots.length && inspected < 5_000) {
    const root = roots[rootIndex];
    rootIndex += 1;
    if (!root) continue;
    let candidates: NodeListOf<Element>;
    try {
      candidates = root.querySelectorAll('*');
    } catch {
      continue;
    }
    for (
      let index = 0;
      index < candidates.length && inspected < 5_000;
      index += 1
    ) {
      const candidate = candidates[index];
      if (!candidate) continue;
      inspected += 1;
      if (candidate.shadowRoot) roots.push(candidate.shadowRoot);
      const snapshot = readNestedScrollSnapshot(
        candidate,
        sourceDocument,
        sourceWindow,
      );
      if (!snapshot) continue;
      if (qualifiedOrdinal === preferredOrdinal) preferred = candidate;
      qualifiedOrdinal += 1;
      const score = candidate.clientWidth * candidate.clientHeight *
        (1 + Math.log2(1 + snapshot.maxScrollY));
      if (score <= bestScore) continue;
      best = candidate;
      bestScore = score;
    }
  }
  return preferred ?? best;
}

/** Returns a bounded, content-free ordinal among currently qualified panes. */
export function nestedScrollerOrdinal(
  target: Element,
  sourceDocument: Document,
  sourceWindow: NestedViewportLike,
): number | undefined {
  const roots: ParentNode[] = [sourceDocument];
  let rootIndex = 0;
  let inspected = 0;
  let qualifiedOrdinal = 0;
  while (rootIndex < roots.length && inspected < 5_000) {
    const root = roots[rootIndex];
    rootIndex += 1;
    if (!root) continue;
    let candidates: NodeListOf<Element>;
    try {
      candidates = root.querySelectorAll('*');
    } catch {
      continue;
    }
    for (
      let index = 0;
      index < candidates.length && inspected < 5_000;
      index += 1
    ) {
      const candidate = candidates[index];
      if (!candidate) continue;
      inspected += 1;
      if (candidate.shadowRoot) roots.push(candidate.shadowRoot);
      if (!readNestedScrollSnapshot(candidate, sourceDocument, sourceWindow)) {
        continue;
      }
      if (candidate === target) return qualifiedOrdinal;
      qualifiedOrdinal += 1;
    }
  }
  return undefined;
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
    const roles = current.getAttribute('role')
      ?.trim()
      .toLowerCase()
      .split(/\s+/u) ?? [];
    if (roles.some((role) => EDITABLE_SCROLL_ROLES.has(role))) return true;
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
      [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
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
  return Math.max(0, ...values.map(finite));
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

function bounded(value: number): number {
  return Math.min(PRIMARY_SCROLL_MAX, Math.max(0, value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
