import { Replayer } from '@rrweb/replay';

import {
  emptyReplicaDiagnostics,
  type ReplicaCaptureRequest,
  type ReplicaCheckpointResponse,
  type ReplicaDiagnosticCode,
  type ReplicaDiagnostics,
  type ReplicaEngine,
  type ReplicaRunResult,
} from './contracts';
import type {
  ReplayPresentationHost,
  VisibleReplayCandidateLease,
} from './visible-replay-host';

export const SHADOW_CAPTURE_DEADLINE_MS = 5_000;
export const SHADOW_REPLAY_DEADLINE_MS = 5_000;

interface ReplayerLike {
  readonly iframe: HTMLIFrameElement;
  on(event: string, handler: () => void): unknown;
  play(timeOffset?: number): void;
  disableInteract(): void;
  destroy(): void;
}

type ReplayerFactory = (
  events: readonly unknown[],
  root: HTMLElement,
) => ReplayerLike;

interface RrwebShadowReplicaEngineOptions {
  readonly presentationHost: ReplayPresentationHost;
  readonly capture: (
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ) => Promise<ReplicaCheckpointResponse>;
  readonly createReplayer?: ReplayerFactory;
  readonly now?: () => number;
  readonly captureDeadlineMs?: number;
  readonly replayDeadlineMs?: number;
}

interface ManagedReplay {
  readonly lease: VisibleReplayCandidateLease;
  readonly abortController: AbortController;
  replayer?: ReplayerLike;
  released: boolean;
}

class ShadowReplicaError extends Error {
  constructor(readonly code: ReplicaDiagnosticCode) {
    super(code);
    this.name = 'ShadowReplicaError';
  }
}

export class ReplicaCaptureBoundaryError extends Error {
  constructor(readonly code: ReplicaDiagnosticCode) {
    super(code);
    this.name = 'ReplicaCaptureBoundaryError';
  }
}

export class RrwebShadowReplicaEngine implements ReplicaEngine {
  readonly id = 'rrweb-shadow-v2' as const;
  readonly #createReplayer: ReplayerFactory;
  readonly #now: () => number;
  #disposed = false;
  #runVersion = 0;
  #candidate: ManagedReplay | undefined;
  #committed: ManagedReplay | undefined;

  constructor(private readonly options: RrwebShadowReplicaEngineOptions) {
    this.#now = options.now ?? (() => performance.now());
    this.#createReplayer = options.createReplayer ?? createRrwebReplayer;
  }

