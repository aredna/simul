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
