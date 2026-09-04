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

export interface BrowserWindowFollowState {
  readonly type?: string;
  readonly focused?: boolean;
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

/**
 * Chrome requires sidePanel.open() in the direct action-click turn. Before
 * storage hydration the safe fallback is to pre-open it, but a known pop-out
 * preference must not flash and initialize a side panel that is immediately
 * closed again.
 */
export function shouldPreopenSidePanel(
  preferences: Pick<
    CompanionPreferences,
    'launchBehavior' | 'lastLaunchSurface'
  >,
  preferencesHydrated: boolean,
): boolean {
  return !preferencesHydrated ||
    resolveCompanionLaunchSurface(preferences) === 'side-panel';
}

/**
 * A newer click in another browser window supersedes an eager side-panel open
 * made while launch preferences were still loading. Never close the same
 * window: its newer click may be relying on that exact user-gesture open.
 */
export function shouldCloseStalePreopenedSidePanel(
  clickSequence: number,
  latestClickSequence: number,
  clickedWindowId: number | undefined,
  latestClickWindowId: number | undefined,
  wasPreopened: boolean,
): boolean {
  return wasPreopened &&
    clickSequence !== latestClickSequence &&
    clickedWindowId !== undefined &&
    latestClickWindowId !== undefined &&
    clickedWindowId !== latestClickWindowId;
}

/**
 * A second toolbar click reuses the detached companion this worker already
 * opened instead of stacking another window over the page. A companion that
 * follows the active tab retargets through the authorized-tab message, so any
 * click reuses it; a locked companion is reused only for its own source tab.
 */
export function shouldReuseDetachedWindow(
  followMode: CompanionPreferences['popoutTabMode'],
  existingSourceTabId: number | undefined,
  clickedTabId: number,
): boolean {
  return existingSourceTabId !== undefined &&
    (followMode === 'active' || existingSourceTabId === clickedTabId);
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
 * covered the source's full bounds hid the page it mirrors. The companion
 * keeps the source's top and height. Popup windows remain user-resizable
 * because no fixed state is requested.
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

/** Background-window activations are not user focus changes and must not
 * retarget a detached companion that follows the visible browser tab. */
export function isFocusedNormalBrowserWindow(
  window: BrowserWindowFollowState,
): boolean {
  return (window.type === undefined || window.type === 'normal') &&
    window.focused !== false;
}

/**
 * Once active-tab following is enabled, updates emitted by the tab being left
 * are stale even if the asynchronous activation lookup has not committed yet.
 */
export function shouldIgnoreInactiveFollowedTabUpdate(
  isDetachedWindow: boolean,
  followMode: CompanionPreferences['popoutTabMode'],
  tabIsActive: boolean,
  followTransitionPending = false,
): boolean {
  return isDetachedWindow && followMode === 'active' &&
    (followTransitionPending || !tabIsActive);
}

/**
 * Closing the followed tab activates a neighbor without requiring another
 * click. Detached active-follow companions should reacquire that neighbor,
 * while locked companions and closing browser windows remain terminal.
 */
export function shouldRecoverRemovedActiveSource(
  isDetachedWindow: boolean,
  followMode: CompanionPreferences['popoutTabMode'],
  companionWindowId: number | undefined,
  removedWindowId: number,
  isWindowClosing: boolean,
): boolean {
  return Boolean(
    isDetachedWindow &&
      followMode === 'active' &&
      !isWindowClosing &&
      companionWindowId !== removedWindowId,
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
