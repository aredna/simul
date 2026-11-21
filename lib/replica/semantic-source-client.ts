import type { ReplicaCaptureRequest } from './contracts';
import { createReplicaIdentity } from './replica-identity';
import type { ReplicaReadScope } from './read-scope-policy';
import { replicaReadScopeFingerprint } from './read-scope-policy';
import {
  SEMANTIC_SOURCE_PROTOCOL_VERSION,
  SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION,
  createSemanticSourceAck,
  createSemanticSourcePortName,
  createSemanticSourceStart,
  readSemanticSourceBatch,
  type SemanticSourceBatch,
  type SemanticSourceBridgeId,
  type SemanticSourceProtocolVersion,
} from './semantic-source-protocol';
import { sourceDocumentIdentity } from './source-identity';

export interface SemanticSourceStreamObserver {
  /** Return true only after the complete batch is bound and applied. */
  onBatch(batch: SemanticSourceBatch): boolean;
  onFailure(): void;
}

export interface SemanticSourceStreamLease {
  setObserver(observer: SemanticSourceStreamObserver): void;
  dispose(): void;
}

export type SemanticSourceStreamFactory = (
  request: ReplicaCaptureRequest,
  bridge: SemanticSourceBridgeId,
  scope: ReplicaReadScope,
  signal?: AbortSignal,
) => Promise<SemanticSourceStreamLease>;

/**
 * Documents whose page let a start of version 3 go before any batch (D179):
 * a page script of a build before it refuses one. The next start there asks
 * for version 2, whole states only. Bounded; a document is a page load.
 */
const WHOLE_STATE_DOCUMENTS = new Set<string>();
const MAX_WHOLE_STATE_DOCUMENTS = 64;

function semanticSourceDocumentKey(request: ReplicaCaptureRequest): string {
  return `${request.tabId}:${request.frameId}:${request.documentId}`;
}

export async function openChromeSemanticSource(
  request: ReplicaCaptureRequest,
  bridge: SemanticSourceBridgeId,
  scope: ReplicaReadScope,
  signal?: AbortSignal,
): Promise<SemanticSourceStreamLease> {
  signal?.throwIfAborted();
  if (!request.isCurrent()) {
    throw new DOMException('Stale semantic source.', 'AbortError');
  }
  const identity = createReplicaIdentity({
    sessionId: request.sessionId,
    pageEpoch: request.pageEpoch,
    generation: request.generation,
    documentId: request.documentId,
    frameId: request.frameId,
    sequence: 0,
  });
  const document = sourceDocumentIdentity(identity);
  const port = browser.tabs.connect(request.tabId, {
    documentId: request.documentId,
    frameId: request.frameId,
    name: createSemanticSourcePortName(request.sessionId, bridge),
  });
  const documentKey = semanticSourceDocumentKey(request);
  return new ChromeSemanticSourceLease(
    port,
    document,
    request,
    bridge,
    scope,
    signal,
    WHOLE_STATE_DOCUMENTS.has(documentKey)
      ? SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION
      : SEMANTIC_SOURCE_PROTOCOL_VERSION,
    () => {
      if (WHOLE_STATE_DOCUMENTS.size >= MAX_WHOLE_STATE_DOCUMENTS) {
        WHOLE_STATE_DOCUMENTS.clear();
      }
      WHOLE_STATE_DOCUMENTS.add(documentKey);
    },
  );
}

class ChromeSemanticSourceLease implements SemanticSourceStreamLease {
  readonly #queue: SemanticSourceBatch[] = [];
  readonly #policyFingerprint: string;
  #observer: SemanticSourceStreamObserver | undefined;
  #lastAppliedSequence = 0;
  #disposed = false;
  #explicitlyDisposed = false;
  #failureDelivered = false;
  #terminalFailure = false;
  #receivedBatch = false;

