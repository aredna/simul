# Handover: session close, 0.5.0 release candidate on PR #22 (2026-09-22, late)

Chains from `handover-2026-09-22-release-readiness.md`, which keeps the
publish runbook and the release-notes draft; this file records where the day
ended. Decision-log entries **D43** through **D48** (with addenda) hold the
reasoning for everything below.

## Where things stand

| Item | State |
| --- | --- |
| Branch / PR | `feat/ui-string-catalogue`, PR #22, **open, mergeable, twelve commits**, head `febb852`. Description covers D40–D48. |
| Version / identity | `0.5.0` / `0.5.0 beta v.20260922.7` (bumped on every shipped change; next is `.8`). |
| Gate | `npm run check` green at head: typecheck clean, **1,405 tests pass, 1 skipped** (Chrome fixture), `dist/chrome-unpacked` re-synced and byte-verified. No CI by decision. |
| NAS | `Dev/simul/` on the rsync daemon mirrors `febb852` byte for byte (checksum dry-run clean). Load `Dev/simul/dist/chrome-unpacked`; settings must show `Build 0.5.0 beta v.20260922.7`. The temporary bisect folder is gone. |
| `main` | `eb09813` (through D39); its committed build still says `0.4.0 beta v.20260905.1`. |
| Release | `v0.4.0` pre-release only; the Releases page serves an older build than the branch until 0.5.0 is published. |
| Repo | Public, MIT, description in the public voice, PVR / secret scanning / push protection on, Dependabot: no open alerts or PRs. |

## What landed today (one line each)

- **D43** method-toggle aria re-localized; identity bumped on every change; README aligned; public README voice (Build Week origin, on-device, simple install); 0.5.0 numeric version.
- **D44** `<style>` text inside hidden regions is kept (freee.co.jp sign-up modal).
- **D45** computed style and a painted box decide whether a declared-hidden region is withheld (freee footer accordion).
- **D46** page text and image text translate together: enabled OCR counts as intent; switching OCR on asks for the page text.
- **D47** image translation on by default; a reset still clears every grant via the ledger rule; OCR overlays stay opaque per line (owner ruling).
- **D48** a label-based image translation is a caption band along the bottom edge, not a box over the whole picture.

## Open items

1. **freee.co.jp carousel "resized very small after a move"** — not reproduced.
   The picture-vanishing part is explained and fixed (the accessibility label's
   full cover became a caption band, D48); what is left is the owner's
   observation that the image is sometimes tiny. The console readout that
   would pin it was never run; the one-line version sent in a question had a
   syntax error. The version below parses (`node --check`). Run it in the
   panel's DevTools Console (right-click the panel, Inspect, Console) while the
   image is small; it prints the image and each ancestor with size, display,
   opacity and transform, so the shrinking element is the first line whose
   size collapses.

   ```js
   [...document.querySelectorAll('iframe')].map((frame) => {
     const doc = frame.contentDocument;
     const img = doc && doc.querySelector('.kvslide-individual img');
     if (!img) return 'no img';
     const view = doc.defaultView;
     const lines = [];
     for (let el = img; el && el !== doc.documentElement; el = el.parentElement) {
       const style = view.getComputedStyle(el);
       const box = el.getBoundingClientRect();
       lines.push(`${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]} ${Math.round(box.width)}x${Math.round(box.height)} display=${style.display} opacity=${style.opacity} transform=${style.transform.slice(0, 40)}`);
     }
     return lines;
   });
   ```

   Already ruled out from code and served assets: the sanitizer keeps the
   slide `<img src>`; Swiper's inline transforms pass `sanitizeCss`; the Swiper
   stylesheet is retained as a link; the visually-hidden detector only matches
   the sr-only recipe; the CDN serves the images to an extension-style request;
   the sandboxed frame loads images eagerly; nothing in the overlay projector or
   the engine styles the replica image itself. Remaining candidates once the
   readout names the element: a Swiper inline `width` patch on the slide, a
   `selectedImageSource` refresh on a looped duplicate, or the page's own
   responsive rules under the replica viewport.
2. **Publish 0.5.0** — waits for the owner's go. Runbook and release-notes
   draft: `handover-2026-09-22-release-readiness.md`. Log it as **D49**.
3. Unchanged: F6 (memoizing `Intl.DisplayNames`) stays declined;
   `deferred-work.md` holds the 28 research-sized entries.

## Working notes for the next session

- `git fetch origin` and compare `origin/feat/ui-string-catalogue` before
  starting; the tree here is clean at `febb852`.
- Toolchain on the path: `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`.
- Any shipped change: bump `betaBuildSuffix` in `wxt.config.ts` (`.8`), update
  README (two places) and the two identity tests, `npm run artifact:sync`,
  `npm run check`, then mirror the committed tree to the NAS (the exact rsync
  is in the memory note `simul-nas-mirror`; dry-run first).
- PR #22's description is regenerated from a drafted body file with
  `gh pr edit 22 --body-file`; keep it in step with the decision log.
- Owner's standing preferences from today: OCR on by default; page text and
  image text translate together; OCR overlays stay opaque per line but label
  results must not cover the picture; public voice per D43; and when a
  question asks the owner to run a snippet, the snippet goes inside the
  question itself.
