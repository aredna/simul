# Simul

## The problem Simul solves

The web contains useful information, communities, and services in languages
their visitors may not understand. Ordinary page translation replaces the
original, which makes it harder to compare wording, layout, images, and
context. Simul keeps the original page untouched while placing an inert,
translated copy beside it in a Chrome side panel or detached window.

The companion follows live page changes and scrolling, translates visible text
on-device, and can optionally recognize and translate text inside images. Its
goal is to make unfamiliar parts of the web understandable without turning the
translated view into a second active copy of the website.

## How Simul was built

Planning, architecture, research, implementation, debugging, tests, and
documentation for Simul were produced 100% using **Codex 5.6 Sol Ultra** with
the **BMAD skill**.

The extension itself uses Node.js 24 LTS, npm, WXT, TypeScript, and Chrome
Manifest V3. Page text is translated locally through Chrome's built-in
Translator API. Optional image text recognition uses Chrome TextDetector when
available and packaged Tesseract.js models as the local fallback. Simul has no
cloud translation service, bundled API key, or remotely hosted executable
code.

## Install directly in Chrome

The repository keeps both the TypeScript source and a compiled, ready-to-load
extension in `dist/chrome-unpacked`. Installation does not require Node.js,
npm, or a build step.

1. Download or clone this repository and extract it if needed.
2. Open `chrome://extensions` in desktop Chrome 138 or newer.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Select this repository's `dist/chrome-unpacked` directory.

Keep that directory in place while the extension is installed. A Developer
mode installation does not update automatically. After repository files are
updated, select **Reload** on Simul's extension card, reopen the companion, and
confirm its visible build number is the version you expected.

## Challenges and solutions

| Challenge | Simul's approach |
| --- | --- |
| Modern pages change after load and often render through JavaScript. | The default Isolated HTML engine reads the browser-produced DOM, constructs a script-disabled replica, and applies bounded, ordered patches. A gap or unsafe transition stages a fresh checkpoint while the last good view remains visible. |
| Ordinary sites lose their layout when every external visual reference is removed. | The saved **Passive Fidelity** policy is the Isolated HTML default. It retains bounded passive CSS, image, font, link-identity, and static SVG semantics, with a clear warning that the replica may make additional HTTP(S) requests. **Conservative** retains the stricter fallback. Neither mode claims zero replica networking; **Strict Local Mirror** remains hidden until that guarantee is implemented and tested. |
| A translated view must not become another active website. | In both fidelity policies, the replica strips scripts, handlers, form actions, active embedded documents, playback, and executable URLs. Its sandbox remains scriptless, controls and links are pointer-inert, navigation cannot escape the companion, and the source page is never rewritten. |
| Useful search and text fields can contain public text, but form controls may also contain secrets. | Isolated HTML reads only native text, search, email, URL, telephone, and textarea controls. It uses a nonempty current value or otherwise the placeholder. Passwords, password-autocomplete fields, unsupported controls, selects, contenteditable regions, and ARIA textbox fallbacks stay blank. Control text is typed metadata rather than a copied `value` attribute and is never logged or saved. rrweb remains fully masked. |
| Live pages repeat the same phrases and images in different nodes. | Bounded memory-only caches use content rather than DOM identity. Text uses the provider, exact From/To pair, and exact source string; concurrent matches join one provider request. OCR uses provider/model order, language, preprocessing profile, dimensions, and processed pixel hash; matching in-flight jobs join. A URL alone is not a cache key because the same image may render at a different size, crop, or frame. |
| Some sites scroll a large nested application surface instead of the document. | Document coordinates remain the authoritative path and are retained even if they arrive before a new replica commits. A nested surface can take ownership only after it emits a qualifying real scroll event. Rebuild and navigation clear stale ownership; text fields, hidden overflow, small carousels, and incidental horizontal strips are ignored. |
| OCR is expensive and can mistake decoration for text. | Visible pixels are captured at a bounded rate and size, recognition runs off the companion UI, and blank, punctuation-only, or explicitly very-low-confidence regions are rejected before translation. Recognition is bounded by entry and result-weight budgets; same-language work stops before OCR. |
| Website appearance comes from several CSS channels, not just inline styles. | Under Passive Fidelity, Simul preserves bounded inline declarations, style blocks, stylesheet links, readable CSSOM, constructed/adopted sheets, open-shadow styles, custom properties, conditional rules, pseudo-elements, passive fonts/backgrounds, static SVG presentation, and local `url(#fragment)` effects in cascade order. The source canvas color is propagated through the complete replica shell and live updates. |
| Script-disabled replicas cannot reproduce every browser and site behavior. | Open shadow roots, bounded static inline SVG, responsive images, standards/quirks document mode, ordinary CSSOM-change recovery, live mutations, and stylesheet settlement are handled explicitly. Opaque source blobs, exact limited-quirks behavior, unreadable cross-origin CSSOM, broad computed-style reconstruction, external SVG fetch/intrinsic-animation behavior controlled by Chrome, current media pixels, closed roots, and script-only component state remain documented limits. |

## Use the companion

