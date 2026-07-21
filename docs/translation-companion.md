# Translation companion design

## Live mirror lifecycle

The canonical renderer converts the current page into a privacy-sanitized,
typed DOM graph in Chrome's isolated world. It reconstructs that graph in a
same-origin-only, inert, scriptless sandbox. Ordered patches are validated
before application; gaps recover through a staged checkpoint and atomic swap
while the last good replica stays visible. rrweb remains an explicitly
selectable experimental renderer, never an automatic fallback.

Source scroll messages are animation-frame throttled and one-way. The mirror
uses exact scaled CSS-pixel offsets in faithful layout and proportional offsets
when adaptive translations change page height. No mirror interaction is sent
back to the website.

Full capture is not scheduled periodically. It is used for initial bootstrap,
navigation, a manual rebuild, or bounded recovery. Exact document identity,
sequence, source revision, translation epoch/pair, and replay lease checks
discard stale asynchronous work.

## Translation and saved settings

The source preference can be a language or Auto-detect. Auto-detect uses the
document's HTML `lang` value first, normalizes its BCP-47 tag, then falls back
to Chrome's local `i18n.detectLanguage` result only when it is reliable. An
equal resolved pair is an explicit no-op.

Chrome 138 exposes Translator pair availability and session creation but does
not expose language enumeration. Simul therefore shows Chrome's documented
language list and probes the selected pair at runtime. Language changes reset
the visible strings and immediately translate again when the pair is already
available. Chrome still requires a user action before a model's first
download.

`browser.storage.local` holds only settings: From/To languages, Fit/1:1/custom
zoom, zoom percent, adaptive/faithful text layout, scroll following, explicit
automatic-translation scopes, and image-analysis options. Image translation is
off by default. Composer input, output, page text, and translation results are
never stored.

## Local image text

When explicitly enabled, an exact-document source Port observes ordinary
top-frame `<img>` elements by the selected engine's private node ID without
emitting their URL or text.
The saved scan policy orders visible/near/background work, and very small
images are skipped by default. Only stable visible pixels are captured, at no
more than two viewport captures per second, after matching pre/post document,
scroll, bounds, and revision. High-DPI crops are proportionally downscaled
before OCR so the processed bitmap never exceeds 4 MP; the CSS crop geometry
is retained for overlay placement.

The offscreen extension page reads a short-lived crop from extension-origin
storage and runs packaged Tesseract.js 7.0.0 locally. The routed model group is
chosen from nearest valid element `lang`, explicit From, then detected page
language. Recognition results stay in a bounded memory cache; the crop is
deleted after the job and expires after two minutes if cleanup is interrupted.
An unchanged empty result must be observed twice before it enters the
recognition cache, and transient capture failures receive only one immediate
retry. Translated line boxes are inert siblings in the replay document. Document,
content revision, SHA-256 pixel key, replay lease, pair epoch, replica image,
and normalized geometry must still match at commit and on refresh.

## Rendering and privacy

At 1:1, one captured source CSS pixel maps to one mirror pixel (`scale(1)`).
The source viewport width remains the layout containing block; the captured
document width drives horizontal overflow. Fit computes a scale no greater
than one, while custom zoom is clamped to 25–300%.

Private controls become empty inert `div`/`span` shells instead of disabled
form controls, avoiding browser disabled-state wash while retaining geometry.
Public button labels are retained inside inert shells. Adaptive layout removes
height and clipping constraints from containers holding translated text;
faithful layout retains geometry but never silently ellipsizes translated
content.

The extension copies no source HTML. Both bootstrap and delta boundaries
allowlist tags, style properties, attributes, and image schemes. Scripts,
handlers, navigation semantics, values, passwords, contenteditable text, and
cross-origin frame content never enter the mirror. Open shadow trees and slot
assignments are composed; closed roots remain inaccessible by web-platform
design. The live bridge discovers roots present during capture, roots on newly
inserted DOM, and roots created as previously undefined custom elements
upgrade. The web platform exposes no general event when an already-defined,
already-connected host attaches a root later; if that happens without a DOM,
resize, focus, or load signal, a manual rebuild may be required.

The isolated renderer also carries two narrow source facts that are difficult
to recover after scripts are disabled: a boolean for the canonical clipped
1px screen-reader-only pattern and a sanitized selected `currentSrc` for
responsive images. It does not transport arbitrary computed styles. Candidate
stylesheets settle through load/error outcomes, two paints, or a short fixed
deadline before the staged candidate replaces the last good view.

## Reddit-class troubleshooting and submission limits

OCR Diagnostics assigns each attempt an ephemeral job number. Use that number
to follow capture, bounded retry, recognition, translation, projection, and
same-lease anchor-rebinding stages. Logs contain only safe dimensions, counts,
provider names, outcomes, and cache state—never page text, URLs, pixels,
hashes, or DOM identifiers. Mirror logs similarly report aggregate shadow-root,
adopted-style, hidden-label, selected-source, stylesheet outcome, and patch
replacement/reconciliation counts. The latter distinguish retained, inserted,
moved, and removed nodes and report bounded representability counters without
text, URLs, tag names, attributes, hashes, or node IDs.

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

## Detached window

Chrome has no API to detach a native side panel. The ↗ control instead creates
an extension popup with `windows.create`, passing only numeric source tab and
window IDs in its extension URL. The popup follows that tab even though it is
not the active tab in the popup's own window. This requires no new permission;
the user must reauthorize after temporary page access expires.

## Manual release checks

After loading `dist/chrome-unpacked`, verify dynamic expansion, late content,
image/style changes, same-tab navigation, source scrolling, all size/zoom
modes, language changes, settings persistence, detached-window binding, and
composer cancellation/copy. Check the supplied Reddit article for late left
and right rails, public labels, and open-shadow content. Also confirm form
values remain absent and the source DOM is unchanged.

For image OCR, also test the supplied 1206x761 Reddit media image at high-DPI
display scale. It should reach recognition through a bitmap at or below 4 MP,
and its overlay should remain when a live mirror patch replaces the replica
`img` under the same logical node and replay lease.

Enable image translation and exercise English/Japanese plus Spanish, Chinese,
Korean, Russian, and Arabic images. Scroll/zoom, change target language,
navigate during OCR, and disable/re-enable the option. Confirm stale overlays
disappear, same-language images stay unchanged, and page text translation stays
responsive.

The manifest must retain Chrome 138, required permissions `activeTab`,
`scripting`, `sidePanel`, `storage`, and `offscreen`, no required host
permissions, only the approved optional HTTP(S) patterns, and the exact local
Wasm/Worker extension-page CSP.
