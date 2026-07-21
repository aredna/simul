# Translation companion design

## Live mirror lifecycle

The canonical renderer converts the current page into a privacy-sanitized,
typed DOM graph in Chrome's isolated world. It reconstructs that graph in a
same-origin-only, inert, scriptless sandbox. Ordered patches are validated
before application; gaps recover through a staged checkpoint and atomic swap
while the last good replica stays visible. rrweb remains an explicitly
selectable experimental renderer, never an automatic fallback.

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

The scroll observer is a locally bundled unlisted extension script, not a
serialized callback with missing imported dependencies. A tiny closure-free
invoker starts that bundle, and its implementation revision disconnects and
replaces an incompatible registry left in an already-open tab. Content-free
`[Simul scroll]` entries distinguish observer installation, accepted source
messages, and projection without logging coordinates, URLs, or page content.

The most recent source position is retained even when it arrives before a
staged replica commits, then applied as soon as that replica becomes visible.
Navigation and an explicit rebuild reset the retained position and ownership so
an earlier page cannot move the new one. The mirror uses exact scaled CSS-pixel
offsets for faithful document scroll and proportional offsets when adaptive
translations or nested layouts change the available range. No mirror
interaction is sent back to the website.

This restores the direct document-coordinate behavior used by 0.2.3 while
retaining the later, event-qualified nested-scroll support. A temporary legacy
build is not required to select that path.

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
language list and probes the selected pair at runtime. Both menus use a single
specified order based on the English reference name, rather than locale-aware
sorting that would move choices between sessions. The From menu begins with
Auto-detect and renders the remaining names in the selected target language.
The To menu uses the same code order but renders every name as its native
endonym, including separate Simplified and Traditional Chinese labels. Language
changes reset the visible strings and immediately translate again when the pair
is already available. Chrome still requires a user action before a model's
first download.

`browser.storage.local` holds only settings: From/To languages, Fit/1:1/custom
zoom, zoom percent, adaptive/faithful text layout, scroll following, explicit
automatic-translation scopes, the selected replica-fidelity policy, and
image-analysis options. Image translation is off by default. Composer input,
output, page text, and translation results are never stored.

Page translation uses a bounded, memory-only exact-content LRU. A cache key is
the translation provider, normalized source/target pair, and complete source
string—not a DOM node, page, document, or URL. Identical requests from another
node or a live source update reuse the result, and matching requests already in
flight join one provider call. Projection still requires the exact current
document, revision, translation epoch, pair, and replay lease, so reusable text
does not weaken stale-result protection.

The slim full-width toolbar exposes Refresh; the From label, `[A]` (set From to
Auto-detect), and a wider From selector; swap and a wider To selector; Fit/1:1
size; OCR On/Off; Current/Active tab following; quick reverse translation; Settings;
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
capture, live-update, permission, quick-translation, image-analysis, and
surface-transition activity without intercepting pointer input. Reduced-motion
preferences disable decorative progress animation.

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
language. Recognition uses a bounded memory-only content cache keyed by the
ordered provider/runtime/model route, source language, preprocessing profile,
processed dimensions, and SHA-256 pixel hash—not by node, source document, or
image URL. Exact concurrent requests join one recognition load, and completed
results remain reusable across live source refreshes while the companion stays
open. Both entry count and aggregate transcript/region weight are bounded; an
oversized result is returned for the current job but is not retained. A
repeated URL is reused only when its processed pixels and geometry inputs
match, because a responsive, resized, cropped, or animated rendering can
produce different overlay coordinates.

The transient crop is deleted after the job and expires after two minutes if
cleanup is interrupted. An unchanged empty result must be observed twice
before it enters the recognition cache, and transient capture failures receive
only one immediate retry. Provider-neutral quality filtering drops blank,
punctuation-only, and explicitly very-low-confidence regions while accepting
providers that do not report confidence. Explicit same-language pairs stop
before source capture. Auto-detected work uses the nearest valid image/element
language and stops before recognition when that resolved language equals To.
Translated line boxes are inert siblings in the replay document; text wraps
and uses bounded font-size reduction within the recognized box instead of
forcing a single clipped line. Document, content revision, SHA-256 pixel key,
replay lease, pair epoch, replica image, and normalized geometry must still
match at commit and on refresh.

## Rendering and privacy

At 1:1, one captured source CSS pixel maps to one mirror pixel (`scale(1)`).
The source viewport width remains the layout containing block; the captured
document width drives horizontal overflow. Fit computes a scale no greater
than one, while custom zoom is clamped to 25–300%.

In Isolated HTML, native `input` elements whose type is missing, `text`,
`search`, `email`, `url`, or `tel`, plus `textarea`, may expose only their
current nonempty text or otherwise their placeholder as bounded typed control
metadata. The replica reconstructs that visible text and can translate it, but
never receives raw `value` or `placeholder` attributes. Password and
password-autocomplete fields, unsupported native controls, contenteditable
regions, and ARIA textbox fallbacks stay blank. A public native select may
expose only bounded option/optgroup labels and selected/disabled/multiple/open
presentation state. Both engines render those labels in a companion-owned,
scriptless disclosure: the selected value stays visible, all translated labels
can be revealed, and long lists scroll without changing the source selection.
Customizable-select `:open` state is progressive; native OS popup geometry is
not observable. Public non-editable ARIA listbox/menu/option labels translate,
while editable combobox/searchbox/textbox/contenteditable branches stay blank.
Raw option values, names, data attributes, datalist/standalone-option content,
rich picker descendants, and private select ancestry stay blank. A field that
becomes sensitive clears its prior source record and projection atomically.
rrweb keeps all editable/value-bearing controls masked.

Other private controls become empty inert shells rather than disabled form
controls, avoiding browser disabled-state wash while retaining geometry.
Public button labels remain translatable inside inert shells. Adaptive layout
removes height and clipping constraints from containers holding translated
text; faithful layout retains geometry but never silently ellipsizes translated
content.

The extension transports no raw source HTML. Both bootstrap and delta
boundaries allowlist tags, style properties, attributes, image schemes, and the
narrow typed control record above. Scripts, handlers, navigation semantics,
raw value attributes, passwords, contenteditable text, and cross-origin frame
content never enter the mirror. Open shadow trees and slot assignments are
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

Isolated HTML has two saved, selectable fidelity policies. **Passive Fidelity**
is the default. It preserves more inert presentation semantics and may cause
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
environment; Simul does not reuse that opaque URL and cannot always obtain its
bytes to create an extension-owned replacement. A validated source document
mode selects a standards or quirks `srcdoc` shell; Chrome's distinct
limited-quirks mode is not separately represented.
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

## Detached window

Chrome has no API to detach a native side panel. The ↗ control instead creates
an extension popup with `windows.create`, passing only numeric source tab and
window IDs in its extension URL. The popup follows that tab even though it is
not the active tab in the popup's own window. This requires no new permission;
the user must reauthorize after temporary page access expires.

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
navigate during OCR, and disable/re-enable the option. Confirm stale overlays
disappear, same-language images stay unchanged, and page text translation stays
responsive.

The manifest must retain Chrome 138, required permissions `activeTab`,
`scripting`, `sidePanel`, `storage`, and `offscreen`, no required host
permissions, only the approved optional HTTP(S) patterns, and the exact local
Wasm/Worker extension-page CSP.
