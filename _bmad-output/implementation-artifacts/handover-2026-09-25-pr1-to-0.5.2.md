# Handover: PR #1 (D82–D86) to release 0.5.2 (2026-09-25)

Chains from `handover-2026-09-23-limits-quirks-defaults.md`. Decision-log
entries **D82**–**D86** in `review-2026-09-03-decision-log.md` hold the
reasoning and measurements. The owner closed this session with: *"Create a
handover with any remaining work that needs to be done. Then the next session
we'll do that work and we will submit this pull request and bump the version
number to 0.5.2."*

## Where things stand

| Item | State |
| --- | --- |
| Branch / PR | `fix/hover-menus`, **PR #1** in `aredna/simul`, open and mergeable. Head `b81d036` (plus this handover update). The title and description cover D82–D89. |
| Commits on the branch | `306671c` D82 hover menus · `fae77f8` D83 Reddit styles · `aaedbf3` D84 big pages, one scrollbar · `4d25bb0` D85 pair change, D86 image cache · `107af20` this handover · `b81d036` D87 handover items, D88 Wise, D89 Fastmail. `main` is `4f26a42`. |
| Version / identity | `0.5.1` / `0.5.1 beta v.20260924.6` (the next beta build would be `.7`). |
| Gate | `npm run check` green at `b81d036`: **1,541 tests pass** (the one skipped Chrome-only test was removed with the menu facsimile), and `dist/chrome-unpacked` is byte-verified. |
| NAS | `Dev/simul/` mirrors `b81d036`; the owner loads `Dev/simul/dist/chrome-unpacked`. |
| Release | `v0.5.1` is Latest. The owner has asked for PR #1 to be submitted and the version bumped to **0.5.2** next session (see the release steps below). |

## What this PR carries (owner reports, all fixed and verified in Chrome for Testing)

- **D82: hover menus.** CSS `:hover` menus in page headers open in the
  mirror, from either side. The owner confirmed it works on their bank.
- **D83: Reddit styles.**
  - An escaped `\'` in Tailwind class names made the CSS scanners reject
    Reddit's whole 237 KB sheet.
  - Chrome's CSSOM drops `font:var(--x)` when a later declaration in the
    same rule sets a longhand. A `<style>` now sends its own text when that
    text matches the CSSOM.
  - `:defined` state is carried across: the replica registers empty
    Simul-owned classes for the elements the page has defined (approved by
    the owner).
- **D84: big pages, scroll bars, Auto-detect.**
  - Adopted stylesheets were sent once per shadow root: Reddit's feed turned
    0.34 MB of CSS into 23 MB, the mirror stopped following, and threads
    failed with "could not be prepared". Each distinct sheet is now sent and
    counted once per message.
  - The panel crops the replica frame's own scroll bar (there were two in
    Fit mode).
  - The From menu shows the detected language, for example `[A] English`.
- **D85: pair changes.** Picking a pair whose pack is not installed now
  starts translating (the choice is the click Chrome needs). A page
  translation waiting for a pack resumes when any part of the panel installs
  it.
- **D86: image cache.** A whole-image OCR result is kept by the image itself
  (its address, natural and rendered size, fit, pair and settings). Carousel
  slides and images scrolled back into view reuse it without a new capture.

## Update, second 2026-09-25 session (D87–D89)

The owner said "Fix those items, also look at wise.com" (the side navigation
of the signed-in pages lands down and to the right and jumps off screen on
scroll) and "For fastmail.com the logo in the top right is a small icon and
does not show up." Done, in `b81d036`, and verified in Chrome for Testing
except where noted:

- **Item 1 done (D87):** Chrome's video play bar is hidden in the document
  and in every replica shadow root.
- **Item 2 not done (D87):** it could not be measured. The archived Reddit
  pages no longer run Reddit's scripts here (headless Chrome aborts the
  `redditstatic.com` bundles), so there are no adopted sheets to test
  against. Still documented in `docs/replica-fidelity.md`.
- **Item 3 done (D87):** a confirmed no-text image is kept by the image
  itself (unit-tested; not yet seen on the bank carousel).
- **Item 4 done (D87):** `statusPairNeedsPack` removed.
- **Wise (D88):** large stylesheets are watched by their shape, so style
  polling works on pages carrying one (Wise's 2.4 M character design system
  had switched it off, and rules added later never reached the mirror). ARIA
  menus and listboxes are now page content with the page's styles, inline
  position and images (the Wise currency dropdown drew as a plain list); the
  mirror's own ARIA preview opens the page's menu in place. The signed-in
  side navigation itself is unverified; the owner's second readout could not
  be run.