1. Open a regular HTTP or HTTPS page.
2. Select the extension icon. Simul opens the last-used companion view; Options
   can make it always open the side panel or detached window.
3. Leave From on **Auto-detect** or choose a source language, then choose the
   target language. Select **Translate page** if Chrome needs an initial user
   gesture to prepare that language pack.
4. Use the **文** button for a private, unsaved reverse translation into the
   website language. Use the settings button only when you need the full
   options.

The thin, full-width toolbar keeps the common controls in one row: Refresh;
the **From** label, `[A]` (set From to Auto-detect), and a wider From selector;
swap and a wider **To** selector; Fit/1:1 size; OCR; Current/Active tab
following; quick translation; Settings; Side/Popout; and the replica state at
the far right. At unusually narrow widths the row scrolls horizontally rather
than covering the replica. Visible toolbar and Settings labels are translated
as one complete set into the selected target language. If any label cannot be
translated locally, the whole set remains in English instead of mixing
languages. Healthy state has no detached dot; a warning or error marker appears
on Refresh or Settings according to the action that needs attention.

The two language menus use one explicit, stable order based on each language's
English reference name; they are not re-sorted by the current UI locale.
**From** begins with Auto-detect and displays language names in the selected
target language. **To** displays each language in its own native form, including
distinct endonyms for Simplified and Traditional Chinese. This keeps every
supported language in the same predictable position while making the target
choice recognizable to its reader.

The toolbar background shows page capture, translation, live-update,
permission, image-analysis, and surface-transition activity. Automation,
custom zoom, layout, window behavior, and experimental engine/OCR controls
remain in Settings.

The initial capture bootstraps a sanitized visual tree. A bounded observer then
streams relevant text, control text, attributes, children, styles, images,
dimensions, and source scroll position into that tree. Full capture is reserved
for initial bootstrap, navigation, manual rebuild, or bounded recovery rather
than periodic snapshots.

View options include Fit width, exact 1:1 CSS-pixel size, 25–300% custom zoom,
horizontal and vertical overflow, source-scroll following, and adaptive or
faithful translated-text layout. **Isolated HTML** is the default engine;
**rrweb (experimental)** remains selectable under Advanced & experimental. A
detached window can stay locked to its opening tab or follow the active tab
across ordinary browser windows. Settings are saved; quick-translation drafts
and output are not. Isolated HTML also saves its **Replica fidelity** policy;
changing that policy rebuilds the replica through the newly selected boundary.

If From and To resolve to the same language, Simul leaves the source text
unchanged. Chrome does not expose an API that enumerates Translator languages,
so Simul presents Chrome's documented Chrome 138 language set and checks the
chosen pair at runtime.

## Privacy and permissions

Page, eligible control, image-line, and quick-translation text are processed
on-device. Simul has no analytics, remote translation fallback, embedded API
key, or required host access. Its installed permissions are:

- `activeTab` for temporary access after a toolbar gesture;
- `scripting` to bootstrap and observe the authorized top-level page;
- `sidePanel` to display the native companion;
- `storage` to remember settings and explicit automatic-translation scopes;
  and
- `offscreen` to run packaged local OCR away from the companion UI.

Optional page access is granted only after choosing **This site** or **All
sites** for automatic translation, or explicitly enabling image translation.
Chrome requires a literal optional all-sites grant for reliable visible-tab
pixel capture after temporary `activeTab` access expires. Simul requests that
grant only from an explicit gesture, does not fetch the image URL, and removes
broad access after image translation and all-sites automation are both off. A
saved-on setting without the grant remains paused instead of prompting at
startup.

A detached window uses the same permissions. Following newly active tabs works
automatically on sites with optional access; otherwise select Simul on the new
site because `activeTab` access does not transfer between tabs. Chrome blocks
extensions from browser settings, the Chrome Web Store, and other restricted
URLs.

The mirror never runs site scripts or copies event handlers, passwords,
selections, contenteditable text, or unsupported control values. Passive
Fidelity may retain a normalized HTTP(S) anchor address for selectors and inert
semantics, but pointer input and navigation remain disabled.
Eligible native text-control content is held only in the current in-memory
replica/translation session and is cleared when a field becomes sensitive.

**Passive Fidelity**, the default, may reload original remote images, linked or
imported stylesheets, fonts, CSS backgrounds, responsive image candidates,
static posters, and passive SVG resources from their existing hosts. This can
produce additional HTTP(S) requests attributable to the replica. **Conservative**
admits fewer resource-bearing semantics, but it can still load allowlisted
images, stylesheet links, fonts, and CSS URLs; it is not a no-network mode. A
future **Strict Local Mirror** mode is recorded as deferred work and is not
shown in Settings until explicit no-network acceptance tests pass.

When image translation is explicitly enabled and access is granted, Simul
captures stable visible top-frame image pixels, tries available local OCR
providers in the saved order, translates accepted lines through Chrome, and
discards the transient crop. Pixels and recognized text are never sent to a
remote service or saved as history.

