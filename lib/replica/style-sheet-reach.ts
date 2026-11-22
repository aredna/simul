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
  const plain = text.replace(
    /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'/gu,
    (match) => (match.startsWith('/*') ? ' ' : '""'),
  );
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
const CROSS_ORIGIN_SHEET_REACH = new WeakMap<
  Document,
  Map<string, ReplicaSelectorReach | 'pending' | 'refused'>
>();

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
    reach = widerReach(reach, known);
  }
  return Object.freeze({ reach, hrefs: Object.freeze(hrefs) });
}

function pageSheetReach(
  document: Document,
  sheet: CSSStyleSheet,
  href: string,
  read: SourceCrossOriginSheetReader | undefined,
  onRead: () => void,
): ReplicaSelectorReach | undefined {
  try {
    const count = sheet.cssRules.length;
    const known = READ_SHEET_REACH.get(sheet);
    if (known?.count === count) return known.reach;
    const reach = cssRulesReach(sheet);
    READ_SHEET_REACH.set(sheet, { count, reach });
    return reach;
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
  const settle = (value: ReplicaSelectorReach | 'refused'): void => {
    asked.set(href, value);
    if (value !== 'refused') onRead();
  };
  try {
    void read(href).then((text) => {
      settle(typeof text === 'string' && text.length <= MAX_CROSS_ORIGIN_SHEET_CHARACTERS
        ? styleSheetTextReach(text)
        : 'refused');
    }, () => settle('refused'));
  } catch {
    asked.set(href, 'refused');
  }
  return undefined;
}
