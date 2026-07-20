---
title: 'Restore Isolated HTML Activation Labels and Add a Source-Only Baseline'
type: 'bugfix'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'd558c6e'
context:
  - '_bmad-output/project-context.md'
  - '_bmad-output/implementation-artifacts/spec-isolated-html-mirror-engine.md'
  - '_bmad-output/implementation-artifacts/spec-isolated-html-adopted-stylesheets.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Isolated HTML erases ordinary visible labels beneath native and ARIA buttons, which blanks the D-U-N-S call-to-action and Y Combinator's scrolling company names. It also drops URL-encoded static SVG data images such as YC's Y logo, and there is no projection-free control view to distinguish mirror fidelity defects from translation defects.

**Approach:** Narrow the private-content boundary to preserve page-authored activation labels while retaining editable/value-bearing redaction, safely admit a conservative static SVG data-image subset, and add a persisted source-only mode that uses the exact same live isolated mirror but applies no text or OCR projections.

## Boundaries & Constraints

**Always:** Apply generic rules with no hostname exceptions; keep scripts, events, navigation, forms, frames, media, and connection sinks inert; preserve redaction for input/select/textarea/option/output, editable content, and private values/attributes; validate SVG data images identically at source and receiver and reject executable or external-resource constructs; keep source-only and translated views on one sanitizer, protocol, DOM, patch stream, replay lease, and scroll behavior; continue acknowledging live patches in source-only mode; abort stale translation work and remove existing text/OCR projections when source-only is selected; keep the current permissions and sandbox.

**Ask First:** Any new permission or host match; executing replica code; admitting external SVG references or a broader active SVG feature set; changing the deferred Strict Local Mirror network guarantee; capturing closed shadow roots, frames, canvas/video state, or ordinary stylesheet CSSOM mutations.

**Never:** Inject raw page HTML into `srcdoc`; use `cloneNode()` on untrusted custom elements; label source-only as a pixel-exact or complete copy; weaken typed/editable-control privacy to make labels appear; create site-specific D-U-N-S or YC branches; make source-only a second renderer whose behavior can drift.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Activation label | Nested `<button>` or `role="button"` with visible text | Exact source text enters the graph and translation records; attributes remain inert | Descendant editable/value controls stay blank |
| Static logo | URL-encoded `data:image/svg+xml` containing static SVG shapes | `img.src` survives source and receiver validation | Script, event, navigation, external URL, entity/doctype, or unsupported SVG is omitted |
| Source-only control | A translated isolated replica with OCR enabled | Original text is restored in place, overlays are released, translator/OCR projection work stops, and live patches continue | In-flight/stale results cannot reapply |
| Resume translation | Source-only changes back to translated | Existing language and automation settings resume on the current mirror | A missing local language pack retains the normal user-action message |

</frozen-after-approval>

## Code Map

- `lib/replica/source-privacy-policy.ts` -- shared distinction between activation labels and private values.
- `lib/replica/html-mirror-sanitizer.ts` -- source serialization, data-image admission, and receiver revalidation.
- `lib/replica/isolated-html-engine.ts` -- receiver context checks and in-place source restoration.
- `lib/preferences.ts`, `lib/preference-coordinator.ts` -- persisted source-only/translated view setting.
- `entrypoints/sidepanel/{index.html,main.ts}` -- control wiring and translation/OCR gating.
- `tests/{html-mirror-protocol,html-mirror-source,isolated-html-engine,source-value-model,preferences,preference-coordinator}.test.*` -- security, fidelity, persistence, and mode regressions.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- record additional audit gaps outside this safe fix.

## Tasks & Acceptance

**Execution:**
- [x] `lib/replica/{source-privacy-policy,html-mirror-sanitizer,isolated-html-engine}.ts` -- preserve activation labels and safely carry static SVG data images through every validation layer.
- [x] `lib/{preferences,preference-coordinator}.ts` and `entrypoints/sidepanel/{index.html,main.ts}` -- add the persisted “Translated / Live source only” setting and restore/gate projections without recapture.
- [x] `tests/` -- add D-U-N-S-shaped nested-button, YC-shaped role-button/data-SVG, hostile SVG, live-patch, in-flight toggle, and preference coverage.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- retain the audit's separate CSSOM, inert-link, responsive-source, local-SVG-reference, doctype, and custom-element fidelity follow-ups.
- [x] `package.json`, lockfile, and installable artifact -- increment the patch version/build identity and rebuild the ready-to-load extension.

