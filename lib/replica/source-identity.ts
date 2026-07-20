import type { ReplicaDocumentIdentity } from './contracts';

/** Identity shared by canonical text and derived image records. */
export interface ReplicaSourceDocumentIdentity {
  readonly sessionId: string;
  readonly pageEpoch: number;
  readonly generation: number;
  readonly documentId: string;
  readonly frameId: number;
}

const SOURCE_IDENTITY_KEYS = Object.freeze([
  'sessionId',
  'pageEpoch',
  'generation',
  'documentId',
  'frameId',
] as const);

export function readSourceDocumentIdentity(
  input: unknown,
): ReplicaSourceDocumentIdentity | undefined {
  if (!isRecordWithExactKeys(input, SOURCE_IDENTITY_KEYS)) return undefined;
  if (
    !isSafeToken(input.sessionId) ||
    !isBoundedInteger(input.pageEpoch, 1, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(input.generation, 1, Number.MAX_SAFE_INTEGER) ||
    input.pageEpoch !== input.generation ||
    !isSafeToken(input.documentId) ||
    !isBoundedInteger(input.frameId, 0, 1_000_000)
  ) return undefined;
  return Object.freeze({
    sessionId: input.sessionId,
    pageEpoch: input.pageEpoch,
    generation: input.generation,
    documentId: input.documentId,
    frameId: input.frameId,
  });
}

export function sourceDocumentIdentity(
  identity: ReplicaDocumentIdentity,
): ReplicaSourceDocumentIdentity {
  const source = readSourceDocumentIdentity({
    sessionId: identity.sessionId,
    pageEpoch: identity.pageEpoch,
    generation: identity.generation,
    documentId: identity.documentId,
    frameId: identity.frameId,
  });
  if (!source) throw new Error('Invalid replica source document identity.');
  return source;
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
  return Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum;
}

function isRecordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function sameSourceDocument(
  left: ReplicaSourceDocumentIdentity,
  right: ReplicaSourceDocumentIdentity,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.pageEpoch === right.pageEpoch &&
    left.generation === right.generation &&
    left.documentId === right.documentId &&
    left.frameId === right.frameId
  );
}
