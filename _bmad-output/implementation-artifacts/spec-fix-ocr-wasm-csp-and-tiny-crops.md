---
title: 'Fix OCR embedded-Wasm CSP errors and tiny visible crops'
type: 'bugfix'
created: '2026-07-25'
status: 'done'
review_loop_iteration: 0
baseline_commit: '266a7af6ab2ac78415203f1d690e3ffbe8124ac7'
context:
  - '_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** PaddleOCR repeatedly asks Chrome to `fetch()` its embedded OpenCV Wasm `data:` URL before locally decoding it, so the deliberately strict sandbox CSP emits two errors whenever Paddle is reconstructed. Separately, a partly visible image can produce a 1–2 pixel crop that reaches either Tesseract runtime and causes the native `Image too small to scale!!` warning. These events recur around window/surface changes, although neither message alone proves that the shared OCR host is permanently lost.

**Approach:** Make the pinned Paddle vendoring transform route embedded Wasm directly through its existing local decoder without weakening CSP. Stop unusably narrow final crops at the pixel-acquisition boundary, after semantic text remains eligible but before any OCR surface/runtime is invoked, so later geometry changes may retry safely.

## Boundaries & Constraints

**Always:** Keep all OCR code, models, and execution local; retain the exact four-provider trial profile and current licenses; preserve `connect-src 'self'`, extension permissions, password exclusions, accessibility-first overlays, provider ordering, caches, and bounded infrastructure retry behavior. Patch pinned third-party output reproducibly through its guarded vendoring tool, regenerate catalog hashes, advance the visible beta identity to `.14`, rebuild `dist/chrome-unpacked`, and leave all work uncommitted on `feat/replica-read-scope-redesign`.

**Ask First:** A new dependency, provider, host permission, remote endpoint, CSP expansion, credential flow, or change that reads password values; any commit, push, merge, or work on `main`.

**Never:** Permit `data:` network connections; suppress global browser errors; hand-edit generated vendor or `dist` files; pad a crop with neighboring page pixels; reject a candidate before its accessibility text can be translated; treat a warning as recognized text; claim the window-switch outage is fixed without evidence.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Paddle startup | Pinned worker contains embedded OpenCV Wasm as `data:application/octet-stream;base64,…` | Decode locally; no `fetch(data:…)`; strict CSP remains unchanged | Vendoring fails closed if the reviewed loader shape or match count changes |
| Narrow visible sliver | Final preprocessed OCR axis is 1–2 pixels | Defer pixel OCR before surface creation; semantic/ALT path remains available | Non-transient deferral waits for a later observation/geometry revision |
| Minimum boundary | Both final OCR axes are at least 3 pixels | Existing crop, hash, cache, and provider flow continues | Existing bounded provider/host errors apply |
| Window/surface transition | Paddle sandbox or OCR worker is recreated | Recreated runtime follows the corrected local loader; stale jobs retain existing cancel/retry semantics | Do not add speculative global host recycling in this change |

</frozen-after-approval>

## Code Map

- `tools/vendor-paddle-ocr.mjs` -- guarded transform and validated Paddle catalog generation.
- `vendor/ocr/paddle/` -- generated pinned worker and integrity manifest.
- `lib/ocr/pixel-acquisition.ts` -- visible crop, preprocessing, and OCR-only admission boundary.
- `lib/ocr/providers/paddleocr-wasm/runtime.ts` -- sandbox lifecycle and bounded recovery after cancellation or an exact source-document change.
- `tests/paddleocr-assets.test.mjs` -- vendored loader and strict-boundary regression coverage.
- `tests/pixel-acquisition.test.ts` -- tiny-axis and 3-pixel boundary coverage.
- `tests/image-translation-controller.test.ts` -- semantic fallback behavior after pixel deferral.
- `wxt.config.ts`, `README.md`, `tests/extension-artifact.test.mjs` -- visible beta build identity.

## Tasks & Acceptance

