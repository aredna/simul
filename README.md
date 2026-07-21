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
use the extension card's **Reload** button. Open Simul's ⚙ options afterward
and confirm the displayed build number matches the version you intended to
test.

## Use the companion

1. Open a regular HTTP or HTTPS page.
2. Select the extension icon. Simul opens the last-used companion view directly;
   Options can instead make the toolbar always open the side panel or detached
   window.
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
faithful translated-text layout. **Isolated HTML** is the default replica
engine; it mirrors the browser-produced DOM into a script-disabled iframe.
The previous **rrweb (experimental)** engine remains selectable under Options
without rebuilding the extension. A detached window can stay locked to its
opening tab or follow the active tab across ordinary browser windows. Language,
engine, zoom, layout, scroll, launch, and automatic translation choices are
saved. Image translation is also available as an
experimental, initially-off option under **Image text**. A reply composer translates from the language
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
- `sidePanel` to display the native companion;
- `storage` to remember settings and explicit automatic-translation scopes;
  and
- `offscreen` to run the packaged local OCR worker away from the panel UI.

Optional page access is granted only after choosing **This site** or **All
sites** for automatic translation, or explicitly enabling image translation.
Chrome requires a literal optional all-sites grant for reliable visible-tab
pixel capture after temporary `activeTab` access expires. Simul requests that
grant only from an explicit image toggle, **Grant image access**, or **All
sites** automation gesture; it does not fetch the image resource, and it
removes broad access after both image translation and all-sites automation are
off. A saved-on setting without the grant remains paused and actionable instead
of prompting at startup. A
detached popup window uses the same permissions. Following newly active tabs
works automatically on sites with optional access; otherwise the user must
select Simul on the new site because `activeTab` access does not transfer to a
different tab. Chrome 141 or newer uses the native panel-close API when
popping out; older supported releases use a disable-and-reenable teardown for
Simul's panel entry.

The mirror never runs site scripts or copies event handlers, navigable links,
passwords, form values, selections, or contenteditable text. Private controls
and their descendant text are masked before transport. Original remote images and allowlisted CSS
backgrounds may reload from their existing hosts for visual context. When
image translation is explicitly enabled and image access is granted, Simul captures only stable visible
top-frame image pixels, tries Chrome's capability-probed TextDetector when the
platform exposes it, falls back to packaged Tesseract models according to the
saved OCR priority, translates accepted lines through Chrome, and discards the
transient crop.
Pixels and recognized text are never sent to a remote service or saved as
history.

The installable directory includes local Tesseract.js 7.0.0 assets and models
for English, Spanish, French, German, Portuguese, Italian, Vietnamese,
Japanese (horizontal and vertical), Korean, Simplified and Traditional
Chinese, Russian, Ukrainian, Arabic, Hebrew, Hindi, Marathi, Bengali, Kannada,
Tamil, and Telugu. Only the routed language group is loaded into memory; the
remaining models stay on disk. The complete unpacked extension remains below
the project's 42 MiB release limit.

## Fidelity limits

This is a high-fidelity safe reconstruction, not the website itself. Open
shadow roots are mirrored and dynamically reconciled; closed shadow roots,
cross-origin frame contents, pseudo-elements, canvas pixels, current
video frames, DRM content, CSSOM-only rule edits, and some browser-managed or
script-only state cannot be copied across the isolated HTML boundary. Use
**Rebuild mirror** when a site changes only one of those unobservable states.
Translations can be longer than the source. Adaptive layout lets affected
containers grow; faithful layout keeps geometry and allows text overflow rather
than silently ellipsizing it.

Image OCR currently handles ordinary visible top-frame `<img>` elements,
including externally sourced SVG images displayed through `<img>`.
Hidden images wait until visible; CSS backgrounds, canvas, video, frames, and
images without a supported language hint are left unchanged. OCR overlays are
inert sibling layers and do not resize or rewrite the source or replica image.
See the [image translation notes](docs/image-translation-research.md) and the
[translation companion guide](docs/translation-companion.md).

## Troubleshooting

- If Chrome reports a missing manifest, select `dist/chrome-unpacked` itself.
- If a language pair is unavailable, update Chrome and check that the device
  can download Chrome's corresponding on-device language pack.
- If image text stays unchanged, open options, enable **Translate text inside
  images**, choose **Grant image access** if it appears, and make sure the
  image is visible and the From language is supported. Small images are
  skipped by default. Expand **OCR diagnostics**
  under Image text to see memory-only discovery counts, skips, capture,
  recognition, translation, and projection stages. Capture failures distinguish
  inactive-tab, permission, quota, API, data, decode, drawing-surface, encode,
  and digest stages. These entries never include
  page text, URLs, pixels, hashes, or node IDs; the same details are also sent
  to the companion window's `[Simul image translation]` console channel.
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
