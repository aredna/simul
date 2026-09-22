# Handover: release-readiness pass before the Chrome test and the publish (2026-09-22)

Follows `handover-2026-09-08-f2-and-build-bump.md`. Same branch
`feat/ui-string-catalogue` / PR #22. Reasoning is decision-log **D43**. The
owner plans to reload and test this afternoon, then publish to GitHub for
anyone to use; this doc records what was brought current, what the test should
cover, and the exact publish steps that follow a passing test.

## What was done today

- **Closed the last known localization gap.** The image method-toggle
  checkbox `aria-label` (a filled `Enable {0}` / `Disable {0}` template) now
  re-localizes on a pure To-language switch through
  `ImageAnalysisPanel.relocalize()`, without rebuilding the list. One test
  added. This was the "newly spotted, deferred" item from D42.
- **Build identity is `0.4.0 beta v.20260922.1`** (`wxt.config.ts`, the two
  identity tests, `dist/chrome-unpacked` re-synced).
- **README agrees with the build again** (it still said `v.20260905.1`), and
  now tells testers that the companion's own labels, titles, hints and status
  messages follow the To language once the pair is installed.

Files: `entrypoints/sidepanel/image-analysis-panel.ts`,
`tests/image-analysis-panel.test.ts`, `wxt.config.ts`,
`tests/build-identity.test.ts`, `tests/extension-artifact.test.mjs`,
`README.md`, `dist/chrome-unpacked/{manifest.json,sidepanel.html,chunks/sidepanel-*.js}`,
this doc and the decision log.

## Gate

`npm run check` is green: typecheck clean, **1,397 tests pass, 1 skipped** (the
Chrome-fixture test), `dist/chrome-unpacked` re-synced and byte-verified. No CI
by decision (D32); run locally with the pinned toolchain (Node 24.18.0 /
npm 12.0.2 via `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`).

## Where things stand for publishing

