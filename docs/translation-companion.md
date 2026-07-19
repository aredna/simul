# Translation companion design

## Live mirror lifecycle

The extension first executes a bounded capture in Chrome's isolated world. It
copies an allowlisted visual model with computed styles and assigns opaque IDs
through an extension-owned `WeakMap`; it does not add attributes to the source
DOM. A `MutationObserver` then coalesces structural, text, image, and relevant
attribute changes. The panel requests only those dirty subtrees, validates the
typed delta again, replaces matching inert nodes, and translates only newly
changed text.

Source scroll messages are animation-frame throttled and one-way. The mirror
uses exact scaled CSS-pixel offsets in faithful layout and proportional offsets
when adaptive translations change page height. No mirror interaction is sent
back to the website.

Full capture is not scheduled. It is used for the initial bootstrap,
navigation, a manual rebuild, or recovery when an ID, generation, bound, or
delta target cannot be reconciled. Generation and exact tab/window checks
discard stale asynchronous results. The previous mirror stays visible while a
replacement bootstrap is prepared.

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
zoom, zoom percent, adaptive/faithful text layout, scroll following, and
explicit automatic-translation scopes. Composer input, output, page text, and
translation results are never stored.

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

The manifest must retain Chrome 138, required permissions `activeTab`,
`scripting`, `sidePanel`, and `storage`, no required host permissions, and only
the approved optional HTTP(S) patterns.
