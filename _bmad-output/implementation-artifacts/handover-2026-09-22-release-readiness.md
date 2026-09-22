# Handover: release-readiness pass before the Chrome test and the publish (2026-09-22)

Follows `handover-2026-09-08-f2-and-build-bump.md`. Same branch
`feat/ui-string-catalogue` / PR #22. Reasoning is decision-log **D43**, its
same-day addendum, **D44** and **D45** (the two freee.co.jp fixes found during
the pass). The owner tests this afternoon, then wants Simul published on
GitHub for anyone to use. Their answers today: the release is **0.5.0**; merge
and release happen **after** their Chrome pass; the version inside the
extension is updated now; the build goes to the NAS so they can load it on
their computer; and the public voice is set (below).

## What was done today

- **Closed the last known localization gap.** The image method-toggle
  checkbox `aria-label` (a filled `Enable {0}` / `Disable {0}` template) now
  re-localizes on a pure To-language switch through
  `ImageAnalysisPanel.relocalize()`, without rebuilding the list. One test
  added and verified to fail with the fix reverted. This was the "newly
  spotted, deferred" item from D42.
- **Hidden regions keep their stylesheet text (D44).** The owner's first
  Chrome check hit https://www.freee.co.jp/: its sign-up modal carries the
  `<style>` that hides it inside itself, and the sanitizer blanked that CSS
  along with the region's page text, so the replica showed the modal's icons.
  Fixed in the sanitizer with a deterministic test; not a regression (0.3.3
  showed it too).
- **Declared-hidden but painted regions keep their text (D45).** The same
  page's footer accordion marks its lists `aria-hidden` while the desktop CSS
  paints them; computed style and a painted box now decide, so those product
  links keep their text. Test added. The README's image-text bullet now
  explains the OCR toggle and that images inside links or buttons need the
  Standard scope.
- **Version is 0.5.0, identity `0.5.0 beta v.20260922.4`.** `package.json`,
  `package-lock.json`, `wxt.config.ts`, README, `THIRD_PARTY_NOTICES.md`, the
  two identity tests, and `dist/chrome-unpacked` all agree. The extension card
  shows `0.5.0`; Simul's settings show `Build 0.5.0 beta v.20260922.4`. What is
  tested is byte-for-byte what will be released.
- **README rewritten for a public reader** (top sections only; the reference
  sections from "How it works" down are unchanged). Voice per the owner: one
  sentence that Simul started as a quick build for the OpenAI Build Week
  hackathon as something we would use ourselves and is now shared for others;
  fully on-device translation with no server, account or key; "What you need"
  (desktop Chrome 138+, about 35 MB, Chrome may download a language pack);
  "Install" from the release zip or the repository download; a short "Use
  Simul". It also says the companion UI follows the To language.
- **NAS.** The committed tree was mirrored to `Dev/simul/` (see below). The
  temporary bisect builds used to locate D44 were removed again.

Files: `lib/replica/html-mirror-sanitizer.ts`, `docs/replica-fidelity.md`,
`entrypoints/sidepanel/image-analysis-panel.ts`,
`tests/image-analysis-panel.test.ts`, `wxt.config.ts`, `package.json`,
`package-lock.json`, `README.md`, `THIRD_PARTY_NOTICES.md`,
`tests/build-identity.test.ts`, `tests/extension-artifact.test.mjs`,
`tests/html-mirror-protocol.test.ts`,
`dist/chrome-unpacked/{manifest.json,page-mirror.js,sidepanel.html,THIRD_PARTY_NOTICES.md,chunks/sidepanel-*.js}`,
this doc and the decision log.

## Gate

`npm run check` is green at the head commit: typecheck clean, **1,399 tests
pass, 1 skipped** (the Chrome-fixture test), `dist/chrome-unpacked` re-synced
and byte-verified. No CI by decision (D32); run locally with the pinned
toolchain (`export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`, Node
24.18.0 / npm 12.0.2).

## Where things stand for publishing

