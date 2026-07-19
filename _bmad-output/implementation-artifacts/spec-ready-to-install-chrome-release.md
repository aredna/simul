---
title: 'Ready-to-install Chrome release'
type: 'feature'
created: '2026-07-19T16:15:34+09:00'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'c3e9b8a12eab681f11176b3a2976902c2be0c3ce'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A fresh repository download contains source code but no installable extension, and the README asks users to install Node, build the project, and read internal BMAD learning material. That prevents a product user from installing Simul directly in Chrome.

**Approach:** Check in a verified production build at `dist/chrome-unpacked/` and rewrite the README around product installation and use. A user should only download/extract the repository, open Chrome's extensions page, enable Developer mode, choose **Load unpacked**, and select that directory; Node and npm remain contributor-only tools.

## Boundaries & Constraints

**Always:** Keep `manifest.json` at the install directory root and commit every referenced asset. Build the artifact deterministically from current source, validate MV3, Chrome 138+, exactly `activeTab`/`scripting`/`sidePanel`, and no host permissions. Provide an explicit sync command plus a non-mutating check that builds in a temporary directory and compares complete paths and bytes. Reject symlinks, source maps, secrets, keys, and environment files. Make `npm run check` fail with actionable differences when the committed artifact is absent, stale, incomplete, or unsafe. Keep the README product-first and free of BMAD, learning-method, and workflow instructions.

**Ask First:** Chrome Web Store publication, CRX signing, GitHub Release automation, permission/version changes, deleting internal agent or BMAD project files, or changing the extension's runtime behavior.

**Never:** Require Node, npm, WXT, or a build command for installation. Do not make `.output/`, ZIP, CRX, or a hosted download the canonical local artifact. Do not embed credentials, remote executable code, source maps, or private configuration. Do not claim one-click or automatic updates: normal local installation still uses Chrome Developer mode and **Load unpacked**.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh download | Repository without `node_modules` or `.output` | `dist/chrome-unpacked/` loads directly in Chrome and includes the complete MVP | README gives only Chrome installation steps |
| Current artifact | Temporary production build equals committed release | Artifact check exits successfully without changing tracked files | N/A |
| Stale artifact | Any missing, unexpected, or byte-different file | Check fails and lists differences | Instruct contributor to run the explicit sync command |
| Unsafe output | Symlink, map, key, environment file, invalid manifest, or excess permission | Sync/check rejects the build before publishing it | Existing committed artifact is not silently replaced |
| Artifact refresh | Contributor intentionally runs sync | Only the guarded release directory is replaced with the validated build | Temporary files are cleaned and unrelated paths remain untouched |

</frozen-after-approval>

## Code Map

- `README.md` -- Public product, no-build installation, use, limitations, and optional contributor guidance.
- `dist/chrome-unpacked/` -- Checked-in directory selected by Chrome's **Load unpacked** dialog.
- `tools/extension-artifact.mjs` -- Temporary build, validation, comparison, and guarded synchronization.
- `tests/extension-artifact.test.mjs` -- Artifact validator/comparator boundary coverage.
- `package.json` -- Product metadata and artifact sync/check commands.
- `.gitignore` -- Ignore transient outputs while explicitly tracking the canonical release.
- `.github/workflows/ci.yml` -- Verify and upload the committed installable directory.
- `docs/translation-companion.md`, `_bmad-output/project-context.md` -- Align durable install and repository conventions.

## Tasks & Acceptance

**Execution:**
- [x] `README.md`, `package.json` -- remove public BMAD/learning language, lead with no-build Chrome installation, and use product metadata.
- [x] `tools/extension-artifact.mjs`, `tests/extension-artifact.test.mjs` -- implement and test deterministic temporary builds, strict validation, byte comparison, cleanup, and exact-path sync guards.
- [x] `package.json`, `package-lock.json` -- add `artifact:sync`/`artifact:check` and make the standard quality gate verify the committed production artifact.
- [x] `.gitignore`, `dist/chrome-unpacked/` -- track only the canonical unpacked release and generate it from current source.
- [x] `.github/workflows/ci.yml`, `docs/translation-companion.md`, `_bmad-output/project-context.md` -- verify/upload the ready artifact and document its maintenance boundary.

