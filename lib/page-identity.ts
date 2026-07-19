export interface CapturedPageIdentity {
  tabId: number;
  windowId: number;
  url: string;
}

export interface BrowserTabIdentity {
  id?: number;
  windowId?: number;
  url?: string;
}

export interface DetachedPageIdentityHint {
  tabId: number;
  windowId: number;
}

/** Parse the explicit source identity attached to a detached companion URL.
 * Missing parameters must not be coerced to zero because the native side
 * panel intentionally has no query string. */
export function parseDetachedPageIdentityHint(
  search: string,
): DetachedPageIdentityHint | undefined {
  const parameters = new URLSearchParams(search);
  const tabIdParameter = parameters.get('sourceTabId');
  const windowIdParameter = parameters.get('sourceWindowId');
  if (
    tabIdParameter === null ||
    windowIdParameter === null ||
    !/^\d+$/u.test(tabIdParameter) ||
    !/^\d+$/u.test(windowIdParameter)
  ) return undefined;
  const tabId = Number(tabIdParameter);
  const windowId = Number(windowIdParameter);
  return Number.isSafeInteger(tabId) && Number.isSafeInteger(windowId)
    ? { tabId, windowId }
    : undefined;
}

/** Missing URLs are stale: activeTab access may have expired or the tab may be
 * restricted, and either case must not leave old companion content visible. */
export function isSamePageIdentity(
  captured: CapturedPageIdentity | undefined,
  current: BrowserTabIdentity | undefined,
): boolean {
  return Boolean(
    captured &&
      current &&
      current.id === captured.tabId &&
      current.windowId === captured.windowId &&
      typeof current.url === 'string' &&
      current.url.length > 0 &&
      current.url === captured.url,
  );
}