- **Fastmail (D89):** its avatar CDN answers 403 without
  `Origin: https://app.fastmail.com`. An image the mirror cannot fetch
  (`crossorigin` up to 512 x 512, `blob:` up to 2048 x 2048) now travels as
  the pixels the page decoded. Unverified on the signed-in app.

The owner checks below now include Wise and Fastmail. Harness scripts from
this session are in `~/.cache/simul-harness/d87/` (see the memory
`simul-chrome-repro-harness`).

## Remaining work before the release (as written by the first session)

These came out of the first session's reports. Items 1, 3 and 4 are done;
item 2 is documented as not done (see above). Item 5 remains.

1. **Hide Chrome's native video controls in the mirror** (found in D83). A
   frame without scripts gets Chrome's own play bar on every `<video>`; the
   mirror cannot play video, so the bar only misleads. On Reddit the video is
   inside a shadow root, so a document-level rule does not reach it. Add
   `video::-webkit-media-controls{display:none!important}` (and the overlay
   play button) to the shell style and to each replica shadow root. Keep it
   separate from the owned adopted-style elements, because an adopted-style
   patch replaces those (`isolated-html-engine.ts`, `appendOwnedAdoptedStyles`
   and the adopted-style patch path around line 3134). Test: a shadow-root
   video in an engine fixture keeps the rule through an adopted-style patch.
2. **Buttons inside shadow roots lose their font** (D83 known gap). A rule in
   an adopted sheet whose `var()` shorthand Chrome's CSSOM drops (Reddit's
   `.button` in `shreddit-async-loader` and others) cannot be recovered from
   its own sheet. Possible fix: while recovering a `<style>` element's text
   (`readStyleElementSourceText`), keep a per-document map from each lossy
   rule's CSSOM text to its original text, then repair identical lossy rules
   in adopted sheets. Measure first with `lossy-rules.mjs` (3 lossy rules on
   the home feed). If it is not clean, leave it documented.
