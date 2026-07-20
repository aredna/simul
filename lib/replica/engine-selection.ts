import {
  type ReplicaCaptureRequest,
  type ReplicaDiagnosticCode,
  type ReplicaDiagnostics,
  type ReplicaEngine,
  type ReplicaRunResult,
} from './contracts';

export type ReplicaEngineMode = 'legacy' | 'isolated-html' | 'rrweb-shadow';
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
  return engineMode !== 'legacy' &&
    environment.WXT_SIMUL_RRWEB_TRANSLATION !== '0'
    ? 'rrweb-projection'
    : 'legacy';
}

export function selectReplicaEngineMode(
  environment: ReplicaBuildEnvironment,
  preference: 'isolated-html' | 'rrweb' = 'isolated-html',
): ReplicaEngineMode {
  if (preference === 'rrweb' && environment.WXT_SIMUL_RRWEB_SHADOW !== '0') {
    return 'rrweb-shadow';
  }
  return 'isolated-html';
}

interface ReplicaEngineControllerOptions {
  readonly mode: ReplicaEngineMode;
  readonly legacy: ReplicaEngine;
  readonly shadow: ReplicaEngine;
  readonly isolated?: ReplicaEngine;
  readonly onDiagnostics?: (diagnostics: ReplicaDiagnostics) => void;
  readonly onFallback?: (code: ReplicaDiagnosticCode) => void;
}

/**
 * Keeps legacy visible in every mode. A shadow failure disables that shadow
 * for this companion lifetime and invokes the fallback notification once.
 */
export class ReplicaEngineController {
  #mode: ReplicaEngineMode;
  readonly #disabled = new Set<ReplicaEngineMode>();
  #fallbackNotified = false;

  constructor(private readonly options: ReplicaEngineControllerOptions) {
    this.#mode = options.mode;
  }

  get fallbackNotified(): boolean {
    return this.#fallbackNotified;
  }

  /** True only while a run would still be delegated to the shadow engine. */
  get shadowAvailable(): boolean {
    return this.selectedAvailable;
  }

  get selectedAvailable(): boolean {
    return this.#mode !== 'legacy' &&
      !this.#disabled.has(this.#mode) &&
      Boolean(this.#selectedEngine());
  }

  get mode(): ReplicaEngineMode {
    return this.#mode;
  }

  get selectedEngine(): ReplicaEngine | undefined {
    return this.selectedAvailable ? this.#selectedEngine() : undefined;
  }

  selectMode(mode: ReplicaEngineMode): void {
    // An explicit selection is also an explicit retry of a previously failed
    // engine. This is useful after a transient document/Port failure.
    this.#disabled.delete(mode);
    if (mode === this.#mode) {
      this.#fallbackNotified = false;
      return;
    }
    const previous = this.#selectedEngine();
    previous?.releasePresentation(false);
    this.#mode = mode;
    this.#fallbackNotified = false;
  }

  async run(
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    const runMode = this.#mode;
    const selected = this.#engineForMode(runMode);
    if (
      runMode === 'legacy' ||
      this.#disabled.has(runMode) ||
      !selected
    ) {
      const result = await this.options.legacy.run(request, signal);
      this.options.onDiagnostics?.(result.diagnostics);
      return result;
    }
    const result = await selected.run(request, signal);
    this.options.onDiagnostics?.(result.diagnostics);
    if (result.status !== 'failed') return result;

    // A late failure from an engine that has already been switched away from
    // must never disable or release the newly selected engine.
    if (this.#mode !== runMode) return result;
    this.#disabled.add(runMode);
    selected.releasePresentation(true);
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
    this.#selectedEngine()?.releasePresentation(showFallbackLabel);
  }

  disableShadow(code: ReplicaDiagnosticCode): void {
    this.disableSelected(code);
  }

  disableSelected(code: ReplicaDiagnosticCode): void {
    if (!this.selectedAvailable) return;
    this.#disabled.add(this.#mode);
    this.#selectedEngine()?.releasePresentation(true);
    if (!this.#fallbackNotified) {
      this.#fallbackNotified = true;
      this.options.onFallback?.(code);
    }
  }

  dispose(): void {
    this.options.isolated?.dispose();
    if (this.options.shadow !== this.options.isolated) this.options.shadow.dispose();
    this.options.legacy.dispose();
  }

  #selectedEngine(): ReplicaEngine | undefined {
    return this.#engineForMode(this.#mode);
  }

  #engineForMode(mode: ReplicaEngineMode): ReplicaEngine | undefined {
    if (mode === 'isolated-html') return this.options.isolated;
    if (mode === 'rrweb-shadow') return this.options.shadow;
    return undefined;
  }
}
