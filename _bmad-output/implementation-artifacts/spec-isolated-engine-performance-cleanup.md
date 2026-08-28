---
title: 'Isolated engine performance cleanup'
type: 'refactor'
created: '2026-07-25'
status: 'done'
review_loop_iteration: 0
baseline_commit: '266a7af6ab2ac78415203f1d690e3ffbe8124ac7'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-progressive-cached-image-translation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Simul ships two replica stacks even though Isolated HTML is now authoritative, while routine mutations, scrolling, accessibility preview, overlay refresh, and OCR-provider reordering can repeat document scans, layout reads, capture, or recognition. This increases startup size and makes visible translation feel delayed or unstable.

**Approach:** Remove rrweb recording/replay and its dependencies, retain Isolated HTML with the existing legacy emergency fallback, and make image/visibility work priority-driven, scan-coalesced, cache-reusing, and bounded without weakening privacy or read-scope behavior.

## Boundaries & Constraints

**Always:** Stay on `feat/replica-read-scope-redesign`; preserve fail-closed secret/control handling, inert isolated presentation, memory-only evidence, existing extension permissions, local-only executable code, upgrade safety for stored `replicaEngine: 'rrweb'`, and useful isolated/OCR/privacy tests. Build generated artifacts only through repository scripts.

**Ask First:** Removing the legacy emergency fallback; weakening a privacy/read-scope proof; changing permissions, host access, OCR providers, language packs, or the four-provider trial profile; deleting historical planning records; committing or contacting a remote.

**Never:** Switch or merge to `main`, push/fetch, bypass hooks, persist source text/pixels/URLs/identities, add site-specific exceptions, treat unreadable DOM/style state as safe, hand-edit generated BMAD files or `dist/chrome-unpacked`, or delete unrelated tests merely to lower line count.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stored rrweb preference | Existing profile selects `rrweb` | Canonicalize and save Isolated HTML; companion remains usable | Fail closed on malformed storage, not on the known migration |
| Mixed OCR queue | Visible and background images, some with ALT | Scheduler handles the highest-priority job; that job may show ALT before its OCR | Stale/mismatched ALT is isolated without starving later work |
| Stable movement | Repeated scroll with unchanged crop and safety relation | No capture revision, overlay loss, OCR, or translation restart | Unreadable/moving safety state still invalidates conservatively |
| Provider reorder | Unchanged pixels and retained enabled-provider evidence | Recompose/rerank locally without capture or recognition | Run only genuinely missing provider work |
| Busy replica | Mutation and interaction bursts before one frame | One content-free visibility comparison with scan-local style/geometry reuse | Any unreadable proof withholds or requests conservative recovery |
| Many overlays | Scroll with unchanged image dimensions | Update currentness and position without text refitting; retained work stays bounded | Stale leases and invalid anchors are removed |

</frozen-after-approval>

## Code Map

- `entrypoints/sidepanel/`, `lib/preferences.ts`, `lib/replica/engine-selection.ts` -- remove engine choice and migrate saved rrweb preferences.
- `entrypoints/page-recorder.ts`, `lib/replica/{page-recorder,live-*,rrweb-*}.ts`, `lib/replica/protocol-v2.ts` -- delete the rrweb transport/replay graph and retain only shared identity behavior.
- `wxt.config.ts`, `package*.json`, `tools/extension-artifact.mjs` -- remove rrweb dependencies, entrypoint, markers, and artifact assumptions.
- `lib/ocr/image-translation-controller.ts`, `image-analysis-coordinator.ts`, `image-source-session.ts`, `source-image-observer.ts` -- visible-first execution, targeted refresh, cached reorder, and stable capture safety.
- `lib/replica/source-visibility-boundary.ts`, `source-privacy-policy.ts`, `html-mirror-source.ts`, `lib/ocr/image-overlay-projector.ts` -- coalesced scan-local proof and cheap scroll layout.
- `tests/`, `README.md`, `docs/translation-companion.md`, `THIRD_PARTY_NOTICES.md` -- focused regressions and current product/runtime truth.

## Tasks & Acceptance

**Execution:**
- [x] Remove rrweb-only source/tests/dependencies/build output; simplify shared contracts, identity, semantic presentation, engine control, settings, and migration around Isolated HTML plus legacy fallback.
- [x] Delete the all-queue accessibility pre-sweep; use the existing ALT-first active-job path, isolate malformed evidence, and target-refresh only the requested image.
- [x] Reuse retained enabled-provider corroboration after reorder; suppress generic provisional placeholders; remove the duplicate image-memory purge.
- [x] Coalesce visibility work per frame and cache paint inputs for one scan; reuse the capture-control ledger and invalidate only changed safety relations.
- [x] Cache overlay layout dimensions, bound retained overlay weight, and avoid font fitting on position-only scroll.
- [x] Update focused tests, artifact validation, documentation, generated trial artifact, and runtime/bundle measurements.

