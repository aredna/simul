import { readSourceFlatTreeElementPath } from './source-privacy-policy';

/**
 * What the computed style cannot say about an element under something
 * hidden: whether the element is hidden by a rule of its own.
 *
 * `visibility` is inherited, so under a parent that is `visibility: hidden`
 * every element computes to hidden, its own rule or not. And under
 * `display: none` an element has no box, and Chrome computes its `transform`
 * to `none` whatever the page wrote. A dropdown in a site menu's collapsed
 * panel is drawn when the mirror opens the panel for the reader, unless the
 * page hides it by a rule of its own (a backing field under a custom
 * dropdown): there the page's own style rules, and the element's style
 * attribute, are asked.
 */

const MAX_SOURCE_HIDING_RULES_READ = 50_000;
const MAX_SOURCE_HIDING_RULES_KEPT = 512;

interface SourceHidingRule {
  readonly selector: string;
  readonly visibility: boolean;
  readonly scale: boolean;
  /** The media conditions around the rule: asked when the rule is. */
  readonly media: readonly string[];
}

interface SourceHidingRuleSet {
  readonly sheets: readonly CSSStyleSheet[];
  /** How many rules each sheet held when it was read; -1 for unreadable. */
  readonly sizes: readonly number[];
  readonly rules: readonly SourceHidingRule[];
}

/**
 * The rules of one tree that hide by `visibility` or scale to nothing, kept
 * for as long as the tree has the same sheets with the same number of rules:
 * a page changes its classes at every turn and its sheets hardly ever, and
 * reading every rule again at each change of the page cost more than all
 * the rest of this.
 */
const keptHidingRules = new WeakMap<Node, SourceHidingRuleSet>();

/**
 * The trees whose sheets were compared in this run of the reader, which the
 * page cannot interrupt: no sheet can change before the microtask that
 * forgets them.
 */
let checkedHidingRules: WeakMap<Node, readonly SourceHidingRule[]> | undefined;

/**
 * Whether the element's own `visibility` hides it. Where its parent is not
 * hidden by `visibility` the computed style says so; under a hidden parent,
 * only a style rule that names the element, or its style attribute, does.
 */
export function sourceElementHidesItselfByVisibility(element: Element): boolean {
  const view = element.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  try {
    if (!hidesByVisibility(view.getComputedStyle(element).visibility)) return false;
    const parent = readSourceFlatTreeElementPath(element)?.[1];
    if (!parent || !hidesByVisibility(view.getComputedStyle(parent).visibility)) {
      return true;
    }
    return sourceElementDeclares(element, 'visibility');
  } catch {
    return false;
  }
}

/**
 * Whether a style rule that names the element, or its style attribute,
 * scales it to nothing (`transform: scale(0)`, `scale: 0`). For an element
 * with no box, whose computed transform says nothing.
 */
export function sourceElementScalesItselfToNothing(element: Element): boolean {
  try {
    return sourceElementDeclares(element, 'scale');
  } catch {
    return false;
  }
}

function sourceElementDeclares(
  element: Element,
  what: 'visibility' | 'scale',
): boolean {
  const inline = (element as Partial<HTMLElement>).style;
  if (inline && declares(inline, what)) return true;
  const view = element.ownerDocument?.defaultView;
  for (const rule of sourceHidingRules(element.getRootNode())) {
    if (!rule[what]) continue;
    try {
      if (
        element.matches(rule.selector) &&
        rule.media.every((query) => view?.matchMedia(query).matches !== false)
      ) return true;
    } catch {
      // A selector this element cannot be asked about names something else.
    }
  }
  return false;
}

