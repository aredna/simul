import {
  REPLICA_PROTOCOL_VERSION,
  type ReplicaCheckpointResponse,
  type ReplicaDocumentIdentity,
  type ReplicaLiveBatch,
} from './contracts';
import {
  createReplicaIdentity,
  readCheckpointResponse,
  readReplicaIdentity,
} from './protocol-v2';

export const REPLICA_LIVE_PORT_PREFIX = 'simul:replica-v2:live:';
export const MAX_REPLICA_LIVE_EVENTS_PER_BATCH = 128;
export const MAX_REPLICA_LIVE_EVENT_BYTES = 128 * 1024;
export const MAX_REPLICA_LIVE_BATCH_BYTES = 256 * 1024;
export const MAX_REPLICA_LIVE_HISTORY_BATCHES = 64;
export const MAX_REPLICA_LIVE_HISTORY_BYTES = 2 * 1024 * 1024;
export const MAX_REPLICA_LIVE_UNACKED_BATCHES = 4;
export const MAX_REPLICA_LIVE_SUBSCRIBERS = 16;

export type ReplicaLiveControllerMessage =
  | {
      readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
      readonly kind: 'simul:replica-v2:start-live';
      readonly identity: ReplicaDocumentIdentity;
    }
  | {
      readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
      readonly kind: 'simul:replica-v2:ack';
      readonly identity: ReplicaDocumentIdentity;
    }
  | {
      readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
      readonly kind: 'simul:replica-v2:checkpoint-ack';
      readonly identity: ReplicaDocumentIdentity;
    }
  | {
      readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
      readonly kind: 'simul:replica-v2:request-checkpoint';
      readonly identity: ReplicaDocumentIdentity;
    };

export interface ReplicaLiveBatchEnvelope {
  readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  readonly kind: 'simul:replica-v2:batch';
  readonly identity: ReplicaDocumentIdentity;
  readonly payload: {
    readonly firstSequence: number;
    readonly events: readonly unknown[];
    readonly byteLength: number;
  };
}

export interface ReplicaLiveErrorEnvelope {
  readonly protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  readonly kind: 'simul:replica-v2:stream-error';
  readonly identity: ReplicaDocumentIdentity;
  readonly payload: {
    readonly code: 'stream_overflow' | 'stream_failed';
  };
}

export type ReplicaLiveRecorderMessage =
  | ReplicaCheckpointResponse
  | ReplicaLiveBatchEnvelope
  | ReplicaLiveErrorEnvelope;

export class ReplicaLiveProtocolError extends Error {
  constructor(
    readonly code: ReplicaLiveErrorEnvelope['payload']['code'],
  ) {
    super(code);
    this.name = 'ReplicaLiveProtocolError';
  }
}

export function createReplicaLivePortName(sessionId: string): string {
  return `${REPLICA_LIVE_PORT_PREFIX}${sessionId}`;
}

export function readReplicaLivePortSessionId(name: string): string | undefined {
  if (!name.startsWith(REPLICA_LIVE_PORT_PREFIX)) return undefined;
  const sessionId = name.slice(REPLICA_LIVE_PORT_PREFIX.length);
  return isSafeToken(sessionId) ? sessionId : undefined;
}

export function createStartLiveMessage(
  identity: ReplicaDocumentIdentity,
): ReplicaLiveControllerMessage {
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:start-live',
    identity,
  };
}

export function createLiveAckMessage(
  identity: ReplicaDocumentIdentity,
  sequence: number,
): ReplicaLiveControllerMessage {
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:ack',
    identity: withSequence(identity, sequence),
  };
}

export function createLiveCheckpointAckMessage(
  identity: ReplicaDocumentIdentity,
  sequence: number,
): ReplicaLiveControllerMessage {
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:checkpoint-ack',
    identity: withSequence(identity, sequence),
  };
}

export function createLiveCheckpointRequest(
  identity: ReplicaDocumentIdentity,
  sequence: number,
): ReplicaLiveControllerMessage {
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:request-checkpoint',
    identity: withSequence(identity, sequence),
  };
}

export function readLiveControllerMessage(
  input: unknown,
  expectedSessionId?: string,
): ReplicaLiveControllerMessage | undefined {
  if (!isRecordWithExactKeys(input, ['protocolVersion', 'kind', 'identity'])) {
    return undefined;
  }
  if (input.protocolVersion !== REPLICA_PROTOCOL_VERSION) return undefined;
  if (
    input.kind !== 'simul:replica-v2:start-live' &&
    input.kind !== 'simul:replica-v2:ack' &&
    input.kind !== 'simul:replica-v2:checkpoint-ack' &&
    input.kind !== 'simul:replica-v2:request-checkpoint'
  ) return undefined;
  const identity = readReplicaIdentity(input.identity);
  if (!identity || (expectedSessionId && identity.sessionId !== expectedSessionId)) {
    return undefined;
  }
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: input.kind,
    identity,
  };
}

