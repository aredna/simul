# Handover: mirror limits, quirks mode, new defaults (2026-09-23, second session)

Chains from `handover-2026-09-23-session-close.md`, whose work list this
session worked through. Decision-log entries **D63**–**D76** hold the reasoning
and measurements; this file is the summary and the next steps. D73–D74 came
from a third session the same day (owner reports on the side panel and on
image overlays), and D75–D76 from a fourth (owner report on a signed-in banking form
and the follow-up on what D75 still hid).

## Where things stand

| Item | State |
| --- | --- |
| Branch / PR | `feat/ui-string-catalogue`, PR #22, **rebase-merged into `main` at the 0.5.0 publish (D77)**; the branch is deleted. |
| Version / identity | `0.5.0` / `0.5.0 beta v.20260922.36` on `docs/readme-simple-and-ocr-notices` (D78: minimal README, OCR license notices; next is `.37`; `npm run bump-build`). The released v0.5.0 zip is `.35`. |
| Gate | `npm run check` green at D76: **1,513 tests pass, 1 skipped**; `dist/chrome-unpacked` byte-verified. |
| NAS | `Dev/simul/` mirrors head; the owner loads `Dev/simul/dist/chrome-unpacked` (`Build 0.5.0 beta v.20260922.35`). |
| `main` / release | **0.5.0 published (D77)**: PR #22 rebase-merged, tag `v0.5.0`, GitHub release "Simul 0.5.0 beta (v.20260922.35)" marked Latest with `simul-0.5.0-chrome-unpacked.zip`. New work branches from `main`; bump to `.36` before the next shipped change. |

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
- **Data-URL fonts:** allow them (D72). **Caption band (O3):** grow when
  needed (D72).
- **P3–P6:** "Do whatever is necessary, but if it's low priority, let's not
  spend a lot of time on it yet. Better to focus on it in the future when it
  becomes an actual issue." Deferred.
- **Owner report (D71):** after choosing an item, the mirror's dropdown
  stayed open. Fixed.
- **Owner report (D73):** "I cannot click the pinned button in the main
  screen. The default should be set to follow instead of pinned." Pinned in
  the side panel keeps the tab it shows (owner's pick, same as the window).
- **Owner report (D74):** a page's pop-up covered its images, but image
  translations were drawn above it. Owner's pick: put each translation inside
  the page right after its image ("A"), not a top layer that hides parts.
- **Owner report (D75):** on a signed-in banking form, with every read
  setting allowed, an upload button, the website-link information and many
  clickable items were blank (all text). "Could we have an advanced setting
  that lets me disable all privacy for testing purposes? Please go ahead and
  make any other fixes you think might be causing us to filter those out."
  Done: **Show everything (testing)** in Advanced, plus eight default fixes.
- **Owner ruling (D76):** the items D75 still hid were not protected data;
  change all four. "We don't have to strip editable regions unless they are
  tagged as private regions, such as a credit card number, or as a bunch of
  asterisks for a password. Even then, we should err on the side of showing
  something until we have a user complaint." Done: author attributes and
  `data-*` travel, `<output>` / spinbutton / slider text shows, visibility is
  decided per element, and credential inputs show as empty boxes.

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
| `.29` | D70 | Review L6, L8, L9: translated frames keep their placeholders; the count label follows a language switch; code-written text gets `lang` and `dir="auto"`. README step 4 reworded. `npm run bump-build` added. |
| `.30` | D71 | Choosing an option, link or menu item closes the mirror's dropdown; select facsimiles open only on click or keyboard (not hover), like native selects. |
| `.31` | D72 | Base64 font data URLs in CSS are kept (embedded web fonts render); the caption band grows to at most 60% when its text would be under 9px. |
| `.32` | D73 | The side panel honours Follow / Pinned (default Follow): it follows the active tab of its own window, the button is clickable there, and Pinned keeps the tab it shows. Settings reads "Mirror follows". Verified with the real side panel (CDP `Extensions.triggerAction`). |
| `.33` | D74 | Image translations are `simul-image-overlay` elements right after each image with no z-index, so pop-ups cover them and backdrops dim them; closed shadow root, inline `!important` reset, positioned by measuring its containing block (transforms, scale, nested scrollers), sized to the visible part, re-inserted after mirror rewrites. Painted logo labels drop their z-index. |
| `.34` | D75 | **Show everything (testing)** (Advanced, off by default) turns every privacy filter off on both sides of the mirror (start-message field, `source-privacy-mode.ts`); typed passwords never travel, and three disclosure attributes stay replica-owned. Default fixes: no more "class changed twice" masking secrets (a `<body>` toggle blanked whole pages); file inputs drawn; checkbox / radio / switch / select-only combobox labels public; painted ARIA menus keep their text; `open` kept on details and dialog; painted controlled regions shown whatever their controllers' state (a bank homepage's hero slides); date and time values read as form values; an OCR queue restart loop that overflowed the stack after a purge. Verified on a bank-form fixture, a bank homepage, Wikipedia and freee. |
| `.35` | D76 | `aria-label`, `title`, `alt` and `data-*` travel (everywhere except inside a credential input); `<output>`, spinbutton and slider text show; a `visibility: visible` child of a hidden parent shows; password, card and one-time-code inputs are drawn as empty boxes (box attributes only, no value). The bank-form fixture now misses nothing the page shows at the defaults; CSS-masked text is the last opaque shell. |

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
3. **The receiver refuses a whole semantic batch for one bad item**
   (session-close item 5). D62's months-long outage was one such case.
   Dropping only the failing record or proof and logging it would limit the
   damage. It needs care, because proofs can depend on records.
