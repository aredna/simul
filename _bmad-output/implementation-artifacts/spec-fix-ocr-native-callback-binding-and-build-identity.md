---
title: 'Fix OCR native callback binding and expose build identity'
type: 'bugfix'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 0
baseline_commit: '654d8e9d8ce50d096599052bd17a6f7ae5ac7797'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** In Chrome, Isolated HTML reaches `replica-ready` and then OCR aborts with `TypeError: Illegal invocation`. Native browser scheduling functions are copied into class fields and later called with the class instance as their receiver instead of their owning global object. The installed extension also has no visible build identity, making it difficult to confirm that Chrome loaded the rebuilt artifact.

**Approach:** Normalize native timeout and animation-frame callbacks behind receiver-safe closures throughout the OCR execution path, add regressions that reproduce strict browser receiver behavior, bump the extension to `0.2.0`, and surface the manifest version in the compact options UI and startup logs. Rebuild the checked-in unpacked extension, commit the complete approved working tree, and push `main` to `origin`.

## Boundaries & Constraints

**Always:** Preserve injected scheduling callbacks for tests and alternate runtimes; derive displayed/logged build identity from `chrome.runtime.getManifest()`; keep Isolated HTML script execution disabled; preserve exact-document OCR correlation, selected-engine behavior, and existing permissions.

**Ask First:** Any new Chrome permission or host match, enabling scripts in the replica sandbox, external networking, remotely hosted executable code, or a change to the extension update/install model.

**Never:** Treat the expected `about:srcdoc` blocked-script warning as the OCR failure; enable `allow-scripts`; hard-code a UI version independently of the manifest; loosen replica sanitization; remove rrweb or Isolated HTML.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Isolated OCR activation | Current replica commits with OCR enabled | Controller progresses from `replica-ready` to source connection without an illegal invocation | Startup remains content-free and reports a diagnostic failure if a real source error occurs |
| Overlay scheduling | OCR result requests an overlay refresh | Frame scheduling and cancellation execute with valid native receivers | Disposal cancels pending work without leaking a callback |
| Offscreen OCR | Provider deadline or worker timeout is scheduled | Timeout functions run safely in the Chrome offscreen document | Existing timeout and abort semantics remain unchanged |
| Build verification | User expands options or inspects startup console | UI and logs identify `Build 0.2.0`, matching the packaged manifest | Version is always read from the runtime manifest |
| Replica sandbox | Sanitized `srcdoc` contains a removed/blocked script | Chrome may log the expected sandbox warning; scripts do not run | No attempt is made to silence it by weakening the sandbox |

</frozen-after-approval>

## Code Map

- `lib/browser-scheduling.ts` -- receiver-safe adapters for browser timers and animation frames.
- `lib/ocr/image-translation-controller.ts` -- mutation quiet-window scheduling during OCR activation.
- `lib/ocr/image-overlay-projector.ts` -- overlay refresh frame scheduling.
- `lib/ocr/offscreen-host.ts` and OCR provider runtimes -- offscreen/provider deadline scheduling.
- `entrypoints/sidepanel/index.html`, `entrypoints/sidepanel/style.css`, `entrypoints/sidepanel/main.ts` -- visible companion build identity.
- `entrypoints/background.ts` -- service-worker startup build identity.
- `package.json`, `package-lock.json` -- authoritative `0.2.0` package version.
- `tests/` -- native-receiver and artifact/version regressions.

## Tasks & Acceptance

**Execution:**
- [x] Add receiver-safe scheduling adapters and apply them to every OCR timer/frame callback copied from a browser global.
- [x] Add focused tests that use receiver-sensitive callback doubles and cover controller activation, overlay refresh/cancellation, and provider/offscreen scheduling.
- [x] Bump package and manifest-derived build identity to `0.2.0`; show it in the expandable options UI and startup console.
- [x] Extend artifact assertions, run focused and full checks, and synchronize `dist/chrome-unpacked/`.
- [x] Apply review hardening for rrweb timer receivers, exact-document projection retention, TextDetector cancellation, default frame cancellation, and safe `srcset` parsing.
- [x] Prepare the complete approved working tree for commit and push after workflow review.

