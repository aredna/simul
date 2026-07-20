import type {
  ReplicaCaptureRequest,
  ReplicaCheckpointResponse,
  ReplicaDiagnosticCode,
  ReplicaLiveBatch,
  ReplicaLiveStreamLease,
  ReplicaLiveStreamObserver,
} from './contracts';
import {
  MAX_REPLICA_LIVE_UNACKED_BATCHES,
  createLiveAckMessage,
  createLiveCheckpointAckMessage,
  createLiveCheckpointRequest,
  createReplicaLivePortName,
  createStartLiveMessage,
  liveBatchFromEnvelope,
  ReplicaLiveProtocolError,
  readLiveRecorderMessage,
  sameReplicaDocument,
} from './live-protocol';
import { createReplicaIdentity, readReplicaIdentity } from './protocol-v2';

export async function openChromeReplicaLiveStream(
  request: ReplicaCaptureRequest,
  signal?: AbortSignal,
): Promise<ReplicaLiveStreamLease> {
  signal?.throwIfAborted();
  if (!request.isCurrent()) throw new DOMException('Stale replica identity.', 'AbortError');
  const injections = await browser.scripting.executeScript({
    target: { tabId: request.tabId, documentIds: [request.documentId] },
    files: ['/page-recorder.js'],
  });
  signal?.throwIfAborted();
  if (
    !request.isCurrent() ||
    !injections.some(
      (result) =>
        result.frameId === request.frameId &&
        result.documentId === request.documentId,
    )
  ) throw new DOMException('Stale replica identity.', 'AbortError');

  const identity = createReplicaIdentity({
    sessionId: request.sessionId,
    pageEpoch: request.pageEpoch,
    generation: request.generation,
    documentId: request.documentId,
    frameId: request.frameId,
    sequence: 0,
  });
  const port = browser.tabs.connect(request.tabId, {
    documentId: request.documentId,
    frameId: request.frameId,
    name: createReplicaLivePortName(request.sessionId),
  });
  return new ChromeReplicaLiveStreamLease(port, identity, request, signal);
}

class ChromeReplicaLiveStreamLease implements ReplicaLiveStreamLease {
  readonly initialCheckpoint: Promise<ReplicaCheckpointResponse>;
  readonly #resolveInitial: (value: ReplicaCheckpointResponse) => void;
  readonly #rejectInitial: (reason: unknown) => void;
  readonly #queued: Array<ReplicaLiveBatch | ReplicaCheckpointResponse> = [];
  #observer: ReplicaLiveStreamObserver | undefined;
  #receivedSequence = 0;
  #appliedSequence = 0;
  #recovering = false;
  #initialSettled = false;
  #disposed = false;
  #terminalFailure:
    | Extract<ReplicaDiagnosticCode, 'stream_gap' | 'stream_overflow' | 'stream_failed'>
    | undefined;
  #terminalFailureDelivered = false;

