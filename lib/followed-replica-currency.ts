import type { CapturedPageIdentity } from './page-identity';

export interface StaleFollowedReplicaCheck {
  /** A capture is running or queued; it will publish the current page. */
  readonly captureInFlight: boolean;
  /** A debounced navigation refresh is armed and will rebuild on its own. */
  readonly navigationRefreshPending: boolean;
  /** Chrome's `Tab.status`; a loading tab schedules its own refresh on `complete`. */
  readonly tabStatus: string | undefined;
  /** The page whose replica is currently rendered, if any. */
  readonly captured: CapturedPageIdentity | undefined;
  /** The page the follower just resolved for the activated tab. */
  readonly identity: CapturedPageIdentity;
  readonly normalizeUrl?: (url: string) => string;
}

/**
 * An active-tab follow that lands on the page already being followed normally
 * has nothing to do. When the rendered replica is still an older page of that
 * same tab (a navigation whose debounced refresh never ran), returning early
 * would leave the stale mirror frozen; rebuild instead. Nothing is queued
 * while a capture or refresh is already on the way, while the tab is still
 * loading (its `complete` signal schedules the authoritative refresh), or when
 * the replica belongs to another tab (a failed follow keeps its error state).
 */
export function shouldRebuildStaleFollowedReplica(
  check: StaleFollowedReplicaCheck,
): boolean {
  if (check.captureInFlight || check.navigationRefreshPending) return false;
  if (check.tabStatus === 'loading') return false;
  const { captured, identity } = check;
  if (!captured || captured.tabId !== identity.tabId) return false;
  const normalize = check.normalizeUrl ?? ((url: string) => url);
  return normalize(captured.url) !== normalize(identity.url);
}