| Item | State |
| --- | --- |
| Repository | Public, MIT, description and topics set, issues on. Private vulnerability reporting, secret scanning and push protection are on. |
| Dependabot | Security updates on. No open alerts (the four earlier ones are fixed) and no open Dependabot PRs. |
| PR #22 | Open, mergeable, merge state clean. Commits: D40, D41, D41 docs, D42, D43, D43 addendum (0.5.0 + README), D44 and D45 (freee fixes). No review checks configured. |
| `main` | `eb09813`: everything through D39; its `dist/chrome-unpacked` still says `0.4.0 beta v.20260905.1`. |
| GitHub release | `v0.4.0` pre-release (2026-09-05) with the `v.20260905.1` zip. `main` is 48 commits past that tag and PR #22 adds eight more. Until 0.5.0 is released, the Releases page serves an older build than a clone of the branch. |
| NAS | `Dev/simul/` on the owner's NAS (the same rsync daemon another project's tooling uses). It held a July checkout (build `0.3.2 beta v.20260725.15`, `.git` on `main`, `node_modules`, `.github`, the old hackathon disclosure doc). The committed tree is now mirrored over it with `--delete` for tracked content; `.git`, `node_modules`, `.output`, `.wxt` and `@eaDir` were excluded and therefore left as they were. Load `Dev/simul/dist/chrome-unpacked`. That folder's stale `.git` no longer matches its working tree; it is a copy, not a checkout to commit from. |
| Icons | Still generated placeholders (owner's choice, D32). |

## Test this afternoon

Load `dist/chrome-unpacked` from the NAS copy or from a pull of
`feat/ui-string-catalogue`. Reload the extension card, reload the source tab,
reopen the companion. The card must show `0.5.0` and Simul's settings
`Build 0.5.0 beta v.20260922.4`; anything else means the old folder is still
loaded.

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
3. **freee.co.jp (D44, D45):** open https://www.freee.co.jp/ and confirm the
   mirror no longer shows the sign-up modal's Google and mail icons at the top,
   and that the footer product links under each "製品" heading carry their
   text; the page should look like the tab, with the 2.7 MB global stylesheet
   fetched by the replica. Still open there: the top carousel's images (see
   D45). For image text, switch the readable-content scope to Standard and turn
   **OCR** on; the banners on this page all sit inside links or buttons.
4. **Replica proofs (D37–D39):** a page with a slider or spinbutton (values
   travel only under the personal-values read scope), an `aria-labelledby` /
   `aria-describedby` control, and a `progressbar` or `meter`.

## Publish runbook — after the test passes

The publish commit is already on the branch (0.5.0, identity
`0.5.0 beta v.20260922.4`), so what remains mirrors the 0.4.0 publish (D32): a
rebase merge so `main` stays linear, an annotated tag at the merge head, and a
GitHub pre-release carrying a zip of the committed `dist/chrome-unpacked`.
If anything else ships before the merge, bump the suffix to `.4` and re-sync
first.

```sh
export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH
git checkout feat/ui-string-catalogue && git pull --ff-only && npm run check

# 1. Merge PR #22 (rebase, branch auto-deletes) and fast-forward main
gh pr merge 22 --rebase --delete-branch
git checkout main && git pull --ff-only

# 2. Tag the merge head
git tag -a v0.5.0 -m "Simul 0.5.0 beta (v.20260922.4)"
git push origin v0.5.0

# 3. Zip the committed artifact and create the pre-release
(cd dist && zip -r ../simul-0.5.0-chrome-unpacked.zip chrome-unpacked)   # ~31 MB, *.zip is ignored
gh release create v0.5.0 simul-0.5.0-chrome-unpacked.zip \
  --prerelease --title "Simul 0.5.0 beta (v.20260922.4)" \
  --notes-file _bmad-output/implementation-artifacts/release-notes-0.5.0.md
rm simul-0.5.0-chrome-unpacked.zip

# 4. Verify, then re-mirror main to the NAS (same rsync as D43) so Dev/simul matches the release
gh release view v0.5.0
```

Then log it as D46 (merge SHA, tag, release URL, gate numbers) and update the
state memory. The README's "latest release" link starts pointing at the right
zip the moment the release exists.

## Release notes draft (write to `release-notes-0.5.0.md` at publish time)

Simul is a Chrome extension that shows a translated copy of the page you are
reading next to the original, translated entirely on your own computer with
Chrome's built-in translator. Nothing is sent anywhere: no server, no
account, no key. It started as a quick build for the OpenAI Build Week
hackathon, made as something we would use ourselves, and we are now sharing
it so others can use it too.

**Install:** desktop Chrome 138 or newer. Download
`simul-0.5.0-chrome-unpacked.zip`, unzip it, open `chrome://extensions`, turn
on Developer mode, choose **Load unpacked**, and select the `chrome-unpacked`
folder. Then open any normal web page and select the Simul icon. Simul's
settings show `Build 0.5.0 beta v.20260922.4`. This is an unpacked beta, so
Chrome does not update it automatically. The zip is a byte-for-byte copy of the
committed `dist/chrome-unpacked` at the tagged commit, which `npm run check`
verifies against a fresh build.

What changed since 0.4.0 (decision log D31–D45):

- **Companion UI in your language.** Every label, title, hint, placeholder,
  status and progress line follows the To language once that pair is
  installed, switches as one set with no English flash, and re-localizes on a
  pure language switch. Placeholder frames keep counts and language names in
  the target language's word order.
- **Hidden modals stay hidden, visible accordions stay readable.** A page
  that hides a modal with a `<style>` placed inside the modal now mirrors
  correctly, and content a script declares hidden but the stylesheet paints
  anyway keeps its text.
- **Side panel restructured** into a dozen tested modules with a transactional
  image-permission rollback.
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
