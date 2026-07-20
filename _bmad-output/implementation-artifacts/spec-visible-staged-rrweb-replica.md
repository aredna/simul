---
title: 'Promote the staged rrweb replica to a visible preview'
type: 'feature'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'ab0ba3d5e996b8917aab0065394e0d6c931d786d'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-live-incremental-replica-engine.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Checkpoint A safely rebuilds one rrweb snapshot but destroys it off-screen, so fidelity, source-viewport geometry, zoom, scrolling, navigation, and fallback cannot be evaluated in the companion.

**Approach:** In the explicitly flagged development build, atomically promote a completed, identity-current candidate as a labeled static and untranslated rrweb preview. Retain the legacy renderer as the bounded fallback and return to it before translation or live-delta work reserved for later checkpoints.

## Boundaries & Constraints

**Always:** Keep candidates hidden until validated, rebuilt, protected, and exact-document current; preserve the last coherent surface until a synchronous swap; retain at most one candidate and committed Replayer; size the iframe to the source viewport and bound extension-owned overflow; preserve zoom, scroll following, side-panel, and detached behavior; keep the iframe sandboxed with only `allow-same-origin`, inert, unfocusable, pointer-free, and no-referrer; label preview versus fallback; keep production and ordinary development on legacy.

**Ask First:** Any permission, host, CSP, resource-traffic, privacy-limit, deadline, production/default, or v2 transport change.

**Never:** Translate or resize rrweb text here; stream rrweb incrementals; run site scripts, forms, navigation, interactions, or unsafe canvas; restore stripped resource URLs; mutate the source; blank the companion on failure; retain unbounded replay state.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|---------------|-------------------|----------------|
| Visible preview | Flagged development; valid current checkpoint | Hidden candidate atomically becomes the labeled source-sized preview | Legacy remains mounted until commit succeeds |
| Legacy-only build | Production or no flag | Existing mirror and controls stay unchanged | No rrweb presentation work |
| Rejected candidate | Stale, invalid/private/oversized, denied, timed out, or replay failed | Destroy candidate; keep legacy visible | Permanent failure labels once; stale and `capture_busy` remain retryable |
| Unsupported operation | Translation or first v1 dirty event while preview is visible | Show legacy and dispose preview before processing | Continue through the existing v1 path |
| Layout/lifecycle | Zoom, scroll, repeat capture, navigation, teardown | Scale externally; map scroll into the iframe; release ownership once | Preserve last-good view until replacement |

</frozen-after-approval>

## Code Map

- `lib/replica/rrweb-shadow-engine.ts` -- prepared candidate, promotion seam, retained Replayer, disposal.
- `lib/replica/engine-selection.ts` -- legacy-default fallback and presentation release boundary.
- `lib/replica/visible-replay-host.ts` -- surfaces, labels, geometry, scroll mapping.
- `entrypoints/sidepanel/main.ts`, `entrypoints/sidepanel/index.html`, `entrypoints/sidepanel/style.css` -- exact-document wiring and compact preview UI.
- `tests/replica-engine.test.ts`, `tests/visible-replay-host.test.ts` -- ownership, atomicity, geometry, fallback, cleanup.

## Tasks & Acceptance

**Execution:**
- [x] `lib/replica/rrweb-shadow-engine.ts` -- commit one completed candidate and destroy failed, superseded, or disposed leases exactly once.
- [x] `lib/replica/visible-replay-host.ts` -- manage surfaces, labels, bounded extents, zoom-compatible roots, and scaled scroll projection.
- [x] `lib/replica/engine-selection.ts`, `entrypoints/sidepanel/main.ts` -- await preview outcome, release presentation on fallback, switch before v1 translation/deltas, and preserve exact `documentId` checks.
- [x] `entrypoints/sidepanel/index.html`, `entrypoints/sidepanel/style.css` -- add a minimal hidden-by-default badge and local protected viewport styles.
- [x] `tests/replica-engine.test.ts`, `tests/visible-replay-host.test.ts` -- cover the matrix, protection, replacement, teardown, scaling, and scroll.
- [x] `_bmad-output/project-context.md`, `dist/chrome-unpacked/` -- document B and refresh through validated artifact sync only.

