# Handover: the L4/L5 UI string catalogue (2026-09-07)

Follows `handover-2026-09-06-batches-merged.md`. That handover's "next" item 3
(the L4/L5 string catalogue) is now built on branch `feat/ui-string-catalogue`;
items 1 (build identity) and 2 (manual Chrome pass) are still owed and unchanged.

## What was done

Resolved review findings L4 (titles/aria/status stayed English while labels
translated) and L5 (a newly seen label flashed the whole UI back to English).
Full reasoning is decision-log entry **D40**.

- **`lib/companion-ui-strings.ts`** — new single source of truth for every
  code-driven user-facing English string, plus `formatUiTemplate` for `{0}`
  placeholder frames and `ALL_UI_STRINGS` (derived from `Object.values`, so the
  atomic set cannot drift from the catalogue).
- **`UiLocalizer`** — now localizes `data-ui-title` / `data-ui-aria-label` /
  `data-ui-placeholder` in the same atomic pass as `data-ui-label`, plus
  `localized()`, `localizeTemplate()`, `setAttribute()`, and an `onApply` hook.
- **`ToolbarStatus`** — displays the localized status while keeping the English
  message for `statusText` and attention routing; re-renders via `onApply`.
- Every side-panel module reads its displayed strings from the catalogue; the
  central `setStatus` localizes each status; `index.html` static
  titles/aria/placeholder and dialog/section text carry `data-ui-*` hooks.

## Gate

`npm run check` is green: typecheck clean, **1,386 tests pass, 1 skipped** (the
Chrome-fixture test), `dist/chrome-unpacked` re-synced and byte-verified. There
is no CI; the gate was run locally with the pinned toolchain on the path.

## Owed — needs a browser this machine does not have

1. **Manual Chrome pass for the localization itself.** The unit tests use a fake
   translator; only Chrome's on-device Translator proves the real behaviour.
   Switch the To language to a non-English installed pair and confirm:
   - titles, aria-labels, placeholders, status lines and loading states now
     translate together with the labels (L4), and no English-then-localized
     flash appears when a new status or label first shows (L5);
   - the `{0}` template frames survive translation with their placeholders
     intact and in a sensible order (check a status like "Ready to translate X
     to Y on-device.", the "Translating N of M…" progress, the partial-projection
     summary, and an RTL target such as Arabic or Hebrew);
   - the composer's own status, the read-scope setup/reset status, the
     image-panel status, and the detected-language line localize. **Known gap:**
     these secondary imperative surfaces localize at set-time and the toolbar
     status re-localizes on `onApply`, but they are not yet re-driven on a
     *pure* language switch (a To change with no other state change). If that
     reads wrong in the browser, the fix is to add them to
     `relocalizeDynamicSurfaces()` in `main.ts` (store each surface's last
     English and re-render it), mirroring `ToolbarStatus.relocalize()`.
2. **Build identity** stays `0.4.0 beta v.20260905.1` — still bump it only after
   the browser pass, per the prior handover.

## Notes for the reviewer

- The catalogue holds only code-driven strings. Static markup text keeps its
  English in `index.html` and is gathered from the DOM, so a markup string and
  its catalogue twin cannot diverge (there is no twin).
- Correctness rule: a displayed string localizes only if it exactly matches a
  registered entry. Because call sites now reference `UI_STRINGS.*` and
  `ALL_UI_STRINGS` is `Object.values(UI_STRINGS)`, that match holds by
  construction. Adding a new user-facing string means adding a catalogue key and
  referencing it, never a bare literal at the call site.
- Two internal thrown-and-swallowed error strings in `image-translation-config`
  are intentionally *not* in the catalogue (never shown to the user).
