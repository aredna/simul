import type { ReplicaCaptureRequest, ReplicaDiagnosticCode } from './contracts';
import {
  assembleHtmlMirrorCheckpoint,
  createHtmlMirrorAck,
  createHtmlMirrorCheckpointRequest,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  decodeHtmlMirrorWireMessage,
  HtmlMirrorScrollPaneLedger,
  readHtmlMirrorSourceMessage,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorCheckpointPart,
  type HtmlMirrorPatchBatch,
  type HtmlMirrorScrollUpdate,
} from './html-mirror-protocol';
import {
  createHtmlMirrorRepresentabilityCollector,
  snapshotHtmlMirrorRepresentability,
  type HtmlMirrorRepresentabilitySummary,
} from './html-mirror-sanitizer';
import {
  DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
  MAX_HTML_MIRROR_BYTES,
  MAX_HTML_MIRROR_NODES,
  type HtmlMirrorLimitSettings,
} from './html-mirror-limits';
import { createReplicaIdentity } from './replica-identity';
import type { SelectableReplicaFidelityPolicy } from './fidelity-policy';

export interface HtmlMirrorStreamObserver {
  onPatch(batch: HtmlMirrorPatchBatch): void;
  onCheckpoint(checkpoint: HtmlMirrorCheckpoint): void;
  onScroll(update: HtmlMirrorScrollUpdate): void;
  onFailure(code: Extract<
    ReplicaDiagnosticCode,
    'stream_gap' | 'stream_overflow' | 'stream_failed' | 'privacy_rejected'
  >, representability?: HtmlMirrorRepresentabilitySummary): void;
  /**
   * A part of a checkpoint read in slices arrived and checked (D163): the
   * page is still reading, so a wait for its checkpoint goes on.
   */
  onProgress?(): void;
}

export interface HtmlMirrorStreamLease {
  readonly initialCheckpoint: Promise<HtmlMirrorCheckpoint>;
  setObserver(observer: HtmlMirrorStreamObserver): void;
  acknowledge(sequence: number): void;
  requestCheckpoint(sequence: number): void;
  dispose(): void;
}

/**
 * How long the page may send nothing towards the first checkpoint: the
 * deadline restarts at each part, and after a preview runs on until its
 * full copy arrives (D163). A read that goes on never times out; one that
 * stalls does.
 */
export const HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS = 5_000;
export const MAX_HTML_MIRROR_PREOBSERVER_MESSAGES = 8;

type QueuedHtmlMirrorMessage =
  | HtmlMirrorCheckpoint
  | HtmlMirrorPatchBatch
  | HtmlMirrorScrollUpdate
  | {
      readonly kind: 'failure';
      readonly code: Extract<
        ReplicaDiagnosticCode,
        'stream_gap' | 'stream_overflow' | 'stream_failed' | 'privacy_rejected'
      >;
      readonly representability: HtmlMirrorRepresentabilitySummary;
    };

export type HtmlMirrorStreamFactory = (
  request: ReplicaCaptureRequest,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
  signal?: AbortSignal,
  limits?: HtmlMirrorLimitSettings,
  showEverything?: boolean,
) => Promise<HtmlMirrorStreamLease>;

export async function openChromeHtmlMirrorStream(
  request: ReplicaCaptureRequest,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  signal?: AbortSignal,
  limits: HtmlMirrorLimitSettings = DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
  showEverything = false,
): Promise<HtmlMirrorStreamLease> {
  signal?.throwIfAborted();
  if (!request.isCurrent()) {
    throw new DOMException('Stale HTML mirror identity.', 'AbortError');
  }
  const injections = await browser.scripting.executeScript({
    target: { tabId: request.tabId, documentIds: [request.documentId] },
    files: ['/page-mirror.js'],
  });
  signal?.throwIfAborted();
  if (
    !request.isCurrent() ||
    !injections.some(
      (result) => result.frameId === request.frameId &&
        result.documentId === request.documentId,
    )
  ) throw new DOMException('Stale HTML mirror identity.', 'AbortError');
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
    name: createHtmlMirrorPortName(request.sessionId),
  });
  return new ChromeHtmlMirrorStreamLease(
    port,
    identity,
    request,
    fidelityPolicy,
    limits,
    showEverything,
    signal,
  );
}

