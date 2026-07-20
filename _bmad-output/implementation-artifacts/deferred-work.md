- source_spec: `_bmad-output/implementation-artifacts/spec-side-by-side-page-translation.md`
  summary: Add an optional detached translated companion window as an alternative to Chrome's native side panel.
  evidence: Chrome can create and arrange an extension popup window but cannot detach a native side panel; this requires separate window lifecycle and layout work after the MVP.
- source_spec: `spec-content-first-live-multilingual-companion.md`
  summary: Prototype opt-in Japanese/English image OCR and inert translated overlays.
  evidence: `../../docs/image-translation-research.md` documents the local Tesseract bundle, pixel-access choices, coordinate mapping, privacy boundaries, and cloud alternative; OCR and remote processing remain outside the approved implementation boundary.
- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-e-ocr-foundation.md`
  summary: Checkpoint E establishes modular OCR contracts, five stable provider IDs, an empty compile-time registry, exact-document image revisions, three visibility scheduling policies, and conservative small-image eligibility.
  evidence: The dormant implementation emits no page URL, text, pixels, or hashes; compiles no provider; and adds no runtime asset, dependency, permission, CSP change, recognition, or overlay.
- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-e-ocr-foundation.md`
  summary: Checkpoint F separately adds the restartable Chrome offscreen compute host, locally packaged Tesseract Worker and lazy language groups, pixel acquisition/hashing, recognition cache, validated geometry, and inert translated overlays.
  evidence: F requires explicit approval for the offscreen permission, Worker/Wasm CSP, executable/runtime assets, trained-data catalog, artifact budget, and browser lifecycle gates. It must consume E's stable IDs/order repair, exact-document content and observation revisions, current-revision override, descriptor privacy, three-policy priority rules, small-image reason codes, bounds, and virtual registry without reopening those invariants.
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
  summary: Complete the recorded Chrome privacy/fidelity gates and promote rrweb to the default only after every blocking result passes.
  evidence: Checkpoint D implements revisioned translation projection and pair-scoped memory behind development flags. Mexico City and Reddit target-site acceptance remains pending, so production and unflagged builds intentionally retain legacy authority.