  constructor(
    private readonly port: Browser.runtime.Port,
    private readonly identity: ReturnType<typeof createReplicaIdentity>,
    private readonly request: ReplicaCaptureRequest,
    private readonly signal?: AbortSignal,
  ) {
    let resolveInitial!: (value: ReplicaCheckpointResponse) => void;
    let rejectInitial!: (reason: unknown) => void;
    this.initialCheckpoint = new Promise<ReplicaCheckpointResponse>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    this.#resolveInitial = resolveInitial;
    this.#rejectInitial = rejectInitial;
    this.port.onMessage.addListener(this.#onMessage);
    this.port.onDisconnect.addListener(this.#onDisconnect);
    this.signal?.addEventListener('abort', this.#onAbort, { once: true });
    try {
      this.port.postMessage(createStartLiveMessage(this.identity));
    } catch (error) {
      this.#fail(error);
    }
  }

  setObserver(observer: ReplicaLiveStreamObserver): void {
    if (this.#terminalFailure) {
      this.#observer = observer;
      this.#deliverTerminalFailure();
      this.#observer = undefined;
      return;
    }
    if (this.#disposed) return;
    this.#observer = observer;
    const queued = this.#queued.splice(0);
    for (const item of queued) {
      if (this.#disposed) break;
      if ('firstSequence' in item) {
        if (!this.#deliverBatch(item)) break;
      } else if (!this.#deliverCheckpoint(item)) break;
    }
  }

  acknowledge(sequence: number): void {
    if (
      this.#disposed ||
      !Number.isSafeInteger(sequence) ||
      sequence < this.#appliedSequence ||
      sequence > this.#receivedSequence
    ) return;
    this.#appliedSequence = sequence;
    try {
      this.port.postMessage(createLiveAckMessage(this.identity, sequence));
    } catch {
      this.#fail(new Error('Replica stream acknowledgement failed.'));
    }
  }

  acknowledgeCheckpoint(sequence: number): void {
    if (
      this.#disposed ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      sequence > this.#receivedSequence
    ) return;
    try {
      this.port.postMessage(createLiveCheckpointAckMessage(this.identity, sequence));
    } catch {
      this.#fail(new Error('Replica checkpoint acknowledgement failed.'));
    }
  }

  requestCheckpoint(): void {
    if (this.#disposed || this.#recovering) return;
    this.#recovering = true;
    this.#postCheckpointRequest();
  }

  #postCheckpointRequest(): void {
    try {
      this.port.postMessage(
        createLiveCheckpointRequest(this.identity, this.#appliedSequence),
      );
    } catch {
      this.#fail(new Error('Replica checkpoint request failed.'));
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.port.onMessage.removeListener(this.#onMessage);
    this.port.onDisconnect.removeListener(this.#onDisconnect);
    this.signal?.removeEventListener('abort', this.#onAbort);
    if (!this.#initialSettled) {
      this.#initialSettled = true;
      this.#rejectInitial(new DOMException('Replica stream closed.', 'AbortError'));
    }
    try {
      this.port.disconnect();
    } catch {
      // Disconnect is idempotent at the browser boundary.
    }
    this.#queued.length = 0;
    this.#observer = undefined;
  }

  readonly #onMessage = (input: unknown): void => {
    if (this.#disposed || !this.request.isCurrent()) {
      this.dispose();
      return;
    }
    const message = readLiveRecorderMessage(input, this.identity);
    if (!message) {
      const candidateIdentity = isRecord(input)
        ? readReplicaIdentity(input.identity)
        : undefined;
      if (
        this.#initialSettled &&
        candidateIdentity &&
        sameReplicaDocument(candidateIdentity, this.identity)
      ) {
        if (this.#recovering) return;
        this.#queued.length = 0;
        if (!this.#deliverRecoveryFailure('stream_gap')) return;
        this.requestCheckpoint();
        return;
      }
      this.#fail(new Error('The replica stream returned an invalid message.'));
      return;
    }
    if (
      message.kind === 'simul:replica-v2:checkpoint' ||
      message.kind === 'simul:replica-v2:checkpoint-error'
    ) {
      const isUnexpectedReplacement = this.#initialSettled && (
        message.kind === 'simul:replica-v2:checkpoint-error'
          ? !this.#recovering
          : message.identity.sequence < this.#receivedSequence
      );
      if (isUnexpectedReplacement) {
        this.#fail(new Error('The replica stream returned an unexpected checkpoint.'));
        return;
      }
      if (message.kind === 'simul:replica-v2:checkpoint') {
        this.#receivedSequence = message.identity.sequence;
        this.#recovering = false;
      }
      if (!this.#initialSettled) {
        this.#initialSettled = true;
        this.#resolveInitial(message);
      } else {
        this.#queued.length = 0;
        this.#deliverCheckpoint(message);
      }
      return;
    }
    if (message.kind === 'simul:replica-v2:stream-error') {
      if (!this.#initialSettled) {
        this.#initialSettled = true;
        this.#rejectInitial(new ReplicaLiveProtocolError(message.payload.code));
        this.dispose();
        return;
      }
      this.#queued.length = 0;
      if (message.payload.code === 'stream_failed') {
        this.#fail(new ReplicaLiveProtocolError(message.payload.code));
        return;
      }
      this.#recovering = true;
      if (!this.#deliverRecoveryFailure(message.payload.code)) return;
      return;
    }
    if (!this.#initialSettled) {
      this.#fail(new Error('The replica stream returned events before its checkpoint.'));
      return;
    }
    const batch = liveBatchFromEnvelope(message);
    if (this.#recovering) return;
    if (batch.firstSequence !== this.#receivedSequence + 1) {
      if (!this.#deliverRecoveryFailure('stream_gap')) return;
      this.requestCheckpoint();
      return;
    }
    this.#receivedSequence = batch.lastSequence;
    if (this.#observer) {
      this.#deliverBatch(batch);
    } else if (this.#queued.length < MAX_REPLICA_LIVE_UNACKED_BATCHES) {
      this.#queued.push(batch);
    } else {
      this.#queued.length = 0;
      this.requestCheckpoint();
    }
  };

  readonly #onDisconnect = (): void => {
    if (!this.#disposed) this.#fail(new Error('The replica stream disconnected.'));
  };

  readonly #onAbort = (): void => this.dispose();

  #deliverCheckpoint(checkpoint: ReplicaCheckpointResponse): boolean {
    if (this.#observer) {
      try {
        this.#observer.onCheckpoint(checkpoint);
        return !this.#disposed;
      } catch {
        this.#fail(new Error('The replica checkpoint observer failed.'));
        return false;
      }
    }
    else if (this.#queued.length < MAX_REPLICA_LIVE_UNACKED_BATCHES) {
      this.#queued.push(checkpoint);
    } else this.#fail(new Error('The replica stream recovery queue overflowed.'));
    return !this.#disposed;
  }

  #deliverBatch(batch: ReplicaLiveBatch): boolean {
    if (!this.#observer) return false;
    try {
      this.#observer.onBatch(batch);
      return !this.#disposed;
    } catch {
      this.#fail(new Error('The replica batch observer failed.'));
      return false;
    }
  }

  #deliverRecoveryFailure(
    code: Extract<ReplicaDiagnosticCode, 'stream_gap' | 'stream_overflow'>,
  ): boolean {
    if (!this.#observer) return true;
    try {
      this.#observer.onFailure(code);
      return !this.#disposed;
    } catch {
      this.#fail(new Error('The replica failure observer failed.'));
      return false;
    }
  }

  #deliverTerminalFailure(): void {
    if (
      !this.#terminalFailure ||
      this.#terminalFailureDelivered ||
      !this.#observer
    ) return;
    this.#terminalFailureDelivered = true;
    try {
      this.#observer.onFailure(this.#terminalFailure);
    } catch {
      // A consumer exception cannot keep the Port or queued page data alive.
    }
  }

  #fail(error: unknown): void {
    if (this.#disposed) return;
    if (!this.#initialSettled) {
      this.#initialSettled = true;
      this.#rejectInitial(error);
    } else {
      this.#terminalFailure = 'stream_failed';
      this.#deliverTerminalFailure();
    }
    this.dispose();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
