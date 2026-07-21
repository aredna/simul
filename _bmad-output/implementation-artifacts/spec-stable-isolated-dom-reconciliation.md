---
title: 'Stable Isolated DOM Reconciliation and Fidelity Diagnostics'
type: 'bugfix'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 0
baseline_commit: '6326669'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Isolated HTML currently serializes and rebuilds a parent’s complete child tree after a small child-list mutation. This destroys unchanged DOM identity, can detach translations and OCR anchors, repeats work, and leaves users unable to distinguish an intentional safety omission from a fidelity defect.

**Approach:** Add a bounded ordered child-reconciliation operation that retains proven same-parent nodes and transports graphs only for new content, while keeping the existing full-child replacement as a conservative fallback. Report content-free reconciliation and representability counters so failures and known mirror limits are visible.

## Boundaries & Constraints

**Always:** Preserve exact document/sequence identity, final child order, privacy masking, current size/depth/byte limits, inert scriptless rendering, last-good recovery, and Simul-owned style nodes. Retain only a node that the receiver already knows as a direct child of that same target; validate the whole batch and stage new graphs before visible mutation. Derive references from ordered emitted state, including unacknowledged batches. Keep rules generic and diagnostics aggregate-only.

**Ask First:** Cross-parent identity reuse; custom-element definitions or source-definition metadata; per-element diagnostics; closed-root instrumentation; new permissions, networking, persistence, computed-style capture, or weaker sandbox/CSP.

**Never:** Execute page scripts, constructors, or lifecycle callbacks; call `cloneNode`; inspect inaccessible roots; log text, URLs, attributes, tag names, node IDs, or exception messages; special-case a website; or claim pixel parity or closed-root detection.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Stable edit | Append, remove, or reorder public direct children | Retain unchanged DOM objects; insert/remove only the delta; preserve exact order, translations, slots, shadows, and image anchors | New graphs remain sanitized and bounded |
| Covered dirty branch | Ancestor child-list change also covers changed descendants, privacy context, or shadow topology | Use existing full `children` replacement | Record a bounded fallback reason |
| Invalid reference | Unknown, duplicate, disconnected, cross-parent, ancestor/shadow-root, or colliding ID | Do not mutate or acknowledge the batch | Keep last-good view and request checkpoint recovery |
| Reinsertion | A node returns after its removal was emitted | Send it as a new graph, not a retain reference | Ordered state prevents stale references |
| Representation gap | Unsafe node/resource, stripped active state, unreadable style, depth/capacity limit, or custom host without an accessible open root | Omit or fail closed as today, with aggregate reason/count | Never infer that an inaccessible root is closed |

</frozen-after-approval>

## Code Map

- `lib/replica/html-mirror-{protocol,source,sanitizer}.ts` -- validate the new operation, track sender-known child identity, sanitize new graphs, and collect bounded source diagnostics.
- `lib/replica/isolated-html-engine.ts` -- preflight and apply keyed children, preserve projections/anchors, recover safely, and produce metrics.
- `entrypoints/sidepanel/main.ts` -- print content-free reconciliation and representability diagnostics.
- `tests/{html-mirror-protocol,html-mirror-source,isolated-html-engine}.test.ts` -- protocol, sequencing, privacy, identity, rollback, slot/shadow, and diagnostics regressions.
- `README.md`, `package.json`, `dist/chrome-unpacked/` -- document limits and synchronize build identity/artifact.

## Tasks & Acceptance

**Execution:**
- [x] Add a strictly validated `reconcile-children` final-order payload containing same-parent retain references or sanitized new graphs; preserve `children` as fallback.
- [x] Track the receiver-known ordered child state across emitted batches, removal/reinsertion, dirty coverage, privacy transitions, and recovery checkpoints.
- [x] Prebuild and validate reconciliation plans, retain compatible objects, minimally reorder, remove stale maps/projections, and avoid translation upserts for unchanged text.
- [x] Add bounded counters for retained/inserted/moved/removed/replaced nodes, fallback classes, unsafe resources/active state, unreadable styles, depth/capacity omissions, custom hosts, and accessible open roots.
- [x] Cover adversarial references, partial-commit rollback, adopted styles, named slots/open shadows, translated text, image anchors, and privacy transitions; update docs/version/artifact.

