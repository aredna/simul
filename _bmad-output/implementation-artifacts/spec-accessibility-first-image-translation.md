---
title: 'Show accessibility translations before OCR refinement'
type: 'feature'
created: '2026-07-24'
status: 'done'
baseline_commit: '266a7af6ab2ac78415203f1d690e3ffbe8124ac7'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Image translation currently completes accessibility text and OCR for one image before reading accessibility text for the next. Slow OCR therefore delays useful translated labels on later image buttons even though their accessibility text is cheap to obtain.

**Approach:** When Accessibility text is enabled, perform a bounded semantic-first sweep over every currently eligible queued image, translating and provisionally projecting useful labels before dispatching OCR. Then retain the existing prioritized OCR pipeline and deterministic ranker so OCR replaces a provisional label only when it is the better result.

## Boundaries & Constraints

**Always:** Respect the current image-reading toggles, scan policy, security/read policy, control-image setting, queue limits, exact document/content/observation revisions, target pair, and abort signals. Keep generic or inadmissible labels such as `CDN Media` from flashing. Record semantic absence as an attempted result, reuse retained semantic evidence instead of rereading it, keep provisional semantic results out of Auto-language voting and final scheduler settlement, and preserve current OCR caches, provider order, ranking, priority, retry, and stale-result behavior. An image discovered while OCR is active receives its semantic attempt before the next OCR dispatch; the active OCR may finish unless existing preemption rules cancel it.

**Ask First:** Increasing OCR concurrency or queue capacity, changing privacy/security defaults, or adding permissions, providers, remote services, or network behavior.

**Never:** Enter per-image OCR or cached-evidence refinement while an admitted, currently eligible image still needs its initial semantic attempt. Never treat accessibility text as the unconditional final winner, bypass the evidence ranker, translate blocked password/credential content, hard-code site or hostname exceptions, merge or work on `main`, commit, or push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Initial page | Several eligible image buttons with useful labels | Every label is translated/projected in scheduler priority order before the first OCR capture or recognition starts | A failed/empty/generic label is recorded or skipped and does not prevent later labels from being attempted |
| OCR refinement | A provisional label and later OCR evidence | The ranker retains the label or replaces it with OCR according to evidence quality and configured order | Weak, empty, or failed OCR leaves the valid provisional label visible |
| Dynamic image | A new eligible image arrives during OCR | Current OCR follows existing preemption rules; the new label is attempted before another OCR job starts | Stale revisions are discarded and only the current descriptor is retried |
| Disabled or ineligible OCR | OCR is disabled, unavailable, or rejected by the small-image rule | Valid semantic text remains available and can become the final result | No pixel capture is forced solely to settle semantic evidence |
| Configuration/source change | Method toggle, pair, policy, document, removal, or source reconnect changes during the sweep | The sweep aborts or fences obsolete work and restarts only under the current configuration | No stale translation or projection is committed |

</frozen-after-approval>

## Code Map

- `lib/ocr/image-translation-controller.ts` -- Add the semantic-first sweep, reuse retained candidates in per-image refinement, and preserve currentness/abort semantics.
- `lib/ocr/image-scan-scheduler.ts` -- Reuse or minimally extend the ordered non-consuming queue view without changing admission, capacity, or priority.
- `tests/image-translation-controller.test.ts` -- Replace the per-image ordering contract and cover initial, dynamic, generic, stale, and ranker outcomes.
- `wxt.config.ts`, `README.md`, `tests/extension-artifact.test.mjs` -- Identify the manual-test artifact as `0.3.2 beta v.20260724.11`.
- `dist/chrome-unpacked/` -- Regenerate the local unpacked extension for Chrome reload testing.

## Tasks & Acceptance

