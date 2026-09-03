import type { CapturedPageIdentity } from './page-identity';
import type {
  CompanionSurface,
  CompanionPreferences,
} from './preferences';

export interface BrowserWindowGeometry {
  readonly width?: number;
  readonly height?: number;
  readonly left?: number;
  readonly top?: number;
}

export interface DetachedWindowCreateData extends BrowserWindowGeometry {
  readonly url: string;
  readonly type: 'popup';
  readonly focused: true;
}

export interface CompanionLaunchStamp {
  readonly epoch: string;
  readonly sequence: number;
}

export function resolveCompanionLaunchSurface(
  preferences: Pick<
    CompanionPreferences,
    'launchBehavior' | 'lastLaunchSurface'
  >,
): CompanionSurface {
  return preferences.launchBehavior === 'last-used'
    ? preferences.lastLaunchSurface
    : preferences.launchBehavior;
}

export function createDetachedCompanionUrl(
  extensionPageUrl: string,
  identity: CapturedPageIdentity,
): string {
  const url = new URL(extensionPageUrl);
  url.searchParams.set('sourceTabId', String(identity.tabId));
  url.searchParams.set('sourceWindowId', String(identity.windowId));
  return url.toString();
}

/** Share of the source window's width the companion takes when docked. */
export const DETACHED_WINDOW_WIDTH_RATIO = 0.45;
export const DETACHED_WINDOW_MIN_WIDTH = 480;

/**
 * Dock the companion to the right edge of the source window at a fraction of
 * its width so the page stays readable beside its translation. A window that
 * covered the source's full bounds hid the page it mirrors. Popup windows
 * remain user-resizable because no fixed state is requested.
 */
export function createDetachedWindowData(
  url: string,
  sourceWindow: BrowserWindowGeometry,
  fallback: Required<Pick<BrowserWindowGeometry, 'width' | 'height'>> = {
    width: 720,
    height: 800,
  },
): DetachedWindowCreateData {
  const sourceWidth = positiveInteger(sourceWindow.width);
  const width = sourceWidth === undefined
    ? fallback.width
    : Math.min(
        sourceWidth,
        Math.max(
          DETACHED_WINDOW_MIN_WIDTH,
          Math.round(sourceWidth * DETACHED_WINDOW_WIDTH_RATIO),
        ),
      );
  const left = integer(sourceWindow.left);
  return {
    url,
    type: 'popup',
    focused: true,
    width,
    height: positiveInteger(sourceWindow.height) ?? fallback.height,
    ...(left === undefined || sourceWidth === undefined
      ? {}
      : { left: left + sourceWidth - width }),
    ...(integer(sourceWindow.top) === undefined
      ? {}
      : { top: integer(sourceWindow.top) }),
  };
}

export function shouldFollowActivatedTab(
  isDetachedWindow: boolean,
  followMode: CompanionPreferences['popoutTabMode'],
  companionWindowId: number | undefined,
  activatedWindowId: number,
): boolean {
  return Boolean(
    isDetachedWindow &&
      followMode === 'active' &&
      companionWindowId !== activatedWindowId,
  );
}

export function sameCompanionSourcePage(
  left: CapturedPageIdentity | undefined,
  right: CapturedPageIdentity,
  normalizeUrl: (url: string) => string = (url) => url,
): boolean {
  return Boolean(
    left &&
      left.tabId === right.tabId &&
      left.windowId === right.windowId &&
      normalizeUrl(left.url) === normalizeUrl(right.url),
  );
}

/** Orders toolbar authorizations by click time rather than asynchronous API
 * completion. A new service-worker epoch supersedes the previous worker. */
export function isNewerCompanionLaunchStamp(
  current: CompanionLaunchStamp | undefined,
  candidate: CompanionLaunchStamp,
): boolean {
  return candidate.epoch.length > 0 &&
    Number.isSafeInteger(candidate.sequence) &&
    candidate.sequence > 0 &&
    (current?.epoch !== candidate.epoch || candidate.sequence > current.sequence);
}

function positiveInteger(value: number | undefined): number | undefined {
  return integer(value) !== undefined && Number(value) > 0
    ? Number(value)
    : undefined;
}

function integer(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}
