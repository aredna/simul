import type {
  ReplicaSourceDocumentIdentity,
  ReplicaSourceTextChange,
  ReplicaSourceTextRecord,
} from '../replica/source-text-record';
import { sameSourceDocument } from '../replica/source-text-record';
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
  /**
   * The language this pair's projections are in, for a surface that tells
   * screen readers the language of translated text (D124).
   */
  readonly targetLanguage?: string;
}

interface ReplicaProjectionBase {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly replayLease: number;
  readonly nodeId: number;
  readonly sourceRevision: number;
  readonly source: string;
  readonly translationEpoch: number;
  readonly pairKey: string;
  readonly translated: string;
}

export type ReplicaTextProjection = ReplicaProjectionBase & (
  | { readonly nodeType: 3 }
  | {
      readonly nodeType: 1;
      readonly controlTarget: 'value' | 'placeholder' | 'label';
    }
);

export interface ReplicaTranslationSnapshot {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly documentLanguage?: string;
  /**
   * Where `documentLanguage` comes from when the page does not declare it:
   * a PDF's scanned pages, read by the language probe.
   */
  readonly documentLanguageSource?: 'scanned-pages';
  readonly replayLease: number;
  readonly records: readonly ReplicaSourceTextRecord[];
}

export interface ReplicaTranslationSurface {
  beginProjection(context: ReplicaProjectionContext): void;
  snapshot(): ReplicaTranslationSnapshot | undefined;
  project(projection: ReplicaTextProjection): boolean;
  /**
   * Node ids in the order the surface wants them translated. Pending work
   * for other ids follows in its own order. Without it, work runs in record
   * order.
   */
  translationOrder?(): Iterable<number> | undefined;
  /**
   * A surface that goes on reading text during a run (a PDF's scanned
   * pages). A run that starts while it reads waits for its new records
   * instead of ending, until it stops reading; a run that starts while it
   * does not read is an ordinary run. Both or neither.
   */
  isReading?(): boolean;
  /** Resolves at the surface's next text change; rejects when `signal` aborts. */
  waitForText?(signal: AbortSignal): Promise<void>;
}

export interface ReplicaTranslationRunOptions
  extends CreateTranslationSessionOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (completed: number, total: number) => void;
  /**
   * The run has translated all it has and waits for a reading surface to
   * read more (a PDF's scanned pages).
   */
  readonly onWaitForText?: () => void;
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

interface CurrentReplicaRecordIndex {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly replayLease: number;
  readonly records: Map<number, ReplicaSourceTextRecord>;
}

