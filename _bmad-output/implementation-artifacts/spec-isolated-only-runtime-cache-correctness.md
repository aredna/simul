---
title: 'Isolated-only runtime and cache correctness'
type: 'refactor'
created: '2026-07-26'
baseline_commit: '266a7af6ab2ac78415203f1d690e3ffbe8124ac7'
status: 'done'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-isolated-engine-performance-cleanup.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-progressive-cached-image-translation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Simul still executes a complete custom snapshot/live-delta renderer before its authoritative Isolated HTML engine, while Auto-to-explicit language changes with the same resolved source discard reusable image work and can cancel translation. Image-derived Auto evidence also has invalidation and quorum-reuse gaps, and cache clears can undercount provider work that is still running.

**Approach:** Make Isolated HTML the only replica runtime, carry source scroll through its existing typed transport, and delete the custom snapshot/delta/visual path. Normalize cache and task identity around the effective source language, make image-language invalidation explicit, preserve true quorum semantics, and keep real in-flight work bounded across retention clears.

## Boundaries & Constraints

**Always:** Stay on `feat/replica-read-scope-redesign`; preserve the last-good isolated replica during recoverable replacement failures, source-scroll following, exact-document/replay currentness, fail-closed secret/control handling, inert presentation, memory-only evidence, current permissions, current OCR providers, and locally packaged executable code. Use repository scripts for generated artifacts and retain relevant isolated/privacy/OCR tests.

**Ask First:** New permissions or host matches, changing OCR providers or trial profiles, weakening any privacy/currentness proof, removing scroll synchronization, staging or committing files, or expanding beyond the reviewed findings.

**Never:** Switch or merge to `main`, push/fetch/contact a remote, bypass hooks, persist source-derived content, add site-specific rules, hand-edit generated BMAD files or `dist/chrome-unpacked`, or delete unrelated tests merely to lower line count.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Initial capture | Accessible top-frame document | One exact-document isolated checkpoint becomes visible; no legacy snapshot or intermediate mirror renders | Preserve a prior committed replica when possible; otherwise show a retryable local error |
| Source scrolling | Document or qualified nested scroller moves | One animation-frame-coalesced typed update repositions the isolated replica | Invalid or stale identities are ignored without changing presentation |
| Same effective language | Auto resolved `ja` changes to explicit `ja`, or back | Existing page translation, image projection, final analysis, pixels, OCR, and translated evidence remain current | Reset only Auto-probe mode state; do not abort same-pair work |
| Auto contributor changes | Image-derived language contributor changes or disappears | Revalidate current-document evidence and replace or clear the promoted language | Never continue new work from a revoked contributor |
| Origin evidence reuse | Prior resolution required two distinct images | One matching cached image restores one vote, not the completed quorum | Require current distinct contributors before promotion |
| Retention clear | Translation/OCR provider work is unsettled | Entries and joins clear, but real active work still consumes the concurrency bound | Stale completions cannot refill cleared retention |

</frozen-after-approval>

## Code Map

- `entrypoints/sidepanel/main.ts` -- isolated bootstrap, language/task lifecycle, and removal of legacy state/branches.
- `lib/replica/{html-mirror-*,isolated-html-engine,visible-replay-host}.ts` -- sole replica stream, scroll transport, and last-good presentation.
- `lib/{page-snapshot,live-page-mirror,visual-renderer}.ts`, legacy entrypoints/adapters -- deletion targets after isolated replacements exist.
- `lib/ocr/image-translation-controller.ts` -- effective-language identity, Auto invalidation, quorum-safe evidence.
- `lib/{translation/translation-memory,ocr/image-analysis-coordinator}.ts` -- active-work accounting across clears.
- `tools/`, `wxt.config.ts`, `tests/`, durable docs -- reproducible guards, deterministic Chrome fixture, artifact truth, and regressions.

## Tasks & Acceptance

