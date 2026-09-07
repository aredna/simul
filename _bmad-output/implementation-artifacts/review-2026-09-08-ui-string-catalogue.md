<!-- Review of PR #22 / branch feat/ui-string-catalogue (D40, resolves L4/L5). Line references are against commit cbb5e2c (1 commit ahead of main eb09813) and the working tree of 2026-09-08. Gate re-run locally with the pinned toolchain (Node 24.18.0 / npm 12.0.2). -->

Code review · Simul 0.4.0 · Chrome MV3 · 8 September 2026

# Review: the L4/L5 UI string catalogue (PR #22, D40)

> **Resolution (2026-09-08, decision-log D41):** F1, F3, F4, F5 and F7 were
> fixed on this branch in a follow-up commit (gate green: 1,387 tests, 1 skipped,
> artifact re-synced). **F2** stays the deferred known gap pending the manual
> Chrome pass. **F6** (minor perf) was not taken. See D41 and
> `handover-2026-09-08-l4-followup.md`.

Reviews commit `cbb5e2c` — "localize the whole UI atomically from one string
catalogue" — the only commit ahead of `main` (`eb09813`). It introduces
`lib/companion-ui-strings.ts` as the single source of truth for code-driven
user-facing English and rewires every side-panel module to read from it, to
resolve **L4** (titles/aria/placeholders/status/loading stayed English while
`data-ui-label` text translated) and **L5** (a newly shown label flashed the
whole UI back to English). Full design in decision-log **D40**.

## Verdict

