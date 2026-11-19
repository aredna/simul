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
  /** The rule as it was read, asked again before the kept list is reused. */
  readonly source: Partial<CSSStyleRule & CSSMediaRule & CSSImportRule>;
  /** Its own selector text, or undefined for declarations in a condition. */
  readonly rawSelector: string | undefined;
  /** The style rules the entry's selector was built under, and their text. */
  readonly selectorSources: readonly SelectorSource[];
  readonly selectorSourceTexts: readonly (string | undefined)[];
  /** The enclosing media conditions beyond the sheet's own, and their text. */
  readonly mediaSources: readonly MediaSource[];
  readonly mediaSourceTexts: readonly (string | undefined)[];
}

/** A rule that wraps another with a selector: a style rule around a nested one. */
interface SelectorSource {
  readonly selectorText?: string;
}

/** A rule that wraps another with a media condition: `@media` or `@import`. */
interface MediaSource {
  readonly media?: { readonly mediaText: string };
}

interface HidingRuleContext {
  readonly media: readonly string[];
  readonly parent: string | undefined;
  readonly selectorSources: readonly SelectorSource[];
  readonly mediaSources: readonly MediaSource[];
  // `@supports` wrappers are not recorded or asked: a rule under a false
  // condition can be read as hiding, which withholds content rather than
  // showing it. The opened-panel read re-collects rules, so additions inside
  // one are seen; an in-place condition change is a fidelity limit only.
}

interface SourceHidingRuleSet {
  readonly sheets: readonly CSSStyleSheet[];
  /** How many rules each sheet held when it was read; -1 for unreadable. */
  readonly sizes: readonly number[];
  /** Each sheet's own media condition, which `link.media` can change. */
  readonly sheetMedia: readonly string[];
  readonly rules: readonly SourceHidingRule[];
  /**
   * False when a sheet could not be read, or the read was cut short: a rule
   * the page hides the element by may have been missed, and the opened
   * panel withholds what it cannot prove shown.
   */
  readonly complete: boolean;
}

/**
 * The rules of one tree that hide by `visibility` or scale to nothing, kept
 * for as long as the tree has the same sheets with the same number of rules
 * and the kept rules say what they said: a page changes its classes at every
 * turn and its sheets hardly ever, and reading every rule again at each
 * change of the page cost more than all the rest of this.
 */
const keptHidingRules = new WeakMap<Node, SourceHidingRuleSet>();

/**
 * The trees whose sheets were compared in this run of the reader, which the
 * page cannot interrupt: no sheet can change before the microtask that
 * forgets them.
 */
let checkedHidingRules: WeakMap<Node, SourceHidingRuleSet> | undefined;

/**
 * Whether the element's own `visibility` hides it. Where its parent is not
 * hidden by `visibility` the computed style says so; under a hidden parent,
 * only a style rule that names the element, or its style attribute, does.
 */
export function sourceElementHidesItselfByVisibility(
  element: Element,
  /**
   * The opened-panel read asks again, without the run's cache: a rule that
   * did not hide at read time can start hiding in place, and a rule added
   * inside a kept condition does not change a top-level count. The hot path
   * still reads a tree's rules once per run.
   */
  fresh = false,
): boolean {
  const view = element.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  try {
    if (!hidesByVisibility(view.getComputedStyle(element).visibility)) return false;
    const parent = readSourceFlatTreeElementPath(element)?.[1];
    if (!parent || !hidesByVisibility(view.getComputedStyle(parent).visibility)) {
      return true;
    }
    return sourceElementDeclares(element, 'visibility', fresh);
  } catch {
    return false;
  }
}

/**
 * Whether a style rule that names the element, or its style attribute,
 * scales it to nothing (`transform: scale(0)`, `scale: 0`). For an element
 * with no box, whose computed transform says nothing.
 */
export function sourceElementScalesItselfToNothing(
  element: Element,
  /** The opened-panel read asks again, without the run's cache, as the
   * visibility half does: a scale rule added inside a kept condition does
   * not change a top-level count (A5). */
  fresh = false,
): boolean {
  try {
    return sourceElementDeclares(element, 'scale', fresh);
  } catch {
    return false;
  }
}

