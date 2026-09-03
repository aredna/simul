import type { ReplicaSourceCommit } from './replica-translation-coordinator';

export interface ReplicaSourceCommitAction {
  readonly prepareForNewText: boolean;
  readonly refreshDetectedLanguage: boolean;
}

/**
 * Apply a live document-language update to the captured snapshot without
 * changing its object identity unless the language actually changed. In-flight
 * availability checks are keyed on snapshot identity, so a gratuitous copy on
 * every live commit would silently discard their results.
 */
export function snapshotWithLiveDocumentLanguage<
  Snapshot extends { readonly documentLanguage?: string },
>(snapshot: Snapshot, documentLanguage: string | undefined): Snapshot {
  const next = documentLanguage || undefined;
  if ((snapshot.documentLanguage || undefined) === next) return snapshot;
  const { documentLanguage: _previous, ...rest } = snapshot;
  return (next ? { ...rest, documentLanguage: next } : rest) as Snapshot;
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
