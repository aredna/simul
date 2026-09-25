# Handover: the open items after 0.5.2 (2026-09-25)

Chains from `handover-2026-09-25-pr1-to-0.5.2.md` and
`handover-2026-09-23-limits-quirks-defaults.md`. The owner released 0.5.2
(D90) and then said: "Go ahead and work on the open items." Decision-log
entries **D91**–**D99** in `review-2026-09-03-decision-log.md` hold the
reasoning and measurements.

## Where things stand

| Item | State |
| --- | --- |
| Branch / PR | `fix/open-items`, **PR #2** in `aredna/simul`, open and mergeable, title and description cover D91–D99. `main` is `7068be3` (v0.5.2). |
| Version / identity | `0.5.2` / `0.5.2 beta v.20260925.8` (the next build is `.9`). |
| Gate | `npm run check` green at `c8ca056`: **1,554 tests pass**, `dist/chrome-unpacked` byte-verified. |
| NAS | `Dev/simul/` mirrors this handover commit. Most builds this session renamed the side-panel chunk, so reload only after Synology Drive finishes syncing (see memory `simul-nas-mirror`). |
| Release | v0.5.2 is Latest. Nothing new is published; wait for the owner. |

## Owner decisions this session

Asked before the work started (one question each):

- **"Mirror follows" in Settings:** remove it (the toolbar button does the
  same). Done, D91.
- **Credential fields:** draw the dots the page draws; only the count may
  travel. Done, D91.
- **Image overlays and sibling-counting CSS:** "Change it now", accepting
  per-site trade-offs. Done, D92.

## What shipped (verified in Chrome for Testing unless noted)

| Build | Decision | Change |
| --- | --- | --- |
| `.2` | D91 | "Mirror follows" removed from Settings. Password, card-number and one-time-code fields show one dot per character (a `masked-length` proof carries only the count, capped at 256, under form values). |
| `.3` | D92 | Image overlays live in a closed Simul-owned shadow root on the image's parent (after a slot), so `img + p`, `:nth-child` and `:last-child` rules no longer change in the mirror. Links, pictures, figures and list items keep the old placement. |
| (tests) | D93 | Default-state versions of the G2 and rollback tests (image text on). No product change. |
| `.4` | D94 | The painted-path and credential-ancestor checks read each element once per scan. Longest page pause on a 23,000-element article: about 1,010 ms to 900 ms. |
| `.5` | D95 | Style polling survives many medium sheets that together pass the budget (they are watched by their shape). Unit-tested; real sites were already covered by D88. |
| `.6` | D96 | The semantic receiver drops a refused record or proof by itself; only a broken stream refuses the batch. Development builds log drops; none on five real sites. |
| `.7` | D97 | Limited-quirks pages (XHTML 1.0 / HTML 4.01 Transitional and Frameset) mirror in limited-quirks mode. |
| `.8` | D98 | `<select role="combobox">` reads like a plain select. |
| (none) | D99 | Adopted-sheet `var()` shorthands (Reddit's shadow-root buttons): Chrome keeps no readable trace; the gap stays documented. |

## Owner checks on real pages

This machine cannot reach the owner's signed-in pages. Worth a look after
the Drive sync, each with a screenshot if something looks wrong:

- **Settings > Window behavior** shows only "Toolbar opens"; the toolbar's
  Follow / Pinned button still switches following.
- **A sign-in form** (the bank's login page, a card form): typing a password
  or card number shows the same number of dots in the mirror.
- **Image translations** on the bank's login carousel and on a page with
  pop-ups: translations still sit on their images, pop-ups still cover them,
  and text next to images keeps its look.
- **Dropdowns and menus** still translate and open as before (D96 changed
  how the receiver treats a batch with one bad item).
- **An older site** with an XHTML Transitional doctype, if the owner uses
  one: no extra gaps under images in tables.

## Still open

- **Visibility refresh cost.** D94's "found, not fixed" note (two full scans
  as the mirror starts) was a misreading: the second scan is the first
  mutation flush. By design (the comments in
  `source-visibility-boundary.ts`), every attribute, text or child-list
  mutation triggers a whole-document paint-index comparison, because `:has()`
  and sibling selectors can reveal text anywhere. About 155 ms per flush on
  the 23,000-element article. Reducing it needs a design (for example,
  scoping by the stylesheets' selector surface).
- **Adopted-sheet `var()` shorthands** (D99): not recoverable without
  page-world access.
- **From the earlier handovers, unchanged:** P3–P6 wait until they become
  real issues (owner); `:defined` state refreshes only on re-serialization;
  the adopted-sheet wire table is per message; macOS overlay scroll bars are
  unverified.
- **Sibling rules in fallback parents** (D92): `figure img + figcaption` and
  similar still see the overlay, because a `figure`, link or list item cannot
  host a shadow root.

## Reproduction and verification

- Harness scripts from this session are in `~/.cache/simul-harness/d91/`
  (with `site/`): `dots.mjs` (credential fields), `overlay-placement.mjs`
  (finds overlays in closed shadow roots through CDP, sibling styles,
  carousel clipping), `timing-compare.py` (alternates builds through
  `mirror-timing.mjs`), `prof-top.mjs` (self and inclusive time from a CPU
  profile), `drops.mjs` (semantic drops per page, development build),
  `modes.mjs` (compat mode, doctype and table height), `select-labels2.mjs`
  (facsimile labels after translating), `typedom.mjs` (the D99 probe),
  `build-unminified.sh` (profiling build). Run them from a scratch folder with
  a `node_modules` symlink to the 2026-09-22 scratchpad's
  `harness/node_modules`, and edit `copybuild.py`'s OUT and
  `build-unminified.sh`'s paths first. Serve `site/` with
  `python3 -m http.server 8791 --bind 127.0.0.1`.
- Page JS cannot reach a closed shadow root, so since D92 an overlay is found
  with CDP `DOM.getDocument({ depth: -1, pierce: true })`, or in tests with
  `findImageOverlays`.
