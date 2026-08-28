# Simul

Simul is a Chrome translation companion. It keeps the original website intact
and opens a live, read-only translated replica in Chrome's side panel or a
detached window.

Current build: **0.3.3 beta v.20260828.1** · Desktop Chrome **138+** ·
Manifest V3

Simul is useful when you want to compare the original page and its translation
instead of replacing the page in place. Page text is translated with Chrome's
on-device Translator API. Optional image text reading uses accessibility text,
Chrome's platform TextDetector when available, or packaged Tesseract.js.

## Install or reload in Chrome

The checked-in [`dist/chrome-unpacked`](dist/chrome-unpacked/) directory is the
canonical ready-to-load build. You do not need Node.js or npm to install it.

1. Download or clone this repository and extract it if needed.
2. Open `chrome://extensions` in desktop Chrome 138 or newer.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose this repository's `dist/chrome-unpacked` directory.
6. Open a normal HTTP(S) page and select the Simul toolbar icon.

Keep the directory in place while the extension is installed. After pulling a
new version, select **Reload** on the Simul extension card, reload the source
tab, and reopen the companion. The extension card should show version `0.3.3`;
Simul Options should show `Build 0.3.3 beta v.20260828.1`.

This is an unpacked beta, not a Chrome Web Store or auto-updating release.

## Use Simul

1. Open a normal HTTP(S) page. Chrome does not allow extensions to run on every
   internal, store, or protected page.
2. Select the Simul icon to open the saved side-panel or detached-window
   surface.
3. Leave **From** on **Auto-detect** or choose a source language, then choose
   **To**.
4. If Chrome asks, select **Translate page** so it can prepare the on-device
   language pack.
5. Use **Fit**, **1:1**, custom zoom, layout, and scroll-following controls to
   compare the source with the replica.
6. Turn **OCR On** only when you want to translate text inside visible images.
7. Use **Rebuild mirror** if a browser-level page change cannot be observed
   incrementally.

The settings screen controls launch behavior, automatic translation scopes,
readable-content scope, visual fidelity, image-reading methods, and reset.

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

Image translation is persisted but **off by default**. When enabled, Simul:

1. inspects policy-approved, visible top-frame `<img>` elements;
2. first tries direct `aria-label` or `alt` text, which needs no pixel access;
3. for pixel OCR, verifies stable visible geometry, captures only the relevant
   visible-tab crop, and reduces it to at most 4 megapixels;
4. tries Chrome TextDetector when the installed platform exposes it, then the
   packaged Tesseract.js 7.0.0 fallback according to the saved method order;
5. rejects blank, punctuation-only, and insufficient-confidence results; and
6. translates accepted lines and places inert overlays over the replica image.

The Tesseract worker, WebAssembly cores, notices, and 22 pinned
`tessdata_fast` language files are packaged with the extension. No OCR code,
model, image pixel, or recognized text is fetched from or sent to a remote OCR
service. Crops use short-lived extension storage for the offscreen handoff and
are deleted after the job; OCR and translation caches are bounded and
memory-only.

OCR currently targets stable visible top-frame images. It does not read CSS
backgrounds, canvas, video frames, embedded documents, hidden images, or
credential-overlapping pixels. See
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
broad access at startup.

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
- **Image text is unchanged:** turn on OCR, grant image access if requested,
  keep the image visible, and use a supported source language. Small images are
  skipped by default.
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
