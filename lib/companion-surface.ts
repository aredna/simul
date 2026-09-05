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

/** Session-storage key of the last toolbar launch generation this browser
 * session allocated. Session storage outlives service-worker restarts and is
 * cleared with the browser, together with every companion that could hold a
 * stamp. */
export const COMPANION_LAUNCH_GENERATION_STORAGE_KEY =
  'simul:companion-launch-generation';

export interface CompanionLaunchGenerationStore {
  read(): Promise<unknown>;
  write(generation: number): Promise<void>;
}

/**
 * Allocates the launch generation of a new worker lifecycle: above every
 * generation this browser session persisted, and never below the clock, so a
 * lifecycle that cannot reach storage still orders after the ones that could.
 * Never rejects; storage failures degrade to clock order for this lifecycle.
 */
export async function allocateCompanionLaunchGeneration(
  store: CompanionLaunchGenerationStore,
  now: () => number = Date.now,
): Promise<number> {
  let persisted: number | undefined;
  try {
    const stored = await store.read();
    if (typeof stored === 'number' && Number.isSafeInteger(stored) && stored > 0) {
      persisted = stored;
    }
  } catch {
    persisted = undefined;
  }
  let clock = 1;
  try {
    const value = now();
    if (Number.isSafeInteger(value) && value > 0) clock = value;
  } catch {
    clock = 1;
  }
  const generation = Math.max(persisted === undefined ? 1 : persisted + 1, clock);
  try {
    await store.write(generation);
  } catch {
    // The clock-derived generation still orders against the lifecycles that
    // could persist theirs.
  }
  return generation;
}

/** `<generation>.<nonce>`: the generation orders lifecycles, the nonce keeps
 * two lifecycles that read the same persisted generation apart. */
export function createCompanionLaunchEpoch(
  generation: number,
  nonce: string,
): string {
  return `${generation}.${nonce}`;
}

/** The generation prefix of a launch epoch, or undefined for an epoch without
 * one (an older build's bare UUID). */
export function readCompanionLaunchEpochGeneration(
  epoch: string,
): number | undefined {
  const match = /^([1-9]\d{0,15})\./.exec(epoch);
  if (!match) return undefined;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

/**
 * Orders toolbar authorizations by click time rather than asynchronous API
 * completion. Within one worker lifecycle the click sequence orders; across
 * lifecycles the persisted generation orders, so an exceptionally delayed
 * message from an older lifecycle no longer supersedes a newer launch. Epochs
 * without a shared order keep the previous rule: a different worker is newer.
 */
export function isNewerCompanionLaunchStamp(
  current: CompanionLaunchStamp | undefined,
  candidate: CompanionLaunchStamp,
): boolean {
  if (
    candidate.epoch.length === 0 ||
    !Number.isSafeInteger(candidate.sequence) ||
    candidate.sequence <= 0
  ) return false;
  if (!current) return true;
  if (current.epoch === candidate.epoch) {
    return candidate.sequence > current.sequence;
  }
  const currentGeneration = readCompanionLaunchEpochGeneration(current.epoch);
  const candidateGeneration = readCompanionLaunchEpochGeneration(candidate.epoch);
  if (
    currentGeneration !== undefined &&
    candidateGeneration !== undefined &&
    currentGeneration !== candidateGeneration
  ) {
    return candidateGeneration > currentGeneration;
  }
  return true;
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
