# Review: PR #22 before the bug hunt (2026-09-22)

Scope: the sixteen commits on `feat/ui-string-catalogue` against
`origin/main` (`eb09813`), head `5a55302`, source and tests only (docs, `dist/`
and the lockfile read for consistency). Reviewed in three areas (replica
privacy D44/D45/D49/D50, side-panel localization D40–D43, translation and OCR
D46–D48) plus the open carousel-overlay item. Every finding below was checked
against the code; "confirmed by run" means a throwaway script or test in the
session scratchpad reproduced it (none were committed). No code was changed.

Baseline: `npm run check` re-run at `5a55302`: exit 0, **1,415 tests pass,
1 skipped**, working tree clean.

## Status (updated the same evening)

The owner chose four fixes, each shipped as its own build, and ruled on two
questions:

| Build | Decision | Fixed |
| --- | --- | --- |
| `.10` | D51 | L1: read-scope descriptions |
| `.11` | D52 | O1 + O2: overlays clipped to what the page shows, hidden while unpainted, following slide motion |
| `.12` | D53 | G1: a pending reset can't re-adopt the broad grant. G3: the OCR button turns OCR off after a refusal. G4: docs |
| `.13` | D54 | P1 + P2: the D45 and D49 paint checks read opacity, `content-visibility`, clips and collapsed boxes |

Rulings:
- **G2:** keep the simplest option. One broad grant stays while any enabled
  feature, including default-on image text, uses it. No change.
- **G4:** alt-text captions stay on after setup. Docs fixed.

Still open: L2–L9, O3, P3–P6, the process items, and the simplification
proposal at the end of this file. T1–T3 were fixed in D68 (2026-09-23); the
D54-addendum rulings below were implemented in D66.

Owner rulings on the proposal (D54 addendum), queued until after the bug hunt:
- The default read scope becomes **Full visible**, and the user can reduce it.
  This replaces R10/R11's forced question. The number of profiles may shrink
  later.
- **Keep most toolbar buttons.** The owner may remove some after going
  through them one by one, so R2–R6 wait.
- **Tab follow:** keep the toggle, make `active` the default, and find two
  clearer words than "Active"/"Current". Candidates: Follow/Pinned, Any
  tab/This tab, Switches/Stays.
- **Mirror size:** the default becomes **1:1**.

## Summary

| ID | Sev | Area | Finding | Evidence |
| --- | --- | --- | --- | --- |
| L1 | High | Localization | Read-scope toggle descriptions are deleted by every localization pass | confirmed by run |
| O1 | Medium | Overlay | Image overlays are not clipped by the image's clipping ancestors (carousel item) | code |
| O2 | Medium | Overlay | Overlays are not re-measured when a CSS transition ends (carousel item) | code |
| G1 | Medium | Grants | Reset with pending cleanup, then setup, keeps `<all_urls>` and reports cleanup complete | confirmed by run |
| G2 | Medium | Grants | Turning All sites off no longer releases `<all_urls>` (OCR is on by default) | confirmed by run |
| G3 | Medium | OCR toggle | After a denied grant the toolbar OCR button can only re-prompt, never turn OCR off | code |
| G4 | Medium | Product | Completing setup turns accessibility text on, so every alt-bearing image gets a caption band by default | code |
| P1 | Medium | Privacy | D45: declared-hidden text ships when it is hidden by opacity, `content-visibility`, `clip` or `clip-path` | confirmed by run |
| P2 | Medium | Privacy | D49: a collapsed (`max-height:0`, `opacity:0`) region behind a stateless button ships its text | confirmed by run |
| L2 | Medium | Localization | The status line cannot re-localize filled templates or composite messages | confirmed by run |
| L3 | Medium | Localization | Language names are rendered in the To language even when the UI is English | code |
| L4 | Medium | Localization | Catalogue sentences passed as error details reach `{0}` untranslated | code |
| L5 | Medium | Localization | Page-access guidance strings are outside the catalogue | code |
| T1 | Medium | Translation | A stale translation task can swallow the request for a newer snapshot | driver confirmed by run; trigger plausible |
| L6–L9, P3–P6, T2–T3, O3 | Low | various | see below | |

## Where each finding shows up in Chrome

Use this list while testing the extension.

