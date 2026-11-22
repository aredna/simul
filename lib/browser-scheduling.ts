import { later } from './settle';
export type TimeoutScheduler = (
  callback: () => void,
  milliseconds?: number,
) => ReturnType<typeof setTimeout>;

export type TimeoutCanceller = (
  handle: ReturnType<typeof setTimeout>,
) => void;

export type AnimationFrameScheduler = (callback: () => void) => number;
export type AnimationFrameCanceller = (handle: number) => void;

/**
 * Keep browser scheduling methods attached to their owning global object.
 *
 * Web APIs can reject calls made with an arbitrary class instance as their
 * receiver. Injected callbacks remain ordinary receiver-free functions, while
 * native defaults are invoked as methods of `globalThis`.
 */
export function receiverSafeTimeoutScheduler(
  implementation?: TimeoutScheduler,
): TimeoutScheduler {
  if (implementation) {
    return (callback, milliseconds) => implementation(callback, milliseconds);
  }
  return (callback, milliseconds) =>
    globalThis.setTimeout(callback, milliseconds);
}

export function receiverSafeTimeoutCanceller(
  implementation?: TimeoutCanceller,
): TimeoutCanceller {
  if (implementation) return (handle) => implementation(handle);
  return (handle) => globalThis.clearTimeout(handle);
}

export function receiverSafeAnimationFrameScheduler(
  implementation?: AnimationFrameScheduler,
): AnimationFrameScheduler {
  if (implementation) return (callback) => implementation(callback);
  return (callback) => globalThis.requestAnimationFrame(callback);
}

export function receiverSafeAnimationFrameCanceller(
  implementation?: AnimationFrameCanceller,
): AnimationFrameCanceller {
  if (implementation) return (handle) => implementation(handle);
  return (handle) => globalThis.cancelAnimationFrame(handle);
}

/**
 * Starts optional readiness work after the current synchronous startup turn.
 * Every result is settled internally so a failed enhancement cannot delay or
 * reject the primary UI path.
 */
export function startBestEffortBackgroundTasks(
  tasks: readonly (() => Promise<unknown>)[],
): void {
  void Promise.allSettled(
    tasks.map((task) => later(task)),
  );
}

/**
 * Gives the browser a turn before continuing, as a task among the page's own
 * (D180): `scheduler.postTask` at `user-visible` priority, the priority of
 * the page's timers and messages, in Chrome (94 and later, so every
 * supported Chrome), otherwise a new task through `setTimeout`.
 *
 * `scheduler.yield()` was used before D180. Its continuation runs ahead of
 * every task of the same priority, so a page read in slices back to back
 * (the first read in parts of a page of 54,000 elements, about two seconds)
 * kept the page's own timers waiting for the whole read (a 10 ms interval did
 * not run for 1.3 s) and its frames to Chrome's floor of about one in
 * 110 ms. A task of the same priority waits behind what the page has already
 * queued and no longer: a page with nothing waiting continues at once.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as {
    scheduler?: {
      postTask?: (
        callback: () => void,
        options?: { priority?: 'user-blocking' | 'user-visible' | 'background' },
      ) => Promise<void>;
    };
  }).scheduler;
  if (typeof scheduler?.postTask === 'function') {
    return scheduler.postTask(() => undefined, { priority: 'user-visible' });
  }
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/** What a slice of page-side work may take before it gives the page a turn (D163). */
export const DEFAULT_SLICE_BUDGET_MS = 35;

/**
 * A slice of the live whole-page passes (D164): less than the first read's,
 * so that a slice that runs over by a unit and a garbage collection inside
 * it still ends under 50 ms.
 */
export const LIVE_SLICE_BUDGET_MS = 30;

/**
 * Times the slices of one long piece of page-side work (D163). The work asks
 * `expired()` between its units and, when it says so, awaits `next()`, which
 * gives the browser a turn and starts the next slice's budget. A slice that
 * never runs out never yields, so work that fits one slice stays in the task
 * that began it. The work closes what it holds open for one slice (a walk, a
 * memo, a paint cache) before it awaits `next()`.
 */
export interface SliceClock {
  /** The slices' budget, in milliseconds. */
  readonly budgetMs: number;
  /** How many times the work has yielded so far. */
  readonly yields: number;
  /** The current slice has used its budget. */
  expired(): boolean;
  /** Gives the browser a turn, then starts a new slice. */
  next(): Promise<void>;
}

export interface SliceClockOptions {
  readonly budgetMs?: number;
  /**
   * The first slice's budget when it differs: a first slice that shares its
   * task with other work (D169).
   */
  readonly firstBudgetMs?: number;
  /** `performance.now` by default; tests pass a clock they move. */
  readonly now?: () => number;
  /** `yieldToMain` by default; tests pass one they resolve. */
  readonly yield?: () => Promise<void>;
}

/** A slice clock whose first slice starts now. */
export function createSliceClock(options: SliceClockOptions = {}): SliceClock {
  const budgetMs = options.budgetMs ?? DEFAULT_SLICE_BUDGET_MS;
  const now = options.now ?? (() => globalThis.performance.now());
  const yieldOnce = options.yield ?? yieldToMain;
  let started = now();
  let yields = 0;
  let sliceBudgetMs = options.firstBudgetMs ?? budgetMs;
  return {
    budgetMs,
    get yields() {
      return yields;
    },
    expired: () => now() - started >= sliceBudgetMs,
    next: async () => {
      yields += 1;
      await yieldOnce();
      started = now();
      sliceBudgetMs = budgetMs;
    },
  };
}

