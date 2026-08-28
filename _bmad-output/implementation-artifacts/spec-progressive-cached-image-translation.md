---
title: Progressive cached image translation
slug: progressive-cached-image-translation
type: refactor
status: done
created: 2026-07-24
baseline_commit: 266a7af
---

# Progressive cached image translation

## Frozen intent

### Problem

Image translation feels serial and unstable. Reloads and same-origin navigation discard OCR, translation, ranking, and language evidence; ALT text waits behind OCR; visible images do not reliably preempt background work; scrolling, replay-lease changes, duplicate navigation events, and priority reordering can trigger page-wide recalculation. Mainichi’s background-image logo also has useful Japanese label text pushed offscreen, so the replica never presents its translation over the visible mark.

### Approach

Add a controller-owned, bounded, memory-only, same-top-origin evidence cache with a 15-minute TTL. Separate routine replica detachment from security-sensitive purging. Retain per-provider recognition, language, translation, quality, and projection evidence so priority changes rerank locally. Current-DOM accessibility text may project provisionally at once; cached OCR-derived content requires a fast current-pixel hash match before display. Schedule by visibility and visual attention, preserve completed projection blueprints across replica leases, and coalesce geometry/navigation invalidations. Add a narrow semantic-label path for visible image-painted elements whose direct safe text is displaced by large text indentation. Install local Simul Git hooks that reject protected-branch commits and every push until removed.

### Always

- Stay on the current feature branch; do not merge or push. Advance the beta identity and rebuild `dist/chrome-unpacked`.
- Keep cached results in extension memory only. Never persist raw pixels, OCR/translated text, URLs, tab/document IDs, or password/secret values.
- Scope entries to top-page origin and current pixel digest. Keys also cover provider/model, source/target language, preprocessing, thresholds, ranking schema, and relevant read policy—but exclude priority order. Readable CDN assets may be reused only within the same top-page origin; exclude `data:`/`blob:` identity shortcuts.
- Expire entries after 15 minutes, enforce count/weight bounds, and emit content-free per-stage hit/miss/expiry/revalidation/purge counters.
- Purge on settings reset, read-scope narrowing, origin change, permission loss, or disable; generation-fence stale async completions.
- Preserve password exclusions, inert replica behavior, deterministic selection, and generic—not hostname-specific—admission.

### Ask first

- Disk/`chrome.storage` result persistence, new permissions or host matches, remote services/code, unresolved dependencies, or general CSS-background pixel OCR.

### Never

- Commit on `main`/`master`, push, merge to main, bypass hooks, reuse evidence across origins, expose secrets, restore replica actions, or add Mainichi-specific rules.

## Inputs and outputs

| Input/state | Required output |
|---|---|
| Same-top-origin page reuses an unchanged image | Show current admissible ALT immediately; after capture/hash confirmation, reuse cached stages without OCR/translation/ranking calls. Different top origins cannot hit. |
| Accessibility text arrives before OCR | If it passes the existing generic/admissibility floor, translate/project it provisionally without an Auto-language vote or final settlement; later retain or replace it. |
| OCR/ALT order changes | Rerank retained evidence without source reconnect, recapture, or completed-provider/translation calls; compute only missing evidence. |
| Visible, nearby, and background work coexist | Visible attention targets preempt background work; stable top/left/area ordering plus aging prevents starvation. |
| Scroll, duplicate completion, URL-only navigation, or lease renewal occurs | Rebind retained projections and invalidate only changed semantic, clipping, asset, or policy state. |
| A visible bounded element paints a safe image while its direct text is displaced offscreen | Translate/project the semantic label without background OCR or admitting arbitrary hidden text. |
| A security boundary occurs | Purge reusable evidence and prevent stale work from restoring it. |

## Implementation map

- `entrypoints/sidepanel/main.ts`: cache ownership, purge boundaries, navigation coalescing, build wiring.
- `lib/ocr/image-translation-controller.ts`: detach/purge lifecycle, evidence ledger, provisional ALT, reranking, lease rebinding.
- `lib/ocr/image-analysis-coordinator.ts` and `lib/translation/translation-memory.ts`: TTL-aware bounded evidence.
- `lib/ocr/image-scan-scheduler.ts`: attention order, preemption, aging.
- `lib/ocr/source-image-observer.ts`: clipping-relative invalidation.
- Replica contracts/engines and overlay projector: narrowly admitted painted semantic-label anchors.
- Tests, beta metadata, `dist/chrome-unpacked`, and local `.git/hooks/{pre-commit,pre-push}` with fail-safe preservation of any active pre-existing hook.

## Tasks & Acceptance

1. [x] Add same-top-origin, pixel-confirmed TTL evidence, content-free counters, and split routine release from irreversible purge.
2. [x] Remove method order from capture invalidation; rerank retained candidates and schedule only missing work.
3. [x] Add provisional accessibility projection and correct final promotion/replacement.
4. [x] Add deterministic attention scheduling, preemption, and starvation protection.
5. [x] Use clipping/semantic/asset observation tokens, retain projection blueprints, and deduplicate navigation refreshes.
6. [x] Add safe painted semantic-label admission/presentation without broad background OCR.
7. [x] Add tests, build identity/artifact, and executable repository-local hooks.

### Acceptance criteria

