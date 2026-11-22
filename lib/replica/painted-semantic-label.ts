import { sourceContentEditableFact } from './source-secret-classifier';

export const PAINTED_SEMANTIC_LABEL_ATTRIBUTE =
  'data-simul-painted-semantic-label';
export const PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE =
  'data-simul-painted-semantic-label-overlay';

export const MAX_PAINTED_SEMANTIC_LABEL_TEXT = 3_500;
export const MIN_PAINTED_SEMANTIC_LABEL_DIMENSION_PX = 8;
export const MAX_PAINTED_SEMANTIC_LABEL_DIMENSION_PX = 8_192;
export const MAX_PAINTED_SEMANTIC_LABEL_AREA_PX = 4_000_000;

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_STRUCTURAL_DESCENDANTS = 256;
const MAX_STRUCTURAL_ANCESTORS = 64;
const MIN_LARGE_NEGATIVE_INDENT_PX = 64;
const CLIPPING_VALUES = new Set(['clip', 'hidden']);
const SENSITIVE_INPUT_TYPES = new Set(['file', 'hidden', 'password']);
const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'webauthn',
]);
const SENSITIVE_ROLES = new Set([
  'combobox',
  'searchbox',
  'spinbutton',
  'textbox',
]);

export interface PaintedSemanticLabelEnvironment {
  readonly getComputedStyle?: (element: Element) => CSSStyleDeclaration;
  readonly getBoundingClientRect?: (element: HTMLElement) => DOMRectReadOnly;
  /**
   * How far the document is scrolled, to place a box in document terms
   * (D173). The element's own window is asked when these are absent.
   */
  readonly scrollX?: number;
  readonly scrollY?: number;
}

export interface PaintedSemanticLabelCandidate {
  readonly element: HTMLElement;
  readonly sourceText: string;
  readonly width: number;
  readonly height: number;
}

interface ResolvedEnvironment {
  readonly getComputedStyle: (element: Element) => CSSStyleDeclaration;
  readonly getBoundingClientRect: (element: HTMLElement) => DOMRectReadOnly;
  readonly scrollX: number;
  readonly scrollY: number;
}

interface InspectedPaintedLabel {
  readonly element: HTMLElement;
  readonly sourceText: string;
  readonly width: number;
  readonly height: number;
  readonly positionIsStatic: boolean;
}

const candidateEnvironments = new WeakMap<
  PaintedSemanticLabelCandidate,
  ResolvedEnvironment
>();
const activePresentations = new WeakMap<HTMLElement, () => void>();
/** The overlay each presentation shows, wherever it stands. */
const activeOverlays = new WeakMap<HTMLElement, HTMLElement>();
/**
 * The closed root Simul gave a host to hold its label (D178), kept for the
 * next presentation: a root cannot be taken off again, and with only a
 * `<slot>` left in it the host draws as it did without one.
 */
const ownedLabelRoots = new WeakMap<HTMLElement, ShadowRoot>();
/**
 * The tags `attachShadow` accepts besides custom elements and `body`. A
 * custom element is left alone: the page may give it a root later, which
 * the mirror then builds on it.
 */
const LABEL_ROOT_HOST_TAGS: ReadonlySet<string> = new Set([
  'article', 'aside', 'blockquote', 'div', 'footer', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span',
]);

/**
 * Normalizes only bounded, human-readable direct label text. This is not an
 * accessible-name algorithm: descendants are intentionally excluded by the
 * detector so hidden or private subtrees cannot become image evidence.
 */
export function normalizePaintedSemanticLabelText(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (
    text.length === 0 ||
    text.length > MAX_PAINTED_SEMANTIC_LABEL_TEXT ||
    !/[\p{L}\p{N}]/u.test(text) ||
    isUrlOrFileOnlyLabel(text)
  ) return undefined;
  return text;
}

/**
 * Reads the host's current direct text in DOM order. The isolated engine uses this
 * after applying an individual text projection so a painted label with more
 * than one direct text node presents the whole progressively translated label
 * instead of whichever fragment happened to update last.
 */
export function aggregatePaintedSemanticLabelText(
  element: Element | null | undefined,
): string | undefined {
  return element?.namespaceURI === HTML_NAMESPACE
    ? readDirectSemanticText(element as HTMLElement)
    : undefined;
}

