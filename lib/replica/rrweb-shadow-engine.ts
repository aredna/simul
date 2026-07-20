import { Replayer } from '@rrweb/replay';

import {
  emptyReplicaDiagnostics,
  type ReplicaCaptureRequest,
  type ReplicaCheckpointResponse,
  type ReplicaDiagnosticCode,
  type ReplicaDiagnostics,
  type ReplicaEngine,
  type ReplicaLiveBatch,
  type ReplicaLiveStreamFactory,
  type ReplicaLiveStreamLease,
  type ReplicaRunResult,
} from './contracts';
import {
  MAX_REPLICA_LIVE_HISTORY_BATCHES,
  MAX_REPLICA_LIVE_HISTORY_BYTES,
  ReplicaLiveProtocolError,
} from './live-protocol';
import { RrwebStreamSanitizer } from './rrweb-stream-sanitizer';
import {
  SourceValueModel,
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
  type ReplicaSourceTextChange,
} from './source-value-model';
import type {
  ReplayPresentationHost,
  VisibleReplayCandidateLease,
} from './visible-replay-host';
import type {
  ReplicaProjectionContext,
  ReplicaSourceCommit,
  ReplicaTextProjection,
  ReplicaTranslationSnapshot,
  ReplicaTranslationSurface,
} from '../translation/replica-translation-coordinator';

export const SHADOW_CAPTURE_DEADLINE_MS = 5_000;
export const SHADOW_REPLAY_DEADLINE_MS = 5_000;

interface ReplayerLike {
  readonly iframe: HTMLIFrameElement;
  on(event: string, handler: (event?: unknown) => void): unknown;
  off?(event: string, handler: (event?: unknown) => void): unknown;
  play(timeOffset?: number): void;
  startLive?(baselineTime?: number): void;
  addEvent?(event: unknown): void;
  getMirror?(): {
    getNode(id: number): Node | null;
  };
  disableInteract(): void;
  destroy(): void;
}

type ReplayerFactory = (
  events: readonly unknown[],
  root: HTMLElement,
  live: boolean,
) => ReplayerLike;

interface RrwebShadowReplicaEngineOptions {
  readonly presentationHost: ReplayPresentationHost;
  readonly capture: (
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ) => Promise<ReplicaCheckpointResponse>;
  readonly openStream?: ReplicaLiveStreamFactory;
  readonly onLiveFailure?: (code: ReplicaDiagnosticCode) => void;
  readonly onLiveApplied?: () => void;
  readonly onLayoutChanged?: () => void;
  readonly onSourceCommit?: (commit: ReplicaSourceCommit) => void;
  readonly createReplayer?: ReplayerFactory;
  readonly createSanitizer?: () => RrwebStreamSanitizer;
  readonly now?: () => number;
  readonly captureDeadlineMs?: number;
  readonly replayDeadlineMs?: number;
  readonly maxAppliedBatchesBeforeCheckpoint?: number;
  readonly maxAppliedBytesBeforeCheckpoint?: number;
  readonly shouldReplayScroll?: () => boolean;
}

interface ManagedReplay {
  readonly lease: VisibleReplayCandidateLease;
  readonly abortController: AbortController;
  replayer?: ReplayerLike;
  sanitizer?: RrwebStreamSanitizer;
  readonly sourceModel: SourceValueModel;
  readonly checkpointSequence: number;
  sequence: number;
  replayLease: number;
  released: boolean;
}

interface ManagedLiveStream {
  readonly lease: ReplicaLiveStreamLease;
  readonly request: ReplicaCaptureRequest;
  readonly runVersion: number;
  readonly pending: ReplicaLiveBatch[];
  processing: Promise<void> | undefined;
  recoveryTask: Promise<void> | undefined;
  queuedCheckpoint: Extract<ReplicaCheckpointResponse, { kind: 'simul:replica-v2:checkpoint' }> | undefined;
  initializing: boolean;
  recovering: boolean;
  recoveryAttempts: number;
  recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  appliedBatches: number;
  appliedBytes: number;
  disposed: boolean;
}

export interface ReplicaImageAnchor {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly replayLease: number;
  readonly image: HTMLImageElement;
  readonly iframe: HTMLIFrameElement;
}

class ShadowReplicaError extends Error {
  constructor(readonly code: ReplicaDiagnosticCode) {
    super(code);
    this.name = 'ShadowReplicaError';
  }
}

export class ReplicaCaptureBoundaryError extends Error {
  constructor(readonly code: ReplicaDiagnosticCode) {
    super(code);
    this.name = 'ReplicaCaptureBoundaryError';
  }
}

