---
title: 'Release Candidate Privacy and UX Hardening'
type: 'feature'
created: '2026-07-21'
status: 'complete'
review_loop_iteration: 0
baseline_commit: '28e030147c62f2110ee7aabeafba475bd9f1ae46'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Simul still blanks useful public text controls, misses or has regressed document and nested page scrolling, repeats or appears to repeat work for identical content, gives little compact progress feedback, and mixes common actions with experiments. Contrast, OCR noise, target-language UI labels, release documentation, OCR text fitting, and high-fidelity dark rendering on OpenAI.com also need a final pass.

**Approach:** Safely translate eligible Isolated HTML control text; make text/OCR caches demonstrably content-based across nodes and live updates; repair scrolling; refine a slim full-width target-language action bar with contextual status; improve quick reverse translation, options, OCR filtering/fitting, generic dark-page/resource fidelity, safe CSS capture/application, and release output.

## Boundaries & Constraints

**Always:** Keep the replica inert and source untouched. Read only native `input` types missing/`text`/`search`/`email`/`url`/`tel` and `textarea`; use a nonempty value, otherwise its placeholder. Blank passwords, password-autocomplete, other controls, selects/options, contenteditable, and ARIA textbox fallbacks. Fail closed when state is unreadable or becomes sensitive; never log or persist control text. Cache exact text by provider/pair/content, not node or document. Cache OCR by provider/model/language/profile/dimensions/pixel content, not node/URL/document; join matching in-flight work and retain bounded memory across live source refreshes. The same URL reuses OCR only when processed pixels and geometry inputs match. Accept document or nested scroll only for the true primary reading viewport; ignore textareas/small carousels. Keep processing and quick drafts local and memory-only. Use a single slim, full-width toolbar row in this order: refresh; From then `[A]` immediately before its wider dropdown, swap, and To; size; OCR; active/current tab following; quick reverse-translation; settings; side/popout; then the replica-state label at the far right. Localize visible toolbar and Settings labels to the selected target language with an English fallback. Hide the general status dot when healthy; attach warning/error indicators to the specific refresh or settings action requiring attention. Keep deeper or experimental choices in Settings. Preserve safely representable inline, embedded, linked, adopted, open-shadow, custom-property, media/pseudo-element, and SVG presentation CSS in cascade order. Keep CSS inert and bounded; sanitize active/unsafe resources and report browser-inaccessible CSS rather than weakening CSP, permissions, privacy, or sandboxing. Fit OCR overlay text within its region with wrapping and bounded downscaling. Skip OCR recognition/replacement when the resolved image source language already equals the target language. Treat OpenAI.com logo/background/scroll fidelity as a critical generic compatibility acceptance case. Preserve reduced motion, Chrome 138+, permissions/CSP, source, and `dist/chrome-unpacked/`.

**Ask First:** rrweb/contenteditable/ARIA input reading; source write-back; new permissions, networking, analytics, durable text history, store publishing/signing, or weaker privacy/sandbox rules.

**Never:** Transport passwords/raw value attributes; key work by DOM node; let progress intercept controls; duplicate composer IDs; special-case sites; run aggressive OCR multipass; hand-edit artifacts; or claim perfect fidelity.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Controls | Safe value/placeholder; later password transition | Translate safe text; password stays blank | Clear prior record/projection atomically |
| Cache | Same content on another node/update | Join/reuse one provider result | Separate changed pair/profile/pixels/geometry |
| Scroll | Document/body or large nested viewport | Synced replica follows progress | Ignore incidental scroll; clamp after shrink |
| UI/OCR | Busy work, quick translation, noisy OCR | Accessible progress/panel; no noise overlay | Idle clears; unresolved language disables action |
| Toolbar | Narrow or wide companion | One slim full-width row; compact controls wrap/overflow accessibly only when unavoidable | Deeper choices remain in Settings |
| OCR fit/language | Long translated region; resolved source equals target | Wrap/downscale inside region; skip recognition/replacement for same language | Preserve original pixels when uncertain |
| OpenAI.com | Dark theme, logo, nested/document scrolling | Background, logo geometry, and reading-position sync remain faithful | Use generic fidelity fixes; report unavoidable sandbox limits |
| Revised toolbar | Healthy, refresh-needed, settings-needed; target language changes | Wider readable language controls, contextual indicators, localized labels, far-right replica state | English fallback; never obscure the replica |
| CSS fidelity | Inline/style/link/adopted/open-shadow/SVG CSS | Preserve safe cascade, custom properties, pseudo/media rules, local visual references | Strip unsafe/active resources; report closed or unreadable browser state |