**Execution:**
- [x] `entrypoints/sidepanel/main.ts`, replica host/controller, legacy modules -- collapse capture, translation, recovery, layout, and readiness onto the isolated snapshot/document contract; delete obsolete renderer code.
- [x] `lib/replica/html-mirror-{protocol,source,client}.ts`, isolated engine -- add bounded scroll delivery to the existing exact-document stream before deleting the live observer.
- [x] `lib/language-detection.ts`, sidepanel language helpers, image controller -- canonicalize effective-pair transitions and implement revocable image-derived Auto state with quorum-safe origin reuse.
- [x] `lib/translation/translation-memory.ts`, `lib/ocr/image-analysis-coordinator.ts` -- count unsettled provider loads independently from generation-scoped join maps.
- [x] `tools/git-hooks/`, hook installer, Chrome disclosure fixture, build/artifact checks and docs -- make local safeguards reproducible and verification stable without overwriting existing hooks.
- [x] `tests/` -- replace legacy-only coverage with focused isolated-scroll, cache-transition, invalidation, quorum, task-lifecycle, and clear-capacity regressions.

**Acceptance Criteria:**
- Given a production build, when its entrypoints and artifact are inspected, then only the isolated page-mirror replica transport exists and no snapshot/live-delta/legacy engine bundle or runtime branch remains.
- Given an unchanged effective language pair, when Auto and its explicit language are toggled in either direction during or after translation, then no current task is cancelled and no unchanged image stage reruns.
- Given changed Auto contributors or same-origin cached weak evidence, when language promotion is evaluated, then only current-document evidence satisfying the original threshold can select the source language.
- Given cache clears with pending loads, when new work arrives, then actual provider concurrency remains within its configured maximum and stale work cannot repopulate retention.
- Given absent, managed, or unrelated active Git hooks, when the tracked installer runs, then it installs idempotently or fails without overwriting; protected-branch commits and every push remain locally rejected.
- Given the completed tree, when focused tests, repeated Chrome disclosure coverage, `npm run check`, a repository-script artifact sync, and `git diff --check` run, then they pass; authored runtime LOC decreases materially and the initial sidepanel chunk remains below 500 KiB.

## Spec Change Log

- 2026-07-26: Implemented the isolated-only runtime, effective-language and Auto-evidence correctness, active-load accounting, reproducible hooks, deterministic Chrome coverage, and obsolete-stack deletion.
- 2026-07-26: Adversarial review fixed pre-observer scroll overflow, same-language Auto revalidation settlement, and paused-source reconnection; thirteen validated earlier issues were recorded in `deferred-work.md`.

## Design Notes

The status/loading surface may remain as extension UI, but it must never hold a second page renderer. Historical completed specs remain provenance; this spec supersedes only their formerly approval-gated legacy-fallback requirement.

## Verification

**Commands:**
- `npm test -- tests/image-translation-controller.test.ts tests/translation-memory.test.ts tests/offscreen-ocr.test.ts tests/html-mirror-protocol.test.ts tests/html-mirror-source.test.ts tests/isolated-html-engine.test.ts tests/visible-replay-host.test.ts` -- focused lifecycle, privacy, cache, and scroll regressions pass.
- `npm test -- tests/isolated-disclosure-chrome.test.ts --repeat=5` -- Chrome fixture is repeatable, or an equivalent repository-supported repeat loop passes five runs.
- `npm run artifact:sync:ocr-trials && npm run check && git diff --check` -- synchronized local artifact and complete gate pass.

**Results:**
- `npm run check` passes: TypeScript, 74 test files / 1,104 tests, and exact four-provider artifact verification.
- `npm run test:chrome-disclosure:repeat` passes across five fresh Chrome profiles; hook tests pass 5/5 and the installed guards remain unchanged.
- Authored runtime is 55,835 lines versus 62,516 at the baseline commit, a net reduction of 6,681 lines; tests contain 43,894 lines.
- The synchronized artifact contains only `page-mirror.js` for replica transport. Its initial side-panel chunk is 430,449 bytes.
- OCR imports/assets occupy 72,368,325 of 73,219,677 artifact bytes (98.8%); the non-OCR extension shell is 851,352 bytes.
- The branch remains `feat/replica-read-scope-redesign`, the index is clean, no remote operation occurred, and `git diff --check` passes.

## Suggested Review Order

**Isolated-only runtime ownership**

