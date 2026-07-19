---
title: 'Content-first live-cloned multilingual companion'
type: 'feature'
created: '2026-07-19'
status: 'done'
review_loop_iteration: 0
baseline_commit: '7e537f9e5267fec7dde161d64f71729d45ee0d5d'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The current periodic static-snapshot model falls behind the live page and can omit or distort important content. Permanent controls, limited languages, and missing zoom, pop-out, saved settings, scroll following, and reverse translation further reduce usefulness.

**Approach:** Bootstrap an inert copy of the rendered DOM once, then keep it translated and current through incremental structure, text, style, image, layout, and scroll updates. Put controls in small overlays; add multilingual translation, saved zoom/layout, a detached window, and an image-OCR memo.

## Boundaries & Constraints

**Always:** Keep the source read-only and omit form values. The first DOM copy is bootstrap only: stream bounded sanitized deltas and fully recapture only for navigation/desynchronization recovery. Preserve MV3, Chrome 138+, local code, cancellable work, and runtime pair checks. Save settings only. Keep the mirror inert; 1:1 means one source CSS pixel per mirror pixel with horizontal overflow.

**Ask First:** New required permissions or broader host access; remote page/image processing; embedded credentials; automatic source-page input; a higher Chrome minimum.

**Never:** Run site scripts in the extension page, depend on iframes, or use periodic full snapshots for normal sync. Do not promise pixel perfection across browser boundaries/reflow, expose values, truncate silently, use remote code, or ship OCR/cloud processing now.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Live source | DOM/text/style/image/layout/scroll change | Apply coalesced sanitized deltas to existing nodes and translate changed text only | Reject stale/invalid deltas; rebootstrap on desync |
| Navigation | Full or SPA navigation | Bind a new generation and bootstrap current state | Keep old mirror until replacement; reauthorize if needed |
| Languages | Auto/manual source or target changes | Save and immediately retranslate; HTML `lang`, then reliable local detection; equal pair unchanged | Preserve original if unavailable; gesture prepares download |
| Zoom/layout | Fit, 1:1, 25–300%, long translation | Exact scale/2-D overflow; adaptive wrapping/growth or faithful geometry | Clamp zoom; never silently ellipsize |
| Composer | Target-language draft | Reverse resolved pair and copyable output | Cancel stale work; never persist text |
| Pop-out | User detaches | Popup stays tied to the source tab | Reauthorize if access is revoked |

</frozen-after-approval>

## Code Map

- `entrypoints/sidepanel/*` -- compact UI, live-mirror lifecycle, languages, zoom, sync, composer, pop-out.
- `entrypoints/popup/*`, `entrypoints/background.ts` -- launch and validated source identity.
- `lib/page-snapshot.ts`, `lib/live-page-mirror.ts`, `lib/visual-renderer.ts` -- bootstrap/delta protocol, geometry, inert rendering, text layout.
- `lib/preferences.ts`, `lib/preference-coordinator.ts` -- persisted settings/migration.
- `lib/{translation-provider,chrome-translator,translation-pipeline}.ts` -- languages and forward/reverse translation.
- `tests/*`, `docs/*` -- regressions, OCR guidance, build parity.

## Tasks & Acceptance

**Execution:**
- [x] `lib/preferences.ts`, `lib/preference-coordinator.ts`, `entrypoints/background.ts` -- migrate/save source, target, zoom, layout, and sync settings.
- [x] `lib/{translation-provider,chrome-translator}.ts` -- add Chrome's language list, tag canonicalization, local detection, equal-pair no-op, and availability probing.
- [x] `lib/page-snapshot.ts`, `lib/live-page-mirror.ts`, `lib/visual-renderer.ts` -- bootstrap open composed trees, identify nodes, apply bounded deltas, preserve public labels, redact values, remove disabled wash, and add adaptive/faithful text.
- [x] `entrypoints/sidepanel/*` -- remove branding/borders; add hidden controls/composer, immediate retranslation, Fit/1:1/custom zoom, 2-D scrolling, and source-scroll follow.
- [x] `entrypoints/sidepanel/main.ts`, `entrypoints/background.ts` -- stream validated coalesced deltas, incrementally retranslate changes, and rebootstrap only on navigation/desync.
- [x] `entrypoints/popup/*`, `entrypoints/sidepanel/main.ts` -- open a permission-neutral detached popup bound to the source tab.
- [x] `docs/*` -- document local Tesseract Japanese/English overlays, privacy constraints, cloud options/costs, and fidelity limits.
- [x] `tests/*`, `README.md`, artifact -- cover the new state/lifecycle/capture/math and synchronize a ready-to-load build.