  constructor(
    private readonly port: Browser.runtime.Port,
    private readonly document: ReturnType<typeof sourceDocumentIdentity>,
    private readonly request: ReplicaCaptureRequest,
    private readonly bridge: SemanticSourceBridgeId,
    private readonly scope: ReplicaReadScope,
    private readonly signal?: AbortSignal,
    private readonly protocolVersion: SemanticSourceProtocolVersion =
      SEMANTIC_SOURCE_PROTOCOL_VERSION,
    private readonly onStartRefused?: () => void,
  ) {
    this.#policyFingerprint = replicaReadScopeFingerprint(scope);
    port.onMessage.addListener(this.#onMessage);
    port.onDisconnect.addListener(this.#onDisconnect);
    signal?.addEventListener('abort', this.#onAbort, { once: true });
    try {
      port.postMessage(createSemanticSourceStart(
        bridge,
        document,
        scope,
        protocolVersion,
      ));
    } catch {
      this.#terminalFailure = true;
      this.#close(true);
    }
  }

  setObserver(observer: SemanticSourceStreamObserver): void {
    if (this.#observer) return;
    this.#observer = observer;
    if (this.#terminalFailure) {
      this.#deliverFailure();
      return;
    }
    if (this.#disposed) return;
    for (const batch of this.#queue.splice(0)) {
      if (!this.#apply(batch)) return;
    }
  }

  dispose(): void {
    if (this.#explicitlyDisposed) return;
    this.#explicitlyDisposed = true;
    this.#terminalFailure = false;
    this.#queue.length = 0;
    if (this.#disposed) return;
    this.#close(true);
  }

  readonly #onMessage = (input: unknown): void => {
    if (this.#disposed) return;
    if (!this.request.isCurrent()) {
      this.#close(true);
      return;
    }
    const batch = readSemanticSourceBatch(
      input,
      this.document,
      this.#policyFingerprint,
      this.bridge,
      this.scope,
    );
    // A panel that asked for whole states takes nothing else (D179).
    if (
      !batch || batch.sequence !== this.#lastAppliedSequence + 1 ||
      (batch.delta && this.protocolVersion !== SEMANTIC_SOURCE_PROTOCOL_VERSION)
    ) {
      this.#fail();
      return;
    }
    this.#receivedBatch = true;
    if (!this.#observer) {
      // The source is capacity-one until ACK, but retain a defensive bound.
      if (this.#queue.length >= 4) {
        this.#fail();
        return;
      }
      this.#queue.push(batch);
      return;
    }
    this.#apply(batch);
  };

  readonly #onDisconnect = (): void => {
    if (this.#disposed) return;
    // The page let the start go before any batch: a page script that knows
    // only version 2 does that to a start of version 3 (D179).
    if (
      !this.#receivedBatch && !this.#explicitlyDisposed &&
      this.protocolVersion === SEMANTIC_SOURCE_PROTOCOL_VERSION
    ) {
      try {
        this.onStartRefused?.();
      } catch {
        // The next start asks for version 3 again.
      }
    }
    this.#terminalFailure = !this.#explicitlyDisposed;
    this.#close(false);
    if (!this.#explicitlyDisposed) this.#deliverFailure();
  };

  readonly #onAbort = (): void => this.#close(true);

  #apply(batch: SemanticSourceBatch): boolean {
    if (this.#disposed || batch.sequence !== this.#lastAppliedSequence + 1) {
      this.#fail();
      return false;
    }
    let applied = false;
    try {
      applied = this.#observer?.onBatch(batch) === true;
    } catch {
      applied = false;
    }
    if (!applied) {
      this.#fail();
      return false;
    }
    this.#lastAppliedSequence = batch.sequence;
    try {
      this.port.postMessage(createSemanticSourceAck(
        this.document,
        this.#policyFingerprint,
        batch.sequence,
        this.protocolVersion,
      ));
      return true;
    } catch {
      this.#fail();
      return false;
    }
  }

  #fail(): void {
    if (this.#disposed) return;
    this.#terminalFailure = true;
    this.#close(true);
    this.#deliverFailure();
  }

  #deliverFailure(): void {
    if (this.#failureDelivered || !this.#observer) return;
    this.#failureDelivered = true;
    try {
      this.#observer?.onFailure();
    } catch {
      // Failure remains terminal even when derived cleanup reports badly.
    }
  }

  #close(disconnect: boolean): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue.length = 0;
    this.port.onMessage.removeListener(this.#onMessage);
    this.port.onDisconnect.removeListener(this.#onDisconnect);
    this.signal?.removeEventListener('abort', this.#onAbort);
    if (disconnect) {
      try {
        this.port.disconnect();
      } catch {
        // The source frame may have already disappeared.
      }
    }
  }
}
