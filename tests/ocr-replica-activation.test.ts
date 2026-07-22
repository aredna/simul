import { describe, expect, it, vi } from 'vitest';

import {
  activateImageReplicaAfterRun,
  imageReplicaActivationFailureReason,
} from '../lib/ocr/replica-activation';

describe('post-run OCR replica activation', () => {
  it('activates exactly once only after a matching committed run settles', () => {
    const activate = vi.fn(() => true);

    expect(activateImageReplicaAfterRun({
      runStatus: 'complete',
      hasCommittedReplica: true,
      aborted: false,
      modeMatches: true,
      requestCurrent: true,
      snapshotAvailable: true,
      snapshotMatches: true,
      activate,
    })).toEqual({ status: 'activated' });
    expect(activate).toHaveBeenCalledOnce();
  });

  it.each([
    ['failed run', { runStatus: 'failed' }, 'run-failed'],
    ['skipped run', { runStatus: 'skipped' }, 'run-skipped'],
    ['no commit', { hasCommittedReplica: false }, 'not-committed'],
    ['aborted request', { aborted: true }, 'stale'],
    ['stale request', { requestCurrent: false }, 'stale'],
    ['engine switch', { modeMatches: false }, 'engine-changed'],
    ['no snapshot', { snapshotAvailable: false }, 'snapshot-unavailable'],
    ['mismatched snapshot', { snapshotMatches: false }, 'snapshot-mismatch'],
  ] as const)('reports %s without opening an image source', (
    _label,
    patch,
    reason,
  ) => {
    const activate = vi.fn(() => true);
    const options = {
      runStatus: 'complete' as const,
      hasCommittedReplica: true,
      aborted: false,
      modeMatches: true,
      requestCurrent: true,
      snapshotAvailable: true,
      snapshotMatches: true,
      activate,
      ...patch,
    };

    expect(activateImageReplicaAfterRun(options)).toEqual({
      status: 'not-activated',
      reason,
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it('reports a bounded rejection when the controller refuses activation', () => {
    expect(activateImageReplicaAfterRun({
      runStatus: 'complete',
      hasCommittedReplica: true,
      aborted: false,
      modeMatches: true,
      requestCurrent: true,
      snapshotAvailable: true,
      snapshotMatches: true,
      activate: () => false,
    })).toEqual({
      status: 'not-activated',
      reason: 'activation-rejected',
    });
  });

  it('classifies thrown work without misreporting post-activation UI errors', () => {
    expect(imageReplicaActivationFailureReason({
      aborted: true,
      requestCurrent: true,
      modeMatches: true,
      engineRunSettled: false,
    })).toBe('stale');
    expect(imageReplicaActivationFailureReason({
      aborted: false,
      requestCurrent: true,
      modeMatches: false,
      engineRunSettled: false,
    })).toBe('engine-changed');
    expect(imageReplicaActivationFailureReason({
      aborted: false,
      requestCurrent: true,
      modeMatches: true,
      engineRunSettled: false,
    })).toBe('run-failed');
    expect(imageReplicaActivationFailureReason({
      aborted: false,
      requestCurrent: true,
      modeMatches: true,
      engineRunSettled: true,
    })).toBe('activation-rejected');
  });
});
