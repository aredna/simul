/**
 * The names the page's style sheets mention, and the changes of the page the
 * comparison of what it paints may leave out because of them (D164).
 *
 * A change can only change what is painted through a rule that reads it: an
 * attribute through `[name`, `attr(name)` or the browser's own sheet, a class
 * through `.token`, an interaction through its pseudo-class. The names are
 * collected from the whole text of every readable sheet (declarations,
 * strings and URLs too), which can only collect too many, never too few.
 * Only pseudo-classes are not read from inside a quoted string: no string
 * of a sheet is ever a selector, and the `:image` of every inline SVG's
 * `data:image/svg+xml` would have kept every event of the page compared.
 * Whenever anything cannot be read, every name counts as mentioned.
 */

/** What the readable sheets of the page mention, all in lower case. */
export interface SourceStyleNames {
  /** `.token` */
  readonly classes: ReadonlySet<string>;
  /** `#name`; collected for completeness, an `id` is never left out. */
  readonly ids: ReadonlySet<string>;
  /** `[name`, with or without a namespace. */
  readonly attributes: ReadonlySet<string>;
  /** `attr(name)` */
  readonly attributeReads: ReadonlySet<string>;
  /** `:name`, outside quoted strings */
  readonly pseudoClasses: ReadonlySet<string>;
  /** `::name`: a pseudo-element, which no event turns on or off by itself. */
  readonly pseudoElements: ReadonlySet<string>;
  /**
   * `.token` in the selector of a rule that hides (`display: none`,
   * `visibility: hidden`, `opacity: 0`, `content-visibility: hidden`), as
   * far as a plain rule shows it (D180): such a class hides or shows a
   * panel, and its comparison does not wait for the share.
   */
  readonly hidingClasses: ReadonlySet<string>;
}

interface MutableSourceStyleNames extends SourceStyleNames {
  readonly hidingClasses: Set<string>;
  readonly classes: Set<string>;
  readonly ids: Set<string>;
  readonly attributes: Set<string>;
  readonly attributeReads: Set<string>;
  readonly pseudoClasses: Set<string>;
  readonly pseudoElements: Set<string>;
}

export function createSourceStyleNames(): MutableSourceStyleNames {
  return {
    classes: new Set(),
    ids: new Set(),
    attributes: new Set(),
    attributeReads: new Set(),
    pseudoClasses: new Set(),
    pseudoElements: new Set(),
    hidingClasses: new Set(),
  };
}

/**
 * Adds the names `cssText` mentions to `into`. Identifiers are read with
 * their escapes undone, as Chrome writes them (`.md\:flex`, `.\31 0`), and
 * leniently: `.5em` adds a class `5em`, `#fff` an id, which costs nothing.
 */
export function collectSourceStyleNames(
  cssText: string,
  into: MutableSourceStyleNames,
): void {
  collectNames(cssText, 0, cssText.length, into, false);
  collectHidingClasses(cssText, into);
}

/** A declaration that hides what a rule selects (D180). */
const HIDING_DECLARATION =
  /(?:^|[;\s])(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*(?:0+(?:\.0*)?|\.0+)%?\s*(?:!|;|$)|content-visibility\s*:\s*hidden)/iu;

/**
 * The classes in the selectors of the plain rules of `cssText` (a block
 * with no block inside) that hide (D180). A rule this misses (nested CSS,
 * a hiding by `transform` or a height of 0) only keeps the share's wait.
 */
function collectHidingClasses(cssText: string, into: MutableSourceStyleNames): void {
  if (!cssText.includes('{')) return;
  const block = /([^{}]*)\{([^{}]*)\}/gu;
  for (const match of cssText.matchAll(block)) {
    if (!HIDING_DECLARATION.test(match[2] ?? '')) continue;
    const selector = match[1] ?? '';
    for (let index = selector.indexOf('.'); index >= 0; index = selector.indexOf('.', index + 1)) {
      const name = readIdentifier(selector, index + 1);
      if (name) into.hidingClasses.add(name.value.toLowerCase());
    }
  }
}

