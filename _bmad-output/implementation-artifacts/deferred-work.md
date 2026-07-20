- source_spec: `_bmad-output/implementation-artifacts/spec-side-by-side-page-translation.md`
  summary: Add an optional detached translated companion window as an alternative to Chrome's native side panel.
  evidence: Chrome can create and arrange an extension popup window but cannot detach a native side panel; this requires separate window lifecycle and layout work after the MVP.
- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md`
  summary: Extend local image translation beyond visible top-frame `<img>` elements to CSS backgrounds, canvas/video frames, and embedded frames only after a new pixel-access/privacy review.
  evidence: Checkpoint F ships opt-in local Tesseract overlays for stable visible `<img>` crops only. Direct fetch/host access, non-`<img>` sources, durable captures, and remote processing remain outside its approved boundary.
- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md`
  summary: Add image-only automatic language detection instead of relying on nearest HTML `lang`, explicit From, or detected page language.
  evidence: Tesseract recognizes a selected language group but is not a reliable general language detector. Prompt or a dedicated classifier remains separately reviewable.
- source_spec: none
  summary: Add Chrome TextDetector as an experimental capability-probed OCR provider that can pass boxes-only region hints to later providers.
  evidence: TextDetector has its own availability, normalization, fallback, diagnostics, and browser-version acceptance criteria and can be reviewed independently of the OCR foundation.
- source_spec: none
  summary: Add Transformers.js as a locally packaged specialized text-crop recognition provider using Wasm with conditional WebGPU.
  evidence: Transformers.js introduces independent model selection, geometry-composition, packaging, memory, and quality gates and is separately shippable behind its compile-time flag.
- source_spec: none
  summary: Add official PaddleOCR.js as a locally packaged Wasm spatial OCR provider with dedicated Worker execution and line-polygon results.
  evidence: PaddleOCR.js has independent MV3 CSP, Worker emission, offline model, language, memory, and artifact-validation risks and should not share a review boundary with other providers.
- source_spec: none
  summary: Add the two independent Chrome Prompt image sidecars for language hints and transcript interpretation without trusting generated geometry.
  evidence: Prompt capability, user-activation, model-download, schema-validation, hallucination, and fallback behavior form a separate experimental deliverable from deterministic OCR.
- source_spec: none
  summary: Add the complete provider build-profile matrix and production artifact absence validation for disabled modules, Workers, Wasm, models, settings, permissions, CSP additions, and notices.
  evidence: Checkpoint F validates canonical Tesseract and fully compiled-out profiles. Cross-product profiles become necessary as additional providers are implemented.
- source_spec: `_bmad-output/implementation-artifacts/spec-live-incremental-replica-engine.md`
  summary: Promote the staged rrweb checkpoint to a user-visible replica behind the development flag while retaining labeled, bounded legacy fallback.
  evidence: Visibility should follow only after the hidden checkpoint proves privacy, packaging, iframe isolation, and real-Chrome replay viability without changing production behavior.
- source_spec: `_bmad-output/implementation-artifacts/spec-live-incremental-replica-engine.md`
  summary: Stream ordered rrweb incremental events with per-document sequence and ACK state, gap recovery, bounded subscriber history, checkpoint resynchronization, and atomic last-good swaps.
  evidence: Incremental convergence and transport recovery are independently testable after full-checkpoint replay is safe and visibly faithful.
- source_spec: `_bmad-output/implementation-artifacts/spec-live-incremental-replica-engine.md`
  summary: Diagnose and improve the remaining Mexico City carousel/background and Reddit left-login/right-related-rail fidelity gaps without weakening rrweb privacy or fallback.
  evidence: Checkpoint F Choice C promoted rrweb with legacy fallback while explicitly retaining these two installed-Chrome rows as known, non-blocking follow-ups rather than passed gates.
- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md`
  summary: Run a future technical spike for an optional Strict Local Mirror mode that preserves rrweb DOM/layout and translated text while guaranteeing that the replica makes no additional requests to the original website.
  evidence: The spike must neutralize every original resource reference (`src`, `srcset`, CSS `url()`/`@import`, remote fonts, posters, frames, and external SVG), lazily substitute already-rendered visible images/backgrounds with `captureVisibleTab()` crops exposed only through revocable temporary local blobs, revoke them on navigation/teardown, and add a restrictive extension-origin network CSP/backstop. Acceptance tests must prove zero replica-initiated network requests while the source page may network normally. `debugger`, `pageCapture`, new host permissions, and MHTML parsing remain prohibited without separate review and approval.
