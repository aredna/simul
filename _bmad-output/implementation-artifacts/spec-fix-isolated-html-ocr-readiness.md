---
title: 'Enable OCR readiness for Isolated HTML'
type: 'bugfix'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 0
baseline_commit: '654d8e9d8ce50d096599052bd17a6f7ae5ac7797'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Image translation can remain at `waiting-for-replica` when Isolated HTML is selected because its visible source commit supplies the replay lease before the OCR controller receives the matching capture request and source window. The append-only diagnostic history also makes a normal pre-capture wait look like a permanent failure unless later readiness stages are inspected.

**Approach:** Correlate each selected-engine run with its exact OCR capture context and activate OCR atomically when the matching Isolated HTML or rrweb source commit becomes authoritative. Preserve the existing shared image-node identity bridge and make readiness transitions explicit and testable.

## Boundaries & Constraints

**Always:** Match session, page epoch, generation, document, and frame before activating OCR; retain exact-document and replay-lease currentness checks; keep diagnostics content-free; preserve last-good replica behavior and both isolated/rrweb modes.

**Ask First:** Any new Chrome permission, host match, external request, remote OCR/model code, or weakening of the sandbox/privacy filters.

**Never:** Start OCR against an uncommitted or stale replica; expose source text, URLs, pixels, DOM IDs, or hashes in diagnostics; remove rrweb; alter OCR provider priority or scan-policy semantics as part of this fix.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Isolated initial commit | Current isolated capture and OCR enabled | Matching request, window, and replay lease activate once; source connects and image work can run | A stale or failed run never activates OCR |
| Live/recovery commit | Active document receives a new replay lease | Existing OCR context adopts the new lease and refreshes/requeues overlays | A commit for another document cannot consume pending context |
| Post-run fallback | Engine reports complete but callback handoff was not observed | Authoritative selected-surface snapshot completes the same correlated activation | No matching snapshot leaves OCR waiting and does not target legacy/old content |
| Startup diagnostics | OCR enabled before a replica exists | Current state progresses from waiting to ready/connecting after commit | History remains bounded and content-free |

</frozen-after-approval>

## Code Map

- `entrypoints/sidepanel/main.ts` -- selected-engine capture orchestration and source-commit callback.
- `lib/ocr/image-translation-controller.ts` -- OCR request, source-window, replay-lease, source, and overlay lifecycle.
- `lib/replica/source-identity.ts` -- exact source-document correlation.
- `lib/replica/replica-surface-router.ts` -- authoritative selected-surface snapshot and image-anchor routing.
- `tests/image-translation-controller.test.ts` -- controller readiness and stale/current lifecycle coverage.
- `tests/legacy-transition-gate.test.ts` -- completed isolated-result classification coverage.

## Tasks & Acceptance

**Execution:**
- [x] `lib/ocr/image-translation-controller.ts` -- add one atomic activation boundary for request, source window, and replay lease while retaining live lease notifications.
- [x] `entrypoints/sidepanel/main.ts` -- stage the exact run context, consume it only on a matching source commit, and use a matching selected-surface snapshot as a bounded completion backstop.
- [x] `tests/image-translation-controller.test.ts` -- prove atomic activation reaches source connection and rejects invalid leases without leaking content.
- [x] `tests/legacy-transition-gate.test.ts` -- prove completed Isolated HTML is recognized alongside rrweb and stale/failed results are not.
- [x] `dist/chrome-unpacked/` -- synchronize the ready-to-load extension artifact after verification.

**Acceptance Criteria:**
- Given OCR is enabled and Isolated HTML commits the current document, when the source commit fires, then diagnostics progress beyond waiting and the isolated image source is opened exactly once with the current request.
- Given an unrelated or stale commit arrives during staging, when it is handled, then it cannot activate or retarget OCR.
- Given a recovery commit rotates the replay lease, when image work resumes, then anchors and overlays use only the new lease.
- Given rrweb is selected, when it commits, then its existing OCR behavior remains operational.

## Spec Change Log

## Verification

**Commands:**
- `npx vitest run tests/image-translation-controller.test.ts tests/legacy-transition-gate.test.ts tests/isolated-html-engine.test.ts tests/image-source-session.test.ts` -- expected: focused OCR/replica lifecycle tests pass.
- `npm run check` -- expected: typecheck, full test suite, and artifact integrity pass.
- `npm run artifact:sync && npm run artifact:check` -- expected: `dist/chrome-unpacked` matches the verified source build.

## Suggested Review Order

**Commit orchestration**

- Atomically activates OCR at the authoritative source commit, with a post-run backstop.
  [`main.ts:379`](../../entrypoints/sidepanel/main.ts#L379)

- Stages the exact request, window, engine mode, and abort signal before engine execution.
  [`main.ts:1409`](../../entrypoints/sidepanel/main.ts#L1409)

**Controller currentness**

- Binds request, source window, and replay lease before opening the image source.
  [`image-translation-controller.ts:271`](../../lib/ocr/image-translation-controller.ts#L271)

- Rejects stale documents, stale requests, and backward recovery leases.
  [`image-translation-controller.ts:340`](../../lib/ocr/image-translation-controller.ts#L340)

- Correlates selected snapshots and callbacks using document plus replay lease.
  [`source-identity.ts:108`](../../lib/replica/source-identity.ts#L108)

**Regression coverage**

- Covers atomic readiness, idempotence, stale rejection, and lease rotation.
  [`image-translation-controller.test.ts:115`](../../tests/image-translation-controller.test.ts#L115)

- Proves every source identity field and authoritative lease must match.
  [`source-identity.test.ts:45`](../../tests/source-identity.test.ts#L45)

- Confirms completed isolated and rrweb replicas share the committed classification.
  [`legacy-transition-gate.test.ts:46`](../../tests/legacy-transition-gate.test.ts#L46)