/**
 * Whether a change of `class` added or took away a token a hiding rule
 * names (D180): a panel hidden or shown by it, which waits for no share.
 */
export function sourceClassChangeNamesHidingRule(
  record: MutationRecord,
  names: SourceStyleNames | undefined,
): boolean {
  if (
    !names || names.hidingClasses.size === 0 ||
    record.type !== 'attributes' || record.attributeName !== 'class'
  ) return false;
  const target = record.target as Element;
  let current: string | null;
  try {
    current = target.getAttribute('class');
  } catch {
    return false;
  }
  const before = classTokens(record.oldValue);
  const after = classTokens(current);
  for (const token of before) {
    if (!after.has(token) && names.hidingClasses.has(token)) return true;
  }
  for (const token of after) {
    if (!before.has(token) && names.hidingClasses.has(token)) return true;
  }
  return false;
}

/**
 * The names of `cssText` from `start` to `end`. Inside a quoted string
 * (`inString`), every name but a pseudo-class.
 */
function collectNames(
  cssText: string,
  start: number,
  end: number,
  into: MutableSourceStyleNames,
  inString: boolean,
): void {
  let index = start;
  while (index < end) {
    const code = cssText.charCodeAt(index);
    if (!inString && (code === 0x22 /* " */ || code === 0x27 /* ' */)) {
      const close = stringEnd(cssText, index + 1, code, end);
      collectNames(cssText, index + 1, close, into, true);
      index = close + 1;
      continue;
    }
    if (code === 0x2e /* . */ || code === 0x23 /* # */) {
      const name = readIdentifier(cssText, index + 1);
      if (name) {
        (code === 0x2e ? into.classes : into.ids).add(name.value.toLowerCase());
        index = name.end;
        continue;
      }
    } else if (code === 0x5b /* [ */) {
      const name = readAttributeName(cssText, index + 1);
      if (name) {
        into.attributes.add(name.value.toLowerCase());
        index = name.end;
        continue;
      }
    } else if (code === 0x3a /* : */ && !inString) {
      const element = cssText.charCodeAt(index + 1) === 0x3a;
      const name = readIdentifier(cssText, element ? index + 2 : index + 1);
      if (name) {
        (element ? into.pseudoElements : into.pseudoClasses)
          .add(name.value.toLowerCase());
        index = name.end;
        continue;
      }
    } else if (isIdentifierCode(code) || code === 0x5c /* \ */) {
      const name = readIdentifier(cssText, index);
      if (name) {
        index = name.end;
        if (
          cssText.charCodeAt(index) === 0x28 /* ( */ &&
          name.value.toLowerCase() === 'attr'
        ) {
          const read = readAttributeName(cssText, index + 1);
          if (read) {
            into.attributeReads.add(read.value.toLowerCase());
            index = read.end;
          }
        }
        continue;
      }
    }
    index += 1;
  }
}

/**
 * Where the string opened before `start` by `quote` closes: its closing
 * quote, a line end (where CSS ends a string that was not closed), or
 * `end`. A backslash escapes the character after it.
 */
function stringEnd(text: string, start: number, quote: number, end: number): number {
  let index = start;
  while (index < end) {
    const code = text.charCodeAt(index);
    if (code === quote || code === 0x0a || code === 0x0c || code === 0x0d) return index;
    index += code === 0x5c /* \ */ ? 2 : 1;
  }
  return end;
}

interface ReadIdentifier {
  readonly value: string;
  readonly end: number;
}

function isIdentifierCode(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x5f ||
    code >= 0x80;
}

function isHexCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66) ||
    (code >= 0x41 && code <= 0x46);
}

function isWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c ||
    code === 0x0d;
}

