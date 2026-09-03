import {
  type ReplicaCaptureRequest,
  type ReplicaDiagnosticCode,
  type ReplicaDiagnostics,
  type ReplicaEngine,
  type ReplicaRunResult,
} from './contracts';

const TRANSIENT_REPLICA_FAILURE_CODES: ReadonlySet<ReplicaDiagnosticCode> =
  new Set<ReplicaDiagnosticCode>([
    'access_denied',
    'capture_busy',
    'capture_timeout',
    'checkpoint_too_large',
    'replay_timeout',
    'stale_identity',
    'stream_overflow',
  ]);

/** True for failures that a later page or attempt can succeed past. */
export function isTransientReplicaFailure(code: ReplicaDiagnosticCode): boolean {
  return TRANSIENT_REPLICA_FAILURE_CODES.has(code);
}

interface ReplicaEngineControllerOptions {
  readonly legacy: ReplicaEngine;
  readonly isolated: ReplicaEngine;
  readonly onDiagnostics?: (diagnostics: ReplicaDiagnostics) => void;
  readonly onFallback?: (code: ReplicaDiagnosticCode) => void;
}

/**
 * Runs the Isolated HTML engine and keeps the legacy view visible beneath it.
 * A protocol or privacy failure disables the engine for this companion
 * lifetime and invokes the fallback notification once; a capacity, timing or
 * access failure only affects the current page.
 */
export class ReplicaEngineController {
  #disabled = false;
  #fallbackNotified = false;

  constructor(private readonly options: ReplicaEngineControllerOptions) {}

  get fallbackNotified(): boolean {
    return this.#fallbackNotified;
  }

  get selectedAvailable(): boolean {
    return !this.#disabled;
  }

  get selectedEngine(): ReplicaEngine | undefined {
    return this.selectedAvailable ? this.options.isolated : undefined;
  }

  /**
   * An explicit retry of a previously failed engine, for example after a
   * transient document/Port failure or a manual rebuild.
   */
  retrySelected(): void {
    this.#disabled = false;
    this.#fallbackNotified = false;
  }

  async run(
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    if (this.#disabled) {
      const result = await this.options.legacy.run(request, signal);
      this.options.onDiagnostics?.(result.diagnostics);
      return result;
    }
    const result = await this.options.isolated.run(request, signal);
    this.options.onDiagnostics?.(result.diagnostics);
    if (result.status !== 'failed') return result;

    // Capacity, timing, and access failures describe this page or attempt,
    // not the engine; disabling the engine for the companion's lifetime on
    // one oversized page left every later page on the legacy fallback.
    if (!isTransientReplicaFailure(result.diagnostics.code)) {
      this.#disabled = true;
    }
    this.options.isolated.releasePresentation(true);
    if (!this.#fallbackNotified) {
      this.#fallbackNotified = true;
      this.options.onFallback?.(result.diagnostics.code);
      // The visible legacy view already exists. Running its adapter is only an
      // idempotent acknowledgement that fallback has been selected.
      await this.options.legacy.run(request, signal);
    }
    return result;
  }

  releasePresentation(showFallbackLabel = true): void {
    this.selectedEngine?.releasePresentation(showFallbackLabel);
  }

  disableSelected(code: ReplicaDiagnosticCode): void {
    if (!this.selectedAvailable) return;
    this.#disabled = true;
    this.options.isolated.releasePresentation(true);
    if (!this.#fallbackNotified) {
      this.#fallbackNotified = true;
      this.options.onFallback?.(code);
    }
  }

  dispose(): void {
    this.options.isolated.dispose();
    this.options.legacy.dispose();
  }
}
