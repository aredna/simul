# Simul reference

This document gives the detail behind the [README](../README.md): how the
mirror works, the privacy boundary, permissions, fidelity limits,
troubleshooting, and development.

## How it works

Simul does not run a second active copy of the website.

1. **Authorize the current page.** From installation, Simul can read the
   pages that you open (`<all_urls>`). Thus the panel follows each page and
   tab, and you do not have to click its icon. If you limit its site access
   in Chrome, select the toolbar icon. Simul then receives temporary
   `activeTab` access to that exact document, and the panel offers to allow
   all sites again.
2. **Capture a bounded page model.** A thin source bridge reads the DOM
   that the browser produced. It sends an allowlisted graph, not raw HTML.
   Scripts, event handlers, navigation behavior, forms, active embeds, and
   protected values are excluded before they cross the extension boundary.
3. **Build an inert mirror.** The extension validates the graph again. Then
   it creates new DOM nodes inside an iframe sandbox that has no scripts.
   The website presentation is pointer-inert. Companion-owned controls can
   adjust the view, but they cannot click, navigate, select, or submit on
   the source page.
4. **Translate locally.** Chrome's on-device Translator API translates
   eligible text nodes. Chrome can download language packs. But Simul does
   not send page content to a Simul server or to a third-party translation
   API.
5. **Follow safe changes.** Ordered, bounded patches update text,
   attributes, eligible controls, styles, images, dimensions, and scroll
   state. If a patch stream becomes unsafe or inconsistent, Simul keeps the
   last good mirror and prepares a new checkpoint.

Simul shows the translations on the mirror. It does not change the source
DOM. Simul joins and caches exact-content translations only in memory, for
the current extension session.

A screen reader reads the mirror as it reads the page: the headings, links
and text, translated where a translation shows. Tab moves the focus through
the links of the mirror and then out of the mirror. No other key has an
effect on the mirror.

- **Language.** Translated text has the language that it was translated
  to. Thus a screen reader that changes voices reads it with the correct
  voice. An element that shows a translation gives the translation's
  language in `lang` for as long as the translation shows. After that, the
  element has exactly what the page gave it again. Sometimes the translator
  returns text without a change (a name, a number, or a word of a third
  language that the page marks with its own `lang`). This text is not a
  translation, and it keeps the language that the page declares. In an
  element that also contains translated text, text that has no `lang` of
  its own is read in the translation's language.

  The visible mirror does not change. Chrome would also use that attribute
  to select fonts, quotation marks, hyphenation and the page's `:lang()`
  rules. Thus Simul keeps the page's own language beside it for all that
  Chrome draws, and Chrome draws the mirror as before. But 2 types of page
  rule see a difference. A rule that selects on the attribute itself
  (`[lang="en"]`) sees the translation's language. A rule written with the
  XML namespace (`[xml|lang]`, `[*|lang]`) matches the elements that show a
  translation.

  The page's own language is one of these: its `lang`; the `xml:lang` of an
  XHTML document or of SVG and MathML, which the mirror uses to draw as the
  page does; or, if the page's root declares no language, the document's
  own language. Chrome takes the document's language from a
  `<meta http-equiv="content-language">` or from the HTTP
  `Content-Language` header.
- **No announcements.** The mirror does not make announcements. The tab
  announces the page's alerts, status lines and other live regions. In the
  mirror, they are ordinary text that keeps its role. Thus a screen reader
  does not say them a second time when the mirror updates, and a third time
  when the translation arrives.

  1 case can possibly remain. In Chrome, an element with `role="alert"` or
  `role="alertdialog"` is an alert at the moment it appears, whatever its
  `aria-live` says. Thus a screen reader can still announce an alert one
  more time in the mirror in these cases:
  - The page adds the alert, or shows it after it was hidden, while the
    panel is open.
  - The page gives one of those roles to an existing element.
  - The mirror is built again (**Rebuild mirror**, or a recovery after the
    mirror was out of step with the page). This applies to every alert on
    the page, each time.
- **Images.** If the caption of an image translates the image's own `alt`
  or `aria-label` text, the translation is the name of the image. A screen
  reader does not read the caption again. Text read from the pixels of an
  image is new. Thus a screen reader reads it as text over the image, in
  its language. A piece that the translator returns as it was read (a
  number, a name) does not declare a language of its own.

### Size

The **Size** setting and the toolbar size button work in the same way for
web pages and PDFs:

