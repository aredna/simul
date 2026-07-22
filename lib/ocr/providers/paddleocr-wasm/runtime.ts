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
  PADDLE_OCR_DETECTION_MODEL_NAME,
  PADDLE_OCR_DETECTOR_BOX_THRESHOLD,
  PADDLE_OCR_DETECTOR_THRESHOLD,
  PADDLE_OCR_RECOGNITION_MODEL_NAME,
  PADDLE_OCR_RECOGNITION_SCORE_THRESHOLD,
} from './constants';
import { normalizePaddleOcrResult } from './normalize';

export const PADDLE_OCR_IDLE_TIMEOUT_MS = 90_000;
export const PADDLE_OCR_JOB_TIMEOUT_MS = 30_000;
export const PADDLE_OCR_RUNTIME_MARKER =
  'simul-paddleocr-js-0.4.2-offscreen-v1';

interface PaddlePipeline {
  predict(input: Blob, params: Readonly<Record<string, number>>): Promise<unknown>;
  terminate(): void;
  dispose(): Promise<void>;
}

interface PaddlePipelineCreateOptions {
  readonly workerUrl: string;
  readonly detectionModelUrl: string;
  readonly recognitionModelUrl: string;
  readonly runtimeWasmUrl: string;
  readonly createWorker: () => Worker;
  readonly decode: (encoded: Blob) => Promise<ImageBitmap>;
  readonly onPipelineCreated: (pipeline: PaddlePipeline) => void;
}

export interface PaddleOcrRunnerEnvironment {
  readonly createPipeline?: (
    options: PaddlePipelineCreateOptions,
  ) => Promise<PaddlePipeline>;
  readonly createWorker?: (url: string) => Worker;
  readonly decode?: (encoded: Blob) => Promise<ImageBitmap>;
  readonly getUrl?: (path: string) => string;
  readonly setTimer?: TimeoutScheduler;
  readonly clearTimer?: TimeoutCanceller;
  readonly jobTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export class PaddleOcrOffscreenRunner implements OffscreenOcrProviderRunner {
  readonly #createPipeline: NonNullable<
    PaddleOcrRunnerEnvironment['createPipeline']
  >;
  readonly #createWorker: (url: string) => Worker;
  readonly #decode: (encoded: Blob) => Promise<ImageBitmap>;
  readonly #getUrl: (path: string) => string;
  readonly #setTimer: TimeoutScheduler;
  readonly #clearTimer: TimeoutCanceller;
  readonly #jobTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  #pipeline: PaddlePipeline | undefined;
  #initializingPipeline: PaddlePipeline | undefined;
  #creating: Promise<PaddlePipeline> | undefined;
  #worker: Worker | undefined;
  #token: symbol | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(environment: PaddleOcrRunnerEnvironment = {}) {
    this.#createPipeline = environment.createPipeline ?? createPaddleWorkerPipeline;
    this.#createWorker = environment.createWorker ?? ((url) => new Worker(url, {
      type: 'module',
      name: 'simul-paddleocr',
    }));
    this.#decode = environment.decode ?? ((encoded) => createImageBitmap(encoded));
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
    signal.throwIfAborted();
    this.#cancelIdleTimer();
    try {
      const result = await withDeadline(
        this.#recognize(job, encoded),
        this.#jobTimeoutMs,
        signal,
        this.#setTimer,
        this.#clearTimer,
      );
      if (!this.#disposed && this.#pipeline) this.#scheduleIdleDisposal();
      return result;
    } catch (error) {
      this.#terminatePipeline();
      if (signal.aborted) throw error;
      if (
        error instanceof ProviderUnavailableError ||
        error instanceof UnsupportedLanguageError ||
        error instanceof InvalidNormalizedOcrOutputError
      ) throw error;
      throw new WorkerLostError();
    }
  }

  cancelActive(): Promise<void> {
    this.#terminatePipeline();
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#terminatePipeline();
    return Promise.resolve();
  }

  async #recognize(
    job: Extract<OffscreenOcrJob, { providerId: 'paddleocr-wasm' }>,
    encoded: Blob,
  ): Promise<ImageTextResult> {
    const acquired = await this.#pipelineFor();
    const raw = await acquired.pipeline.predict(encoded, {
      textDetThresh: PADDLE_OCR_DETECTOR_THRESHOLD,
      textDetBoxThresh: PADDLE_OCR_DETECTOR_BOX_THRESHOLD,
      textRecScoreThresh: PADDLE_OCR_RECOGNITION_SCORE_THRESHOLD,
    });
    if (this.#token !== acquired.token || this.#disposed) {
      throw new WorkerLostError();
    }
    const normalized = normalizePaddleOcrResult(
      raw,
      job.bitmapWidth,
      job.bitmapHeight,
    );
    if (!normalized) throw new InvalidNormalizedOcrOutputError();
    return normalized;
  }

  async #pipelineFor(): Promise<{
    readonly pipeline: PaddlePipeline;
    readonly token: symbol;
  }> {
    if (this.#pipeline && this.#token) {
      return { pipeline: this.#pipeline, token: this.#token };
    }
    if (!this.#creating) {
      const token = Symbol('paddleocr');
      this.#token = token;
      const options: PaddlePipelineCreateOptions = {
        workerUrl: this.#getUrl('/ocr/paddle/worker/worker-entry.js'),
        detectionModelUrl: this.#getUrl(
          '/ocr/paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar',
        ),
        recognitionModelUrl: this.#getUrl(
          '/ocr/paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
        ),
        runtimeWasmUrl: this.#getUrl(
          '/ocr/paddle/runtime/ort-wasm-simd-threaded.wasm',
        ),
        createWorker: () => {
          const worker = this.#createWorker(
            this.#getUrl('/ocr/paddle/worker/worker-entry.js'),
          );
          if (!this.#disposed && this.#token === token) {
            this.#worker = worker;
          }
          return worker;
        },
        decode: this.#decode,
        onPipelineCreated: (pipeline) => {
          if (this.#disposed || this.#token !== token) {
            pipeline.terminate();
            disposePipelineDetached(pipeline);
            return;
          }
          this.#initializingPipeline = pipeline;
        },
      };
      const creation = Promise.resolve().then(() =>
        this.#createPipeline(options));
      this.#creating = creation;
      void creation.finally(() => {
        if (this.#creating === creation) this.#creating = undefined;
      }).catch(() => undefined);
    }
    const creation = this.#creating;
    const token = this.#token;
    if (!creation || !token) throw new WorkerLostError();
    const pipeline = await creation;
    if (this.#disposed || this.#token !== token) {
      pipeline.terminate();
      disposePipelineDetached(pipeline);
      throw new WorkerLostError();
    }
    if (this.#initializingPipeline === pipeline) {
      this.#initializingPipeline = undefined;
    }
    this.#pipeline = pipeline;
    return { pipeline, token };
  }

  #terminatePipeline(): void {
    this.#cancelIdleTimer();
    const pipeline = this.#pipeline;
    const initializingPipeline = this.#initializingPipeline;
    const creating = this.#creating;
    const worker = this.#worker;
    this.#pipeline = undefined;
    this.#initializingPipeline = undefined;
    this.#creating = undefined;
    this.#worker = undefined;
    this.#token = undefined;
    pipeline?.terminate();
    disposePipelineDetached(pipeline);
    if (initializingPipeline !== pipeline) {
      initializingPipeline?.terminate();
      disposePipelineDetached(initializingPipeline);
    }
    if (!pipeline && !initializingPipeline) worker?.terminate();
    if (creating) {
      void creating.then((late) => {
        if (late === pipeline || late === initializingPipeline) return;
        late.terminate();
        disposePipelineDetached(late);
      }, () => undefined);
    }
  }

  #scheduleIdleDisposal(): void {
    this.#cancelIdleTimer();
    this.#idleTimer = this.#setTimer(() => {
      this.#idleTimer = undefined;
      this.#terminatePipeline();
    }, this.#idleTimeoutMs);
  }

  #cancelIdleTimer(): void {
    if (this.#idleTimer !== undefined) this.#clearTimer(this.#idleTimer);
    this.#idleTimer = undefined;
  }
}

