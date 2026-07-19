# Simul

Simul is a Chrome extension that shows a safe, read-only translation of the
current page beside the original. Translation runs on-device with Chrome's
built-in Translator API, initially for Japanese and English.

## Install in Chrome

You need desktop Chrome 138 or newer. You do not need Node.js, npm, or a build
tool to install Simul.

1. Download or clone this repository and extract it if necessary.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** in the upper-right corner.
4. Choose **Load unpacked**.
5. Select the repository's `dist/chrome-unpacked` directory.

Chrome should display Simul in the extension list. Keep the downloaded
directory in place while the extension is installed; Chrome loads the local
files from that directory. This Developer mode installation does not update
automatically.

## Use Simul

1. Open a regular HTTP or HTTPS page containing Japanese or English text.
2. Select the Simul toolbar icon, then **Open translation panel**.
3. Choose Japanese → English or English → Japanese.
4. Select **Translate page**. Chrome may download an on-device language pack
   the first time you use a language pair.

The original tab is not modified. Simul rebuilds a sanitized, inert visual
mirror in Chrome's side panel, preserving ordinary page structure, layout,
styling, images, and empty control locations. Choose **Fit width** for a scaled
comparison or **1:1 size** for the source viewport's natural width.

**Refresh snapshot** immediately rereads an authorized page. Simul also
follows completed navigations in the same tab. Because Chrome intentionally
expires temporary access when that tab moves to a different site, select the
Simul toolbar icon once on the new site to authorize it; an already-open panel
then refreshes without being closed.

Automatic translation defaults to **Off**. Choose **This site** or **All
sites** to grant the matching optional access and translate completed page
loads automatically. If Chrome still needs to download a language pack,
choose **Translate page** once from the panel; automatic loads begin only after
that language pair is ready. Chrome controls whether side panels appear on the
left or right.

## Privacy and permissions

Page text is translated on-device. Simul has no analytics, remote translation
fallback, API key, persistent content script, or required host access. Its
installed permissions are:

- `activeTab` for temporary access after you select the toolbar action;
- `scripting` to read a bounded snapshot from that active page;
- `sidePanel` to show the translated companion; and
- `storage` to remember only automatic-translation scopes and the Fit/1:1
  display choice.

The manifest declares optional access for regular HTTP and HTTPS pages, but
Chrome grants none of it at installation. Selecting **This site** requests only
that origin; selecting **All sites** requests all regular web origins. Turning
a scope off removes its no-longer-needed access. Chrome shows the corresponding
permission prompt.

Chrome's per-site match patterns cannot represent one non-default port without
broadening access to every port on that host. Simul therefore keeps **This
site** unavailable for those URLs; use the toolbar gesture or explicitly choose
**All sites** instead.

Original remote images and safe CSS backgrounds displayed for context may
reload from their existing source host. They are not sent to a translation
service. Simul never copies page HTML, scripts, event handlers, links, form
values, passwords, selections, or contenteditable text into the mirror.

## Current limitations

- Chrome's Translator API and the required language pack must be available on
  the device.
- The companion is a high-fidelity approximation, not a pixel-perfect or live
  page clone. Translation changes text metrics and line wrapping.
- Image pixels are unchanged. Only available image labels and captions are
  translated; OCR is not included.
- Embedded-frame contents, canvas pixels, video, closed shadow roots, source
  web-font files, live DOM mutation mirroring, scroll synchronization, and
  automatic form filling are not included. Placeholders or safe shells retain
  their approximate locations where possible.

See [the translation companion guide](docs/translation-companion.md) for the
full privacy model, limitations, and troubleshooting context.

## Troubleshooting

- If Chrome says the manifest is missing, select `dist/chrome-unpacked`
  itself—not the repository root or its parent `dist` directory.
- If translation is unavailable, update desktop Chrome and confirm it is at
  least version 138. Availability can also depend on the device and language
  pack state.
- If you replace the repository with a newer download, return to
  `chrome://extensions` and select Simul's **Reload** button.
- Chrome blocks extensions from reading browser settings pages, the Chrome Web
  Store, and other restricted URLs. Open Simul on a regular website instead.
- If a newly opened site says access expired, select the Simul toolbar icon on
  that site. To avoid that gesture on later loads, opt that site into automatic
  translation.

## Contributing

Contributor tooling requires Node.js 24 LTS and npm 12. Install dependencies
with `npm ci`, then use:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the WXT development runner |
| `npm run typecheck` | Type-check the source |
| `npm test` | Run automated tests |
| `npm run build` | Build transient output under `.output/` |
| `npm run artifact:check` | Build temporarily and verify the committed release byte-for-byte |
| `npm run artifact:sync` | Intentionally refresh `dist/chrome-unpacked/` from a validated build |
| `npm run check` | Run all required quality and release-artifact checks |

The canonical installable directory is generated. Change source files first,
then run `npm run artifact:sync`; do not edit release files by hand.