export class RrwebShadowReplicaEngine
  implements ReplicaEngine, ReplicaTranslationSurface {
  readonly id = 'rrweb-shadow-v2' as const;
  readonly #createReplayer: ReplayerFactory;
  readonly #createSanitizer: () => RrwebStreamSanitizer;
  readonly #now: () => number;
  #disposed = false;
  #runVersion = 0;
  #candidate: ManagedReplay | undefined;
  #committed: ManagedReplay | undefined;
  #liveStream: ManagedLiveStream | undefined;
  #sourceValues = new SourceValueModel();
  #replayLease = 0;
  #projectionContext: ReplicaProjectionContext = {
    translationEpoch: 0,
    pairKey: undefined,
  };
  #projections = new Map<number, ReplicaTextProjection>();
  #extentRefreshPending = false;
  #extentRefreshReplay: ManagedReplay | undefined;

  constructor(private readonly options: RrwebShadowReplicaEngineOptions) {
    this.#now = options.now ?? (() => performance.now());
    this.#createReplayer = options.createReplayer ?? createRrwebReplayer;
    this.#createSanitizer = options.createSanitizer ?? (() => new RrwebStreamSanitizer());
  }

  async run(
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    if (this.#disposed || signal?.aborted || !request.isCurrent()) {
      return this.skipped('stale_identity');
    }
    const runVersion = ++this.#runVersion;
    this.#releaseCandidate();
    this.#releaseLiveStream();

    let response: ReplicaCheckpointResponse;
    let liveStream: ManagedLiveStream | undefined;
    try {
      if (this.options.openStream) {
        const lease = await openLiveStreamWithDeadline(
          this.options.openStream,
          request,
          this.options.captureDeadlineMs ?? SHADOW_CAPTURE_DEADLINE_MS,
          signal,
        );
        if (!this.#isCurrentRun(runVersion, request, signal)) {
          lease.dispose();
          return this.skipped('stale_identity');
        }
        liveStream = {
          lease,
          request,
          runVersion,
          pending: [],
          processing: undefined,
          recoveryTask: undefined,
          queuedCheckpoint: undefined,
          initializing: true,
          recovering: false,
          recoveryAttempts: 0,
          recoveryTimer: undefined,
          appliedBatches: 0,
          appliedBytes: 0,
          disposed: false,
        };
        this.#liveStream = liveStream;
        this.#observeLiveStream(liveStream);
        response = await withDeadline(
          lease.initialCheckpoint,
          this.options.captureDeadlineMs ?? SHADOW_CAPTURE_DEADLINE_MS,
          signal,
          'capture_timeout',
        );
      } else {
        response = await withDeadline(
          this.options.capture(request, signal),
          this.options.captureDeadlineMs ?? SHADOW_CAPTURE_DEADLINE_MS,
          signal,
          'capture_timeout',
        );
      }
    } catch (error) {
      if (liveStream) this.#disposeLiveStream(liveStream);
      if (!this.#isCurrentRun(runVersion, request, signal)) {
        return this.skipped('stale_identity');
      }
      const code = readShadowErrorCode(error, 'capture_failed');
      return code === 'stale_identity'
        ? this.skipped(code)
        : this.failure(code);
    }
    if (!this.#isCurrentRun(runVersion, request, signal)) {
      if (liveStream) this.#disposeLiveStream(liveStream);
      return this.skipped('stale_identity');
    }
    if (response.kind === 'simul:replica-v2:checkpoint-error') {
      if (liveStream) this.#disposeLiveStream(liveStream);
      if (response.payload.code === 'capture_busy') {
        // A busy replacement must not leave a prior document presented under
        // the new identity. The engine stays enabled so a later run can retry.
        this.releasePresentation(true);
        return this.skipped('capture_busy');
      }
      return this.failure(response.payload.code);
    }

    const payload = response.payload;
    // Concurrent runs can finish capture out of order. Revoke any earlier
    // uncommitted replay before this run takes the single candidate slot.
    this.#releaseCandidate();
    let candidate: ManagedReplay | undefined;
    let committed = false;
    let streamCommitted = false;
    const replayStartedAt = this.#now();
    try {
      candidate = {
        lease: this.options.presentationHost.createCandidate({
          viewportWidth: payload.viewportWidth,
          viewportHeight: payload.viewportHeight,
          documentWidth: payload.documentWidth,
          documentHeight: payload.documentHeight,
        }),
        abortController: new AbortController(),
        sourceModel: this.#sourceValues.fork(),
        checkpointSequence: response.identity.sequence,
        sequence: response.identity.sequence,
        replayLease: 0,
        released: false,
      };
      this.#candidate = candidate;
      candidate.replayer = this.#createReplayer(
        payload.events,
        candidate.lease.mount,
        Boolean(liveStream),
      );
      protectReplayIframe(candidate.replayer.iframe);
      candidate.replayer.disableInteract();
      await waitForFullSnapshot(
        candidate.replayer,
        this.options.replayDeadlineMs ?? SHADOW_REPLAY_DEADLINE_MS,
        signal
          ? AbortSignal.any([signal, candidate.abortController.signal])
          : candidate.abortController.signal,
      );
      const sourceCheckpoint = candidate.sourceModel.prepareCheckpoint(
        response.identity,
        payload.events,
      );
      if (!sourceCheckpoint) {
        throw new ShadowReplicaError('privacy_rejected');
      }
      sourceCheckpoint.commit();
      if (liveStream) {
        candidate.sanitizer = this.#createSanitizer();
        if (!candidate.sanitizer.reset(payload.events)) {
          throw new ShadowReplicaError('privacy_rejected');
        }
        candidate.replayer.startLive?.();
        const catchupSequence = liveStream.pending.at(-1)?.lastSequence ?? candidate.sequence;
        await this.#applyPendingToReplay(
          liveStream,
          candidate,
          false,
          false,
          catchupSequence,
        );
      }
      if (
        !this.#isCurrentRun(runVersion, request, signal) ||
        this.#candidate !== candidate
      ) {
        return this.skipped('stale_identity');
      }
      const nextReplayLease = this.#replayLease + 1;
      const nextProjections = this.#projectionsForCandidate(
        candidate,
        nextReplayLease,
      );
      // Candidate projections are applied as one hidden mutation set before
      // the single extent read used for atomic presentation.
      const extent = measureReplayExtent(candidate.replayer.iframe);
      const diagnostics: ReplicaDiagnostics = {
        engine: this.id,
        code: 'shadow_complete',
        bytes: payload.byteLength,
        eventCount: payload.events.length,
        captureMs: payload.captureMs,
        replayMs: boundedDuration(this.#now() - replayStartedAt),
        sourceViewportWidth: payload.viewportWidth,
        sourceViewportHeight: payload.viewportHeight,
        sourceDocumentWidth: payload.documentWidth,
        sourceDocumentHeight: payload.documentHeight,
        replayDocumentWidth: extent.width,
        replayDocumentHeight: extent.height,
      };
      candidate.replayLease = nextReplayLease;
      candidate.lease.commit(candidate.replayer.iframe, extent);
      const previous = this.#committed;
      this.#candidate = undefined;
      this.#committed = candidate;
      this.#sourceValues = candidate.sourceModel;
      this.#replayLease = nextReplayLease;
      this.#projections = nextProjections;
      committed = true;
      releaseManagedReplay(previous);
      if (liveStream) {
        streamCommitted = true;
        liveStream.initializing = false;
        liveStream.lease.acknowledgeCheckpoint(candidate.checkpointSequence);
        liveStream.lease.acknowledge(candidate.sequence);
        this.#notifySourceCommit(candidate, 'checkpoint', undefined, sourceCheckpoint.documentLanguageChanged);
        if (candidate.sequence > candidate.checkpointSequence) {
          this.options.onLiveApplied?.();
        }
        this.options.presentationHost.markLive(candidate.replayer.iframe);
        const queuedCheckpoint = liveStream.queuedCheckpoint;
        liveStream.queuedCheckpoint = undefined;
        if (queuedCheckpoint) {
          this.#startRecovery(liveStream, queuedCheckpoint);
        } else {
          this.#kickLiveProcessing(liveStream);
        }
      } else {
        this.#notifySourceCommit(candidate, 'checkpoint', undefined, sourceCheckpoint.documentLanguageChanged);
      }
      return { status: 'complete', diagnostics };
    } catch (error) {
      if (!this.#isCurrentRun(runVersion, request, signal)) {
        return this.skipped('stale_identity');
      }
      const code = readShadowErrorCode(error, 'replay_failed');
      if (code === 'stale_identity') return this.skipped(code);
      return this.failure(
        code,
        payload,
        this.#now() - replayStartedAt,
      );
    } finally {
      if (!committed && candidate) {
        if (this.#candidate === candidate) this.#candidate = undefined;
        releaseManagedReplay(candidate);
      }
      if (liveStream && !streamCommitted) this.#disposeLiveStream(liveStream);
    }
  }

  beginProjection(context: ReplicaProjectionContext): void {
    if (
      !Number.isSafeInteger(context.translationEpoch) ||
      context.translationEpoch < 0 ||
      (context.pairKey !== undefined &&
        (typeof context.pairKey !== 'string' || context.pairKey.length > 128))
    ) return;
    this.#projectionContext = Object.freeze({ ...context });
    this.#projections.clear();
    const committed = this.#committed;
    if (!committed?.replayer) return;
    let restored = false;
    for (const record of this.#sourceValues.records()) {
      const node = mirrorTextNode(committed.replayer, record.nodeId);
      if (node && node.textContent !== record.source) {
        node.textContent = record.source;
        restored = true;
      }
    }
    if (restored) this.#scheduleExtentRefresh(committed);
  }

  snapshot(): ReplicaTranslationSnapshot | undefined {
    const document = this.#sourceValues.document;
    const committed = this.#committed;
    if (!document || !committed || committed.released || committed.replayLease === 0) {
      return undefined;
    }
    return {
      document,
      ...(this.#sourceValues.documentLanguage
        ? { documentLanguage: this.#sourceValues.documentLanguage }
        : {}),
      replayLease: committed.replayLease,
      records: this.#sourceValues.records(),
    };
  }

  resolveImageAnchor(
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
  ): ReplicaImageAnchor | undefined {
    const committed = this.#committed;
    const currentDocument = this.#sourceValues.document;
    if (
      !committed?.replayer ||
      committed.released ||
      committed.replayLease === 0 ||
      !currentDocument ||
      !sameSourceDocument(currentDocument, document)
    ) return undefined;
    const image = mirrorImageNode(committed.replayer, nodeId);
    if (
      !image ||
      !image.isConnected ||
      image.ownerDocument !== committed.replayer.iframe.contentDocument
    ) return undefined;
    return Object.freeze({
      document: currentDocument,
      replayLease: committed.replayLease,
      image,
      iframe: committed.replayer.iframe,
    });
  }

  project(projection: ReplicaTextProjection): boolean {
    const committed = this.#committed;
    const document = this.#sourceValues.document;
    if (
      !committed?.replayer ||
      committed.released ||
      !document ||
      projection.nodeType !== 3 ||
      projection.replayLease !== committed.replayLease ||
      projection.translationEpoch !== this.#projectionContext.translationEpoch ||
      projection.pairKey !== this.#projectionContext.pairKey ||
      !sameSourceDocument(document, projection.document) ||
      projection.translated.length > 1_000_000
    ) return false;
    const record = this.#sourceValues.get(projection.nodeId);
    if (
      !record ||
      record.revision !== projection.sourceRevision ||
      record.source !== projection.source
    ) return false;
    const node = mirrorTextNode(committed.replayer, projection.nodeId);
    if (!node) return false;
    const textChanged = node.textContent !== projection.translated;
    node.textContent = projection.translated;
    this.#projections.set(projection.nodeId, Object.freeze({ ...projection }));
    if (textChanged) this.#scheduleExtentRefresh(committed);
    return true;
  }

  releasePresentation(showFallbackLabel = true): void {
    this.#runVersion += 1;
    this.#releaseLiveStream();
    this.#releaseCandidate();
    this.options.presentationHost.showLegacy(showFallbackLabel);
    releaseManagedReplay(this.#committed);
    this.#committed = undefined;
    this.#sourceValues.clear();
    this.#projections.clear();
    this.#replayLease += 1;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.releasePresentation(false);
    this.options.presentationHost.dispose();
  }

  #releaseCandidate(): void {
    releaseManagedReplay(this.#candidate);
    this.#candidate = undefined;
  }

  #projectionsForCandidate(
    candidate: ManagedReplay,
    replayLease: number,
  ): Map<number, ReplicaTextProjection> {
    const next = new Map<number, ReplicaTextProjection>();
    const candidateDocument = candidate.sourceModel.document;
    const currentDocument = this.#sourceValues.document;
    if (
      !candidate.replayer ||
      !candidateDocument ||
      !currentDocument ||
      !sameSourceDocument(candidateDocument, currentDocument)
    ) return next;
    for (const projection of this.#projections.values()) {
      const record = candidate.sourceModel.get(projection.nodeId);
      if (
        !record ||
        record.revision !== projection.sourceRevision ||
        record.source !== projection.source ||
        projection.translationEpoch !== this.#projectionContext.translationEpoch ||
        projection.pairKey !== this.#projectionContext.pairKey
      ) continue;
      const node = mirrorTextNode(candidate.replayer, projection.nodeId);
      if (!node) continue;
      node.textContent = projection.translated;
      next.set(
        projection.nodeId,
        Object.freeze({ ...projection, replayLease }),
      );
    }
    return next;
  }

  #notifySourceCommit(
    replay: ManagedReplay,
    reason: ReplicaSourceCommit['reason'],
    changes?: readonly ReplicaSourceTextChange[],
    documentLanguageChanged = false,
  ): void {
    const document = replay.sourceModel.document;
    if (!document || replay.replayLease === 0) return;
    const records = replay.sourceModel.records();
    const committedChanges = changes ?? records.map(
      (record): ReplicaSourceTextChange => ({ kind: 'upsert', record }),
    );
    try {
      this.options.onSourceCommit?.({
        document,
        ...(replay.sourceModel.documentLanguage
          ? { documentLanguage: replay.sourceModel.documentLanguage }
          : {}),
        documentLanguageChanged,
        replayLease: replay.replayLease,
        records,
        changes: Object.freeze([...committedChanges]),
        reason,
      });
    } catch {
      // Derived translation work cannot affect replay commit or source ACK.
    }
  }

  #scheduleExtentRefresh(replay: ManagedReplay): void {
    if (
      replay.released ||
      !replay.replayer ||
      this.#committed !== replay
    ) return;
    this.#extentRefreshReplay = replay;
    if (this.#extentRefreshPending) return;
    this.#extentRefreshPending = true;
    schedulePresentationRefresh(() => {
      this.#extentRefreshPending = false;
      const current = this.#extentRefreshReplay;
      this.#extentRefreshReplay = undefined;
      if (
        !current?.replayer ||
        current.released ||
        this.#committed !== current
      ) return;
      const extent = measureReplayExtent(current.replayer.iframe);
      this.options.presentationHost.refreshExtent(current.replayer.iframe, extent);
      this.options.onLayoutChanged?.();
    });
  }

  #isCurrentRun(
    runVersion: number,
    request: ReplicaCaptureRequest,
    signal: AbortSignal | undefined,
  ): boolean {
    return (
      !this.#disposed &&
      !signal?.aborted &&
      runVersion === this.#runVersion &&
      request.isCurrent()
    );
  }

  #observeLiveStream(stream: ManagedLiveStream): void {
    stream.lease.setObserver({
      onBatch: (batch) => {
        if (!this.#isLiveStreamCurrent(stream)) return;
        if (stream.pending.length >= 4) {
          if (stream.recovering) {
            this.#failLiveStream(stream, 'stream_overflow');
          } else {
            this.#requestLiveRecovery(stream, 'stream_overflow');
          }
          return;
        }
        stream.pending.push(batch);
        if (!stream.recovering) this.#kickLiveProcessing(stream);
      },
      onCheckpoint: (checkpoint) => {
        if (!this.#isLiveStreamCurrent(stream)) return;
        this.#clearRecoveryDeadline(stream);
        if (checkpoint.kind === 'simul:replica-v2:checkpoint-error') {
          this.#failLiveStream(stream, checkpoint.payload.code);
          return;
        }
        if (stream.initializing) {
          if (stream.queuedCheckpoint) {
            this.#failLiveStream(stream, 'stream_failed');
            return;
          }
          stream.recovering = true;
          stream.pending.length = 0;
          stream.queuedCheckpoint = checkpoint;
          return;
        }
        this.#startRecovery(stream, checkpoint);
      },
      onFailure: (code) => {
        if (!this.#isLiveStreamCurrent(stream)) return;
        if (code === 'stream_failed') {
          this.#failLiveStream(stream, code);
        } else if (stream.recovering) {
          this.#failLiveStream(stream, code);
        } else {
          this.#requestLiveRecovery(stream, code);
        }
      },
    });
  }

  #kickLiveProcessing(stream: ManagedLiveStream): void {
    if (
      !this.#isLiveStreamCurrent(stream) ||
      stream.initializing ||
      stream.recovering ||
      stream.processing ||
      stream.pending.length === 0
    ) return;
    const replay = this.#committed;
    if (!replay?.replayer || !replay.sanitizer) return;
    stream.processing = this.#applyPendingToReplay(stream, replay, true, false)
      .catch(() => {
        if (this.#isLiveStreamCurrent(stream) && !stream.recovering) {
          // A cast can fail after rrweb has touched part of the iframe. Keep
          // that uncommitted surface out of view while the atomic checkpoint
          // replacement is staged; the existing v1 mirror remains visible.
          this.options.presentationHost.showLegacy(false);
          this.#requestLiveRecovery(stream, 'stream_failed');
        }
      })
      .finally(() => {
        stream.processing = undefined;
        if (this.#isLiveStreamCurrent(stream) && !stream.recovering) {
          this.#kickLiveProcessing(stream);
        }
      });
  }

  async #applyPendingToReplay(
    stream: ManagedLiveStream,
    replay: ManagedReplay,
    acknowledge: boolean,
    allowDuringRecovery: boolean,
    throughSequence?: number,
  ): Promise<void> {
    if (!replay.replayer?.addEvent || !replay.sanitizer) {
      throw new ShadowReplicaError('replay_failed');
    }
    while (stream.pending.length > 0) {
      if (throughSequence !== undefined && replay.sequence >= throughSequence) return;
      if (stream.recovering && !allowDuringRecovery) return;
      if (!this.#isLiveStreamCurrent(stream) || replay.released) {
        throw new ShadowReplicaError('stale_identity');
      }
      const batch = stream.pending[0];
      if (!batch || batch.firstSequence !== replay.sequence + 1) {
        throw new ShadowReplicaError('stream_gap');
      }
      const prepared = replay.sanitizer.prepareBatch(batch.events);
      if (!prepared || prepared.events.length !== batch.events.length) {
        throw new ShadowReplicaError('privacy_rejected');
      }
      const sourceUpdate = replay.sourceModel.prepareBatch(
        batch.identity,
        prepared.events,
      );
      if (!sourceUpdate) {
        throw new ShadowReplicaError('privacy_rejected');
      }
      const replayEvents = this.options.shouldReplayScroll?.() === false
        ? prepared.events.filter((event) => !isScrollEvent(event))
        : prepared.events;
      const presentationPaused = acknowledge && replayEvents.length > 0;
      if (presentationPaused) {
        // rrweb mutates before event-cast. Keep the committed iframe hidden
        // behind last-good v1 until every event in this protocol batch casts,
        // so an eventual timeout can never expose a partial batch.
        this.options.presentationHost.showLegacy(false);
      }
      await waitForEventsCast(
        replay.replayer,
        replayEvents,
        this.options.replayDeadlineMs ?? SHADOW_REPLAY_DEADLINE_MS,
        replay.abortController.signal,
      );
      if (
        (stream.recovering && !allowDuringRecovery) ||
        stream.pending[0] !== batch
      ) return;
      if (!this.#isLiveStreamCurrent(stream) || replay.released) {
        throw new ShadowReplicaError('stale_identity');
      }
      prepared.commit();
      sourceUpdate.commit();
      replay.sequence = batch.lastSequence;
      stream.pending.shift();
      if (acknowledge) {
        if (presentationPaused) {
          this.options.presentationHost.markLive(replay.replayer.iframe);
        }
        stream.lease.acknowledge(replay.sequence);
        this.#notifySourceCommit(
          replay,
          'batch',
          sourceUpdate.changes,
          sourceUpdate.documentLanguageChanged,
        );
        this.options.onLiveApplied?.();
        this.#scheduleExtentRefresh(replay);
        stream.appliedBatches += 1;
        stream.appliedBytes += batch.byteLength;
        if (
          stream.appliedBatches >= (
            this.options.maxAppliedBatchesBeforeCheckpoint ??
            MAX_REPLICA_LIVE_HISTORY_BATCHES
          ) ||
          stream.appliedBytes >= (
            this.options.maxAppliedBytesBeforeCheckpoint ??
            MAX_REPLICA_LIVE_HISTORY_BYTES
          )
        ) {
          this.#requestLiveRecovery(stream, 'stream_overflow', false);
          return;
        }
      }
    }
  }

  #requestLiveRecovery(
    stream: ManagedLiveStream,
    code: Extract<ReplicaDiagnosticCode, 'stream_gap' | 'stream_overflow' | 'stream_failed'>,
    hideInFlight = true,
  ): void {
    if (!this.#isLiveStreamCurrent(stream)) return;
    if (stream.recovering) {
      this.#failLiveStream(stream, code);
      return;
    }
    if (stream.recoveryAttempts >= 1) {
      this.#failLiveStream(stream, code);
      return;
    }
    stream.recoveryAttempts += 1;
    stream.recovering = true;
    if (hideInFlight && stream.processing) {
      this.options.presentationHost.showLegacy(false);
    }
    stream.pending.length = 0;
    this.#armRecoveryDeadline(stream);
    stream.lease.requestCheckpoint();
  }

  #startRecovery(
    stream: ManagedLiveStream,
    checkpoint: Extract<ReplicaCheckpointResponse, { kind: 'simul:replica-v2:checkpoint' }>,
  ): void {
    if (!this.#isLiveStreamCurrent(stream)) return;
    this.#clearRecoveryDeadline(stream);
    if (stream.processing) this.options.presentationHost.showLegacy(false);
    if (stream.recoveryTask) {
      this.#failLiveStream(stream, 'stream_failed');
      return;
    }
    stream.recoveryTask = this.#recoverFromCheckpoint(stream, checkpoint)
      .finally(() => {
        stream.recoveryTask = undefined;
      });
  }

  async #recoverFromCheckpoint(
    stream: ManagedLiveStream,
    checkpoint: Extract<ReplicaCheckpointResponse, { kind: 'simul:replica-v2:checkpoint' }>,
  ): Promise<void> {
    if (!this.#isLiveStreamCurrent(stream)) return;
    if (!stream.recovering) stream.recoveryAttempts += 1;
    if (stream.recoveryAttempts > 1) {
      this.#failLiveStream(stream, 'stream_failed');
      return;
    }
    stream.recovering = true;
    let candidate: ManagedReplay | undefined;
    try {
      await stream.processing;
      if (!this.#isLiveStreamCurrent(stream)) return;
      while (
        stream.pending[0] &&
        stream.pending[0].lastSequence <= checkpoint.identity.sequence
      ) {
        stream.pending.shift();
      }
      if (
        stream.pending[0] &&
        stream.pending[0].firstSequence !== checkpoint.identity.sequence + 1
      ) {
        throw new ShadowReplicaError('stream_gap');
      }
      this.#releaseCandidate();
      const payload = checkpoint.payload;
      candidate = {
        lease: this.options.presentationHost.createCandidate({
          viewportWidth: payload.viewportWidth,
          viewportHeight: payload.viewportHeight,
          documentWidth: payload.documentWidth,
          documentHeight: payload.documentHeight,
        }),
        abortController: new AbortController(),
        sourceModel: this.#sourceValues.fork(),
        checkpointSequence: checkpoint.identity.sequence,
        sequence: checkpoint.identity.sequence,
        replayLease: 0,
        released: false,
      };
      this.#candidate = candidate;
      candidate.replayer = this.#createReplayer(
        payload.events,
        candidate.lease.mount,
        true,
      );
      protectReplayIframe(candidate.replayer.iframe);
      candidate.replayer.disableInteract();
      await waitForFullSnapshot(
        candidate.replayer,
        this.options.replayDeadlineMs ?? SHADOW_REPLAY_DEADLINE_MS,
        candidate.abortController.signal,
      );
      const sourceCheckpoint = candidate.sourceModel.prepareCheckpoint(
        checkpoint.identity,
        payload.events,
      );
      if (!sourceCheckpoint) {
        throw new ShadowReplicaError('privacy_rejected');
      }
      sourceCheckpoint.commit();
      candidate.sanitizer = this.#createSanitizer();
      if (!candidate.sanitizer.reset(payload.events)) {
        throw new ShadowReplicaError('privacy_rejected');
      }
      candidate.replayer.startLive?.();
      const catchupSequence = stream.pending.at(-1)?.lastSequence ?? candidate.sequence;
      await this.#applyPendingToReplay(
        stream,
        candidate,
        false,
        true,
        catchupSequence,
      );
      if (!this.#isLiveStreamCurrent(stream) || this.#candidate !== candidate) {
        throw new ShadowReplicaError('stale_identity');
      }
      const nextReplayLease = this.#replayLease + 1;
      const nextProjections = this.#projectionsForCandidate(
        candidate,
        nextReplayLease,
      );
      // Recovery reapplies current projections while hidden, then measures
      // once before the candidate becomes the committed presentation.
      const extent = measureReplayExtent(candidate.replayer.iframe);
      candidate.replayLease = nextReplayLease;
      candidate.lease.commit(candidate.replayer.iframe, extent);
      const previous = this.#committed;
      this.#candidate = undefined;
      this.#committed = candidate;
      this.#sourceValues = candidate.sourceModel;
      this.#replayLease = nextReplayLease;
      this.#projections = nextProjections;
      releaseManagedReplay(previous);
      stream.recovering = false;
      stream.recoveryAttempts = 0;
      stream.appliedBatches = 0;
      stream.appliedBytes = 0;
      stream.lease.acknowledgeCheckpoint(candidate.checkpointSequence);
      stream.lease.acknowledge(candidate.sequence);
      this.#notifySourceCommit(
        candidate,
        'recovery',
        undefined,
        sourceCheckpoint.documentLanguageChanged,
      );
      if (candidate.sequence > (previous?.sequence ?? candidate.sequence)) {
        this.options.onLiveApplied?.();
      }
      this.options.presentationHost.markLive(candidate.replayer.iframe);
      this.#kickLiveProcessing(stream);
    } catch {
      if (candidate && this.#candidate === candidate) {
        this.#candidate = undefined;
        releaseManagedReplay(candidate);
      }
      if (this.#isLiveStreamCurrent(stream)) {
        this.#failLiveStream(stream, 'stream_failed');
      }
    }
  }

  #isLiveStreamCurrent(stream: ManagedLiveStream): boolean {
    return (
      !this.#disposed &&
      !stream.disposed &&
      this.#liveStream === stream &&
      stream.runVersion === this.#runVersion &&
      stream.request.isCurrent()
    );
  }

  #failLiveStream(stream: ManagedLiveStream, code: ReplicaDiagnosticCode): void {
    if (!this.#isLiveStreamCurrent(stream)) return;
    this.#disposeLiveStream(stream);
    this.#releaseCandidate();
    // Keep the last committed replica owned until the controller has prepared
    // its bounded fallback. The callback may synchronously select legacy, but
    // a failed recovery candidate never tears down last-good state by itself.
    this.options.onLiveFailure?.(code);
  }

  #disposeLiveStream(stream: ManagedLiveStream): void {
    if (stream.disposed) return;
    stream.disposed = true;
    this.#clearRecoveryDeadline(stream);
    stream.pending.length = 0;
    stream.lease.dispose();
    if (this.#liveStream === stream) this.#liveStream = undefined;
  }

  #releaseLiveStream(): void {
    if (this.#liveStream) this.#disposeLiveStream(this.#liveStream);
  }

  #armRecoveryDeadline(stream: ManagedLiveStream): void {
    this.#clearRecoveryDeadline(stream);
    stream.recoveryTimer = setTimeout(() => {
      stream.recoveryTimer = undefined;
      this.#failLiveStream(stream, 'stream_failed');
    }, this.options.captureDeadlineMs ?? SHADOW_CAPTURE_DEADLINE_MS);
  }

  #clearRecoveryDeadline(stream: ManagedLiveStream): void {
    if (stream.recoveryTimer === undefined) return;
    clearTimeout(stream.recoveryTimer);
    stream.recoveryTimer = undefined;
  }

  private skipped(
    code: Extract<ReplicaDiagnosticCode, 'capture_busy' | 'stale_identity'>,
  ): ReplicaRunResult {
    return {
      status: 'skipped',
      diagnostics: emptyReplicaDiagnostics(this.id, code),
    };
  }

  private failure(
    code: ReplicaDiagnosticCode,
    payload?: Extract<ReplicaCheckpointResponse, { kind: 'simul:replica-v2:checkpoint' }>['payload'],
    replayMs = 0,
  ): ReplicaRunResult {
    const base = emptyReplicaDiagnostics(this.id, code);
    return {
      status: 'failed',
      diagnostics: payload
        ? {
            ...base,
            bytes: payload.byteLength,
            eventCount: payload.events.length,
            captureMs: payload.captureMs,
            replayMs: boundedDuration(replayMs),
            sourceViewportWidth: payload.viewportWidth,
            sourceViewportHeight: payload.viewportHeight,
            sourceDocumentWidth: payload.documentWidth,
            sourceDocumentHeight: payload.documentHeight,
          }
        : base,
    };
  }
}

