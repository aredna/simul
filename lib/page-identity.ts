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

import type { CompanionLaunchStamp } from './companion-surface';

/** The subset of a browser tab the companion reads to identify a page. */
export interface PageTabLike extends BrowserTabIdentity {
  active?: boolean;
}

/** A page the companion cannot read: restricted URL, expired grant, timeout. */
export class PageAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageAccessError';
  }
}

export const PAGE_ACCESS_GUIDANCE =
  'Open a regular HTTP or HTTPS page, then select the extension from that page.';
export const PAGE_CHANGED_GUIDANCE =
  'The source page changed or access expired. Select the extension on the source page to authorize it again.';

export function identityFromTab(
  tab: PageTabLike | undefined,
  fallbackUrl?: string,
  requireActive = true,
): CapturedPageIdentity {
  const url = tab?.url ?? fallbackUrl;
  if (
    tab?.id === undefined ||
    tab.windowId === undefined ||
    !url ||
    !isSupportedPage(url) ||
    (requireActive && !tab.active)
  ) {
    throw new PageAccessError(PAGE_ACCESS_GUIDANCE);
  }
  return { tabId: tab.id, windowId: tab.windowId, url };
}

/** Throws when the tab no longer matches the captured identity exactly. */
export function assertSnapshotIsCurrent(
  tab: PageTabLike | undefined,
  identity: CapturedPageIdentity,
  requireActive: boolean,
): void {
  if ((requireActive && !tab?.active) || !isSamePageIdentity(identity, tab)) {
    throw new PageAccessError(PAGE_CHANGED_GUIDANCE);
  }
}

export interface AuthorizedTabMessage {
  type: 'simul:authorized-tab';
  tabId: number;
  windowId: number;
  url: string;
  launchEpoch?: string;
  launchSequence?: number;
}

export interface AuthorizedTabRequest {
  identity: CapturedPageIdentity;
  launchStamp?: CompanionLaunchStamp;
}

/** Validates the background worker's toolbar authorization message. */
export function readAuthorizedTabMessage(message: unknown): AuthorizedTabRequest | undefined {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'simul:authorized-tab' ||
    !('tabId' in message) ||
    !Number.isSafeInteger(message.tabId) ||
    Number(message.tabId) < 0 ||
    !('windowId' in message) ||
    !Number.isSafeInteger(message.windowId) ||
    Number(message.windowId) < 0 ||
    !('url' in message) ||
    typeof message.url !== 'string' ||
    !isSupportedPage(message.url)
  ) return undefined;
  const authorized = message as AuthorizedTabMessage;
  const hasLaunchStamp = authorized.launchEpoch !== undefined ||
    authorized.launchSequence !== undefined;
  if (
    hasLaunchStamp &&
    (typeof authorized.launchEpoch !== 'string' ||
      authorized.launchEpoch.length === 0 ||
      authorized.launchEpoch.length > 128 ||
      !Number.isSafeInteger(authorized.launchSequence) ||
      Number(authorized.launchSequence) <= 0)
  ) return undefined;
  return {
    identity: {
      tabId: authorized.tabId,
      windowId: authorized.windowId,
      url: authorized.url,
    },
    ...(hasLaunchStamp
      ? {
          launchStamp: {
            epoch: authorized.launchEpoch as string,
            sequence: authorized.launchSequence as number,
          },
        }
      : {}),
  };
}

/** Same page for following purposes: credentials, query and hash removed. */
export function normalizedPageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

export function isSupportedPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function hasNonDefaultPort(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).port.length > 0;
  } catch {
    return false;
  }
}

export function readableError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Something went wrong. Retry the current step.';
}

/** Chrome's access errors are rephrased as the action that restores access. */
export function readPageError(error: unknown): string {
  if (error instanceof PageAccessError) return error.message;
  const message = readableError(error);
  return /cannot access|permission|extensions gallery|chrome:\/\//iu.test(message)
    ? 'The extension no longer has access to this page. Select its toolbar icon on the source page to authorize it again.'
    : message;
}

/** Rejects with a PageAccessError when the operation outlasts the deadline. */
export function withPageTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message = 'The page took too long to respond. Retry the current page.',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new PageAccessError(message)), milliseconds);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
