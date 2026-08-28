---
title: 'Incremental Image Mutation Stability'
type: 'bugfix'
created: '2026-07-25'
status: 'done'
review_loop_iteration: 0
baseline_commit: '266a7af6ab2ac78415203f1d690e3ffbe8124ac7'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-hover-disclosure-and-image-stability.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A local image visibility change can trigger a page-wide observation refresh and, in rrweb, an authoritative checkpoint. Unchanged descriptions then disappear and return serially from cache even though their content, pixels, ranking, and translation remain valid; Soumu's four-attribute carousel transition reproduces this every seven seconds across a page with about 90 unrelated images.

**Approach:** Classify source mutations by the dependency they actually change. Keep image-only visibility updates incremental, limit settle work to affected images, carry completed scheduling state across observation-only revisions with the same capture identity, and rebase retained projection metadata without unmounting its overlay.

## Boundaries & Constraints

**Always:** Use generic structural and revision proofs, never hostname or authored class names. Preserve exact-document, pair, read-policy, secret, crop, pixel, and replay currency. Reuse a completion only when content and capture revisions are unchanged; real source, crop, size, paint-safety, or protected-overlap changes invalidate the affected image. Visibility privacy still rematerializes subtrees that may contain authored text. Keep diagnostics content-free. Stay on `feat/replica-read-scope-redesign`, retain Git guards, do not commit/merge/push, advance the beta identity, and synchronize `dist/chrome-unpacked`.

**Ask First:** New permissions or host matches, persistent result storage, remote code/services, a weaker secret/capture-safety floor, or executing page scripts.

**Never:** Treat every `class`, transition, or animation as page-wide OCR work; reuse an old projection across a changed capture revision; suppress a checkpoint that is required to reveal previously withheld text; hard-code Soumu/carousel libraries; or let stale async work restore an invalidated overlay.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Rotating image | Previous/new image and thumbnail toggle a visibility class; sources and text stay stable | Patch only changed attributes; refresh only affected image descriptors; unrelated overlay nodes remain mounted with zero acquisition/OCR/translation/ranking work | Coalesce the mutation/settle burst into one frame |
| Observation-only update | Same document, content revision, capture revision, pair, and policy; visibility/priority observation advances | Carry settled completion and rebase projection currency in place | Missing/expired retained state may queue only that image |
| Real image change | One source, crop, dimensions, paint safety, or pixel identity changes | Withdraw and recompute only that image; retain all unrelated results | Exact safety ambiguity fails closed for the affected bounded set |
| Hidden text transition | CSS visibility changes for a subtree that structurally may contain authored text | Rematerialize that subtree; rrweb may take an atomic checkpoint when incremental replay cannot reveal withheld text | Overflow retains the last-good replica and uses bounded recovery |
| Protected overlap | A secret/control surface moves across an image | Advance capture safety for the potentially affected image set; do not reuse stale pixels | Unknown or oversized dependency scope uses the existing fail-closed fallback |

</frozen-after-approval>

## Code Map

- `lib/ocr/source-image-observer.ts` -- mutation/transition targeting and capture-safety escalation.
- `lib/ocr/image-scan-scheduler.ts` -- completion ownership across content, capture, and observation revisions.
- `lib/ocr/image-translation-controller.ts`, `image-overlay-projector.ts` -- retained analysis/projection rebasing without visible teardown.
- `lib/replica/source-visibility-boundary.ts`, `html-mirror-source.ts`, `live-recorder-session.ts` -- distinguish paint-only image changes from text-rematerialization boundaries.
- `tests/{source-image-observer,image-scan-scheduler,image-translation-controller,source-visibility-boundary,live-recorder-session}.test.ts` -- Soumu-shaped and safety regressions.
- `README.md`, `_bmad-output/project-context.md`, build metadata, and `dist/chrome-unpacked/` -- beta identity, durable behavior, and reloadable artifact.

## Tasks & Acceptance

**Execution:**
- [x] Narrow image mutation and settle invalidation to the changed/overlapped set while preserving explicit fail-closed safety escalation.
- [x] Carry settled scheduler state only across proven same-capture observation revisions.
- [x] Rebase retained projection currency in place so observation-only updates never unmount visible text.
- [x] Prevent image-only paint transitions from requesting rrweb checkpoints while retaining text-bearing visibility recovery.
- [x] Add adversarial regressions, advance beta `.13`, update durable context, and rebuild the exact OCR-trials unpacked artifact.

**Acceptance Criteria:**
- Given a Soumu-shaped rotating carousel plus many stable images, when active classes and opacity settle, then only the changing images advance and every unrelated overlay keeps object identity with no provider, translation, or ranking calls.
- Given a completed image whose observation revision changes without its capture revision, when the update arrives, then the scheduler remains empty and the existing overlay stays continuously mounted.
- Given a capture or privacy boundary change, when the same flow runs, then stale evidence is rejected and only the bounded affected scope is recomputed or conservatively recovered.
- Given both replica engines, when an image-only paint mutation occurs, then isolated HTML patches locally and rrweb does not replace its replay lease.