/** A run of identifier characters from `start`, its escapes undone. */
function readIdentifier(text: string, start: number): ReadIdentifier | undefined {
  let value = '';
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isIdentifierCode(code)) {
      value += text[index];
      index += 1;
      continue;
    }
    if (code !== 0x5c /* \ */) break;
    const next = text.charCodeAt(index + 1);
    // A backslash before a line end, or at the end, escapes nothing.
    if (Number.isNaN(next) || next === 0x0a || next === 0x0c || next === 0x0d) break;
    if (isHexCode(next)) {
      let end = index + 1;
      while (end < text.length && end < index + 7 && isHexCode(text.charCodeAt(end))) {
        end += 1;
      }
      const point = Number.parseInt(text.slice(index + 1, end), 16);
      value += point > 0 && point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : '�';
      // One whitespace after a hexadecimal escape belongs to it.
      if (end < text.length && isWhitespaceCode(text.charCodeAt(end))) end += 1;
      index = end;
      continue;
    }
    value += String.fromCodePoint(text.codePointAt(index + 1)!);
    index += next >= 0xd800 && next <= 0xdbff ? 3 : 2;
  }
  return value ? { value, end: index } : undefined;
}

/** The name in `[ns|name` or `attr(ns|name`, after the opening bracket. */
function readAttributeName(text: string, start: number): ReadIdentifier | undefined {
  let index = start;
  while (index < text.length && isWhitespaceCode(text.charCodeAt(index))) index += 1;
  // `[*|name` and `[|name`: any namespace, or none.
  if (text.charCodeAt(index) === 0x2a /* * */ && text.charCodeAt(index + 1) === 0x7c) {
    index += 2;
  } else if (
    text.charCodeAt(index) === 0x7c /* | */ && text.charCodeAt(index + 1) !== 0x3d
  ) {
    index += 1;
  }
  const first = readIdentifier(text, index);
  if (!first) return undefined;
  // `[ns|name`, and not `[name|=value`.
  if (
    text.charCodeAt(first.end) === 0x7c && text.charCodeAt(first.end + 1) !== 0x3d
  ) {
    const second = readIdentifier(text, first.end + 1);
    if (second) return second;
  }
  return first;
}

/**
 * Whether the comparison of what the page paints may leave out an
 * `attributes` record (D164); its mutation patch is sent all the same.
 * `names` gives undefined when every name counts as mentioned: nothing is
 * left out. It is asked only for a record that could be left out.
 *
 * Only an attribute no rule of the page reads, and that has no effect of its
 * own on what is painted: a `data-*` attribute, an `aria-*` attribute other
 * than `aria-hidden` (which the reader itself reads), or `title` (which
 * picks the style sheets of a `<link>` or `<style>`). And a change of
 * `class` whose every token added or taken away is mentioned nowhere, when
 * no rule reads the attribute `class` as such. Never a change of `id`,
 * `style`, `hidden`, `open`, `dir`, `lang`, `slot`, `src`, a presentation or
 * form attribute, or any attribute in a namespace; and never one of an
 * element whose inline style may call `attr()`, which no sheet shows.
 */
export function sourceVisibilityMutationMaySkip(
  record: MutationRecord,
  names: () => SourceStyleNames | undefined,
): boolean {
  if (record.type !== 'attributes') return false;
  const target = record.target as Element;
  if (target.nodeType !== 1 || record.attributeNamespace) return false;
  const name = record.attributeName?.toLowerCase();
  if (!name) return false;
  const kind = name === 'class'
    ? 'class'
    : name.startsWith('data-') ||
        (name.startsWith('aria-') && name !== 'aria-hidden') ||
        (name === 'title' && !['link', 'style'].includes(
          String(target.localName).toLowerCase(),
        ))
      ? 'own'
      : undefined;
  if (!kind) return false;
  // Chrome's typed `attr()` (133 and later) reads any attribute of the
  // element from its inline style: such a style may read this one.
  if (inlineStyleReadsAttributes(target)) return false;
  const mentioned = names();
  if (!mentioned) return false;
  if (mentioned.attributes.has(name) || mentioned.attributeReads.has(name)) {
    return false;
  }
  return kind === 'own' || classChangeIsUnmentioned(record, target, mentioned);
}

/**
 * Whether the element's own `style` attribute may call `attr(`: it names
 * it, or holds an escape that could spell it (`\61ttr(`), or cannot be read.
 */
