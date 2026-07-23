---
title: 'Identify the OCR trial beta build'
type: 'chore'
created: '2026-07-23'
status: 'done'
review_loop_iteration: 0
baseline_commit: '06cc38dcce7d04139593634b366b4b7bceb63367'
context:
  - '_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every unpacked OCR trial currently presents only the package version `0.3.2`, so Chrome, Simul's Options screen, and startup logs cannot distinguish the newest local artifact from an earlier build with the same release version.

**Approach:** Keep Chrome's numeric update version at `0.3.2`, add the human-readable manifest identity `0.3.2 beta v.20260723.1`, and make the existing build indicator and readiness logs use that same runtime-manifest identity. Rebuild the exact four-provider OCR trial into the existing `dist/chrome-unpacked` directory.

## Boundaries & Constraints

**Always:** Derive the numeric prefix from WXT's generated manifest rather than duplicating the package version; use Manifest V3 `version_name` for the beta suffix; retain a safe numeric-version fallback when `version_name` is missing or blank; keep the label deterministic; cover both preferred and fallback paths; leave the final ready-to-load artifact as the validated four-provider OCR trial.

**Ask First:** Any need to change the release/package version, rename the extension, alter permissions, change provider selection or ordering, or replace a different install directory.

**Never:** Push, merge to `main`, modify `main`, add remote code or services, infer identity from build time at runtime, or change OCR/replica behavior as part of this task.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Current beta | Manifest has `version: 0.3.2` and `version_name: 0.3.2 beta v.20260723.1` | Options and both readiness logs identify `Build 0.3.2 beta v.20260723.1` | N/A |
| Compatibility fallback | Manifest omits `version_name`, or it is empty/whitespace | Options and logs identify `Build 0.3.2` | Ignore the unusable display value without failing startup |

</frozen-after-approval>

## Code Map

- `wxt.config.ts` -- generates the Chrome manifest and is the authoritative beta-label insertion point.
- `lib/build-identity.ts` -- creates the shared identity consumed by both browser entrypoints.
- `tests/build-identity.test.ts` -- covers display-name preference and numeric fallback behavior.
- `tests/extension-artifact.test.mjs` -- verifies the fresh Chrome artifact retains numeric `version` and exact beta `version_name`.
- `README.md` -- tells testers where to confirm the loaded beta identity before manual testing.
- `dist/chrome-unpacked/` -- canonical unpacked artifact to replace with the validated OCR trial build.

## Tasks & Acceptance

**Execution:**
- [x] `wxt.config.ts` -- attach the dated beta suffix to the generated manifest version name -- make Chrome's installed-extension identity unambiguous without changing update semantics.
- [x] `lib/build-identity.ts` and `tests/build-identity.test.ts` -- prefer a trimmed manifest version name and test its fallback -- keep Options and console evidence reliable across runtime-manifest variants.
- [x] `tests/extension-artifact.test.mjs` -- assert both numeric and human-readable identities in a fresh build -- prevent a build pipeline regression from silently removing the marker.
- [x] `README.md` -- add concise reload/identity guidance -- let a tester verify the correct unpacked artifact before evaluating websites.
- [x] `dist/chrome-unpacked/` -- regenerate production for the standard release gate, then restore and validate the exact four-provider trial -- leave the requested folder immediately reloadable.

**Acceptance Criteria:**
- Given a freshly built artifact, when its manifest is inspected, then `version` is `0.3.2` and `version_name` is `0.3.2 beta v.20260723.1`.
- Given that artifact is loaded or reloaded, when the tester opens Simul Options, then the visible build marker reads `Build 0.3.2 beta v.20260723.1`.
- Given either browser entrypoint starts, when its ready message is logged, then the message contains the same full build marker.
- Given the final `dist/chrome-unpacked`, when the all-provider trial validator runs, then it contains exactly the approved ordered four-provider profile and passes its artifact limits and security checks.
- Given repository state after completion, when branches and remotes are inspected, then all changes exist only on `feat/ocr-reliability-trials` and nothing was pushed or merged.

## Spec Change Log

## Verification

**Commands:**
- `npm run test -- tests/build-identity.test.ts tests/extension-artifact.test.mjs` -- expected: identity unit and fresh-build assertions pass.
- `npm run check` -- expected: typecheck, full tests, and canonical production-artifact validation pass.
- `npm run artifact:sync:ocr-trials && npm run check:ocr-all-trial` -- expected: `dist/chrome-unpacked` is the validated exact four-provider OCR trial.
- `git status --short --branch && git log -1 --oneline` -- expected: the local OCR trial branch contains the committed change with no push or merge.

## Suggested Review Order

**Manifest identity**

- Derives the beta display identity from Chrome's numeric update version.
  [`wxt.config.ts:151`](../../wxt.config.ts#L151)

- Confirms the reloadable trial contains both numeric and human-readable versions.
  [`manifest.json:1`](../../dist/chrome-unpacked/manifest.json#L1)

**Runtime evidence**

- Prefers Chrome's trimmed display version while preserving a numeric fallback.
  [`build-identity.ts:8`](../../lib/build-identity.ts#L8)

**Tester handoff**

- Gives the exact two identities testers should verify before evaluating sites.
  [`README.md:84`](../../README.md#L84)

**Regression coverage**

- Covers the beta identity in visible UI and both readiness logs.
  [`build-identity.test.ts:9`](../../tests/build-identity.test.ts#L9)

- Exercises missing, empty, and whitespace-only display-version fallbacks.
  [`build-identity.test.ts:29`](../../tests/build-identity.test.ts#L29)

- Requires the exact beta identity from a fresh WXT artifact.
  [`extension-artifact.test.mjs:626`](../../tests/extension-artifact.test.mjs#L626)
