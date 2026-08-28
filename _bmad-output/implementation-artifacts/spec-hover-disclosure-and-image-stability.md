---
title: 'Hover Disclosure and Image Analysis Stability'
type: 'bugfix'
created: '2026-07-25'
status: 'done'
review_loop_iteration: 0
baseline_commit: '266a7af6ab2ac78415203f1d690e3ffbe8124ac7'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-progressive-cached-image-translation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Common non-ARIA menus, including Y Combinator's desktop menu, contain safe text but remain unusable because site hover code never runs in the inert replica and visibility-only mutations do not rematerialize hidden text. A rotating image can also revoke one Auto-language vote, clear every overlay, rebuild the image queue, and repeat ranking despite cached provider results.

**Approach:** Add a strict typed structural-menu path shared by both engines, with extension-owned hover/focus/keyboard presentation and no source action. Separate image content/pixel evidence, language aggregation, final selection/translation, and projection geometry so only changed dependencies recompute.

## Boundaries & Constraints

**Always:** Infer structural menus only from bounded, unambiguous, same-root public navigation with a visible activation sibling, one non-empty collapsed safe panel, and no editable or secret descendants. Receiver-revalidate relationships, respect `disclosureContent`, preserve the authored trigger, and keep submenu actions inert. Reconcile real hidden/painted boundaries without rereading ordinary class churn. Keep image evidence memory-only, bounded, TTL-limited, same-top-origin, generation-fenced, and subject to existing purges. Retain provider evidence plus the winner, translated regions, and intrinsic projection blueprint. Stay on `feat/replica-read-scope-redesign`; do not commit, merge, or push; retain Git guards; advance the beta and synchronize `dist/chrome-unpacked`.

**Ask First:** Persistent or cross-origin caches, new permissions/host matches, remote code/services, executing page scripts, or relaxing an existing secret-classification floor.

**Never:** Add site/class-name rules; forward replica events to the source; admit empty/ambiguous panels; expose disclosure text when disabled; treat geometry as changed pixels; or restart all OCR for one replaceable language sample.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Structural menu | Visible trigger plus one safe collapsed sibling | Hover/focus opens translated items; trigger-to-panel travel stays open; leave/Escape/outside closes | Ambiguous, empty, unsafe, or oversized candidates stay withheld |
| Visibility transition | Class/style/hidden/ARIA crosses a computed visibility boundary | Coalesce one bounded rematerialization in both engines | Ordinary class churn does nothing |
| Rotating hero | One sample changes; remaining votes sustain the language | Recompute only that sample/image; unrelated work continues | Insufficient or contradictory votes may reopen bounded detection |
| Geometry-only change | Same pixels move, resize, clip, or change visibility | Retain analysis and rebind after geometry validation | Unsafe geometry pauses only that image |
| Language change | Aggregate resolves differently | Re-evaluate winners while reusing compatible caches | Reject stale old-pair completions |

</frozen-after-approval>

## Code Map

- `lib/replica/semantic-source-{protocol,session,receiver}.ts` -- structural proof, source inference, receiver validation, hidden text.
- `lib/replica/semantic-proof-presenter.ts`, `lib/replica/read-only-disclosure.ts` -- shared inert hover/focus presentation.
- `lib/replica/html-mirror-source.ts`, `lib/replica/live-recorder-session.ts` -- visibility-boundary reconciliation.
- `lib/ocr/image-translation-controller.ts`, `lib/ocr/auto-language-probe.ts` -- sample-local language and final-result retention.
- `lib/ocr/source-image-observer.ts`, `lib/ocr/image-scan-scheduler.ts` -- scoped safety refresh and starvation prevention.
- Tests, metadata, README, and `dist/chrome-unpacked` -- regressions and beta artifact.

## Tasks & Acceptance

**Execution:**
- [x] Add and receiver-validate generic structural-menu proofs; admit safe text under `disclosureContent` in both engines.
- [x] Unify read-only presentation with hover/focus retention, closing, scrolling, and action blocking while preserving the trigger.
- [x] Reconcile only true visibility transitions, including ancestors and CSS-only hover/focus, with coalesced rrweb work.
- [x] Recompute Auto language from remaining samples; retain content/final analysis across observation revisions; invalidate changed pixels per image.
- [x] Add final-result reuse, starvation protection, diagnostics, adversarial tests, beta `.12`, and the unpacked artifact.

