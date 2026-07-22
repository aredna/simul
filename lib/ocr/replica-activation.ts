export const IMAGE_REPLICA_NOT_ACTIVATED_REASONS = Object.freeze([
  'document-unavailable',
  'run-failed',
  'run-skipped',
  'not-committed',
  'stale',
  'engine-changed',
  'snapshot-unavailable',
  'snapshot-mismatch',
  'activation-rejected',
] as const);

export type ImageReplicaNotActivatedReason =
  (typeof IMAGE_REPLICA_NOT_ACTIVATED_REASONS)[number];

export type ImageReplicaActivationResult =
  | { readonly status: 'activated' }
  | {
      readonly status: 'not-activated';
      readonly reason: ImageReplicaNotActivatedReason;
    };

export interface PostRunImageReplicaActivationOptions {
  readonly runStatus: 'complete' | 'failed' | 'skipped';
  readonly hasCommittedReplica: boolean;
  readonly aborted: boolean;
  readonly modeMatches: boolean;
  readonly requestCurrent: boolean;
  readonly snapshotAvailable: boolean;
  readonly snapshotMatches: boolean;
  readonly activate: () => boolean;
}

export interface ImageReplicaActivationFailureState {
  readonly aborted: boolean;
  readonly requestCurrent: boolean;
  readonly modeMatches: boolean;
  readonly engineRunSettled: boolean;
}

/** The sole initial OCR activation boundary after an engine run settles. */
export function activateImageReplicaAfterRun(
  options: PostRunImageReplicaActivationOptions,
): ImageReplicaActivationResult {
  if (options.runStatus === 'failed') return notActivated('run-failed');
  if (options.runStatus === 'skipped') return notActivated('run-skipped');
  if (!options.hasCommittedReplica) return notActivated('not-committed');
  if (options.aborted || !options.requestCurrent) return notActivated('stale');
  if (!options.modeMatches) return notActivated('engine-changed');
  if (!options.snapshotAvailable) return notActivated('snapshot-unavailable');
  if (!options.snapshotMatches) return notActivated('snapshot-mismatch');
  return options.activate()
    ? Object.freeze({ status: 'activated' })
    : notActivated('activation-rejected');
}

/** Classifies an exception without claiming a settled activation was absent. */
export function imageReplicaActivationFailureReason(
  state: ImageReplicaActivationFailureState,
): ImageReplicaNotActivatedReason {
  if (state.aborted || !state.requestCurrent) return 'stale';
  if (!state.modeMatches) return 'engine-changed';
  return state.engineRunSettled ? 'activation-rejected' : 'run-failed';
}

function notActivated(
  reason: ImageReplicaNotActivatedReason,
): ImageReplicaActivationResult {
  return Object.freeze({ status: 'not-activated', reason });
}