**Acceptance Criteria:**
- Given a fresh extracted repository, when a Chrome 138+ user selects `dist/chrome-unpacked` through **Load unpacked**, then Simul installs without Node, npm, or a build step.
- Given the README, when a product user follows it, then installation and first use appear before contributor information and no BMAD or learning-workflow language appears.
- Given unchanged source and release files, when `npm run check` runs, then typecheck, tests, a temporary production build, security validation, and byte comparison pass without modifying the artifact.
- Given source/artifact drift or unsafe output, when artifact verification runs, then it fails with actionable diagnostics and does not mutate the committed release.
- Given an intentional artifact sync, when it succeeds, then only `dist/chrome-unpacked/` is atomically refreshed and its manifest retains the approved permission boundary.

## Spec Change Log

## Design Notes

Chrome cannot directly install a repository ZIP or unsigned CRX on standard macOS/Windows Chrome. A visible unpacked directory is therefore the fewest honest local steps; Chrome Web Store publication can later replace Developer mode with one-click installation and automatic updates. Directory comparison ignores timestamps and modes but compares every relative path and byte, avoiding nondeterministic ZIP metadata and stale content-hashed assets.

## Verification

**Commands:**
- `npm run artifact:sync` -- intentionally refreshes only the validated canonical artifact.
- `npm run check` -- typecheck, tests, temporary production build, validation, and exact artifact comparison pass.
- `git diff --check` -- no whitespace errors.

**Manual checks:**
- From a fresh repository download without dependencies, load `dist/chrome-unpacked/` in Chrome 138+, open Simul on an HTTP(S) page, and confirm the popup, side panel, and Japanese↔English translation flow.

## Suggested Review Order

**No-build installation**

- Start with the exact product-user installation path and zero-build promise.
  [`README.md:7`](../../README.md#L7)

- Confirm Chrome receives a complete MV3 manifest with the approved permission boundary.
  [`dist/manifest.json:1`](../../dist/chrome-unpacked/manifest.json#L1)

**Release integrity**

- Inspect the validator that certifies every file before comparison or publication.
  [`extension-artifact.mjs:95`](../../tools/extension-artifact.mjs#L95)

- Follow the non-mutating temporary build and byte-for-byte drift check.
  [`extension-artifact.mjs:190`](../../tools/extension-artifact.mjs#L190)

- Review guarded synchronization and rollback around the sole canonical target.
  [`extension-artifact.mjs:247`](../../tools/extension-artifact.mjs#L247)

- Examine semantic HTML resource discovery added during adversarial hardening.
  [`extension-artifact.mjs:567`](../../tools/extension-artifact.mjs#L567)

**Automated proof**

- See validation coverage for manifests, resources, secrets, and unsafe artifacts.
  [`extension-artifact.test.mjs:35`](../../tests/extension-artifact.test.mjs#L35)

- See orchestration coverage for drift, non-mutation, rollback, and cleanup failures.
  [`extension-artifact.test.mjs:200`](../../tests/extension-artifact.test.mjs#L200)

- Confirm contributor commands make release verification part of the standard gate.
  [`package.json:15`](../../package.json#L15)

- Confirm CI verifies and publishes only the certified unpacked directory.
  [`ci.yml:36`](../../.github/workflows/ci.yml#L36)

**Repository conventions**

- Verify ignore rules expose only the canonical generated release under `dist`.
  [`.gitignore:9`](../../.gitignore#L9)

- Read the durable release-maintenance boundary and manual verification guidance.
  [`translation-companion.md:110`](../../docs/translation-companion.md#L110)
