import {
  readImageTextResult,
  type ImageTextResult,
} from './contracts';
import {
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
  type TimeoutCanceller,
  type TimeoutScheduler,
} from '../browser-scheduling';
import {
  createOffscreenOcrError,
  type OffscreenOcrCommand,
  type OffscreenOcrJob,
  type OffscreenOcrResponse,
  type OcrHostErrorCode,
} from './offscreen-protocol';
import type { TransientImageInputStore } from './transient-image-store';
import type { ImageTextProviderId } from './known-provider-ids';

export interface OffscreenOcrProviderRunner {
  recognize(
    job: OffscreenOcrJob,
    encoded: Blob,
    signal: AbortSignal,
  ): Promise<ImageTextResult>;
  cancelActive?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface OffscreenOcrProviderRunnerFactory {
  readonly id: ImageTextProviderId;
  create(): OffscreenOcrProviderRunner;
}

interface QueuedHostJob {
  readonly job: OffscreenOcrJob;
  readonly resolve: (response: OffscreenOcrResponse) => void;
  readonly promise: Promise<OffscreenOcrResponse>;
}

export const OFFSCREEN_TRANSIENT_CLEANUP_INTERVAL_MS = 30_000;

export interface OffscreenComputeHostEnvironment {
  readonly setTimer?: TimeoutScheduler;
  readonly clearTimer?: TimeoutCanceller;
  readonly cleanupIntervalMs?: number;
}

/** One global active and one pending expensive OCR job. */
export class OffscreenComputeHost {
  readonly #setTimer: TimeoutScheduler;
  readonly #clearTimer: TimeoutCanceller;
  readonly #cleanupIntervalMs: number;
  #active: QueuedHostJob | undefined;
  #activeAbortController: AbortController | undefined;
  #pending: QueuedHostJob | undefined;
  #cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(
    private readonly store: TransientImageInputStore,
    private readonly runner: OffscreenOcrProviderRunner,
    environment: OffscreenComputeHostEnvironment = {},
  ) {
    this.#setTimer = receiverSafeTimeoutScheduler(environment.setTimer);
    this.#clearTimer = receiverSafeTimeoutCanceller(environment.clearTimer);
    this.#cleanupIntervalMs = cleanupInterval(environment.cleanupIntervalMs);
    void this.#cleanupExpiredInputs();
  }

  handle(command: OffscreenOcrCommand): Promise<OffscreenOcrResponse | undefined> {
    if (command.kind === 'simul:ocr-v1:cancel') {
      void this.#cancel(command.clientId, command.jobId);
      return Promise.resolve(undefined);
    }
    if (this.#disposed) {
      return Promise.resolve(createOffscreenOcrError(command.job, 'host-unavailable'));
    }
    const duplicate = this.#find(command.job.clientId, command.job.jobId, command.job.attempt);
    if (duplicate) return duplicate.promise;
    const queued = createQueuedJob(command.job);
    if (!this.#active) {
      this.#active = queued;
      void this.#run(queued);
      return queued.promise;
    }
    if (!this.#pending) {
      this.#pending = queued;
      return queued.promise;
    }
    return Promise.resolve(createOffscreenOcrError(command.job, 'host-overflow'));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#cleanupTimer !== undefined) {
      this.#clearTimer(this.#cleanupTimer);
      this.#cleanupTimer = undefined;
    }
    this.#activeAbortController?.abort();
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) pending.resolve(createOffscreenOcrError(pending.job, 'cancelled'));
    try {
      await this.runner.cancelActive?.();
    } catch {
      // Disposal continues through provider failure.
    }
    await this.runner.dispose().catch(() => undefined);
  }

  async #cleanupExpiredInputs(): Promise<void> {
    await this.store.clearExpired().catch(() => undefined);
    if (this.#disposed) return;
    this.#cleanupTimer = this.#setTimer(() => {
      this.#cleanupTimer = undefined;
      void this.#cleanupExpiredInputs();
    }, this.#cleanupIntervalMs);
  }

  async #run(queued: QueuedHostJob): Promise<void> {
    const abortController = new AbortController();
    this.#activeAbortController = abortController;
    let response: OffscreenOcrResponse;
    try {
      const encoded = await this.store.get(queued.job.inputKey);
      if (!encoded) {
        response = createOffscreenOcrError(queued.job, 'input-missing');
      } else {
        const candidate = await this.runner.recognize(
          queued.job,
          encoded,
          abortController.signal,
        );
        const result = readImageTextResult(candidate);
        response = result &&
          result.providerId === queued.job.providerId &&
          result.bitmapWidth === queued.job.bitmapWidth &&
          result.bitmapHeight === queued.job.bitmapHeight
          ? Object.freeze({
              kind: 'simul:ocr-v1:result' as const,
              version: 1 as const,
              jobId: queued.job.jobId,
              clientId: queued.job.clientId,
              attempt: queued.job.attempt,
              document: queued.job.document,
              nodeId: queued.job.nodeId,
              contentRevision: queued.job.contentRevision,
              observationRevision: queued.job.observationRevision,
              pixelHash: queued.job.pixelHash,
              result,
            })
          : createOffscreenOcrError(queued.job, 'invalid-result');
      }
    } catch (error) {
      response = createOffscreenOcrError(
        queued.job,
        abortController.signal.aborted ? 'cancelled' : readRunnerError(error),
      );
    }
    queued.resolve(response);
    if (this.#active === queued) this.#active = undefined;
    if (this.#activeAbortController === abortController) {
      this.#activeAbortController = undefined;
    }
    const pending = this.#pending;
    this.#pending = undefined;
    if (!this.#disposed && pending) {
      this.#active = pending;
      void this.#run(pending);
    }
  }

  async #cancel(clientId: string, jobId: string): Promise<void> {
    if (this.#pending?.job.clientId === clientId && this.#pending.job.jobId === jobId) {
      const pending = this.#pending;
      this.#pending = undefined;
      pending.resolve(createOffscreenOcrError(pending.job, 'cancelled'));
    }
    if (this.#active?.job.clientId !== clientId || this.#active.job.jobId !== jobId) {
      return;
    }
    this.#activeAbortController?.abort();
    try {
      await this.runner.cancelActive?.();
    } catch {
      // The active wrapper still settles as cancelled.
    }
  }

  #find(
    clientId: string,
    jobId: string,
    attempt: number,
  ): QueuedHostJob | undefined {
    return [this.#active, this.#pending].find((queued) =>
      queued?.job.clientId === clientId &&
      queued.job.jobId === jobId &&
      queued.job.attempt === attempt,
    );
  }
}

function createQueuedJob(job: OffscreenOcrJob): QueuedHostJob {
  let resolve!: (response: OffscreenOcrResponse) => void;
  const promise = new Promise<OffscreenOcrResponse>((next) => {
    resolve = next;
  });
  return { job, resolve, promise };
}

function readRunnerError(error: unknown): OcrHostErrorCode {
  if (error instanceof Error) {
    if (error.name === 'ProviderUnavailableError') return 'provider-unavailable';
    if (error.name === 'UnsupportedLanguageError') return 'unsupported-language';
    if (error.name === 'WorkerLostError') return 'worker-lost';
  }
  return 'recognition-failed';
}

function cleanupInterval(value: number | undefined): number {
  if (!Number.isFinite(value) || Number(value) <= 0) {
    return OFFSCREEN_TRANSIENT_CLEANUP_INTERVAL_MS;
  }
  return Math.min(
    Math.max(1, Math.floor(Number(value))),
    OFFSCREEN_TRANSIENT_CLEANUP_INTERVAL_MS,
  );
}
