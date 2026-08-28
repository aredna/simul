# Deferred work

`source_spec` records provenance. A path that is absent from the current tree
identifies a historical implementation artifact retained in Git history after
the public-release cleanup; it is not a runnable instruction for the current
build.

- source_spec: `_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md`
  summary: Extend local image translation beyond visible top-frame `<img>` elements to CSS backgrounds, canvas/video frames, and embedded frames only after a new pixel-access/privacy review.
  evidence: Checkpoint F ships opt-in local Tesseract overlays for stable visible `<img>` crops only. Direct fetch/host access, non-`<img>` sources, durable captures, and remote processing remain outside its approved boundary.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-mirror-engine.md`
  summary: Run an installed-Chrome TextDetector availability and quality matrix on profiles/platforms where the experimental API is exposed.
  evidence: The capability-probed offscreen provider, priority fallback, normalization, and boxes-only handoff are implemented. Standard Chrome builds may not expose TextDetector, and the current platform draft focuses on Latin-1, so real platform acceptance remains distinct from the deterministic packaged-Tesseract path.
- source_spec: none
  summary: Add Transformers.js as a locally packaged specialized text-crop recognition provider using Wasm with conditional WebGPU.
  evidence: Transformers.js introduces independent model selection, geometry-composition, packaging, memory, and quality gates and is separately shippable behind its compile-time flag.
- source_spec: none
  summary: Activate the reserved Chromium Screen AI provider only after Chrome exposes a supported public extension API.
  evidence: Simul preserves the stable provider ID and compile-time module seam, but Chromium's current Screen AI integration is private native C++/Mojo browser infrastructure and cannot be called by a stock MV3 extension.
- source_spec: none
  summary: Add the two independent Chrome Prompt image sidecars for language hints and transcript interpretation without trusting generated geometry.
  evidence: Prompt capability, user-activation, model-download, schema-validation, hallucination, and fallback behavior form a separate experimental deliverable from deterministic OCR.
- source_spec: none
  summary: Extend the production artifact profile matrix and absence validation as Transformers.js, Prompt sidecars, or future Screen AI become runnable.
  evidence: The current release now validates disabled, TextDetector-only, Tesseract-only, and combined profiles independently, including provider-specific CSP/assets/runtime markers. New providers will add distinct Workers, Wasm/models, settings, notices, and permission/CSP boundaries.
- source_spec: `_bmad-output/implementation-artifacts/spec-live-incremental-replica-engine.md`
  summary: Diagnose and improve the remaining Mexico City carousel/background and Reddit left-login/right-related-rail fidelity gaps without weakening isolated-mirror privacy or last-good recovery.
  evidence: The isolated engine is now the sole renderer; these installed-Chrome rows remain known, non-blocking fidelity follow-ups rather than passed gates.
- source_spec: `_bmad-output/implementation-artifacts/spec-passive-replica-fidelity.md`
  summary: Run a future technical spike for a hidden-until-complete Strict Local Mirror mode that preserves the current inert DOM/layout and translated text while guaranteeing that the replica makes no additional requests to the original website.
  evidence: Passive Fidelity is intentionally request-capable and Conservative still permits some allowlisted visual requests, so neither is a no-network mode. The spike must neutralize every original resource reference (`src`, `srcset`, CSS `url()`/`@import`, remote fonts, posters, frames, and external SVG), lazily substitute already-rendered visible images/backgrounds with `captureVisibleTab()` crops exposed only through revocable temporary local blobs, revoke them on navigation/teardown, and add a restrictive extension-origin network CSP/backstop. Acceptance tests must prove zero replica-initiated network requests while the source page may network normally. Strict Local must remain absent from Settings until those tests pass. `debugger`, `pageCapture`, new host permissions, and MHTML parsing remain prohibited without separate review and approval.
- source_spec: `_bmad-output/implementation-artifacts/spec-passive-replica-fidelity.md`
  summary: Add a bounded, privacy-reviewed localization path for usable source `blob:` visual resources.
  evidence: A source `blob:` URL is scoped to the source environment and cannot be safely reused by the replica. The current boundary omits it and reports browser inaccessibility because the extension cannot always obtain its bytes. A future path may use already-rendered pixels or explicitly obtainable bytes to create Simul-owned revocable blobs, with lifecycle, capacity, and no-content diagnostics proved independently.
- source_spec: `_bmad-output/implementation-artifacts/spec-passive-replica-fidelity.md`
  summary: Evaluate a narrowly targeted computed-style fallback for custom-element hosts or elements whose presentation depends on browser-inaccessible CSS.
  evidence: Indiscriminately serializing computed styles would create large privacy-sensitive payloads, force layout work, freeze responsive cascade behavior, and can still miss pseudo/content state. Any fallback must identify a small reviewed element/property set, impose payload and timing budgets, preserve live invalidation, and keep website code disabled.
- source_spec: `_bmad-output/implementation-artifacts/spec-passive-replica-fidelity.md`
  summary: Evaluate local current-pixel capture for canvas and static media frames without enabling playback or embedded active content.
  evidence: Passive Fidelity can preserve a static poster but cannot transport current canvas/video pixels, protected media, or embedded-document rendering through the existing typed DOM boundary. A future pixel path needs explicit access, stability, privacy, lifetime, geometry, and memory limits and must not activate audio/video playback.
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
  summary: Assess whether source doctype and standards/quirks mode can be represented safely in the fixed isolated shell.
  evidence: Simul owns a constant standards-mode `srcdoc` shell and transports the document element, not the source doctype. Quirks-mode pages can therefore retain DOM content while producing different layout metrics.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-html-fidelity-baseline-mode.md`
  summary: Audit custom-element fidelity that depends on inaccessible internal state, closed roots, lifecycle code, or browser-managed rendering.
  evidence: Simul intentionally never defines or executes copied custom elements and captures only representable light DOM plus accessible open roots. Exact behavior for closed or script-owned state remains outside the safe mirror boundary.
