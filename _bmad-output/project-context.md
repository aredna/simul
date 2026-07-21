---
project_name: Simul
project_type: chrome-extension
planning_track: quick-flow
status: release-candidate-privacy-ux-hardening
---

# Simul Project Context

## Current product state

The repository contains a content-first live translation companion. A user can
open a read-only active-page replica in Chrome's native side panel or a detached
extension window, translate Chrome-supported language pairs locally, follow
bounded DOM/style/image/document-or-nested-scroll changes, zoom the replica,
and compose a reverse translation. A compact quick-translation panel reverses
the active page pair without opening settings, while a pointer-inert toolbar
background reports determinate translation progress or indeterminate capture,
live-update, permission, OCR, composer, and surface-transition work. Common
options precede window behavior and the collapsed experimental engine/OCR
controls. The canonical production engine is isolated HTML with
revision-safe text projection. Its exact-document bridge assigns private
WeakMap IDs, reads changed DOM directly into a bounded allowlisted graph, and
sends a sanitized checkpoint plus contiguous targeted patches. The
extension validates the graph again and creates real nodes with DOM APIs inside
a `sandbox="allow-same-origin"` iframe whose CSP disables scripts, workers,
connections, frames, objects, forms, and navigation. Gaps or overflow stage one
fresh checkpoint and atomically replace the last-good view. rrweb remains a
persisted experimental choice unless `WXT_SIMUL_RRWEB_SHADOW=0` hides it. The
legacy renderer is the emergency fallback; neither engine silently falls back
to the other.

Direct-child mutations use a final-order reconciliation payload. A receiver
retains a referenced object only when it already owns that exact ID as a direct
child of the same target; new content remains a sanitized graph. The source
derives references from ordered emitted state, including unacknowledged
batches. Covered dirty descendants, privacy transitions, cross-parent churn,
or missing proof keep the existing full-child/checkpoint fallback. The receiver
preflights and stages the whole batch, preserves Simul-owned style nodes, and
rolls back DOM/maps/dimensions before requesting recovery on commit failure.

The isolated graph carries a boolean only for the canonical clipped 1px
screen-reader pattern and a sanitized selected `currentSrc` for responsive
images; it never transports arbitrary computed styles. A staged checkpoint
waits for stylesheet load/error outcomes, two paints, or a 300 ms deadline
before replacing the last-good view. Content-free mirror diagnostics expose
aggregate shadow-root, adopted-style, hidden-label, selected-source, and
stylesheet outcome counts.

CSS capture preserves safely readable inline declarations, style elements,
passive linked stylesheets, constructed/adopted document and open-shadow
sheets, custom properties, media and pseudo-element rules, SVG presentation,
and bounded same-document CSS `url(#fragment)` effects in cascade order.
Imports, scriptable or legacy behavior, invalid resources, and external SVG
references remain sanitized. The bounded computed source canvas color travels
with checkpoints and live dimension patches and is applied across every
presentation-shell layer; transparent updates clear the override.

Native and ARIA activation labels remain translatable. Isolated HTML also reads
only a nonempty current value or otherwise the placeholder from native
`input` types missing/`text`/`search`/`email`/`url`/`tel` and `textarea`.
That text crosses the bounded protocol only as discriminated control metadata,
never as raw `value`/`placeholder` attributes, and stays memory-only and
content-free in logs. Password/password-autocomplete fields, unsupported
controls, selects/options, contenteditable regions, and ARIA textbox fallbacks
remain blank; a safe-to-sensitive transition clears its record and projection
atomically. rrweb continues masking every editable/value-bearing control.
Passive image validation admits a narrow, shape-only URL-encoded SVG data-image
profile (including the YC logo) with the same checks on capture and receipt. A
persisted `Live source only` mode uses the identical isolated DOM/patch stream,
restores source text in place, clears OCR overlays, and blocks stale text/image
projections without recapture.

Capture ACKs never wait for translation. Document, source revision,
translation epoch, pair, replay lease, and node type must match before text
projection commits. Same-language and pair changes restore source text without
recapture, matching projections reconcile before same-document recovery, and
source viewport geometry remains independent of fit/custom zoom. Translation
memory is bounded and keyed by provider, exact language pair, and exact source
string—never node or document. Identical live-update work joins or reuses one
provider result, while exact-document/revision/epoch/lease checks remain at the
projection boundary. Mexico City and Reddit fidelity gaps are documented
follow-ups; Checkpoint F's approved Choice C did not claim those sites were
fixed.

Source scroll transport coalesces at most once per animation frame. It reads
the standards/body document fallbacks first and may adopt a visible,
viewport-scale nested element with meaningful, user-scrollable vertical
overflow, including inside an observed open shadow root. Textareas, inputs,
editable/ARIA control ancestry, hidden or visible non-scroll containers, small
carousels, and horizontal strips cannot drive synchronization. The replica
finds the corresponding generic nested surface and projects normalized
progress, retaining nested rather than document bounds across extent refresh;
document movement takes ownership immediately, and a removed, non-scrollable,
or shrunken nested owner is cleared or clamped. No hostname-specific scroll
branch is permitted. Isolated HTML also carries a bounded computed canvas-color
fallback and allows only same-document fragment references for inline SVG
`<use>` while retaining canonical SVG attribute case.

