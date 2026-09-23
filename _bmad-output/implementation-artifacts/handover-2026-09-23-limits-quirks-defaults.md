# Handover: mirror limits, quirks mode, new defaults (2026-09-23, second session)

Chains from `handover-2026-09-23-session-close.md`, whose work list this
session worked through. Decision-log entries **D63**–**D69** hold the reasoning
and measurements; this file is the summary and the next steps.

## Where things stand

| Item | State |
| --- | --- |
| Branch / PR | `feat/ui-string-catalogue`, PR #22, **open**, head at the D69 commit plus this file. Description covers D40–D69. |
| Version / identity | `0.5.0` / `0.5.0 beta v.20260922.28` (next is `.29`). |
| Gate | `npm run check` green at D69: **1,491 tests pass, 1 skipped**; `dist/chrome-unpacked` byte-verified. |
| NAS | `Dev/simul/` mirrors head; the owner loads `Dev/simul/dist/chrome-unpacked` (`Build 0.5.0 beta v.20260922.28`). |
| `main` / release | Only `v0.4.0` released. Publishing 0.5.0 is **D70**, only when the owner says so; do not ask. |

## Owner rulings this session

- **When a page is too big for the mirror:** keep today's behaviour (the
  panel says the replica could not be prepared). Not "drop the stylesheet".
- **Other size caps:** "Let's raise caps where possible to numbers that are
  less likely to cause issues. These also feel like something that could be
  advanced settings where we can enter a number."
- **Settings shape:** three numbers in Advanced (largest single item, largest
  page up to 60 MB, most page elements) with Restore defaults. Chosen from a
  preview.
- **Replica fidelity (Passive / Conservative):** "Move it to Advanced" (not
  removed).
- **Tab-follow words:** **Follow / Pinned**.

## What shipped (all verified in Chrome for Testing unless noted)

| Build | Decision | Change |
| --- | --- | --- |
| `.22` | D63 | Size caps follow Chrome's 64 MiB port-message limit: any one string 10 MiB (stylesheet cap folded in), page 60 MiB, 200,000 nodes, depth 256, rule caps follow sizes. `sanitizeCss` about 6× faster (linear passes, differential-tested against the old code on 330,000 inputs). A per-walk memo for the credential-ancestor check. A 135,000-node capture went from 7.1 s to 3.5 s; Wikipedia's Donald Trump article from 6.5 s to 2.3 s. The Falcon 9 launch list (53k nodes), refused before, now mirrors. |
| `.23` | D64 | The three limits are Advanced settings (1–30 MB, 1–60 MB, 1,000–1,000,000; defaults 10 / 60 / 200,000); the panel sends them in the start message, so page and panel agree. Replica fidelity moved to Advanced. |
| `.24` | D65 | Quirks pages mirror in quirks mode: a blank frame with the doctype-free shell written by `document.open/write` (an `srcdoc` document is never in quirks mode). Google's 404 page and a fixture verified. |
| `.25` | D66 | D54-addendum defaults: new installs and resets start set up at Full visible with no setup question, the detached mirror follows the active tab, and the mirror opens at 1:1; the toolbar reads Follow / Pinned. Also fixed: with no safety journal the background's Page-only recovery ceiling could never release at a Full-visible default. A true first run (no journal and no saved preferences) now writes an empty journal instead. |
| `.26` | D67 | Hidden accessible names (label records in always-hidden owned spans) are no longer translated: 593 → 471 Translator calls on the Wikipedia portal. |
| `.27` | D68 | Review T1–T3: a newer snapshot no longer joins a stale translation task; the OCR lock is released before the page translation; unreadable storage keeps OCR off. Unit-tested; the T1 race was not reproduced in the browser. |
| `.28` | D69 | Review L2–L5 and L7: status text is kept as `UiText` (`lib/ui-text.ts`) and re-renders in the current UI language; language names follow the language the UI is shown in; catalogue error details and page-access guidance localize; the error panel re-renders. |

## Found, not fixed (candidates, in rough order of value)

1. **Style polling skips large documents.** The CSSOM-change poll reads at
   most 1 MiB of rule text (25,000 rules) per half-second tick on the page's
   main thread. A document with more (freee, YouTube: about 3 MB) hits
   capacity every time and is never polled, so CSSOM-only changes (no DOM
   mutation) reach the replica only with the next checkpoint. Documented in
   `docs/replica-fidelity.md`. A per-sheet signature (rule count plus sampled
   rules, or `cssRules` identity) would keep polling cheap. Needs a design.
