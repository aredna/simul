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

  it('stops rebuilding a page whose stream fails after every commit', () => {
    let now = 0;
    const gate = new IsolatedReplicaFailureRecoveryGate({
      maxRebuilds: 3,
      windowMs: 60_000,
      now: () => now,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(gate.decide(true)).toBe('rebuild-last-good');
      gate.markCommitted();
      now += 1_000;
    }
    expect(gate.decide(true)).toBe('terminal-error');
    gate.markCommitted();
    expect(gate.decide(true)).toBe('terminal-error');

    // The budget is a sliding window: once the oldest rebuild ages out, one
    // more is allowed, and a new page starts fresh.
    now += 57_500;
    expect(gate.decide(true)).toBe('rebuild-last-good');
    gate.markCommitted();
    expect(gate.decide(true)).toBe('terminal-error');
    gate.reset();
    expect(gate.decide(true)).toBe('rebuild-last-good');
  });

  it('keeps the single retry for one failure after a good commit', () => {
    let now = 0;
    const gate = new IsolatedReplicaFailureRecoveryGate({ now: () => now });

    expect(gate.decide(true)).toBe('rebuild-last-good');
    gate.markCommitted();
    now += 120_000;
    expect(gate.decide(true)).toBe('rebuild-last-good');
    expect(gate.decide(true)).toBe('terminal-error');
  });

  it('falls back to the default budget for unusable options', () => {
    let now = 0;
    const gate = new IsolatedReplicaFailureRecoveryGate({
      maxRebuilds: Number.NaN,
      windowMs: 0,
      now: () => now,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(gate.decide(true)).toBe('rebuild-last-good');
      gate.markCommitted();
      now += 1;
    }
    expect(gate.decide(true)).toBe('terminal-error');
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
