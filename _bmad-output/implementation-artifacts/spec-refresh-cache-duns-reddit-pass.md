---
title: 'Compact Refresh, Cache Reuse, D-U-N-S OCR, and Reddit Diagnostics'
type: 'bugfix'
created: '2026-07-21'
status: 'done'
baseline_commit: 'c45d171'
context:
  - '_bmad-output/project-context.md'
  - '_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md'
  - '_bmad-output/implementation-artifacts/spec-isolated-html-fidelity-baseline-mode.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Rebuilding the live mirror requires opening settings; cache-backed work can look like a new provider translation and exact phrases with different boundary whitespace can miss; short path-only SVG logos such as the D-U-N-S header are discovered but Tesseract receives too few pixels for useful recognition; modern Reddit's server-rendered Lit/custom-element tree is expensive because a small child-list mutation currently replaces an entire mirrored child set.

**Approach:** Put the existing rebuild action in the compact corner toolbar, strengthen and prove bounded in-memory text/OCR reuse, add conservative small-crop OCR scaling plus banner segmentation, and add content-free mirror mutation diagnostics while recording the larger granular-patch/custom-element work as an explicit follow-up.

## Boundaries & Constraints

**Always:** Use generic rules with no hostname branches; keep source and replica scripts/events/forms/navigation inert; retain current permissions, host matches, sandbox, privacy redaction, visible-top-frame `<img>` boundary, 4 MP OCR cap, local packaged models, exact-document/replay guards, and memory-only cache semantics. Preserve CSS image geometry when OCR pixels are scaled. Keep cache logs aggregate and content-free. Treat Reddit as evidence for generic mirror behavior, not a special case.

**Ask First:** New permissions or host matches; executing copied or no-op custom-element code in the replica; CSS background/media/frame OCR; persistent storage of page text, OCR transcripts, pixels, or translations; a protocol change that inserts/removes/moves live nodes; raising current privacy/capture bounds.

**Never:** Fetch page images for OCR, store screenshot blobs after handoff, log page text/URLs/pixels/hashes/node IDs, run Reddit JavaScript in the replica, claim pixel-perfect Reddit parity, or weaken Strict Local Mirror's deferred review boundary.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Compact rebuild | Corner refresh pressed while idle | Runs the exact existing manual rebuild flow | Disabled during capture; no parallel rebuild |
| Repeated phrase | Same translation core with different leading/trailing whitespace | One provider call; each projection keeps its own whitespace | Failed/empty provider output remains retryable |
| Repeated OCR region | Replica/replay lease changes but pixels and recognized text are identical | Recognition and region translation hit bounded RAM caches; no eager Translator session on all-hit work | Changed crop/route/pair intentionally misses |
| Short banner/logo | Stable visible shallow `<img>` crop under the scale threshold | Crop is upscaled within the 4 MP limit and a high-aspect Tesseract job uses single-line segmentation | Original bounded crop is used when scaling is unsafe; low-quality OCR leaves original pixels visible |
| Large dynamic tree | Reddit-like async loader replaces a large child set | Console reports only aggregate operation/replacement sizes and recovery stage | No content or identifiers are exposed; current atomic replacement remains authoritative |

</frozen-after-approval>

## Code Map

- `entrypoints/sidepanel/{index.html,main.ts}` -- compact rebuild control, separate bounded cache instances, aggregate diagnostics.
- `lib/translation/{translation-memory,replica-translation-coordinator}.ts` -- cache counters/core-key reuse.
- `lib/ocr/{pixel-acquisition,image-analysis-coordinator,image-translation-controller}.ts` -- bounded crop scale/profile and lazy translation session.
- `lib/ocr/providers/tesseract/runtime.ts` -- deterministic banner page segmentation without state leakage.
- `lib/replica/isolated-html-engine.ts` -- aggregate child-replacement diagnostics.
- `tests/` -- UI artifact, cache, OCR scaling/runner/controller, and mirror diagnostic regressions.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- granular child-list, custom-element definition state, ordinary CSSOM, and richer capacity diagnostics.

## Tasks & Acceptance

**Execution:**
- [x] Add a compact accessible refresh button wired to `refreshFollowedPage('manual')` and governed by the same disabled state as **Rebuild mirror**.
- [x] Key replica translation by trimmed core, lazily create OCR Translator sessions only on cache misses, partition DOM/OCR translation memory, and expose aggregate cache counters.
- [x] Upscale shallow OCR crops with a deterministic bounded profile, version recognition keys, select/restore Tesseract segmentation per crop, and preserve overlay coordinate mapping.
- [x] Extend isolated mirror logs with aggregate patch-kind and child-replacement sizes; document Reddit's architecture and the prioritized granular-patch follow-up.
- [x] Increment build identity, synchronize the ready-to-load artifact, and run the full project check.

**Acceptance Criteria:**
- The compact refresh and settings rebuild invoke one shared manual action and cannot overlap capture.
- Same-core whitespace variants call Chrome Translator once and project their original boundaries.
- A cache-hit image pass creates no new translation session; recognition cache remains separate and raw pixels remain transient.
- A D-U-N-S-shaped 275×30 crop is enlarged without exceeding 4 MP, uses banner segmentation, and its OCR geometry projects against the original CSS bounds.
- Reddit-like one-item async churn is visible in content-free replacement diagnostics, with no Reddit hostname code or weakened sandbox.
- `npm run check` passes and `dist/chrome-unpacked` displays the new version/build.