**Execution:**
- [x] `lib/ocr/image-translation-controller.ts` -- Separate semantic preview scheduling from OCR dispatch and consume remembered evidence during final comparison.
- [x] `lib/ocr/image-scan-scheduler.ts` -- Support the bounded ordered sweep only if the existing queue snapshot is insufficient.
- [x] `tests/image-translation-controller.test.ts` -- Assert all eligible semantic attempts complete before OCR begins and verify the edge-case matrix.
- [x] `wxt.config.ts`, `README.md`, `tests/extension-artifact.test.mjs`, `dist/chrome-unpacked/` -- Bump the beta identity, build, and verify the reloadable artifact.

**Acceptance Criteria:**
- Given multiple eligible image controls and Accessibility text enabled, when processing begins, then no OCR capture/recognition starts until every initial queued control has completed one semantic attempt.
- Given a provisional semantic projection, when OCR completes, then only the deterministic winner is projected and a weaker OCR result never erases the label.
- Given cached semantic evidence for the exact current revision, when refinement starts, then the controller does not reread or retranslate that evidence unnecessarily.
- Given a new eligible image during an active OCR job, when the controller chooses its next job, then it attempts that image's semantic text before dispatching more OCR.
- Given Accessibility text disabled, when images are processed, then existing OCR-only scheduling remains unchanged.

## Spec Change Log

## Design Notes

Use the scheduler's ordered queue snapshot as a non-consuming semantic phase. Semantic attempts must not activate or settle OCR jobs; refinement continues through the normal capacity-one dispatcher. Retained evidence is the handoff between phases and remains keyed to the exact descriptor and evidence configuration.

## Verification

**Commands:**
- `npx vitest run tests/image-translation-controller.test.ts tests/image-scan-scheduler.test.ts` -- focused ordering, ranking, and scheduler tests pass.
- `npm run check` -- the complete lint, type, unit, artifact, and build checks pass.
- `npm run build` -- `dist/chrome-unpacked` is regenerated with version name `0.3.2 beta v.20260724.11`.

**Manual checks:**
- Reload `dist/chrome-unpacked`, open a page with several labeled image buttons, and confirm all admissible translated labels appear before OCR begins replacing any of them.

## Suggested Review Order

**Semantic-first dispatch**

- The dispatcher completes the bounded semantic sweep before consuming an OCR job.
  [`image-translation-controller.ts:1230`](../../lib/ocr/image-translation-controller.ts#L1230)

- The sweep reads every queued candidate first, then projects admissible labels in priority order.
  [`image-translation-controller.ts:1338`](../../lib/ocr/image-translation-controller.ts#L1338)

- Exact-revision preview evidence feeds normal per-image ranking without another source read.
  [`image-translation-controller.ts:1642`](../../lib/ocr/image-translation-controller.ts#L1642)

**Ranking and scheduling boundaries**

- A failed semantic first paint still receives its ranked final attempt before OCR fallback.
  [`image-translation-controller.ts:1781`](../../lib/ocr/image-translation-controller.ts#L1781)

- Repetition suppresses compact boilerplate while preserving useful acronym labels.
  [`image-translation-controller.ts:4965`](../../lib/ocr/image-translation-controller.ts#L4965)

- Non-consuming snapshots and deferral preserve capacity-one OCR ownership and overflow admission.
  [`image-scan-scheduler.ts:224`](../../lib/ocr/image-scan-scheduler.ts#L224)

**Regression and artifact proof**

- The primary contract proves every useful initial label appears before the first capture.
  [`image-translation-controller.test.ts:759`](../../tests/image-translation-controller.test.ts#L759)

- Stress coverage proves retained evidence survives weight eviction without rereading source labels.
  [`image-translation-controller.test.ts:897`](../../tests/image-translation-controller.test.ts#L897)

- Overflow coverage proves the 513th record receives semantic preview before its OCR dispatch.
  [`image-translation-controller.test.ts:979`](../../tests/image-translation-controller.test.ts#L979)

- The manifest suffix identifies the exact unpacked build used for manual testing.
  [`wxt.config.ts:12`](../../wxt.config.ts#L12)