function sourceElementDeclares(
  element: Element,
  what: 'visibility' | 'scale',
  fresh = false,
): boolean {
  const inline = (element as Partial<HTMLElement>).style;
  if (inline && declares(inline, what)) return true;
  const view = element.ownerDocument?.defaultView;
  const { rules, complete } = sourceHidingRules(element.getRootNode(), fresh);
  // A page hides a backing dropdown by one of its rules; when a sheet could
  // not be read, or the read was cut short, that rule may be among the ones
  // not seen. The opened panel then reads the dropdown as still hidden.
  if (!complete) return true;
  for (const rule of rules) {
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

function sourceHidingRules(root: Node, fresh = false): SourceHidingRuleSet {
  if (!checkedHidingRules) {
    checkedHidingRules = new WeakMap();
    queueMicrotask(() => {
      checkedHidingRules = undefined;
    });
  }
  if (!fresh) {
    const checked = checkedHidingRules.get(root);
    if (checked) return checked;
  }
  const entry = readSourceHidingRuleSet(root, fresh);
  checkedHidingRules.set(root, entry);
  return entry;
}

function readSourceHidingRuleSet(
  root: Node,
  fresh = false,
): SourceHidingRuleSet {
  const owner = root as Partial<Document | ShadowRoot>;
  const sheets: CSSStyleSheet[] = [];
  let complete = true;
  try {
    for (const sheet of [
      ...Array.from(owner.styleSheets ?? []) as CSSStyleSheet[],
      ...owner.adoptedStyleSheets ?? [],
    ]) if (!sheet.disabled) sheets.push(sheet);
  } catch {
    // A tree whose sheets cannot be listed may hold one that hides it.
    complete = false;
  }
  const sizes = sheets.map((sheet) => {
    try {
      return sheet.cssRules.length;
    } catch {
      // A sheet of another origin cannot be read: its rules are not known.
      return -1;
    }
  });
  const sheetMedia = sheets.map((sheet) => sheet.media?.mediaText ?? '');
  const kept = keptHidingRules.get(root);
  let rules: readonly SourceHidingRule[];
  if (
    fresh || !kept || kept.sheets.length !== sheets.length ||
    sheets.some((sheet, index) =>
      sheet !== kept.sheets[index] || sizes[index] !== kept.sizes[index]) ||
    !hidingRulesSayWhatTheySaid(kept)
  ) {
    const found: SourceHidingRule[] = [];
    const budget = { left: MAX_SOURCE_HIDING_RULES_READ };
    sheets.forEach((sheet, index) => {
      if (sizes[index]! < 0) return;
      const media = sheetMedia[index]!;
      collectHidingRules(sheet, found, budget, {
        media: media ? [media] : [],
        parent: undefined,
        selectorSources: [],
        mediaSources: [],
      });
    });
    rules = found;
    complete = complete && !sizes.includes(-1) && budget.left > 0 &&
      found.length < MAX_SOURCE_HIDING_RULES_KEPT;
    keptHidingRules.set(root, {
      sheets, sizes, sheetMedia, rules, complete,
    });
  } else {
    rules = kept.rules;
    complete = kept.complete;
  }
  return { sheets, sizes, sheetMedia, rules, complete };
}

/**
 * Whether the kept rules still say what they said. `rule.style.setProperty`
 * and `link.media` change a rule where it stands: neither the sheet nor its
 * rule count changes, and the kept list would otherwise outlive the edit.
 * A rule that stops hiding is read again as one that does not, and one that
 * starts hiding is a rule the read did not keep: the sheet's own media is
 * compared too, which `link.media` edits.
 */
function hidingRulesSayWhatTheySaid(kept: SourceHidingRuleSet): boolean {
  for (let index = 0; index < kept.sheets.length; index += 1) {
    const sheet = kept.sheets[index];
    if (!sheet) return false;
    if ((sheet.media?.mediaText ?? '') !== kept.sheetMedia[index]) return false;
  }
  for (const entry of kept.rules) {
    const rule = entry.source;
    const selector = typeof rule.selectorText === 'string'
      ? rule.selectorText
      : undefined;
    if (selector !== entry.rawSelector) return false;
    if (!rule.style) return false;
    if (declares(rule.style, 'visibility') !== entry.visibility) return false;
    if (declares(rule.style, 'scale') !== entry.scale) return false;
    // A nested rule's selector is the one around it joined with its own; a
    // rewrite of that selector stales the kept one just as its own would.
    if (!sameTexts(
      entry.selectorSources.map((source) => source.selectorText),
      entry.selectorSourceTexts,
    )) return false;
    // The conditions around it decide whether the rule applies at all, and
    // `@media`/`@import` media can be edited where they stand.
    if (!sameTexts(
      entry.mediaSources.map((source) => source.media?.mediaText),
      entry.mediaSourceTexts,
    )) return false;
  }
  return true;
}

function sameTexts(
  live: readonly (string | undefined)[],
  read: readonly (string | undefined)[],
): boolean {
  return live.length === read.length &&
    live.every((text, index) => text === read[index]);
}

/**
 * `context.parent`: the selector of the style rule these rules are nested
 * in. A nested rule's own selector says `&` for it, or is meant under it.
 */
function collectHidingRules(
  holder: { readonly cssRules: CSSRuleList },
  found: SourceHidingRule[],
  budget: { left: number },
  context: HidingRuleContext,
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
      const { parent } = context;
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
      if (visibility || scale) {
        found.push({
          selector,
          visibility,
          scale,
          media: context.media,
          source: rule,
          rawSelector: typeof rule.selectorText === 'string'
            ? rule.selectorText
            : undefined,
          selectorSources: context.selectorSources,
          selectorSourceTexts: context.selectorSources.map(
            (source) => source.selectorText,
          ),
          mediaSources: context.mediaSources,
          mediaSourceTexts: context.mediaSources.map(
            (source) => source.media?.mediaText,
          ),
        });
      }
      if (rule.cssRules && rule.cssRules.length > 0) {
        const selectorSources = typeof rule.selectorText === 'string'
          ? [...context.selectorSources, rule as SelectorSource]
          : context.selectorSources;
        collectHidingRules(
          rule as { cssRules: CSSRuleList }, found, budget,
          { ...context, parent: selector, selectorSources },
        );
      }
      continue;
    }
    const mediaText = rule.media?.mediaText;
    const within: HidingRuleContext = mediaText
      ? {
          ...context,
          media: [...context.media, mediaText],
          mediaSources: [...context.mediaSources, rule as MediaSource],
        }
      : context;
    if (rule.styleSheet) collectHidingRules(rule.styleSheet, found, budget, within);
    else if (rule.cssRules) {
      collectHidingRules(rule as { cssRules: CSSRuleList }, found, budget, within);
    }
  }
}