function sourceHidingRules(root: Node): readonly SourceHidingRule[] {
  if (!checkedHidingRules) {
    checkedHidingRules = new WeakMap();
    queueMicrotask(() => {
      checkedHidingRules = undefined;
    });
  }
  const checked = checkedHidingRules.get(root);
  if (checked) return checked;
  const owner = root as Partial<Document | ShadowRoot>;
  const sheets: CSSStyleSheet[] = [];
  try {
    for (const sheet of [
      ...Array.from(owner.styleSheets ?? []) as CSSStyleSheet[],
      ...owner.adoptedStyleSheets ?? [],
    ]) if (!sheet.disabled) sheets.push(sheet);
  } catch {
    // A tree whose sheets cannot be listed has none to ask.
  }
  const sizes = sheets.map((sheet) => {
    try {
      return sheet.cssRules.length;
    } catch {
      // A sheet of another origin cannot be read: its rules are not known.
      return -1;
    }
  });
  const kept = keptHidingRules.get(root);
  let rules = kept?.rules;
  if (
    !kept || kept.sheets.length !== sheets.length ||
    sheets.some((sheet, index) =>
      sheet !== kept.sheets[index] || sizes[index] !== kept.sizes[index])
  ) {
    const found: SourceHidingRule[] = [];
    const budget = { left: MAX_SOURCE_HIDING_RULES_READ };
    sheets.forEach((sheet, index) => {
      if (sizes[index]! < 0) return;
      const media = sheet.media?.mediaText ?? '';
      collectHidingRules(sheet, found, budget, media ? [media] : [], undefined);
    });
    rules = found;
    keptHidingRules.set(root, { sheets, sizes, rules });
  }
  checkedHidingRules.set(root, rules!);
  return rules!;
}

/**
 * `parent`: the selector of the style rule these rules are nested in. A
 * nested rule's own selector says `&` for it, or is meant under it.
 */
function collectHidingRules(
  holder: { readonly cssRules: CSSRuleList },
  found: SourceHidingRule[],
  budget: { left: number },
  media: readonly string[],
  parent: string | undefined,
): void {
  let rules: CSSRuleList;
  try {
    rules = holder.cssRules;
  } catch {
    return;
  }
  for (let index = 0; index < rules.length; index += 1) {
    if (budget.left <= 0 || found.length >= MAX_SOURCE_HIDING_RULES_KEPT) return;
    budget.left -= 1;
    const rule = rules[index] as Partial<CSSStyleRule & CSSMediaRule & CSSImportRule>;
    if (!rule) continue;
    if (rule.style) {
      // Declarations straight in a condition inside a rule are that rule's.
      const selector = typeof rule.selectorText !== 'string'
        ? parent
        : parent === undefined
          ? rule.selectorText
          : rule.selectorText.includes('&')
            ? rule.selectorText.replaceAll('&', `:is(${parent})`)
            : `:is(${parent}) :is(${rule.selectorText})`;
      if (selector === undefined) continue;
      const visibility = declares(rule.style, 'visibility');
      const scale = declares(rule.style, 'scale');
      if (visibility || scale) found.push({ selector, visibility, scale, media });
      if (rule.cssRules && rule.cssRules.length > 0) {
        collectHidingRules(
          rule as { cssRules: CSSRuleList }, found, budget, media, selector,
        );
      }
      continue;
    }
    const within = rule.media?.mediaText ? [...media, rule.media.mediaText] : media;
    if (rule.styleSheet) collectHidingRules(rule.styleSheet, found, budget, within, parent);
    else if (rule.cssRules) {
      collectHidingRules(rule as { cssRules: CSSRuleList }, found, budget, within, parent);
    }
  }
}

function declares(style: CSSStyleDeclaration, what: 'visibility' | 'scale'): boolean {
  if (what === 'visibility') {
    return hidesByVisibility(style.getPropertyValue('visibility'));
  }
  return scalesToNothing(style.getPropertyValue('transform')) ||
    /^0(?:\s|$)|\s0(?:\s|$)/u.test(style.getPropertyValue('scale').trim());
}

function hidesByVisibility(value: unknown): boolean {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return token === 'hidden' || token === 'collapse';
}

/** A written transform with a scale of nothing, or a matrix with no area. */
function scalesToNothing(value: string): boolean {
  const transform = value.trim().toLowerCase();
  if (transform === '' || transform === 'none') return false;
  if (/scale(?:3d|x|y)?\(\s*(?:[^,)]*,\s*)?0(?:\.0+)?\s*[,)]/u.test(transform)) {
    return true;
  }
  const matrix = /matrix(3d)?\(([^)]+)\)/u.exec(transform);
  if (!matrix) return false;
  const values = matrix[2]!.split(',').map((part) => Number(part.trim()));
  const [a, b, c, d] = matrix[1]
    ? [values[0], values[1], values[4], values[5]]
    : [values[0], values[1], values[2], values[3]];
  return [a, b, c, d].every((part) => Number.isFinite(part)) &&
    a! * d! - b! * c! === 0;
}
