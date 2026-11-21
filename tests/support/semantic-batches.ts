import {
  applySemanticSourceOrderPlacements,
  semanticSourceProofIdentity,
  type SemanticSourceBatch,
  type SemanticSourceProof,
  type SemanticSourceRecord,
} from '../../lib/replica/semantic-source-protocol';

/**
 * The page's whole state after `batch`, as a batch of the whole state: a
 * batch of what changed (D179) applied to the whole state before it. Throws
 * when it does not fit, as the receiver refuses it.
 */
export function wholeSemanticBatch(
  previous: SemanticSourceBatch | undefined,
  batch: SemanticSourceBatch,
): SemanticSourceBatch {
  const delta = batch.delta;
  if (!delta) return batch;
  if (!previous || previous.sequence !== delta.base) {
    throw new Error('A batch of what changed without the batch before it.');
  }
  const records = new Map<number, SemanticSourceRecord>(
    previous.records.map((record) => [record.recordId, record]),
  );
  for (const recordId of delta.removedRecordIds) {
    if (!records.delete(recordId)) throw new Error('A removed record was not there.');
  }
  for (const record of batch.records) records.set(record.recordId, record);
  const proofs = new Map<string, SemanticSourceProof>(
    previous.proofs.map((proof) => [semanticSourceProofIdentity(proof), proof]),
  );
  for (const proofId of delta.removedProofIds) {
    if (!proofs.delete(proofId)) throw new Error('A removed proof was not there.');
  }
  for (const proof of batch.proofs) proofs.set(semanticSourceProofIdentity(proof), proof);
  const recordOrder = applySemanticSourceOrderPlacements(
    previous.records.map(({ recordId }) => recordId),
    new Set(delta.removedRecordIds),
    delta.recordPlacements,
    0,
  );
  const proofOrder = applySemanticSourceOrderPlacements(
    previous.proofs.map(semanticSourceProofIdentity),
    new Set(delta.removedProofIds),
    delta.proofPlacements,
    '',
  );
  if (
    !recordOrder || !proofOrder || recordOrder.length !== records.size ||
    proofOrder.length !== proofs.size || recordOrder.length !== delta.recordCount ||
    proofOrder.length !== delta.proofCount
  ) throw new Error('A batch of what changed that does not fit.');
  const { delta: _delta, ...rest } = batch;
  return Object.freeze({
    ...rest,
    records: Object.freeze(recordOrder.map((recordId) => records.get(recordId)!)),
    proofs: Object.freeze(proofOrder.map((proofId) => proofs.get(proofId)!)),
  });
}