function declares(style: CSSStyleDeclaration, what: 'visibility' | 'scale'): boolean {
  if (what === 'visibility') {
    return hidesByVisibility(style.getPropertyValue('visibility'));
  }
  return scalesToNothing(style.getPropertyValue('transform')) ||
    scalePropertyIsZero(style.getPropertyValue('scale'));
}

/**
 * `scale: 0`, `0.0`, `.0`, `-0`, `0e0`, `0%`, or any such value on one axis.
 * Read as a number: the shapes a page writes a zero in are the page's, and a
 * misspelled one used to be read as no scale at all.
 */
function scalePropertyIsZero(value: string): boolean {
  return value.trim().toLowerCase().split(/\s+/u)
    .some((token) => isZeroScaleToken(token));
}

function isZeroScaleToken(token: string): boolean {
  const match = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(%?)$/u.exec(token);
  if (!match) return false;
  const number = match[1] ? token.slice(0, -1) : token;
  return Number(number) === 0;
}

function hidesByVisibility(value: unknown): boolean {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return token === 'hidden' || token === 'collapse';
}

/** A written transform with a scale of nothing, or a matrix with no area. */
function scalesToNothing(value: string): boolean {
  const transform = value.trim().toLowerCase();
  if (transform === '' || transform === 'none') return false;
  const scales = /scale(?:3d|x|y)?\s*\(([^)]*)\)/gu;
  for (let match = scales.exec(transform); match; match = scales.exec(transform)) {
    if ((match[1] ?? '').split(',').map((part) => part.trim())
      .some((part) => isZeroScaleToken(part))) return true;
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