</frozen-after-approval>

## Code Map

- `lib/replica/`, `lib/translation/replica-translation-coordinator.ts` -- typed control text, privacy, projection, rollback.
- `lib/translation/translation-memory.ts`, `lib/ocr/{image-analysis-coordinator,image-translation-controller,result-quality}.ts` -- content keys, joins, quality, metrics.
- `lib/live-page-mirror.ts`, `lib/replica/visible-replay-host.ts` -- primary-scroll synchronization.
- `entrypoints/sidepanel/`, `lib/companion-ui-state.ts` -- progress, quick translator, hierarchy, help, themes.
- `tests/`, `README.md`, docs/context, `package*.json`, `dist/chrome-unpacked/` -- proof, narrative, version, artifact.

## Tasks & Acceptance

**Execution:**
- [x] `lib/replica/`, `lib/translation/` -- add bounded control metadata and discriminated records across exact-key capture, updates, projection, reset, and rollback; keep rrweb masked.
- [x] Translation/OCR memories and tests -- remove exact-document text scoping; prove cross-node reuse, in-flight joins, geometry-safe OCR keys, survival across source refresh, and content-free hit/miss/load diagnostics.
- [x] `lib/live-page-mirror.ts`, scroll tests -- coalesce standards/body or viewport-scale nested scroll without allowing small controls to drive the replica.
- [x] `entrypoints/sidepanel/`, `lib/companion-ui-state.ts`, OCR quality/tests -- add mutually exclusive settings/quick panels, toolbar progress, common-first groups, experiments last, hover help, responsive high-contrast themes, and conservative noise rejection.
- [x] README/docs/context/version/artifact/tests -- order README as problem, Codex 5.6 Sol Ultra plus BMAD Method, installation, challenges/solutions, then details; document source plus compiled artifact, bump version, synchronize, and run gates.
- [x] Full-width toolbar/tests -- replace the floating compact cluster with the approved single-row action order, add direct Auto, language, size, OCR, tab-follow, quick input, settings, and side/popout actions, and preserve responsive/accessibility behavior.
- [x] OCR overlay/tests -- make translated image text wrap and downscale inside its box; prove resolved same-language work stops before recognition and leaves original pixels unchanged.
- [x] OpenAI.com fidelity/scroll tests -- diagnose logo sizing, dark background, and scrolling, then apply generic sanitizer/layout/scroll fixes without executing page scripts.
- [x] Expanded release integration -- update docs/versioned artifact as needed, rerun all gates and adversarial review, and synchronize the ready-to-load build.
- [x] Revised toolbar/status/tests -- move `[A]` between the From label and dropdown, widen language controls, move the replica-state label to the far-right toolbar, and attach warning/error indicators to the responsible refresh or Settings action.
- [x] Target-language chrome/tests -- translate visible toolbar and Settings labels when the target changes, use exact cached UI strings, and preserve an immediate English fallback when a local translator is unavailable.
- [x] Dark-canvas regression/tests -- propagate and apply source canvas color through the full presentation shell so OpenAI.com does not reveal a white replica background.
- [x] CSS fidelity audit/tests -- preserve every safely representable CSS channel and local visual reference in cascade order; fix generic losses and document intentional inertness/browser boundaries.
- [x] Scroll regression/tests -- restore generic document and nested reading-position synchronization across ordinary DOM and open shadow roots without small controls taking ownership.
- [x] Re-expanded release integration -- finish the consolidated gate, synchronize and byte-check the ready-to-load artifact, and repeat fresh adversarial review after the human-approved expansion.