function createRrwebReplayer(
  events: readonly unknown[],
  root: HTMLElement,
  live: boolean,
): ReplayerLike {
  return new Replayer(
    events as ConstructorParameters<typeof Replayer>[0],
    {
      root,
      liveMode: live,
      mouseTail: false,
      showWarning: false,
      showDebug: false,
      triggerFocus: false,
      UNSAFE_replayCanvas: false,
      pauseAnimation: true,
      skipInactive: false,
      loadTimeout: 0,
      useVirtualDom: false,
    },
  );
}

function mirrorTextNode(
  replayer: ReplayerLike,
  nodeId: number,
): Text | undefined {
  if (!Number.isSafeInteger(nodeId) || nodeId < 1 || !replayer.getMirror) {
    return undefined;
  }
  try {
    const node = replayer.getMirror().getNode(nodeId);
    return node?.nodeType === 3 ? (node as Text) : undefined;
  } catch {
    return undefined;
  }
}

function mirrorImageNode(
  replayer: ReplayerLike,
  nodeId: number,
): HTMLImageElement | undefined {
  if (!Number.isSafeInteger(nodeId) || nodeId < 1 || !replayer.getMirror) {
    return undefined;
  }
  try {
    const node = replayer.getMirror().getNode(nodeId);
    return node?.nodeType === 1 &&
      String((node as Element).tagName).toLowerCase() === 'img'
      ? node as HTMLImageElement
      : undefined;
  } catch {
    return undefined;
  }
}

