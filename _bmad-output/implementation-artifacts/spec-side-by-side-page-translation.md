---
title: 'Side-by-side Japanese and English page translation'
type: 'feature'
created: '2026-07-19T14:19:03+09:00'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'f1e8546f65e70c2e4d270b39bd2f9b80dc2f7828'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Readers need to compare a Japanese or English page with a translation while keeping the original untouched. Arbitrary sites cannot be reproduced as an exact, safe live copy, especially when text is embedded in image pixels.

**Approach:** Open a horizontal Chrome side-panel containing a sanitized, read-only snapshot of the active page's visible top-frame content. Recommend right-side placement, while respecting Chrome's user-controlled global side setting. Translate text locally with Chrome's Translator API; retain supported images as original context and translate only their accessible labels/captions in this increment.

## Boundaries & Constraints

**Always:** Leave the source page untouched. Require a user click, target Chrome 138+ desktop, check the pair at runtime, and expose progress/retry. Use only `activeTab`, `scripting`, and `sidePanel`. Feature-detect Chrome's read-only panel-layout API and guide users to Chrome Appearance settings when the panel is left-positioned. Extract eligible top-frame content; exclude hidden text, passwords, and entered values. Pass typed data—not HTML—and render strings as text. Keep a provider interface for later OpenAI support.

**Ask First:** Any new permission; remote processing; OCR/image editing; source-page layout changes; window management; or languages beyond Japanese/English.

**Never:** Use a live iframe, cloned scripts, `<all_urls>`, credentials, or network fallback. Do not claim exact/live or pixel-translation fidelity. Cross-origin frames, canvas/video, vertical layout, an ineffective Simul left/right picker, scroll sync, live mirroring, form filling, and free-text composition are out of scope.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Supported page | HTTP(S), eligible text, pair available | Ordered inert translation and supported image context | Mark failed segments; allow retry |
| Model not ready | `downloadable`/`downloading` | User click starts creation with progress | Return failure/cancel to retryable state |
| Unsupported | Missing API/pair, restricted/stale tab, or empty text | Specific capability/access/empty state | No fabricated or network result |
| Panel is left | Chrome user preference is left | Open normally and explain how to select right in Chrome Appearance settings | Do not claim Simul can change it |
| Unsafe/private | Scripts, controls, hidden nodes, or frames | Omit content; nothing can execute | Report omissions non-fatally |
| Image | Loadable source and accessible text | Translate accessible text; label pixels untranslated | Safe placeholder; no OCR claim |

</frozen-after-approval>

## Code Map

- `wxt.config.ts`, `types/translator-api.d.ts` -- Chrome target, permissions, and API types.
- `entrypoints/popup/`, `entrypoints/sidepanel/` -- Launcher and companion UI.
- `entrypoints/page-snapshot.ts`, `lib/page-snapshot.ts` -- Active-tab extraction and safe snapshot model.
- `lib/{translation-provider,chrome-translator,translation-pipeline}.ts` -- Provider boundary, adapter, and mapping.
- `tests/` -- Pure behavior and browser-boundary tests.
- `docs/translation-companion.md` -- Privacy, support, limitations, and future provider seam.

## Tasks & Acceptance

**Execution:**
- [x] `wxt.config.ts`, `types/translator-api.d.ts` -- target Chrome 138; add only `activeTab`, `scripting`, `sidePanel`; type Translator.
- [x] `lib/page-snapshot.ts`, `entrypoints/page-snapshot.ts` -- extract safe visible blocks/images without HTML or private values.
- [x] `lib/{translation-provider,chrome-translator,translation-pipeline}.ts` -- add pair checks, user-activated creation, progress, bounded sequential translation, deduplication, cancel, and partial retry.
- [x] `entrypoints/popup/{index.html,main.ts,style.css}` -- build an accessible panel launcher.
- [x] `entrypoints/sidepanel/{index.html,main.ts,style.css}` -- build direction/swap, translate/refresh/cancel, status, safe rendering, placement guidance, and disclosures.
- [x] `tests/{page-snapshot,translation-pipeline,chrome-translator}.test.ts`, `docs/translation-companion.md` -- cover the matrix and document privacy, support, limits, and future OpenAI seam.

**Acceptance Criteria:**
- Given a supported page, when translation starts, then the untouched source remains beside a read-only panel translated in document order.
- Given first-use download, when translation starts, then progress appears and page data stays local.
- Given hostile markup, when rendered, then no HTML, script, navigation, or form action executes.
- Given an image, when rendered, then accessible text is translated and original pixels are disclosed.
- Given Chrome places side panels on the left, when Simul opens, then it works there and shows accurate right-side settings guidance without offering a nonfunctional picker.
- Given an error/cancel, when it occurs, then an actionable state appears without page mutation or remote fallback.
- Given completion, when `npm run check` runs, then all gates pass and the manifest has no host permissions.