## Spec Change Log

- 2026-07-25: Implemented mutation-local image refresh, same-capture
  observation rebasing, stable overlay identity, selector/CSSOM visibility
  proof, and old/current protected-overlap invalidation; adversarial review and
  artifact synchronization remain in progress.
- 2026-07-25: Closed the adversarial patch findings, documented three
  pre-existing follow-ups, passed all 1,313 tests, and synchronized the exact
  four-provider beta `.13` unpacked artifact.

## Design Notes

Observation revision orders geometry and attention; capture revision owns
pixel-analysis validity. A projection may adopt a newer observation only after
the controller proves the same content/capture result, while the overlay
projector updates metadata on the existing DOM entry. Structural presence of
text nodes—not their contents—decides whether an image-owned paint boundary can
require privacy rematerialization. Remote selector dependencies are proved with
a bounded document-wide comparison that carries only content-free state; a
global proof does not imply global image invalidation. Secret currency is exact
and sticky across queued work, while capture safety compares old/current image
and protected-surface geometry before replacing its ledger.

## Verification

**Commands:**
- `npx vitest run tests/source-image-observer.test.ts tests/source-image-model.test.ts tests/image-scan-scheduler.test.ts tests/image-translation-controller.test.ts tests/image-overlay-projector.test.ts tests/source-visibility-boundary.test.ts tests/live-recorder-session.test.ts tests/html-mirror-source.test.ts tests/image-source-session.test.ts tests/page-recorder.test.ts tests/rrweb-secret-projection.test.ts tests/rrweb-stream-sanitizer.test.ts` -- 332 focused mutation, projection, replica, and safety regressions pass.
- `npm run check` -- typecheck, all tests, production build, and artifact validation pass.
- `npm run artifact:sync:ocr-trials && npm run artifact:check:ocr-trials` -- `dist/chrome-unpacked` exactly matches beta `.13` with licensed local OCR trials.
- `git diff --check` and branch/hook probes -- clean patch; no commit, merge, or push.

## Suggested Review Order

**Mutation-local image currency**

- Start with the mutation router that separates local capture work from global safety proof.
  [`source-image-observer.ts:975`](../../lib/ocr/source-image-observer.ts#L975)

- Compare old/current protected geometry and motion hulls before reusing pixels.
  [`source-image-observer.ts:1582`](../../lib/ocr/source-image-observer.ts#L1582)

- Make capture-only safety changes observable even when content is unchanged.
  [`source-image-model.ts:101`](../../lib/ocr/source-image-model.ts#L101)

**Stable completion and presentation**

- Carry settled completion only across proven same-content, same-capture observations.
  [`image-scan-scheduler.ts:371`](../../lib/ocr/image-scan-scheduler.ts#L371)

- Rebase retained evidence and projection currency without reopening OCR.
  [`image-translation-controller.ts:4206`](../../lib/ocr/image-translation-controller.ts#L4206)

- Preserve the existing overlay root when translated regions are identical.
  [`image-overlay-projector.ts:120`](../../lib/ocr/image-overlay-projector.ts#L120)

**Replica and privacy safety**

- Prove arbitrary selector effects globally while carrying no authored content.
  [`source-visibility-boundary.ts:18`](../../lib/replica/source-visibility-boundary.ts#L18)

- Coalesce isolated-engine interaction disclosure into targeted rematerialization.
  [`html-mirror-source.ts:1140`](../../lib/replica/html-mirror-source.ts#L1140)

- Apply the same interaction proof before rrweb checkpoint decisions.
  [`live-recorder-session.ts:1281`](../../lib/replica/live-recorder-session.ts#L1281)

- Route CSSOM-only paint changes into both visibility and image capture proof.
  [`page-recorder.ts:200`](../../lib/replica/page-recorder.ts#L200)

**Regression evidence**

- Verify arbitrary selector churn advances only images whose pixels changed.
  [`source-image-observer.test.ts:995`](../../tests/source-image-observer.test.ts#L995)

- Verify same-capture observations retain settled scheduler completion.
  [`image-scan-scheduler.test.ts:347`](../../tests/image-scan-scheduler.test.ts#L347)

- Verify final analysis rebinds without replacing visible overlay content.
  [`image-translation-controller.test.ts:3273`](../../tests/image-translation-controller.test.ts#L3273)

- Verify in-place projection keeps the exact overlay DOM root.
  [`image-overlay-projector.test.ts:305`](../../tests/image-overlay-projector.test.ts#L305)
