---
title: 'OpenAI Build Week Disclosures'
type: 'chore'
created: '2026-07-22'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'ee8398d84f37e59b1a1229825ec61129b405afec'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Simul's public repository identifies Codex and GPT-5.6 but does not yet provide the concrete collaboration, new-work, third-party-work, testing-rights, and submission-boundary disclosures required or requested by the OpenAI Build Week FAQ and Official Rules.

**Approach:** Add a concise judge-facing README disclosure and a detailed compliance record, preserve an exact pre-deadline submission commit, release original Simul material under the standard MIT License, remove copied brand fixtures from tests, and identify submission actions that cannot be completed from the repository.

## Boundaries & Constraints

**Always:** Use only verifiable repository history and official Devpost sources. State that Simul began during the Submission Period, distinguish entrant decisions/manual browser testing from Codex-authored implementation, and explain that GPT-5.6 Sol Ultra powered the Codex development workflow but is not a runtime translation API. Identify the exact pre-deadline commit and installable artifact. Disclose third-party libraries, generated BMAD Method material, Chrome APIs, and their notices. License original Simul material under the standard MIT License, while preserving every third-party component's own terms and notices. Warn that the primary-thread Session ID, track, text submission, and public narrated video belong in Devpost and cannot be fabricated or submitted by repository automation.

**Ask First:** Any license other than MIT for original Simul material; any assertion about entrant identity, residency, team membership, submitted track, video URL, or Session ID that is not available from verified evidence.

**Never:** Change extension runtime behavior; imply that GPT-5.6 performs runtime page translation; claim compliance with unverified entrant-only requirements; publish a guessed Session ID; conceal pre-existing or third-party material; apply Simul's MIT license to third-party material governed by other terms; or rewrite history after the cutoff.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Public judge review | README at repository HEAD | Concise provenance, human/Codex decisions, GPT-5.6 role, new-work timeline, testing path, and disclosure link | Every claim is traceable to Git or project files |
| License review | Public repository and judging requirement | Standard MIT License covers original Simul material for everyone | Third-party material retains its own licenses/notices |
| Deadline boundary | Documentation clarification near cutoff | Exact immutable pre-deadline functional commit, final tagged compliance tree, and executable release commit are identified | Later non-runtime compliance changes are not described as submitted functionality |
| External submission fields | Session ID/video/track/form | Action checklist states what the entrant must provide | No placeholder or fabricated completion claim |
| Copied compatibility fixture | Branded SVG/text embedded in tests | Replace with original synthetic equivalents retaining the same structural coverage | Do not alter production behavior or weaken assertions |

</frozen-after-approval>

## Code Map

- `README.md` -- required judge-facing Codex/GPT-5.6 collaboration and provenance disclosure.
- `docs/openai-build-week-disclosure.md` -- detailed rules mapping, cutoff evidence, external submission checklist, and demo-IP warning.
- `LICENSE`, `dist/chrome-unpacked/LICENSE`, `package.json`, `package-lock.json` -- standard MIT terms and matching metadata for original Simul material.
- `THIRD_PARTY_NOTICES.md` -- existing dependency and generated-tooling attribution inventory.
- `tests/html-mirror-source.test.ts`, `tests/html-mirror-protocol.test.ts`, `tests/pixel-acquisition.test.ts` -- replace copied brand/logo fixtures with original synthetic content.
- `_bmad-output/project-context.md` -- keep the durable SVG-fixture description generic and current.

## Tasks & Acceptance

**Execution:**
- [x] `README.md` -- replace the vague provenance statement with concrete, accurate collaboration and hackathon disclosures.
- [x] `docs/openai-build-week-disclosure.md` -- record the official requirements, evidence, immutable cutoff, external actions, and video/IP constraints.
- [x] `LICENSE`, `package.json`, `dist/chrome-unpacked/` -- replace the prior
  custom terms with MIT and resynchronize the packaged legal file.
- [x] Branded test fixtures -- replace copied Y Combinator/D-U-N-S/company names with original generic SVG and text while retaining coverage.
- [x] `_bmad-output/project-context.md` -- replace the obsolete branded-fixture reference with its synthetic equivalent.
- [x] Documentation checks -- verify timestamps, links, terminology, absence of placeholders, and no runtime behavior changes.

