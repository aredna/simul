- source_spec: `_bmad-output/implementation-artifacts/spec-side-by-side-page-translation.md`
  summary: Add an optional detached translated companion window as an alternative to Chrome's native side panel.
  evidence: Chrome can create and arrange an extension popup window but cannot detach a native side panel; this requires separate window lifecycle and layout work after the MVP.
- source_spec: `spec-content-first-live-multilingual-companion.md`
  summary: Prototype opt-in Japanese/English image OCR and inert translated overlays.
  evidence: `../../docs/image-translation-research.md` documents the local Tesseract bundle, pixel-access choices, coordinate mapping, privacy boundaries, and cloud alternative; OCR and remote processing remain outside the approved implementation boundary.
- source_spec: none
  summary: Add the modular OCR foundation with a generated provider registry, three visibility scheduling policies, a restartable offscreen compute host, and the Tesseract spatial baseline.
  evidence: This is independently shippable after stable live-replica node and image identity exists, and separating it avoids coupling the DOM replication migration to heavy OCR runtime work.
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
  evidence: Cross-profile release hardening is independently verifiable after provider modules exist and should be confirmed before publishing the expanded OCR release.
- source_spec: `_bmad-output/implementation-artifacts/spec-live-incremental-replica-engine.md`
  summary: Promote the staged rrweb checkpoint to a user-visible replica behind the development flag while retaining labeled, bounded legacy fallback.
  evidence: Visibility should follow only after the hidden checkpoint proves privacy, packaging, iframe isolation, and real-Chrome replay viability without changing production behavior.
- source_spec: `_bmad-output/implementation-artifacts/spec-live-incremental-replica-engine.md`
  summary: Stream ordered rrweb incremental events with per-document sequence and ACK state, gap recovery, bounded subscriber history, checkpoint resynchronization, and atomic last-good swaps.
  evidence: Incremental convergence and transport recovery are independently testable after full-checkpoint replay is safe and visibly faithful.
- source_spec: `_bmad-output/implementation-artifacts/spec-live-incremental-replica-engine.md`
  summary: Project translations from revisioned canonical source values onto only changed rrweb text nodes, add pair-scoped cache reuse, and promote rrweb to the default after browser privacy and fidelity gates pass.
  evidence: Translation correctness depends on stable live node identity and should be promoted only after ordered replication converges without source mutation or stale commits.
