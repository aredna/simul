---
title: 'Multi-provider OCR testing across both replica engines'
type: 'feature'
created: '2026-07-22'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'ad64fbd909f4252c78fd0ac53f2b8801c5e89088'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-local-ocr-reliability-trials.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The installed Paddle-only trial hides the other usable OCR providers, its background worker rejects Paddle before opening the offscreen host, and rrweb can complete a replica without producing OCR work when source images lack usable rrweb identities.

**Approach:** Provide one local testing artifact containing PaddleOCR, Chrome TextDetector, Tesseract.js, and a clearly labeled direct Tesseract-Wasm runtime in visible priority order, with persisted per-provider toggles. Repair the offscreen readiness gate and make both Integrated and rrweb reliably hand normal image candidates to the same ordered OCR pipeline.

## Boundaries & Constraints

**Always:** Work only on `feat/ocr-reliability-trials`; do not alter `main` or remotes. Default testing priority is PaddleOCR, Chrome TextDetector, Tesseract.js, then Tesseract WASM (direct). List every compiled provider even when off, persist toggles, and include the enabled ordered subset in existing currentness/cache boundaries. Keep all pixels, text, models, Workers, and Wasm local. Verify both code and model licenses before adding a trial provider; package required notices and only use permissively redistributable components compatible with Simul's MIT distribution and Chrome Web Store Manifest V3 rules. Treat both Tesseract bindings as one provider family so they can never independently corroborate each other. Preserve a truly empty Paddle result as terminal, but allow uncertain Paddle candidates to continue for independent corroboration. Keep the normal release profile unchanged and capped at 42 MiB; use a closed, exact-four-provider local trial profile capped at 72 MiB.

**Ask First:** Enabling a trial-only provider in the normal release, changing the production cap, or adding permissions/host matches.

**Never:** Push, merge to `main`, use remote OCR/private Screen AI, package code or model weights with unclear, GPL, AGPL, share-alike, or noncommercial redistribution terms, invent a second rrweb node-ID namespace, treat Tesseract.js and direct Tesseract-Wasm as independent corroborators, weaken stale-result/privacy guards, or cache raw OCR inputs durably.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| All providers on | Local trial on Chrome/macOS | UI lists Paddle, TextDetector, Tesseract.js, and Tesseract WASM (direct) in priority order; first accepted result wins | Provider-specific unavailability falls through; macOS TextDetector may be unavailable or detection-only |
| Provider toggled off | Saved provider checkbox cleared | Provider is skipped immediately; current work/projections rebuild under a distinct key | All off pauses OCR without a retry loop |
| Paddle-only | Other providers off | Background creates the offscreen host and runs packaged Paddle assets | Genuine host failure remains bounded and diagnostic |
| rrweb image page | Committed rrweb replica with ordinary images | Source scan obtains replay-compatible IDs and schedules OCR | Missing IDs receive bounded same-document recovery, never fabricated IDs |
| Weak/no text | Empty or uncertain Paddle result | Empty is terminal; uncertain candidates may be corroborated downstream | Uncorroborated or low-confidence text produces no overlay |

</frozen-after-approval>

## Code Map

- `lib/ocr/known-provider-ids.ts`, `lib/preferences.ts`, `lib/preference-coordinator.ts` -- priority, toggle persistence, repair, and strict command validation.
- `entrypoints/sidepanel/main.ts`, `entrypoints/sidepanel/style.css` -- ordered provider controls and enabled-route derivation.
- `entrypoints/background.ts`, `lib/ocr/image-analysis-coordinator.ts` -- offscreen eligibility and ordered fallback/quality behavior.
- `lib/replica/page-recorder.ts`, `lib/ocr/{image-source-session,source-image-observer}.ts` -- rrweb source/replay identity readiness and bounded rediscovery.
- `lib/ocr/providers/tesseract-wasm-direct/`, `vendor/ocr/tesseract-wasm/` -- separately labeled direct runtime, normalization, packaged runtime assets, and legal notices.
- `tools/{ocr-build-profile,extension-artifact}.*`, `wxt.config.ts`, `package.json` -- exact combined trial build, validation, and atomic unpacked-folder sync.

## Tasks & Acceptance