**Acceptance Criteria:**
- Given the official FAQ, when a judge reads the README, then every repository-level disclosure requirement is answered directly and accurately.
- Given commit history, when new-versus-existing work is evaluated, then the first commit, release artifact commit, and pre-deadline cutoff are unambiguous.
- Given the runtime architecture, when GPT-5.6 usage is reviewed, then development-time use is explicit and no runtime OpenAI integration is implied.
- Given third-party code and judging access, when licenses are reviewed, then original Simul material is clearly MIT-licensed and every dependency/tool/model retains its own documented terms.
- Given the Devpost-only requirements, when the checklist is read, then it clearly identifies `/status`, the narrated public video, track, description, and eligibility as entrant actions rather than completed repository facts.
- Given repository ownership warranties, when tracked fixtures are scanned, then copied third-party logos and branded compatibility text are absent while equivalent generic tests pass.

## Spec Change Log

- 2026-07-22: Entrant explicitly replaced the proposed narrow judging grant
  with the standard MIT License for original Simul material.
- 2026-07-22: Implemented disclosure, licensing, synthetic-fixture, and packaged
  artifact changes; completed focused and full validation.
- 2026-07-22: Adversarial review clarified entrant attestation versus Git
  evidence, judging-period availability, mandatory video audio, final-tree
  identification, development-tool notices, and complete verification scope;
  it also restored nontrivial SVG path syntax coverage in the synthetic fixture.

## Verification

**Commands:**
- `git diff --check` plus `git diff --no-index --check /dev/null <new-file>` -- no whitespace errors in tracked or untracked changes.
- `npm run check` -- production source remains unchanged; tests and the byte-exact installable artifact remain valid.
- `git diff --name-only ee8398d` plus `git ls-files --others --exclude-standard` -- only approved disclosures, legal packaging, durable context, and synthetic test-fixture substitutions changed.

**Manual checks:**
- Compare every requirement against the current official FAQ and Rules immediately before pushing.

**Results:**
- Focused fixture suites: 3 files / 110 tests passed.
- Full `npm run check`: typecheck passed, 56 files / 726 tests passed, and the
  ready-to-load unpacked artifact matched a fresh guarded build byte-for-byte.
- `git diff --check`: passed.
- Artifact changes are limited to the packaged MIT `LICENSE`; extension runtime
  bytes and behavior are unchanged.

## Suggested Review Order

**Build Week disclosure and provenance**

- Start with the judge-facing summary, evidence cutoff, and collaboration split.
  [`README.md:29`](../../README.md#L29)

- Review the detailed evidence, final tagged tree, and controlling-source caveat.
  [`openai-build-week-disclosure.md:13`](../../docs/openai-build-week-disclosure.md#L13)

- Confirm entrant-owned submission steps, mandatory audio, and continued judge access.
  [`openai-build-week-disclosure.md:117`](../../docs/openai-build-week-disclosure.md#L117)

**Open-source and third-party boundaries**

- Confirm original Simul material uses canonical permissive MIT terms.
  [`LICENSE:1`](../../LICENSE#L1)

- Verify package metadata declares the same MIT license.
  [`package.json:6`](../../package.json#L6)

- Check runtime, development-tool, and third-party notice boundaries.
  [`openai-build-week-disclosure.md:71`](../../docs/openai-build-week-disclosure.md#L71)

**Synthetic fixture and validation cleanup**

- Review original synthetic SVG complexity and generic public-label coverage.
  [`html-mirror-source.test.ts:18`](../../tests/html-mirror-source.test.ts#L18)

- Confirm safe SVG admission and hostile-resource rejection remain symmetric.
  [`html-mirror-protocol.test.ts:1354`](../../tests/html-mirror-protocol.test.ts#L1354)

- Verify durable context no longer names a copied branded fixture.
  [`project-context.md:78`](../project-context.md#L78)

- Confirm the shallow-image geometry test retains its behavior without a brand name.
  [`pixel-acquisition.test.ts:135`](../../tests/pixel-acquisition.test.ts#L135)
