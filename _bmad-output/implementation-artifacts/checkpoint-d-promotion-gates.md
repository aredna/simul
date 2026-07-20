# Checkpoint D Promotion Gates

Checkpoint D remains development-only. The checked production artifact and
all unflagged builds still select `legacy-v1`; no default promotion is claimed
until every blocking Chrome row below passes in an installed extension.

| Gate | Evidence | Result |
|---|---|---|
| Source isolation | Unit contracts reject stale document, revision, pair, epoch, lease, and node-type work; source values are never derived from rendered translations. | Automated pass |
| Private text | Source-model fixtures exclude private-control and style canaries before provider scheduling. Existing dual rrweb validators remain authoritative. | Automated pass |
| ACK independence | Engine tests observe checkpoint/batch ACK state before the source-commit callback can enqueue provider work. | Automated pass |
| Incremental text | Cast-complete text events advance one node revision; equal writes request cache-backed re-projection without inventing a revision. | Automated pass |
| Non-text work | Canonical batch transactions emit no text changes for scroll/style-only events, so the coordinator schedules no translation calls. | Automated pass |
| Cache/recovery | Pair/provider exact-source memory deduplicates work; current projections reapply to a same-document recovery candidate before atomic swap. | Automated pass |
| Cancellation/partial results | Coordinator tests propagate caller cancellation during session creation and node work. Failed, stale, superseded, and overflow work all keep the completion predicate false. | Automated pass |
| Bounds/fallback | Tests exercise bounded completed-cache values, in-flight requests, initial translation admission, and live queue eviction; existing one-recovery and legacy fallback tests pass. | Automated pass |
| Live result currentness | Coordinator tests notify once for a multi-commit drain, reject obsolete lease results, and give a user pass its own progress after waiting for background work. | Automated pass |
| Language lifecycle | Pure scheduling tests prepare a late first-text upsert and refresh automatic detection for eligible upserts/removals or changed HTML language. The 20k sample builder stops consuming records when full. | Automated pass |
| Projection layout | Engine tests restore actual mirror source text, reject every projection identity dimension, and coalesce projection/source extent refreshes. | Automated pass |
| Production authority | Flagged production build succeeds and its manifest is byte-identical to the checked installable manifest. Runtime selection still requires `DEV` plus both rrweb flags. | Automated pass |
| Mexico City fidelity/network | Exercise carousel/background changes, landmarks, requests, scroll, actions, source isolation, and fallback in installed Chrome. | **Pending manual Chrome** |
| Reddit fidelity/network | Exercise left login rail, right related rail, shadow/custom elements, landmarks, requests, scroll, actions, source isolation, and fallback in installed Chrome. | **Pending manual Chrome** |

Because the two target-site rows are pending, the promotion decision is
**keep legacy as production default**. The rollback remains omission of either
`WXT_SIMUL_RRWEB_SHADOW=1` or `WXT_SIMUL_RRWEB_TRANSLATION=1` in a development
session; production ignores both because the rrweb path additionally requires
`import.meta.env.DEV === true`.
