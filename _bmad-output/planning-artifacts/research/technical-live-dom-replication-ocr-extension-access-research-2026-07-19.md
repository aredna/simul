---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments: []
workflowType: 'research'
lastStep: 6
research_type: 'technical'
research_topic: 'Live DOM replication, incremental translation, modular local OCR overlays, visibility scheduling, and Chrome extension access'
research_goals: 'Choose the highest-fidelity safe page-copy architecture; translate supported languages automatically when ready; reuse translated phrases; update only changed content; improve host access; design independently compiled, user-ordered TextDetector, Tesseract, Transformers.js, PaddleOCR-Wasm, and future Screen AI providers in offscreen workers; schedule OCR by visibility; and diagnose the Mexico City and Reddit fidelity cases.'
user_name: 'Builder'
date: '2026-07-19'
web_research_enabled: true
source_verification: true
---

# Research Report: Technical

**Date:** 2026-07-19
**Author:** Builder
**Research Type:** Technical

---

## Research Overview

This research evaluates how Simul can reproduce an authorized live website with
high visual fidelity while leaving the source untouched, translating only
revision-current content, applying incremental DOM/CSS/state changes, and
preserving strict privacy and Manifest V3 boundaries. It covers replica
architecture, translation lifecycle and caching, access across navigation,
popout behavior, scroll/zoom fidelity, image OCR overlays, and local inference.

The selected direction is a script-inert, source-sized rrweb replica backed by
an ordered event stream rather than periodic snapshots. Image translation uses
five stable, independently compiled provider IDs with user-controlled priority,
three IntersectionObserver scheduling policies, a conservative small-image
filter, and restartable offscreen-owned Workers. Tesseract is the dependable
baseline; TextDetector is opportunistic; Transformers.js and PaddleOCR-Wasm are
prototype-gated; Chromium Screen AI remains compiled out until Chrome exposes a
supported public API. See **Research Synthesis and Strategic Technical
Conclusions** for the executive summary and consolidated implementation roadmap.

---

## Technical Research Scope Confirmation

**Research Topic:** Live DOM replication, incremental translation, modular local OCR overlays, visibility scheduling, and Chrome extension access
**Research Goals:** Choose the highest-fidelity safe page-copy architecture; translate supported languages automatically when ready; reuse translated phrases; update only changed content; improve host access; design independently compiled, user-ordered TextDetector, Tesseract, Transformers.js, PaddleOCR-Wasm, and future Screen AI providers in offscreen workers; schedule OCR by visibility; and diagnose the Mexico City and Reddit fidelity cases.

**Technical Research Scope:**

- Architecture Analysis - design patterns, frameworks, system architecture
- Implementation Approaches - development methodologies, coding patterns
- Technology Stack - languages, frameworks, tools, platforms
- Integration Patterns - APIs, protocols, interoperability
- Performance Considerations - scalability, optimization, patterns

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights

**Scope Confirmed:** 2026-07-19

## Technology Stack Analysis

### Programming Languages and Runtime Boundaries

Simul should keep **TypeScript** as the primary language across the service
worker, page-capture bridge, side-panel controller, replica renderer, and test
suite. The existing Node 24, WXT, Manifest V3, and strict TypeScript baseline is
well suited to a small extension and does not need a framework rewrite.

The implementation has five deliberately different runtime boundaries:

1. An isolated content-script world observes the authorized source document and
   transports validated, serializable events.
2. A visible extension page controls translation, storage, image policy, and UI.
3. A same-extension, sandboxed iframe rebuilds the inert replica without
   executing site scripts.
4. A static offscreen extension document owns the restartable OCR queue and
   communicates only through `chrome.runtime`.
5. Dedicated module Workers isolate compiled Tesseract, Transformers, and
   PaddleOCR inference from every Window event loop.

Chrome exposes both `ISOLATED` and `MAIN` execution worlds. Most capture logic
should remain isolated; narrowly scoped main-world hooks are justified only for
browser state that a `MutationObserver` cannot see, such as CSSOM and
constructable stylesheet mutations. Page-derived messages must always be
treated as untrusted input. ([Chrome content-script worlds](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts),
[Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting))

**WebAssembly** is appropriate only behind the OCR boundary. Tesseract.js uses
a Wasm Tesseract core; Transformers.js and PaddleOCR.js use ONNX Runtime Web,
with Paddle also using OpenCV.js. All enabled Worker, runtime, graph/model, and
language assets must be selected by the compile profile and packaged rather
than loaded from a CDN.
Manifest V3 forbids remotely hosted executable code, and extension CSP may
need the narrowly scoped `wasm-unsafe-eval` source for the packaged module.
([Manifest V3 remote-code policy](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code),
[extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy),
[Tesseract.js local installation](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md))

**Confidence:** High.

### Frameworks and Libraries

#### Extension framework and platform APIs

- **WXT and Chrome Manifest V3:** retain the existing WXT build and entrypoint
  structure. The required platform APIs already align with the product:
  `sidePanel`, `scripting`, `activeTab`, `storage`, `offscreen`, and
  runtime-requested host permissions. The offscreen permission is justified by
  the local OCR Worker host. No remotely executed library or cloud runtime is
  needed.