Image translation is implemented as an initially-off persisted option. The
source frame observes ordinary top-level `<img>` elements by the selected
engine's node ID while keeping URLs and text private. A capacity-one scheduler applies the saved
visible/background policy and small-image filter. Stable visible pixels are
captured through `captureVisibleTab()` at no more than twice per second, cropped
and proportionally downscaled to no more than 4 MP after exact pre/post geometry
checks, SHA-256 keyed, and handed to a
restartable offscreen host through two-minute extension-origin transient
storage. Tesseract.js/core 7.0.0, three embedded Wasm core loaders, its Worker,
and 22 pinned `tessdata_fast` files are local. One routed language group is
loaded at a time and disposed after a group change or 90 seconds idle.

Reliable image capture after the temporary `activeTab` grant expires uses a
literal `<all_urls>` optional host grant shared with all-sites automatic
translation. Chrome requests it only from an explicit user gesture. Saved OCR
intent remains paused and actionable when the grant is absent or revoked; no
startup prompt or capture retry loop is allowed.

Recognition remains in a memory-only cache bounded by 128 entries and an
aggregate result-weight budget, separate from the bounded page-text and
image-line translation memories. Page-text and image-line
translation keys contain only provider, exact language pair, and exact source
string. Image-recognition keys contain ordered provider/runtime/model route,
source language, preprocessing profile, processed dimensions, and cropped-pixel
hash—not node, document, URL, replay identity, or target language. Matching
in-flight text or recognition work joins one provider load; completed content
remains reusable across live source refreshes while the companion stays open.
Recognition retention is bounded by both entry count and aggregate
transcript/region weight; an oversized result serves its current job without
entering memory.
The same image URL reuses OCR only when its processed pixels and geometry inputs
match, preserving correct overlays across responsive sizes, crops, and animated
frames. An unchanged empty result requires two OCR passes before it is cached;
changing blank pixels defer, and a transient capture failure receives one
immediate retry.
Raw screenshot blobs remain transient and are removed after offscreen handoff.
Nearest valid element `lang`, explicit From, then detected page language selects
the OCR group. An explicit same-language pair stops before capture; an
auto-detected same-language image stops before recognition. Stable shallow
banners are classified from CSS geometry so
device pixel ratio cannot change OCR mode; low-resolution crops are
conservatively upscaled 2x inside the existing 4 MP/per-axis limits. The
versioned profile selects Tesseract's single-line segmentation and restores the
normal block mode afterward. Overlay
coordinates still map through the original CSS crop. Inert line overlays commit
only when document, content revision, pixel hash, replay lease, pair epoch,
replica image, and geometry remain current; they follow replay scroll/zoom
without resizing the image. Overlay text wraps and uses bounded font reduction
inside its recognized box. A same-ID replica image replacement on
the same replay lease rebinds the existing overlay. Provider-neutral quality
filtering removes blank, punctuation-only, and supplied-confidence-below-0.25
regions while accepting providers that omit confidence. Disabled builds omit the host, OCR
assets, permission, and CSP. The canonical build adds required `offscreen`, the
optional user-granted all-sites capture match, and the exact local Wasm/Worker
CSP, validates every runtime hash/notice offline, and remains under 42 MiB
unpacked.

Translation and OCR depend on an engine-neutral selected-surface router.
Content-free `console.info` diagnostics report mirror connection/checkpoint/
patch/recovery counts, aggregate isolated-patch kinds/replacement sizes,
retained/inserted/moved/removed counts, bounded representability omissions,
and custom-host/open-root risk counts,
bounded content-free translation-cache hit/miss/join/load counters, and every
OCR discovery, skip, capture, recognition, quality-filter, translation, or
projection stage through an ephemeral job ordinal and safe dimensions without
text, URLs, pixels, hashes, or IDs. Settings and the slim full-width toolbar
share one guarded manual rebuild action. The toolbar keeps Refresh, the From
label, `[A]` Auto-detect immediately before its wider selector, swap, the wider
To selector, size, OCR, Current/Active following, quick translation, Settings,
Side/Popout, and the replica state in one ordered row. Healthy state shows no
detached dot; warning/error markers attach to Refresh or Settings, whichever
can resolve the condition. Visible toolbar and Settings labels are translated
as one atomic target-language set using the existing exact-content memory.
English is immediate and remains complete if local UI-label translation is
unavailable or any member fails. Quick-translation drafts/results and toolbar
activity stay local to the current companion and are never persisted.

Fidelity remains explicitly bounded: closed shadow roots are inaccessible;
cross-origin stylesheet links can render while their CSSOM remains unreadable;
generated pseudo-element text is not translatable; no-script custom elements
cannot recreate state produced only by website JavaScript; and pure CSSOM
mutations without a DOM, resource, resize, focus, or load signal can require a
rebuild. The deferred Strict Local Mirror spike, rather than this release, owns
a guarantee that the replica makes no additional origin requests.

## Fixed engineering baseline

