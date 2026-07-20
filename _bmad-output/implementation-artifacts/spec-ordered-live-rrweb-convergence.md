---
title: 'Converge the rrweb replica with ordered live events'
type: 'feature'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'ee3153034e6bafd303df735a61d29668044eb49e'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-visible-staged-rrweb-replica.md'
  - '{project-root}/_bmad-output/planning-artifacts/research/technical-live-dom-replication-ocr-extension-access-research-2026-07-19.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Checkpoint B displays an rrweb copy only at capture time and abandons it on the first page change. It needs ordered delivery, applied-state ACKs, and bounded recovery to remain current.

**Approach:** Under the existing development flag, retain one masked recorder per source document and apply sanitized events serially over exact-document Ports. Recover gaps with a hidden checkpoint and catch-up before an atomic swap.

## Boundaries & Constraints

**Always:** Preserve document/session/generation identity; ACK only the highest contiguous sequence after rrweb `event-cast` and candidate commit; use one recorder with independent subscriber watermarks; bound all queues and retries; validate twice with stateful private-node ancestry; keep the source read-only and replay protected, resource-inert, untranslated, and local; retain last-good until replacement; keep production and unflagged development on v1.

**Ask First:** New permissions, hosts, CSP, resource traffic, weaker privacy/size/deadline limits, checkpoint chunking, translation in rrweb, or production/default promotion.

**Never:** Relay through the service worker, drop/reorder admitted events, ACK receipt, leak controls/contenteditable, run scripts/interactions/canvas, restore URLs, mutate the source, loop recovery, or include OCR.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Ordered page | Checkpoint then contiguous batches | Catch up hidden, commit once, update in place, cumulatively ACK | Cast timeout keeps last-good and recovers once |
| Slow viewer | Shared recorder; separate ACK | Targeted checkpoint joins without rebuilding fast viewers | Pressure resyncs only the lagger |
| Gap/bad event | Missing sequence, overflow, malformed data, unknown node | Freeze subscriber; checkpoint at current sequence | Failed recovery uses bounded fallback without blanking first |
| Navigation | Old work settles after identity changes | Only exact new document can stage/commit | Reject before `addEvent`; never ACK |
| Private/unsafe | Private values, executable nodes, URLs, CSS resources | Mask, strip, or reject | Never partially replay a batch |
| Legacy operation | Production, no flag, translation, or v1 fallback | Existing v1 remains authoritative | Disconnect stream before v1 DOM work |

</frozen-after-approval>

## Code Map

- `lib/replica/live-protocol.ts`, `lib/replica/rrweb-stream-sanitizer.ts` -- envelopes, limits, allowlist, privacy/resource validation.
- `lib/replica/live-recorder-session.ts`, `lib/replica/page-recorder.ts` -- recorder, ACK/history state, checkout, Port bridge.
- `lib/replica/contracts.ts`, `lib/replica/live-stream-client.ts` -- stream lease and Chrome adapter.
- `lib/replica/rrweb-shadow-engine.ts`, `lib/replica/visible-replay-host.ts` -- live apply barrier, recovery candidates, extent, label.
- `entrypoints/sidepanel/main.ts`, `tests/` -- lifecycle/fallback wiring and coverage.

## Tasks & Acceptance

**Execution:**
- [x] `lib/replica/live-protocol.ts`, `lib/replica/rrweb-stream-sanitizer.ts` -- add dual-validated messages and safe incremental projection.
- [x] `lib/replica/live-recorder-session.ts`, `lib/replica/page-recorder.ts` -- multiplex, frame-batch, bound backpressure, and checkpoint laggers.
- [x] `lib/replica/contracts.ts`, `lib/replica/live-stream-client.ts`, `entrypoints/sidepanel/main.ts` -- own exact-document Ports through navigation/fallback/teardown.
- [x] `lib/replica/rrweb-shadow-engine.ts`, `lib/replica/visible-replay-host.ts` -- wait for event-cast, ACK applied sequences, refresh extent, and swap caught-up candidates.
- [x] `tests/`, `_bmad-output/project-context.md`, `dist/chrome-unpacked/` -- cover the matrix, document C, and artifact-sync after validation.

**Acceptance Criteria:**
- Given a flagged current document, when DOM/CSS/scroll batches are contiguous, then one protected live/untranslated replica converges without full rebuilds.
- Given multiple viewers or a lag/gap/race, when recovery runs, then ACKs stay independent, fast viewers continue, stale work cannot commit, and state stays bounded.
- Given private/resource mutations, when both validators run, then canaries and replay-origin requests remain absent.
- Given production, no flag, translation, or failed recovery, when selected, then v1 authority is unchanged and fallback occurs once.

