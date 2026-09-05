# Chrome manual test plan (2026-09-05)

Browser pass for the changes that unit tests cannot prove: the browser
adapters behind the side-panel split (PR #10), the host-grant ledger and the
other lib-level fixes (PR #12, D33), the overlay rebinding and discovery
changes (D34), and the OCR overlap rule (D30). Run it on a build that
contains every open PR before the next public build. Each step names the
decision-log entry it verifies so a failure can be traced.

## Setup

1. Desktop Chrome 138 or newer, a **fresh profile** (no earlier Simul data),
   and a second profile or window for the multi-window checks.
2. Build the branch under test: `npm run check` must be green, then load
   `dist/chrome-unpacked` through `chrome://extensions` with Developer mode.
3. Note the build identity shown in Simul Options (expected
   `Build 0.4.0 beta v.20260905.1` on `main`; a later merge advances it).
4. Keep the DevTools console of the side panel open (right-click the panel,
   Inspect). A release build logs nothing page-derived; any page text in the
   console is a failure of the content-free diagnostics rule.

Fixture pages (public, no login):

| Fixture | Use |
| --- | --- |
| A long article with a fixed header and inline images (a news site) | scroll following, text-cover heuristic, attention ranking |
| An infinite-scroll feed (Reddit-class) | nested scroller, busy DOM, long documents past 100,000 px |
| A page with an ARIA tablist (documentation sites with tabbed code samples) | tab visibility proofs |
| A login page with an image next to the form | OCR overlap rule |
| A page with responsive images (`srcset` / `<picture>`) | image-source hints |
| A Hebrew page (Wikipedia in Hebrew) | Hebrew translator tag |
| A page whose main content lives in a nested scroll pane (a docs site with a scrolling main column) | nested scroller identity |

Record every step as pass, fail, or not run in the table at the end.

## 1. Install, identity, icons (D12, D29, D32)

1. The extension card shows version `0.4.0` and the placeholder icon (green
   rounded square with a page and its offset mirror). The toolbar shows the
   same icon, not a generic letter.
2. Simul Options shows the build identity from Setup step 3.
3. `chrome://extensions` shows no host access by default ("On click" or no
   site access listed). Simul must not hold `<all_urls>` after a fresh
   install.

## 2. First run and read-scope setup (D31 ReadScopeController)

1. Open a fixture page, select the Simul toolbar icon. The companion opens as
   a side panel and shows the mandatory first-run **Readable content &
   security** setup.
2. Choose a profile; toggle one per-key setting; confirm. The replica renders
   only after the setup is committed.
3. Reload the page and reopen the companion: setup does not reappear; the
   chosen scope is still shown in the options disclosure.
4. Open the companion in a second window on another page while the first is
   open: both windows show the same scope (preference sync through the
   background), and changing the scope in one updates the other without
   reloading.

## 3. Toolbar and languages (D30, D31 TranslationDriver, UiLocalizer)

1. **From** on **Auto-detect**, choose **To**. If Chrome has no pack for the
   pair, the status asks for **Translate page** and nothing downloads until
   it is selected (D14/D30: label localization never starts a download).
2. After **Translate page**, the page translates and the panel's own labels
   localize into the target language once the pair is installed.
3. **Swap languages**, then swap back. Availability status updates each time
   and never leaves a stale "checking" state (H1).
4. In a second companion window, change **To**. The first window keeps its
   own language and does not start translating on its own (L2).

## 4. Mirror controls (D30 zoom, D31 PreferenceClient)

1. **Change mirror size**: Fit, 1:1, then drag the zoom slider slowly for two
   seconds. The replica rescales live; in `chrome://extensions` → Simul →
   storage (or via a second companion window) the zoom value updates once
   after the drag settles, not on every tick.
2. Close the panel mid-drag (Chrome closes it when the tab changes): reopen
   and confirm the last zoom survived (`pagehide` flush).
3. Toggle layout mode and scroll following; each survives a panel reopen.

## 5. Detached window and surface switching (D11, D30, D31 SurfaceSwitcher, SourceFollower)

1. **Open detached companion window**. The window docks to the right edge at
   about 45% of the source window's width (never narrower than 480 px) and
   does not cover the page.
2. Select the toolbar icon again. The existing detached window is focused
   and re-authorized; no second window opens.
3. In the detached window, switch the source window's active tab to another
   HTTP(S) page. The companion follows the active tab, rebuilds, and shows
   the new page's title in its status.
4. Move the followed tab to another window, then close it. The companion
   reports the lost page and recovers when a new tab is activated.
5. Return to the side panel from the detached window. The detached window
   closes and the side panel resumes on the same page.

## 6. Navigation and currency (M1, M2, D30, D31 CapturePipeline)

1. On the article fixture, click an in-page anchor (hash change). The replica
   updates its scroll position without a full rebuild.
2. Navigate to a second article via a link. The replica rebuilds once; the
   old page's translation does not flash into the new one.
3. Switch to another tab and back after the source page changed (for example
   a comment loaded). The replica refreshes on return; a stale replica is
   rebuilt when the page identity changed.
4. **Rebuild mirror** during translation: the rebuild completes and the
   translation restarts for the new replica only.

## 7. Very long documents (D33 scroll bound)

1. On the infinite-scroll fixture, load until the page is deeper than
   100,000 CSS px (check `document.scrollingElement.scrollHeight` in the
   page console).
2. Scroll the source in steps from the top to the bottom. The replica
   follows proportionally the whole way. Before this fix the replica pinned to
   its bottom once the source passed 100,000 px.

## 8. Nested scrollers (D33 scan budget)

1. On the docs-site fixture whose main column scrolls, scroll that column.
   The replica's matching column follows, not the document.
2. On the same page, add content above the column by expanding menus or
   sidebars until thousands of elements precede it (the fixture should
   already have them). Scrolling the column still follows; the scroller is
   identified even behind a long DOM prefix.

## 9. Tab panels (D33 contradictory tablists, padding-box clip)

1. On the tablist fixture, select each tab in turn. The replica shows the
   selected panel's text and hides the others.
2. Where the site keeps two tabs "selected" at once (some tab libraries do
   this during animation), the replica shows neither panel until the state
   settles; it never shows both.
3. A selected panel partly hidden under its container's scrollbar or border
   is shown only for the part inside the container's padding box; text lying
   entirely under the scrollbar is not disclosed.

## 10. Image text (OCR) (D9, D18, D30, D34)

Enable **Toggle image text translation** (OCR On). Chrome prompts for site
access once; accept.

1. **Overlap rule (D30):** on the login fixture, an image next to an ordinary
   text field (search box, username) is translated; an image overlapping the
   password field is not, and the diagnostics disclosure in options reports
   the deferral without the field's contents.
2. **Text cover (D30):** on the article fixture, scroll so the fixed header
   covers the top of an image. The image is not scanned while covered and is
   scanned once the header clears it.
3. **Scroll cancel keeps the worker warm (D30):** scroll quickly through
   twenty images. The network panel of the offscreen document shows the
   Tesseract core fetched once, not per image.
4. **Inactive tab (D30):** switch tabs while images are pending, return.
   Pending images resume without a manual action.
5. **Rebuild keeps overlays (D34):** with overlays visible, select **Rebuild
   mirror**. Overlays reappear on the rebuilt replica as soon as their image
   nodes exist, without re-running OCR (no new recognition diagnostics for
   unchanged images). Before this fix an overlay whose node arrived late
   stayed missing until the image changed.
6. **Attention ranking (D34):** on an image-heavy page (a photo gallery),
   the images currently in view are translated first even when hundreds of
   offscreen images precede them in the document.
7. **Responsive sources:** on the `srcset` fixture, resize the source window
   so the browser selects another candidate. The replica's image follows the
   selection (D34 policy reuse must not change this).

## 11. Hebrew (D33 L10)

1. Choose **To** Hebrew with **From** English. Availability is reported as
   available or downloadable, not unsupported. **Translate page** produces
   Hebrew text.
2. Open the Hebrew fixture with **From** Auto-detect and **To** English. The
   page is detected as Hebrew and translates.

## 12. Host grants (D33 M5)

1. In `chrome://extensions` → Simul → Site access, allow the extension on a
   specific site you have not used with Simul. Open a companion on any other
   page and change a setting (which reconciles preferences). Return to Site
   access: the grant you made is still there.
2. In Simul, turn automatic translation on for **this site** on a fixture,
   accept the prompt, then turn it off. The site grant Simul asked for is
   removed; your manual grant from step 1 is untouched.
3. In `chrome://extensions`, allow Simul on all sites. In Simul, choose
   automatic translation for **this site** on a page. The choice sticks (it is
   covered by your broad grant) and the broad grant is not revoked.
4. Turn automatic translation **on for all sites** in Simul, then **off**. The
   broad grant is removed (Simul owns it once it relies on it, D33 choice 2).
5. Open options → **Reset all extension settings?** → confirm. Every Simul
   host grant is removed, including the manual ones (D33 choice 1), the
   companion returns to first-run setup, and no "Reset cleanup needs
   attention" notice remains after the cleanup finishes.

## 13. Quick translation (D31 QuickComposer)

1. **Open quick translation**, type a sentence, submit with the shortcut. The
   translation appears; the character counter counts down from 5,000.
2. Switch direction; the composer keeps the draft.
3. Nothing typed appears in the console or in the diagnostics disclosure.

## 14. Reset and cleanup (D31 ReadScopeController, D33)

1. Reset with the OCR host running and images pending. The reset completes
   and OCR stops; no overlay remains on the replica.
2. If Chrome refuses a permission removal (rare), the **Reset cleanup needs
   attention** notice appears with a retry that succeeds on the second try.

## 15. Diagnostics and privacy (upstream rule, kept)

1. With everything above done, search the side-panel console and the options
   diagnostics for any word from the fixture pages. None may appear.
2. Passive Fidelity note (D17/D20, known limit): the replica may request
   remote fonts, which can reveal the target language to the font host. This
   is documented, not a failure.

## Results

| Section | Step | Result | Notes (build, page, what happened) |
| --- | --- | --- | --- |
| 1 | 1–3 | | |
| 2 | 1–4 | | |
| 3 | 1–4 | | |
| 4 | 1–3 | | |
| 5 | 1–5 | | |
| 6 | 1–4 | | |
| 7 | 1–2 | | |
| 8 | 1–2 | | |
| 9 | 1–3 | | |
| 10 | 1–7 | | |
| 11 | 1–2 | | |
| 12 | 1–5 | | |
| 13 | 1–3 | | |
| 14 | 1–2 | | |
| 15 | 1–2 | | |

File failures as decision-log entries or issues with the section and step
number; a fix lands with the unit test that would have caught it where one is
possible.