4. **Limited-quirks mode** is not represented (reports `CSS1Compat`, gets the
   standards shell).
5. **The overlay element is visible to sibling-counting page CSS** (D74's
   known cost): `img + figcaption`, `:last-child` on the image, or
   `:nth-child` of later siblings can change. No report yet; if one comes,
   options are placing it last in the parent (paints above later positioned
   siblings) or accepting per-site cases.
6. **Review R4 remainder:** "Mirror follows" in Settings now fully duplicates
   the toolbar's Follow / Pinned button on both surfaces; a simplification
   candidate to bring to the owner.
7. **Credential fields show no dots** (after D76): a password or card field
   is an empty box, and CSS-masked text (`-webkit-text-security`) is still an
   opaque shell, where the page draws dots. Drawing the same number of dots
   would reveal only the length the page shows; do it if the owner reports
   it (the owner's rule: show something until a user complains).
8. **The ARIA menu facsimile drops page styles** (D75 finding): every painted
   `role="menu"` / `listbox` is moved into an isolated shadow root, so a
   static menu (an Ant Design sidebar) now shows its text but unstyled.
   Wrapping only validated dropdown panels would keep the page's styles;
   needs a design because the preview code expects the facsimile host.
9. **A `<select role="combobox">` is never an eligible select** (found in
   D75, not new): an explicit `combobox` role on a native select, its
   implicit role, makes it ineligible, so its facsimile shows no labels.

## Next work, in order

1. **Default-state tests** (review process item): add versions of the G1,
   G2 and rollback tests that run at the shipped defaults (D47 pinned them to
   OCR off). No owner input needed.
2. **Candidate 2 (capture performance):** memoize the visibility index's
   painted-path check per scan, the same way D63 memoized the secret-ancestor
   walk. It is behaviour-preserving, so no owner input is needed; verify
   with `mirror-timing.mjs` and a differential check.
3. Candidates 1 and 3 (style polling on large documents; per-item semantic
   refusal) need a design first. P3–P6 wait until one becomes an actual
   issue (owner).
4. Watch for owner reports on D75 (ask what Show everything showed on the
   banking form: anything still missing with it on is not a privacy rule), D74
   (overlays inside the page), D73 (side panel following), D71 (dropdowns)
   and D66 (new defaults), the most visible changes.
5. Done: 0.5.0 published as **D77** (notes in `release-notes-0.5.0.md`;
   README lists Chrome 138+ and Edge 148+ as the browsers with the
   Translator API; no packed `.crx`, see D77).

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
  `count-translations.mjs` (counts stand-in Translator calls), `status-smoke.mjs` / `status-lang.mjs` (status line after a To switch; flags "[object"; `lang`/`dir`), `dropdown-select.mjs` (open each select and menu, choose an item, report what is still open), `data-font.mjs`, `caption-band.mjs`, `sidepanel-follow.mjs` (opens the real side panel with CDP `Extensions.triggerAction` on a `tab` target, found with `Target.getTargets({filter:[{}]})`; checks Follow / Pinned across tab switches), `overlay-stacking.mjs` (pop-up, backdrop, scaled box, cover image, carousel; alt-text captions via the stand-in Translator, source `en`), `overlay-scrollers.mjs` (adds positioned and static nested scrollers and scrolls them). D75 (in `~/.cache/simul-harness/d75/`): `bank-form.html` (60 `T##` markers across file inputs, input buttons, choice roles, values, ARIA text regions, disclosures, masking, form structure and script-driven rows; `?body=1` also toggles a `<body>` class), `marker-audit.mjs <ext> <url> [shot]` (which markers show in source and replica: text, values, pseudo content, open shadow roots; `PRIVACY_OFF=1` turns the switch on), `text-coverage.mjs <ext> <url>` (source lines missing from the replica on a real page), `source-ancestry.mjs <url> <needle>...` (no extension; tag, role, aria and computed visibility up the tree), `menu-debug.mjs`, `slick-current.mjs` (current carousel slide in source and replica); `dropdown-select.mjs` there takes `PRIVACY_OFF` and `SETTLE_MS`, and its `ext-harness.mjs` prints page-error stacks. The `d63/`
  folder has `run-cap-matrix.sh` (old vs new build table),
  `build-unminified.sh` (profiling build), the profile summarizers, the
  `sanitizeCss` differential and benchmark, `make-cap-pages.py` (the
  `site/big-*.html` pages) and `nas-mirror.sh` (edit its `S=` scratch path
  first).
- Test pages: `site/big-sheet-5mb.html`, `big-sheet-12mb.html`,
  `big-nodes.html` (about 135,000 nodes), `big-text.html`, `big-image.html`,
  `quirks.html`, `data-font.html`, `caption-band.html`. Real pages: the Falcon 9 launch list, the Donald Trump and
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
- Per shipped change: `npm run bump-build` (bumps `.NN` in `wxt.config.ts`,
  README and the two identity tests), then `npm run artifact:sync && npm run
  check`; decision log (publish moves to
  the next number); commit; push; PR description (`gh pr view 22 --json body
  -q .body`, edit, `gh pr edit 22 --body-file`); NAS mirror (dry run first,
  read the deletion list; `*.user.toml` excluded).
- Limits are module state (`lib/replica/html-mirror-limits.ts`, live `export
  let` bindings). A test that lowers them must restore them with
  `applyHtmlMirrorLimitSettings()`.
- Owner preferences: no publish prompts; the simplest rule and fewer
  controls; questions go through the question tool with a Notes option;
  multi-step shell work goes in a script file.