- source_spec: `_bmad-output/implementation-artifacts/spec-refresh-cache-duns-reddit-pass.md`
  summary: Spike a scriptless representation of source custom-element definition state for selectors such as `:defined` and `:not(:defined)`.
  evidence: Reddit's source custom elements are defined by its Lit runtime while the inert replica intentionally registers no website code. A reviewed experiment may carry only bounded definition-state metadata and use extension-owned inert behavior, but it must prove that no website constructor, lifecycle callback, request, or script executes.
- source_spec: `_bmad-output/implementation-artifacts/spec-refresh-cache-duns-reddit-pass.md`
  summary: Add confidence-gated, bounded multi-pass OCR fallback for stylized logos and tiny text, including geometry-hint consumption and original-coordinate consensus.
  evidence: The generic 2x shallow-banner profile and single-line segmentation improve the D-U-N-S path-only logo, but real-crop experiments still produce imperfect Japanese. Native RAW_LINE, 2x SINGLE_LINE, and bounded high-contrast candidates need confidence/script/agreement selection, cache-profile versioning, and exact box remapping before they can safely replace a nonempty low-quality first pass.
- source_spec: `_bmad-output/implementation-artifacts/spec-release-candidate-privacy-ux-hardening.md`
  summary: Add a privacy-reviewed stable identity for mapping among multiple simultaneous viewport-scale nested scrollers.
  evidence: The current generic observer switches to the nested surface that actually emits a qualifying source scroll, but a scriptless replica with multiple similarly sized candidates still selects its strongest local candidate independently; translated geometry can make that a different surface.
- source_spec: `_bmad-output/implementation-artifacts/spec-multi-provider-ocr-testing.md`
  summary: Make exported artifact validation resolve reviewed vendor manifests from the caller's explicit project root instead of the module-owning checkout.
  evidence: Existing Tesseract validation reads reviewed assets through module-global `PROJECT_ROOT`; a caller using `check` or `sync` APIs for another checkout can therefore compare against unrelated source state.
- source_spec: `_bmad-output/implementation-artifacts/spec-incremental-image-mutation-stability.md`
  summary: Unify the initial isolated text-serialization privacy floor with the shared computed visibility boundary.
  evidence: Incremental visibility comparison covers opacity, content visibility, clipping, positive geometry, and ancestor clipping, while the initial isolated serializer still applies a narrower structural/display/visibility floor. Closing that pre-existing mismatch requires a dedicated privacy migration and fixture matrix rather than changing mutation-local OCR behavior alone.
- source_spec: `_bmad-output/implementation-artifacts/spec-incremental-image-mutation-stability.md`
  summary: Add bounded in-flight sampling or suspension for protected surfaces that cross images during long-running or infinite CSS motion.
  evidence: The observer now compares old/current image and protected-surface rectangles plus their endpoint hull, covering ordinary settle crossings. A transition can still curve through an image outside that hull, and an infinite animation may never emit a terminal event; solving that safely needs a separate frame-budget and overlay-suspension design.
