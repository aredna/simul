import {
  type ReplicaCaptureRequest,
  type ReplicaDiagnosticCode,
  type ReplicaDiagnostics,
  type ReplicaEngine,
  type ReplicaRunResult,
} from './contracts';

export type ReplicaEngineMode = 'legacy' | 'rrweb-shadow';
export type ReplicaTranslationMode = 'legacy' | 'rrweb-projection';

export interface ReplicaBuildEnvironment {
  readonly DEV?: boolean;
  readonly WXT_SIMUL_RRWEB_SHADOW?: string;
  readonly WXT_SIMUL_RRWEB_TRANSLATION?: string;
}

export function selectReplicaTranslationMode(
  environment: ReplicaBuildEnvironment,
  engineMode = selectReplicaEngineMode(environment),
): ReplicaTranslationMode {
  return engineMode === 'rrweb-shadow' &&
    environment.WXT_SIMUL_RRWEB_TRANSLATION !== '0'
    ? 'rrweb-projection'
    : 'legacy';
}

export function selectReplicaEngineMode(
  environment: ReplicaBuildEnvironment,
): ReplicaEngineMode {
  // Checkpoint F promotes rrweb to the canonical release path. An explicit
  // zero remains a local emergency rollback, while runtime failures still
  // atomically return to the already-prepared legacy surface.
  return environment.WXT_SIMUL_RRWEB_SHADOW === '0'
    ? 'legacy'
    : 'rrweb-shadow';
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

  /** True only while a run would still be delegated to the shadow engine. */
  get shadowAvailable(): boolean {
    return this.options.mode === 'rrweb-shadow' && !this.#shadowDisabled;
  }

  async run(
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    if (!this.shadowAvailable) {
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

  disableShadow(code: ReplicaDiagnosticCode): void {
    if (this.options.mode !== 'rrweb-shadow' || this.#shadowDisabled) return;
    this.#shadowDisabled = true;
    this.options.shadow.releasePresentation(true);
    if (!this.#fallbackNotified) {
      this.#fallbackNotified = true;
      this.options.onFallback?.(code);
    }
  }

  dispose(): void {
    this.options.shadow.dispose();
    this.options.legacy.dispose();
  }
}
