---
title: 'Rank accessibility and OCR image-text evidence'
type: 'feature'
created: '2026-07-23'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'a3fb3748cd859db8ef305fa8e005501abc29a556'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-simul-2026-07-23/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-secure-readable-replica.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Image translation currently commits the first successful method, so generic accessibility labels such as `CDN Media` can suppress better OCR and vote for the wrong Auto language, while a fixed OCR preference would lose accurate short ALT text when recognition is poor.

**Approach:** Add an explainable, deterministic, entirely local evidence ranker that holds only provisional candidates, lazily compares the minimum necessary later methods, selects source evidence before translating once, and preserves the saved method order as attempt order and the final tie-breaker. Evaluate available pretrained rankers; if none is task-fit and publishable, document a reproducible Simul-specific logistic-ranker training path.

## Boundaries & Constraints

**Always:** Preserve the credential floor, inert replica, exact document/revision/policy/reset currency, existing OCR confidence gate, independent-family corroboration, and semantic fallback. Keep candidate/repetition state bounded, memory-only, exact-document, and absent from diagnostics; clear it on reconnect, mutation/removal, method/read-policy changes, pair/reset transitions, release, and disposal. Treat shortness and repetition only as reasons to compare, never as rejection or synthetic OCR confidence. Acquire pixels only when execution reaches an enabled eligible OCR method; lack of permission, small-image ineligibility, empty/unavailable OCR, or exhausted retry returns to the best admissible semantic candidate. Only selected evidence may translate, project, or vote for Auto language, and semantic Auto promotion requires distinct images with distinct normalized labels. Keep all runtime code/assets local with no new permission.

**Ask First:** Adding third-party model weights/runtime dependencies, collecting or exporting user examples, enabling Gemini Nano, changing the saved confidence value, or broadening source evidence beyond the currently admitted direct `aria-label`-then-`alt` contract.

**Never:** Add phrase, hostname, or language-specific winner lists; use longest-text-wins; sweep every OCR provider unconditionally; count the two Tesseract bindings as independent; log text, translations, fingerprints, IDs, hashes, lengths, or per-label frequencies; persist learned/repetition state; push, merge, or modify `main`/origin.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Accurate semantic label | Short or descriptive ALT; OCR weak/conflicting | ALT wins, including one-word controls and `お知らせ` | Existing OCR failures cannot suppress ALT |
| Generic authored label | Low-information or repeated label; accepted richer OCR | Compare lazily; stronger OCR wins without a phrase rule | Repetition alone never rejects ALT |
| Agreement or disagreement | ALT and one or more OCR results | Agreement boosts trust; calibrated quality, independent corroboration, role-free text shape, and priority decide | Close scores use saved order |
| OCR cannot run | Small-image rule, permission absent, providers empty/unavailable | Use held ALT without prompting or looping | Preserve transient capture's single retry |
| Live change | Label mutates/removes, duplicate appears, policy/reset/reconnect occurs | Abort stale work, update bounded counts, and re-evaluate affected exact-current images | Old candidate/vote cannot project or resolve language |

</frozen-after-approval>

## Code Map

- `lib/ocr/image-evidence-ranker.ts` -- pure bounded assessment, agreement, repetition index, and deterministic selection reasons.
- `lib/ocr/{image-translation-controller,image-analysis-coordinator,result-quality}.ts` -- collect candidates before translation, retain selected-result quality and provider-family boundaries, preserve lazy continuations, currentness, fallback, and selected-only Auto votes.
- `lib/ocr/{auto-language-probe,image-scan-scheduler,diagnostic-history}.ts` -- distinct-label semantic votes, safe exact-current requeue, and content-free selection diagnostics.
- `entrypoints/sidepanel/main.ts` -- clarify that priority is attempt/tie order and uncertain accessibility text may be compared.
- `docs/image-evidence-ranker-training.md` -- evaluated model matrix and custom logistic dataset/features/calibration/release plan.
- `tests/` and architecture/build artifacts -- ranking, lifecycle, privacy, UI, beta identity, and unpacked-trial coverage.

## Tasks & Acceptance

