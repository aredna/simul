import { describe, expect, it } from 'vitest';

import type { ReplicaSourceTextRecord } from '../lib/replica/source-value-model';
import { replicaSourceCommitAction } from '../lib/translation/replica-translation-lifecycle';
import type { ReplicaSourceCommit } from '../lib/translation/replica-translation-coordinator';

const documentIdentity = {
  sessionId: 'session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'document',
  frameId: 0,
} as const;

describe('replicaSourceCommitAction', () => {
  it('prepares a late eligible upsert after an initially empty checkpoint', () => {
    expect(replicaSourceCommitAction(commit('checkpoint', []), true)).toEqual({
      prepareForNewText: false,
      refreshDetectedLanguage: false,
    });
    expect(replicaSourceCommitAction(
      commit('batch', [{ kind: 'upsert', record: text('Hola') }]),
      true,
    )).toEqual({
      prepareForNewText: true,
      refreshDetectedLanguage: true,
    });
  });

  it('refreshes automatic detection for removals and html language changes', () => {
    expect(replicaSourceCommitAction(
      commit('batch', [{
        kind: 'remove',
        document: documentIdentity,
        nodeId: 4,
        revision: 2,
      }]),
      true,
    ).refreshDetectedLanguage).toBe(true);
    expect(replicaSourceCommitAction({
      ...commit('batch', []),
      documentLanguageChanged: true,
    }, true).refreshDetectedLanguage).toBe(true);
  });

  it('does not detect from whitespace or refresh auto detection for explicit source', () => {
    expect(replicaSourceCommitAction(
      commit('batch', [{ kind: 'upsert', record: text('  ') }]),
      true,
    )).toEqual({
      prepareForNewText: false,
      refreshDetectedLanguage: false,
    });
    expect(replicaSourceCommitAction(
      commit('batch', [{ kind: 'upsert', record: text('Hola') }]),
      false,
    )).toEqual({
      prepareForNewText: true,
      refreshDetectedLanguage: false,
    });
  });
});

function commit(
  reason: ReplicaSourceCommit['reason'],
  changes: ReplicaSourceCommit['changes'],
): ReplicaSourceCommit {
  return {
    document: documentIdentity,
    documentLanguageChanged: false,
    replayLease: 1,
    records: changes.flatMap((change) =>
      change.kind === 'upsert' ? [change.record] : []),
    changes,
    reason,
  };
}

function text(source: string): ReplicaSourceTextRecord {
  return {
    document: documentIdentity,
    nodeId: 4,
    nodeType: 3,
    revision: 1,
    source,
  };
}