- Chrome Manifest V3 extension built with WXT and strict TypeScript.
- Node.js 24 LTS and npm with a committed lockfile.
- Vanilla HTML, CSS, and TypeScript until a documented UX need justifies a UI
  framework.
- Production permissions stay at the documented minimum. `offscreen` is the
  only required OCR permission addition. The all-sites capture match remains
  optional, explicitly granted, shared by its two owners, and revoked after
  both owners release it; every host match remains optional and user-scoped.
- No remotely hosted executable code and no secrets in extension bundles.
- Background and popup entrypoints stay thin; testable domain logic lives in
  `lib/`.

## Quality gates

Every implementation change must pass:

```sh
npm run typecheck
npm test
npm run build
npm run artifact:check
```

`npm run check` runs typechecking, tests, and the non-mutating artifact check;
that check performs the production build in a temporary directory. Add focused
unit tests for pure logic and browser-level tests when behavior depends on
extension APIs or page integration.

## Source layout

- `entrypoints/background.ts`: Manifest V3 service worker entrypoint
- `entrypoints/popup/`: active-page side-panel launcher
- `entrypoints/sidepanel/`: translation companion UI and browser orchestration
- `lib/companion-ui-state.ts`: pure overlay, reverse-pair, and toolbar-progress
  state derivation
- `lib/companion-ui-localization.ts`: atomic target-language label sets and
  action-specific toolbar attention routing
- `entrypoints/page-snapshot.ts`: unlisted top-frame snapshot entrypoint
- `entrypoints/page-recorder.ts`: unlisted rrweb checkpoint, live recorder,
  and exact-document image-source bridge
- `entrypoints/page-mirror.ts`: unlisted isolated-HTML observer and shared
  WeakMap image-identity bridge
- `lib/replica/html-mirror-protocol.ts`, `html-mirror-sanitizer.ts`, and
  `html-mirror-source.ts`: typed bounded transport, dual validation, private
  masking, passive visual-resource policy, ACKs, and recovery
- `lib/replica/isolated-html-engine.ts`: no-script real-DOM construction,
  incremental patches, translation/image anchors, and atomic last-good swaps
- `lib/replica/replica-surface-router.ts`: selected-engine translation and OCR
  routing
- `entrypoints/offscreen/`: static local Tesseract compute host
- `lib/replica/visible-replay-host.ts`: candidate/committed
  replay ownership, atomic presentation, protected iframe layout, zoom, and
  scroll projection
- `lib/replica/live-protocol.ts`, `lib/replica/live-recorder-session.ts`, and
  `lib/replica/live-stream-client.ts`: bounded ordered transport, shared recorder
  ownership, independent subscriber watermarks, and recovery requests
- `lib/replica/rrweb-stream-sanitizer.ts`: transactional incremental privacy,
  identity, and resource validation
- `lib/replica/source-value-model.ts`: transactional canonical rrweb text,
  monotonic revisions/tombstones, and committed text-change records
- `lib/translation/`: bounded exact-source memory and the single-session,
  revision/epoch/lease-safe engine-neutral translation coordinator
- `lib/primary-scroll.ts`: generic document/nested primary-scroll
  classification, bounds, and normalized source snapshots
- `lib/ocr/`: exact-document image observation, capture/currentness,
  capacity-one scheduling, transient host coordination, Tesseract routing,
  content-keyed joined recognition cache, conservative result quality, and
  inert overlay projection
- `tools/ocr-build-profile.ts`: strict compile-profile flags; Tesseract is the
  default implemented provider and every other enabled provider fails build
- `vendor/ocr/`: immutable Tesseract runtime/model assets, hashes, and notices
- `lib/`: safe bootstrap/delta boundaries, inert renderer, preferences,
  provider adapter, translation pipeline logic, and replica-engine adapters
- `tests/`: unit tests
- `tools/extension-artifact.mjs`: guarded release build, validation, sync, and
  byte comparison
- `dist/chrome-unpacked/`: canonical checked-in Chrome installation directory
- `docs/`: durable project knowledge
- `_bmad-output/`: BMAD planning and implementation artifacts

## Decision rules

1. Prefer the smallest implementation that satisfies approved acceptance
   criteria.
2. Keep browser permissions least-privileged and explain additions in the BMAD
   spec or story.
3. Keep WXT and generated BMAD files within their documented extension points.
4. Update this file when architecture or engineering conventions change.
5. Never edit `dist/chrome-unpacked/` by hand; refresh it only with `npm run
   artifact:sync` after the temporary build passes release validation.
6. OCR providers must consume the stable E contracts and compile registry;
   adding a provider never weakens exact-document currency, descriptor privacy,
   bounded scheduling, saved-order preservation, or current-revision override.
7. OCR runtime code, models, and notices must be local, exactly pinned, hash
   validated, and absent from a compiled-out provider profile.
8. Modern Reddit is evidence for generic web-component and high-churn mirror
   behavior, never a hostname-specific implementation branch. Its server HTML
   depends on Lit custom-element definitions and partial loaders. Stable
   same-parent children are reconciled by receiver-proven identity; custom
   definitions, inaccessible roots, script-only state, and cross-parent
   identity reuse remain separately reviewable work.
