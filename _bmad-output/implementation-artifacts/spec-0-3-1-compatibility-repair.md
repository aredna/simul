---
title: '0.3.1 replica compatibility repair'
type: 'bugfix'
created: '2026-07-21'
status: 'complete'
review_loop_iteration: 0
baseline_commit: '2fde1c8dee0b022bae9846d25c292d44f34c4bf5'
context:
  - '_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Simul 0.3.0 stopped receiving source-scroll updates, forces some Isolated HTML pages into the wrong color-scheme context, retains misleading posterless video shells, blanks useful native dropdown labels/state, and makes the compact toolbar harder to understand than necessary.

**Approach:** Repair the Chrome injection boundary with a bundled local observer, let the isolated replica inherit the source-compatible theme while retaining the captured canvas, omit unusable video shells, add a narrow memory-only dropdown representation, and clarify the toolbar without changing its single-row structure.

## Boundaries & Constraints

**Always:** Keep Isolated HTML scriptless, sandboxed, pointer-inert, and unable to navigate, submit, play media, or mutate the source. Keep current permissions and site-generic behavior. Preserve static video posters but omit videos without a usable poster. For native selects, transport bounded visible option/optgroup labels and current selected state only; strip raw values, names, data attributes, form semantics, URLs, and private ancestry, and never log or persist selection content. Keep passwords and all existing unsupported/private controls blank. Ship every injected observer dependency locally and replace an incompatible observer registry after extension reload. Preserve RRWeb as an experimental engine only. Keep HTML `lang` authoritative for Auto-detect, per the human’s explicit decision.

**Ask First:** Enabling media sources/playback, capturing current video pixels, approximating a browser-owned open dropdown popup, adding permissions, or widening readable form state beyond the native select behavior above.

**Never:** Add site-specific OpenAI/Reddit/NCSTI branches; borrow RRWeb layout; execute website/custom-element code; weaken CSP/sandbox/privacy; or claim browser-owned popups and posterless current video frames are exact DOM-replica features.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Scroll | Document or qualifying nested viewport scrolls | Bundled observer emits current bounded coordinates and committed replica follows at fit/1:1/custom zoom | Ignore incidental controls/carousels; stale generations remain rejected |
| Theme | Source uses dark `prefers-color-scheme` and a dark canvas | Isolated CSS evaluates in a compatible context and the captured canvas remains dark after commit | Transparent/unknown canvas leaves authored CSS authoritative |
| Media | Video has a safe poster, or no usable poster | Static poster remains; posterless shell is omitted so it cannot cover fallback visuals | Never retain media source/control/playback attributes |
| Select | Public native option labels and selection change | Labels translate and the current label updates in-memory | Raw values/private ancestry remain blank; OS popup-open state is not cloned |
| Toolbar | OCR disabled/enabled and toolbar idle/pressed | Visible label reads OCR Off/On; compact controls have clear button affordance | Target-language localization retains English fallback |

</frozen-after-approval>

## Code Map

- `entrypoints/page-live-observer.ts`, `entrypoints/sidepanel/main.ts`, `lib/live-page-mirror.ts`, `wxt.config.ts` -- closure-safe observer injection, registry revision, diagnostics, and scroll routing.
- `entrypoints/sidepanel/{index.html,style.css,main.ts}` -- replica color-scheme boundary, OCR label, and compact button affordance.
- `lib/replica/{source-privacy-policy,html-mirror-sanitizer,html-mirror-source,html-mirror-protocol,isolated-html-engine}.ts` -- poster and native-select source/transport/receiver invariants.
- `tests/`, `docs/`, `README.md`, package files, `tools/extension-artifact.mjs`, `dist/chrome-unpacked/` -- regression proof and ready-to-load 0.3.1 artifact.

## Tasks & Acceptance

**Execution:**
- [x] Bundle and inject the live observer with its dependency closure; revision-gate old page registries and add content-free installed/received/projected diagnostics.
- [x] Remove forced-light isolated ancestor styling while retaining source-canvas propagation; omit passive videos unless their sanitized poster survives receiver validation.
- [x] Admit bounded native select/optgroup/option labels plus selected state through live changes without admitting raw form values or private descendants.
- [x] Render localized `OCR On`/`OCR Off`, strengthen toolbar border/background/pressed/focus affordances, and retain the slim ordered row.
- [x] Add deterministic unit, injection-boundary, security/privacy, artifact, and UI tests; update durable docs, bump through 0.3.2, and regenerate the unpacked artifact.

**Acceptance Criteria:**
- Source document and qualified nested scrolling reach the active Isolated replica after a normal extension reload, including when a broken 0.3.0 registry existed in the tab.
- An OS-dark OpenAI-shaped fixture stays dark after replica commit; no forced-light replica rule remains.
- Posterless video creates no native placeholder, poster media stays static, and no media source/playback attribute crosses the boundary.
- Public native select labels and current selection render and translate while raw option values and password/private form data remain absent from serialized payloads and logs.
- Toolbar OCR state is explicit and controls visibly read as buttons without increasing the row height materially.
- `npm run check`, artifact validation, source/artifact version parity, and fresh adversarial review pass.

## Spec Change Log

## Design Notes

The scroll regression is an execution-context failure, not coordinate math: Chrome serializes `executeScript({ func })` without imported helpers. A local unlisted bundle plus a tiny self-contained invoker preserves module dependencies and prevents the same class of regression. Native dropdown popup chrome and posterless current video pixels are browser-managed visuals; 0.3.1 represents safe DOM state and removes misleading shells without enabling active media.

## Verification

**Commands:**
- `npm run check` -- all checks, tests, build, and artifact gates pass.
- `git diff --check` -- no malformed patch output.

**Manual checks:**
- Reload `dist/chrome-unpacked`, reload the source tab, and verify scroll follow on an ordinary page and OpenAI.com; verify OpenAI dark background in OS dark mode, no blank video shells, visible Japanese select labels/current choice on the supplied reservation page, OCR On/Off, and clearer toolbar buttons.
