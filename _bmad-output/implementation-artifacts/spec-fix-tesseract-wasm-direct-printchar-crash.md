---
title: 'Stop Tesseract WASM Direct native output from becoming Chrome extension errors'
type: 'bugfix'
created: '2026-07-24'
status: 'done'
review_loop_iteration: 0
baseline_commit: '266a7af6ab2ac78415203f1d690e3ffbe8124ac7'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Tesseract WASM Direct sends ordinary native stderr through Emscripten's `printChar` to `console.warn`. Chrome records it under the red Errors control with `offscreen.html` context, making successful OCR look like a crash. The generated helper also assumes every write uses descriptor 1 or 2 and can dereference an absent buffer otherwise.

**Approach:** Extend the deterministic vendoring transform with a content-free, non-warning Tesseract stderr sink and an unexpected-descriptor buffer guard. Preserve real rejection, teardown, `worker-lost` fallback, OCR output, and all other warnings.

## Boundaries & Constraints

**Always:** Patch pinned `tesseract-wasm@0.11.0` through the vendoring tool; fail generation if reviewed snippets change or match unexpectedly; regenerate hashes/provenance; retain local-only execution, permissions/CSP, provider order/toggles, confidence behavior, and the four-provider trial; keep output content-free; leave work uncommitted on `feat/replica-read-scope-redesign` and sync the verified build to `dist/chrome-unpacked`.

**Ask First:** Dependency upgrades, permissions/host matches, remote executable/model loading, a fifth provider, or production-default changes.

**Never:** Globally suppress `console.warn`; silence Comlink security warnings; hand-edit vendor output or `dist`; convert genuine rejection to success; merge, commit, push, or modify main/remote refs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Successful OCR diagnostic | Recognition emits a resolution estimate on stderr | OCR is unchanged; Chrome records no `printChar` warning/error | Do not expose native text as warning/error output |
| Unexpected descriptor | `_fd_write` reaches `printChar` with a descriptor other than 1 or 2 | Use a safe fallback buffer | No absent-buffer dereference |
| Genuine worker failure | Module, model, or recognition rejects | Drop client and report `worker-lost`; ordered fallback continues | Never resolve failure as success |
| Other warning | Comlink rejects an origin | Existing warning remains visible | Security reporting is unchanged |

</frozen-after-approval>

## Code Map

- `tools/vendor-tesseract-wasm.mjs` -- reproducible transforms, exact-match guards, hashes, and provenance.
- `vendor/ocr/tesseract-wasm/` -- generated worker/integrity output; never edited directly.
- `tests/tesseract-wasm-direct-assets.test.mjs` -- transform, local-only, license, byte, and hash assertions.
- `tests/tesseract-wasm-direct-provider.test.ts` -- rejection-to-`worker-lost` coverage.
- `wxt.config.ts`, `README.md`, `tests/extension-artifact.test.mjs` -- next beta identity and artifact contract.

## Tasks & Acceptance

**Execution:**
- [x] `tools/vendor-tesseract-wasm.mjs` -- add fail-fast native-output transforms and accurate provenance without changing global warnings.
- [x] Direct-provider tests -- require both guards and prove genuine rejection still tears down the client as `worker-lost`.
- [x] Build-identity sources/tests -- advance `.9` to `.10` consistently.
- [x] Regenerate assets, run focused/full checks, validate the exact trial, and sync `dist/chrome-unpacked` without commit/push.

**Acceptance Criteria:**
- Successful OCR with native stderr returns unchanged without a `printChar` entry on `chrome://extensions`.
- An unexpected write descriptor cannot cause an absent-buffer exception.
- Genuine rejection discards the client, reports `worker-lost`, and permits ordered fallback.
- The synced trial shows `.10`; all four providers remain available in the same order.

## Spec Change Log

## Design Notes

The stack alone does not show a thrown exception. The pinned engine locally recognized `TEST` at 0.946 confidence while emitting `Estimating resolution as 622` through this frame. Chrome retains extension `console.warn` calls in its Errors UI, so patch the Tesseract module sink, not the worker's global console/Comlink bundle.

## Verification

**Commands:**
- `npm run vendor:ocr-tesseract-wasm` -- deterministic worker/provenance/manifest regeneration.
- `npx vitest run tests/tesseract-wasm-direct-assets.test.mjs tests/tesseract-wasm-direct-provider.test.ts tests/extension-artifact.test.mjs` -- focused regressions pass.
- `npm run check` -- full gate passes.
- `npm run artifact:sync:ocr-trials && npm run artifact:check:ocr-trials` -- unpacked trial matches.

**Manual checks:**
- Clear existing Errors, reload the unpacked trial, hard-refresh a page, select Direct alone, and confirm English/Japanese OCR creates no `printChar` entry while a real failure remains bounded and falls through.

## Suggested Review Order

**Deterministic worker boundary**

- Start here: exact transforms reject upstream drift and pre-patched input.
  [`vendor-tesseract-wasm.mjs:160`](../../tools/vendor-tesseract-wasm.mjs#L160)

- The generated bridge discards routine stderr, caps buffering, and preserves fatal warnings.
  [`tesseract-worker.js:349`](../../vendor/ocr/tesseract-wasm/worker/tesseract-worker.js#L349)

- Provenance records every intentional deviation from the permissively licensed upstream worker.
  [`PROVENANCE.txt:14`](../../vendor/ocr/tesseract-wasm/PROVENANCE.txt#L14)

**Failure and packaging invariants**

- Genuine recognition rejection still destroys the client and surfaces `worker-lost`.
  [`tesseract-wasm-direct-provider.test.ts:171`](../../tests/tesseract-wasm-direct-provider.test.ts#L171)

- Artifact validation admits only the newly identified, hashed worker transform.
  [`extension-artifact.mjs:1911`](../../tools/extension-artifact.mjs#L1911)

**Behavioral regression and test identity**

- VM execution proves stdout, silent stderr, descriptor fallback, cap, and reset behavior.
  [`tesseract-wasm-direct-assets.test.mjs:102`](../../tests/tesseract-wasm-direct-assets.test.mjs#L102)

- The manifest-derived beta suffix uniquely identifies this test build.
  [`wxt.config.ts:12`](../../wxt.config.ts#L12)

- Tester instructions point Chrome at the same `.10` unpacked build.
  [`README.md:87`](../../README.md#L87)
