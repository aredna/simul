import type { ReplicaCaptureRequest, ReplicaDiagnosticCode } from './contracts';
import {
  createHtmlMirrorAck,
  createHtmlMirrorCheckpointRequest,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  readHtmlMirrorSourceMessage,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPatchBatch,
} from './html-mirror-protocol';
import {
  createHtmlMirrorRepresentabilityCollector,
  snapshotHtmlMirrorRepresentability,
  type HtmlMirrorRepresentabilitySummary,
} from './html-mirror-sanitizer';
import { createReplicaIdentity } from './protocol-v2';
import type { SelectableReplicaFidelityPolicy } from './fidelity-policy';

export interface HtmlMirrorStreamObserver {
  onPatch(batch: HtmlMirrorPatchBatch): void;
  onCheckpoint(checkpoint: HtmlMirrorCheckpoint): void;
  onFailure(code: Extract<
    ReplicaDiagnosticCode,
    'stream_gap' | 'stream_overflow' | 'stream_failed' | 'privacy_rejected'
  >, representability?: HtmlMirrorRepresentabilitySummary): void;
}

export interface HtmlMirrorStreamLease {
  readonly initialCheckpoint: Promise<HtmlMirrorCheckpoint>;
  setObserver(observer: HtmlMirrorStreamObserver): void;
  acknowledge(sequence: number): void;
  requestCheckpoint(sequence: number): void;
  dispose(): void;
}

export const HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS = 5_000;
export const MAX_HTML_MIRROR_PREOBSERVER_MESSAGES = 8;

type QueuedHtmlMirrorMessage =
  | HtmlMirrorCheckpoint
  | HtmlMirrorPatchBatch
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
) => Promise<HtmlMirrorStreamLease>;

export async function openChromeHtmlMirrorStream(
  request: ReplicaCaptureRequest,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  signal?: AbortSignal,
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
    signal,
  );
}

class ChromeHtmlMirrorStreamLease implements HtmlMirrorStreamLease {
  readonly initialCheckpoint: Promise<HtmlMirrorCheckpoint>;
  readonly #resolveInitial: (checkpoint: HtmlMirrorCheckpoint) => void;
  readonly #rejectInitial: (error: unknown) => void;
  readonly #queue: QueuedHtmlMirrorMessage[] = [];
  #observer: HtmlMirrorStreamObserver | undefined;
  #initialSettled = false;
  #disposed = false;
  #explicitlyDisposed = false;
  #initialTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly port: Browser.runtime.Port,
    private readonly identity: ReturnType<typeof createReplicaIdentity>,
    private readonly request: ReplicaCaptureRequest,
    private readonly fidelityPolicy: SelectableReplicaFidelityPolicy,
    private readonly signal?: AbortSignal,
  ) {
    let resolveInitial!: (checkpoint: HtmlMirrorCheckpoint) => void;
    let rejectInitial!: (error: unknown) => void;
    this.initialCheckpoint = new Promise((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    this.#resolveInitial = resolveInitial;
    this.#rejectInitial = rejectInitial;
    port.onMessage.addListener(this.#onMessage);
    port.onDisconnect.addListener(this.#onDisconnect);
    signal?.addEventListener('abort', this.#onAbort, { once: true });
    this.#initialTimer = setTimeout(() => {
      this.#fail(new Error('HTML mirror initial checkpoint timed out.'));
    }, HTML_MIRROR_INITIAL_CHECKPOINT_TIMEOUT_MS);
    try {
      port.postMessage(createHtmlMirrorStart(identity, fidelityPolicy));
    } catch (error) {
      this.#fail(error);
    }
  }

  setObserver(observer: HtmlMirrorStreamObserver): void {
    if (this.#explicitlyDisposed || this.#observer) return;
    this.#observer = observer;
    for (const message of this.#queue.splice(0)) {
      if (message.kind === 'failure') {
        observer.onFailure(message.code, message.representability);
      } else if (message.kind === 'simul:html-mirror-v1:checkpoint') {
        observer.onCheckpoint(message);
      } else {
        observer.onPatch(message);
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
    if (this.#disposed) return;
    this.#explicitlyDisposed = true;
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
    const message = readHtmlMirrorSourceMessage(
      input,
      this.identity,
      this.fidelityPolicy,
    );
    if (!message) {
      this.#fail(new Error('Invalid HTML mirror source message.'));
      return;
    }
    if (message.kind === 'simul:html-mirror-v1:error') {
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
    if (!this.#initialSettled) {
      if (message.kind !== 'simul:html-mirror-v1:checkpoint') {
        this.#fail(new Error('HTML mirror patch arrived before checkpoint.'));
        return;
      }
      this.#initialSettled = true;
      this.#clearInitialTimer();
      this.#resolveInitial(message);
      return;
    }
    if (this.#observer) {
      if (message.kind === 'simul:html-mirror-v1:checkpoint') {
        this.#observer.onCheckpoint(message);
      } else {
        this.#observer.onPatch(message);
      }
    } else {
      if (this.#queue.length >= MAX_HTML_MIRROR_PREOBSERVER_MESSAGES) {
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
      this.#observer.onFailure(code, representability);
    } else {
      if (this.#queue.length >= MAX_HTML_MIRROR_PREOBSERVER_MESSAGES) {
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

  #closeTransport(disconnect: boolean): void {
    if (this.#disposed) return;
    this.#disposed = true;
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
