# Translation companion design

## Live mirror lifecycle

The canonical renderer converts the current page into a privacy-sanitized,
typed DOM graph in Chrome's isolated world. It reconstructs that graph in a
same-origin-only, inert, scriptless sandbox. Ordered patches are validated
before application; gaps recover through a staged checkpoint and atomic swap
while the last good replica stays visible. Isolated HTML is the only renderer.
An initial failure stays local and retryable; after a
commit, one bounded recovery keeps the last-good replica visible and a repeated
failure surfaces without changing engines.

Source scroll messages are animation-frame throttled and one-way. Standards
and body/document scroll fallbacks are normalized before transport. When a
site instead uses a visible, viewport-scale nested vertical scroller, Simul
tracks that surface by proportional progress, including scroll events inside
an observed open shadow root. Initial status and dimension announcements do not
guess that a pre-scrolled nested surface owns scrolling: only a qualifying real
nested-scroll event can take ownership. Text controls, non-scrollable hidden or
visible overflow, small carousels, and incidental horizontal strips cannot take
ownership. Nested coordinates remain clamped to the source nested range during
replica extent refresh rather than the document range. A changed document
offset immediately returns ownership to the document; removal, loss of
scrollability, and range shrink clear or clamp a stale nested owner.

Scroll is carried by the locally bundled `page-mirror` stream that already owns
the exact-document checkpoint and patch transport. The source coalesces real
scroll events once per animation frame, and the typed receiver ignores invalid
or stale identities without logging coordinates, URLs, or page content.

The most recent source position is retained even when it arrives before a
staged replica commits, then applied as soon as that replica becomes visible.
Navigation and an explicit rebuild reset the retained position and ownership so
an earlier page cannot move the new one. The mirror follows by share of the
scroll range, not by pixels (D100): when the page is 40% of the way down its
range, the mirror is 40% of the way down its own. A translation that makes the
page longer therefore scrolls the mirror further, a little faster, and both
reach the end together; while translations land and the mirror grows, it keeps
that share. Equal ranges keep exact pixels. Nested panes, and the page offset
around them, are followed the same way. No mirror interaction is sent back to
the website.

The mirror moves only when the source position actually changes. The source
re-reports its unchanged position after every layout change (an image load, a
font, a resize) and with each checkpoint; those repeats leave the reader's own
scrolling in the mirror where it is, in the mirror's own pixels. The panel
tells a reader's scroll from the scroll event its own following causes by the
position it set. Turning scroll following back on re-aligns the mirror with
the source.

This retains direct document coordinates together with event-qualified
nested-scroll support in the sole isolated transport.

Full checkpoint capture is not scheduled periodically. It is used for initial bootstrap,
navigation, a manual rebuild, or bounded recovery. Exact document identity,
sequence, source revision, translation epoch/pair, and replay lease checks
discard stale asynchronous work.

## Translation and saved settings

The source preference can be a language or Auto-detect. Auto-detect uses the
document's HTML `lang` value first, normalizes its BCP-47 tag, then falls back
to at least four unambiguous script characters occupying 60% of the visible
sample, or Chrome's local `i18n.detectLanguage` result only when it is reliable. If page
text still cannot establish a source language and OCR is enabled, Simul may
probe up to three privacy-approved source images, six representative packaged
language routes per image, 18 routes total, and 20 seconds from the first probe.
Japanese is attempted on every crop. A single crop can resolve the page only
with at least three dominant-script characters and at least 90% supplied OCR
confidence; confidence-free evidence must agree across distinct source images.
Changing pixels or animation frames on one source image does not create a new
corroborating sample. The
result is memory-only page evidence, never a saved From choice, and explicit or
nearest-element language remains authoritative. An equal resolved pair is an
explicit no-op.

The visible sample is built lazily from bounded, sanitized isolated-replica
text records; no second page snapshot or renderer is involved.

