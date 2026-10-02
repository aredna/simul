# Simul reference

Detail behind the [README](../README.md): how the mirror works, the privacy
boundary, permissions, fidelity limits, troubleshooting, and development.

## How it works

Simul does not run a second active copy of the website.

1. **Authorize the current page.** Selecting the toolbar icon gives Simul
   temporary `activeTab` access to that exact document. No permanent host
   access is required for ordinary manual use.
2. **Capture a bounded page model.** A thin source bridge reads the
   browser-produced DOM and sends an allowlisted graph rather than raw HTML.
   Scripts, event handlers, navigation behavior, forms, active embeds, and
   protected values are excluded before they cross the extension boundary.
3. **Build an inert replica.** The extension validates the graph again and
   creates new DOM nodes inside an iframe sandbox without scripts. Website
   presentation is pointer-inert; companion-owned controls can adjust the view
   but cannot click, navigate, select, or submit on the source page.
4. **Translate locally.** Eligible text nodes are translated with Chrome's
   on-device Translator API. Chrome may download language packs, but Simul does
   not send page content to a Simul server or a third-party translation API.
5. **Follow safe changes.** Ordered, bounded patches update text, attributes,
   eligible controls, styles, images, dimensions, and scroll state. If a patch
   stream becomes unsafe or inconsistent, Simul keeps the last good replica and
   stages a fresh checkpoint.

Translations are projected onto the replica; the source DOM is not modified.
Exact-content translations are joined and cached only in memory for the current
extension session.

### Size

The **Size** setting and the toolbar size button work the same way for web
pages and PDFs:

- **Fit** fills the panel width. The page grows or shrinks to fit, up to five
  times its size.
- **1:1** shows the page at the size the tab shows it. If you zoom the tab,
  Simul follows.
- **Custom zoom** multiplies the 1:1 size.

With **Follow source scrolling** on, a web page's mirror also follows:

- a pinch zoom in the tab (a trackpad pinch or a double-tap zoom). The mirror
  magnifies the same part of the page, in every size setting; with Fit it
  shows exactly what the tab shows. Turning following off shows the whole
  page again.
- the page scrolled sideways, like the page scrolled down. A pane inside the
  page that scrolls sideways only, such as a board of columns, is not
  followed.

### PDFs

When the tab shows a PDF, selecting Simul shows the PDF's pages in the panel,
in order, with the packaged pdf.js.

