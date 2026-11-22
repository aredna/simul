/**
 * How far the rules of a style sheet that make text secret reach from the
 * element a change touches (D188, D191). The panel asks again, after a live
 * patch, only what the patch touched; a rule that declares
 * `-webkit-text-security` under a sibling combinator, `:has()` and the like
 * makes a text secret beyond it, so the panel asks more, or everything.
 * The panel reads the mirror's sheets; a sheet the mirror holds only by its
 * address (a link to another origin) is read by the page, which says how far
 * each one it could read reaches (`readPageLinkedSheets`).
 */
import type { SourceCrossOriginSheetReader } from './source-style-names';
import {
  sourceProperty,
} from './source-node-accessors';

/**
 * How far a change of one node may change what a sheet makes secret
 * elsewhere (D188), from the rules that declare text security: within its
 * own subtree, which a scoped refresh asks;
 * to the siblings after it (`+`, `~`); or anywhere (`:has()`, which styles
 * what holds a node or comes before it, `:nth-child(… of …)`, a container
 * query, which follows sizes the layout changes anywhere, or a sheet that
 * cannot be read, which fails closed).
 */
export type ReplicaSelectorReach = 'subtree' | 'siblings' | 'everything';

const SELECTOR_REACH_ORDER: readonly ReplicaSelectorReach[] = ['subtree', 'siblings', 'everything'];

export function widerReach(
  first: ReplicaSelectorReach,
  second: ReplicaSelectorReach,
): ReplicaSelectorReach {
  return SELECTOR_REACH_ORDER.indexOf(first) >= SELECTOR_REACH_ORDER.indexOf(second)
    ? first
    : second;
}

/** The reach of one rule's prelude: a selector list or an at-rule's. */
function preludeReach(prelude: string): ReplicaSelectorReach {
  const text = prelude.trim();
  if (/^@container\b/iu.test(text)) return 'everything';
  if (/:has\(/iu.test(text)) return 'everything';
  if (/:nth-(?:last-)?child\([^)]*\bof\b/iu.test(text)) return 'everything';
  // What may hold `+` or `~` and is no combinator: attribute selectors
  // (`[class~=a]`) and `an+b` arguments.
  const bare = text
    .replace(/\[[^\]]*\]/gu, '')
    .replace(/:nth-[a-z-]+\([^)]*\)/giu, '');
  return /[+~]/u.test(bare) ? 'siblings' : 'subtree';
}

/**
 * Whether a declaration may change what the receiver reads of style: the
 * computed `-webkit-text-security` alone, which `all` may also make inherit.
 */