/**
 * The whole-page passes of the live mirror (the semantic scan and the
 * comparison of what the page paints) together take at most one fifth of
 * the tab's time (D164): after a pass that kept the tab busy for `t`, the
 * next waits `4 t`, as `LISTING_SHARE` does for animations.
 */
export const LIVE_PASS_SHARE = 5;

/**
 * When the next live whole-page pass may start (D164). One ledger serves
 * both passes of a page: each notes its busy time (the work of its slices,
 * not the time it waited between them) when it ends, and asks before it
 * starts. A pass asked to wait sets a timer for `waitMs()` and asks again.
 * One pass runs at a time: a pass that has begun holds the page until it
 * notes its end or is released, so two first slices never share a task. A
 * pass touches its hold at the start of every slice: a long pass, turns
 * and all, keeps it, and only a hold nobody touches runs out.
 */
export interface PassShareLedger {
  /** The earliest time, on the ledger's clock, the next pass may start. */
  readonly notBefore: number;
  /**
   * How long a pass that wants to start now waits: 0 when it may run at
   * once. While another pass holds the page, a short wait to ask again.
   * `ignoreShare` waits only for a pass that holds the page (the first scan
   * after start).
   */
  waitMs(owner?: object, ignoreShare?: boolean): number;
  /**
   * How long a pass a person's typing asked for waits (D230): for its share
   * as any pass does, but at most until `TYPING_PASS_MAX_WAIT_MS` after
   * `typedSince` (the first key not yet read, on `clock()`), and for a pass
   * that holds the page.
   */
  typingWaitMs(owner: object, typedSince: number): number;
  /** The ledger's clock, for `typedSince` and for when a wait is over. */
  clock(): number;
  /** A pass of `owner` begins: it holds the page until `note` or `release`. */
  begin(owner: object): void;
  /**
   * A slice of `owner`'s pass starts: its hold, if it still holds the page,
   * counts from now. Nothing for an owner that does not hold it.
   */
  touch(owner: object): void;
  /**
   * Notes a pass that kept the tab busy for `busyMs` and has just ended,
   * or was cancelled after it had done work: a page that keeps cancelling
   * its passes still pays for what they did.
   */
  note(busyMs: number, owner?: object): void;
  /**
   * A pass of `owner` ended without a share to note: cancelled before it
   * did any work, or with its busy time unknown.
   */
  release(owner: object): void;
}

export interface PassShareLedgerOptions {
  /** `performance.now` by default; tests pass a clock they move. */
  readonly now?: () => number;
  /** One pass in this many of the tab's time: `LIVE_PASS_SHARE` by default. */
  readonly share?: number;
}

/** How soon a pass that found the page held asks again, in milliseconds (D164). */
export const PASS_HELD_RECHECK_MS = 50;

/**
 * A hold not touched for longer than this is taken to be lost (a path that
 * forgot to release it) and no longer holds the page (D164). A pass touches
 * it at every slice, so a pass that runs longer, turns and all, keeps it.
 */
export const PASS_HOLD_LIMIT_MS = 10_000;

/**
 * How long a pass a person's typing asked for waits at most for the share
 * of the tab's time (D230). The first key after a pause is read at once;
 * while a person keeps typing into a large page, a pass every so often and
 * not one at each key: the mirror's field trails by this and a pass at
 * most, about a second, against all of the tab's time.
 */
export const TYPING_PASS_MAX_WAIT_MS = 700;

export function createPassShareLedger(
  options: PassShareLedgerOptions = {},
): PassShareLedger {
  const now = options.now ?? (() => globalThis.performance.now());
  const rest = Math.max(0, (options.share ?? LIVE_PASS_SHARE) - 1);
  let notBefore = Number.NEGATIVE_INFINITY;
  let holder: object | undefined;
  let heldSince = 0;
  const heldByOther = (owner: object | undefined): boolean => {
    if (!holder || holder === owner) return false;
    if (now() - heldSince > PASS_HOLD_LIMIT_MS) {
      holder = undefined;
      return false;
    }
    return true;
  };
  return {
    get notBefore() {
      return notBefore;
    },
    waitMs: (owner, ignoreShare = false) => {
      if (heldByOther(owner)) return PASS_HELD_RECHECK_MS;
      return ignoreShare ? 0 : Math.max(0, notBefore - now());
    },
    typingWaitMs: (owner, typedSince) => {
      if (heldByOther(owner)) return PASS_HELD_RECHECK_MS;
      const at = now();
      return Math.max(0, Math.min(notBefore, typedSince + TYPING_PASS_MAX_WAIT_MS) - at);
    },
    clock: () => now(),
    begin: (owner) => {
      holder = owner;
      heldSince = now();
    },
    touch: (owner) => {
      if (holder === owner) heldSince = now();
    },
    note: (busyMs, owner) => {
      if (owner !== undefined && holder === owner) holder = undefined;
      if (!Number.isFinite(busyMs) || busyMs <= 0) return;
      // A pass that ended before the last one's rest was over ran beside it
      // (the other pass, or the first scan, which does not wait): its rest
      // comes on top, so two passes at once still keep to the share.
      notBefore = Math.max(notBefore, now()) + rest * busyMs;
    },
    release: (owner) => {
      if (holder === owner) holder = undefined;
    },
  };
}
