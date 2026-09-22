# Handover: bug hunt on the `.14` build, PR #22 (2026-09-23)

Chains from `handover-2026-09-22-session-close.md` (which chains from
`handover-2026-09-22-release-readiness.md`, holding the publish runbook and the
release-notes draft). This file records the session that shipped **D55** and
the three owner reports that are still open. Decision-log entries **D43**
through **D55** hold the reasoning.

## Where things stand

| Item | State |
| --- | --- |
| Branch / PR | `feat/ui-string-catalogue`, PR #22, **open**, head `1fe18b4` (D55). Description covers D40–D55. |
| Version / identity | `0.5.0` / `0.5.0 beta v.20260922.14` (bumped on every shipped change; next is `.15`). |
| Gate | `npm run check` green at head: typecheck clean, **1,428 tests pass, 1 skipped**, `dist/chrome-unpacked` re-synced and byte-verified. |
| NAS | `Dev/simul/` mirrors `1fe18b4` (checksum dry-run clean). Load `Dev/simul/dist/chrome-unpacked`; settings must show `Build 0.5.0 beta v.20260922.14`. |
| `main` | `eb09813` (through D39). Release: `v0.4.0` pre-release only. Publishing 0.5.0 is **D56**, and only when the owner says so. |

## What this session shipped

- **D55 (`.14`)** — the mirror follows the source scroll only when the source
  actually moves. The source re-posts its unchanged position after every
  layout change (image load or error, font load, `html`/`body` resize, hash
  change) and after each checkpoint; the panel re-applied each packet and
  discarded the reader's own scrolling. `followSourceScroll` now ignores a
  repeat, `resetSourceScroll` forgets it (new page, navigation), and the
  sync-scroll toggle passes `force` to re-align. Present since at least 0.3.3,
  so it is not a PR #22 regression.
- **Image-text report investigated, no code change** — see D55's second half.
  `.10` and `.13` behave identically in Chrome for Testing across a
  14-structure page and four live sites; the owner's Image diagnostics log
  showed `capture deferred: reason=hidden` and `visibility=background`. Pixel
  OCR reads a screenshot of the source tab (`captureVisibleTab`), so only
  images on screen **in the tab** can be read. The owner confirmed on `.14`:
  scrolling the web page itself so the image is fully on screen does make its
  text appear.

## Open owner reports (next session starts here)

### 1. Read the whole page's images when it loads (owner request, needs a design decision)

Owner's words: *"I don't think there's images that are only on screen in the
mirror, but we should go ahead and do the entire web page at once when it
loads. We can do processing in the background."*

Today `ImageScanScheduler` gates on the source viewport (`visible`, `near`,
`background` tiers; `background` is skipped unless the scan policy is
`eager-all`), and `PixelAcquisitionCoordinator` can only read what a
`captureVisibleTab` screenshot contains, deferring everything else with
`reason=hidden` (`lib/ocr/pixel-acquisition.ts`, `#acquire`). Scheduling every
image eagerly therefore is **not enough on its own**: off-screen images would
queue and defer forever.

Pixel sources to weigh (a ruling is needed before coding):

- **Fetch the image file in the extension** (host permission already exists,
  and Passive fidelity already lets the replica request image URLs), decode it
  in the offscreen document and OCR the decoded bitmap. Reads every `<img>`
  regardless of the viewport, and costs one request plus one OCR per image.
  Limits: text the page paints *over* an image is not in the file; CSS
  background images and `<canvas>` need separate handling; cookies/credentials
  on those requests need a deliberate choice (`credentials: 'omit'`).
- **Reuse the replica's own loaded images** — no new request, but a cross-origin
  image taints the canvas, so pixels cannot be read back. Only viable with a
  fetch fallback, so it is not simpler.
- **Do not change the pixel source; only widen scheduling** — cheap, but does
  nothing for images the tab never showed, which is exactly the case reported.

Recommendation: the fetch path, with the work queued at a low priority after
the visible images, and the existing recognition/final caches keyed as today so
a rebuild does not redo it. Also check `MIN_CAPTURE_INTERVAL_MS` and the
scheduler's concurrency before turning a whole page loose.

### 2. The mirror jumps to the top when the carousel advances (new bug, root cause narrowed)

Owner's words: *"when the top image carousel scrolls, we redraw the screen from
the top and it kind of jumps back to the top and then scrolls back to the same
place. It shouldn't be doing that, and it didn't used to do that in old
versions."*

Measured on freee.co.jp in Chrome for Testing (40 s, companion open, source
tab untouched), counting committed replica roots:

| Build | Replica rebuilds in 40 s |
| --- | --- |
| 0.3.3 (`9c4c6c6`), 0.4.0, `main` | 2 |
| `.2` (D43), `.4` (D45), `.6` (D47), `.8` (D49) | 2–3 |
| **`.9` (D50, `8243ab0`)** | **9–10** |
| `.10`, `.13`, `.14` | 10 |

