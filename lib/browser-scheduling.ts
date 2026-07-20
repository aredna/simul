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