- **Fit** fills the panel width. The page becomes larger or smaller to fit,
  up to 5 times its size.
- **1:1** shows the page at the size that the tab shows it. If you zoom the
  tab, Simul follows.
- **Custom zoom** multiplies the 1:1 size.

When **Follow source scrolling** is on, the mirror of a web page also
follows these:

- A pinch zoom in the tab (a trackpad pinch or a double-tap zoom). The
  mirror magnifies the same part of the page, in all size settings. With
  Fit, it shows exactly what the tab shows. If you stop following, the
  mirror shows the full page again.
- A sideways scroll of the page, as for a scroll down.
- A part of the page that scrolls by itself: a board of columns, a wide
  table in its own scroller, a carousel, a chat log, a code block, the main
  pane of an app-style page. The mirror puts each part where it is in the
  tab, also when it was already scrolled when the mirror opened. When such a
  part moves, the rest of the mirror does not move, and this includes your
  own scroll position in the mirror. When you scroll the mirror yourself,
  the full mirror moves, not a pane in it. Text fields keep their own scroll
  position, and the mirror does not follow them. When following is off, the
  panes do not move. When it is on again, they go to where the tab has
  them.

### PDFs

When the tab shows a PDF and you select Simul, the panel shows the pages of
the PDF in order. It uses the packaged pdf.js.