  async run(
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    if (this.#disposed || signal?.aborted || !request.isCurrent()) {
      return this.skipped('stale_identity');
    }
    const runVersion = ++this.#runVersion;
    this.#releaseCandidate();

    let response: ReplicaCheckpointResponse;
    try {
      response = await withDeadline(
        this.options.capture(request, signal),
        this.options.captureDeadlineMs ?? SHADOW_CAPTURE_DEADLINE_MS,
        signal,
        'capture_timeout',
      );
    } catch (error) {
      if (!this.#isCurrentRun(runVersion, request, signal)) {
        return this.skipped('stale_identity');
      }
      const code = readShadowErrorCode(error, 'capture_failed');
      return code === 'stale_identity'
        ? this.skipped(code)
        : this.failure(code);
    }
    if (!this.#isCurrentRun(runVersion, request, signal)) {
      return this.skipped('stale_identity');
    }
    if (response.kind === 'simul:replica-v2:checkpoint-error') {
      if (response.payload.code === 'capture_busy') {
        // A busy replacement must not leave a prior document presented under
        // the new identity. The engine stays enabled so a later run can retry.
        this.releasePresentation(true);
        return this.skipped('capture_busy');
      }
      return this.failure(response.payload.code);
    }

    const payload = response.payload;
    // Concurrent runs can finish capture out of order. Revoke any earlier
    // uncommitted replay before this run takes the single candidate slot.
    this.#releaseCandidate();
    let candidate: ManagedReplay | undefined;
    let committed = false;
    const replayStartedAt = this.#now();
    try {
      candidate = {
        lease: this.options.presentationHost.createCandidate({
          viewportWidth: payload.viewportWidth,
          viewportHeight: payload.viewportHeight,
          documentWidth: payload.documentWidth,
          documentHeight: payload.documentHeight,
        }),
        abortController: new AbortController(),
        released: false,
      };
      this.#candidate = candidate;
      candidate.replayer = this.#createReplayer(payload.events, candidate.lease.mount);
      protectReplayIframe(candidate.replayer.iframe);
      candidate.replayer.disableInteract();
      await waitForFullSnapshot(
        candidate.replayer,
        this.options.replayDeadlineMs ?? SHADOW_REPLAY_DEADLINE_MS,
        signal
          ? AbortSignal.any([signal, candidate.abortController.signal])
          : candidate.abortController.signal,
      );
      if (
        !this.#isCurrentRun(runVersion, request, signal) ||
        this.#candidate !== candidate
      ) {
        return this.skipped('stale_identity');
      }
      const extent = measureReplayExtent(candidate.replayer.iframe);
      const diagnostics: ReplicaDiagnostics = {
        engine: this.id,
        code: 'shadow_complete',
        bytes: payload.byteLength,
        eventCount: payload.events.length,
        captureMs: payload.captureMs,
        replayMs: boundedDuration(this.#now() - replayStartedAt),
        sourceViewportWidth: payload.viewportWidth,
        sourceViewportHeight: payload.viewportHeight,
        sourceDocumentWidth: payload.documentWidth,
        sourceDocumentHeight: payload.documentHeight,
        replayDocumentWidth: extent.width,
        replayDocumentHeight: extent.height,
      };
      candidate.lease.commit(candidate.replayer.iframe, extent);
      const previous = this.#committed;
      this.#candidate = undefined;
      this.#committed = candidate;
      committed = true;
      releaseManagedReplay(previous);
      return { status: 'complete', diagnostics };
    } catch (error) {
      if (!this.#isCurrentRun(runVersion, request, signal)) {
        return this.skipped('stale_identity');
      }
      const code = readShadowErrorCode(error, 'replay_failed');
      if (code === 'stale_identity') return this.skipped(code);
      return this.failure(
        code,
        payload,
        this.#now() - replayStartedAt,
      );
    } finally {
      if (!committed && candidate) {
        if (this.#candidate === candidate) this.#candidate = undefined;
        releaseManagedReplay(candidate);
      }
    }
  }

  releasePresentation(showFallbackLabel = true): void {
    this.#runVersion += 1;
    this.#releaseCandidate();
    this.options.presentationHost.showLegacy(showFallbackLabel);
    releaseManagedReplay(this.#committed);
    this.#committed = undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.releasePresentation(false);
    this.options.presentationHost.dispose();
  }

  #releaseCandidate(): void {
    releaseManagedReplay(this.#candidate);
    this.#candidate = undefined;
  }

  #isCurrentRun(
    runVersion: number,
    request: ReplicaCaptureRequest,
    signal: AbortSignal | undefined,
  ): boolean {
    return (
      !this.#disposed &&
      !signal?.aborted &&
      runVersion === this.#runVersion &&
      request.isCurrent()
    );
  }

  private skipped(
    code: Extract<ReplicaDiagnosticCode, 'capture_busy' | 'stale_identity'>,
  ): ReplicaRunResult {
    return {
      status: 'skipped',
      diagnostics: emptyReplicaDiagnostics(this.id, code),
    };
  }

  private failure(
    code: ReplicaDiagnosticCode,
    payload?: Extract<ReplicaCheckpointResponse, { kind: 'simul:replica-v2:checkpoint' }>['payload'],
    replayMs = 0,
  ): ReplicaRunResult {
    const base = emptyReplicaDiagnostics(this.id, code);
    return {
      status: 'failed',
      diagnostics: payload
        ? {
            ...base,
            bytes: payload.byteLength,
            eventCount: payload.events.length,
            captureMs: payload.captureMs,
            replayMs: boundedDuration(replayMs),
            sourceViewportWidth: payload.viewportWidth,
            sourceViewportHeight: payload.viewportHeight,
            sourceDocumentWidth: payload.documentWidth,
            sourceDocumentHeight: payload.documentHeight,
          }
        : base,
    };
  }
}

function createRrwebReplayer(
  events: readonly unknown[],
  root: HTMLElement,
): ReplayerLike {
  return new Replayer(
    events as ConstructorParameters<typeof Replayer>[0],
    {
      root,
      liveMode: false,
      mouseTail: false,
      showWarning: false,
      showDebug: false,
      triggerFocus: false,
      UNSAFE_replayCanvas: false,
      pauseAnimation: true,
      skipInactive: false,
      loadTimeout: 0,
      useVirtualDom: false,
    },
  );
}

function protectReplayIframe(iframe: HTMLIFrameElement): void {
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('inert', '');
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  // The extension uses border-box globally. Removing the user-agent iframe
  // border keeps the browsing context exactly at the captured viewport size.
  iframe.style.border = '0';
  iframe.style.pointerEvents = 'none';
}

function releaseManagedReplay(replay: ManagedReplay | undefined): void {
  if (!replay || replay.released) return;
  replay.released = true;
  replay.abortController.abort();
  try {
    replay.replayer?.destroy();
  } catch {
    // DOM ownership is still released when upstream teardown fails.
  }
  replay.lease.release();
}

function waitForFullSnapshot(
  replayer: ReplayerLike,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: ShadowReplicaError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(new ShadowReplicaError('stale_identity'));
    const timer = setTimeout(
      () => finish(new ShadowReplicaError('replay_timeout')),
      deadlineMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    replayer.on('fullsnapshot-rebuilded', () => finish());
    try {
      replayer.play(0);
    } catch {
      finish(new ShadowReplicaError('replay_failed'));
    }
  });
}

function measureReplayExtent(iframe: HTMLIFrameElement): {
  width: number;
  height: number;
} {
  const replayDocument = iframe.contentDocument;
  if (!replayDocument) return { width: 0, height: 0 };
  return {
    width: boundedDimension(
      Math.max(
        replayDocument.documentElement?.scrollWidth ?? 0,
        replayDocument.body?.scrollWidth ?? 0,
      ),
    ),
    height: boundedDimension(
      Math.max(
        replayDocument.documentElement?.scrollHeight ?? 0,
        replayDocument.body?.scrollHeight ?? 0,
      ),
    ),
  };
}

function withDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  timeoutCode: ReplicaDiagnosticCode,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void =>
      finish(() => reject(new ShadowReplicaError('stale_identity')));
    const timer = setTimeout(
      () => finish(() => reject(new ShadowReplicaError(timeoutCode))),
      deadlineMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function readShadowErrorCode(
  error: unknown,
  fallback: ReplicaDiagnosticCode,
): ReplicaDiagnosticCode {
  if (error instanceof ShadowReplicaError) return error.code;
  if (error instanceof ReplicaCaptureBoundaryError) return error.code;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'stale_identity';
  }
  if (
    error instanceof Error &&
    /cannot access|permission|not allowed|receiving end does not exist/iu.test(error.message)
  ) return 'access_denied';
  return fallback;
}

function boundedDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(60_000, value)) : 0;
}

function boundedDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, value)) : 0;
}
