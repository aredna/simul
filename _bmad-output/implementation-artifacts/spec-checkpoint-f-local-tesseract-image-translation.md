---
title: 'Checkpoint F: Canonical rrweb and Local Tesseract Image Translation'
type: 'feature'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-checkpoint-e-ocr-foundation.md'
  - '{project-root}/_bmad-output/implementation-artifacts/checkpoint-d-promotion-gates.md'
  - '{project-root}/_bmad-output/planning-artifacts/research/technical-live-dom-replication-ocr-extension-access-research-2026-07-19.md'
baseline_commit: '1ea6f7f0dea06eb213a50301f1f1ddbc52d7a072'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The installable extension selects the legacy mirror, so E's rrweb image identities cannot reach a visible projection and no provider can translate image text.

**Approach:** Promote rrweb replay/text projection with legacy last-good fallback, then run packaged Tesseract in a restartable offscreen host and project translated line overlays over stable visible `<img>` elements.

## Boundaries & Constraints

**Always:** Choice C promotes rrweb while retaining legacy fallback; Mexico City/Reddit gaps become documented follow-ups, not passed gates. Image translation is a persisted, initially-off toggle; enabling it applies E's policy, exact-document revisions, provider order, privacy, filtering, and capacity-one scheduler. Capture only visible top-frame `<img>` elements through `captureVisibleTab()` at most twice per second after matching pre/post document, viewport, scroll, bounds, and revision; defer hidden work and reject crops above 4 MP. Package exact Tesseract.js/core 7.0.0 plus the pinned 21-language/22-file `tessdata_fast` catalog within 42 MiB; load one routed group and terminate it after group change or 90 seconds idle. Route from nearest valid `lang`, explicit From language, then detected page language. Keep bounded recognition and translation caches separate. Commit only overlays matching current document, image revision, pixel hash, replay lease, pair epoch, replica `<img>`, and normalized geometry.

**Ask First:** Direct image fetch/host access; durable pixels, screenshots, transcripts, or results; remote models; a larger artifact; permission beyond `offscreen`; broader CSP; another provider, Prompt, non-`<img>` source, or weaker legacy fallback.

**Never:** Mutate source or replica image/layout; send pixels off-device; ship remote fallbacks; retain URLs/screenshots/OCR text beyond approved transient lifetimes; scan private controls; trust unchecked geometry; show stale overlays; rebuild for OCR; or claim promotion fixes known fidelity bugs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Stable visible image | OCR enabled and supported pair | Capture once, cache recognition, translate lines, project inert boxes | Empty output leaves the image unchanged |
| Hidden/changing image | No stable visible pixels | Defer until visibility/observation changes | No loop or completed mark |
| Late result | Identity, revision, lease, pair, or geometry changed | Discard input/result and obsolete overlay | Never retry stale work |
| Compute loss | Host or Worker disappears | Recreate once with the same job | Second failure degrades OCR only |
| Language change | Same pixels, new target | Reuse OCR and retranslate | Same-language shows no overlay |
| Unsupported input | No model route or geometry mismatch | Keep image unchanged with bounded reason | Never guess or fan out models |

</frozen-after-approval>

## Code Map

- `lib/replica/{engine-selection,page-recorder,rrweb-shadow-engine,visible-replay-host}.ts` -- canonical rrweb, source image stream, replay anchors, and overlay surface.
- `lib/ocr/{image-source-protocol,image-analysis-coordinator,image-translation-controller,pixel-acquisition,offscreen-protocol,image-overlay-projector}.ts` -- capture/currentness, cache, orchestration, host messages, and projection.
- `lib/ocr/providers/tesseract/`, `entrypoints/offscreen/`, `entrypoints/background.ts` -- provider normalization, Worker/model lifecycle, static compute page, and serialized host creation.
- `entrypoints/sidepanel/`, `lib/preferences.ts`, `lib/preference-coordinator.ts` -- opt-in control, pair orchestration, progress, and cancellation.
- `tools/ocr-build-profile.ts`, `wxt.config.ts`, `tools/extension-artifact.mjs`, `vendor/ocr/`, `dist/chrome-unpacked/` -- assets, manifest/CSP/notices, budgets, and installable output.
- `tests/` and project artifacts -- boundary, recovery, geometry, packaging, and promotion evidence.