**Acceptance Criteria:**
- Given production or an unflagged build, when capture runs, then legacy behavior and permissions remain unchanged and no badge appears.
- Given a flagged current checkpoint, when rebuild completes, then exactly one protected viewport appears atomically and is labeled static/untranslated.
- Given stale or failed work, when it settles, then it cannot alter the committed surface and usable legacy remains without a fallback loop.
- Given translation or a v1 dirty event during preview, when processing begins, then legacy is visible first and rrweb presentation is released.
- Given zoom, scroll, navigation, repeat capture, or teardown, when state changes, then breakpoints and identity remain stable and no old Replayer survives.

## Spec Change Log

## Design Notes

Keep `WXT_SIMUL_RRWEB_SHADOW=1` for continuity. B is a fidelity probe: sanitized resources stay omitted, C adds ordered incremental convergence, and D adds revision-checked translation. Parent scrolling maps scaled offsets into `iframe.contentWindow.scrollTo()`; stretching the iframe to document height would change responsive layout and is forbidden.

## Verification

**Commands:**
- `npm run artifact:sync` -- refresh the validated installable artifact without permission or remote-code drift.
- `npm run check` -- pass typecheck, tests, production build, and exact artifact comparison.
- `WXT_SIMUL_RRWEB_SHADOW=1 npm run dev` -- select the visible preview path.

**Manual checks (if no CLI):**
- In Chrome, verify privacy, no replay traffic/source mutation, zoom/scroll, visible fallback, atomic navigation, and clean side-panel/detached teardown.

## Suggested Review Order

**Flagged orchestration and fallback**

- Development-only wiring selects the preview while preserving legacy production behavior.
  [`main.ts:161`](../../entrypoints/sidepanel/main.ts#L161)

- Current-document capture awaits promotion and retains coherent fallback across navigation.
  [`main.ts:633`](../../entrypoints/sidepanel/main.ts#L633)

- Versioned engine ownership prevents stale candidates from superseding newer work.
  [`rrweb-shadow-engine.ts:80`](../../lib/replica/rrweb-shadow-engine.ts#L80)

- Synchronous DOM replacement preserves the previous surface until commit succeeds.
  [`visible-replay-host.ts:206`](../../lib/replica/visible-replay-host.ts#L206)

- Translation and live deltas release static presentation before legacy mutation.
  [`main.ts:970`](../../entrypoints/sidepanel/main.ts#L970)

**Protected geometry and scrolling**

- Source-sized iframe geometry keeps zoom external and overflow bounded.
  [`visible-replay-host.ts:110`](../../lib/replica/visible-replay-host.ts#L110)

- Sandbox, inertness, focus blocking, border removal, and no-referrer are enforced together.
  [`rrweb-shadow-engine.ts:285`](../../lib/replica/rrweb-shadow-engine.ts#L285)

- Fractional parent scrolling projects stable, unscaled coordinates into the replay.
  [`visible-replay-host.ts:274`](../../lib/replica/visible-replay-host.ts#L274)

- Pointer-free sticky viewport styles preserve inspection without page interaction.
  [`style.css:212`](../../entrypoints/sidepanel/style.css#L212)

**Ownership and regression boundaries**

- Presentation release aborts candidates and destroys each retained Replayer once.
  [`rrweb-shadow-engine.ts:196`](../../lib/replica/rrweb-shadow-engine.ts#L196)

- Busy replacement, overlap, and delayed-capture tests cover exact-document races.
  [`replica-engine.test.ts:229`](../../tests/replica-engine.test.ts#L229)

- Geometry and fractional-drift tests exercise the scaled presentation host.
  [`visible-replay-host.test.ts:101`](../../tests/visible-replay-host.test.ts#L101)

- Atomic-failure and disposal tests preserve the last coherent surface.
  [`visible-replay-host.test.ts:203`](../../tests/visible-replay-host.test.ts#L203)

**Release surfaces and project knowledge**

- Hidden preview and badge surfaces add no unflagged visual chrome.
  [`index.html:120`](../../entrypoints/sidepanel/index.html#L120)

- Engine contracts expose one explicit presentation-release boundary.
  [`contracts.ts:73`](../../lib/replica/contracts.ts#L73)

- Durable context records Checkpoint B limits and future checkpoint boundaries.
  [`project-context.md:19`](../project-context.md#L19)

- The installable production artifact contains the hidden surfaces with unchanged authority.
  [`sidepanel.html:112`](../../dist/chrome-unpacked/sidepanel.html#L112)