function inlineStyleReadsAttributes(target: Element): boolean {
  let style: string | null;
  try {
    style = target.getAttribute('style');
  } catch {
    return true;
  }
  return style !== null && (/attr\s*\(/iu.test(style) || style.includes('\\'));
}

/**
 * Every token that the change of `class` added or took away, counted from
 * the value before the record to the value now: over several records of a
 * batch, a token that came and went shows in one of them.
 */
function classChangeIsUnmentioned(
  record: MutationRecord,
  target: Element,
  names: SourceStyleNames,
): boolean {
  let current: string | null;
  try {
    current = target.getAttribute('class');
  } catch {
    return false;
  }
  const before = classTokens(record.oldValue);
  const after = classTokens(current);
  for (const token of before) {
    if (!after.has(token) && names.classes.has(token)) return false;
  }
  for (const token of after) {
    if (!before.has(token) && names.classes.has(token)) return false;
  }
  return true;
}

function classTokens(value: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  if (!value) return tokens;
  for (const token of value.split(/[\t\n\f\r ]+/)) {
    // A class selector of a page in quirks mode ignores case: compared in
    // lower case, a token can only seem mentioned more often.
    if (token) tokens.add(token.toLowerCase());
  }
  return tokens;
}

/**
 * The pseudo-classes through which an event of each kind can change what is
 * painted; a kind not listed is always compared (a click, an input, a
 * toggle, the end of a transition). `:user-invalid` and `:user-valid` change
 * when a field the person touched loses the focus, so `focusout` asks for
 * them too.
 */
const EVENT_PSEUDO_CLASSES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    pointerover: ['hover'],
    pointerout: ['hover'],
    pointerdown: ['hover', 'active'],
    pointerup: ['hover', 'active'],
    focusin: ['focus', 'focus-within', 'focus-visible'],
    focusout: [
      'focus',
      'focus-within',
      'focus-visible',
      'user-invalid',
      'user-valid',
    ],
    keydown: ['active', 'focus-visible'],
    keyup: ['active', 'focus-visible'],
  });

/**
 * The pseudo-classes whose match only a change of the page's tree or of an
 * attribute can change, which the mutation records already bring to the
 * comparison; and the four pseudo-elements a sheet may still write with
 * one colon. Nothing else: a script that handles a key or a pointer can
 * change what is painted with no mutation at all, through a property
 * (`input.checked` and `.value`: `:checked`, `:placeholder-shown`,
 * `:invalid`, `:dir()` of a field with `dir=auto`), a custom element's
 * state (`:state()`), its definition (`:defined`), the address (`:target`)
 * or a method (`:popover-open`, `:modal`, `:fullscreen`, `:open`,
 * `:playing`), and the browser by itself (`:autofill`). Each of those,
 * and any name not listed here, a vendor's or one Chrome adds later, has
 * every event compared (D164).
 */
const MUTATION_ONLY_PSEUDO_CLASSES: ReadonlySet<string> = new Set([
  // The tree.
  'root', 'empty', 'scope', 'host', 'host-context',
  'first-child', 'last-child', 'only-child', 'nth-child', 'nth-last-child',
  'first-of-type', 'last-of-type', 'only-of-type', 'nth-of-type',
  'nth-last-of-type',
  // What they hold is collected as names of its own.
  'not', 'is', 'where', 'has',
  // Attributes: `lang` (and the document's language, an element of its
  // own), `href`, `disabled` (of the element or of a `<fieldset>` around
  // it), `required`. A link's `:visited` paints a colour, never a box.
  'lang', 'link', 'any-link', 'visited', 'local-link',
  'disabled', 'enabled', 'required', 'optional',
  // Pseudo-elements written the old way.
  'before', 'after', 'first-line', 'first-letter',
]);

