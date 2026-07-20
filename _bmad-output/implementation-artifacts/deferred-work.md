- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md`
  summary: Extend local image translation beyond visible top-frame `<img>` elements to CSS backgrounds, canvas/video frames, and embedded frames only after a new pixel-access/privacy review.
  evidence: Checkpoint F ships opt-in local Tesseract overlays for stable visible `<img>` crops only. Direct fetch/host access, non-`<img>` sources, durable captures, and remote processing remain outside its approved boundary.
- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md`
  summary: Add image-only automatic language detection instead of relying on nearest HTML `lang`, explicit From, or detected page language.
  evidence: Tesseract recognizes a selected language group but is not a reliable general language detector. Prompt or a dedicated classifier remains separately reviewable.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-mirror-engine.md`
  summary: Run an installed-Chrome TextDetector availability and quality matrix on profiles/platforms where the experimental API is exposed.
  evidence: The capability-probed offscreen provider, priority fallback, normalization, and boxes-only handoff are implemented. Standard Chrome builds may not expose TextDetector, and the current platform draft focuses on Latin-1, so real platform acceptance remains distinct from the deterministic packaged-Tesseract path.
- source_spec: none
  summary: Add Transformers.js as a locally packaged specialized text-crop recognition provider using Wasm with conditional WebGPU.
  evidence: Transformers.js introduces independent model selection, geometry-composition, packaging, memory, and quality gates and is separately shippable behind its compile-time flag.
- source_spec: none
  summary: Add official PaddleOCR.js as a locally packaged Wasm spatial OCR provider with dedicated Worker execution and line-polygon results.
  evidence: PaddleOCR.js has independent MV3 CSP, Worker emission, offline model, language, memory, and artifact-validation risks and should not share a review boundary with other providers.
- source_spec: none
  summary: Activate the reserved Chromium Screen AI provider only after Chrome exposes a supported public extension API.
  evidence: Simul preserves the stable provider ID and compile-time module seam, but Chromium's current Screen AI integration is private native C++/Mojo browser infrastructure and cannot be called by a stock MV3 extension.
- source_spec: none
  summary: Add the two independent Chrome Prompt image sidecars for language hints and transcript interpretation without trusting generated geometry.
  evidence: Prompt capability, user-activation, model-download, schema-validation, hallucination, and fallback behavior form a separate experimental deliverable from deterministic OCR.
- source_spec: none
  summary: Extend the production artifact profile matrix and absence validation as Transformers.js, PaddleOCR-Wasm, Prompt sidecars, or future Screen AI become runnable.
  evidence: The current release now validates disabled, TextDetector-only, Tesseract-only, and combined profiles independently, including provider-specific CSP/assets/runtime markers. New providers will add distinct Workers, Wasm/models, settings, notices, and permission/CSP boundaries.
- source_spec: `_bmad-output/implementation-artifacts/spec-live-incremental-replica-engine.md`
  summary: Diagnose and improve the remaining Mexico City carousel/background and Reddit left-login/right-related-rail fidelity gaps without weakening rrweb privacy or fallback.
  evidence: Checkpoint F Choice C promoted rrweb with legacy fallback while explicitly retaining these two installed-Chrome rows as known, non-blocking follow-ups rather than passed gates.
- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md`
  summary: Run a future technical spike for an optional Strict Local Mirror mode that preserves rrweb DOM/layout and translated text while guaranteeing that the replica makes no additional requests to the original website.
  evidence: The spike must neutralize every original resource reference (`src`, `srcset`, CSS `url()`/`@import`, remote fonts, posters, frames, and external SVG), lazily substitute already-rendered visible images/backgrounds with `captureVisibleTab()` crops exposed only through revocable temporary local blobs, revoke them on navigation/teardown, and add a restrictive extension-origin network CSP/backstop. Acceptance tests must prove zero replica-initiated network requests while the source page may network normally. `debugger`, `pageCapture`, new host permissions, and MHTML parsing remain prohibited without separate review and approval.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-mirror-engine.md`
  summary: Add real-Chrome render-readiness and no-blank acceptance coverage for isolated HTML, including delayed stylesheets and CSS states that normally depend on source-page JavaScript.
  evidence: DOM/linkedom tests can prove sanitization and text presence but cannot prove that Chrome paints meaningful content after late CSS loads. A browser fixture should keep last-good visible through two paints and bounded stylesheet settling, report content-free paint health, and reject an empty candidate without weakening the sandbox.
- source_spec: `_bmad-output/implementation-artifacts/spec-content-first-live-multilingual-companion.md`
  summary: Add an explicitly authorized write-back mode that translates user-authored text and inserts it into the selected source-page input while preserving normal input/change events.
  evidence: The shipped composer deliberately stops at copy-and-paste. Direct insertion mutates the source page, requires a user-selected target and gesture, and must exclude password/private controls and never submit a form automatically.
- source_spec: `_bmad-output/implementation-artifacts/spec-side-by-side-page-translation.md`
  summary: Add optional OpenAI or other cloud translation/OCR adapters only with explicit consent, secure credential handling, and clear local-versus-remote status.
  evidence: Chrome's built-in Translator remains the local default. API keys must never ship in the extension or enter page content; paid/free-tier availability changes over time and needs a separately reviewed user-key or backend design, quotas, privacy disclosure, cancellation, and provider-specific caching.
- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md`
  summary: Evaluate integrity-checked, user-initiated local OCR language/model packs beyond the bundled catalog, loading only the selected script group into memory.
  evidence: The current artifact bundles its approved Tesseract catalog and already loads one group dynamically. Downloadable data packs need offline persistence, checksums, versioning, licensing, quota/eviction UI, CSP review, and a guarantee that no remotely hosted executable code is introduced.
- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md`
  summary: Add bounded image-language detection and one controlled OCR reroute when HTML/page hints are absent or contradicted by recognition evidence.
  evidence: Script detection can narrow candidate models but does not reliably identify a language by itself. Any Prompt, OSD, or classifier hint must be capability-probed, confidence-bounded, content-private, and unable to supply trusted geometry.
- source_spec: `_bmad-output/implementation-artifacts/spec-side-by-side-page-translation.md`
  summary: Add optional companion placement and multi-display window arrangement beyond Chrome's fixed native side-panel placement.
  evidence: Chrome controls native side-panel side/position. A detached companion can be sized and positioned as its own window, but left/right/above pairing, display work areas, and restoring user geometry require a separate cross-platform window-management pass.
- source_spec: `_bmad-output/implementation-artifacts/spec-fix-ocr-native-callback-binding-and-build-identity.md`
  summary: Extend image discovery and OCR overlay routing into accessible open shadow roots.
  evidence: The isolated mirror reconstructs open shadow roots, but the current source image observer intentionally scans ordinary document `<img>` elements and does not traverse separate shadow-root trees, so those mirrored images are outside the current OCR boundary.
- source_spec: `_bmad-output/implementation-artifacts/spec-fix-ocr-native-callback-binding-and-build-identity.md`
  summary: Give toolbar authorization stamps a monotonic generation that remains ordered across background service-worker restarts.
  evidence: Sequence ordering is deterministic within one worker epoch, but UUID epochs have no cross-epoch order, so an exceptionally delayed message from an older worker lifecycle cannot be distinguished from the first launch of a newer lifecycle.
- source_spec: `_bmad-output/implementation-artifacts/spec-fix-ocr-native-callback-binding-and-build-identity.md`
  summary: Make rapid toolbar launches across multiple windows clean up every losing preopened side panel without disturbing the winning surface.
  evidence: Chrome's user-gesture constraint requires synchronously preopening the panel before saved launch preferences hydrate; a superseded cross-window click can leave that preopened panel visible, while Chrome 138's global disable/re-enable fallback cannot safely close only the losing window.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-fidelity-baseline-mode.md`
  summary: Mirror bounded ordinary stylesheet CSSOM mutations that do not change DOM attributes, text nodes, or constructable adopted stylesheets.
  evidence: The isolated observer detects DOM and adopted-sheet changes, but `insertRule`, `deleteRule`, and mutable rule declarations on ordinary `<style>`/linked sheets can change the source presentation without producing an observable patch.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-fidelity-baseline-mode.md`
  summary: Preserve inert link semantics needed by CSS and accessibility without restoring replica navigation.
  evidence: The current boundary deliberately strips ordinary anchor `href`, targets, downloads, and other navigation sinks. Some sites style link state or depend on URL-shaped attributes for layout, so an inert non-navigable representation needs its own security review.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-fidelity-baseline-mode.md`
  summary: Expand responsive image-source fidelity for `<picture>`, `<source>`, sizes/media selection, and browser-selected current-source changes.
  evidence: The safe mirror carries bounded `<img>` sources and srcsets but does not claim parity for the browser's full responsive source-selection state or passive `<source>` resource attributes.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-fidelity-baseline-mode.md`
  summary: Support a reviewed static subset of same-document SVG fragment references such as `<use href="#symbol">` and paint-server `url(#id)`.
  evidence: This fix admits only self-contained shape-only SVG data images. Local SVG references remain rejected with all external/resource-bearing references because graph ordering, ID scoping, CSS parsing, and receiver validation need a separate design.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-fidelity-baseline-mode.md`
  summary: Assess whether source doctype and standards/quirks mode can be represented safely in the fixed isolated shell.
  evidence: Simul owns a constant standards-mode `srcdoc` shell and transports the document element, not the source doctype. Quirks-mode pages can therefore retain DOM content while producing different layout metrics.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-fidelity-baseline-mode.md`
  summary: Audit custom-element fidelity that depends on inaccessible internal state, closed roots, lifecycle code, or browser-managed rendering.
  evidence: Simul intentionally never defines or executes copied custom elements and captures only representable light DOM plus accessible open roots. Exact behavior for closed or script-owned state remains outside the safe mirror boundary.
