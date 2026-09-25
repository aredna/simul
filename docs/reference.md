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
backgrounds, canvas, video frames, embedded documents, hidden images, or
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
- **Nothing translates at all:** the browser must have the Translator API
  (Chrome 138 or newer, or Edge 148 or newer, on a computer). Other browsers
  can load Simul but cannot translate with it.
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
