import { readSourceFlatTreeElementPath } from './source-privacy-policy';
import { readSourceAssignedSlot } from './source-shadow-root';

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
/**
 * Rules that declare one of the properties without hiding by it (a later
 * `visibility: visible`). Past this many they are not asked: what hides the
 * element then wins, as it did before the cascade was worked out (D173).
 */
const MAX_SOURCE_SHOWING_RULES_KEPT = 1_024;
/** How many slots up the flat tree the roots' `::slotted` rules are asked. */
const MAX_SOURCE_SLOT_CHAIN = 16;

/** The properties by which an element hides itself, as the cascade sets them. */
type HidingProperty = 'visibility' | 'transform' | 'scale';
const PROPERTIES_OF = {
  visibility: ['visibility'],
  scale: ['transform', 'scale'],
} as const satisfies Record<'visibility' | 'scale', readonly HidingProperty[]>;
const HIDING_PROPERTIES: readonly HidingProperty[] = ['visibility', 'transform', 'scale'];

interface Declared {
  readonly value: string;
  readonly important: boolean;
}

interface SourceHidingRule {
  readonly selector: string;
  /** What the rule declares of each property, `!important` or not. */
  readonly declared: Readonly<Partial<Record<HidingProperty, Declared>>>;
  /** Whether it hides by `visibility`, and by a scale of nothing. */
  readonly visibility: boolean;
  readonly scale: boolean;
  /**
   * Where it stands among the tree's rules: a later one wins between rules
   * of the same weight.
   */
  readonly order: number;
  /**
   * Under something whose weight in the cascade is not worked out here (a
   * cascade layer, `@scope`, a container query, `@starting-style`, a
   * condition that could not be asked): such a rule may hide the element,
   * as every rule did before D173, and never shows it.
   */
  readonly uncertain: boolean;
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
  /** See `SourceHidingRule.uncertain`. */
  readonly uncertain: boolean;
  /**
   * `CSS.supports` of the tree's window (D173): a rule under an `@supports`
   * that does not hold applies nowhere and is not kept. The answer cannot
   * change in place (`conditionText` is read-only), so it is not kept.
   */
  readonly supports: ((condition: string) => boolean) | undefined;
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
  /**
   * False when more rules declared the properties than are kept: a rule
   * that shows the element may have been missed, and none is asked.
   */
  readonly showingComplete: boolean;
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

/**
 * Whether the element hides itself by `visibility` or by a scale of nothing,
 * as the cascade decides it among its style attribute, the rules of its tree
 * that name it, and the `::slotted` rules of the roots it is slotted into
 * (D173): a later or more specific rule, or an `!important` one, that shows
 * it wins over one that hides it, as in the page. What the cascade cannot be
 * worked out for here (see `SourceHidingRule.uncertain`) hides it, never
 * shows it.
 */
function sourceElementDeclares(
  element: Element,
  what: 'visibility' | 'scale',
  fresh = false,
): boolean {
  const view = element.ownerDocument?.defaultView;
  const candidates: Candidate[] = [];
  let showingComplete = true;
  let uncertainHides = false;
  const inline = (element as Partial<HTMLElement>).style;
  if (inline) {
    for (const property of PROPERTIES_OF[what]) {
      const declared = readDeclared(inline, property);
      if (declared) {
        candidates.push({
          property, ...declared, context: 0, inline: true,
          specificity: [0, 0, 0], order: Infinity,
        });
      }
    }
  }
  const consider = (
    set: SourceHidingRuleSet,
    context: number,
    specificityOf: (selector: string) => Specificity | 'unknown' | undefined,
  ): void => {
    showingComplete &&= set.showingComplete;
    for (const rule of set.rules) {
      if (!PROPERTIES_OF[what].some((property) => rule.declared[property])) continue;
      let specificity: Specificity | 'unknown' | undefined;
      try {
        if (!rule.media.every((query) => view?.matchMedia(query).matches !== false)) {
          continue;
        }
        specificity = specificityOf(rule.selector);
      } catch {
        // A selector this element cannot be asked about names something else.
        continue;
      }
      if (specificity === undefined) continue;
      if (rule.uncertain || specificity === 'unknown') {
        uncertainHides ||= rule[what];
        continue;
      }
      for (const property of PROPERTIES_OF[what]) {
        const declared = rule.declared[property];
        if (declared) {
          candidates.push({
            property, ...declared, context, inline: false, specificity,
            order: rule.order,
          });
        }
      }
    }
  };
  // A page hides a backing dropdown by one of its rules; when a sheet could
  // not be read, or the read was cut short, that rule may be among the ones
  // not seen. The opened panel then reads the dropdown as still hidden.
  const own = sourceHidingRules(element.getRootNode(), fresh);
  if (!own.complete) return true;
  consider(own, 0, (selector) => matchedSpecificity(element, selector));
  // The roots along its slots, closed ones too: their `::slotted(...)`
  // rules style it (f15). A root with too many slots to search for it is a
  // way not known, and the dropdown stays hidden.
  let slot: Element | null | undefined;
  try {
    slot = readSourceAssignedSlot(element);
    for (let depth = 1; slot && depth <= MAX_SOURCE_SLOT_CHAIN; depth += 1) {
      const set = sourceHidingRules(slot.getRootNode(), fresh);
      if (!set.complete) return true;
      const through = slot;
      consider(set, depth, (selector) => slottedSpecificity(element, through, selector));
      slot = readSourceAssignedSlot(slot);
    }
  } catch {
    return true;
  }
  if (uncertainHides) return true;
  return PROPERTIES_OF[what].some((property) => {
    const declared = candidates.filter((candidate) => candidate.property === property);
    if (!declared.some((candidate) => hidesBy(property, candidate.value))) return false;
    if (!showingComplete) return true;
    const winner = declared.reduce((best, next) =>
      cascadeWins(next, best) ? next : best);
    // A value that only the page's variables decide may hide it.
    return /\b(?:var|env|attr)\(/iu.test(winner.value) ||
      hidesBy(property, winner.value);
  });
}

type Specificity = readonly [number, number, number];

interface Candidate extends Declared {
  readonly property: HidingProperty;
  /** 0 for the element's own tree, then one more for each slot up. */
  readonly context: number;
  readonly inline: boolean;
  readonly specificity: Specificity;
  readonly order: number;
}

/**
 * The cascade among author declarations (css-cascade-5): importance, then
 * the context (the outer tree wins for normal declarations, the inner one
 * for `!important`), then the style attribute, then specificity, then
 * order. Cascade layers and scoping are not here: such a rule is uncertain.
 */
function cascadeWins(next: Candidate, best: Candidate): boolean {
  if (next.important !== best.important) return next.important;
  if (next.context !== best.context) {
    return next.important ? next.context > best.context : next.context < best.context;
  }
  if (next.inline !== best.inline) return next.inline;
  const order = compareSpecificity(next.specificity, best.specificity);
  if (order !== 0) return order > 0;
  return next.order >= best.order;
}

function hidesBy(property: HidingProperty, value: string): boolean {
  if (property === 'visibility') return hidesByVisibility(value);
  if (property === 'transform') return scalesToNothing(value);
  return scalePropertyIsZero(value);
}

function readDeclared(
  style: CSSStyleDeclaration,
  property: HidingProperty,
): Declared | undefined {
  const written = style.getPropertyValue(property).trim();
  // Chrome gives the priority apart; a value with it left on is read too.
  const value = written.replace(/\s*!\s*important$/iu, '');
  if (!value) return undefined;
  const priority = typeof style.getPropertyPriority === 'function'
    ? style.getPropertyPriority(property)
    : '';
  return { value, important: priority === 'important' || value !== written };
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
  let showingComplete: boolean;
  if (
    fresh || !kept || kept.sheets.length !== sheets.length ||
    sheets.some((sheet, index) =>
      sheet !== kept.sheets[index] || sizes[index] !== kept.sizes[index]) ||
    !hidingRulesSayWhatTheySaid(kept)
  ) {
    const found: SourceHidingRule[] = [];
    const budget = {
      left: MAX_SOURCE_HIDING_RULES_READ,
      hiding: 0,
      showing: 0,
      showingComplete: true,
    };
    const supports = readSupports(root);
    sheets.forEach((sheet, index) => {
      if (sizes[index]! < 0) return;
      const media = sheetMedia[index]!;
      collectHidingRules(sheet, found, budget, {
        media: media ? [media] : [],
        parent: undefined,
        selectorSources: [],
        mediaSources: [],
        uncertain: false,
        supports,
      });
    });
    rules = found;
    complete = complete && !sizes.includes(-1) && budget.left > 0 &&
      budget.hiding < MAX_SOURCE_HIDING_RULES_KEPT;
    showingComplete = budget.showingComplete;
    keptHidingRules.set(root, {
      sheets, sizes, sheetMedia, rules, complete, showingComplete,
    });
  } else {
    rules = kept.rules;
    complete = kept.complete;
    showingComplete = kept.showingComplete;
  }
  return { sheets, sizes, sheetMedia, rules, complete, showingComplete };
}

/** `CSS.supports` of the tree's window, where it can be asked. */
function readSupports(root: Node): ((condition: string) => boolean) | undefined {
  const view = (root as Partial<Document>).defaultView ??
    root.ownerDocument?.defaultView;
  const css = (view as (Window & { CSS?: typeof CSS }) | null | undefined)?.CSS;
  return typeof css?.supports === 'function'
    ? (condition) => css.supports(condition)
    : undefined;
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
    for (const property of HIDING_PROPERTIES) {
      const now = readDeclared(rule.style, property);
      const then = entry.declared[property];
      if (now?.value !== then?.value || now?.important !== then?.important) {
        return false;
      }
    }
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
  budget: { left: number; hiding: number; showing: number; showingComplete: boolean },
  context: HidingRuleContext,
): void {
  let rules: CSSRuleList;
  try {
    rules = holder.cssRules;
  } catch {
    return;
  }
  for (let index = 0; index < rules.length; index += 1) {
    if (budget.left <= 0 || budget.hiding >= MAX_SOURCE_HIDING_RULES_KEPT) return;
    budget.left -= 1;
    const rule = rules[index] as Partial<
      CSSStyleRule & CSSMediaRule & CSSImportRule & CSSSupportsRule &
      CSSContainerRule
    >;
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
      const declared: Partial<Record<HidingProperty, Declared>> = {};
      for (const property of HIDING_PROPERTIES) {
        const value = readDeclared(rule.style, property);
        if (value) declared[property] = value;
      }
      const visibility = declares(rule.style, 'visibility');
      const scale = declares(rule.style, 'scale');
      // A rule that only shows is kept while there is room; one that hides
      // always is, up to the cap that marks the read incomplete.
      let keep = visibility || scale;
      if (!keep && !context.uncertain && Object.keys(declared).length > 0) {
        if (budget.showing < MAX_SOURCE_SHOWING_RULES_KEPT) keep = true;
        else budget.showingComplete = false;
      }
      if (keep) {
        if (visibility || scale) budget.hiding += 1;
        else budget.showing += 1;
        found.push({
          selector,
          declared,
          visibility,
          scale,
          order: found.length,
          uncertain: context.uncertain,
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
    let within: HidingRuleContext = mediaText
      ? {
          ...context,
          media: [...context.media, mediaText],
          mediaSources: [...context.mediaSources, rule as MediaSource],
        }
      : context;
    if (rule.styleSheet) {
      // A sheet imported into a cascade layer weighs as the layer does.
      if (typeof rule.layerName === 'string') within = { ...within, uncertain: true };
      collectHidingRules(rule.styleSheet, found, budget, within);
      continue;
    }
    if (!rule.cssRules) continue;
    if (!rule.media) {
      if (
        typeof rule.conditionText === 'string' &&
        rule.containerName === undefined
      ) {
        // `@supports` (f4): one that does not hold applies nowhere.
        let holds: boolean | undefined;
        try {
          holds = context.supports?.(rule.conditionText);
        } catch {
          holds = undefined;
        }
        if (holds === false) continue;
        if (holds === undefined) within = { ...within, uncertain: true };
      } else {
        // A cascade layer, `@scope`, a container query, `@starting-style`.
        within = { ...within, uncertain: true };
      }
    }
    collectHidingRules(rule as { cssRules: CSSRuleList }, found, budget, within);
  }
}

/**
 * The specificity by which the rule's selector names the element: of the
 * most specific of its selectors that matches it; undefined when none does;
 * `unknown` when one matches and its specificity cannot be read here.
 */
function matchedSpecificity(
  element: Element,
  selectorList: string,
): Specificity | 'unknown' | undefined {
  let best: Specificity | undefined;
  for (const complex of splitTopLevel(selectorList)) {
    let matches = false;
    try {
      matches = element.matches(complex);
    } catch {
      // A selector the element cannot be asked about (a pseudo-element).
    }
    if (!matches) continue;
    const specificity = complexSpecificity(complex);
    if (!specificity) return 'unknown';
    if (!best || compareSpecificity(specificity, best) > 0) best = specificity;
  }
  return best;
}

/**
 * The same for a rule of a root the element is slotted into through `slot`
 * (f15): only a selector that ends in `::slotted(...)` names it, when the
 * slot matches what comes before and the element what is inside.
 */
function slottedSpecificity(
  element: Element,
  slot: Element,
  selectorList: string,
): Specificity | 'unknown' | undefined {
  let best: Specificity | undefined;
  for (const complex of splitTopLevel(selectorList)) {
    const at = complex.toLowerCase().lastIndexOf('::slotted(');
    if (at < 0 || !complex.endsWith(')')) continue;
    const argument = complex.slice(at + '::slotted('.length, -1);
    const before = complex.slice(0, at);
    // `.menu ::slotted(x)`: the slot is any element under `.menu`.
    const slotSelector = before.trim() === ''
      ? '*'
      : /[\s>+~]$/u.test(before) ? `${before}*` : before;
    let matches = false;
    try {
      matches = element.matches(argument) && slot.matches(slotSelector);
    } catch {
      // Something here cannot be asked about: it names nothing.
    }
    if (!matches) continue;
    const ofArgument = complexSpecificity(argument);
    const ofBefore = before.trim() === '' ? [0, 0, 0] as const : complexSpecificity(before);
    if (!ofArgument || !ofBefore) return 'unknown';
    const specificity: Specificity = [
      ofArgument[0] + ofBefore[0],
      ofArgument[1] + ofBefore[1],
      ofArgument[2] + ofBefore[2] + 1,
    ];
    if (!best || compareSpecificity(specificity, best) > 0) best = specificity;
  }
  return best;
}

function compareSpecificity(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** A selector list's selectors: split at the commas outside brackets and strings. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index]!;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter((part) => part !== '');
}

const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
const IDENTIFIER = /^(?:[-\w\u0080-\uffff]|\\.)+/u;

/**
 * The specificity of one complex selector (Selectors 4): ids; classes,
 * attributes and pseudo-classes; types and pseudo-elements. `:is()`,
 * `:not()` and `:has()` count their most specific argument, `:where()`
 * nothing, `:nth-child(... of S)` one more than S. Undefined for what is
 * not read here.
 */
function complexSpecificity(selector: string): Specificity | undefined {
  let [a, b, c] = [0, 0, 0];
  let index = 0;
  const identifierAt = (at: number): string => IDENTIFIER.exec(selector.slice(at))?.[0] ?? '';
  while (index < selector.length) {
    const character = selector[index]!;
    if (/[\s>+~]/u.test(character) || character === '*') {
      index += 1;
      continue;
    }
    if (character === '|') {
      // A namespace prefix was counted as a type: what follows is the type.
      if (/[-\w\u0080-\uffff]/u.test(selector[index - 1] ?? '')) c -= 1;
      index += 1;
      if (selector[index] === '*') index += 1;
      else if (identifierAt(index)) {
        c += 1;
        index += identifierAt(index).length;
      }
      continue;
    }
    if (character === '#' || character === '.') {
      const name = identifierAt(index + 1);
      if (!name) return undefined;
      if (character === '#') a += 1;
      else b += 1;
      index += 1 + name.length;
      continue;
    }
    if (character === '[') {
      const close = closingIndex(selector, index, '[', ']');
      if (close < 0) return undefined;
      b += 1;
      index = close + 1;
      continue;
    }
    if (character === ':') {
      const element = selector[index + 1] === ':';
      const nameStart = index + (element ? 2 : 1);
      const name = identifierAt(nameStart).toLowerCase();
      if (!name) return undefined;
      index = nameStart + name.length;
      let argument: string | undefined;
      if (selector[index] === '(') {
        const close = closingIndex(selector, index, '(', ')');
        if (close < 0) return undefined;
        argument = selector.slice(index + 1, close);
        index = close + 1;
      }
      if (element || LEGACY_PSEUDO_ELEMENTS.has(name)) {
        c += 1;
        if (name === 'slotted' && argument !== undefined) {
          const inner = complexSpecificity(argument);
          if (!inner) return undefined;
          [a, b, c] = [a + inner[0], b + inner[1], c + inner[2]];
        }
        continue;
      }
      let inner: Specificity | undefined = [0, 0, 0];
      if (name === 'where') {
        continue;
      } else if (['is', 'not', 'has', 'matches', '-webkit-any'].includes(name)) {
        if (argument === undefined) return undefined;
        inner = maxSpecificity(argument);
      } else {
        b += 1;
        if (argument !== undefined) {
          if (name === 'nth-child' || name === 'nth-last-child') {
            const of = /\sof\s/iu.exec(argument);
            if (of) inner = maxSpecificity(argument.slice(of.index + of[0].length));
          } else if (name === 'host' || name === 'host-context') {
            inner = complexSpecificity(argument);
          }
        }
      }
      if (!inner) return undefined;
      [a, b, c] = [a + inner[0], b + inner[1], c + inner[2]];
      continue;
    }
    const name = identifierAt(index);
    if (!name) return undefined;
    c += 1;
    index += name.length;
  }
  return [a, b, c];
}

function maxSpecificity(list: string): Specificity | undefined {
  let best: Specificity = [0, 0, 0];
  for (const complex of splitTopLevel(list)) {
    const specificity = complexSpecificity(complex);
    if (!specificity) return undefined;
    if (compareSpecificity(specificity, best) > 0) best = specificity;
  }
  return best;
}

function closingIndex(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  let quote = '';
  for (let index = open; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === opener) depth += 1;
    else if (character === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
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
