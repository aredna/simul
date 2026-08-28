---
title: 'Fresh public testing build identity'
type: 'chore'
created: '2026-08-28T13:35:00+09:00'
status: 'done'
review_loop_iteration: 0
baseline_commit: '9698946ed896a0628bcff7de56771614e2c24d68'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The public GitHub branch still points to the July release-candidate commit, while the completed local public-release cleanup retains numeric version 0.3.2 and shortens its visible build name to generic `beta`. A tester therefore cannot reliably distinguish the current artifact from the older July build.

**Approach:** Publish one unmistakable successor identity: numeric version `0.3.3` with visible build name `0.3.3 beta v.20260828.1`. Update its documentation and assertions, regenerate the guarded unpacked artifact, verify the declared Node/npm release gate, and push the fast-forwarded local `main` to `origin/main`.

## Boundaries & Constraints

**Always:** Keep runtime behavior, extension permissions, dependencies, license terms, Chrome 138 minimum, and artifact contents unchanged except for mechanically generated identity/hash differences. Generate `dist/chrome-unpacked/` only through `npm run artifact:sync`. Make the Options label, Chrome manifest, README, package metadata, and release tests agree exactly. Fetch and confirm the remote remains an ancestor before pushing `main`.

**Ask First:** Choosing any identity other than `0.3.3 beta v.20260828.1`, creating or moving a Git tag, creating a GitHub Release, or resolving unexpected remote divergence.

**Never:** Hand-edit generated artifact files, force-push, rewrite history, change runtime scope, or claim the old installed directory updates without a pull and Chrome reload.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh GitHub checkout | Tester pulls updated `main` | Package and artifact report `0.3.3`; visible label reports `Build 0.3.3 beta v.20260828.1` | Artifact validation rejects any identity or byte drift |
| Existing unpacked install | Chrome still holds the July artifact | Pull, extension-card Reload, source-tab reload, and companion reopen expose the new build label | README states every required reload step |
| Remote changed | `origin/main` no longer matches the fetched July ancestor | Do not overwrite or force-push | Stop and report the divergence for human resolution |

</frozen-after-approval>

## Code Map

- `package.json`, `package-lock.json` -- canonical numeric version and its derived lockfile copy.
- `wxt.config.ts`, `lib/build-identity.ts` -- generated `version_name` and its runtime-visible consumer.
- `README.md`, `THIRD_PARTY_NOTICES.md` -- tester instructions and release inventory identity.
- `tests/build-identity.test.ts`, `tests/extension-artifact.test.mjs` -- visible-label and generated-manifest assertions.
- `tools/extension-artifact.mjs`, `dist/chrome-unpacked/` -- guarded sync, validation, and checked-in install directory.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `package-lock.json`, `wxt.config.ts` -- set numeric `0.3.3` and build suffix `beta v.20260828.1` consistently.
- [x] `README.md`, `THIRD_PARTY_NOTICES.md` -- publish exact tester-facing labels and the numeric notice inventory release.
- [x] `tests/build-identity.test.ts`, `tests/extension-artifact.test.mjs` -- pin numeric and visible identities.
- [x] `dist/chrome-unpacked/` -- regenerate through the guarded artifact sync and confirm the manifest and rendered label.
- [x] Local Git -- run the release gate, commit through the feature branch, and fast-forward `main`.
- [x] Push safety -- verify the fetched `origin/main` remains an ancestor without force or history rewriting.
- [x] Publication -- push reviewed `main` to `origin/main` only after the workflow marks the spec done.

**Acceptance Criteria:**
- Given the updated GitHub `main`, when a tester pulls and reloads the same unpacked directory, then Chrome and Simul display `0.3.3 beta v.20260828.1` rather than an ambiguous 0.3.2/July identity.
- Given a checkout with `npm ci` complete, when `npm run check` executes under Node 24/npm 12, then all retained tests and the byte-exact artifact gate pass.
- Given unchanged remote ancestry, when the release commit is pushed, then `origin/main` advances normally to the reviewed local tip with no tag or rewritten history.

## Spec Change Log

- 2026-08-29: Adversarial review added generic `version_name` correlation
  validation and exact Chrome-card versus Options labels, corrected metadata
  ownership and verification wording, separated publication state, and
  deferred automated sequence advancement. The exact approved identity,
  guarded artifact sync, unchanged runtime boundary, and fast-forward-only push
  remain preserved.

## Verification

**Commands:**
- `node --version && corepack npm --version` -- expected: Node 24 and npm 12.
- `corepack npm run check` -- typecheck, 1,143 retained tests, production build, artifact validation, and byte comparison pass.
- `git diff --check` -- no whitespace errors.
- `git fetch origin main && git merge-base --is-ancestor origin/main main` -- the final push is fast-forward safe.

**Publication after review:**
- `git push origin main` -- GitHub receives the reviewed public testing build.

**Manual checks:**
- In Chrome 138+, reload the same `dist/chrome-unpacked/` installation, reload the source tab, reopen Simul, and confirm `Build 0.3.3 beta v.20260828.1` in Options.

## Suggested Review Order

**Release identity**

- Build configuration composes the approved sequence with the canonical numeric version.
  [`wxt.config.ts:12`](../../wxt.config.ts#L12)

- Package metadata advances Chrome's sortable release version.
  [`package.json:3`](../../package.json#L3)

- The committed manifest proves the ready-to-load artifact carries both identities.
  [`manifest.json:1`](../../dist/chrome-unpacked/manifest.json#L1)

**Artifact safety**

- Validation now correlates every visible name with its exact numeric version.
  [`extension-artifact.mjs:728`](../../tools/extension-artifact.mjs#L728)

- Identity failures cover missing, blank, and mismatched build names.
  [`extension-artifact.test.mjs:72`](../../tests/extension-artifact.test.mjs#L72)

**Tester and release guidance**

- Reload instructions distinguish Chrome's numeric card from Simul's full label.
  [`README.md:27`](../../README.md#L27)

- Legal inventory follows the numeric release without changing dependency terms.
  [`THIRD_PARTY_NOTICES.md:9`](../../THIRD_PARTY_NOTICES.md#L9)

- Deferred automation records the remaining manual build-sequence decision.
  [`deferred-work.md:149`](deferred-work.md#L149)
