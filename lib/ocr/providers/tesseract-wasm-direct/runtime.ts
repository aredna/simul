import {
  OCRClient,
  supportsFastBuild,
  type OCRClientInit,
  type TextItem,
} from 'tesseract-wasm';

import {
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
  type TimeoutCanceller,
  type TimeoutScheduler,
} from '../../../browser-scheduling';
import type { ImageTextResult } from '../../contracts';
import type { OffscreenOcrProviderRunner } from '../../offscreen-host';
import type { OffscreenOcrJob } from '../../offscreen-protocol';
import { isPackagedTesseractLanguageGroup } from '../tesseract/language-catalog';
import { normalizeDirectTesseractTextItems } from './normalize';

export const TESSERACT_WASM_DIRECT_VERSION = '0.11.0';
export const TESSERACT_WASM_DIRECT_RUNTIME_MARKER =
  'tesseract-wasm-0.11.0';
export const TESSERACT_WASM_DIRECT_IDLE_TIMEOUT_MS = 90_000;
export const TESSERACT_WASM_DIRECT_JOB_TIMEOUT_MS = 30_000;

interface DirectOcrClient {
  loadModel(model: string | ArrayBuffer): Promise<void>;
  loadImage(image: ImageBitmap | ImageData): Promise<void>;
  getTextBoxes(unit: 'line'): Promise<TextItem[]>;
  clearImage(): Promise<void>;
  destroy(): Promise<void>;
}

interface AcquiredDirectClient {
  readonly client: DirectOcrClient;
  readonly token: symbol;
}

