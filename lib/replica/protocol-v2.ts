import {
  REPLICA_PROTOCOL_VERSION,
  type ReplicaDocumentIdentity,
} from './contracts';

/**
 * Replica document identity shared by the isolated HTML mirror and the OCR
 * image-source bridge. The identity is exact: one session, one page epoch,
 * one document, one frame, and a monotonic sequence.
 */
export function createReplicaIdentity(
  value: Omit<ReplicaDocumentIdentity, 'protocolVersion'>,
): ReplicaDocumentIdentity {
  return Object.freeze({
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    ...value,
  });
}

export function readReplicaIdentity(
  input: unknown,
): ReplicaDocumentIdentity | undefined {
  if (
    !isRecordWithExactKeys(input, [
      'protocolVersion',
      'sessionId',
      'pageEpoch',
      'generation',
      'documentId',
      'frameId',
      'sequence',
    ]) ||
    input.protocolVersion !== REPLICA_PROTOCOL_VERSION ||
    !isSafeToken(input.sessionId) ||
    !isBoundedInteger(input.pageEpoch, 1, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(input.generation, 1, Number.MAX_SAFE_INTEGER) ||
    input.pageEpoch !== input.generation ||
    !isSafeToken(input.documentId) ||
    !isBoundedInteger(input.frameId, 0, 1_000_000) ||
    !isBoundedInteger(input.sequence, 0, Number.MAX_SAFE_INTEGER)
  ) return undefined;
  return createReplicaIdentity({
    sessionId: input.sessionId,
    pageEpoch: input.pageEpoch,
    generation: input.generation,
    documentId: input.documentId,
    frameId: input.frameId,
    sequence: input.sequence,
  });
}

export function sameReplicaIdentity(
  left: ReplicaDocumentIdentity,
  right: ReplicaDocumentIdentity,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.sessionId === right.sessionId &&
    left.pageEpoch === right.pageEpoch &&
    left.generation === right.generation &&
    left.documentId === right.documentId &&
    left.frameId === right.frameId &&
    left.sequence === right.sequence
  );
}

function isSafeToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}