So **D50 introduced the storm**, which matches "it didn't used to do that".
With the dev build the engine reports `recovery/privacy_rejected` ten times in
the same 40 s: `IsolatedHtmlReplicaEngine.#applyLivePatch` gets `undefined`
back from `applyPatchBatch` and requests a full recovery
(`lib/replica/isolated-html-engine.ts:795-808`), which rebuilds the replica
from a new checkpoint — that is the redraw. D55 restores the reader's scroll
position onto the new scroller afterwards, which is the "scrolls back to the
same place" half; the jump itself is the rebuild.

Next steps: instrument `applyPatchBatch` (`lib/replica/isolated-html-engine.ts`)
to report which operation it refuses on a Swiper move, and compare `.8` with
`.9` on the same records — `tests/carousel-move-patches.test.ts` already drives
the source session with Swiper's real move records and is the natural place to
reproduce it in a test. Before D50 the carousel regions were rebuilt as opaque
placeholders (the owner's older "shrinks and goes away" report), which is
probably why no patch was refused then. Fixing this should also stop the OCR
churn: each rebuild invalidates the image final cache (the owner's log showed
`entries=0`, `purges=7`).

### 3. Carousel images and buttons show no text (new bug)

Owner's words: *"the images in the carousel are not having all the text show up
on top of them. For the very first image in the carousel, we do not have text
on top of the image, and we do not have any text shown on top of the buttons."*

Two distinct halves, both unverified:

- **No text over the carousel images.** In this session's harness, carousel
  slides never got OCR text in any build (`.10` and `.13` alike): a moving
  slide fails the stability check (`before`/`after` measure must match) and a
  partially clipped slide fails `hasSafeCaptureGeometry` (`clipsImage`), so the
  capture defers and the label-based caption band (D48) is all that lands.
  Report 2's rebuild storm makes it worse. Check whether the first slide is
  read while the carousel is paused, and whether the caption band is what the
  owner sees as "no text".
- **No text on the buttons.** This is replica text, not OCR. Likely the read
  scope: a fresh profile is **Page only**, which withholds control labels and
  control images, and the owner's queued ruling is to default to **Full
  visible** (D54 addendum). Check the owner's actual Read profile first; then
  see whether D49/D50/D54's controlled-region rules withhold the carousel's
  buttons.

## Reproduction harness (built this session)

No Chrome is installed on this box; Chrome for Testing runs the real extension
headless. Scripts are kept at `~/.cache/simul-harness/` (they were written in a
session scratchpad, so treat that copy as the durable one) and the recipe is in
the memory note `simul-chrome-repro-harness`:

- `ext-harness.mjs` — launch, find the service worker, open the source page,
  open the detached companion
  (`sidepanel.html?sourceTabId=…&sourceWindowId=…` via `chrome.windows.create`
  in the worker), and inject a stand-in `Translator` (Chrome's is only
  "downloadable" here, so nothing translates without it).
- `extract_builds.py` / `copy_build.py` — put any committed build (or a local
  `wxt build`) in `builds/<name>/dist/chrome-unpacked` with
  `host_permissions: ["<all_urls>"]` added so nothing prompts.
- `scroll-test.mjs`, `scroll-trace.mjs` — reproduce the D55 snap-back and log
  every write to the mirror's scroller with a stack.
- `rebuild-count.mjs`, `replica-codes.mjs` — count replica rebuilds and print
  the engine's stage/code diagnostics (needs a `--mode development` build).
- `structures-test.mjs` + `site/structures.html` — 14 image structures with an
  optional autoplaying carousel; reports per-cell overlay state.
- `compare-builds.mjs`, `run-source-probe.mjs`, `run-replica-probe.mjs` — live
  sites: overlay coverage per build, and the D52 clipping/paint checks measured
  against `IntersectionObserver`.

`site/` is served with `python3 -m http.server 8765`. Runs take 1–4 minutes
each; keep them serial, because concurrent runs make OCR timings noisy.

## Everything else still open

1. **Rest of the bug-hunt review** (`review-2026-09-22-pr22-bug-hunt.md`):
   L2–L9, T1–T3, O3, P3–P6, and the process items (single-source build
   identity, default-state tests, README step 4).
2. **Queued owner rulings (D54 addendum)**: default read scope Full visible
   with no forced setup question; tab follow defaults to `active` with two
   clearer words; mirror size defaults to 1:1; toolbar buttons stay until the
   owner reviews them one by one.
3. **Publish 0.5.0** as **D56**, only when the owner says it is ready; do not
   ask. Runbook: `handover-2026-09-22-release-readiness.md`; the release-notes
   draft needs a line for D51–D55.
4. Unchanged: F6 (memoizing `Intl.DisplayNames`) stays declined;
   `deferred-work.md` holds the 28 research-sized entries.

## Working notes

- Toolchain: `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`.
- Any shipped change: bump `betaBuildSuffix` in `wxt.config.ts` (`.15`), README
  (two places) and the two identity tests, `npm run artifact:sync`,
  `npm run check` (read the `exit=` and `Tests` lines), decision log, commit,
  push, then mirror to the NAS (memory note `simul-nas-mirror`; dry-run first
  and read the deletion list).
- PR #22's description: `gh pr view 22 --json body -q .body`, edit, then
  `gh pr edit 22 --body-file`.
- Owner preferences that shaped this session: no publish prompts; keep the tool
  simple; multi-step shell work goes in a script file rather than a long
  compound command with `rm -rf`.
