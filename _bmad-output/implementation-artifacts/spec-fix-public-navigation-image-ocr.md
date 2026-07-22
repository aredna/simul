---
title: 'Unify replica disclosures and resilient image OCR fallbacks'
type: 'bugfix'
created: '2026-07-22'
status: 'completed'
review_loop_iteration: 2
baseline_commit: 'e0e72a6b99ae3fa7924027be1d43df6440610add'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-ocr-trial-runtime-reliability.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-0-3-2-dropdown-visibility.md'
---

<frozen-after-approval reason="human-owned intent, explicitly renegotiated and pre-approved on 2026-07-22">

## Intent

**Problem:** Simul applies several related but inconsistent interpretations of source semantics. A public navigation image can be rejected by every OCR provider after an accessibility script gives its real hyperlink `role="button"`. Auto language detection stops before OCR on image-only or text-light pages even when a few image probes could identify a strong script for the whole page. Native dropdowns also change shape across replica engines, can be clipped or partially hidden while the replica scrolls, and custom ARIA disclosure triggers do not reveal their mapped public menu content.

**Approach:** Use one pure source-semantic classification vocabulary for private regions, protected activation controls, genuine public HTTP(S) hyperlinks, and validated disclosure relations. Consumers remain purpose-specific: OCR may capture a genuine public-link image after re-validating live ancestry; mirror sanitization keeps roles for CSS fidelity while stripping activity; replica renderers consume only typed, sanitized disclosure state and never forward interaction to the source. Add a bounded page-scoped Auto OCR probe that can promote strong, corroborated language evidence for otherwise unresolved images, plus provider-specific Japanese routing. Render native and validated custom dropdown content through extension-owned, read-only disclosure UI that preserves popup/list identity and escapes source clipping.

## Boundaries & Constraints

**Always:** Keep the source DOM untouched; keep replica roles where author CSS needs them; keep replicas script-disabled/sandboxed and visually `aria-hidden`; validate every transported relation at both protocol boundaries; keep OCR local, exact-document/revision guarded, content-free in diagnostics, and limited to privacy-approved images. Preserve explicit and nearest-element language over a page probe. Preserve provider priority, on/off toggles, confidence filtering, permissions, CSP, production defaults, trial size cap, and branch-only delivery. Finish with `dist/chrome-unpacked` ready to reload.

**Never:** Forward replica clicks, keys, selection, form values, or navigation to the source; transport raw option values, names, private labels, or arbitrary rich picker descendants; infer custom-menu relationships without a unique same-document sanitized target; add hostname, URL, filename, Japanese-text, or NTA-specific branches; treat alt text as OCR truth; allow blocked images into probing; add remote code, permissions, hosts, providers, model assets, or release-cap changes; push or merge.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| Public navigation image | HTML `<a href>` resolving to HTTP(S), later given plain `role="button"`, outside private ancestry | Observe, measure, capture, and route normally | Re-check live DOM and geometry before/after capture |
| False/public-looking controls | Native button, non-link `role=button`, fragment/JavaScript/data/blob/mail link, stateful activation role, editable/private or protected outer ancestry | Exclude before pixels leave the source bridge | Fail closed; content-free diagnostics only |
| Runtime semantics | `role`, `href`, `<base>`, private state, or ancestry changes | Re-evaluate descendants once per batch, cancel stale work, remove/re-admit safely | Exact document and descriptor revisions remain authoritative |
| Japanese provider A/B | Source resolves to Japanese | Tesseract.js uses `jpn+jpn_vert`; direct Wasm uses supported `jpn` | Unsupported providers fail/fall through honestly |
| Auto with page evidence | Valid HTML/nearest `lang`, reliable visible-text detection, or strong unambiguous page script | Use that language without image probes | Per-image nearest valid language remains stronger |
| Auto unresolved | Text-light/image-only page with eligible images | Probe at most 3 distinct images, 6 routes per image, 18 recognition routes total, and 20 seconds; try Japanese on every image and promote only strong/corroborated evidence for this exact document | Inconclusive work stops with actionable, content-free guidance |
| Strong single image | One eligible transcript has at least 3 unambiguous script characters and OCR confidence >=90% | Resolve page language in memory and restart remaining unresolved image work | A stale/disabled-provider result cannot vote |
| Native popup select | Single select without authored multi-row presentation | Keep a popup-shaped selected-label trigger; click opens a local bounded list | No replica selection mutation or source event |
| Native list select | `multiple` or authored `size>1` | Keep bounded list presentation and internal scrolling | Selected/disabled/optgroup state remains presentation-only |
| Valid custom disclosure | One sanitized trigger maps through a unique same-document relation to public menu/listbox/region content | Local click opens extension-owned preview; source-expanded state may initialize it | Ambiguous, missing, private, or stale mapping remains static |
| Replica scroll/zoom/update | Open list near any viewport edge, then scroll/resize/patch/navigate | Overlay flips/clamps/repositions or closes; full list remains internally scrollable | Never rewrite source clipping ancestors or retain stale overlays |

