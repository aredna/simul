/**
 * Waits for a promise and says how it ended, without throwing. With it, a
 * `.then(onFulfilled, onRejected)` becomes plain async/await (Chrome's
 * extension guidance, rule 5) while keeping the two-armed meaning: a throw in
 * the success branch is not mistaken for a rejection of the work.
 */
export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export async function settle<T>(work: PromiseLike<T> | T): Promise<Settled<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Runs `work` in a later microtask, as `Promise.resolve().then(work)` does:
 * the caller's turn finishes first, and a throw becomes a rejection.
 */
export async function later<T>(work: () => T | PromiseLike<T>): Promise<T> {
  await null;
  return work();
}