## Tasks & Acceptance

**Execution:**
- [x] `lib/replica/{engine-selection,rrweb-shadow-engine,visible-replay-host}.ts` -- promote rrweb/text projection while retaining atomic legacy fallback and honest diagnostics.
- [x] `lib/replica/page-recorder.ts`, `lib/ocr/{image-source-protocol,image-scan-scheduler,pixel-acquisition}.ts` -- stream exact-document images and defer unstable pixels without loops.
- [x] `lib/ocr/{image-analysis-coordinator,offscreen-protocol}.ts`, `entrypoints/{background,offscreen}/` -- add transient handoff, SHA-256 keys, bounded memory, and one-retry host lifecycle.
- [x] `lib/ocr/providers/tesseract/`, `vendor/ocr/`, `tools/ocr-build-profile.ts` -- package/normalize Tesseract, lazy groups, disposal, hashes, licenses, and budgets.
- [x] `lib/ocr/image-overlay-projector.ts`, `entrypoints/sidepanel/` -- translate accepted lines and project clipped sibling overlays following scroll/zoom.
- [x] `lib/{preferences,preference-coordinator}.ts`, `tests/`, project artifacts, `dist/chrome-unpacked/` -- add opt-in UI, coverage, documentation, and reproducible output.

**Acceptance Criteria:**
- Given a normal production build, when a page is captured, then rrweb and revision-safe text translation are authoritative and a failed rrweb run atomically retains or restores legacy.
- Given OCR is disabled or its provider is compiled out, when Simul runs, then no pixels are captured, no compute host starts, and disabled-profile artifacts contain no OCR runtime assets or CSP/permission drift.
- Given a stable supported visible image, when OCR is enabled, then one local Tesseract job yields validated translated line overlays without blocking source capture or mutating page/replica layout.
- Given scroll, zoom, churn, navigation, pair changes, cancellation, overflow, or host loss, when work settles, then only current overlays survive and page translation remains usable.
- Given the canonical release artifact, when validated offline, then every expected Worker/Wasm/model/notice hash is present, no remote runtime URL exists, and total unpacked size stays within 42 MiB.

## Spec Change Log

- 2026-07-20: Implemented approved Choice C, local Tesseract/offscreen
  translation, opt-in overlays, and exact enabled/disabled artifact guards.
  Mexico City/Reddit fidelity rows remain documented follow-ups.
- 2026-07-20: Completed automated verification and synchronized the validated
  39.12 MB ready-to-load Chrome artifact. Manual installed-Chrome OCR checks
  remain the Checkpoint F human confirmation step.
- 2026-07-20: Applied the independent review pass: exact-tab/global-rate capture,
  observation-safe cancellation, conservative privacy geometry, recurring
  transient cleanup, one-shot source recovery, hard-bounded Worker failure,
  and byte-exact artifact guards.
- 2026-07-20: Recorded Strict Local Mirror as deferred technical-spike work with
  explicit zero-replica-network acceptance tests and no new privileged capture
  APIs or permissions without separate approval.

## Design Notes

The catalog is English, Spanish, French, German, Portuguese, Italian, Vietnamese, Japanese plus vertical Japanese, Korean, Simplified/Traditional Chinese, Russian, Ukrainian, Arabic, Hebrew, Hindi, Marathi, Bengali, Kannada, Tamil, and Telugu. Tesseract does not identify exact language; image-only detection remains later. A transient viewport screenshot may exist in extension-origin storage only for offscreen crop/decode and is deleted on completion, cancellation, restart cleanup, or two-minute expiry. Recognition stays memory-only and contains no URL.

