import type {
  ReplicaSourceDocumentIdentity,
  ReplicaSourceTextChange,
  ReplicaSourceTextRecord,
} from '../replica/source-value-model';
import { sameSourceDocument } from '../replica/source-value-model';
import { translateWithSession } from '../translation-pipeline';
import type {
  CreateTranslationSessionOptions,
  TranslationPair,
  TranslationProvider,
  TranslationSession,
} from '../translation-provider';
import { TranslationMemory } from './translation-memory';

export interface ReplicaSourceCommit {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly documentLanguage?: string;
  readonly documentLanguageChanged: boolean;
  readonly replayLease: number;
  readonly records: readonly ReplicaSourceTextRecord[];
  readonly changes: readonly ReplicaSourceTextChange[];
  readonly reason: 'checkpoint' | 'batch' | 'recovery';
}

export interface ReplicaProjectionContext {
  readonly translationEpoch: number;
  readonly pairKey: string | undefined;
}

export interface ReplicaTextProjection {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly replayLease: number;
  readonly nodeId: number;
  readonly nodeType: 3;
  readonly sourceRevision: number;
  readonly source: string;
  readonly translationEpoch: number;
  readonly pairKey: string;
  readonly translated: string;
}

export interface ReplicaTranslationSnapshot {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly documentLanguage?: string;
  readonly replayLease: number;
  readonly records: readonly ReplicaSourceTextRecord[];
}

export interface ReplicaTranslationSurface {
  beginProjection(context: ReplicaProjectionContext): void;
  snapshot(): ReplicaTranslationSnapshot | undefined;
  project(projection: ReplicaTextProjection): boolean;
}

export interface ReplicaTranslationRunOptions
  extends CreateTranslationSessionOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (completed: number, total: number) => void;
}

export interface ReplicaTranslationRunResult {
  readonly document?: ReplicaSourceDocumentIdentity;
  readonly replayLease?: number;
  readonly translationEpoch: number;
  readonly pairKey?: string;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly stale: number;
  readonly skipped: number;
  readonly overflow: number;
}

interface PendingJob {
  readonly record: ReplicaSourceTextRecord;
  readonly replayLease: number;
  readonly translationEpoch: number;
  readonly pairKey: string;
  readonly pairSignal: AbortSignal;
  readonly signal?: AbortSignal;
}

export const MAX_PENDING_JOBS = 2_048;
export const MAX_PENDING_CHARACTERS = 500_000;

export interface ReplicaTranslationCoordinatorOptions {
  readonly memory?: TranslationMemory;
  readonly providerId?: string;
  readonly onBackgroundResult?: (result: ReplicaTranslationRunResult) => void;
  readonly maxPendingJobs?: number;
  readonly maxPendingCharacters?: number;
}

/**
 * Owns one retained Translator session and one sequential projection lane.
 * Capture commits only enqueue work; they never await this coordinator.
 */
export class ReplicaTranslationCoordinator {
  readonly #memory: TranslationMemory;
  readonly #providerId: string;
  #pair: TranslationPair | undefined;
  #translationEpoch = 0;
  #pairController = new AbortController();
  #session: TranslationSession | undefined;
  #sessionTask: Promise<TranslationSession> | undefined;
  #pending = new Map<number, PendingJob>();
  #pendingCharacters = 0;
  #pendingSkipped = 0;
  #pendingOverflow = 0;
  #drainTask: Promise<ReplicaTranslationRunResult> | undefined;
  #disposed = false;
  readonly #maxPendingJobs: number;
  readonly #maxPendingCharacters: number;
  readonly #onBackgroundResult:
    | ((result: ReplicaTranslationRunResult) => void)
    | undefined;