A PDF saved on your computer opens in a `file://` tab, which Simul cannot
read. Give Simul the file instead:
- Whenever the panel shows a message and no page (such as "Simul cannot read
  a PDF opened from this computer in a tab"), it offers **Open a PDF file…**.
- A file dropped anywhere on Simul opens too, over a mirrored page as well,
  and replaces what Simul showed. Of several files, the first PDF opens; a
  file that is not a PDF leaves the message "This file is not a readable
  PDF."
- If Simul opens in a separate window, selecting Simul on a tab it cannot
  read opens that window (or brings it forward) with the message and the
  button.
- If the side panel is already open, selecting Simul on a tab it cannot read
  replaces the page it showed with the message and the button, also when
  the panel is pinned to another tab. A PDF you opened from the computer
  stays. Select Simul on a web page to show that page again.

A file from the computer then works like a web PDF, with one difference:
it has no site, so automatic translation follows the all-sites setting or
**OCR** being on. It stays until Simul shows something else: a page you
select Simul on, a tab you switch to while Simul is set to **Follow**, or
another file. Moving between windows or a page finishing its load keeps it.

**Rebuild mirror** reads the file again. If the file was moved or changed
meanwhile, the PDF closes and you choose it again. Simul keeps the file only
in the panel or window you opened it in: the side panel's ↗ button is off
while it shows, and returning a separate window to the side panel leaves
the file behind.

**Translate page**, From/To, Auto-detect, automatic translation, Cancel and
Live source only work as they do for web pages. Each paragraph, heading or
list item is covered with the page's own background colour and its
translation is written in its place, in the text's colour. A translation
longer than the original shrinks down to half the original size; if it still
does not fit, it runs past its block (though not past the edge of the page,
which clips it). The page you are
reading is translated first, then the pages after it, then those before it;
scroll elsewhere and translation continues from there. Auto-detect uses the
PDF's own language tag when it has one, otherwise its text. Simul reads all
of a PDF's text first, after its pages show ("Reading the PDF…"), so
**Translate page** turns on a moment later (about half a second for 300
pages), or after the scanned-page language check below. Translations appear
on a page once it is drawn.

- Scanned pages (images of text) are read with Simul's on-device OCR, but
  only while translating: **Translate page** or automatic translation reads
  them, the page you are reading first, and **Cancel** stops the reading
  too. Text pages never wait for scanned ones. Showing a PDF, Live source
  only, or From and To in the same language read no scanned page, with one
  exception: with Auto-detect and no language tag or text (or text only on
  scanned pages, such as a header over each scan), Simul reads up to
  three scanned pages to find the language (for about 20 seconds at most)
  when the PDF's text has been read, when From becomes Auto-detect, or when
  Live source only ends, once per PDF. The OCR draws each page itself (at
  most 4 megapixels and 300 dpi), so it needs no image access, and the
  toolbar's **OCR** switch does not apply; the image reading methods under
  **Advanced & experimental** do, and Tesseract.js must be on (Chrome's text
  detector alone cannot read a page). A page is read when it has no text at
  all, or when its own text covers at most 3% of it and its pictures cover
  at least four fifths of it: a scan under a typed header, page number or
  stamp. That typed text stays as it is and is translated at once; OCR adds
  the rest, without the lines that only repeat it. A page with more text, or
  with smaller pictures, is never read. Such a page's pictures are looked at
  only when it can be read: with Tesseract.js off, or a language without an
  OCR model, it stays as it is and nothing is said about it.
  If Tesseract.js is off, the language has no OCR model, or a page could not
  be read, the status says so; a page that cannot be drawn is not tried again.
  A PDF with no text at all says "No text was found in this PDF." Rotated or
  vertical text stays as it is, on scanned pages too.
- Screen readers read each page ("Page 2 of 10") with its text, translated
  where a translation shows. Untranslated text is marked with the PDF's
  language (the From language, or the detected one) and a translation with
  the To language, so a screen reader that switches voices can pronounce
  each in its own. One language covers the whole PDF; while it is not known,
  the text is marked as of unknown language.
- With **Follow source scrolling** on (in Settings, on by default), the panel
  follows Chrome's PDF viewer in the tab. The viewer says where its most
  visible page sits on screen but never which page it is, so Simul works the
  page out from Chrome's page layout and from how the viewer moves.
  - Followed: scrolling with the wheel or trackpad; the arrow keys; Page Up,
    Page Down and Space; ArrowRight; these keys held down; Home and End.
  - Guessed: anything else that jumps in one step, such as the page box, the
    outline, thumbnails, links, Find, ArrowLeft, or a scrollbar drag on a
    long PDF. So is the first place when you open Simul with the viewer
    already partway down. A newly opened or reloaded tab is taken to be at
    its start (the top, or the address's `#page=N`), and with following on
    the panel opens there too.
  - After a wrong guess the panel stays that many pages off as you read on.
    Home or End from far away puts it right.
  - At zooms where pages start on whole pixels (100% and 90% for US Letter),
    ArrowRight pressed in the first screen of the PDF, or exactly one arrow
    step below a page top, looks the same as scrolling up, and is read as
    that.
  - Pages of different sizes help Simul tell them apart.
  - Sideways scrolling in the viewer is followed too, exactly: the panel is
    scrolled across the page as far as the viewer is. It shows when the
    page is wider than the panel, as it usually is at 1:1.
  - The panel moves only when the viewer moves, so your own scrolling of the
    panel stays until then. That holds each way: scrolling the viewer down
    leaves the panel where you put it sideways.
  - Not followed: a PDF opened from the computer, the viewer's two-page view
    (the panel scrolls on its own there), and Microsoft Edge's viewer, which
    sends nothing. Rotated pages are followed wrongly.
- Without a remembered place, a PDF opens at the page its address names
  (`#page=3`).
- Only the pages near the view are drawn. In a very long PDF (more than
  about 12,000 paragraphs, typically several hundred pages), the pages near
  the view and those read first carry their text for screen readers and
  find; the others are announced by their page number only and get their
  text when you scroll to them. Translation covers every page either way.
  On the test computer, reading the text of 3,000 pages took 1.3 seconds and
  of 10,000 pages 5.4 seconds.
- If you come back to a PDF, or rebuild it, it opens where you left it.
- Simul opens PDFs of up to 128 MB. A download that stalls for 60 seconds
  fails; a slow one that keeps going does not.
- A password-protected, oversized, broken or undownloadable PDF shows one
  status that says why.

### Image text

Image translation is **on by default** and saved with your settings; pixel OCR
waits until you grant image access from the **OCR** button. While on, it also
translates the page text of the mirrored page, and for images Simul:

1. inspects policy-approved top-frame `<img>` elements on the whole page,
   the ones on screen first and the rest in the background;
2. first tries direct `aria-label` or `alt` text, which needs no pixel access
   and is shown as a caption band along the bottom edge of the image (this
   method is on from the start, so images with alt text get a translated
   caption before image access is granted);
3. for pixel OCR, reads an image on screen from a crop of the visible tab
   (after checking its geometry is stable); an image off screen, moving, or in
   a background tab is read from its own file instead: the copy the mirror has
   already loaded, then the page's own copy for same-site images, then (Passive
   fidelity only) a cache-first download of the same URL without cookies. Each
   crop is reduced to at most 4 megapixels;
4. tries Chrome TextDetector when the installed platform exposes it, then the
   packaged Tesseract.js 7.0.0 fallback according to the saved method order;
5. rejects blank, punctuation-only, and insufficient-confidence results, and
   when alt text and OCR text are too close to call, lets Gemini Nano (or
   Chrome's Language Detector) pick, but only if Chrome already has it
   installed; Simul never downloads a model; and
6. translates accepted lines and places inert overlays over the replica image.

The Tesseract worker, WebAssembly cores, notices, and 22 pinned
`tessdata_fast` language files are packaged with the extension. No OCR code,
model, image pixel, or recognized text is fetched from or sent to a remote OCR
service. Crops use short-lived extension storage for the offscreen handoff and
are deleted after the job; OCR and translation caches are bounded and
memory-only.

OCR reads top-frame `<img>` images, on screen or not. It does not read CSS
backgrounds, canvas, video frames, embedded documents (a PDF tab is shown
instead; see [PDFs](#pdfs)), hidden images, or
credential-overlapping pixels, and text a page draws over an off-screen image
is not part of its file. A public text field, button, or link that
overlaps an image does not block capture; only password and other credential
fields do, and capture waits while text from another element covers the
image. See
[Image text translation](image-translation-research.md) for the detailed
boundary.

## Privacy and security boundary

Reading and acting are separate contracts. Broader readable-content settings
never make the replica interactive.

Simul starts at **Full visible**, with no setup question: the mirror shows
what the page shows. You can narrow it in settings. The Page-only, Standard,
Full visible, and custom profiles control whether the mirror may read public
control semantics, non-secret images in controls, validated disclosure
content, visible text/search/URL/textarea values and selection state,
personal/autofill values, and editable text.

Passwords, authentication and one-time-code fields, WebAuthn and payment-card
autocomplete classes, hidden inputs, file names, and CSS-masked text are
blocked under every profile. A file input shows as the empty field the page
draws. Password, card and one-time-code inputs show one dot per character,
as the page does; only the number of characters is read, and only when form
values are allowed. A node
classified as secret remains secret for that document. Narrowing
the scope clears the current replica, translations, and image overlays before
rebuilding.

**Show everything (testing)**, under **Advanced & experimental**, turns every
privacy filter off, to find out whether a privacy rule hides a missing part of
a page: hidden text, labels, card numbers, one-time codes, and form values are
copied as the page holds them (typed passwords are not). The mirror still
cannot act on the page. It is off by default.

A PDF opened from the computer is read from the file you chose and makes no
request; the panel keeps only a reference to the file, never past closing it.

To follow Chrome's PDF viewer, Simul adds a small script to the PDF tab
that asks the viewer for its scroll reports and passes on five numbers (where
the most visible page sits and the viewport's size) and the time of each,
nothing else.

On a PDF tab Simul makes one extra request: it downloads the PDF's own URL,
which the tab has already loaded. Chrome keeps the extension's cache separate
from the tab's, so this is a second download of the same file; Simul's own
copy is reused while it is fresh. The site's cookies go along, as they did for
the tab. Simul requests nothing else for a PDF. Scanned pages are read on
the computer, by the same local OCR as images: as for an image, each page's
drawing goes to the local OCR host through extension-origin temporary
storage, kept at most two minutes, and the recognized text stays in memory.

Diagnostics contain bounded stages, dimensions, and counts. They do not log
page text, recognized text, URLs, pixels, hashes, DOM IDs, or attribute values.
Simul includes no analytics, credentials, remotely hosted executable code, or
cloud translation/OCR integration.

### Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporarily authorize the page after a user gesture. |
| `scripting` | Start the exact-document mirror bridge and bounded observers. |
| `sidePanel` | Host the native Chrome companion. |
| `storage` | Save settings and explicit automatic-translation scopes. |
| `offscreen` | Run packaged local OCR away from the visible companion UI. |

`<all_urls>` is an **optional** host permission. Simul requests it only from an
explicit gesture when all-sites automation or reliable image capture needs it.
A saved feature remains paused if its grant is absent; Simul does not prompt for
broad access at startup. Simul releases only the site access it asked for and
no longer needs; access you grant yourself in `chrome://extensions` is left in
place (and covers your saved per-site choices) until you remove it there or
use **Reset all**, which clears every grant.

## Fidelity

The default **Passive Fidelity** policy preserves a broad, bounded set of
passive CSS, images, fonts, responsive sources, static posters, and static SVG
presentation. Those references can make ordinary HTTP(S) requests to their
existing hosts. **Conservative** admits fewer passive semantics but is not a
zero-network mode. Both policies keep the same scriptless sandbox and
active-content blocks. The policy, the mirror's size limits (largest single
item, largest page, most page elements), and **Show everything (testing)** are
under **Advanced & experimental**.

Simul is a safe reconstruction, not a browser clone. Current limitations
include closed shadow roots, script-only custom-element state, virtualized DOM
that the page has not created, inaccessible cross-origin CSSOM, generated
pseudo-element text, canvas/video pixels, protected media, active embedded
documents, and cross-origin frame contents. Exact pixel parity is not claimed.

See [Replica fidelity](replica-fidelity.md) and the
[translation companion architecture](translation-companion.md) for the
complete design and browser-boundary rationale.

## Troubleshooting

- **Chrome says the manifest is missing:** select `dist/chrome-unpacked`
  itself, not the repository root.
- **The icon does not work:** try a normal HTTP(S) page; Chrome blocks extension
  access on some internal and protected URLs.
- **A PDF on the computer (a `file://` tab) does not open:** Simul cannot read
  `file://` tabs, even with **Allow access to file URLs** on. Select
  **Open a PDF file…** in the panel, or drop the file on it.
- **Nothing translates at all:** the browser must have the Translator API
  (Chrome 138 or newer, Edge 148 or newer, or Opera 122 or newer, on a
  computer; https://caniuse.com/mdn-api_translator lists them). Other
  browsers can load Simul but cannot translate with it.
- **A language pair is unavailable:** update Chrome and allow its on-device
  Translator to prepare that pair.
- **Automatic translation paused after navigation:** temporary `activeTab`
  access does not transfer between sites. Select Simul again or explicitly
  grant the intended site/all-sites scope.
- **Image text is unchanged:** OCR is on by default, but pixel reading waits
  for image access; select the **OCR** button to grant it. Keep the image
  visible in the source tab and use a supported source language. Small images are skipped by default, and an image inside a link or
  button is read only under the **Standard** or **Full visible** readable-content
  scope (Page-only leaves images in controls alone).
- **The replica is stale:** use **Rebuild mirror**. Some closed-root, opaque
  resource, CSSOM, and script-only changes cannot be observed safely.
- **An update still looks old:** reload Simul at `chrome://extensions`, then
  reload the source tab and reopen the companion.

## Development

Prerequisites are Node.js 24 LTS and npm 12. Install the locked dependencies:

```sh
npm ci
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start WXT's development runner. |
| `npm run build` | Build the Chrome extension under `.output/`. |
| `npm run artifact:sync` | Validate and refresh `dist/chrome-unpacked/`. |
| `npm run artifact:check` | Rebuild, validate, and byte-compare the checked-in artifact. |
| `npm run typecheck` | Type-check source and tests. |
| `npm test` | Run the Vitest suite once. |
| `npm run check` | Run typechecking, all tests, and the artifact check. |
| `npm run zip` | Create WXT's Chrome distribution archive. |

Do not edit `dist/chrome-unpacked` by hand. Change source, run
`npm run artifact:sync`, then run `npm run check`. `npm run check` is the
required handoff gate.

Runtime entrypoints live under `entrypoints/`; browser-independent logic lives
under `lib/`; tests live under `tests/`; durable project knowledge lives under
`docs/`; and BMAD planning/implementation records live under `_bmad-output/`.