</frozen-after-approval>

## Code Map

- `lib/replica/source-privacy-policy.ts` -- shared semantic primitives plus the OCR-specific public-navigation image decision.
- `lib/ocr/{source-image-observer,image-source-session}.ts` -- discovery, mutation, composed-ancestry, and final measurement gates.
- `lib/ocr/providers/{tesseract,tesseract-wasm-direct}/`, `lib/ocr/image-analysis-coordinator.ts` -- provider-specific Japanese route and cache identity.
- `lib/language-detection.ts`, `lib/ocr/{auto-language-probe,image-translation-controller,diagnostic-history}.ts`, `entrypoints/sidepanel/main.ts` -- bounded page-wide Auto evidence, lifecycle, promotion, and diagnostics.
- `lib/replica/{html-mirror-sanitizer,html-mirror-source,isolated-html-engine,visible-replay-host}.ts`, `lib/visual-renderer.ts`, side-panel CSS -- typed disclosure mapping and clipping-independent local presentation.
- Focused OCR, protocol, renderer, replay-host, and artifact tests -- privacy, currentness, budgets, provider routes, mapping, scroll, and cleanup regressions.

## Tasks & Acceptance

**Execution:**
- [x] Add a shared semantic classifier and a narrowly named image-capture policy that exempts only genuine HTTP(S) navigation anchors carrying the permitted public activation role; retain strict overlap and mirror predicates.
- [x] Observe `href`/`role`/private/base changes, coalesce affected images, and prove stale jobs cannot commit.
- [x] Route wrapper/direct Japanese jobs independently while preserving provider-specific cache identities.
- [x] Add bounded page-scoped Auto language evidence and OCR probing with privacy/currentness/provider/reset guards.
- [x] Replace the inconsistent native-select facsimiles with one typed read-only disclosure contract and validated custom ARIA relation handling; keep RRWeb explicitly inert unless it can satisfy the same privacy proof.
- [x] Add site-shaped and boundary fixtures for OCR, Auto promotion/inconclusive/reset, popup/list/custom disclosure mapping, viewport edges, nested/outer scroll, zoom, patch, and teardown.
- [x] Run focused tests, adversarial review, `npm run check`, sync and validate the exact four-provider trial artifact, then commit locally without pushing.

**Acceptance Criteria:**
- The supplied `gnav-news2.gif` reaches Tesseract OCR from its real navigation page; in Auto on an otherwise unresolved page, its high-confidence Kana transcript can establish Japanese and restart remaining eligible images.
- Private/editable/stateful controls, unsafe pseudo-links, ambiguous custom disclosures, blocked images, stale documents, and overlapping protected controls remain fail-closed.
- Native dropdowns retain popup versus list identity, reveal every admitted translated label on local click, stay usable at viewport edges and through scrolling, and never change or activate the source.
- A uniquely mapped public ARIA menu/listbox/region can be previewed locally; ambiguous or private mappings do not become interactive.
- Roles remain available for replica CSS, while sandbox/CSP, pointer/event guards, stripped activity, and receiver validation prove the replica remains inert.
- Full checks and exact trial-artifact validation pass; permissions, CSP, local assets, production provider profile, `main`, and origin remain unchanged.

