---
title: 'Secure, selectable readable replica'
type: 'feature'
created: '2026-07-23'
status: 'done'
review_loop_iteration: 1
baseline_commit: '74d9ae7'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-simul-2026-07-23/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The replica blocks useful visible control/image content too broadly, while OCR can hallucinate text, accessible image labels are ignored, rrweb and Integrated diverge, settings cannot express selective privacy choices, and testing lacks a complete reset.

**Approach:** Separate runtime-selectable reading from a permanently inert action shell; add source-classified readable-content controls, a prioritized accessibility-text image method, unified inert disclosures, first-load setup, and a revision-safe reset, then ship a locally identifiable unpacked beta on the feature branch.

## Boundaries & Constraints

**Always:** Keep the replica unable to execute site code, navigate, submit, download, or forward events. Classify before reading and permanently exclude password/text-security fields, hidden/file inputs, password/authentication/OTP/WebAuthn autocomplete, and every `cc-*` autocomplete class; secret classification stays sticky. Keep source-derived content memory-only and diagnostics content-free. Apply committed setting changes while running; narrowing purges old content before broader work can survive. Preserve rrweb input/contenteditable masking and use shared bounded semantic/image channels for optional evidence. Keep all providers/assets local and Chrome Web Store/license compatible.

**Ask First:** Any new permission, dependency, remotely supplied runtime/model, weakening of the credential floor/action firewall, or scope beyond ordinary visible page/control/image fidelity.

**Never:** Add hostname-specific behavior, read or infer password length, treat semantic text as OCR confidence, inject source text as HTML, edit `dist/chrome-unpacked` manually, push, merge, or change `main`/origin.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First setup | Missing/outdated setup | Page-only is effective; Standard is only a suggestion | No new semantic read or permission request before commit |
| Live profile change | Standard ↔ Full visible/custom | All open panels converge and recapture under one new policy epoch | Stale commands/results are rejected; narrowing remains at safe intersection if save fails |
| Credential mutation | Password/OTP/card field later becomes ordinary text | It remains redacted and overlapping image evidence stays blocked | Unknown value-bearing controls are withheld |
| Image method order | Accessibility text interleaved with OCR providers | Methods run in exact enabled order; pixels are acquired only when OCR is reached | Empty/blocked/provider failure falls through without leaking text in diagnostics |
| NTA navigation GIF | Direct `alt`/`aria-label` inside validated disclosure control | Label translates and overlays even when small-image OCR skipping is enabled | Decorative/hidden/zero-area/secret evidence is rejected |
| Reset race | Multiple panels, work and permission flow active | Defaults/setup-zero commit first; work/caches clear; undesired optional origins are reconciled | Stale writers fail; pending cleanup resumes after worker restart |

</frozen-after-approval>

## Code Map

- `lib/preferences.ts`, `lib/preference-coordinator.ts` -- scope/method/setup/reset schema, commands, migration, locking, permission reconciliation.
- `lib/replica/source-privacy-policy.ts` and new policy/classifier modules -- pre-access classification, profiles, sticky secret floor.
- `lib/replica/{html-mirror-source,page-recorder,live-recorder-session}.ts` plus strict protocols -- engine-neutral policy identity and bounded semantic supplements while rrweb stays masked.
- `lib/replica/{html-mirror-sanitizer,isolated-html-engine,rrweb-shadow-engine}.ts` -- receiver validation, optional semantic injection, inert viewport-safe controls/disclosures.
- `lib/ocr/{known-provider-ids,image-source-protocol,image-source-session,source-image-observer}.ts` -- unified image methods and explicit direct-image accessibility evidence.
- `lib/ocr/{image-translation-controller,image-analysis-coordinator,image-overlay-projector}.ts` -- lazy ordered planning, OCR grouping, semantic provenance/projection.
- `entrypoints/{background,sidepanel/main}.ts`, `entrypoints/sidepanel/style.css` -- live setup/options, reset dialog, convergence/purge, diagnostics, beta identity.
- `tests/`, `tools/extension-artifact.mjs`, `dist/chrome-unpacked/` -- security/runtime/UI regression and guarded artifact sync.

## Tasks & Acceptance

**Execution:**
- [x] `lib/preferences.ts`, new read-policy/classifier modules, and tests -- implement fail-closed six-toggle presets, method-order migration, exact allowlists, setup/reset revisions, and sticky credential admission.
- [x] source/receiver replica protocols and engines -- bind bridge/document/node/policy identities, keep optional records out of base streams, apply bounded semantic supplements, and unify inert select/disclosure presentation.
- [x] image source/planner/projector and tests -- add reorderable `accessibility-text`, alt/ARIA mutation currency, control-image gating, lazy capture, fallthrough, whole-image overlay, and content-free diagnostics.
- [x] coordinator/background/runtime tests -- serialize live commits, two-phase narrowing, stale-write rejection, resumable reset, optional-origin reconciliation, transient-store clearing, and offscreen shutdown.
- [x] sidepanel UI/style/tests -- expose Page-only/Standard/Full-visible/Custom with six live toggles, all image methods in priority order, OCR-only confidence copy, first-load setup, accessible reset confirmation, and cleanup status.
- [x] docs/build artifact -- document privacy limits, advance to `0.3.2 beta v.20260723.4`, run all checks, and regenerate the canonical unpacked directory only through artifact tooling.

