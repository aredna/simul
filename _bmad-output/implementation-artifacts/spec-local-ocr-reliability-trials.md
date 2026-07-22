---
title: 'Local OCR reliability trials with PaddleOCR.js'
type: 'feature'
created: '2026-07-22'
status: 'done'
review_loop_iteration: 0
baseline_commit: '746af63e92a52e90e623bf164fecbd02a4281096'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/docs/image-translation-research.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Simul accepts the first OCR line containing any letter or digit at confidence 0.25, including results with no confidence. TextDetector and Tesseract can therefore turn non-text patterns into cached translated overlays.

**Approach:** Add official PaddleOCR.js with PP-OCRv6-tiny as a local, default-off precision trial. Add a persisted options-screen confidence control, tighten selection so weak/confidence-free output cannot win alone, and make a clean Paddle empty result terminal instead of falling through to Tesseract.

## Boundaries & Constraints

**Always:** Work only on local branch `feat/ocr-reliability-trials`; keep `main` and remotes untouched. Pin exact SDK/runtime/models; package every Worker, Wasm, ONNX model, config, hash, license, and notice locally. Compile Paddle only with `SIMUL_OCR_PADDLE=1`, provide a Paddle-only trial command with Tesseract disabled, preserve current privacy/currentness limits, and favor precision. Persist a minimum-confidence preference from 0.25 through 0.95 in 0.05 steps, default it to 0.65, apply it to scored Paddle/Tesseract regions, and include it with the quality policy in cache/currentness keys.

**Ask First:** Enabling Paddle by default; changing the 42 MiB release cap; adding permissions, network/model downloads, durable OCR data, another provider, or production-default changes.

**Never:** Push; send pixels/text off-device; exceed existing transient retention; use remote fallbacks or private Screen AI; add Transformers.js; fall through after Paddle reports no text; or mutate source/replica layout.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Ordinary build | Paddle flag unset | Existing artifact remains reproducible | No Paddle code/assets may leak |
| Precision trial | Paddle on; Tesseract off | Local PP-OCRv6-tiny returns validated scored polygons | Runtime/asset failure degrades OCR only; no network fallback |
| Non-text/weak crop | No boxes, low/missing score, punctuation, or invalid geometry | No cacheable positive or overlay; Paddle empty is terminal | Reject malformed output; never invoke Tesseract |
| Valid text | Accepted scored lines | Normalize, translate, and project through existing stale guards | Reject the whole result on invalid dimensions/polygons |
| Threshold change | User selects 25%–95% in Options | Persist the value, clear obsolete projections, and re-evaluate current images under a distinct cache key | Repair invalid stored values to 65%; reject malformed runtime commands |

</frozen-after-approval>

## Code Map

- `lib/ocr/providers/paddleocr-wasm/` -- descriptor, offscreen runner, normalization, lifecycle, and asset routing.
- `lib/ocr/{offscreen-protocol,image-analysis-coordinator,result-quality}.ts` -- typed jobs, terminal-empty routing, quality decisions, and cache identity.
- `lib/preferences.ts`, `lib/preference-coordinator.ts`, `entrypoints/sidepanel/` -- bounded persistence, strict commands, and accessible confidence control.
- `tools/{ocr-build-profile,vendor-paddle-ocr,extension-artifact}.*`, `wxt.config.ts` -- deterministic provider profiles/assets/CSP and artifact validation.
- `package*.json`, `vendor/ocr/paddle/`, `legal/`, `tests/`, `docs/` -- exact dependencies/assets/legal evidence, regressions, and trial guidance.

## Tasks & Acceptance

**Execution:**
- [x] `package*.json`, `tools/vendor-paddle-ocr.mjs`, `vendor/ocr/paddle/`, `legal/` -- pin the SDK/ORT and vendor verified PP-OCRv6-tiny runtime/model/legal assets.
- [x] `lib/ocr/providers/paddleocr-wasm/`, `lib/ocr/offscreen-protocol.ts` -- implement the gated runner, strict normalization, bounded lifecycle, and typed job identity.
- [x] `lib/ocr/result-quality.ts`, `lib/ocr/image-analysis-coordinator.ts` -- add threshold-driven quality decisions, terminal Paddle empty, corroboration, and provider cache identity.
- [x] `lib/preferences.ts`, `lib/preference-coordinator.ts`, `entrypoints/sidepanel/` -- persist, validate, render, and apply the 25%–95% confidence option; threshold changes reprocess current images.
- [x] `package.json`, `tools/ocr-build-profile.ts`, `wxt.config.ts`, `tools/extension-artifact.mjs`, `tests/`, `docs/` -- add the Paddle-only check, profile isolation/validation, threshold/text/non-text regressions, and trial guidance without changing the canonical artifact.

