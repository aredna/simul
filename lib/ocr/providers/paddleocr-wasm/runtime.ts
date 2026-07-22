import {
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
  type TimeoutCanceller,
  type TimeoutScheduler,
} from '../../../browser-scheduling';
import type { ImageTextResult } from '../../contracts';
import type { OffscreenOcrProviderRunner } from '../../offscreen-host';
import type { OffscreenOcrJob } from '../../offscreen-protocol';
import {
  readPaddleSandboxReadyMessage,
  readPaddleSandboxResponse,
  type PaddleSandboxAssetUrls,
  type PaddleSandboxErrorCode,
} from './sandbox-protocol';

export const PADDLE_OCR_IDLE_TIMEOUT_MS = 90_000;
export const PADDLE_OCR_JOB_TIMEOUT_MS = 30_000;
export const PADDLE_OCR_SANDBOX_STARTUP_TIMEOUT_MS = 8_000;
export const PADDLE_OCR_RUNTIME_MARKER =
  'simul-paddleocr-js-0.4.2-offscreen-v2-sandbox';

export interface PaddleSandboxClient {
  recognize(
    input: Blob,
    bitmapWidth: number,
    bitmapHeight: number,
  ): Promise<ImageTextResult>;
  terminate(): void;
  dispose(): Promise<void>;
}

export interface PaddleSandboxClientCreateOptions {
  readonly sandboxUrl: string;
  readonly assets: PaddleSandboxAssetUrls;
  readonly startupTimeoutMs: number;
  readonly setTimer: TimeoutScheduler;
  readonly clearTimer: TimeoutCanceller;
}

export interface PaddleOcrRunnerEnvironment {
  readonly createClient?: (
    options: PaddleSandboxClientCreateOptions,
  ) => Promise<PaddleSandboxClient>;
  readonly getUrl?: (path: string) => string;
  readonly setTimer?: TimeoutScheduler;
  readonly clearTimer?: TimeoutCanceller;
  readonly jobTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

/** Privileged offscreen adapter; Paddle execution stays inside the sandbox. */
export class PaddleOcrOffscreenRunner implements OffscreenOcrProviderRunner {
  readonly #createClient: NonNullable<PaddleOcrRunnerEnvironment['createClient']>;
  readonly #getUrl: (path: string) => string;
  readonly #setTimer: TimeoutScheduler;
  readonly #clearTimer: TimeoutCanceller;
  readonly #jobTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  #client: PaddleSandboxClient | undefined;
  #creating: Promise<PaddleSandboxClient> | undefined;
  #token: symbol | undefined;
  #terminalFailureName: TerminalPaddleFailureName | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(environment: PaddleOcrRunnerEnvironment = {}) {
    this.#createClient = environment.createClient ?? createPaddleSandboxClient;
    this.#getUrl = environment.getUrl ?? ((path) =>
      (browser.runtime.getURL as (value: string) => string)(path));
    this.#setTimer = receiverSafeTimeoutScheduler(environment.setTimer);
    this.#clearTimer = receiverSafeTimeoutCanceller(environment.clearTimer);
    this.#jobTimeoutMs = positiveTimeout(
      environment.jobTimeoutMs,
      PADDLE_OCR_JOB_TIMEOUT_MS,
    );
    this.#idleTimeoutMs = positiveTimeout(
      environment.idleTimeoutMs,
      PADDLE_OCR_IDLE_TIMEOUT_MS,
    );
    this.#startupTimeoutMs = positiveTimeout(
      environment.startupTimeoutMs,
      PADDLE_OCR_SANDBOX_STARTUP_TIMEOUT_MS,
    );
  }

  async recognize(
    job: OffscreenOcrJob,
    encoded: Blob,
    signal: AbortSignal,
  ): Promise<ImageTextResult> {
    if (this.#disposed || job.providerId !== 'paddleocr-wasm') {
      throw new ProviderUnavailableError();
    }
    if (!PADDLE_SUPPORTED_LANGUAGES.has(job.languageGroup)) {
      throw new UnsupportedLanguageError();
    }
    if (this.#terminalFailureName) {
      throw terminalFailure(this.#terminalFailureName);
    }
    signal.throwIfAborted();
    this.#cancelIdleTimer();
    try {
      const completed = await withDeadline(
        (async () => {
          const client = await this.#clientFor();
          const result = await client.recognize(
            encoded,
            job.bitmapWidth,
            job.bitmapHeight,
          );
          return { client, result };
        })(),
        this.#jobTimeoutMs,
        signal,
        this.#setTimer,
        this.#clearTimer,
      );
      const { client, result } = completed;
      if (
        result.providerId !== 'paddleocr-wasm' ||
        result.bitmapWidth !== job.bitmapWidth ||
        result.bitmapHeight !== job.bitmapHeight
      ) throw new InvalidNormalizedOcrOutputError();
      if (!this.#disposed && this.#client === client) this.#scheduleIdleDisposal();
      return result;
    } catch (error) {
      this.#terminateClient();
      if (signal.aborted) throw error;
      if (isTerminalFailure(error)) {
        if (!(error instanceof PaddleSandboxUnavailableError)) {
          this.#terminalFailureName = error.name;
        }
        throw error;
      }
      if (
        error instanceof ProviderUnavailableError ||
        error instanceof UnsupportedLanguageError ||
        error instanceof InvalidNormalizedOcrOutputError ||
        error instanceof WorkerLostError ||
        error instanceof PaddleRecognitionError
      ) throw error;
      throw new PaddleRecognitionError();
    }
  }

  cancelActive(): Promise<void> {
    this.#terminateClient();
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#terminateClient();
    return Promise.resolve();
  }

  async #clientFor(): Promise<PaddleSandboxClient> {
    if (this.#client) return this.#client;
    if (!this.#creating) {
      const token = Symbol('paddle-sandbox');
      this.#token = token;
      const creation = this.#createClient({
        sandboxUrl: this.#getUrl('/paddle-ocr.html'),
        assets: Object.freeze({
          runtimeModule: this.#getUrl(
            '/ocr/paddle/worker/worker-entry.js',
          ),
          detectionModel: this.#getUrl(
            '/ocr/paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar',
          ),
          recognitionModel: this.#getUrl(
            '/ocr/paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
          ),
          runtimeLoader: this.#getUrl(
            '/ocr/paddle/runtime/ort-wasm-simd-threaded.mjs',
          ),
          runtimeWasm: this.#getUrl(
            '/ocr/paddle/runtime/ort-wasm-simd-threaded.wasm',
          ),
        }),
        startupTimeoutMs: this.#startupTimeoutMs,
        setTimer: this.#setTimer,
        clearTimer: this.#clearTimer,
      });
      this.#creating = creation;
      void creation.finally(() => {
        if (this.#creating === creation) this.#creating = undefined;
      }).catch(() => undefined);
    }
    const creation = this.#creating;
    const token = this.#token;
    if (!creation || !token) throw new WorkerLostError();
    const client = await creation;
    if (this.#disposed || this.#token !== token) {
      client.terminate();
      void client.dispose().catch(() => undefined);
      throw new WorkerLostError();
    }
    this.#client = client;
    return client;
  }

  #terminateClient(): void {
    this.#cancelIdleTimer();
    const client = this.#client;
    this.#client = undefined;
    this.#creating = undefined;
    this.#token = undefined;
    client?.terminate();
    if (client) void client.dispose().catch(() => undefined);
  }

  #scheduleIdleDisposal(): void {
    this.#cancelIdleTimer();
    this.#idleTimer = this.#setTimer(() => {
      this.#idleTimer = undefined;
      this.#terminateClient();
    }, this.#idleTimeoutMs);
  }

  #cancelIdleTimer(): void {
    if (this.#idleTimer !== undefined) this.#clearTimer(this.#idleTimer);
    this.#idleTimer = undefined;
  }
}