## Spec Change Log

## Design Notes

One masked rrweb recorder is shared per source document. Animation-frame batches stream Mutation, Scroll, StyleSheetRule, StyleDeclaration, and sanitized AdoptedStyleSheet events; resize and uncertain mutations request an authoritative checkpoint. Private/nonvisual tails are ignored without sequence numbers, while unknown or malformed sources resync.

Port delivery is not commit proof. A subscriber stays paused after each checkpoint until its exact checkpoint ACK, then receives at most four contiguous retained batches or rolls forward to a newer checkpoint. Receiver ACKs advance only after rrweb emits `event-cast`; recovery stages a hidden candidate and atomically swaps it while stale runs can release only their own candidate.

CSS is canonicalized through CSSOM and validated against tracked rule topology on both sides. Source imports are represented by one index-stable wrapper; inaccessible cross-origin rules retain their already stripped serialization, while import/namespace ambiguity fails closed. Constructed stylesheet IDs are capped at 4,096 and require an all-subscriber ACK barrier before a checkout resets their namespace.

Bounds: 128 events/256 KiB per batch, 128 KiB per event, 64 batches/2 MiB history, four unACKed batches per subscriber, 16 subscribers, 50,000 tracked CSS rules, and the existing 8 MiB atomic checkpoint. Healthy long-lived replays rotate at 64 applied batches or 2 MiB. Recovery is limited to one attempt per incident with a deadline.

## Verification

**Commands:**
- `npm run artifact:sync` -- refreshed the validated installable Chrome artifact.
- `npm run check` -- passed TypeScript, 21 test files / 264 tests, production build, and exact artifact comparison.
- `git diff --exit-code ee3153034e6bafd303df735a61d29668044eb49e -- dist/chrome-unpacked/manifest.json` -- confirmed production permissions and manifest authority are unchanged.

**Manual Chrome check:**
- Not run in this workspace. With `WXT_SIMUL_RRWEB_SHADOW=1 npm run dev`, mutate DOM/CSS/scroll, resize, and navigate in both views; confirm convergence, atomic recovery, masking, no replay traffic, and exact-once cleanup.

## Suggested Review Order

**Live ownership and atomic replay**

- Start with the exact-document stream lifecycle and atomic candidate promotion.
  [`rrweb-shadow-engine.ts:123`](../../lib/replica/rrweb-shadow-engine.ts#L123)

- ACK only cast events, then recover through a hidden bounded candidate.
  [`rrweb-shadow-engine.ts:430`](../../lib/replica/rrweb-shadow-engine.ts#L430)

- Wire live failure, scrolling, and legacy ownership at the companion boundary.
  [`main.ts:177`](../../entrypoints/sidepanel/main.ts#L177)

**Ordered transport and recovery**

- Share one recorder while retaining independent subscriber watermarks and queues.
  [`live-recorder-session.ts:61`](../../lib/replica/live-recorder-session.ts#L61)

- Pause checkpoint delivery until applied-state ACK, then bound catch-up.
  [`live-recorder-session.ts:406`](../../lib/replica/live-recorder-session.ts#L406)

- Bind and validate the document-targeted Chrome Port bridge.
  [`page-recorder.ts:90`](../../lib/replica/page-recorder.ts#L90)

- Reject malformed, stale, regressing, or oversized recorder messages.
  [`live-stream-client.ts:181`](../../lib/replica/live-stream-client.ts#L181)

**Privacy and CSS convergence**

- Transactionally validate private ancestry, identity, and CSS topology twice.
  [`rrweb-stream-sanitizer.ts:120`](../../lib/replica/rrweb-stream-sanitizer.ts#L120)

- Preserve rule indexes across imports and fail closed on unsafe preludes.
  [`live-recorder-session.ts:668`](../../lib/replica/live-recorder-session.ts#L668)

- Neutralize CSS resources with a token-aware parser instead of regex rewriting.
  [`protocol-v2.ts:827`](../../lib/replica/protocol-v2.ts#L827)

**Fallback and evidence**

- Keep shadow gating disabled after fallback so v1 behavior remains unchanged.
  [`engine-selection.ts:48`](../../lib/replica/engine-selection.ts#L48)

- Exercise forward checkpoints, paused catch-up, and active-page rollover.
  [`live-recorder-session.test.ts:456`](../../tests/live-recorder-session.test.ts#L456)

- Prove superseded recovery cannot revoke a newer candidate.
  [`replica-engine.test.ts:562`](../../tests/replica-engine.test.ts#L562)

- Record the durable Checkpoint C ownership and safety boundaries.
  [`project-context.md:17`](../project-context.md#L17)
