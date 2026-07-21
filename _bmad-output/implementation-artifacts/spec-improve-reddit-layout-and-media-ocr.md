---
title: 'Improve Reddit-Class Layout and Media OCR'
type: 'bugfix'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 0
baseline_commit: '12b62b9'
context:
  - '{project-root}/_bmad-output/project-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Modern Reddit exposes generic mirror gaps: accessibility labels become visible, late rails/styles are missed, and patches replace images. Its JPEG is OCR-readable, but anchor replacement, high-DPI admission, and sticky failures can prevent or erase the overlay.

**Approach:** Carry bounded presentation/source hints, settle style-dependent candidates, preserve projections across same-node replacements, downscale high-DPI crops, and retry bounded transient/blank captures with correlated safe diagnostics.

## Boundaries & Constraints

**Always:** Use generic rules, never hostname branches. Keep the replica scriptless, inert, `aria-hidden`, sandboxed, privacy-redacted, and within existing limits. Transport only a boolean for the canonical clipped 1px pattern. Blank broken icon `alt` only in public controls; preserve article alt and private exclusions. Keep last-good content visible and logs content-free.

**Ask First:** Custom-element definitions; stable-ID protocol changes; control-pixel capture; new permissions, fetches, persistence, computed styles, or weaker sandbox/CSP.

**Never:** Execute page JavaScript, special-case Reddit, fetch/parse source media, log content or identifiers, raise the 4 MP OCR cap, claim pixel parity, or absorb Strict Local Mirror work.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|---------------------------|----------------|
| Hidden label | Canonical clipped 1px host | Replica keeps it hidden | Normal small text stays visible |
| Broken control icon | Failed image inside activation | No fallback alt overlay | Article alt survives |
| Late rail/style | Shadow content or stylesheet settles late | Wait for outcome/two paints or deadline | Log aggregate error; commit at deadline |
| Responsive image | Safe `currentSrc` differs from declared source | Snapshot sanitized selected source | Omit unsafe/blob source |
| Replaced anchor | Same node ID/lease, new `<img>` | Rebind existing projection | Remove wrong-lease/missing anchor |
| High-DPI crop | 1206x761 at 2.25 scale | Downscale to <=4 MP and OCR | Defer unsafe geometry |
| Transient/blank | Capture failure or pre-paint no-text | Bounded retry; require repeated empty hash | Permanent failures settle |

</frozen-after-approval>

## Code Map

- `lib/replica/{html-mirror-sanitizer,html-mirror-protocol,html-mirror-source,isolated-html-engine}.ts` -- metadata, readiness, diagnostics, reconstruction.
- `lib/ocr/{image-overlay-projector,pixel-acquisition,image-translation-controller,image-scan-scheduler,diagnostic-history}.ts` -- rebinding, scaling, retries, stages.
- `tests/` -- generic Reddit-shaped regressions.
- `entrypoints/sidepanel/main.ts`, `tools/extension-artifact.mjs`, `docs/` -- diagnostics, build, guidance.

## Tasks & Acceptance

**Execution:**
- [x] Add sanitized hidden/selected-source metadata, suppress activation-icon fallback alt, and expose aggregate capture counters.
- [x] Add bounded style settling and fixtures for hidden labels, late rails, style outcomes, selected sources, and normal content.
- [x] Rebind same-ID replacement image anchors without discarding projections; refresh them on same-lease commits.
- [x] Downscale crops to the 4 MP cap and retry transient capture plus one unchanged no-text result within fixed limits.
- [x] Correlate OCR stages with an ephemeral ordinal, safe dimensions, and projection outcomes.
- [x] Update troubleshooting/submission limitations, bump build identity, sync the ready-to-load artifact, and run all gates.

**Acceptance Criteria:**
- A three-column fixture retains late rails and hides vote/comment accessibility labels without hiding normal text.
- Broken control icons show no fallback alt; article alt and privacy protections remain.
- Replacing a mirrored image object under the same logical node preserves its translated overlay.
- The JPEG at 2.25 scale reaches recognition through a <=4 MP crop; retries are bounded and observable.
- Safe diagnostics distinguish OCR stages, anchor replacement, style readiness, and permanent deferral.
- `npm run check` passes and `dist/chrome-unpacked` shows the incremented version/build.

## Design Notes

Bundled Tesseract finds seven positioned English lines in the exact JPEG, so model quality is not the primary defect. Custom-element upgrade state, closed roots, ElementInternals, virtualization, keyed patches, and replica `:defined` semantics remain follow-ups.

