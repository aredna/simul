/**
 * The wheel over a pane of the mirror (owner ruling D175, built in D186):
 * the pane under the pointer scrolls, and at the pane's end the mirror
 * does. The replica takes no pointer, so the browser cannot say which pane
 * is under it; the tab names its scrollable panes (`paneBoxes`, D180) and
 * this tests the wheel's point against those panes' boxes in the replica.
 *
 * The test reads each named pane's box in the replica itself, in the
 * coordinates the wheel event has inside the replica's frame: the mirror's
 * zoom, its page's scrolling and the panes' own scrolling are all in it, so
 * nothing of the tab's layout has to be mapped. A pane the reader scrolled
 * keeps its place until that pane moves in the tab (the host places only
 * the panes that moved, D122).
 */

/** Pixels a line of a wheel that counts in lines moves, as Chrome does. */
const WHEEL_LINE_PX = 16;
/**
 * A wheel event this soon after the last one belongs to the same gesture
 * (D193): Chrome keeps a gesture with the element it began on, and a
 * fling's last events come well within this.
 */
export const REPLICA_WHEEL_LATCH_MS = 300;

/** The part of a wheel event the routing reads. */
export interface ReplicaPaneWheel {
  readonly clientX: number;
  readonly clientY: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  /** When it came, in milliseconds (`Event.timeStamp`). */
  readonly timeStamp?: number;
}

/**
 * Keeps a wheel gesture with what it began on, as Chrome does (D193): a
 * pane, or the mirror. A pane that reaches its end takes the rest of the
 * gesture and moves no further, so a fling does not carry on into the
 * outer pane or the mirror; the next gesture finds the pane under it anew.
 * A gesture ends when no wheel event came for `REPLICA_WHEEL_LATCH_MS`.
 */
export class ReplicaPaneWheelLatch {
  #target: HTMLElement | 'mirror' | undefined;
  #last = Number.NEGATIVE_INFINITY;

  /** As `routeReplicaPaneWheel`, within the gesture the event belongs to. */
  route(wheel: ReplicaPaneWheel, panes: Iterable<HTMLElement>): boolean {
    const now = Number.isFinite(wheel.timeStamp)
      ? wheel.timeStamp!
      : globalThis.performance?.now?.() ?? Date.now();
    const sameGesture = now - this.#last >= 0 &&
      now - this.#last < REPLICA_WHEEL_LATCH_MS;
    this.#last = now;
    const latched = sameGesture ? this.#target : undefined;
    if (latched === 'mirror') return false;
    if (latched && latched.isConnected) {
      // Held to the end of the gesture, moved or not.
      scrollPaneBy(latched, wheel);
      return true;
    }
    const pane = paneTakingWheel(wheel, panes);
    this.#target = pane ?? 'mirror';
    return pane !== undefined;
  }

  /** Forgets the gesture: a new replica, or panes the tab no longer names. */
  reset(): void {
    this.#target = undefined;
    this.#last = Number.NEGATIVE_INFINITY;
  }
}

/**
 * Scrolls the innermost pane under the wheel's point that can still move
 * in the wheel's direction, and says whether one did. None: the caller
 * scrolls the mirror. `panes` are the replica's elements of the panes the
 * tab named.
 */
export function routeReplicaPaneWheel(
  wheel: ReplicaPaneWheel,
  panes: Iterable<HTMLElement>,
): boolean {
  return paneTakingWheel(wheel, panes) !== undefined;
}

/** The pane the wheel scrolled, if one could move. */
function paneTakingWheel(
  wheel: ReplicaPaneWheel,
  panes: Iterable<HTMLElement>,
): HTMLElement | undefined {
  if (
    !Number.isFinite(wheel.clientX) || !Number.isFinite(wheel.clientY) ||
    (!wheel.deltaX && !wheel.deltaY)
  ) return undefined;
  const under: HTMLElement[] = [];
  for (const pane of panes) {
    let rect: DOMRect;
    try {
      rect = pane.getBoundingClientRect();
    } catch {
      continue;
    }
    if (
      rect.width > 0 && rect.height > 0 &&
      wheel.clientX >= rect.left && wheel.clientX < rect.right &&
      wheel.clientY >= rect.top && wheel.clientY < rect.bottom
    ) under.push(pane);
  }
  if (under.length === 0) return undefined;
  // The innermost first: a pane inside another goes before it.
  under.sort((left, right) =>
    left.contains(right) ? 1 : right.contains(left) ? -1 : 0);
  for (const pane of under) {
    if (scrollPaneBy(pane, wheel)) return pane;
  }
  return undefined;
}

/** Scrolls `pane` by the wheel; whether it moved. */
function scrollPaneBy(pane: HTMLElement, wheel: ReplicaPaneWheel): boolean {
  const lineX = wheel.deltaMode === 1
    ? WHEEL_LINE_PX
    : wheel.deltaMode === 2 ? Math.max(1, pane.clientWidth) : 1;
  const lineY = wheel.deltaMode === 1
    ? WHEEL_LINE_PX
    : wheel.deltaMode === 2 ? Math.max(1, pane.clientHeight) : 1;
  const left = pane.scrollLeft;
  const top = pane.scrollTop;
  if (wheel.deltaX) pane.scrollLeft = left + wheel.deltaX * lineX;
  if (wheel.deltaY) pane.scrollTop = top + wheel.deltaY * lineY;
  return Math.abs(pane.scrollLeft - left) >= 0.5 ||
    Math.abs(pane.scrollTop - top) >= 0.5;
}