**Execution:**
- [x] `lib/ocr/known-provider-ids.ts`, `lib/preferences.ts`, `lib/preference-coordinator.ts` -- add the runtime priority, migrate the exact legacy default, and persist a repaired disabled-provider subset.
- [x] `entrypoints/sidepanel/main.ts`, `entrypoints/sidepanel/style.css` -- render accessible toggles beside every compiled provider and configure only enabled providers without losing reorder controls.
- [x] `lib/ocr/providers/tesseract-wasm-direct/`, provider protocol/registry code, `vendor/ocr/tesseract-wasm/`, and legal manifests -- add the local BSD/Apache direct Tesseract runtime, while keeping it in the same corroboration family as Tesseract.js.
- [x] `entrypoints/background.ts`, `lib/ocr/image-analysis-coordinator.ts` -- admit every compiled runtime provider and preserve precise empty/uncertain fallback semantics.
- [x] `lib/replica/page-recorder.ts`, `lib/ocr/{image-source-session,source-image-observer}.ts` -- synchronize rrweb image discovery with live mirror identity and recover boundedly when IDs are not ready.
- [x] `tools/extension-artifact.mjs`, `tools/ocr-build-profile.ts`, `package.json`, `docs/` -- add an exact four-provider check/sync command and dependency/asset/license validation while preserving canonical release gates.
- [x] `tests/` -- cover preference repair/commands/UI/currentness, Paddle-only host readiness, all-provider packaging, ordered fallback, and live rrweb image-source-to-anchor flow.

**Acceptance Criteria:**
- Given either Integrated or rrweb, when image translation is enabled with at least one provider, then a normal visible image reaches that enabled ordered route.
- Given the local trial sync command, when it completes, then `dist/chrome-unpacked` validates with exactly all four providers and can be refreshed in Chrome.
- Given `npm run check`, when canonical gates run, then the ordinary 42 MiB Paddle-free release remains reproducible.

## Spec Change Log

## Design Notes

The measured three-provider artifact was 69,580,478 bytes; the validated four-provider artifact is 73,405,493 bytes. The elevated 72 MiB allowance is accepted only for that exact local four-provider profile; arbitrary caps and provider sets remain rejected. Chrome TextDetector is platform-dependent and confidence-free; Chromium's macOS implementation may return geometry without decoded text, so it may show as compiled yet fall through and cannot project uncorroborated text alone. Direct Tesseract-Wasm is a runtime A/B comparison, not an independent recognition family.

## Verification

**Commands:**
- `npm run check` -- canonical type, test, and reproducible release gates pass.
- `npm run check:ocr-paddle-trial` -- Paddle-only readiness and packaged runtime pass.
- `npm run check:ocr-all-trial` -- exact combined local profile passes under the trial-only cap.
- `npm run artifact:sync:ocr-trials` -- validated combined artifact replaces only `dist/chrome-unpacked`.

**Manual checks:**
- Refresh unpacked Simul in Chrome on macOS; test each provider alone and all-on in both replica engines, including text, blank, photo, pattern, and logo images.

## Suggested Review Order

### Provider controls and routing

- Provider controls derive the enabled route while preserving user priority.
  [Side-panel configuration](../../entrypoints/sidepanel/main.ts#L3339)
- Canonical identifiers repair legacy priority and persisted disabled-provider subsets.
  [Provider identifiers](../../lib/ocr/known-provider-ids.ts#L1)
- Ordered fallback distinguishes empty Paddle results from uncertain candidates.
  [Recognition coordinator](../../lib/ocr/image-analysis-coordinator.ts#L223)
- Runtime readiness accepts every compiled provider, including Paddle-only trials.
  [Background host gate](../../entrypoints/background.ts#L192)
- Both Tesseract bindings remain one corroboration family.
  [Result-quality policy](../../lib/ocr/result-quality.ts#L194)

### rrweb image discovery

- Full rrweb snapshots refresh image discovery against the recorder mirror.
  [Page recorder](../../lib/replica/page-recorder.ts#L138)
- Missing rrweb identities receive bounded retries and explicit cleanup.
  [Source image observer](../../lib/ocr/source-image-observer.ts#L596)

### Direct Tesseract runtime

- Direct runtime loads only packaged Worker, Wasm, and single-language models.
  [Direct runtime](../../lib/ocr/providers/tesseract-wasm-direct/runtime.ts#L111)
- Normalization rejects malformed confidence, geometry, and oversized transcripts.
  [Direct result normalizer](../../lib/ocr/providers/tesseract-wasm-direct/normalize.ts#L20)
- Build transforms require every pinned local-asset fallback to remain recognizable.
  [WXT build guard](../../wxt.config.ts#L111)
- Vendor generation pins provenance, licenses, hashes, and Worker fallback rewrites.
  [Vendor generator](../../tools/vendor-tesseract-wasm.mjs#L6)

### Packaging and verification

- Build profiles keep production defaults separate from exact trial providers.
  [OCR build profile](../../tools/ocr-build-profile.ts#L27)
- Artifact validation enforces exact providers, local assets, notices, and caps.
  [Artifact validator](../../tools/extension-artifact.mjs#L377)
- Direct-provider tests cover normalization, unsupported groups, cancellation, and lifecycle.
  [Direct-provider tests](../../tests/tesseract-wasm-direct-provider.test.ts#L14)
- Packaging tests exercise canonical, Paddle-only, and all-provider trial boundaries.
  [Artifact tests](../../tests/extension-artifact.test.mjs#L663)