**Acceptance Criteria:**
- Same-parent append/remove/reorder retains unchanged text, image, and shadow-host object identity and emits no unchanged translation work.
- Dirty or privacy-changing branches use full replacement; malformed or cross-parent references leave the last-good DOM and internal maps unchanged before recovery.
- Diagnostics explain delta versus fallback and suspected inaccessible custom-host state using bounded counts only.
- `npm run check` passes and the ready-to-load artifact reports the incremented build.

## Spec Change Log

## Design Notes

The reconciliation operation represents the target’s final direct-child order. A retained entry contains only an existing child ID; a graph entry contains one complete new sanitized subtree. Source-side emitted state, not the live DOM alone, decides whether retention is legal. Existing full replacement remains the recovery path whenever that proof is unavailable.

## Verification

**Commands:**
- `npx vitest run tests/html-mirror-protocol.test.ts tests/html-mirror-source.test.ts tests/isolated-html-engine.test.ts` -- focused reconciliation and diagnostics coverage passes.
- `npm run check` -- typecheck, full tests, and artifact integrity pass.
- `npm run artifact:sync && npm run artifact:check` -- installable Chrome artifact matches source.

## Suggested Review Order

**Sender identity and bounded deltas**

- Start with final-order reconciliation and new-root-only graph transport.
  [`html-mirror-source.ts:562`](../../lib/replica/html-mirror-source.ts#L562)

- Conservative proof failures preserve full replacement for unsafe identity transitions.
  [`html-mirror-source.ts:921`](../../lib/replica/html-mirror-source.ts#L921)

- Shared budgets sanitize only newly transported roots.
  [`html-mirror-sanitizer.ts:424`](../../lib/replica/html-mirror-sanitizer.ts#L424)

**Wire contract and validation**

- The payload distinguishes retained IDs from complete sanitized graphs.
  [`html-mirror-protocol.ts:42`](../../lib/replica/html-mirror-protocol.ts#L42)

- Exact-key parsing enforces global identity and node bounds.
  [`html-mirror-protocol.ts:407`](../../lib/replica/html-mirror-protocol.ts#L407)

**Atomic receiver reconciliation**

- Whole-batch preflight rejects mixed, disconnected, colliding, or cross-parent references.
  [`isolated-html-engine.ts:1151`](../../lib/replica/isolated-html-engine.ts#L1151)

- Staged commit preserves retained objects and counts immutable pre-batch membership.
  [`isolated-html-engine.ts:1302`](../../lib/replica/isolated-html-engine.ts#L1302)

- LIS selection minimizes moves while preserving exact final order.
  [`isolated-html-engine.ts:1663`](../../lib/replica/isolated-html-engine.ts#L1663)

- Independent rollback attempts preserve the last-good replica after partial failures.
  [`isolated-html-engine.ts:1512`](../../lib/replica/isolated-html-engine.ts#L1512)

**Privacy-safe diagnostics**

- Bounded exact-key counters distinguish omissions, fallbacks, and accessible roots.
  [`html-mirror-sanitizer.ts:76`](../../lib/replica/html-mirror-sanitizer.ts#L76)

- Failure summaries cross the stream without carrying source content.
  [`html-mirror-client.ts:263`](../../lib/replica/html-mirror-client.ts#L263)

- Console output separates baseline and event-only aggregate counters.
  [`main.ts:311`](../../entrypoints/sidepanel/main.ts#L311)

**Regression coverage and release**

- Sender tests prove retained subtrees are never traversed again.
  [`html-mirror-source.test.ts:447`](../../tests/html-mirror-source.test.ts#L447)

- Receiver tests preserve text, image, shadow, slot, and DOM identity.
  [`isolated-html-engine.test.ts:399`](../../tests/isolated-html-engine.test.ts#L399)

- Adversarial tests cover minimal movement and complete rollback recovery.
  [`isolated-html-engine.test.ts:721`](../../tests/isolated-html-engine.test.ts#L721)

- User-facing limits and diagnostic meanings remain explicit.
  [`README.md:37`](../../README.md#L37)

- The ready-to-load artifact asserts build version 0.2.5.
  [`extension-artifact.test.mjs:529`](../../tests/extension-artifact.test.mjs#L529)