Chrome 138 exposes Translator pair availability and session creation but does
not expose language enumeration. Simul therefore shows Chrome's documented
language list and probes the selected pair at runtime. Both menus use a single
specified order based on the English reference name, rather than locale-aware
sorting that would move choices between sessions. The From menu begins with
Auto-detect and renders the remaining names in the selected target language.
Once Auto-detect has resolved the page, that first entry names the result,
for example `[A] English`, and it reads Auto-detect again until the next page
resolves (D84).
The To menu uses the same code order but renders every name as its native
endonym, including separate Simplified and Traditional Chinese labels. Language
changes reset the visible strings and immediately translate again. Chrome
requires a user action before a model's first download, and choosing the
language is that action, so a pair whose pack is not installed starts
downloading and translating at once (D85); if the choice is too old for
Chrome to accept, the status asks for Translate page. When any part of the
panel (the page, images, the panel's own labels) installs the pack for the
current pair, a page translation waiting for it resumes.

`browser.storage.local` holds only settings: From/To languages, Fit/1:1/custom
zoom, zoom percent, adaptive/faithful text layout, scroll following, explicit
automatic-translation scopes, the selected replica-fidelity policy, and
image-analysis options, plus the selected readable-content scope and its
setup/reset revisions. Image translation is on by default; pixel OCR waits
for the optional image-access grant. Composer input,
output, page text, accessibility labels, OCR text, and translation results are
never stored.

Page translation uses a bounded, memory-only exact-content LRU. A cache key is
the translation provider, normalized source/target pair, and complete source
string—not a DOM node, page, document, or URL. Identical requests from another
node or a live source update reuse the result, and matching requests already in
flight join one provider call. Projection still requires the exact current
document, revision, translation epoch, pair, and replay lease, so reusable text
does not weaken stale-result protection.

The slim full-width toolbar exposes Refresh; the From label, `[A]` (set From to
Auto-detect), and a wider From selector; swap and a wider To selector; Fit/1:1
size; OCR On/Off; Follow/Pinned tab following; quick reverse translation; Settings;
Side/Popout; and the replica-state label at the far right. It scrolls
horizontally only at unusually narrow widths. A healthy toolbar has no detached
status dot. Warning and error markers attach to Refresh or Settings according
to the action that can resolve the condition.

Visible toolbar and Settings copy is resolved as one atomic set in the selected
target language. Exact repeated English labels share the existing in-memory
provider/pair/content translation cache. English is painted immediately; if
the local Translator is unavailable or any label fails or is empty, the
complete interface remains English rather than showing a partially translated
set. A later target-language change invalidates stale asynchronous UI work.

Quick translation reverses the active page pair,
uses the same provider/pair/exact-content memory as page text, retains its draft
and result only in the current companion window, and stays disabled with
guidance until Auto-detect resolves the website language. Settings and quick
translation are mutually exclusive overlays below the toolbar. The toolbar
background presents determinate page-translation progress or indeterminate
capture, permission, quick-translation, image-analysis, and
surface-transition activity without intercepting pointer input. Reduced-motion
preferences disable decorative progress animation.

## Runtime readable-content scope

Reading and acting are separate contracts. The replica remains scriptless,
pointer-inert, unable to navigate or submit, and unable to forward source
events under every setting. A new install and a reset start at Full visible
with no setup question (D66, the owner's D54-addendum ruling); the user can
narrow it in settings. Stored preferences saved before D66 that never completed
setup keep the setup dialog, and until it is committed the effective scope is
Page-only. Page-only, Standard, and Full visible are presets over six
independent switches, and any other combination is shown as Custom:

- public control labels and semantics;
- non-secret images inside controls;
- validated same-document disclosure content;
- ordinary visible text/search/URL/number/date/time/textarea values and
  selection state;
- personal/autofill values such as names, addresses, usernames, email, and
  telephone; and
- visible non-secret contenteditable or ARIA editor text.

Password fields, CSS text-security fields, hidden inputs, file names and
paths, password/authentication/one-time-code/WebAuthn autocomplete, and every
`cc-*` autocomplete token are a floor no read scope lifts; only the Advanced
**Show everything (testing)** switch does (D75, see
[Replica fidelity](replica-fidelity.md)). A file input is drawn as the empty
field the page shows (D75). A credential input is drawn with one dot per
character, as the page draws it (D76, D91): only the length of its value
travels, under the form-values setting, and never its characters.
Classification occurs before
reading; once a node is classified as a secret it remains secret for the
document lifetime. A narrower live setting clears source-derived replica,
translation, and image state before the new preference is saved. Reset commits
setup-zero safe defaults first, then clears transient work and reconciles
Simul-managed optional origins; interrupted permission cleanup is retryable.

## Local image text

When explicitly enabled, an exact-document source Port observes top-frame
`<img>` elements by the isolated engine's private node ID without emitting
their URL or text. One saved priority list contains direct accessibility text,
Chrome TextDetector, and packaged Tesseract.js. The accessibility method lazily reads only a
direct image `aria-label` or `alt`, after policy and credential checks, and can
translate/project it as one inert caption band along the image's bottom edge
without screenshot access. The band takes a third of the image, growing to at
most 60% when long text on a short image would otherwise shrink below about
9px (D72). This method is on from the start (D66), so with image translation
on by default every eligible image with alt text gets a translated caption
before any image access is granted.
Decorative, hidden, zero-area, filename/URL-like, or secret-overlapping evidence
is rejected. Positive-area accessibility labels are not blocked by the OCR
small-image setting.

Pixel capture remains blocked for credential overlap. Images inside native or
ARIA controls are admitted only when the independent control-images switch is
on and are checked again immediately before and after capture. The saved scan
policy orders visible/near/background work, and very small pixel-OCR images are
skipped by default. Only stable visible pixels are captured, at no
more than two viewport captures per second, after matching pre/post document,
scroll, bounds, and revision. High-DPI crops are proportionally downscaled
before OCR so the processed bitmap never exceeds 4 MP; the CSS crop geometry
is retained for overlay placement.

The offscreen extension page reads a short-lived crop from extension-origin
storage. Chrome TextDetector is tried only when the platform exposes it;
packaged Tesseract.js 7.0.0 provides the deterministic local fallback. The
routed language is chosen from nearest valid element `lang`, explicit From,
then detected page or bounded image-probe evidence. Tesseract loads
`jpn+jpn_vert` for Japanese. Recognition uses a
bounded memory-only content cache keyed by the ordered provider/runtime/model
route, source language,
quality-policy version, selected confidence threshold, preprocessing profile,
processed dimensions, and SHA-256 pixel hash—not by node, source document, or
image URL. Exact concurrent requests join one recognition load, and completed
results remain reusable across live source refreshes while the companion stays
open. Both entry count and aggregate transcript/region weight are bounded; an
oversized result is returned for the current job but is not retained.
A translated result read while the whole image was on screen is also kept by
the image itself (D86): the replica image's address, natural size, rendered
size and object-fit/-position, with the pair and reading settings. A carousel
slide that comes round again or an image scrolled back into view moves its
visible crop, which used to force a new capture and recognition each time; it
is now overlaid from that result without either. An image confirmed to have
no text (two reads of the same pixels found none) is kept the same way and
settles without a capture when it returns (D87); one whose pixels change
between reads, such as a slide caught mid-transition, is never kept, so it
cannot hide real text. The results are memory-only,
bounded, expire after 15 minutes and are purged with the other image results.
Any other repeat of a URL is reused only when its processed pixels and
geometry inputs match, because a responsive, resized, cropped, or animated
rendering can produce different overlay coordinates.

The transient crop is deleted after the job and expires after two minutes if
cleanup is interrupted. An unchanged empty result must be observed twice
before it enters the recognition cache, and transient capture failures receive
only one immediate retry. Provider-neutral quality filtering drops blank,
punctuation-only, and regions scored below 25%. A saved 25–95% minimum,
defaulting to 65%, controls authoritative scored text. Confidence-free and
intermediate-score text is accepted only when another provider returns the
same NFKC/whitespace-normalized text at bounding-box IoU 0.5 or greater.
Changing the threshold clears overlays and reprocesses current images under a
new cache identity. Explicit same-language pairs stop
before source capture. Auto-detected work uses the nearest valid image/element
language and stops before recognition when that resolved language equals To.
Each image's translated line boxes live in an inert `simul-image-overlay`
element inside the image's parent in the replay document (D74). It is
absolutely positioned with no z-index, so it paints where the image paints:
a pop-up, sticky header or menu that covers the image covers its translation,
and a dimming backdrop dims it. It takes no part in layout, resets every
property with inline `!important`, and keeps its boxes in a closed shadow
root, so page CSS cannot restyle them. Where the parent can host one (a
`div`, `span`, `p`, `section` and the like, without a shadow root of its
own), the element lives in a closed Simul-owned shadow root on the parent,
after a slot that shows the parent's own children unchanged (D92): page
rules that count siblings (`img + p`, `:last-child`, `:nth-child`) do not
see it, and the mirror patches the parent's children as before. It then
paints after all of the parent's children, so a later positioned sibling (a
badge over the image) no longer covers the translation. Any other parent (a
link, a `picture`, a `figure`, a list item) keeps the element right after
the image, where sibling rules such as `img + figcaption` still see it. When
the mirror rewrites the image's parent, the next refresh puts the element
back. It is placed
by measuring where it lands, so a transformed or zoomed containing block is
handled; rotation is not. Text wraps and uses bounded font-size reduction
within the recognized box instead of forcing a single clipped line. Each
overlay covers only the part of the image that clipping ancestors (a carousel
window, a scroller) leave visible, so it never widens the page, is hidden
while the image is not painted (a faded-out slide), and is re-measured every
frame for a bounded time while a transition or animation moves the image,
then once more when that motion ends. Painted logo labels likewise carry no
z-index of their own. Document, content revision, SHA-256 pixel key,
replay lease, pair epoch, replica image, and normalized geometry must still
match at commit and on refresh.
Overlay entries retain a bounded aggregate DOM/text weight. A cached layout
size lets stable scroll frames update currentness and position without
remapping regions or rerunning bounded font fitting.

## Rendering and privacy

The size follows the tab's browser zoom (D104). The panel reads it with
`tabs.getZoom` at each capture and follows `tabs.onZoomChange` for the
followed tab; an unreadable zoom counts as 1. The rule lives in
`lib/display-scale.ts` and is shared with the PDF view:

- **1:1** scales by the tab's zoom, so the page is the size the tab shows. At
  100% one captured source CSS pixel is one mirror pixel.
- **Fit** is the panel width over the source width, with no cap, so it grows as
  well as shrinks. A zoomed tab already has a narrower CSS viewport, so Fit
  follows the tab's zoom without using the factor.
- **Custom zoom** is the zoom percentage times the tab's zoom, kept within
  0.25–5.

The source viewport width remains the layout containing block; the captured
document width drives horizontal overflow.

The isolated base stream keeps optional labels, accessibility attributes,
values, checked or selected state, and disclosure relationships out. A
separate exact-document semantic channel admits only the capabilities selected
in the live readable-content scope. Standard can add translated public control
and option labels, disabled semantics, native select shape, and validated
disclosure content; ordinary/personal values, selected or checked state, and
editable text require their respective broader switches. Source secret
classification remains authoritative underneath this supplement. The receiver
checks each record and proof on its own: one it cannot place (its node is
missing, the replica classifies it differently, or two relationships claim
one node) is dropped by itself, and a batch is refused whole only when the
stream itself is broken (a forged identity or a revision rewind) (D96). Until
D96 one refused item refused the batch, which purged every label, menu and
control state for as long as the page kept sending it (D62).

A public single-row select becomes a companion-owned trigger whose top-layer,
internally scrolling list escapes source clipping, stays within the replica
viewport, and repositions on scroll or resize. `multiple` and authored
`size>1` controls remain bounded inline lists. The same presenter is used by
Isolated HTML, and may also preview a custom menu, opened in place with
the page's own styles (D88), only when a typed proof names one unique
same-document `aria-controls` target with matching semantics. Missing, duplicate, stale, private, editable, or
forged mappings remain static and inert. Local preview events change only
replica-owned presentation: they never select, submit, navigate, or send an
event to the source page.

Raw option values, names, data attributes, datalist/standalone-option content,
rich picker descendants, and private select ancestry stay blank. Password,
authentication, payment-autofill, hidden-input, file-name, and CSS-masked
secrets stay outside every scope and never disclose their text. The one
exception is length: a credential input the replica draws as its own field
shows one dot per character, as the page does, so under the form-values
setting its length travels as a bounded count (D91). A field that becomes
sensitive clears its prior semantic record and projection atomically.

Other private controls become empty inert shells rather than disabled form
controls, avoiding browser disabled-state wash while retaining geometry.
Public button labels remain translatable inside inert shells.

The "Translated text" setting chooses how translations take up room (D101).
"Let boxes grow", the default, lays translated text out with the page's own
styles, so a longer translation makes its box, and the page, longer. "Keep
geometry" holds every box that shows translated text at the size it has with
the page's text, so nothing around it moves and the mirror keeps the page's
layout and length. Text that no longer fits shrinks until it does, down to half
its size; past that it overflows as the page's own styles allow. Margins and
padding stay at the page's pixels while text shrinks, and a table cell, whose
size is only a minimum, keeps its size by shrinking alone. The boxes are
measured with the page's text put back for the length of one task, so the page
text never paints, and are measured again whenever translations, patches, the
viewport, or late images and fonts change the layout. Switching back to "Let
boxes grow" returns every box to the page's styles.

The extension transports no raw source HTML. Checkpoint, patch, and semantic
boundaries allowlist tags, style properties, attributes, image schemes, and the
narrow typed semantic records above. Scripts, handlers, navigation semantics,
raw `value` attributes, credential secrets, and cross-origin frame content
never enter the mirror; approved visible values travel only through the scoped
typed channel. Open shadow trees and slot assignments are
composed; closed roots remain inaccessible by web-platform design. The live
bridge discovers roots present during capture, roots on newly inserted DOM,
and roots created as previously undefined custom elements upgrade. The web
platform exposes no general event when an already-defined, already-connected
host attaches a root later; if that happens without a DOM, resize, focus, or
load signal, a manual rebuild may be required.

The isolated renderer also carries two narrow source facts that are difficult
to recover after scripts are disabled: a boolean for the canonical clipped
1px screen-reader-only pattern and a sanitized selected `currentSrc` for
responsive images. It does not transport arbitrary computed styles. Candidate
stylesheets settle through load/error outcomes, two paints, or a short fixed
deadline before the staged candidate replaces the last good view.

Isolated HTML has two saved fidelity policies, selectable under **Advanced &
experimental**. **Passive Fidelity** is the default. It preserves more inert presentation semantics and may cause
additional HTTP(S) requests from the replica. **Conservative** retains the
stricter sanitizer as a fallback, but still allows some visual resources and
does not promise zero networking. The planned **Strict Local Mirror** is hidden
until its no-network resource substitution and acceptance tests are complete.

Under Passive Fidelity, sanitized CSS remains in source cascade order across
inline declarations, `<style>` elements, passive stylesheet links, readable
CSSOM, constructed/adopted sheets, and styles inside open shadow roots.
Sanitization keeps custom properties, media/support/container queries, layers,
pseudo-element rules, passive fonts and backgrounds, SVG presentation
attributes, and bounded same-document effects such as
`fill: url(#brand-gradient)`. Readable CSSOM imports are recursively flattened
within rule, byte, and depth limits. If Chrome does not expose an import's
CSSOM, a normalized passive HTTP(S) `@import` may remain in Passive Fidelity and
may request again. Ordinary `insertRule`, `deleteRule`, mutable declaration,
disabled-state, media, or ordering changes are detected by a bounded signature
pass and trigger last-good checkpoint recovery rather than prototype patching.

Passive HTML retains normalized HTTP(S) anchor identity for selectors such as
`a[href]`, while pointer events and navigation remain disabled. It preserves
responsive `<picture>`/`<source>` candidates and selected image state. A video
is retained only when a sanitized static poster survives validation; posterless
video shells are omitted. Media sources, controls, autoplay, and playback remain
disabled. Passive inline SVG supports bounded static definitions,
gradients, patterns, symbols, clips, masks, markers, filters, and same-document
references. Normalized HTTP(S) `<image>`, `<feImage>`, and external `<use>`
references are admitted only in Passive Fidelity and remain subject to Chrome's
resource-fetch and CORS behavior. SVG scripts, handlers, navigation,
`foreignObject`, animation elements, and resource-changing attributes remain
blocked. Simul applies authoritative no-animation/no-transition declarations to
every reconstructed inline SVG node. Intrinsic animation inside an opaque
external SVG image remains a documented Chrome access boundary because the
outer document cannot inspect or pause it.

A bounded source-computed canvas color is carried with the initial graph and
live dimension patches. The renderer applies it to the reconstructed root,
iframe, mount, scale, scroll, and presentation-stage layers, and clears those
hints when the source returns to a transparent canvas. This is a generic dark-
theme fallback, not a site-specific OpenAI.com branch.

Fidelity still has browser-enforced boundaries. Closed shadow roots are not
observable. Cross-origin stylesheet CSSOM can be unreadable even though the
passive link itself renders. A source `blob:` URL is scoped to the source
environment and Simul does not reuse it; a loaded `blob:` or `crossorigin`
image within the size caps travels as the pixels the page decoded (D89). A validated source document
mode selects the shell: a standards page loads the doctype shell through
`srcdoc`, and a quirks page gets a blank frame into which the panel writes the
doctype-free shell, because an `srcdoc` document is always no-quirks (see
`docs/replica-fidelity.md`). A limited-quirks page (an XHTML 1.0 or HTML 4.01
Transitional or Frameset doctype) gets a written shell with the XHTML 1.0
Transitional doctype (D97).
Generated pseudo-element text is not a DOM text node and therefore cannot be
translated even when its rule renders. Broad computed-style serialization is
deliberately omitted because it can freeze responsive cascade behavior, expose
private presentation state, and exceed payload/performance limits. The
no-script replica cannot recreate custom-element state that only page JavaScript
creates. External SVG references may still be refused by Chrome's fetch/CORS
rules. Canvas pixels, current video/audio frames, protected media, and embedded
document contents are not reconstructed.

See [Replica fidelity](replica-fidelity.md) for the policy matrix, diagnostic
meaning, no-network follow-up, and the complete browser-boundary rationale.

## Reddit-class troubleshooting and submission limits

OCR Diagnostics assigns each attempt an ephemeral job number. Use that number
to follow capture, bounded retry, recognition, translation, projection, and
same-lease anchor-rebinding stages. Logs contain only safe dimensions, counts,
provider names, outcomes, quality-rejection counts, and content-free cache
hit/miss/join/load state—never page text, URLs, pixels, hashes, or DOM
identifiers. Mirror logs similarly report aggregate shadow-root,
adopted-style, hidden-label, selected-source, stylesheet outcome, and patch
replacement/reconciliation counts. The latter distinguish retained, inserted,
moved, and removed nodes. Fidelity counters identify preserved, flattened,
omitted, or blocked styles/SVG resources, reason categories, and resources that
may request from the replica. A request-capable count is a policy diagnostic,
not proof that Chrome made a network request. Logs never include text, URLs,
tag names, attributes, hashes, or node IDs.

Modern component sites can still depend on page JavaScript to define custom
elements, toggle `:defined`, populate closed shadow roots, expose
`ElementInternals` state, or virtualize off-screen rails. Simul deliberately
does not execute that code in the replica. Same-parent final-order patches now
retain receiver-proven direct children and transport graphs only for new nodes.
Covered descendant edits, privacy changes, cross-parent churn, and ambiguous
references still take the conservative full-child or checkpoint path. These
constraints mean the current release improves representable Reddit content but
does not claim pixel parity.

Useful content-free research for a missing rail or label is whether the source
element exists, whether its shadow root is open, its adopted stylesheet count,
whether it matches `:defined`, its computed `display`, `visibility`, `position`,
`clip`, and `clip-path`, and its bounding rectangle. For a missing image overlay,
record the OCR job stages and safe rendered/bitmap dimensions. Do not share
account text, URLs containing private tokens, or page HTML.

## PDF tabs

Chrome shows a PDF in its own viewer, so the tab's top document is an empty
shell and the mirror has nothing to copy (D103).

- **Detect.** The capture's one injected function returns
  `document.contentType` next to the frame's `documentId`.
  `lib/pdf/pdf-detection.ts` treats `application/pdf` as a PDF.
- **Branch.** After the tab-currency check, `CapturePipeline` hands a PDF to
  `PdfController`; the replica engine never runs. The branch reuses the
  capture generation, so a tab switch, navigation or invalidation aborts the
  load through `state.pdfAbortController` and a superseded load stays silent.
- **Fetch.** `lib/pdf/pdf-fetch.ts` downloads the tab's own URL with the
  site's cookies, under the tab's existing grant. Chrome partitions its HTTP
  cache by top-level site, so the extension never reuses the tab's copy; the
  request uses normal caching (`cache: 'default'`), which reuses Simul's own
  fresh copy and revalidates a stale one (`force-cache` could have shown an
  outdated file). It stops past 128 MiB (checked on `Content-Length` and
  while streaming, into one buffer when the length is known) or after 60
  seconds without a byte, and requires `%PDF-` in the first 1 KiB; markup in
  its place (a sign-in page, an XML error) counts as a failed download.
- **Open.** `lib/pdf/pdfjs-runtime.ts` opens the bytes with the packaged
  pdf.js in the panel's realm. Parsing runs in pdf.js's worker. None of
  pdf.js's HTML layers is used. Opening and measuring may take 60 seconds; a
  page pdf.js cannot measure takes its neighbour's size, and only a file with
  no measurable page is unreadable. A cancel ends the wait at once.
- **Show.** The controller mounts a document only after it opens and every
  page size is read, then destroys the previous one. `#pdf-view` holds one
  placeholder per page; `lib/pdf/pdf-layout.ts` places them and picks which to
  draw. Pages within one screen above and below the view are drawn one at a
  time, nearest first, at most 4 MP each. At most eight keep a canvas; a
  released page's canvas is zeroed and pdf.js frees the page. A page that
  fails to draw stays blank, takes no place in that budget, and is tried
  again after the next layout change. After a layout change the canvases
  stretch, and are redrawn once the change settles; a new device pixel ratio
  redraws them too. The reading position stays at the top of the view, and
  the controller remembers it (memory only, 16 PDFs), so a PDF shown again
  with the same page count opens where the reader left it.
- **Last good.** A shown PDF is a committed presentation, with the mirror's
  rules: it suppresses the loading and error states, and a same-page manual
  rebuild keeps it until the replacement is ready. Any other capture,
  invalidation, purge or `pagehide` destroys the pdf.js task and empties the
  view.
- **Failures** show one status each: password, too large, download failed,
  not a readable PDF, or the reader could not start.
- **Text (D105).** `lib/pdf/text-blocks.ts` turns a page's pdf.js text runs
  into lines and blocks in content order:
  - a line breaks after `hasEOL`, when the baseline moves more than half the
    font size, at a gap wider than 1.5 sizes (measured leftwards in a
    right-to-left line, where a left-to-right number or word does not break
    it), or when a run starts left of a left-to-right line; a run that
    repeats one of its line's runs at almost the same place (fake bold, a
    shadow, a line drawn twice) is dropped;
  - lines join a block when their sizes are within 15%, the next baseline is
    at most 1.6 sizes lower and their x ranges overlap. Bullets (including
    Office's Symbol and Wingdings bullets, U+F000–U+F0FF) and numbers (`1.`,
    `1)`, `(1)`) always start a block; dashes, letters and roman numerals
    only after a line ending `.:;!?)` or inside a list;
  - a word broken by a hyphen rejoins; Chinese, Japanese, Thai, Lao, Khmer
    and Myanmar lines join without a space, Korean with one; rotated and
    vertical runs are left out;
  - a block's alignment is physical (`left`, `center`, `right`, so the
    translation's direction cannot flip it): centred when its line centres
    line up; right when its right edges line up and its left edges vary
    beyond a first-line indent; else the text's own side. A single line is
    centred in the middle of the page, away from the left margin of the
    page's multi-line left-aligned blocks (no margin test on a page with
    none, such as a title page);
  - blocks with no area are left out.
