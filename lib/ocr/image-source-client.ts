import type { ReplicaCaptureRequest } from '../replica/contracts';
import { sourceDocumentIdentity } from '../replica/source-identity';
import { createReplicaIdentity } from '../replica/protocol-v2';
import type { SourceImageChange, SourceImageDescriptor } from './contracts';
import {
  createImageSourcePortName,
  readImageSourceRecorderMessage,
  type SourceImageCaptureMetrics,
} from './image-source-protocol';

export const IMAGE_SOURCE_MEASURE_TIMEOUT_MS = 1_500;
const MAX_PENDING_MEASUREMENTS = 16;

export class ImageSourceUnavailableError extends Error {
  override readonly name = 'ImageSourceUnavailableError';
}

export function isImageSourceUnavailableError(
  error: unknown,
): error is ImageSourceUnavailableError {
  return error instanceof Error && error.name === 'ImageSourceUnavailableError';
}

export interface ImageSourceLease {
  /** Resolves only when the exact-document messaging channel fails unexpectedly. */
  readonly unavailable?: Promise<ImageSourceUnavailableError>;
  measure(
    descriptor: SourceImageDescriptor,
    signal?: AbortSignal,
  ): Promise<SourceImageCaptureMetrics | undefined>;
  dispose(): void;
}

export async function openChromeImageSource(
  request: ReplicaCaptureRequest,
  onChange: (change: SourceImageChange) => void,
  signal?: AbortSignal,
): Promise<ImageSourceLease> {
  signal?.throwIfAborted();
  if (!request.isCurrent()) throw new DOMException('Stale image source.', 'AbortError');
  const identity = createReplicaIdentity({
    sessionId: request.sessionId,
    pageEpoch: request.pageEpoch,
    generation: request.generation,
    documentId: request.documentId,
    frameId: request.frameId,
    sequence: 0,
  });
  const document = sourceDocumentIdentity(identity);
  let port: Browser.runtime.Port;
  try {
    port = browser.tabs.connect(request.tabId, {
      documentId: request.documentId,
      frameId: request.frameId,
      name: createImageSourcePortName(request.sessionId),
    });
  } catch (error) {
    throw new ImageSourceUnavailableError(readableError(error));
  }
  return new ChromeImageSourceLease(port, document, request, onChange, signal);
}

class ChromeImageSourceLease implements ImageSourceLease {
  readonly unavailable: Promise<ImageSourceUnavailableError>;
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (value: SourceImageCaptureMetrics | undefined) => void;
      readonly reject: (reason: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
      readonly signal?: AbortSignal;
      readonly onAbort: () => void;
    }
  >();
  readonly #resolveUnavailable: (error: ImageSourceUnavailableError) => void;
  #disposed = false;
  #unavailableSignalled = false;

  constructor(
    private readonly port: Browser.runtime.Port,
    private readonly document: ReturnType<typeof sourceDocumentIdentity>,
    private readonly request: ReplicaCaptureRequest,
    private readonly onChange: (change: SourceImageChange) => void,
    private readonly signal?: AbortSignal,
  ) {
    let resolveUnavailable!: (error: ImageSourceUnavailableError) => void;
    this.unavailable = new Promise((resolve) => {
      resolveUnavailable = resolve;
    });
    this.#resolveUnavailable = resolveUnavailable;
    port.onMessage.addListener(this.#onMessage);
    port.onDisconnect.addListener(this.#onDisconnect);
    signal?.addEventListener('abort', this.#onAbort, { once: true });
    try {
      port.postMessage({ kind: 'simul:image-source-v1:start', document });
    } catch (error) {
      this.disposeWithError(
        new ImageSourceUnavailableError(readableError(error)),
      );
    }
  }

  measure(
    descriptor: SourceImageDescriptor,
    signal?: AbortSignal,
  ): Promise<SourceImageCaptureMetrics | undefined> {
    if (
      this.#disposed ||
      this.#pending.size >= MAX_PENDING_MEASUREMENTS ||
      !this.request.isCurrent()
    ) return Promise.reject(new ImageSourceUnavailableError('Image source is unavailable.'));
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    return new Promise<SourceImageCaptureMetrics | undefined>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        clearTimeout(pending.timer);
        reject(new DOMException('Image measurement cancelled.', 'AbortError'));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        signal?.removeEventListener('abort', onAbort);
        resolve(undefined);
      }, IMAGE_SOURCE_MEASURE_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, reject, timer, signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.port.postMessage({
          kind: 'simul:image-source-v1:measure',
          requestId,
          descriptor,
        });
      } catch (error) {
        this.disposeWithError(
          new ImageSourceUnavailableError(readableError(error)),
        );
      }
    });
  }

  dispose(): void {
    this.disposeWithError(new DOMException('Image source closed.', 'AbortError'));
  }

  readonly #onMessage = (input: unknown): void => {
    if (this.#disposed || !this.request.isCurrent()) {
      this.dispose();
      return;
    }
    const message = readImageSourceRecorderMessage(input, this.document);
    if (!message) {
      this.disposeWithError(
        new ImageSourceUnavailableError('Invalid image source message.'),
      );
      return;
    }
    if (message.kind === 'simul:image-source-v1:change') {
      try {
        this.onChange(message.change);
      } catch {
        // Derived image work cannot unwind source observation.
      }
      return;
    }
    this.#settlePending(
      message.requestId,
      message.status === 'ready' ? message.metrics : undefined,
    );
  };

  readonly #onDisconnect = (): void => {
    this.disposeWithError(
      new ImageSourceUnavailableError('Image source disconnected.'),
      false,
    );
  };

  readonly #onAbort = (): void => this.dispose();

  #settlePending(
    requestId: string,
    value: SourceImageCaptureMetrics | undefined,
    error?: unknown,
  ): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private disposeWithError(error: unknown, disconnect = true): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.port.onMessage.removeListener(this.#onMessage);
    this.port.onDisconnect.removeListener(this.#onDisconnect);
    this.signal?.removeEventListener('abort', this.#onAbort);
    for (const requestId of [...this.#pending.keys()]) {
      this.#settlePending(requestId, undefined, error);
    }
    if (
      isImageSourceUnavailableError(error) &&
      !this.#unavailableSignalled
    ) {
      this.#unavailableSignalled = true;
      this.#resolveUnavailable(error);
    }
    if (disconnect) {
      try {
        this.port.disconnect();
      } catch {
        // Disconnect is idempotent across navigation teardown.
      }
    }
  }
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Image source messaging failed.';
}
