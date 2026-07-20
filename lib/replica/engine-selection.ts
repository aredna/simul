import {
  type ReplicaCaptureRequest,
  type ReplicaDiagnosticCode,
  type ReplicaDiagnostics,
  type ReplicaEngine,
  type ReplicaRunResult,
} from './contracts';

export type ReplicaEngineMode = 'legacy' | 'rrweb-shadow';

export interface ReplicaBuildEnvironment {
  readonly DEV?: boolean;
  readonly WXT_SIMUL_RRWEB_SHADOW?: string;
}

export function selectReplicaEngineMode(
  environment: ReplicaBuildEnvironment,
): ReplicaEngineMode {
  return environment.DEV === true &&
    environment.WXT_SIMUL_RRWEB_SHADOW === '1'
    ? 'rrweb-shadow'
    : 'legacy';
}

interface ReplicaEngineControllerOptions {
  readonly mode: ReplicaEngineMode;
  readonly legacy: ReplicaEngine;
  readonly shadow: ReplicaEngine;
  readonly onDiagnostics?: (diagnostics: ReplicaDiagnostics) => void;
  readonly onFallback?: (code: ReplicaDiagnosticCode) => void;
}

/**
 * Keeps legacy visible in every mode. A shadow failure disables that shadow
 * for this companion lifetime and invokes the fallback notification once.
 */
export class ReplicaEngineController {
  #shadowDisabled = false;
  #fallbackNotified = false;

  constructor(private readonly options: ReplicaEngineControllerOptions) {}

  get fallbackNotified(): boolean {
    return this.#fallbackNotified;
  }

  async run(
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    if (this.options.mode === 'legacy' || this.#shadowDisabled) {
      const result = await this.options.legacy.run(request, signal);
      this.options.onDiagnostics?.(result.diagnostics);
      return result;
    }

    const result = await this.options.shadow.run(request, signal);
    this.options.onDiagnostics?.(result.diagnostics);
    if (result.status !== 'failed') return result;

    this.#shadowDisabled = true;
    this.options.shadow.releasePresentation(true);
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
    if (this.options.mode !== 'rrweb-shadow') return;
    this.options.shadow.releasePresentation(showFallbackLabel);
  }

  dispose(): void {
    this.options.shadow.dispose();
    this.options.legacy.dispose();
  }
}
