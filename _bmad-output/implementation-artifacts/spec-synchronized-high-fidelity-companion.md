---
title: 'Synchronized high-fidelity translation companion'
type: 'feature'
created: '2026-07-19T17:16:02+09:00'
status: 'done'
review_loop_iteration: 0
baseline_commit: '5448d27cae9a5f17823f0ea57087191725b0a723'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-side-by-side-page-translation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The panel becomes stale after navigation, Refresh cannot recover expired cross-origin `activeTab` access, and the flat card loses page layout, styling, and visuals. Translation must also be started manually each time.

**Approach:** Make the panel follow completed page loads with race-safe recapture, offer persisted opt-in automatic translation with explicit per-site or all-site access, and replace the flat card with a sanitized computed-style visual tree that closely mirrors ordinary page structure while remaining inert.

## Boundaries & Constraints

**Always:** Leave source DOM and scrolling untouched. Treat injected data as hostile; revalidate and rebuild only a bounded typed tree using safe tags, attributes, image URLs, and computed-style allowlists. Preserve ordinary layout, typography, borders, colors, safe backgrounds, images, empty control shells, RTL, and source dimensions. Auto-translation defaults off and persists only preferences. Offer Off / This site / All sites; request matching optional HTTP(S) access only from a user gesture and remove access with its preference. Add only required `storage` plus declared optional HTTP(S) patterns. Invalidate on loading/tab changes, debounce completion, queue the newest refresh, and reject stale generations. Require one explicit Translate action before automatic runs if Chrome must prepare/download the pair.

**Ask First:** Required always-on host access, `tabs`/`debugger`/screen-capture permissions, live mutation mirroring, OCR, source-page changes, cross-origin frame capture, remote translation, or languages beyond Japanese/English.

**Never:** Claim pixel-perfect or exact fidelity; embed the live page; copy HTML, scripts, handlers, arbitrary stylesheets/CSS properties, form values, passwords, selections, contenteditable text, navigation, or executable behavior. Do not auto-start a model download without user activation. Do not retain stale content after access loss or silently broaden site access.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Manual refresh | Authorized page, idle or busy | Queue latest capture and abort obsolete work | Clear stale output; show actionable failure |
| New origin | `activeTab` revoked; panel open | Toolbar signal refreshes its locked tab without reload | Explain reauthorization when absent |
| Automatic load | Scope granted; model ready | Capture and translate once after completion | Disable revoked scope; show CTA |
| Model unprepared | Pair downloadable/downloading | Render mirror; wait for explicit Translate | Never create automatically |
| Rapid navigation | Events race with work | Only newest generation commits | Abort/discard stale work |
| Complex page | Unsupported or oversized content | Safe subset plus placeholders/omissions | Enforce bounds; retain failed-image layout |

</frozen-after-approval>

## Code Map

- `lib/page-snapshot.ts`, `entrypoints/page-snapshot.ts` -- typed visual-tree capture, bounds, privacy filtering, and parsing.
- `lib/visual-renderer.ts`, `entrypoints/sidepanel/` -- inert reconstruction, scaling, controls, and translation binding.
- `lib/companion-lifecycle.ts`, `lib/preferences.ts` -- generation control, auto policy, permission scope, and settings.
- `entrypoints/popup/main.ts`, `entrypoints/sidepanel/main.ts` -- locked authorization messaging, capture queue, and translation orchestration.
- `wxt.config.ts`, `tools/extension-artifact.mjs` -- required storage and exact optional-host release boundary.
- `tests/`, `docs/translation-companion.md`, `README.md`, `dist/chrome-unpacked/` -- regression proof, permission/fidelity disclosure, and refreshed installable build.

## Tasks & Acceptance

**Execution:**
- [x] `lib/{page-snapshot,visual-renderer}.ts`, matching tests -- build and adversarially validate bounded visual capture, translation keys, and inert rendering.
- [x] `lib/{companion-lifecycle,preferences}.ts`, matching tests -- model newest-generation work, auto readiness, scope persistence, denial/revocation, and coalescing.
- [x] `entrypoints/sidepanel/{index.html,main.ts,style.css}` -- add mirror/scaling/auto UI and race-safe load completion.
- [x] `entrypoints/popup/main.ts` -- signal an open panel with the newly authorized locked tab.
- [x] `wxt.config.ts`, artifact tool/tests -- allow exactly `storage` and optional HTTP(S) patterns.
- [x] `README.md`, companion guide, release artifact -- document limits/prompts/preparation and ship the verified build.