- **Reading.** `PdfController.show` mounts as before, with an empty surface
  and no text read before the first paint. The capture then ends, and the
  pipeline awaits `readText` under `state.pdfTextAbortController` (aborted
  with the rest of the page work): every page, one at a time, from the
  reading page on, then the nearest earlier ones, each shown to the view as
  it is read. A page that takes more than 10 s counts as no text, and a
  throwing surface or view does not stop it. The status says "Reading the
  PDF…" meanwhile. The surface publishes no snapshot until
  `markTextComplete`, so a half-read PDF is never published, even by a
  failed rebuild. When reading resolves and the capture is still current
  (checked against the surface's document), the pipeline publishes the
  full snapshot and runs the replica's translation tail. Translate page is
  off until then, usually well under a second (300 pages took 0.64 s in
  Chrome 154). A finished PDF translation says "The PDF is translated.",
  with no promise of live updates.
- **Translation surface.** `lib/pdf/pdf-text-surface.ts` makes the shown PDF
  a `ReplicaProjectionSurface`: blocks are text records (the document /Lang
  is the document language), one document identity and replay lease per
  shown PDF. The pipeline selects it on the surface router for a PDF (the
  mirror otherwise), so the driver's language, availability, automation,
  cancel, pair-epoch and Live source only rules apply unchanged, and one run
  holds every block: Cancel stops the rest of the PDF, and a Refresh queues
  everything again from the page on screen. The surface makes no commits. A
  projection is accepted only for the current document, lease, epoch, pair,
  block and source, and never empty. `translateCurrent` enqueues in the
  surface's `translationOrder()` (reading page on, then earlier pages), so
  the queue caps drop the least urgent blocks, and the coordinator's
  `reprioritize()` reorders pending work once the reading page has held for
  250 ms.
- **Overlays.** `entrypoints/sidepanel/pdf-text-layer.ts` lays each page's
  blocks over its canvas in shares of the page, font sizes scaled by
  `--pdf-scale`, so zoom moves nothing. Source text is transparent (screen
  readers read it; pages are `role="group"` with "Page n of N"). A translated
  block covers its lines (padded 0.12 font sizes) with the background sampled
  once per page from its canvas (`lib/pdf/colour-sample.ts`: rects clipped
  to the canvas; the background is the dominant colour inside the line
  boxes and a ring around them, weighting the inside, so a snug table fill
  wins; the ink is the darkest 0.5% of the slightly inset line boxes'
  pixels, never pushed past them, faint text included) and writes in the
  sampled ink, generic family, the weight and slant pdf.js names after a
  draw (the style part of the font name, `Bd`, `It`, Nimbus `Medi` and the
  TeX families such as `CMBX` and `CMTI` included), and the block's
  alignment. A failed canvas read is tried again only after the next draw.
  A translation shows only on a page that is drawn and whose colours were
  read (`data-overlays`); before that it stays transparent for screen
  readers. Every cover sits below every block's text, so an overflow is
  never hidden by a neighbour's cover; the page's edge still clips it. The
  layer ignores forced colours. Fitting searches the largest size that
  fits, from 1 down to 0.5 of the source size; each round measures the
  blocks of every drawn page, then resizes them. A block still too long at
  0.5 stops there and overflows; a block that cannot be measured yet waits
  for a later frame, and translations for pages not drawn yet fit when
  drawn. Every page's layer is built as its text is read, whether drawn or
  not; keeping only nearby pages' layers is deferred.
- **Scanned pages (D106).** A page pdf.js read and found no text item on at
  all (not a failed or timed-out read, not a page of only rotated or
  vertical text) is a scanned page of the surface, unread until a
  translation run reads it.
  OCR runs only inside a run: the driver's `beginTranslationRun` hook starts
  `PdfController.readScannedPages(sourceLanguage, runSignal)` just before
  `translateCurrent`, and `onTranslationSettled` stops it. It reads one page
  at a time with `nextPageToRead` from the reading page, so it follows the
  reader. `lib/pdf/pdf-ocr.ts` skips a page that paints no image, draws the
  page with pdf.js into an `OffscreenCanvas` at no more than 4 MP and
  300 dpi, encodes it with `renderImageFilePixels` (identity placement: PNG,
  SHA-256, preprocessing version), and sends it to a PDF-owned
  `ImageRecognitionCoordinator` (memory-only cache, reset epoch from the
  preferences, cleared with the image caches and kept for one top-page
  origin at a time) with the page number as the
  node id and the PDF's document identity. The route is the enabled,
  runtime-ready pixel methods in the saved order
  (`usablePixelProviderOrder()`, no grant gate) and the Tesseract group of
  the run's source language; Tesseract is required (`canReadScannedPages`:
  TextDetector alone has no confidence and passes nothing), and no method or
  no group leaves the pages as they are with a note (pages read in another
  group are forgotten first). Checking for images and drawing have a 60 s
  deadline; a page that cannot be drawn is `unreadable`, marked read with no
  text so it is not drawn again, while a recognition failure stays unread
  for the next run. A busy host is asked once more. The recognised lines
  go through `pdfOcrBlocks` (`lib/pdf/text-blocks.ts`): the same line and
  block rules, sizes from the line boxes with a 40% size tolerance, the
  tallest line as the font size, direction from the script, an empty font
  id (a regular face); a line much taller than wide (vertical text) stays as
  drawn. `PdfTextSurface.setScannedPage` gives the page new
  block ids; pages read in another OCR model group are read again, and a
  target-only change keeps them.