**Acceptance Criteria:**
- Given OCR is enabled and the current Isolated HTML replica commits, when activation schedules its quiet window, then no `Illegal invocation` is thrown and diagnostics progress to `source-connecting`.
- Given an overlay or offscreen provider schedules or cancels native work, when Chrome enforces the native receiver, then the call uses the correct global receiver and existing cancellation behavior is preserved.
- Given the unpacked extension is reloaded, when the user opens options or reads startup logs, then `Build 0.2.0` is visible and equals `manifest.json` version `0.2.0`.
- Given the replica iframe remains sandboxed without scripts, when page scripts are present, then they remain blocked and OCR can still proceed.

## Spec Change Log

- 2026-07-21 review: Patched five concrete runtime findings without changing approved intent. Recorded open-shadow-root OCR, cross-worker launch ordering, and rapid cross-window preopen cleanup as deferred work because they are separate capability/lifecycle changes.

## Verification

**Commands:**
- `npx vitest run tests/browser-scheduling.test.ts tests/image-translation-controller.test.ts tests/image-overlay-projector.test.ts tests/offscreen-ocr.test.ts` -- focused native scheduling and OCR lifecycle coverage passes.
- `npm run check` -- typecheck, complete test suite, and repository checks pass.
- `npm run artifact:sync && npm run artifact:check` -- installable unpacked artifact is current and reports version `0.2.0`.

**Results:**
- Focused scheduling/build-identity suite: 8 files / 60 tests passed; review-hardening suite: 7 files / 65 tests passed.
- `npm run check`: 51 files / 500 tests passed; typecheck and byte-for-byte artifact verification passed.
- `dist/chrome-unpacked/manifest.json`: version `0.2.0`; generated sidepanel and background bundles include the manifest-derived build identity.

## Suggested Review Order

**Replica and OCR orchestration**

- Start here: selected-engine commits atomically activate OCR against the authoritative replica.
  [`main.ts:294`](../../entrypoints/sidepanel/main.ts#L294)

- Exact-document staging prevents translated records from crossing navigation boundaries.
  [`isolated-html-engine.ts:369`](../../lib/replica/isolated-html-engine.ts#L369)

- Retained projections require matching document, source, revision, pair, and epoch.
  [`isolated-html-engine.ts:598`](../../lib/replica/isolated-html-engine.ts#L598)

**Native scheduling and OCR lifecycle**

- Receiver-safe adapters preserve browser globals while keeping injected callbacks receiver-free.
  [`browser-scheduling.ts:20`](../../lib/browser-scheduling.ts#L20)

- Replica activation reaches source connection through the guarded quiet-window timer.
  [`image-translation-controller.ts:277`](../../lib/ocr/image-translation-controller.ts#L277)

- rrweb checkpoint timers now use the same safe scheduling boundary.
  [`page-recorder.ts:241`](../../lib/replica/page-recorder.ts#L241)

- Timed-out TextDetector jobs release pixels and evict only their busy instance.
  [`runtime.ts:83`](../../lib/ocr/providers/chrome-text-detector/runtime.ts#L83)

- Source-scroll frames have paired production scheduling and cancellation.
  [`source-image-observer.ts:133`](../../lib/ocr/source-image-observer.ts#L133)

**Passive mirror safety**

- Bounded `srcset` parsing preserves data-image commas without synthesizing network requests.
  [`html-mirror-sanitizer.ts:949`](../../lib/replica/html-mirror-sanitizer.ts#L949)

**Build identity and release surface**

- One manifest-derived identity formats visible and console build markers.
  [`build-identity.ts:8`](../../lib/build-identity.ts#L8)

- The compact options overlay exposes the installed build without consuming mirror space.
  [`index.html:36`](../../entrypoints/sidepanel/index.html#L36)

- Background startup reports the same runtime manifest version.
  [`background.ts:27`](../../entrypoints/background.ts#L27)

**Verification**

- Receiver-strict doubles reproduce Chrome's native callback semantics.
  [`browser-scheduling.test.ts:16`](../../tests/browser-scheduling.test.ts#L16)

- Cross-document recovery regression proves stale translations cannot survive.
  [`isolated-html-engine.test.ts:134`](../../tests/isolated-html-engine.test.ts#L134)

- Artifact validation guards permissions, CSP, local OCR assets, and release identity.
  [`extension-artifact.mjs:244`](../../tools/extension-artifact.mjs#L244)
