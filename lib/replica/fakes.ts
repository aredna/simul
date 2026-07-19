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

  dispose(): void {
    this.disposed = true;
  }
}
