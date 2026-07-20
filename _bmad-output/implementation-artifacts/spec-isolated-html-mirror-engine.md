---
title: 'Default Isolated HTML Mirror with rrweb Opt-In'
type: 'feature'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
baseline_commit: '654d8e9d8ce50d096599052bd17a6f7ae5ac7797'
context:
  - '_bmad-output/project-context.md'
  - '_bmad-output/implementation-artifacts/deferred-work.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The rrweb replica is unreliable on some JavaScript-heavy sites and owns translation/OCR identity so tightly that failed discovery can be silent. Simul needs a parallel mirror that follows the live DOM produced by the original page without executing page JavaScript in the copy.

**Approach:** Add an isolated-HTML engine that observes the source DOM, sends bounded sanitized checkpoints and patches, and creates real nodes in a script-disabled extension iframe. Make it the persisted default, retain rrweb as an experimental option, and route translation, OCR, and diagnostics through the selected engine.

## Boundaries & Constraints

**Always:** Leave the source page and its JavaScript untouched. Assign source nodes private `WeakMap` IDs, never source attributes. Use a Simul-owned constant `srcdoc` shell with `sandbox="allow-same-origin"`, no `allow-scripts`, and CSP blocking scripts, workers, connections, frames, objects, forms, navigation, and unsafe schemes. Convert detached clones into a typed allowlisted graph before transport, revalidate it in the extension, and construct nodes with DOM APIs—never inject source-derived HTML. Mask private controls/contenteditable before transport. Carry document identity and contiguous sequences; ACK only applied patches, reject stale work, recover gaps/overflow with a checkpoint, and keep the last good view atomically. Preserve scroll, zoom, revisions, and translation currentness. Only the selected engine owns the presentation and live session. Emit content-free `console.info` summaries for mirror connection and OCR discovery, skip, capture, recognition, translation, and projection; never log text, URLs, pixels, hashes, or IDs. Engine changes cancel work and start a fresh checkpoint. Missing preferences default to isolated HTML; rrweb remains selectable unless its existing build flag disables it.

Initial fidelity mode may reuse normalized passive stylesheet, image, and font references already present on the source page, so the replica can make additional website requests. Active, navigational, frame, media, form, and connection sinks stay blocked. The deferred Strict Local Mirror mode will later replace remote references and prove zero replica requests.

**Ask First:** New permissions/host matches; replica scripts, interaction, forms, navigation, or site storage; new resource classes; Strict Local Mirror or screenshot-resource substitution; cross-origin frame capture, closed shadow roots, canvas/video state, MHTML, debugger, or pageCapture.

**Never:** Remove rrweb or silently choose it as fallback; execute copied scripts, handlers, or custom-element definitions; parse or attach an unsanitized clone; copy credentials/live input values; claim pixel-perfect parity for browser-managed state unavailable to MutationObserver.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|---------------|-------------------|----------------|
| Initial/live mirror | Dynamic top-frame page and DOM mutations | Sanitized real-DOM replica; only affected nodes patch | Preserve last good view; checkpoint on gap/limit |
| Hostile/private DOM | Active elements, unsafe URLs, private fields | Active content removed/inert; private state masked | Reject invalid batch atomically |
| Engine switch | User chooses rrweb or isolated HTML | Persist choice, cancel old work, start fresh session | Legacy view is last-good emergency fallback only |
| OCR scan | Eligible/ineligible images | Active-engine anchors drive overlays; stage counts explain outcomes | Missing anchor/provider/language is counted safely |
| Unobservable state | Closed shadow, canvas, CSSOM-only change | Preserve last representable state | Report bounded limitation; never run site code |

</frozen-after-approval>

## Code Map

- `entrypoints/page-mirror.ts`, `lib/replica/html-mirror-source.ts` -- independent observer, identity, image discovery, and recovery bridge.
- `lib/replica/html-mirror-protocol.ts`, `lib/replica/html-mirror-sanitizer.ts` -- bounded typed messages, dual validation, privacy, and resource policy.
- `lib/replica/isolated-html-engine.ts`, `lib/replica/visible-replay-host.ts` -- inert iframe DOM, patches, translation, anchors, scroll, and lifecycle.
- `lib/replica/contracts.ts`, `lib/replica/engine-selection.ts` -- selected presentation router and fallback ownership.
- `lib/preferences.ts`, `entrypoints/sidepanel/*` -- compact persisted engine control and diagnostics.
- `lib/ocr/*`, `lib/translation/replica-translation-coordinator.ts` -- replace concrete rrweb coupling.
- `wxt.config.ts`, `tools/extension-artifact.mjs`, `tests/*`, `README.md` -- packaging, guards, tests, and instructions.

## Tasks & Acceptance

**Execution:**
- [x] Implement the isolated source protocol, stable IDs, dual sanitizer, observer batching, ACK/gap recovery, and image discovery.
- [x] Implement the no-script iframe runtime and engine-neutral surface router with last-good atomic presentation.
- [x] Persist the compact engine selector; migrate missing settings to isolated HTML and keep rrweb explicit.
- [x] Route translation/OCR through the selected engine and add privacy-safe diagnostics for every silent path.
- [x] Add sanitizer canaries, protocol/recovery, engine-switch, real-iframe, translation/OCR, and artifact tests; update docs.

