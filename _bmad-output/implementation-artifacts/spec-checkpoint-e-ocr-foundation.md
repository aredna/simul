---
title: 'Checkpoint E: Modular OCR Foundation and Image Scheduling'
type: 'feature'
created: '2026-07-20'
status: 'done'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-checkpoint-d-live-translation-projection.md'
  - '{project-root}/_bmad-output/planning-artifacts/research/technical-live-dom-replication-ocr-extension-access-research-2026-07-19.md'
baseline_commit: '26d64505d8919099fad54a2f407928a504dc09a5'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Simul has no stable boundary for discovering image text, ordering independently packaged OCR engines, or deciding when image work becomes eligible. Adding Tesseract directly would couple settings, page observation, scheduling, and a heavy runtime into one unsafe change.

**Approach:** Add the provider-neutral OCR contracts, compile-generated empty registry, persisted policy, bounded source-image revision model, and IntersectionObserver-backed scheduling foundation. Keep it dormant until a later provider checkpoint supplies pixels and compute.

## Boundaries & Constraints

**Always:** Preserve the five stable IDs and default order: `chrome-text-detector`, `tesseract`, `transformers`, `paddleocr-wasm`, `chromium-screen-ai`. Persist a complete duplicate-free order, the three scan policies, conservative small-image setting, and two independent Prompt preferences. Filter runtime order through compiled availability without changing saved positions. Image records are exact-document, rrweb-node-owned, revisioned, tombstoned, bounded, and currency-checked. Manual override applies only to the current revision. Visible work outranks near/background work.

**Ask First:** Any dependency, Worker, model, Wasm, offscreen document/permission, CSP relaxation, pixel capture/fetch, image-result persistence, provider activation, Prompt session, or user-visible claim that image translation works.

**Never:** Mutate the source or replica; emit source URLs, surrounding text, pixels, hashes, or control/private data in image descriptors; import compile-disabled providers; silently repair an untrusted UI command; trust replay geometry as source geometry; or implement OCR recognition, translation overlays, remote downloads, SVG/canvas/video/background capture in E.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Saved policy | Old, partial, duplicated, or unknown stored values | Retain valid values, append missing IDs canonically, and supply safe defaults | Parser repairs storage data; strict command boundary rejects malformed patches |
| Build profile | Default build or provider flag set | Default registry is empty and imports no provider; an unimplemented enabled flag fails clearly | Production forces all OCR flags off and rejects leaked runtime artifacts |
| Image lifecycle | `<img>` load/source change, resize, removal/reuse, or late observer callback | Advance content or observation revision appropriately; preserve tombstones and exact-document identity | Reject stale, disconnected, malformed, wrong-document, or over-capacity records |
| Scan policy | Visible-only, background-prescan gates, eager-all, or policy switch | Recompute one bounded priority queue without changing content revisions | New visible/manual work preempts background; duplicates coalesce |
| Small image | Boundary dimensions, long thin image, disabled filter, or explicit override | Apply documented reason-coded heuristic; override current revision only | Invalid/non-finite dimensions are rejected |

</frozen-after-approval>

## Code Map

- `lib/ocr/{known-provider-ids,contracts,provider-registry}.ts` -- stable identities, normalized provider/result geometry contracts, policy filtering, and compiled-subset reordering.
- `lib/ocr/{source-image-model,source-image-observer}.ts` -- bounded revision/tombstone ownership and thin injected `<img>`/IntersectionObserver adapter.
- `lib/ocr/{image-scan-scheduler,small-image-policy}.ts` -- deterministic three-policy queue, gates, promotion, override, and eligibility decisions.
- `lib/preferences.ts`, `lib/preference-coordinator.ts`, `entrypoints/sidepanel/` -- additive persisted OCR settings and compiled-capability-driven controls within the existing collapsed options surface.
- `tools/ocr-build-profile.ts`, `wxt.config.ts`, `types/`, `tools/extension-artifact.mjs` -- virtual compile registry and default-artifact absence guarantees.
- `tests/` and `_bmad-output/project-context.md` -- behavioral, boundary, build-profile, and architecture coverage.

## Tasks & Acceptance

**Execution:**
- [x] Add provider IDs, strict normalized contracts, registry filtering/reordering, and an all-disabled virtual build registry.
- [x] Extend additive v1 preference parsing and serialized patches; render OCR controls only for compiled capabilities and keep the compact toolbar unchanged.
- [x] Implement and unit-test the bounded source-image model, `<img>` observer adapter, small-image decisions, and three scheduling policies.
- [x] Harden production builds against ambient OCR flags, permissions/CSP drift, provider dependencies, and Worker/Wasm/model leakage.
- [x] Update architecture/deferred handoff so F activates offscreen local Tesseract without reopening E invariants.