  constructor(
    private readonly provider: TranslationProvider,
    private readonly surface: ReplicaTranslationSurface,
    options: ReplicaTranslationCoordinatorOptions = {},
  ) {
    this.#memory = options.memory ?? new TranslationMemory();
    this.#providerId = options.providerId ?? 'chrome-translator-v1';
    this.#onBackgroundResult = options.onBackgroundResult;
    this.#maxPendingJobs = positiveInteger(
      options.maxPendingJobs,
      MAX_PENDING_JOBS,
    );
    this.#maxPendingCharacters = positiveInteger(
      options.maxPendingCharacters,
      MAX_PENDING_CHARACTERS,
    );
  }

  get selectedPair(): TranslationPair | undefined {
    return this.#pair;
  }

  get translationEpoch(): number {
    return this.#translationEpoch;
  }

  /** The callback/UI may use this to reject an obsolete drain result. */
  isResultCurrent(result: ReplicaTranslationRunResult): boolean {
    if (
      this.#disposed ||
      result.translationEpoch !== this.#translationEpoch ||
      result.pairKey !== this.#selectedPairKey()
    ) return false;
    const snapshot = this.surface.snapshot();
    return Boolean(
      snapshot &&
        result.document &&
        result.replayLease === snapshot.replayLease &&
        sameSourceDocument(result.document, snapshot.document),
    );
  }

  selectPair(pair: TranslationPair | undefined): void {
    if (samePair(this.#pair, pair)) return;
    this.#translationEpoch += 1;
    this.#pairController.abort();
    this.#pairController = new AbortController();
    this.#pending.clear();
    this.#pendingCharacters = 0;
    this.#pendingSkipped = 0;
    this.#pendingOverflow = 0;
    this.#session?.destroy();
    this.#session = undefined;
    this.#sessionTask = undefined;
    this.#pair = pair;
    this.surface.beginProjection({
      translationEpoch: this.#translationEpoch,
      pairKey: pair && pair.sourceLanguage !== pair.targetLanguage
        ? translationPairKey(pair)
        : undefined,
    });
  }

  async translateCurrent(
    pair: TranslationPair,
    options: ReplicaTranslationRunOptions = {},
  ): Promise<ReplicaTranslationRunResult> {
    if (this.#disposed) return this.#emptyResult();
    this.selectPair(pair);
    if (pair.sourceLanguage === pair.targetLanguage) return this.#emptyResult();
    const requestedEpoch = this.#translationEpoch;
    options.signal?.throwIfAborted();
    await this.#waitForActiveDrain(options.signal);
    this.#assertRunCurrent(pair, requestedEpoch, options.signal);
    await this.#ensureSession(options);
    this.#assertRunCurrent(pair, requestedEpoch, options.signal);
    const snapshot = this.surface.snapshot();
    if (!snapshot) return this.#emptyResult();
    const pairKey = translationPairKey(pair);
    const candidates = snapshot.records.filter(isTranslatableRecord);
    for (const record of candidates) {
      this.#enqueue({
        record,
        replayLease: snapshot.replayLease,
        translationEpoch: this.#translationEpoch,
        pairKey,
        pairSignal: this.#pairController.signal,
        ...(options.signal ? { signal: options.signal } : {}),
      }, false);
    }
    return this.#drain(options.onProgress, candidates.length);
  }

  handleSourceCommit(commit: ReplicaSourceCommit): void {
    if (
      this.#disposed ||
      !this.#session ||
      !this.#pair ||
      this.#pair.sourceLanguage === this.#pair.targetLanguage
    ) return;
    const snapshot = this.surface.snapshot();
    if (
      !snapshot ||
      snapshot.replayLease !== commit.replayLease ||
      !sameSourceDocument(snapshot.document, commit.document)
    ) return;
    const pairKey = translationPairKey(this.#pair);
    let queued = false;
    for (const change of commit.changes) {
      if (change.kind === 'remove') {
        this.#drop(change.nodeId);
        continue;
      }
      if (!isTranslatableRecord(change.record)) continue;
      queued = this.#enqueue({
        record: change.record,
        replayLease: commit.replayLease,
        translationEpoch: this.#translationEpoch,
        pairKey,
        pairSignal: this.#pairController.signal,
      }, true) || queued;
    }
    if (queued || this.#pendingSkipped > 0 || this.#pendingOverflow > 0) {
      this.#startBackgroundDrain();
    }
  }

  cancelPending(): void {
    this.#pending.clear();
    this.#pendingCharacters = 0;
    this.#pendingSkipped = 0;
    this.#pendingOverflow = 0;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pairController.abort();
    this.#session?.destroy();
    this.#session = undefined;
    this.#sessionTask = undefined;
    this.#pending.clear();
    this.#pendingCharacters = 0;
    this.#pendingSkipped = 0;
    this.#pendingOverflow = 0;
  }

  async #ensureSession(
    options: ReplicaTranslationRunOptions,
  ): Promise<TranslationSession> {
    if (this.#session) return this.#session;
    if (this.#sessionTask) {
      return waitForPromise(this.#sessionTask, options.signal);
    }
    const pair = this.#pair;
    if (!pair) throw new Error('A translation pair is not selected.');
    const epoch = this.#translationEpoch;
    const combined = combineAbortSignals(
      this.#pairController.signal,
      options.signal,
    );
    const task = this.provider.createSession(pair, {
      signal: combined.signal,
      ...(options.onDownloadProgress
        ? { onDownloadProgress: options.onDownloadProgress }
        : {}),
    }).then((session) => {
      if (
        this.#disposed ||
        epoch !== this.#translationEpoch ||
        !samePair(this.#pair, pair)
      ) {
        session.destroy();
        throw new DOMException('Translation pair changed.', 'AbortError');
      }
      this.#session = session;
      return session;
    }).finally(() => {
      combined.dispose();
      if (this.#sessionTask === task) this.#sessionTask = undefined;
    });
    this.#sessionTask = task;
    return task;
  }

  #enqueue(job: PendingJob, evictOldest: boolean): boolean {
    const current = this.#pending.get(job.record.nodeId);
    if (current && samePendingJob(current, job)) return true;
    if (current) {
      this.#pendingCharacters -= current.record.source.length;
      this.#pendingSkipped += 1;
    }
    this.#pending.delete(job.record.nodeId);
    if (
      !evictOldest &&
      (this.#pending.size >= this.#maxPendingJobs ||
        this.#pendingCharacters + job.record.source.length >
          this.#maxPendingCharacters)
    ) {
      this.#pendingOverflow += 1;
      return false;
    }
    this.#pending.set(job.record.nodeId, job);
    this.#pendingCharacters += job.record.source.length;
    while (
      this.#pending.size > this.#maxPendingJobs ||
      this.#pendingCharacters > this.#maxPendingCharacters
    ) {
      const oldest = this.#pending.entries().next().value as
        | [number, PendingJob]
        | undefined;
      if (!oldest) break;
      this.#pending.delete(oldest[0]);
      this.#pendingCharacters -= oldest[1].record.source.length;
      this.#pendingOverflow += 1;
    }
    return this.#pending.get(job.record.nodeId) === job;
  }

  #drop(nodeId: number): void {
    const current = this.#pending.get(nodeId);
    if (!current) return;
    this.#pending.delete(nodeId);
    this.#pendingCharacters -= current.record.source.length;
  }

  #drain(
    onProgress?: (completed: number, total: number) => void,
    requestedTotal = this.#pending.size,
  ): Promise<ReplicaTranslationRunResult> {
    if (this.#drainTask) return this.#drainTask;
    const context = this.#resultContext();
    let completed = 0;
    let failed = 0;
    let stale = 0;
    let skipped = this.#takePendingSkipped();
    let overflow = this.#takePendingOverflow();
    const task = (async (): Promise<ReplicaTranslationRunResult> => {
      while (this.#pending.size > 0) {
        const next = this.#pending.entries().next().value as
          | [number, PendingJob]
          | undefined;
        if (!next) break;
        this.#drop(next[0]);
        const job = next[1];
        if (job.signal?.aborted) {
          this.#dropJobsForSignal(job.signal);
          job.signal.throwIfAborted();
        }
        if (!this.#isCurrentJob(job)) {
          stale += 1;
          continue;
        }
        try {
          const session = this.#session;
          const pair = this.#pair;
          if (!session || !pair) {
            stale += 1;
            continue;
          }
          const boundary = splitBoundaryWhitespace(job.record.source);
          const translated = await this.#memory.getOrCreate(
            {
              provider: this.#providerId,
              pair,
              pageKey: sourceDocumentTranslationKey(job.record.document),
            },
            boundary.core,
            () => {
              const combined = combineAbortSignals(
                job.pairSignal,
                job.signal,
              );
              return translateWithSession(
                session,
                boundary.core,
                combined.signal,
              ).finally(combined.dispose);
            },
          );
          if (!this.#isCurrentJob(job)) {
            stale += 1;
            continue;
          }
          const projected = this.surface.project({
            document: job.record.document,
            replayLease: job.replayLease,
            nodeId: job.record.nodeId,
            nodeType: 3,
            sourceRevision: job.record.revision,
            source: job.record.source,
            translationEpoch: job.translationEpoch,
            pairKey: job.pairKey,
            translated: `${boundary.leading}${translated.trim()}${boundary.trailing}`,
          });
          if (projected) completed += 1;
          else stale += 1;
        } catch (error) {
          if (job.signal?.aborted) {
            this.#dropJobsForSignal(job.signal);
            throw abortReason(job.signal, error);
          }
          if (job.pairSignal.aborted) stale += 1;
          else failed += 1;
        }
        skipped += this.#takePendingSkipped();
        overflow += this.#takePendingOverflow();
        reportProgress(
          onProgress,
          { completed, failed, stale, skipped, overflow },
          requestedTotal,
          this.#pending.size + this.#pendingSkipped + this.#pendingOverflow,
        );
      }
      skipped += this.#takePendingSkipped();
      overflow += this.#takePendingOverflow();
      const total = Math.max(
        requestedTotal,
        completed + failed + stale + skipped + overflow,
      );
      reportProgress(
        onProgress,
        { completed, failed, stale, skipped, overflow },
        total,
        0,
      );
      return {
        ...context,
        total,
        completed,
        failed,
        stale,
        skipped,
        overflow,
      };
    })().finally(() => {
      if (this.#drainTask === task) this.#drainTask = undefined;
    });
    this.#drainTask = task;
    return task;
  }

  #startBackgroundDrain(): void {
    if (this.#drainTask || this.#disposed) return;
    const task = this.#drain();
    void task.then((result) => {
      if (this.isResultCurrent(result)) this.#onBackgroundResult?.(result);
    }).catch(() => {
      // Background jobs carry only the pair signal and normally settle stale
      // on invalidation. A defensive rejection must not become unhandled.
    });
  }

  async #waitForActiveDrain(signal?: AbortSignal): Promise<void> {
    while (this.#drainTask) {
      try {
        await waitForPromise(this.#drainTask, signal);
      } catch (error) {
        if (signal?.aborted || !isAbortError(error)) throw error;
        // A previous caller owned that cancellation. The current caller gets
        // a fresh bounded pass rather than inheriting the obsolete abort.
      }
      signal?.throwIfAborted();
    }
  }

  #assertRunCurrent(
    pair: TranslationPair,
    epoch: number,
    signal?: AbortSignal,
  ): void {
    signal?.throwIfAborted();
    if (
      this.#disposed ||
      epoch !== this.#translationEpoch ||
      !samePair(this.#pair, pair)
    ) {
      throw new DOMException('Translation pair changed.', 'AbortError');
    }
  }

  #dropJobsForSignal(signal: AbortSignal): void {
    for (const [nodeId, job] of this.#pending) {
      if (job.signal === signal) this.#drop(nodeId);
    }
  }

  #takePendingSkipped(): number {
    const value = this.#pendingSkipped;
    this.#pendingSkipped = 0;
    return value;
  }

  #takePendingOverflow(): number {
    const value = this.#pendingOverflow;
    this.#pendingOverflow = 0;
    return value;
  }

  #selectedPairKey(): string | undefined {
    return this.#pair && this.#pair.sourceLanguage !== this.#pair.targetLanguage
      ? translationPairKey(this.#pair)
      : undefined;
  }

  #resultContext(): Pick<
    ReplicaTranslationRunResult,
    'document' | 'replayLease' | 'translationEpoch' | 'pairKey'
  > {
    const snapshot = this.surface.snapshot();
    return {
      translationEpoch: this.#translationEpoch,
      ...(this.#selectedPairKey() ? { pairKey: this.#selectedPairKey() } : {}),
      ...(snapshot
        ? { document: snapshot.document, replayLease: snapshot.replayLease }
        : {}),
    };
  }

  #emptyResult(): ReplicaTranslationRunResult {
    return {
      ...this.#resultContext(),
      total: 0,
      completed: 0,
      failed: 0,
      stale: 0,
      skipped: 0,
      overflow: 0,
    };
  }

  #isCurrentJob(job: PendingJob): boolean {
    if (
      this.#disposed ||
      job.translationEpoch !== this.#translationEpoch ||
      !this.#pair ||
      translationPairKey(this.#pair) !== job.pairKey
    ) return false;
    const snapshot = this.surface.snapshot();
    if (
      !snapshot ||
      snapshot.replayLease !== job.replayLease ||
      !sameSourceDocument(snapshot.document, job.record.document)
    ) return false;
    const current = snapshot.records.find(
      (record) => record.nodeId === job.record.nodeId,
    );
    return Boolean(
      current &&
        current.nodeType === 3 &&
        current.revision === job.record.revision &&
        current.source === job.record.source,
    );
  }
}