1. Same-top-origin reload/navigation reuses pixel-confirmed stages before OCR; changed pixels, different top origins, expiry, reset, narrowing, disable, and permission loss miss/purge.
2. Admissible ALT appears while OCR is blocked, but generic labels such as “CDN Media” do not flash; provisional text remains vote-free and is retained/replaced deterministically.
3. Reordering updates the winner from retained evidence without recapture or calls for cached stages; only absent recognition/translation evidence runs.
4. Visible work deterministically preempts background work without starvation.
5. Repeated pure scroll, identical configuration/observer delivery, duplicate navigation completion, and lease renewal over stable content produce zero new full-page OCR jobs; clipping/asset changes affect only relevant items.
6. A Mainichi-style background logo with displaced direct text gains a translated visible overlay; ordinary hidden text/background decorations remain excluded.
7. Caches/diagnostics contain no raw URL, pixels, password, tab, or document identifiers; stale results cannot refill a purged generation.
8. Hooks preserve or fail safely around active existing hooks, permit feature-branch commits, reject `main`/`master` commits, and reject all pushes with a clear message.
9. `npm run check` passes and the rebuilt unpacked extension shows the new beta identity.

## Verification

- Unit-test keys, TTL/eviction/origin isolation, hash confirmation, stage counters, purge fencing, provisional/final transitions, cached reranking, scheduler behavior, stability/coalescing, lease rebinding, and semantic-label inclusion/exclusion.
- Run focused tests, `npm run check`, and the production unpacked build.
- Invoke hooks locally without contacting a remote; manually refresh/reorder/navigate and verify Mainichi’s logo in Chrome.

## Context references

- `_bmad-output/project-context.md`
- `_bmad-output/implementation-artifacts/spec-rank-image-text-evidence.md`
- `_bmad-output/implementation-artifacts/spec-refresh-cache-duns-reddit-pass.md`
- `_bmad-output/implementation-artifacts/spec-fix-accessible-navigation-image-ocr.md`

## Suggested Review Order

**Runtime ownership and invalidation**

- Controller wiring centralizes cache ownership, lifecycle purges, and extension diagnostics.
  [`main.ts:561`](../../entrypoints/sidepanel/main.ts#L561)

- Navigation handling coalesces document loads, history URLs, and completion captures.
  [`main.ts:1118`](../../entrypoints/sidepanel/main.ts#L1118)

- The gate retargets debounced history changes without duplicating full captures.
  [`navigation-refresh-gate.ts:6`](../../lib/navigation-refresh-gate.ts#L6)

**Cached evidence and progressive selection**

- Provisional accessibility evidence renders early while final comparison continues.
  [`image-translation-controller.ts:2679`](../../lib/ocr/image-translation-controller.ts#L2679)

- Controller evidence crosses same-origin documents only after current-pixel confirmation.
  [`image-translation-controller.ts:2830`](../../lib/ocr/image-translation-controller.ts#L2830)

- Raw provider evidence supports threshold and order recomposition without rerunning OCR.
  [`image-analysis-coordinator.ts:365`](../../lib/ocr/image-analysis-coordinator.ts#L365)

- Translation memory adds bounded TTL, coalescing, and generation-fenced purges.
  [`translation-memory.ts:30`](../../lib/translation/translation-memory.ts#L30)

- Retained projection blueprints rebind across replica leases without recomputation.
  [`image-translation-controller.ts:3510`](../../lib/ocr/image-translation-controller.ts#L3510)

**Priority and stability**

- Attention ordering preempts background work while aging prevents starvation.
  [`image-scan-scheduler.ts:518`](../../lib/ocr/image-scan-scheduler.ts#L518)

- Mutation handling limits security and clipping remeasurement to affected images.
  [`source-image-observer.ts:585`](../../lib/ocr/source-image-observer.ts#L585)

- Stylesheet and protected-subtree changes receive bounded safety rescans.
  [`source-image-observer.ts:696`](../../lib/ocr/source-image-observer.ts#L696)

**Replica semantics**

- Generic painted-label admission exposes displaced safe text without broad background OCR.
  [`painted-semantic-label.ts:117`](../../lib/replica/painted-semantic-label.ts#L117)

- Fragment aggregation preserves complete labels before either replica engine projects them.
  [`painted-semantic-label.ts:93`](../../lib/replica/painted-semantic-label.ts#L93)

- Both replication paths share the same isolated semantic-label presentation.
  [`isolated-html-engine.ts:3670`](../../lib/replica/isolated-html-engine.ts#L3670)

- rrweb consumes the identical semantic-label contract and aggregation behavior.
  [`rrweb-shadow-engine.ts:1289`](../../lib/replica/rrweb-shadow-engine.ts#L1289)

**Regression coverage and artifact identity**

- Controller tests cover provisional ALT, same-origin reuse, reranking, and purge boundaries.
  [`image-translation-controller.test.ts:2193`](../../tests/image-translation-controller.test.ts#L2193)

- Provider tests prove reorder reuse, blank evidence, and confidence re-filtering.
  [`offscreen-ocr.test.ts:734`](../../tests/offscreen-ocr.test.ts#L734)

- Scheduler tests exercise visible preemption and bounded starvation.
  [`image-scan-scheduler.test.ts:147`](../../tests/image-scan-scheduler.test.ts#L147)

- Observer tests exercise stylesheet-driven security overlap and targeted invalidation.
  [`source-image-observer.test.ts:791`](../../tests/source-image-observer.test.ts#L791)

- Painted-label tests cover admission, privacy exclusion, aggregation, and teardown.
  [`painted-semantic-label.test.ts:35`](../../tests/painted-semantic-label.test.ts#L35)

- Artifact configuration pins the exact reloadable beta identity.
  [`wxt.config.ts:12`](../../wxt.config.ts#L12)

- Artifact verification confirms the synchronized unpacked build identity.
  [`extension-artifact.test.mjs:628`](../../tests/extension-artifact.test.mjs#L628)