## Spec Change Log

## Design Notes

Translator is stable for desktop extensions from Chrome 138, runs in an extension document, and may download a language pack. Chrome supports only left/right native panels; the user controls placement globally, and Chrome 140+ exposes it read-only. The panel avoids iframe failures and source rewriting but is approximate. Later OpenAI use needs a key-protecting backend; there is no ongoing free API tier.

Deferred image-translation research identified a local-first follow-up: capture visible image regions under `activeTab`, OCR lines and bounding boxes with extension-bundled Tesseract.js Japanese/English models, translate the lines, and render positioned overlays. If local accuracy is insufficient, compare a backend-mediated Google Vision + Cloud Translation pipeline; Azure's paid Document Translation can instead return reconstructed images. These remain Ask First and outside this MVP.

A later companion-window mode can create a separate extension popup with `chrome.windows.create()` and coordinate it with the source tab. Chrome cannot detach its native side panel, so this would be a distinct layout mode with window lifecycle, sizing, positioning, and multi-display behavior to design and test.

## Verification

**Commands:**
- `npm run check` -- strict TypeScript, all unit tests, and Chrome MV3 build succeed.

**Manual checks:**
- In Chrome 138+, verify both directions, progress, retry/cancel, keyboard use, restricted/empty/image pages, unchanged source DOM, and no `host_permissions`.

## Suggested Review Order

**Runtime flow**

- Starts model creation from user activation, then guards freshness through rendering.
  [sidepanel/main.ts:238](../../entrypoints/sidepanel/main.ts#L238)

- Captures and validates a bounded active-tab snapshot before enabling translation.
  [sidepanel/main.ts:125](../../entrypoints/sidepanel/main.ts#L125)

- Clears stale companion state on relevant tab activation, navigation, or reload.
  [sidepanel/main.ts:513](../../entrypoints/sidepanel/main.ts#L513)

- Opens Chrome's native panel directly from the toolbar's user gesture.
  [popup/main.ts:1](../../entrypoints/popup/main.ts#L1)

**Trust boundary**

- Extracts only eligible top-frame semantics with explicit traversal and payload bounds.
  [page-snapshot.ts:220](../../lib/page-snapshot.ts#L220)

- Rebuilds untrusted injected results into a known typed snapshot without HTML.
  [page-snapshot.ts:108](../../lib/page-snapshot.ts#L108)

- Requires exact tab, window, and URL identity before showing results.
  [page-identity.ts:15](../../lib/page-identity.ts#L15)

**Translation engine**

- Adapts Chrome capability, download, cancellation, quota, and session lifecycle behavior.
  [chrome-translator.ts:41](../../lib/chrome-translator.ts#L41)

- Detects both object and function-valued WebIDL Translator globals.
  [chrome-translator.ts:184](../../lib/chrome-translator.ts#L184)

- Deduplicates and translates bounded fields sequentially with partial retry.
  [translation-pipeline.ts:70](../../lib/translation-pipeline.ts#L70)

- Measures provider quota and recursively produces Unicode-safe input chunks.
  [translation-pipeline.ts:263](../../lib/translation-pipeline.ts#L263)

**User contract**

- Exposes language direction, progress, placement guidance, and fidelity disclosures.
  [sidepanel/index.html:22](../../entrypoints/sidepanel/index.html#L22)

- Documents local processing, remote-image behavior, permissions, and deliberate limitations.
  [translation-companion.md:26](../../docs/translation-companion.md#L26)

**Verification and configuration**

- Exercises real DOM extraction boundaries, captions, controls, limits, and identity.
  [page-snapshot.test.ts:179](../../tests/page-snapshot.test.ts#L179)

- Covers sequencing, deduplication, cancellation, quota, Unicode, bounds, and retry.
  [translation-pipeline.test.ts:39](../../tests/translation-pipeline.test.ts#L39)

- Regresses real WebIDL detection, capability states, progress, and quota exposure.
  [chrome-translator.test.ts:15](../../tests/chrome-translator.test.ts#L15)

- Declares Chrome 138 and exactly three least-privilege manifest permissions.
  [wxt.config.ts:3](../../wxt.config.ts#L3)

- Types only the stable Translator surface consumed by Simul.
  [translator-api.d.ts:38](../../types/translator-api.d.ts#L38)