/**
 * Whether the comparison may leave out an interaction event (D164). `names`
 * is asked only for a kind that could be left out.
 *
 * It fails closed: only when no sheet mentions a pseudo-class the event
 * itself changes, and every pseudo-class any sheet mentions is one only a
 * mutation can change. A pseudo-class of another kind of event is not
 * taken to be that event's alone: a key that scrolls the page moves
 * `:hover` with no pointer event, and a handler can move the focus.
 */
export function sourceVisibilityEventMaySkip(
  type: string,
  names: () => SourceStyleNames | undefined,
): boolean {
  const pseudoClasses = Object.hasOwn(EVENT_PSEUDO_CLASSES, type)
    ? EVENT_PSEUDO_CLASSES[type]
    : undefined;
  if (!pseudoClasses) return false;
  const mentioned = names();
  if (!mentioned) return false;
  if (pseudoClasses.some((name) => mentioned.pseudoClasses.has(name))) return false;
  for (const name of mentioned.pseudoClasses) {
    if (!MUTATION_ONLY_PSEUDO_CLASSES.has(name)) return false;
  }
  return true;
}

/** The sheets of one owner, as the census last read them. */
interface OwnerSheets {
  /** The signature the poll gave them; names are read again when it changes. */
  readonly signature: string;
  /** Undefined when a sheet could not be read whole: every name counts. */
  readonly names: SourceStyleNames | undefined;
  /** The owner's own list of sheets, in its order. */
  readonly listed: readonly CSSStyleSheet[];
  /** Every sheet read, imported ones too, with its count of rules. */
  readonly ruleCounts: ReadonlyArray<readonly [CSSStyleSheet, number]>;
}

interface OwnerCensus {
  ordinary?: OwnerSheets;
  adopted?: OwnerSheets;
}

/** What one read of an owner's sheets collected for the census. */
export interface SourceStyleSheetCollection {
  /** False when a sheet could not be read, or was read only by its shape. */
  complete: boolean;
  /** The text of every rule read whole. */
  readonly texts: string[];
  readonly ruleCounts: Array<readonly [CSSStyleSheet, number]>;
  /** The names of cross-origin sheets the page's cache gave (D180). */
  readonly names: SourceStyleNames[];
  /**
   * The names of a sheet the page may not read (another origin's), when
   * they are known (`SourceCrossOriginSheetNames`): undefined leaves the
   * collection incomplete.
   */
  readonly crossOrigin?: (sheet: CSSStyleSheet) => SourceStyleNames | undefined;
}

export function createSourceStyleSheetCollection(
  crossOrigin?: (sheet: CSSStyleSheet) => SourceStyleNames | undefined,
): SourceStyleSheetCollection {
  return { complete: true, texts: [], ruleCounts: [], names: [], crossOrigin };
}

/** Reads a cross-origin sheet's text, or answers undefined (D180). */
export type SourceCrossOriginSheetReader = (
  href: string,
) => Promise<string | undefined>;

/** Cross-origin sheets of one document whose text is asked for, at most (D180). */
const MAX_CROSS_ORIGIN_SHEETS = 32;
/** The longest cross-origin sheet whose names are read (D180). */
const MAX_CROSS_ORIGIN_SHEET_CHARACTERS = 2 * 1024 * 1024;

/**
 * The names a cross-origin style sheet mentions, read from the copy the
 * browser keeps of it (owner ruling D175, built in D180). The page may not
 * read such a sheet's rules, so every name counted and the comparison of
 * what the page paints ran at every change on a page with a sheet from a
 * CDN. The sheet's text is asked for with `cache: 'force-cache'` and no
 * credentials, once a sheet, only for a sheet the page itself loaded
 * (Resource Timing names it), and only from the page's script: that is
 * where Chrome keeps the page's copy (the cache is kept apart for each
 * site, and the extension's worker asked the server again, D180). The
 * server must allow it to be read (CORS), as CDNs do for style sheets; a
 * sheet it does not let be read keeps every name counted. The text is used
 * for the names alone and kept nowhere.
 */
export class SourceCrossOriginSheetNames {
  readonly #read: SourceCrossOriginSheetReader | undefined;
  readonly #baseOrigin: string;
  readonly #asked = new Map<string, SourceStyleNames | 'pending' | 'refused'>();

