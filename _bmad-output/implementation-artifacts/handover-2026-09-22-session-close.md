# Handover: session close, 0.5.0 release candidate on PR #22 (2026-09-22, late)

Chains from `handover-2026-09-22-release-readiness.md`, which keeps the
publish runbook and the release-notes draft; this file records where the day
ended. Decision-log entries **D43** through **D49** (with addenda) hold the
reasoning for everything below. Updated at the end of the evening session
that produced D49 and D50.

## Where things stand

| Item | State |
| --- | --- |
| Branch / PR | `feat/ui-string-catalogue`, PR #22, **open, mergeable, fifteen commits**, head = the D50 commit ("fix(replica): a class flip on a region of links and buttons is not a masking transition"). Description covers D40–D50. |
| Version / identity | `0.5.0` / `0.5.0 beta v.20260922.9` (bumped on every shipped change; next is `.10`). |
| Gate | `npm run check` green at head: typecheck clean, **1,415 tests pass, 1 skipped** (Chrome fixture), `dist/chrome-unpacked` re-synced and byte-verified. No CI by decision. |
| NAS | `Dev/simul/` on the rsync daemon mirrors the D50 commit (checksum dry-run clean). Load `Dev/simul/dist/chrome-unpacked`; settings must show `Build 0.5.0 beta v.20260922.9`. |
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

## Open items

1. **freee.co.jp carousel: confirm D49 + D50 with the `.9` build.** Load the
   NAS copy, reload the extension card and the tab, reopen the companion, and
   watch the top carousel through several automatic slide changes (every 5 s)
   and after **Rebuild mirror**: the two text slides keep their text, the
   picture slide its picture, and the three pagination circles stay put with
   the blue one moving. The owner reported after `.8`: "as soon as the first
   move happens ... it shrinks and goes away", the deactivated circle vanishes
   on each move, "the circles also move to the top of the window and the
   blank space remains"; D50 explains all of that (the elements became opaque
   placeholders). If anything still goes wrong, run this in the panel's
   DevTools Console (right-click the panel, Inspect, Console) while it looks
   wrong; it prints the carousel's replica subtree with sizes, text, image
   sources and Simul's own markers. Note the owner could not run the earlier
   readouts from the question dialog (truncated); print the snippet in the
   chat message as well, and keep it short.

   ```js
[...document.querySelectorAll('iframe')].map((frame) => {
  const doc = frame.contentDocument;
  const root = doc && doc.querySelector('.kv-carousel');
  if (!root) return 'no carousel';
  const lines = [];
  const walk = (el, depth) => {
    const b = el.getBoundingClientRect();
    const marks = [...el.attributes].filter((a) => a.name.startsWith('data-simul') || a.name === 'aria-hidden' || a.name === 'hidden').map((a) => `${a.name}=${a.value}`).join(' ');
    const src = el.tagName === 'IMG' ? ` src=${(el.currentSrc || el.src || '(none)').slice(-40)} nat=${el.naturalWidth}x${el.naturalHeight}` : '';
    lines.push(`${'  '.repeat(depth)}${el.tagName.toLowerCase()}.${String(el.className || '').split(' ').slice(0, 2).join('.')} ${Math.round(b.width)}x${Math.round(b.height)} text=${JSON.stringify((el.textContent || '').trim().slice(0, 20))}${src} ${marks}`);
    if (depth < 6) for (const child of el.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return lines.join('\n');
}).join('\n');
   ```

   Reproduction without a browser: `tests/carousel-move-patches.test.ts`
   drives `HtmlMirrorSourceSession` with Swiper's real move records; extend
   its fixture if a new symptom appears rather than asking for readouts first.
2. **Publish 0.5.0** — waits for the owner's go. Runbook and release-notes
   draft (now with the carousel bullet): `handover-2026-09-22-release-readiness.md`.
   Log it as **D51**.
3. Unchanged: F6 (memoizing `Intl.DisplayNames`) stays declined;
   `deferred-work.md` holds the 28 research-sized entries.

## Working notes for the next session

- `git fetch origin` and compare `origin/feat/ui-string-catalogue` before
  starting; the tree here is clean at the D49 commit.
- Toolchain on the path: `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`.
- Any shipped change: bump `betaBuildSuffix` in `wxt.config.ts` (`.10`), update
  README (two places) and the two identity tests, `npm run artifact:sync`,
  `npm run check`, then mirror the committed tree to the NAS (the exact rsync
  is in the memory note `simul-nas-mirror`; dry-run first).
- PR #22's description is edited with `gh pr edit 22 --body-file` from the
  current body (`gh pr view 22 --json body -q .body`); keep it in step with the
  decision log.
- `grep` on this machine is ugrep: minified or non-ASCII files need `-a`, and
  bounded `.{0,N}` patterns fail on them; use python for context extraction.
- Owner's standing preferences from today: OCR on by default; page text and
  image text translate together; OCR overlays stay opaque per line but label
  results must not cover the picture; public voice per D43; a snippet the owner
  must run goes inside the question itself, and a long one is also printed in
  the chat message right before the question (the question dialog truncated a
  35-line one).
