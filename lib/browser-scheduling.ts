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
 * Gives the browser a turn before continuing: scheduler.yield() in Chrome
 * (129 and later, so every supported Chrome), otherwise a new task.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/** What a slice of page-side work may take before it gives the page a turn (D163). */
export const DEFAULT_SLICE_BUDGET_MS = 35;

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
  return {
    budgetMs,
    get yields() {
      return yields;
    },
    expired: () => now() - started >= budgetMs,
    next: async () => {
      yields += 1;
      await yieldOnce();
      started = now();
    },
  };
}