  constructor(
    read: SourceCrossOriginSheetReader | undefined,
    baseOrigin: string,
  ) {
    this.#read = read;
    this.#baseOrigin = baseOrigin;
  }

  /**
   * The sheet's names, once its text has been read; the first ask starts
   * the read. Undefined for a sheet of the page's own origin, which is read
   * through its rules, and for one that cannot be read.
   */
  names(sheet: CSSStyleSheet): SourceStyleNames | undefined {
    let href: string | null | undefined;
    try {
      href = sheet.href;
    } catch {
      return undefined;
    }
    if (!href || !this.#read) return undefined;
    const known = this.#asked.get(href);
    if (known !== undefined) return typeof known === 'object' ? known : undefined;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return undefined;
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.origin === this.#baseOrigin ||
      this.#asked.size >= MAX_CROSS_ORIGIN_SHEETS
    ) return undefined;
    this.#asked.set(href, 'pending');
    let reading: Promise<string | undefined>;
    try {
      reading = this.#read(href);
    } catch {
      this.#asked.set(href, 'refused');
      return undefined;
    }
    void reading.then((text) => {
      if (typeof text !== 'string' || text.length > MAX_CROSS_ORIGIN_SHEET_CHARACTERS) {
        this.#asked.set(href, 'refused');
        return;
      }
      const names = createSourceStyleNames();
      collectSourceStyleNames(text, names);
      this.#asked.set(href, names);
    }, () => {
      this.#asked.set(href, 'refused');
    });
    return undefined;
  }
}

/**
 * The default reader of a cross-origin sheet (D180): only a sheet the page
 * loaded in this document, from the page's copy, with no credentials.
 */