class ChromeHtmlMirrorStreamLease implements HtmlMirrorStreamLease {
  readonly initialCheckpoint: Promise<HtmlMirrorCheckpoint>;
  readonly #resolveInitial: (checkpoint: HtmlMirrorCheckpoint) => void;
  readonly #rejectInitial: (error: unknown) => void;
  readonly #queue: QueuedHtmlMirrorMessage[] = [];
  #observer: HtmlMirrorStreamObserver | undefined;
  /** Every pane's place, from the lists the page has sent (D122). */
  readonly #panes = new HtmlMirrorScrollPaneLedger();
  #initialSettled = false;
  #disposed = false;
  #explicitlyDisposed = false;
  #initialTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The parts of the checkpoint being read, each checked as it came (D163).
   * Only one read's: parts of a later sequence drop them.
   */
  #parts: {
    readonly sequence: number;
    readonly list: HtmlMirrorCheckpointPart[];
    readonly indexes: Set<number>;
    bytes: number;
  } | undefined;
  /** The sequence of the last checkpoint handed on; parts of before are stale. */
  #checkpointSequence: number | undefined;
  /** A preview was handed on and its full copy has not come yet (D163). */
  #copyPending = false;

  constructor(
    private readonly port: Browser.runtime.Port,
    private readonly identity: ReturnType<typeof createReplicaIdentity>,
    private readonly request: ReplicaCaptureRequest,
    private readonly fidelityPolicy: SelectableReplicaFidelityPolicy,
    limits: HtmlMirrorLimitSettings,
    showEverything: boolean,
    private readonly signal?: AbortSignal,
  ) {
    const initial = Promise.withResolvers<HtmlMirrorCheckpoint>();
    this.initialCheckpoint = initial.promise;
    this.#resolveInitial = initial.resolve;
    this.#rejectInitial = initial.reject;
    port.onMessage.addListener(this.#onMessage);
    port.onDisconnect.addListener(this.#onDisconnect);
    signal?.addEventListener('abort', this.#onAbort, { once: true });
    this.#armTimer();
    try {
      port.postMessage(createHtmlMirrorStart(
        identity,
        fidelityPolicy,
        limits,
        showEverything,
      ));
    } catch (error) {
      this.#fail(error);
    }
  }

  setObserver(observer: HtmlMirrorStreamObserver): void {
    if (this.#explicitlyDisposed || this.#observer) return;
    this.#observer = observer;
    for (const message of this.#queue.splice(0)) {
      try {
        if (message.kind === 'failure') {
          observer.onFailure(message.code, message.representability);
        } else if (message.kind === 'simul:html-mirror-v2:checkpoint') {
          observer.onCheckpoint(message);
        } else if (message.kind === 'simul:html-mirror-v2:scroll') {
          observer.onScroll(message);
        } else {
          observer.onPatch(message);
        }
      } catch {
        if (message.kind === 'failure') this.#closeTransport(true);
        else this.#fail(new Error('Queued HTML mirror observer failed.'));
        return;
      }
    }
  }

  acknowledge(sequence: number): void {
    if (this.#disposed || !Number.isSafeInteger(sequence) || sequence < 0) return;
    try {
      this.port.postMessage(createHtmlMirrorAck(this.identity, sequence));
    } catch (error) {
      this.#fail(error);
    }
  }

  requestCheckpoint(sequence: number): void {
    if (this.#disposed || !Number.isSafeInteger(sequence) || sequence < 0) return;
    try {
      this.port.postMessage(
        createHtmlMirrorCheckpointRequest(this.identity, sequence),
      );
    } catch (error) {
      this.#fail(error);
    }
  }

  dispose(): void {
    if (this.#explicitlyDisposed) return;
    this.#explicitlyDisposed = true;
    this.#queue.splice(0);
    this.#parts = undefined;
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearInitialTimer();
    this.port.onMessage.removeListener(this.#onMessage);
    this.port.onDisconnect.removeListener(this.#onDisconnect);
    this.signal?.removeEventListener('abort', this.#onAbort);
    if (!this.#initialSettled) {
      this.#initialSettled = true;
      this.#rejectInitial(new DOMException('HTML mirror closed.', 'AbortError'));
    }
    try {
      this.port.disconnect();
    } catch {
      // Navigation may already have disconnected the exact-document Port.
    }
  }

  readonly #onMessage = (input: unknown): void => {
    if (this.#disposed || !this.request.isCurrent()) {
      this.dispose();
      return;
    }
    const received = readHtmlMirrorSourceMessage(
      decodeHtmlMirrorWireMessage(input),
      this.identity,
      this.fidelityPolicy,
    );
    if (!received) {
      this.#fail(new Error('Invalid HTML mirror source message.'));
      return;
    }
    // The page names the panes that moved; every scroll update handed on
    // carries the whole list, so a later one can stand alone.
    let message = received.kind === 'simul:html-mirror-v2:scroll'
      ? this.#panes.complete(received)
      : received;
    if (message.kind === 'simul:html-mirror-v2:error') {
      if (!this.#initialSettled) {
        this.#initialSettled = true;
        this.#clearInitialTimer();
        this.#rejectInitial(new HtmlMirrorClientError(
          message.code,
          message.representability,
        ));
        this.#closeTransport(true);
      } else {
        this.#deliverOrQueueFailure(message.code, message.representability);
      }
      return;
    }
    if (message.kind === 'simul:html-mirror-v2:checkpoint-part') {
      if (!this.#bufferPart(message)) {
        this.#fail(new Error('Invalid HTML mirror checkpoint part.'));
        return;
      }
      // The page is reading: whatever waits for its checkpoint waits on.
      if (!this.#initialSettled || this.#copyPending) this.#armTimer();
      if (this.#initialSettled) {
        try {
          this.#observer?.onProgress?.();
        } catch {
          this.#fail(new Error('HTML mirror observer failed.'));
        }
      }
      return;
    }
    if (message.kind === 'simul:html-mirror-v2:checkpoint') {
      const whole = this.#takeCheckpoint(message);
      if (!whole) {
        this.#fail(new Error('Invalid HTML mirror checkpoint parts.'));
        return;
      }
      message = whole;
    }
    if (!this.#initialSettled) {
      if (message.kind === 'simul:html-mirror-v2:scroll') {
        this.#queueLatestScroll(message);
        return;
      }
      if (message.kind !== 'simul:html-mirror-v2:checkpoint') {
        this.#fail(new Error('HTML mirror patch arrived before checkpoint.'));
        return;
      }
      this.#initialSettled = true;
      this.#clearInitialTimer();
      // A preview is shown at once; its full copy is waited for as the
      // first checkpoint was (D163).
      if (this.#copyPending) this.#armTimer();
      this.#resolveInitial(message);
      return;
    }
    if (this.#observer) {
      try {
        if (message.kind === 'simul:html-mirror-v2:checkpoint') {
          this.#observer.onCheckpoint(message);
        } else if (message.kind === 'simul:html-mirror-v2:scroll') {
          this.#observer.onScroll(message);
        } else {
          this.#observer.onPatch(message);
        }
      } catch {
        this.#fail(new Error('HTML mirror observer failed.'));
      }
    } else {
      if (message.kind === 'simul:html-mirror-v2:scroll') {
        this.#queueLatestScroll(message);
      } else if (
        this.#queuedStructuralMessageCount() >=
          MAX_HTML_MIRROR_PREOBSERVER_MESSAGES
      ) {
        this.#deliverOrQueueFailure(
          'stream_failed',
          emptyRepresentability(),
          true,
        );
      } else {
        this.#queue.push(message);
      }
    }
  };

  readonly #onDisconnect = (): void => {
    this.#fail(new Error('HTML mirror source disconnected.'), false);
  };

  readonly #onAbort = (): void => this.dispose();

  #fail(error: unknown, disconnect = true): void {
    if (this.#disposed) return;
    if (!this.#initialSettled) {
      this.#initialSettled = true;
      this.#clearInitialTimer();
      this.#rejectInitial(error);
    } else {
      this.#deliverOrQueueFailure(
        'stream_failed',
        emptyRepresentability(),
        true,
      );
      return;
    }
    this.#closeTransport(disconnect);
  }

  #deliverOrQueueFailure(
    code: Extract<
      ReplicaDiagnosticCode,
      'stream_gap' | 'stream_overflow' | 'stream_failed' | 'privacy_rejected'
    >,
    representability: HtmlMirrorRepresentabilitySummary = emptyRepresentability(),
    terminal = code === 'stream_failed',
  ): void {
    if (this.#observer) {
      try {
        this.#observer.onFailure(code, representability);
      } catch {
        terminal = true;
      }
    } else {
      if (
        this.#queuedStructuralMessageCount() >=
          MAX_HTML_MIRROR_PREOBSERVER_MESSAGES
      ) {
        this.#queue.splice(0);
        this.#queue.push({
          kind: 'failure',
          code: 'stream_failed',
          representability: emptyRepresentability(),
        });
        terminal = true;
      } else {
        this.#queue.push({ kind: 'failure', code, representability });
      }
    }
    if (terminal) this.#closeTransport(true);
  }

  /**
   * Keeps a part, checked on its own, for the checkpoint that closes its
   * read (D163). A part of a later sequence starts a new read and drops the
   * parts of the one before (cancelled or restarted on the page). A part of
   * a sequence before the parts kept or the last checkpoint, a second part
   * of an index, or parts over the page's node or byte limits are refused.
   */
  #bufferPart(part: HtmlMirrorCheckpointPart): boolean {
    const sequence = part.identity.sequence;
    if (
      (this.#checkpointSequence !== undefined &&
        sequence < this.#checkpointSequence) ||
      (this.#parts !== undefined && sequence < this.#parts.sequence)
    ) return false;
    if (!this.#parts || sequence > this.#parts.sequence) {
      this.#parts = { sequence, list: [], indexes: new Set(), bytes: 0 };
    }
    const parts = this.#parts;
    parts.bytes += part.byteLength;
    if (
      parts.indexes.has(part.index) ||
      parts.list.length >= MAX_HTML_MIRROR_NODES ||
      parts.bytes > MAX_HTML_MIRROR_BYTES
    ) {
      this.#parts = undefined;
      return false;
    }
    parts.indexes.add(part.index);
    parts.list.push(part);
    return true;
  }

  /**
   * The checkpoint to hand on (D163): one sent whole as it is, one that
   * closes parts assembled from them, each shell filled once and the whole
   * checked again as one graph. Only the stream's first checkpoint may be a
   * preview. Undefined when the parts do not make the checkpoint.
   */
  #takeCheckpoint(
    checkpoint: HtmlMirrorCheckpoint,
  ): HtmlMirrorCheckpoint | undefined {
    const sequence = checkpoint.identity.sequence;
    const partCount = checkpoint.payload.partCount ?? 0;
    const parts = this.#parts;
    this.#parts = undefined;
    if (checkpoint.payload.preview && this.#checkpointSequence !== undefined) {
      return undefined;
    }
    let whole: HtmlMirrorCheckpoint | undefined = checkpoint;
    if (partCount === 0) {
      // Parts of an older read are dropped; a newer one's cannot come first.
      if (parts && parts.sequence > sequence) return undefined;
    } else {
      whole = parts?.sequence === sequence &&
          parts.list.length === partCount &&
          parts.bytes + checkpoint.payload.byteLength <= MAX_HTML_MIRROR_BYTES
        ? assembleHtmlMirrorCheckpoint(checkpoint, parts.list, this.fidelityPolicy)
        : undefined;
    }
    if (!whole) return undefined;
    this.#checkpointSequence = sequence;
    if (whole.payload.preview) {
      this.#copyPending = true;
    } else if (this.#copyPending) {
      this.#copyPending = false;
      this.#clearInitialTimer();
    }
    return whole;
  }

  #armTimer(): void {
    this.#clearInitialTimer();
    this.#initialTimer = setTimeout(() => {
      this.#fail(new Error(this.#initialSettled
        ? 'HTML mirror full copy timed out.'
        : 'HTML mirror initial checkpoint timed out.'));
    }, HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS);
  }

  #queueLatestScroll(message: HtmlMirrorScrollUpdate): void {
    const previousIndex = this.#queue.findIndex(
      ({ kind }) => kind === 'simul:html-mirror-v2:scroll',
    );
    if (previousIndex >= 0) this.#queue.splice(previousIndex, 1);
    // Appending after removal preserves the latest scroll's ordering relative
    // to any checkpoint, patch, or failure that arrived since the old update.
    this.#queue.push(message);
  }

  #queuedStructuralMessageCount(): number {
    return this.#queue.reduce(
      (count, { kind }) =>
        count + (kind === 'simul:html-mirror-v2:scroll' ? 0 : 1),
      0,
    );
  }

  #closeTransport(disconnect: boolean): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#parts = undefined;
    this.#clearInitialTimer();
    this.port.onMessage.removeListener(this.#onMessage);
    this.port.onDisconnect.removeListener(this.#onDisconnect);
    this.signal?.removeEventListener('abort', this.#onAbort);
    if (disconnect) {
      try {
        this.port.disconnect();
      } catch {
        // Idempotent teardown.
      }
    }
  }

  #clearInitialTimer(): void {
    if (this.#initialTimer === undefined) return;
    clearTimeout(this.#initialTimer);
    this.#initialTimer = undefined;
  }
}

export class HtmlMirrorClientError extends Error {
  constructor(
    readonly code: ReplicaDiagnosticCode,
    readonly representability: HtmlMirrorRepresentabilitySummary =
      emptyRepresentability(),
  ) {
    super(code);
    this.name = 'HtmlMirrorClientError';
  }
}

function emptyRepresentability(): HtmlMirrorRepresentabilitySummary {
  return snapshotHtmlMirrorRepresentability(
    createHtmlMirrorRepresentabilityCollector(),
  );
}
