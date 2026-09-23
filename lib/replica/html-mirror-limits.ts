/**
 * The mirror's size limits (D63, D64). They keep the tab and the panel
 * responsive; they do not protect data. Three are Advanced settings; every
 * other cap follows from them.
 *
 * Both sides of one mirror must use the same values: the panel applies the
 * settings before it opens a session and sends them in the start message, and
 * the page applies them from there. The values are live bindings, so modules
 * that import them read the current settings.
 */

const MIB = 1024 * 1024;

/** Characters one CSS rule takes at least, for rule caps that follow sizes. */
const MIN_CSS_CHARACTERS_PER_RULE = 16;

export interface HtmlMirrorLimitSettings {
  /** Any one string (stylesheet, text, attribute, URL), in MiB of characters. */
  readonly itemMegabytes: number;
  /**
   * The whole page in MiB, counted as memory (two bytes per character). A
   * checkpoint crosses the runtime port as one message and Chrome refuses a
   * message above 64 MiB, so this stays at or below 60.
   */
  readonly pageMegabytes: number;
  /** Nodes (elements and text) one mirror may copy. */
  readonly maxElements: number;
}

export const HTML_MIRROR_LIMIT_RANGES = Object.freeze({
  // Above half the largest page, an item could never fit.
  itemMegabytes: Object.freeze({ min: 1, max: 30, defaultValue: 10 }),
  pageMegabytes: Object.freeze({ min: 1, max: 60, defaultValue: 60 }),
  maxElements: Object.freeze({ min: 1_000, max: 1_000_000, defaultValue: 200_000 }),
});

export type HtmlMirrorLimitKey = keyof typeof HTML_MIRROR_LIMIT_RANGES;

export const DEFAULT_HTML_MIRROR_LIMIT_SETTINGS: HtmlMirrorLimitSettings =
  Object.freeze({
    itemMegabytes: HTML_MIRROR_LIMIT_RANGES.itemMegabytes.defaultValue,
    pageMegabytes: HTML_MIRROR_LIMIT_RANGES.pageMegabytes.defaultValue,
    maxElements: HTML_MIRROR_LIMIT_RANGES.maxElements.defaultValue,
  });

/** Walks that must never stop short of the node cap use its largest setting. */
export const MAX_HTML_MIRROR_NODES_SETTING = HTML_MIRROR_LIMIT_RANGES.maxElements.max;

export let MAX_HTML_MIRROR_STRING = 0;
export let MAX_HTML_MIRROR_BYTES = 0;
export let MAX_HTML_MIRROR_NODES = 0;
/** Adopted sheets of one document or shadow root, and one sheet's rules. */
export let MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER = 0;
export let MAX_ADOPTED_STYLE_RULES_PER_OWNER = 0;
export let MAX_HTML_MIRROR_ADOPTED_STYLE_RULES = 0;

let currentSettings = DEFAULT_HTML_MIRROR_LIMIT_SETTINGS;

export function applyHtmlMirrorLimitSettings(
  settings: HtmlMirrorLimitSettings = DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
): void {
  currentSettings = readHtmlMirrorLimitSettings(settings) ??
    DEFAULT_HTML_MIRROR_LIMIT_SETTINGS;
  MAX_HTML_MIRROR_STRING = currentSettings.itemMegabytes * MIB;
  MAX_HTML_MIRROR_BYTES = currentSettings.pageMegabytes * MIB;
  MAX_HTML_MIRROR_NODES = currentSettings.maxElements;
  MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER = MAX_HTML_MIRROR_STRING;
  MAX_ADOPTED_STYLE_RULES_PER_OWNER = Math.floor(
    MAX_HTML_MIRROR_STRING / MIN_CSS_CHARACTERS_PER_RULE,
  );
  MAX_HTML_MIRROR_ADOPTED_STYLE_RULES = Math.floor(
    MAX_HTML_MIRROR_BYTES / 2 / MIN_CSS_CHARACTERS_PER_RULE,
  );
}

export function currentHtmlMirrorLimitSettings(): HtmlMirrorLimitSettings {
  return currentSettings;
}

export function isHtmlMirrorLimitValue(
  key: HtmlMirrorLimitKey,
  value: unknown,
): value is number {
  const range = HTML_MIRROR_LIMIT_RANGES[key];
  return Number.isSafeInteger(value) &&
    Number(value) >= range.min &&
    Number(value) <= range.max;
}

/** Exact settings, or undefined; used for messages and committed patches. */
export function readHtmlMirrorLimitSettings(
  input: unknown,
): HtmlMirrorLimitSettings | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !isHtmlMirrorLimitValue('itemMegabytes', record.itemMegabytes) ||
    !isHtmlMirrorLimitValue('pageMegabytes', record.pageMegabytes) ||
    !isHtmlMirrorLimitValue('maxElements', record.maxElements)
  ) return undefined;
  return Object.freeze({
    itemMegabytes: record.itemMegabytes,
    pageMegabytes: record.pageMegabytes,
    maxElements: record.maxElements,
  });
}

/** Repairs one stored value: a number is clamped, anything else defaults. */
export function repairHtmlMirrorLimitValue(
  key: HtmlMirrorLimitKey,
  value: unknown,
): number {
  const range = HTML_MIRROR_LIMIT_RANGES[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return range.defaultValue;
  }
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

applyHtmlMirrorLimitSettings();