export function readCrossOriginSheetFromPageCache(
  sourceWindow: Window,
): SourceCrossOriginSheetReader | undefined {
  const fetchSheet = (sourceWindow as { fetch?: typeof fetch }).fetch;
  const performance = (sourceWindow as { performance?: Performance }).performance;
  if (typeof fetchSheet !== 'function' || !performance) return undefined;
  return async (href) => {
    try {
      if (performance.getEntriesByName(href, 'resource').length === 0) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    const response = await fetchSheet.call(sourceWindow, href, {
      cache: 'force-cache',
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return undefined;
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_CROSS_ORIGIN_SHEET_CHARACTERS * 4) {
      return undefined;
    }
    return await response.text();
  };
}

/**
 * More owners than this, or more sheets, and the check made before the
 * names are believed is not cheap any more: every name counts.
 */
const MAX_CENSUS_OWNERS = 256;
const MAX_CENSUS_SHEETS = 2_048;

/**
 * The names every style owner of the page (the document and each shadow
 * root the mirror holds) mentions, as the style poll last read them (D164).
 * Usable only when every owner has been read whole, by both its own sheets
 * and its adopted ones, and when a cheap look finds each owner's sheets as
 * they were read: the same sheets in the same order, each with the same
 * count of rules (a rule inserted by script changes it). A change the look
 * cannot see (a rule's text rewritten in place) is found by the poll, which
 * then compares the whole page and reads the names again.
 */
export class SourceStyleNameCensus {
  #owners = new WeakMap<object, OwnerCensus>();
  #version = 0;
  #union:
    | {
      readonly version: number;
      readonly owners: readonly object[];
      readonly names: SourceStyleNames | undefined;
    }
    | undefined;

  /** The owner's own sheets, read by the poll with `collection`. */
  noteOrdinary(
    owner: Document | ShadowRoot,
    signature: string | undefined,
    collection: SourceStyleSheetCollection,
  ): void {
    const census = this.#census(owner);
    const known = census.ordinary;
    const listed = listSheets(() => owner.styleSheets);
    // The signature is of every rule's text: the same, the same names.
    census.ordinary = this.#sheets(
      known,
      signature,
      listed,
      collection.complete && signature !== undefined && listed !== undefined,
      collection.ruleCounts,
      collection.texts,
      known?.names !== undefined && known.signature === signature,
      collection.names,
    );
  }

  /**
   * The owner's adopted sheets, which the poll reads through the
   * sanitizer: their names are read here from the sheets themselves, when
   * the poll's signature of them changes or they are other sheets.
   */
  noteAdopted(owner: Document | ShadowRoot, signature: string): void {
    const census = this.#census(owner);
    const known = census.adopted;
    const listed = listSheets(() => owner.adoptedStyleSheets);
    const collection = createSourceStyleSheetCollection();
    // The same sheets with the same signature were read already, whole or
    // not: only the counts are taken again. A sheet too long to read is not
    // read again at every poll.
    // A rule inserted into a sheet is a change too, whatever the signature.
    const reuse = known !== undefined && known.signature === signature &&
      listed !== undefined && sameSheets(known.listed, listed) &&
      known.ruleCounts.every(([sheet, count]) => ruleCount(sheet) === count);
    if (reuse) {
      if (!known.names) collection.complete = false;
      for (const item of known.ruleCounts) collection.ruleCounts.push(item);
    } else if (listed) {
      for (const sheet of listed) collectSheet(sheet, collection, new Set(), 0);
    }
    census.adopted = this.#sheets(
      known,
      signature,
      listed,
      collection.complete && listed !== undefined,
      collection.ruleCounts,
      collection.texts,
      reuse,
    );
  }

  /** A `<style>` or `<link>` of the owner changed: read it again first. */
  forget(owner: object): void {
    if (!this.#owners.has(owner)) return;
    this.#owners.delete(owner);
    this.#version += 1;
  }

  reset(): void {
    this.#owners = new WeakMap();
    this.#version += 1;
    this.#union = undefined;
  }

  /**
   * What the sheets of `owners` mention, or undefined when every name
   * counts as mentioned.
   */
  names(owners: readonly (Document | ShadowRoot)[]): SourceStyleNames | undefined {
    if (owners.length === 0 || owners.length > MAX_CENSUS_OWNERS) return undefined;
    let sheets = 0;
    for (const owner of owners) {
      const census = this.#owners.get(owner);
      const ordinary = census?.ordinary;
      const adopted = census?.adopted;
      if (!ordinary?.names || !adopted?.names) return undefined;
      sheets += ordinary.ruleCounts.length + adopted.ruleCounts.length;
      if (sheets > MAX_CENSUS_SHEETS) return undefined;
      if (
        !stillAsRead(ordinary, () => owner.styleSheets) ||
        !stillAsRead(adopted, () => owner.adoptedStyleSheets)
      ) return undefined;
    }
    const union = this.#union;
    if (
      union && union.version === this.#version &&
      union.owners.length === owners.length &&
      union.owners.every((owner, index) => owner === owners[index])
    ) return union.names;
    const names = createSourceStyleNames();
    for (const owner of owners) {
      const census = this.#owners.get(owner)!;
      for (const part of [census.ordinary!.names!, census.adopted!.names!]) {
        mergeSourceStyleNames(part, names);
      }
    }
    this.#union = { version: this.#version, owners: [...owners], names };
    return names;
  }

  #census(owner: object): OwnerCensus {
    let census = this.#owners.get(owner);
    if (!census) {
      census = {};
      this.#owners.set(owner, census);
    }
    return census;
  }

  #sheets(
    known: OwnerSheets | undefined,
    signature: string | undefined,
    listed: readonly CSSStyleSheet[] | undefined,
    complete: boolean,
    ruleCounts: ReadonlyArray<readonly [CSSStyleSheet, number]>,
    texts: readonly string[],
    reuseNames: boolean,
    crossOriginNames: readonly SourceStyleNames[] = [],
  ): OwnerSheets {
    let names: SourceStyleNames | undefined;
    if (!complete || signature === undefined || !listed) {
      names = undefined;
    } else if (reuseNames && known?.names) {
      names = known.names;
    } else {
      const collected = createSourceStyleNames();
      for (const text of texts) collectSourceStyleNames(text, collected);
      for (const part of crossOriginNames) mergeSourceStyleNames(part, collected);
      names = collected;
    }
    if (names !== known?.names) this.#version += 1;
    return Object.freeze({
      signature: signature ?? '',
      names,
      listed: listed ?? [],
      ruleCounts: Object.freeze([...ruleCounts]),
    });
  }
}