function protectReplayIframe(iframe: HTMLIFrameElement): void {
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('inert', '');
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  // The extension uses border-box globally. Removing the user-agent iframe
  // border keeps the browsing context exactly at the captured viewport size.
  iframe.style.border = '0';
  iframe.style.pointerEvents = 'none';
}

function releaseManagedReplay(replay: ManagedReplay | undefined): void {
  if (!replay || replay.released) return;
  replay.released = true;
  replay.abortController.abort();
  try {
    replay.replayer?.destroy();
  } catch {
    // DOM ownership is still released when upstream teardown fails.
  }
  replay.lease.release();
}

function waitForFullSnapshot(
  replayer: ReplayerLike,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: ShadowReplicaError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      replayer.off?.('fullsnapshot-rebuilded', onRebuilt);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(new ShadowReplicaError('stale_identity'));
    const onRebuilt = (): void => finish();
    const timer = setTimeout(
      () => finish(new ShadowReplicaError('replay_timeout')),
      deadlineMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    replayer.on('fullsnapshot-rebuilded', onRebuilt);
    try {
      replayer.play(0);
    } catch {
      finish(new ShadowReplicaError('replay_failed'));
    }
  });
}

function waitForEventsCast(
  replayer: ReplayerLike,
  events: readonly unknown[],
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!replayer.addEvent || events.length === 0) {
    return events.length === 0
      ? Promise.resolve()
      : Promise.reject(new ShadowReplicaError('replay_failed'));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const remaining = new Set(events);
    const finish = (error?: ShadowReplicaError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      replayer.off?.('event-cast', onCast);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(new ShadowReplicaError('stale_identity'));
    const onCast = (event?: unknown): void => {
      if (!remaining.delete(event)) return;
      if (remaining.size === 0) finish();
    };
    const timer = setTimeout(
      () => finish(new ShadowReplicaError('replay_timeout')),
      deadlineMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    replayer.on('event-cast', onCast);
    try {
      for (const event of events) replayer.addEvent?.(event);
    } catch {
      finish(new ShadowReplicaError('replay_failed'));
    }
  });
}