- Start here: one engine, surface router, scroll callback, and image controller wiring.
  [`main.ts:391`](../../entrypoints/sidepanel/main.ts#L391)

- Exact-document capture now commits isolated HTML without an intermediate renderer.
  [`main.ts:1940`](../../entrypoints/sidepanel/main.ts#L1940)

- One bounded rebuild preserves last-good content without switching engines.
  [`replica-recovery.ts:13`](../../lib/replica/replica-recovery.ts#L13)

- Presentation clearing owns only isolated candidates and committed frames.
  [`visible-replay-host.ts:360`](../../lib/replica/visible-replay-host.ts#L360)

**Typed source-scroll transport**

- The protocol validates scroll identity, target, bounds, and normalized geometry.
  [`html-mirror-protocol.ts:393`](../../lib/replica/html-mirror-protocol.ts#L393)

- The source coalesces document and qualified nested-scroll sampling per frame.
  [`html-mirror-source.ts:1178`](../../lib/replica/html-mirror-source.ts#L1178)

- Pre-observer scroll bursts retain only the latest update, preserving structural capacity.
  [`html-mirror-client.ts:317`](../../lib/replica/html-mirror-client.ts#L317)

- The engine forwards only current-document scroll into presentation.
  [`isolated-html-engine.ts:717`](../../lib/replica/isolated-html-engine.ts#L717)

- Replay projects source progress independently from fit and custom zoom.
  [`visible-replay-host.ts:202`](../../lib/replica/visible-replay-host.ts#L202)

**Effective language and reusable image work**

- Side-panel provenance accepts and revokes only exact-document image language evidence.
  [`main.ts:483`](../../entrypoints/sidepanel/main.ts#L483)

- Effective pair and source-evidence identities drive configuration transitions.
  [`image-translation-controller.ts:708`](../../lib/ocr/image-translation-controller.ts#L708)

- Paused source failures retire dead transport for deterministic later reconnect.
  [`image-translation-controller.ts:1156`](../../lib/ocr/image-translation-controller.ts#L1156)

- OCR Auto resolution exits early only after a real pair-epoch transition.
  [`image-translation-controller.ts:2892`](../../lib/ocr/image-translation-controller.ts#L2892)

- Cached distinct-image evidence restores one vote, while strong evidence restores immediately.
  [`image-translation-controller.ts:3465`](../../lib/ocr/image-translation-controller.ts#L3465)

- Semantic Auto revalidation likewise continues projection when the pair stays unchanged.
  [`image-translation-controller.ts:4605`](../../lib/ocr/image-translation-controller.ts#L4605)

**Bounded provider work**

- Translation capacity counts unsettled provider loads independently from cleared join keys.
  [`translation-memory.ts:196`](../../lib/translation/translation-memory.ts#L196)

- Recognition capacity uses the same active-load invariant across retention clears.
  [`image-analysis-coordinator.ts:296`](../../lib/ocr/image-analysis-coordinator.ts#L296)

**Build and local workflow guards**

- Production entrypoints include only the isolated page-mirror transport.
  [`wxt.config.ts:30`](../../wxt.config.ts#L30)

- Artifact validation requires page-mirror and rejects retired bundle names.
  [`extension-artifact.mjs:42`](../../tools/extension-artifact.mjs#L42)

- Hook installation is idempotent and refuses unrelated active-hook conflicts.
  [`install.mjs:86`](../../tools/git-hooks/install.mjs#L86)

**Regression evidence**

- Scroll bursts and structural overflow receive separate fail-closed coverage.
  [`html-mirror-client.test.ts:84`](../../tests/html-mirror-client.test.ts#L84)

- Same-effective Auto toggles preserve active and settled image work.
  [`image-translation-controller.test.ts:7170`](../../tests/image-translation-controller.test.ts#L7170)

- Current-document quorum restoration cannot promote one cached weak contributor.
  [`image-translation-controller.test.ts:7902`](../../tests/image-translation-controller.test.ts#L7902)

- Cache clears retain real provider capacity until unsettled work finishes.
  [`translation-memory.test.ts:190`](../../tests/translation-memory.test.ts#L190)

- Chrome disclosure runs in five independent fresh profiles.
  [`isolated-disclosure-chrome.test.ts:110`](../../tests/isolated-disclosure-chrome.test.ts#L110)

- Hook behavior covers absent, managed, conflicting, and custom-path installations.
  [`git-hooks.test.ts:57`](../../tests/git-hooks.test.ts#L57)