export interface TesseractWasmDirectRunnerEnvironment {
  readonly createClient?: (init: OCRClientInit) => DirectOcrClient;
  readonly getUrl?: (path: string) => string;
  readonly loadArrayBuffer?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<ArrayBuffer>;
  readonly decompressGzip?: (
    input: ArrayBuffer,
    signal: AbortSignal,
  ) => Promise<ArrayBuffer>;
  readonly decodeImage?: (encoded: Blob) => Promise<ImageBitmap | ImageData>;
  readonly supportsFastBuild?: () => boolean;
  readonly setTimer?: TimeoutScheduler;
  readonly clearTimer?: TimeoutCanceller;
  readonly jobTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/**
 * Direct `tesseract-wasm` A/B runtime. It deliberately reuses Simul's pinned
 * tessdata catalog and remains in the same corroboration family as Tesseract.js.
 */
export class TesseractWasmDirectOffscreenRunner
  implements OffscreenOcrProviderRunner {
  readonly #createClient: (init: OCRClientInit) => DirectOcrClient;
  readonly #getUrl: (path: string) => string;
  readonly #loadArrayBuffer: (
    url: string,
    signal: AbortSignal,
  ) => Promise<ArrayBuffer>;
  readonly #decompressGzip: (
    input: ArrayBuffer,
    signal: AbortSignal,
  ) => Promise<ArrayBuffer>;
  readonly #decodeImage: (encoded: Blob) => Promise<ImageBitmap | ImageData>;
  readonly #supportsFastBuild: () => boolean;
  readonly #setTimer: TimeoutScheduler;
  readonly #clearTimer: TimeoutCanceller;
  readonly #jobTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #destroyedClients = new WeakSet<object>();
  #client: DirectOcrClient | undefined;
  #clientGroup: string | undefined;
  #clientToken: symbol | undefined;
  #creating: Promise<DirectOcrClient> | undefined;
  #creatingGroup: string | undefined;
  #preparationAbortController: AbortController | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(environment: TesseractWasmDirectRunnerEnvironment = {}) {
    this.#createClient = environment.createClient ?? ((init) => new OCRClient(init));
    this.#getUrl = environment.getUrl ?? ((path) =>
      (browser.runtime.getURL as (value: string) => string)(path));
    this.#loadArrayBuffer = environment.loadArrayBuffer ?? loadLocalArrayBuffer;
    this.#decompressGzip = environment.decompressGzip ?? decompressGzip;
    this.#decodeImage = environment.decodeImage ?? ((encoded) =>
      createImageBitmap(encoded));
    this.#supportsFastBuild = environment.supportsFastBuild ?? supportsFastBuild;
    this.#setTimer = receiverSafeTimeoutScheduler(environment.setTimer);
    this.#clearTimer = receiverSafeTimeoutCanceller(environment.clearTimer);
    this.#jobTimeoutMs = positiveTimeout(
      environment.jobTimeoutMs,
      TESSERACT_WASM_DIRECT_JOB_TIMEOUT_MS,
    );
    this.#idleTimeoutMs = positiveTimeout(
      environment.idleTimeoutMs,
      TESSERACT_WASM_DIRECT_IDLE_TIMEOUT_MS,
    );
  }

  async recognize(
    job: OffscreenOcrJob,
    encoded: Blob,
    signal: AbortSignal,
  ): Promise<ImageTextResult> {
    if (
      this.#disposed ||
      job.providerId !== 'tesseract-wasm-direct'
    ) throw new WorkerLostError();
    if (!isPackagedTesseractLanguageGroup(job.languageGroup)) {
      throw new UnsupportedLanguageError();
    }
    signal.throwIfAborted();
    this.#cancelIdleTimer();
    try {
      const result = await withDeadline(
        this.#recognizeWithClient(job, encoded),
        this.#jobTimeoutMs,
        signal,
        this.#setTimer,
        this.#clearTimer,
      );
      if (!this.#disposed && this.#client) this.#scheduleIdleDisposal();
      return result;
    } catch (error) {
      if (error instanceof InvalidNormalizedOcrOutputError) {
        if (!this.#disposed && this.#client) this.#scheduleIdleDisposal();
        throw error;
      }
      this.#dropClient();
      if (signal.aborted) throw error;
      if (error instanceof UnsupportedLanguageError) throw error;
      if (error instanceof WorkerLostError) throw error;
      throw new WorkerLostError();
    }
  }

  cancelActive(): Promise<void> {
    this.#dropClient();
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#dropClient();
    return Promise.resolve();
  }

  async #recognizeWithClient(
    job: Extract<OffscreenOcrJob, { providerId: 'tesseract-wasm-direct' }>,
    encoded: Blob,
  ): Promise<ImageTextResult> {
    const acquired = await this.#clientFor(job.languageGroup);
    const image = await this.#decodeImage(encoded);
    try {
      await acquired.client.loadImage(image);
    } finally {
      closeDecodedImage(image);
    }
    const items = await acquired.client.getTextBoxes('line');
    if (
      this.#disposed ||
      this.#clientToken !== acquired.token ||
      this.#client !== acquired.client
    ) throw new WorkerLostError();
    const normalized = normalizeDirectTesseractTextItems(
      items,
      job.bitmapWidth,
      job.bitmapHeight,
    );
    if (!normalized) throw new InvalidNormalizedOcrOutputError();
    try {
      await acquired.client.clearImage();
    } catch {
      this.#dropClient(acquired.token);
    }
    return normalized;
  }

  async #clientFor(group: string): Promise<AcquiredDirectClient> {
    if (this.#client && this.#clientGroup === group && this.#clientToken) {
      return { client: this.#client, token: this.#clientToken };
    }
    if (this.#creating && this.#creatingGroup === group && this.#clientToken) {
      const client = await this.#creating;
      if (this.#disposed || this.#clientToken === undefined) {
        throw new WorkerLostError();
      }
      return { client, token: this.#clientToken };
    }
    this.#dropClient();
    const token = Symbol(group);
    const preparationAbortController = new AbortController();
    this.#clientToken = token;
    this.#creatingGroup = group;
    this.#preparationAbortController = preparationAbortController;
    const creation = this.#createPreparedClient(
      group,
      preparationAbortController.signal,
    );
    this.#creating = creation;
    try {
      const client = await creation;
      if (this.#disposed || this.#clientToken !== token) {
        this.#destroyClientDetached(client);
        throw new WorkerLostError();
      }
      this.#client = client;
      this.#clientGroup = group;
      return { client, token };
    } finally {
      if (this.#creating === creation) {
        this.#creating = undefined;
        this.#creatingGroup = undefined;
      }
      if (this.#preparationAbortController === preparationAbortController) {
        this.#preparationAbortController = undefined;
      }
    }
  }

  async #createPreparedClient(
    group: string,
    signal: AbortSignal,
  ): Promise<DirectOcrClient> {
    if (group.includes('+')) throw new UnsupportedLanguageError();
    const modelCode = group;
    signal.throwIfAborted();
    const wasmName = this.#supportsFastBuild()
      ? 'tesseract-core.wasm'
      : 'tesseract-core-fallback.wasm';
    const [wasmBinary, compressedModel] = await Promise.all([
      this.#loadArrayBuffer(
        this.#getUrl(`/ocr/tesseract-wasm/core/${wasmName}`),
        signal,
      ),
      this.#loadArrayBuffer(
        this.#getUrl(`/ocr/tesseract/lang/${modelCode}.traineddata.gz`),
        signal,
      ),
    ]);
    signal.throwIfAborted();
    const model = await this.#decompressGzip(compressedModel, signal);
    signal.throwIfAborted();
    const client = this.#createClient({
      wasmBinary,
      workerURL: this.#getUrl(
        '/ocr/tesseract-wasm/worker/tesseract-worker.js',
      ),
      createWorker: (url) => new Worker(url),
    });
    try {
      await client.loadModel(model);
      return client;
    } catch (error) {
      this.#destroyClientDetached(client);
      throw error;
    }
  }

  #dropClient(expectedToken?: symbol): void {
    if (expectedToken && this.#clientToken !== expectedToken) return;
    this.#cancelIdleTimer();
    const client = this.#client;
    const creating = this.#creating;
    this.#preparationAbortController?.abort(
      new DOMException('Direct OCR preparation cancelled.', 'AbortError'),
    );
    this.#client = undefined;
    this.#clientGroup = undefined;
    this.#clientToken = undefined;
    this.#creating = undefined;
    this.#creatingGroup = undefined;
    this.#preparationAbortController = undefined;
    this.#destroyClientDetached(client);
    if (creating) {
      void creating.then(
        (lateClient) => this.#destroyClientDetached(lateClient),
        () => undefined,
      );
    }
  }

  #destroyClientDetached(client: DirectOcrClient | undefined): void {
    if (!client || this.#destroyedClients.has(client)) return;
    this.#destroyedClients.add(client);
    try {
      void Promise.resolve(client.destroy()).catch(() => undefined);
    } catch {
      // Worker teardown is best-effort after ownership has been dropped.
    }
  }

  #scheduleIdleDisposal(): void {
    this.#cancelIdleTimer();
    this.#idleTimer = this.#setTimer(() => {
      this.#idleTimer = undefined;
      this.#dropClient();
    }, this.#idleTimeoutMs);
  }

  #cancelIdleTimer(): void {
    if (this.#idleTimer !== undefined) this.#clearTimer(this.#idleTimer);
    this.#idleTimer = undefined;
  }
}

export class UnsupportedLanguageError extends Error {
  override readonly name = 'UnsupportedLanguageError';
}

export class WorkerLostError extends Error {
  override readonly name = 'WorkerLostError';

  constructor() {
    super(TESSERACT_WASM_DIRECT_RUNTIME_MARKER);
  }
}

export class InvalidNormalizedOcrOutputError extends Error {
  override readonly name = 'InvalidNormalizedOcrOutputError';
}

class RecognitionTimeoutError extends Error {
  override readonly name = 'RecognitionTimeoutError';
}

async function loadLocalArrayBuffer(
  url: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error('Packaged OCR asset is unavailable.');
  return response.arrayBuffer();
}

async function decompressGzip(
  input: ArrayBuffer,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const stream = new Blob([input]).stream().pipeThrough(
    new DecompressionStream('gzip'),
  );
  const result = await new Response(stream).arrayBuffer();
  signal.throwIfAborted();
  return result;
}

function closeDecodedImage(image: ImageBitmap | ImageData): void {
  if ('close' in image && typeof image.close === 'function') image.close();
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
    const onAbort = (): void => finish(() => reject(signal.reason));
    const timer = setTimer(() => {
      finish(() => reject(new RecognitionTimeoutError()));
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}