// Match the validated Isolated HTML graph envelope so a fully admitted public
// option list cannot outrun the downstream translation lane. The lane remains
// sequential and the memory cache keeps its own tighter eviction budget.
export const MAX_PENDING_JOBS = 50_000;
export const MAX_PENDING_CHARACTERS = 8 * 1024 * 1024;

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
  #pairKey: string | undefined;
  #translationEpoch = 0;
  #pairController = new AbortController();
  #session: TranslationSession | undefined;
  #sessionTask: Promise<TranslationSession> | undefined;
  #pending = new Map<number, PendingJob>();
  #pendingCharacters = 0;
  #pendingSkipped = 0;
  #pendingOverflow = 0;
  #drainTask: Promise<ReplicaTranslationRunResult> | undefined;
  #currentRecords: CurrentReplicaRecordIndex | undefined;
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
      result.pairKey !== this.#pairKey
    ) return false;
    const snapshot = this.#currentRecords;
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
    this.#currentRecords = undefined;
    this.#session?.destroy();
    this.#session = undefined;
    this.#sessionTask = undefined;
    this.#pair = pair;
    this.#pairKey = pair && pair.sourceLanguage !== pair.targetLanguage
      ? translationPairKey(pair)
      : undefined;
    this.surface.beginProjection({
      translationEpoch: this.#translationEpoch,
      pairKey: this.#pairKey,
      ...(pair && this.#pairKey ? { targetLanguage: pair.targetLanguage } : {}),
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
    this.#replaceCurrentRecords(snapshot);
    if (this.surface.isReading?.() && this.surface.waitForText) {
      return this.#translateWhileReading(pair, requestedEpoch, snapshot, options);
    }
    const pairKey = this.#pairKey!;
    let candidateCount = 0;
    // In the surface's order, so the queue's caps drop the least urgent.
    for (const record of this.#ordered(snapshot.records)) {
      if (!isTranslatableRecord(record)) continue;
      candidateCount += 1;
      this.#enqueue({
        record,
        replayLease: snapshot.replayLease,
        translationEpoch: this.#translationEpoch,
        pairKey,
        pairSignal: this.#pairController.signal,
        ...(options.signal ? { signal: options.signal } : {}),
      }, false);
    }
    return this.#drain(options.onProgress, candidateCount);
  }

  /**
   * One run over a surface that is still reading text: what it has is
   * translated, then the run waits for more and translates that too, until
   * the surface stops reading. Every job carries the run's signal, progress
   * counts on across the waits, and the result covers the whole run. Text
   * read while a batch translates is queued as soon as the batch ends, so
   * the run only waits when there is nothing new.
   */
  async #translateWhileReading(
    pair: TranslationPair,
    requestedEpoch: number,
    first: ReplicaTranslationSnapshot,
    options: ReplicaTranslationRunOptions,
  ): Promise<ReplicaTranslationRunResult> {
    const pairKey = this.#pairKey!;
    // The run's own pair: a pair change ends the run, never re-targets it.
    const pairSignal = this.#pairController.signal;
    const queued = new Set<number>();
    const counts = { total: 0, completed: 0, failed: 0, stale: 0, skipped: 0, overflow: 0 };
    let result: ReplicaTranslationRunResult | undefined;
    let snapshot = first;
    const enqueueNew = (): number => {
      let added = 0;
      for (const record of this.#ordered(snapshot.records)) {
        if (!isTranslatableRecord(record) || queued.has(record.nodeId)) continue;
        queued.add(record.nodeId);
        added += 1;
        this.#enqueue({
          record,
          replayLease: snapshot.replayLease,
          translationEpoch: this.#translationEpoch,
          pairKey,
          pairSignal,
          ...(options.signal ? { signal: options.signal } : {}),
        }, false);
      }
      return added;
    };
    let added = enqueueNew();
    while (true) {
      if (added > 0 || !result) {
        const processedBefore = counts.completed + counts.failed + counts.stale +
          counts.skipped + counts.overflow;
        const onProgress = options.onProgress;
        const drained = await this.#drain(
          onProgress
            ? (completed, total) => onProgress(processedBefore + completed, processedBefore + total)
            : undefined,
          added,
        );
        result = drained;
        counts.total += drained.total;
        counts.completed += drained.completed;
        counts.failed += drained.failed;
        counts.stale += drained.stale;
        counts.skipped += drained.skipped;
        counts.overflow += drained.overflow;
        this.#assertRunCurrent(pair, requestedEpoch, options.signal);
      }
      // What the surface read meanwhile goes first; only nothing new waits.
      const latest = this.surface.snapshot();
      if (
        !latest ||
        latest.replayLease !== snapshot.replayLease ||
        !sameSourceDocument(latest.document, snapshot.document)
      ) break;
      if (latest !== snapshot) {
        snapshot = latest;
        this.#replaceCurrentRecords(snapshot);
      }
      added = enqueueNew();
      if (added > 0) continue;
      if (!(this.surface.isReading?.() ?? false)) break;
      // No await between the checks above and registering the wait, so no
      // page can be read in between unnoticed.
      const combined = combineAbortSignals(pairSignal, options.signal);
      try {
        const waiting = this.surface.waitForText!(combined.signal);
        try {
          options.onWaitForText?.();
        } catch {
          // Progress is shown on the side; the run goes on.
        }
        await waiting;
      } catch (error) {
        if (options.signal?.aborted) throw abortReason(options.signal, error);
        throw error;
      } finally {
        combined.dispose();
      }
      this.#assertRunCurrent(pair, requestedEpoch, options.signal);
    }
    return { ...(result ?? this.#emptyResult()), ...counts };
  }

  handleSourceCommit(commit: ReplicaSourceCommit): void {
    if (
      this.#disposed ||
      !this.#session ||
      !this.#pair ||
      this.#pair.sourceLanguage === this.#pair.targetLanguage
    ) return;
    // The current record index already authenticates ordinary in-lease batches.
    // Avoid rebuilding the surface's full snapshot for every small DOM mutation;
    // checkpoint/recovery commits still cross-check their new lease explicitly.
    const incremental = this.#isCurrentIncrementalCommit(commit);
    if (!incremental) {
      const snapshot = this.surface.snapshot();
      if (
        !snapshot ||
        snapshot.replayLease !== commit.replayLease ||
        !sameSourceDocument(snapshot.document, commit.document)
      ) return;
      // Checkpoint/recovery replaces the projection lease. Work that has not
      // started belongs wholly to the prior surface and must not leak stale
      // counts into the clean current-lease drain queued below.
      this.#pending.clear();
      this.#pendingCharacters = 0;
      this.#pendingSkipped = 0;
      this.#pendingOverflow = 0;
    }
    this.#applySourceCommitToCurrentRecords(commit);
    const pairKey = this.#pairKey!;
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

  /**
   * Puts pending work in the surface's preferred order (a PDF translates the
   * page being read first). Work the surface does not name keeps its order
   * after the named work.
   */
  reprioritize(): void {
    if (this.#disposed || this.#pending.size < 2) return;
    const order = this.surface.translationOrder?.();
    if (!order) return;
    const next = new Map<number, PendingJob>();
    for (const nodeId of order) {
      const job = this.#pending.get(nodeId);
      if (job && !next.has(nodeId)) next.set(nodeId, job);
    }
    if (next.size === 0) return;
    for (const [nodeId, job] of this.#pending) {
      if (!next.has(nodeId)) next.set(nodeId, job);
    }
    this.#pending = next;
  }

  cancelPending(): void {
    this.#pending.clear();
    this.#pendingCharacters = 0;
    this.#pendingSkipped = 0;
    this.#pendingOverflow = 0;
    this.#currentRecords = undefined;
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
    this.#currentRecords = undefined;
  }

  /** Records in the surface's order; the rest after, in their own order. */
  #ordered(
    records: readonly ReplicaSourceTextRecord[],
  ): readonly ReplicaSourceTextRecord[] {
    const order = this.surface.translationOrder?.();
    if (!order) return records;
    const byId = indexReplicaRecords(records);
    const ordered: ReplicaSourceTextRecord[] = [];
    for (const nodeId of order) {
      const record = byId.get(nodeId);
      if (!record) continue;
      ordered.push(record);
      byId.delete(nodeId);
    }
    for (const record of records) {
      if (byId.has(record.nodeId)) ordered.push(record);
    }
    return ordered;
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
        if (!sameResultContext(context, this.#resultContext())) break;
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
          const projectionBase = {
            document: job.record.document,
            replayLease: job.replayLease,
            nodeId: job.record.nodeId,
            sourceRevision: job.record.revision,
            source: job.record.source,
            translationEpoch: job.translationEpoch,
            pairKey: job.pairKey,
            translated: `${boundary.leading}${translated.trim()}${boundary.trailing}`,
          };
          const projection: ReplicaTextProjection = job.record.nodeType === 1
            ? {
                ...projectionBase,
                nodeType: 1,
                controlTarget: job.record.controlTarget,
              }
            : { ...projectionBase, nodeType: 3 };
          const projected = this.surface.project(projection);
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
    }).finally(() => {
      if (
        !this.#disposed &&
        (this.#pending.size > 0 ||
          this.#pendingSkipped > 0 ||
          this.#pendingOverflow > 0)
      ) this.#startBackgroundDrain();
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

  #resultContext(): Pick<
    ReplicaTranslationRunResult,
    'document' | 'replayLease' | 'translationEpoch' | 'pairKey'
  > {
    const snapshot = this.#currentRecords ?? this.surface.snapshot();
    return {
      translationEpoch: this.#translationEpoch,
      ...(this.#pairKey ? { pairKey: this.#pairKey } : {}),
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
      this.#pairKey !== job.pairKey
    ) return false;
    const snapshot = this.#currentRecords;
    if (
      !snapshot ||
      snapshot.replayLease !== job.replayLease ||
      !sameSourceDocument(snapshot.document, job.record.document)
    ) return false;
    const current = snapshot.records.get(job.record.nodeId);
    return Boolean(
      current &&
        current.nodeType === job.record.nodeType &&
        (current.nodeType !== 1 ||
          (job.record.nodeType === 1 &&
            current.controlTarget === job.record.controlTarget)) &&
        current.revision === job.record.revision &&
        current.source === job.record.source,
    );
  }

  #replaceCurrentRecords(snapshot: ReplicaTranslationSnapshot): void {
    this.#currentRecords = {
      document: snapshot.document,
      replayLease: snapshot.replayLease,
      records: indexReplicaRecords(snapshot.records),
    };
  }

  #isCurrentIncrementalCommit(commit: ReplicaSourceCommit): boolean {
    return Boolean(
      commit.reason === 'batch' &&
        this.#currentRecords?.replayLease === commit.replayLease &&
        sameSourceDocument(this.#currentRecords.document, commit.document),
    );
  }

  #applySourceCommitToCurrentRecords(commit: ReplicaSourceCommit): void {
    const current = this.#currentRecords;
    if (
      !current ||
      commit.reason !== 'batch' ||
      current.replayLease !== commit.replayLease ||
      !sameSourceDocument(current.document, commit.document)
    ) {
      this.#currentRecords = {
        document: commit.document,
        replayLease: commit.replayLease,
        records: indexReplicaRecords(commit.records),
      };
      return;
    }
    for (const change of commit.changes) {
      if (change.kind === 'remove') current.records.delete(change.nodeId);
      else current.records.set(change.record.nodeId, change.record);
    }
  }
}

function indexReplicaRecords(
  records: readonly ReplicaSourceTextRecord[],
): Map<number, ReplicaSourceTextRecord> {
  const indexed = new Map<number, ReplicaSourceTextRecord>();
  for (const record of records) indexed.set(record.nodeId, record);
  return indexed;
}

export function translationPairKey(pair: TranslationPair): string {
  return `${pair.sourceLanguage}>${pair.targetLanguage}`;
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
    left.record.nodeType === right.record.nodeType &&
    (left.record.nodeType !== 1 ||
      (right.record.nodeType === 1 &&
        left.record.controlTarget === right.record.controlTarget)) &&
    left.record.revision === right.record.revision &&
    left.record.source === right.record.source &&
    left.replayLease === right.replayLease &&
    left.translationEpoch === right.translationEpoch &&
    left.pairKey === right.pairKey &&
    left.pairSignal === right.pairSignal &&
    left.signal === right.signal &&
    sameSourceDocument(left.record.document, right.record.document)
  );
}

function sameResultContext(
  left: Pick<
    ReplicaTranslationRunResult,
    'document' | 'replayLease' | 'translationEpoch' | 'pairKey'
  >,
  right: Pick<
    ReplicaTranslationRunResult,
    'document' | 'replayLease' | 'translationEpoch' | 'pairKey'
  >,
): boolean {
  return (
    left.translationEpoch === right.translationEpoch &&
    left.pairKey === right.pairKey &&
    left.replayLease === right.replayLease &&
    ((!left.document && !right.document) ||
      Boolean(
        left.document &&
          right.document &&
          sameSourceDocument(left.document, right.document),
      ))
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