2. **Capture is still O(nodes × depth) in the visibility index.**
   `sourceElementPathIsPainted` walks each element's whole ancestor path
   (about a quarter of the remaining capture time after D63). A memo like
   D63's secret-ancestor memo, keyed per scan, would help. On a 46,000-node
   Wikipedia article the page still blocks 1.2–1.5 s per pass, with
   checkpoint, visibility refresh and semantic scan as separate passes.
3. **Data-URL fonts are dropped.** `passiveUrl` admits `data:image/*` only,
   so `@font-face { src: url(data:font/woff2;base64,…) }` becomes `none`. The
   shell CSP already allows `font-src data:`. Under the truthful-first ruling
   this is worth an owner ruling (inert, often CJK web fonts).
4. **The receiver refuses a whole semantic batch for one bad item**
   (session-close item 5). D62's months-long outage was one such case.
   Dropping only the failing record or proof and logging it would limit the
   damage. It needs care, because proofs can depend on records.
5. **Limited-quirks mode** is not represented (reports `CSS1Compat`, gets the
   standards shell).

## Next work, in order

1. **Low items** (`review-2026-09-22-pr22-bug-hunt.md`): L6, L8, L9, O3, and
   the process items. A build-identity bump
   script would save a step per shipped change: this session bumped five
   files by hand six times. Also default-state tests, and README step 4.
2. **P3–P6** are privacy edge cases written before the truthful-first
   ruling. Bring them to the owner, since some may now be declined.
3. The candidates above, 1–4, each with an owner question where it changes
   behaviour.
4. Publish 0.5.0 as **D70** only when the owner says so. The release-notes
   draft (`handover-2026-09-22-release-readiness.md`) needs lines for
   D51–D69.

## Reproduction and verification

- Harness: `~/.cache/simul-harness/` (memory note `simul-chrome-repro-harness`),
  runnable from the 2026-09-22 scratchpad `harness/` (node_modules, Chrome for
  Testing 153). Serve `~/.cache/simul-harness/site/` with
  `python3 -m http.server 8765`.
- Scripts from this session: `port-limit.mjs`, `page-caps.mjs`,
  `mirror-timing.mjs` (time to replica plus page main-thread blocks via a
  heartbeat), `profile-source.mjs` (CDP CPU profile of the source page),
  `limits-ui.mjs`, `advanced-shot.mjs`, `overlay-top.mjs`, `quirks-probe.mjs`,
  `quirks-check.mjs`, `fresh-defaults.mjs`, `labels-timeline.mjs` (select
  labels through shadow roots), `scope-safety.mjs` (narrow, widen, reset),
  `count-translations.mjs` (counts stand-in Translator calls), `status-smoke.mjs` (status line after a To switch; flags "[object"). The `d63/`
  folder has `run-cap-matrix.sh` (old vs new build table),
  `build-unminified.sh` (profiling build), the profile summarizers, the
  `sanitizeCss` differential and benchmark, `make-cap-pages.py` (the
  `site/big-*.html` pages) and `nas-mirror.sh` (edit its `S=` scratch path
  first).
- Test pages: `site/big-sheet-5mb.html`, `big-sheet-12mb.html`,
  `big-nodes.html` (about 135,000 nodes), `big-text.html`, `big-image.html`,
  `quirks.html`. Real pages: the Falcon 9 launch list, the Donald Trump and
  United States articles, freee, YouTube, Google sign-in and 404, and the
  Wikipedia portal.
- Harness artifacts: the manifest copy makes `<all_urls>` required, so the
  status line reads "The preference service returned an invalid response."
  and a Reset leaves one permission-cleanup entry pending. Neither is a
  product bug. The panel's `[Simul isolated mirror]` stage lines print only
  in development builds. The longtask observer reports nothing in headless
  mode, so use the heartbeat instead.

## Working notes

- Toolchain: `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`.
- Per shipped change: bump `.NN` in `wxt.config.ts`, README (two places),
  `tests/build-identity.test.ts` and `tests/extension-artifact.test.mjs`;
  `npm run artifact:sync && npm run check`; decision log (publish moves to
  the next number); commit; push; PR description (`gh pr view 22 --json body
  -q .body`, edit, `gh pr edit 22 --body-file`); NAS mirror (dry run first,
  read the deletion list; `*.user.toml` excluded).
- Limits are module state (`lib/replica/html-mirror-limits.ts`, live `export
  let` bindings). A test that lowers them must restore them with
  `applyHtmlMirrorLimitSettings()`.
- Owner preferences: no publish prompts; the simplest rule and fewer
  controls; questions go through the question tool with a Notes option;
  multi-step shell work goes in a script file.