## Design Notes

The role itself is not an execution capability and should not be rewritten in the visual replica. OCR runs against the original page before replica normalization could help, while changing the role would break selectors such as `[role="button"]`. The shared classifier therefore describes semantics; each consumer applies its own permission. OCR waives only the plain activation role on a real safe navigation anchor. Replica sanitization still strips active attributes and event behavior and preserves the authored role for layout.

Auto probing is page evidence, not a persisted From choice. Explicit From, valid nearest element language, and reliable page evidence outrank it. Probe state is exact-document and memory-only, resets on navigation/document/provider/confidence/Auto changes, uses enabled and ready providers only, and does not log transcripts, URLs, pixels, hashes, or node IDs.

One controller-owned, non-serializable identity represents each source image
for the exact document. Pixel revisions remain part of recognition currency but
do not create independent language votes or reopen the six-route image budget.

Replica disclosure state separates transported `sourceExpanded` from local `previewExpanded`. Node/revision mappings authorize only local presentation. Native values and source events never cross the boundary. Popup overlays belong to the extension-owned surface, clamp/flip within the visible replica viewport, scroll internally, and close whenever their anchor or identity becomes stale.

## Verification

**Commands:**
- Focused Vitest suites for source privacy/observer/session, OCR routes/controller/diagnostics, mirror protocols/renderers, and replay-host geometry.
- `npm run check`
- `npm run artifact:sync:ocr-trials && npm run check:ocr-all-trial`
- `git diff --check` and branch/main/origin verification.

**Results:**
- Focused final boundary run: 12 files / 288 tests passed; TypeScript and diff checks passed.
- Full project run and `npm run check`: 66 files / 855 tests passed; the production artifact check passed.
- Exact four-provider trial: `paddleocr-wasm`, `chrome-text-detector`, `tesseract`, `tesseract-wasm-direct`; 73,478,531 bytes, below the 72 MiB cap; trial validation passed.
- Two-pass Auto OCR adversarial re-review closed all four lifecycle findings and returned no further findings. Disclosure review additionally closed forged internal-marker authorization and found no second issue.

**Manual checks:**
- Reload `dist/chrome-unpacked`; on the NTA page test Auto and explicit Japanese with each provider enabled alone and in priority order.
- Open the GIF alone and verify bounded Auto probing or actionable inconclusive guidance.
- Test native single, multiple, and long selects plus public and ambiguous ARIA menus at top/bottom/RTL edges; scroll the source replica and list, zoom/fit, update options, navigate, and confirm the source never changes.

## Spec Change Log

- 2026-07-22: Initial public-navigation OCR bug drafted and approved.
- 2026-07-22: Human explicitly expanded and pre-approved scope to unify source/replica semantic mapping, page-wide Auto OCR language fallback, and native/custom dropdown disclosure behavior before the next manual test.
- 2026-07-22: Auto probe budget expanded from 12 to 18 routes so three six-route windows cover all 13 packaged representative languages while retrying Japanese on every image; provider/confidence provenance, target-only preservation, and page-evidence precedence were hardened during adversarial review.
- 2026-07-22: Disclosure review found and fixed Shadow DOM cascade and detached-staging lifecycle defects; installed Chrome now verifies closed panels are hidden and open panels compute as fixed overlays.
- 2026-07-22: Final adversarial review bound image evidence to the exact source document, gated OCR behind pending page evidence, separated source-image identity from pixel currency, and made the six-route per-image budget persistent across same-document reconnects.
- 2026-07-22: Disclosure authorization now requires extension-owned runtime identity and both transport boundaries reserve `data-simul-*`, preventing source-forged markers. Paddle's bundled js-yaml 4.1.1 attribution was corrected and guarded without changing executable dependencies.
