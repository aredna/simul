import {
  emptyReplicaDiagnostics,
  type ReplicaCaptureRequest,
  type ReplicaEngine,
  type ReplicaEngineId,
  type ReplicaRunResult,
} from './contracts';

export class FakeReplicaEngine implements ReplicaEngine {
  readonly requests: ReplicaCaptureRequest[] = [];
  disposed = false;
  presentationReleases = 0;
  lastFallbackLabel = false;

  constructor(
    readonly id: ReplicaEngineId,
    private result: ReplicaRunResult = {
      status: 'complete',
      diagnostics: emptyReplicaDiagnostics(id, 'shadow_complete'),
    },
  ) {}

  setResult(result: ReplicaRunResult): void {
    this.result = result;
  }

  async run(
    request: ReplicaCaptureRequest,
    _signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    this.requests.push(request);
    return this.result;
  }

  releasePresentation(showFallbackLabel = true): void {
    this.presentationReleases += 1;
    this.lastFallbackLabel = showFallbackLabel;
  }

  dispose(): void {
    this.disposed = true;
  }
}
