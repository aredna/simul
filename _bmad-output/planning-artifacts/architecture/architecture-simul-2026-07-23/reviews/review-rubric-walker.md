# Rubric-walker review

## Gate verdict

**Revise before handoff.** The spine has a strong action/read separation and covers most of the requested feature surface, but five high-severity seams still permit incompatible or unsafe implementations: source-contract reconciliation, the semantic-channel trust proof, exact policy/classifier behavior, runtime migration/convergence, and accessibility evidence for control images.

The deterministic spine linter passes with zero findings. Stack versions also match `package.json` (Node/npm ranges and pinned WXT, TypeScript, Vitest, rrweb, Tesseract, PaddleOCR, and ONNX packages). The findings below are semantic rather than mechanical.

## Critical findings

None.

## High findings

### H1 — The spine neither resolves nor traceably supersedes its canonical privacy source

- **Checklist impact:** brownfield ratification; spec coverage; traceability.
- **Evidence:** The `sources` entries for the passive-fidelity SPEC and architecture point under `_bmad-output/implementation-artifacts/spec-passive-replica-fidelity/`, but the canonical files actually live under `_bmad-output/specs/spec-passive-replica-fidelity/`. The canonical SPEC still says that password/**private-field transport** remains blocked under every policy, while AD-3 and AD-5 intentionally admit selectable current form, personal, and editable content. `_bmad-output/project-context.md` also still records stricter rrweb/private behavior. The user's newer direction can renegotiate that contract, but the spine currently looks like an accidental contradiction rather than an explicit replacement.
- **Risk:** Downstream units can legitimately follow either the old canonical contract or this spine and produce mutually incompatible privacy behavior and tests.
- **Disposition:** **Autofix.** Correct both source paths; add an explicit `supersedes`/reconciliation note that identifies the exact prior private-field constraint being replaced while preserving the hard credential and action constraints; update the canonical project/spec companion before implementation handoff.

### H2 — AD-11 requires receiver-side reclassification from proof that cannot contain the facts AD-4/AD-5 require

- **Checklist impact:** enforceability; incompatible-unit prevention; protocol boundary.
- **Evidence:** AD-11 says the receiver reconstructs a record's category from canonical tag/type/autocomplete/role/ancestry proof. AD-4 additionally permits computed `text-security`, identifier/label heuristics, CAPTCHA context, and sticky prior classification; AD-5 permits broader personal-data “semantics.” AD-4 simultaneously says those classifier inputs are not transported. Therefore the receiver cannot independently reach the same classification required by AD-11. The new semantic channel is also called “typed, bounded” without binding exact record-count, string, batch-byte, mutation-rate, or overflow/recovery budgets.
- **Risk:** One unit trusts a source-supplied category, another rejects valid records, and a third quietly transports extra classifier metadata. This is the feature's most sensitive cross-boundary seam and can also become an unbounded live-content channel.
- **Disposition:** **Discuss, then autofix.** Choose one coherent trust contract: either (a) define a minimal, exact, content-safe `ClassificationProof` sufficient for a deterministic shared classifier at both ends, including sticky-state proof, or (b) explicitly make source-side admission authoritative within the exact extension session and make receiver checks structural/allowlist-only. Add concrete budgets and overflow behavior, preferably by naming existing protocol constants where they apply.

### H3 — The read-scope profiles and source classifiers are not closed enough to be enforceable

- **Checklist impact:** real divergence points; enforceable rules; security boundary.
- **Evidence:** AD-3 names six booleans but gives no exact Boolean mapping for `Page only`; Standard and Full visible are described only in prose. AD-4 relies on undefined “tokens,” “known CAPTCHA/security-challenge contexts,” and “bounded source-local password/OTP heuristics.” AD-5 ends the personal-data taxonomy with “other non-secret personal data.” AD-2 says classification happens before accessibility strings are accessed, while AD-4 allows label metadata as classifier input, leaving it unclear which label-like attributes may be read before classification. The Deferred section acknowledges imperfect custom-widget detection but does not freeze the permitted heuristic inputs or failure category.
- **Risk:** Implementations can disagree on the same field, and a security-sensitive heuristic can either over-read label content or under-block credentials. Profile migrations and UI summaries also cannot be tested against one canonical matrix.
- **Disposition:** **Autofix.** Add a profile matrix covering all six booleans; define an exhaustive category enum and deterministic classifier decision table (native type, exact autocomplete tokens, role, computed style, ancestry, and permitted metadata names but not their value-bearing strings); define exact sticky-state and unknown handling. Move non-deterministic/custom CAPTCHA heuristics to a separately named conservative rule with bounded inputs and explicit false-positive behavior.

### H4 — Upgrade/setup and multi-panel tightening semantics are incomplete

- **Checklist impact:** brownfield migration; runtime operations; lifecycle consistency.
- **Evidence:** AD-16 says missing/outdated setup shows Standard preselected but does not say which effective scope runs before completion or whether capture is paused. Current brownfield behavior already transports some ordinary values, so a modal alone is not a safe migration rule. The new `ImageReadingMethodId` also lacks an exact migration from existing provider order/disabled lists. AD-6 promises that a narrowing purges synchronously *before* persistence, but AD-14 distributes state to other open panels only through command/storage convergence after commit; no pre-commit cross-panel barrier exists. The state diagram has no narrowing commit-failure path.
- **Risk:** Existing installs, fresh installs, two open panels, and a failed save can each retain different readable content or different method order. A privacy tightening can remain visible in another panel despite the stated invariant.
- **Disposition:** **Autofix.** Decide the pre-setup effective policy (safest: close all configurable gates and pause affected capture until setup commits), specify one-time preference migrations including insertion of `accessibility-text`, and define multi-panel narrowing semantics honestly. Either add a coordinated purge/ack barrier or weaken “synchronously before persistence” to an enforceable initiator/committed-event contract with epoch rejection and a conservative failure state.

### H5 — AD-7's `control-only` rejection conflicts with the feature's control-image path

- **Checklist impact:** requested capability coverage; internal consistency.
- **Evidence:** AD-7 rejects “control-only” accessibility candidates, but AD-3/AD-10 add a selectable `controlImages` admission gate and AD-12 is specifically intended to recover navigation images carrying disclosure roles. The motivating NTA GIFs are image labels inside navigation/disclosure controls. `control-only` is not defined, and a reasonable implementation would reject exactly the alt-text fallback this redesign is meant to add.
- **Risk:** Accessibility text works for ordinary images but still fails the user's principal button/navigation-image examples, while different adapters interpret the undefined exclusion differently.
- **Disposition:** **Autofix.** Remove the blanket exclusion. Admit image-owned `aria-label`/`alt` when `controlImages` and the hard-secret floor allow it. Define duplicate-label suppression as a projection/rendering decision (or exact semantic-equivalence rule), not a source-read privacy category.

## Medium findings

### M1 — Disclosure admission is not sufficiently bounded or visibility-defined

- **Evidence:** AD-5 admits content behind a “validated visible disclosure/menu relationship,” while AD-12 remaps relationships and AD-13 presents lists. The spine does not define whether collapsed/hidden source descendants may be read, how one target is chosen, maximum target depth/items/text, or what happens when relationships mutate or become ambiguous.
- **Risk:** A disclosure implementation can expose arbitrary hidden DOM or diverge between rrweb and Integrated.
- **Disposition:** **Autofix.** Reuse the existing unique same-document relation model, and specify source visibility, uniqueness, item/depth/byte budgets, mutation revision, and fail-closed ambiguity behavior.

### M2 — The operational/build envelope requested by the user is absent

- **Evidence:** The feature-altitude spine has no rollout/environment decision for the explicitly required branch-only trial, no-push/no-merge constraint, beta identity, `dist/chrome-unpacked` synchronization, or exact artifact/security gates.
- **Risk:** A correct implementation can still violate the delivery boundary or leave the user testing an older unpacked build.
- **Disposition:** **Autofix.** Add a small deployment/verification rule: branch-only local commit, no main/origin mutation, next beta identity, artifact sync/check, `npm run check`, and loaded-build identity verification.

### M3 — Reset cleanup ownership is named but not connected to concrete brownfield stores/leases

- **Evidence:** AD-15 says to clear a “transient OCR object store,” caches, diagnostics, replicas, and the offscreen document, but Structural Seed does not identify one reset-purge protocol/owner across multiple panels and the offscreen host. It also does not define whether optional non-host permissions, if introduced later, are in or outside “all settings.”
- **Risk:** Implementers can clear only the initiating panel or delete the wrong storage surface; tests cannot enumerate authoritative cleanup acknowledgements.
- **Disposition:** **Autofix.** Define a versioned purge broadcast/ack contract and enumerate current storage/cache/lease owners by existing module/API. Explicitly constrain permission reset to extension-owned optional host origins unless a later schema adds other permission classes.

### M4 — Accessibility evidence selection lacks deterministic duplicate/currentness semantics

- **Evidence:** AD-7 prioritizes direct `aria-label` over `alt`, while AD-9 keys freshness to an “evidence identity,” but neither decides whether equal text already represented by an adjacent/ancestor accessible control label should overlay, nor defines the evidence identity without logging or retaining content. Direct attributes can mutate independently and language can come from an ancestor.
- **Risk:** Double text overlays, stale language, or incompatible hash/string identity choices.
- **Disposition:** **Autofix.** Define the exact identity tuple (for example revision + selected attribute kind + memory-only digest), include relevant ancestor-language mutation invalidation, and specify a conservative exact duplicate suppression rule if desired.

## Low findings

### L1 — `companions: []` understates the deliverable set

The architecture already implies classifier/profile tables, protocol schemas, and acceptance/security matrices. If these are created as separate artifacts, list them as companions so downstream implementation receives the closed contract. **Disposition: autofix when those artifacts exist.**

### L2 — Environment support is implicit

The spine names Chrome Manifest V3 but does not state the tested Chrome/macOS floor or how unavailable providers such as Chrome `TextDetector` remain selectable-but-unavailable without breaking fallback. Existing provider architecture likely covers this, but a one-line compatibility rule would remove ambiguity. **Disposition: defer to implementation acceptance or add to the operational rule.**

## Checklist summary

| Good-spine criterion | Result |
| --- | --- |
| Fixes real divergence points | Partial — strong coverage, but profiles/classification/channel proof remain open |
| Every AD enforceable and preventive | No — AD-4, AD-5, AD-7, and AD-11 need closure |
| Deferred cannot cause unit divergence | Partial — custom-widget heuristic inputs are still implementation-defined |
| Named technology verified current | Pass against committed package metadata |
| Ratifies brownfield | Partial — most safety mechanics are preserved, but canonical source conflict is unresolved |
| Covers driving specs/capabilities | Partial — feature goals covered; canonical privacy and delivery constraints are not reconciled |
| Inherited spine consistency | Not applicable; no parent spine declared |
| Owned dimensions decided/deferred/open | Partial — deployment/migration and cross-panel operational semantics are incomplete |

## Positive observations

- AD-1 cleanly makes action capability non-configurable and independent of read scope.
- AD-6's epoch/currentness model, AD-8's lazy pixel acquisition, and AD-17's memory-only rule are the right high-level boundaries.
- Treating accessibility text as semantic provenance rather than fake OCR confidence is a sound divergence-prevention decision.
- The reset ordering (safe preferences first, permissions cleanup second) is fail-safe.
- The structural seed maps the major brownfield seams without proposing new permissions, remote code, or cloud OCR.

---

## Addendum — revised-spine critical/high recheck

**Verdict: materially improved, but not yet clear for implementation handoff. No critical findings remain; three high-severity rule ambiguities and one high-severity reconciliation precondition remain.** H2's trust-model contradiction and H5's blanket control-image rejection are resolved. The setup/multi-panel transition is also now coherent.

### AH1 — Canonical-source reconciliation remains an unmet handoff precondition

The source paths and supersession scope are now correct, but the canonical SPEC and project context still contain the blanket private-field rule that the spine says must be reconciled before implementation. This is no longer an architecture ambiguity; it remains a **high pre-handoff condition**. Reconcile those two artifacts or mark an exact companion amendment before implementation begins.

### AH2 — Malformed read policy repairs to a broader profile despite the fail-closed claim

AD-2 still repairs unknown or malformed policy input to Standard, which enables three capabilities. That can broaden a corrupt or partially written Page-only/Custom scope and conflicts with AD-2's fail-closed title plus AD-14/AD-16's safe Page-only setup behavior. **High.** Command-boundary input should reject; storage-boundary invalid/missing scope should become effective Page-only and require setup/migration repair. Standard may remain only the uncommitted UI suggestion.

### AH3 — The classifier/channel contract still delegates security-relevant allowlists and limits

AD-5 refers to “allowlisted” native controls, autocomplete classes, and editor-like ARIA text without enumerating them or binding a companion table. AD-11 refers to “existing” string/byte/node/batch limits even though the two engines have separate protocol constants. This leaves the shared source and receiver implementations free to disagree on admission and capacity. **High.** Bind an exhaustive classifier matrix (including select/textarea/current-state handling) and one canonical semantic-channel limit set, or name a required companion that freezes both before coding.

### AH4 — `controlImages` is scoped inconsistently

AD-7 correctly makes `controlImages` the exception for images inside navigation/disclosure controls, but AD-10 says to apply the `controlImages` gate generally at every evidence/pixel read. A literal AD-10 implementation disables OCR/alt for ordinary images whenever that control-specific capability is off. **High.** State that `controlImages` is consulted only when a candidate is within non-secret activation/control ancestry; ordinary images remain governed by image-translation enablement, method order, and the hard-secret floor.

---

## Addendum — final critical/high recheck

**Verdict: pass. No unresolved critical or high findings.**

The canonical SPEC, architecture companion, and project context now explicitly reconcile the narrowed private-field rule while preserving credential and action guarantees. AD-2 repairs malformed scope to Page-only. AD-3, AD-5, and AD-11 now close the preset, classifier, bridge-identity, and channel-capacity seams with deterministic rules. AD-3 and AD-7 unambiguously limit `controlImages` to non-secret control ancestry while leaving ordinary images governed by image translation and method settings. Earlier H1–H5 and AH1–AH4 are therefore resolved at critical/high severity; any remaining review tail is medium or lower and does not block architecture handoff.
