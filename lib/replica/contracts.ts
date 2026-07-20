export const REPLICA_PROTOCOL_VERSION = 2 as const;

import type { ReplicaSourceDocumentIdentity } from './source-identity';

export type ReplicaEngineId =
  | 'legacy-v1'
  | 'isolated-html-v1'
  | 'rrweb-shadow-v2';

export interface ReplicaDocumentIdentity {
  readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly pageEpoch: number;
  readonly generation: number;
  readonly documentId: string;
  readonly frameId: number;
  readonly sequence: number;
}

export interface ReplicaCaptureRequest {
  readonly sessionId: string;
  readonly pageEpoch: number;
  readonly generation: number;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
  readonly isCurrent: () => boolean;
}

export type ReplicaDiagnosticCode =
  | 'legacy_selected'
  | 'shadow_disabled'
  | 'shadow_complete'
  | 'isolated_complete'
  | 'isolated_connected'
  | 'stale_identity'
  | 'access_denied'
  | 'capture_busy'
  | 'capture_failed'
  | 'capture_timeout'
  | 'invalid_message'
  | 'checkpoint_too_large'
  | 'privacy_rejected'
  | 'replay_failed'
  | 'replay_timeout'
  | 'stream_gap'
  | 'stream_overflow'
  | 'stream_failed';

export interface ReplicaImageAnchor {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly replayLease: number;
  readonly image: HTMLImageElement;
  readonly iframe: HTMLIFrameElement;
}

export interface ReplicaImageSurface {
  resolveImageAnchor(
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
  ): ReplicaImageAnchor | undefined;
}

/**
 * Deliberately content-free local diagnostics. Never add URLs, source text,
 * serialized nodes, control values, or thrown error messages to this shape.
 */
export interface ReplicaDiagnostics {
  readonly engine: ReplicaEngineId;
  readonly code: ReplicaDiagnosticCode;
  readonly bytes: number;
  readonly eventCount: number;
  readonly captureMs: number;
  readonly replayMs: number;
  readonly sourceViewportWidth: number;
  readonly sourceViewportHeight: number;
  readonly sourceDocumentWidth: number;
  readonly sourceDocumentHeight: number;
  readonly replayDocumentWidth: number;
  readonly replayDocumentHeight: number;
}

export type ReplicaRunResult =
  | {
      readonly status: 'complete';
      readonly diagnostics: ReplicaDiagnostics;
    }
  | {
      readonly status: 'skipped';
      readonly diagnostics: ReplicaDiagnostics;
    }
  | {
      readonly status: 'failed';
      readonly diagnostics: ReplicaDiagnostics;
    };

export interface ReplicaEngine {
  readonly id: ReplicaEngineId;
  run(request: ReplicaCaptureRequest, signal?: AbortSignal): Promise<ReplicaRunResult>;
  releasePresentation(showFallbackLabel?: boolean): void;
  dispose(): void;
}

export interface ReplicaLiveBatch {
  readonly identity: ReplicaDocumentIdentity;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly events: readonly unknown[];
  readonly byteLength: number;
}

export interface ReplicaLiveStreamObserver {
  onBatch(batch: ReplicaLiveBatch): void;
  onCheckpoint(checkpoint: ReplicaCheckpointResponse): void;
  onFailure(code: Extract<ReplicaDiagnosticCode, 'stream_gap' | 'stream_overflow' | 'stream_failed'>): void;
}

/**
 * One exact-document Port owned by the visible companion. The recorder does
 * not consider transport delivery an acknowledgement; only the replica engine
 * may advance the applied watermark.
 */
export interface ReplicaLiveStreamLease {
  readonly initialCheckpoint: Promise<ReplicaCheckpointResponse>;
  setObserver(observer: ReplicaLiveStreamObserver): void;
  acknowledgeCheckpoint(sequence: number): void;
  acknowledge(sequence: number): void;
  requestCheckpoint(): void;
  dispose(): void;
}

export type ReplicaLiveStreamFactory = (
  request: ReplicaCaptureRequest,
  signal?: AbortSignal,
) => Promise<ReplicaLiveStreamLease>;

export interface ReplicaCheckpointPayload {
  readonly events: readonly unknown[];
  readonly byteLength: number;
  readonly captureMs: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

export interface ReplicaCheckpointEnvelope {
  readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  readonly kind: 'simul:replica-v2:checkpoint';
  readonly identity: ReplicaDocumentIdentity;
  readonly payload: ReplicaCheckpointPayload;
}

export interface ReplicaCheckpointErrorEnvelope {
  readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  readonly kind: 'simul:replica-v2:checkpoint-error';
  readonly identity: ReplicaDocumentIdentity;
  readonly payload: {
    readonly code:
      | 'capture_busy'
      | 'capture_failed'
      | 'capture_timeout'
      | 'checkpoint_too_large'
      | 'privacy_rejected';
  };
}

export type ReplicaCheckpointResponse =
  | ReplicaCheckpointEnvelope
  | ReplicaCheckpointErrorEnvelope;

export interface ReplicaCheckpointCommand {
  readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  readonly kind: 'simul:replica-v2:capture-checkpoint';
  readonly identity: ReplicaDocumentIdentity;
}

export function emptyReplicaDiagnostics(
  engine: ReplicaEngineId,
  code: ReplicaDiagnosticCode,
): ReplicaDiagnostics {
  return {
    engine,
    code,
    bytes: 0,
    eventCount: 0,
    captureMs: 0,
    replayMs: 0,
    sourceViewportWidth: 0,
    sourceViewportHeight: 0,
    sourceDocumentWidth: 0,
    sourceDocumentHeight: 0,
    replayDocumentWidth: 0,
    replayDocumentHeight: 0,
  };
}
