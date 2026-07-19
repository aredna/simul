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
  readonly hostDocument: Document;
  readonly capture: (
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ) => Promise<ReplicaCheckpointResponse>;
  readonly createReplayer?: ReplayerFactory;
  readonly now?: () => number;
  readonly captureDeadlineMs?: number;
  readonly replayDeadlineMs?: number;
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

    let response: ReplicaCheckpointResponse;
    try {
      response = await withDeadline(
        this.options.capture(request, signal),
        this.options.captureDeadlineMs ?? SHADOW_CAPTURE_DEADLINE_MS,
        signal,
        'capture_timeout',
      );
    } catch (error) {
      const code = readShadowErrorCode(error, 'capture_failed');
      return code === 'stale_identity'
        ? this.skipped(code)
        : this.failure(code);
    }
    if (signal?.aborted || !request.isCurrent()) {
      return this.skipped('stale_identity');
    }
    if (response.kind === 'simul:replica-v2:checkpoint-error') {
      if (response.payload.code === 'capture_busy') {
        return this.skipped('capture_busy');
      }
      return this.failure(response.payload.code);
    }

    const payload = response.payload;
    const staging = createHiddenStaging(
      this.options.hostDocument,
      payload.viewportWidth,
      payload.viewportHeight,
    );
    if (!staging) return this.failure('replay_failed', payload);
    let replayer: ReplayerLike | undefined;
    const replayStartedAt = this.#now();
    try {
      replayer = this.#createReplayer(payload.events, staging);
      protectReplayIframe(replayer.iframe);
      replayer.disableInteract();
      await waitForFullSnapshot(
        replayer,
        this.options.replayDeadlineMs ?? SHADOW_REPLAY_DEADLINE_MS,
        signal,
      );
      if (signal?.aborted || !request.isCurrent()) {
        return this.skipped('stale_identity');
      }
      const extent = measureReplayExtent(replayer.iframe);
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
      return { status: 'complete', diagnostics };
    } catch (error) {
      const code = readShadowErrorCode(error, 'replay_failed');
      if (code === 'stale_identity') return this.skipped(code);
      return this.failure(
        code,
        payload,
        this.#now() - replayStartedAt,
      );
    } finally {
      try {
        replayer?.destroy();
      } catch {
        // Staging is removed below even when an upstream destroy hook fails.
      }
      staging.remove();
    }
  }

  dispose(): void {
    this.#disposed = true;
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

function createHiddenStaging(
  targetDocument: Document,
  width: number,
  height: number,
): HTMLElement | undefined {
  const parent = targetDocument.body ?? targetDocument.documentElement;
  if (!parent) return undefined;
  const staging = targetDocument.createElement('div');
  staging.dataset.simulReplicaShadow = 'v2';
  staging.setAttribute('aria-hidden', 'true');
  staging.setAttribute('inert', '');
  staging.style.position = 'fixed';
  staging.style.left = '-1000000px';
  staging.style.top = '0';
  staging.style.width = `${width}px`;
  staging.style.height = `${height}px`;
  staging.style.visibility = 'hidden';
  staging.style.opacity = '0';
  staging.style.pointerEvents = 'none';
  staging.style.overflow = 'hidden';
  staging.style.contain = 'strict';
  parent.append(staging);
  return staging;
}

function protectReplayIframe(iframe: HTMLIFrameElement): void {
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('inert', '');
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.pointerEvents = 'none';
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