**Acceptance Criteria:**
- Given either reported page, when Isolated HTML commits, then the D-U-N-S label, YC company names, and YC Y logo are present without a site-specific rule.
- Given source-only mode, when the page changes or scrolls, then the same live mirror keeps updating while page text and image overlays remain unmodified source content.
- Given source-only is selected after translation began, when stale async work completes, then it cannot overwrite restored source content.
- Given a private editable/value control nested near an activation label, when captured, then its value and private attributes never enter the transported graph.
- Given an unsafe SVG data image, when sanitized or revalidated, then its `src` is omitted without failing the rest of the page.

## Design Notes

Source-only is a diagnostic control, not an unsafe raw-copy path: it proves whether the sanitized live DOM and styling match before projection. Exact browser duplication remains impossible for intentionally unobservable or active state; those limitations stay explicit rather than being hidden behind a misleading “exact copy” label.

## Spec Change Log

- 2026-07-21: Implemented activation-label privacy narrowing, conservative
  shape-only URL-encoded SVG data-image admission at both trust boundaries,
  persisted source-only projection gating/restoration, deferred fidelity audit
  entries, version `0.2.1`, and the synchronized unpacked artifact. The frozen
  intent and constraints were unchanged.
- 2026-07-21: Closed adversarial-review findings without changing the frozen
  intent: propagated private-attribute context through activation descendants,
  rejected CSS-escaped SVG references, made privacy-context transitions
  atomic (including open shadow-root recovery), and hardened source-only
  language, availability, cancellation, OCR teardown, and live-delta races.

## Verification

**Commands:**
- `npm run check` -- expected: all formatting, type, unit, artifact, and packaging checks pass.
- Focused Vitest suites for mirror protocol/source/engine, source-value model, and preferences -- expected: reported-page fixtures and hostile canaries pass.

**Manual checks (if no CLI):**
- Reload the versioned unpacked build in Chrome; compare Translated and Live source-only on both reported URLs, including YC's desktop scroll section and logo.

**Results:**
- Focused final privacy/mirror/lifecycle suite: 6 files, 83 tests passed;
  post-review shadow and transition suite: 3 files, 43 tests passed.
- Full `npm run check`: typecheck passed, 51 files / 521 tests passed, and
  artifact byte-integrity validation passed.
- Installable artifact: synchronized at `dist/chrome-unpacked`, version
  `0.2.1`, 39.24 MB unpacked.
- Independent blind, edge-case, and acceptance re-reviews reported no
  remaining actionable finding after the review patches.
- Installed-Chrome comparison remains the explicit human acceptance check; the
  CLI fixtures contain the reported D-U-N-S labels and YC SVG data URL exactly.

## Suggested Review Order

**Source-only mode boundary**

- Start with the persisted mode transition, restoration, and stale-work gates.
  [`main.ts:2508`](../../entrypoints/sidepanel/main.ts#L2508)

- Keep automation and interrupted live work decisions browser-independent.
  [`companion-lifecycle.ts:25`](../../lib/companion-lifecycle.ts#L25)

- Persist a bounded translated/source-only enum with a safe translated default.
  [`preferences.ts:29`](../../lib/preferences.ts#L29)

- Expose the control inside the existing compact settings overlay.
  [`index.html:89`](../../entrypoints/sidepanel/index.html#L89)

**Mirror fidelity and privacy**

- Distinguish public activation labels from private editable/value controls.
  [`source-privacy-policy.ts:56`](../../lib/replica/source-privacy-policy.ts#L56)

- Propagate text and private-attribute contexts through every serialized descendant.
  [`html-mirror-sanitizer.ts:593`](../../lib/replica/html-mirror-sanitizer.ts#L593)

- Admit only the conservative static SVG subset needed by YC.
  [`html-mirror-sanitizer.ts:1153`](../../lib/replica/html-mirror-sanitizer.ts#L1153)

- Recover atomically when host privacy changes affect an open shadow root.
  [`html-mirror-source.ts:436`](../../lib/replica/html-mirror-source.ts#L436)

- Revalidate privacy-context transitions before applying visible live patches.
  [`isolated-html-engine.ts:871`](../../lib/replica/isolated-html-engine.ts#L871)

**Cancellation and evidence**

- Block late provider completion before it can repaint restored source text.
  [`visual-renderer.ts:376`](../../lib/visual-renderer.ts#L376)

- Exercise exact D-U-N-S, YC logo, live-patch, and metadata fixtures.
  [`html-mirror-source.test.ts:103`](../../tests/html-mirror-source.test.ts#L103)

- Verify source restoration continues accepting live updates without projection.
  [`isolated-html-engine.test.ts:106`](../../tests/isolated-html-engine.test.ts#L106)

- Prove shadow privacy tightening uses checkpoint recovery at the receiver.
  [`isolated-html-engine.test.ts:402`](../../tests/isolated-html-engine.test.ts#L402)

- Ship the reviewed build identity in the ready-to-load artifact.
  [`package.json:3`](../../package.json#L3)