class PaddleSandboxFrameClient implements PaddleSandboxClient {
  readonly #pending = new Map<number, {
    readonly resolve: (result: ImageTextResult) => void;
    readonly reject: (error: unknown) => void;
  }>();
  #nextRequestId = 1;
  #disposed = false;

  private constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly assets: PaddleSandboxAssetUrls,
    private readonly hostWindow: Window,
  ) {
    hostWindow.addEventListener('message', this.#onMessage);
  }

  static create(
    options: PaddleSandboxClientCreateOptions,
  ): Promise<PaddleSandboxFrameClient> {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return Promise.reject(new PaddleSandboxUnavailableError());
    }
    const parent = document.body;
    if (!parent) return Promise.reject(new PaddleSandboxUnavailableError());
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = options.sandboxUrl;
    const client = new PaddleSandboxFrameClient(frame, options.assets, window);
    return new Promise<PaddleSandboxFrameClient>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        options.clearTimer(timer);
        frame.removeEventListener('error', onError);
        window.removeEventListener('message', onReady);
        callback();
      };
      const onError = (): void => finish(() => {
        client.terminate();
        reject(new PaddleSandboxUnavailableError());
      });
      const onReady = (event: MessageEvent<unknown>): void => {
        if (
          event.source !== frame.contentWindow ||
          !readPaddleSandboxReadyMessage(event.data)
        ) return;
        finish(() => resolve(client));
      };
      const timer = options.setTimer(() => finish(() => {
        client.terminate();
        reject(new PaddleSandboxUnavailableError());
      }), options.startupTimeoutMs);
      frame.addEventListener('error', onError, { once: true });
      window.addEventListener('message', onReady);
      parent.append(frame);
    });
  }

  recognize(
    input: Blob,
    bitmapWidth: number,
    bitmapHeight: number,
  ): Promise<ImageTextResult> {
    if (this.#disposed) return Promise.reject(new WorkerLostError());
    const target = this.frame.contentWindow;
    if (!target) return Promise.reject(new PaddleSandboxUnavailableError());
    const requestId = this.#nextRequestId;
    this.#nextRequestId = requestId >= Number.MAX_SAFE_INTEGER
      ? 1
      : requestId + 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      try {
        target.postMessage({
          kind: 'simul:paddle-sandbox-v1:run',
          version: 1,
          requestId,
          input,
          bitmapWidth,
          bitmapHeight,
          assets: this.assets,
        }, '*');
      } catch (error) {
        this.#pending.delete(requestId);
        reject(new PaddleSandboxUnavailableError({ cause: error }));
      }
    });
  }

  terminate(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.frame.contentWindow?.postMessage({
        kind: 'simul:paddle-sandbox-v1:dispose',
        version: 1,
      }, '*');
    } catch {
      // Removing the frame below remains authoritative.
    }
    this.hostWindow.removeEventListener('message', this.#onMessage);
    this.frame.remove();
    this.#fail(new WorkerLostError());
  }

  dispose(): Promise<void> {
    this.terminate();
    return Promise.resolve();
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== this.frame.contentWindow) return;
    const response = readPaddleSandboxResponse(event.data);
    if (!response) return;
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    this.#pending.delete(response.requestId);
    if (response.kind === 'simul:paddle-sandbox-v1:result') {
      pending.resolve(response.result);
    } else {
      pending.reject(sandboxFailure(response.code));
    }
  };

  #fail(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export function createPaddleSandboxClient(
  options: PaddleSandboxClientCreateOptions,
): Promise<PaddleSandboxClient> {
  return PaddleSandboxFrameClient.create(options);
}

