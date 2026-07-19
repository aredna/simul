# Simul

Simul is a Chrome extension that keeps an inert, translated copy of the current
web page beside the original. It performs text translation on-device through
Chrome's built-in Translator API and never changes the source page.

## Install directly in Chrome

You need desktop Chrome 138 or newer. Node.js, npm, and a build step are not
needed to install the extension.

1. Download or clone this repository and extract it if needed.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Select this repository's `dist/chrome-unpacked` directory.

Keep that directory in place while the extension is installed. A Developer
mode installation does not update automatically; after replacing the files,
use the extension card's **Reload** button.

## Use the companion

1. Open a regular HTTP or HTTPS page.
2. Select the extension icon and choose **Open translation panel** or **Open
   detached window**.
3. The From language defaults to **Auto-detect**. Choose any listed target
   language and select **Translate page** if Chrome needs an initial user
   action to prepare that language pack.
4. Select the small ⚙ button over the mirror whenever you need the controls;
   close it to return the page to nearly the full companion area.

The initial capture bootstraps a sanitized visual tree. A bounded observer then
streams changed subtrees, styles, images, dimensions, and source scroll
position into the existing mirror. Expanding content and asynchronously loaded
sections therefore update without periodic full-page snapshots. Navigation or
a detected synchronization failure performs a fresh bootstrap while keeping
the last usable mirror visible.

View options include Fit width, exact 1:1 CSS-pixel size, 25–300% custom zoom,
horizontal and vertical overflow, source-scroll following, and adaptive or
faithful translated-text layout. Language, zoom, layout, scroll, and automatic
translation choices are saved. A reply composer translates from the language
you are reading back into the detected website language and provides a
copyable result; draft and output text are never saved.

If From and To resolve to the same language, Simul leaves the original text
unchanged. Chrome does not provide an API for enumerating Translator languages,
so the UI uses Chrome's documented Chrome 138 language list and verifies each
selected pair at runtime.

## Privacy and permissions

Page and composer text are translated on-device. Simul has no analytics,
remote translation fallback, embedded API key, remotely hosted code, or
required host access. Its installed permissions are:

- `activeTab` for temporary access after a toolbar gesture;
- `scripting` to bootstrap and observe the authorized top-level page;
- `sidePanel` to display the native companion; and
- `storage` to remember settings and explicit automatic-translation scopes.

Optional HTTP(S) access is granted only after choosing **This site** or **All
sites** for automatic translation and is removed when no longer needed. A
detached popup window uses the same permissions and remains tied to the source
tab; Chrome does not expose native side-panel detachment.

The mirror never runs site scripts or copies event handlers, links, passwords,
form values, selections, or contenteditable text. Public button labels remain
visible in inert elements. Original remote images and allowlisted CSS
backgrounds may reload from their existing hosts for visual context, but image
pixels are not sent to a translation service.

## Fidelity limits

This is a high-fidelity safe reconstruction, not the website itself. Open
shadow roots are traversed, but closed shadow roots, cross-origin frame
contents, pseudo-elements, canvas pixels, current video frames, DRM content,
and some script-only state cannot be copied across the extension boundary.
Open roots present during capture, added with new DOM, or created by a newly
upgraded custom element are followed automatically. A root attached later to
an already-defined, already-connected host without any DOM, resize, focus, or
load signal may require **Rebuild mirror** because the platform emits no
general shadow-root-attached event.
Translations can be longer than the source. Adaptive layout lets affected
containers grow; faithful layout keeps geometry and allows text overflow rather
than silently ellipsizing it.

Image OCR and translated image overlays are researched but not shipped. See
[image translation research](docs/image-translation-research.md) and the
[translation companion guide](docs/translation-companion.md).

## Troubleshooting

- If Chrome reports a missing manifest, select `dist/chrome-unpacked` itself.
- If a language pair is unavailable, update Chrome and check that the device
  can download Chrome's corresponding on-device language pack.
- Chrome blocks extensions from browser settings, the Chrome Web Store, and
  other restricted URLs.
- A cross-origin navigation can expire temporary `activeTab` access. Select the
  extension icon on the new site, or explicitly enable automatic access for
  that site.
- If a mirror reports a bounded-content omission, use **Rebuild mirror** after
  reducing or expanding the relevant page section.

## Contributing

Contributor tooling uses Node.js 24 LTS and npm 12. After `npm ci`, run:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the WXT development runner |
| `npm run typecheck` | Type-check source and tests |
| `npm test` | Run automated tests |
| `npm run build` | Build transient output under `.output/` |
| `npm run artifact:check` | Verify the committed installable build byte-for-byte |
| `npm run artifact:sync` | Refresh `dist/chrome-unpacked/` after validation |
| `npm run check` | Run all required quality and artifact checks |

Never edit `dist/chrome-unpacked` by hand; change source and use
`npm run artifact:sync` only after checks pass.