**Execution:**
- [x] `lib/ocr/{image-evidence-ranker,result-quality,image-analysis-coordinator}.ts` -- implement source-neutral features, bounded duplicate tracking, selected-provider quality, decisive-margin behavior, and same-family protection.
- [x] `lib/ocr/{image-translation-controller,auto-language-probe,image-scan-scheduler,diagnostic-history}.ts` -- collect before translating, requeue affected duplicates safely, preserve every fallback/currentness path, and admit only selected language votes.
- [x] `tests/`, `ARCHITECTURE-SPINE.md`, `entrypoints/sidepanel/main.ts`, and `docs/image-evidence-ranker-training.md` -- revise AD-7/8/9/10, explain the UI behavior and model decision, and cover every matrix row without site-specific policy code.
- [x] `wxt.config.ts`, `README.md`, identity/artifact tests, and `dist/chrome-unpacked/` -- advance to `0.3.2 beta v.20260723.5`, run full checks, and sync the exact four-provider build on this branch only.

**Acceptance Criteria:**
- Given accessibility and OCR methods in any saved order, when evidence is decisive or exhausted, then only the selected source is translated/projected and the order remains observable as attempt order and tie precedence.
- Given repeated generic labels, short legitimate labels, differing languages, provider disagreement, same-family OCR, permission failure, mutation, reset, and reconnect, when jobs race, then deterministic current results preserve semantic fallback and rejected candidates never vote or reappear.
- Given the completed branch, when `npm run check`, exact artifact validation, and branch checks run, then the local unpacked beta is reproducible and neither main nor origin changed.

## Spec Change Log

## Design Notes

The closest task-specific research found was Bigham's 2007 ALT-quality AdaBoost classifier, but no licensed weights were released and its small English/web-search-dependent corpus does not fit an offline multilingual extension. Retrieval models such as TinyBERT/MiniLM judge semantic relevance rather than visual truth. The first release therefore uses transparent features; a later pairwise logistic model may replace only the numeric weights after held-out-site calibration proves lower harmful-selection error.

## Verification

**Commands:**
- `npx vitest run tests/image-evidence-ranker.test.ts tests/image-translation-controller.test.ts tests/auto-language-probe.test.ts tests/image-scan-scheduler.test.ts tests/ocr-diagnostic-history.test.ts tests/offscreen-ocr.test.ts` -- focused selection, lifecycle, and privacy regressions pass.
- `npm run artifact:sync:ocr-trials && npm run check && npm run check:ocr-all-trial` -- full quality gates and exact unpacked trial pass.
- `git diff --check && git status --short --branch && git log --oneline --decorate -5` -- clean branch-only handoff with no push or merge.

## Suggested Review Order

**Evidence selection and execution**

- Start with the lazy planner that compares candidates before translating either.
  [`image-translation-controller.ts:1035`](../../lib/ocr/image-translation-controller.ts#L1035)

- Review the explainable score, decisive margin, agreement, and priority tie-break.
  [`image-evidence-ranker.ts:201`](../../lib/ocr/image-evidence-ranker.ts#L201)

- Follow bounded continuation fallback, transcript revalidation, and selected-only Auto voting.
  [`image-translation-controller.ts:1831`](../../lib/ocr/image-translation-controller.ts#L1831)

**Bounded lifecycle and language evidence**

- Inspect exact-document duplicate tracking and conservative capacity behavior.
  [`image-evidence-ranker.ts:67`](../../lib/ocr/image-evidence-ranker.ts#L67)

- Verify state-free transcript classification remains separate from bounded vote mutation.
  [`auto-language-probe.ts:374`](../../lib/ocr/auto-language-probe.ts#L374)

- Check active-work cancellation and exact-current requeue semantics.
  [`image-scan-scheduler.ts:192`](../../lib/ocr/image-scan-scheduler.ts#L192)

**Product explanation and future model path**

- Confirm Options describes attempt order, comparisons, and close-tie behavior accurately.
  [`main.ts:4499`](../../entrypoints/sidepanel/main.ts#L4499)

- Review why no pretrained model shipped and how a logistic ranker could qualify.
  [`image-evidence-ranker-training.md:1`](../../docs/image-evidence-ranker-training.md#L1)

- Read the architectural invariants protecting fidelity, privacy, and selected-only output.
  [`ARCHITECTURE-SPINE.md:91`](../planning-artifacts/architecture/architecture-simul-2026-07-23/ARCHITECTURE-SPINE.md#L91)

**Regression and build proof**

- Begin with pure ranking, tie, repetition, mutation, and capacity cases.
  [`image-evidence-ranker.test.ts:29`](../../tests/image-evidence-ranker.test.ts#L29)

- Trace Auto transcript correction and lifecycle fallbacks through controller integration tests.
  [`image-translation-controller.test.ts:3716`](../../tests/image-translation-controller.test.ts#L3716)

- Verify the visible beta identity used to confirm the loaded unpacked build.
  [`wxt.config.ts:12`](../../wxt.config.ts#L12)