- **The run waits for them.** While the reader runs, the surface
  `isReading()`, and a run that starts while it reads (through the router's
  forwarding) loops in the coordinator: translate what is queued, wait on
  `waitForText(runSignal + pairSignal)`, enqueue the records not yet queued
  in this run in surface order, until reading ends. Every job carries the
  run's signal; progress counts on across the waits; before waiting it
  queues whatever the surface read during the last batch, and it ends when
  its pair changes. The result sums the
  whole run, so "The PDF is translated." means every page. A run that
  starts while the surface does not read is the ordinary run, and the
  mirror never reads. Text blocks translate while the offscreen host reads
  the next page. After the run the published snapshot takes the pages it
  read (`CapturePipeline.adoptReadPdfText`), so pair and language decisions see
  that text. The driver's field count includes readable unread scanned
  pages (`hasUnreadText`), so Translate page is on for a fully scanned PDF
  and stays on for a page OCR failed to read.
- **Auto on a scanned PDF.** `/Lang` first, then the text. When neither gives
  a language and scanned pages can be read, `CapturePipeline.probePdfLanguage`
  runs `PdfController.probeLanguage` before the translation tail, and again
  when From becomes Auto or Translated mode resumes (the driver's
  `probeScannedLanguage` hook; the controller keeps its answer per PDF and
  reading methods, and a run settling never stops it): the
  `AutoImageLanguageProbe` over up to three candidate pages from the reading
  page (one drawing each, its route windows, 18 attempts, a 20 s budget that
  also ends a recognition in progress; strong script on one page, or two
  pages agreeing via `i18n.detectLanguage`). The language found becomes the
  surface's `languageHint`, used as the document language when the PDF names
  none it knows, and marked `documentLanguageSource: 'scanned-pages'` so the
  note says "Detected {0} from the scanned pages." Statuses: no method, no
  OCR model for the language, n pages not read (only after a complete
  translation; failures show the partial summary), and "No text was found
  in this PDF."
