---
title: 'Preserve Constructable Stylesheets in Isolated HTML'
type: 'bugfix'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 1
baseline_commit: '654d8e9d8ce50d096599052bd17a6f7ae5ac7797'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Modern Reddit and other Web Component sites lose major formatting in Isolated HTML because Simul mirrors open shadow-root nodes but omits the document and shadow roots' constructable `adoptedStyleSheets`. Old Reddit works because its ordinary linked stylesheets already pass through the mirror.

**Approach:** Extend the bounded isolated-HTML graph/checkpoint to carry ordered, sanitized adopted stylesheet text, reconstruct it as Simul-owned inert `<style>` elements, and use the existing bounded shadow-discovery timer to request a recovery checkpoint when CSSOM-only changes are detected.

## Boundaries & Constraints

**Always:** Apply the existing CSS URL/import/script sanitization; capture only readable sheets adopted by the top document or accessible open shadow roots; preserve per-root sheet order and cascade precedence; include styles in transport size/count limits and dual validation; keep polling bounded and diagnostics content-free.

**Ask First:** Changes to private-control masking, closed shadow-root access, strict-local-mirror networking, iframe CSP, permissions, host matches, or the 8 MiB checkpoint ceiling.

**Never:** Add a Reddit hostname exception; fetch a stylesheet separately; execute page JavaScript/custom-element code in the replica; transport raw inaccessible sheets; weaken sandboxing or private-value masking; change `<template>` handling in this slice.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Initial modern component | Document or nested open root adopts readable sheets | Sanitized sheets appear after ordinary style children in original adopted order | Unreadable sheets are omitted without losing the DOM |
| Unsafe CSS | Sheet contains imports, unsafe schemes, or active CSS | Imports are removed and unsafe URLs/rules cannot cross the boundary | Malformed/oversized transported style data is rejected |
| CSSOM-only update | `replaceSync`, `insertRule`, or adopted-sheet assignment changes content/order | Bounded reconciliation detects a signature change and requests one recovery checkpoint | Last-good replica remains visible until atomic replacement |
| Repeated shared sheet | Many component roots adopt the same sheet | Capture remains within existing global limits and never loops or executes code | Over-limit style payloads fail closed without unbounded work |

</frozen-after-approval>

## Code Map

- `lib/replica/html-mirror-sanitizer.ts` -- graph types, source CSS extraction, transport revalidation, and limits.
- `lib/replica/html-mirror-protocol.ts` -- checkpoint schema, byte accounting, and exact-key validation.
- `lib/replica/html-mirror-source.ts` -- checkpoint production and bounded shadow/CSSOM reconciliation.
- `lib/replica/isolated-html-engine.ts` -- inert document/open-shadow reconstruction and atomic recovery.
- `tests/html-mirror-protocol.test.ts` -- sanitizer and hostile transport coverage.
- `tests/html-mirror-source.test.ts` -- CSSOM-change recovery behavior.
- `tests/isolated-html-engine.test.ts` -- cascade-order reconstruction behavior.

## Tasks & Acceptance

**Execution:**
- [x] `lib/replica/html-mirror-sanitizer.ts` -- represent, extract, sanitize, bound, and revalidate document/open-root adopted styles.
- [x] `lib/replica/html-mirror-protocol.ts` -- transport document styles and include all style data in canonical byte validation.
- [x] `lib/replica/html-mirror-source.ts` -- checkpoint styles and detect bounded document/open-root stylesheet signature changes through recovery.
- [x] `lib/replica/isolated-html-engine.ts` -- reconstruct ordered inert styles after ordinary root children without polluting source node IDs/text records.
- [x] `tests/html-mirror-protocol.test.ts`, `tests/html-mirror-source.test.ts`, `tests/isolated-html-engine.test.ts` -- cover nested roots, hostile CSS, order, limits, and CSSOM recovery.
- [x] `dist/chrome-unpacked/` -- synchronize the verified ready-to-load extension.

**Acceptance Criteria:**
- Given a Lit-style open shadow root with `:host` rules in adopted sheets, when Isolated HTML commits, then the reconstructed root contains the same ordered sanitized rules and layout selectors can apply.
- Given document-level adopted styles, when the checkpoint crosses the transport boundary, then their content is validated and counted exactly once in the declared byte length.
- Given adopted stylesheet content or order changes without a DOM mutation, when the bounded reconciliation pass reaches that owner, then Simul emits one recoverable gap and replaces the replica from a fresh checkpoint.
- Given rrweb or legacy is selected, when pages are captured, then their behavior is unchanged.

## Spec Change Log

- 2026-07-21: Implemented bounded document/open-shadow adopted stylesheet capture, canonical transport validation, inert reconstruction, CSSOM recovery detection, regression coverage, and artifact synchronization.
- 2026-07-21: Review iteration 1 preserved stylesheet media conditions and meaningful CSS escapes, then added shared patch budgets plus dual per-owner/global sheet and conservative rule-block validation. Both review findings were rechecked as resolved.

## Verification

**Commands:**
- `npx vitest run tests/html-mirror-protocol.test.ts tests/html-mirror-source.test.ts tests/isolated-html-engine.test.ts` -- expected: adopted-style boundary and recovery tests pass.
- `npm run check` -- expected: typecheck, full tests, and artifact integrity pass.
- `npm run artifact:sync && npm run artifact:check` -- expected: installable artifact matches verified source.

**Results:**
- Focused mirror suite: 4 files, 33 tests passed.
- Full `npm run check`: typecheck passed, 49 files / 485 tests passed, artifact integrity passed.
- Installable artifact: synchronized at `dist/chrome-unpacked` (39.23 MB).

## Suggested Review Order

**Capture and trust boundary**

- Captures ordered readable document/open-shadow sheets with bounded CSSOM work and media preservation.
  [`html-mirror-sanitizer.ts:194`](../../lib/replica/html-mirror-sanitizer.ts#L194)

- Revalidates per-owner/global stylesheet, character, rule-block, byte, node, and identity limits.
  [`html-mirror-sanitizer.ts:754`](../../lib/replica/html-mirror-sanitizer.ts#L754)

- Uses one graph budget across every node in a transported patch.
  [`html-mirror-protocol.ts:317`](../../lib/replica/html-mirror-protocol.ts#L317)

**Live fidelity and reconstruction**

- Detects CSSOM-only document/open-shadow changes through bounded recovery polling.
  [`html-mirror-source.ts:674`](../../lib/replica/html-mirror-source.ts#L674)

- Reconstructs adopted rules as inert, source-ID-free styles after ordinary root children.
  [`isolated-html-engine.ts:815`](../../lib/replica/isolated-html-engine.ts#L815)

**Regression coverage**

- Covers nested roots, shared/media sheets, hostile CSS, inaccessible sheets, and aggregate limits.
  [`html-mirror-protocol.test.ts:160`](../../tests/html-mirror-protocol.test.ts#L160)

- Covers CSSOM-only recovery and retained last-good behavior.
  [`html-mirror-source.test.ts:218`](../../tests/html-mirror-source.test.ts#L218)

- Covers document/shadow ordering across live children patches.
  [`isolated-html-engine.test.ts:268`](../../tests/isolated-html-engine.test.ts#L268)