**Acceptance Criteria:**
- Dynamic expansions, async content, style/image changes, navigation, languages, and scroll update without source mutation, scheduled full snapshots, or blanking a usable mirror.
- The Reddit case/fixtures retain late rails, accessible open-shadow content, and public button labels.
- Only a small toolbar remains; overlays fully close and branding, page title/footer/borders, and gray control wash are gone.
- At 100%, captured layout width is scale 1 with horizontal overflow; zoom/layout choices persist.
- Reverse-pair composer output is copyable, cancellable, and never stored.

## Design Notes

Chrome exposes neither side-panel detachment nor language enumeration. Use an extension popup tied durably to the source tab and a documented static list with runtime pair probes. OCR stays documented because local models and image access add size/privacy decisions.

## Verification

**Commands:**
- `npm run check` -- typecheck, tests, and artifact parity pass.
- `npm run build` -- MV3 production build succeeds without remote code or new permissions.

**Manual checks (if no CLI):**
- In Chrome 138+, exercise the Reddit URL, dynamic expansion, same/cross-origin navigation, languages/model preparation, sync, all zoom/layout modes, pop-out, composer/copy, and reload persistence.

## Suggested Review Order

**Live companion lifecycle**

- Start here: coordinates authorized bootstrap, retained rendering, and live session setup.
  [`main.ts:576`](../../entrypoints/sidepanel/main.ts#L576)

- Installs the read-only observer with bounded sessions and sanitized event delivery.
  [`live-page-mirror.ts:104`](../../lib/live-page-mirror.ts#L104)

- Captures aggregate-bounded dirty subtrees plus current document language.
  [`live-page-mirror.ts:489`](../../lib/live-page-mirror.ts#L489)

- Coalesces deltas, detects sequence gaps, and recovers without blanking the mirror.
  [`main.ts:1038`](../../entrypoints/sidepanel/main.ts#L1038)

- Bootstraps the inert composed tree while redacting private form-derived content.
  [`page-snapshot.ts:522`](../../lib/page-snapshot.ts#L522)

- Builds root replacements off-DOM and commits them atomically after translation.
  [`visual-renderer.ts:431`](../../lib/visual-renderer.ts#L431)

**Translation and persistence**

- Owns cancellable full-page translation and downloadable-pack promotion.
  [`main.ts:820`](../../entrypoints/sidepanel/main.ts#L820)

- Resolves manual, HTML-language, and reliable visible-content detection paths.
  [`language-detection.ts:18`](../../lib/language-detection.ts#L18)

- Keeps every translation request within Chrome's measured session quota.
  [`translation-pipeline.ts:223`](../../lib/translation-pipeline.ts#L223)

- Defines the documented Chrome language list and runtime pair boundary.
  [`translation-provider.ts:2`](../../lib/translation-provider.ts#L2)

- Sanitizes saved language, zoom, layout, scroll, and automation choices.
  [`preferences.ts:62`](../../lib/preferences.ts#L62)

- Serializes atomic multi-window setting patches and reconciles optional host grants.
  [`preference-coordinator.ts:64`](../../lib/preference-coordinator.ts#L64)

- Bounds reusable translations while preserving current pair and generation guards.
  [`main.ts:940`](../../entrypoints/sidepanel/main.ts#L940)

**Companion interface**

- Keeps permanent chrome minimal while placing every option in one overlay.
  [`index.html:11`](../../entrypoints/sidepanel/index.html#L11)

- Implements Fit, exact 1:1, custom scaling, and two-dimensional overflow.
  [`main.ts:1282`](../../entrypoints/sidepanel/main.ts#L1282)

- Opens a detached companion that remains bound to the source tab.
  [`main.ts:1420`](../../entrypoints/sidepanel/main.ts#L1420)

- Reverses the resolved pair for cancellable, non-persisted reply translation.
  [`main.ts:1443`](../../entrypoints/sidepanel/main.ts#L1443)

**Release evidence and boundaries**

- Covers protocol budgets, session limits, sanitization, and live replacement.
  [`live-page-mirror.test.ts:29`](../../tests/live-page-mirror.test.ts#L29)

- Verifies atomic replacement, deep overflow, public labels, and image translation.
  [`visual-model.test.ts:260`](../../tests/visual-model.test.ts#L260)

- Records the local Japanese OCR path and cloud privacy boundary.
  [`image-translation-research.md:10`](../../docs/image-translation-research.md#L10)

- Documents direct Chrome installation from the synchronized unpacked artifact.
  [`README.md:9`](../../README.md#L9)

- Pins Chrome 138, MV3 permissions, and optional-only host access.
  [`wxt.config.ts:5`](../../wxt.config.ts#L5)