**Acceptance Criteria:**
- Given an ordinary page, when captured, then Fit width and 1:1 mirrors retain its safe structure, styling, images, and locations.
- Given private or hostile DOM, when mirrored, then values and executable/navigation behavior never cross or activate.
- Given authorized navigation, when complete, then refresh occurs without reload and prepared auto mode runs once.
- Given expired access, when the toolbar action runs, then its exact tab refreshes without closing the panel.
- Given any race or failure, when handled, then stale content stays cleared and guidance names the next action.
- Given completion, when `npm run check` runs, then the MV3 artifact passes without required host access or remote code.

## Spec Change Log

## Design Notes

Exact duplication is impossible because translation changes text metrics and frames, shadow roots, canvas/video state, fonts, and script pixels may be inaccessible. A typed computed-style tree supports full-page translation and ordinary layout without cloning HTML. Fit width scales the source viewport; 1:1 scrolls horizontally. Optional host access enables unattended cross-origin capture; otherwise toolbar-granted `activeTab` remains.

## Verification

**Commands:**
- `npm run check` -- strict types, full unit suite, production build, security validation, and byte-identical committed artifact pass.
- `git diff --check` -- no whitespace errors.

**Manual checks:**
- In Chrome 138+, exercise both languages, two origins, permissions, model preparation, races, scaling, private controls, missing images, and preference persistence.

## Suggested Review Order

**Capture and navigation lifecycle**

- Navigation events clear stale output and debounce only the newest completed page.
  [`main.ts:175`](../../entrypoints/sidepanel/main.ts#L175)

- One generation-aware capture queue owns refresh, timeout, and stale-result rejection.
  [`main.ts:343`](../../entrypoints/sidepanel/main.ts#L343)

- Toolbar authorization targets the exact active tab and wakes an open panel.
  [`main.ts:8`](../../entrypoints/popup/main.ts#L8)

**Visual fidelity and safety**

- Snapshot capture extracts bounded translation items before constructing the visual model.
  [`page-snapshot.ts:519`](../../lib/page-snapshot.ts#L519)

- Typed visual reconstruction captures allowlisted styles while shelling private controls.
  [`page-snapshot.ts:1098`](../../lib/page-snapshot.ts#L1098)

- The panel rebuilds only inert nodes and applies translations through text content.
  [`visual-renderer.ts:33`](../../lib/visual-renderer.ts#L33)

- Grouped translations preserve target-language word and grapheme boundaries across inline styles.
  [`visual-renderer.ts:290`](../../lib/visual-renderer.ts#L290)

**Automatic translation and permission integrity**

- User-gesture permission changes use an origin-wide lock before requesting access.
  [`main.ts:880`](../../entrypoints/sidepanel/main.ts#L880)

- Chrome-138-compatible messaging routes preference writes through one service-worker coordinator.
  [`background.ts:17`](../../entrypoints/background.ts#L17)

- Fresh-value serialization prevents side panels from overwriting each other's scopes.
  [`preference-coordinator.ts:56`](../../lib/preference-coordinator.ts#L56)

- Reconciliation removes partial wildcard, revoked, and orphaned exact grants.
  [`preference-coordinator.ts:141`](../../lib/preference-coordinator.ts#L141)

- Automatic runs start only when Chrome's local language pair is already prepared.
  [`companion-lifecycle.ts:10`](../../lib/companion-lifecycle.ts#L10)

**Interface, release boundary, and proof**

- The side panel exposes Off/Site/All and Fit/1:1 choices without source mutation.
  [`index.html:55`](../../entrypoints/sidepanel/index.html#L55)

- The manifest keeps host access optional and declares only documented capabilities.
  [`wxt.config.ts:10`](../../wxt.config.ts#L10)

- Renderer regression tests protect target-language segment boundaries.
  [`visual-model.test.ts:275`](../../tests/visual-model.test.ts#L275)

- Permission regression tests protect wildcard and exact-origin cleanup.
  [`preference-coordinator.test.ts:98`](../../tests/preference-coordinator.test.ts#L98)

- Installation remains a direct Load-unpacked flow from the committed release directory.
  [`README.md:7`](../../README.md#L7)
