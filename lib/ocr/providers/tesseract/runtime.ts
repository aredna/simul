import Tesseract from 'tesseract.js';

import {
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
  type TimeoutCanceller,
  type TimeoutScheduler,
} from '../../../browser-scheduling';
import type { ImageTextResult } from '../../contracts';
import type {
  OffscreenOcrProviderRunner,
} from '../../offscreen-host';
import type { OffscreenOcrJob } from '../../offscreen-protocol';
import {
  isTesseractBannerPreprocessingVersion,
} from '../../preprocessing-profile';
import {
  isPackagedTesseractLanguageGroup,
} from './language-catalog';
import { normalizeTesseractPage } from './normalize';

export const TESSERACT_IDLE_TIMEOUT_MS = 90_000;
export const TESSERACT_JOB_TIMEOUT_MS = 30_000;

type TesseractWorker = Awaited<ReturnType<typeof Tesseract.createWorker>>;

interface AcquiredTesseractWorker {
  readonly worker: TesseractWorker;
  readonly token: symbol;
  readonly loss: Promise<void>;
}

export interface TesseractRunnerEnvironment {
  readonly createWorker?: typeof Tesseract.createWorker;
  readonly getUrl?: (path: string) => string;
  readonly setTimer?: TimeoutScheduler;
  readonly clearTimer?: TimeoutCanceller;
  readonly jobTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export class TesseractOffscreenRunner implements OffscreenOcrProviderRunner {
  readonly #createWorker: typeof Tesseract.createWorker;
  readonly #getUrl: (path: string) => string;
  readonly #setTimer: TimeoutScheduler;
  readonly #clearTimer: TimeoutCanceller;
  readonly #jobTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  #worker: TesseractWorker | undefined;
  #workerGroup: string | undefined;
  #creating: Promise<TesseractWorker> | undefined;
  #workerToken: symbol | undefined;
  #workerLoss: Promise<void> | undefined;
  #signalWorkerLoss: (() => void) | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(environment: TesseractRunnerEnvironment = {}) {
    this.#createWorker = environment.createWorker ?? Tesseract.createWorker;
    this.#getUrl = environment.getUrl ?? ((path) =>
      (browser.runtime.getURL as (value: string) => string)(path));
    this.#setTimer = receiverSafeTimeoutScheduler(environment.setTimer);
    this.#clearTimer = receiverSafeTimeoutCanceller(environment.clearTimer);
    this.#jobTimeoutMs = positiveTimeout(
      environment.jobTimeoutMs,
      TESSERACT_JOB_TIMEOUT_MS,
    );
    this.#idleTimeoutMs = positiveTimeout(
      environment.idleTimeoutMs,
      TESSERACT_IDLE_TIMEOUT_MS,
    );
  }

  async recognize(
    job: OffscreenOcrJob,
    encoded: Blob,
    signal: AbortSignal,
  ): Promise<ImageTextResult> {
    if (this.#disposed) throw new WorkerLostError();
    if (!isPackagedTesseractLanguageGroup(job.languageGroup)) {
      throw new UnsupportedLanguageError();
    }
    signal.throwIfAborted();
    this.#cancelIdleTimer();
    try {
      const recognition = await withDeadline(
        this.#recognizeWithWorker(job, encoded),
        this.#jobTimeoutMs,
        signal,
        this.#setTimer,
        this.#clearTimer,
      );
      if (!this.#disposed && this.#worker) this.#scheduleIdleDisposal();
      return recognition;
    } catch (error) {
      if (error instanceof InvalidNormalizedOcrOutputError) {
        if (!this.#disposed && this.#worker) this.#scheduleIdleDisposal();
        throw error;
      }
      this.#terminateWorker();
      if (signal.aborted) throw error;
      if (error instanceof WorkerLostError) throw error;
      throw new WorkerLostError();
    }
  }

  cancelActive(): Promise<void> {
    this.#terminateWorker();
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#terminateWorker();
    return Promise.resolve();
  }

  async #recognizeWithWorker(
    job: OffscreenOcrJob,
    encoded: Blob,
  ): Promise<ImageTextResult> {
    const acquired = await this.#workerFor(job.languageGroup);
    const useSingleLine = isTesseractBannerPreprocessingVersion(
      job.preprocessingVersion,
    );
    if (useSingleLine) {
      await this.#setPageSegmentation(
        acquired,
        Tesseract.PSM.SINGLE_LINE,
        job.jobId,
      );
    }
    let recognition: Awaited<ReturnType<TesseractWorker['recognize']>>;
    try {
      recognition = await raceWorkerLoss(
        Promise.resolve().then(() => acquired.worker.recognize(
          encoded,
          {},
          { text: true, blocks: true },
          job.jobId,
        )),
        acquired.loss,
      );
    } finally {
      if (
        useSingleLine &&
        this.#workerToken === acquired.token &&
        !this.#disposed
      ) {
        try {
          await this.#setPageSegmentation(
            acquired,
            Tesseract.PSM.SINGLE_BLOCK,
            job.jobId,
          );
        } catch {
          this.#terminateWorker(acquired.token);
          throw new WorkerLostError();
        }
      }
    }
    if (this.#workerToken !== acquired.token || this.#disposed) {
      throw new WorkerLostError();
    }
    let normalized: ImageTextResult | undefined;
    try {
      normalized = normalizeTesseractPage(
        recognition.data,
        job.bitmapWidth,
        job.bitmapHeight,
      );
    } catch {
      throw new InvalidNormalizedOcrOutputError();
    }
    if (!normalized) throw new InvalidNormalizedOcrOutputError();
    return normalized;
  }

  #setPageSegmentation(
    acquired: AcquiredTesseractWorker,
    mode: (typeof Tesseract.PSM)[keyof typeof Tesseract.PSM],
    jobId: string,
  ): Promise<unknown> {
    return raceWorkerLoss(
      Promise.resolve().then(() => acquired.worker.setParameters({
        tessedit_pageseg_mode: mode,
      }, jobId)),
      acquired.loss,
    );
  }

  async #workerFor(group: string): Promise<AcquiredTesseractWorker> {
    if (
      this.#worker && this.#workerGroup === group &&
      this.#workerToken && this.#workerLoss
    ) {
      return {
        worker: this.#worker,
        token: this.#workerToken,
        loss: this.#workerLoss,
      };
    }
    if (this.#workerGroup !== group) this.#terminateWorker();
    if (!this.#creating) {
      const token = Symbol(group);
      let signalWorkerLoss!: () => void;
      const loss = new Promise<void>((resolve) => {
        signalWorkerLoss = resolve;
      });
      this.#workerToken = token;
      this.#workerLoss = loss;
      this.#signalWorkerLoss = signalWorkerLoss;
      const creation = Promise.resolve().then(() => this.#createWorker(
        group,
        Tesseract.OEM.LSTM_ONLY,
        {
          workerPath: this.#getUrl('/ocr/tesseract/worker/worker.min.js'),
          corePath: this.#getUrl('/ocr/tesseract/core'),
          langPath: this.#getUrl('/ocr/tesseract/lang'),
          workerBlobURL: false,
          gzip: true,
          cacheMethod: 'none',
          legacyCore: false,
          legacyLang: false,
          logger: () => undefined,
          errorHandler: () => this.#handleWorkerError(token),
        },
      ));
      this.#creating = creation;
      void creation.then(
        () => {
          if (this.#creating === creation && this.#workerToken === token) {
            this.#creating = undefined;
          }
        },
        () => {
          if (this.#creating === creation && this.#workerToken === token) {
            this.#creating = undefined;
          }
        },
      );
    }
    const creation = this.#creating;
    const token = this.#workerToken;
    const loss = this.#workerLoss;
    if (!creation || !token || !loss) throw new WorkerLostError();
    const worker = await raceWorkerLoss(creation, loss);
    if (this.#disposed || this.#workerToken !== token) {
      throw new WorkerLostError();
    }
    this.#worker = worker;
    this.#workerGroup = group;
    return { worker, token, loss };
  }

  #handleWorkerError(token: symbol): void {
    if (this.#workerToken !== token) return;
    this.#signalWorkerLoss?.();
    this.#terminateWorker(token);
  }

  #terminateWorker(expectedToken?: symbol): void {
    if (expectedToken && this.#workerToken !== expectedToken) return;
    this.#cancelIdleTimer();
    const worker = this.#worker;
    const creating = this.#creating;
    this.#signalWorkerLoss?.();
    this.#worker = undefined;
    this.#workerGroup = undefined;
    this.#creating = undefined;
    this.#workerToken = undefined;
    this.#workerLoss = undefined;
    this.#signalWorkerLoss = undefined;
    // Worker shutdown is best-effort cleanup and must never hold the host's
    // active slot after this runner has dropped ownership.
    terminateWorkerDetached(worker);
    if (creating) {
      void creating.then(
        (lateWorker) => {
          if (lateWorker === worker) return;
          terminateWorkerDetached(lateWorker);
        },
        () => undefined,
      );
    }
  }

  #scheduleIdleDisposal(): void {
    this.#cancelIdleTimer();
    this.#idleTimer = this.#setTimer(() => {
      this.#idleTimer = undefined;
      this.#terminateWorker();
    }, this.#idleTimeoutMs);
  }

  #cancelIdleTimer(): void {
    if (this.#idleTimer !== undefined) this.#clearTimer(this.#idleTimer);
    this.#idleTimer = undefined;
  }
}

function terminateWorkerDetached(worker: TesseractWorker | undefined): void {
  if (!worker) return;
  try {
    void Promise.resolve(worker.terminate()).catch(() => undefined);
  } catch {
    // A broken worker may also throw synchronously during best-effort cleanup.
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
      new DOMException('Tesseract recognition cancelled.', 'AbortError'),
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

function raceWorkerLoss<T>(promise: Promise<T>, loss: Promise<void>): Promise<T> {
  return Promise.race([
    promise,
    loss.then(() => {
      throw new WorkerLostError();
    }),
  ]);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.min(Number(value), 10 * 60_000)
    : fallback;
}
