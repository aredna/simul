# Handover: implement F2 and bump the build identity (2026-09-08)

Follows `handover-2026-09-08-l4-followup.md`. Same branch
`feat/ui-string-catalogue` / PR #22; a follow-up on top of the D41 commit
`8434078`. Reasoning is decision-log **D42**.

At the owner's direction, two things that the prior handover left owed/deferred
were done now, ahead of the manual Chrome pass:

1. **F2 implemented** — the imperative status surfaces re-localize on a pure
   language switch, not only at set-time.
2. **Build identity bumped** to `0.4.0 beta v.20260908.1`, and going forward it
   should be bumped on **every** change so the newest build is always
   identifiable (this overrides the earlier "bump only after the browser pass"
   rule — see D42 for why).

## What was done (F2)

All four surfaces are re-driven from `relocalizeDynamicSurfaces()` in
`entrypoints/sidepanel/main.ts` (the localizer's `onApply` hook), mirroring the
existing `ToolbarStatus.relocalize()` / `relocalizeSizeToggle()`.

- **Shared primitive** — `entrypoints/sidepanel/dynamic-status-text.ts`
  (`DynamicStatusText`) stores the last English catalogue **frame + args** and
  re-renders `formatUiTemplate(localize(frame), args)`. Tone stays caller-owned.
- **Composer status** (`quick-composer.ts`) and the three **read-scope** statuses
  — setup / reset / reset-cleanup (`read-scope-controller.ts`) — back onto
  `DynamicStatusText`; each gained a `relocalize()`. Templated cases (the
  pending-cleanup count, the composer error detail) and the copied cleanup
  message are preserved as frame+args.
- **Image-panel status** — the diagnostics empty-state (`imagePanelNoActivity`)
  is the panel's only imperative text (everything else uses the `data-ui` marker
  path the localizer re-drives). New `ImageAnalysisPanel.relocalize()` re-runs
  `renderDiagnostics()`.
- **Detected-language note** (`translation-driver.ts`) embeds a source-language
  name rendered *in the current target language*, so frame+args is not enough. It
  stores a **re-render thunk** capturing the raw inputs; a new
  `relocalizeDetectedLanguage()` re-runs it, re-deriving the language name via
  `localizeLanguageName` in the language now current.

The refactor is output-preserving under an identity localizer, so all prior
tests pass unchanged. New coverage: `tests/dynamic-status-text.test.ts` (5) plus
one language-switch test per surface (composer; read-scope with an interpolated
count; image panel; detected-language re-deriving the language name).

Files: `entrypoints/sidepanel/dynamic-status-text.ts` (new),
`entrypoints/sidepanel/{quick-composer,read-scope-controller,image-analysis-panel,translation-driver,main}.ts`,
`wxt.config.ts`, tests `dynamic-status-text.test.ts` (new) +
`{quick-composer,read-scope-controller,image-analysis-panel,translation-driver,build-identity,extension-artifact}` tests,
and the re-synced `dist/chrome-unpacked`.

## Gate

`npm run check` is green: typecheck clean, **1,396 tests pass, 1 skipped** (+9;
the one skipped is still the Chrome-fixture test), `dist/chrome-unpacked`
re-synced and byte-verified. No CI; run locally with the pinned toolchain
(Node 24.18.0 / npm 12.0.2).

## Still owed — needs a browser this machine lacks

1. **Manual Chrome pass.** All the earlier owed checks stand (the `{0}` frames
   survive on-device translation with correct token order and RTL; the secondary
   imperative surfaces localize). It should **now also confirm the F2 surfaces**
   translate on a pure To-language switch: the composer status, the read-scope
   setup/reset/cleanup statuses, the image diagnostics empty-state, and the
   detected-language note (with the source-language name itself re-derived in the
   new language).
2. **Newly spotted, deferred — method-toggle aria-label.** In
   `image-analysis-panel.ts` `#createMethodList`, the enable/disable checkbox
   `aria-label` is a *templated* string set with `localizeTemplate` directly (not
   the `data-ui` marker path) and is guarded behind the panel `renderKey`, so it
   is stale after a pure language switch — the same class as F5. Left unfixed to
   keep F2 scoped; fold it into the browser pass, and if it reads wrong, re-drive
   it (store its inputs and re-render, or route the aria through `setUiAttr`).
3. **F6 (unchanged, declined)** — memoizing `Intl.DisplayNames` per target
   language; minor allocation cleanup, logged in D41.

## Notes

- The build identity now tracks every change (D42); re-bump `betaBuildSuffix` in
  `wxt.config.ts` (date `.N`) and re-run `npm run artifact:sync` on each edit that
  ships, then the gate's `artifact:check` verifies it.
- The correctness rule still holds: a string localizes only if it is a registered
  catalogue entry. Every F2 frame is a `UI_STRINGS.*` constant, so no bare literal
  reaches the localizer.
