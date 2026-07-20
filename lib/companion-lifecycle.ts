import type { ReplicaViewMode } from './preferences';
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

/**
 * Source-only mode never resumes translation, even when saved automation or a
 * prior manual request would otherwise make the translation eligible.
 */
export function replicaViewTranslationAction(
  replicaViewMode: ReplicaViewMode,
  autoTranslationEnabled: boolean,
  translationDesired: boolean,
  availability: TranslationAvailability,
): AutomaticTranslationAction {
  if (replicaViewMode === 'source-only') return 'skip';
  return automaticTranslationAction(
    autoTranslationEnabled || translationDesired,
    availability,
  );
}

export interface AvailabilityRequestCurrency {
  readonly replicaViewMode: ReplicaViewMode;
  readonly requestMatches: boolean;
  readonly generationMatches: boolean;
  readonly snapshotMatches: boolean;
  readonly pairMatches: boolean;
}

/**
 * An async availability result is actionable only while translated mode and
 * every identity boundary from the initiating request are still current.
 */
export function isAvailabilityRequestCurrent(
  currency: AvailabilityRequestCurrency,
): boolean {
  return Boolean(
    currency.replicaViewMode === 'translated' &&
      currency.requestMatches &&
      currency.generationMatches &&
      currency.snapshotMatches &&
      currency.pairMatches,
  );
}

export interface LiveUpdateBatch<NodeId> {
  readonly generation: number;
  readonly firstSequence: number;
  readonly sequence: number;
  readonly nodeIds: ReadonlySet<NodeId>;
}

/** Reinsert interrupted live work without losing a queued remainder. */
export function mergeLiveUpdateBatches<NodeId>(
  current: LiveUpdateBatch<NodeId> | undefined,
  interrupted: LiveUpdateBatch<NodeId>,
): LiveUpdateBatch<NodeId> {
  if (!current || current.generation !== interrupted.generation) {
    const selected = !current || interrupted.generation > current.generation
      ? interrupted
      : current;
    return {
      ...selected,
      nodeIds: new Set(selected.nodeIds),
    };
  }
  return {
    generation: current.generation,
    firstSequence: Math.min(current.firstSequence, interrupted.firstSequence),
    sequence: Math.max(current.sequence, interrupted.sequence),
    nodeIds: new Set([...current.nodeIds, ...interrupted.nodeIds]),
  };
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
