---
title: 'Public GitHub release readiness'
type: 'chore'
created: '2026-08-28T12:41:21+09:00'
status: 'in-progress'
review_loop_iteration: 0
baseline_commit: 'c4f747cdbdc71dd17cd14a9e0412579042355dca'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The checked-in Chrome artifact and public documentation still describe a hackathon-era four-provider OCR trial. They are larger and more complex than the normal release profile, retain trial-only dependencies and disclosures, and do not give a concise current explanation of how Simul works.

**Approach:** Promote the normal production profile as the sole ready-to-load artifact, remove obsolete OCR A/B trial and OpenAI Build Week material from the current tree, retain MIT for original Simul work with complete dependency notices, and rewrite the README around installation, operation, privacy, limitations, and contribution.

## Boundaries & Constraints

**Always:** Preserve the current isolated-HTML runtime behavior, Chrome 138 minimum, optional OCR default-off behavior, existing privacy/sandbox controls, and least-privilege permission boundary. Keep accessibility image text, platform Chrome TextDetector fallback, packaged Tesseract.js/core 7.0.0, the pinned 22-file language catalog, and their required MIT/Apache/ISC/BSD notices. Treat MIT as the license for original Simul material only; third-party components retain their own terms. Generate `dist/chrome-unpacked/` only through the guarded normal-profile sync and make `npm run check` verify that exact artifact. Preserve historical Git references without carrying hackathon disclosures in the current public tree.

**Ask First:** Changing runtime behavior beyond removing trial-only providers, changing extension permissions/host matches, changing the numeric release version, removing production OCR languages, publishing or pushing to a remote, or selecting a license other than MIT.

**Never:** Delete substantive production tests, remove required copyright/license/NOTICE material, rewrite Git history, claim legal advice or absolute compliance, retain remote executable code, package PaddleOCR/direct Tesseract-Wasm trial assets in the public artifact, or claim Chrome Web Store/automatic-update availability.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Chrome reload | Current repository checkout | `dist/chrome-unpacked/` loads directly and identifies version 0.3.2 beta | Artifact validation blocks missing, stale, oversized, or unsafe output |
| Image text | OCR enabled | Accessibility text runs first; available Chrome TextDetector or local Tesseract.js handles pixels | Unavailable platform OCR falls through without remote calls |
| License review | Public source and unpacked artifact | Root MIT covers original Simul; dependency-specific texts/notices accompany redistributed components | Verification rejects notice or artifact drift |
| Historical disclosure | Current public tree | Hackathon-specific README/docs/spec material is absent; history remains intact | Non-hackathon OpenAI.com compatibility records are not misclassified |

</frozen-after-approval>

## Code Map

- `package.json`, `package-lock.json`, `tools/ocr-build-profile.ts`, `wxt.config.ts` -- remove trial commands/dependencies/providers and set the public beta identity.
- `entrypoints/`, `lib/ocr/`, `tools/extension-artifact.mjs`, `tests/` -- remove Paddle/direct-Wasm trial seams while retaining production OCR and release validation.
- `vendor/ocr/`, `legal/`, `THIRD_PARTY_NOTICES.md` -- delete trial-only payloads and align required license inventory with shipped/source-distributed material.
- `README.md`, `docs/`, `_bmad-output/project-context.md` -- current product explanation, maintenance guidance, limitations, and removal of hackathon-specific disclosures.
- `dist/chrome-unpacked/` -- guarded, byte-exact normal-profile Chrome installation directory.

## Tasks & Acceptance

**Execution:**
- [x] Remove trial-only PaddleOCR and direct Tesseract-Wasm code, assets, dependencies, commands, UI labels, validation branches, and focused tests; retain general provider abstractions and production coverage.
- [x] Audit MIT/Apache-2.0/ISC/BSD obligations against the remaining source and artifact; correct notices and package metadata without relicensing third-party work.
- [x] Rewrite `README.md` product-first and update durable technical docs/context to match the isolated engine and normal OCR profile; delete current-tree Build Week disclosure artifacts.
- [x] Set a non-hackathon 0.3.2 beta build identity, sync `dist/chrome-unpacked/` with `npm run artifact:sync`, and verify it is reload-ready.
- [x] Run focused tests, `npm run check`, whitespace/reference audits, review the complete diff, commit the release pass on the feature branch, and fast-forward local `main`.

**Acceptance Criteria:**
- Given a public checkout, when a user follows the README, then they can load or reload `dist/chrome-unpacked/` without Node and understand the source-to-sanitized-replica-to-local-translation flow.
- Given the current tree and artifact, when trial/hackathon references and OCR payloads are audited, then only relevant production material and required legal notices remain.
- Given the release gate, when `npm run check` runs, then strict TypeScript, the full retained test suite, release security validation, size limits, and byte comparison pass.
- Given the completed feature branch, when integrated locally, then `main` advances by fast-forward with no remote push and no rewritten history.

## Spec Change Log

- 2026-08-28: Implemented the production-profile cleanup, public documentation
  and notice update, guarded unpacked-artifact sync, complete quality gate, and
  local feature-branch integration pass.

## Design Notes

The dependency licenses are permissive and compatible with retaining MIT for original Simul code when their conditions are honored. MIT notices must remain with substantial copies; Apache-2.0 components require their license and applicable attribution/NOTICE content, with modified-file notices where relevant; BSD/ISC notices and disclaimers must remain. This is an evidence-based repository audit, not legal advice.

## Verification

**Commands:**
- `npm run check` -- all quality gates and the normal byte-exact artifact check pass.
- `git diff --check` -- no whitespace errors.
- `rg -n -i 'build week|hackathon|ocr[- ]?trial|paddleocr|tesseract-wasm-direct'` over public runtime/docs/config paths -- no obsolete release references.
- `git merge-base --is-ancestor <feature-tip> main` -- local `main` contains the reviewed feature tip after fast-forward.

**Manual checks:**
- Reload `dist/chrome-unpacked/` in Chrome 138+, open a normal HTTP(S) page, confirm the build identity, side-panel/popout launch, page translation, privacy setup, scroll following, and optional OCR controls.