const TEXT_SECURITY_DECLARATION = /(?:^|[\s;{])(?:-webkit-text-security|text-security|all)\s*:/iu;

/**
 * The reach of a sheet's text (D188). Comments and strings out, every text
 * before a `{` is a prelude and opens a block, `}` closes it, and a
 * declaration ends at `;` or `}`. Only a rule that declares text security
 * counts, with the preludes of every block around it (a nested rule's `&`
 * is its parent's selector). An `@import` brings rules this text does not
 * hold, so it reaches everywhere.
 */
export function styleSheetTextReach(text: string): ReplicaSelectorReach {
  const plain = plainSheetText(text);
  if (/@import\b/iu.test(plain)) return 'everything';
  if (!TEXT_SECURITY_DECLARATION.test(plain)) return 'subtree';
  let reach: ReplicaSelectorReach = 'subtree';
  const blocks: ReplicaSelectorReach[] = [];
  let start = 0;
  for (let index = 0; index < plain.length; index += 1) {
    const character = plain[index];
    if (character !== '{' && character !== '}' && character !== ';') continue;
    const segment = plain.slice(start, index);
    start = index + 1;
    if (character === '{') {
      blocks.push(widerReach(blocks.at(-1) ?? 'subtree', preludeReach(segment)));
      continue;
    }
    if (blocks.length > 0 && TEXT_SECURITY_DECLARATION.test(` ${segment}`)) {
      reach = widerReach(reach, blocks.at(-1)!);
      if (reach === 'everything') return reach;
    }
    if (character === '}') blocks.pop();
  }
  return reach;
}

/** A sheet's text with comments and strings left out. */
function plainSheetText(text: string): string {
  return text.replace(
    /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/gu,
    (match) => (match.startsWith('/*') ? ' ' : '""'),
  );
}

/**
 * A declaration through which a sheet changes what the semantic scan
 * classifies an element as (D217): text security makes it, and all it
 * holds, a secret. Anything else a sheet declares leaves the classification
 * alone, which reads attributes and the tree; an editor a sheet makes is
 * marked when the page edits it (D192), which the scan asks every time.
 * A property name written with an escape may spell it, and counts.
 */
const CLASSIFYING_DECLARATION =
  /(?:^|[\s;{])(?:(?:-webkit-)?text-security|[-\w]*\\[-\w\\]*)\s*:/iu;

/**
 * Whether a sheet's text may change what the scan classifies an element as
 * by style alone (D217): it declares one of those, or imports a sheet this
 * text does not hold. A rule of either kind, under any selector, may start
 * or stop matching with no change to the tree (`:hover`, `:focus`), so the
 * scan classifies every element anew while such a sheet is on the page.
 */
export function styleSheetTextClassifies(text: string): boolean {
  const plain = plainSheetText(text);
  return /@import\b/iu.test(plain) || CLASSIFYING_DECLARATION.test(plain);
}

/** `styleSheetTextClassifies` of a sheet read through its rules; throws where it cannot be read. */
function cssRulesClassify(sheet: CSSStyleSheet): boolean {
  for (const rule of Array.from(sheet.cssRules)) {
    if ((rule as Partial<CSSImportRule>).styleSheet !== undefined) return true;
    if (styleSheetTextClassifies(rule.cssText)) return true;
  }
  return false;
}

/** The reach of a sheet read through its rules; throws where it cannot be read. */
export function cssRulesReach(sheet: CSSStyleSheet): ReplicaSelectorReach {
  let reach: ReplicaSelectorReach = 'subtree';
  for (const rule of Array.from(sheet.cssRules)) {
    const imported = (rule as Partial<CSSImportRule>).styleSheet;
    reach = widerReach(
      reach,
      imported ? cssRulesReach(imported) : styleSheetTextReach(rule.cssText),
    );
    if (reach === 'everything') return reach;
  }
  return reach;
}


/** What the page says of its stylesheet links (D191): see the batch field. */
export interface PageLinkedSheets {
  /** How far the rules of the sheets in `hrefs` reach, together. */
  readonly reach: ReplicaSelectorReach;
  /** The address of every link sheet the page read, as `sheet.href`. */
  readonly hrefs: readonly string[];
}

export const MAX_PAGE_LINKED_SHEETS = 64;
export const MAX_PAGE_LINKED_SHEET_HREF_LENGTH = 2_048;
/** The longest cross-origin sheet read, as the census (D180). */
const MAX_CROSS_ORIGIN_SHEET_CHARACTERS = 2 * 1024 * 1024;

const READ_SHEET_REACH = new WeakMap<CSSStyleSheet, {
  readonly count: number;
  readonly reach: ReplicaSelectorReach;
}>();
/** What a sheet of another origin was read to say, by its address (D191, D217). */
interface CrossOriginSheetFacts {
  readonly reach: ReplicaSelectorReach;
  readonly classifies: boolean;
}
const CROSS_ORIGIN_SHEET_REACH = new WeakMap<
  Document,
  Map<string, CrossOriginSheetFacts | 'pending' | 'refused'>
>();
const READ_SHEET_CLASSIFIES = new WeakMap<CSSStyleSheet, {
  readonly count: number;
  readonly classifies: boolean;
}>();

/**
 * How far the page's stylesheet links reach (D191), each read once: one of
 * its own origin through its rules, one of another origin from the copy the
 * page keeps of it (`readCrossOriginSheetFromPageCache`, D180), which the
 * server must let be read (CORS). A link not read yet, or not to be read,
 * is left out of `hrefs`, and the panel asks everything for it. `onRead` is
 * told when a sheet's text has been read since.
 */
export function readPageLinkedSheets(
  document: Document,
  read: SourceCrossOriginSheetReader | undefined,
  onRead: () => void,
): PageLinkedSheets {
  let reach: ReplicaSelectorReach = 'subtree';
  const hrefs: string[] = [];
  const sheets = sourceProperty(document, 'styleSheets');
  const length = Math.min(sheets?.length ?? 0, 2_048);
  for (let index = 0; index < length && hrefs.length < MAX_PAGE_LINKED_SHEETS; index += 1) {
    const sheet = sheets[index];
    const owner = sheet?.ownerNode as Element | null | undefined;
    if (!sheet || owner?.nodeType !== 1 || owner.localName.toLowerCase() !== 'link') continue;
    const href = sheet.href;
    if (
      !href || href.length > MAX_PAGE_LINKED_SHEET_HREF_LENGTH ||
      !/^https?:/iu.test(href) || hrefs.includes(href)
    ) continue;
    const known = pageSheetReach(document, sheet, href, read, onRead);
    if (known === undefined) continue;
    hrefs.push(href);
    reach = widerReach(reach, known.reach);
  }
  return Object.freeze({ reach, hrefs: Object.freeze(hrefs) });
}

function pageSheetReach(
  document: Document,
  sheet: CSSStyleSheet,
  href: string,
  read: SourceCrossOriginSheetReader | undefined,
  onRead: () => void,
): CrossOriginSheetFacts | undefined {
  try {
    const count = sheet.cssRules.length;
    const known = READ_SHEET_REACH.get(sheet);
    if (known?.count === count) return { reach: known.reach, classifies: readSheetClassifies(sheet) };
    const reach = cssRulesReach(sheet);
    READ_SHEET_REACH.set(sheet, { count, reach });
    return { reach, classifies: readSheetClassifies(sheet) };
  } catch {
    // Another origin's, or one that imports another origin's: its text.
  }
  let asked = CROSS_ORIGIN_SHEET_REACH.get(document);
  if (!asked) {
    asked = new Map();
    CROSS_ORIGIN_SHEET_REACH.set(document, asked);
  }
  const known = asked.get(href);
  if (known !== undefined) {
    return known === 'pending' || known === 'refused' ? undefined : known;
  }
  if (!read || asked.size >= MAX_PAGE_LINKED_SHEETS) return undefined;
  asked.set(href, 'pending');
  const settle = (value: CrossOriginSheetFacts | 'refused'): void => {
    asked.set(href, value);
    if (value !== 'refused') onRead();
  };
  try {
    void read(href).then((text) => {
      settle(typeof text === 'string' && text.length <= MAX_CROSS_ORIGIN_SHEET_CHARACTERS
        ? { reach: styleSheetTextReach(text), classifies: styleSheetTextClassifies(text) }
        : 'refused');
    }, () => settle('refused'));
  } catch {
    asked.set(href, 'refused');
  }
  return undefined;
}

/** `cssRulesClassify`, kept while the sheet holds as many rules; throws where it cannot be read. */
function readSheetClassifies(sheet: CSSStyleSheet): boolean {
  const count = sheet.cssRules.length;
  const known = READ_SHEET_CLASSIFIES.get(sheet);
  if (known?.count === count) return known.classifies;
  const classifies = cssRulesClassify(sheet);
  READ_SHEET_CLASSIFIES.set(sheet, { count, classifies });
  return classifies;
}

/** Sheets of one tree looked at, at most (D217); past it every sheet may classify. */
const MAX_CLASSIFYING_SHEETS = 2_048;

/**
 * Whether a sheet of the document, or of one of `roots`, may change what the
 * semantic scan classifies an element as by style alone (D217); see
 * `styleSheetTextClassifies`. A sheet that cannot be read may; a link of
 * another origin is read from the page's copy (D191) and may until it has
 * been, when `onRead` is told. The scan keeps what it classified for an
 * element the page did not change only while none may.
 */
export function sourceSheetsMayClassify(
  document: Document,
  roots: Iterable<ShadowRoot>,
  read: SourceCrossOriginSheetReader | undefined,
  onRead: () => void,
): boolean {
  try {
    for (const owner of [document, ...roots] as Array<Document | ShadowRoot>) {
      const ordinary = sourceProperty(owner as Document, 'styleSheets') as StyleSheetList | undefined;
      const adopted = sourceProperty(owner as Document, 'adoptedStyleSheets') as
        readonly CSSStyleSheet[] | undefined;
      const sheets: CSSStyleSheet[] = [];
      for (let index = 0; index < (ordinary?.length ?? 0); index += 1) {
        if (sheets.length >= MAX_CLASSIFYING_SHEETS) return true;
        sheets.push(ordinary![index] as CSSStyleSheet);
      }
      for (const sheet of adopted ?? []) {
        if (sheets.length >= MAX_CLASSIFYING_SHEETS) return true;
        sheets.push(sheet);
      }
      for (const sheet of sheets) {
        if (!sheet) return true;
        try {
          if (readSheetClassifies(sheet)) return true;
          continue;
        } catch {
          // Another origin's: its text, as the page keeps it.
        }
        const href = sheet.href;
        if (!href || owner !== document) return true;
        const known = pageSheetReach(document, sheet, href, read, onRead);
        if (!known || known.classifies) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}