| Item | State |
| --- | --- |
| Repository | Public, MIT, description and topics set, issues on. Private vulnerability reporting, secret scanning and push protection are on. |
| Dependabot | Security updates on. No open alerts (the four earlier ones are fixed) and no open Dependabot PRs. |
| PR #22 | Open, mergeable, merge state clean, five commits (D40, D41, D41 docs, D42, D43). No review checks configured. |
| `main` | `eb09813`: everything through D39. Its checked-in `dist/chrome-unpacked` still carries `v.20260905.1`. |
| GitHub release | `v0.4.0` pre-release (2026-09-05) with `simul-0.4.0-chrome-unpacked.zip`, the `v.20260905.1` build; `main` is 48 commits past that tag and PR #22 adds five more. Someone landing on Releases today gets an older build than a clone of `main`. |
| Icons | Still generated placeholders (owner's choice, D32). |

## Test this afternoon — load `dist/chrome-unpacked` from this branch

Pull `feat/ui-string-catalogue`, Reload the extension card, reload the source
tab, reopen the companion. Simul Options must show
`Build 0.4.0 beta v.20260922.1`; if it shows a 0905 or 0908 build the old
directory is still loaded.

The owed list, accumulated since 2026-09-06, all of it needing a browser:

1. **Side-panel split seams (D31):** detached window (open, return, active-tab
   following), first-run read-scope setup, a settings reset, and the
   image-permission rollback (turn image translation off and confirm the exact
   site grants are re-requested). A busy page (Reddit-class, fixed header over
   images, login form near an image) for the OCR overlap rule, the text-cover
   heuristic and the rebuild budget.
2. **Whole-UI localization (D40–D43).** Switch To to a non-English installed
   pair and confirm: titles, aria-labels, placeholders, status lines and loading
   states translate together with the labels, with no English-then-localized
   flash when a new status first shows; the `{0}` frames keep their values in a
   sensible order (a "Ready to translate X to Y" status, "Translating N of M",
   the partial-projection summary) including an RTL target such as Arabic or
   Hebrew; the toolbar progress labels and progressbar aria-labels; the
   size-toggle aria/title. Then change **only** the To language again and
   confirm the composer status, the read-scope setup/reset/cleanup statuses,
   the image diagnostics empty-state, the detected-language note (with the
   source-language name re-derived in the new language), and the image
   method-toggle aria-labels (a screen reader or the Accessibility pane in
   DevTools) all follow.
3. **Replica proofs (D37–D39):** a page with a slider or spinbutton (values
   travel only under the personal-values read scope), an `aria-labelledby` /
   `aria-describedby` control, and a `progressbar` or `meter`.

## Publish runbook — after the test passes

Mirrors the 0.4.0 publish (D32): a publish commit on the branch, a rebase
merge so `main` stays linear, an annotated tag at the merge head, and a GitHub
pre-release carrying a zip of the committed `dist/chrome-unpacked`. The numeric
version needs the owner's word; **0.5.0** is recommended because the tree since
0.4.0 has the side-panel restructuring, four lib-level fix batches, new replica
proofs and the whole-UI localization (0.4.0 itself was a minor bump for a
fix-only line). Commands below assume 0.5.0 and a merge date `MMDD`.

```sh
export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH
git checkout feat/ui-string-catalogue && git pull --ff-only

# 1. Publish commit (identity only; runtime behaviour unchanged)
npm version 0.5.0 --no-git-tag-version        # package.json + package-lock.json
#   wxt.config.ts            betaBuildSuffix = 'beta v.2026MMDD.1'
#   README.md                lines 7, 29 and 30: 0.5.0 and the new suffix
#   THIRD_PARTY_NOTICES.md   line 9: "Simul 0.5.0"
#   tests/build-identity.test.ts        version '0.5.0' and the four suffix strings
#   tests/extension-artifact.test.mjs   version '0.5.0' and the version_name
npm run artifact:sync && npm run check
git add -A && git commit -m "chore: publish 0.5.0 testing build"
git push

# 2. Merge PR #22 (rebase, branch auto-deletes) and fast-forward main
gh pr merge 22 --rebase --delete-branch
git checkout main && git pull --ff-only

# 3. Tag the merge head
git tag -a v0.5.0 -m "Simul 0.5.0 beta (v.2026MMDD.1)"
git push origin v0.5.0

# 4. Zip the committed artifact and create the pre-release
(cd dist && zip -r ../simul-0.5.0-chrome-unpacked.zip chrome-unpacked)   # ~31 MB, *.zip is ignored
gh release create v0.5.0 simul-0.5.0-chrome-unpacked.zip \
  --prerelease --title "Simul 0.5.0 beta (v.2026MMDD.1)" \
  --notes-file _bmad-output/implementation-artifacts/release-notes-0.5.0.md
rm simul-0.5.0-chrome-unpacked.zip

# 5. Verify
gh release view v0.5.0
```

Then log it as D44 (the publish commit, merge SHA, tag, release URL, gate
numbers) and update the state memory.

## Release notes draft (finalize at publish time)

Testing build of the Simul Chrome extension. Build identity
`0.5.0 beta v.2026MMDD.1`, desktop Chrome 138+. Everything runs on-device;
nothing is sent anywhere. Install: download the zip, unzip it, `Load unpacked`
the `chrome-unpacked` folder at `chrome://extensions`; Simul Options shows the
build identity above. The zip is a byte-for-byte copy of the committed
`dist/chrome-unpacked` at the tagged commit, which `npm run check` verifies
against a fresh build.

What changed since 0.4.0 (decision log D31–D43):

- **Companion UI in your language.** Every label, title, hint, placeholder,
  status and progress line follows the To language once that pair is
  installed, switches as one set with no English flash, and the
  imperatively written surfaces (composer, read-scope, image diagnostics,
  detected-language note, method toggles) re-localize on a pure language
  switch. Placeholder frames keep counts and language names in the target
  language's word order.
- **Side panel restructured** into a dozen tested modules (translation driver,
  capture pipeline, read-scope controller, surface switcher, source follower,
  preference client, permission flows, toolbar status, localizer, composer,
  image panel) with a transactional image-permission rollback.
- **Replica proofs.** Slider and spinbutton values travel under the
  personal-values scope; `aria-labelledby` / `aria-describedby` carried as
  relationship proofs; pressed, current and indicator range state as typed
  ARIA proofs; contradictory tablists withheld; clipping by the padding box;
  controlled-content admission refreshed for any attribute on a participant
  path; a selected panel painted by a remote selector change is re-admitted.
- **Scroll.** The nested-scroller scan is budgeted over real candidates and
  progress survives documents deeper than the protocol bound.
- **Image text.** A shadow host counts as the image's ancestor, not an
  overlay; discovery ranks by attention beyond the DOM-order prefix; a
  retained overlay that a new replay lease cannot install is re-queued.
- **Background and preferences.** Toolbar authorizations are ordered across
  service-worker lifecycles; Simul releases only the host grants it relied on;
  Hebrew probes `he` before the legacy `iw` tag.
- **Housekeeping.** The GitHub Actions workflow and Dependabot config are
  removed; verification is the local `npm run check` gate.

Known limits: icons are placeholders; the Chrome-fixture disclosure test
skips without a browser.

## Still owed after the publish

- The manual Chrome pass is the only thing between this branch and the
  release; nothing else is blocked.
- F6 (memoizing `Intl.DisplayNames` per target language) stays declined (D41).
- `deferred-work.md` still holds the 28 research-sized entries listed in
  `handover-2026-09-06-batches-merged.md`.
