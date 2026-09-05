# Handover: review fixes over the 0.3.3 line (2026-09-05)

## Where things stand

| Item | State |
| --- | --- |
| Merged | [#9 "0.4.0: review fixes re-applied over the 0.3.3 line"](https://github.com/aredna/simul/pull/9), rebase-merged 2026-09-05; [#11](https://github.com/aredna/simul/pull/11) removed the GitHub Actions workflow at your request. `main` is `95f1ba7` |
| Released | tag `v0.4.0` at `9f4987f` (the publish commit); GitHub pre-release [Simul 0.4.0 beta (v.20260905.1)](https://github.com/aredna/simul/releases/tag/v0.4.0) with the zipped `dist/chrome-unpacked` and notes from D29 and D30 |
| Open PR | [#10 "Side-panel split over the 0.4.0 line"](https://github.com/aredna/simul/pull/10), branch `refactor/side-panel-split`, 17 commits rebased onto `main`. Fifteen modules, `main.ts` 5,305 → 1,472 lines (D31). Ready for review |
| Open PR | [#12 "Review remainder and deferred-work fixes outside the side panel"](https://github.com/aredna/simul/pull/12), branch `fix/review-remainder-lib` off `main`, 10 commits: L10 Hebrew tag probe, M5 host-grant ledger, and six deferred-work items (validator project root, shadow-host overlap, scroll progress bound, contradictory tablists, padding-box clip, scroller scan budget). Logged as D33 (on that branch). Independent of #10 in source; both rebuild the side-panel chunk, so whichever merges second needs a rebase and `npm run artifact:sync` |
| Stacked PR | [#16](https://github.com/aredna/simul/pull/16) `fix/image-permission-rollback` on this branch: the transactional image-permission rollback (D35). Merge into `refactor/side-panel-split` before #10, or together with it |
| Also open | [#14](https://github.com/aredna/simul/pull/14) `fix/deferred-lib-batch-2` against `main` (D34): overlay rebinding, image-hint policy reuse, attention-ranked discovery |
| Merged 2026-09-05 | [#12](https://github.com/aredna/simul/pull/12) (D33), [#13](https://github.com/aredna/simul/pull/13) (Dependabot config removed), [#15](https://github.com/aredna/simul/pull/15) (Chrome manual test plan) |
| Closed | [#8](https://github.com/aredna/simul/pull/8) (superseded; branch deleted) and Dependabot #1, #2, #4, #6 (superseded by the 0.4.0 pins) |
| Local `main` | at `origin/main` (`95f1ba7`) |
| Gate at #10 head | typecheck clean; 1,355 tests after the rebase onto `main` (the Chrome-fixture test skips without a browser); `dist/chrome-unpacked` synced and byte-verified. There is no CI any more: run `npm run check` before every push |
| Build identity | `0.4.0 beta v.20260905.1`; placeholder icons (your choice for this build); exact pins with a tracked lockfile |
| Records | `review-2026-09-03-decision-log.md` D1–D32 here and D33 on `fix/review-remainder-lib`, plus `review-2026-09-03-findings.md` (the original review, 52 findings and 12 recommendations, converted from the page it was first published on) in this directory. Reports stay in the repository from now on; nothing further is published to claude.ai. |

## What happened, in order

1. **2026-09-03: review and fixes on a stale base.** The extension was reviewed
   (4 blockers, 4 High, 20 Medium, 24 Low, 12 recommendations) and fixed on a
   branch cut from the local `main`. That work also refreshed dependencies to
   floating ranges without a lockfile, removed rrweb, and split the side panel
   into fourteen modules with tests (`main.ts` 4,587 to 1,415 lines).
2. **2026-09-04: the base turned out to be stale.** While preparing the merge you
   asked for, `origin/main` was found 119 commits ahead (22 July to 29 August):
   your perf series, three fixes, the sweep that deleted the legacy mirror, the
   page snapshot, the live page mirror and rrweb, the semantic-source and
   read-scope subsystems, read-only disclosures, replica recovery,
   accessibility-first OCR, and the 0.3.3 beta testing build. A trial merge
   conflicted in 46 source, test and doc files. Recorded as D27.
3. **2026-09-04: the upstream review.** Four read-only passes over `origin/main`
   cross-checked the review branch's 46 items against the current code: 22 still
   applied, 13 were already upstream in your own form, 7 were obsolete (code
   gone), 4 were policy conflicts. Five new defects were noticed in the current
   code while cross-checking. Recorded as D28 with file and line evidence.
4. **2026-09-04: your decisions.** Upstream is the code base, but "0.3.1 and
   0.3.3 both had issues; do not assume 0.3.3 is required; do what you deem
   best". Dependencies: exact pins with a tracked lockfile, bumped to the newest
   release before 2026-08-27. OCR: the looser overlap rule (only credential
   fields block pixel capture).
5. **2026-09-04/05: the redo.** Branch `chore/review-redo` off `origin/main`.
   Toolchain first (D29), then the 22 still-applying fixes, the five new
   findings, the OCR rule and the docked window, ported in five file-disjoint
   clusters, each re-verified against the current code with its own tests, and
   integrated one at a time under the full gate (D30). PR #9 opened, PR #8
   closed.

## What landed on PR #9

**Toolchain (D29).** Version 0.4.0. Exact pins: wxt 0.21.4, Vite 8.2.2 (peer),
vitest 4.1.11, typescript 7.0.2, acorn 8.18.0, linkedom 0.18.13, @types/node
24.13.3; tesseract.js and tesseract.js-core stay 7.0.0 because the OCR runtime
is vendored byte-for-byte against them. Lockfile regenerated by npm 12.0.2 (178
packages, 0 vulnerabilities). The `overrides` block was removed because none of
its six targets is installed once wxt 0.21 drops web-ext and Vite 8 drops
esbuild; `allowScripts` keys are name-only. Manifest icons from `public/icon`
(placeholders); legal comments via rolldown's `output.comments.legal`; the
release build runs under a scrubbed environment (`WXT_*`, `VITE_*`,
`SIMUL_OCR_*` removed); the validator requires the four icon sizes. CI installs
npm 12.0.2 and runs `npm ci`.

**Sanitizer and engine.** Colon-prefixed tag names are rejected outside the
HTML namespace and HTML elements are created with `createElement`, so `x:iframe`
stays an inert unknown element (H2). SVG camelCase names are restored from the
full table (H3). A stale run checks currency before releasing the stream (L16).
`crossorigin` is stripped on every element.

**Source observer.** Shadow-root observation is iterative with a 20,000 node
budget per mutation batch and a per-batch visited set; exhaustion is reported
through the existing content-free omission counter. A throwing mutation record
posts `stream_gap` instead of silently dropping the batch.

**OCR.** Tesseract bootstrap has its own 60 s deadline; a caller cancel keeps
the worker warm. Inactive tab, host outage, overflow, missing input and lost
worker defer the image; `resume()` is wired to followed-tab activation and to
the companion becoming visible; a replica commit re-queues anchor-deferred
images. A text-cover heuristic defers capture while another element's text
covers the image. The overlap rule is yours: only credential-secret overlaps
block; README states it.

**Side panel.** Focus changes and `followActivatedSourceTab` keep the navigation
refresh armed, and a stale same-page replica rebuilds (M1, helper
`lib/followed-replica-currency.ts`). Zoom commits once per drag (150 ms,
flushed on `pagehide`). Image settings render on a key and keep the diagnostics
disclosure open. Label localization creates a session only for an installed
pair and retries after a page translation prepared it. Another window's language
change no longer forces translation. The availability pair is recorded only
after the guarded result. The follow marker is released on the early return;
stale optional chains removed; the dark focus ring has contrast.

**Background, surface, providers.** A second toolbar click focuses the existing
detached window and re-authorizes it through the ordered message. The detached
window docks right at 45% of the source width (minimum 480 px). Chrome's
`NotAllowedError` and `QuotaExceededError` surface as `activation-required`
and `quota-exceeded`. Long values keep their line breaks across chunks. The
recovery gate has a sliding budget of 3 rebuilds per 60 s.

## Decisions in force

- **Base line:** `origin/main`. The review branch is a reference, not a line to
  merge (D28).
- **Dependencies:** exact pins, tracked lockfile, `npm ci` in CI, nothing
  released within the last 7 days at bump time; tesseract.js exact and bumped
  only as a deliberate release step with `tools/vendor-tesseract.mjs` (D4, D29).
- **OCR privacy:** everything runs locally; capture near public text controls is
  allowed, credential controls block, foreign text covering an image defers
  (D9, D18, D30). No opt-in for private data yet.
- **Language:** HTML `lang` stays authoritative for Auto-detect (D10).
- **Window:** detached companion docks right at 45% (D11); real side-by-side
  pairing is still a separate window-management pass.
- **Icons:** placeholders until you provide the mark (D12).
- **Telemetry:** none; diagnostics stay content-free and DEV-gated (upstream
  rule, kept).

## What is next, in order

1. **Review and merge PR #10.** The design is D25/D26: one
   `CompanionState`, one `Currency` of scoped tokens, and modules that take
   their collaborators through a small environment and test against fakes.
   D31 lists the fifteen modules, the deliberate details, and what stays in
   `main.ts` by design. Suggested reading order: `companion-state.ts` and
   `currency.ts`, then `main.ts`, then the modules. A manual pass in Chrome
   is worth doing before a public build: the browser adapters (tabs, windows,
   side panel, scripting, permissions, storage) are the seams no unit test
   covers. After it merges, advance the build identity (`v.2026MMDD.1`)
   before any further release; `v0.4.0` stays on the #9 merge.
2. **Decide on `.github/dependabot.yml`** (D32): it was left when the CI
   workflow was removed because it is not CI.
3. **Review and merge PR #12** (D33). L10 and M5 are fixed there; L3 is
   obsolete on this line and D17 stays a documented limit (reasons in D33).
   Two choices in M5 are marked "please confirm". Merging #12 first and then
   rebasing #10 (with an artifact resync) is the smaller rebase.
4. **Side-panel items that wait for #10:** L4/L5 string catalogue for titles
   and aria labels, the transactional image-permission rollback, and the
   redirect-during-load capture from `deferred-work.md`.
5. **Upstream's remaining deferred work** is listed in
   `_bmad-output/implementation-artifacts/deferred-work.md` (42 entries after
   #12).
6. **Real icon mark** whenever it exists (replace `public/icon/*.png`; the
   validator only checks presence and size names).

## Known limits and loose ends

- The Chrome-fixture test (`tests/isolated-disclosure-chrome.test.ts`) skips
  without a browser. On the GitHub runner it timed out on D-Bus on 2026-08-28
  and again on the 0.4.0 publish commit's run (the same tree had passed on the
  PR run minutes earlier). The workflow is gone since PR #11, so this only
  matters if CI ever comes back.
- wxt 0.21 reports about 116 MB for the build because upstream's release plugin
  emits the OCR assets once per Vite build; the artifact on disk is 37.5 MiB and
  the validator measures disk.
- `tools/git-hooks/pre-push` blocks every push when installed; it is not
  installed in this clone. Install only when you want that behavior.
- The rebuild budget, the text-cover heuristic and the overlap rule have unit
  tests but no browser-level test; a manual pass on a busy page (Reddit-class,
  a page with a fixed header over images, a login form near an image) is worth
  doing before a public build.
- PR #10 moved about 3,800 lines of `main.ts` into modules by mechanical
  edits verified by the typechecker and the suite (1,333 tests), not by a
  browser run. Exercise the detached window (open, return, active-tab
  following), the first-run read-scope setup and a settings reset in Chrome
  before merging it into a public build.

## How to work in this clone

- Always `git fetch origin` and compare `origin/main` before starting; this is
  what went wrong on 2026-09-03.
- Put the pinned toolchain on the path for every npm command:
  `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH` (Node 24.18.0, npm
  12.0.2). The shell's default Node 24.14 / npm 11.9 fails `engine-strict`.
- Never hand-edit `dist/chrome-unpacked/`; run `npm run artifact:sync` after a
  source change and commit the result. `npm run check` is the gate.
- Do not hand-edit `.agents/skills/` or `_bmad/` (generated by the BMAD
  installer).
- Every non-obvious choice goes in the decision log with a "Please confirm"
  marker when a different reading of your instructions would change the work.
- Side-panel modules: class + explicit environment (callbacks and element
  refs, browser calls behind a small adapter) + a unit test against fakes or
  a linkedom document. Source-substring tests over `main.ts` are replaced by
  behavioral tests when the code they cover moves.