A PDF saved on your computer opens in a `file://` tab, and Simul cannot
read this tab. Give the file to Simul instead:
- When the panel shows a message and no page (for example, "Simul cannot
  read a PDF opened from this computer in a tab"), it offers
  **Open a PDF file…**.
- You can also drop a file anywhere on Simul, also on a mirrored page. The
  file opens and replaces what Simul showed. If you drop more than 1 file,
  the first PDF opens. A file that is not a PDF gives the message "This file
  is not a readable PDF."
- If Simul opens in a separate window, and you select Simul on a tab that
  it cannot read, that window opens (or comes to the front) with the
  message and the button.
- If the side panel is already open, and you select Simul on a tab that it
  cannot read, the message and the button replace the page that the panel
  showed. This also occurs when the panel is pinned to a different tab. A
  PDF that you opened from the computer continues to show. To show a web
  page again, select Simul on that page.

After this, a file from the computer works like a web PDF, with 1
difference: it has no site. Thus automatic translation follows the
all-sites setting, or occurs because **OCR** is on. The file continues to
show until Simul shows a different item: a page on which you select Simul,
a tab that you go to while Simul is set to **Follow**, or a different file.
The file continues to show when you move between windows or when a page
finishes its load.

**Rebuild mirror** reads the file again. If the file was moved or changed
in the meantime, the PDF closes, and you select it again. Simul keeps the
file only in the panel or window in which you opened it. While the file
shows, the ↗ button of the side panel is off. If you move a separate window
back to the side panel, the file does not go with it.

**Translate page**, From/To, Auto-detect, automatic translation, Cancel and
Live source only work as they do for web pages. Simul covers each
paragraph, heading or list item with the page's own background colour.
Then it writes the translation in its place, in the colour of the text. If
a translation is longer than the original, Simul makes it smaller, to a
minimum of half the original size. If it still does not fit, it goes past
its block, but not past the edge of the page, which clips it.

Simul translates the page that you read first, then the pages after it,
then the pages before it. If you scroll to a different location,
translation continues from there. Auto-detect uses the language tag of the
PDF if it has one. If not, it uses the text of the PDF. After the pages
show, Simul first reads all the text of the PDF ("Reading the PDF…"). Thus
**Translate page** becomes available a short time later (about half a
second for 300 pages), or after the language check of scanned pages below.
Translations appear on a page after the page is drawn.

- Simul reads scanned pages (images of text) with its on-device OCR, but
  only during translation. **Translate page** or automatic translation
  reads them, and starts with the page that you read. **Cancel** also stops
  the reading. Text pages never wait for scanned pages.

  No scanned page is read when Simul only shows a PDF, with Live source
  only, or when From and To are the same language. There is 1 exception.
  With Auto-detect, if the PDF has no language tag and no text (or text only
  on scanned pages, for example a header over each scan), Simul reads up to
  3 scanned pages to find the language. This takes about 20 seconds at
  most. It occurs 1 time for each PDF: when Simul has read the PDF's text,
  when From changes to Auto-detect, or when Live source only ends.

  The OCR draws each page itself (at most 4 megapixels and 300 dpi). Thus
  image access is not necessary, and the **OCR** switch on the toolbar does
  not apply. The image reading methods apply (all of them in the public
  edition; in the dev edition, the methods that are on under
  **Advanced & experimental**). Tesseract.js must be on, because Chrome's
  text detector alone cannot read a page.

  Simul reads a page when it has no text, or when its own text covers at
  most 3% of it and its pictures cover at least four fifths of it. An
  example is a scan under a typed header, page number or stamp. Simul does
  not change that typed text, and translates it immediately. OCR adds the
  remaining text, but not the text that only repeats the typed text. Typed
  text can be on a line of the scan (a page number beside a scanned footer,
  or a stamp across a scanned line). Then Simul keeps the scan's own words
  on that line and translates them as a separate piece, beside the typed
  text.

  A page with more text, or with smaller pictures, is never read. Simul
  examines the pictures of such a page only when it can read pages. If
  Tesseract.js is off, or the language has no OCR model, such a page does
  not change, and Simul says nothing about it. If Tesseract.js is off, the
  language has no OCR model, or Simul could not read a page, the status
  tells you. Simul does not try again to read a page that it cannot draw.
  For a PDF with no text, Simul shows "Simul found no text in this PDF."
  Simul does not change rotated or vertical text, also on scanned pages.
- Screen readers read each page ("Page 2 of 10") with its text, translated
  where a translation shows. Simul marks text that is not translated with
  the language of the PDF (the From language, or the detected language). It
  marks a translation with the To language. Thus a screen reader that
  changes voices can pronounce each text in its own language. 1 language
  applies to the full PDF. While Simul does not know this language, it
  marks the text as of unknown language.
- When **Follow source scrolling** is on (in Options, on by default), the
  panel follows Chrome's PDF viewer in the tab. The viewer tells where its
  most visible page is on the screen, but it never tells which page it is.
  Thus Simul calculates the page from Chrome's page layout and from the
  movement of the viewer.
  - Followed: a scroll with the wheel or trackpad; the arrow keys; Page Up,
    Page Down and Space; ArrowRight; these keys when you hold them down;
    Home and End.
  - Guessed first, then read from the toolbar of the viewer: all moves that
    jump in 1 step, for example the page box, the outline, thumbnails,
    links, Find and ArrowLeft. Simul does the same for the first position
    when you open Simul and the viewer is already partway down. It also does
    this for the position after a turned view is upright again, or after
    the two-page view ends. Simul assumes that a newly opened or reloaded
    tab is at its start (the top, or the `#page=N` of the address). When
    following is on, the panel also opens there.
  - How Simul reads the toolbar: after such a move, the viewer must be
    still for a third of a second, and Simul must know the zoom of the tab.
    Then Simul takes 1 picture of the tab. It keeps only the page number and
    the page count that Chrome's toolbar shows ("12 / 300"). It reads them
    on your computer with Tesseract.js, and moves the panel to that page. In
    a small window, this takes about a twentieth of a second. On a large
    high-density screen, it takes a quarter of a second or more, because
    Chrome gives a picture of the full tab. If you scrolled the panel
    yourself after the guess, the panel does not move from where you put
    it. From then on, it follows from the correct page.
  - Simul uses the number only when all of these conditions are true: the
    toolbar is where the viewer says its view starts; the count beside the
    number is the page count of this PDF; the number has as many digits as
    the box holds; 2 readings of it at different sizes agree; and the page
    fits the position where the viewer reports its page. If not, Simul
    keeps the guess. The panel is then that many pages wrong while you
    continue to read, until the next jump. Home from far away corrects it,
    and End also corrects it.
  - To Simul, a page turn that stops at the top of a page looks like a jump
    to that page. Thus Simul also reads it from the toolbar: ArrowRight and
    ArrowLeft at all zoom levels, and Page Down, Space and Page Up in fit to
    page. Simul takes 1 picture for each such turn.
  - Simul takes no picture when you scroll, at any speed (the wheel, a
    trackpad, the scrollbar), when you use the other keys, or when you
    zoom. It takes no picture while following is off, and no picture of a
    tab that is not visible. Simul follows each step of the wheel that
    Chrome does not animate (when smooth scrolling is off in Chrome), at any
    speed. A single long step of the wheel, a drag of the scrollbar across a
    long PDF, or a fling that is too fast to follow is still a guess.
  - Simul keeps the guess, as in 0.6.2, in these conditions:
    - Tesseract.js is off in Options. Simul then captures nothing.
    - The tab is narrower than about 420 px. Chrome's toolbar then has no
      page box.
    - The toolbar is hidden (an address with `#toolbar=0`, or the viewer in
      presentation mode). Simul does not capture such a tab.
    - A menu of the toolbar is open.
    - Chrome does not allow a picture of the tab: the access from the Simul
      icon has expired and all-sites access is off. Simul does not ask for
      access.
    - The number in the page box is selected, or you type in it. After a
      picture shows this, Simul does not look again until the next jump.

    If the toolbar showed no page box 3 times in sequence, Simul does not
    examine it for 1 minute. Simul also reads Chrome's toolbar in forced
    high-contrast colours. This was checked with Chrome's own forced
    colours on Linux, but not yet with a Windows high-contrast theme.
  - Simul also examines a jump that occurs while the viewer still scrolls
    (an outline entry clicked during a fling). On a slow or heavily loaded
    computer, the jump can still look like part of the scroll. The panel
    then does not move from the page that it followed.
  - Simul also examines a jump that also changes the zoom (an outline entry
    or a link that sets its own zoom). This includes a jump from the top of
    one page to the top of a different page. Chrome reports such a jump more
    frequently than it reports a zoom.
  - When you press a key and the viewer cannot move farther (Page Down at
    the end of the PDF), Simul takes no picture. But 2 such presses in a
    tenth of a second, immediately after the press that reached the end,
    can cause 1 picture.
  - Simul must have the zoom of the tab to know which pages fit a position.
    Without the zoom, Simul cannot tell a view turned a quarter from an
    upright view. While the zoom is not known, Simul does not examine a
    position that it is not sure of. When the viewer is still, Simul asks
    Chrome for the zoom of the tab, and examines the position when it has
    the zoom. Chrome tells Simul when the zoom changes. If the viewer
    reports a position that fits no page at the zoom that Simul knows,
    Simul asks again. This request asks nothing of the page and takes no
    picture.
  - While Simul reads scanned pages, a look at the toolbar can wait for its
    turn.
  - At the top of a page, 2 actions look the same as ArrowRight: you set
    the zoom of the viewer to its current value, or you change it to fit to
    page. The panel goes down 1 page, and the toolbar corrects it. Simul
    guesses and reads a half turn (2 quarter turns) in the same way.
  - Pages of different sizes help Simul to know which page is which.
  - Simul also follows a sideways scroll in the viewer exactly: it scrolls
    the panel across the page as far as the viewer. You can see this when
    the page is wider than the panel, which is usual at 1:1.
  - The panel moves only when the viewer moves. Thus, if you scroll the
    panel yourself, it does not move until then. This applies to each
    direction: when you scroll the viewer down, the panel keeps the
    sideways position that you gave it.
  - Not followed: a PDF opened from the computer, the two-page view of the
    viewer, and a view turned a quarter (Rotate, Ctrl+[ and Ctrl+]). The
    panel does not move, and scrolls independently, until the view is 1 page
    wide and upright again. Then Simul guesses the position of the viewer
    and reads it from the toolbar, as after a jump. Simul never captures a
    turned view. Simul identifies a turned view from the zoom of the tab.
    Some PDFs have a page that is about as wide as a different page is tall
    (within 1%, for example portrait and landscape pages of 1 size). If
    such a PDF is turned, Simul does not see this, and then follows it
    incorrectly. The viewer of Microsoft Edge sends nothing.
- If Simul has no remembered position, a PDF opens at the page that its
  address names (`#page=3`).
- Simul draws only the pages near the view. In a very long PDF (more than
  about 12,000 paragraphs, usually several hundred pages), only some pages
  contain their text for screen readers and find: the pages near the view
  and the pages read first. A screen reader announces the other pages by
  their page number only. They receive their text when you scroll to them.
  Translation covers all pages in both cases, up to 50,000 paragraphs or
  about 8 million characters waiting at the same time (more than a thousand
  pages). Above that, the status says that the translation is partial.
  Simul releases text-only pages after it reads their text, and it sweeps
  the document every 32 pages. On the test computer, Simul read the text of
  3,000 pages in 1.3 seconds and the text of 10,000 pages in 5.4 seconds.
- If you go back to a PDF, or rebuild it, it opens at the position where
  you left it.
- Simul opens PDFs of up to 128 MB. A download that stops for 60 seconds
  fails. A slow download that continues does not fail.
- If a PDF is password-protected, too large, damaged, or cannot be
  downloaded, Simul shows 1 status that tells why.

### Image text

Image translation is **on by default**, and Simul saves it with your
settings. Pixel OCR waits until you grant image access from the **OCR**
button. While image translation is on, it also translates the page text of
the mirrored page. For images, Simul does these steps:

1. It examines policy-approved top-frame `<img>` elements on the full page:
   first the elements on the screen, then the others in the background.
2. It first tries direct `aria-label` or `alt` text. Pixel access is not
   necessary for this method, and it shows the text as a caption band along
   the bottom edge of the image. This method is on from the start. Thus
   images with alt text receive a translated caption before image access is
   granted. For a screen reader, that translation is the name of the image.
   When Simul then finds text in the image, that text replaces the caption.
   The caption stays only when Simul finds no text in the image. To turn alt
   text off, clear **Translate alt text when an image has no text**.
3. For pixel OCR, it reads an image on the screen from a crop of the
   visible tab, after it makes sure that the geometry of the image is
   stable. Some images are read from their own file instead: an image off
   the screen, an image that moves, an image in a background tab, or an
   image in a pinch-zoomed tab (the pixels of the tab then show the
   magnified view). Simul tries these files in this sequence: the copy that
   the mirror already loaded, then the page's own copy for same-site
   images, then (Passive fidelity only) a cache-first download of the same
   URL without cookies. If Simul cannot read the file of an image while the
   tab is pinch-zoomed, it reads the image from the tab immediately when the
   pinch ends. For some images, only CSS decides the picture
   (`content: url()` of a different picture, or an `object-view-box` that
   shows a part of the file). Simul reads these images from the screen
   only, because the file is not what the image shows. Simul makes each crop
   smaller, to a maximum of 4 megapixels.
4. It tries Chrome TextDetector only when the platform already has the
   model installed. A model that Chrome could download counts as
   unavailable. Then it tries the packaged Tesseract.js 7.0.0 fallback, in
   the saved method order.
5. It rejects blank results, results with only punctuation, and results
   with insufficient confidence. Text that remains is the text of the image,
   and it is shown instead of the alt text.
6. It translates the accepted lines and puts inert overlays over the mirror
   image.

The Tesseract worker, the WebAssembly cores, the notices, and 22 pinned
`tessdata_fast` language files are packaged with the extension. No OCR code,
model, image pixel, or recognized text is fetched from a remote OCR service
or sent to one. Crops use short-lived extension storage for the offscreen
handoff, and Simul deletes them after the job. OCR and translation caches
are bounded and memory-only.

OCR reads top-frame `<img>` images, on the screen or off it. It does not
read CSS backgrounds, canvas, video frames, embedded documents (Simul shows
a PDF tab instead; see [PDFs](#pdfs)), hidden images, or pixels that overlap
credential fields. Text that a page draws over an off-screen image is not
part of the image file. A public text field, button, or link that overlaps
an image does not block capture. Only password fields and other credential
fields block it, at all positions over the image. Text from a different
element over the image prevents the capture when the check finds it. But
the check examines only a few fixed points on the image, so Simul can still
read a thin caption between them. For the detailed boundary, see
[Image text translation](image-translation-research.md).

### Options

The toolbar contains the controls that you use most: From (with
Auto-detect) and To, swap, **Rebuild mirror** (↻), Size, the **OCR**
switch, Follow or Pinned, quick translation, the detached window, and the
options (⚙). The Options panel contains:

- **Automatic translation**: Off, This site, or All sites.
- **Size** and the zoom slider.
- **Follow source scrolling** (on by default).
- **Translate page**, and **Cancel** while a translation runs.
- **Read profile**: **Page only** (the page's text and pictures only),
  **Standard** (adds button labels, button pictures and folded sections), or
  **Full visible** (adds the content of forms and text editors), which is
  the default. Passwords, one-time codes and card numbers are never read.
  See [Privacy and security boundary](#privacy-and-security-boundary).
- **Image text**: on or off, **Translate alt text when an image has no
  text** (on by default), and the button that grants image access when
  Chrome requires it.
- **Reset all extension settings**.
- **Advanced** (closed until you open it): **Translated text** (Let boxes
  grow or Keep geometry), **Toolbar opens** (Last used view, Always side
  panel, or Always detached window), and **Minimum OCR confidence**.

At the start, the To language is Chrome's own language if Simul can
translate into it. A regional variant, for example `pt-BR` or `zh-TW`,
counts as Portuguese or Traditional Chinese. If Simul cannot translate into
Chrome's language, the To language is English. Simul keeps a To language
that you selected.

All other settings have fixed default values: Passive Fidelity, the default
size limits of the mirror, every image reading method in the default order,
visible images read first, small images skipped, and no local Prompt for
image text. The release zips and the Chrome Web Store contain this edition.

A separate dev edition for tests (see [Development](#development)) adds
those settings, all under **Advanced & experimental**: the per-item read
choices, Mirror text and fidelity, the size limits,
**Show everything (testing)**, the image reading methods, scan order, small
images, the Prompt options, and OCR diagnostics. It also adds a first-run
read-profile question for settings saved before that question was removed.
The public edition does not use a value set in the dev edition.

## Privacy and security boundary

Reading and acting are separate contracts. Wider readable-content settings
never make the mirror interactive.

Simul starts at **Full visible**, without a setup question: the mirror
shows what the page shows. To make it narrower, use **Read profile** in
Options. The Page-only, Standard, and Full visible profiles (and, in the dev
edition, custom choices for each item) control which of these the mirror
can read: public control semantics, non-secret images in controls,
validated disclosure content, visible text/search/URL/textarea values and
selection state, personal/autofill values, and editable text. The public
edition reads custom choices saved by the dev edition as the widest profile
that reads nothing more than they did.

All profiles block passwords, authentication and one-time-code fields,
WebAuthn and payment-card autocomplete classes, hidden inputs, file names,
and CSS-masked text. A file input shows as the empty field that the page
draws. Password, card and one-time-code inputs show 1 dot for each
character, as the page does. Simul reads only the number of characters, and
only when form values are allowed. A node classified as secret continues to
be secret for that document. When you make the scope narrower, Simul clears
the current mirror, translations, and image overlays before it rebuilds.

**Show everything (testing)** is only in the dev edition, under
**Advanced & experimental**. It sets all privacy filters to off, so that you
can find out whether a privacy rule hides a missing part of a page. Hidden
text, labels, card numbers, one-time codes, and form values are then copied
as the page holds them (typed passwords are not). The mirror still cannot
act on the page. The setting is off by default. The public edition does not
contain it, and ignores it if a dev build saved it as on.

**Closed shadow roots.** A page component can close its shadow root. This
hides the inside of the component from the page's own scripts. Chrome
allows an extension to read such a root, and the mirror reads it. A closed
component shows with its text, images, menus and scrolling parts, as the
rest of the page does. All the rules above apply inside it. Simul
identifies password, card and one-time-code fields there and shows them as
dots.

1 case remains. Nothing tells Simul when a component attaches a new root to
an element that is already on the page. Simul asks about it when a person
clicks, types or moves the focus inside it, before the page's own handlers
on the component run. While the panel is open, Simul also asks when
something changes there, in turn with the rest of the page. Simul uses a
root that it finds in this way from then on. It also reads the page again
at that time. Thus Simul corrects text that it already sent as public, and
does not wait for a different change.

Until a reader finds the root, nothing knows that it is there. A password
field in such a root can show in clear text before Simul asks, with no
input from a person inside the component. (For example, the page fills it
after a click at a different location, or it handles all clicks and keys
for the full window before Simul sees them.) Simul then reads the field as
the plain text field that it is at that time. This is the same as for a
field that showed in clear text before Simul was first opened. Other
extensions frequently draw their own parts of a page inside closed roots (a
password manager's suggestion list, a grammar checker's bubble). While the
tab shows them, the mirror also shows them. Simul does not read the insides
of the browser's own controls (the editor of a text field, the buttons of a
video).

**Frames from other sites.** A page can show a frame from a different
site, for example a "Continue with Google" button or the output of a code
example. Chrome does not let Simul's reader in the page read inside that
frame. Simul runs the same reader in the frame itself, with the same read
profile and the same rules for passwords and card numbers. The reader in
the page holds the frame's box at its size, and the mirror draws what the
frame shows in that box. Simul translates its text as it translates the
page. When the frame changes, the mirror changes too.

To find which box a frame goes in, the reader in the page sends each frame
a random token, and nothing else. What the frame's reader reads goes to the
panel, and never through the page. Simul reads only the page's own frames
(not a frame inside a frame), at most 12 frames of a page. These frames
stay as blank boxes of the same size:

- A frame inside a frame.
- A frame that the page places outside the flow (fixed or absolute).
- A frame with more than 4,000 nodes.
- A frame on a site that Simul cannot read (Site access set to On click).

Simul does not read text in images inside a frame.

Simul reads a PDF opened from the computer from the file that you selected,
and makes no request. The panel keeps only a reference to the file, and
never after it is closed.

To follow Chrome's PDF viewer, Simul adds a small script to the PDF tab.
The script asks the viewer for its scroll reports. It passes on 5 numbers
(the position of the most visible page and the size of the viewport), the
time of each, the width of the scrollbar that the tab draws, and the
scaling of its screen, and nothing else.

The viewer never tells which page it shows, but its toolbar does. After a
move that Simul can only guess (a jump, the first position, a view turned
back), and only on a PDF tab that it shows and follows, Simul takes 1
picture of the tab. It uses the same call as image text
(`tabs.captureVisibleTab`, with the access that the Simul icon gave or
all-sites access). It does not ask for more. From the picture, Simul keeps
the top 56 px for a short time and finds the page box there. Then it makes
a small grey picture of only 2 items: the page number and the page count
("12 / 300"). Simul releases the picture of the tab before it reads
anything, and it never looks at the area below the toolbar.

The local OCR host reads the small picture as it reads all images (through
the same temporary storage, which is deleted when the reading ends). The
text that it reads is kept in memory. Nothing is saved, and nothing leaves
the computer. Simul does not capture a tab whose toolbar is hidden. This
look does not wait for the image access that image text on web pages asks
for. The OCR button does not switch it on or off (the words of the button
are about images on web pages). If you switch Tesseract.js off in Options,
this look stops too.

On a PDF tab, Simul makes 1 more request: it downloads the PDF's own URL,
which the tab already loaded. Chrome keeps the cache of the extension
separate from the cache of the tab. Thus this is a second download of the
same file. Simul uses its own copy again while that copy is fresh. The
site's cookies go with the request, as they did for the tab. Simul requests
nothing else for a PDF.

Scanned pages are read on the computer, by the same local OCR as images. As
for an image, the drawing of each page goes to the local OCR host through
extension-origin temporary storage. The recognized text is kept in memory.
A crop is refused after 2 minutes. An expired crop is deleted in one of
these ways: by the sweep of the OCR host every 30 seconds while a host is
alive, by the service worker when it starts, or by a new host when it is
built. This does not cover a browser restart that never starts the service
worker.

Diagnostics contain bounded stages, dimensions, and counts. They do not log
page text, recognized text, URLs, pixels, hashes, DOM IDs, or attribute
values. Simul includes no analytics, credentials, remotely hosted
executable code, or cloud translation/OCR integration.

### Permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporarily authorize the page after a user gesture. |
| `scripting` | Start the exact-document mirror bridge and bounded observers. |
| `sidePanel` | Host the native Chrome companion. |
| `storage` | Save settings and explicit automatic-translation scopes. |
| `offscreen` | Run packaged local OCR away from the visible companion UI. |

Since 0.7.0 (D166), `<all_urls>` is a **required** host permission. Thus
the panel follows each page and tab that the reader opens, and the reader
does not have to click the Simul icon on each new site. Chrome allows the
reader to withhold it (Site access: On click, or chosen sites). Then Simul
reads a tab after the reader selects its icon on that tab. A saved feature
that must have the access is paused. The panel's message that asks for the
icon offers **Allow on all sites**, which asks Chrome for the access from
that click. Simul never removes the required access (Chrome would refuse).
It releases only narrower site access that it asked for and that is no
longer necessary, and **Reset all** clears those.

## Fidelity

The default **Passive Fidelity** policy keeps a wide, bounded set of
passive CSS, images, fonts, responsive sources, static posters, and static
SVG presentation. Those references can make ordinary HTTP(S) requests to
their existing hosts. **Conservative** accepts fewer passive semantics, but
it is not a zero-network mode. Both policies keep the same sandbox without
scripts and the same blocks on active content. The public edition uses
Passive Fidelity and the default size limits. In the dev edition, the
policy, the mirror's size limits (largest single item, largest page, most
page elements), and **Show everything (testing)** are under
**Advanced & experimental**.

Simul is a safe reconstruction, not a browser clone. These are the current
limits: script-only custom-element state, virtualized DOM that the page has
not created, inaccessible cross-origin CSSOM, generated pseudo-element
text, canvas/video pixels, protected media, active embedded documents, and
the frames listed under "Frames from other sites" in
[Privacy and security boundary](#privacy-and-security-boundary). A
stylesheet that Simul cannot read (a different origin without CORS) can
hide a dropdown. A sheet with more rules than Simul reads can also hide a
dropdown. Simul does not show such a dropdown when its panel opens, because Simul does not show what it cannot
prove that the page would show. Simul does not claim exact pixel parity.

For the complete design and the reasons for the browser boundary, see
[Mirror fidelity](replica-fidelity.md) and the
[translation companion architecture](translation-companion.md).

## Troubleshooting

- **Chrome says the manifest is missing.** The folder that you selected is
  not `dist/chrome-unpacked` itself (for example, it is the repository
  root). Select `dist/chrome-unpacked` itself.
- **The icon does not work.** Chrome blocks extension access on some
  internal and protected URLs. Try a normal HTTP(S) page.
- **A PDF on the computer (a `file://` tab) does not open.** Simul cannot
  read `file://` tabs, even when **Allow access to file URLs** is on.
  Select **Open a PDF file…** in the panel. As an alternative, drop the
  file on the panel.
- **Nothing translates at all.** The browser must have the Translator API:
  Chrome 141 or newer, Edge 148 or newer, or Opera 125 or newer, on a
  computer (https://caniuse.com/mdn-api_translator lists them). Other
  browsers can load Simul, but they cannot translate with it.
- **A language pair is unavailable.** Chrome's on-device Translator has not
  prepared that pair.
  1. Update Chrome.
  2. Allow its on-device Translator to prepare that pair.
- **Automatic translation paused after navigation.** Temporary `activeTab`
  access does not go from one site to another. Select Simul again. As an
  alternative, explicitly grant the intended site or all-sites scope.
- **Image text is unchanged.** OCR is on by default, but pixel reading
  waits for image access. Small images are skipped by default. An image
  inside a link or button is read only under the **Standard** or
  **Full visible** readable-content scope (Page-only does not read images in
  controls).
  1. Select the **OCR** button to grant image access.
  2. Keep the image visible in the source tab.
  3. Use a supported source language.
- **The mirror is out of date.** Simul cannot safely observe some
  closed-root, opaque resource, CSSOM, and script-only changes. Select
  **Rebuild mirror** (↻ in the toolbar).
- **An update still looks old.** Chrome, the source tab or the panel can
  still use the earlier version of Simul.
  1. Reload Simul at `chrome://extensions`.
  2. Reload the source tab.
  3. Open the panel again.

## Development

You must have Node.js 24 LTS and npm 12. Install the locked dependencies:

```sh
npm ci
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start WXT's development runner. |
| `npm run build` | Build the Chrome extension under `.output/`. |
| `npm run artifact:sync` | Validate and refresh `dist/chrome-unpacked/` (and the dev edition where the checkout keeps it). |
| `npm run artifact:check` | Rebuild, validate, and byte-compare the checked-in artifacts. |
| `npm run typecheck` | Type-check source and tests. |
| `npm test` | Run the Vitest suite one time on Node 24. |
| `npm run check` | Run typechecking, all tests, and the artifact check. |
| `npm run zip` | Create WXT's Chrome distribution archive. |

Do not edit `dist/chrome-unpacked` by hand. To make a change:

1. Change the source.
2. Run `npm run artifact:sync`.
3. Run `npm run check`.

Simul builds in 2 editions from the same source. `SIMUL_EDITION` selects
the edition at build time (`lib/edition.ts`). If it is not set, or has a
different value, the build is the public edition. If it is `dev`, the build
is the dev edition, and its version name ends in `dev`. The public edition
does not include the dev-only controls in its pages and bundles. It reads
each setting that it does not show as its default (in
`lib/preferences.ts`). Storage keeps all values that were saved.

The tests run as the dev edition. Where the public edition is different,
they pass the edition explicitly. `npm run check` is the required handoff
gate. The test suite must have Node 24, because the vendored pdf.js uses
`Promise.try`. On a different major version, a test run stops at startup
with a message.

Runtime entrypoints are under `entrypoints/`, browser-independent logic is
under `lib/`, tests are under `tests/`, and durable project knowledge is
under `docs/`.