**Acceptance Criteria:**
- Given a clean build and an upgraded rrweb preference, when Simul starts, then no rrweb package, source import, setting, entrypoint, or artifact marker remains and Isolated HTML opens normally.
- Given 512 mixed-priority images, when processing starts, then only the scheduler-selected job receives eager ALT work before its OCR; background labels cannot block it.
- Given stable scrolling, when repeated frames run, then capture/recognition counters remain unchanged and overlay text fitting does not rerun.
- Given equivalent retained provider evidence in a new order, when settings change, then acquisition and recognition counts remain one.
- Given bounded mutation/interaction bursts, when one frame flushes, then each element's computed paint inputs are read at most once for that scan and privacy fixtures remain fail closed.
- Given the final source and trial artifact, when verification runs, then `git diff --check` and `npm run check` pass, `page-recorder.js` is absent, authored runtime LOC decreases materially, and the initial side-panel chunk is below 500 KiB.

## Spec Change Log

## Design Notes

Historical rrweb specs remain as provenance. Current documentation and runtime contracts identify Isolated HTML as the only selectable primary engine. Scan caches are frame-local: no style, geometry, privacy, or source-derived fact survives its proof generation.

## Verification

**Commands:**
- `npm test -- tests/image-translation-controller.test.ts tests/image-source-session.test.ts tests/source-image-observer.test.ts tests/source-visibility-boundary.test.ts tests/html-mirror-source.test.ts tests/image-overlay-projector.test.ts` -- focused performance/privacy regressions pass.
- `npm run artifact:sync:ocr-trials && npm run check` -- canonical local trial rebuild and complete project gate pass.
- `git diff --check` -- no whitespace errors.

**Results:**
- Complete gate: 76 test files and 1,164 tests passed, including TypeScript and exact four-provider artifact validation.
- Side-panel entry chunk: 708,765 bytes at task start; 492,163 bytes after cleanup (216,602 bytes / 30.6% smaller).
- Authored TypeScript/JavaScript: 62,653 runtime lines and 45,306 test lines after cleanup. Removing the recorder/replay stack retired 8,122 runtime lines and 4,772 associated test lines.
- Canonical artifact: no `page-recorder.js`, rrweb dependency, import, entrypoint, or runtime marker remains.

**Manual checks:**
- Load `dist/chrome-unpacked`, upgrade an old rrweb preference, and verify isolated translation, source-only mode, disclosures, images, stable scrolling, and legacy fallback after an induced isolated failure.

## Suggested Review Order

**Runtime simplification**

- Isolated HTML is authoritative; legacy activates only after an isolated failure.
  [`engine-selection.ts:22`](../../lib/replica/engine-selection.ts#L22)

- Preference reconciliation removes stale engine fields and persists canonical settings.
  [`preference-coordinator.ts:197`](../../lib/preference-coordinator.ts#L197)

- Build entrypoints omit the recorder while retaining local mirror and snapshot surfaces.
  [`wxt.config.ts:26`](../../wxt.config.ts#L26)

**Priority and evidence reuse**

- Same-node transitions cannot let stale active work overwrite the current candidate.
  [`image-scan-scheduler.ts:537`](../../lib/ocr/image-scan-scheduler.ts#L537)

- Only the selected job enters eager accessibility and OCR processing.
  [`image-translation-controller.ts:1388`](../../lib/ocr/image-translation-controller.ts#L1388)

- Requested-image refresh avoids walking unrelated page images before source reads.
  [`image-source-session.ts:164`](../../lib/ocr/image-source-session.ts#L164)

- Retained empty routes close locally; unavailable providers remain retryable.
  [`image-translation-controller.ts:5412`](../../lib/ocr/image-translation-controller.ts#L5412)

**Mutation and privacy boundaries**

- Admission precedes reads, and each existing image refreshes once per mutation delivery.
  [`source-image-observer.ts:996`](../../lib/ocr/source-image-observer.ts#L996)

- Scroll uses relative geometry and swept bounds without reclassifying every control.
  [`source-image-observer.ts:1714`](../../lib/ocr/source-image-observer.ts#L1714)

- One frame drains secret-safe visibility records and rematerializes changed boundaries.
  [`html-mirror-source.ts:700`](../../lib/replica/html-mirror-source.ts#L700)

- Every selector surface receives a global, content-free painted-state comparison.
  [`source-visibility-boundary.ts:58`](../../lib/replica/source-visibility-boundary.ts#L58)

- Scan-local caches share style and geometry inputs inside one privacy proof.
  [`source-privacy-policy.ts:140`](../../lib/replica/source-privacy-policy.ts#L140)

**Overlay and artifact evidence**

- Stable-size scroll only repositions overlays; fitting reruns after dimension changes.
  [`image-overlay-projector.ts:281`](../../lib/ocr/image-overlay-projector.ts#L281)

- Weighted eviction bounds retained overlays while exact rebases preserve their DOM.
  [`image-overlay-projector.ts:128`](../../lib/ocr/image-overlay-projector.ts#L128)

- Artifact validation requires the isolated runtime and its sandbox markers.
  [`extension-artifact.mjs:521`](../../tools/extension-artifact.mjs#L521)

- Production profiles verify permissions, local assets, versioning, and bundle composition.
  [`extension-artifact.test.mjs:615`](../../tests/extension-artifact.test.mjs#L615)
