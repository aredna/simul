---
title: 'Make the local OCR trial providers and rrweb path testable'
type: 'bugfix'
created: '2026-07-22'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'c921acb43292597f66f36c641bbc96d0ecf9682f'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The four-provider trial is selectable but unreliable: Paddle collapses CSP/loader defects into `worker-lost`, TextDetector reports a missing experimental API only after capture, and rrweb can show no OCR activity before replica activation. The shared lineage of the two Tesseract choices is also unclear.

**Approach:** Expose real runtime states, run Paddle only in Chrome's unprivileged extension sandbox with its complete pinned runtime, and use the committed post-run replica snapshot as the single initial OCR activation boundary. Keep ordered fallback while explaining unavailable providers and the Tesseract A/B relationship.

## Boundaries & Constraints

**Always:** Work only on `feat/ocr-reliability-trials`; keep code/models local, pinned, hashed, license-compatible, and Web-Store-eligible; retain the exact four-provider order/toggles and confidence control; keep privileged CSP strict and diagnostics content-free; preserve production defaults, permissions, provider set, and cap; finish by syncing the verified trial to `dist/chrome-unpacked` without pushing or merging.

**Ask First:** Any new permission/host match, remotely fetched executable/model asset, fifth OCR provider, production-default change, or release-size-cap change.

**Never:** Add `'unsafe-eval'` to `extension_pages`; run Paddle dynamic code in a privileged context; log page content/identity; retry deterministic unavailability; claim TextDetector is universal; treat the Tesseract adapters as independent corroboration; push or merge.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Paddle | Paddle first; English image; current Chrome/macOS | Sandbox initializes once and returns normalized OCR | Unsupported environments fall through once with a bounded startup code |
| TextDetector absent | Usable-detect probe fails | Toggle stays listed and shows unavailable; no job is sent | Continue to the next provider |
| TextDetector present | Probe and language succeed | Normalize platform text/geometry | Boxes-only/empty may assist then fall through |
| rrweb committed | Current matching snapshot | Activate once; emit ready/connect/scan/schedule | Live commits only update the lease |
| rrweb not committed | Failed/skipped/stale/mismatch/no snapshot | Do not open an OCR source | Emit one bounded `not-activated` reason |
| Tesseract A/B | Either adapter enabled | Explain shared engine/models and expected similar text | Never cross-corroborate |

</frozen-after-approval>

## Code Map

- `wxt.config.ts`, Paddle sandbox entrypoints, and `tools/vendor-paddle-ocr.mjs` -- sandbox CSP/manifest and complete pinned ONNX assets.
- `lib/ocr/providers/paddleocr-wasm/`, `lib/ocr/offscreen-host.ts` -- transport, lifecycle, failures, and fallback.
- `lib/ocr/providers/chrome-text-detector/`, `lib/ocr/provider-registry.ts` -- usable-detect probe and status.
- `entrypoints/sidepanel/main.ts`, `lib/ocr/diagnostic-history.ts` -- labels/status and replica activation diagnostics.
- `lib/replica/page-recorder.ts` and rrweb tests -- production-order image identity coverage.
- `tools/extension-artifact.mjs` and tests -- CSP, manifest, hashes, notices, and trial validation.

## Tasks & Acceptance

**Execution:**
- [x] Paddle sandbox/vendor/runtime -- isolate dynamic execution, add the paired ONNX loader, preserve bounded failures, and avoid deterministic retries.
- [x] TextDetector probe/settings -- show usable runtime status without removing the toggle; skip unavailable jobs.
- [x] Replica orchestration/diagnostics -- activate once from the post-run committed snapshot and report every pre-activation result.
- [x] Provider copy -- distinguish wrapper/direct Tesseract while stating their shared family/models.
- [x] Focused, artifact, and real-Chrome tests -- cover CSP, assets, fallback, probes, engine switching, and commit-before-image-port order.

**Acceptance Criteria:**
- Each provider enabled alone produces OCR or a clear availability/startup result; none silently does nothing.
- Paddle initializes and recognizes the English test image on current Chrome/macOS without privileged `'unsafe-eval'`; unsupported environments fail once with a specific bounded code.
- A successful rrweb commit reaches `replica ready -> source connecting -> source connected -> source scan`; no commit reports why.
- Tesseract copy explains expected similarity, and tests enforce one corroboration family.
- Production stays unchanged; the exact trial validates and is synced to `dist/chrome-unpacked`.

## Verification

**Commands:**
- `npx vitest run <focused tests>` -- OCR, replica, settings, and artifact regressions pass.
- `npm run check:ocr-all-trial` -- exact trial assets/CSP/notices/cap pass.
- `npm run check` -- full gate passes.
- `npm run artifact:sync:ocr-trials` -- prepares the unpacked trial after checks.

**Manual checks:**
- Reload `dist/chrome-unpacked` on Chrome/macOS; test each provider alone on the same English image in Integrated and rrweb modes and verify the matrix.

## Suggested Review Order

1. [Paddle privileged adapter](../../lib/ocr/providers/paddleocr-wasm/runtime.ts#L54) — Owns total deadlines, retry policy, and sandbox lifecycle.
2. [Paddle direct pipeline](../../lib/ocr/providers/paddleocr-wasm/sandbox-worker-pipeline.ts#L32) — Imports the pinned loader before initializing Paddle.
3. [Paddle sandbox protocol](../../lib/ocr/providers/paddleocr-wasm/sandbox-protocol.ts#L4) — Bounds payloads and admits only exact local asset paths.
4. [Paddle sandbox entrypoint](../../entrypoints/paddle-ocr.sandbox/main.ts#L27) — Serializes requests and returns only bounded protocol responses.
5. [Pinned bundle patch](../../tools/vendor-paddle-ocr.mjs#L643) — Converts one reviewed Worker attach point into a direct export.
6. [Manifest CSP generation](../../wxt.config.ts#L21) — Confines dynamic Paddle execution to the sandbox CSP.
7. [TextDetector preflight](../../entrypoints/sidepanel/main.ts#L3384) — Removes unusable platform jobs before image capture.
8. [Probe readiness policy](../../lib/ocr/runtime-provider-readiness.ts#L16) — Allows one retry only after an inconclusive platform probe.
9. [Provider controls](../../entrypoints/sidepanel/main.ts#L3433) — Retains ordered toggles, statuses, confidence, and Tesseract A/B copy.
10. [rrweb activation checkpoint](../../entrypoints/sidepanel/main.ts#L1828) — Makes engine completion the sole initial OCR activation boundary.
11. [rrweb live commit handling](../../entrypoints/sidepanel/main.ts#L507) — Advances existing leases without racing initial activation.
12. [Pure activation rules](../../lib/ocr/replica-activation.ts#L42) — Makes every non-activation outcome bounded and testable.
13. [Artifact manifest guard](../../tools/extension-artifact.mjs#L1130) — Enforces exact CSP, sandbox, permissions, and profile boundaries.
14. [Production-order rrweb test](../../tests/page-recorder.test.ts#L285) — Proves image discovery when commit precedes image-port connection.
15. [Paddle lifecycle tests](../../tests/paddleocr-provider.test.ts#L405) — Covers total deadline, cancellation, transient retries, and deterministic failures.
