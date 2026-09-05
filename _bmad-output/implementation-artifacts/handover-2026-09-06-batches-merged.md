# Handover: the review work is merged to main (2026-09-06)

Supersedes `handover-2026-09-05-review-redo.md` (which described the state
before the side-panel split and the four lib batches were merged).

## Where things stand

| Item | State |
| --- | --- |
| `main` | `6e9367c`. All five open PRs are merged. Local `main` = `origin/main`. |
| Merged today (2026-09-06) | [#10](https://github.com/aredna/simul/pull/10) side-panel split (D31/D32), [#16](https://github.com/aredna/simul/pull/16) transactional image-permission rollback (D35), [#14](https://github.com/aredna/simul/pull/14) lib batch 2 (D34), [#17](https://github.com/aredna/simul/pull/17) lib batch 3 (D36), [#18](https://github.com/aredna/simul/pull/18) lib batch 4 (D37). All rebase-merged so `main` stays linear; each PR branch auto-deleted. |
| Gate on `main` | typecheck clean; 1,369 tests across 93 files (the Chrome-fixture test skips without a browser); `dist/chrome-unpacked` synced and byte-verified. There is no CI: run `npm run check` before every push. |
| Merge method | Each PR was rebased onto the current `main`, re-gated, then rebase-merged. The three lib batches each needed the decision log (tail append), `deferred-work.md` (their own removals), and the `dist/` bundles resolved; the resolution kept `main`'s docs and re-applied each batch's section and removals, then `npm run artifact:sync` regenerated `dist/`. |
| Build identity | still `0.4.0 beta v.20260905.1`. `main` is 45 commits ahead of the `v0.4.0` tag, so the merged tree is materially newer than what that identity names. See "What is next" item 1. |
| Deferred work | 29 entries in `deferred-work.md` (was 42 before this run). |
| Decision log | D1–D37 in `review-2026-09-03-decision-log.md`. The tail is appended in merge order, not numeric order: D33, D35, D34, D36, D37. Each section records the state of its own batch at the time it was written (its "down to N entries" line is that batch's local count, not the running total). |
| Records policy | Reports stay in the repository; nothing is published to claude.ai. |

## What is next, in order

1. **Advance the build identity before any further release.** `betaBuildSuffix`
   in `wxt.config.ts` still reads `beta v.20260905.1`, which named the #9
   publish build. The merged `main` is a different build, so a fresh public
   testing build should get a new date/sequence (`beta v.2026MMDD.1`). This was
   deliberately not bumped on merge because the merged tree has not had a manual
   Chrome pass yet (item 2); stamping a fresh testing-build identity on unrun
   code would be misleading. Bump it as the first step of the next release,
   after the browser pass, then `npm run artifact:sync` and re-gate. The
   `v0.4.0` tag stays on the original #9 publish commit.
2. **Manual Chrome pass (owed, needs a browser this machine does not have).**
   The split moved ~3,800 lines of `main.ts` into modules verified only by the
   typechecker and the suite. Exercise the seams no unit test covers before a
   public build: the detached window (open, return, active-tab following),
   first-run read-scope setup, a settings reset, and the image-permission
   rollback path (turn image translation off and confirm the exact site grants
   are re-requested). Also worth a busy-page pass (Reddit-class, a fixed header
   over images, a login form near an image) for the OCR overlap rule, the
   text-cover heuristic and the rebuild budget. The Chrome-fixture test
   (`tests/isolated-disclosure-chrome.test.ts`) skips without a Chrome binary.
3. **L4/L5 string catalogue (now unblocked).** Scoped in D35: about 240
   user-facing literals across the side-panel modules plus 102 labels/titles/
   aria strings in `index.html`. Doing L4 properly means one catalogue module
   keyed by purpose, every `setStatus`/DOM label reading from it, `UiLocalizer`
   extended to titles/aria/status templates, and L5's flash addressed by
   swapping a whole localized catalogue at once. It is a session of its own with
   a browser check at the end; it was held until #10 merged, which is now done.

## Decisions awaiting your call

- **`aria-labelledby` accessible names (deferred entry still open).** A label
  record becomes a painted, `aria-hidden` span next to the control and would
  duplicate the visible referenced text, so this needs a relationship proof
  (native node ids, replica-side id assignment) rather than a text record —
  a semantic-protocol addition to approve before building. Reasoning in D37.
- **Slider/spinbutton range values.** D37 carries `aria-valuenow` for the
  read-only indicator roles (`progressbar`, `meter`, `scrollbar`) only, and
  deliberately excludes `slider`/`spinbutton` because their value is user
  input. Decide whether user-facing range values should travel under the
  `formValues` gate like other personal values, or stay excluded.

## The remaining deferred work

`deferred-work.md` holds 29 entries. They are research- or design-sized, not
quick wins: Strict Local no-network mirror mode, additional OCR providers
(Transformers.js, Chrome Prompt sidecars, Screen AI), the multi-pass OCR
fallback for stylized logos, aligning the text-serialization privacy floor
with the shared painted-visibility boundary, ancestor paint changes in the
image capture identity, a privacy-reviewed nested-scroller identity, and the
installed-Chrome fidelity/accessibility test rows. Several earlier entries
turned out to be already implemented upstream when checked (D34, D36 and D37
each retired one or two that way), so verify any entry against the current
code before designing a fix.

## How to work in this clone

- `git fetch origin` and compare `origin/main` before starting.
- Put the pinned toolchain on the path for every npm command:
  `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH` (Node 24.18.0, npm
  12.0.2). The shell's default Node fails `engine-strict`.
- Never hand-edit `dist/chrome-unpacked/`; run `npm run artifact:sync` after a
  source change and commit the result. `npm run check` is the gate. When a gate
  runs in the background, read the log's `exit=` and `Tests` lines before
  claiming green.
- `main` rejects direct commits (pre-commit hook); land changes through a PR.
  Do not hand-edit `.agents/skills/` or `_bmad/` (generated by the installer).
- Side-panel modules: class + explicit environment (callbacks and element
  refs, browser calls behind a small adapter) + a unit test against fakes or a
  linkedom document. Replace `main.ts` source-substring tests with behavioral
  tests when the code they cover moves.