function sandboxFailure(code: PaddleSandboxErrorCode): Error {
  if (code === 'runtime-loader-failed') return new PaddleRuntimeLoaderError();
  if (code === 'runtime-startup-failed') return new PaddleRuntimeStartupError();
  if (code === 'worker-lost') return new WorkerLostError();
  if (code === 'invalid-result') return new InvalidNormalizedOcrOutputError();
  return new PaddleRecognitionError();
}

function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  signal: AbortSignal,
  setTimer: TimeoutScheduler,
  clearTimer: TimeoutCanceller,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(
      new DOMException('PaddleOCR.js recognition cancelled.', 'AbortError'),
    ));
    const timer = setTimer(
      () => finish(() => reject(new PaddleRecognitionError())),
      milliseconds,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.min(Number(value), 10 * 60_000)
    : fallback;
}

type TerminalPaddleFailureName =
  | 'PaddleSandboxUnavailableError'
  | 'PaddleRuntimeLoaderError'
  | 'PaddleRuntimeStartupError';

function isTerminalFailure(error: unknown): error is Error & {
  readonly name: TerminalPaddleFailureName;
} {
  return error instanceof PaddleSandboxUnavailableError ||
    error instanceof PaddleRuntimeLoaderError ||
    error instanceof PaddleRuntimeStartupError;
}

function terminalFailure(name: TerminalPaddleFailureName): Error {
  if (name === 'PaddleSandboxUnavailableError') {
    return new PaddleSandboxUnavailableError();
  }
  if (name === 'PaddleRuntimeLoaderError') return new PaddleRuntimeLoaderError();
  return new PaddleRuntimeStartupError();
}

const PADDLE_SUPPORTED_LANGUAGES = new Set([
  'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'hr', 'hu', 'id', 'it', 'lt',
  'nl', 'no', 'pl', 'pt', 'ro', 'sk', 'sl', 'sv', 'tr', 'vi', 'zh',
  'zh-Hant',
]);

export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';

  constructor() {
    super(`${PADDLE_OCR_RUNTIME_MARKER} is unavailable.`);
  }
}

export class UnsupportedLanguageError extends Error {
  override readonly name = 'UnsupportedLanguageError';
}

export class PaddleSandboxUnavailableError extends Error {
  override readonly name = 'PaddleSandboxUnavailableError';

  constructor(options?: ErrorOptions) {
    super('The local Paddle sandbox could not start.', options);
  }
}

export class PaddleRuntimeLoaderError extends Error {
  override readonly name = 'PaddleRuntimeLoaderError';

  constructor() {
    super('The pinned Paddle runtime loader could not start.');
  }
}

export class PaddleRuntimeStartupError extends Error {
  override readonly name = 'PaddleRuntimeStartupError';

  constructor() {
    super('The Paddle runtime could not initialize.');
  }
}

export class PaddleRecognitionError extends Error {
  override readonly name = 'PaddleRecognitionError';
}

export class WorkerLostError extends Error {
  override readonly name = 'WorkerLostError';
}

export class InvalidNormalizedOcrOutputError extends Error {
  override readonly name = 'InvalidNormalizedOcrOutputError';
}