**Acceptance Criteria:**
- A YC-shaped fixture exposes the same translated submenu in both engines on local hover/focus; item activation cannot act.
- Unrelated styling or continuous hero rotation causes zero provider/translation/ranking calls for unchanged images, and background work progresses.
- Real pixel change reprocesses only that image; geometry-only change only rebinds.
- Secrets, malformed relationships, disabled reading, purge boundaries, and stale work remain fail-closed.

## Spec Change Log

## Design Notes

Content, pixels, evidence policy, ranking policy, translation pair, and geometry are separate dependencies. A final-result hit requires current source/pixel/policy validation and never bypasses privacy.

## Verification

**Commands:**
- Focused Vitest suites for disclosures, both engines, Auto probe, controller, observer, and scheduler -- all pass.
- `npm run check` -- typecheck, full tests, build, and artifact validation pass.
- `npm run artifact:sync:ocr-trials && npm run artifact:check:ocr-trials` -- unpacked build is exactly `0.3.2 beta v.20260725.12` with all licensed trial providers.
- `git diff --check` and hook probes -- clean diff; protected commits and all pushes remain blocked.

## Suggested Review Order

**Image stability and cache reuse**

- Start with dependency-local invalidation, Auto-vote revocation, and retained OCR rebasing.
  [`image-translation-controller.ts:1180`](../../lib/ocr/image-translation-controller.ts#L1180)

- Separate semantic routing changes from source pixels, capture geometry, and observation state.
  [`source-image-observer.ts:720`](../../lib/ocr/source-image-observer.ts#L720)

- Keep capture identity stable when only semantic image content changes.
  [`source-image-model.ts:121`](../../lib/ocr/source-image-model.ts#L121)

- Reuse translated winners across same-origin pages with bounded memory and TTL.
  [`image-translation-controller.ts:3785`](../../lib/ocr/image-translation-controller.ts#L3785)

- Preserve later-provider fallback when a cached candidate cannot produce an overlay.
  [`image-translation-controller.ts:4208`](../../lib/ocr/image-translation-controller.ts#L4208)

- Let newly visible images preempt near/background OCR without displacing manual work.
  [`image-scan-scheduler.ts:665`](../../lib/ocr/image-scan-scheduler.ts#L665)

**Inert structural menus**

- Infer only bounded, painted, nonempty trigger-and-panel navigation structures.
  [`semantic-source-session.ts:1158`](../../lib/replica/semantic-source-session.ts#L1158)

- Revalidate structural relationships and panel safety inside the replica document.
  [`semantic-source-receiver.ts:580`](../../lib/replica/semantic-source-receiver.ts#L580)

- Install one shared extension-owned disclosure controller in either replica engine.
  [`semantic-proof-presenter.ts:429`](../../lib/replica/semantic-proof-presenter.ts#L429)

- Keep hover, focus, keyboard traversal, scrolling, and Escape local and actionless.
  [`read-only-disclosure.ts:191`](../../lib/replica/read-only-disclosure.ts#L191)

**Visibility and recovery boundaries**

- Track the same painted path used by controlled-content privacy admission.
  [`source-visibility-boundary.ts:26`](../../lib/replica/source-visibility-boundary.ts#L26)

- Recover the isolated HTML mirror immediately after a bounded visibility overflow.
  [`html-mirror-source.ts:1169`](../../lib/replica/html-mirror-source.ts#L1169)

- Coalesce rrweb visibility/style changes while failing closed on incomplete indexing.
  [`live-recorder-session.ts:1022`](../../lib/replica/live-recorder-session.ts#L1022)

**Regression anchors and build identity**

- Verify ALT-only changes reuse OCR while reranking the fresh semantic label.
  [`image-translation-controller.test.ts:3440`](../../tests/image-translation-controller.test.ts#L3440)

- Verify unpainted ancestors and oversized panel text cannot create structural proofs.
  [`semantic-source-session.test.ts:688`](../../tests/semantic-source-session.test.ts#L688)

- Verify keyboard traversal remains available while activation stays blocked.
  [`read-only-disclosure.test.ts:207`](../../tests/read-only-disclosure.test.ts#L207)

- Identify the exact unpacked test build in Chrome.
  [`wxt.config.ts:12`](../../wxt.config.ts#L12)
