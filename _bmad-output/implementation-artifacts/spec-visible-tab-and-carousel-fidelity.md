---
title: 'Visible Tab and Carousel Fidelity'
type: 'bugfix'
created: '2026-07-24'
status: 'done'
review_loop_iteration: 0
baseline_commit: '266a7af6ab2ac78415203f1d690e3ffbe8124ac7'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-progressive-cached-image-translation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Simul blanks visible e-Tax date/headline rows because every `aria-controls` target is withheld. Its linked Slick banners can disappear in rrweb and miss ALT/OCR because replay geometry/resources are absent and transform-only motion invalidates evidence.

**Approach:** Admit controlled content only when relationship, state, and visibility prove it open; model tabs inline, not as popups. Give Passive Fidelity inert image parity and separate content identity from carousel layout.

## Boundaries & Constraints

**Always:** Use generic rules with source/receiver validation. Keep hidden or contradictory targets withheld and preserve password, authentication, payment, file, OTP, text-security, and private-editable floors. Strip website actions. Respect `controlImages`: disabled means no linked-image ALT/OCR and a content-free diagnostic. Keep evidence memory-only and bounded. Remain on `feat/replica-read-scope-redesign`; do not commit, merge, or push; advance the beta and synchronize `dist/chrome-unpacked`.

**Ask First:** New permissions/hosts, persistence, remote code/services, rrweb resource expansion beyond the existing Passive Fidelity disclosure, or weaker secret classification.

**Never:** Add e-Tax/Slick production branches, execute page scripts, restore source actions, map rotation/perspective as axis-aligned, expose contradictory panels, or bypass Git guards.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Failure Behavior |
|----------|---------------|-------------------|------------------|
| Selected tab | Open `tab`; painted `tabpanel` | Visible date/headline translates in both engines | Contradiction remains withheld |
| Inactive tab | Hidden panel | Base omits text; use inline-tab semantics only | Never create popup semantics |
| Secret descendant | Visible panel contains a secret field | Ordinary base text remains; secret subtree is opaque | Relationship stays unproven |
| Passive banner | Linked safe image | Both replicas keep an inert visual; ALT precedes OCR | Unsafe resource is counted and omitted |
| Carousel movement | Only layout changes | Rebind while retaining evidence | Retry after stable geometry |
| Policy/geometry block | Reading off or transform unsafe | Passive visual remains; blocked content is unread | Emit content-free reason |

</frozen-after-approval>

## Code Map

- `lib/replica/source-privacy-policy.ts`, `html-mirror-sanitizer.ts`, `live-recorder-session.ts` -- shared controlled-content classification.
- `lib/replica/semantic-source-{protocol,session,receiver}.ts`, `semantic-proof-presenter.ts` -- typed inline tab state.
- `lib/replica/protocol-v2.ts`, `rrweb-stream-sanitizer.ts`, `rrweb-shadow-engine.ts` -- inert Passive image parity.
- `lib/ocr/image-source-session.ts`, `source-image-observer.ts`, `image-translation-controller.ts` -- safe matrices and clone reuse.
- Tests, metadata, documentation, and `dist/chrome-unpacked/` -- regressions and reloadable beta.

## Tasks & Acceptance

**Execution:**
- [x] Replica privacy/sanitizer/session files -- base-admit only consistently open controlled targets while preserving secrets.
- [x] Semantic protocol/session/receiver/presenter files -- add typed inline `tab-state`; never route tabs through popup disclosure.
- [x] rrweb protocol/sanitizer/engine files -- under Passive Fidelity, revalidate inert image sources and bounded geometry while keeping anchors actionless.
- [x] OCR image session/observer/controller files -- accept only axis-aligned affine `matrix3d`, separate layout observation from content, and reuse clone evidence.
- [x] Tests/metadata/docs/artifact -- add both-engine regressions, diagnostics, beta identity, and synchronized trial build.

**Acceptance Criteria:**
- Given the e-Tax-shaped active tab, when either engine captures it, then all visible dates/headlines translate and inactive text stays withheld.
- Given a tab transition, when source state changes, then the typed batch is accepted and replica state updates inline without actions.
- Given an enabled carousel image, when its slide settles, then visual and provisional ALT appear without transform-only provider reruns.
- Given `controlImages` disabled, when the same page replicates, then its passive visual remains but ALT/OCR is unread.
- Given hidden, malformed, rotated, perspective, unsafe-resource, or secret fixtures, when captured, then each fails closed at its boundary.
- Given completion, when full checks and trial-artifact verification run, then all pass with the new beta identity.

## Spec Change Log

- 2026-07-24: Implemented both-engine selected-tab admission and inline tab state; inert Passive image resources and omission telemetry; safe carousel settle/rebinding and clone reuse; beta `.9` metadata, documentation, regression coverage, and synchronized four-provider trial artifact.
- 2026-07-24: Patched independent review findings: isolated replica/semantic/image bridge versions; hardened passive base/srcset handling; added transition, shadow-root, overlap, crop, cache-clear, rerank, and navigation boundaries; replaced periodic image rescans with bounded shadow-host discovery.

