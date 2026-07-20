import { describe, expect, it } from 'vitest';

import { emptyReplicaDiagnostics } from '../lib/replica/contracts';
import {
  isCommittedShadowReplica,
  LegacyTransitionGate,
  LiveReplicaFailureRecoveryGate,
  shouldPreserveCommittedReplicaForCapture,
  shouldReleaseReplicaAfterCaptureFailure,
} from '../lib/replica/legacy-transition-gate';

describe('legacy transition gate', () => {
  it('coalesces any live-preview dirtiness into one fresh legacy capture', () => {
    const gate = new LegacyTransitionGate();
    gate.beginShadowOwnership();

    expect(gate.markDirty()).toBe(true);
    expect(gate.markDirty()).toBe(true);

    expect(gate.release()).toBe(true);
    expect(gate.shadowOwnsPage).toBe(false);
    expect(gate.release()).toBe(false);
  });

  it('can reset a stale document without requesting legacy work', () => {
    const gate = new LegacyTransitionGate();
    gate.beginShadowOwnership();
    gate.markDirty();

    gate.reset();

    expect(gate.release()).toBe(false);
  });

  it('covers hidden staging and ignores dirtiness after legacy takes ownership', () => {
    const gate = new LegacyTransitionGate();

    gate.beginShadowOwnership();
    expect(gate.shadowOwnsPage).toBe(true);
    expect(gate.markDirty()).toBe(true);
    expect(gate.release()).toBe(true);
    expect(gate.markDirty()).toBe(false);
    expect(gate.release()).toBe(false);
  });

  it('recognizes only completed selected replicas with a retained committed lease', () => {
    const legacyComplete = {
      status: 'complete' as const,
      diagnostics: emptyReplicaDiagnostics('legacy-v1', 'legacy_selected'),
    };
    const rrwebComplete = {
      status: 'complete' as const,
      diagnostics: emptyReplicaDiagnostics('rrweb-shadow-v2', 'shadow_complete'),
    };
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

    expect(isCommittedShadowReplica(legacyComplete, true)).toBe(false);
    expect(isCommittedShadowReplica(rrwebComplete, false)).toBe(false);
    expect(isCommittedShadowReplica(rrwebComplete, true)).toBe(true);
    expect(isCommittedShadowReplica(isolatedComplete, false)).toBe(false);
    expect(isCommittedShadowReplica(isolatedComplete, true)).toBe(true);
    expect(isCommittedShadowReplica(isolatedStale, true)).toBe(false);
    expect(isCommittedShadowReplica(isolatedFailed, true)).toBe(false);
  });
});

describe('live replica failure recovery gate', () => {
  it('allows one last-good rebuild and falls back if failure repeats', () => {
    const gate = new LiveReplicaFailureRecoveryGate();

    expect(gate.decide(true)).toBe('rebuild-last-good');
    expect(gate.decide(true)).toBe('fallback');

    gate.markCommitted();
    expect(gate.decide(true)).toBe('rebuild-last-good');
    gate.reset();
    expect(gate.decide(false)).toBe('fallback');
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

  it('does not erase a committed replica when later capture work fails', () => {
    expect(shouldReleaseReplicaAfterCaptureFailure(true, true, true)).toBe(
      false,
    );
    expect(shouldReleaseReplicaAfterCaptureFailure(true, true, false)).toBe(
      true,
    );
    expect(shouldReleaseReplicaAfterCaptureFailure(false, true, false)).toBe(
      false,
    );
    expect(shouldReleaseReplicaAfterCaptureFailure(true, false, false)).toBe(
      false,
    );
  });
});