- source_spec: `_bmad-output/implementation-artifacts/spec-incremental-image-mutation-stability.md`
  summary: Replace the shared oversized private processing-token sentinel with a bounded change-sensitive representation.
  evidence: Different computed routing or paint dependency strings above 64 KiB currently collapse to the same private sentinel. Always treating the sentinel as changed would make unrelated refreshes loop and discard stable work, so a separately reviewed keyed digest or mutation-scoped fail-closed proof is needed without exposing the underlying private value.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Preserve authoritative capture when a loading navigation redirects before completion.
  evidence: A loading key can be overwritten by a URL-only update that is classified as same-document, causing the matching completion event to be suppressed and leaving the previous replica visible.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Reuse the checkpoint-scoped controlled-content policy while sanitizing image hints.
  evidence: Rebuilding the policy for every image repeats a bounded whole-document traversal and makes initial checkpoint work scale approximately with image count times node count.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Align initial text serialization with the computed painted-visibility privacy boundary.
  evidence: Ordinary opacity-zero, content-visibility-hidden, clipped, or zero-geometry text can pass the serializer's narrower withholding predicate and remain present in the replica.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Observe semantic mutations inside every admitted open shadow root.
  evidence: Initial semantic discovery traverses open shadow roots, but the document-only MutationObserver cannot see later shadow-root changes that make text stale or newly secret.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Reclaim semantic revision history for identities removed from long-lived documents.
  evidence: Removed semantic records and proofs retain history until disposal, so a virtualized application can exhaust the 50,000-identity limit and permanently block new semantic records.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Make bounded image discovery retain visually important candidates beyond an early DOM-order prefix.
  evidence: The 10,000-image budget is exhausted before attention ranking, so a visible image late in DOM order can remain permanently undiscovered behind offscreen early images.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Include relevant ancestor paint changes in screenshot-based image capture identity.
  evidence: Ancestor background, border, padding, or content changes can alter pixels beneath a transparent or composited image without advancing its capture revision, allowing stale OCR projection reuse.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Requeue a retained image projection when replay-lease rebinding cannot install its overlay.
  evidence: Recovery marks retained work projected before checking the projector result, so a missing anchor or rejected projection can leave settled work with no visible overlay and no retry.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Preserve normalized scroll progress on documents taller or wider than 100,000 CSS pixels.
  evidence: Clamping both position and maximum to 100,000 makes intermediate movement on very long documents appear as 100 percent progress and collapses all later source offsets.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Carry stable source identity for qualified nested scrollers beyond the first 5,000 elements.
  evidence: A valid late-DOM source scroller can lack an ordinal, causing replay to select a different early candidate or fall back to document scrolling.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Reject contradictory tablists with more than one independently selected visible tabpanel.
  evidence: Proving each relationship in isolation can admit multiple selected sibling panels and expose payloads that should remain inactive under a unique-selection contract.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Use padding-box geometry when proving selected tabpanel visibility through overflow clips.
  evidence: Border-box intersection can classify a panel as painted even when it lies fully outside an overflow ancestor's padding clip.
- source_spec: `_bmad-output/implementation-artifacts/spec-isolated-only-runtime-cache-correctness.md`
  summary: Refresh controlled-content policy when remote selector changes alter a selected tabpanel's visibility without resizing the document.
  evidence: The visibility comparison can identify the changed target while the retained policy still sanitizes the newly visible panel as withheld, leaving it blank.
- source_spec: `_bmad-output/implementation-artifacts/spec-public-release-readiness.md`
  summary: Recompute controlled-content visibility when a custom attribute changes CSS-selected tab or disclosure state.
  evidence: The relationship policy observes all attribute mutations but only treats a fixed attribute set as layout-changing, so selectors such as `[data-state="open"]` can reveal a panel without refreshing the withholding proof until another recognized signal arrives.
- source_spec: `_bmad-output/implementation-artifacts/spec-public-release-readiness.md`
  summary: Exclude flat-tree control ancestors from protected-sibling overlap when control-image reading is enabled.
  evidence: `Element.contains()` does not establish host containment for an image inside an open shadow root, so the host control can be misclassified as a different painted protected overlap and block an explicitly enabled image.
- source_spec: `_bmad-output/implementation-artifacts/spec-public-release-readiness.md`
  summary: Audit when the isolated replica iframe becomes available to assistive technology for ordinary translated documents.
  evidence: The iframe starts `aria-hidden`, while the reviewed unhide path is tied to semantic proof presentation; a text-only article needs an installed-Chrome accessibility-tree test proving the committed replica is exposed.
- source_spec: `_bmad-output/implementation-artifacts/spec-public-release-readiness.md`
  summary: Add bounded accessible-name support for safe `aria-labelledby` control relationships.
  evidence: The base sanitizer removes `aria-labelledby` and the semantic label reader uses direct label sources, so a public control named only by referenced visible text may become unnamed in the inert replica.
- source_spec: `_bmad-output/implementation-artifacts/spec-public-release-readiness.md`
  summary: Model approved `aria-current`, `aria-pressed`, and range-value semantics in the typed read-scope channel.
  evidence: These attributes are stripped from the base mirror and the current semantic protocol carries checked/selected state but no current-item, toggle, or bounded range-value proof.
- source_spec: `_bmad-output/implementation-artifacts/spec-public-release-readiness.md`
  summary: Make optional-host permission rollback transactional when disabling image translation.
  evidence: The disable flow can remove the shared broad grant before a later preference failure and its rollback relies on an earlier user-activation snapshot without proving the exact-origin grant was restored.
- source_spec: `_bmad-output/implementation-artifacts/spec-fresh-public-testing-build-identity.md`
  summary: Automate release build-sequence freshness when the canonical Chrome artifact changes.
  evidence: The current release gate validates and byte-compares an explicit build identity, but deciding when to advance its date/sequence remains a manual release-management step outside this identity correction.
