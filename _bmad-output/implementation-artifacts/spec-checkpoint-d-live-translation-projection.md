---
title: 'Checkpoint D: Live Translation Projection and Promotion Gate'
type: 'feature'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-ordered-live-rrweb-convergence.md'
  - '{project-root}/_bmad-output/planning-artifacts/research/technical-live-dom-replication-ocr-extension-access-research-2026-07-19.md'
baseline_commit: '983f0978cad732f56e9b67340363fb5d9d2b42ef'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Checkpoint C keeps an exact-document rrweb replica converged, but translating tears it down for the lower-fidelity legacy snapshot. Results lack live-node revisions, so asynchronous work cannot safely survive page, language, or recovery changes.

**Approach:** Keep revisioned canonical source values, translate only committed changes through a bounded coordinator, and project current results into matching replay nodes without touching the source stream. Ship behind a development flag; promote only after recorded Chrome gates pass.

## Boundaries & Constraints

**Always:** Capture/replay ACK never waits for translation. Canonical values use exact document identity, rrweb node ID, monotonic revision/tombstone, and contain no projection. Commit requires matching document, node revision, translation epoch, pair, replay lease, and node type. Work is sequential and bounded; exact-source cache entries are bounded and pair/provider scoped. Same-language pairs do nothing. Pair changes restore/reproject without recapture. Failed segments keep source text; structural failure may request one checkpoint before existing legacy fallback. Production authority remains unchanged.

**Ask First:** Persistent translation storage; replay-origin requests; new permissions, hosts, CSP, dependencies, or remote models; weaker privacy filters; promotion with a failed gate; or adaptive text reflow.

**Never:** Mutate the original; feed projections into capture/source/cache keys; commit stale work; translate private, control, editable, style, or script content; execute replay scripts/forms/navigation/resources; or add image discovery, pixels, OCR, overlays, or model downloads in D.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Initial | Live replica, unequal supported pair | Eligible nodes translate; capture stays live | Failures keep source text |
| Text delta | Text changes after translation | Queue only changed revisions; reuse cache | Drop superseded/removed results |
| Non-text delta | Scroll, CSS, attribute, or image-only batch | Converge with zero translation calls | ACK continues |
| Pair change | New/equal pair or detected source change | Advance epoch and reproject without recapture | Reject old-pair work |
| Identity change | Recovery/navigation while work runs | Reapply matching cache; reject old lease | One recovery, then legacy fallback |
| Promotion | Chrome gate evidence | Flip default only if all gates pass | Keep opt-in rrweb and rollback |

</frozen-after-approval>

## Code Map

- `lib/replica/source-value-model.ts` -- transactional canonical records, revisions, tombstones, and change feed.
- `lib/translation/{translation-memory,replica-translation-coordinator}.ts` -- pair cache, single-session queue, epochs, and stale-result rejection.
- `lib/replica/{rrweb-shadow-engine,rrweb-stream-sanitizer,contracts}.ts` -- sanitized deltas, mirror projection, leases, and recovery.
- `entrypoints/sidepanel/main.ts` -- keep rrweb active across translation and pair changes; retain legacy fallback.
- `lib/replica/{engine-selection,visible-replay-host}.ts`, `tests/`, and `deferred-work.md` -- rollout, status, coverage, evidence, and OCR handoff.

## Tasks & Acceptance

**Execution:**
- [x] Add and unit-test the source model, bounded cache/in-flight dedupe, and revision-safe coordinator.
- [x] Integrate transactional source commits, mirror-owned projection, leases, and recovery reconciliation.
- [x] Route Translate, detection, and pair changes through live rrweb; use legacy only after fallback.
- [x] Add flagged rollout/status plus deterministic and Chrome gate evidence without authority drift.
- [x] Record E as OCR contracts/visibility scheduling and F as separately approved offscreen local Tesseract.

**Acceptance Criteria:**
- Given an admitted batch, when replay completes, then ACK precedes and ignores provider completion.
- Given private canaries or stale identity/pair/revision work, when translation runs, then no canary reaches provider/replay and no stale result commits.
- Given repeated exact text, when nodes change or recovery occurs, then bounded pair cache avoids duplicate work and matching nodes reproject.
- Given fixtures plus Chrome checks on Mexico City and Reddit, when evidence is recorded, then privacy, source isolation, replay requests/actions, landmarks, scroll, bounds, and fallback each have an explicit result; any failure keeps legacy default.

## Spec Change Log

## Design Notes

Per-node translation is D's safe minimum. Cross-node sentence grouping and adaptive layout remain follow-ups. E consumes D's identity seam for OCR providers/scheduling; F delivers offscreen local Tesseract after permission/CSP approval.

## Verification

**Commands:**
- `npm run check` -- all checks pass.
- `WXT_SIMUL_RRWEB_SHADOW=1 WXT_SIMUL_RRWEB_TRANSLATION=1 npm run build` -- flagged build succeeds without authority drift.

**Manual checks:**
- In Chrome, exercise translation, churn, pair switching, navigation, recovery, failure, and rollback on fixtures, Mexico City, and Reddit; record every gate.

## Suggested Review Order

**Controller and rollout**

- Start where committed source changes enter translation without releasing the live replica.
  [`main.ts:193`](../../entrypoints/sidepanel/main.ts#L193)

- Follow pair preparation, automatic detection, and late-first-text reconciliation.
  [`main.ts:1005`](../../entrypoints/sidepanel/main.ts#L1005)

- Confirm success requires complete, current projection coverage.
  [`main.ts:1218`](../../entrypoints/sidepanel/main.ts#L1218)

- Verify both development flags are required and production remains legacy.
  [`engine-selection.ts:18`](../../lib/replica/engine-selection.ts#L18)

**Canonical source and projection**

- Review transactional canonical text, exact-document revisions, privacy exclusions, and tombstone bounds.
  [`source-value-model.ts:106`](../../lib/replica/source-value-model.ts#L106)

- Trace retained-session scheduling, cancellation, bounds, currentness, and partial-result accounting.
  [`replica-translation-coordinator.ts:99`](../../lib/translation/replica-translation-coordinator.ts#L99)

- Inspect exact mirror-node projection, reversible source restoration, and coalesced extent refresh.
  [`rrweb-shadow-engine.ts:373`](../../lib/replica/rrweb-shadow-engine.ts#L373)

- Check bounded exact-source reuse and abort-safe in-flight deduplication.
  [`translation-memory.ts:28`](../../lib/translation/translation-memory.ts#L28)

**Lifecycle and evidence**

- See the pure late-text and automatic-language scheduling decision.
  [`replica-translation-lifecycle.ts:9`](../../lib/translation/replica-translation-lifecycle.ts#L9)

- Exercise identity rejection, recovery projection, and source restoration through engine tests.
  [`replica-engine.test.ts:253`](../../tests/replica-engine.test.ts#L253)

- Review cancellation and admission-bound behavior at the coordinator boundary.
  [`replica-translation-coordinator.test.ts:198`](../../tests/replica-translation-coordinator.test.ts#L198)

- Finish with automated results, pending Chrome gates, and the conservative promotion decision.
  [`checkpoint-d-promotion-gates.md:1`](checkpoint-d-promotion-gates.md#L1)