function isUrlOrFileOnlyLabel(text: string): boolean {
  if (/\s/u.test(text)) return false;
  if (/^(?:\/\/|[a-z][a-z0-9+.-]*:[^\s]*)$/iu.test(text)) return true;
  if (/^www\.[^\s/\\?#]+(?:[/?#][^\s]*)?$/iu.test(text)) return true;
  if (/^(?:[a-z]:[\\/]|[./\\]|[^/\\?#]+[\\/])[^\s]*$/iu.test(text)) {
    return true;
  }
  return /^[^\s/\\?#]+\.[\p{L}\p{N}]{1,16}(?:[?#][^\s]*)?$/iu.test(text);
}

/**
 * Admits the narrow "image-painted label" shape used by CSS logo links. The
 * returned proof deliberately contains neither the background URL nor other
 * page identity. Callers must still apply their normal translation revision
 * guards before presenting a result.
 */
export function detectPaintedSemanticLabel(
  input: Element,
  environment: PaintedSemanticLabelEnvironment = {},
): PaintedSemanticLabelCandidate | undefined {
  const resolved = resolveEnvironment(input, environment);
  if (!resolved) return undefined;
  const inspected = inspectPaintedSemanticLabel(input, resolved);
  if (!inspected) return undefined;
  const candidate = Object.freeze({
    element: inspected.element,
    sourceText: inspected.sourceText,
    width: inspected.width,
    height: inspected.height,
  });
  candidateEnvironments.set(candidate, resolved);
  return candidate;
}

/**
 * Adds one owned, inert overlay to a freshly detected replica candidate.
 * Source text and the background remain untouched. The cleanup restores only
 * inline properties still owned by this presentation.
 */
export function presentPaintedSemanticLabel(
  candidate: PaintedSemanticLabelCandidate,
  translatedText: unknown,
): (() => void) | undefined {
  const environment = candidateEnvironments.get(candidate);
  const text = normalizePaintedSemanticLabelText(translatedText);
  if (!environment || !text) return undefined;

  const current = inspectPaintedSemanticLabel(candidate.element, environment);
  if (!current || current.sourceText !== candidate.sourceText) return undefined;
  const element = current.element;
  if (
    activePresentations.has(element) ||
    element.hasAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE) ||
    hasOwnedOverlayChild(element)
  ) return undefined;

  const style = element.style;
  const originalPointerEvents = inlineStyleSnapshot(style, 'pointer-events');
  const originalPosition = inlineStyleSnapshot(style, 'position');
  const overlay = element.ownerDocument.createElement('span');

  element.setAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE, 'v1');
  style.setProperty('pointer-events', 'none', 'important');
  if (current.positionIsStatic) {
    style.setProperty('position', 'relative', 'important');
  }

  overlay.setAttribute(PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE, 'v1');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('dir', 'auto');
  overlay.textContent = text;
  applyOverlayStyle(overlay.style);
  // Out of sight of the page's selectors where the host can have a root of
  // its own (D178): appended to the host, the label was its last child, and
  // a rule on its last or only child changed. A link cannot have one.
  const labelRoot = ownedLabelRoot(element);
  (labelRoot ?? element).append(overlay);
  activeOverlays.set(element, overlay);

  let active = true;
  const cleanup = (): void => {
    if (!active) return;
    active = false;
    if (activePresentations.get(element) === cleanup) {
      activePresentations.delete(element);
    }
    if (activeOverlays.get(element) === overlay) activeOverlays.delete(element);
    if (overlay.parentNode === element || overlay.parentNode === labelRoot) {
      overlay.remove();
    }
    if (element.getAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE) === 'v1') {
      element.removeAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE);
    }
    restoreOwnedInlineStyle(
      style,
      'pointer-events',
      'none',
      originalPointerEvents,
    );
    if (current.positionIsStatic) {
      restoreOwnedInlineStyle(
        style,
        'position',
        'relative',
        originalPosition,
      );
    }
  };
  activePresentations.set(element, cleanup);
  return cleanup;
}

/** Removes only a presentation created by this module's current runtime. */
export function removePaintedSemanticLabelPresentation(
  element: Element | null | undefined,
): boolean {
  if (!element || element.namespaceURI !== HTML_NAMESPACE) return false;
  const cleanup = activePresentations.get(element as HTMLElement);
  if (!cleanup) return false;
  cleanup();
  return true;
}

/**
 * Detects after an exact text projection and creates or refreshes the owned
 * visual label. This never scans descendant text and never mutates source
 * content; it is safe to call after repeated live translation projections.
 */
export function synchronizePaintedSemanticLabelPresentation(
  element: Element | null | undefined,
  translatedText: unknown,
  environment: PaintedSemanticLabelEnvironment = {},
): boolean {
  if (!element) return false;
  const text = normalizePaintedSemanticLabelText(translatedText);
  if (!text) {
    removePaintedSemanticLabelPresentation(element);
    return false;
  }
  const candidate = detectPaintedSemanticLabel(element, environment);
  if (!candidate) {
    removePaintedSemanticLabelPresentation(element);
    return false;
  }
  const host = candidate.element;
  const existing = activeOverlays.get(host);
  if (
    activePresentations.has(host) &&
    host.getAttribute(PAINTED_SEMANTIC_LABEL_ATTRIBUTE) === 'v1' &&
    existing?.namespaceURI === HTML_NAMESPACE
  ) {
    existing.textContent = text;
    return true;
  }
  removePaintedSemanticLabelPresentation(host);
  return Boolean(presentPaintedSemanticLabel(candidate, text));
}

function resolveEnvironment(
  input: Element,
  environment: PaintedSemanticLabelEnvironment,
): ResolvedEnvironment | undefined {
  const view = input.ownerDocument?.defaultView;
  let getComputedStyle = environment.getComputedStyle;
  if (!getComputedStyle && view && typeof view.getComputedStyle === 'function') {
    getComputedStyle = (element) => view.getComputedStyle(element);
  }
  if (!getComputedStyle) return undefined;
  const getBoundingClientRect = environment.getBoundingClientRect ??
    ((element: HTMLElement) => element.getBoundingClientRect());
  return {
    getComputedStyle,
    getBoundingClientRect,
    scrollX: finiteOrZero(environment.scrollX ?? view?.scrollX),
    scrollY: finiteOrZero(environment.scrollY ?? view?.scrollY),
  };
}

function inspectPaintedSemanticLabel(
  input: Element,
  environment: ResolvedEnvironment,
): InspectedPaintedLabel | undefined {
  if (!isConnectedHtmlElement(input)) return undefined;
  const element = input;

  let style: CSSStyleDeclaration;
  let rect: DOMRectReadOnly;
  try {
    style = environment.getComputedStyle(element);
    rect = environment.getBoundingClientRect(element);
  } catch {
    return undefined;
  }
  if (
    !style ||
    !isVisiblePaintedBox(style, rect, environment) ||
    hasHiddenOrMaskedAncestor(element, environment) ||
    hasSensitiveStructuralBoundary(element) ||
    !safePaintedBackgroundImage(
      styleValue(style, 'background-image', 'backgroundImage'),
      element.ownerDocument.baseURI,
    ) ||
    !hasHorizontalOverflowClipping(style) ||
    !hasLargeNegativeTextIndent(style, rect.width)
  ) return undefined;

  const sourceText = readDirectSemanticText(element);
  if (!sourceText) return undefined;
  return {
    element,
    sourceText,
    width: rect.width,
    height: rect.height,
    positionIsStatic:
      ['', 'static'].includes(styleValue(style, 'position', 'position')),
  };
}

function isConnectedHtmlElement(input: Element): input is HTMLElement {
  return input.namespaceURI === HTML_NAMESPACE &&
    input.isConnected === true &&
    typeof (input as HTMLElement).style?.setProperty === 'function';
}

function isVisiblePaintedBox(
  style: CSSStyleDeclaration,
  rect: DOMRectReadOnly,
  environment: ResolvedEnvironment,
): boolean {
  const values = [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height];
  if (!values.every(Number.isFinite)) return false;
  if (
    rect.width < MIN_PAINTED_SEMANTIC_LABEL_DIMENSION_PX ||
    rect.height < MIN_PAINTED_SEMANTIC_LABEL_DIMENSION_PX ||
    rect.width > MAX_PAINTED_SEMANTIC_LABEL_DIMENSION_PX ||
    rect.height > MAX_PAINTED_SEMANTIC_LABEL_DIMENSION_PX ||
    rect.width * rect.height > MAX_PAINTED_SEMANTIC_LABEL_AREA_PX
  ) return false;
  if (
    ['none', 'contents'].includes(styleValue(style, 'display', 'display')) ||
    ['hidden', 'collapse'].includes(
      styleValue(style, 'visibility', 'visibility'),
    ) ||
    styleValue(style, 'content-visibility', 'contentVisibility') === 'hidden'
  ) return false;
  const opacity = styleValue(style, 'opacity', 'opacity');
  if (opacity !== '') {
    const parsedOpacity = Number(opacity);
    if (!Number.isFinite(parsedOpacity) || parsedOpacity <= 0) return false;
  }
  // Off the page, not out of view (D173): a logo below the first screen, or
  // scrolled away when a patch makes its label be looked at again, keeps its
  // label. Only a box placed left of the document or above it (the way a page
  // hides a skip link) is passed over; the mirror is never scrolled to it.
  if (
    rect.right + environment.scrollX <= 0 ||
    rect.bottom + environment.scrollY <= 0
  ) return false;
  return true;
}

function hasHiddenOrMaskedAncestor(
  element: HTMLElement,
  environment: ResolvedEnvironment,
): boolean {
  let current: Element | null = element;
  let inspected = 0;
  while (current) {
    inspected += 1;
    if (inspected > MAX_STRUCTURAL_ANCESTORS) return true;
    try {
      if (
        current.hasAttribute('hidden') ||
        current.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true'
      ) return true;
      const style = environment.getComputedStyle(current);
      if (
        !style ||
        ['none', 'contents'].includes(styleValue(style, 'display', 'display')) ||
        ['hidden', 'collapse'].includes(
          styleValue(style, 'visibility', 'visibility'),
        ) ||
        styleValue(style, 'content-visibility', 'contentVisibility') ===
          'hidden' ||
        hasInvisibleOpacity(style) ||
        hasMaskedComputedText(style)
      ) return true;
    } catch {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function hasInvisibleOpacity(style: CSSStyleDeclaration): boolean {
  const opacity = styleValue(style, 'opacity', 'opacity');
  if (opacity === '') return false;
  const parsed = Number(opacity);
  return !Number.isFinite(parsed) || parsed <= 0;
}

function hasSensitiveStructuralBoundary(element: HTMLElement): boolean {
  let ancestor: Element | null = element;
  let inspectedAncestors = 0;
  while (ancestor) {
    inspectedAncestors += 1;
    if (
      inspectedAncestors > MAX_STRUCTURAL_ANCESTORS ||
      elementHasSensitiveStructure(ancestor)
    ) return true;
    ancestor = ancestor.parentElement;
  }

  const pending: Element[] = [];
  for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
    pending.push(child);
  }
  let inspectedDescendants = 0;
  while (pending.length > 0) {
    const descendant = pending.pop()!;
    inspectedDescendants += 1;
    if (
      inspectedDescendants > MAX_STRUCTURAL_DESCENDANTS ||
      elementHasSensitiveStructure(descendant)
    ) return true;
    for (
      let child = descendant.lastElementChild;
      child;
      child = child.previousElementSibling
    ) pending.push(child);
  }
  return false;
}

function elementHasSensitiveStructure(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  if (['input', 'option', 'select', 'textarea'].includes(tagName)) return true;
  const type = safelyReadAttribute(element, 'type').toLowerCase();
  if (SENSITIVE_INPUT_TYPES.has(type)) return true;
  // A bare attribute is an editor too (D145).
  const contentEditable = safelyHasAttribute(element, 'contenteditable')
    ? sourceContentEditableFact(safelyReadAttribute(element, 'contenteditable'))
    : '';
  if (contentEditable !== '' && contentEditable.toLowerCase() !== 'false') {
    return true;
  }
  const role = safelyReadAttribute(element, 'role').toLowerCase().split(/\s+/u);
  if (role.some((token) => SENSITIVE_ROLES.has(token))) return true;
  const autocomplete = safelyReadAttribute(element, 'autocomplete')
    .toLowerCase()
    .split(/\s+/u);
  return autocomplete.some((token) =>
    SENSITIVE_AUTOCOMPLETE_TOKENS.has(token) || token.startsWith('cc-'));
}

function safelyHasAttribute(element: Element, name: string): boolean {
  try {
    return element.hasAttribute(name);
  } catch {
    // Unreadable structural metadata is not proof that text is public.
    return true;
  }
}

function safelyReadAttribute(element: Element, name: string): string {
  try {
    return element.getAttribute(name)?.trim() ?? '';
  } catch {
    // Unreadable structural metadata is not proof that text is public.
    return name === 'type' ? 'password' : 'current-password';
  }
}

function hasMaskedComputedText(style: CSSStyleDeclaration): boolean {
  const security = styleValue(
    style,
    '-webkit-text-security',
    'webkitTextSecurity',
  );
  return security !== '' && security !== 'none';
}

function safePaintedBackgroundImage(
  value: string,
  baseUri: string,
): boolean {
  const rawUrl = singleCssUrl(value);
  if (!rawUrl || rawUrl.startsWith('#')) return false;
  try {
    const url = new URL(rawUrl, baseUri);
    if (url.protocol === 'http:' || url.protocol === 'https:') return true;
    if (url.protocol !== 'chrome-extension:') return false;
    const base = new URL(baseUri);
    return base.protocol === 'chrome-extension:' &&
      base.hostname.length > 0 &&
      url.hostname === base.hostname;
  } catch {
    return false;
  }
}

function singleCssUrl(value: string): string | undefined {
  const normalized = value.trim();
  const doubleQuoted = /^url\(\s*"([^"\\]*)"\s*\)$/iu.exec(normalized);
  if (doubleQuoted?.[1]) return doubleQuoted[1].trim();
  const singleQuoted = /^url\(\s*'([^'\\]*)'\s*\)$/iu.exec(normalized);
  if (singleQuoted?.[1]) return singleQuoted[1].trim();
  const unquoted = /^url\(\s*([^"'()\\\s][^()\\]*?)\s*\)$/iu.exec(normalized);
  return unquoted?.[1]?.trim() || undefined;
}

function hasHorizontalOverflowClipping(style: CSSStyleDeclaration): boolean {
  const overflowX = styleValue(style, 'overflow-x', 'overflowX');
  const overflow = styleValue(style, 'overflow', 'overflow');
  return CLIPPING_VALUES.has(overflowX) || CLIPPING_VALUES.has(overflow);
}

function hasLargeNegativeTextIndent(
  style: CSSStyleDeclaration,
  width: number,
): boolean {
  const indent = cssLengthInPixels(
    styleValue(style, 'text-indent', 'textIndent'),
    styleValue(style, 'font-size', 'fontSize'),
    width,
  );
  return indent !== undefined &&
    indent <= -Math.max(MIN_LARGE_NEGATIVE_INDENT_PX, width * 0.75);
}

function cssLengthInPixels(
  value: string,
  fontSizeValue: string,
  percentageBasis: number,
): number | undefined {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|em|rem|%)$/iu.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  switch (match[2].toLowerCase()) {
    case 'px':
      return amount;
    case '%':
      return percentageBasis * amount / 100;
    case 'em':
    case 'rem': {
      const fontSize = /^((?:\d+\.?\d*|\.\d+))px$/iu.exec(
        fontSizeValue.trim(),
      );
      if (!fontSize?.[1]) return undefined;
      const pixels = Number(fontSize[1]);
      return Number.isFinite(pixels) && pixels > 0 ? amount * pixels : undefined;
    }
    default:
      return undefined;
  }
}

function readDirectSemanticText(element: HTMLElement): string | undefined {
  let output = '';
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 3) continue;
    const value = child.nodeValue ?? '';
    const remaining = MAX_PAINTED_SEMANTIC_LABEL_TEXT + 1 - output.length;
    if (remaining <= 0) return undefined;
    output += value.slice(0, remaining);
    if (value.length > remaining) return undefined;
  }
  return normalizePaintedSemanticLabelText(output);
}

/** The text of the label Simul shows over `element`, if it shows one. */
export function readPaintedSemanticLabelOverlayText(
  element: Element | null | undefined,
): string | undefined {
  if (!element || element.namespaceURI !== HTML_NAMESPACE) return undefined;
  return activeOverlays.get(element as HTMLElement)?.textContent ?? undefined;
}

/**
 * A closed root of Simul's own on the host, with a `<slot>` that draws the
 * host's children as before; undefined where the host cannot have a root
 * (a link, a list item) or already has one (a component of the page).
 * Should the page give such a host a root later, the mirror cannot build it
 * there: that patch fails and the mirror is read again whole.
 */
function ownedLabelRoot(element: HTMLElement): ShadowRoot | undefined {
  const kept = ownedLabelRoots.get(element);
  if (kept) return kept;
  if (
    !LABEL_ROOT_HOST_TAGS.has(element.localName.toLowerCase()) ||
    element.shadowRoot
  ) return undefined;
  let root: ShadowRoot;
  try {
    root = element.attachShadow({ mode: 'closed' });
  } catch {
    return undefined;
  }
  root.append(element.ownerDocument.createElement('slot'));
  ownedLabelRoots.set(element, root);
  return root;
}

function hasOwnedOverlayChild(element: HTMLElement): boolean {
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
    if (child.hasAttribute(PAINTED_SEMANTIC_LABEL_OVERLAY_ATTRIBUTE)) return true;
  }
  return false;
}