**Acceptance Criteria:**
- Given eligible control text, when it changes, then only current safe text is translated in Isolated HTML and a sensitive transition blanks prior state before acknowledgment.
- Given identical text or processed image content on different nodes or live updates, when requested, then one provider call serves matching work; meaningful cache-key changes reprocess it.
- Given a large nested scroller with sync on, when it moves, then the replica advances while small scrollers do not take ownership.
- Given tracked work or quick translation, when the toolbar/panel is visible, then progress and reverse From/To input/output work accessibly without opening full settings or saving drafts.
- Given light/dark and narrow/wide options, when rendered, then text is readable and common controls precede experimental controls.
- Given release completion, when `npm run check` runs, then tests and byte-exact artifact checks pass and the build reports the new version.
- Given the companion toolbar, when it is shown at supported widths, then its primary actions appear in the approved order in one slim full-width row, with Settings retaining advanced controls.
- Given an OCR translation whose text exceeds its source region, when projected, then it wraps and downscales within the region instead of being clipped; when resolved source equals target, recognition is not invoked.
- Given OpenAI.com in Isolated HTML mode, when mirrored and scrolled, then its dark page background, logo geometry, and primary reading scroll are preserved as far as the inert sandbox permits.
- Given the revised toolbar, when healthy, then no detached status dot is shown; when refresh or settings attention is required, then the yellow/red indicator is attached to that specific action, and the replica state appears at the far right.
- Given a target-language change, when UI localization is available, then visible toolbar and Settings labels update to the target language; otherwise the complete English UI remains readable while page translation continues.
- Given a dark source canvas and either document or viewport-scale nested scrolling, when the replica is displayed, then its surrounding canvas remains dark and synchronized scroll advances the replica rather than remaining fixed.
- Given safely readable CSS in document or open-shadow scope, when the replica is rebuilt, then its cascade, local visual references, custom properties, pseudo/media rules, and SVG presentation remain effective without enabling scripts, navigation, or unsafe resource behavior.

## Spec Change Log

- 2026-07-21: Human-approved release expansion added the full-width one-row toolbar, OCR fit/same-language behavior, and OpenAI.com as a critical generic fidelity/scroll acceptance site. Existing completed privacy/cache work is retained.
- 2026-07-21: Human-approved follow-up moved `[A]` inside the From control, widened language selectors, moved replica state onto the toolbar, made status indicators action-specific, localized UI labels to the target language, and reopened OpenAI dark-canvas plus cross-site scrolling as release-blocking regressions.
- 2026-07-21: Human-approved CSS follow-up requires a complete safe capture/application audit, implementation of generic fidelity fixes, and an explicit explanation for any CSS excluded by inertness, privacy, CSP, permissions, or browser access boundaries.

## Design Notes

Control text is typed metadata, never a raw `value` attribute. Projection identity checks provide currency without polluting cache keys with nodes/documents. Pixel hashes are safer than URL-only reuse: equivalent processed content hits, while changed crop/size preserves correct geometry. OCR accepts missing confidence but rejects punctuation-only or supplied low-confidence regions.

CSS fidelity preserves safe inline, embedded, linked, adopted, open-shadow,
custom-property, media/pseudo-rule, SVG-presentation, and same-document fragment
effects in cascade order. It does not weaken the inert boundary: closed roots,
unreadable cross-origin CSSOM, generated pseudo text, no-script custom-element
state, and CSSOM-only script mutations without an observable signal remain
limits. Strict Local Mirror and its no-network acceptance suite remain deferred.

## Verification

**Commands:**
- Focused implementation suites cover toolbar localization/status, exact-content
  caches, OCR safeguards, document/nested/open-shadow scrolling, live canvas
  color propagation, and sanitized same-document CSS fragments.
- `npm run check` passes with 56 test files and 726 tests; the guarded release
  build is byte-equal to `dist/chrome-unpacked` and reports version 0.3.2.
- `git diff --check` is rerun after the final review and artifact synchronization.

**Manual checks:**
- In Chrome, verify inputs/passwords, duplicate-content cache hits, nested and
  document scrolling, quick translation/progress, target-language UI fallback,
  themes/280px layout, OCR, persistence, and build number.
- OpenAI.com remains an explicit human acceptance check for dark canvas, logo
  geometry, and reading-position sync; the implementation does not claim a live
  browser verification in this document.
