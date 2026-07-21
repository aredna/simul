# Simul

Simul is a Chrome translation companion that keeps the original website intact
and places a live, inert, translated replica beside it in the side panel or a
detached window.

Current release: **0.3.2 release candidate** · Desktop Chrome **138+** · Chrome
Manifest V3

## Why Simul exists

The useful parts of the web are not always written in a language their readers
understand. Conventional page translation replaces the original presentation,
making it harder to compare wording, layout, images, and context—and an active
copy of a website would create a second surface for scripts, navigation, and
forms.

Simul takes a different approach:

- the source page stays visible and unchanged;
- a read-only companion follows relevant page updates and scrolling;
- visible text is translated through Chrome's on-device Translator API;
- optional local OCR can translate text inside visible images; and
- the replica is reconstructed behind a scriptless, pointer-inert boundary.

The goal is useful visual comparison, not a claim that every website can be
reproduced pixel-for-pixel without executing it.

## OpenAI Build Week disclosure

Simul was newly created during the OpenAI Build Week Submission Period. The
repository has one root commit: [`f1e8546`](https://github.com/aredna/simul/commit/f1e8546f65e70c2e4d270b39bd2f9b80dc2f7828),
dated July 18, 2026 at 10:03 PM PDT. The entrant attests that no pre-existing
Simul code was carried into the submission. The installable 0.3.2 release
candidate was produced at
[`90f8f4b`](https://github.com/aredna/simul/commit/90f8f4b3dfe789c8ea63083f625080bf46e18b80),
and [`ee8398d`](https://github.com/aredna/simul/commit/ee8398d84f37e59b1a1229825ec61129b405afec)
is the immutable functional baseline immediately before non-runtime compliance
work. The completed submission tree is marked by the immutable
[`openai-build-week-2026-submission`](https://github.com/aredna/simul/tree/openai-build-week-2026-submission)
tag.

The entrant and Codex collaborated throughout the project:

| Contributor | Work and decisions |
| --- | --- |
| **Entrant** | Defined the problem and requirements; chose the read-only side-by-side product direction, privacy and fidelity tradeoffs, feature priorities, and acceptance criteria; repeatedly tested real websites in Chrome; and approved release decisions. |
| **Codex powered by GPT-5.6 Sol Ultra** | Turned that direction into BMAD Method research and specifications; proposed architecture and security boundaries; implemented and debugged the extension; created tests and the ready-to-load artifact; and performed adversarial, privacy, dependency, licensing, and release reviews. |

Codex accelerated the work by keeping requirements, research, implementation,
tests, and documentation connected through the primary long-running build
thread and checked-in BMAD Method artifacts. Representative decision records
include the
[initial product specification](_bmad-output/implementation-artifacts/spec-side-by-side-page-translation.md),
[live-replica and OCR research](_bmad-output/planning-artifacts/research/technical-live-dom-replication-ocr-extension-access-research-2026-07-19.md),
[isolated-mirror specification](_bmad-output/implementation-artifacts/spec-isolated-html-mirror-engine.md),
and [passive-fidelity architecture](_bmad-output/specs/spec-passive-replica-fidelity/architecture.md).

GPT-5.6 Sol Ultra was the development model powering Codex; it is **not** a
runtime translation API in Simul. The shipped extension uses Chrome's on-device
Translator and optional TextDetector APIs plus packaged Tesseract.js assets. It
makes no OpenAI API call and contains no cloud translation integration, service
credentials, analytics, or remotely hosted executable code.

The BMAD Method supplied third-party workflow templates and generated project
tooling; it is not part of the extension runtime. WXT, TypeScript, rrweb,
Tesseract.js, and other third-party work retain their own licenses and notices.
See the [complete Build Week disclosure](docs/openai-build-week-disclosure.md)
and [third-party notices](THIRD_PARTY_NOTICES.md).

## Install the ready-to-load Chrome extension

The checked-in [dist/chrome-unpacked](dist/chrome-unpacked/) directory is the
canonical ready-to-load build. Installing it does not require Node.js, npm, or
a local build.

1. Download or clone this repository and extract it if necessary.
2. Open `chrome://extensions` in desktop Chrome 138 or newer.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose this repository's `dist/chrome-unpacked` directory.
6. Open a normal HTTP(S) page and select the Simul toolbar icon.

Keep the directory in place while Simul is installed. Developer Mode extensions
do not update automatically: after updating the repository, select **Reload**
on Simul's extension card and reopen the companion.

## What ships in 0.3.2

- A live translated companion in Chrome's side panel or a detached window.
- Auto-detected or explicit source language, explicit target language, pair
  swapping, and same-language short-circuiting.
- A private quick translator that reverses the active page pair without saving
  its draft or result.
- A compact toolbar with rebuild, language, size, OCR, tab-following, quick
  translation, settings, surface, activity, and replica-state controls.
- Fit width, exact 1:1 CSS-pixel size, 25–300% custom zoom, horizontal and
  vertical overflow, adaptive or faithful translated-text layout, and source
  scroll following.
- Generic document and qualifying nested-scroll synchronization, including
  eligible open-shadow scroll surfaces.
- Site-scoped or all-sites automatic translation after an explicit permission
  choice.
- A detached window that can remain on its opening tab or follow the active tab
  across ordinary browser windows.
- Atomic target-language localization for the visible Simul toolbar and
  settings labels; English remains complete if a local label translation fails.
- Memory-only, content-keyed translation and OCR caches with bounded size and
  in-flight request joining.
- Content-free mirror, fidelity, translation-cache, scroll, and OCR diagnostics.
- A **Live source only** inspection mode that removes translation projections
  without rebuilding the underlying live replica.

Public native dropdowns are represented as companion-owned, scriptless
disclosures: the selected label remains visible and translated option/optgroup
labels can be revealed in a bounded scrolling list. The disclosure cannot
change or submit the website's selection. Public non-editable ARIA
menu/listbox/option labels can also be translated; editable or private control
branches remain masked.

## Replica engines

### Isolated HTML — default

The production engine reads the browser-produced DOM into a bounded,
allowlisted graph. The extension validates that graph again and creates real DOM
nodes inside an isolated iframe. An initial checkpoint establishes the tree;
ordered live patches then update text, eligible controls, attributes, children,
styles, dimensions, images, and scroll state.

Stable same-parent child updates retain receiver-proven DOM objects and send
graphs only for new content. Covered dirty descendants, privacy transitions,
cross-parent moves, ambiguous identity, gaps, and capacity failures use bounded
replacement or a freshly staged checkpoint. A new checkpoint replaces the
last-good view only after it is ready.

### rrweb — experimental

rrweb remains selectable under **Advanced & experimental**. It uses a separate
sanitized recording/replay path with revision-safe translation projection and
fully masked editable/value-bearing controls. It is useful for comparison and
compatibility testing, but Isolated HTML is the recommended engine.

### Legacy renderer — emergency path

The legacy renderer remains an internal recovery path. Simul does not silently
switch between Isolated HTML and rrweb when an engine fails.

## Inertness, privacy, and permissions

The replica is not a second running copy of the website. Its iframe uses
`sandbox="allow-same-origin"` without `allow-scripts`; source scripts,
constructors, event handlers, forms, frames, active embeds, playback, executable
URLs, and navigation behavior are removed or disabled. Website presentation is
pointer-inert, while extension code can still inspect and translate the safe
tree. Companion-owned dropdown disclosures are the narrow exception: they can
reveal safe labels but cannot change or submit website state.

Passwords, contenteditable text, unsupported controls, editable ARIA controls,
private ancestry, raw native-select values, names, data attributes, datalist
suggestions, and submission semantics do not cross the replica boundary.
Eligible public native text-control content is held only in the active in-memory
session and is cleared if the field becomes sensitive. Diagnostics never include
page text, URLs, attribute values, pixels, hashes, or DOM IDs.

The installed permissions are:

| Permission | Why it is present |
| --- | --- |
| `activeTab` | Temporary access to the page after the user selects Simul. |
| `scripting` | Bootstrap the authorized top-level page snapshot and bounded observers. |
| `sidePanel` | Host the native Chrome companion. |
| `storage` | Save settings and explicit automatic-translation scopes. |
| `offscreen` | Run packaged local OCR away from the companion UI. |

`<all_urls>` is declared only as an optional host permission. Simul requests it
from an explicit gesture when all-sites automation or reliable image capture
needs it. A saved setting without the grant remains paused rather than prompting
at startup, and broad access is removed after both owners are disabled.

Page text, eligible control text, image OCR text, and quick translations are
processed on-device. Image crops use extension-origin transient storage for
offscreen handoff and are removed after use; recognized text and pixels are not
saved as history or sent to a remote service.

## Fidelity policies

Visual fidelity and replica networking are separate concerns. Isolated HTML
saves one of two selectable policies:

| Policy | Status | Behavior |
| --- | --- | --- |
| **Passive Fidelity** | Default and recommended | Preserves the broadest bounded set of passive CSS, images, fonts, anchor identity, responsive sources, usable static posters, and static SVG references. These references may cause additional HTTP(S) requests to their existing hosts. |
| **Conservative** | Selectable fallback | Omits newer passive semantics and admits fewer resource-bearing references, but can still load allowlisted images, stylesheet links, fonts, and CSS URLs. It is not a no-network mode. |
| **Strict Local Mirror** | Hidden and deferred | Will become selectable only after a deterministic no-network backstop and acceptance suite exist. It is not implemented in this release. |

Both available policies keep the same scriptless sandbox and active-content
blocks. Changing policy rebuilds Isolated HTML through the newly selected
boundary.

Passive Fidelity can preserve bounded inline styles, `<style>` blocks, linked
stylesheets, readable CSSOM, constructed/adopted sheets, open-shadow styles,
custom properties, conditional rules, pseudo-elements, fonts/backgrounds,
static SVG presentation, and local `url(#fragment)` effects. Readable imports
are flattened in source order. Browser-inaccessible styles may remain as
request-capable normalized links/imports when the selected policy permits them.

For the complete matrix and diagnostic meanings, see
[Replica fidelity](docs/replica-fidelity.md).

## Optional local image translation

Image translation is persisted but **off by default**. Once enabled from an
explicit gesture and granted the needed access, Simul:

1. observes ordinary visible top-frame `<img>` elements without using their URL
   as an OCR cache key;
2. captures a geometry-checked visible-tab crop no more than twice per second;
3. proportionally reduces high-DPI crops to a maximum of 4 MP;
4. tries the saved local-provider order—by default, Chrome TextDetector when
   the installed browser exposes it, then packaged Tesseract.js 7.0.0;
5. rejects blank, punctuation-only, and explicitly very-low-confidence regions;
6. translates accepted lines with Chrome's on-device Translator; and
7. projects clipped, inert text overlays that follow replica scroll and zoom.

The ready-to-load build includes the Tesseract Worker, three local Wasm core
loaders, notices/hashes, and 22 pinned `tessdata_fast` files covering English,
Spanish, French, German, Portuguese, Italian, Vietnamese, horizontal and
vertical Japanese, Korean, Simplified and Traditional Chinese, Russian,
Ukrainian, Arabic, Hebrew, Hindi, Marathi, Bengali, Kannada, Tamil, and Telugu.
Only the routed language group is loaded into memory.

OCR currently targets stable visible top-frame images. CSS backgrounds, canvas,
video, frames, hidden images, and images without a usable language route remain
unchanged. See [Image text translation research](docs/image-translation-research.md)
for the implemented boundary and deferred alternatives.

## Use Simul

1. Open a regular HTTP(S) page. Chrome blocks extensions on settings pages, the
   Chrome Web Store, and other restricted URLs.
2. Select the Simul icon. The saved launch behavior opens the side panel or
   detached companion.
3. Leave **From** on **Auto-detect** or select a source language, then choose
   **To**.
4. Select **Translate page** if Chrome needs a user gesture to prepare the
   on-device language pack.
5. Use **Fit**, **1:1**, custom zoom, layout, and scroll-following controls to
   compare the source and translation.
6. Use **OCR On** only when local image text translation is wanted; grant image
   access if Chrome asks.
7. Select **文** for an unsaved reverse translation into the page language.
8. Use **Rebuild mirror** after a browser-boundary change that cannot be
   observed incrementally.

Chrome does not expose an API that enumerates every Translator language at
runtime. Simul presents Chrome's documented Chrome 138 language set, then asks
Chrome whether the selected pair is available on the current device.

## Engineering challenges and solutions

| Challenge | Implemented solution |
| --- | --- |
| Dynamic, JavaScript-rendered pages | Mirror the browser-produced DOM, stream bounded ordered changes, retain stable child identity, and recover through an atomically staged checkpoint. |
| High fidelity without a second active site | Apply fidelity policy at capture and receipt, strip active behavior, and render inside a scriptless, pointer-inert iframe. |
| Public labels beside private form state | Transport typed, bounded presentation metadata only; mask passwords, editable/private branches, raw values, names, and submission semantics. |
| CSS spread across DOM and CSSOM channels | Preserve bounded safe declarations, rules, imports, adopted/open-shadow sheets, and static SVG effects; poll readable CSSOM signatures and rebuild on unobservable rule changes. |
| Nested application scrolling | Keep document coordinates authoritative until a qualifying real nested scroll surface takes ownership; reject controls, carousels, and incidental overflow. |
| Expensive or noisy OCR | Use a capacity-one scheduler, stable geometry checks, a 4 MP ceiling, local offscreen providers, quality filtering, bounded content caches, and stale-result guards. |
| Live repeated phrases and pixels | Key memory by exact content and processing inputs rather than DOM identity or URL, and join identical in-flight provider work. |

## Known browser-boundary limitations

Simul is a safe reconstruction, not an instrumented browser clone. Current
limits include:

- closed shadow roots, `ElementInternals`, `:defined`, and other script-owned
  custom-element state;
- virtualized content that does not exist in the accessible browser-produced
  DOM;
- unreadable cross-origin CSSOM, even when the original stylesheet can render;
- generated pseudo-element text, which can render but is not a translatable DOM
  text node;
- source `blob:` resources, broad computed-style reconstruction, and exact
  limited-quirks emulation;
- external SVG behavior still governed by Chrome fetch, CORS, MIME, and SVG
  rules;
- canvas pixels, current video frames, DRM/protected media, active embedded
  documents, and cross-origin frame contents; and
- OCR sources other than supported visible top-frame images.

Passive and Conservative fidelity can both initiate permitted passive resource
requests. This release does not provide a zero-network replica and does not
claim pixel parity.

## Troubleshooting

- **Chrome says the manifest is missing:** choose `dist/chrome-unpacked` itself,
  not the repository root or its parent.
- **The icon does not work on the current page:** try a normal HTTP(S) page.
  Chrome does not allow extensions to run on every internal or protected URL.
- **A language pair is unavailable:** update Chrome and confirm its on-device
  Translator can prepare that pair.
- **Automatic translation paused after navigation:** temporary `activeTab`
  access does not transfer between sites. Select Simul on the new site or grant
  the intended site/all-sites scope explicitly.
- **Image text is unchanged:** turn on OCR, grant access when requested, keep
  the image visible, choose a supported source route, and remember that small
  images are skipped by default.
- **The replica is visibly stale:** select **Rebuild mirror**. Some closed-root,
  opaque resource, CSSOM, and script-only changes cannot be observed safely.
- **The updated build still looks old:** reload Simul at
  `chrome://extensions`, then reload the source tab and reopen the companion.
- **More detail is needed:** expand **OCR diagnostics** or inspect
  `[Simul isolated mirror]`, `[Simul fidelity resources]`, and `[Simul scroll]`
  console entries. They contain bounded stages and counts, never source content.

## Development

Prerequisites are Node.js 24 LTS and npm 12. Install the locked dependencies:

```sh
npm ci
```

Then use the repository scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the WXT development runner. |
| `npm run typecheck` | Type-check source and tests. |
| `npm test` | Run the Vitest suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run build` | Create a Chrome build under `.output/`. |
| `npm run artifact:check` | Produce a guarded temporary release build and compare it with the committed artifact. |
| `npm run artifact:sync` | Refresh `dist/chrome-unpacked/` from a validated release build. |
| `npm run zip` | Create WXT's Chrome distribution archive. |
| `npm run check` | Run typechecking, the full test suite, and the non-mutating artifact integrity check. |

Do not edit `dist/chrome-unpacked` by hand. Change source, run `npm run check`,
then use `npm run artifact:sync` only when the ready-to-load build must be
refreshed.

Long-lived technical detail lives in [docs](docs/); BMAD Method planning and
implementation artifacts live in [_bmad-output](_bmad-output/).

## License and third-party notices

Original Simul material is open source under the standard
[MIT License](LICENSE). Anyone may use, copy, modify, merge, publish,
distribute, sublicense, or sell copies subject to the license's notice and
permission-text requirement.

Bundled libraries, OCR runtime code, language models, and repository tooling
retain their own terms. The complete production and source-distribution
inventory and required notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with full OCR and
compiled-core texts under `vendor/ocr/tesseract/licenses/`. The same project
license and extension-runtime notice inventory are packaged inside the
ready-to-load extension.

## Release status and hackathon readiness

Simul 0.3.2 is a **hackathon release candidate**. The repository includes:

- the complete TypeScript source and BMAD Method artifacts;
- a checked-in, directly installable Chrome artifact;
- locally packaged OCR runtime/model assets and third-party notices;
- automated type, unit, build-profile, privacy-boundary, artifact-integrity,
  and size checks; and
- detailed fidelity, privacy, OCR, and browser-boundary documentation.

It is ready for direct Developer Mode evaluation and a local hackathon demo. It
is not presented as a Chrome Web Store release, an auto-updating distribution,
or a guarantee of compatibility with every site. For a reliable demo, use
Chrome 138 or newer, allow Chrome to prepare the selected on-device translation
pair, and preload OCR only if image translation will be shown.
