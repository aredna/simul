/**
 * The address a linked style sheet came from, when the server answered its
 * link's address with a redirect (D180).
 *
 * Chrome resolves a sheet's relative `url()` against the address the sheet
 * finally came from, but the CSSOM tells a script only the link's address
 * (`CSSStyleSheet.href`) and the `url()` as written: a sheet linked as
 * `/r?to=/deep/er/made.css` with `url(img.png)` is drawn with
 * `/deep/er/img.png` in the tab, and the mirror, which resolved it against
 * the link, asked for `/img.png` (checked in Chrome 158). Resource Timing
 * says whether a sheet of the page's own origin was redirected; for such a
 * sheet the address is asked for once, by a request that follows the
 * redirect from the browser's copy where it has one, without cookies, and
 * whose body is not read.
 */

const BASES = new WeakMap<CSSStyleSheet, string>();
const ASKED = new WeakSet<CSSStyleSheet>();
let asking = 0;
/** Requests at once, at most: a page of hundreds of redirected sheets is rare. */
const MAX_ASKING = 8;

/** The address the sheet came from, when it is known to differ from its `href`. */
export function readSourceSheetBase(sheet: CSSStyleSheet): string | undefined {
  return BASES.get(sheet);
}

/**
 * Asks, once a sheet, where a redirected sheet came from; `learned` is
 * called when the answer differs from its `href`. Nothing for a sheet that
 * was not redirected, or whose timing the page may not read.
 */
export function learnSourceSheetBase(
  sheet: CSSStyleSheet,
  sourceWindow: Window,
  learned: (sheet: CSSStyleSheet) => void,
): void {
  if (ASKED.has(sheet) || asking >= MAX_ASKING) return;
  let href: string | null | undefined;
  try {
    href = sheet.href;
  } catch {
    return;
  }
  ASKED.add(sheet);
  if (!href || !/^https?:/iu.test(href)) return;
  const performance = (sourceWindow as { performance?: Performance }).performance;
  const fetchSheet = (sourceWindow as { fetch?: typeof fetch }).fetch;
  if (!performance || typeof fetchSheet !== 'function') return;
  let redirected = false;
  try {
    for (const entry of performance.getEntriesByName(href, 'resource')) {
      const timing = entry as PerformanceResourceTiming;
      if (timing.redirectEnd > 0 || timing.redirectStart > 0) redirected = true;
    }
  } catch {
    return;
  }
  if (!redirected) return;
  asking += 1;
  void (async () => {
    try {
      const controller = new AbortController();
      const response = await fetchSheet.call(sourceWindow, href, {
        cache: 'force-cache',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      // Only the address: the body is not read.
      controller.abort();
      const final = response.url;
      if (response.redirected && final && final !== href && /^https?:/iu.test(final)) {
        BASES.set(sheet, final);
        learned(sheet);
      }
    } catch {
      // Not known: the link's address stands.
    } finally {
      asking -= 1;
    }
  })();
}
