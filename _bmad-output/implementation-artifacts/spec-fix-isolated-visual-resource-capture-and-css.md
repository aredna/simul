---
title: 'Fix Isolated Visual-Resource Capture and CSS Fidelity'
type: 'bugfix'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 0
baseline_commit: '05e2463'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Isolated HTML finds the D-U-N-S SVG-backed logo and Reddit JPEG, but Chrome rejects their screenshot after `activeTab` expires because Simul's saved narrow host grants do not authorize `captureVisibleTab()`; Simul hides that rejection as `capture-failed`. Reddit's media view also loses its utility stylesheet because the CSS sanitizer mistakes safe `scroll-behavior` properties for legacy IE `behavior:`.

**Approach:** Add separately consented optional all-sites pixel-capture access for image translation, expose actionable capture stages, avoid stale initial captures, and tighten the CSS security boundary so safe behavior-suffixed properties survive while true `behavior:` stays blocked.

## Boundaries & Constraints

**Always:** Keep `<all_urls>` optional and request it only from an explicit image-translation/grant gesture. Retain narrow grants for mirroring and share an existing all-sites grant with automatic translation. Use generic rules, keep website code inert, and limit memory-only diagnostics to allowlisted codes/dimensions/counts—never URLs, text, pixels, hashes, or identities. Preserve exact-document/replay guards, local OCR, and the 4 MP cap.

**Ask First:** Approving this spec authorizes literal `<all_urls>` in `optional_host_permissions` and Chrome's native image-OCR consent prompt. Required hosts, silent prompts, new schemes, or other Chrome permissions still need separate approval.

**Never:** Fetch/parse source images, execute Reddit/Lit code, enable iframe scripts, weaken CSS URL/import checks, log raw errors, add hostname/file-type branches, claim direct standalone SVG-document support, or absorb deferred custom-element/rrweb-placeholder work.

## I/O & Edge-Case Matrix

| Scenario | Expected behavior | Failure behavior |
|----------|-------------------|------------------|
| User enables OCR without access | Prompt once before enabling | Denial keeps OCR off with retry guidance |
| Saved-on upgrade lacks access | Mirror works and shows a Grant action | No silent prompt or capture loop |
| External SVG `<img>` or Reddit JPEG | Painted pixels reach existing OCR/overlay path | Bounded capture/recognition reason is shown |
| Safe vs dangerous CSS | `scroll-behavior`/`overscroll-behavior-*` survive | Actual or obfuscated `behavior:` is rejected |
| Capture abort/API failure | Current superseded work retries; calls stay under quota | Permanent permission/inactive failures settle |

</frozen-after-approval>

## Code Map

- `wxt.config.ts`, `tools/extension-artifact.mjs` -- exact optional permission boundary.
- `lib/preferences.ts`, `lib/preference-coordinator.ts`, `entrypoints/sidepanel/main.ts` -- shared grant ownership, consent/retry/revocation UI, persisted intent.
- `lib/ocr/{pixel-acquisition,image-translation-controller,diagnostic-history,source-image-observer}.ts` -- typed stages, aborts, throttling, initial visibility.
- `lib/replica/html-mirror-sanitizer.ts` -- precise legacy `behavior:` rejection.
- `tests/` -- permission, CSS security, capture, mirror, and artifact regressions.

## Tasks & Acceptance

**Execution:**
- [x] Use literal optional `<all_urls>` for capture, retain it while automatic-all-sites or desired image translation needs it, and implement user-activated grant/deny/revoke handling.
- [x] Preserve aborts; classify inactive/permission/quota/API/data/decode/surface/encode/digest failures; use safe throttling and let initial visibility settle before capture.
- [x] Correct CSS `behavior:` detection and prove safe behavior-suffixed properties plus a Reddit-like utility sheet survive.
- [x] Add generic external-SVG `<img>` and image-only media fixtures through isolated discovery, anchor, layout, and OCR orchestration.
- [x] Bump build identity, update permission/debugging docs, sync `dist/chrome-unpacked`, and run all gates.

**Acceptance Criteria:**
- Once granted, image translation continues across cross-origin navigation/rebuild without another toolbar click; denial/revocation is actionable and does not hot-loop.
- D-U-N-S and Reddit media advance past capture into recognition under Isolated HTML for explicit English/Japanese pairs.
- Reddit-like flex/viewport/image-size CSS survives while real/obfuscated legacy `behavior:` remains blocked.
- Background-to-visible discovery wastes no screenshot; capture stays below Chrome's quota; aborts are not mislabeled.
- No required permission, image fetch, website script, private diagnostic content, or hostname-specific code is added.
- `npm run check` and artifact verification pass.

## Design Notes