export function translationPairKey(pair: TranslationPair): string {
  return `${pair.sourceLanguage}>${pair.targetLanguage}`;
}

function sourceDocumentTranslationKey(
  document: ReplicaSourceDocumentIdentity,
): string {
  return JSON.stringify([
    document.sessionId,
    document.documentId,
    document.frameId,
  ]);
}

function isTranslatableRecord(record: ReplicaSourceTextRecord): boolean {
  return record.source.trim().length > 0;
}

export function splitBoundaryWhitespace(source: string): {
  readonly leading: string;
  readonly core: string;
  readonly trailing: string;
} {
  const match = /^(\s*)(.*?)(\s*)$/su.exec(source);
  return {
    leading: match?.[1] ?? '',
    core: match?.[2] ?? source,
    trailing: match?.[3] ?? '',
  };
}

export function isCompleteReplicaTranslationResult(
  result: ReplicaTranslationRunResult,
): boolean {
  return (
    result.completed === result.total &&
    result.failed === 0 &&
    result.stale === 0 &&
    result.skipped === 0 &&
    result.overflow === 0
  );
}

function samePair(
  left: TranslationPair | undefined,
  right: TranslationPair | undefined,
): boolean {
  return (
    (!left && !right) ||
    Boolean(
      left &&
        right &&
        left.sourceLanguage === right.sourceLanguage &&
        left.targetLanguage === right.targetLanguage,
    )
  );
}