function schedulePresentationRefresh(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 0);
}

function measureReplayExtent(iframe: HTMLIFrameElement): {
  width: number;
  height: number;
} {
  const replayDocument = iframe.contentDocument;
  if (!replayDocument) return { width: 0, height: 0 };
  return {
    width: boundedDimension(
      Math.max(
        replayDocument.documentElement?.scrollWidth ?? 0,
        replayDocument.body?.scrollWidth ?? 0,
      ),
    ),
    height: boundedDimension(
      Math.max(
        replayDocument.documentElement?.scrollHeight ?? 0,
        replayDocument.body?.scrollHeight ?? 0,
      ),
    ),
  };
}

function withDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  timeoutCode: ReplicaDiagnosticCode,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void =>
      finish(() => reject(new ShadowReplicaError('stale_identity')));
    const timer = setTimeout(
      () => finish(() => reject(new ShadowReplicaError(timeoutCode))),
      deadlineMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function openLiveStreamWithDeadline(
  openStream: ReplicaLiveStreamFactory,
  request: ReplicaCaptureRequest,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<ReplicaLiveStreamLease> {
  const openAbortController = new AbortController();
  const openSignal = signal
    ? AbortSignal.any([signal, openAbortController.signal])
    : openAbortController.signal;
  let opening: Promise<ReplicaLiveStreamLease>;
  try {
    opening = openStream(request, openSignal);
  } catch (error) {
    openAbortController.abort();
    throw error;
  }
  try {
    return await withDeadline(
      opening,
      deadlineMs,
      signal,
      'capture_timeout',
    );
  } catch (error) {
    openAbortController.abort();
    void opening.then(
      (lateLease) => lateLease.dispose(),
      () => undefined,
    );
    throw error;
  }
}

function readShadowErrorCode(
  error: unknown,
  fallback: ReplicaDiagnosticCode,
): ReplicaDiagnosticCode {
  if (error instanceof ShadowReplicaError) return error.code;
  if (error instanceof ReplicaCaptureBoundaryError) return error.code;
  if (error instanceof ReplicaLiveProtocolError) return error.code;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'stale_identity';
  }
  if (
    error instanceof Error &&
    /cannot access|permission|not allowed|receiving end does not exist/iu.test(error.message)
  ) return 'access_denied';
  return fallback;
}

function boundedDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(60_000, value)) : 0;
}

function boundedDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, value)) : 0;
}

function isScrollEvent(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 3 &&
    'data' in event &&
    typeof event.data === 'object' &&
    event.data !== null &&
    'source' in event.data &&
    event.data.source === 3
  );
}
