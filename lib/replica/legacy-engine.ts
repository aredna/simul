import {
  emptyReplicaDiagnostics,
  type ReplicaCaptureRequest,
  type ReplicaEngine,
  type ReplicaRunResult,
} from './contracts';

/**
 * Adapter for the existing visible renderer. Checkpoint A intentionally leaves
 * that renderer under its current controller, so this adapter records engine
 * selection without rebuilding or mutating the already usable view.
 */
export class LegacyReplicaEngine implements ReplicaEngine {
  readonly id = 'legacy-v1' as const;

  async run(
    _request: ReplicaCaptureRequest,
    _signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    return {
      status: 'skipped',
      diagnostics: emptyReplicaDiagnostics(this.id, 'legacy_selected'),
    };
  }

  dispose(): void {
    // The existing side-panel controller owns the visible legacy renderer.
  }
}