- **PDFs from this computer (D107).** A `file://` tab cannot be read: `fetch`
  and XHR of its URL fail from the panel even with file access on. The panel
  takes the file instead.
  - `renderErrorState` (every error panel, shown only when nothing else
    shows) adds the hint "For a PDF on this computer, open it here or drop
    it on Simul." and **Open a PDF file…**, which clicks the hidden
    `#pdf-file-input` (`accept="application/pdf,.pdf"`).
  - The panel document's `dragover`/`drop` handlers take files dropped
    outside the mirror. The mirror frame's guards hand file drops to the
    engine's `onFileDrop`: registered before the activation guard, they
    prevent the default, so a dragged file never navigates. Of several
    files, `chooseDroppedPdf` opens the first PDF by type or `.pdf` name,
    else the first file.
  - `CapturePipeline.openLocalPdf(file)` resets the page as an invalidation
    does: page currencies, abort, release, `clearPage`.
  - It then sets `state.localPdf` (`lib/pdf/pdf-file.ts` `LocalPdfFile`: the
    file and an opaque `local-file:<uuid>` key, never its name) and enqueues
    a `LocalPdfCaptureRequest` on the capture coordinator, so its generation
    orders it against tab captures.
  - `#captureLocalPdf` reads no tab, document, zoom or tab currency.
    `#capturePdf` shows the file through `PdfController.show(LocalPdfFile)`,
    which reads it with `readPdfFile`:
    - the size cap is checked before reading, then the `%PDF-` check;
    - a cancel ends a slow read at once;
    - the step is `read`, and a read failure says "Simul could not read this
      file. Choose it again.";
    - the key names the reading position and the PDF OCR cache.
  - The rest is the web PDF path with no page URL. With no site, automatic
    translation follows all sites, OCR On or the reader's click.
  - The driver runs and resumes against `state.shownPage` (the captured
    tab's page, or the local PDF) and skips the tab check for a local PDF.
  - What replaces the file:
    - any page capture (`queueCapture`: a toolbar click, Follow moving to an
      activated tab) drops it;
    - `invalidateCompanion` clears it with the page;
    - while it shows, the follower ignores window focus changes and active
      tabs finishing a load.
  - Refresh and a settings rebuild after a purge closed the PDF call
    `reopenLocalPdf`, which reads the file again. A manual Refresh keeps the
    PDF on screen until the new copy shows. Mirror-only settings do not
    touch a shown local PDF.
  - A failed open or reopen closes the PDF and forgets the file, so the
    error panel offers the picker again.
  - When Chrome exposes a `file:` address, `unreadablePageGuidance` says the
    file can be opened here.
  - The popout launch opens (or focuses, without the authorized-tab message)
    the companion window for any tab, so a tab Simul cannot read gets the
    message and the picker there too.
  - The side panel's ↗ stays off for a local PDF (`capturedPageIdentity` is
    unset), and a window's return to the side panel leaves the file behind.