The installable directory includes local Tesseract.js 7.0.0 assets and models
for English, Spanish, French, German, Portuguese, Italian, Vietnamese,
Japanese (horizontal and vertical), Korean, Simplified and Traditional
Chinese, Russian, Ukrainian, Arabic, Hebrew, Hindi, Marathi, Bengali, Kannada,
Tamil, and Telugu. Only the routed language group is loaded into memory; other
models remain on disk. The complete unpacked extension must remain below the
project's 42 MiB release limit.

## Fidelity policies and limits

Simul is a high-fidelity safe reconstruction, not the website itself. Passive
Fidelity preserves sanitized CSS through inline declarations, `<style>` blocks,
linked and adopted stylesheets, readable CSSOM, open shadow roots, custom
properties, conditional and pseudo-element rules, passive fonts/backgrounds,
SVG presentation, and bounded same-document `url(#fragment)` references.
Readable imports are flattened in source order; an unreadable normalized
HTTP(S) import may remain request-capable. A validated computed canvas color
fills the iframe and its surrounding presentation layers at bootstrap and
during live dimension/theme updates, so a transparent dark page does not expose
a white companion canvas.

Closed shadow roots remain inaccessible. Cross-origin stylesheet links may
still render, but browser security prevents Simul from reading their CSSOM for
sanitized reconstruction. Generated pseudo-element text can render from a
preserved rule but is not a DOM text node and therefore cannot be translated.
Script-only custom-element state is not recreated because the replica does not
execute website JavaScript. Bounded polling detects ordinary stylesheet CSSOM
changes and recovers from a fresh checkpoint, but Chrome can still hide rules
behind cross-origin CSSOM boundaries. Source `blob:` URLs cannot be reused
safely across the isolated boundary. Simul selects a standards or quirks
`srcdoc` shell from validated source metadata, but it does not separately
reproduce Chrome's limited-quirks mode. Broad computed-style serialization is
intentionally omitted.
External SVG references remain subject to Chrome's fetch/CORS behavior. Canvas
pixels, current video frames, DRM content, cross-origin frame contents, and
other browser-managed state also cannot cross the isolated boundary.

Covered descendant edits, privacy transitions, ambiguous identity, and
cross-parent churn deliberately use bounded replacement or a fresh checkpoint.
Translations can be longer than the source: adaptive layout lets affected
containers grow, while faithful layout retains geometry and allows overflow.

Image OCR currently handles ordinary visible top-frame `<img>` elements,
including externally sourced SVG images displayed through `<img>`. Hidden
images wait until visible; CSS backgrounds, canvas, video, frames, and images
without a supported language hint remain unchanged. OCR overlays are inert and
do not resize or rewrite the source or replica image. Translated overlay text
wraps and uses bounded font downscaling inside the recognized region. When an
explicit or reliably resolved image source language equals To, Simul preserves
the original pixels without running recognition. High-DPI captures are
proportionally downscaled to the 4 MP OCR ceiling. See the
[image translation notes](docs/image-translation-research.md) and
[translation companion guide](docs/translation-companion.md). The complete
policy matrix, diagnostics, and browser-boundary notes are in
[Replica fidelity](docs/replica-fidelity.md).

## Troubleshooting

- If Chrome reports a missing manifest, select `dist/chrome-unpacked` itself.
- If a language pair is unavailable, update Chrome and confirm that Chrome can
  prepare the corresponding on-device language pack.
- If image text stays unchanged, open Advanced & experimental, enable image
  translation, grant access if requested, and make sure the image is visible
  and From uses a supported language. Small images are skipped by default.
- Expand **OCR diagnostics** to see memory-only discovery, scheduling, capture,
  recognition, cache hit/miss/join/load, quality-filter, translation,
  projection, retry, and anchor-rebinding stages. Entries never include page
  text, URLs, pixels, hashes, or node IDs.
- A cross-origin navigation can expire temporary `activeTab` access. Select the
  extension icon on the new site, or explicitly enable automatic access for
  that site.
- If the replica reports a bounded-content omission, reduce or expand the
  relevant source section and use **Rebuild mirror**.
- `[Simul isolated mirror]` console entries report bounded replica stages, and
  `[Simul fidelity resources]` reports the selected policy plus
  preserved/flattened/omitted resource counts, block-reason counts, and
  request-capable resource counts. Neither includes page text, URLs, tag names,
  attributes, hashes, or node IDs. A request-capable count means the replica may
  request the resource; it is not a network request log.

## Contributing

The installable artifact is compiled and checked in, but the complete
uncompiled TypeScript source remains in the same repository. Contributor
tooling uses Node.js 24 LTS and npm 12. After `npm ci`, run:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the WXT development runner |
| `npm run typecheck` | Type-check source and tests |
| `npm test` | Run automated tests |
| `npm run build` | Build transient output under `.output/` |
| `npm run artifact:check` | Verify the committed installable build byte-for-byte |
| `npm run artifact:sync` | Refresh `dist/chrome-unpacked/` after validation |
| `npm run check` | Run all required quality and artifact checks |

Never edit `dist/chrome-unpacked` by hand. Change source, pass the gates, and
then use `npm run artifact:sync` to refresh the ready-to-install directory.