function mergeSourceStyleNames(
  part: SourceStyleNames,
  names: MutableSourceStyleNames,
): void {
  for (const name of part.classes) names.classes.add(name);
  for (const name of part.ids) names.ids.add(name);
  for (const name of part.attributes) names.attributes.add(name);
  for (const name of part.attributeReads) names.attributeReads.add(name);
  for (const name of part.pseudoClasses) names.pseudoClasses.add(name);
  for (const name of part.pseudoElements) names.pseudoElements.add(name);
  for (const name of part.hidingClasses) names.hidingClasses.add(name);
}

function listSheets(
  read: () => ArrayLike<CSSStyleSheet> | null | undefined,
): readonly CSSStyleSheet[] | undefined {
  try {
    const sheets = read();
    if (!sheets) return [];
    const length = sheets.length;
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    const listed: CSSStyleSheet[] = [];
    for (let index = 0; index < length; index += 1) {
      const sheet = sheets[index];
      if (sheet) listed.push(sheet);
    }
    return listed;
  } catch {
    return undefined;
  }
}

function sameSheets(
  known: readonly CSSStyleSheet[],
  listed: readonly CSSStyleSheet[],
): boolean {
  return known.length === listed.length &&
    known.every((sheet, index) => sheet === listed[index]);
}

function ruleCount(sheet: CSSStyleSheet): number | undefined {
  try {
    const count = sheet.cssRules.length;
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

/** The cheap look: the same sheets, in the same order, the same rule counts. */
function stillAsRead(
  sheets: OwnerSheets,
  read: () => ArrayLike<CSSStyleSheet> | null | undefined,
): boolean {
  try {
    const current = read();
    const length = current?.length ?? 0;
    if (length !== sheets.listed.length) return false;
    for (let index = 0; index < length; index += 1) {
      if (current![index] !== sheets.listed[index]) return false;
    }
  } catch {
    return false;
  }
  for (const [sheet, count] of sheets.ruleCounts) {
    if (ruleCount(sheet) !== count) return false;
  }
  return true;
}

/** The longest sheet the census reads whole, as the poll (D95). */
const MAX_COLLECTED_RULES_PER_SHEET = 4_000;
const MAX_COLLECTED_CHARACTERS_PER_SHEET = 256 * 1024;

/** Reads an adopted sheet, and what it imports, into `collection`. */
function collectSheet(
  sheet: CSSStyleSheet,
  collection: SourceStyleSheetCollection,
  visited: Set<CSSStyleSheet>,
  depth: number,
): void {
  if (depth > 8 || visited.has(sheet)) return;
  visited.add(sheet);
  try {
    const rules = sheet.cssRules;
    const count = rules.length;
    if (
      !Number.isSafeInteger(count) || count < 0 ||
      count > MAX_COLLECTED_RULES_PER_SHEET
    ) {
      collection.complete = false;
      return;
    }
    collection.ruleCounts.push([sheet, count]);
    let characters = 0;
    for (let index = 0; index < count; index += 1) {
      const rule = rules[index] ?? rules.item(index);
      const text = rule?.cssText;
      if (typeof text !== 'string') {
        collection.complete = false;
        return;
      }
      characters += text.length;
      if (characters > MAX_COLLECTED_CHARACTERS_PER_SHEET) {
        collection.complete = false;
        return;
      }
      collection.texts.push(text);
      const imported = (rule as CSSRule & {
        readonly styleSheet?: CSSStyleSheet | null;
      }).styleSheet;
      if (imported) collectSheet(imported, collection, visited, depth + 1);
    }
  } catch {
    collection.complete = false;
  } finally {
    visited.delete(sheet);
  }
}