**Acceptance Criteria:**
- Given a JavaScript-driven source page, when its DOM changes, then the isolated replica incrementally reflects representable changes while running no source script.
- Given hostile markup or private controls, when data crosses either boundary, then no active behavior/private value reaches the replica, logs, or storage.
- Given a fresh/upgraded install, when Simul opens, then isolated HTML is default and rrweb can be selected and persisted without rebuilding.
- Given image translation is enabled, when a scan runs, then active-engine anchors are used and the console explains every projected, skipped, deferred, or failed scan.
- Given stale, malformed, or missing patches, when recovery runs, then the visible last-good replica remains until a valid checkpoint commits.

## Spec Change Log

- 2026-07-20: Implemented the approved isolated HTML engine, selected-surface
  translation/OCR routing, persisted engine choice, diagnostics, tests, and
  installable artifact. The frozen intent and constraints were unchanged.
- 2026-07-20: Fixed Chrome's connected-iframe `srcdoc` reset by staging the
  candidate in its final parent, added startup ACK backpressure and last-good
  recovery, separated isolated/rrweb OCR source channels, and added ordered
  TextDetector-to-Tesseract OCR with an in-companion diagnostic history. The
  frozen intent and constraints were unchanged.
- 2026-07-20: Closed the independent review findings with cached no-text OCR,
  bounded shared-host retry, scroll-aware crop revisions, restart-safe OCR
  reconfiguration, periodic bounded open-shadow discovery, serialized surface
  transitions, synchronous cold-launch routing, click-stamped toolbar
  authorization, and locked tab move recovery. The frozen intent and
  constraints were unchanged.

## Design Notes

The sandbox is a rendering backstop, not the sanitizer. JavaScript runs only on the original page; the mirror observes its representable results. Passive visual loading is intentionally distinct from the deferred Strict Local Mirror guarantee.

## Verification

**Commands:**
- `npm run check` -- all repository checks pass.
- `npm run build` -- MV3 output contains the isolated bridge and no remote executable code.

Verified 2026-07-20 after integration hardening: `npm run check` passed 48
test files / 476 tests and validated the synchronized 39.22 MB Chrome artifact.

**Manual checks:**
- On JavaScript-heavy English, Japanese, and Spanish pages, verify isolated mirroring, incremental translation, engine switching, scroll/zoom, OCR logs, and inert replica controls/scripts.

## Suggested Review Order

**Companion orchestration**

- Start with engine ownership, OCR composition, and last-good presentation wiring.
  [`main.ts:277`](../../entrypoints/sidepanel/main.ts#L277)

- Route every toolbar click through one authorization and surface-launch boundary.
  [`background.ts:25`](../../entrypoints/background.ts#L25)

- Serialize pop-out transitions and preserve exact source-tab identity.
  [`main.ts:2608`](../../entrypoints/sidepanel/main.ts#L2608)

**Isolated mirror boundary**

- Install the bounded top-document observer without running or mutating page code.
  [`html-mirror-source.ts:99`](../../lib/replica/html-mirror-source.ts#L99)

- Sanitize source DOM into the only graph permitted across contexts.
  [`html-mirror-sanitizer.ts:224`](../../lib/replica/html-mirror-sanitizer.ts#L224)

- Construct and incrementally patch real nodes inside the inert iframe.
  [`isolated-html-engine.ts:117`](../../lib/replica/isolated-html-engine.ts#L117)

- Stage candidates in their final parent before atomic visible commit.
  [`visible-replay-host.ts:64`](../../lib/replica/visible-replay-host.ts#L64)

- Discover late open shadow roots with bounded periodic work.
  [`html-mirror-source.ts:655`](../../lib/replica/html-mirror-source.ts#L655)

**Local image translation**

- Centralize image currency, scheduling, translation, caching, and overlay ownership.
  [`image-translation-controller.ts:174`](../../lib/ocr/image-translation-controller.ts#L174)

- Apply ordered provider fallback, no-text caching, and bounded host recovery.
  [`image-analysis-coordinator.ts:46`](../../lib/ocr/image-analysis-coordinator.ts#L46)

- Lazily instantiate only the offscreen provider selected for each job.
  [`offscreen-provider-router.ts:9`](../../lib/ocr/offscreen-provider-router.ts#L9)

- Capability-probe Chrome TextDetector and normalize untrusted spatial output.
  [`runtime.ts:19`](../../lib/ocr/providers/chrome-text-detector/runtime.ts#L19)

- Reconsider stable visible crops when scrolling changes their viewport position.
  [`source-image-observer.ts:83`](../../lib/ocr/source-image-observer.ts#L83)

**Release evidence**

- Build and validate disabled, individual-provider, and combined OCR artifacts.
  [`extension-artifact.mjs:200`](../../tools/extension-artifact.mjs#L200)

- Prove late shadow attachment reconciles without an impossible mutation callback.
  [`html-mirror-source.test.ts:183`](../../tests/html-mirror-source.test.ts#L183)

- Prove toolbar authorization follows click-time order across asynchronous completion.
  [`companion-surface.test.ts:86`](../../tests/companion-surface.test.ts#L86)

- Exercise independent TextDetector-only and Tesseract-only production packages.
  [`extension-artifact.test.mjs:536`](../../tests/extension-artifact.test.mjs#L536)