- **Following Chrome's viewer (D108).** Chrome's PDF viewer reports its
  viewport to the page that embeds it once that page has sent it any
  message. The `viewport` report is undocumented and gives only the most
  visible page's screen rectangle (`pageX`, `pageY`, `pageWidth`) and the
  viewport size, never the page number (Chromium `pdf_viewer_base.ts`,
  `viewportChanged_`).
  - **Bridge.** After a tab PDF shows, `PdfController.show(..., viewer)`
    starts `PdfViewerFollower` (`entrypoints/sidepanel/pdf-viewer-follower.ts`).
    The follower injects the unlisted `pdf-viewer-bridge.js`
    (`lib/pdf/pdf-viewer-bridge.ts`) into the tab's document and connects a
    `simul-pdf-viewer:<session>` port.
    - The bridge finds the viewer frame through
      `chrome.dom.openOrClosedShadowRoot(document.body)`.
    - It posts a hello whose type the viewer ignores (`simul:follow`), every
      second until `documentLoaded`, at most 60 times.
    - It forwards only `viewport` reports from the viewer's frame and origin
      (`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai`), as five
      numbers and a time.
    - A replaced or closed PDF, and `close`, stop the follower. A local PDF
      starts none.
  - **Guessing the page.** `lib/pdf/pdf-viewer-tracker.ts` models Chrome's
    one-page-wide layout (Chromium `document_layout.cc`): pages are
    trunc(points × 4/3) px, with insets of 3/5/7/5 px and 4 px between
    pages. Every page is a candidate for the report's page, implying a zoom
    (its width against the report's) and a viewport top. Candidates at the
    previous zoom win while the viewport is unchanged, which tells pages of
    different widths apart. With several whole pages in view Chrome may name
    any of them, so the rules compare the viewport top, not the page named.
    The rules, in order:
    - the two-page view is not followed. It shows as a page reported 4 px
      narrower at an unchanged zoom and viewport (its insets differ), or as
      a page that is not where the one-page layout puts it;
    - a report that moved only sideways, or a zoom or resize that keeps the
      place within a snapped pixel, is the same place;
    - for a lone report (none for 100 ms):
      - an arrow step (40 px);
      - an exact page top. It is the top of the page after the most visible
        one (ArrowRight, paged modes, and the guess for the page box).
        Within the first screen it reads as the very top instead, and an
        arrow step onto a page top stays an arrow step, unless Chrome's
        snapped second report follows within 20 ms: a jump's exact position
        is snapped to whole pixels at once, a scroll's is not;
      - the bottom of the PDF, when a key step was cut short by it;
      - a PageUp, PageDown or Space step (0.875 × the viewport). When it is
        not the nearest reading it is held: frames that follow mean a
        scroll, 150 ms of quiet means the key. The same step again means a
        held key only after a first press was read as a key, because equal
        wheel steps can look like repeats of the opposite page key;
      - a jump of more than 160 px is held until the viewer is still;
    - for a report in a movement more than 20 ms after the last: a held
      key's repeat (the next page top again, or the same page key step);
    - otherwise the candidate nearest the place the viewer's speed predicts
      (the second frame also tries the first frame's step), within 0.2 of a
      page;
    - a movement beyond that is held while reports come within 300 ms (a
      viewer busy drawing can stall mid-scroll) and read after 300 ms of
      quiet: as the top or bottom of the PDF when it stopped there (Home,
      End), else as the page nearest where the last trusted speed, slowing,
      would have carried it. A lone held jump takes the nearest candidate
      after 150 ms.
  - **Where guessing starts.** A newly opened or reloaded tab document is
    taken to be at the viewer's start: the top, or the address's `#page=N`
    (`addressPage`). `PdfController` passes that as the tracker's anchor,
    and with following on mounts the view there instead of at a place
    remembered from another document. The same tab document shown again
    (Refresh, coming back) keeps the view's place and the tracker's guess.
    Otherwise the first report is read nearest the view's own place.
  - **Measured.** A seeded simulation (`tests/pdf-viewer-tracker-sim.test.ts`:
    80 sessions, zooms from 25% to 180% with Chrome's presets, mixed sizes,
    scroll positions snapped to whole pixels) places the page after 100% of
    arrow steps and held arrows or page keys, 99.9% of wheel turns, 99.8% of
    page keys, 99.6% of Home/End, 99.1% of flings, 97.9% of ArrowRight and
    97.2% of held ArrowRight. Each mistake is counted once, with the tracker
    then started again from the true page; in use a mistake stays until
    Home or End. The page box, outline, links, Find and ArrowLeft are
    guesses. The harness
    (`~/.cache/simul-harness/pdf/phase6/panel-follow.mjs`) checks 20 moves
    in Chrome for Testing 154 and 138.
  - **Panel.** The follower moves `PdfView.followPosition` only when Follow
    source scrolling is on and the guess moved. The latest guess is kept
    while following is off, and turning following on (here or in another
    window) moves the view there. A held report is read by a timer in the
    panel; if a frame still follows a key read that way (the panel was
    busy), the key becomes a scroll again.

## Detached window

Chrome has no API to detach a native side panel. The ↗ control instead creates
an extension popup with `windows.create`, passing only numeric source tab and
window IDs in its extension URL. The popup follows that tab even though it is
not the active tab in the popup's own window. This requires no new permission;
the user must reauthorize after temporary page access expires.

## Following tabs

The toolbar's Follow / Pinned button switches one saved setting, and both
surfaces honor it (D73). Settings has no second control for it (D91). Follow
is the default: a side panel mirrors whichever tab becomes active in its own
window, and a detached window mirrors the active tab of the focused browser
window. Pinned
keeps the mirror on the tab it shows while other tabs are active; image text
on that tab waits until it is visible again, because pixel capture reads only
the visible tab. Clicking the extension on another tab of the side panel's
window still moves a pinned side panel to that tab.

With Follow, a newly selected new-tab or browser page shows
"Waiting for a web page in the active tab." when Simul may read every site
(Chrome hides only such URLs then), and the companion follows that tab as soon
as it finishes loading a web page. Without all-site access a hidden URL may be
a site Simul cannot read yet, so the companion still asks for page access.

## Manual release checks

After loading `dist/chrome-unpacked`, verify dynamic expansion, late content,
image/style changes, same-tab navigation, document and viewport-scale nested
source scrolling, all size/zoom modes, language changes, settings persistence,
detached-window binding, toolbar progress, and quick-translation
cancellation/copy. Check OpenAI.com for its dark canvas, upper-left SVG logo
geometry, and primary reading scroll. Check the supplied Reddit article for
late left and right rails, public labels, and open-shadow content. Confirm
eligible native text controls translate, password/password-autocomplete and
unsupported controls stay blank, public native dropdown labels/current
selection update without raw values, a safe-to-sensitive transition clears
immediately, and the source DOM is unchanged.

For dropdown coverage, test a native single select, a multiple select with
disabled options and optgroups, a public read-only ARIA listbox/menu, and an
editable combobox. The replica must reveal a bounded, scrolling translated
list without changing the source. On a Chrome customizable-select fixture,
verify that source `:open` state propagates while arbitrary rich option markup
and form values remain absent.

For image OCR, also test the supplied 1206x761 Reddit media image at high-DPI
display scale. It should reach recognition through a bitmap at or below 4 MP,
and its overlay should remain when a live mirror patch replaces the replica
`img` under the same logical node and replay lease.

Enable image translation and exercise English/Japanese plus Spanish, Chinese,
Korean, Russian, and Arabic images. Scroll/zoom, change target language,
navigate during OCR, change the OCR confidence threshold, and disable/re-enable
the option. Confirm stale overlays
disappear, same-language images stay unchanged, and page text translation stays
responsive.

Run `npm run artifact:check` and confirm the ready-to-load artifact remains
under the 42 MiB unpacked limit, contains the pinned Tesseract catalog, the
pinned pdf.js subset, and their notices, and has no remote OCR or PDF runtime
references.

The manifest must retain Chrome 138, required permissions `activeTab`,
`scripting`, `sidePanel`, `storage`, and `offscreen`, no required host
permissions, only the approved optional HTTP(S) patterns, and the exact local
Wasm/Worker extension-page CSP, which every build profile carries because
pdf.js ships in all of them.