External SVG inside `<img>` is already format-opaque and screenshot-rasterized; the SVG and JPEG share the same upstream permission failure. Reddit's media is likewise a normal light-DOM `<img>`; its first-order layout loss is the sanitizer false positive, while custom-element definition state remains deferred.

## Verification

- Focused Vitest suites for preferences/coordinator, pixel/controller/diagnostics, mirror sanitizer/source/engine, and artifact validation.
- `npm run check`.
- `npm run artifact:sync && npm run artifact:check`.
- In reloaded Chrome, grant image translation once; test D-U-N-S Japanese→English and Reddit media English→Japanese across an origin change. Expect capture→recognition diagnostics and centered/constrained Reddit media.

## Spec Change Log

- 2026-07-21: Implemented the approved capture-permission, typed-diagnostic, visibility, CSS-fidelity, fixture, documentation, and build-identity work.
- 2026-07-21: Hardened permission transactions, async access-state ordering, broad-dependent site reconciliation, CSS selector handling, and stale observer callbacks after adversarial review.

## Implementation Result

- Chrome now receives the literal optional `<all_urls>` grant required by `captureVisibleTab()` only after an explicit user gesture; saved image intent remains paused and actionable when access is absent.
- The D-U-N-S SVG `<img>` and Reddit JPEG remain format-opaque: Simul captures their already-rendered pixels without downloading or parsing either resource.
- Capture failures expose bounded stage codes, aborts remain aborts, and permission/inactive failures settle instead of looping.
- Isolated HTML preserves Reddit-like scroll, flex, viewport, and image sizing CSS while continuing to reject real or obfuscated legacy `behavior:` declarations.
- Build `0.2.3` is synchronized in `dist/chrome-unpacked`.
- Final automated gate: TypeScript passed, 51/51 test files and 551/551 tests passed, and the generated Chrome artifact matched byte-for-byte.

## Review Resolution

- Patched review findings: grant rollback on failed persistence, broad-grant restoration on failed disable, revision-guarded permission refreshes, exact-site materialization/reconciliation, safe `behavior` selectors, stale IntersectionObserver callbacks, and cross-realm abort recognition.
- Confirmed intentional behavior: permission/inactive capture failures settle, capture quota cooldown remains global, Chrome API error strings are reduced to allowlisted codes, and resource URLs never enter the OCR recognition contract.
- No intent or specification loopback was required. Reloaded-Chrome verification on the two reported live pages remains the human acceptance step.

## Suggested Review Order

**Consent and permission ownership**

- Start with the explicit grant, rollback, revocation, and retry state machine.
  [`main.ts:1020`](../../entrypoints/sidepanel/main.ts#L1020)

- Reconciliation shares broad access without confusing coverage for retained exact grants.
  [`preference-coordinator.ts:184`](../../lib/preference-coordinator.ts#L184)

- Canonical permission constants preserve legacy values only for migration cleanup.
  [`preferences.ts:65`](../../lib/preferences.ts#L65)

**Capture and scheduling**

- Exact-tab capture is globally throttled and emits bounded failure categories.
  [`pixel-acquisition.ts:306`](../../lib/ocr/pixel-acquisition.ts#L306)

- Permanent permission and inactive failures settle instead of entering capture loops.
  [`image-translation-controller.ts:680`](../../lib/ocr/image-translation-controller.ts#L680)

- Initial visibility tiers settle before first scheduling; stale callbacks are ignored.
  [`source-image-observer.ts:219`](../../lib/ocr/source-image-observer.ts#L219)

**Isolated HTML fidelity**

- Declaration-aware CSS filtering preserves modern behavior-suffixed layout properties safely.
  [`html-mirror-sanitizer.ts:897`](../../lib/replica/html-mirror-sanitizer.ts#L897)

- Reddit-style CSS regressions distinguish safe selectors from legacy executable declarations.
  [`html-mirror-protocol.test.ts:481`](../../tests/html-mirror-protocol.test.ts#L481)

- External SVG and JPEG fixtures prove passive layout plus replica anchor resolution.
  [`isolated-html-engine.test.ts:668`](../../tests/isolated-html-engine.test.ts#L668)

**Boundary and regression coverage**

- Capture tests cover quota, abort, stage classification, and raw-error containment.
  [`pixel-acquisition.test.ts:345`](../../tests/pixel-acquisition.test.ts#L345)

- External SVG discovery proves dimensions pass while resource identity stays private.
  [`source-image-observer.test.ts:170`](../../tests/source-image-observer.test.ts#L170)

- Manifest config declares only the approved optional all-sites host boundary.
  [`wxt.config.ts:109`](../../wxt.config.ts#L109)

- Durable context records the explicit-consent and shared-ownership invariant.
  [`project-context.md:54`](../project-context.md#L54)
