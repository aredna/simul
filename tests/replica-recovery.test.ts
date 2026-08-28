import { describe, expect, it } from 'vitest';

import { emptyReplicaDiagnostics } from '../lib/replica/contracts';
import {
  isCommittedPrimaryReplica,
  IsolatedReplicaFailureRecoveryGate,
  shouldPreserveCommittedReplicaForCapture,
} from '../lib/replica/replica-recovery';

describe('isolated replica commit qualification', () => {
  it('recognizes only completed isolated replicas with a retained committed lease', () => {
    const isolatedComplete = {
      status: 'complete' as const,
      diagnostics: emptyReplicaDiagnostics(
        'isolated-html-v1',
        'isolated_complete',
      ),
    };
    const isolatedStale = {
      status: 'skipped' as const,
      diagnostics: emptyReplicaDiagnostics(
        'isolated-html-v1',
        'stale_identity',
      ),
    };
    const isolatedFailed = {
      status: 'failed' as const,
      diagnostics: emptyReplicaDiagnostics(
        'isolated-html-v1',
        'stream_failed',
      ),
    };

    expect(isCommittedPrimaryReplica(isolatedComplete, false)).toBe(false);
    expect(isCommittedPrimaryReplica(isolatedComplete, true)).toBe(true);
    expect(isCommittedPrimaryReplica(isolatedStale, true)).toBe(false);
    expect(isCommittedPrimaryReplica(isolatedFailed, true)).toBe(false);
  });
});

describe('live replica failure recovery gate', () => {
  it('allows one last-good rebuild and surfaces a terminal error if failure repeats', () => {
    const gate = new IsolatedReplicaFailureRecoveryGate();

    expect(gate.decide(true)).toBe('rebuild-last-good');
    expect(gate.decide(true)).toBe('terminal-error');

    gate.markCommitted();
    expect(gate.decide(true)).toBe('rebuild-last-good');
    gate.reset();
    expect(gate.decide(false)).toBe('terminal-error');
  });

  it('preserves last-good only for same-page manual or recovery captures', () => {
    expect(shouldPreserveCommittedReplicaForCapture(
      'desynchronized',
      true,
      true,
    )).toBe(true);
    expect(shouldPreserveCommittedReplicaForCapture('manual', true, true)).toBe(
      true,
    );
    expect(shouldPreserveCommittedReplicaForCapture(
      'navigation',
      true,
      true,
    )).toBe(false);
    expect(shouldPreserveCommittedReplicaForCapture('manual', false, true)).toBe(
      false,
    );
  });
});
