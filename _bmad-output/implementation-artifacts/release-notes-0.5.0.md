Simul is a browser extension that shows a translated copy of the page you are
reading next to the original. The translation happens entirely on your own
computer, using the browser's built-in translator. Nothing is sent anywhere:
there is no server, no account and no key. It started as a quick build for the
OpenAI Build Week hackathon, made as something we would use ourselves, and we
are now sharing it so others can use it too.

## What you need

Simul translates with the browser's built-in **Translator API**, so it needs a
browser that has it:

- **Google Chrome 138 or newer** on a desktop or laptop (Windows, macOS or
  Linux). Simul is built and tested in Chrome.
- **Microsoft Edge 148 or newer** on a desktop or laptop. Edge has had its own
  on-device Translator API since version 148. Simul installs the same way
  there but has had less testing in Edge.

Firefox, Safari, and browsers on phones and tablets don't have the Translator
API. Other Chromium-based browsers can load Simul, but it can only translate
if the browser has the API. You also need about 35 MB of disk space. The first
time you translate into a new language, the browser may download that
language pack.

## Install

1. Download `simul-0.5.0-chrome-unpacked.zip` below and unzip it.
2. Open `chrome://extensions` (in Edge, `edge://extensions`) and turn on
   **Developer mode**.
3. Select **Load unpacked** and choose the `chrome-unpacked` folder.
4. Open any normal web page and select the Simul icon.

Simul's settings show `Build 0.5.0 beta v.20260922.35`. This is an unpacked
beta, so the browser does not update it automatically. It is a folder, not a
packed `.crx` file, because Chrome on Windows and macOS installs packed
extensions only from the Chrome Web Store. The zip is a byte-for-byte copy of
the committed `dist/chrome-unpacked` at the tagged commit, which
`npm run check` verifies against a fresh build.

## What changed since 0.4.0

- **Ready to use from the first run.** A new install starts at Full visible
  with no setup question. The mirror opens at 1:1 and **Follow**s the active
  tab in the side panel and in a separate window. Select **Pinned** to keep it
  on one tab. A new tab is followed once its web page loads.
- **The mirror shows what the page shows.** Visible text that privacy rules
  used to withhold now appears, including labels, `aria-label`/`title`/`alt`
  text, `<output>`, sliders and spinbuttons, file inputs, checkboxes, radios,
  switches and comboboxes. Password, card and one-time-code fields are drawn
  as empty boxes, and their values are never read. **Show everything
  (testing)** under Advanced turns every privacy filter off so you can check
  whether a rule is hiding part of a page. It is off by default, and typed
  passwords still never travel.
- **Real pages look right.** Dropdowns and site menus open in the mirror, and
  choosing an option closes them. Large inline stylesheets (up to 10 MB) are
  kept, quirks-mode pages render in quirks mode, embedded data-URL fonts are
  kept, and the browser's own `html` and `body` are preserved.
- **Carousels and scrolling.** A carousel move is a live update, not a
  rebuild, and its slides, text and buttons stay readable. The mirror follows
  the source's scroll only when the source actually scrolls, so it no longer
  jumps back while you read.
- **Image text across the whole page.** Image translation is on by default and
  translates the page text with it. Images off screen are read from their own
  file, not only from a screenshot. Translated alt or label text appears as a
  caption band along the bottom of the image, and the band grows when it needs
  to. Translations sit right after their image, so a pop-up covering the image
  also covers its translation. When alt text and OCR disagree, an on-device
  model decides, but only if the browser already has one installed; Simul
  never downloads one.
- **Size limits you can change.** Advanced settings set the largest single
  item, the largest page and the most page elements, with a Restore button.
  Replica fidelity also moved to Advanced.
- **Companion UI in your language.** Every label, title, hint, placeholder,
  status and progress line follows the To language once that pair is
  installed. They switch as one set, re-localize on a language switch, and keep
  counts and language names in the target language's word order.
- **Reliability.** Translation requests follow the newest snapshot, the OCR
  lock and unreadable storage are handled, a pending reset cannot keep the
  broad site grant, the OCR button can always turn OCR off, hidden accessible
  names are no longer sent for translation, and the side panel is split into
  tested modules with a transactional image-permission rollback.
- **Housekeeping.** The GitHub Actions workflow and the Dependabot config are
  removed; verification is the local `npm run check` gate (1,513 tests).

Known limits: the icons are placeholders, and the Chrome-fixture disclosure
test is skipped when no browser is available.