3. **Cache "no text" outcomes by image identity** (D86 known gap). An image
   read whole with no readable text is captured and read again every time it
   returns (one carousel slide on the owner's bank login page). Keep a
   confirmed-empty whole-image outcome in the same identity cache and settle
   the job without a capture. Only do this after the empty result has been
   confirmed, as today's retry does; a slide caught mid-transition must not
   hide real text.
4. **Remove the now-unused `statusPairNeedsPack` string** from
   `lib/companion-ui-strings.ts` (D85 left it unused), unless a catalogue
   test needs it.
5. **Owner checks on real pages.** This machine cannot reach them, so ask
   the owner for these, each with a screenshot or console readout if it
   fails (see memory `questions-carry-their-snippets`):
   - **Live Reddit (D83/D84).** Feed scroll-following after infinite scroll;
     opening a thread (bug 4) from the feed and by direct link; Fit mode
     showing one scroll bar; the From menu reading `[A] English`. If
     opening a thread still fails, record the exact message. Thread
     navigation itself (single-page vs full load, activeTab after a
     same-origin navigation) was not reproduced here.
   - **Language packs (D85).** Switch to a language never used before and
     check that the page and image text change without a refresh.
   - **Image cache (D86, D87).** On the bank's login-page carousel, and while
     scrolling a long page, overlays should come back at once, and the slide
     without text should not flash "processing" when it returns.
   - **Wise, signed in (D88).** The side navigation stays at the left and
     stays put while scrolling; account and currency menus look like the
     page. If the sidebar still moves, run the two readouts from this
     session (which sheets place `.sidebar-container` on the page, and its
     computed position inside the mirror) and record them.
   - **Fastmail, signed in (D89).** The small account icon at the top right
     shows in the mirror.
   - **Any Reddit video (D87).** No play bar over the poster.

## Releasing 0.5.2 (after the work above)

The owner asked for this. Per `publish-only-when-owner-says`, the merge and
the version bump are requested; a **GitHub release** was not named. If the
owner does not say to publish one, stop after the tag and the NAS mirror,
and say so plainly instead of asking.

1. Branch state: everything committed on `fix/hover-menus`, gate green.
2. **Version 0.5.2** (D79 shows the 0.5.1 bump):
   - `package.json` and `package-lock.json` (both top-level `version`
     fields).
   - `THIRD_PARTY_NOTICES.md` line 8 ("the Simul 0.5.1 extension artifact").
     The `dist/` copy follows through `npm run artifact:sync`.
   - `tests/build-identity.test.ts` (`version:` fields) and
     `tests/extension-artifact.test.mjs` (`manifest.version`).
   - Restart the build identity on the release date: `betaBuildSuffix` in
     `wxt.config.ts` becomes `beta v.<YYYYMMDD>.1`, and the same string goes
     into the two identity tests. `npm run bump-build` only increments, so
     edit by hand, then `grep -rn "0\.5\.1" --exclude-dir=node_modules
     --exclude-dir=dist --exclude-dir=_bmad-output .` should come back
     empty.
3. **Release notes**: `_bmad-output/implementation-artifacts/release-notes-0.5.2.md`,
   in the owner's voice (memory `simul-public-messaging`): what changed for
   a reader (hover menus, Reddit and other big web-component pages, a single
   scroll bar, the detected language in the From menu, language changes
   that translate at once, faster image translation when images return,
   menus and dropdowns drawn as the page draws them, images from signed-in
   apps such as account avatars, no video play bars),
   then requirements and install, as in `release-notes-0.5.1.md`. **Never
   name the owner's bank.**
4. `npm run artifact:sync && npm run check` in the background. Read the
   `exit=` and `Tests` lines before claiming green (memory
   `simul-toolchain-on-linux`).
5. Decision-log entry **D90** (the release; D87–D89 are this session's
   fixes), then commit, push, and update the PR description's Gate line.
6. **Redaction scan before anything public**: grep the whole diff, commit
   messages and PR text for the bank's name, the NAS address, rsync details
   and other projects (D80's list). The earlier D82–D86 texts were written
   without them.
7. Merge PR #1 with a **rebase merge** (the method used for #22 and #23), delete
   the branch, then add an annotated tag `v0.5.2` at the merge head. Use
   plain `git`/`gh` (memory `simul-git-standing-commands`). Never
   force-push.
8. Publish the GitHub release only if the owner says so. As in D79 it would
   be "Simul 0.5.2 beta (v.<date>.1)", with
   `git archive v0.5.2:dist/chrome-unpacked` zipped as
   `simul-0.5.2-chrome-unpacked.zip`, marked Latest.
9. Mirror `main` to the NAS (memory `simul-nas-mirror`: dry run first, read
   the deletion list).

## Still open from earlier handovers (not touched this session)

From `handover-2026-09-23-limits-quirks-defaults.md`, "Found, not fixed" and
"Next work". None blocks 0.5.2.

- Default-state tests (G1, G2 and rollback at the shipped defaults).
- Capture performance: memoize the visibility index's painted-path check
  per scan (O(nodes × depth)).
- Style polling skips documents over 1 MiB of rules (needs a design).
- The receiver refuses a whole semantic batch for one bad item (needs a
  design).
- Limited-quirks mode is not represented.
- The overlay element is visible to sibling-counting page CSS.
- "Mirror follows" duplicates the toolbar's Follow / Pinned button (a
  simplification to bring to the owner).
- Credential fields show no dots (only if the owner reports it).
- The ARIA menu facsimile drops page styles.
- A `<select role="combobox">` is never an eligible select.

## Smaller notes from this session

- `:defined` state (D83) refreshes only when an element is re-serialized. An
  element the page defines later, whose upgrade changes nothing the mirror
  sees, stays undefined in the mirror until the next rebuild.
- The adopted-sheet wire table (D84) is per message, so infinite scroll
  resends a batch's sheets once per patch. A session-level table would save
  more, but it adds state; do it only if patch sizes become a problem.
- On macOS, overlay scroll bars take no gutter, so nothing is cropped (D84).
  The frame's overlay bar may still flash while the panel scrolls it.
  Unverified.

## Reproduction and verification

- **Harness scripts** from this session are in `~/.cache/simul-harness/d83/`,
  `d84/` and `d85/`; memory `simul-chrome-repro-harness` explains them.
  Run them from a scratch folder whose `node_modules` links to the
  2026-09-22 scratchpad's `harness/node_modules`, and edit `copybuild.py`'s
  output folder first.
- **Reddit** blocks this machine's headless Chrome. Use Wayback raw
  snapshots (`web.archive.org/web/<ts>id_/https://www.reddit.com/…`, a large
  one from the CDX API), gunzip them, add `<meta charset="utf-8">`, and serve
  them with `python3 -m http.server`. Reddit's own scripts then run.
  `big-feed.mjs` / `live-feed.mjs` grow the feed by cloning posts.
- **Development builds** go to `.output/chrome-mv3-dev`, not `chrome-mv3`.
  `CAPTURE_INFO=1` records every image diagnostic (the Options log keeps
  only 48). `CHROME_LIKE=1 PREDOWNLOADED=en:ja` makes the stand-in
  translator need a click for new packs, as Chrome does.