## Design Notes

Reddit is mostly server-rendered but depends on Lit custom-element definitions, shadow/light-DOM projection, partial loaders, and client state. Simul can faithfully mirror representable rendered DOM without running that code; closed roots, video, `:defined` state, ElementInternals, and script-only state remain real limits. The highest-value efficiency change is a future bounded insert/remove/move protocol that retains unchanged receiver nodes and translations. This pass adds evidence needed to implement and review that protocol safely rather than mixing it into OCR/cache fixes.

## Verification

- Focused Vitest suites for translation memory/coordinator, image capture/controller/Tesseract, isolated engine, and artifact markup.
- `npm run check` for typecheck, all tests, and installable artifact integrity.
- Installed Chrome: press the new corner refresh; inspect cache-hit diagnostics; retest the D-U-N-S header with Japanese→English; capture one Reddit patch diagnostic while expanding/scrolling.

## Implementation Result

- Added the compact rebuild control and one shared guarded manual-refresh handler.
- Split page and OCR-line translation memory, normalized page-text cache keys to
  translation cores, made image Translator sessions cache-miss-only, and added
  content-free aggregate counters.
- Added a versioned, CSS-geometry-classified shallow-banner profile with
  bounded 2x scaling for low-resolution crops and isolated Tesseract
  single-line mode with block-mode restoration.
- Added isolated-patch operation/replacement-size telemetry and recorded the
  generic stable-node Reddit follow-ups without adding hostname-specific code.
- Synchronized Chrome artifact version 0.2.2. `npm run check` passed with 51
  test files and 528 tests.

## Review Resolution

Blind and edge-case review produced patch-level findings only. The corrected
implementation now classifies banners independently of device pixel ratio,
selects segmentation from the preprocessing profile rather than raw bitmap
shape, rejects per-axis overflow before capture encoding, preserves exact-page
and boundary-whitespace cache semantics in the legacy renderer, counts both
incoming and outgoing replacement churn, and projects a scaled OCR regression
through original CSS coordinates. No intent or spec loopback was required.

## Suggested Review Order

**Entry and cache orchestration**

- Separate bounded memories make page and image reuse observable without sharing eviction pressure.
  [`main.ts:334`](../../entrypoints/sidepanel/main.ts#L334)

- Both rebuild controls invoke one guarded action and disable during active capture.
  [`main.ts:652`](../../entrypoints/sidepanel/main.ts#L652)

- The compact toolbar exposes rebuild without reopening the settings overlay.
  [`index.html:23`](../../entrypoints/sidepanel/index.html#L23)

- Legacy translation now preserves whitespace and scopes reuse to the exact document.
  [`main.ts:2037`](../../entrypoints/sidepanel/main.ts#L2037)

- Aggregate counters distinguish true provider work from cache-backed reprojection.
  [`translation-memory.ts:76`](../../lib/translation/translation-memory.ts#L76)

- OCR Translator sessions are created only when a region cache miss occurs.
  [`image-translation-controller.ts:822`](../../lib/ocr/image-translation-controller.ts#L822)

**D-U-N-S OCR path**

- CSS geometry classifies banners consistently across device pixel ratios.
  [`preprocessing-profile.ts:35`](../../lib/ocr/preprocessing-profile.ts#L35)

- Capture applies bounded scaling while retaining original CSS crop coordinates.
  [`pixel-acquisition.ts:167`](../../lib/ocr/pixel-acquisition.ts#L167)

- Tesseract switches segmentation from the versioned profile and restores defaults.
  [`runtime.ts:124`](../../lib/ocr/providers/tesseract/runtime.ts#L124)

**Reddit efficiency diagnostics**

- Patch metrics are captured before atomic replacement mutates the committed tree.
  [`isolated-html-engine.ts:474`](../../lib/replica/isolated-html-engine.ts#L474)

- Incoming and outgoing subtree sizes expose removal-only and replacement churn.
  [`isolated-html-engine.ts:1593`](../../lib/replica/isolated-html-engine.ts#L1593)

- Stable-node patches and custom-element state remain explicit reviewed follow-ups.
  [`deferred-work.md:78`](deferred-work.md#L78)

**Acceptance regressions and release**

- D-U-N-S sizing, high-DPI classification, and axis limits are unit-locked.
  [`pixel-acquisition.test.ts:132`](../../tests/pixel-acquisition.test.ts#L132)

- Scaled OCR boxes map through original crop geometry into the replica.
  [`image-overlay-projector.test.ts:122`](../../tests/image-overlay-projector.test.ts#L122)

- Removal-only mirror churn must remain visible in content-free diagnostics.
  [`isolated-html-engine.test.ts:388`](../../tests/isolated-html-engine.test.ts#L388)

- Same-core whitespace variants prove one provider call and exact boundary restoration.
  [`replica-translation-coordinator.test.ts:258`](../../tests/replica-translation-coordinator.test.ts#L258)

- Version 0.2.2 and compact refresh are validated in the installable artifact.
  [`extension-artifact.test.mjs:529`](../../tests/extension-artifact.test.mjs#L529)