**Acceptance Criteria:**
- Given any profile and hostile source markup, when a replica/image/semantic message is produced or consumed, then no credential secret or website action capability crosses the boundary and all stale/forged payloads fail closed.
- Given either rrweb or Integrated, when the same supported read scope and image methods are selected, then visible non-secret semantic/image results follow the same policy and rrweb base masking remains enabled.
- Given settings changed during active work or reset from any panel, when convergence completes, then every open panel shows only content allowed by the newest committed revision and no prior cache/projection can reappear.
- Given the supplied NTA page and GIF, when accessibility-text is enabled ahead of OCR, then the navigation label translates without pixel capture; when disabled/reordered, exact fallback order is observable without diagnostic content leakage.
- Given the completed branch, when validation and artifact comparison run, then `npm run check` passes, `dist/chrome-unpacked` is byte-identical to the validated beta build, and main/origin remain untouched.

## Spec Change Log

- 2026-07-23: Implemented the approved replica read-scope, image-reading,
  security, reset, and interaction redesign on the local feature branch.
- 2026-07-23: Adversarial review added document-lifetime secret tracking for
  slotted, moved, detached, CSS-masked, and between-session source nodes.
- 2026-07-23: OCR acceptance review added Integrated bridge and live
  accessibility-label mutation coverage; no provider blocker remained.

## Design Notes

Read policy is an evidence-admission contract, not a renderer mode. Base replica streams remain conservative; optional source evidence is admitted before access, transported with bridge-scoped identity and bounded proof, revalidated, translated, and injected into an actionless facsimile. Accessibility text is a semantic image-reading method with no OCR confidence or pixel permission.

## Verification

**Commands:**
- Focused privacy review -- 7 suites and 178 credential/protocol tests passed.
- Focused OCR acceptance review -- Integrated bridge and mutation suites passed; no provider blocker remained.
- `npm run check` -- typecheck, 79 files/1,048 tests, and exact artifact comparison passed.
- `npm run artifact:sync:ocr-trials` -- guarded four-provider beta `.4` was synchronized and validated.
- `git diff --check && git status --short --branch && git log --oneline --decorate -3` -- clean branch-only handoff with no push/merge.

**Manual checks (if no CLI):**
- Reload `dist/chrome-unpacked`; confirm beta `.4`, first-load/profile/reset flows, live provider/profile swapping, NTA alt overlay, dropdown viewport behavior, and password/OTP/card redaction in both engines.

## Suggested Review Order

**Read boundary and immutable security floor**

- Start with the six-capability policy, presets, intersections, and setup fail-closed behavior.
  [`read-scope-policy.ts:6`](../../lib/replica/read-scope-policy.ts#L6)

- Sticky document-scoped classification makes credential decisions irreversible.
  [`source-secret-classifier.ts:155`](../../lib/replica/source-secret-classifier.ts#L155)

- Initial traversal primes every secret descendant identity without reading content.
  [`semantic-source-session.ts:1125`](../../lib/replica/semantic-source-session.ts#L1125)

- Mutation history handles transient masks, removals, moves, and bounded failure.
  [`semantic-source-session.ts:1177`](../../lib/replica/semantic-source-session.ts#L1177)

- Integrated keeps the shared classifier active before and between Port connections.
  [`html-mirror-source.ts:131`](../../lib/replica/html-mirror-source.ts#L131)

**Unified readable replica**

- One semantic source session emits policy-bound typed evidence for both engines.
  [`semantic-source-session.ts:155`](../../lib/replica/semantic-source-session.ts#L155)

- One presenter applies translated controls and disclosures to either replay engine.
  [`semantic-proof-presenter.ts:21`](../../lib/replica/semantic-proof-presenter.ts#L21)

- Viewport-bound replica disclosures remain useful while permanently actionless.
  [`read-only-disclosure.ts:161`](../../lib/replica/read-only-disclosure.ts#L161)

**Image-reading pipeline**

- Exact enabled priority becomes lazy semantic steps and adjacent OCR groups.
  [`image-reading-methods.ts:134`](../../lib/ocr/image-reading-methods.ts#L134)

- Controller execution separates accessibility evidence, pixel OCR, and auto-language provenance.
  [`image-translation-controller.ts:939`](../../lib/ocr/image-translation-controller.ts#L939)

- Runtime UI exposes method ordering, toggles, status, and OCR-only confidence.
  [`main.ts:4384`](../../entrypoints/sidepanel/main.ts#L4384)

**Runtime convergence and reset**

- Serialized commands enforce revisions, first setup, safe narrowing, and reset durability.
  [`preference-coordinator.ts:149`](../../lib/preference-coordinator.ts#L149)

- The safety journal reconciles every live panel and fails closed after restart.
  [`preference-safety-coordinator.ts:104`](../../lib/preference-safety-coordinator.ts#L104)

- Side-panel commits purge before narrowing and expose complete runtime reset.
  [`main.ts:1383`](../../entrypoints/sidepanel/main.ts#L1383)

**Regression and artifact gates**

- Integrated connection gaps and moved secrets are locked by executable regressions.
  [`html-mirror-source.test.ts:102`](../../tests/html-mirror-source.test.ts#L102)

- The supplied small Japanese GIF path is covered without pixel capture.
  [`image-translation-controller.test.ts:346`](../../tests/image-translation-controller.test.ts#L346)

- Canonical sync validates exactly four local providers, assets, licenses, and CSP.
  [`extension-artifact.mjs:830`](../../tools/extension-artifact.mjs#L830)
