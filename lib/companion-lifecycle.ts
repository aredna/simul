import type { TranslationAvailability } from './translation-provider';

export type AutomaticTranslationAction =
  | 'skip'
  | 'translate'
  | 'needs-user-action'
  | 'unavailable';

/** Automatic work may use an installed model, but never initiate preparation. */
export function automaticTranslationAction(
  enabled: boolean,
  availability: TranslationAvailability,
): AutomaticTranslationAction {
  if (!enabled) return 'skip';
  if (availability === 'available') return 'translate';
  if (availability === 'unavailable') return 'unavailable';
  return 'needs-user-action';
}

export interface GenerationWork<T> {
  readonly generation: number;
  readonly value: T;
}

export interface EnqueuedWork<T> {
  readonly work: GenerationWork<T>;
  readonly startNow: boolean;
}

/**
 * Coordinates one running operation and one latest queued operation. Enqueueing
 * invalidates earlier generations, replaces pending work, and lets callers
 * discard stale asynchronous results before updating the UI.
 */
export class LatestWorkCoordinator<T> {
  #generation = 0;
  #running: GenerationWork<T> | undefined;
  #queued: GenerationWork<T> | undefined;

  get generation(): number {
    return this.#generation;
  }

  get hasRunningWork(): boolean {
    return this.#running !== undefined;
  }

  get hasQueuedWork(): boolean {
    return this.#queued !== undefined;
  }

  enqueue(value: T): EnqueuedWork<T> {
    const work = Object.freeze({
      generation: ++this.#generation,
      value,
    });

    if (!this.#running) {
      this.#running = work;
      return { work, startNow: true };
    }

    this.#queued = work;
    return { work, startNow: false };
  }

  /** Invalidate in-flight work and forget pending work on loading/tab changes. */
  invalidate(): number {
    this.#queued = undefined;
    return ++this.#generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  /**
   * Mark the running generation settled and promote the newest queued request.
   * A mismatched completion cannot disturb the actual running operation.
   */
  finish(generation: number): GenerationWork<T> | undefined {
    if (this.#running?.generation !== generation) return undefined;

    this.#running = undefined;
    const next = this.#queued;
    this.#queued = undefined;
    if (next) this.#running = next;
    return next;
  }
}