class PaddleWorkerPipeline implements PaddlePipeline {
  readonly #pending = new Map<number, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  }>();
  #nextRequestId = 1;
  #disposed = false;

  constructor(
    private readonly worker: Worker,
    private readonly decode: (encoded: Blob) => Promise<ImageBitmap>,
  ) {
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const response = readWorkerResponse(event.data);
      if (!response) return;
      const pending = this.#pending.get(response.requestId);
      if (!pending) return;
      this.#pending.delete(response.requestId);
      if (response.status === 'success') pending.resolve(response.payload);
      else pending.reject(workerResponseError(response.error));
    };
    worker.onerror = () => this.#fail(new WorkerLostError());
  }

  initialize(options: unknown): Promise<void> {
    return this.#request('init', { options }).then(() => undefined);
  }

  async predict(
    input: Blob,
    params: Readonly<Record<string, number>>,
  ): Promise<unknown> {
    if (this.#disposed) throw new WorkerLostError();
    const bitmap = await this.decode(input);
    if (this.#disposed) {
      bitmap.close();
      throw new WorkerLostError();
    }
    try {
      return await this.#request('predict', {
        sources: [{ kind: 'imageBitmap', imageBitmap: bitmap }],
        params,
      }, [bitmap]);
    } catch (error) {
      try {
        bitmap.close();
      } catch {
        // Ownership may already have transferred to the terminated Worker.
      }
      throw error;
    }
  }

  terminate(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.worker.terminate();
    this.#fail(new WorkerLostError());
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#request('dispose', {});
    } finally {
      this.terminate();
    }
  }

  #request(
    type: 'init' | 'predict' | 'dispose',
    payload: unknown,
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    if (this.#disposed) return Promise.reject(new WorkerLostError());
    const requestId = this.#nextRequestId;
    this.#nextRequestId = requestId >= Number.MAX_SAFE_INTEGER
      ? 1
      : requestId + 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      try {
        this.worker.postMessage({
          kind: 'worker-transport-request',
          type,
          payload,
          requestId,
        }, transfer);
      } catch (error) {
        this.#pending.delete(requestId);
        reject(error);
      }
    });
  }

  #fail(error: unknown): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