The PR is functionally sound and mergeable — no crash-class bugs, and the
catalogue/template machinery is correct (`formatUiTemplate` leaves an unmatched
`{n}` intact rather than printing `undefined`; `ALL_UI_STRINGS` is a deduped
derivation of the catalogue, so `setText`/`setAttribute` on catalogue strings
never trip the whole-UI English fallback). But it does **not** fully achieve its
own L4 goal: the toolbar progress presentation (a visible label plus the
progressbar's screen-reader labels) is wrapped in `localize()` yet its source
strings are outside the catalogue, so that surface stays English in a non-English
UI — the same defect class the PR set out to close (**F1**, the one worth fixing
before merge). The rest are localization-completeness and consistency gaps of
decreasing severity; **F2** is the known gap already documented and deferred in
D40.

## Gate (re-verified 2026-09-08)

- typecheck clean · **1,386 pass / 1 skipped** (Chrome fixture) · `dist/chrome-unpacked` byte-verified · exit 0

The green gate does not catch F1/F3: `toolbar-status.test.ts` stubs `localize`
as the identity function, and `companion-ui-strings.test.ts` only asserts
internal consistency (`ALL_UI_STRINGS === Object.values(UI_STRINGS)`). Nothing
ties the strings that actually reach `localize()` to catalogue membership.

---

## F1 · Medium · Toolbar progress + activity labels never localize (residual L4)

**Where:** `entrypoints/sidepanel/toolbar-status.ts:128,137,146,161,173` ·
`lib/companion-ui-state.ts:47-54`

*Verification: confirmed independently by two reviewers and by reading the diff.*

This PR deliberately wrapped the toolbar progress presentation in `localize()`
to fix L4 (the diff shows `'Companion idle'` → `localize(IDLE_LABEL)`,
`toolbarActivityLabel(activity)` → `localize(toolbarActivityLabel(activity))`,
etc.). But every source string it wraps lives **outside** the catalogue:

- `IMAGE_PROGRESS_LABEL` = `'Recognizing visible image text locally…'` — a
  **visible** progress label (`progressLabel.textContent`, shown while image OCR
  runs).
- `IDLE_LABEL` (`'Companion idle'`), `DETERMINATE_FALLBACK_LABEL`
  (`'Translating page'`) — module-local constants.
- The whole `toolbarActivityLabel()` family in `companion-ui-state.ts`:
  `'Changing companion view'`, `'Updating site access'`, `'Building page mirror'`,
  `'Translating quick draft'`, `'Translating page'`, `'Recognizing image text'`,
  `'Companion idle'` — the progressbar's `aria-label` / `aria-valuetext`.

None appear in `UI_STRINGS`, `ALL_UI_STRINGS`, or `DYNAMIC_UI_LABELS`. Since
`UiLocalizer.localized()` returns `#translations.get(english) ?? english` and
`#translations` is built only from those sets plus the DOM `data-ui-*` markers,
every one of these `localize()` calls is an inert no-op that returns English.

**Failure scenario:** with the To language set to Spanish, the settings progress
region reads "Recognizing visible image text locally…" in English during image
OCR, and the compact toolbar progressbar reports "Building page mirror" /
"Translating page" / "Companion idle" in English to a screen reader — exactly the
aria-labels-and-loading-states half of L4, unfixed for this surface.

**Fix sketch:** move these literals into `UI_STRINGS` and have
`toolbarActivityLabel()` return `UI_STRINGS.*` (no import cycle —
`companion-ui-strings.ts` has no imports). They then flow into `ALL_UI_STRINGS`
→ `DYNAMIC_UI_LABELS` and localize by construction. Add a guard test that every
string reaching `localize()` from the toolbar-status/activity paths is a
catalogue member, so this class can't regress.

---

## F2 · Low · Secondary imperative surfaces not re-localized on a pure language switch (known / deferred)

**Where:** `entrypoints/sidepanel/quick-composer.ts:254` ·
`read-scope-controller.ts` (setup/reset status) · `main.ts:1355-1373`
(`renderLoadingState` / `renderErrorState`) · detected-language line
(`translation-driver.ts:264,330`)

*Verification: confirmed — and already documented.* `onApply → relocalizeDynamicSurfaces()`
(`main.ts:387`) only calls `toolbarStatus.relocalize()`. The composer status,
read-scope setup/reset status, replica loading/error text, and the
detected-language line each localize once at set-time with no re-localization
marker, so a To change made while any of them shows a message leaves that
message in the previous language until the surface is next re-driven by its own
flow.

This is the **known gap** the D40 log and `handover-2026-09-07-ui-string-catalogue.md`
already call out and defer pending the manual Chrome pass ("those secondary
surfaces are not yet re-driven on a pure language switch"). No new action needed
beyond what the handover prescribes: if the browser pass shows it reads wrong,
store each surface's last English and re-render it from
`relocalizeDynamicSurfaces()`, mirroring `ToolbarStatus.relocalize()`.

---

## F3 · Low · `#englishProgressLabel` stores already-localized text for templated progress

**Where:** `entrypoints/sidepanel/toolbar-status.ts:160,172` ·
`translation-driver.ts:686-703` vs `:670`

*Verification: confirmed.* `showProgress(label, …)` stores `label` in
`#englishProgressLabel` and re-runs `localize()` on it in `relocalize()`. But its
callers are inconsistent: `translation-driver.ts:670` passes the **raw** key
`UI_STRINGS.progressPreparingModel` (correct), while `:686` and `:695` pass
`localizeTemplate(UI_STRINGS.progressDownloadingPack, …)` / `progressTranslating`
— **already localized and filled**. For those, `#englishProgressLabel` holds
target-language text, so `relocalize()` does `localize(<already-localized>)`,
misses the map, and returns the *old* language string. The field name also
misdescribes its contents.

Impact is limited because determinate progress re-fires `showProgress` on the
next tick (self-healing) and the filled count can't be re-derived by
`relocalize()` anyway — but it is wrong-by-design and inconsistent with the raw
key path. **Fix:** pass raw catalogue keys as `label` and let the label carry no
interpolation, or interpolate the count separately, so `#englishProgressLabel`
truly holds English.

---

## F4 · Low · `setStatus` receives pre-localized strings, breaking the "English message" invariant

**Where:** `entrypoints/sidepanel/toolbar-status.ts:70-82` (invariant) ·
`main.ts:298-304` · `translation-driver.ts:711-722` · `quick-composer.ts:189-195`

*Verification: confirmed as latent; no current functional impact.* D40 states
`ToolbarStatus` "keeps the English message for `statusText` and attention routing
(both still match English)", and the code comments say "Attention routing matches
English keywords, never the localized text." But three callers pass a string that
is *already* localized into `setStatus`: `describePartialReplicaTranslation(...)`
from both the background-result path (`main.ts:298`) and the completion path
(`translation-driver:716`), and the composer error message
(`quick-composer:194`, passed to the toolbar `setStatus` in addition to the
composer-local status). For those, `#englishMessage`/`statusText` hold localized
text and `toolbarAttentionTarget()` runs its English regex against localized
text.

Today there is **no misroute**: none of the affected English strings contains a
`REFRESH_ATTENTION_PATTERN` keyword, so both English and localized fall through to
`'settings'`; and the only `statusText` consumer (`main.ts:1464`) compares
against `statusCancellingTranslation`, which is always set as the English key. But
the invariant is genuinely violated — a future partial/error string containing a
keyword like "mirror"/"rebuild" would route its attention marker wrong in
non-English UIs. **Fix:** have `describePartial` (and the composer error path)
hand `setStatus` the English message plus a separate localized form, or localize
inside `setStatus` only, so attention/`statusText` always see English.

---

## F5 · Low · Size-toggle aria-label/title stuck in the old language after a switch

**Where:** `entrypoints/sidepanel/main.ts:1283-1288`

*Verification: confirmed.* The mirror size-toggle `aria-label`/`title` are
templates (`'Mirror size: {0}. Switch to {1}'`), so they cannot use the
`data-ui-*` marker path and are applied via raw `setAttribute(...,
localizeUiTemplate(...))` inside `syncToolbarPreferenceControls()`. That function
runs on control/zoom changes, not on the async localization pass, and the size
toggle is not in `relocalizeDynamicSurfaces()`. After a pure To-language switch,
the toggle's screen-reader label and tooltip stay in the previous language until
the next size or zoom change. Same class as F2 but a distinct, undocumented
surface. **Fix:** re-drive it from `relocalizeDynamicSurfaces()` (recompute from
current `displayMode`/`zoomPercent`).

---

## F6 · Low · `Intl.DisplayNames` rebuilt on every language-name interpolation

**Where:** `entrypoints/sidepanel/main.ts:551-552` ·
`lib/language-options.ts` (`createSourceLanguageLabeler`)

*Verification: confirmed, minor.* `localizeLanguageName` calls
`createSourceLanguageLabeler(state.preferences.targetLanguage)` — which `new`s an
`Intl.DisplayNames` — on every invocation, and it is called once per interpolated
language name on the status/detected-language path. Every status refresh that
names a language rebuilds the ICU display-names table. **Fix:** memoize one
labeler per target language.

---

## F7 · Low · Double-`formatUiTemplate` via the partial-status localize callback

**Where:** `entrypoints/sidepanel/translation-driver.ts:719` vs `main.ts:298`

*Verification: confirmed, works today.* `describePartialReplicaTranslation`
expects a plain localizer (`english → localized`) and does the
`formatUiTemplate` itself. `main.ts:298` correctly passes `localizeUi`.
`translation-driver:719` passes `(english) => this.environment.localizeTemplate(english)`,
which runs `formatUiTemplate` with empty args first (leaving `{0}` intact only
because of the missing-arg passthrough) and then `describePartial` fills it — a
redundant, fragile double-format that silently breaks if that passthrough ever
changes. **Fix:** pass `localizeUi` here too, matching `main.ts`.

---

## Suggested disposition

| Finding | Severity | Suggested action |
|---|---|---|
| F1 | Medium | Fix before merge (or log as an explicit, tracked L4 follow-up) — it's an inert instance of the PR's own goal. |
| F2 | Low | No new action; already deferred to the manual Chrome pass per D40/handover. |
| F5 | Low | Fold into the same fix as F1/F2 (re-localize on switch). |
| F3, F4, F7 | Low | Cleanups; batch into a follow-up or fix alongside F1. |
| F6 | Low | Minor perf; optional. |

F1 and F5 are both fixable with the F2-class mechanism (participate in
re-localization) plus catalogue registration, so a single small follow-up commit
could close F1/F3/F4/F5/F7 together and would let D40's L4 claim hold for the
toolbar surface too.
