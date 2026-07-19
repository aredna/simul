# Simul translation companion

Simul places a safe, read-only approximation of the active page in Chrome's
native side panel and translates its eligible Japanese or English text with
Chrome's built-in Translator API. The source tab stays untouched and remains
available for scrolling and comparison.

## Requirements and use

- Chrome 138 or newer on a desktop device that supports the Translator API.
- A regular HTTP or HTTPS page in the active tab.
- Japanese → English or English → Japanese. Use **Swap languages** to reverse
  the direction.

Select the Simul toolbar icon, then **Open translation panel**. The panel reads
a bounded snapshot and checks whether Chrome supports the selected language
pair. Select **Translate page** to create the local translation session. On
first use, Chrome may download a language pack and Simul displays that
progress. **Cancel** stops creation or translation; successful segments remain
available when a partial run is retried.

Use **Refresh snapshot** after the source navigates or its visible content
changes. Simul rejects a stale snapshot rather than translating a different
tab accidentally.

## Privacy and permissions

Translation runs on-device through Chrome. Simul has no remote translation
fallback, analytics, API key, host permission, or persistent content script.
It does not send page text to Simul, Google Cloud, OpenAI, or another server.
Chrome itself manages any language-pack download.

The three manifest permissions each have a narrow purpose:

- `activeTab` grants temporary access only after the user selects the toolbar
  action.
- `scripting` injects one top-frame snapshot function into that temporarily
  authorized tab.
- `sidePanel` displays the read-only companion beside the page.

The snapshot contains typed strings and vetted image URLs, never page HTML. It
omits scripts, styles, controls, entered form values, content-editable regions,
hidden nodes, canvas/video/audio, and cross-origin frame contents. The panel
rebuilds DOM nodes itself and assigns translated strings with `textContent`, so
page markup, handlers, links, and forms cannot execute.

Original remote images shown in the companion may be requested again from
their existing source host. Simul uses no referrer and sends the image to no
translation service. Bounded raster data URLs are accepted; active blobs,
SVG data URLs, and non-web schemes are omitted.

## Deliberate MVP limitations

- The companion is an ordered visual approximation, not an exact or live page
  clone. Page CSS, scripts, navigation, forms, and interactive state are not
  copied.
- Chrome's native panel supports only left or right placement. The user owns
  that global setting. On Chrome 140+, Simul can detect left placement and
  explain how to choose the right under **Settings → Appearance → Side panel**.
  It does not offer a placement control it cannot honor.
- Images retain their original pixels. Simul translates available alt labels
  and figure captions and marks pixels as untranslated. There is no OCR in this
  increment.
- Cross-origin frames, canvas, video, scroll synchronization, live mirroring,
  typed composition, and form filling are not included.
- Translation availability varies by Chrome build, operating system, device,
  and language-pack state. Failure produces a retryable local error; there is
  no fabricated or network result.

## Architecture and future providers

`lib/translation-provider.ts` is the provider seam. The Chrome adapter owns API
feature detection, capability state, creation progress, cancellation, and
session destruction. The browser-independent pipeline translates sequentially,
deduplicates repeated strings, enforces page/input limits, retains successful
work after partial failure, and retries only incomplete fields.

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

After `npm run build`, load `.output/chrome-mv3` as an unpacked extension and
verify:

1. Japanese → English and English → Japanese on regular text pages.
2. First-use language download progress, cancel, partial failure, and retry.
3. Keyboard access for all buttons and selects and announced status updates.
4. Restricted, stale, empty, image, and embedded-frame pages.
5. The source DOM and form values remain unchanged.
6. Left-side guidance (Chrome 140+) and normal operation on either side.
7. `.output/chrome-mv3/manifest.json` has no `host_permissions` and contains
   only `activeTab`, `scripting`, and `sidePanel` permissions.