async function createPaddleWorkerPipeline(
  options: PaddlePipelineCreateOptions,
): Promise<PaddlePipeline> {
  const worker = options.createWorker();
  const pipeline = new PaddleWorkerPipeline(worker, options.decode);
  try {
    options.onPipelineCreated(pipeline);
    await pipeline.initialize({
      pipelineConfig: {
        pipelineName: 'OCR',
        raw: {},
        warnings: [],
        unsupportedFeatures: [],
        modelSelection: {
          textDetectionModelName: PADDLE_OCR_DETECTION_MODEL_NAME,
          textRecognitionModelName: PADDLE_OCR_RECOGNITION_MODEL_NAME,
        },
        assets: {
          det: { url: options.detectionModelUrl },
          rec: { url: options.recognitionModelUrl },
        },
        runtimeDefaults: {
          text_det_limit_side_len: 960,
          text_det_limit_type: 'max',
          text_det_max_side_limit: 4000,
          text_det_thresh: PADDLE_OCR_DETECTOR_THRESHOLD,
          text_det_box_thresh: PADDLE_OCR_DETECTOR_BOX_THRESHOLD,
          text_det_unclip_ratio: 2,
          text_rec_score_thresh: PADDLE_OCR_RECOGNITION_SCORE_THRESHOLD,
        },
        pipelineBatchSize: 1,
        textDetectionBatchSize: 1,
        textRecognitionBatchSize: 1,
      },
      ortOptions: {
        backend: 'wasm',
        // ORT 1.24 interprets a string as a directory containing both its
        // dynamic JS loader and Wasm. Supplying the exact Wasm URL keeps the
        // SDK's bundled loader in use and prevents an unbundled `.jsep.mjs`
        // request.
        wasmPaths: { wasm: options.runtimeWasmUrl },
        numThreads: 1,
        simd: true,
        proxy: false,
        disableWasmProxy: true,
      },
    });
    return pipeline;
  } catch (error) {
    pipeline.terminate();
    throw error;
  }
}

type PaddleWorkerResponse =
  | {
      readonly status: 'success';
      readonly requestId: number;
      readonly payload: unknown;
    }
  | {
      readonly status: 'error';
      readonly requestId: number;
      readonly error: unknown;
    };

function readWorkerResponse(input: unknown): PaddleWorkerResponse | undefined {
  if (!isRecord(input) || input.kind !== 'worker-transport-response' ||
    !Number.isSafeInteger(input.requestId) || Number(input.requestId) < 1) {
    return undefined;
  }
  if (input.status === 'success' && Object.hasOwn(input, 'payload')) {
    return {
      status: 'success',
      requestId: input.requestId as number,
      payload: input.payload,
    };
  }
  if (input.status === 'error' && Object.hasOwn(input, 'error')) {
    return {
      status: 'error',
      requestId: input.requestId as number,
      error: input.error,
    };
  }
  return undefined;
}

function workerResponseError(value: unknown): Error {
  const error = new Error('Paddle OCR Worker failed.');
  if (isRecord(value) && typeof value.name === 'string') error.name = value.name;
  return error;
}

const PADDLE_SUPPORTED_LANGUAGES = new Set([
  'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'hr', 'hu', 'id', 'it', 'lt',
  'nl', 'no', 'pl', 'pt', 'ro', 'sk', 'sl', 'sv', 'tr', 'vi', 'zh',
  'zh-Hant',
]);

function disposePipelineDetached(pipeline: PaddlePipeline | undefined): void {
  if (!pipeline) return;
  try {
    void Promise.resolve(pipeline.dispose()).catch(() => undefined);
  } catch {
    // Best-effort release cannot retain the host slot.
  }
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
      () => finish(() => reject(new RecognitionTimeoutError())),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';

  constructor() {
    super(`${PADDLE_OCR_RUNTIME_MARKER} is unavailable.`);
  }
}

export class UnsupportedLanguageError extends Error {
  override readonly name = 'UnsupportedLanguageError';
}

export class WorkerLostError extends Error {
  override readonly name = 'WorkerLostError';
}

class RecognitionTimeoutError extends Error {
  override readonly name = 'RecognitionTimeoutError';
}

class InvalidNormalizedOcrOutputError extends Error {
  override readonly name = 'InvalidNormalizedOcrOutputError';
}