**Acceptance Criteria:**
- Given `npm run check`, when the normal profile builds, then its artifact is reproducible and Paddle-free.
- Given an offline Paddle-only trial, when valid text is recognized, then only packaged assets run and scored polygons reach existing currentness guards.
- Given non-text or low-confidence pixels, when Paddle completes, then no overlay is produced and Tesseract is not invoked.
- Given a user changes minimum confidence, when the preference commits, then the options value survives reload and current OCR projections are re-evaluated using the new threshold without reusing an incompatible cache entry.
- Given malformed, stale, cancelled, timed-out, or corrupt work, when it settles, then OCR degrades without stale projection, leaked input, unbounded retry, or page-translation failure.

## Spec Change Log

## Design Notes

Use official `PP-OCRv6_tiny_det`/`PP-OCRv6_tiny_rec` archives with single-threaded SIMD Wasm. Keep detector/box thresholds fixed at 0.45/0.75; use the saved 0.65 default as the scored-region acceptance threshold and include its selected value in the policy key. A meaningful scored region is accepted at or above the selected threshold, uncertain from 0.25 up to that threshold or when confidence is missing, and rejected below 0.25. Confidence-free TextDetector output never becomes authoritative solely because the slider is lowered; uncertain corroboration requires equal NFKC/collapsed-whitespace text and box IoU >=0.5 from another provider. These are calibration values, not an accuracy claim; representative hard negatives are required before promotion.

## Verification

**Commands:**
- `npm run test -- --run tests/ocr-result-quality.test.ts tests/offscreen-ocr.test.ts tests/paddleocr-provider.test.ts tests/ocr-build-profile.test.ts` -- focused coverage passes.
- `npm run check` -- full canonical gates pass.
- `npm run check:ocr-paddle-trial` -- the offline Paddle artifact has exact assets/runtime and no Tesseract assets.

**Manual checks:**
- Load the local trial on text plus blank, photographic, patterned, and logo-only negatives; no-text images stay unchanged and diagnostics remain content-free.

## Suggested Review Order

1. [OCR coordinator](../../lib/ocr/image-analysis-coordinator.ts#L260) — Trace provider routing, terminal-empty behavior, filtering, and cache identity.
2. [Paddle runtime](../../lib/ocr/providers/paddleocr-wasm/runtime.ts#L53) — Inspect local assets, pipeline lifetime, cancellation, and deadlines.
3. [Paddle normalization](../../lib/ocr/providers/paddleocr-wasm/normalize.ts#L12) — Verify strict confidence, geometry, and transcript bounds.
4. [Quality policy](../../lib/ocr/result-quality.ts#L60) — Review threshold decisions and independent corroboration.
5. [Preferences](../../lib/preferences.ts#L96) and [coordination](../../lib/preference-coordinator.ts#L90) — Check repair, persistence, and command validation.
6. [Options control](../../entrypoints/sidepanel/main.ts#L3416) — Confirm accessible 25%–95% user adjustment.
7. [Translation controller](../../lib/ocr/image-translation-controller.ts#L840) — Follow threshold currentness and projection reprocessing.
8. [Build profile](../../tools/ocr-build-profile.ts#L1) and [artifact gate](../../tools/extension-artifact.mjs#L631) — Confirm canonical isolation and Paddle-only validation.
9. [Vendoring](../../tools/vendor-paddle-ocr.mjs#L97) — Audit pinned sources, hashes, staging, and bounded downloads.
10. [Provider tests](../../tests/paddleocr-provider.test.ts#L19), [quality tests](../../tests/ocr-result-quality.test.ts#L14), and [artifact tests](../../tests/extension-artifact.test.mjs#L690) — Exercise reliability and packaging boundaries.
11. [Research notes](../../docs/image-translation-research.md#L18) — Review provider selection and deferred alternatives.