- **Chrome Translator API:** remain the first translation provider. It is local,
  private, and supports BCP 47 language tags including Spanish, English, and
  Japanese on supported Chrome desktop installations. Availability must be
  checked per pair. A pair reported as `downloadable` can require a trusted user
  gesture for `Translator.create()` because Chrome intentionally masks
  pair-specific download state. Once a pair is `available`, automatic page
  translation can proceed without another click. ([Translator API](https://developer.chrome.com/docs/ai/translator-api),
  [built-in AI model-download guidance](https://developer.chrome.com/docs/ai/inform-users-of-model-download))

The language-select change event itself is a suitable gesture from which to
prepare one selected pair immediately. Simul should show download progress and
retain that translator session while the pair remains active. It should not
promise completely unattended first-time translation for a model Chrome has
not yet made available; the platform intentionally prevents that.

#### Capture and replica engine

The current custom sanitizer and dirty-subtree replacement protocol should move
toward an **rrweb-style full snapshot plus ordered incremental-event model**.
`rrweb-snapshot` already supplies serializable nodes, stable mirror IDs,
resource URL normalization, state capture, and script disabling; rrweb's
recorder adds incremental DOM, input, scroll, stylesheet, shadow-root, media,
and related events. Its current rebuild guidance uses a sandboxed iframe, which
matches Simul's trust boundary. ([rrweb-snapshot](https://github.com/rrweb-io/rrweb/tree/main/packages/rrweb-snapshot),
[rrweb architecture](https://github.com/rrweb-io/rrweb#project-structure),
[rrweb changelog](https://github.com/rrweb-io/rrweb/blob/main/packages/rrweb/CHANGELOG.md))

The recommended implementation decision is a short, pinned rrweb 2.1.x spike
before replacing the existing protocol wholesale. If its replay layer is too
large or opinionated, Simul should still adopt its `Mirror`, stable-ID schema,
and ordered observer design while implementing only the event types it needs.
`morphdom` may help reconcile a bounded subtree, but it does not capture
arbitrary pages or provide an event protocol. Google Incremental DOM is a
template compilation target, not a capture/replay system, so it is not a fit.
([morphdom](https://github.com/patrick-steele-idem/morphdom),
[Incremental DOM](https://github.com/google/incremental-dom))

The replica belongs in a same-extension iframe with a **source-sized virtual
viewport** and `allow-same-origin` but no `allow-scripts`. The side panel scales
that viewport for fit-width mode rather than allowing the page to reflow to the
narrow panel width. Preserving the original viewport is essential for media
queries, container queries, fixed/sticky elements, line wrapping, and the
Reddit navigation rails.

This design cannot make every browser surface identical. `cloneNode()` does not
copy a canvas bitmap or ordinary event listeners, shadow roots are not generally
cloned, cross-origin frames need access to their own origins, and protected
media cannot safely be reconstructed. Chrome's `dom.openOrClosedShadowRoot()`
can improve custom-element capture—including likely Reddit/Shreddit gaps—when
the extension has access to the page. ([DOM cloning](https://dom.spec.whatwg.org/#concept-node-clone),
[Chrome DOM API](https://developer.chrome.com/docs/extensions/reference/api/dom),
[ShadowRoot clonability](https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot/clonable))

An actual duplicated site tab moved into a popup window is the only practical
mode that retains the site's own runtime, CSS, custom elements, and network
behavior. Chrome exposes `tabs.duplicate()` and
`windows.create({tabId, type: "popup"})` for this. It should remain a separately
labeled, opt-in **live page window** because it runs the site again, is not
read-only, can repeat network activity, may not preserve ephemeral state, and
requires persistent host access for reliable translation injection.
([tabs.duplicate](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-duplicate),
[windows.create](https://developer.chrome.com/docs/extensions/reference/api/windows#method-create))

**Confidence:** High for the iframe/event architecture; medium-high for direct
rrweb adoption until bundle size, sanitization, and translation interception
are proven in a spike.

#### OCR and image-translation stack

Use a normalized **five-provider local OCR chain**, with a complete user-set
priority order:

1. Chrome `TextDetector`;
2. Tesseract.js;
3. Transformers.js;
4. PaddleOCR.js using its ONNX Runtime Web Wasm backend; and
5. Chromium Screen AI.

Those numbers are the initial default only; settings persist any permutation of
all five provider IDs. At runtime, Simul walks the saved order and skips a
provider that is unavailable, unsupported for the requested language or input,
not prepared, or incapable of returning the geometry required by that job.
Providers and models are loaded lazily, so assigning five providers does not
place every engine or model in memory. Each provider is also a separate build
module behind a compile-time flag; a distribution can omit its code and assets,
not merely hide it at runtime.

Pinned **Tesseract.js 7.0.0 with locally packaged models** remains the first
dependable baseline. It runs in a Worker and returns nested block, paragraph,
line, word, and symbol data containing confidence and spatial bounds when
`blocks` output is explicitly requested. Simul can translate recognized lines
through the ordinary translation provider and render `pointer-events: none`
overlays without changing the underlying image or page geometry.
([Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md),
[Tesseract.js 7.0.0 release](https://github.com/naptha/tesseract.js/releases/tag/v7.0.0))

The initial local catalog should contain 21 user languages in 22 separate
compressed `tessdata_fast` files: English, Spanish, French, German, Portuguese,
Italian, Vietnamese, Japanese plus Japanese vertical, Korean, Simplified and
Traditional Chinese, Russian, Ukrainian, Arabic, Hebrew, Hindi, Marathi,
Bengali, Kannada, Tamil, and Telugu. At the pinned upstream revision, the
language assets are approximately **25.4 MiB** after deterministic gzip and the
complete local Tesseract runtime is approximately **36.7 MiB** before the
application bundle. Japanese vertical text requires the additional model and
`tessdata_fast` is LSTM-only. ([pinned official tessdata_fast models](https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd))

OCR must be lazy-initialized and load only the selected exact language group.
Tesseract.js v7 `reinitialize()` retains previously loaded trained data in the
worker, so a group change must terminate and recreate the worker rather than
continually reinitialize one long-lived instance. The compressed models that
are not selected remain packaged on disk, not resident in the OCR worker.
([Tesseract.js worker lifecycle](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/createWorker.js),
[Tesseract.js model loader](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/worker-script/index.js))

WXT should copy the pinned worker, core variants, and compressed trained-data
files as local public assets. Simul should pass explicit extension URLs for
`workerPath`, `corePath`, and `langPath` and set `workerBlobURL: false`; otherwise
Tesseract.js has CDN/blob loading defaults that are unsuitable for MV3. The
extension CSP should remain self-only while adding only `wasm-unsafe-eval` and
`worker-src 'self'` for these packaged assets.

Image pixels should be acquired in this order:

1. Directly from same-origin or CORS-readable image data.
2. From an extension fetch only when the user has already granted the relevant
   image-host origin.
3. From a throttled `captureVisibleTab()` image cropped to a visible source
   element, avoiding a new CDN permission request.

The screenshot fallback is viewport-only and Chrome limits capture frequency,
so OCR should be visibility-aware, deduplicated by image hash, and scheduled
after ordinary DOM translation. ([Tabs capture API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab),
[cross-origin extension requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests))

Chrome `TextDetector` is only a progressive provider. Chrome's published status
still says text detection is behind an experimental flag and recognition is not
universally available. The current WICG draft adds asynchronous language-aware
availability/creation and returns `rawValue`, `boundingBox`, and `cornerPoints`,
but it is a draft rather than a dependable cross-device Chrome capability. It
must therefore be feature-tested by doing real availability/detection work, not
only by checking that a constructor exists.
([Chrome Shape Detection status](https://developer.chrome.com/docs/capabilities/shape-detection),
[WICG Text Detection draft](https://wicg.github.io/shape-detection-api/text.html))

Transformers.js runs ONNX models locally and uses Wasm on CPU by default or
WebGPU when explicitly selected. Its OCR role must be model-specific: a TrOCR
image-to-text model can recognize a prepared single text-line crop but does not
by itself detect arbitrary scene-text boxes. It therefore needs geometry from
another detector, or it returns a transcript-only result that cannot create
spatial overlays. Simul must use a small, pinned, measured model catalog—not
Transformers.js's default arbitrary Hub download behavior—and package every
executable JavaScript, worker, and Wasm file locally.
([Transformers.js](https://huggingface.co/docs/transformers.js/main/en/index),
[Hugging Face image-to-text OCR guidance](https://huggingface.co/tasks/image-to-text),
[Transformers.js pipelines](https://huggingface.co/docs/transformers.js/main/pipelines))

For PaddleOCR, use the new official **`@paddleocr/paddleocr-js` browser SDK**, not
a hand port of the Python runtime. Version 0.4.2 exposes PP-OCRv5/PP-OCRv6
detection and recognition, line polygons, text, score, a dedicated-worker mode,
and an explicit ONNX Runtime `backend: "wasm"`. Simul must supply local
`wasmPaths`, emit the package's module Worker, and keep OpenCV.js/ONNX/Wasm
assets local. Because this browser SDK is new and its npm package is large
before models, it remains prototype-gated for MV3 CSP, build output, model
license/size, memory, and speed.
([PaddleOCR.js SDK](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js),
[PaddleOCR.js package guide](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md),
[PaddleOCR 3.5 release](https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.5.0))

Chromium Screen AI is architecturally useful but is **not currently callable
from a Chrome extension**. The linked source is browser-process C++ that creates
a profile service, downloads Chrome's Screen AI component, and communicates
through internal Mojo interfaces. Its own integration instructions require
adding a Chromium `OcrClientType`, constructing an
`OpticalCharacterRecognizer` on the Chromium UI thread, or connecting a browser
process to `ScreenAIAnnotator`; none is a Web Platform or `chrome.*` extension
API. Keep `chromium-screen-ai` as a compile-time-disabled provider adapter and
capability probe for a future public API. Do not copy the Chromium glue code or
attempt to extract Chrome's downloaded model/library into the extension. The
open Chromium tree contains native-library host glue; its Screen AI service
README says the implementation is developed internally and delivered as a
Chrome component/DLC, so there is no supported source/model package or
Emscripten target to turn into extension Wasm.
([Chromium Screen AI README](https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/screen_ai/README.md),
[Chromium Screen AI public C++ surface](https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/screen_ai/public/),
[Screen AI OCR service handler](https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/screen_ai/screen_ai_service_handler_ocr.cc),
[Screen AI service README](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/services/screen_ai/README.md))

Tesseract, Transformers.js, and PaddleOCR should run under one restartable
**offscreen compute host** instead of the side-panel UI. The bundled offscreen
HTML document is created for `WORKERS` (and `BLOBS` if object URLs are required),
owns a bounded scheduler, and spawns provider Workers. Chrome permits only one
offscreen document per extension profile and exposes only `chrome.runtime` to
it, so every job/result crosses a versioned runtime message protocol. It is not
an immortal queue: the controller must recreate it, retry at most once, and
reject stale results after a context loss. Chrome's local Prompt session remains
in the visible companion Window because Prompt is not a Worker API.
([Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
[Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api))

**Confidence:** High on Tesseract, compile-time modularity, and offscreen-worker
topology; medium on Transformers.js line recognition; medium-low on PaddleOCR.js
until an exact MV3 spike; low/experimental on production `TextDetector` reach
and Prompt geometry; high that Screen AI has no extension-callable surface now.

### Data and Storage Technologies

Use `chrome.storage.local` only for small user settings such as language pair,
automatic translation, zoom, panel state, access preference, and OCR enabled
state. Its 10 MB quota and JSON-oriented API are appropriate for preferences,
not a growing translation corpus. ([Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage))

The existing bounded in-memory LRU already avoids retranslating repeated text
while one panel/page session is alive. Add a bounded **extension-origin
IndexedDB** translation memory because the user has now explicitly requested
reuse across page changes. IndexedDB provides transactions, indexes, and larger
structured storage without the `unlimitedStorage` permission. Content scripts
must not open this cache because their IndexedDB belongs to the visited origin;
the side panel or service worker should own it. ([extension storage and IndexedDB](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies),
[IndexedDB standard](https://w3c.github.io/IndexedDB/))

Recommended translation-cache key and policy:

```text
schemaVersion + provider/engine/modelOrPromptPolicyVersion
+ preprocessingVersion + exactSourceLanguage + targetLanguage + exact source text
```

- Preserve case and meaningful whitespace; do not lowercase the source key.
- Keep the in-memory LRU in front of IndexedDB.
- Apply byte and entry limits, last-used LRU eviction, and a conservative TTL.
- Do not persist values from inputs, textareas, contenteditable regions,
  password/private controls, or the translation composer.
- Provide a visible clear-cache action and invalidate when provider semantics or
  normalization rules change.
- Store image results separately by image-content hash, detection mode,
  recognition engine, model/prompt-policy version, extraction-schema version,
  preprocessing version, language, and processing scale. Geometry is optional;
  reuse it only when produced and validated by the same spatial engine.

Chrome itself recommends bounded caching for repeated built-in-AI tasks and a
refresh path. ([Chrome built-in AI caching guidance](https://developer.chrome.com/docs/ai/built-in-ai-dos-donts#cache-results-for-repeated-tasks))

**Confidence:** High.

### Development Tools and Verification Platforms

Retain **Vitest**, **LinkeDOM**, TypeScript type checking, WXT builds, and the
checked unpacked artifact. Unit tests should cover event ordering, stable IDs,
cache eviction/invalidation, language-pair preparation, permission transitions,
OCR coordinate transforms, and translation-only text patches.

Add deterministic browser fixtures for:

- source-sized responsive layouts and fixed/sticky side rails;
- open and closed shadow roots and constructable stylesheets;
- background-image-only changes such as the Mexico City carousel;
- SPA route changes versus full same-origin and cross-origin navigation;
- input/form state, canvas/media placeholders, and nested frames;
- Spanish, horizontal Japanese, and vertical Japanese OCR samples.

The Mexico City carousel should specifically prove that an attribute/style event
patches only the affected node and schedules no translation when text hashes are
unchanged. The Reddit fixture should prove custom-element/shadow-root capture,
source viewport preservation, and fixed/sticky navigation geometry.

A connected interactive Chrome instance was unavailable during this research,
so the public Mexico City and Reddit output could be inspected but the installed
extension could not be exercised against their live, possibly personalized DOM.
That remains a separate manual acceptance check after implementation.

**Confidence:** High for automated coverage; site-specific confidence remains
medium until the live-extension check is completed.

### Deployment, Permissions, and Access Lifecycle

There is no required cloud infrastructure for this pass. Translation and OCR
remain on-device; all executable assets ship in the Chrome extension package.
This avoids API keys, external content disclosure, and cloud cost.

The current `activeTab` grant is intentionally temporary. It survives
same-origin path navigation but is revoked on cross-origin navigation or tab
close. A one-shot `scripting.executeScript()` bridge also disappears when its
document unloads, even if the next page is same-origin. Simul must distinguish
these cases:

- Reinject idempotently for every new document/document ID when access remains.
- For unattended operation, request the already-declared optional **This site**
  or **All sites** host permission and re-check `permissions.contains()` because
  the user or administrator may later revoke it.
- Explain that a site grant matches only that origin; a new domain requires its
  own grant unless All sites was chosen.

([activeTab lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab),
[Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions),
[content-script lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts),
[webNavigation document lifecycle](https://developer.chrome.com/docs/extensions/reference/api/webNavigation))

This is why a new domain can report that Simul lacks read access while an
extension configured with persistent broad host access appears to work
everywhere. It is platform permission behavior, not random loss of DOM access.

**Confidence:** High.

### Technology Adoption and Direction

The most durable direction is a hybrid with explicit fidelity/safety tradeoffs:

- **Default inert companion:** local sandboxed replica, stable IDs, operation-
  level updates, source-sized viewport, on-device text translation, and optional
  local OCR overlays.
- **Optional live page window:** duplicated real site tab for the highest runtime
  fidelity, clearly marked as interactive and requiring persistent site access.
- **No remote-site iframe:** arbitrary sites can block framing with
  `frame-ancestors` or X-Frame-Options, and same-origin policy prevents Simul
  from safely replacing their DOM text from an extension parent.

([CSP `frame-ancestors`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors),
[X-Frame-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options),
[same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy))

For the default mode, operation-level patches—not periodic static snapshots—are
the pivotal change. Each stream should carry an epoch, document/frame identity,
and monotonically increasing sequence. It should batch ordered add/move/remove,
attribute, text, scroll, form-state, shadow, stylesheet, and media operations;
detect gaps; and request a full checkpoint only on navigation or desynchronization.
Chrome messages are JSON-serialized and capped per message, so large initial
snapshots require chunking and backpressure. ([Chrome message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging))

This structure directly addresses the reported behavior: a rotating background
image produces one style/attribute patch and no text translation; a changed text
node translates only its new value; a Spanish language selection prepares that
pair from the selection gesture and begins automatic translation as soon as the
model is available; and cross-origin navigation either uses a stored optional
grant or presents a precise access request.

### Stack Recommendation Summary

| Concern | Recommended technology | Decision confidence |
|---|---|---:|
| Extension application | TypeScript + WXT + Chrome Manifest V3 | High |
| Default replica | Sandboxed same-extension iframe, source-sized viewport | High |
| Capture/update protocol | rrweb 2.1.x spike; stable-ID ordered incremental events | Medium-high |
| Text translation | Chrome Translator API with explicit model-preparation UX | High |
| Session reuse | Existing in-memory LRU | High |
| Persistent reuse | Bounded IndexedDB translation/OCR caches | High |
| Image text | Five known ordered modules: TextDetector, Tesseract.js, Transformers.js, PaddleOCR.js-Wasm, future Screen AI; optional Prompt sidecar | High Tesseract / prototype-gated others |
| Image scheduling | Source-owned IntersectionObserver with visible-only, idle-prescan, or eager-all policy | High |
| Image compute | Restartable offscreen document hosting bounded provider Workers | High topology / provider spikes required |
| Exact-runtime option | Duplicated tab moved to popup window | Medium-high |
| Settings | `chrome.storage.local` | High |
| Cloud services | No Simul backend; browser-managed local Chrome AI downloads allowed | High |

## Integration Patterns Analysis

### Research Coverage and Applicability

The relevant integrations are all local browser boundaries: the source page,
an isolated content script, an extension controller page, an inert replica,
Chrome's Translator and Language Detector APIs, an offscreen OCR compute host,
compile-selected local provider Workers, an optional Window-owned Chrome Prompt
image session, extension-origin storage, and an optional duplicated live tab.
Chromium Screen AI is researched as a future adapter but has no stock-extension
integration boundary. REST, GraphQL, gRPC, message brokers, service meshes,
sagas, and other microservice patterns add no value to this single-user,
single-device extension and are intentionally excluded.

The current extension uses one-shot `runtime.sendMessage()` notifications and
then calls `scripting.executeScript()` to pull each dirty subtree. That is a
sound bounded MVP, but it couples capture granularity to subtree reconstruction
and broadcasts page events to every listening extension page. The next
integration should use a direct session Port and a versioned operation stream.

**Research coverage:** Chrome messaging, scripting, navigation and permission
lifecycle; rrweb capture/replay semantics; Translator scheduling; IndexedDB
cache ownership; visible-tab capture; five-provider OCR policy,
offscreen/Worker lifecycle, Prompt sidecar integration; and iframe
sandbox boundaries. **Overall confidence:** High, with medium confidence on the
exact rrweb adapter until the proposed spike measures bundle size and fidelity.

### API Design Patterns

#### Typed internal protocol rather than a public web API

Simul should expose no network API in this pass. Its API surface is a closed,
versioned set of TypeScript discriminated unions. Commands travel from the
trusted controller to the page bridge; facts and events travel back. All
payloads are parsed at the receiving boundary instead of cast with `as`.

Recommended command/event families:

- `Hello`, `StartCapture`, `StopCapture`, and `RequestCheckpoint`
- `FullSnapshotStart`, `FullSnapshotChunk`, and `FullSnapshotCommit`
- `PatchBatch`, `ViewportState`, `ScrollState`, and `PageIdentityChanged`
- `Ack`, `FlowControl`, `ProtocolError`, and `ResyncRequired`
- controller-local `TranslationJob`, `OcrJob`, and their revisioned results

Every envelope should carry `protocolVersion`, `sessionId`, `pageEpoch`,
`documentId`, `frameId`, `sequence`, and a typed payload. Chrome's scripting
result includes a document ID, so Simul can distinguish successive documents
without adding the `webNavigation` permission. ([Scripting API and
`InjectionResult.documentId`](https://developer.chrome.com/docs/extensions/reference/api/scripting))

Browser integrations should remain behind narrow adapters:

- `CaptureTransport` for Port setup, acknowledgements, and resync
- `ReplicaSink` for safe iframe reconstruction and atomic patch application
- `TranslationProvider` for availability, session creation, and translation
- `TranslationMemory` for memory/IndexedDB lookup and bounded persistence
- `OcrEngine` for worker lifecycle and spatial recognition
- `PageAccessGateway` for active-tab and optional-host permission state

This keeps Chrome globals out of domain logic and makes protocol behavior
testable without a browser.

**Confidence:** High.

### Communication Protocols

#### Direct Port for the live capture stream

The open side-panel or detached extension page should call
`tabs.connect(tabId, {documentId, name})` after idempotently installing the
capture bridge and reading `documentId` from the injection result. The returned
Port is the hot path between that specific controller and document's isolated
world. Chrome documents Ports as the reusable two-way mechanism between
extension pages and content scripts; document targeting prevents accidental
fan-out and closes same-URL reload races that URL and frame ID cannot.
([Chrome message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging))

The Manifest V3 service worker should not relay this high-volume stream or own
volatile replica state. Chrome normally stops an extension service worker after
inactivity, and merely opening a Port no longer resets that timer. The worker
should remain an event-driven coordinator for preferences, permission changes,
and launch actions. ([extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle))

Recommended handshake and stream:

```text
Source document     Isolated capture bridge     Extension controller     Inert iframe
      |                        |                          |                    |
      |<-- executeScript -----|--------------------------|                    |
      |                        |<======= named Port =====>|                    |
      |                        |---- Hello(epoch/doc) --->|                    |
      |                        |<--- StartCapture --------|                    |
      |                        |---- snapshot chunks --->|                    |
      |                        |<--- Ack / flow window ---|                    |
      |-- DOM/CSS/state event->|---- ordered patches --->|-- safe DOM write ->|
      |                        |                          |-- async translate ->|
      |                        |                          |-- async OCR ------->|
```

Chrome serializes extension messages as JSON rather than structured clone and
caps each message at 64 MiB. Simul should use JSON-safe primitives, reject
unexpected keys/types, and keep individual snapshot chunks far below that hard
limit—initially no more than **512 KiB serialized** with aggregate snapshot,
chunk-count, and assembly-time limits. Binary screenshot crops should not cross
a runtime Port as JSON. The authorized visible controller captures/crops once,
writes a bounded transient `Blob` under a random job key in extension-origin
IndexedDB, and sends only that key/revision to the offscreen host. The host reads
and immediately deletes the Blob before transferring an `ImageBitmap` to its
provider Worker; startup/TTL cleanup removes orphaned inputs after a crash.
([message serialization and
limits](https://developer.chrome.com/docs/extensions/develop/concepts/messaging),
[Tabs capture API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab))

#### Ordering, backpressure, and recovery

Mutation operations are order-sensitive. rrweb's replay design explicitly has
to defer nodes whose required neighbor has not yet been serialized, and its
checkout mechanism periodically starts a new full-snapshot chain. Simul should
reuse that proven ordering model rather than treating DOM mutations as
independent replacements. ([rrweb replay design](https://github.com/rrweb-io/rrweb/blob/master/docs/replay.md),
[rrweb checkout and capture options](https://github.com/rrweb-io/rrweb/blob/master/guide.md))

- Coalesce mutations once per animation frame while preserving their original
  dependency order.
- Permit only a small acknowledged window of uncommitted batches. When full,
  merge safe text/attribute writes by `(nodeId, field)` but never reorder
  structural add/move/remove operations.
- Acknowledge only after a batch validates and commits to the source-language
  replica; translation and OCR do not delay the acknowledgement.
- Detect any sequence gap, unknown stable ID, oversized payload, or epoch
  mismatch and request one checkpoint. Do not repeatedly retry malformed data.
- Begin a new epoch for a new document. Old-epoch translation/OCR results are
  discarded even if their asynchronous work later succeeds.
- Make disconnect and cleanup idempotent. Chrome exposes no native Port queue
  depth, delivery acknowledgement, or retransmission contract, so these are
  application responsibilities.

This protocol turns the Mexico City carousel case into one style or attribute
operation. Because its text-node revisions do not change, no text translation
is scheduled and the replica tree is not rebuilt.

**Confidence:** High.

### Data Formats and Standards

#### Capture event format

Use a compact JSON discriminated union compatible with rrweb stable IDs but
owned and validated by Simul. A representative envelope is:

```ts
interface CaptureEnvelope<TKind extends string, TPayload> {
  protocolVersion: 2;
  kind: TKind;
  sessionId: string;
  pageEpoch: number;
  documentId: string;
  frameId: number;
  sequence: number;
  payload: TPayload;
}
```

Patch payloads should cover:

- ordered node add, move, and remove operations;
- text-node and safe attribute changes with a per-node revision;
- source/style-sheet and adopted-style-sheet changes;
- form shell state without private values;
- viewport dimensions, document dimensions, scroll, media, and shadow-root
  attachment;
- image identity, rendered bounds, source revision, and optional content hash.

URLs remain fully resolved HTTPS/data-image values with explicit length and
scheme limits. Event-handler attributes, scripts, executable URLs, forms,
navigation targets, and raw unsanitized HTML are never part of the protocol.
Chrome specifically recommends avoiding `innerHTML` for untrusted content and
validating messages from content scripts. ([Chrome extension security
guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure),
[messaging security considerations](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations))

#### Translation and OCR records

Translation-memory records should contain the exact source string, normalized
BCP 47 source/target tags, provider/cache-policy version, translated text,
creation and last-used times, and byte count. Chrome does not expose a concrete
language-pack model version, so conservative TTL and a refresh control are
required. Exact text—not lowercased text—is the semantic key. A short-lived
in-flight Promise map deduplicates concurrent requests for the same key;
completed results flow through the memory LRU to IndexedDB.

Image-text records should contain image-content hash, language-detection mode,
recognition engine and policy/model version, extraction-schema version, bitmap
dimensions, preprocessing transform, transcript, and optional validated
line/word boxes. Overlay records add target-language and translation-provider
versions. This separates expensive recognition from cheaper retranslation when
the user changes only the target language and prevents geometry from one engine
being reused as if another engine produced it.

Coordinates require an explicit transform rather than assumptions about device
pixel ratio:

```text
OCR bitmap -> screenshot crop -> source visual viewport -> replica viewport -> zoomed display
```

Tesseract's `blocks` output provides nested spatial results, while only text is
enabled by default in modern releases. Simul should request only the spatial
output it uses and translate at line/paragraph granularity. ([Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md))

**Confidence:** High for formats and cache separation; medium for complex
vertical-Japanese reading order until fixture-tested.

### System Interoperability Approaches

#### Source page to capture bridge

The bridge runs in Chrome's isolated world, which shares the page DOM but not
the page's JavaScript globals. That is the default and safest observation
boundary. A narrowly scoped main-world hook may report CSSOM API calls that
`MutationObserver` cannot observe, but it has no privileged actions and its
messages are treated only as bounded dirty hints because the host page can
interfere with main-world code. ([content-script execution worlds](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts))

Initial installation returns the injection `documentId`; subsequent capture
events must match the followed tab, top frame, session, and document. Any later
`executeScript()` snapshot or cleanup call should target
`documentIds: [documentId]`, not merely frame 0, and verify the returned ID. Open and
closed shadow roots can be traversed through Chrome's DOM API where supported,
while inaccessible cross-origin frames remain explicit placeholders unless the
user grants each required origin.

#### Controller to inert replica

The replica iframe is a normal same-extension child with the HTML `sandbox`
attribute set to `allow-same-origin` and without `allow-scripts`, forms,
popups, or top navigation. A same-origin parent can still access and manipulate
that iframe's DOM when child scripts are disabled. Therefore no child-side
message bridge or site script is needed: the trusted parent renderer creates
and patches nodes through DOM APIs. ([iframe sandbox behavior](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe))

This is not a manifest `sandbox.pages` page; those pages use a unique origin
and cannot be given `allow-same-origin`. Simul does not need their relaxed
script policy. ([Chrome extension sandbox pages](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox))

The sandbox stops script execution; it is not a network air gap. Passive
`img`, `srcset`, font, stylesheet, CSS `url()`, and `@import` references can
still issue requests. The validator/resource broker must therefore neutralize,
proxy, cache, or explicitly allow each resource class and must strip nested
frames, objects, embeds, forms, meta refresh, and navigation-capable elements.

The iframe uses the captured source viewport width/height. Fit-width and zoom
transform the iframe's outer visual surface, preserving the original internal
layout and enabling a real horizontal scrollbar in one-to-one mode.

#### Translation provider integration

Chrome processes Translator requests sequentially, so Simul should maintain one
bounded FIFO per active language pair and one retained Translator session. DOM
capture continues while translation runs. Each source text node carries a
revision; a translated result commits only if node revision, page epoch, and
translation epoch still match. ([Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api))

Translator is a secure-`Window` API rather than a Worker API, so session
creation and translation stay in the visible extension controller. Heavy OCR
runs in provider Workers owned by the offscreen compute host; optional Prompt
image analysis also stays in the visible extension Window because Prompt is not
available in Web Workers.
Session-lifetime cancellation and per-translation
job cancellation should be separate because aborting the creation signal after
creation destroys that Translator. ([Chrome built-in API context support](https://developer.chrome.com/docs/ai/built-in-apis))

Language selection should follow this sequence:

1. Increment `translationEpoch`, abort/discard previous-pair work, and keep the
   current replica.
2. In the language-select trusted event handler, call availability and, when
   `navigator.userActivation.isActive`, call `Translator.create()` before
   awaiting unrelated work. If Chrome does not grant transient activation for
   that control interaction, expose one precise **Prepare translation** click
   rather than silently doing nothing.
3. Show model download progress. When ready, traverse current text-node records
   and translate them—do not recapture the webpage.
4. Translate later text revisions automatically through the same queue.
5. When source and target resolve to the same language, retain the source text
   and schedule no provider work.

Chrome intentionally reports untried language pairs as downloadable to protect
privacy, and first creation may need user activation. This explains the
reported Spanish behavior; the language-change gesture can prepare the chosen
pair, but Chrome does not permit Simul to promise a silent first-time model
download. ([Translator availability and download semantics](https://developer.chrome.com/docs/ai/translator-api),
[model-download UX guidance](https://developer.chrome.com/docs/ai/inform-users-of-model-download))

#### Image analysis and overlay integration

Image analysis is a derived, policy-driven pipeline:

1. A source-frame `ImageVisibilityScheduler` observes stable image candidates,
   applies the optional conservative small-image filter, and supplies node ID,
   image/pixel revision, bounds, and `visible`, `near`, or `background` tier.
   Visible-only, visible-first background-prescan, and eager-all differ only in
   when an eligible descriptor enters the same bounded queue.
2. When a queued item is eligible for capture, the controller reads pre-capture
   document/viewport/scroll/bounds metrics, revalidates the followed active tab,
   and captures at no more than Chrome's documented two calls per second.
   Detached mode explicitly supplies the original source window ID rather than
   capturing its own popup.
3. It derives scale from actual screenshot and viewport dimensions, crops the
   image, then rereads metrics. Any identity, viewport, scroll, scale, or bounds
   change discards the crop. A stable crop is hashed and checked against the OCR
   provider/model/policy-specific cache and stable negative cache.
4. The language route uses explicit/element/page context. If the independent
   Prompt-language preference is enabled and exact image modality is available,
   one structured Prompt result may refine the language/script hint.
5. The offscreen host filters the persisted five-provider order through the
   compiled registry and real capability probes. It lazy-loads providers one at
   a time and accepts the first normalized result passing job-specific text and
   geometry gates. Boxes-only output may feed the next recognizer; unsupported,
   failed, timed-out, empty, or invalid output falls through sequentially.
6. If Prompt text interpretation is enabled, a schema-validated sidecar may
   compare/refine a transcript, but it never reorders providers or contributes
   trusted coordinates. Prompt failure leaves the provider result unchanged.
7. Recognized lines use the ordinary translation memory/provider queue. A
   target-language change reuses OCR text/geometry without rescanning pixels.
8. Revision-checked, `pointer-events: none` overlays attach to the corresponding
   replica image without resizing it only when validated spatial geometry is
   available. Prompt-only transcripts without aligned geometry use an
   image-level result rather than guessed boxes.

If navigation, scrolling, image source, bounds, or language changes during a
job, the result is discarded. Queued jobs are cancelable; active providers that
do not support true cancellation normally finish and are ignored. An urgent
large cancellation or failed watchdog terminates and recreates that provider
Worker, settling Simul's wrapper explicitly. Provider reuse is bounded by model,
language, idle, and memory policy. ([Tesseract.js worker guidance](https://github.com/naptha/tesseract.js),
[`captureVisibleTab()` limits](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab),
[Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api),
[Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen))

Direct full-resolution image fetch is an optimization only for a same-origin,
CORS-readable, or already-authorized asset origin. Content scripts do not gain
unrestricted cross-origin fetch, and extension pages require a matching host
grant. Simul should not ask for every image CDN merely to improve OCR; viewport
capture is the privacy-preserving fallback. Consequently, background/eager jobs
for an off-viewport asset whose bytes are not readable remain pending until the
asset becomes visible and can be captured; the scheduling mode does not expand
permissions or make `captureVisibleTab()` capture outside the viewport.
([cross-origin extension requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests))

#### Optional live-page window integration

The high-fidelity live mode duplicates the source tab and moves the duplicate
into a popup/normal Chrome window, then injects translation and OCR overlays
only after confirming persistent host access for that origin. It uses no mirror
protocol because the site renders itself. It must be visually labeled as live
and interactive: duplicate execution can replay requests, analytics, media, or
other site behavior, and site code may later overwrite translated nodes.

**Confidence:** High for default-mode interoperability; medium-high for the
optional live window because preserving ephemeral application state and safely
coexisting with arbitrary frameworks remains site-dependent.

### Navigation, Access, and View Lifecycle Integration

`activeTab` grants temporary access to the invoked tab's main-frame origin. It
survives same-origin path navigation but is revoked on cross-origin navigation
or tab close. Optional host grants persist until removed or revoked. Chrome
133+ can present a tab-scoped host-access request that resets when the tab moves
to another origin while an accepted grant remains persistent for that site's
top origin. ([activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab),
[Permissions API and `addHostAccessRequest`](https://developer.chrome.com/docs/extensions/reference/api/permissions))

Recommended lifecycle rules:

- Use `tabs.onUpdated` and a new capture handshake for full navigation; this
  avoids adding `webNavigation` merely for document identity.
- Treat `history.pushState`/SPA URL changes as the same document and epoch while
  continuing incremental observation.
- On Port disconnect, retain the last good replica, mark it reconnecting, and
  reinject/reconnect if the followed document is still authorized.
- Chrome closes extension message Ports when a document enters BFCache. The
  content bridge must reconnect on `pageshow` with `event.persisted`, and the
  controller must accept the same document only after a fresh handshake.
- Handle `tabs.onReplaced` as well as removed/updated tabs because prerendering
  can replace a tab identity.
- Handle `tabs.onDetached`/`onAttached` so a followed tab moved between Chrome
  windows updates its owner binding instead of being mistaken for a new page.
- Keep an explicit `{tabId, windowId, documentId}` binding for every side-panel
  or detached controller; never infer the target from whichever tab happens to
  be active after an asynchronous operation.

([BFCache Port reconnection guidance](https://developer.chrome.com/blog/bfcache-extension-messaging-changes),
[Tabs lifecycle events](https://developer.chrome.com/docs/extensions/reference/api/tabs))

When cross-origin navigation removes access, Simul should say which origin is
now unauthorized and offer **Allow this site** or **Allow all sites**. A saved
grant is checked with `permissions.contains()` on every new document and after
`permissions.onRemoved`; no failed injection should be described as a random
DOM error.

**Confidence:** High.

### Event-Driven Integration and Incremental Consistency

The source-language replica and derived translations have different consistency
requirements:

| Lane | Commit rule | Recovery |
|---|---|---|
| DOM structure/style/state | Ordered, atomic per patch batch | Checkpoint on gap or unknown ID |
| Scroll/viewport | Latest revision wins | Drop stale samples |
| Text translation | Node + page + translation epochs must match | Keep source text on failure |
| OCR recognition | Image + viewport/page revisions must match | Drop stale result; retry when visible/stable |
| OCR translation overlay | OCR geometry + translation epoch must match | Keep image without overlay |

Structural synchronization must not wait for Chrome Translator or OCR. A cache
hit can replace source text immediately; a cache miss resolves asynchronously
and applies only if still current. This design also allows language changes to
retranslate the existing current node records without rebuilding or rereading
the source page.

Use a small status state machine rather than overlapping booleans:

```text
access -> connecting -> snapshotting -> live
                              |          |
                              +-- degraded/reconnecting

translation: idle -> preparing-model -> translating -> current/degraded
ocr:         disabled -> idle -> recognizing -> current/degraded
```

No event sourcing database or external broker is needed. The live event chain
exists only to maintain the current view; periodic checkpoints bound recovery,
and only translation/OCR cache records persist.

**Confidence:** High.

### Failure Handling and Resilience Patterns

- **Capture transport:** reconnect with bounded exponential backoff while the
  page remains authorized. One sequence gap triggers one checkpoint; repeated
  invalid payloads disable the bridge for that document and retain the last
  good replica.
- **Page churn:** coalesce repeated changes, keep only the latest scalar write,
  and preserve structural order. Cap nodes, text, attributes, CSS, depth,
  batches, and snapshot totals before allocating replica objects.
- **Translation:** maintain source text on individual failure; reuse the session
  while healthy; destroy/recreate after a provider-level failure. A model
  download failure requires a truthful retry action rather than a loop.
- **Image analysis:** serialize expensive OCR through a restartable offscreen
  scheduler and load only the first capable provider in the user's ordered
  chain. Recreate the affected Worker after a crash or language/model change,
  skip unsupported providers, and disable image analysis—not ordinary page
  translation—after repeated chain failure. Prompt remains a separately bounded
  visible-Window session.
- **Storage:** if IndexedDB is unavailable or quota-bound, fall back to the
  memory LRU. Cache failure must never block translation. Do not persist raw
  screenshots by default, and disable persistent page-content caches in
  incognito contexts.
- **Permissions:** reconcile persisted settings with actual Chrome grants and
  degrade to manual `activeTab` access rather than repeatedly attempting an
  unauthorized injection.
- **Optional live window:** if duplicate injection lacks permission, close or
  leave the duplicate untouched according to the user's explicit action; never
  manipulate the original tab as a fallback.

**Confidence:** High.

### Integration Security Patterns

The capture bridge runs beside hostile page content and must be considered
untrusted even in an isolated world. Chrome's own guidance says content-script
messages may be attacker-crafted and privileged actions must be tightly scoped.
([Chrome messaging security](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations))

Required controls:

- validate protocol version, sender tab/frame/document, session, sequence,
  discriminant, lengths, counts, URL schemes, CSS values, and node depth;
- never expose a generic fetch, tab, scripting, storage, or permission command
  to the content bridge;
- build replica nodes with `createElement`, `createTextNode`, and allowlisted
  properties—never raw `innerHTML`, `document.write`, `eval`, or site scripts;
- render into `sandbox="allow-same-origin"` without `allow-scripts`, forms,
  navigation, downloads, or popups;
- preserve MV3's self-only executable-code policy, adding only the permitted
  `wasm-unsafe-eval` and self Worker source required by packaged OCR engines;
- omit password values, input/textarea values, contenteditable text, private
  control state, and composer text from persistent translation/OCR caches;
- keep optional host requests user-initiated, narrowly explained, removable,
  and reconciled after revocation;
- keep image pixels, OCR text, and translated page content on-device in this
  pass, and store no API keys.

Chrome notes that extension storage is not encrypted and recommends minimizing
sensitive client-side persistence. This supports a bounded cache with private
regions excluded and a clear-cache control. ([Chrome user-privacy guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy),
[extension-origin storage behavior](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies))

**Confidence:** High.

### Integration Decision Summary

| Integration boundary | Selected pattern | Rejected alternative |
|---|---|---|
| Followed tab -> controller | Named direct Port + typed ordered events | Broadcast dirty notices + repeated subtree pulls |
| Controller -> replica | Parent DOM writes into script-disabled same-origin iframe | Running site code or raw HTML injection |
| Mutation consistency | Stable IDs, sequence/ack window, checkpoint recovery | Full periodic snapshot refresh |
| Translation | Revisioned async queue + memory/IndexedDB cache | Blocking capture while translating |
| Image analysis | Ordered capability-filtered local providers in an offscreen Worker host; Prompt sidecar | Cloud upload, UI-thread inference, or eager five-engine loading |
| Navigation identity | `tabs.onUpdated` + injection `documentId` + handshake | New required `webNavigation` permission |
| Background worker | Preferences/access/lifecycle coordinator | High-volume stream relay or volatile state owner |
| Highest fidelity | Explicit duplicated live tab/window | Treating the inert side-panel mirror as pixel-perfect |

## Architectural Patterns and Design

### Architectural Decision Summary

Simul should remain a **modular Manifest V3 extension**—a client-side modular
monolith—not become a collection of remote services. Within that package, use
an **event-driven capture/replay architecture** with ports-and-adapters around
Chrome, rrweb, Translator, Language Detector, Prompt, IndexedDB, Intersection
Observer, the Offscreen API, and compile-selected OCR providers.

The selected default is a UI-owned, script-inert live replica:

```text
UNTRUSTED WEBSITE / RENDERER                 TRUSTED EXTENSION ORIGIN

Source DOM
  └─ document-scoped isolated recorder <==== named Port ====> ReplicaSession
       ├─ rrweb record()                                      ├─ validator/sequencer
       ├─ stable node IDs                                     ├─ source-value model
       └─ bounded event stream                                ├─ translation projection
                                                              ├─ OCR projection
Optional MAIN-world dirty probe ----------------------------->├─ asset policy
(untrusted hints only)                                        └─ RrwebReplicaEngine
                                                                      |
                                                                      v
                                                       script-disabled iframe

EPHEMERAL CONTROL PLANE                     LOCAL DATA / COMPUTE

MV3 service worker                          chrome.storage.local: settings
  ├─ launch/user-gesture routing            IndexedDB: bounded result caches
  ├─ preference/permission coordination     Chrome Translator: one Window session
  └─ ensure/route to offscreen host ======> OffscreenComputeHost (restartable)
                                               ├─ bounded priority queue
                                               ├─ TextDetector adapter/probe
                                               ├─ Tesseract module Worker
                                               ├─ Transformers module Worker
                                               └─ PaddleOCR-Wasm module Worker
                                             Chrome Prompt: optional visible-Window sidecar
                                             Screen AI: compiled out until public API
```

Chrome side panels are full extension pages and can call extension APIs, while
Manifest V3 service workers are loaded on demand, have no DOM, and may terminate
when dormant. The visible side panel or detached extension page is therefore the
correct live-session owner; the service worker remains a disposable control
plane. ([Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel),
[extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers),
[service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle))

**Decision confidence:** High for topology and ownership; medium-high for the
full rrweb live adapter until the focused prototype validates translation
overlays, passive resources, and production bundle size.

### System Architecture Patterns

#### Modular monolith with explicit runtime components

The repository should keep one installable WXT bundle and split responsibilities
by runtime and domain rather than adding a UI framework or distributed service.
WXT already models extensions as file-based entrypoints, and its unlisted-script
support produces stable packaged scripts that can be injected on demand.
([WXT entrypoints](https://wxt.dev/guide/essentials/entrypoints),
[WXT scripting](https://wxt.dev/guide/essentials/scripting))

Recommended component boundaries:

| Component | Responsibility | Must not own |
|---|---|---|
| `background.ts` control plane | Top-level browser listeners, launch routing, preference serialization, permission reconciliation | Page snapshots, translation/OCR jobs, replica DOM |
| Popup launcher | Capture the user gesture, resolve initial tab/window, open native panel | Long-lived state |
| `page-recorder` unlisted entrypoint | One isolated-world recorder per document, stable IDs, checkpoint/events, Port subscribers | Preferences, API keys, translations, privileged commands |
| Optional main-world style probe | Bounded CSSOM/adopted-sheet/early-shadow dirty hints | Chrome APIs or authoritative data |
| `ReplicaSession` | Pure session state machine, identity, sequence/ACK, recovery, job epochs | Direct UI rendering details |
| `RrwebReplicaEngine` | Hidden staging iframe, protected live Replayer, atomic swap, node lookup | Translation policy, permissions, persistence |
| `SourceValueModel` | Canonical source text/attributes and per-node revisions | Rendered translated values |
| `TranslationCoordinator` | Pair preparation, one session/queue, stale-job rejection | DOM capture or page access |
| `TranslationMemory` | Memory LRU and IndexedDB read-through/write-through policy | Raw screenshots or private controls |
| `ImageVisibilityScheduler` | Source-frame IntersectionObserver registration, three scan policies, small-image eligibility, tier promotion | OCR engines or pixel interpretation |
| `ImageAnalysisCoordinator` | Image identity/capture consistency, ordered policy, normalized results, fallback, cache and geometry mapping | Provider implementation or site mutation |
| `ImageTextProviderRegistry` | Compile-selected descriptors, persisted-order filtering, lazy module creation and capability probes | Model inference or UI state |
| `OffscreenComputeHost` | Restartable bounded queue, module-Worker lifecycle, job/result protocol, memory release | Source DOM visibility or Prompt session |
| `ChromeTextDetectorProvider` | Experimental runtime probe, boxes/text normalization, boxes-only hints | Guaranteed production availability |
| `TesseractProvider` | Group-scoped Worker, exact model loading, spatial recognition | Prompt sessions or translation policy |
| `TransformersProvider` | Local specialized crop recognition through Wasm/WebGPU Worker | Scene-text detection or invented boxes |
| `PaddleOcrWasmProvider` | Official PaddleOCR.js Worker, local ORT Wasm/models, line polygons | Remote CDN fallback |
| `ChromiumScreenAiProvider` | Compile-time placeholder/future public capability adapter | Private Mojo/browser-process access |
| `ChromePromptImageAnalyzer` | Optional Window-owned language hint and transcript interpretation | Trusted geometry or service-worker lifetime |
| `AssetPolicy` | Schemes, passive resource behavior, placeholders/localization | Generic arbitrary network fetch |
| Side-panel entrypoint | DOM lookup, event wiring, status rendering, controller construction | Capture/translation/storage algorithms |

The current repository already has good seams—provider adapters, preference
coordination, generation control, and a target-document renderer—but
`entrypoints/sidepanel/main.ts` is about 2,000 lines and the two capture modules
are each over 1,100 lines. They should be decomposed into testable `lib/mirror/`,
`lib/translation/`, `lib/ocr/`, `lib/storage/`, and `lib/browser/` modules while
entrypoints remain thin.

#### Packaged recorder rather than serialized functions

The new recorder should be injected as a packaged WXT unlisted file with
`scripting.executeScript({files: [...]})`. Chrome serializes and deserializes a
function passed through `executeScript({func})`, losing its imports, closure,
and bound execution context; that is no longer appropriate once capture uses
rrweb and several policy modules. ([Chrome Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting),
[WXT unlisted scripts](https://wxt.dev/guide/essentials/entrypoints#unlisted-scripts))

Injection stays on-demand under `activeTab` or an explicit optional grant. Do
not register an always-on content script merely to simplify lifecycle; that
would broaden when Simul runs and weaken the consent boundary.

#### rrweb adapter as the primary replica engine

Pin the public rrweb 2.1.x recorder and replay packages behind a Simul-owned
adapter. rrweb already separates DOM snapshot/rebuild, mutation recording and
replay, and player UI; it assigns stable IDs and handles ordering, moves,
missing nodes, stylesheets, shadow roots, viewport changes, controls, media, and
live replay. ([rrweb architecture](https://github.com/rrweb-io/rrweb),
[rrweb guide](https://github.com/rrweb-io/rrweb/blob/master/guide.md),
[rrweb mutation implementation](https://github.com/rrweb-io/rrweb/blob/main/packages/rrweb/src/record/mutation.ts))

Selected usage:

- `record()` in the isolated source bundle;
- Replayer in `liveMode` inside a protected iframe;
- mouse-move/touch/interaction tails, console, canvas, and unrelated recording
  disabled;
- inputs fully masked and private-control events excluded;
- only required meta, snapshot, mutation, scroll, viewport, stylesheet,
  adopted-sheet, font, selected media-state, and safe form-shell events passed;
- Simul sequencing, acknowledgements, size limits, validation, and permission
  policy outside rrweb;
- Replayer Mirror used only to locate affected replica nodes for translation
  and OCR projections.

Do not copy rrweb's internal mutation algorithm into Simul. A custom applier
would make Simul responsible for difficult move/neighbor ordering, snapshot
locking, missing-node pools, shadow mapping, stylesheet state, and control
properties. The adapter is an anti-corruption layer: upstream events are
normalized into Simul's protocol, and no internal rrweb API may leak into the
rest of the application.

The current computed-style visual tree remains **Tier 0 fallback**, not a
parallel primary architecture. If the rrweb engine rejects a page or exceeds a
budget, Simul retains the last good view and clearly labels degraded fidelity.

#### Architecture option trade-offs

| Pattern | Fidelity | Safety/determinism | Decision |
|---|---:|---:|---|
| rrweb live recorder + protected Replayer | High DOM/CSS/state coverage | High with Simul validation and scripts disabled | Primary default |
| rrweb snapshot + Simul custom mutation applier | Potentially high | Larger custom correctness surface | Reject unless Replayer prototype fails |
| Current computed-style dirty subtrees | Medium/low ceiling | Strong existing allowlist | Bounded fallback during migration |
| Duplicated real website tab/window | Highest runtime fidelity | Executes site again; state/permission side effects | Explicit experimental mode |
| External site iframe | Site-dependent | Framing and same-origin failures | Reject |
| Pixel stream/screenshot | Pixel-faithful viewport only | No semantic selectable DOM | OCR/media fallback only |

**Confidence:** High on pattern selection; medium-high on rrweb integration
effort pending a prototype using the exact pinned npm exports.

### Component State Ownership and Invariants

Each datum has one authoritative owner:

| State | Authoritative owner | Lifetime |
|---|---|---|
| Node IDs and capture sequence | Source recorder | Source document |
| Followed `{tabId, windowId, documentId}` | `ReplicaSession` | Companion page |
| Port ACK/retransmit watermarks | Recorder per subscriber + session | Port/session |
| Canonical source text/revision | `SourceValueModel` | Document generation |
| Replica DOM and rrweb Mirror | `RrwebReplicaEngine` | Staged/current iframe |
| Translation pair/session/jobs | `TranslationCoordinator` | Companion/pair epoch |
| Image observation/tier | `ImageVisibilityScheduler` in each source frame | Source document/image revision |
| Image jobs/provider policy | `ImageAnalysisCoordinator` | Companion/page and preference epoch |
| Compiled provider set | Build-generated `ImageTextProviderRegistry` | Extension artifact |
| Heavy provider queue/workers/models | `OffscreenComputeHost` | Offscreen context/provider idle lifetime |
| Prompt image session | `ChromePromptImageAnalyzer` | Visible companion/Prompt preferences and capability |
| Hot result cache | Coordinators | Companion page |
| Persistent result cache | Extension-origin IndexedDB | Bounded TTL across sessions |
| Preferences/access intent | `chrome.storage.local` | Installation |
| Actual access capability | Chrome Permissions API | Browser grant lifecycle |

Required invariants:

1. Default mode never writes to the source DOM; it only observes and may read
   scroll/layout/pixels after authorization.
2. Node identity is valid only inside `(documentId, navigationEpoch,
   checkpointGeneration)`.
3. No incremental event applies before a complete checkpoint or across a
   sequence gap.
4. A full checkpoint builds in a hidden staging iframe; queued contiguous
   deltas apply before one atomic view swap.
5. Source values remain canonical. Translation is a projection and never
   alters the source event stream or source-value model.
6. Every translation result matches page epoch, generation, node ID, source
   revision, and translation epoch before commit.
7. Every image result additionally matches image revision, pixel hash,
   viewport/capture revision, scan policy, ordered provider policy/build/model
   version, and—when present—validated geometry transform.
8. All page-derived data is untrusted until schema, depth, count, string, URL,
   CSS, and aggregate-byte validation succeeds.
9. The replica iframe never receives `allow-scripts`; unsafe rrweb canvas replay
   remains disabled.
10. All buffers, snapshots, queues, caches, sessions, and subscribers are
    explicitly bounded.
11. Compile-disabled providers contribute no runtime code, Worker, Wasm, model,
    license payload, remote fallback string, or visible settings row.
12. Multiple companion views may share one recorder sequence but maintain
    independent ACK watermarks; a slow view resynchronizes rather than forcing
    unbounded recorder history.
13. Faithful mode changes text only. Adaptive font or box resizing is deferred
    and never silently enabled while fidelity is being diagnosed.

These invariants should be represented as runtime assertions at boundaries and
as acceptance tests, not just comments.

**Confidence:** High.

### Design Principles and Best Practices

#### Fidelity-first progressive enhancement

Architecture should expose explicit fidelity tiers:

- **Tier 0 – safe fallback:** existing sanitized, computed-style visual tree,
  placeholders, and dirty-subtree replacement.
- **Tier 1 – default:** rrweb DOM/CSS snapshot and incremental state, source
  viewport, open shadow roots, approved resources, inert controls, text
  translation projections, and local OCR overlays.
- **Tier 2 – enhanced capture:** individually tested CSSOM/adopted stylesheet,
  early/closed shadow, media bitmap, and cross-origin-frame placeholder/raster
  capabilities under suitable access.
- **Tier 3 – optional live website:** duplicated tab/window with site runtime,
  distinctly labeled as interactive and non-read-only.

Canvas/WebGL, DRM/MSE media, inaccessible cross-origin frames, browser UI, and
some closed-component state remain declared limitations. A fidelity diagnostic
should report what was omitted instead of silently presenting the result as an
exact copy.

#### Unidirectional data flow

The source recorder emits facts; `ReplicaSession` validates and reduces them;
the replica engine renders; translation and OCR observe source revisions and
emit revision-checked projections. No rendered translated text feeds back into
capture, language detection, or cache keys. This prevents loops and makes
Mexico City's background update independent of translation.

#### Graceful degradation and last-good-state

Navigation, permission loss, model preparation, OCR failure, and snapshot
resynchronization should retain the last coherent replica until a new atomic
state is ready. Partial failures are isolated:

- capture failure pauses the live stream;
- translation failure keeps source text;
- OCR failure keeps the unmodified image;
- cache failure falls back to memory;
- asset failure uses a measured placeholder;
- live-window failure never mutates the original tab.

#### Capability-driven behavior

Feature-detect Translator, supported pairs, `documentId` targeting, and any
newer side-panel API. Permission settings express user intent, but
`permissions.contains()` is capability truth. This prevents stale preferences
from being mistaken for access.

**Confidence:** High.

### Scalability and Performance Patterns

Simul scales with **DOM size, mutation rate, translation volume, image area,
and number of open companion views**, not server request volume. Relevant
patterns are incremental computation, bounded queues, local caches, and worker
isolation rather than horizontal infrastructure.

#### Incremental O(delta) synchronization

- One recorder/observer set exists per source document, even when multiple
  views follow it.
- Mutations coalesce once per animation frame while retaining structural
  dependency order.
- Repeated text, attribute, scroll, and selection writes may collapse to the
  latest value inside an uncommitted batch; structural and stylesheet events
  may not be dropped or reordered.
- Normal changes apply only to affected nodes. A style/background change emits
  no translation work when source text revisions are unchanged.
- Full checkpoints occur only on initial load, navigation, detected drift,
  high-water overflow, or a conservative periodic boundary.
- Snapshot chunks are capped at 512 KiB serialized, with total node, byte,
  depth, chunk-count, and assembly-time budgets.

rrweb's checkpoint chain and mutation handling provide the base mechanics;
Simul adds transport sequencing and resource budgets. ([rrweb capture and
checkout](https://github.com/rrweb-io/rrweb/blob/master/guide.md))

#### Source-sized viewport and layout stability

The replica iframe's intrinsic dimensions equal the recorded **source viewport
in CSS pixels**, not the narrow side panel and not the full document height.
Fit/custom zoom scales an outer wrapper after layout; one-to-one mode keeps
scale 1 and exposes extension-owned overflow. CSS transforms affect rendering
after layout, so they do not change responsive breakpoints inside the iframe.
([CSS Transforms](https://www.w3.org/TR/css-transforms-1/))

Scrolling occurs in the replica viewport. Links, forms, and controls are
neutralized, but wheel/scrollbar interaction remains available. Faithful scroll
sync uses exact CSS-pixel offsets when source and replica ranges match; any
future adaptive layout maps ranges proportionally.

#### Translation scheduling

- One retained Translator session per active pair and one in-flight provider
  call because Chrome processes translation sequentially.
- Visible/current text jobs have priority, identical jobs share an in-flight
  Promise, and stale revisions are removed before execution.
- Memory LRU precedes IndexedDB; writes happen after currency checks and never
  block replica commits.
- Pair changes increment a translation epoch and reproject current source
  values without recapture.
- Sessions are destroyed on pair replacement or companion teardown.
- Translator remains in the controller `Window`; it is not moved into a Worker.
  OCR and translation use capacity-one lanes, with bulk page-text translation
  ahead of OCR so both local compute workloads do not contend unnecessarily.

Chrome recommends bounded local result caches with conservative TTL and
destroying unused built-in-AI sessions. ([built-in AI guidance](https://developer.chrome.com/docs/ai/built-in-ai-dos-donts),
[Translator sequential behavior](https://developer.chrome.com/docs/ai/translator-api#sequential-translations))

#### OCR scheduling

- The source frame uses IntersectionObserver to assign `visible`, `near`, or
  `background` priority according to the persisted scan policy. Background
  jobs yield to newly visible work.
- The offscreen host filters the user's saved provider order through the
  compile-time registry and real capability probes. It imports and prepares the
  first eligible provider only when a stable candidate exists; later providers
  remain unloaded until a defined fallback.
- Serialize expensive recognition globally at first. Reuse the active provider
  Worker/model for a compatible group and destroy it after a measured idle
  interval, provider/language change, memory pressure, or context recovery.
- Never create an unbounded worker pool or load every compiled engine merely
  because it is present in the priority list.
- Respect Chrome's two-captures-per-second limit and compare pre/post capture
  identity, viewport, scroll, scale, and bounds before accepting pixels.
- Cache recognition separately from translation so target-language changes do
  not rerun OCR. Cache stable no-text results with a shorter TTL.
- Decode the captured data URL once, crop to an encoded PNG/WebP `Blob`, and
  transfer an `ImageBitmap` or minimal provider-supported payload. Do not retain
  expanded data-URL/RGBA copies longer than needed; close bitmaps promptly.
- Start with a 4-megapixel input guardrail, conservative small-image heuristic,
  60–120 second provider idle timeout, and a 30-second maximum-job watchdog
  followed by at most one host/Worker recreation. These are benchmark targets,
  not yet measured guarantees.
- Persist only enough versioned job/cache metadata to survive service-worker or
  companion closure. Every late result is currency-checked before storage and
  before overlay commit.

([Tesseract.js performance guidance](https://github.com/naptha/tesseract.js/blob/master/docs/performance.md),
[`captureVisibleTab()`](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab),
[Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen))

#### Performance budgets and observability

Keep local, privacy-safe counters for snapshot nodes/bytes/time, event batch
size, resync count, cache hits, translation queue depth, OCR time, and dropped
stale jobs. Expose these only in a developer diagnostics panel; do not add
telemetry. Budgets should fail closed into a labeled degraded view rather than
freezing the page or silently truncating important structure.

**Confidence:** High for the performance shape; concrete browser budgets beyond
the message/chrome limits require measurements on target pages and devices.

OCR/translation orchestration should use a pure `ComputeJobController` instead
of accumulating more shared booleans. Jobs transition through explicit stages
such as `acquiring`, `decoding`, `hashing`, `cacheLookup`, `initializing`,
`recognizing`, `translating`, and `rendering`, then end as `complete`, `partial`,
`cancelled`, `stale`, or `failed`. Each capacity-one lane retains only one
running and one latest pending job.

### Integration and Communication Patterns

The architectural communication spine is the Step 3 protocol:

1. Inject the packaged recorder and obtain its Chrome `documentId`.
2. Open `tabs.connect(tabId, {documentId, name})` from the owning companion.
3. Negotiate protocol/capabilities and assemble a bounded full checkpoint.
4. Apply contiguous live events to a hidden/current protected Replayer.
5. ACK source-language commits independently of translation/OCR completion.
6. Request one new checkpoint on gap, unknown ID, overflow, or invalid state.

The service worker is not on this hot path. Side-panel/detached instances do
not use direct JavaScript references across windows; they coordinate settings
through storage and bind explicitly to source tab/document identity.

The recorder may multiplex several document-targeted Ports over one rrweb
sequence. Each subscriber has a bounded ACK/retransmit state. A lagging view is
resynchronized alone, protecting the source page and other views from its
backpressure.

The optional main-world probe is a separate, one-way adapter. The website can
read or forge its signals, so the isolated recorder treats them as rate-limited
requests to reread actual DOM/CSS state—never as privileged commands or trusted
values. Chrome warns that main-world code shares the host page environment.
([content-script execution worlds](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts))

**Confidence:** High.

### Security Architecture Patterns

#### Trust zones and validation

Chrome authority supplies tab/document/origin identities and permissions. The
service worker and extension pages are privileged; isolated code is less
trusted because it runs beside a hostile renderer; every DOM value and capture
message is untrusted. Chrome explicitly recommends validating content-script
messages and limiting the privileged actions they can trigger.
([Chrome messaging security](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations),
[extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure))

Defense-in-depth:

- validate Chrome sender identity plus Simul protocol/session/epoch/sequence;
- use packaged code only and no remote executable JavaScript/Wasm;
- accept no generic fetch, navigation, script, tab, permission, or storage
  command from the recorder;
- sanitize before rrweb replay and again at replica node/resource boundaries;
- strip scripts, handlers, executable URLs, forms, meta refresh, nested frames,
  objects/embeds, downloads, and navigation;
- configure rrweb to mask every input value and exclude private edit/control
  events while retaining inert geometry;
- render in `sandbox="allow-same-origin"` without `allow-scripts`; keep unsafe
  canvas replay disabled;
- keep passive image/font/CSS resources behind `AssetPolicy`, with allowed
  protocols, size limits, no-referrer behavior where possible, and explicit
  placeholders/localization when denied;
- restrict `chrome.storage.local` to `TRUSTED_CONTEXTS`, since Chrome exposes it
  to content scripts by default and the recorder does not need preference data;
- disable persistent page-content caches in incognito and store no screenshots;
- retain optional host access and no required host matches.

([Chrome storage access levels](https://developer.chrome.com/docs/extensions/reference/api/storage),
[rrweb protected rebuild](https://github.com/rrweb-io/rrweb/blob/main/packages/rrweb-snapshot/src/rebuild.ts))

#### Permission architecture

Keep the current required permissions—`activeTab`, `scripting`, `sidePanel`,
and `storage`—and add required `offscreen`, justified solely by the bundled
`WORKERS` compute host. Continue declaring HTTP(S) hosts as optional. This pass
does not need required `webNavigation`, `tabs`, `unlimitedStorage`, `tabCapture`,
or broad required hosts:

- document IDs come from scripting results;
- OCR provider Workers run under one restartable static offscreen document;
- `captureVisibleTab()` works under activeTab or a matching grant;
- bounded IndexedDB does not require unlimited storage.

Permission prompts must originate in a user gesture. Automatic access reconciles
saved intent against actual Chrome grants at startup, navigation, and
`permissions.onRemoved`. ([Chrome optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions),
[`activeTab`](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab))

#### OCR CSP boundary

Local Tesseract, Transformers.js, and PaddleOCR WebAssembly require only the
permitted extension-page CSP relaxation `script-src 'self' 'wasm-unsafe-eval';
worker-src 'self'; object-src 'self'`. All executable code, module Workers,
Wasm, ONNX graphs selected for the build, and default models are pinned and
packaged. MV3 continues to prohibit remotely hosted executable code. Provider
build flags must remove remote runtime/model fallbacks, not merely avoid calling
them. ([extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy),
[remote-hosted-code policy](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code))

**Confidence:** High.

### Data Architecture Patterns

Use four storage lifetimes:

1. **Document memory:** rrweb observer, node Mirror, sequence, subscriber buffers.
2. **Companion memory:** current source model, replica engine, in-flight maps,
   lightweight job descriptors, sessions, and last-good state.
3. **`chrome.storage.local`:** non-sensitive preferences, selected languages,
   view settings, OCR provider order, scan/small-image policy, cache policy, and
   automation intent.
4. **Extension-origin IndexedDB:** the explicitly requested bounded translation
   and OCR result memory plus restart-safe offscreen job metadata. Heavy
   provider Worker/model memory belongs only to the offscreen compute lifetime.

Chrome shares extension-origin IndexedDB across side panels, extension pages,
and the service worker, while a content script would access the website's
storage instead. ([extension storage architecture](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies))

Recommended database `simul-cache-v1`:

| Store | Key | Value | Indices |
|---|---|---|---|
| `translations` | SHA-256 of domain-separated exact source + pair + policy version | translated output, byte count, created/last-used/expires | `lastUsed`, `expiresAt` |
| `imageTextResults` | SHA-256 of canonical pixels + dimensions + detection/engine/policy/schema/preprocessing versions | transcript, optional validated regions/boxes, byte count, timestamps | `lastUsed`, `expiresAt` |
| `pendingImageInputs` | Random job ID + page/image revision | transient cropped Blob, byte count, very short expiry | `expiresAt` |
| `meta` | schema/cache policy key | schema version, approximate bytes, last cleanup | none |

Chrome does not expose its Translator language-pack model version, so the cache
uses a Simul provider-policy version, conservative TTL, and explicit refresh.
Recognition and overlay translation remain separate. Validated normalized
provider geometry can be reused when only the target language changes; Prompt
or Transformers output without validated alignment never creates spatial
overlays.

Privacy/data rules:

- never persist input, textarea, contenteditable, password/private-control, or
  composer values;
- persist no raw screenshots beyond the bounded transient offscreen handoff;
  consume/delete each crop immediately and purge short-expiry orphans at every
  startup, while retaining no page URL history or user identifiers;
- store a source hash rather than duplicate raw source text when lookup permits;
- apply byte/entry limits, LRU eviction, TTL cleanup, schema migrations, and a
  user-facing clear-cache command;
- perform cache writes only after confirming a job remains current;
- fall back to memory when IndexedDB or quota is unavailable;
- skip persistent result reads/writes in incognito contexts.

Tesseract's trained-data cache is a separate recoverable implementation cache;
bundled models remain authoritative. Simul does not request
`unlimitedStorage`. Chrome notes that extension storage persists independently
of ordinary browsing-data clearing, making the clear-cache control important.

**Confidence:** High.

### Deployment and Operations Architecture

#### Build and packaged dependencies

Pin exact dependency versions during the implementation spike:

- rrweb recorder/replay/snapshot 2.1.0;
- Tesseract.js and Tesseract.js core 7.0.0;
- checksummed 21-language/22-file `tessdata_fast` catalog at the pinned commit;
- Transformers.js 4.2.0 plus an explicitly selected local OCR crop model when
  that build flag is enabled; and
- `@paddleocr/paddleocr-js` 0.4.2, local ORT Wasm/OpenCV/Worker, and an exact
  local PP-OCR model pair when that build flag is enabled.

Use WXT's normal bundled entrypoints for extension code, one unlisted static
offscreen HTML page, and Vite-bundled module Workers. Generate a provider asset
staging directory from the compile profile; do not place every optional model
in an unconditional `public/` directory because WXT copies that directory to
every output. ([WXT project structure](https://wxt.dev/guide/essentials/project-structure),
[WXT unlisted entrypoints](https://wxt.dev/guide/essentials/entrypoints#unlisted-pages))

Only the LSTM core variants required by the selected OCR mode should be copied,
not the complete core npm package. The approved compressed language catalog is
approximately **25.4 MiB** and the worker/core/model OCR payload approximately
**36.7 MiB** before application code. Record engine and language assets as
separate artifact budgets, and maintain a checked manifest containing
engine/core/tessdata versions, upstream commit, preprocessing version, SHA-256,
license, and exact byte size.

Record Transformers and Paddle as separate experimental artifact budgets. A
single TrOCR-small crop recognizer is roughly tens of MiB and the measured
PaddleOCR.js/ORT-Wasm/PP-OCRv6-tiny path is also tens of MiB before the rest of
the extension; neither size may be hidden inside the application-code budget.
Only selected providers are shipped, and only the active provider/model is
loaded into memory.

Use `cacheMethod: 'none'` initially for authoritative bundled models so
Tesseract does not duplicate decompressed language files into IndexedDB.
Benchmark startup before considering an explicitly bounded derived cache.

#### Manifest and release validation

The release artifact validator should additionally assert:

- permission and optional-host sets exactly match the approved architecture;
- minimum Chrome remains 138 unless a consciously approved feature changes it;
- CSP includes only self, the required Wasm token, and self Worker source;
- no CDN/dev-server executable URLs or dynamic code-loading fallback exists;
- the generated compiled-provider manifest exactly matches code chunks,
  Workers, Wasm, model files, settings rows, and licenses in the artifact;
- compile-disabled provider markers and assets—including Screen AI—are absent;
- pinned OCR worker/core/models exist with expected checksums and all provider
  runtime/model URLs resolve while offline;
- third-party licenses/notices are present;
- build size and major asset sizes are reported;
- protocol versions are present and stale/unknown versions reject safely.

Open side panels/detached pages can delay extension update installation even
though they do not keep the worker permanently alive. Protocol versioning and
idempotent cleanup therefore protect against old injected scripts/pages during
an update boundary. ([Chrome extension update lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle))

The existing release sequence remains authoritative:

```text
typecheck -> unit/contract tests -> Chrome build -> artifact validation
          -> artifact sync -> byte-for-byte artifact check
```

No Simul cloud deployment, API key, or backend is introduced. Chrome-managed
built-in models and the separately approved verified Tesseract language-data
catalog remain the only download paths; Store builds execute no arbitrary
remote ONNX graph.

#### Verification architecture

Automated tests should be layered:

- protocol parser, invalid-payload, size-budget, sequence/gap, and reducer tests;
- rrweb adapter fixtures for moves, stylesheets, shadow roots, form masking,
  atomic checkpoint swap, and passive-resource filtering;
- translation scheduler/cache/epoch and first-model-preparation tests;
- provider-registry permutation/migration, hard/soft fallthrough, boxes-only
  hint, negative-cache, scan-policy, small-image override, and stale-result
  tests;
- OCR job/crop/coordinate/cache tests plus forced service-worker, offscreen,
  and provider-Worker termination/recovery;
- navigation identity, BFCache reconnect, permission revocation, tab
  move/replacement, and multi-view tests through browser adapters;
- a build matrix that independently enables/disables every provider and proves
  artifact absence as well as runtime presence; and
- production artifact tests for manifest, CSP, bundled assets, offline startup,
  and remote-code absence.

Manual real-Chrome acceptance remains required for:

- Spanish-to-English language change and first pack preparation;
- Mexico City background rotation without tree regeneration/retranslation;
- Reddit left/right rails, fixed/sticky layout, and custom/shadow elements;
- fit/custom/one-to-one zoom and horizontal scrolling;
- same-document, same-origin full, and cross-origin navigation;
- horizontal/vertical Japanese and Spanish image OCR overlays;
- all three visibility policies, scrolling promotion, small-image override,
  provider reordering/fallback, and side-panel closure during offscreen OCR;
- Tesseract baseline plus exact enabled Transformers/Paddle models on their
  declared languages; TextDetector and Screen AI unavailable states are valid;
- detached companion and optional duplicated live page behavior.

The connected browser surface was unavailable during research, so this live
acceptance cannot be represented as already verified.

**Confidence:** High for build/operations design; medium for target-site
acceptance until a browser session exercises the installed artifact.

### Migration Architecture

Use a strangler-style internal migration that preserves the working extension
until the replacement proves itself. These are engineering steps inside one
release effort, not deferred product phases:

1. Add characterization fixtures for current capture, navigation, translation,
   zoom, and permissions; extract controller/reducer modules without changing
   behavior.
2. Move the current visual renderer into a source-viewport-sized protected
   iframe using its existing `targetDocument` seam. Default to faithful text
   layout and disable adaptive resizing.
3. Replace serialized capture functions and broadcast dirty messages with the
   packaged recorder entrypoint, document-targeted Port, protocol v2, and
   ACK/gap/checkpoint recovery. Never mix v1 and v2 node IDs.
4. Introduce rrweb record/live Replayer behind the adapter and a development
   switch. Keep v1 as automatic labeled fallback while parity/security tests
   mature.
5. Move translation into `SourceValueModel` projections, prepare the selected
   pair from a valid language-change gesture, and add bounded IndexedDB memory.
6. Add the source-owned `ImageVisibilityScheduler`, three persisted scan
   policies, small-image skip/override, revisioned job descriptors, normalized
   OCR contract, and compile-generated provider registry.
7. Add the required offscreen compute host and versioned protocol. Move the
   lazy Tesseract Worker behind its independent build module, retain the broad
   catalog, and prove host/Worker restart recovery and spatial overlays.
8. Add TextDetector as a small experimental provider module, Transformers.js
   as a local crop-recognition module, and official PaddleOCR.js forced to
   local Wasm as a prototype-gated spatial module. Implement ordered capability
   filtering/fallthrough and per-provider artifact profiles. Keep Chromium
   Screen AI's provider ID/module compiled out until a public extension API
   exists.
9. Add the two independent persisted Prompt image preferences, Window-owned
   Prompt session, capability/download UX, structured validation, metrics, and
   deterministic ordered-chain fallback.
10. Add enhanced CSS/shadow/media capabilities individually behind negotiated
   protocol flags; add the separately labeled live-site duplicate option only
   where persistent host access exists.
11. Run all automated and real-Chrome acceptance checks, remove the old primary
   dirty-subtree path only after the new engine passes, synchronize
   `dist/chrome-unpacked`, and document residual fidelity limits.

This sequence minimizes the risk of replacing a working release with a large,
unobservable rewrite while still delivering the requested architecture as one
coherent pass.

### Architectural Decision Record Summary

| ADR | Decision | Status/confidence |
|---|---|---|
| A1 | Modular client extension; no Simul backend/cloud processing; Chrome-managed local model downloads permitted | Accepted / High |
| A2 | Visible companion owns live session; worker is control plane | Accepted / High |
| A3 | Document-targeted on-demand packaged recorder | Accepted / High |
| A4 | rrweb live Replayer behind Simul validation/projection adapter | Prototype-required / Medium-high |
| A5 | Source-sized script-disabled iframe and faithful layout default | Accepted / High |
| A6 | Ordered incremental data lane independent from derived AI lanes | Accepted / High |
| A7 | Bounded persistent translation/OCR memory with private exclusions | Accepted / High |
| A8 | Five-ID ordered local OCR policy: capability-filtered TextDetector, Tesseract, Transformers, PaddleOCR-Wasm, and future Screen AI; Prompt remains a sidecar | Accepted / mixed provider confidence |
| A9 | Add required `offscreen` solely for a restartable `WORKERS` compute host; add no required host, `webNavigation`, or unlimited-storage permission | Accepted / High |
| A10 | Current renderer retained only as migration fallback | Accepted / High |
| A11 | Duplicated live site remains explicit experimental fidelity mode | Accepted / Medium-high |
| A12 | Prompt image-language and image-text use are independent persisted preferences, default off, with deterministic fallbacks | Accepted / High |
| A13 | Prompt output is source-revision checked and schema validated; no overlay uses unvalidated or generated geometry | Accepted / High |
| A14 | Core minimum remains Chrome 138; Prompt image capability is progressive and runtime feature-detected | Accepted / High |
| A15 | Every OCR provider is an independent compile-time module with independently staged assets; disabled providers are absent from the artifact | Accepted / High |
| A16 | Persist the user's complete provider permutation; effective order filters only by compiled presence and runtime capability, never silent reordering | Accepted / High |
| A17 | IntersectionObserver drives visible-only, visible-first background prescan, or eager-all scheduling; visible work always outranks queued background work | Accepted / High |
| A18 | Tesseract, Transformers, and Paddle execute in bounded module Workers owned by one restartable offscreen document; Prompt stays in a visible Window | Accepted / High topology; provider spikes required |
| A19 | Small-image skipping is optional/default-on, conservative, revision-aware, and always overridable per image | Accepted / Medium until corpus tuning |
| A20 | Official PaddleOCR.js with forced local Wasm is the only Paddle path; it remains prototype-gated at version 0.x | Prototype-required / Medium |
| A21 | Chromium Screen AI is a reserved, compile-disabled provider because current access requires private Chromium C++/Mojo integration | Accepted / High |

## Implementation Approaches and Technology Adoption

### Technology Adoption Strategies

Simul should adopt the researched architecture through internal provider
boundaries and reversible feature switches, not through a single replacement
commit. The existing capture and replica implementation remains available while
the rrweb path proves fidelity, safety, and performance. Translation, image
recognition, and language routing remain projections over the replica rather
than reasons to mutate the source page.

The image pipeline should expose one ordered provider policy, one scheduling
policy, one eligibility heuristic, and the two previously approved independent
Prompt preferences:

```ts
type ImageTextProviderId =
  | "chrome-text-detector"
  | "tesseract"
  | "transformers"
  | "paddleocr-wasm"
  | "chromium-screen-ai";

type ImageScanPolicy =
  | "visible-first-background-prescan"
  | "visible-only"
  | "eager-all";

interface ImageAnalysisPreferences {
  providerPriority: ImageTextProviderId[];
  scanPolicy: ImageScanPolicy;
  skipSmallImages: boolean;
  usePromptForImageLanguage: boolean;
  usePromptForImageText: boolean;
}
```

The initial priority is the order above. It is a complete, duplicate-free
permutation of known provider IDs; users can reorder it, and Simul never
silently promotes another provider. `visible-first-background-prescan` and
`skipSmallImages: true` are the initial scheduling defaults. Both Prompt
preferences default to `false`. All values persist in `chrome.storage.local`.

Build-time provider flags are independent of those runtime preferences:

```ts
SIMUL_OCR_TEXT_DETECTOR
SIMUL_OCR_TESSERACT
SIMUL_OCR_TRANSFORMERS
SIMUL_OCR_PADDLE
SIMUL_OCR_SCREEN_AI
```

Do not statically import all providers and rely only on tree shaking. A build
script validates these flags and generates `compiled-provider-registry.ts` with
imports only for enabled `lib/ocr/providers/<provider>/index.ts` modules, plus
the provider asset/copy, permission/CSP, and notice manifests. Disabling a
provider therefore removes its Worker, Wasm, models, default URLs, license
payload, permissions, and settings row from the artifact. A production artifact
test fails if a disabled provider's marker or assets remain. Runtime ordering
filters the saved canonical list through this generated registry and each
module's capability probe. This preserves a user's stored position if a later
build re-enables a provider without displaying a nonfunctional row in a build
where it is absent.

`chromium-screen-ai` is false in standard Chrome extension builds. It may turn
true only when a supported bridge exists; compile-enabling today's adapter
still yields `unavailable` because Chromium's private C++/Mojo service is not an
extension API.

The code boundary should be visible in the repository, not simulated by one
large switch statement:

```text
lib/ocr/
  contracts.ts                  # no provider-package imports
  known-provider-ids.ts         # stable persisted IDs only
  compiled-provider-registry.ts # generated imports for this build
  coordinator.ts
  scheduling/
    visible-only.ts
    background-prescan.ts
    eager-all.ts
    small-image-policy.ts
  providers/
    chrome-text-detector/
    tesseract/
    transformers/
    paddleocr-wasm/
    chromium-screen-ai/
```

Each provider directory owns its descriptor/probe, normalization adapter, lazy
runtime and disposal code, optional module-Worker entry, asset/model manifest,
timeouts, tests, and third-party notices. Shared coordinator/scheduler code may
depend only on `contracts.ts`; it must never import a provider library directly.
Screen AI's directory contains only the future adapter/probe and tests—no
extracted Chrome binary or model.

| Prompt language | Prompt text | Effective pipeline |
|---|---|---|
| Off | Off | Element/page/context language route, then ordered OCR chain |
| On | Off | Prompt language/script hint, then ordered OCR chain |
| Off | On | Ordered spatial OCR plus optional Prompt transcript interpretation/comparison |
| On | On | One structured Prompt sidecar request where possible, then ordered spatial OCR chain |

- `usePromptForImageLanguage` asks Chrome's local Prompt API for a structured
  language/script hint when image input is available. When disabled or
  unavailable, routing uses the explicit From language, nearest inherited
  `lang`, document language, and Chrome Language Detector over surrounding DOM
  text.
- `usePromptForImageText` enables an experimental transcript/interpretation
  sidecar. It does not enter or reorder the five spatial OCR providers. When
  Prompt is unavailable, times out, returns invalid output, or fails a quality
  gate, the ordered chain continues unchanged.
- Prompt never supplies trusted overlay geometry. Tesseract, PaddleOCR,
  TextDetector when it returns text, or a detector/recognizer composition must
  supply validated boxes/polygons for a spatial overlay.

Each compile-time provider module implements the same narrow contract:

```ts
interface ImageTextProviderModule {
  readonly descriptor: {
    id: ImageTextProviderId;
    canDetectRegions: boolean;
    canRecognizeText: boolean;
    canReturnGeometry: boolean;
  };
  probe(request: ImageCapabilityRequest): Promise<ProviderCapability>;
  prepare(request: ImagePrepareRequest, signal: AbortSignal): Promise<void>;
  recognize(
    input: ImageJobInput,
    hints: readonly ImageRegionHint[],
    signal: AbortSignal,
  ): Promise<ImageTextResult>;
  dispose(): Promise<void>;
}

interface ImageLanguageHintProvider {
  detect(input: ImageJobInput, signal: AbortSignal): Promise<LanguageHint>;
}
```

The coordinator iterates compiled providers in the user's exact order. It
skips a hard-unavailable or unsupported module without loading it. It falls
through sequentially on initialization failure, timeout, exception, empty text,
boxes-only output, strong language mismatch, or a provider-aware quality-gate
failure. A boxes-only `TextDetector` result can become region hints for the next
recognizer; a Transformers result is eligible for spatial overlay only when it
recognizes such validated crops. The first acceptable result wins. Providers
do not race, and ordinary low confidence does not fan out all five engines in
parallel. A bounded negative cache prevents stable no-text images from
re-running the entire chain.

`ImageTextResult` must distinguish transcript confidence from geometry
confidence. The general-purpose Prompt API can return schema-constrained text,
language, script, and ordered segments, but a JSON schema constrains response
shape rather than proving that generated coordinates or characters are
visually correct. Prompt-derived boxes therefore cannot be treated as trusted
overlay coordinates. The practical experimental modes are:

1. prompt the complete image for language and verbatim text interpretation;
2. use validated provider geometry and optionally prompt individual line crops;
3. compare selected providers in a diagnostic mode without showing duplicate
   overlays; and
4. continue through the ordered OCR chain whenever alignment cannot be
   established.

Chrome exposes image input and JSON-schema response constraints through the
Prompt API beginning with the multimodal implementation shipped in Chrome 148.
The API is available to extensions earlier than it is to ordinary web pages,
but every requested modality and language must still be passed to
`LanguageModel.availability()` and feature-detected. Model creation requires
user activation and may trigger a download. The API is currently Window-only,
so the side panel or detached companion owns Prompt sessions; it must not be
placed in an OCR provider Worker, offscreen document, or MV3 service worker.
([Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api),
[Chrome 148 release notes](https://developer.chrome.com/release-notes/148#prompt-api))

The currently documented Prompt text-language set is English, Japanese,
Spanish, German, and French. Image-language hints outside that set—including
Korean, Chinese, Russian, Arabic, and the broader Tesseract catalog—are
best-effort experiments and must continue through the ordered OCR chain when
capability or output validation is insufficient. Prompt transcription is passed
through Simul's ordinary translation provider; the Prompt model must not silently paraphrase or
translate instead of returning a verbatim transcript.
([Prompt expected languages](https://developer.chrome.com/docs/ai/prompt-api#add-expected-input-and-output))

This makes Prompt-based image handling a progressive enhancement without
raising Simul's Chrome 138 baseline. On Chrome 138-147, on unsupported hardware,
or when the model is absent, both options remain visible but clearly report why
they are unavailable and continue through the local non-Prompt path.

#### Local OCR language catalog and lazy loading

The initial broad Tesseract catalog should package 21 user languages in 22
separate compressed model files:

- Latin: English, Spanish, French, German, Portuguese, Italian, Vietnamese;
- East Asian: Japanese, Japanese vertical, Korean, Simplified Chinese, and
  Traditional Chinese;
- Cyrillic: Russian and Ukrainian;
- Arabic/Semitic: Arabic and Hebrew; and
- South Asian: Hindi, Marathi, Bengali, Kannada, Tamil, and Telugu.

At the pinned official `tessdata_fast` revision researched for this report,
deterministic gzip output for those files is approximately 25.4 MiB. With the
packaged Tesseract.js v7 worker and LSTM WebAssembly variants, the OCR payload is
approximately 36.7 MiB before the application bundle. These figures are release
budgets, not runtime-resident memory.

WXT should copy models as independent public assets rather than import their
bytes into JavaScript. `createWorker(langs)` then fetches and decompresses only
the named files. Tesseract.js v7's `reinitialize()` accumulates every newly
loaded model in the worker's MEMFS and `currentLangs`; it is not a bounded
language switch. Simul should therefore reuse one lazy worker for the same exact
language group, terminate and recreate it when the group changes or becomes
idle, and use `cacheMethod: "none"` for packaged authoritative models to avoid
an unnecessary decompressed IndexedDB copy.
([WXT assets](https://wxt.dev/guide/essentials/assets),
[Tesseract.js worker creation](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/createWorker.js),
[Tesseract.js model loading](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/worker-script/index.js),
[pinned tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd))

Additional Tesseract languages can be installed without a Simul server. A
finite catalog can reference immutable upstream model objects with pinned
commit, byte size, license, and SHA-256. Simul downloads only after an explicit
user action, verifies bytes before storage, keeps them in extension-owned
IndexedDB, supports removal, and passes verified bytes to Tesseract. A local
file-import fallback avoids depending on upstream host permission. Persian and
Urdu are useful Arabic-script additions, but Chrome's current Translator API
does not support those source languages; they should remain optional until a
translation provider can consume them.
([Chrome Translator supported languages](https://developer.chrome.com/docs/ai/translator-api#supported-languages),
[Tesseract.js language-data type](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/index.d.ts))

Tesseract orientation/script detection is not the default image router. It
requires a legacy-capable core and language data, detects script rather than
exact language, and would scan the image before the recognition scan. If later
fixtures justify it, use a short-lived dedicated OSD worker and terminate it
before creating the LSTM recognition worker.
([Tesseract.js OSD API](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/api.md#workerdetectimage-jobid-promise))

#### Provider-specific adoption gates

- **Chrome Text Detector:** compile the small adapter by default, label it
  experimental, and perform a real probe. Constructor presence is insufficient.
  The current Chrome implementation may return boxes without recognized text;
  preserve those boxes as hints and continue. It exposes no standardized
  confidence. The provider is automatically skipped on normal builds where the
  feature remains flag-disabled.
- **Tesseract.js:** compile by default and treat as the dependable first-release
  spatial recognizer. Keep one exact-language-group Worker alive, then destroy
  it on group change or idle timeout.
- **Transformers.js:** prototype exact-pinned 4.2.0 as a crop recognizer. CPU
  Wasm is the baseline and WebGPU is conditional. TrOCR-small-printed is for a
  single text line, not scene detection; Japanese manga OCR is another possible
  specialized crop recognizer. Neither may claim spatial success without
  upstream region geometry. All JS, ORT Wasm, configs, tokenizer, and selected
  ONNX files must be local, with remote model/runtime loading disabled.
- **PaddleOCR-Wasm:** prototype exact-pinned `@paddleocr/paddleocr-js` 0.4.2
  using `worker: true`, `backend: "wasm"`, and local `wasmPaths`. Start the size
  and compatibility spike with PP-OCRv6 tiny; it returns line polygons, text,
  and scores. Route an unsupported script to the next provider. The package's
  remote ORT/model defaults must be removed or proven absent from production
  output, even when local paths are configured.
- **Chromium Screen AI:** keep the module and ID defined, but compile it out in
  public builds. Enabling it requires a future documented public extension API,
  not private Mojo access, browser patching, or copying Chrome component files.

Transformers and Paddle model weights contain executable computation graphs as
well as numeric data. Chrome's Store policy does not explicitly classify ONNX,
so the safest release posture is to package the exact models that a Store build
can execute and reject arbitrary remote model IDs. A later downloadable-model
design requires a separate Web Store policy decision and integrity/license
review; it must never download JavaScript or Wasm.
([Transformers.js 4.2.0](https://github.com/huggingface/transformers.js/tree/4.2.0),
[TrOCR model scope](https://huggingface.co/microsoft/trocr-small-printed),
[PaddleOCR.js worker architecture](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/docs/architecture.md),
[Chrome remote-hosted-code policy](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code))

#### Visibility scheduling and small-image policy

The source recorder/content script owns `IntersectionObserver`; the offscreen
document cannot see the followed tab's DOM. It observes eligible `img`, SVG,
canvas, video-frame, and CSS-background candidates as the existing mutation
stream adds or changes them, then sends versioned descriptors rather than
performing inference. Intersection Observer is asynchronous and intentionally
not pixel-accurate compositing/occlusion detection, which is sufficient for
queue priority but not proof that every pixel was visible.
([Intersection Observer specification](https://w3c.github.io/IntersectionObserver/))

All three settings drive one priority queue:

- **Pre-scan in background** (`visible-first-background-prescan`, default):
  intersecting images are high priority; a second observer with approximately
  `rootMargin: "100% 0px"` can prewarm near-viewport images. After the initial
  replica checkpoint is committed, `document.readyState` is complete, the page
  has had roughly a one-second mutation-quiet interval, and visible translation
  work is idle, enqueue remaining eligible images at low priority. A newly
  visible candidate immediately promotes ahead of background work.
- **Only when visible** (`visible-only`): observe with the viewport root,
  `rootMargin: "0px"`, and a small positive threshold. Enqueue only after
  intersection. Completed results stay cached when the image scrolls away.
- **Everything immediately** (`eager-all`): enqueue every eligible image as it
  is discovered while still marking visible items high priority. “Immediately”
  means queued promptly, not loading five engines or running unbounded jobs in
  parallel.

There is no universal “page finished” event for an SPA, so the prescan gate is
an explicit quiet heuristic, not a completeness claim. Navigation, `src`,
`srcset`, `currentSrc`, background style, canvas/frame, dimensions, or pixel-hash
changes create a new image revision; stale queued or completed work is canceled
or discarded.

When `skipSmallImages` is enabled, start conservatively: always skip zero/one-
pixel trackers, and otherwise skip when
`(renderedArea < 1600 CSS px² && longestRenderedSide < 96 CSS px)` or both
intrinsic dimensions are below 32 pixels. This avoids a simple width-or-height
rule that would incorrectly discard long horizontal or vertical text badges.
Reevaluate after responsive layout changes, count skips in private diagnostics,
and provide **Scan this image anyway** as an unconditional override. The
thresholds are measured tuning parameters, not a claim that small images never
contain text.

#### Offscreen compute execution

Add one bundled `offscreen.html` entrypoint and the required `"offscreen"`
manifest permission. The service worker calls `runtime.getContexts()` before
dispatch, creates the document with reason `WORKERS` when absent, and remains a
short-lived router. The offscreen Window owns the bounded queue and creates one
local module Worker per lazily selected provider implementation. Start with a
global concurrency of one expensive inference job; visible work may preempt
queued background work, but active provider work is normally allowed to finish
and is revision-rejected if stale.

Transformers.js, Tesseract.js, and PaddleOCR.js therefore do not block the side
panel event loop or depend on the panel staying open. The design still tolerates
offscreen/Worker loss: job descriptors carry document, page, image, pixel,
language, provider-policy, and model revisions; the host can be recreated; and
one bounded retry is allowed. Terminating a provider Worker is the deterministic
way to release its Wasm/ONNX/WebGPU/model memory. Prompt stays in a visible
extension Window, and TextDetector may run in a dedicated Worker only after its
actual implementation proves that exposure; otherwise its adapter probes the
offscreen Window.
([Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
[extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle))

### Development Workflows and Tooling

Keep the current Node 24, npm, WXT, TypeScript, Vitest, and Manifest V3
baseline. Pin new runtime dependencies exactly and commit the lockfile. The
rrweb spike should use split recorder/replayer packages so each extension
entrypoint pays only for its own code:

```json
{
  "@rrweb/record": "2.1.0",
  "@rrweb/replay": "2.1.0",
  "tesseract.js": "7.0.0",
  "@huggingface/transformers": "4.2.0",
  "@paddleocr/paddleocr-js": "0.4.2"
}
```

The last two dependencies are spike candidates and appear only in build
profiles whose compile-time provider flag is enabled. Do not top-level import
Transformers.js from a WXT-discovered entrypoint; import its browser build from
the provider's Vite-bundled module Worker so Node-only package paths are not
pulled into entrypoint discovery.

Keep all platform APIs behind adapters with deterministic fakes:

- fake Translator and Language Detector providers for unit tests;
- fake Prompt availability, download, schema result, abort, and failure states;
- fake compiled-provider registry, capability probes, Workers, and model loaders
  for scheduler/fallback tests; and
- legacy and rrweb capture/replica providers behind the same protocol.

The fast loop is `npm run dev` with local deterministic fixtures. Every merge
candidate must run a clean install, `npm run check`, a production build,
production-output browser tests, and artifact inspection. Built-in AI must also
be exercised in a normal Chrome profile because WXT's disposable development
profile and launch flags can differ from a user's model state.
([WXT browser startup](https://wxt.dev/guide/essentials/config/browser-startup.html),
[WXT end-to-end testing](https://wxt.dev/guide/essentials/e2e-testing),
[Chrome extension testing](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing))

### Testing and Quality Assurance

Quality assurance should separate deterministic correctness from model quality.

Deterministic unit/contract coverage includes:

- protocol validation, ordering, gap recovery, generations, and stale-result
  rejection;
- replica sanitization, translation projection, source-value caching, and
  privacy exclusions;
- image identity, revision, coordinate conversion, provider selection,
  cancellation, fallback, and cache eviction;
- all saved provider permutations, compile-registry filtering, capability
  skips, boxes-only hint chaining, first-acceptable-result semantics, and no
  concurrent five-provider fan-out;
- all three scan policies, visible promotion, post-checkpoint quiet gate,
  small-image decisions, manual override, and dynamic-image invalidation;
- bundled catalog/hash validation and provider Worker termination on language,
  model, idle, and host change;
- offscreen creation races, service-worker sleep, panel closure, context loss,
  one bounded retry, and stale result rejection;
- Prompt availability matrices and exact preservation of the two independent
  user settings; and
- no Prompt request after either option is disabled or its source generation
  becomes stale.

Browser fixtures must cover Latin, Japanese horizontal/vertical, Korean,
Simplified/Traditional Chinese, Cyrillic, Arabic/right-to-left, Devanagari,
Bengali, Kannada, Tamil, and Telugu. Include tiny text, curved text, low
contrast, animation, responsive images, changed image content at a stable URL,
and mixed-language images.

Measure the providers rather than assuming one is superior:

- language/script top-1 and top-3 accuracy;
- character and word error rate against a checked transcript;
- hallucinated-character and omitted-line rate;
- box intersection-over-union and translated overlay alignment;
- warm/cold latency, peak worker memory, cancellation time, and model-download
  behavior; and
- fallback rate by Chrome version, device capability, language, and image class.

Publish results by exact engine/model/backend rather than library name alone.
Transformers fixtures must distinguish crop recognition from scene-text
detection. Paddle fixtures must cover line polygons, unsupported-script
fallthrough, forced-Wasm/offline startup, and vertical/rotated text. A standard
Chrome build must treat TextDetector and Screen AI unavailability as expected,
while separately proving their adapters fail closed.

Prompt output is acceptable only after schema validation and source-generation
validation. It must preserve an explicit `unknown` result instead of guessing.
Short image labels are also weak evidence for Chrome Language Detector, so low
confidence remains unknown and never triggers an unbounded model fan-out.
The system instruction must treat words inside the image as untrusted data,
ignore any visual instructions, transcribe only visible characters, and omit
uncertain characters rather than invent them. No Prompt session receives tools,
navigation, or privileged extension actions.
([Chrome Language Detector](https://developer.chrome.com/docs/ai/language-detection),
[Prompt structured output](https://developer.chrome.com/docs/ai/prompt-api#pass-a-json-schema))

Playwright production-extension tests should verify fresh install, active-tab
grant, persistent optional grants, navigation/revocation, BFCache, popup/side
panel/detached companion lifecycles, and forced MV3 worker termination. Real
Chrome acceptance should retain the Mexico City and Reddit targets while all
blocking assertions live in deterministic local fixtures.
([Playwright Chrome-extension testing](https://playwright.dev/docs/chrome-extensions),
[service-worker termination testing](https://developer.chrome.com/docs/extensions/how-to/test/test-serviceworker-termination-with-puppeteer))

### Deployment and Operations Practices

Package all executable JavaScript, module Workers, WebAssembly, and enabled
ONNX graphs locally. Remote Tesseract traineddata is treated as a finite,
pinned, integrity-checked, reviewable data catalog. No prompt, model, or error
path may download JavaScript or Wasm, and Store builds must not execute an
arbitrary remote ONNX model.
([Chrome remote-hosted-code policy](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code),
[Manifest V3 Web Store requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements))

Release testing should cover Chrome for Testing M138 and current Stable as
blocking targets, with current Beta as a non-blocking early warning until its
promotion approaches. Prompt image tests additionally require M148+ and a real
eligible device; unsupported Prompt capability is a valid expected state, not
a release failure. The default build keeps working through its compiled
Tesseract baseline on every supported browser. TextDetector and Screen AI may
truthfully remain unavailable.

The production ZIP must be created from the exact tested output, unpacked and
validated, byte-compared with that output, and recorded with version and
SHA-256. Artifact budgets must report application code separately from OCR
engine/model assets so the intentional language catalog does not obscure an
unexpected JavaScript increase.

Local diagnostics may report compiled provider IDs, effective/attempted order,
availability, scheduling tier, skip reason, language code, timings, bounded
error codes, and model/catalog versions. They must not contain source images,
OCR text, translations, URLs, form values, or browsing history. All enabled OCR
and Prompt processing remains on device; remote page images can still cause
network requests and must be disclosed accurately.

### Team Organization and Skills

The project remains suitable for a small team, but ownership boundaries should
be explicit:

- replica/protocol ownership: rrweb adapters, sanitization, navigation, and
  fidelity fixtures;
- language ownership: translation cache, language routing, model catalog, and
  provider contracts;
- image ownership: capture eligibility, OCR/Prompt schedulers, coordinates,
  overlays, and quality evaluation; and
- release ownership: permission matrix, privacy declarations, artifact
  inspection, browser compatibility, and rollback.

Required working knowledge includes DOM/CSS layout, extension isolation and
permissions, Web Workers/Wasm lifecycle, BCP 47 and Tesseract language codes,
OCR evaluation, generative-model evaluation, Playwright extension testing, and
Chrome Web Store privacy policy. Code review should require a second reviewer
for permission changes, page-data handling, relaxed sanitization, model-host
changes, and Prompt-output trust decisions.

### Cost Optimization and Resource Management

The selected Translator, Language Detector, local OCR providers, and Prompt
paths have no per-request API fee. Their real costs are install bytes,
Chrome-managed model downloads, latency, memory, battery, and
engineering/release effort.

Resource controls should include:

- one global expensive OCR lane in the offscreen host and only the selected
  provider/model loaded lazily; terminate/recreate on incompatible group,
  provider change, idle timeout, failure, or memory pressure;
- one bounded Prompt session owned by the visible companion and destroyed on
  disable, navigation, memory pressure, or idle timeout;
- IntersectionObserver tiering with visible promotion, bounded background
  prescan, and eager enqueue that never means eager model loading;
- default-on conservative small-image filtering with explicit per-image
  override;
- content-hash plus provider/model/prompt-version cache keys;
- no reprocessing when only replica layout changes and image pixels do not;
- model-download progress and cancellation from an explicit gesture; and
- bounded IndexedDB quotas with inspect, remove-language, and clear-all UI.

Chrome's foundation-model APIs require substantial device eligibility: at
least 22 GB free profile-volume storage, more than 4 GB VRAM for GPU execution
or at least 16 GB RAM and four CPU cores for CPU execution, plus an unmetered
initial model download. These requirements make Prompt optional even on a
modern Chrome version.
([Prompt API hardware requirements](https://developer.chrome.com/docs/ai/prompt-api#review-the-hardware-requirements))

### Risk Assessment and Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| rrweb cannot reproduce a target feature safely | Fidelity gap or unsafe behavior | Adapter, feature flag, protected iframe, deterministic fixtures, legacy fallback |
| Prompt image API is absent or hardware-ineligible | Experimental options unavailable | Feature-detect exact modality; keep ordered OCR chain functional and explain status |
| Prompt returns fluent but incorrect text | Misleading image translation | Verbatim schema, `unknown`, confidence/quality gates, provider comparison/fallback |
| Prompt supplies plausible but inaccurate boxes | Misaligned overlays | Never trust generative geometry; use validated spatial-provider geometry or an image-level result |
| Tesseract models accumulate after switches | Memory growth/crash | Terminate/recreate worker by exact group; cap concurrency at one |
| TextDetector is flag-disabled or returns boxes only | First provider cannot complete OCR | Real capability probe, visible unavailable status, reuse boxes as hints, continue exact order |
| Transformers recognizer receives an uncropped scene | Bad transcript and no geometry | Advertise recognition-only capability; require validated regions for spatial mode |
| PaddleOCR.js 0.x fails MV3 CSP/Worker/offline behavior | Provider unavailable or Store rejection | Forced local Wasm spike, vendor/patch remote defaults, artifact scan, next-provider fallback |
| Offscreen or provider Worker is discarded mid-job | Lost/late work | Restartable host, persisted descriptors, revision checks, one bounded retry |
| Compile-disabled provider leaks code/assets/default URLs | Larger or noncompliant artifact | Generated import/asset/permission manifests plus per-profile artifact absence tests |
| Screen AI appears selectable despite no public API | Dead option or unsupported private integration | Compile it out; enable only for a documented public API and fail closed |
| Prescan/eager mode consumes excessive CPU/battery | Browsing slowdown | Global capacity one, visible preemption, pause controls, idle/quiet gates, measurements |
| Small-image heuristic skips meaningful text | Missed overlay | Conservative two-dimensional rule, diagnostics, responsive reevaluation, manual override |
| Broad provider/model catalog inflates release artifact | Slow install/review | Independent compile profiles and asset budgets; include only selected provider models |
| Image language is ambiguous within one script | Wrong OCR model | Page/element context first, optional Prompt/OSD hint, validate OCR text, one bounded retry |
| Source image is inaccessible because of CORS/auth | Missing OCR overlay | Reuse authorized captured bytes where possible; explicit unsupported marker; no privilege escalation |
| Navigation or mutation completes stale AI work | Wrong page receives result | Document/source generation on every job and commit; abort and reject stale results |
| Permission or data disclosure drifts from behavior | Store rejection/user trust loss | Release-blocking manifest/privacy diff and network trace |

## Technical Research Recommendations

### Implementation Roadmap

1. Establish characterization fixtures, the normalized OCR capability/result
   contract, five stable provider IDs, build-flag schema, generated compiled
   registry/manifests, protocol v2, and deterministic fakes.
2. Move the replica into the protected source-sized iframe and integrate the
   rrweb recorder/replayer behind a reversible development flag.
3. Complete incremental translation, language-change automation, phrase cache,
   navigation/access reconciliation, and detached-companion lifecycle.
4. Add source-frame IntersectionObservers, the three scan policies, queue tiers,
   quiet/background gate, dynamic revisioning, small-image heuristic, and manual
   override.
5. Add the required offscreen compute host, global bounded scheduler, restart
   protocol, and Tesseract module with the broad 21-language catalog, hashing,
   geometry, and deterministic fixtures.
6. Add the Chrome TextDetector module as an experimental capability/boxes
   provider with automatic skip and downstream region hints.
7. Spike the compile-selected Transformers.js 4.2.0 module with local Wasm and
   one exact crop-recognition model; prove local/offline build, geometry
   composition, latency, memory, and Worker teardown before enabling by default.
8. Spike official PaddleOCR.js 0.4.2 with `worker: true`, forced local Wasm,
   local PP-OCRv6-tiny assets, line polygons, and compiled-output remote-URL
   removal before enabling by default.
9. Add the two Prompt sidecar switches, schema/capability/download UX, and
   image-translation overlays using only validated provider geometry. Keep the
   Screen AI module compiled out until Chrome publishes a supported API.
10. Run the all-enabled/default/each-single-provider build matrix, production
    browser automation, multilingual model evaluation, permission/privacy
    audit, artifact synchronization, staged Store release, and rollback.

### Technology Stack Recommendations

- Keep Node 24, npm, WXT 0.20.27, strict TypeScript, Manifest V3, and Vitest.
- Adopt exact `@rrweb/record` and `@rrweb/replay` 2.1.0 behind Simul adapters.
- Adopt Tesseract.js 7.0.0 with locally packaged LSTM core/worker and pinned
  `tessdata_fast` assets.
- Add a required Chrome offscreen `WORKERS` host and source-owned Intersection
  Observer scheduler with three persisted scan policies.
- Generate provider imports, asset manifests, permissions/CSP, and notices from
  five independent build flags. Ship Tesseract in the default profile; treat
  TextDetector as opportunistic, Transformers.js 4.2.0 and PaddleOCR.js 0.4.2 as
  prototype-gated, and Chromium Screen AI as compile-disabled.
- For enabled Transformers/Paddle builds, package exact module Workers, ONNX
  Runtime Wasm, and selected models locally and disable every remote runtime or
  arbitrary-model path.
- Use Chrome Translator and Language Detector from the visible companion with
  deterministic fallbacks and persistent translation memory.
- Use Chrome Prompt image input only through the two explicit experimental
  preferences; retain M138 as the extension baseline and feature-detect M148+
  multimodal support.
- Use IndexedDB for bounded translation/OCR/model caches and `chrome.storage`
  only for small durable preferences and access mode.
- Use Playwright against the production Chrome MV3 output, supplemented by
  current Stable real-profile tests for built-in AI.

### Skill Development Requirements

- Build and maintain a checked multilingual image corpus with legal provenance,
  reference transcripts, language labels, and geometry.
- Learn character/word error rate, box alignment, calibration, hallucination,
  and fallthrough analysis rather than judging OCR by anecdotal screenshots.
- Practice Chrome extension permission/revocation and lifecycle testing across
  navigation, BFCache, tab replacement, and persistent side-panel contexts.
- Maintain Wasm/model artifact inspection, license notices, deterministic
  compression, and SHA-256 catalog generation.
- Learn WXT/Vite module-Worker output, generated build registries, Chrome
  offscreen lifecycle, ONNX Runtime Wasm/WebGPU memory behavior, and production
  artifact absence testing.
- Treat generative visual interpretation as an untrusted provider whose output
  is parsed, validated, measured, and replaceable.

### Success Metrics and KPIs

Initial blocking release targets are:

- zero unexpected source-page mutations, script execution, navigation, form
  submission, remote executable loads, or stale-generation commits;
- 100% deterministic convergence for replica mutation fixtures and no full
  rebuild for image-only or bounded text changes;
- key replica geometry within 1 CSS pixel and document/scroll extent within 1%
  on core fixtures;
- initial replica p95 at or below 2 seconds for the fixed 5,000-node fixture and
  mutation-to-replica p95 at or below 500 ms;
- 100% worker termination/recovery and provider-fallback tests passing;
- 100% exact persistence/reconciliation of provider order and deterministic
  behavior for visible-only, background-prescan, and eager-all policies;
- 100% of disabled providers absent from code chunks, Workers, models/Wasm,
  settings, permissions/CSP additions, and notice payloads in every build
  profile;
- bundled OCR language/model/provider manifests, checksums, licenses, and byte
  budgets matching the production artifact exactly;
- zero heavy inference on the side-panel or service-worker event loop, and 100%
  recovery tests for panel close, service-worker sleep, offscreen loss, and
  provider-Worker loss;
- no small-image skip can defeat the manual override, and measured false-skip
  rates are published before thresholds become less conservative;
- no Prompt invocation when its corresponding setting is off, and 100% correct
  fallback behavior across unavailable, downloadable, downloading, available,
  abort, malformed, timeout, and stale states;
- measured results published by exact provider/model/backend for every declared
  script/image class; Transformers never passes a spatial test without detector
  geometry, and Paddle never advertises an unmeasured language;
- zero captured password/form/contenteditable values and zero page content in
  durable diagnostics; and
- 100% pass on Chrome M138/current Stable access and lifecycle suites, with
  Prompt-image acceptance on at least one eligible M148+ GPU device and one
  eligible CPU device before advertising the experimental capability broadly.

**Implementation conclusion:** use five stable, independently compiled provider
modules and a user-ordered, capability-filtered chain. Ship the broad lazy
Tesseract catalog as the dependable default; include experimental TextDetector
only opportunistically; prototype locally packaged Transformers.js crop OCR and
official PaddleOCR.js-Wasm behind their own flags; and keep Chromium Screen AI
compiled out until Chrome exposes a supported API. Run heavy work through a
restartable offscreen Worker host, schedule it by the user's three visibility
policies, and keep the two Prompt options as separate untrusted sidecars. Only
validated spatial-provider geometry may position translated overlays.

---

# Research Synthesis and Strategic Technical Conclusions

## Executive Summary

Simul's core challenge is not translation alone. It must preserve the layout,
CSS, responsive behavior, controls, sidebars, media, and current state of an
authorized live page while guaranteeing that the original page is not modified
and that the copy cannot execute the site's scripts. Periodic screenshots or
reconstructed visual trees cannot meet that fidelity goal consistently. The
recommended foundation is a document-scoped rrweb recorder feeding ordered,
revisioned operations into a protected, source-sized replica iframe. Translation
and image overlays are derived projections over that replica, never mutations
of the canonical source stream.

Text translation remains local through Chrome Translator and Language Detector,
with explicit first-use model preparation, automatic translation after a pair
is ready, exact phrase reuse, persistent bounded caches, and generation checks.
Navigation and access are reconciled against actual Chrome grants: `activeTab`
is temporary, while optional host permission supports deliberate persistent
access. A detached extension companion is safe; a separately labeled duplicated
live-site window offers higher runtime fidelity but executes the website again.

Image translation uses five stable OCR provider IDs in a user-controlled order:
Chrome TextDetector, Tesseract.js, Transformers.js, PaddleOCR-Wasm, and Chromium
Screen AI. Four are technically implementable in stock Chrome today; Screen AI
is internal Chromium C++/Mojo infrastructure and remains compile-disabled until
a public API exists. Each provider is an independent build module, and disabled
modules and assets are absent from the package. Heavy inference runs through a
restartable offscreen document and dedicated provider Workers. Source-owned
IntersectionObservers implement visible-only, visible-first background prescan,
or eager-all scheduling without loading every model at once.

### Key Technical Findings

- Ordered DOM/CSS/state events provide materially better fidelity and efficiency
  than periodic subtree or full-page reconstruction.
- A script-disabled, source-sized iframe preserves layout while isolating site
  behavior; zoom belongs outside the iframe so responsive breakpoints remain
  tied to the source viewport.
- Translation and OCR need separate revisioned lanes and caches; an image-only
  change must not trigger text translation or replica regeneration.
- Chrome's offscreen document is a suitable Worker host but not an immortal
  service. Jobs require versioned descriptors, bounded retry, and stale-result
  rejection. ([Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen))
- `TextDetector` remains experimental and must be capability-probed and skipped
  automatically when unavailable. ([Chrome Shape Detection status](https://developer.chrome.com/docs/capabilities/shape-detection))
- Transformers.js can provide specialized crop recognition through local Wasm
  or WebGPU, but common OCR models such as TrOCR do not detect scene-text boxes.
  ([Transformers.js](https://huggingface.co/docs/transformers.js/main/index),
  [image-to-text OCR guidance](https://huggingface.co/tasks/image-to-text))
- Official PaddleOCR.js now supplies browser detection, recognition, line
  polygons, Workers, and a Wasm backend, but its 0.x MV3 integration requires a
  production spike. ([PaddleOCR.js SDK guide](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md))
- Chromium Screen AI cannot be called, redistributed, or compiled to Wasm by a
  stock extension today; its open tree contains browser integration around an
  internally delivered native component. ([Chromium Screen AI README](https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/screen_ai/README.md),
  [Screen AI service README](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/services/screen_ai/README.md))

### Strategic Recommendations

1. Complete live replica correctness before allowing adaptive translated-text
   resizing or other layout-changing conveniences.
2. Ship Tesseract as the dependable OCR baseline and make every other provider
   capability-driven and removable at compile time.
3. Add the offscreen compute host and visibility scheduler before adding heavy
   Transformers/Paddle models, so lifecycle and resource controls exist first.
4. Package every executable runtime and enabled ONNX graph locally; reject
   arbitrary remote models and verify the built artifact, not only source code.
5. Measure providers by exact model, backend, language, geometry, latency,
   memory, and image class before changing defaults.

## Table of Contents

1. Technical Research Introduction and Methodology
2. Technical Landscape and Architecture Analysis
3. Implementation Approaches and Best Practices
4. Technology Stack Evolution and Current Direction
5. Integration and Interoperability Patterns
6. Performance and Scalability Analysis
7. Security and Compliance Considerations
8. Strategic Technical Recommendations
9. Implementation Roadmap and Risk Assessment
10. Future Technical Outlook and Innovation Opportunities
11. Technical Research Methodology and Source Verification
12. Technical Appendices and Reference Materials

## 1. Technical Research Introduction and Methodology

### Technical Research Significance

Web applications increasingly derive their visible state from client-side
frameworks, runtime CSS, shadow DOM, media, and incremental network activity.
Reconstructing only text and a subset of computed styles produces a recognizable
page but not a faithful second view. Simul therefore needs a browser-native
replication architecture whose primary invariant is that the source remains
untouched while the companion converges on the same authorized state.

Local translation and OCR improve privacy and remove per-request API cost, but
they introduce model downloads, memory pressure, device variability, Worker
lifecycle, and Chrome Web Store packaging constraints. The research treats
these as architectural inputs rather than post-implementation optimizations.

### Technical Research Methodology

- **Scope:** live DOM/CSS/state capture, inert replay, incremental translation,
  caching, navigation/access, scroll/zoom/popout behavior, local image OCR,
  visibility scheduling, offscreen execution, security, and release operations.
- **Sources:** current primary documentation and source repositories from
  Chrome, Chromium, W3C, rrweb, WXT, Tesseract.js, Hugging Face, ONNX Runtime,
  and PaddleOCR.
- **Analysis:** compare technical feasibility, runtime ownership, fidelity,
  security, performance, packaging, failure recovery, and migration cost.
- **Evidence discipline:** distinguish shipped APIs from drafts, model-specific
  behavior from library-level claims, and measured asset sizes from runtime
  memory. Experimental capabilities remain explicitly gated.
- **Research period:** current verification through 2026-07-20, with exact
  versions or source revisions recorded where implementation depends on them.

### Achieved Objectives

- Selected a high-fidelity safe replica architecture and incremental protocol.
- Explained Spanish first-use translation behavior and cross-origin access loss.
- Defined bounded translation and OCR reuse without storing private page data.
- Designed five independent OCR modules, provider ordering, fallthrough, and
  build-time exclusion.
- Defined offscreen execution, three visibility policies, small-image skipping,
  and safe pixel handoff.
- Established acceptance tests for the Mexico City carousel, Reddit rails,
  navigation, popout, zoom, scrolling, multilingual OCR, and lifecycle recovery.

## 2. Technical Landscape and Architecture Analysis

### Selected Architecture

Simul remains a client-only Manifest V3 modular monolith. Runtime responsibilities
are separated without introducing a backend:

```text
UNTRUSTED / AUTHORIZED SOURCE                 TRUSTED EXTENSION ORIGIN

Source document
  └─ isolated recorder + visibility scheduler === ordered Port ===> ReplicaSession
       ├─ rrweb checkpoint/events                                 ├─ validation/ACK
       ├─ stable node identity                                    ├─ SourceValueModel
       └─ image revisions/tiers                                   ├─ translation projection
                                                                  └─ RrwebReplicaEngine
                                                                           |
                                                                           v
                                                             script-inert replica iframe

EPHEMERAL CONTROL                           LOCAL COMPUTE / STORAGE

MV3 service worker                          chrome.storage.local preferences
  ├─ launch/access routing                  IndexedDB bounded caches/blob handoff
  ├─ optional permission reconciliation    Chrome Translator/Language Detector
  └─ ensure offscreen compute host ======> OffscreenComputeHost
                                               ├─ bounded priority queue
                                               ├─ TextDetector probe/adapter
                                               ├─ Tesseract Worker
                                               ├─ Transformers Worker
                                               └─ PaddleOCR-Wasm Worker
                                             Prompt: visible-Window sidecar
                                             Screen AI: compiled out
```

### Architectural Trade-offs

| Pattern | Fidelity | Safety | Decision |
|---|---:|---:|---|
| rrweb live recorder + protected Replayer | High | High with validation/scripts disabled | Primary |
| Custom computed-style dirty subtrees | Medium ceiling | Strong existing allowlist | Migration fallback |
| Duplicated real site window | Highest runtime fidelity | Re-executes site and side effects | Explicit experiment |
| External-site iframe | Site-dependent | Framing/SOP failures | Reject |
| Screenshot stream | Pixel-faithful viewport only | No semantic/selectable DOM | Pixel/OCR fallback |

### Core Invariants

- The default mode never writes to the source DOM.
- Node identity is scoped to document, navigation, and checkpoint generations.
- No delta crosses a sequence gap or applies before a valid checkpoint.
- Source values remain canonical; translations are reversible projections.
- Every async result is revision-current before cache or visual commit.
- The replica iframe never executes site scripts or unsafe canvas replay.
- All queues, buffers, snapshots, caches, sessions, and model lifetimes are
  explicitly bounded.
- A compile-disabled OCR provider contributes nothing to the artifact or UI.

## 3. Implementation Approaches and Best Practices

### Live Capture and Replay

Inject one packaged document-scoped recorder under `activeTab` or an explicit
optional grant. Use a named Port, protocol version, page/document identity,
monotonic sequence, acknowledgements, bounded batches, and checkpoint recovery.
Coalesce safe scalar writes while preserving structural add/move/remove order.

A full checkpoint builds inside a hidden staging iframe. Contiguous queued
deltas apply before one atomic swap, avoiding a half-built page. The renderer
uses a source viewport in CSS pixels; fit/custom zoom transforms its wrapper,
and one-to-one mode exposes real extension-owned overflow.

### Translation

Maintain one Translator session and sequential queue per active language pair.
The language-control gesture prepares a pair when Chrome requires first-use
download activation. Once ready, translate current source records and all later
revisions automatically. Pair changes increment an epoch and reproject existing
source text without recapture. ([Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api))

### OCR Provider Modules

```text
lib/ocr/
  contracts.ts
  known-provider-ids.ts
  compiled-provider-registry.ts        # generated for this build
  coordinator.ts
  scheduling/
    visible-only.ts
    background-prescan.ts
    eager-all.ts
    small-image-policy.ts
  providers/
    chrome-text-detector/
    tesseract/
    transformers/
    paddleocr-wasm/
    chromium-screen-ai/
```

Each provider owns capability metadata, probing, normalization, lazy runtime,
Worker entry, assets/models, timeouts, disposal, tests, and notices. Shared code
depends only on contracts. A generated registry imports only enabled modules and
produces the matching assets, permission/CSP, settings, and notice manifests.

The coordinator preserves the saved provider order. It skips hard-unavailable
modules without loading them and falls through sequentially on initialization
failure, timeout, unsupported language/task, empty text, boxes-only output,
strong language mismatch, or failed quality gates. Boxes-only output may become
region hints. The first acceptable result wins; providers do not race.

### Provider Adoption

- **TextDetector:** small experimental adapter, real probe, automatic skip;
  boxes may be reusable even when recognition is absent.
- **Tesseract.js 7.0.0:** default spatial baseline; lazy exact-language group;
  terminate/recreate on language-group change to release accumulated models.
- **Transformers.js 4.2.0:** prototype crop recognizer with local runtime and
  model, Wasm baseline and conditional WebGPU; no invented scene geometry.
- **PaddleOCR.js 0.4.2:** prototype official SDK with `worker: true`, forced
  `backend: "wasm"`, local ORT/OpenCV/model assets, and line polygons.
- **Chromium Screen AI:** stable future ID, compile-disabled; only a documented
  Web/extension API may activate it.

### Visibility and Small-image Policy

- **Visible-first background prescan:** visible jobs first, optional near-viewport
  prewarm, then low-priority eligible images after replica commit, page load,
  visible translation idle, and a mutation-quiet interval.
- **Visible-only:** enqueue on actual viewport intersection.
- **Eager-all:** enqueue all eligible images promptly while retaining visible
  priority and bounded concurrency.

IntersectionObserver is asynchronous and deliberately not pixel-perfect
occlusion detection; it is a queue-priority signal. ([Intersection Observer](https://w3c.github.io/IntersectionObserver/))

The default small-image heuristic always skips zero/one-pixel trackers and
conservatively filters icon-sized candidates using rendered area, longest side,
and intrinsic dimensions. A manual per-image command overrides all filters.

## 4. Technology Stack Evolution and Current Direction

| Concern | Selected direction |
|---|---|
| Language/runtime | Strict TypeScript, Node 24, Chrome MV3 |
| Extension build | WXT 0.20.27 and Vite-bundled entrypoints/Workers |
| Replica | rrweb 2.1.x behind Simul validation/projection adapters |
| Text AI | Chrome Translator and Language Detector |
| Image baseline | Tesseract.js 7.0.0 + pinned `tessdata_fast` catalog |
| Experimental OCR | TextDetector, Transformers.js 4.2.0, PaddleOCR.js 0.4.2 |
| Future OCR | Chromium Screen AI adapter, disabled pending public API |
| Heavy compute | Static Chrome offscreen document + module Workers |
| Preferences | `chrome.storage.local` |
| Results/models | Bounded extension-origin IndexedDB and packaged assets |
| Testing | Vitest, browser adapters, Playwright production-extension tests |

Transformers.js normally uses hosted models/runtime assets, so enabled builds
must disable remote models and point all runtime/model paths at packaged files.
([Transformers.js custom models](https://huggingface.co/docs/transformers.js/custom_usage))
PaddleOCR.js likewise needs explicit local `wasmPaths`, local model archives,
and removal of unused remote defaults from compiled output.

The Tesseract base catalog contains 21 user languages in 22 separately compressed
models covering Latin, CJK, Cyrillic, Arabic/Hebrew, and selected South Asian
scripts. Models remain on disk until selected. Additional verified traineddata
can be installed without a Simul server, while arbitrary remote ONNX execution
remains excluded from Store builds.

## 5. Integration and Interoperability Patterns

### Source-to-controller Protocol

Use JSON-safe discriminated envelopes containing protocol version, session,
page epoch, document/frame identity, sequence, and typed payload. Keep chunks far
below Chrome's hard message ceiling and bound aggregate snapshot size/time.
Chrome serializes extension messages as JSON, so binary screenshot crops use a
transient IndexedDB Blob handoff rather than expanded runtime messages.
([Chrome message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging))

### Pixel Acquisition

1. Use same-origin or CORS-readable image bytes.
2. Use extension fetch only for an already-granted asset origin.
3. Use throttled `captureVisibleTab()` and a revision-checked crop.

An off-viewport unreadable cross-origin image cannot be background-captured;
it waits until visible. Scheduling policy never expands permissions.

### Navigation and Access

`activeTab` supports the invoked origin temporarily and is lost on cross-origin
navigation. Optional host permissions persist until revoked. Reconcile saved
access intent against `permissions.contains()` at startup, navigation, and
permission removal; never describe a revoked or origin-mismatched grant as a
random injection failure. ([Chrome `activeTab`](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab),
[Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions))

### Popout and Live-site Modes

A detached extension page can own the same safe replica session. A separate
experimental mode may duplicate the source tab and move it into a popup window
for maximum runtime fidelity. That mode runs the site again, may repeat network
effects, and requires persistent access before translation injection.

## 6. Performance and Scalability Analysis

The principal scaling strategy is incremental `O(delta)` synchronization.
Image, style, or bounded text changes update only their affected records and
visual nodes. Full checkpoints occur on navigation, desynchronization, or an
explicit recovery boundary—not on timers.

Resource controls include:

- one retained Translator session and sequential translation lane;
- one global expensive OCR lane in the offscreen host initially;
- visible work ahead of queued background OCR;
- lazy provider/model loading and deterministic Worker teardown;
- exact phrase and image-pixel hashes, in-flight deduplication, and negative
  no-text caching;
- crop-before-inference, image megapixel limits, capture throttling, job
  watchdogs, and short provider idle timeouts;
- prompt disposal and model-download UX; and
- bounded IndexedDB bytes, entries, TTL, LRU cleanup, clear controls, and no
  persistent cache in incognito.

Release evaluation reports exact engine, model, backend, language, image class,
cold/warm latency, peak memory, character/word error rate, hallucinations,
omissions, geometry IoU, overlay alignment, and fallthrough rate. Library-wide
accuracy claims are insufficient.

## 7. Security and Compliance Considerations

The source bridge and all page-derived data are untrusted. Validate sender
identity, protocol, sequence, types, sizes, depth, counts, URLs, CSS, and total
allocation before reconstruction. Never use raw `innerHTML`, `document.write`,
`eval`, executable URLs, site event handlers, or site scripts. Neutralize forms,
navigation, nested frames, objects, embeds, downloads, and popups in the replica.

The manifest retains `activeTab`, `scripting`, `sidePanel`, and `storage`, adds
`offscreen` solely for the `WORKERS` compute host, and keeps HTTP(S) hosts
optional. The extension CSP remains self-only with only the required
`wasm-unsafe-eval` and self Worker allowance.

All JavaScript, module Workers, Wasm, and enabled ONNX computation graphs are
packaged. MV3 prohibits remotely hosted executable code, and production
validation must scan built files for fallback CDN/runtime/model paths.
([Chrome remote-hosted-code policy](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code),
[extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy))

Do not persist passwords, private controls, input/textarea/contenteditable or
composer values, raw screenshots beyond the transient offscreen handoff, page
URL history, or user identifiers. Diagnostics contain only bounded provider,
version, timing, scheduling, skip, cache, and error metadata.

## 8. Strategic Technical Recommendations

### Architecture Strategy

- Complete faithful live replication first; postpone adaptive font/box resizing
  until geometry parity is demonstrated.
- Keep capture, canonical source values, translation, recognition, and overlay
  translation as separate revisioned lanes.
- Treat rrweb and every AI/OCR engine as an adapter behind Simul contracts, not
  as the owner of product policy.
- Use last-good-state degradation: translation or OCR failure must never blank
  or rebuild a healthy replica.

### OCR Strategy

- Ship Tesseract as the dependable default provider.
- Keep TextDetector compiled only as an opportunistic platform adapter.
- Enable Transformers only for measured crop-recognition roles with external
  validated regions.
- Enable Paddle only after the exact WXT/MV3 local-Wasm build passes offline,
  lifecycle, memory, language, geometry, and artifact audits.
- Preserve Screen AI's stable ID/module but omit it from release builds until a
  public API and redistribution terms exist.
- Keep Prompt language and interpretation switches independent and default-off;
  never trust generative coordinates.

### Build Strategy

Generate provider imports and asset/permission/CSP/notice manifests rather than
relying solely on tree shaking. Test default, all-enabled research, and every
single-provider profile. A disabled provider's code, assets, URLs, settings,
permissions, and notices must all be absent.

## 9. Implementation Roadmap and Risk Assessment

### Recommended Roadmap

1. Establish characterization fixtures, normalized OCR contracts, five stable
   IDs, build flags, generated registries, and deterministic platform fakes.
2. Introduce rrweb record/replay behind the protected source-sized adapter and
   keep the current renderer as a labeled migration fallback.
3. Complete incremental translation, pair preparation, persistent exact phrase
   memory, navigation/access reconciliation, scroll/zoom, and detached view.
4. Add source-owned IntersectionObservers, the three scan policies, dynamic
   image revisioning, small-image filtering, and manual override.
5. Add the offscreen host, transient Blob handoff, restart protocol, bounded
   scheduler, and Tesseract spatial baseline.
6. Add TextDetector capability/boxes behavior.
7. Spike local Transformers crop recognition and detector composition.
8. Spike official PaddleOCR.js with forced local Wasm and PP-OCRv6-tiny.
9. Add Prompt sidecars and translated overlays using validated geometry only.
10. Run the build matrix, multilingual evaluation, target-site acceptance,
    permission/privacy audit, artifact synchronization, and staged release.

### Risk Matrix

| Risk | Impact | Primary mitigation |
|---|---|---|
| rrweb fidelity/sanitization gap | Incorrect or unsafe replica | Adapter, fixtures, protected iframe, legacy fallback |
| TextDetector unavailable/boxes-only | First provider cannot finish | Real probe, diagnostics, hint reuse, ordered fallback |
| Transformers sees an uncropped scene | Bad transcript/no geometry | Recognition-only capability; require regions |
| PaddleOCR.js 0.x build/runtime issue | Provider disabled or Store failure | Forced local-Wasm spike and artifact scan |
| Offscreen/Worker loss | Lost or late job | Restartable host, revisions, one bounded retry |
| Provider asset leakage | Large/noncompliant package | Generated manifests and absence tests |
| Screen AI private-only | Dead or unsafe option | Compile out until documented public API |
| Eager/prescan resource use | Browsing slowdown | Capacity one, visible preemption, quiet gates, pause |
| Small-image false skip | Missed text | Conservative rule, measurement, unconditional override |
| CORS/auth image restriction | Missing overlay | Existing authorized bytes or visible capture; no escalation |
| Stale async result | Wrong-page overlay | Full page/image/provider revision checks |

## 10. Future Technical Outlook and Innovation Opportunities

### Near-term

- Benchmark PP-OCRv6 tiny against Tesseract for Latin and CJK scene text.
- Evaluate English TrOCR and specialized Japanese manga recognition only on
  validated text-region crops.
- Tune small-image and background-prescan heuristics against a checked corpus.
- Measure offscreen lifecycle, WebGPU/Wasm fallback, and model memory on low-
  and mid-range devices.

### Medium-term

- Add verified Tesseract language packs and, only after policy review, carefully
  curated additional local model packs.
- Improve region detection/recognizer composition for specialized scripts.
- Consider adaptive translated layouts as a separate fidelity mode after the
  exact-layout default is stable.
- Add multi-frame image observation where the extension has frame access.

### Long-term

- Activate the Screen AI adapter only if Google exposes a supported extension
  or Web API with stable capabilities and redistribution terms.
- Re-evaluate Chrome Prompt or future local multimodal APIs for language hints,
  transcription comparison, or accessibility summaries while retaining
  deterministic spatial providers.
- Explore safe, user-selected cloud translation/OCR adapters only as separate
  privacy-explicit providers, never as an implicit fallback.

## 11. Technical Research Methodology and Source Verification

### Primary Source Set

- Chrome extension APIs, lifecycle, permissions, CSP, remote-code policy,
  Translator, Language Detector, Prompt, Shape Detection, and offscreen docs.
- Chromium Screen AI source, Mojo definitions, browser integration, and service
  deployment documentation.
- W3C Intersection Observer specification.
- rrweb source and capture/replay design documentation.
- Tesseract.js API, lifecycle, performance, and pinned official `tessdata_fast`.
- Transformers.js documentation/source and model cards.
- Official PaddleOCR/PaddleOCR.js source, package documentation, and releases.
- WXT build/entrypoint documentation and Playwright extension guidance.

### Verification Approach

Facts that could change—versions, releases, browser support, API contexts,
permissions, provider capabilities, model formats, and deployment behavior—were
checked against live primary sources. Claims that remain uncertain are labeled
experimental, prototype-required, or model-specific. No target-site browser
acceptance or provider-quality benchmark is represented as completed research;
those remain implementation gates.

### Limitations

- TextDetector's WICG draft does not establish production Chrome availability.
- Prompt image capability depends on Chrome version, eligible hardware, model
  state, language/modality support, and user activation.
- Transformers/Paddle asset size, peak memory, and quality depend on the exact
  selected model and preprocessing.
- PaddleOCR.js is a new 0.x browser SDK and has not yet been validated in this
  repository's production MV3 artifact.
- Chromium Screen AI cannot be exercised from a stock extension.
- Mexico City, Reddit, and real-profile built-in-AI acceptance remain future
  implementation tests.

## 12. Technical Appendices and Reference Materials

### Provider Decision Table

| Provider | Current role | Spatial output | Default release posture |
|---|---|---:|---|
| Chrome TextDetector | Opportunistic detector/recognizer | Boxes/corners; text platform-dependent | Small adapter, auto-skip |
| Tesseract.js | Broad dependable OCR baseline | Blocks/lines/words/symbols | Enabled |
| Transformers.js | Specialized crop recognition | No scene boxes from TrOCR-style models | Prototype-gated |
| PaddleOCR-Wasm | Scene detection + recognition | Line polygons/scores | Prototype-gated |
| Chromium Screen AI | Future Chrome-native spatial OCR | Internal result is spatial | Compile-disabled |
| Chrome Prompt sidecar | Language/transcript interpretation | No trusted geometry | Independent, default-off |

### Persisted Image Preferences

```ts
interface ImageAnalysisPreferences {
  providerPriority: Array<
    | "chrome-text-detector"
    | "tesseract"
    | "transformers"
    | "paddleocr-wasm"
    | "chromium-screen-ai"
  >;
  scanPolicy:
    | "visible-first-background-prescan"
    | "visible-only"
    | "eager-all";
  skipSmallImages: boolean;
  usePromptForImageLanguage: boolean;
  usePromptForImageText: boolean;
}
```

### Release-blocking Success Criteria

- No unexpected source mutation, site-script execution, navigation, form
  submission, remote executable load, or stale-generation commit.
- Deterministic replica convergence and no full rebuild for bounded changes.
- Exact provider-order persistence and deterministic scan-policy behavior.
- Disabled providers absent from chunks, Workers, models/Wasm, settings,
  permissions/CSP additions, and notice payloads.
- Offscreen/service-worker/provider-Worker recovery tests pass.
- Provider/model manifests, checksums, licenses, and byte budgets exactly match
  the production artifact.
- No heavy inference occurs on the side-panel or service-worker event loop.
- Manual image scan always overrides the small-image/visibility filters.
- No provider advertises an unmeasured language or spatial capability.
- No private form/composer data or page content appears in durable diagnostics.

---

## Technical Research Conclusion

Simul should move forward as a safe live-replica extension rather than a static
snapshot translator. The event stream, canonical source model, protected
source-sized iframe, revisioned translation projection, persistent bounded
memory, and explicit access reconciliation form the fidelity and correctness
spine. Image translation extends that spine through independently compiled,
user-ordered providers rather than coupling the product to one OCR engine.

The recommended first dependable image path is Tesseract in a restartable
offscreen-owned Worker. TextDetector remains opportunistic, Transformers is a
specialized crop recognizer, PaddleOCR-Wasm is a promising but gated spatial
provider, and Screen AI remains a future adapter. Visibility scheduling and
small-image filtering control resource use without changing access or loading
all models. Prompt remains optional and untrusted for geometry.

The next engineering action is to implement the generated provider registry,
visibility scheduler, and offscreen/Tesseract foundation after the rrweb live
replica seams are established, then add experimental providers one at a time
behind measurable release gates.

**Technical Research Completion Date:** 2026-07-20  
**Research Period:** Current comprehensive technical analysis  
**Source Verification:** Current primary sources with explicit confidence gates  
**Technical Confidence:** High for the architectural spine; provider-specific
confidence is recorded in the decision tables and implementation gates.
