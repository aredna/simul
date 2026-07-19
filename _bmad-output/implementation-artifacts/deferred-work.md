- source_spec: `_bmad-output/implementation-artifacts/spec-side-by-side-page-translation.md`
  summary: Add an optional detached translated companion window as an alternative to Chrome's native side panel.
  evidence: Chrome can create and arrange an extension popup window but cannot detach a native side panel; this requires separate window lifecycle and layout work after the MVP.
- source_spec: `spec-content-first-live-multilingual-companion.md`
  summary: Prototype opt-in Japanese/English image OCR and inert translated overlays.
  evidence: `../../docs/image-translation-research.md` documents the local Tesseract bundle, pixel-access choices, coordinate mapping, privacy boundaries, and cloud alternative; OCR and remote processing remain outside the approved implementation boundary.
