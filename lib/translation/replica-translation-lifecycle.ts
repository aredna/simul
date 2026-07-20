import type { ReplicaSourceCommit } from './replica-translation-coordinator';

export interface ReplicaSourceCommitAction {
  readonly prepareForNewText: boolean;
  readonly refreshDetectedLanguage: boolean;
}

/** Pure scheduling decision for live source commits in the side panel. */
export function replicaSourceCommitAction(
  commit: ReplicaSourceCommit,
  automaticSourceLanguage: boolean,
): ReplicaSourceCommitAction {
  const liveChanges = commit.reason !== 'checkpoint'
    ? commit.changes
    : [];
  const prepareForNewText = liveChanges.some(
    (change) =>
      change.kind === 'upsert' && change.record.source.trim().length > 0,
  );
  const hasEligibleTextChange = liveChanges.some(
    (change) =>
      change.kind === 'remove' || change.record.source.trim().length > 0,
  );
  return {
    prepareForNewText,
    refreshDetectedLanguage:
      automaticSourceLanguage &&
      (commit.documentLanguageChanged || hasEligibleTextChange),
  };
}
