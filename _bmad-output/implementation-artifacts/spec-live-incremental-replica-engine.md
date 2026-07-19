---
title: 'Introduce the live replica engine foundation'
type: 'feature'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
baseline_commit: '17355d8537bcaa8be32389b070607d1d84c4e835'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/research/technical-live-dom-replication-ocr-extension-access-research-2026-07-19.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Simul rebuilds large DOM subtrees after small changes, causing fidelity gaps and full-page recovery. A safe foundation is needed before replacing the working companion.

**Approach:** Add a reversible engine seam and development-only rrweb shadow path. Validate one bounded, document-scoped checkpoint in hidden, inert, source-sized staging while the legacy mirror stays visible.

## Boundaries & Constraints

**Always:** Keep the source DOM read-only; mask controls/contenteditable before transport; validate every message; package code locally; block replay actions, scripts, canvas, interaction capture, and new network requests; require existing access; preserve current behavior; separate v1/v2 identity; retain the last coherent view.

**Ask First:** New permissions/hosts, resource traffic, visible/default engine changes, or weaker safety limits.

**Never:** Send page data remotely, load remote code, capture private values, expose rrweb to users in this slice, or include OCR.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Error Handling |
|----------|---------------|-------------------|----------------|
| Shadow checkpoint | Authorized page; flag on | Hidden replay and content-free size/timing/extent diagnostics | Deadline leaves legacy intact |
| Private content | Controls/contenteditable hold canaries | Canaries never cross the recorder boundary | Reject safely |
| Stale document | Navigation or wrong document/generation | No commit | Cancel stale work |
| Unsafe data/access | Invalid/oversized data, replay failure, or no grant | No partial replay or broader access | Fail once; no loop |

</frozen-after-approval>

## Code Map

- `package.json`, `package-lock.json` -- pinned rrweb runtimes.
- `entrypoints/page-recorder.ts` -- on-demand unlisted recorder.
- `lib/replica/` -- engine contracts, v2 validation, legacy adapter, shadow engine.
- `entrypoints/sidepanel/main.ts` -- identity, cancellation, diagnostics, fallback wiring.
- `tools/extension-artifact.mjs`, `tests/` -- safety and behavior gates.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `package-lock.json` -- lock `@rrweb/record` and `@rrweb/replay` 2.1.0.
- [x] `lib/replica/` -- add browser-independent contracts, bounded v2 envelopes, fakes, legacy-default selection, and one-shot fallback.
- [x] `entrypoints/page-recorder.ts` -- emit a masked full checkpoint with interaction tails disabled.
- [x] `entrypoints/sidepanel/main.ts` -- run shadow capture only when compiled on and identity-current.
- [x] `tests/` -- cover the matrix, identities, canaries, executable content, limits, and recovery.
- [x] `tools/extension-artifact.mjs`, `dist/chrome-unpacked/` -- enforce safe local bundles and sync the installable extension.

**Acceptance Criteria:**
- Production selects legacy with no behavior, permission, host, or static-content-script change.
- Shadow replay stays in hidden inert staging and reports bounded bytes, timing, extents, and content-free failure codes.
- Private canaries and stale/wrong identities are absent or rejected before replay and never affect the visible companion.
- Any shadow failure falls back at most once while the legacy view remains usable.
- The artifact contains only local recorder/replay code, with no source maps or remote executable fallback.

## Spec Change Log

## Design Notes

Checkpoint A is this spec. Enable its development-only path with `WXT_SIMUL_RRWEB_SHADOW=1 npm run dev`. Queued: B makes staged replay visible; C adds ordered events, ACK/gap recovery, and atomic checkpoints; D translates changed source revisions and promotes rrweb after Chrome safety/fidelity gates. OCR follows stable replica identity.

## Verification

**Commands:**
- `npm run artifact:sync` -- committed unpacked extension is refreshed.
- `npm run check` -- typecheck, tests, build, and artifact checks pass.

**Manual checks (if no CLI):**
- In Chrome, exercise navigation and a private-form fixture in the shadow build; the visible legacy mirror must remain unchanged and canaries absent.

## Suggested Review Order

**Shadow orchestration**

- Start here: production remains legacy while the opt-in shadow controller is wired.
  [`main.ts:158`](../../entrypoints/sidepanel/main.ts#L158)

- Exact document injection binds shadow capture to the visible snapshot's Chrome document.
  [`main.ts:714`](../../entrypoints/sidepanel/main.ts#L714)

- Hidden sandboxed replay disappears without touching the usable legacy mirror.
  [`rrweb-shadow-engine.ts:55`](../../lib/replica/rrweb-shadow-engine.ts#L55)

**Privacy and bounded transport**

- Recorder masks controls and captures one bounded initial checkpoint only on demand.
  [`page-recorder.ts:90`](../../lib/replica/page-recorder.ts#L90)

- Preflight bounds synchronous recorder work before rrweb traverses an adversarial page.
  [`page-recorder.ts:198`](../../lib/replica/page-recorder.ts#L198)

- Dual sanitization rejects stale identity, malformed structure, oversized content, and private canaries.
  [`protocol-v2.ts:181`](../../lib/replica/protocol-v2.ts#L181)

- Node projection removes executable elements, interactions, and replay-time resource requests.
  [`protocol-v2.ts:352`](../../lib/replica/protocol-v2.ts#L352)

**Recovery and release safety**

- One-shot fallback keeps shadow failures from destabilizing the visible legacy view.
  [`engine-selection.ts:37`](../../lib/replica/engine-selection.ts#L37)

- Artifact validation scopes runtime markers and rejects remote executable paths.
  [`extension-artifact.mjs:109`](../../tools/extension-artifact.mjs#L109)

- Build stripping removes genuine directives while preserving harmless vendored string literals.
  [`wxt.config.ts:4`](../../wxt.config.ts#L4)

**Verification**

- Protocol tests exercise privacy canaries, identity, CSS, depth, and aggregate limits.
  [`replica-protocol.test.ts:26`](../../tests/replica-protocol.test.ts#L26)

- Engine tests cover hidden staging, cancellation, transient overlap, timeout, and fallback.
  [`replica-engine.test.ts:31`](../../tests/replica-engine.test.ts#L31)

- Artifact tests cover marker placement, source maps, static remote URLs, and packaging.
  [`extension-artifact.test.mjs:38`](../../tests/extension-artifact.test.mjs#L38)