## Verification

**Commands:**
- `npm run check` -- typecheck, tests, production build, and artifact validation pass.
- `npm run artifact:sync:ocr-trials` -- reloadable build exactly matches the four-provider trial.
- `git diff --check` -- clean diff; branch guards remain executable.

**Implementation evidence:**
- `npm run typecheck` -- passed.
- Combined post-review Vitest suite -- 23 files, 529 tests passed.
- `npm run artifact:sync:ocr-trials` -- synchronized `dist/chrome-unpacked`.
- `npm run artifact:check:ocr-trials` -- exact four-provider artifact passed; manifest reports `0.3.2 beta v.20260724.9`.
- `npm run check` -- 83 files and 1,227 tests passed, followed by exact artifact verification.
- `git diff --check` -- passed after review.

**Manual checks:**
- Reload the beta; verify active news rows and settled hero banners show translated content.
- Switch tabs/slides and engines; verify cache reuse, no source action, and no periodic recalculation.

## Suggested Review Order

**Read-safe controlled content**

- Start here: one bounded policy admits only uniquely proven, painted selected tabs.
  [`source-privacy-policy.ts:131`](../../lib/replica/source-privacy-policy.ts#L131)

- rrweb reuses that policy and coalesces post-transition admission refreshes.
  [`live-recorder-session.ts:1021`](../../lib/replica/live-recorder-session.ts#L1021)

- HTML mirroring applies the same policy before serializing or patching source content.
  [`html-mirror-source.ts:303`](../../lib/replica/html-mirror-source.ts#L303)

- Typed inline tab proofs carry state without inventing popup behavior.
  [`semantic-source-protocol.ts:149`](../../lib/replica/semantic-source-protocol.ts#L149)

- Receiver projects tab state onto exact mirrored nodes without enabling actions.
  [`semantic-source-receiver.ts:529`](../../lib/replica/semantic-source-receiver.ts#L529)

**Passive visual fidelity**

- Version-three wire isolation prevents stale extension bridges accepting the expanded schema.
  [`contracts.ts:1`](../../lib/replica/contracts.ts#L1)

- First valid authored base resolves passive images without ever replaying base.
  [`protocol-v2.ts:598`](../../lib/replica/protocol-v2.ts#L598)

- Passive image URLs and srcsets are revalidated on both transport boundaries.
  [`protocol-v2.ts:1094`](../../lib/replica/protocol-v2.ts#L1094)

- Incremental rrweb mutations retain only inert, sanitized paint resources.
  [`rrweb-stream-sanitizer.ts:241`](../../lib/replica/rrweb-stream-sanitizer.ts#L241)

**OCR correctness and reuse**

- One observer unifies privacy-first discovery, currentness, priority, and bounded shadow coverage.
  [`source-image-observer.ts:190`](../../lib/ocr/source-image-observer.ts#L190)

- Rotating host checks find late open roots without periodic image recalculation.
  [`source-image-observer.ts:636`](../../lib/ocr/source-image-observer.ts#L636)

- Image sessions refresh shared tab policy before reading ALT text or pixels.
  [`image-source-session.ts:420`](../../lib/ocr/image-source-session.ts#L420)

- Retained evidence reranks immediately, reprocessing only missing or expired providers.
  [`image-translation-controller.ts:3163`](../../lib/ocr/image-translation-controller.ts#L3163)

- Clearing translation memory releases old in-flight keys without permitting stale refill.
  [`translation-memory.ts:149`](../../lib/translation/translation-memory.ts#L149)

- Navigation fan-out stays scoped to the current opaque tab/document identity.
  [`navigation-refresh-gate.ts:6`](../../lib/navigation-refresh-gate.ts#L6)

**Runtime controls and trial identity**

- Runtime read-scope changes intersect safety ceilings and rebuild without restart.
  [`main.ts:1414`](../../entrypoints/sidepanel/main.ts#L1414)

- Build identity makes the reloadable trial unmistakable in Chrome.
  [`wxt.config.ts:12`](../../wxt.config.ts#L12)

**Regression boundaries**

- Both-engine tests cover tab state, style settling, and unrelated carousel churn.
  [`page-recorder.test.ts:251`](../../tests/page-recorder.test.ts#L251)

- Observer tests cover shadows, invalidation, bounded work, and idle-timer performance.
  [`source-image-observer.test.ts:1377`](../../tests/source-image-observer.test.ts#L1377)

- Protocol tests lock v3 isolation, inert resources, base resolution, and srcset validation.
  [`replica-protocol.test.ts:30`](../../tests/replica-protocol.test.ts#L30)

- Artifact tests enforce the exact licensed four-provider local trial.
  [`extension-artifact.test.mjs:57`](../../tests/extension-artifact.test.mjs#L57)
