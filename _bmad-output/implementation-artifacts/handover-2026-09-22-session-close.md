# Handover: session close, 0.5.0 release candidate on PR #22 (2026-09-22, late)

Chains from `handover-2026-09-22-release-readiness.md`, which keeps the
publish runbook and the release-notes draft; this file records where the day
ended. Decision-log entries **D43** through **D55** (with addenda) hold the
reasoning for everything below. Updated at the end of the late session that
produced the bug-hunt review (`review-2026-09-22-pr22-bug-hunt.md`) and
D51–D54, then for D55 (first bug-hunt report).

## Where things stand

| Item | State |
| --- | --- |
| Branch / PR | `feat/ui-string-catalogue`, PR #22, **open, twenty-five commits**, head is the D55 commit (`.14`). Description covers D40–D55. The owner keeps it open while they use the build and hunt bugs. |
| Version / identity | `0.5.0` / `0.5.0 beta v.20260922.14` (bumped on every shipped change; next is `.15`). |
| Gate | `npm run check` green at head: typecheck clean, **1,428 tests pass, 1 skipped** (Chrome fixture), `dist/chrome-unpacked` re-synced and byte-verified. No CI by decision. |
| NAS | `Dev/simul/` on the rsync daemon mirrors the head commit (checksum dry-run clean). Load `Dev/simul/dist/chrome-unpacked`; settings must show `Build 0.5.0 beta v.20260922.14`. |
| `main` | `eb09813` (through D39); its committed build still says `0.4.0 beta v.20260905.1`. |
| Release | `v0.4.0` pre-release only; the Releases page serves an older build than the branch until 0.5.0 is published. |
| Repo | Public, MIT, description in the public voice, PVR / secret scanning / push protection on, Dependabot: no open alerts or PRs. |

## What landed (one line each)

- **D43** method-toggle aria re-localized; identity bumped on every change; README aligned; public README voice (Build Week origin, on-device, simple install); 0.5.0 numeric version.
- **D44** `<style>` text inside hidden regions is kept (freee.co.jp sign-up modal).
- **D45** computed style and a painted box decide whether a declared-hidden region is withheld (freee footer accordion).
- **D46** page text and image text translate together: enabled OCR counts as intent; switching OCR on asks for the page text.
- **D47** image translation on by default; a reset still clears every grant via the ledger rule; OCR overlays stay opaque per line (owner ruling).
- **D48** a label-based image translation is a caption band along the bottom edge, not a box over the whole picture.
- **D49** a region that stateless controls reference with `aria-controls` (Swiper's previous/next buttons and its slide wrapper) is readable page content; a stateful control or a tab relation still withholds it. Found by the carousel readout: Swiper's accessibility module made the whole freee.co.jp slide wrapper a withheld region from the moment it initialised.
- **D50** a class or style that flips twice in one observer batch on a region holding only activation controls (links, buttons, `role=button`) is ordinary churn, not a masking transition; the sticky credential rule now needs a value-bearing control in the region. Found by driving the source session with Swiper's real move records: every move had turned the active/next/prev slides, the wrapper and the bullets into permanent opaque placeholders, which is what the owner saw as "shrinks and goes away".

## What landed late (bug-hunt review)

- **D51 (.10)** read-scope toggle descriptions survive localization passes.
- **D52 (.11)** image overlays clipped to what the page shows, hidden while
  the image is unpainted, and following slide motion (the "text outside the
  image" carousel report). **Owner to confirm on freee.co.jp.**
- **D53 (.12)** a pending reset cannot re-adopt `<all_urls>`; the toolbar OCR
  button turns OCR off after a refusal; docs for alt captions after setup.
- **D54 (.13)** declared-hidden and stateless-controlled regions need a really
  painted box again (P1, P2).
- **D55 (.14)** the mirror follows the source only when the source moves; a
  re-reported unchanged position (image load, resize, checkpoint) no longer
  throws away the reader's mirror scrolling. Present since at least 0.3.3.
  The same session investigated "images no longer get their text": no code
  regression found (`.10` = `.13` in Chrome for Testing); the owner's log shows
  captures deferred because the images were not on screen in the source tab.
  Waiting for the owner's check (see D55).
- Owner rulings: the broad grant keeps the one simple rule (G2, no change);
  alt-text captions stay on after setup (G4, docs only).

## Open items

1. **Owner is using the `.14` build and hunting bugs.** Check the carousel
   overlay (D52) on freee.co.jp, and whether image text appears when the
   source tab itself shows the image (D55).
2. **Rest of the review** (`review-2026-09-22-pr22-bug-hunt.md`): L2–L9
   (status-line re-localization, language names, error details, guidance
   strings, placeholders, a11y lang), T1–T3, O3, P3–P6, and the process items
   (single-source build identity, default-state tests, README step 4).
3. **Queued after the bug hunt (owner rulings, D54 addendum):**
   - default read scope Full visible, and the user can reduce it (no forced
     setup question);
   - tab follow defaults to `active`, with two clearer words than
     Active/Current (candidates in D54 addendum);
   - mirror size defaults to 1:1;
   - most toolbar buttons stay (the owner reviews them one by one). The rest of
     the simplification proposal (R1, R7, R8, R9, R12, R13) is still a
     proposal.
4. **Publish 0.5.0** — only when the owner says it is ready, in their own
   words; do not ask. Runbook and release-notes draft:
   `handover-2026-09-22-release-readiness.md`. Log it as **D56** (D55 is the
   scroll fix). The release-notes draft predates D51–D55 and should gain one
   line for them.
5. Unchanged: F6 (memoizing `Intl.DisplayNames`) stays declined;
   `deferred-work.md` holds the 28 research-sized entries.

## Working notes for the next session

- `git fetch origin` and compare `origin/feat/ui-string-catalogue` before
  starting; the tree here is clean at the D55 commit.
- Toolchain on the path: `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`.
- Any shipped change: bump `betaBuildSuffix` in `wxt.config.ts` (`.15`), update
  README (two places) and the two identity tests, `npm run artifact:sync`,
  `npm run check`, then mirror the committed tree to the NAS (the exact rsync
  is in the memory note `simul-nas-mirror`; dry-run first).
- PR #22's description is edited with `gh pr edit 22 --body-file` from the
  current body (`gh pr view 22 --json body -q .body`); keep it in step with the
  decision log.
- `grep` on this machine is ugrep: minified or non-ASCII files need `-a`, and
  bounded `.{0,N}` patterns fail on them; use python for context extraction.
- Owner's standing preferences from today: no publish prompts (they announce
  readiness); OCR on by default; page text and
  image text translate together; OCR overlays stay opaque per line but label
  results must not cover the picture; public voice per D43; a snippet the owner
  must run goes inside the question itself, and a long one is also printed in
  the chat message right before the question (the question dialog truncated a
  35-line one).