- **Settings → read scope (L1).** Open Settings with any To language. The small
  description under each read-scope toggle ("Credential and card data stay
  blocked." and the others) disappears as soon as a localization pass runs. It
  comes back only when the controls are re-synced. The same happens in the
  mandatory setup dialog.
- **freee.co.jp carousel (O1, O2).** After a slide change, the translated text
  sits beside the carousel or over the wrong slide. A carousel that uses a
  fade effect would show every slide's caption stacked in one spot.
- **Switching To while a status is shown (L2, L3).** The "Ready to translate …"
  line stays in the old language, or mixes English words with language names
  in another language, e.g. "japonais to français". The partial-translation
  warning drops back to English after a switch.
- **Denying the OCR grant (G3).** Click OCR on a fresh profile and deny
  Chrome's prompt. After that, every click prompts again. OCR can only be
  turned off from Settings.
- **Reset all (G1) / All sites off (G2).** In `chrome://extensions` → Simul →
  Site access, "On all sites" is still granted after the steps below.
- **A page with many images that have alt text (G4).** After setup, each such
  image above the small-image threshold gets a white caption band, and the
  page text translates when the companion opens.

## Overlay (open item from the D50 addendum)

**O1. Overlays escape the image's clipping ancestors.**
`lib/ocr/image-overlay-projector.ts:317` places each image's overlay root at
`image.getBoundingClientRect()` inside one `position: fixed` layer
(`:559`) at the maximum z-index. The only clipping is the viewport (the
layer) and the image's own box (the root). A carousel's `overflow: hidden`
window, a scroll container's edges, and `clip-path` on an ancestor are ignored.
Label-based captions (D48) need no pixels, and the scan policy is
`visible-first-background-prescan`, so slides outside the carousel's window
get captions too. Each of those captions is painted where its slide sits,
outside the carousel, which fits "text that shows up outside of the image".
The same design paints overlays over sticky headers and page modals.
Separately, an image hidden with `opacity: 0` (Swiper's fade effect stacks
every slide in one place) still gets its overlay.

**O2. No re-measure after motion.** As the D50 addendum says, the projector
refreshes on scroll (capture, `:266`), resize, ResizeObserver and the engine's
layout callback. None of these fires when a `transform` transition ends. On
its own, O2 would put the text over the neighbouring slide. Together with O1,
text measured before the move is drawn where the incoming slide was, outside
the carousel window.

**Suggested fix (both together):**
1. In `#refreshEntry`, return early (root hidden) when
   `image.checkVisibility({ opacityProperty: true, visibilityProperty: true })`
   is false. Chrome 121+ supports this, and Simul needs 138+.
2. Compute the visible rect: intersect the image rect with every ancestor in
   the replay document whose computed `overflow-x`/`overflow-y` is not
   `visible` (also `contain: paint`). Hide the root when the result is empty,
   otherwise set `clip-path: inset(…)` on it. Cache the clipping-ancestor list
   per entry and rebuild it on a patch, so scroll frames only read rects.
3. Listen for `transitionrun`, `transitionend`, `transitioncancel` and
   `animationend` (capture) on the replay window. While transitions are running,
   refresh once per frame with a hard cap (e.g. 1 s). Refresh once more at the
   end.

This covers more than option (b) in the addendum (`transition: none` on
reconstructed HTML): (b) fixes neither clipping nor fade carousels, and it
changes page fidelity. `docs/image-translation-research.md:52` already
describes the overlays as "clipped", so the fix makes the docs accurate. Test
it in `tests/image-overlay-projector.test.ts` with a stubbed ancestor rect and
computed overflow. linkedom has no layout, so the existing tests already stub
`getBoundingClientRect`.

**O3 (low). Caption band legibility.** On short images, the 20px minimum band
minus the 4px/6px padding leaves under 12px for text. Long alt text in a band
34% of the image height shrinks to the 3px minimum font and gets clipped. Let
the band grow (to about 60%) when the fitted font would drop below about 9px.
The band also ignores `object-fit` letterboxing.

## Grants and OCR defaults (D46, D47)

**G1. A reset can leave the broad grant and report success.**
`lib/preference-coordinator.ts:633` (`withGrantLedger`) runs on every save.
D47 says it "never runs before a pending cleanup", and it does. Reproduction:
start with All sites on, `<all_urls>` granted and in the ledger. Reset all
while `permissions.remove` fails, so cleanup stays pending with an empty
ledger. Complete the setup dialog: the ledger now holds `<all_urls>`, because
OCR is on by default and the grant is still present. Retry cleanup: the
result is `{"status":"complete","remainingManagedOrigins":0}`, but Chrome
still holds `<all_urls>`. The README promises that reset clears every grant.
Fix: skip adding to the ledger while `resetCleanupPendingRevision > 0`, or
finish the pending cleanup first, as `reconcile` does.

**G2. All sites off keeps `<all_urls>`.** `lib/preference-coordinator.ts:363`
releases the broad grant only when `!current.imageTranslationEnabled`, and
`retainedPermissionOrigins` keeps it whenever OCR is on. With OCR on by
default, a grant made for all-sites translation now survives switching All
sites off. Pixel OCR then uses it on every page, although the user never
clicked OCR. Reproduced: `commit-auto all` then `commit-auto off` leaves
`<all_urls>` granted. The tests that cover this now pin OCR off
(`tests/preference-coordinator.test.ts`, "owns the broad grant once all-sites
automation relies on it…"; `tests/permission-flows.test.ts`, "rolls a fresh
grant back when the save fails"), so the default state is not tested.
Suggested fix: record *why* a grant is held (automation vs. image access) in
the ledger, and use that one rule here and in `resetRetainedPermissionOrigins`.
That also removes the reset special case. **Needs an owner ruling:** should
default-on OCR be allowed to inherit a grant the user gave for automatic
translation?

**G3. The toolbar OCR button can't turn OCR off after a denial.**
`entrypoints/sidepanel/main.ts:785`: when OCR is on, image access is missing,
and a pixel provider is usable (Tesseract always is), every click calls
`changeImageTranslationEnabled(true, true)`, which re-prompts. A denial leaves
OCR on ("Pixel OCR remains paused"), so the next click prompts again. Because
of D46, OCR on also means the page translates on open, so the toolbar offers
no way out. Fix: after a denial in this panel session, make the next click
turn OCR off. Or use the grant flow only when the status is "needs access
and never asked".

**G4. Accessibility text is on after setup (owner ruling).**
`lib/preference-coordinator.ts:257` enables the accessibility-text method when
the mandatory setup completes. This was on `main` too, but on `main` OCR was
off by default. With D47, every user who finishes setup gets a caption band
and a Translator call for each alt-bearing image on every page, with no grant
needed. D47's line "the accessibility-text method stays disabled by default"
is only true before setup. Either keep that method off until the user turns
it on, or correct D47 and the README.

**T1. A stale task can swallow a newer request.**
`entrypoints/sidepanel/translation-driver.ts:648` keys a task by pair and
capture generation only. A request for a newer snapshot in the same
generation joins the old task. That task then fails `stillCurrent()` and
returns without translating or setting a status. A scratch test confirmed the
driver behaviour (`translateCurrent` called once, `translationComplete`
false, no status). The trigger is plausible: switching OCR on during a
same-page rebuild (D46's `requestAutomaticTranslation`), and then the
commit's automatic translation is deduplicated into the stale task. The
visible symptom would be image overlays on an untranslated page. Fix: add the
snapshot and `replayLease` to the key, or skip the D46 request while a
capture is in flight, since the commit translates anyway.

**T2 (low).** `permission-flows.ts:193` awaits the D46 page translation
inside the permission lock. The Settings OCR toggle and Grant button stay
disabled for the whole translation. A throw there reports "Chrome could not
update image access…" even though the setting was saved. Call it with `void`
after `finally`.

**T3 (low).** `preference-client.ts:82` falls back to the defaults when
storage can't be read, and the defaults now have OCR on, which also triggers
the D46 page translation. Use a fallback that keeps OCR off.

## Replica privacy (D44, D45, D49, D50)

No password, OTP or card value leaks: every scenario built around those,
including a password input inside a stateless-controlled region, stays
withheld. The two medium items below make the replica show text that `main`
withheld.

**P1. D45's paint check is weaker than the strict one.**
`lib/replica/html-mirror-sanitizer.ts:3874–3898`: when an element is declared
hidden but its computed style shows it, only `display`, `visibility` and a
positive client rect are checked. `opacity: 0`, `content-visibility: hidden`,
`clip` and `clip-path` are ignored, although `sourcePaintInputs`
(`source-privacy-policy.ts`) treats all of them as hidden. Cases that ship
text on head and are withheld on `main`:
- `<div hidden="until-found" style="padding:12px">`: Chromium renders it
  with `content-visibility: hidden`, not `display: none`.
- An `aria-hidden="true"` account dropdown faded out with `opacity: 0`.
- A panel clipped away with `clip-path: inset(100%)`.

Fix: reuse `sourcePaintInputs` (or one shared helper) for the D45 branch
instead of the partial copy in `hasSourcePositivePaintBox`.

**P2. D49 opens collapsed regions.** `source-privacy-policy.ts:333` grants
`controlled-region` without a paint check. The comment says hidden-region
rules decide, but those rules only see `display`, `visibility` and the
declarations. Example: `<button aria-controls="p">Show details</button>` with
no `aria-expanded`, controlling `<div id="p" style="max-height:0;overflow:hidden">`.
The panel's text is shipped. Fix: grant `controlled-region` only when
`sourceElementPathIsPainted(panel, …)` passes; the Swiper wrapper passes
that check.

**P3 (low). Role edge cases fail open.** `normalizedSourceRole` (`:1008`)
returns `''` for a multi-token role, and `closestSourceTablist` (`:722`)
returns `undefined` for an unreadable path. Both count as "stateless", which
contradicts the fail-closed docstring. `role="switch button"` is treated as
stateless. Fix: stateful if any token is a stateful role, and treat
unreadable as stateful.

**P4 (low, existed before this branch).** Under passive fidelity,
`resolvedStyleSheetText` still ships the CSS of a `<style>` inside a
privacy region. D44's claim that "a privacy boundary still withholds" it
holds only for the raw-text path. Skip the hint inside privacy regions or
correct the claim.

**P5 (low).** A `role` change on an ancestor (for example a container that
gains `role="tablist"` after hydration) doesn't refresh the controlled-content
policy (`source-privacy-policy.ts:458–462`). Also check `contextElements` in
that branch.

**P6 (low, accepted trade-off).** Under D50, a masked value inside an `<a>` or
`<button>` whose class flips twice in one batch is no longer made a sticky
secret. It is caught only if it was masked when first scanned. Pin this in a
test and name it in `docs/replica-fidelity.md`.

**Nits.** Unreadable `display`/`visibility` falls through to the box check,
although the comment says the declaration is kept. `hasSourceWithheldAncestor(el, undefined)`
means "privacy only", and an explicit flag would be safer. In
`tests/carousel-move-patches.test.ts:323`, the case "…itself becomes a value
control" records `textbox` as the *old* role, so the name is backwards.

## Side-panel localization (D40–D43)

The core `UiLocalizer` holds up: no stale or partial pass is applied, and
translator failures fall back to English as one set.

**L1 (high). Descriptions deleted.** `entrypoints/sidepanel/read-scope-controller.ts:479`
appends the `<small>` description *inside* the span that carries
`data-ui-label`. `UiLocalizer.applyToDom` (`ui-localizer.ts:293`) compares
that span's `textContent` (label plus description) with the label, so they
never match, and it overwrites the span, removing the child. This happens in
English too. The test stubs `setUiText`, so it can't catch this. Fix: put the
label in its own marked span next to the `<small>`, and add a test that uses
the real `UiLocalizer`.

**L2. The status line forgets how to re-render.** `toolbar-status.ts:78–110`
stores `#englishMessage`, which about 10 call sites fill with an
already-localized filled template: `translation-driver.ts:600` ("Ready to
translate {0} to {1}"), `surface-switcher.ts`, `source-follower.ts`,
`permission-flows.ts`, `preference-client.ts`, `read-scope-controller.ts:273`
and `quick-composer.ts:204`. The F4 composites store an English assembly.
Neither is a catalogue key, so `relocalize()` misses: the text stays in the
old language, and the composites revert to English. These localized strings
also feed attention routing, which matches English keywords. Fix: `setStatus`
takes a frame with its args (or a render function); `DynamicStatusText`
already does this and could back the status line and the progress label.
That also removes the duplicate logic in `#englishProgressLabel` and
`#renderProgressLabel`.

**L3. Language names in the wrong language.** `main.ts:589` builds names
with `createSourceLanguageLabeler(state.preferences.targetLanguage)` even
while the UI set is English, for example when the en→To pair isn't
installed. The result is "Ready to translate japonais to français". `main`
used English names. Fix: expose whether the current set is localized from
`UiLocalizer` and pick names to match.

**L4. Untranslated error details.** Catalogue sentences are thrown as errors
and then shown as `{0}` in a localized frame (`preference-client.ts:134/168`
shown at 149/183, `read-scope-controller.ts:244–252` shown at 273). The
result is "No se pudieron guardar las opciones: Settings were reset in
another companion." Localize the detail at render time.

**L5. Guidance outside the catalogue.** `PAGE_ACCESS_GUIDANCE` and its
siblings (`lib/page-identity.ts:72`) stay English on restricted pages, both in
the status line and in the mirror error panel. Move them into `UI_STRINGS`
and add them to the F1 guard test.

**L6 (low, plausible).** Nothing checks that `{n}` placeholders survive
translation. `formatUiTemplate` misses `{ 0 }` and full-width `｛０｝`. A
mangled frame is then cached in translation memory. Compare the placeholder
sets and fall back to the English frame for that key when they differ.

**L7 (low).** `renderErrorState` (`main.ts:1395`) is not re-driven on a
language switch. The prior review's F2 listed it.

**L8 (low, accessibility).** The composer's character-count `aria-label`
(`quick-composer.ts:110`) is set before the first pass and on input only, and
`relocalize()` (`:268`) doesn't refresh it. Call `syncCharacterCount()` there.

**L9 (low, accessibility).** Text that code writes (the status live region,
the composer and read-scope statuses, the detected-language line, the progress
label) gets no `lang` or `dir`, because only the `data-ui-label` path sets
`lang`. Screen readers read Japanese status text with an English voice, and
Arabic gets no RTL. Set `lang` and `dir="auto"` in `onApply`.

**Nits.**
- `statusResetPendingOne`/`Many` is an English-only plural split.
- Partial-translation fragments are translated out of context and joined with
  an English ", ".
- Percentages are not locale-formatted.
- `partialPrefixLivePartial` duplicates `statusLivePartiallyTranslated`.
- `statusPreparingSafeReset` and `statusPreparingNarrower` are unused because
  `read-scope-controller.ts:361–362` uses the literal strings.
- `index.html:309` and `:365` have no marker.

## Process and docs

- **Build identity in five places.** Every shipped change edits
  `wxt.config.ts`, README (two lines), `tests/build-identity.test.ts` and
  `tests/extension-artifact.test.mjs`. The unit test only exercises formatting
  and doesn't need the current value. Keep the suffix in one small file that
  `wxt.config.ts` and the artifact test both read. Add a test that fails when
  the README doesn't mention it, or an `npm run bump-build` script. During a
  bug hunt with one bump per fix, this saves a step each time and removes a
  way to forget one.
- **Default-state tests.** D47 pinned several grant and rollback tests to OCR
  off. Add default-state versions of those tests (G1, G2, the rollback), so the
  shipped default is the tested one.
- **README step 4** says the page is translated on every visit "only if you
  save automatic translation … or if OCR is on". OCR is on by default, so by
  default a mirrored page translates on open. Say that directly.
- **Handover `handover-2026-09-22-session-close.md`** is slightly stale. It
  says "fifteen commits" (there are sixteen) and "D43 through D49" (D50 is
  there too), and its working notes say the tree is "clean at the D49 commit"
  (it is at `5a55302`).

## Suggested order

1. L1: small, visible in Settings, a clear regression.
2. O1 + O2: the open carousel item. One projector change covers both, and the
   owner can check it on freee.co.jp.
3. G1 and G3: small changes. G2 and G4 after the owner rules on them.
4. P1 + P2: tighten the D45 and D49 paint checks with the existing strict
   helper.
5. L2 + L3 together (one status-rendering change), then L4 and L5.
6. The low items, the identity single source, and the default-state tests, as
   time allows.

Each shipped fix follows the usual routine: identity bump (`.10` next),
`npm run artifact:sync`, `npm run check`, NAS mirror, decision-log entry.

## Simplification proposal

The owner asked what could be simplified, hidden, or moved to an advanced
section. Below is an inventory of every control, checked against the code, and
what to do with each. None of this is implemented.

### What is redundant or never needed today

- **Automatic translation (Off / This site / All sites).** With OCR on by
  default this mostly does nothing extra: an enabled OCR already counts as
  intent to translate the page (`lib/companion-lifecycle.ts:28-40`, D46). "All
  sites" asks for the same `<all_urls>` grant that OCR uses. Only "This site"
  adds anything, and only once OCR is off.
- **The [A] auto-detect toolbar button** does the same as the From select's
  Auto-detect option.
- **The tab-follow toolbar button** is always greyed out in the side panel
  (`main.ts`, `toolbarTabFollowButton.disabled = busy || !isDetachedWindow`).
  "Detached window follows" in Settings duplicates it.
- **"Toolbar opens"** (last used, side panel or window) duplicates the ↗/↙
  button, which already records the choice.
- **The Size select** duplicates the Fit/1:1 toolbar toggle. Moving the zoom
  slider already switches to Custom.
- **Rebuild in the Settings action row** duplicates the toolbar ↻.
- **The image panel** has about 15 controls a normal user never touches:
  - the minimum-confidence slider;
  - three reading methods, each with a toggle, a status badge and ↑/↓ order
    buttons;
  - four help notes;
  - the scan policy and the "skip very small images" switch;
  - two prompt toggles that the build compiles out
    (`tools/ocr-build-profile.ts`, `promptImageLanguage: false`,
    `promptImageText: false`).
- **The mandatory read-scope setup dialog** asks one profile question plus six
  checkboxes before anything shows, and returns after every reset.

### Recommendations

| # | Change | Kind | Size | Privacy / permissions |
| --- | --- | --- | --- | --- |
| R1 | Close the "Readable content" section by default and put its six checkboxes behind a nested "Customize" disclosure; keep the profile select visible | hide | S | none |
| R2 | Drop Rebuild from the Settings action row (the toolbar ↻ stays) | merge | S | none |
| R3 | Remove the [A] toolbar button | merge | S | none |
| R4 | Hide the tab-follow button in the side panel and remove the "Detached window follows" select (the button covers it in the window) | merge | S | none |
| R5 | Remove "Toolbar opens"; always reopen where it was last used | remove | S | none |
| R6 | Remove the Size select; keep Fit/1:1 and the zoom slider | merge | S | none |
| R7 | One closed "Advanced" section for Translated text, Replica fidelity, Follow scrolling, Automatic translation, Replica text, Image text and Reset | hide | S | keep fidelity (it is the only choice that cuts network requests) and keep Reset reachable (the README promises it clears every grant) |
| R8 | Image panel: fix confidence at 65%, the scan policy, skip-small and method order; remove the ↑/↓ buttons, badges, help notes, per-provider toggles and the dead prompt code; keep one "Show image alt text as captions" checkbox and Diagnostics | remove + hide | M | none; pixel OCR still needs the broad grant. Keep the stored preference keys and force defaults on load (`lib/preferences.ts` validates exact key sets) |
| R9 | Remove the image panel's own on/off checkbox and Grant button; the toolbar OCR button becomes the only switch | merge | S | possible now that D53 lets the toolbar turn OCR off after a refusal |
| R10 | Setup dialog: keep the profile select and the button, drop the six checkboxes (they live in Settings) | hide | S | none |
| R11 | **Needs a ruling.** Replace the setup dialog with an automatic Standard commit on first run and after reset, plus a one-line notice | remove | M | widens first-use reading from Page-only to Standard without asking (control labels, control images, collapsed menus); form values, personal data and editable content stay off, and secrets are always blocked |
| R12 | **Needs a ruling.** Hide Automatic translation now (R7). Later, either treat opening the companion as the intent to translate even with OCR off, or remove "This site" and the per-site permission code behind it | hide now, remove later | S / L | removing per-site grants only narrows access |
| R13 | Remove the "Live source only" view (the untranslated page is already in the source tab) | remove | M | none |

Suggested first batch, the biggest simplification for the least risk:
1. R1 + R7: Settings becomes the zoom row, Translate/Cancel, the read profile,
   and one closed Advanced section. Mostly markup.
2. R2–R6: remove the duplicate controls, with no privacy effect.
3. R10 and R9: the setup question shrinks to one choice, and OCR has one
   switch.
4. R8: the image panel goes from about 15 controls to one checkbox plus
   diagnostics.

R11 and R12 each need the owner's ruling. R11 is the only change that
touches a privacy default, so it would also need a decision-log entry and a
README change.