## Verification

**Commands:**
- `npm run typecheck && npm test` -- passed with 41 test files and 407 tests.
- `npm run artifact:sync` -- synchronized the validated 39.12 MB canonical ready-to-load directory.
- `npm run check` -- passed all strict contracts, 407 tests, typechecking,
  enabled/disabled profile builds, asset checks, and committed-byte comparison.

**Manual checks:**
- In installed Chrome, exercise English↔Japanese plus Spanish, Chinese, Korean, Russian, and Arabic; toggle OCR, scroll/zoom, change targets, navigate mid-job, and recreate the host. Confirm local pixels, stale-overlay removal, and legacy fallback.

## Suggested Review Order

**Side-panel orchestration**

- Compose the opt-in OCR pipeline beside the canonical rrweb replica.
  [`main.ts:309`](../../entrypoints/sidepanel/main.ts#L309)

- Centralize currentness, caching, translation, cancellation, and overlay ownership.
  [`image-translation-controller.ts:104`](../../lib/ocr/image-translation-controller.ts#L104)

- Make observation revisions first-class scheduler boundaries for incremental work.
  [`image-scan-scheduler.ts:69`](../../lib/ocr/image-scan-scheduler.ts#L69)

**Replica and capture safety**

- Promote rrweb while retaining an explicit, bounded legacy fallback.
  [`engine-selection.ts:28`](../../lib/replica/engine-selection.ts#L28)

- Stream privacy-filtered image identities from the exact source document.
  [`page-recorder.ts:132`](../../lib/replica/page-recorder.ts#L132)

- Validate every cross-context descriptor without exposing source URLs or pixels.
  [`image-source-protocol.ts:70`](../../lib/ocr/image-source-protocol.ts#L70)

- Surface dead source ports immediately for one exact-document reconnect.
  [`image-source-client.ts:34`](../../lib/ocr/image-source-client.ts#L34)

- Reject hidden, clipped, transformed, private-overlapped, or stale image geometry.
  [`image-source-session.ts:51`](../../lib/ocr/image-source-session.ts#L51)

- Capture only the exact active source tab under a global rate lane.
  [`pixel-acquisition.ts:233`](../../lib/ocr/pixel-acquisition.ts#L233)

**Local OCR lifecycle and projection**

- Hand transient pixels to the offscreen host with one infrastructure retry.
  [`image-analysis-coordinator.ts:38`](../../lib/ocr/image-analysis-coordinator.ts#L38)

- Bound the host to one active and one pending compute job.
  [`offscreen-host.ts:39`](../../lib/ocr/offscreen-host.ts#L39)

- Load one packaged language group with deadlines and restartable Worker recovery.
  [`runtime.ts:33`](../../lib/ocr/providers/tesseract/runtime.ts#L33)

- Project inert translated lines without mutating replica layout.
  [`image-overlay-projector.ts:69`](../../lib/ocr/image-overlay-projector.ts#L69)

**Release integrity and evidence**

- Compile disabled providers completely out of runtime and artifact surfaces.
  [`ocr-build-profile.ts:22`](../../tools/ocr-build-profile.ts#L22)

- Vendor pinned Tesseract assets deterministically with hashes and license provenance.
  [`vendor-tesseract.mjs:7`](../../tools/vendor-tesseract.mjs#L7)

- Validate permissions, module closure, exact assets, notices, hashes, and size.
  [`extension-artifact.mjs:215`](../../tools/extension-artifact.mjs#L215)

- Exercise currentness, cache reuse, cancellation, degradation, and projection end-to-end.
  [`image-translation-controller.test.ts:42`](../../tests/image-translation-controller.test.ts#L42)

- Prove enabled and fully compiled-out artifact profiles remain exact.
  [`extension-artifact.test.mjs:427`](../../tests/extension-artifact.test.mjs#L427)
