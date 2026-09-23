# Simul

Simul is a Chrome extension that shows a translated copy of the web page you
are reading, next to the original. The page itself is left untouched; the
translation opens as a live, read-only mirror in Chrome's side panel or in a
separate window, so you can compare the two as you read and scroll.

Everything is translated on your own computer with Chrome's built-in on-device
translator. Page text never leaves your machine, and Simul has no server, no
account, no API key, and nothing remote to set up. The optional reading of text
inside images is also fully local.

Simul started as a quick build for the OpenAI Build Week hackathon, made as
something we would use ourselves. We are now sharing it so others can use it
too.

Current build: **0.5.0 beta v.20260922.22** · Desktop Chrome **138+** ·
Manifest V3

## What you need

- Desktop Chrome 138 or newer.
- about 35 MB of disk space for the extension folder (most of it is the
  packaged image-text reader).
- The first time you translate into a new language, Chrome may download that
  language pack. That is Chrome's own download, not a Simul service.

Nothing else: no Node.js, no account, no key.

## Install

Get the extension folder in either of two ways:

- **Release zip.** Download `simul-<version>-chrome-unpacked.zip` from the
  [latest release](https://github.com/aredna/simul/releases/latest) and unzip
  it. The folder inside is `chrome-unpacked`.
- **Repository.** Use **Code → Download ZIP** (or clone) and unzip it. The
  folder is `dist/chrome-unpacked` inside the download.

Then load it in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Select **Load unpacked** and choose the `chrome-unpacked` folder.
4. Open any normal web page and select the Simul icon in the toolbar.

Keep the folder where it is while the extension is installed. To update,
replace the folder with the new version, then select **Reload** on the Simul
card in `chrome://extensions`, reload the page, and reopen the companion. The
card shows version `0.5.0`; Simul's settings show
`Build 0.5.0 beta v.20260922.22`.

This is an unpacked beta, not a Chrome Web Store release, so Chrome does not
update it automatically.

## Use Simul

1. Open a normal HTTP(S) page. Chrome does not let extensions run on its own
   internal pages, the Web Store, or some protected pages.
2. Select the Simul icon to open the companion in the side panel or a separate
   window (your saved choice).
3. Leave **From** on **Auto-detect** or pick the page's language, then pick
   **To**. Once that language pair is installed, the companion's own labels,
   hints, and status messages follow the **To** language as well.
4. Select **Translate page**. Chrome may first prepare the on-device language
   pack. The page is translated on every visit only if you save automatic
   translation for the site in settings, or if OCR is on.
5. Use **Fit**, **1:1**, zoom, layout, and scroll-following to compare the
   original with the translation.
6. Image text (OCR) is on by default and is translated together with the page
   text. The first time, select the **OCR** button to grant image access when
   Chrome asks; select it again to turn image text off.
7. Use **Rebuild mirror** if the page changed in a way the mirror could not
   follow.

Settings cover launch behavior, automatic translation, how much of the page
may be read, visual fidelity, image-reading methods, and reset.

The rest of this file is the detailed reference: how the mirror works, the
privacy boundary, permissions, fidelity limits, troubleshooting, and
development.

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
   method is on once the first-run setup is done, so images with alt text get
   a translated caption before image access is granted);
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
[Image text translation](docs/image-translation-research.md) for the detailed
boundary.

## Privacy and security boundary

Reading and acting are separate contracts. Broader readable-content settings
never make the replica interactive.

On first use Simul remains at **Page-only** until you choose a scope. The
Page-only, Standard, Full visible, and custom profiles control whether the
mirror may read public control semantics, non-secret images in controls,
validated disclosure content, visible text/search/URL/textarea values and
selection state, personal/autofill values, and editable text.

Passwords, authentication and one-time-code fields, WebAuthn and payment-card
autocomplete classes, hidden/file inputs, file paths, and CSS-masked text are
blocked under every profile. A node classified as secret remains secret for
that document. Narrowing the scope clears the current replica, translations,
and image overlays before rebuilding.

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
active-content blocks.

Simul is a safe reconstruction, not a browser clone. Current limitations
include closed shadow roots, script-only custom-element state, virtualized DOM
that the page has not created, inaccessible cross-origin CSSOM, generated
pseudo-element text, canvas/video pixels, protected media, active embedded
documents, and cross-origin frame contents. Exact pixel parity is not claimed.

See [Replica fidelity](docs/replica-fidelity.md) and the
[translation companion architecture](docs/translation-companion.md) for the
complete design and browser-boundary rationale.

## Troubleshooting

- **Chrome says the manifest is missing:** select `dist/chrome-unpacked`
  itself, not the repository root.
- **The icon does not work:** try a normal HTTP(S) page; Chrome blocks extension
  access on some internal and protected URLs.
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

## License

Original Simul material is licensed under the [MIT License](LICENSE). That
license permits use, copying, modification, distribution, sublicensing, and
sale while requiring the copyright and permission notice to be retained.

Third-party libraries, OCR runtime code, language models, compiled native
components, and generated tooling retain their own licenses. The production
dependency graph uses permissive MIT, Apache-2.0, BSD-2-Clause, and related
compiled-core terms; it does not become MIT merely because Simul is MIT.
Required notices and full bundled license texts are documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and packaged in the ready-to-load
extension.
