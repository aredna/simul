# Simul translation companion

Simul places a safe, read-only, high-fidelity approximation of the active page
in Chrome's native side panel and translates its eligible Japanese or English
text with Chrome's built-in Translator API. The source tab stays untouched and
remains available for scrolling and comparison.

## Requirements and use

- Chrome 138 or newer on a desktop device that supports the Translator API.
- A regular HTTP or HTTPS page in the active tab.
- Japanese → English or English → Japanese. Use **Swap languages** to reverse
  the direction.

For a no-build installation, download and extract the repository, open
`chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and
select `dist/chrome-unpacked`. Node.js and npm are not required for product
installation.

Select the Simul toolbar icon, then **Open translation panel**. The panel reads
a bounded snapshot and checks whether Chrome supports the selected language
pair. Select **Translate page** to create the local translation session. On
first use, Chrome may download a language pack and Simul displays that
progress. **Cancel** stops creation or translation; successful segments remain
available when a partial run is retried.

Use **Fit width** to scale the captured source viewport into the panel or **1:1
size** to retain its natural width with horizontal scrolling. **Refresh
snapshot** rereads the followed page immediately. Simul clears stale content
as navigation starts, coalesces rapid changes, then recaptures the newest
completed load. Same-origin navigation retains Chrome's temporary access. On a
new origin, select the toolbar icon once; the authorization message targets the
exact active tab and refreshes an already-open panel without closing it.

Automatic translation defaults to **Off**. **This site** requests access to
only the current origin; **All sites** requests regular HTTP and HTTPS access.
The selection is persisted and completed loads are captured and translated
when the chosen language model is already available. Chrome requires a user
action to prepare or download a model, so select **Translate page** once for an
unprepared language pair. Simul never initiates that first download from a
background navigation.

## Privacy and permissions

Translation runs on-device through Chrome. Simul has no remote translation
fallback, analytics, API key, required host access, or persistent content
script. It does not send page text to Simul, Google Cloud, OpenAI, or another
server. Chrome itself manages any language-pack download.

The four required manifest permissions each have a narrow purpose:

- `activeTab` grants temporary access only after the user selects the toolbar
  action.
- `scripting` injects one top-frame snapshot function into that temporarily
  authorized tab.
- `sidePanel` displays the read-only companion beside the page.
- `storage` remembers only automatic-translation scopes and the Fit/1:1 view
  preference.

The manifest also declares optional `http://*/*` and `https://*/*` host
patterns. They grant nothing during installation. Chrome prompts only after a
user chooses **This site** or **All sites**, and Simul removes obsolete access
when that scope is turned off. Required `host_permissions` remains empty.
Chrome match patterns cannot isolate one non-default port, so Simul declines a
**This site** grant there instead of silently broadening it to every port on the
host. The one-time toolbar gesture and explicit **All sites** mode remain
available.

The snapshot contains a bounded typed visual tree, never page HTML. It retains
safe structural tags, individually allowlisted computed-style properties,
vetted image/background URLs, text translation keys, and empty control shells.
It omits scripts, stylesheets, handlers, navigation semantics, entered form
values, passwords, selections, contenteditable text, hidden nodes, and embedded
frame contents. Canvas, video, and audio become inert placeholders. The panel
rebuilds every node itself and assigns translated strings with `textContent`,
so page markup, links, forms, and executable behavior cannot activate.

Original remote images and safe CSS backgrounds shown in the companion may be
requested again from their existing source host. Simul uses no referrer for
image elements and sends the resource to no translation service. Bounded
raster data URLs are accepted; active blobs, SVG data URLs, arbitrary
URL-bearing CSS, and non-web schemes are omitted.

## Deliberate MVP limitations

- The companion is a high-fidelity approximation, not an exact, pixel-perfect,
  or live page clone. Translation changes line breaks and page height. Closed
  shadow roots, cross-origin frame contents, canvas/video pixels, all source
  web fonts, pseudo-elements, and script-only state cannot be reproduced.
- Chrome's native panel supports only left or right placement. The user owns
  that global setting. On Chrome 140+, Simul can detect left placement and
  explain how to choose the right under **Settings → Appearance → Side panel**.
  It does not offer a placement control it cannot honor.
- Images retain their original pixels. Simul translates available alt labels
  and figure captions and marks pixels as untranslated. There is no OCR in this
  increment.
- Cross-origin frames, canvas/video pixels, scroll synchronization, live DOM
  mutation mirroring, typed composition, and form filling are not included.
- Translation availability varies by Chrome build, operating system, device,
  and language-pack state. Failure produces a retryable local error; there is
  no fabricated or network result.

## Architecture and future providers

`lib/translation-provider.ts` is the provider seam. The Chrome adapter owns API
feature detection, capability state, creation progress, cancellation, and
session destruction. The browser-independent pipeline translates sequentially,
deduplicates repeated strings, enforces page/input limits, retains successful
work after partial failure, and retries only incomplete fields. A latest-work
generation coordinator rejects stale capture and translation results during
rapid navigation.

A future OpenAI adapter must use a key-protecting backend and require explicit
approval for remote processing; a secret must never ship in the extension.
OpenAI does not provide an ongoing free translation API tier. A future detached
companion would likewise be a distinct extension popup window—not a popped-out
native side panel—and needs separate lifecycle, sizing, placement, and
multi-display design.

Image translation is deferred. The local-first experiment is to bundle
Tesseract.js plus Japanese/English models, retain OCR bounding boxes, translate
recognized lines, and draw inert positioned overlays. Backend-mediated Google
Vision plus Cloud Translation or Azure Document Translation can be evaluated
only after explicit approval for remote image processing and credentials.

## Manual verification

Load the committed `dist/chrome-unpacked` directory as an unpacked extension
and verify:

1. Japanese → English and English → Japanese on regular text pages.
2. First-use language download progress, cancel, partial failure, and retry.
3. Keyboard access for all buttons and selects and announced status updates.
4. Restricted, stale, empty, image, and embedded-frame pages.
5. Same-origin navigation, cross-origin toolbar reauthorization, and rapid
   loading races without closing the panel.
6. Off / This site / All sites grants, denials, revocation, persistence, and
   first-use model preparation.
7. Fit width and 1:1 rendering; the source DOM and form values remain unchanged.
8. Left-side guidance (Chrome 140+) and normal operation on either side.
9. `dist/chrome-unpacked/manifest.json` has no `host_permissions`, contains only
   `activeTab`, `scripting`, `sidePanel`, and `storage`, and declares only the
   approved optional HTTP(S) patterns.

## Release artifact maintenance

`dist/chrome-unpacked/` is the canonical, checked-in local-install release. It
is generated from source and must not be edited directly. Contributors use
`npm run artifact:sync` to build in a temporary directory, validate the output,
and intentionally replace only that guarded directory. `npm run
artifact:check` performs the same temporary build and security validation, then
compares every path and byte without changing the committed release.

Validation rejects symlinks, source maps, private configuration, credential or
key material, remote executable references, missing assets, an invalid Chrome
version, and any permission outside the approved manifest boundary. Transient
WXT output remains under `.output/` and is not an installation artifact.