## Verification

**Commands:**
- Focused Vitest suites -- Reddit-shaped mirror/OCR regressions pass.
- `npm run check` -- typecheck, tests, and artifact integrity pass.
- `npm run artifact:sync && npm run artifact:check` -- artifact matches source.

**Manual checks:**
- Reload the extension; compare Reddit rails/controls, then OCR the supplied media URL. Expect safe dimensions, about seven regions, translation, and an overlay that survives scrolling.

## Implementation Result

- Isolated HTML now preserves canonical clipped accessibility labels, responsive selected image sources, small broken-control icon behavior, open-shadow stylesheet readiness, and late image state without executing page code.
- OCR now rebinds overlays across same-lease image replacement, proportionally downsamples high-DPI inputs under 4 MP, preserves banner segmentation, retries bounded transient/blank work, and removes stale overlays.
- Content-free job diagnostics correlate capture, recognition, translation, projection, retries, and anchor replacement. Build 0.2.4 is synchronized in `dist/chrome-unpacked`.
- Final gate: TypeScript passed, 51/51 test files and 564/564 tests passed, and artifact verification matched byte-for-byte.

## Review Resolution

- Blind and edge-case review produced patch findings only; no intent or specification loopback was required.
- Fixed shadow-root stylesheet discovery, stylesheet load/deadline races, malformed hint admission, selected-source budgeting, article-alt preservation, live responsive-image refresh, high-DPI banner mode, retry exhaustion, stale OCR state, and stage correlation.
- Retained the approved boundaries: no hostname branches, page/custom-element execution, broad computed-style scan, stable-ID protocol change, control-pixel relaxation, new permissions, or remote image fetch.
- Installed-Chrome comparison on live Reddit and the supplied media URL remains the human acceptance check because no interactive Chrome session was connected.

## Suggested Review Order

**Safe mirror fidelity**

- Narrow source hints are validated before entering the inert graph.
  [`html-mirror-sanitizer.ts:381`](../../lib/replica/html-mirror-sanitizer.ts#L381)

- Live image candidates refresh selected sources without resize-driven patch loops.
  [`html-mirror-source.ts:740`](../../lib/replica/html-mirror-source.ts#L740)

- Candidate styles settle across open shadows within one absolute deadline.
  [`isolated-html-engine.ts:1543`](../../lib/replica/isolated-html-engine.ts#L1543)

- Broken control fallback text is limited to proven-small icons.
  [`html-mirror-sanitizer.ts:1150`](../../lib/replica/html-mirror-sanitizer.ts#L1150)

**OCR lifecycle**

- One bounded pipeline owns capture, retries, OCR, translation, and projection currency.
  [`image-translation-controller.ts:740`](../../lib/ocr/image-translation-controller.ts#L740)

- Same-lease replacement anchors retain existing translated overlays.
  [`image-overlay-projector.ts:223`](../../lib/ocr/image-overlay-projector.ts#L223)

- High-DPI inputs downscale while preserving shallow-banner classification.
  [`preprocessing-profile.ts:41`](../../lib/ocr/preprocessing-profile.ts#L41)

- Banner profiles select single-line Tesseract mode and restore defaults.
  [`runtime.ts:124`](../../lib/ocr/providers/tesseract/runtime.ts#L124)

**Diagnostics and boundaries**

- Ephemeral job ordinals format only safe dimensions and outcomes.
  [`diagnostic-history.ts:35`](../../lib/ocr/diagnostic-history.ts#L35)

- Mirror logs expose aggregate style, shadow, source, and patch counters.
  [`main.ts:312`](../../entrypoints/sidepanel/main.ts#L312)

- Submission limits distinguish representable DOM from script-only browser state.
  [`README.md:110`](../../README.md#L110)

**Acceptance and release**

- Reddit-shaped rails, shadow styles, accessibility labels, and style outcomes are fixture-locked.
  [`isolated-html-engine.test.ts:575`](../../tests/isolated-html-engine.test.ts#L575)

- Responsive light/shadow images prove load, error, resize, and coalescing behavior.
  [`html-mirror-source.test.ts:173`](../../tests/html-mirror-source.test.ts#L173)

- The exact 1206x761 at 2.25x geometry stays under 4 MP.
  [`pixel-acquisition.test.ts:284`](../../tests/pixel-acquisition.test.ts#L284)

- Build identity remains visible and installable at version 0.2.4.
  [`package.json:3`](../../package.json#L3)