**Acceptance Criteria:**
- Given any stored provider order, when preferences load, then Simul produces a fresh complete canonical permutation while strict runtime messages accept only exact valid values.
- Given the default production profile, when Simul builds, then no OCR provider import, runtime asset, dependency, permission, CSP relaxation, or visible inert provider row exists.
- Given source-image and observer events, when identity, content, geometry, visibility, or connectivity changes, then only current bounded descriptors and revisions can enter scheduling and no page content is disclosed.
- Given each scan policy, quiet/ready/translation-idle gates, small-image boundaries, overrides, churn, and overflow, when eligibility changes, then ordering, coalescing, cancellation, and fail-closed outcomes are deterministic.

## Spec Change Log

## Design Notes

Only `<img>` discovery is implemented in E; other source kinds remain contract-reserved. The observer and scheduler are inactive with an empty compiled registry. Screen AI keeps a stable persisted ID but cannot be enabled without a future public extension API. Prompt preferences are sidecars, never entries in the spatial provider order. Checkpoint F owns pixels, hashing/cache, offscreen lifecycle, packaged Tesseract, language groups, recognition, geometry validation, and inert overlays.

## Verification

**Commands:**
- `npm run check` -- typecheck, full tests, guarded production build, and committed artifact comparison pass.
- `npm run artifact:sync && npm run check` -- the validated directly installable artifact is synchronized and reproducible.

**Manual checks:**
- Open the collapsed options surface; confirm OCR settings remain absent when no provider or Prompt capability is compiled and ordinary page translation behavior is unchanged.

## Suggested Review Order

**Compile-time provider boundary**

- Empty generated registry preserves stable IDs while keeping default builds inert.
  [`provider-registry.ts:28`](../../lib/ocr/provider-registry.ts#L28)

- Exact build flags fail before an unimplemented provider can enter a bundle.
  [`ocr-build-profile.ts:59`](../../tools/ocr-build-profile.ts#L59)

- WXT receives the compile-generated virtual registry at its main configuration boundary.
  [`wxt.config.ts:29`](../../wxt.config.ts#L29)

**Safe image discovery and lifecycle**

- Strict descriptors exclude URLs, text, pixels, hashes, and unknown fields.
  [`contracts.ts:136`](../../lib/ocr/contracts.ts#L136)

- Exact-document ledger owns bounded revisions, tombstones, and current image records.
  [`source-image-model.ts:40`](../../lib/ocr/source-image-model.ts#L40)

- Shared observer emits safe facts while guarding teardown, privacy, and capacity transitions.
  [`source-image-observer.ts:78`](../../lib/ocr/source-image-observer.ts#L78)

- Canonical identity parsing prevents malformed or cross-document image work.
  [`source-identity.ts:20`](../../lib/replica/source-identity.ts#L20)

- Shared privacy rules exclude controls and editable ancestry from observation.
  [`source-privacy-policy.ts:61`](../../lib/replica/source-privacy-policy.ts#L61)

**Bounded policy scheduling**

- Single-active scheduler orders only current revisions across all three scan policies.
  [`image-scan-scheduler.ts:67`](../../lib/ocr/image-scan-scheduler.ts#L67)

- Overflow recovery deterministically reconsiders deferred candidates when capacity returns.
  [`image-scan-scheduler.ts:417`](../../lib/ocr/image-scan-scheduler.ts#L417)

- Reason-coded small-image decisions keep filtering and manual override explicit.
  [`small-image-policy.ts:21`](../../lib/ocr/small-image-policy.ts#L21)

**Persistence and conditional UI**

- Additive storage parsing repairs legacy provider orders without broadening site access.
  [`preferences.ts:84`](../../lib/preferences.ts#L84)

- Strict command parsing rejects malformed image-analysis patches at the runtime boundary.
  [`preference-coordinator.ts:424`](../../lib/preference-coordinator.ts#L424)

- Image options render only when this compiled artifact exposes a capability.
  [`main.ts:1902`](../../entrypoints/sidepanel/main.ts#L1902)

**Packaging and regression coverage**

- Artifact validation rejects OCR runtimes, models, workers, dependencies, permissions, and CSP drift.
  [`extension-artifact.mjs:862`](../../tools/extension-artifact.mjs#L862)

- Contract tests lock provider identities, strict inputs, and normalized output geometry.
  [`ocr-foundation-contracts.test.ts:17`](../../tests/ocr-foundation-contracts.test.ts#L17)

- Observer tests prove safe facts, revision flow, and private-data exclusion.
  [`source-image-observer.test.ts:20`](../../tests/source-image-observer.test.ts#L20)

- Scheduler tests exercise policies, priority, gates, overflow, churn, and cancellation.
  [`image-scan-scheduler.test.ts:24`](../../tests/image-scan-scheduler.test.ts#L24)
