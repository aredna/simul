/**
 * "Keep geometry" for the translated replica: every box that shows translated
 * text keeps the size it has with the page's own text, so nothing around it
 * moves, and translated text that no longer fits is shrunk until it does.
 */

/** One translated text the lock can show in either language. */
export interface TranslatedGeometryEntry {
  /** The translated text node, or the control whose value is translated. */
  readonly node: Node;
  showSource(): void;
  showTranslation(): void;
}

export interface TranslatedGeometryView {
  getComputedStyle(element: Element): CSSStyleDeclaration;
}

/** Marks a Simul-owned lock inside a replica element's inline style. */
export const GEOMETRY_LOCK_MARKER = '--simul-geometry-lock';
const GEOMETRY_LOCK_VALUE = '1';
/** Translated text is not shrunk below half of the page's size. */
export const MIN_TRANSLATED_FONT_SCALE = 0.5;
const MAX_FIT_PASSES = 5;
/** After the first estimate, each pass shrinks at least this much more. */
const MIN_FIT_STEP = 0.96;
const MAX_LOCKED_BOXES = 10_000;
const MAX_LAYOUT_DEPTH = 64;

const LOCKED_PROPERTIES = [
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'font-size',
  'line-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  GEOMETRY_LOCK_MARKER,
] as const;

/** Spacing that `em` ties to the font; it stays at the page's size. */
const SPACING_PROPERTIES = [
  ['margin-top', 'marginTop'],
  ['margin-right', 'marginRight'],
  ['margin-bottom', 'marginBottom'],
  ['margin-left', 'marginLeft'],
  ['padding-top', 'paddingTop'],
  ['padding-right', 'paddingRight'],
  ['padding-bottom', 'paddingBottom'],
  ['padding-left', 'paddingLeft'],
] as const;

interface SavedDeclaration {
  readonly value: string;
  readonly priority: string;
}

interface SourceBox {
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly lineHeight: number | undefined;
  /** The page's used margins and padding, in pixels. */
  readonly spacing: readonly (readonly [string, string])[];
  /**
   * A table cell's size is only a minimum, so it grows rather than overflows
   * and its growth moves the page; a locked box's overflow moves nothing.
   */
  readonly slack: number;
  /** What the page's own text needed; overflowing the page's way still fits. */
  readonly neededWidth: number;
  readonly neededHeight: number;
}

export class TranslatedGeometryLock {
  /** The page's own declarations, kept for as long as the element lives. */
  readonly #pageDeclarations = new WeakMap<HTMLElement, Map<string, SavedDeclaration>>();
  readonly #locked = new Set<HTMLElement>();

  get lockedCount(): number {
    return this.#locked.size;
  }

  /** Returns every locked box to the page's own styles. */
  release(): void {
    for (const element of this.#locked) this.#unlock(element);
    this.#locked.clear();
  }

  /**
   * Measures every box holding translated text with the page's text in
   * place, locks it at that size, then shrinks translated text that
   * overflows it. Runs in one task, so the page text never paints.
   */
  lock(
    entries: readonly TranslatedGeometryEntry[],
    view: TranslatedGeometryView,
  ): void {
    this.release();
    if (entries.length === 0) return;
    const boxes = new Map<HTMLElement, SourceBox>();
    for (const entry of entries) entry.showSource();
    try {
      const displays = new Map<Element, string>();
      for (const entry of entries) {
        if (boxes.size >= MAX_LOCKED_BOXES) break;
        const box = layoutBox(entry.node, view, displays);
        if (!box || boxes.has(box)) continue;
        const measured = measureSourceBox(box, view);
        if (measured) boxes.set(box, measured);
      }
    } finally {
      for (const entry of entries) entry.showTranslation();
    }
    for (const [box, source] of boxes) this.#lockBox(box, source);
    this.#fit(boxes);
  }

  #lockBox(box: HTMLElement, source: SourceBox): void {
    const style = box.style;
    // A restored style attribute (a disclosure closing, a patch rollback) can
    // bring back an earlier lock; its page values are the ones saved then.
    const earlier = this.#pageDeclarations.get(box);
    if (!earlier || !hasLockMarker(style)) {
      const saved = new Map<string, SavedDeclaration>();
      for (const property of LOCKED_PROPERTIES) {
        saved.set(property, {
          value: style.getPropertyValue(property),
          priority: typeof style.getPropertyPriority === 'function'
            ? style.getPropertyPriority(property)
            : '',
        });
      }
      this.#pageDeclarations.set(box, saved);
    }
    this.#locked.add(box);
    style.setProperty(GEOMETRY_LOCK_MARKER, GEOMETRY_LOCK_VALUE);
    // The used size in the box's own box-sizing: padding and borders stay as
    // the page has them (collapsed table borders included).
    setImportant(style, 'width', px(source.width));
    setImportant(style, 'height', px(source.height));
    setImportant(style, 'min-width', '0');
    setImportant(style, 'min-height', '0');
    setImportant(style, 'max-width', 'none');
    setImportant(style, 'max-height', 'none');
    setImportant(style, 'flex-grow', '0');
    setImportant(style, 'flex-shrink', '0');
    setImportant(style, 'flex-basis', 'auto');
  }