export function createLiveBatchEnvelope(
  identity: ReplicaDocumentIdentity,
  firstSequence: number,
  events: readonly unknown[],
): ReplicaLiveBatchEnvelope | undefined {
  if (
    events.length < 1 ||
    events.length > MAX_REPLICA_LIVE_EVENTS_PER_BATCH ||
    !Number.isSafeInteger(firstSequence) ||
    firstSequence < 1
  ) return undefined;
  for (const event of events) {
    const bytes = jsonByteLength(event);
    if (bytes < 1 || bytes > MAX_REPLICA_LIVE_EVENT_BYTES) return undefined;
  }
  const byteLength = jsonByteLength(events);
  if (byteLength > MAX_REPLICA_LIVE_BATCH_BYTES) return undefined;
  const lastSequence = firstSequence + events.length - 1;
  if (!Number.isSafeInteger(lastSequence) || lastSequence > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:batch',
    identity: withSequence(identity, lastSequence),
    payload: {
      firstSequence,
      events: Object.freeze([...events]),
      byteLength,
    },
  };
}

export function readLiveRecorderMessage(
  input: unknown,
  expectedIdentity: ReplicaDocumentIdentity,
): ReplicaLiveRecorderMessage | undefined {
  if (!isRecord(input) || input.protocolVersion !== REPLICA_PROTOCOL_VERSION) {
    return undefined;
  }
  if (
    input.kind === 'simul:replica-v2:checkpoint' ||
    input.kind === 'simul:replica-v2:checkpoint-error'
  ) {
    const candidateIdentity = isRecord(input.identity)
      ? readReplicaIdentity(input.identity)
      : undefined;
    if (!candidateIdentity || !sameReplicaDocument(candidateIdentity, expectedIdentity)) {
      return undefined;
    }
    return readCheckpointResponse(input, candidateIdentity);
  }
  if (!hasOnlyKeys(input, ['protocolVersion', 'kind', 'identity', 'payload'])) {
    return undefined;
  }
  const identity = readReplicaIdentity(input.identity);
  if (!identity || !sameReplicaDocument(identity, expectedIdentity)) return undefined;
  if (input.kind === 'simul:replica-v2:stream-error') {
    if (!isRecordWithExactKeys(input.payload, ['code'])) return undefined;
    if (
      input.payload.code !== 'stream_overflow' &&
      input.payload.code !== 'stream_failed'
    ) return undefined;
    return {
      protocolVersion: REPLICA_PROTOCOL_VERSION,
      kind: input.kind,
      identity,
      payload: { code: input.payload.code },
    };
  }
  if (input.kind !== 'simul:replica-v2:batch') return undefined;
  if (
    !isRecordWithExactKeys(input.payload, [
      'firstSequence',
      'events',
      'byteLength',
    ]) ||
    !Number.isSafeInteger(input.payload.firstSequence) ||
    Number(input.payload.firstSequence) < 1 ||
    !Array.isArray(input.payload.events) ||
    input.payload.events.length < 1 ||
    input.payload.events.length > MAX_REPLICA_LIVE_EVENTS_PER_BATCH ||
    !Number.isSafeInteger(input.payload.byteLength) ||
    Number(input.payload.byteLength) < 1 ||
    Number(input.payload.byteLength) > MAX_REPLICA_LIVE_BATCH_BYTES
  ) return undefined;
  const firstSequence = Number(input.payload.firstSequence);
  if (identity.sequence !== firstSequence + input.payload.events.length - 1) {
    return undefined;
  }
  for (const event of input.payload.events) {
    const bytes = jsonByteLength(event);
    if (bytes < 1 || bytes > MAX_REPLICA_LIVE_EVENT_BYTES) return undefined;
  }
  if (jsonByteLength(input.payload.events) !== input.payload.byteLength) {
    return undefined;
  }
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: input.kind,
    identity,
    payload: {
      firstSequence,
      events: Object.freeze([...input.payload.events]),
      byteLength: Number(input.payload.byteLength),
    },
  };
}

export function liveBatchFromEnvelope(
  envelope: ReplicaLiveBatchEnvelope,
): ReplicaLiveBatch {
  return {
    identity: envelope.identity,
    firstSequence: envelope.payload.firstSequence,
    lastSequence: envelope.identity.sequence,
    events: envelope.payload.events,
    byteLength: envelope.payload.byteLength,
  };
}

export function createLiveStreamError(
  identity: ReplicaDocumentIdentity,
  code: ReplicaLiveErrorEnvelope['payload']['code'],
): ReplicaLiveErrorEnvelope {
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:stream-error',
    identity,
    payload: { code },
  };
}

export function sameReplicaDocument(
  left: ReplicaDocumentIdentity,
  right: ReplicaDocumentIdentity,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.sessionId === right.sessionId &&
    left.pageEpoch === right.pageEpoch &&
    left.generation === right.generation &&
    left.documentId === right.documentId &&
    left.frameId === right.frameId
  );
}

function withSequence(
  identity: ReplicaDocumentIdentity,
  sequence: number,
): ReplicaDocumentIdentity {
  return createReplicaIdentity({
    sessionId: identity.sessionId,
    pageEpoch: identity.pageEpoch,
    generation: identity.generation,
    documentId: identity.documentId,
    frameId: identity.frameId,
    sequence,
  });
}

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isSafeToken(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isRecordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}