function samePendingJob(left: PendingJob, right: PendingJob): boolean {
  return (
    left.record.revision === right.record.revision &&
    left.record.source === right.record.source &&
    left.replayLease === right.replayLease &&
    left.translationEpoch === right.translationEpoch &&
    left.pairKey === right.pairKey &&
    sameSourceDocument(left.record.document, right.record.document)
  );
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'AbortError',
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function reportProgress(
  onProgress: ((completed: number, total: number) => void) | undefined,
  counts: Pick<
    ReplicaTranslationRunResult,
    'completed' | 'failed' | 'stale' | 'skipped' | 'overflow'
  >,
  requestedTotal: number,
  remaining: number,
): void {
  const processed =
    counts.completed +
    counts.failed +
    counts.stale +
    counts.skipped +
    counts.overflow;
  onProgress?.(processed, Math.max(requestedTotal, processed + remaining));
}

function combineAbortSignals(
  pairSignal: AbortSignal,
  runSignal?: AbortSignal,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  if (!runSignal || runSignal === pairSignal) {
    return { signal: pairSignal, dispose: () => undefined };
  }
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const onPairAbort = (): void => abortFrom(pairSignal);
  const onRunAbort = (): void => abortFrom(runSignal);
  if (pairSignal.aborted) abortFrom(pairSignal);
  else pairSignal.addEventListener('abort', onPairAbort, { once: true });
  if (runSignal.aborted) abortFrom(runSignal);
  else runSignal.addEventListener('abort', onRunAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      pairSignal.removeEventListener('abort', onPairAbort);
      runSignal.removeEventListener('abort', onRunAbort);
    },
  };
}

function waitForPromise<T>(
  task: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return task;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal, fallback?: unknown): unknown {
  if (isAbortError(signal.reason)) return signal.reason;
  if (isAbortError(fallback)) return fallback;
  return new DOMException('Translation was cancelled.', 'AbortError');
}