  #unlock(element: HTMLElement): void {
    const style = element.style;
    // A patch that rewrote the style attribute already put the page's
    // current declarations back; restoring older ones would undo them.
    if (!hasLockMarker(style)) return;
    const saved = this.#pageDeclarations.get(element);
    for (const property of LOCKED_PROPERTIES) {
      const declaration = saved?.get(property);
      if (declaration?.value) {
        style.setProperty(property, declaration.value, declaration.priority);
      } else {
        style.removeProperty(property);
      }
    }
    if (!element.getAttribute('style')?.trim()) element.removeAttribute('style');
  }

  /** Shrinks translated text until it fits the page's box, a few layouts at most. */
  #fit(boxes: ReadonlyMap<HTMLElement, SourceBox>): void {
    const scales = new Map<HTMLElement, number>();
    let pending = [...boxes.keys()];
    for (let pass = 0; pass < MAX_FIT_PASSES && pending.length > 0; pass += 1) {
      const next: [HTMLElement, number][] = [];
      for (const box of pending) {
        const source = boxes.get(box);
        if (!source) continue;
        const ratio = fitRatio(box, source);
        const current = scales.get(box) ?? 1;
        if (ratio >= 0.995 || current <= MIN_TRANSLATED_FONT_SCALE) continue;
        // Text reflows by whole lines, so the estimate can fall just short.
        const step = pass === 0 ? ratio : Math.min(ratio, MIN_FIT_STEP);
        next.push([box, Math.max(MIN_TRANSLATED_FONT_SCALE, current * step)]);
      }
      for (const [box, scale] of next) {
        const source = boxes.get(box);
        if (!source) continue;
        if (!scales.has(box)) {
          for (const [property, value] of source.spacing) {
            setImportant(box.style, property, value);
          }
        }
        scales.set(box, scale);
        setImportant(box.style, 'font-size', px(source.fontSize * scale));
        if (source.lineHeight !== undefined) {
          setImportant(box.style, 'line-height', px(source.lineHeight * scale));
        }
      }
      pending = next.map(([box]) => box);
    }
  }
}

/** The nearest element that lays text out in its own box. */
function layoutBox(
  node: Node,
  view: TranslatedGeometryView,
  displays: Map<Element, string>,
): HTMLElement | undefined {
  let current: Element | undefined = node.nodeType === 1
    ? node as Element
    : composedParentElement(node);
  for (let depth = 0; current && depth < MAX_LAYOUT_DEPTH; depth += 1) {
    const name = current.localName.toLowerCase();
    // Options size their select and SVG text sits on its own canvas; the
    // select facsimile and the drawing keep their own geometry.
    if (
      name === 'option' || name === 'optgroup' ||
      current.namespaceURI === 'http://www.w3.org/2000/svg'
    ) return undefined;
    let display = displays.get(current);
    if (display === undefined) {
      display = readDisplay(current, view);
      displays.set(current, display);
    }
    if (display === 'none' || display === '') return undefined;
    if (display !== 'inline' && display !== 'contents') {
      return 'style' in current ? current as HTMLElement : undefined;
    }
    current = composedParentElement(current);
  }
  return undefined;
}

function measureSourceBox(
  box: HTMLElement,
  view: TranslatedGeometryView,
): SourceBox | undefined {
  let style: CSSStyleDeclaration;
  try {
    style = view.getComputedStyle(box);
  } catch {
    return undefined;
  }
  const width = length(style.width);
  const height = length(style.height);
  const fontSize = length(style.fontSize);
  if (!(width > 0) || !(height > 0) || !(fontSize > 0)) return undefined;
  const lineHeight = style.lineHeight.trim().endsWith('px')
    ? length(style.lineHeight)
    : undefined;
  const spacing = SPACING_PROPERTIES.flatMap(([property, key]) => {
    const value = style[key];
    return typeof value === 'string' && value.trim().endsWith('px')
      ? [[property, value.trim()] as const]
      : [];
  });
  return {
    width,
    height,
    fontSize,
    lineHeight: lineHeight && lineHeight > 0 ? lineHeight : undefined,
    spacing,
    slack: style.display.trim().toLowerCase() === 'table-cell' ? 0.5 : 1,
    neededWidth: Math.max(finite(box.scrollWidth), finite(box.clientWidth)),
    neededHeight: Math.max(finite(box.scrollHeight), finite(box.clientHeight)),
  };
}

/**
 * How much translated text must shrink to need no more room than the page's
 * text did. Wrapping text shrinks in both directions, so a height overflow
 * takes the square root; a line that cannot wrap shrinks with its width.
 */
function fitRatio(box: HTMLElement, source: SourceBox): number {
  const neededHeight = Math.max(finite(box.scrollHeight), finite(box.clientHeight));
  const neededWidth = Math.max(finite(box.scrollWidth), finite(box.clientWidth));
  const height = neededHeight > source.neededHeight + source.slack
    ? Math.sqrt(source.neededHeight / neededHeight)
    : 1;
  const width = neededWidth > source.neededWidth + source.slack
    ? source.neededWidth / neededWidth
    : 1;
  return Math.min(height, width);
}

function readDisplay(element: Element, view: TranslatedGeometryView): string {
  try {
    return view.getComputedStyle(element).display.trim().toLowerCase();
  } catch {
    return '';
  }
}

function composedParentElement(node: Node): Element | undefined {
  if (node.parentElement) return node.parentElement;
  const root = node.parentNode;
  if (root?.nodeType === 11 && 'host' in root) {
    const host = (root as ShadowRoot).host;
    if (host?.nodeType === 1) return host;
  }
  return undefined;
}

/** An inline `all: initial` reads back as `initial` for every custom property. */
function hasLockMarker(style: CSSStyleDeclaration): boolean {
  return style.getPropertyValue(GEOMETRY_LOCK_MARKER).trim() === GEOMETRY_LOCK_VALUE;
}

function setImportant(
  style: CSSStyleDeclaration,
  property: string,
  value: string,
): void {
  style.setProperty(property, value, 'important');
}

function length(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function px(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}