**Execution:**
- [x] `tools/vendor-paddle-ocr.mjs` and `tests/paddleocr-assets.test.mjs` -- guard the one reviewed OpenCV loader and prove embedded Wasm cannot enter its fetch branch.
- [x] `lib/ocr/pixel-acquisition.ts`, `tests/pixel-acquisition.test.ts`, and `tests/image-translation-controller.test.ts` -- add a minimum final-axis deferral while preserving accessibility fallback and the 3-pixel boundary.
- [x] `lib/ocr/providers/paddleocr-wasm/runtime.ts` and `tests/paddleocr-provider.test.ts` -- scope cached startup state to the exact source document and clear it on cancellation so a later window/source can retry without reopening the extension.
- [x] Generated Paddle catalog and beta identity files -- regenerate hashes, advance to `.14`, and synchronize the exact trial artifact.

**Acceptance Criteria:**
- Given a fresh Paddle sandbox, when its embedded OpenCV runtime initializes, then Chrome receives no `fetch()` request for the `data:` Wasm URL and the CSP still allows connections only to self.
- Given a large image represented by only a 2×36 or 36×2 visible sliver, when capture runs, then no OCR surface/provider is called and available accessibility text can still be translated.
- Given a 3×36 final crop, when capture runs, then it remains OCR-eligible.
- Given the completed change, when project and artifact checks run, then the exact four-provider `.14` unpacked build passes without changing HEAD, hooks, branch, or remote state.

## Spec Change Log

## Design Notes

The three-pixel rule belongs after preprocessing because Tesseract’s native scaler requires a minimum axis of three, while earlier candidate rejection would also discard fast semantic labels. Local decoding is safer than CSP expansion: the Wasm bytes are already embedded and integrity-pinned, and the existing fallback already knows how to decode them.

## Verification

**Commands:**
- `npm run vendor:ocr-paddle` -- regenerated pinned catalog validates and replaces atomically.
- `npm test -- tests/paddleocr-assets.test.mjs tests/pixel-acquisition.test.ts tests/image-translation-controller.test.ts` -- focused regressions pass.
- `npm run artifact:sync:ocr-trials && npm run check` -- exact four-provider `.14` unpacked artifact and full project checks pass.
- Git branch/HEAD/hook probes -- branch remains isolated, HEAD unchanged, no commit or push occurs.

## Suggested Review Order

**Strict local Paddle startup**

- Rewrites one integrity-pinned loader branch so embedded Wasm decodes locally under strict CSP.
  [`vendor-paddle-ocr.mjs:656`](../../tools/vendor-paddle-ocr.mjs#L656)

- Scopes cached terminal startup failures to one exact source document before retrying.
  [`runtime.ts:105`](../../lib/ocr/providers/paddleocr-wasm/runtime.ts#L105)

**Safe OCR crop admission**

- Defers sub-three-pixel final crops without excluding semantic ALT/accessibility text.
  [`pixel-acquisition.ts:214`](../../lib/ocr/pixel-acquisition.ts#L214)

**Regression evidence and identity**

- Proves the vendored loader shape fails closed and cannot retain `fetch(data:)`.
  [`paddleocr-assets.test.mjs:245`](../../tests/paddleocr-assets.test.mjs#L245)

- Covers same-document caching plus recovery on cancellation and document change.
  [`paddleocr-provider.test.ts:476`](../../tests/paddleocr-provider.test.ts#L476)

- Verifies both narrow axes defer while the three-pixel boundary remains eligible.
  [`pixel-acquisition.test.ts:135`](../../tests/pixel-acquisition.test.ts#L135)

- Confirms tiny-crop deferral still reaches the translated accessibility fallback.
  [`image-translation-controller.test.ts:3987`](../../tests/image-translation-controller.test.ts#L3987)

- Makes the rebuilt manual-test artifact visibly identifiable as beta `.14`.
  [`wxt.config.ts:12`](../../wxt.config.ts#L12)