function applyOverlayStyle(style: CSSStyleDeclaration): void {
  const declarations: ReadonlyArray<readonly [string, string]> = [
    ['align-items', 'center'],
    ['background', 'rgba(0, 0, 0, 0.72)'],
    ['box-sizing', 'border-box'],
    ['color', '#fff'],
    ['display', 'flex'],
    ['font', 'inherit'],
    ['inset', '0'],
    ['justify-content', 'center'],
    ['line-height', '1.12'],
    ['max-height', '100%'],
    ['max-width', '100%'],
    ['overflow', 'hidden'],
    ['overflow-wrap', 'anywhere'],
    ['padding', '2px'],
    ['pointer-events', 'none'],
    ['position', 'absolute'],
    ['text-align', 'center'],
    ['text-indent', '0'],
    ['user-select', 'none'],
    ['white-space', 'normal'],
    ['word-break', 'break-word'],
    // No z-index: the label paints above its host's own content but under
    // whatever the page draws over the host, such as a pop-up (D74).
  ];
  for (const [property, value] of declarations) {
    style.setProperty(property, value, 'important');
  }
}

interface InlineStyleSnapshot {
  readonly value: string;
  readonly priority: string;
}

function inlineStyleSnapshot(
  style: CSSStyleDeclaration,
  property: string,
): InlineStyleSnapshot {
  return {
    value: style.getPropertyValue(property),
    priority: readInlineStylePriority(style, property) ?? '',
  };
}

function restoreOwnedInlineStyle(
  style: CSSStyleDeclaration,
  property: string,
  ownedValue: string,
  original: InlineStyleSnapshot,
): void {
  const priority = readInlineStylePriority(style, property);
  if (
    style.getPropertyValue(property).trim().toLowerCase() !== ownedValue ||
    (priority !== undefined && priority !== 'important')
  ) return;
  if (original.value === '') style.removeProperty(property);
  else style.setProperty(property, original.value, original.priority);
}

function readInlineStylePriority(
  style: CSSStyleDeclaration,
  property: string,
): string | undefined {
  const getter = (style as unknown as {
    readonly getPropertyPriority?: unknown;
  }).getPropertyPriority;
  if (typeof getter !== 'function') return undefined;
  try {
    return getter.call(style, property);
  } catch {
    return undefined;
  }
}

function styleValue(
  style: CSSStyleDeclaration,
  property: string,
  camelProperty: string,
): string {
  try {
    const declared = style.getPropertyValue(property).trim().toLowerCase();
    if (declared !== '') return declared;
  } catch {
    return '';
  }
  try {
    const value = (style as unknown as Record<string, unknown>)[camelProperty];
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
