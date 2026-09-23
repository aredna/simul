import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

import {
  DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
  applyHtmlMirrorLimitSettings,
  currentHtmlMirrorLimitSettings,
  readHtmlMirrorLimitSettings,
  repairHtmlMirrorLimitValue,
} from '../lib/replica/html-mirror-limits';
import {
  MAX_ADOPTED_STYLE_RULES_PER_OWNER,
  MAX_HTML_MIRROR_ADOPTED_STYLE_RULES,
  MAX_HTML_MIRROR_BYTES,
  MAX_HTML_MIRROR_NODES,
  MAX_HTML_MIRROR_STRING,
  sanitizeSourceDocument,
  type HtmlMirrorDocumentGraph,
  type HtmlMirrorElementNode,
} from '../lib/replica/html-mirror-sanitizer';
import { WeakNodeIdRegistry } from '../lib/replica/html-mirror-source';
import { parseCompanionPreferences } from '../lib/preferences';

const MIB = 1024 * 1024;

beforeEach(() => {
  const { window } = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, {
    Node: window.Node,
    Element: window.Element,
    Text: window.Text,
  });
});
afterEach(() => applyHtmlMirrorLimitSettings());

function capture(document: Document, window: Window): HtmlMirrorDocumentGraph | undefined {
  try {
    return sanitizeSourceDocument(document, window, new WeakNodeIdRegistry());
  } catch {
    return undefined;
  }
}

describe('mirror size limits (D64)', () => {
  it('defaults to 10 MB items, 60 MB pages and 200,000 nodes', () => {
    expect(currentHtmlMirrorLimitSettings()).toEqual(DEFAULT_HTML_MIRROR_LIMIT_SETTINGS);
    expect(MAX_HTML_MIRROR_STRING).toBe(10 * MIB);
    expect(MAX_HTML_MIRROR_BYTES).toBe(60 * MIB);
    expect(MAX_HTML_MIRROR_NODES).toBe(200_000);
    expect(MAX_ADOPTED_STYLE_RULES_PER_OWNER).toBe(10 * MIB / 16);
    expect(MAX_HTML_MIRROR_ADOPTED_STYLE_RULES).toBe(60 * MIB / 2 / 16);
  });

  it('applies settings to every importer and derives the rule caps', () => {
    applyHtmlMirrorLimitSettings({ itemMegabytes: 2, pageMegabytes: 8, maxElements: 5_000 });
    expect(MAX_HTML_MIRROR_STRING).toBe(2 * MIB);
    expect(MAX_HTML_MIRROR_BYTES).toBe(8 * MIB);
    expect(MAX_HTML_MIRROR_NODES).toBe(5_000);
    expect(MAX_ADOPTED_STYLE_RULES_PER_OWNER).toBe(2 * MIB / 16);
    expect(MAX_HTML_MIRROR_ADOPTED_STYLE_RULES).toBe(8 * MIB / 2 / 16);

    // Settings out of range are never applied; the defaults are.
    applyHtmlMirrorLimitSettings({ itemMegabytes: 0, pageMegabytes: 8, maxElements: 5_000 });
    expect(currentHtmlMirrorLimitSettings()).toEqual(DEFAULT_HTML_MIRROR_LIMIT_SETTINGS);
  });

  it('reads only exact settings and repairs stored values', () => {
    const largest = { itemMegabytes: 30, pageMegabytes: 60, maxElements: 1_000_000 };
    expect(readHtmlMirrorLimitSettings(largest)).toEqual(largest);
    for (const invalid of [
      undefined,
      null,
      [],
      {},
      { ...largest, itemMegabytes: 31 },
      { ...largest, pageMegabytes: 61 },
      { ...largest, maxElements: 999 },
      { ...largest, itemMegabytes: 1.5 },
      { ...largest, itemMegabytes: '10' },
      { ...largest, extra: 1 },
    ]) {
      expect(readHtmlMirrorLimitSettings(invalid), JSON.stringify(invalid))
        .toBeUndefined();
    }
    expect(repairHtmlMirrorLimitValue('pageMegabytes', 500)).toBe(60);
    expect(repairHtmlMirrorLimitValue('maxElements', 12.4)).toBe(1_000);
    expect(repairHtmlMirrorLimitValue('itemMegabytes', 'ten')).toBe(10);
    expect(parseCompanionPreferences({
      mirrorLimits: { itemMegabytes: 99, pageMegabytes: 4 },
    }).mirrorLimits).toEqual({
      itemMegabytes: 30,
      pageMegabytes: 4,
      maxElements: 200_000,
    });
  });

  it('refuses a page over a lowered node limit and omits an item over a lowered size', () => {
    const { document, window } = parseHTML(
      `<!doctype html><html><body>${'<p>row</p>'.repeat(1_200)}` +
      '<pre id="log"></pre></body></html>',
    );
    document.querySelector('#log')!.textContent = 'x'.repeat(2 * MIB);
    const sourceWindow = window as unknown as Window;
    const log = (graph: HtmlMirrorDocumentGraph | undefined) => graph?.root.children
      .find((child): child is HtmlMirrorElementNode =>
        child.kind === 'element' && child.tagName === 'body')
      ?.children.at(-1);

    const full = capture(document, sourceWindow);
    expect(log(full)).toMatchObject({ tagName: 'pre', children: [{ kind: 'text' }] });

    applyHtmlMirrorLimitSettings({ itemMegabytes: 1, pageMegabytes: 60, maxElements: 200_000 });
    expect(log(capture(document, sourceWindow)))
      .toMatchObject({ tagName: 'pre', children: [] });

    applyHtmlMirrorLimitSettings({ itemMegabytes: 10, pageMegabytes: 60, maxElements: 1_000 });
    expect(capture(document, sourceWindow)).toBeUndefined();
  });
});
