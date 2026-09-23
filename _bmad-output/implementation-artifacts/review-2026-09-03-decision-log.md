# Decision log: dependency refresh and review fixes (2026-09-03)

Autonomous session following the code review published at
https://claude.ai/code/artifact/a7dde2d3-b6fd-4855-b435-7a08598fe473.
Every non-obvious choice made without you in the room is recorded here, newest
at the bottom. Items marked **Please confirm** are the ones where a different
reading of your instructions would have produced different work.

## Instructions received

1. "Uncommit npm files" — answered as: they need not be tracked; manage them
   following Git best practices; keep local copies until the untracking is
   merged to main.
2. "Fix the local ones we are using" — the Linux machine had a Mac-built
   `node_modules`, npm 11.9 against a required 12, and Node 24.14 against an
   `.nvmrc` of 24.18.
3. "Update packages to latest rather than pin" — nothing released in the last
   7 days (cutoff 2026-08-27); use the newest version before that unless there
   is a legitimate exception.
4. Scope: blockers, High, rrweb quarantine, Medium, and Low findings, in a loop.
5. OCR privacy: allow pixel capture near eligible text inputs; only
   password/private controls block capture. Update test and README.
6. Product goal: run everything locally; avoid reading private data; show
   public data in parallel; no opt-in for private data yet.

## Decisions

### D1. Which "npm files" to untrack — **Please confirm**

Tracked npm-related files are `package.json`, `package-lock.json`, `.npmrc`,
and `.nvmrc`. No `node_modules`, `.wxt`, or `.output` content is tracked.
Git best practice keeps `package.json`, `.npmrc` (project config, no secrets)
and `.nvmrc` tracked; the project cannot build or CI without `package.json`.
The one file whose tracking is a team choice, and the one your "rather than
pin" instruction points at, is `package-lock.json`.

Done: `git rm --cached package-lock.json`, added it to `.gitignore`, set
`package-lock=false` in `.npmrc` so npm neither reads nor writes it, and
switched CI from `npm ci` to `npm install` (npm ci requires a lockfile; the
setup-node npm cache also keys on the lockfile, so it was removed). The local
`package-lock.json` file is left in place, as you asked, to be deleted after
the merge. It is inert while `package-lock=false` is set.

Alternative reading I did not act on: "npm files" as the vendored npm package
copies under `vendor/ocr/tesseract/{worker,core}` and their copies in
`dist/chrome-unpacked`, with "local distro" meaning the `dist/` directory.
That would reverse the documented decision to ship a ready-to-install `dist/`
(README "Install directly in Chrome"). If that was the intent, say so and I
will untrack `dist/chrome-unpacked` and the vendored worker/core files and
regenerate them at build time.

Consequence to be aware of: with floating ranges and no lockfile, a fresh CI
build can differ byte-for-byte from the committed `dist/` whenever a
transitive dependency publishes. See D6 for how the artifact gate was adapted.

### D2. Local environment

- Installed Node 24.18.0 with nvm (matches `.nvmrc`; npm 12 refuses 24.14) and
  made it the nvm default. 24.14.0 remains installed; `nvm alias default
  24.14.0` reverts.
- Enabled corepack so `npm` resolves to the `packageManager` version declared
  in `package.json`.
- Set `git config core.fileMode false` (local repo config, not committed).
  Every file in the checkout is mode 770 because the umask is 0007, which made
  all 522 tracked files show as modified. Git now ignores mode bits here.
- Reinstalled `node_modules` for Linux from the new ranges.

### D3. Branch and commits

You said the untracking would be "merged to main", so work is on the branch
`chore/deps-refresh-and-review-fixes` in logical commits, not pushed. The
first commit captures your uncommitted live-observer bridge work exactly as
found (154 files, plus the new `entrypoints/page-live-observer.ts`) so that my
changes are reviewable as separate diffs on top of it. Nothing was pushed.

### D4. Version choices

| Package | Was | Now | Note |
| --- | --- | --- | --- |
| acorn | 8.17.0 | ^8.18.0 | |
| linkedom | 0.18.13 | ^0.18.13 | newest |
| typescript | 7.0.2 | ^7.0.2 | newest |
| vitest | 4.1.10 | ^4.1.11 | |
| wxt | 0.20.27 | ^0.21.4 | minor bump; see D5 |
| @rrweb/record, @rrweb/replay | 2.1.0 | ^2.1.1 | |
| tesseract.js, tesseract.js-core | 7.0.0 | 7.0.0 (exact) | **exception**, below |
| packageManager npm | 12.0.1 | 12.0.2 | |

Exception: `tesseract.js` and `tesseract.js-core` stay exactly pinned. The OCR
runtime is vendored byte-for-byte from those packages with SHA-256 sums in
`vendor/ocr/tesseract/asset-manifest.json`, third-party notices, and an
artifact validator that requires exact pins so the shipped worker cannot
silently diverge from the validated assets. 7.0.0 is also the newest release,
so nothing is lost today. Bumping them means re-running
`tools/vendor-tesseract.mjs` and updating the approved constants, which is a
deliberate release step.

Overrides: the previous `overrides` block force-pinned five transitive
packages (`adm-zip`, `esbuild`, `fx-runner`, `tmp`, `uuid`). After the
upgrade none of them is installed at all: wxt 0.21 stopped bundling
`web-ext`, which was the only consumer of four of them, and Vite 8 no longer
depends on esbuild. The block was removed; `npm audit` reports 0
vulnerabilities and the install shrank from 318 to 182 packages.

`allowScripts` is a real npm 12 feature (install scripts are blocked by
default and this field approves them), so it was kept and switched to
name-only entries that survive version bumps. `tesseract.js` is denied
explicitly; its postinstall only prints a funding message.

### D5. wxt 0.21 adaptation

Breaking changes that applied here: Vite became a peer dependency
(`vite@^8.2.2` added; Vite 8 is rolldown-based), `@types/node` stopped
arriving transitively (`@types/node@^24.13.3` added; typecheck needed it for
`process` and `node:` imports in tests and `wxt.config.ts`), and unlisted
scripts no longer expose a global by default. The last one is harmless: the
page bundles install their own bridge globals and the side panel never reads
the injection return value of a file injection. `web-ext` is now an optional
peer and was not installed; `npm run dev` still serves the extension but
will not auto-launch a browser until it is added.

Verification: typecheck, all 693 tests, a fresh production build, and the
artifact validator pass on the new toolchain. The rebuilt `dist/` was
resynced.

### D6. Artifact gate under floating dependencies

`npm run check` still byte-compares a fresh build against the committed
`dist/chrome-unpacked`. Without a lockfile, a transitive patch release can
change build output bytes on a day nobody touched the source, and CI will
then fail with "run npm run artifact:sync". I kept the strict compare because
it is the only proof that the shipped directory came from this source; the
cost is an occasional resync commit. If that becomes noisy, the softer option
is to have CI validate the committed artifact for safety (permissions, no
remote code, size, markers) and validate the fresh build, reporting drift as
a warning. Say which you prefer.

### D8. rrweb quarantine — **Please confirm**

Your July spec says "Preserve RRWeb as an experimental engine only"; today's
answer selected the review's quarantine recommendation. I reconciled the two
as: keep every rrweb source file and its tests in the repository, but compile
the engine only when a build sets `WXT_SIMUL_RRWEB_SHADOW=1` (previously it
was compiled in unless the flag was `0`). The release build now ships neither
`page-recorder.js` nor `@rrweb/replay`; the side-panel chunk shrank from
547 KB to 285 KB. The artifact validator proves this in both directions: a
recorder bundle must come with the replay runtime, and the replay runtime
must not appear without the recorder. A saved `rrweb` engine preference
silently resolves to Isolated HTML in the release build, and the option is
removed from Settings. If you want rrweb removed from the repository instead,
that is a follow-up deletion of about 6,500 lines and two dependencies.

The rrweb-specific defects from the review (import bypass, CSSOM blindness,
non-convergence, quadratic sanitizer) were **not** fixed; they are now
unreachable in the release build. They still apply to an opt-in developer
build.

### D9. OCR privacy policy

Per your answer, an image overlapping an ordinary public text control is now
capturable; only password and other private controls block capture. This
matches "avoid reading private data; show public data in parallel". The
README and the capture-safety test say so explicitly.

### D10. HTML lang stays authoritative

The review flagged that `<html lang>` always wins over content detection
(M16). Your July spec records "Keep HTML lang authoritative for Auto-detect,
per the human's explicit decision", so this was left alone. If you want the
cross-check the review suggested, say so.

### D11. Detached window geometry — **Please confirm**

The detached companion used to open at the source window's full bounds,
covering the page it mirrors. It now docks to the right edge at 45% of the
source width (minimum 480 px, never wider than the source). The deferred-work
list notes that real side-by-side pairing needs a separate window-management
pass; this is only a better default until then.

### D12. Placeholder icons — **Please replace**

The manifest had no icons, which shows a generic letter on the toolbar and
would fail a Web Store submission. `public/icon/{16,32,48,128}.png` are
generated placeholders (deep-green rounded square with a page and its offset
mirror). Replace them with the real mark whenever you have one; the validator
now requires all four sizes. The vendored OCR runtime is added through WXT's
`build:publicAssets` hook so `public/` always ships.

### D13. Engine failures are per page, not per lifetime

`stream_overflow`, `checkpoint_too_large`, `capture_timeout`,
`replay_timeout`, `capture_busy`, `stale_identity` and `access_denied` no
longer disable Isolated HTML for the rest of the session. The user still sees
the fallback for that page; the next page runs the engine again. Protocol and
privacy failures (`replay_failed`, `invalid_message`, `privacy_rejected`)
still disable it, as before.

### D14. UI-label localization needs an installed pair

Menu-driven label localization previously called `Translator.create()` for a
merely downloadable pair, which either started a multi-megabyte download as a
side effect of picking a language or threw `NotAllowedError` silently. Labels
now localize only when the pair is already installed; the explicit
"Translate page" click prepares the pair, after which the labels follow. The
quick-translation composer is an explicit click and is unchanged.

### D15. Same-document navigation

A `tabs.onUpdated` URL change without `status: 'loading'` whose normalized
URL (no query, hash or credentials) is unchanged now updates the followed
identity in place instead of aborting translation and rebuilding. A real load
still rebuilds. Query changes that trigger a load are unaffected.

### D16. Orphaned page bridges

After an extension reload the isolated world keeps running with an
invalidated runtime. The live observer now disconnects itself on the first
failed send when the runtime id is gone, instead of retrying for the page's
lifetime. Retries for a live runtime are unchanged. The side panel also
acknowledges dirty and scroll messages so consumed messages are not resent.

### D17. Private-control tokens and crossorigin

`one-time-code` and every `cc-*` autocomplete token now make a text control
private, like passwords. `crossorigin` is stripped from every element so a
replica resource request cannot carry the extension origin. Not done: the
receiver still cannot re-check autocomplete because the source strips it, and
the font-based target-language leak under Passive Fidelity remains (it is
inherent to allowing remote fonts); both are documented limits rather than
fixes.

### D18. OCR lifecycle (round two)

- Overlays no longer vanish on every scroll. The observation token now keys
  on rendered size and the share of the image inside the viewport (bucketed
  to 0/25/50/75/100%) instead of the absolute position. An image scrolling
  further into view still re-captures; a 1 px scroll does not. When the
  viewport size is unknown the raw position is used, as before.
- A caller-side cancel (scroll) keeps the Tesseract worker warm and lets the
  abandoned recognition drain; only disposal and timeouts terminate it. The
  next job may wait briefly behind the abandoned one; that is far cheaper
  than the 3.9 MB core fetch and WASM compile a re-bootstrap cost. Worker
  bootstrap has its own 60 s deadline separate from the 30 s recognition
  deadline.
- An inactive source tab, an unavailable OCR host, a host overflow, missing
  input, or a lost worker now defer the image instead of marking it done for
  the session. `ImageTranslationController.resume()` re-queues deferred
  images when the followed tab is activated or the companion becomes visible.
- The IndexedDB transient store no longer caches a failed open forever.
- Pixel capture is deferred while a non-ancestor element carrying its own
  text (fixed header, caption, dialog) covers a sample point of the image, so
  that text is not recognized as image text. Transparent link overlays and
  wrappers without text are deliberately allowed. **Heuristic — please
  confirm** the trade-off: an image whose caption element overlaps its
  bottom edge will not be scanned until the overlap is gone.

### D19. Engine and coordinator performance (round two)

- The isolated engine keeps a `WeakMap` reverse index next to its node map,
  so reverse lookups, subtree removal and id collection are O(1) per node
  instead of scanning every node.
- The translation coordinator checks job currency through an optional
  `currentRecord(nodeId)` on the surface instead of copying every record per
  job. The isolated engine implements it; other surfaces fall back to the
  old scan.
- The live-failure recovery gate has a budget (3 rebuilds per 60 s sliding
  window per page) so a stream that dies after every commit cannot rebuild
  the page forever.
- The image-analysis settings section rebuilds only when something it shows
  changed, and remembers whether OCR diagnostics were open. The zoom slider
  applies immediately and saves once it settles (150 ms).

### D20. Left as documented limits (not changed)

- M5 (preference reconcile may revoke a host grant the user made in
  chrome://extensions): fixing it needs Simul to record which origins it
  granted; that is a storage-schema change I did not want to make
  unattended. **Please decide.**
- M19 (every capture still injects the legacy observer and runs the v1
  snapshot before the isolated engine): the v1 snapshot feeds several side
  panel paths (field counts, language sample, last-resort view). Removing it
  is a restructuring of the capture pipeline, not a fix.
- The font-based target-language leak under Passive Fidelity and the
  receiver-side autocomplete check (see D17).

### D21. Low findings applied

- L2: a language change made in another companion window no longer forces
  this window to start translating; each window keeps its own intent.
- L6: a new-page rebuild no longer shows the "Legacy mirror · fallback"
  badge; that label is reserved for real fallbacks.
- L7: dark mode gets a visible focus ring.
- L8: per-patch isolated-mirror console summaries are coalesced to one line
  per two seconds; checkpoint, recovery and failure summaries still log
  immediately, so the README's troubleshooting guidance still holds.
- L9: whitespace between translated chunks (paragraph breaks in long values)
  is preserved instead of collapsing to a single space.
- L11: a source language with no packaged Tesseract model reports
  `unsupported-language` instead of `provider-unavailable`.
- L12: the docs no longer claim the TextDetector probe runs offscreen.
- L13: a live replica commit re-queues images that were deferred because
  their anchor did not exist yet.
- L16: a stale engine run no longer tears down the live stream of the
  replica that is still current.
- L18: the injected snapshot walk and the live observer's forget-tree are
  iterative, so a hostile DOM depth truncates instead of throwing.
- L21: the release build strips WXT_*, VITE_* and SIMUL_OCR_* variables from
  the parent environment and pins the two WXT flags through `define`, so a
  developer `.env` cannot change release bytes.

### D22. Low findings left alone, with reasons

- L1 (remove the broad grant before requesting the narrower one): the order
  is deliberate. Chrome treats a request for a pattern already covered by
  `<all_urls>` as granted without a prompt, so requesting first would never
  produce the per-site prompt. Left as is.
- L3 (Web Lock held across `permissions.request`): needs a redesign of the
  preference lock; not attempted unattended.
- L4/L5 (titles, aria-labels and status strings stay English; whole-UI
  flash on a new dynamic label): a string catalogue refactor.
- L10 (`he` sent as `iw`): I could not verify Chrome's runtime behavior
  here; changing it blind could break Hebrew.
- L14, L15 (diagnostic fan-out and forced layouts during scroll): mostly
  moot after D18.
- L17 (CSS-driven editability), L19 (rrweb lows), L20 (sourcemap strip
  fragility; validator fails closed), L22 (Dependabot: with no lockfile it
  only opens PRs for majors), L24 (legacy delta path; unreachable in the
  release configuration).

### D23. Injection boundary test

`tests/injection-boundary.test.ts` serializes every function passed to
`scripting.executeScript({ func })` and runs it inside a scope that throws
on any identifier that is not a real global, so a helper imported from a
module can never again ride along silently (the cause of the shipped scroll
regression).

## 2026-09-04 session

You confirmed D1, D8, D11, D12, D18 and D20, then asked for rrweb to be
removed rather than quarantined, the legacy-mode toggle dropped, version
0.4.0, the side-panel split next, and a pushed branch with a PR.

### D24. rrweb removed outright

Deleted: `rrweb-shadow-engine`, `rrweb-stream-sanitizer`,
`live-recorder-session`, `page-recorder` (module and entrypoint),
`live-stream-client`, `live-protocol`, their tests, and both `@rrweb`
packages (172 packages installed now). `protocol-v2.ts` keeps only the
replica document identity helpers the isolated engine and OCR bridge share
(`tests/replica-identity.test.ts` covers them); `contracts.ts` lost the
rrweb checkpoint and live-stream types. The Settings "Replica engine" option
and the saved `replicaEngine` preference are gone (an old saved value is
ignored by the parser). The OCR image-source bridge has a single
`isolated-html` kind. The artifact validator no longer has an rrweb profile;
it requires the mirror and live-observer bundles plus the isolated marker in
the side panel.

Also removed: the `WXT_SIMUL_RRWEB_SHADOW` and `WXT_SIMUL_RRWEB_TRANSLATION`
build flags and the never-selected `'legacy'` engine mode. The legacy
visible fallback view (v1 snapshot renderer) stays; it is what the user sees
when the isolated engine cannot run. `ReplicaEngineController` is now
isolated-only with `retrySelected()` replacing mode selection.

`deferred-work.md` still lists two rrweb-era items (Reddit/Mexico City
fidelity gaps "without weakening rrweb privacy" and the rrweb convergence
spec); they are history and were left as written.

### D25. Side-panel split, first pass

Six self-contained clusters left `entrypoints/sidepanel/main.ts` as modules
with explicit dependencies and their own unit tests (4,587 → 3,688 lines):

| Module | Owns | Tests |
| --- | --- | --- |
| `ui-localizer.ts` | atomic target-language labels, English fallback, From-menu names | `tests/ui-localizer.test.ts` |
| `quick-composer.ts` | the private reverse-translation composer | `tests/quick-composer.test.ts` |
| `image-analysis-panel.ts` | the "Image text" settings section and OCR diagnostics log | `tests/image-analysis-panel.test.ts` |
| `toolbar-status.ts` | status line, attention markers, both progress presentations | `tests/toolbar-status.test.ts` |
| `preference-client.ts` | optimistic preference writes and reconciliation | `tests/preference-client.test.ts` |
| `lib/page-identity.ts` (extended) | tab identity, authorization message, URL and access-error helpers | `tests/page-identity.test.ts` |

Each module takes its state through a small environment (callbacks and
element refs), and the side panel keeps one-line wrappers where a function
had many call sites, so behavior and call sites are unchanged. The
source-substring tests that covered this code now read the extracted files
or were replaced by behavioral tests.

The second pass was approved on 2026-09-04 and is recorded as D26.

### D26. Side-panel split, second pass (approved 2026-09-04)

Done in three gate-green commits so each step reviews on its own.

1. **State and currency.** The 55 module-level variables moved onto one
   `CompanionState` (`companion-state.ts`), grouped by lifetime, with the
   reset helpers (`resetTranslationIntent`, `resetLiveSequence`,
   `abortPageWork`, `clearPage`) as the only way a group is cleared. The
   four hand-rolled counters (identity request, availability request,
   language refresh, image access) became one `Currency` (`currency.ts`)
   that mints scoped tokens: a guard calls `currency.isCurrent(token)`, and
   the token carries its scope, so a guard can no longer compare against the
   wrong counter (the H1 / M1 class of bug). `supersedePage()` retires every
   page-scoped token in one call. The capture generation stays with the
   existing `LatestWorkCoordinator`, which already models one running and
   one queued capture; I did not fold it into the currency. The legacy
   visual mirror (render, scale, scroll following, loading and error states)
   became `MirrorView` (`mirror-view.ts`).
2. **Permission flows and the source follower.** `PermissionFlows` owns the
   two preference changes that also change Chrome grants; `SourceFollower`
   owns tab following, the toolbar authorization, the tab and window
   listeners, and the debounced navigation refresh. Both take the browser
   through a small adapter and are tested against fakes, including the
   superseded-lookup and armed-refresh cases behind M1 and M2.
3. **The core.** `CapturePipeline` (observer install, snapshot, isolated
   replica checkpoint, invalidation, replica commit and live-failure
   handling), `TranslationDriver` (language resolution, availability with
   the accepted-result-only rule, page translation over either surface,
   replica view mode) and `LiveUpdateDriver` (dirty-notice coalescing,
   sequence baseline and gaps, delta application). Page scripting goes
   through a two-method `PageScripting` adapter; the functions injected by
   reference are unchanged and the injection-boundary test still covers
   them.

`main.ts` went from 3,688 lines (after the first pass; 4,587 at the start
of the review) to 1,415: element lookups, module construction, DOM listeners,
the settings sync, the detached-window surface, and the hoisted wrappers the
engines call into. Unit tests went from 651 to 720 across 65 files.

Behavior is unchanged except for three deliberate details:

- `MirrorView.translationFieldCount()` returns 0 when no visual mirror is
  mounted. The old call cast an undefined root and would have thrown inside
  the capture, which the catch then reported as an error; the flat-page path
  now reads as "no text" like every other guard already did.
- A page load and an invalidation now supersede the language-refresh scope
  along with identity and availability (`supersedePage()`). A commit-driven
  refresh for the old page was already discarded by the generation check;
  this makes it explicit.
- `startTranslation`'s two identical settle handlers became one.

The three untested seams left are the ones that need a browser: the
`PageScripting` adapter, the `FollowerBrowser` adapter, and the
`chrome.permissions` adapter, each a one-line pass-through in `main.ts`.

### D27. The branch was cut from a stale main — **Please decide**

Found on 2026-09-04 while preparing the merge you asked for. The local clone
this review started from had `main` at `2fde1c8` ("feat: add passive
replica fidelity"), but `origin/main` had already moved to `596dec7` with
119 of your commits dated 2026-07-22 to 2026-08-29, ending with the
allocation and hot-path perf series, three fixes, "chore: prepare public beta
release", "chore: publish 0.3.3 testing build", and the release handoff docs. Neither
the review nor the fixes saw that work.

What upstream contains that this branch does not: version 0.3.3 with exact
pins (wxt 0.20.27, vitest 4.1.10, typescript 7.0.2) and a tracked lockfile;
a new semantic-source subsystem under `lib/replica/` (semantic source
protocol, receiver, session and client, read-scope policy and safety gates,
secret classifier, source visibility boundary, structural patch conflicts,
replica recovery); `main.ts` at 5,173 lines; Chrome-fixture tests; git
hooks under `tools/git-hooks/`; and 1,143 unit tests. Upstream also removed
the rrweb engine, the legacy engine and the transition gate on its own.

What overlaps: a trial merge in a throwaway worktree conflicts in 46 source,
test and doc files plus 6 under `dist/`, including `main.ts`,
`background.ts`, the isolated engine, the mirror protocol and sanitizer,
the OCR controller and session, the translation pipeline and coordinator,
`wxt.config.ts`, the artifact validator, `package.json` and the lockfile.
These are not textual conflicts that a merge tool settles: the side-panel
split was made over the old `main.ts`, and upstream's `main.ts` has grown
new features since.

The last CI run on `origin/main` (596dec7, 2026-08-28) failed in
`tests/isolated-disclosure-chrome.test.ts` because the runner's Chrome
timed out on a D-Bus error, not because of a code fault.

I did not merge PR #8 and did not touch `main`. The choice is yours:

- **Redo on top of origin/main.** Re-apply this branch's intent as new
  commits over 596dec7: the shipped-bug fixes that still apply, the
  dependency policy, the review findings that upstream did not already
  address, and the side-panel split over upstream's `main.ts`. PR #8 would
  be closed and replaced. This is the option I recommend; it is a few
  sessions of work because every finding has to be re-checked against the
  new code.
- **Merge and resolve by hand.** Keep PR #8 and resolve the 46 conflicts on
  the branch, choosing per file. Cheaper up front, but the side-panel split
  cannot be resolved this way and would be redone anyway.
- **Take this branch as-is.** Treat the branch as the new line and rebase
  upstream's 119 commits onto it. I do not recommend this: it discards a
  published 0.3.3 build and a subsystem this branch never saw.

### D28. Review of the 119 upstream commits — determination

You asked on 2026-09-04: "Review what changed on main and determine if we
need to add it in." Four read-only passes over the `origin/main` worktree
(architecture and release records, a finding-by-finding cross-check of this
branch, the two side-panel structures, and the tooling) support one answer:

**Yes. `origin/main` is the base; this branch is a set of findings to
re-apply over it, not a line to merge.**

Why:

1. Upstream is the published line. It carries the 0.3.3 beta testing build
   (`version_name` "0.3.3 beta v.20260828.1"), `LICENSE`, `SECURITY.md`
   ("fixes go only to the latest committed release candidate on `main`"),
   root third-party notices, the public-release readiness spec, and a
   validator that byte-checks the legal files and the OCR package
   provenance in the lockfile.
2. Upstream removed what this branch spent most of its effort on. Commit
   `c7686de` (2026-08-28) deleted the legacy v1 mirror, the page snapshot,
   the live page mirror and its dirty/scroll message bridge, the rrweb
   engine, the legacy engine, the transition gate and the engine selector
   (236 files). Scroll now rides the isolated `page-mirror` stream. The only
   remaining `executeScript({ func })` is a no-op used to read a
   `documentId`. Upstream's own 0.3.1 repair had already fixed the shipped
   scroll regression (B2) the same way this branch did, then deleted the
   path.
3. Upstream added subsystems this branch never saw: the semantic-source
   supplement (typed, ACKed, bounded, read-scope gated), read-scope policy
   presets with fail-closed persisted repair, read-only disclosure
   facsimiles for native selects and menus, replica recovery, accessibility
   first image text with a deterministic evidence ranker, provider
   readiness probes, a navigation refresh gate, a view-preference ledger,
   preference safety with reset confirmation, and a quick-translation
   shortcut. `main.ts` grew to 5,173 lines and the suite to 79 files.

Cross-check of this branch's 46 items against upstream code (details in the
reviewer table below): **22 still apply, 13 are already upstream in some
form, 7 are obsolete because the code is gone, 4 are policy conflicts.**

Still applies (re-fix over upstream, grouped by file):

- `lib/replica/html-mirror-sanitizer.ts` and `isolated-html-engine.ts`:
  H2 colon-prefixed tag names (`isSafeTagName` allows `:`, :4107-4111),
  H3 camelCase SVG names lowercased (:1520, engine :1404), L16 stale run
  releases the current stream before its currency check (engine :304-309),
  `crossorigin` stripped only on `video` (:533, :1747, :3705).
- `lib/replica/html-mirror-source.ts`: recursive shadow-root observation
  without a budget (:1982-1994), whole-subtree walk per record (:850), no
  guard around `#onMutations` so an exception drops the batch silently.
- OCR runtime and controller: one deadline covers Tesseract bootstrap
  (`runtime.ts` :89-95), cancel terminates the worker (:110-113), inactive
  tab settles the image for the session with no resume
  (`image-translation-controller.ts` :2329-2335), commit does not re-queue
  anchor-deferred images (:955, :1516-1519), no text-cover heuristic.
- `entrypoints/sidepanel/main.ts`: M1 focus change still clears the
  navigation timer (:943, :1992) and the same-page early return never
  checks the captured identity (:2010-2014); zoom commits one storage write
  per slider tick (:854, :3171-3178); image-analysis settings rebuilt with
  `replaceChildren` on every sync (:3783-3786) and the diagnostics
  disclosure recreated closed (:4072); D14 label localization still creates
  a session for a merely downloadable pair (:3080-3086); L2 a language
  change from another window forces translation (:1155); L7 dark-mode
  focus ring (`style.css` :75-78, no dark override at :438).
- Elsewhere: `chrome-translator.ts` still reports generic codes for
  activation-required and quota (:100-103, :181-184); `background.ts`
  always creates a second detached window (:219-227); `replica-recovery.ts`
  re-arms after every commit so a stream that dies after each commit
  rebuilds without bound (:13-31); `translation-pipeline.ts` joins split
  segments with ASCII spaces (:16-35); `companion-surface.ts` opens the
  detached window at the full source bounds (D11); the validator passes raw
  `process.env` into the release build (`extension-artifact.mjs` :252).

Already upstream: H1's trigger (live language no longer replaces the
snapshot, :2363-2365, though `availabilityCheckedForPair` is still recorded
before the await at :2719, see new findings), M2 same-document navigation
(navigation refresh gate), L8 log coalescing (DEV-only logging), the
viewport observation token (as `imageClippingToken`), the transient store
failed-open, `one-time-code` and `cc-*` as secrets (secret classifier),
the reverse node index (`Map<Node, number>`), the coordinator currency
index, L11 unsupported-language, L12 docs, the popout pre-open
short-circuit, the rrweb removal, and the 0.3.1 wip items.

Obsolete: B2 scroll bridge and the injection-boundary test (no injected
function has a body upstream; the test is cheap to port as a guard), B1
bundle-marker indexing (one bundle), H4 rrweb, D16 orphaned bridges (ports
die with the runtime), D13 per-lifetime engine disable (single engine),
L6 fallback badge, L18 recursive snapshot walks (the same class survives in
the shadow-root walk above).

Policy conflicts that need your decision before the redo:

- **Dependencies (D1, D4, D6).** Upstream pins every version exactly,
  tracks `package-lock.json`, runs `npm ci` with a cache, keeps
  `overrides`, and its validator verifies the lockfile's `resolved` and
  `integrity` for the OCR packages. Every one of these conflicts with the
  branch's floating ranges and no lockfile. The reviewers also found that
  this branch's own validator (`extension-artifact.mjs` :1611-1616) and
  two tests still read `package-lock.json`; the branch gate passes here
  only because a stale, ignored 0.3.0 lockfile is on disk, and a fresh
  checkout would fail. Recommendation: keep upstream's exact pins and
  tracked lockfile (the provenance check is a real supply-chain property
  for the vendored OCR runtime) and apply your "newest before 2026-08-27"
  rule as a pinned bump (wxt 0.21.4, Vite 8.2.2 peer, vitest 4.1.11,
  `@types/node`), regenerating the lockfile with the same npm.
- **OCR capture near text controls (D9).** Upstream chose the stricter
  rule: any painted control overlap blocks pixel capture
  (`image-source-session.ts` `hasProtectedSiblingOverlap`,
  `source-privacy-policy.ts` :1590-1611). Your 2026-09-03 instruction was
  the looser rule (only password and private controls block). Both are
  defensible; the README and test on this branch state the looser one.
- **Icons (D12).** Upstream shipped the beta without manifest icons and has
  no `public/` directory; its validator does not require them. The
  placeholders and the validator rule can be re-applied as a follow-up.
- **The side-panel split (D25, D26).** `CompanionState`, `Currency`,
  `SourceFollower`, `PermissionFlows`, `ToolbarStatus`, `UiLocalizer` and
  `QuickComposer` map cleanly onto upstream function groups; the capture
  pipeline, translation driver, preference client and image panel map
  partially and must absorb upstream's new features; `LiveUpdateDriver`
  and `MirrorView` have no counterpart because the legacy mirror is gone.
  Upstream keeps seven hand-rolled counters (`identityRequestId`,
  `availabilityRequestId`, `replicaLanguageRefreshVersion`,
  `sourceLanguageResolutionRevision`, `imageCaptureAccessRevision`,
  `uiLocalizationRequestId`, `activeFollowRequestId`), which is exactly
  what `Currency` replaces. The split should be redone over upstream's
  file after the fixes, as its own PR.

New findings in upstream code, noticed while cross-checking (not yet
fixed anywhere):

1. `main.ts` :3081-3087: a merely `downloadable` pair reaches
   `provider.createSession` from the gesture-free label pass, which starts
   a download or throws `NotAllowedError` (the D14 class).
2. `main.ts` :2718: `availabilityCheckedForPair` is recorded before the
   await; with the refresh-version skip at :2612-2624 a superseded check can
   leave the pair marked as checked and automatic translation unrun for
   that generation (the H1 class, different trigger).
3. `lib/replica/replica-recovery.ts` :8-31 wired at `main.ts` :557-590,
   :2260: `markCommitted()` re-arms after every commit, so a stream that
   fails after each successful commit rebuilds forever; the comment's bound
   holds only when the rebuild itself fails.
4. `main.ts` :1941-1944: the early return precedes the `try/finally`, so
   a follow request superseded in the `onRemoved` microtask gap (:1077)
   leaves `activeFollowRequestId` set and :970-975 keeps dropping updates.
   Practically unreachable; the guard shape is wrong.
5. `main.ts` :421, :541: `imageTranslationController?.` on a definitely
   assigned `let`; stale guard.

Process facts that affect the redo: upstream's `tools/git-hooks/pre-push`
blocks every push and `pre-commit` blocks commits on `main`; both install
only through `npm run hooks:install` and are not installed in this clone.
`AGENTS.md` forbids hand-editing `.agents/skills/` and `_bmad/` (this
clone has local modifications there from before the review; they were never
committed). `README.md` on this branch still says `npm ci`.

Plan for the redo, once you decide the policy rows: fast-forward local
`main` to `origin/main`; open a new branch; land the tooling decision
first (pins, lockfile, CI) so the gate is trustworthy; re-apply the
still-applying fixes file by file with their tests, plus the five new
findings; then the side-panel split over upstream's `main.ts` as a separate
PR; close PR #8 with a pointer to the new one. Every re-applied item gets
re-verified against upstream code rather than ported blind.

### D29. Redo branch: base and tooling (2026-09-04)

Your answers: upstream is the code base but "0.3.1 and 0.3.3 both had
issues; do not assume 0.3.3 is required; do what you deem best"; exact pins
with a tracked lockfile, bumped to the newest release before 2026-08-27; the
looser OCR overlap rule. Branch `chore/review-redo` was cut from
`origin/main` (`596dec7`); local `main` was fast-forwarded to it.

Tooling landed first so the gate is trustworthy for everything after:

- `package.json`: version **0.4.0** (your earlier choice; 0.3.3 is not
  treated as fixed), `packageManager` npm 12.0.2, exact pins wxt 0.21.4,
  vite 8.2.2 (peer of wxt 0.21), vitest 4.1.11, typescript 7.0.2, acorn
  8.18.0, linkedom 0.18.13, @types/node 24.13.3; tesseract.js and
  tesseract.js-core stay 7.0.0 (D4 exception). `package-lock.json` is
  tracked and was regenerated with npm 12.0.2 (178 packages, 0
  vulnerabilities). The `overrides` block was removed: none of its six
  targets (adm-zip, esbuild, fx-runner, shell-quote, tmp, uuid) is in the
  tree once wxt 0.21 drops web-ext and Vite 8 drops esbuild, so the
  entries were inert. `allowScripts` uses name-only keys (`esbuild`,
  `fsevents`; `tesseract.js` denied) so a version bump cannot silently
  re-block a script.
- `.npmrc` stays upstream's (`engine-strict`, `fund=false`); the
  branch's `package-lock=false` line is gone with the policy. CI keeps
  `npm ci` with the npm cache and installs npm 12.0.2 globally.
- `wxt.config.ts`: build identity `0.4.0 beta v.20260904.1`; manifest
  `icons` at 16/32/48/128 from `public/icon/` (the D12 placeholders);
  the legal-comments setting moved from `esbuild.legalComments` to
  `build.rolldownOptions.output.legalComments` because Vite 8 bundles with
  rolldown and its types no longer accept the esbuild form. Upstream's
  release plugin emits the OCR assets and legal files from `generateBundle`,
  which runs once per Vite build, so wxt's size summary reports about 116 MB
  while the artifact on disk is 37.5 MiB (files overwrite each other); the
  validator measures disk and passes. Left as is; a `build:publicAssets`
  hook would emit once but changes upstream's release plugin for no
  functional gain.
- `tools/extension-artifact.mjs`: the release build now runs under
  `releaseBuildEnvironment` (developer `WXT_*`, `VITE_*`, `SIMUL_OCR_*`
  variables scrubbed, D6) and `validateManifest` requires the four PNG
  icons; the test fixture writes them and `tests/extension-artifact.test.mjs`
  gained the icons test. Version identity tests, README and the
  build-identity test read 0.4.0.
- `.gitignore` ignores stray `vendor/ocr/tesseract/core/*.wasm` copies
  (B4).
- Not ported: `tests/injection-boundary.test.ts`. Upstream's only
  `executeScript({ func })` is a bodiless `() => undefined` used to read
  a `documentId`, so the guard would have nothing to check.

Gate on the new toolchain before any fix: typecheck clean; 1,143 tests
pass, 1 skipped (the Chrome-fixture disclosure test skips without a
browser binary); fresh build validated and synced to `dist/chrome-unpacked`.

### D30. Fixes re-applied over the 0.3.3 line (2026-09-05)

The 22 still-applying items from D28, the five new upstream findings, the
looser OCR rule (D9) and the docked window (D11) were ported in five
file-disjoint clusters, each verified against the current code rather than
pasted from the old branch, each with its own tests, and integrated in this
order: background/surface/provider, sanitizer/engine, OCR, side panel,
source observer. Gate at the head: typecheck clean, 1,197 tests across 80
files (1 Chrome-fixture test skips without a browser), artifact synced and
verified.

What landed, and where it deliberately differs from the old branch:

- **Sanitizer and engine.** H2: `isRepresentableTagName` rejects colon
  names outside the HTML namespace on both the transported and the live
  path; the engine creates HTML elements through `createElement` (so an
  `x:iframe` stays one inert unknown element instead of being prefix-parsed
  into a real iframe) and everything else through `createElementNS`. H3:
  the full SVG camelCase table restores `linearGradient`, `clipPath`,
  `feGaussianBlur` and the rest. L16: the currency check now runs before a
  run releases the stream, semantic source or staging candidate.
  `crossorigin` joined the active/navigational attribute set, so it is
  stripped on every element.
- **Source observer.** Shadow-root observation is iterative with a 20,000
  node budget shared per mutation batch and a per-batch visited set;
  exhaustion is reported through the existing content-free
  `capacityOmissionCount`. Roots that already exist at checkpoint are
  observed while the mirrored graph is marked, so the budget only defers
  discovery of unmirrored roots. `#onMutations` is guarded: a throwing
  record posts the receiver's non-terminal `stream_gap` and recovery
  proceeds. The old branch's target-only per-record walk was not adopted;
  the per-batch de-duplication achieves the bound without changing what is
  mirrored.
- **OCR.** Tesseract bootstrap has its own 60 s deadline; a caller cancel
  keeps the worker warm; disposal and timeouts still terminate. Inactive
  tab, host outage, overflow, missing input and lost worker now defer the
  image; `resume()` re-kicks deferred images and the side panel calls it
  when the followed tab is activated and when the companion becomes visible.
  A replica commit re-queues only anchor-deferred images (L13), on purpose:
  commits are frequent and re-queuing hidden images on each one would churn
  measurement round trips. The text-cover heuristic samples five points
  through `elementFromPoint`, descending open shadow roots (bounded to 16),
  and fails closed on an unreadable hit test; an overlay with
  `pointer-events: none` is invisible to it, an accepted limit. The overlap
  rule is now yours: only credential-secret overlaps (password,
  one-time-code, payment-card autocompletes, hidden/file inputs, CSS-masked
  text, sticky secret classifications) block capture. README states it.
- **Side panel.** M1: focus changes and `followActivatedSourceTab` leave
  the navigation timer armed, and a same-page re-activation rebuilds a stale
  replica through the new pure helper `lib/followed-replica-currency.ts`
  (never while a capture is in flight, the refresh is armed, or the tab is
  still loading). Zoom applies through one optimistic ledger entry and
  commits once after 150 ms, flushed on `pagehide`. The image-analysis
  settings render on a key of everything they display and keep the
  diagnostics disclosure open. Label localization creates a session only for
  an installed pair and retries once a page translation has prepared the
  pair. Another window's language change no longer forces this window into
  translating. The availability pair is recorded only after the guarded
  result; `followFocusedBrowserWindow` releases its follow marker on the
  early return; the stale optional chains are gone; the dark focus ring has
  contrast. Not ported: the old branch's widening of `needsPreparation`,
  because upstream no longer replaces the snapshot identity on a language
  refresh.
- **Background, surface, providers.** A second toolbar click focuses the
  existing detached window (tracked per worker, cleared on
  `windows.onRemoved`; reuse follows the popout tab mode) and re-authorizes
  it through the ordered `simul:authorized-tab` message. The detached window
  docks right at 45% of the source width (minimum 480 px). Chrome's
  `NotAllowedError` and `QuotaExceededError` surface as
  `activation-required` and `quota-exceeded` with readable messages. Long
  values keep their line breaks across chunks. The recovery gate has a
  sliding budget of 3 rebuilds per 60 s.

Left for the next PR: the side-panel split over upstream's `main.ts`
(D25/D26 design, the seven hand-rolled counters listed in D28), and the
deferred-work items upstream already tracks.

### D31. Side-panel split over the 0.4.0 line, first pass (2026-09-05)

Branch `refactor/side-panel-split` off `chore/review-redo`, PR #10 (stacked
on PR #9; retarget to `main` once #9 merges). The D25/D26 design was redone
over upstream's `main.ts` (5,305 lines at the start), in gate-green commits,
each module with a unit test against fakes or a linkedom document. Behavior
is unchanged except where noted.

Landed (main.ts 5,305 → 1,472 lines; suite 1,197 → 1,333 tests across 94
files; two `let`s remain in main.ts, the two collaborators that reference
each other at construction):

| Module | Owns |
| --- | --- |
| `lib/page-identity.ts` (extended) | tab identity reader, current-tab assertion, toolbar authorization parser, navigation and same-page URL keys, `PageAccessError`, page timeout |
| `toolbar-status.ts` | status line, attention markers, both progress presentations |
| `ui-localizer.ts` | atomic label localization, installed-pair rule (D14), single delayed retry, follow-up after a page translation |
| `quick-composer.ts` | reverse-translation composer, draft counter, submit shortcut |
| `image-analysis-panel.ts` | the "Image text" settings section and diagnostics log, rendered from a keyed view |
| `companion-state.ts` | the 42 former module-level variables, grouped by lifetime, with `clearPage`, `resetTranslationIntent`, `clearLanguageResolution`, `abortPageWork` |
| `currency.ts` | one `Currency` of scoped tokens replacing five hand-rolled counters and the active-follow marker |
| `source-follower.ts` | tab following, toolbar authorization, navigation refresh gate and debounce, moved/replaced/closed-tab recovery |
| `preference-client.ts` | preference service transport, load fallbacks, revision-guarded apply with ledger projection, view and image patches, zoom debounce |
| `permission-flows.ts` | image-access and automatic-translation changes with grant rollback |
| `translation-driver.ts` | source-language resolution (page, image evidence, explicit), availability with the accepted-result-only rule, page translation, commit reconciliation, replica view mode |
| `capture-pipeline.ts` | capture queueing, the page capture and engine checkpoint with image-replica activation, commit and live-failure handlers, source-navigation teardown, companion invalidation |
| `read-scope-controller.ts` | the mandatory first-run setup, profile menus and per-key toggles, read-scope commits with the purge-before-save rule and narrowing ceilings, the full reset with cleanup retry, the preference safety protocol |
| `image-translation-config.ts` | the image-translation controller's configuration from preferences, grant, probes and read scope; retiring image-derived language evidence on a key change; the TextDetector probe |
| `surface-switcher.ts` | detaching to a window, returning to the side panel, the placement note |

Deliberate details:

- `Currency` scopes are `identity`, `availability`, `language-refresh`,
  `language-resolution` and `image-access`; the first four are page scopes.
  A page load and an invalidation call `supersedePage()`, which also retires
  a commit-driven language refresh for the old page explicitly (that refresh
  was already discarded by the capture generation check).
- `uiLocalizationRequestId` did not become a scope; the localizer keeps its
  own request id because it is not page-scoped.
- The `AutoLanguageEvidencePrecedence` API still takes a numeric revision,
  so the language-resolution token's `id` is passed through.
- The navigation debounce timer lives in `SourceFollower`; `queueCapture`
  cancels it through `cancelNavigationRefresh()`.
- `PreferenceClient.applyCommitted` reports the previous snapshot through
  `onCommitted`, and the side panel keeps the read-scope setup-draft reset
  and the safety-gate releases in that callback.
- Source-substring tests that covered moved code became behavioral tests;
  `tests/navigation-completion-integration.test.ts` is now a follower test.
  The remaining source tests over `main.ts` read the module that now holds
  the code where an ordering property is what they assert.
- The translation driver's test covers the superseded availability check
  that used to leave a pair marked as checked (H1); the pipeline's test
  covers the same-page rebuild that keeps the last good replica, the
  superseded capture, the engine failure diagnostics and the rebuild budget.
- The capture pipeline's only injected function stays bodiless and lives in
  the side panel's `readDocumentId` adapter, so the injection boundary is
  unchanged.
- Two status strings ("The committed settings snapshot was older than this
  panel." and the invalid-storage message) had picked up a stray `state.`
  inside their text during the mechanical state migration; restored in the
  read-scope commit.

What stays in `main.ts` by design (1,472 lines): the element lookups, the
engine, coordinator and controller constructions with their wiring, the
module constructions with their environments (the browser adapters are
one-line pass-throughs), the DOM listeners, the settings sync and toolbar
control sync, `updateControls`, the runtime purge (engine, coordinator,
memories and image cache in one place) and the hoisted wrappers the engines
call into. The untested seams are the browser adapters. Not carried over
from the old branch: `live-update-driver` and `mirror-view` (the legacy
mirror is gone upstream), and the old `preference-client`'s Web Lock
handling (upstream deliberately never waits for the background while holding
the preference lock).

**Please review** PR #10 after #9. Order of reading: `companion-state.ts`
and `currency.ts` first, then `main.ts` (what remains and how modules are
wired), then the modules in the table order.

### D32. Merge, release and housekeeping (2026-09-05)

Your answers to the outstanding items: merge #9 now and retarget #10; ship
0.4.0 with the placeholder icons; a publish commit plus tag and GitHub
release; next work is the remaining review items, upstream's deferred work,
and anything else I can take on. Mid-session you added: remove any GitHub CI
work that may have been installed.

Done, in order:

- **Publish commit.** `chore: publish 0.4.0 testing build` on
  `chore/review-redo`: build identity `0.4.0 beta v.20260905.1`
  (`wxt.config.ts`, README, the two identity tests), third-party notices name
  0.4.0 (they still said 0.3.3), dist resynced (manifest and notices only).
  Gate green locally and on the PR run.
- **PR #9 merged** as a rebase merge, so `main` stays linear like upstream's
  history and the gate-green commits survive. `main` became `9f4987f`, the
  same tree as the tested commit. GitHub retargeted #10 to `main` on its own.
- **Tag and release.** Annotated tag `v0.4.0` at `9f4987f`. GitHub
  pre-release "Simul 0.4.0 beta (v.20260905.1)" at
  https://github.com/aredna/simul/releases/tag/v0.4.0 with
  `simul-0.4.0-chrome-unpacked.zip` (the committed `dist/chrome-unpacked`,
  58 files, 31 MB) and notes drawn from D29 and D30. Marked pre-release
  because it is a beta testing build.
- **GitHub CI removed** (your mid-session instruction).
  `.github/workflows/ci.yml` dated from the 2026-07-19 bootstrap; the review
  sessions had only bumped its npm version. Removed through PR #11
  (rebase-merged; `main` is `95f1ba7`). `.github/dependabot.yml` was left in
  place because it is not CI; **please confirm** whether it should go too.
  The workflow's last run on `main` (the publish commit) failed only in the
  Chrome-fixture disclosure test, which timed out on the runner's D-Bus after
  8 s; the same tree had passed on the PR run minutes earlier and the other
  1,197 tests passed. Verification is now local only: `npm run check` before
  any push.
- **PR #10 rebased** onto `main` with `git rebase --onto` (17 commits, no
  conflicts; the identity bump and the workflow removal carry through). Gate
  on the rebased head: typecheck clean, 1,333 tests across 94 files (1
  Chrome-fixture skip), artifact verified. Force-pushed with lease.
- **Branches deleted,** local and remote: `chore/review-redo` (merged) and
  `chore/deps-refresh-and-review-fixes` (the D28 reference; the split has
  been redone as D31).
- **Dependabot PRs #1, #2 and #4 closed** with a comment (rrweb removed;
  acorn 8.18.0 pinned on `main`). #6 (wxt 0.21.3) had already been closed by
  Dependabot once `main` reached 0.21.4.

Not done: the icons stay placeholders (your choice). The decision log on
`main` ends at D30; D31 and D32 live on the split branch until #10 merges.

After #10 merges, advance the build identity again (`v.2026MMDD.1` on the
merge date) before any further release; the `v0.4.0` tag stays on the #9
merge.

### D7. Local toolchain notes

- Nothing in the dependency set had a release inside the 7-day window
  (cutoff 2026-08-27), so the rule excluded nothing; every resolved version
  is the newest available.
- The stale `.wxt/tsconfig.json` may list a temporary artifact build
  directory under `exclude`; it is regenerated by `wxt prepare` and ignored.


### D33. Remaining review items and lib-level deferred work (2026-09-05)

Your 2026-09-05 answer to "what next": the remaining review items, upstream's
deferred-work list, and anything else I can take on. Because PR #10 rewrote
`entrypoints/sidepanel/main.ts`, this batch stays out of the side panel: it
is branch `fix/review-remainder-lib` off `main` (after the 0.4.0 publish
commit and the CI removal), and it only touches `lib/`, `tools/` and their
tests. Side-panel items (L4/L5 string catalogue, the transactional
image-permission rollback, the redirect-during-load capture) wait for #10.
Numbering: D31 and D32 live on the split branch; this entry takes D33 so the
two logs merge without conflict.

Landed, each as its own commit with tests, gate-green at the head:

- **L10 Hebrew (fixed, not documented away).** Google's own Translator API
  guidance lists Chrome's supported tags with Hebrew as `he`; `iw` is not in
  the list, so the unconditional `iw` mapping most likely made Hebrew
  unavailable. The provider now probes `he` first and falls back to `iw`,
  remembering whichever Chrome accepted per language. A probe that throws for
  one tag counts as a refusal of that tag only. Non-Hebrew pairs still reach
  Chrome with one synchronous call, so cancellation timing is unchanged.
  Source: the GoogleChrome/modern-web-guidance translator guide.
- **Deferred: exported validation project root.** `validateArtifact` takes
  `{ projectRoot }` and compares legal files and the Tesseract vendor
  manifest against the caller's root; `checkArtifact`, `syncArtifact` and the
  promotion path pass theirs. The orchestration test fixtures had fake
  project roots without legal files, which the module-root read had masked;
  they now carry them.
- **Deferred: shadow-host overlap.** `hasProtectedSiblingOverlap` decides
  ancestry by the flat-tree path instead of `Element.contains()`, so a host
  is never a foreign overlay over its own shadow-hosted image. Under your
  looser overlap rule this rarely changes an outcome (a secret host already
  blocks through the image's own ancestry check); it is a correctness fix.
- **Deferred: scroll progress beyond 100,000 px.** Position and maximum are
  scaled together past the protocol bound instead of both being clamped, so
  a very long document keeps reporting where the reader is. The replay side
  already projects by ratio. Coordinates inside the bound stay exact.
- **M5 host grants (the storage-schema change you declined unattended in
  D20 and asked for on 2026-09-05).** Preferences gain
  `grantedPermissionOrigins`, the managed host patterns Simul's own intent
  has relied on. Automatic reconciliation releases only those plus the legacy
  wildcard shapes (which only old Simul builds ever created); a grant the
  user made in `chrome://extensions` is left alone, and a user-made broad
  grant covers saved per-site choices instead of being dropped to prove
  them. Installs that predate the ledger adopt every managed grant they hold
  once, so their cleanup is exactly what it was. README says so.
  **Please confirm two choices:** (1) **Reset all still clears every managed
  grant**, owned or not, because it is the user's explicit request to release
  Simul's site access and the cleanup-pending protocol would otherwise report
  a user-made grant as unfinished forever; (2) once the user tells Simul to
  use a site or all sites, Simul owns that grant and releases it when the
  intent is turned off, even if the user had granted it manually first.
- **Deferred: contradictory tablists.** Two tabs of one `role=tablist`
  that both claim selection with both panels painted now withhold every
  panel of that tablist; tabs with no tablist ancestor keep their individual
  proofs.
- **Deferred: padding-box clipping.** A selected panel's visibility through
  an overflow clip is proven against the ancestor's padding box
  (`clientLeft/Top/Width/Height`), not its border box; elements with several
  fragments or no client geometry fall back to the border box as before.
- **Deferred: nested-scroller identity beyond 5,000 elements.** The scan
  budgets the full read (computed style, geometry) over candidates that show
  at least 96 px of vertical overflow, with a separate 50,000-element walk
  cap, so a long page of ordinary content cannot exhaust the budget before
  its scroller. `findPrimaryNestedScroller` and `nestedScrollerOrdinal`
  share one walker.

Checked and left alone, with reasons:

- **L3 (Web Lock across `permissions.request`)** is obsolete on the 0.4.0
  line: the only preference lock is in the background, wrapping storage
  read/modify/write and the safety acknowledgement; the side panel requests
  permissions before it sends a command and holds no lock.
- **D17 (receiver-side autocomplete check).** The base sanitizer strips
  `autocomplete` as a private attribute, and the receiver's consistency rule
  deliberately accepts a source claim of `personal` where it can only see
  `ordinary-form`, never the reverse. Carrying an autocomplete class into the
  replica so the receiver can re-check would need its own privacy review;
  the source classifier (extension code in the isolated world, not page
  code) remains the authority. Documented limit, unchanged.
- **D10** stays as your July decision (HTML `lang` authoritative).

`deferred-work.md` lost the six entries this batch closes.

### D35. Side-panel items stacked on the split (2026-09-06)

The third track from your 2026-09-05 answer. Branch
`fix/image-permission-rollback` off `refactor/side-panel-split` (PR #16,
base #10), because these files exist only in the split's module layout.
Numbering note: D34 was written on `fix/deferred-lib-batch-2` (#14); both
entries append to this log, so the second of the two merges will need the two
sections kept one after the other.

- **Transactional image-permission rollback (deferred item, done).** Turning
  image translation off releases the broad grant, re-requests the exact site
  grants it had covered, then saves. Two holes are closed. Before anything is
  released, the flow now asks for a fresh gesture when exact grants would be
  needed but no user activation is live; previously the release went ahead and
  the exact re-request then failed silently. After a failed save, the rollback
  re-request is verified with `permissions.contains`; when Chrome keeps the
  grant released, the panel purges image-derived caches, reports the
  revocation and explains that the setting could not be saved and pixel OCR is
  paused until access is granted again, instead of the generic "setting left
  unchanged" message that was no longer true.
- **Redirect during load (deferred item, removed without a change).**
  `NavigationRefreshGate` scopes a pending load by tab and window only, so a
  URL-only update while a load is pending retargets the load instead of being
  consumed as a same-document change, and the completion still schedules its
  capture; `tests/navigation-refresh-gate.test.ts` covers it ("retargets a
  pending document load across redirects"). The described suppression does not
  exist in the current code.
- **L4/L5 string catalogue (scoped, not started).** Inventory on the split:
  about 240 user-facing literals across the side-panel modules
  (`main.ts` 67, `image-analysis-panel.ts` 37, `read-scope-controller.ts` 31,
  `permission-flows.ts` 29, `translation-driver.ts` 23, `capture-pipeline.ts`
  18, `quick-composer.ts` 13, the rest under ten each) plus 102 labels,
  titles and aria strings in `index.html`. Doing L4 properly means one
  catalogue module keyed by purpose, every `setStatus` and DOM label reading
  from it, `UiLocalizer` extended from the atomic control labels to titles,
  aria labels and status templates, and L5's flash addressed by swapping a
  whole localized catalogue at once. That is a dedicated session of its own
  with a browser check at the end, and it should start after #10 merges so it
  is not stacked on twenty unreviewed commits. Left for you to schedule.

`deferred-work.md` is down to 40 entries on this branch (36 once #14's
removals merge).


### D34. Answers of 2026-09-05 and the second lib-level batch

Your answers to the D32/D33 questions: remove `.github/dependabot.yml` too
(done, PR #13); both M5 choices stand (reset clears every managed grant; a
grant Simul is told to use becomes Simul's to release); merge #12 first and
rebase #10 onto it; next work is more deferred items outside the side panel,
the side-panel items stacked on #10, and a Chrome manual test plan.

Done: PR #12 and PR #13 rebase-merged; `main` is `cf3e79e`. PR #10 was
rebased with `git rebase --onto` (one dist conflict, resolved by taking the
replayed commit and resyncing once at the end), gate-green at 1,355 tests,
force-pushed with lease. The handover on the split branch points at #12 and
the D33 batch.

This batch, branch `fix/deferred-lib-batch-2` off `main`, again outside the
side panel:

- **Deferred: overlay rebinding.** When a new replay lease cannot install a
  retained overlay (`ImageTranslationController.#rebindRetainedProjections`),
  the retained projection is dropped and the exact current descriptor is
  requeued through `ImageScanScheduler.requeueCurrent`, so settled work waits
  on the anchor (`anchor-deferred`) and projects on the commit that adds the
  node, instead of staying "projected" with nothing on screen. The test
  fixture that found this had to be corrected on the way: the job resolves
  its own anchor and adopts the anchor's lease, so a resolver that returns a
  stale-lease anchor is not something the side panel ever does; the realistic
  fixture returns no anchor until the new replica has the node.
- **Deferred: policy reuse for image hints.** `sanitizeSourceElementHints`
  accepts the caller's controlled-content policy; the checkpoint serializer
  passes its context policy and the live patch and image-source refresh paths
  pass the source's retained policy, so the per-image whole-document rebuild
  is now the fallback only.
- **Deferred: attention-ranked discovery.** `collectBoundedImageGraph` keeps
  every image inside the node budget (the image budget only records that the
  cap was exceeded), so admission ranks candidates by visual attention rather
  than by the DOM-order prefix the traversal reached. A visible image late in
  the document now wins a slot over offscreen images before it. Eviction of an
  already admitted offscreen image in favour of a later visible one is a
  separate design and was not attempted.
- **Deferred: semantic revision history** was removed from the list without
  a change: `SemanticSourceSession` already prunes `#revisions` and
  `#proofRevisions` to the current record and proof ids on every full scan,
  the 50,000 constant is only a traversal budget, and the node registry prunes
  dead references; the described exhaustion does not exist in the current
  code.

`deferred-work.md` is down to 38 entries.

### D36. Third lib-level batch: controlled-content admission and launch ordering (2026-09-06)

Branch `fix/deferred-lib-batch-3` off `main` (`ce5b314`), again outside the
side panel, so it is independent of #10 and #16 in source and of #14 except
for three lines of `html-mirror-source.ts` context. Numbering note: D34 (#14)
and D35 (#16) live on their own branches; whichever of the three merges later
needs the sections kept one after the other. The current handover is the one
on `refactor/side-panel-split`; the copy on `main` still describes PR #9.

- **Deferred: custom attribute state (done).**
  `sourceControlledContentMutationsMayChange` treated only `aria-hidden`,
  `hidden`, `class` and `style` as layout-changing, so `[data-state="open"]`
  on a tabpanel's wrapper revealed the panel without refreshing the withholding
  proof until another recognized signal arrived. Every remaining attribute name
  now runs the same bounded check (`sourceControlledContentLayoutMayChange`:
  participants, their flat-tree ancestors, and descendants of participants);
  the specific `aria-controls`, `aria-selected`, `aria-expanded`, `id` and
  `role` branches are unchanged, and churn outside those paths is still
  ignored. The test asserts both directions and the resulting patch.
- **Deferred: remote selector changes (done).** When the painted-visibility
  comparison reports a changed target that is a controlled-content participant
  or lies on a participant's path, `HtmlMirrorSourceSession` refreshes the
  controlled-content policy before that target is re-emitted. A sibling
  combinator or `:has()` reveal touches no participant, so no mutation record
  refreshed the policy; the visibility index queued the panel and the retained
  policy sanitized it as withheld, re-emitting it blank. The test toggles
  `data-open` on a sibling button that is neither a participant nor on a
  participant's path and checks the reveal and the withdrawal.
- **Deferred: monotonic toolbar authorization (done).** The launch epoch is
  `<generation>.<uuid>`. The generation is allocated once per worker lifecycle
  as `max(persisted + 1, Date.now())` and persisted in `chrome.storage.session`,
  which outlives service-worker restarts and is cleared with the browser,
  together with every companion that could hold a stamp.
  `isNewerCompanionLaunchStamp` orders different epochs by generation, so a
  delayed message from an older lifecycle no longer supersedes a newer launch;
  epochs without a shared order (an older build's bare UUID, or two lifecycles
  that read the same persisted value because a write failed) keep the previous
  rule that a different worker is newer. If session storage is unavailable the
  generation degrades to clock order. The wire shape (`launchEpoch` string
  under 128 characters, `launchSequence`) and the side-panel consumer are
  unchanged, which keeps this batch off the files #10 rewrites.
  **Please confirm** the `storage.session` choice: `storage.local` would also
  order across browser restarts, but nothing that survives a restart holds a
  stamp, and session storage cannot leave a stale counter behind.
- **Deferred: semantic mutations inside open shadow roots (removed without a
  change).** `SemanticSourceSession.#observeSemanticRoot` already attaches the
  same MutationObserver and the DOM-change, select-activation and
  presentation-change listeners to every open shadow root the scan admits, and
  `tests/semantic-source-session.test.ts` ("observes controls inserted inside
  an open shadow root") covers a later insertion inside such a root. A root
  attached to an already-scanned host is picked up at the next refresh, which
  any observed mutation or the control poll triggers. The document-only
  observer the entry describes does not exist in the current code.

Not attempted from the remaining list, with the reason: ancestor paint changes
in the screenshot capture identity need a design for which ancestors and
properties count without turning every scroll into a recapture; the
text-serialization privacy floor items need the fixture matrix the entries
call for; the `aria-labelledby` and `aria-current`/`aria-pressed`/range items
change the typed read-scope protocol and deserve their own review.

`deferred-work.md` is down to 38 entries on this branch (32 once #14 and #16
merge).

### D37. Fourth lib-level batch: typed ARIA state and two retired entries (2026-09-06)

Branch `fix/deferred-lib-batch-4` off `main` (`ce5b314`), again outside the
side panel and independent of #10, #14, #16 and #17 in source. Numbering:
D34 (#14), D35 (#16), D36 (#17), D37 here; the later merges keep the sections
in sequence. Trial merges of the four earlier PRs in every order found no
source conflicts, only the regenerated `dist/` bundles and, between #14 and
#17, these two log files; each later merge still needs a rebase and
`npm run artifact:sync`.

- **Deferred: `aria-current`, `aria-pressed` and range values (done,
  bounded).** The typed `aria-state` proof carried only `checked` and
  `selected`. It now also carries `pressed` (role `button`, or the `button`
  tag without a role; `true`, `false`, `mixed`), `current` (links, buttons,
  list items, options and summaries, and the tab, treeitem, menuitem,
  menuitemradio, row and gridcell roles; the seven ARIA tokens, lower-cased)
  and `valuenow` for the read-only indicator roles `progressbar`, `meter` and
  `scrollbar` only, as a bounded decimal (up to 15 integer and 6 fraction
  digits, no exponent). Gates: `pressed` reads under `formValues` like
  `checked`; `current` and `valuenow` read under `controlSemantics` because
  they are page state rather than user input. The protocol validator binds
  each state to its gate and value set, the receiver re-checks the replica
  element's tag and role before presenting, and the presenter path is the
  existing generic one. Not carried, by design: `aria-valuetext` (free text)
  and `slider`/`spinbutton` values (user input, which the classifier treats as
  withheld on non-native widgets). Because the base sanitizer strips these
  attributes as private, the proofs also restore source CSS that keys on
  `[aria-current]` and `[aria-pressed]`. **Please confirm** the indicator-only
  range choice; sliders could follow the `formValues` category rules instead.
- **Deferred: image discovery in open shadow roots (removed without a
  change).** `collectBoundedImageGraph` in `source-image-observer.ts` already
  traverses open shadow roots under a root budget, the observer discovers
  late-attached roots on a timer, and the replica anchors overlays through the
  node map (`resolveImageAnchor`), which includes reconstructed open roots.
  Test: "discovers and observes existing and added open shadow-root images
  only".
- **Deferred: doctype and quirks mode (removed without a change).** The
  checkpoint carries `documentMode` (`standards` or `quirks`, read from
  `compatMode`) and the engine stages `ISOLATED_HTML_QUIRKS_SHELL`, the shell
  without the doctype, for quirks documents. Tests: "transports a bounded
  standards-or-quirks document mode" and the engine's quirks-shell assertion.

Considered and left for your call: `aria-labelledby` accessible names need a
relationship proof (native node ids, replica-side id assignment) rather than a
text record, because a label record becomes a painted `aria-hidden` span next
to the control and would duplicate the visible referenced text; that is a
protocol design to approve first. The two text-serialization privacy-floor
entries stand: the serializer still uses its own withheld-ancestor predicate
rather than the shared painted-visibility boundary. No Chrome binary is
installed on this machine, so the Chrome-fixture test stays skipped and the
manual pass remains yours.

`deferred-work.md` is down to 39 entries on this branch (29 once #14, #16,
#17 and this batch all merge).

### D38. Slider and spinbutton range values under formValues (2026-09-06)

Branch `fix/slider-spinbutton-form-values` off `main` (`33501d8`). Resolves the
first of the two calls D37 left open ("Please confirm the indicator-only range
choice; sliders could follow the formValues category rules instead"). The call:
carry user-editable range values, under the form-value gate.

- **ARIA widgets (`role="slider"`, `role="spinbutton"`).** The typed `aria-state`
  proof gains a `valueinput` state that reads the same `aria-valuenow`
  attribute as the indicator-only `valuenow`, but gates under `formValues`
  instead of `controlSemantics` because the value is user input. Value
  validation is identical (bounded decimal, up to 15 integer and 6 fraction
  digits, no exponent). `semanticAriaStateGate` keeps the state->gate binding
  the validator relies on; a new `semanticAriaStateAttribute` helper maps
  `valueinput` back to `aria-valuenow` so the session reads and the presenter
  paints the real attribute (never a literal `aria-valueinput`). The receiver
  re-checks that the replica element's role is `slider`/`spinbutton` before
  presenting, and rejects `valueinput` on an indicator or `valuenow` on a
  slider. `aria-valuetext` (free text) still never travels.
- **Native `<input type="range">` and `<input type="number">`.** These are the
  native slider/spinbutton; their value lives in `.value`, not
  `aria-valuenow`. The classifier now admits them as `ordinary-form`, so the
  existing value-record path carries `.value` under `formValues` exactly like a
  text field's value (and a label under `controlSemantics`). Secret and
  personal precedence is unchanged: a `cc-*` autocomplete still classifies
  secret and a personal autocomplete (e.g. `bday-year`) still takes the
  stronger `personal` gate before the ordinary-form branch is reached.

Why this is safe. Both paths are opt-in: nothing travels unless `formValues` is
granted (the `full-visible` profile). The always-on base mirror still strips
the `value` attribute and treats slider/spinbutton as private roles, so the
page-only baseline is unchanged; the semantic protocol is the one authorized,
gated channel, exactly as it already is for ordinary text-input values. The
asymmetry D37 noted -- typed text carried, dragged/spun values withheld -- is
now closed.

Tests: the session ARIA proof test now expects the slider's `valueinput` under
`formValues` (the D37 fixture that asserted exclusion is inverted) and a new
case carries native range/number value records; the receiver test admits
`valueinput` on a slider and rejects it on an indicator (and the reverse for
`valuenow`); the presenter test proves `valueinput` paints and restores
`aria-valuenow` without a literal `aria-valueinput`; the classifier test admits
native range/number as ordinary form while keeping personal/secret precedence.
`npm run check` is green and `dist/chrome-unpacked` is re-synced.

The second open call (D37's `aria-labelledby` accessible names, plus
`aria-describedby`) is a separate relationship-proof change on its own branch.

### D39. Accessible-name relationships: aria-labelledby and aria-describedby (2026-09-06)

Branch `fix/aria-labelledby-relationship-proof` stacked on D38's branch (both
resolve the two calls D37 left open; they touch the same ARIA code, so they
stack rather than run independently). Resolves the deferred entry "Add bounded
accessible-name support for safe `aria-labelledby` control relationships" and,
per the approved scope, `aria-describedby` in the same mechanism.

The problem. The base sanitizer strips `aria-labelledby`/`aria-describedby` as
private ID-reference surface, and the semantic label reader uses only direct
label sources (`aria-label`, `title`, option text, button value). A control
named only by referenced visible text therefore arrives unnamed. Carrying the
resolved name as a text record was rejected in D37: it would paint an
`aria-hidden` span duplicating the already-visible referenced text.

The design (approved before building): a relationship proof, not a text record.

- **Protocol.** A new `aria-relationship` proof carries the control's native
  bridge nodeId, the `relation` (`labelledby`/`describedby`), and the referenced
  nodes' native bridge ids in author order -- never a source id string and never
  text. Gate `controlSemantics` (page-authored structure). Bounded: 1..32
  targets, each a positive integer, unique, and never the control itself. Its
  identity is per (control, relation); its signature includes the ordered id
  list; byte accounting scales with the id count.
- **Source.** For each public-semantic element the session parses the id list,
  resolves each id within the element's own tree scope only (aria references
  never cross a shadow boundary), skips the element itself and any
  credential-secret referenced node, maps the survivors to native bridge ids,
  and emits one proof per relation. No id string or text leaves the source.
- **Receiver.** Resolves the control (voiding the batch if the control itself is
  absent or unsafe, like every other proof) and then filters the references to
  those that are represented, safe (non-secret), and in the same replica tree
  scope. Unlike a select's contained options, label references point anywhere in
  the tree scope, so a dropped reference is filtered rather than voiding the
  whole batch; a fully-unresolved relationship resolves to an empty reference
  set and presents as a no-op.
- **Presenter.** Points the control's `aria-labelledby`/`aria-describedby` at
  the already-present replica nodes, reusing a node's own unique id when it has
  one and otherwise assigning a replica-owned `simul-aria-ref-*` id (checked
  unique against the live document). Every change is reversible: teardown
  restores the control attribute and removes only the ids this proof added,
  leaving source-authored ids untouched. No text is painted, so the visible
  referenced text is never duplicated.

Tests: protocol round-trip plus rejections (wrong gate, non-`labelledby`/
`describedby` relation, empty/self/duplicate/oversized target lists, distinct
per-relation identity); session emits both relations, drops a secret reference,
drops a dangling reference, carries no id string, and is gated by
controlSemantics; receiver filters secret/unknown/foreign-scope references and
no-ops rather than voiding on a fully-unresolved set; presenter reuses an
existing id, assigns a replica-owned id, and restores everything on teardown.
`npm run check` is green and `dist/chrome-unpacked` is re-synced.

Both of D37's open calls are now resolved (D38 range values, D39 accessible-name
relationships). The two text-serialization privacy-floor entries and the other
deferred entries still stand.

### D40. L4/L5: the UI string catalogue and atomic localization (2026-09-07)

Branch `feat/ui-string-catalogue` off `main` (`eb09813`). Resolves the two
low-severity review findings held since 2026-09-03 and scoped in D35:

- **L4** — localization was not atomic in practice: `[data-ui-label]` text
  translated, but titles, aria-labels, placeholders, status lines, and loading
  states stayed English.
- **L5** — every newly seen dynamic label forced the whole interface back to
  English and re-localized, a visible flash.

The design (as scoped in D35): one catalogue module, every code-driven label
and status reading from it, `UiLocalizer` extended from atomic control labels to
titles/aria/status templates, and the flash closed by pre-registering the whole
catalogue as one atomic set.

- **Catalogue.** `lib/companion-ui-strings.ts` is the single source of truth for
  every code-driven user-facing English string (statuses, toolbar
  labels/titles/aria, settings and image-panel copy). Templated strings are
  frames carrying numbered `{0}` placeholders that survive machine translation;
  `formatUiTemplate` fills them after the frame is localized, so interpolated
  values (counts, already-localized language names, opaque error text) land in
  the target language's word order. `ALL_UI_STRINGS` is derived with
  `Object.values`, so the atomic localization set can never drift from what the
  modules actually show. Static markup keeps its English in `index.html`; the
  localizer gathers those `data-ui-*` strings from the DOM.
- **Localizer.** `UiLocalizer` now gathers and applies `data-ui-title`,
  `data-ui-aria-label` and `data-ui-placeholder` in the same atomic pass as
  `data-ui-label` text, exposes `localized()` and `localizeTemplate()` for
  imperatively written surfaces, `setAttribute()` for code-driven attributes
  (which re-localize on the next pass via their marker), and an `onApply` hook.
- **Status surfaces.** `ToolbarStatus` keeps the English message for
  `statusText` and attention routing (both still match English), displays the
  localized form, and re-renders through `onApply`. The composer, read-scope and
  image-analysis panels localize their own status/labels at set-time through
  injected helpers.
- **L5.** `DYNAMIC_UI_LABELS` is now `[...ALL_UI_STRINGS, replica badges]`, so a
  newly shown string is already in the set and never triggers an
  English-then-localized flash.

Every side-panel module (`main.ts`, `translation-driver`, `capture-pipeline`,
`surface-switcher`, `source-follower`, `permission-flows`, `read-scope-controller`,
`image-analysis-panel`, `quick-composer`, `preference-client`) reads its
displayed strings from the catalogue; `index.html` static titles/aria/placeholder
and headings/dialog text carry `data-ui-*` hooks.

Tests: a new `companion-ui-strings` test (template fill/reorder, contiguous
frame tokens, `ALL_UI_STRINGS` dedup/coverage); `ui-localizer` extended for
attribute localization, the `localized()`/`localizeTemplate()` accessors, and
`onApply`; each migrated module's test env supplies the new injected helpers;
the two `main.ts`/module source-substring assertions that named moved literals
now assert the catalogue references. `npm run check` is green (1,386 tests, 1
skipped) and `dist/chrome-unpacked` is re-synced.

Owed and documented (see `handover-2026-09-07-ui-string-catalogue.md`): the
manual Chrome pass must confirm real on-device Translator behaviour for the
`{0}` frames (token preservation, RTL) and that the imperative status surfaces
(composer, read-scope, image-panel, and the detected-language line) also
re-localize on a pure language switch — they localize at set-time and via the
toolbar's `onApply`, but those secondary surfaces are not yet re-driven on a
language change with no other state change. The build identity is deliberately
not bumped (still owed after the browser pass, per the prior handover).

---

### D41. Review of PR #22: close the toolbar-side L4 gaps (2026-09-08)

Same branch `feat/ui-string-catalogue`, follow-up commit on top of `cbb5e2c`.
A review of the D40 commit (findings recorded in
`review-2026-09-08-ui-string-catalogue.md`, corroborated by an independent
reviewer) found that D40 achieved atomic localization for the catalogued and
markup surfaces but left the **toolbar progress presentation** English: it wired
`localize()` into the progressbar labels but the source strings lived outside the
catalogue, so the call was an inert no-op (finding **F1**). Five findings were
fixed here; **F2** stays deferred and **F6** was declined.

- **F1 (medium, fixed).** The visible image-OCR progress label and the whole
  `toolbarActivityLabel()` family plus the idle/determinate fallbacks are now
  catalogue entries (`UI_STRINGS.progressRecognizingImageText`,
  `UI_STRINGS.activity*`). `lib/companion-ui-state.ts` `toolbarActivityLabel`
  returns `UI_STRINGS.*` (no import cycle — the catalogue module has no imports),
  and `toolbar-status.ts` references the catalogue instead of module-local
  literals. They therefore flow into `ALL_UI_STRINGS` → `DYNAMIC_UI_LABELS` and
  localize by construction. A guard test in `companion-ui-state.test.ts` asserts
  every `toolbarActivityLabel` output is a member of `ALL_UI_STRINGS`, so the
  "bare literal reaches `localize()`" class cannot regress.
- **F3 (low, fixed).** `ToolbarStatus.showProgress` now takes a raw English frame
  plus its interpolation args (`#englishProgressLabel` truly holds English), and a
  new `#renderProgressLabel()` localizes then fills. `translation-driver` passes
  the raw `progressDownloadingPack` / `progressTranslating` frames with their
  counts, so a language switch re-localizes and re-fills them correctly.
- **F4 (low, fixed).** `setStatus` gained an optional `englishMessage` used for
  attention routing and `statusText`; the composite partial-translation summaries
  (`main.ts`, `translation-driver`) and the composer error path (`quick-composer`)
  now hand it the English assembly while still displaying the localized form,
  restoring the D40 invariant that routing matches English, never localized text.
- **F5 (low, fixed).** The templated size-toggle aria-label/title are re-driven by
  a new `relocalizeSizeToggle()` called from `relocalizeDynamicSurfaces()`
  (`onApply`) as well as `syncToolbarPreferenceControls`, so they follow a pure
  To-language switch instead of sticking until the next size/zoom change.
- **F7 (low, fixed).** `translation-driver` now passes the plain `localizeUi`
  (newly injected into its environment) to `describePartialReplicaTranslation`,
  matching `main.ts` and removing the redundant double `formatUiTemplate`.
- **F2 (low, deferred — unchanged).** The other imperative surfaces (composer,
  read-scope, image-panel status, detected-language line) still re-localize only
  at set-time; re-driving them on a pure language switch stays gated on the manual
  Chrome pass, per D40 and the prior handover.
- **F6 (low, declined).** Memoizing `Intl.DisplayNames` per target language is a
  minor allocation cleanup, not taken here.

Gate: `npm run check` green — typecheck clean, **1,387 tests pass, 1 skipped**
(one guard test added), `dist/chrome-unpacked` re-synced and byte-verified. The
build identity is still not bumped (owed after the browser pass). See
`handover-2026-09-08-l4-followup.md`.

### D42. Implement F2 and bump the build identity every change (2026-09-08)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `8434078`. At the
owner's direction, **F2 is now implemented** (rather than staying gated on the
manual Chrome pass) and the **build identity is bumped on every change** so the
newest build is always identifiable from its version name.

- **F2 (implemented).** The imperative status surfaces that previously
  re-localized only at set-time now re-render on a pure language switch, driven
  from `relocalizeDynamicSurfaces()` (the localizer's `onApply`), mirroring
  `ToolbarStatus.relocalize()` / `relocalizeSizeToggle()`:
  - A shared primitive, `entrypoints/sidepanel/dynamic-status-text.ts`
    (`DynamicStatusText`), stores the last English catalogue **frame + args** and
    re-renders via `formatUiTemplate(localize(frame), args)`; tone stays
    caller-owned (a tone never changes with language). It backs the **composer
    status** (`quick-composer.ts`) and the three **read-scope** statuses — setup,
    reset, and reset-cleanup (`read-scope-controller.ts`), including the templated
    pending-cleanup count and the copied cleanup message.
  - The **image-panel status** is the diagnostics empty-state
    (`imagePanelNoActivity`), the panel's only imperative text — everything else
    goes through the `data-ui` marker path the localizer already re-drives; a new
    `ImageAnalysisPanel.relocalize()` re-runs `renderDiagnostics()`.
  - The **detected-language note** (`translation-driver.ts`) embeds a
    source-language name shown *in the current target language*, so a finished
    string cannot be re-localized by frame+args alone. It stores a re-render
    **thunk** capturing the raw inputs (detection source, resolved language code,
    image proposal); `relocalizeDetectedLanguage()` re-runs it, re-deriving the
    language name via `localizeLanguageName` in the language now current.
  - The refactor is output-preserving under an identity localizer (existing tests
    unchanged). New coverage: `dynamic-status-text.test.ts` (5) plus one
    language-switch test per surface (composer, read-scope with an interpolated
    count, image panel, detected-language re-deriving the language name).
- **Build identity bumped to `0.4.0 beta v.20260908.1`** (`wxt.config.ts`).
  D40/D41 deferred the bump so a shipped id would map to a browser-verified
  build; the owner prefers the id always track the newest build, so it is bumped
  now and should be re-bumped on each subsequent change. Fixtures updated
  (`build-identity`, `extension-artifact` tests); `dist/chrome-unpacked` re-synced.
- **Newly spotted, deferred.** The image method-toggle checkbox aria-label
  (`image-analysis-panel.ts` `#createMethodList`) is a *templated* aria written
  with `localizeTemplate` directly (not the marker path) and guarded behind the
  panel `renderKey`, so it is stale after a pure language switch — the same class
  as F5. Not fixed here to keep F2 scoped; worth folding into the browser pass.

Gate: `npm run check` green — typecheck clean, **1,396 tests pass, 1 skipped**
(+9), `dist/chrome-unpacked` re-synced and byte-verified. Still owed: the manual
Chrome pass (unchanged), which should now also confirm the F2 surfaces above and
the deferred method-toggle aria-label.

### D43. Release-readiness pass: close the method-toggle aria gap and stamp today's identity (2026-09-22)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `b0cb195`. A
review of the project state ahead of the owner's manual Chrome pass and the
public publish. Everything pushed was already current (PR #22 open and
mergeable, no open Dependabot alerts or PRs, gate green at 1,396 tests); three
things were stale or still owed and are fixed here.

- **The deferred method-toggle aria-label is now re-driven (closes the D42
  "newly spotted" item).** In `image-analysis-panel.ts` `#createMethodList`,
  each method checkbox's `aria-label` is a filled template (`Enable {0}` /
  `Disable {0}` around the localized method name) written with
  `localizeTemplate` rather than the `data-ui` marker path, and the list is
  guarded by the panel `renderKey`, so it stayed in the old language after a
  pure To-language switch — the same class as F5. Each toggle now records a
  re-apply thunk (`#methodToggleRelocalizers`, rebuilt whenever the list is)
  that re-reads the live `checked` state and re-fills the template;
  `ImageAnalysisPanel.relocalize()` runs those thunks before
  `renderDiagnostics()`. The list is not rebuilt, so no control is destroyed
  under the user's focus. One language-switch test added
  (`image-analysis-panel.test.ts`): three toggles, one disabled, asserted before
  and after a dictionary flip, and the same input nodes survive.
- **Build identity advanced to `0.4.0 beta v.20260922.1`** (`wxt.config.ts`),
  per the D42 rule that the id tracks every shipped change. Fixtures updated
  (`build-identity`, `extension-artifact` tests); `dist/chrome-unpacked`
  re-synced (manifest, `sidepanel.html`, and the side-panel chunk hash).
- **README brought back into agreement with the build.** It still named
  `v.20260905.1` in both places (the D42 bump to `v.20260908.1` did not touch
  it); the fresh-identity spec requires the Options label, manifest, README
  and identity tests to agree exactly. Also added one sentence under "Use
  Simul" saying the companion's own labels, titles, hints and status messages
  follow the To language once the pair is installed — the L4/L5 behaviour was
  not described anywhere a tester would read.

Gate: `npm run check` green — typecheck clean, **1,397 tests pass, 1 skipped**
(+1), `dist/chrome-unpacked` re-synced and byte-verified.

Publish state and the runbook for after the browser pass are in
`handover-2026-09-22-release-readiness.md`. Still owed: the manual Chrome pass
(unchanged list, now including the method-toggle aria-labels), then the
numeric version bump, PR #22 merge, tag and GitHub release.

**D43 addendum (same day, owner answers).** The owner chose **0.5.0** for the
release and asked for the version inside the extension to be updated now, so
the numeric bump is no longer a post-test publish step: `package.json` /
`package-lock.json` are 0.5.0 and the identity is **`0.5.0 beta v.20260922.2`**
(second shipped build today), with README, `THIRD_PARTY_NOTICES.md` and the two
identity tests in agreement and `dist/chrome-unpacked` re-synced. What the owner
tests this afternoon is byte-for-byte what the release will carry; the
remaining publish steps are merge, tag and release. The owner also set the
public voice: mention only that Simul started as a quick build for the OpenAI
Build Week hackathon as something we would use ourselves and is now shared for
others; say plainly that translation is fully on-device with nothing remote;
give the install steps, that it is a Chrome extension, and the requirements,
all as simply as possible. The README's top (intro, "What you need",
"Install", "Use Simul") was rewritten to that brief; the reference sections
below it are unchanged. The owner asked for everything to be pushed to the
NAS so they can load it on their computer: the committed tree was mirrored
over the stale July copy at `Dev/simul/` on the rsync daemon another project's
tooling uses (the owner's NAS), protecting that copy's
`.git`, `node_modules`, `.output`, `.wxt` and `@eaDir`; the loadable folder is
`Dev/simul/dist/chrome-unpacked`. Merge and release remain gated on the
owner's Chrome pass, as they chose.

### D44. Hidden regions keep their stylesheet text (freee.co.jp sign-up modal) (2026-09-22)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `93f2cf0`. During
the owner's Chrome pass, https://www.freee.co.jp/ showed "a giant Google logo
and a mail icon, scaling with the page width, on top of the page" in the
mirror only; the source tab was fine. The staged 0.3.3 build showed it too, so
it was not a regression. Root cause found by running the real page and its
three real stylesheets through the sanitizer (temporary test, not kept), then
reduced to a deterministic case:

- **The page** hides its sign-up modal (`#individual-modal`, class
  `modal__signup`, `display:none` until opened) with a `<style>` element that
  sits *inside* the modal. Neither external stylesheet mentions that class.
- **The sanitizer** treats a hidden or controlled disclosure region as
  withheld and blanked every text node inside it, including the CSS text of
  that `<style>`. The replica therefore never received
  `.modal__signup{display:none;position:fixed;…}`; the modal rendered as flow
  content. Its page text was withheld as well, so only its icons survived: the
  Google and mail sign-up marks, unsized because their modal-scoped rules were
  gone with them. Exactly what the owner described.
- **Why Passive's CSSOM path did not rescue it.** The site's global stylesheet
  is 2.7 MB with about 35,000 rules, above the per-sheet 512 KB cap, so it
  exhausts the shared style budget; every later `<style>`/`<link>` then falls
  back to raw text or a plain link. The raw text of this one was blanked. Under
  Conservative the CSSOM path never runs, so it failed there always. The large
  sheet itself is handled as designed: it is kept as a request-capable link and
  the replica fetches it (the CDN serves it to an extension-style request).
- **Fix.** `SerializeContext` gains `privacyRegion`, the privacy-and-menu-only
  subset of `privateRegion` (private controls, native selects, public menus;
  never merely hidden). The text branch withholds a node when
  `privateRegion && !(styleRegion && !privacyRegion)`: stylesheet text is
  presentation, not page content, so a hidden or controlled region keeps its
  CSS while a privacy or menu boundary still withholds it. Root contexts derive
  it through a new `hasSourcePrivacyWithheldAncestor`, sharing the walk with
  `hasSourceBaseWithheldAncestor`. The redaction counter no longer counts kept
  CSS. Test: `keeps stylesheet text inside a hidden region while withholding
  its page text` (hidden, aria-hidden, and a `role=textbox` privacy control),
  verified to fail without the fix on the CSS assertion.
- **Not changed.** The shared style budget still stops at the first oversized
  sheet for the rest of the pass; with the raw-text fallback now intact for
  hidden regions this is safe, and a page that big is what the budget is for.

Build identity `0.5.0 beta v.20260922.3` (third shipped build today);
`dist/chrome-unpacked` re-synced (manifest and the page bridge bundle). Gate:
`npm run check` green, **1,398 tests pass, 1 skipped** (+1). The temporary
bisect builds under `Dev/simul-bisect/` on the NAS were removed; `Dev/simul/`
was re-mirrored to this commit.

### D45. Declared-hidden but painted regions are ordinary page text (freee.co.jp footer) (2026-09-22)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `86443ad`. After
D44 the owner reported, on the same page, that the footer's product links
under each "製品" heading showed no text, that the top carousel's images did
not show, and asked whether text inside images is still translated.

- **Footer links (fixed).** The site's accordion script marks collapsed
  `[data-js-accordion-content]` lists `aria-hidden="true"` (and inline
  `display:none`), while the desktop stylesheet forces that content visible
  again (`[data-js-accordion=pcDisabled] [aria-hidden=true]{display:block
  !important}`). The sanitizer withheld any region carrying `hidden` or
  `aria-hidden="true"` before consulting computed style, so painted links lost
  their text; the base graph of the served HTML kept all 93 footer links with
  text, which pointed at live-page state rather than markup. Now
  `elementStartsHiddenOrControlledDisclosureRegion` lets computed style decide:
  a computed-hidden element is withheld; a declared-hidden element that
  computed style shows is withheld only when it has no client rect with a
  positive size (`hasSourcePositivePaintBox`, content-free); unreadable style
  or geometry keeps the declaration (fail closed). The strict
  `sourceElementPathIsPainted` proof could not be used because it reports a
  declared-versus-computed contradiction as `unknown` by design. Test: `keeps
  the page text of a painted region that is only declared hidden` (painted
  `aria-hidden` link kept; `hidden` with computed `display:none` withheld;
  declared hidden with a zero-size box withheld), verified to fail without the
  fix. The semantic channel's `isExplicitlyHidden` (trigger/panel collapse
  proofs) is untouched.
- **Image text (answered, documented).** OCR is off by default (`imageTranslationEnabled: false`; the toolbar **OCR** toggle). With it on, pixels are captured from the source tab, so the image must be on screen there. Every text-bearing raster image on this page sits inside a link or button, and images inside controls are one read capability (`controlImages`), off under the Page-only scope and on under Standard and Full visible. The README troubleshooting bullet now says so.
- **Carousel images (open).** The `.kv-carousel` slides keep their `<img src>` in the base graph, inline Swiper transforms pass `sanitizeCss` unchanged, the Swiper stylesheet is retained as a link, and neither the visually-hidden detector nor the control-images switch touches base `<img>` transport. The live Swiper state cannot be reproduced from served HTML; the owner is asked what the top area shows (the text slides but never the picture slide, or an empty box) to separate a withheld image from a missing layout.

Build identity `0.5.0 beta v.20260922.4`; `dist/chrome-unpacked` re-synced
(manifest and the page bridge bundle). Gate: `npm run check` green,
**1,399 tests pass, 1 skipped** (+1). NAS `Dev/simul/` re-mirrored.

### D46. Page text and image text translate together (2026-09-22)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `0c42f47`. After
the `.4` build the owner confirmed the footer links carry their text (D45) and
that the carousel images had loaded, then reported that "regular text is not
being translated now, only the OCR text", with no status line they noticed;
pressing **Translate page** fixed it.

- **Cause (by design until now).** Page text translates only under a saved
  automatic-translation mode for the site ("Off / This site / All sites") or
  after a **Translate page** press, and that press is remembered in memory
  only. Reloading the extension for the new build gave a fresh panel, so the
  rebuilt mirror sat at "Ready to translate … on-device" in the quiet success
  tone. Image translation, once enabled, is a saved setting that runs on the
  current mirror by itself (`enabled` depended only on the OCR preference, the
  view mode, methods and access), so translated image overlays appeared on an
  untranslated page. The intent flag itself survives same-page rebuilds
  (`retainTranslationIntent` for manual, desynchronized and preference
  captures), so this was not a reset bug.
- **Owner ruling.** "We need both to run at the same time." Enabled image
  translation now counts as intent for the page text:
  `replicaViewTranslationAction` takes `imageTranslationEnabled` and treats it
  like a retained manual request (source-only mode still skips; a downloadable
  pack still needs the one Translate click that prepares it);
  `TranslationDriver.maybeTranslateAutomatically` passes the preference; and
  `PermissionFlows.changeImageTranslationEnabled` asks for the page text right
  when OCR is switched on for a mirrored page, through the same
  `requestAutomaticTranslation` hook the automatic-scope flow uses. Switching
  OCR off leaves the page translated. Tests: lifecycle (image intent in
  translated, downloadable and source-only cases), driver (translates with the
  preference on and no click), permission flows (asks on enable, not on
  disable, not without a replica).
- **README.** Step 4 no longer calls the Translate press conditional; step 6
  and the "Image text" section say page text and image text translate
  together.

Build identity `0.5.0 beta v.20260922.5`; `dist/chrome-unpacked` re-synced
(manifest, `sidepanel.html` and the side-panel chunk). Gate: `npm run check`
green, **1,403 tests pass, 1 skipped** (+4). NAS `Dev/simul/` re-mirrored.
Remaining from the owner's pass: nothing open; the carousel images resolved
with the `.4` build.

### D47. Image translation on by default; a reset still clears every grant (2026-09-22)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `b825bab`. Owner
direction after the `.5` pass: "please make sure OCR on is the default, not
off"; everything else on freee.co.jp was reported working, except that the top
carousel's images "disappeared again".

- **Default.** `DEFAULT_COMPANION_PREFERENCES` and `createDefaultPreferences()`
  now set `imageTranslationEnabled: true`. Pixel OCR still needs the optional
  `<all_urls>` grant, which only a gesture can give, so a fresh install shows
  **OCR On** with the existing "needs image access" title; the first click on
  the OCR button requests the grant (that flow already existed), a later click
  turns image text off. The accessibility-text method stays disabled by
  default as before. With D46, an enabled OCR also carries page translation, so
  a mirrored page now translates on open without a Translate click. The image
  panel's microcopy key `imageOffByDefault` became `imageOnByDefault` with
  matching text; README (steps 4 and 6, the Image text section, the
  troubleshooting bullet) and both docs pages say on by default.
- **Reset semantics.** "Reset all" must still clear every grant (README), but
  the reset's fresh defaults now say image translation is on, and the cleanup
  retained whatever the saved intent needed, so the broad grant would have
  survived. `resetRetainedPermissionOrigins` now treats image translation's
  broad access as retained only when the grant ledger holds it: a reset clears
  the ledger and the OCR button's grant flow refills it, so "on" alone no
  longer proves the user asked for the grant after the reset. A reset therefore
  leaves image translation on but without the grant, exactly like a fresh
  install. `withGrantLedger` only adopts a retained origin that is actually
  granted at save time and never runs before a pending cleanup, so a pre-reset
  grant cannot slip into the ledger.
- **Tests.** Default expectations updated (`preferences`, coordinator reset and
  patch results, the image panel microcopy); the ledger and grant tests that
  are about automation alone now pin image translation off in their fixtures;
  the two manual-intent driver tests do the same because of D46; the
  pending-reset test's fixture carries the ledger entry the new rule requires;
  the two permission-flow tests that start from "off" use the harness's
  `stored` override. Gate: `npm run check` green, **1,403 tests pass,
  1 skipped**.
- **Carousel images (explained, decision pending).** The images had reappeared
  with `.4` while the page was untranslated and vanished with `.5` once the
  page translated automatically. That is the image-text feature itself: OCR
  overlays are opaque white boxes (`rgba(255,255,255,0.94)` per recognised
  line, `0.86` for a whole-image label) placed over the recognised text, and
  the carousel banner is almost entirely text, so the overlays whitewash it.
  With OCR on by default this will be common on text-heavy banners. Options
  put to the owner: keep as is; make the backdrop more translucent so the
  picture shows through; or render label-based results as a caption band.

Build identity `0.5.0 beta v.20260922.6`; `dist/chrome-unpacked` re-synced.
NAS `Dev/simul/` re-mirrored.

**D47 addendum (owner ruling).** OCR overlays stay as they are: opaque white
boxes over each recognised line, also on text-heavy banners such as the
freee.co.jp carousel. Nothing is open from the Chrome pass; the publish waits
only for the owner's go.

### D48. Label-based image translations become a caption band (2026-09-22)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `797988f`. The
owner reported that the freee.co.jp carousel "still disappears", possibly
"resized very small after a move", and ruled on the overlay: "the text should
try to appear where it belongs on the image. It shouldn't just replace
everything." Their Image text settings have every reading method on, and the
overlay they see is "one box covering the whole image with all text".

- **Cause.** With the accessibility-text method enabled, the banner's `alt`
  ("個人向け 確定申告するなら、freee いますぐ！無料で登録") is translated and
  projected as a `whole-image` region: one box the size of the picture with an
  86% white backdrop. It is a provisional preview; pixel OCR replaces it with
  per-line boxes when its capture succeeds, and stays when capture does not
  (a slide that moved, text covering the image, a pack not ready). That is why
  the cover came and went, and why it read as the picture vanishing. OCR
  regions were already placed per line (`normalizeTesseractPage` walks
  blocks/paragraphs/lines; TextDetector returns per-detection boxes; the
  controller hands `recognition.result.regions` to the projector unchanged), so
  "where it belongs" already held for pixel results.
- **Change.** In `ImageOverlayProjector.#refreshEntry`, a region with
  `placement: 'whole-image'` is laid out by `captionBandBox(width, height)`:
  a full-width band along the bottom edge, 34% of the image height and at
  least 20px (never taller than the image), geometry rounded to CSS
  hundredths. The picture stays visible and the translated label reads as its
  caption; OCR boxes, which have geometry, still replace it when they arrive.
  The controller and the 0.86 backdrop are unchanged. Tests: a projection-level
  test (200×120 image → band at top 79.2px, height 40.8px, full width; fails
  without the change with the old full-cover box) and the band's minimum
  height on short images.
- **Docs.** README image-text step 2 and `docs/image-translation-research.md`
  now say the label is shown as a caption band along the bottom edge.
- **Not isolated.** Whether anything is "resized very small after a move" was
  not reproduced; the console readout that would show it was not run. If it
  persists with the band, the next question will carry the snippet inside it.

Build identity `0.5.0 beta v.20260922.7`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,405 tests pass, 1 skipped** (+2). NAS
`Dev/simul/` re-mirrored.

**D48 addendum (session close).** With the `.7` build the owner still saw the
carousel image "shrink or vanish at times"; the one-line readout sent in the
question had a syntax error, so nothing was measured. The owner asked to close
the session and continue in a new one. `handover-2026-09-22-session-close.md`
records the state, the parsed readout to run first, what is already ruled
out, and the publish step (to be logged as D49).

### D49. A carousel controlled by stateless buttons is page content (2026-09-22)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `9e995e4`. The
open freee.co.jp item ("the carousel image shrinks or vanishes after a move")
was read out this session with a selector-agnostic console snippet: of the 137
images in the replica, the only one inside `.kv-carousel` was the 24px pause
icon that the page's own script injects *outside* the Swiper wrapper; no slide
text or slide image was present, and the owner placed the change "when the
carousel advances from the first slide to the second", not reproducible at
will.

- **Cause.** Swiper 8.1.4's accessibility module (on by default in the bundle
  the page loads) gives the slide wrapper a generated `id` and points the
  previous/next buttons at it with `aria-controls`. Simul's controlled-content
  policy marks every resolved `aria-controls` target `withheld` and reopens
  only a structurally unique `role=tab` → `role=tabpanel` relation; the wrapper
  has two triggers and no tab semantics, so from the moment Swiper initialises
  it is a withheld region: text blank, `alt` and other private attributes
  stripped, image sources dropped from the hint path. The panel that opens
  before Swiper's `afterInit` shows the slides; the first attribute churn on a
  participant path (the slide change) refreshes the policy and withdraws them,
  which is the "after a move". Reproduced offline: the served HTML through
  `sanitizeSourceDocument` keeps the slide text as served and blanks it once
  the wrapper id and the buttons' `aria-controls` are added, with one or two
  buttons alike. Neither the semantic channel (`aria-expanded` disclosures and
  tabs only) nor any read scope could re-admit it, so visible content was
  unreadable under every profile.
- **Change.** A target is now `controlled-region` (readable, hidden-region
  rules unchanged) when every controller that references it is stateless: no
  `aria-expanded`, `aria-selected`, `aria-pressed`, `aria-checked` or
  `aria-haspopup` (any value, and an unreadable attribute fails closed), no
  `role` of tab/combobox/switch/checkbox/radio/menuitemcheckbox/menuitemradio,
  not a native `input`/`select`/`textarea`/`details`/`summary`, and not inside
  a `tablist`. One stateful trigger keeps the target `withheld`; the popup
  case (`<button aria-expanded="true" aria-controls>`) and every tab rule are
  unchanged. State flips are reported by `sourceControlledContentChangedTargets`
  so the source session re-emits the region. Image policy is unchanged: an
  image inside a stateless controlled region still counts as a control image
  (`hasSourceAriaControlledRegionAncestor`), so the OCR gate is as before.
- **Tests.** `tests/stateless-controlled-region.test.ts` (5): the carousel
  wrapper is readable while its stateful neighbour stays withheld; each state
  attribute, `role=tab`, a native control and a tablist member flip it back to
  withheld; the flip is a changed target in both directions; the banner image
  remains a control image. The offline freee reproduction was a temporary test,
  not kept (site HTML is not committed).
- **Docs.** `docs/replica-fidelity.md` states the rule.
- **Not proven.** Whether this is the whole of the owner's observation. The
  sanitizer never removed the slide `<img>` element itself, only its text and
  private attributes, so the missing image in the readout is either the same
  refresh seen mid-replacement or something in the live patch path; the owner
  re-tests with the `.8` build and, if the picture still shrinks or vanishes,
  runs the structural readout in the session-close handover.

Build identity `0.5.0 beta v.20260922.8`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,410 tests pass, 1 skipped** (+5). The publish
becomes **D50**.

### D50. A class flip on a region of activation controls is not a masking transition (2026-09-22)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `b49a540`. With
the `.8` build the owner still saw the freee.co.jp carousel empty out "as
soon as the first move happens": the deactivated pagination bullet vanished,
then the next one on the next move, then the slides, and the empty 333px box
stayed. That shape (elements disappearing exactly when the page mutates them)
pointed at the live patch path, and the source session reproduced it offline
with the mutation records Swiper 8 emits for one `slideNext()`.

- **Cause.** `rememberSourceMutationSecrets` treats an element whose `class`
  or `style` attribute mutates twice within one observer batch as a transient
  style boundary: the observer cannot see the intermediate CSSOM state, so if
  that region "may hold a value" the element is classified with a computed
  text-security of `disc`, which the sticky classifier keeps as a credential
  secret for the page's lifetime. The mirror then rebuilds (`stream_gap`) and
  the element returns as an opaque placeholder, empty and unstyled, and every
  later mutation under it is ignored. "May hold a value" walked the subtree
  for `sourceElementIsValueOrControlBoundary`, which counted every activation
  control: `a`, `button`, `summary`, and the button/link/menuitem/tab/treeitem
  roles. Swiper removes the state classes from every slide and re-adds the
  new active/next/prev ones in the same tick, writes the wrapper's transition
  duration and transform as two style values, and re-marks the bullets, so
  each move made two class or style records on regions that hold a `<button>`
  or `<a>`, or on a `role="button"` bullet itself. From the first move on, the
  active, next and previous slides, the wrapper, and the bullets became
  placeholders one by one.
- **Change.** The masking rule now asks whether the region holds a
  *value-bearing* control: native `input`, `select`, `option`, `optgroup`,
  `textarea`, `label`, `output`; editable text (`contenteditable`, private
  roles); or a text-entry, checked or selected role (textbox, searchbox,
  combobox, listbox, option, spinbutton, slider, checkbox, radio, switch,
  menuitemcheckbox, menuitemradio). A region that holds only activation
  controls is ordinary content: its class and style churn is mirrored as
  attribute patches like any other. The sticky classification, the same-task
  computed-mask rule, the contenteditable and role transitions, and the
  control semantics of `a`/`button` everywhere else are unchanged. The unused
  control-token helper was removed.
- **Tests.** `tests/carousel-move-patches.test.ts` (5): a Swiper move
  batch (two style values on the wrapper, remove-then-add classes on five
  slides, bullets and `aria-current`) is mirrored as attribute patches with no
  error, three consecutive moves stay error-free, a region of links, buttons
  and a `role=button` span with two class records is not a credential, six
  value-bearing controls inside such a region still fail closed, and an
  element that becomes a textbox while its class flips still fails closed.
  The existing "conservatively remembers existing-node class and content
  transitions" and "does not turn ordinary dynamic class and text updates into
  credentials" cases pass unchanged.
- **Docs.** `docs/replica-fidelity.md` states the rule under the
  text-security invariant.
- **Method note.** No browser on this machine; the owner could not run the
  console readouts (the question dialog truncated them), so the cause was
  reached by driving `HtmlMirrorSourceSession` in the test harness with the
  page's real DOM shape and Swiper's real mutation sequence, bisecting the
  batch until one record combination forced the rebuild, then tracing the
  signal to the secret branch. D49 stays correct and necessary (the wrapper
  was withheld as controlled content before Swiper's first move); D50 is what
  emptied it after the move.

Build identity `0.5.0 beta v.20260922.9`; `dist/chrome-unpacked` re-synced
(only `page-mirror.js` and the manifest changed). Gate: `npm run check`
green, **1,415 tests pass, 1 skipped** (+5). The publish becomes **D51**.

**D50 addendum (owner confirmation).** With the `.9` build the owner confirmed
"slides, picture and circles stay" through the automatic moves, which closes
the carousel item that D48 left open. Two rulings from the same answer: the
release waits until the owner says, in their own words, that it is ready (they
had been asked three times and said "Don't keep pushing for that"), so the
publish runbook is not to be offered again; and a new observation, "the third
image in the carousel has text that shows up outside of the image instead of
on top of the image". Assessment (no code changed): the overlay projector
positions each image's overlay layer at `getBoundingClientRect()` when it is
asked to refresh, and after a live patch that refresh runs on the next
animation frame (`#refreshExtent` → `onLayoutChanged` →
`refreshOverlays()`); a Swiper move rewrites the wrapper's transform under a
300 ms transition that the replica plays, so the measurement is taken at the
start of the movement and the translated text stays where the picture was
while the picture slides on, which reads as text beside the next slide.
Nothing re-measures when the transition ends: the replica document has no
`transitionend`/`transitioncancel` listener and the image's ResizeObserver
does not fire for a pure translation. Two candidate fixes for a later
decision: (a) listen for `transitionend`/`transitioncancel` (and a bounded
settle timer) on the replica document and refresh the overlays then; or (b)
apply the same `transition: none` backstop to reconstructed HTML that the
fidelity doc already applies to inline SVG ("passive visual animation is not
enabled in this release"), which makes every replica state change instant and
keeps the post-patch measurement correct; keyframe `animation` should not be
suppressed the same way, since a page can rely on an animation's end state to
reveal content.


### D51. Read-scope toggle descriptions survive a localization pass (2026-09-22)

Same branch `feat/ui-string-catalogue` / PR #22, follow-up on `5a55302`. First
fix from the bug-hunt review (`review-2026-09-22-pr22-bug-hunt.md`, finding
L1); the owner chose to fix L1, the carousel overlay (O1+O2), the reset grant
and OCR button (G1+G3), and the hidden-text checks (P1+P2), one build each, and
ruled on the two open questions: the broad grant keeps today's single rule
("keep the simplest option": one `<all_urls>` grant retained while any enabled
feature uses it, no per-purpose bookkeeping), and accessibility-text captions
stay on after setup (fix the docs, not the behaviour).

- **Cause.** `ReadScopeController.#renderToggleSet` appended each toggle's
  `<small>` description inside the span that carries the title's
  `data-ui-label` marker. `UiLocalizer.applyToDom` compares a marked element's
  `textContent` with its label and rewrites it on a mismatch; title plus
  description never matches, so every pass, English included, replaced the
  span's children and the descriptions (among them "Credential and card data
  stay blocked.") vanished from Settings and the setup dialog until the next
  control re-sync. The controller test stubbed `setUiText`, so no test drove
  the real localizer over this markup.
- **Change.** The toggle text is an unmarked span holding two marked
  siblings: the title span and the `<small>` description. Layout is
  unchanged (the description was already `display: block`).
- **Tests.** `tests/read-scope-controller.test.ts`: "keeps every toggle
  description through a real localization pass" renders both toggle sets,
  runs the real `UiLocalizer` (an English `applyToDom`, then an `es` pass) and
  checks all twelve descriptions survive and localize, and that no title
  contains a description. It fails on `5a55302` (0 of 12 descriptions left).

Build identity `0.5.0 beta v.20260922.10`; `dist/chrome-unpacked` re-synced
(side-panel chunk, `sidepanel.html`, manifest). Gate: `npm run check` green,
**1,416 tests pass, 1 skipped** (+1).

### D52. Image overlays follow the page's clipping, painting and motion (2026-09-22)

Same branch / PR #22, follow-up on D51. Closes the open item from the D50
addendum ("the third image in the carousel has text that shows up outside of
the image instead of on top of the image"), findings O1 and O2 of the bug-hunt
review.

- **Cause (two parts).** The projector draws every overlay in one
  `position: fixed` layer at the image's `getBoundingClientRect()`, so the
  page's own clipping never applied: a carousel window's `overflow: hidden`
  did not cut the overlay, and label captions (D48) exist for slides outside
  the window because the scan policy pre-scans in the background. Those
  captions were painted beside the carousel. Second, a slide move plays a
  300 ms transform transition in the replica and nothing re-measured when it
  ended (scroll, resize, ResizeObserver and the engine's layout callback do not
  fire for a transform), so text measured at the start of the move stayed
  where the incoming slide had been, outside the window. A fade carousel
  (every slide stacked, all but one at `opacity: 0`) would also have shown
  every slide's overlay at once.
- **Change.** `ImageOverlayProjector` now (1) hides an overlay while
  `checkVisibility({ opacityProperty, visibilityProperty })` reports its image
  as not painted; (2) clips each overlay root with `clip-path: inset(…)` to the
  part of the image its clipping ancestors leave visible, walking the
  containing-block chain (absolute boxes skip non-positioned ancestors, fixed
  boxes escape all, `body`/root are the viewport's job), and hides it when
  nothing is left; the ancestor list is cached per entry and re-read when the
  replica's layout changes (`refresh()`), so scroll frames only read rects;
  (3) listens for `transitionrun`/`animationstart` on the replay document
  (capture) and, when the moving element contains an overlaid image (across
  shadow roots), re-measures every frame for at most
  `IMAGE_OVERLAY_MOTION_FRAMES` (90) frames, and once more on
  `transitionend`/`transitioncancel`/`animationend`/`animationcancel`. The
  listeners are removed with the layer. Option (b) of the addendum
  (`transition: none` on reconstructed HTML) was not taken: it fixes neither
  clipping nor fade carousels and changes page fidelity.
- **Tests.** `tests/image-overlay-projector.test.ts`, "carousel geometry
  (D52)" (5): partial and full clipping by a 300×200 carousel window and
  recovery, hiding while unpainted, following a transition frame by frame
  with a bounded loop and settling on the end event, ignoring motion on
  unrelated elements, and no listening after dispose. The first three fail on
  `5d78c73`.
- **Docs.** `docs/translation-companion.md` (image text) states the rule;
  `docs/image-translation-research.md` already called the overlays "clipped".

Build identity `0.5.0 beta v.20260922.11`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,421 tests pass, 1 skipped** (+5).

### D53. A pending reset cannot re-adopt the broad grant; the OCR button can always turn OCR off (2026-09-22)

Same branch / PR #22, follow-up on D52. Findings G1, G3 and the G4 docs
ruling from the bug-hunt review.

- **G1 cause.** `withGrantLedger` runs on every save and adopts each origin
  the saved intent retains that Chrome still grants. While a reset's cleanup
  was pending (Chrome's `permissions.remove` failed), the setup dialog's save
  found image translation on (the D47 default) and the pre-reset
  `<all_urls>` still granted, so it wrote `<all_urls>` into the freshly
  cleared ledger; the retry then treated that entry as the user's request and
  reported `{ status: 'complete', remainingManagedOrigins: 0 }` with the
  grant still in Chrome. D47's claim that the ledger "never runs before a
  pending cleanup" was wrong.
- **G1 change.** While `resetCleanupPendingRevision > 0` the ledger adopts only
  what the reset keeps (`resetRetainedPermissionOrigins`: site and all-sites
  automation the user chose after the reset, and image translation's broad
  grant only when the ledger already holds it). Outside a pending reset the
  rule is unchanged. Per the owner's ruling ("keep the simplest option"), G2 is
  not changed: one broad grant stays while any enabled feature, including
  default-on image translation, uses it.
- **G3 cause and change.** With OCR on by default, no image access and a usable
  pixel provider, every toolbar OCR click re-requested the grant, and a refusal
  left OCR on, so the toolbar could never turn OCR off (and, through D46, never
  stop the automatic page translation). The click decision is now
  `toolbarOcrClickAction` (`lib/companion-ui-state.ts`): after Chrome refuses in
  this panel, the next click turns image text off, and the button's title says
  so (`ocrTitleAccessDeclined`). Turning OCR on again clears the refusal.
  `PermissionFlows.changeImageTranslationEnabled` now resolves with
  `'applied' | 'denied' | 'activation' | 'busy' | 'failed'` so the toolbar can
  tell a refusal from a prompt that needs another gesture.
- **G4 (docs).** Completing the first-run setup turns the accessibility-text
  method on (unchanged, owner ruling "keep, fix the docs"), so with image
  translation on by default every eligible alt-bearing image gets a translated
  caption band before any image access. D47's sentence that the method "stays
  disabled by default" holds only before setup. README (Image text, step 2) and
  `docs/translation-companion.md` now say so, and the latter no longer calls
  the label a whole-image box (D48).
- **Tests.** `preference-coordinator`: a reset with failing removal, then the
  setup save, then the retry leaves no `<all_urls>` (fails before the change).
  `companion-ui-state`: the click decision table (2). `permission-flows`: a
  refusal from the default "on" state resolves `'denied'` and OCR can then be
  turned off; the activation case resolves `'activation'`. `sidepanel-ui`'s
  source assertion follows the new wiring.

Build identity `0.5.0 beta v.20260922.12`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,425 tests pass, 1 skipped** (+4).

### D54. Hidden-region and stateless-region checks require a really painted box (2026-09-22)

Same branch / PR #22, follow-up on D53. Findings P1 and P2 of the bug-hunt
review: two of today's relaxations let text that `main` withheld reach the
replica. Password, OTP and card values were never affected.

- **P1 cause and change (D45).** A declared-hidden (`hidden`/`aria-hidden`)
  region whose computed style showed it was kept whenever it had a positive
  client rect, although `opacity: 0`, `content-visibility: hidden` (Chrome's
  rendering of `hidden="until-found"`), `clip` and `clip-path` leave such a box
  unpainted; the strict paint proof already reads all of them. The declaration
  now also holds when any of these apply, for `hidden="until-found"`, and when
  `display`/`visibility` are unreadable (the comment already promised that).
  A faded account dropdown marked `aria-hidden`, a find-in-page answer and a
  clipped panel are withheld again; the freee footer case (declared hidden,
  forced visible and painted) is unchanged.
- **P2 cause and change (D49).** A region every controller of which is
  stateless became `controlled-region` without any paint check, so a "Show
  details" button without `aria-expanded` exposed a panel collapsed with
  `max-height: 0`, faded out, or clipped away by a zero-size overflow window.
  The grant now requires the panel's own box to be painted
  (`sourceElementPaintState` visible) and to survive its overflow-clipping
  ancestors (the intersection half of `sourceElementPathIsPainted`, extracted
  as `sourcePaintSurvivesClipping`). Ancestors are deliberately not required to
  prove their own paint state, so an unrelated `clip-path` or declared-hidden
  ancestor does not re-close a painted carousel; hidden ancestors are still
  handled by the hidden-region rules. The existing layout-triggered policy
  refresh re-proves the panel when it expands, and the flip is reported as a
  changed target.
- **Tests.** `html-mirror-protocol`: faded, `until-found`, `clip-path` and
  `clip` regions are withheld while a painted declared-hidden region keeps its
  text. `stateless-controlled-region`: collapsed, faded and clipped-away panels
  behind stateless buttons stay withheld and out of the graph, the carousel
  wrapper stays readable, and expanding the panel flips it to
  `controlled-region` as a reported change. Both fail on `3533354`.
- **Docs.** `docs/replica-fidelity.md` defines "paints" for both rules.
- **Left open.** P3 (multi-token or unreadable roles count as stateless), P4
  (`resolvedStyleSheetText` inside privacy regions, pre-existing), P5 (ancestor
  role change does not refresh the policy) and P6 (the accepted D50 trade-off)
  stay in the review.

Build identity `0.5.0 beta v.20260922.13`; `dist/chrome-unpacked` re-synced
(`page-mirror.js`, manifest). Gate: `npm run check` green, **1,427 tests pass,
1 skipped** (+2).

**D54 addendum (owner rulings, queued).** Asked whether to start the
simplification proposal, the owner chose to test the `.13` build first; no code
changed. Rulings recorded for the batch after the bug hunt:

- **Read scope.** "We may reduce the number of choices for what can be read.
  Default will be full visible, but let the user reduce it." The default
  becomes the Full visible profile (all six switches: control labels, control
  images, collapsed content, visible form values, personal-data fields and
  editable text; passwords, one-time codes and card data stay blocked by the
  privacy boundary) instead of Page-only until a mandatory setup answer. The
  user can narrow it in Settings; the number of profiles may shrink later.
  Implementation must also cover reset (which today returns to Page-only and
  reopens the setup dialog), the README privacy text, and the setup dialog
  (R10/R11 in the review become: no forced question).
- **Toolbar.** Keep most toolbar buttons ("The new bar is very useful"); the
  owner may remove some after going through them one by one. The duplicate-
  control removals R2–R6 wait for that review.
- **Tab follow.** Keep the toggle; the default becomes `active` (follow the
  active browser tab) instead of `locked`. The labels "Active"/"Current" both
  read as "follows me"; two new words are wanted. Candidates for the owner:
  "Follow"/"Pinned", "Any tab"/"This tab", "Switches"/"Stays". Following the
  active tab still needs access to each tab's site, as today.
- **Mirror size.** The default becomes 1:1 (`displayMode: 'actual'`) instead
  of Fit.

Stored preferences keep their saved values; the new defaults apply to fresh
installs and after a reset.

### D55. The mirror follows the source only when the source moves (2026-09-22)

Same branch / PR #22, first owner report from the `.13` bug hunt: "Our page in
the app is auto rescrolling every time something updates or changes."

- **Cause.** The source session re-posts its scroll position on every layout
  change (image load or error, font load, `html`/`body` resize, hash change) and
  after each checkpoint, even when the reader has not scrolled the page. The
  side panel handed every packet to `VisibleReplayHost.followSourceScroll`,
  which re-applied the source offsets and threw away the reader's own scrolling
  in the mirror. Reproduced in Chrome for Testing 153 with the unmodified
  `.13` build: scroll the mirror to 1600 px with the source at 0, then let the
  page load an image or grow; about a second later the mirror jumps back to 0.
  A stack trace on freee.co.jp showed the same path (`onSourceScroll` →
  `followSourceScroll`) 400 ms after the wheel gesture.
- **Not new in this PR.** The same test snaps back on 0.3.3 (`9c4c6c6`),
  0.4.0, `main` (`eb09813`) and `.9`; text-only page updates never triggered
  it. It likely became more visible with busier pages and more mirror reading.
- **Change.** `followSourceScroll` remembers the last position it followed and
  ignores a packet with the same scroller and offsets (maxima may differ). A
  real source move still wins, `resetSourceScroll` (new page, navigation)
  forgets the memory, and turning "Follow source scrolling" back on passes
  `force` to re-align. Rebuilt replicas keep the reader's position as before.
- **Verified in Chrome.** With the fix the mirror stays at 1600 px through image
  loads and page growth, and on freee.co.jp through 30 s of layout changes and
  six replica rebuilds (each new scroller restored to 1600).
- **Test.** `visible-replay-host`: a repeated position (with a new maximum and an
  extent refresh) keeps the reader scroll, a real move follows, `force`
  re-aligns, and a reset follows afresh. Fails on `b1dc116`.
- **Docs.** `docs/translation-companion.md` states the rule.

**Image text report investigated, no code change.** Second owner report: "In
the current version, images are no longer getting their text on top of them",
"most images", "a few images seem to be working". Findings:

- The D52 overlay checks (clipping ancestors, `checkVisibility` paint test) did
  not hide an overlay on any visible image: 0 false hides over six live sites
  (freee, Yahoo! JAPAN, ITmedia, GIGAZINE, note, Rakuten) measured against
  `IntersectionObserver`, and none inside the real replica of GIGAZINE.
- End to end (Tesseract, stand-in translator), `.10` and `.13` gave identical
  results on a 14-structure page (inline and block links, buttons, clipping
  boxes, fades, transforms, `contain: paint`, `content-visibility`, picture,
  lazy, alt text, a carousel), with and without an autoplaying carousel.
  Yahoo! JAPAN, GIGAZINE and Rakuten matched build for build; freee.co.jp,
  whose carousel keeps moving, varied run to run (images with text over four
  scroll positions: 7 and 12 on `.10`, 8 and 7 on `.13`), far from a "most
  images" gap. Replica rebuild frequency on freee is
  the same in `.10` and `.13` (about one every 5 s), and overlays survive them.
- The owner's Image diagnostics log shows captures deferred with
  `reason=hidden` and images skipped as `visibility=background`, with the final
  image cache empty: the pixels never came in, only alt-text captions did.
  Pixel OCR reads a screenshot of the source tab, so an image that is not fully
  on screen and unclipped there cannot be read, whatever the mirror shows. In
  Fit mode a side panel shows about three source screens at once, and the
  owner also scrolls the mirror, so most images seen in the mirror are off
  screen in the tab. This limit dates from the first OCR commit (`654d8e9`).
- Open: confirm with the owner whether the missing text returns when the source
  tab itself shows the image; if the owner wants mirror-only images read, that
  needs a different pixel source (a ruling, not a bug fix).

Build identity `0.5.0 beta v.20260922.14`; `dist/chrome-unpacked` re-synced.
Publishing 0.5.0 moves to **D56**.

**D55 addendum (owner reports at session close, 2026-09-23).** The owner
confirmed on `.14` that an image does get its text when the source tab itself
shows it, which settles the image-text report as the screenshot limit rather
than a regression, and asked for three follow-ups. They are carried in
`handover-2026-09-23-bug-hunt-continued.md`; no code changed.

- **Read the whole page at load.** "We should go ahead and do the entire web
  page at once when it loads. We can do processing in the background."
  Scheduling alone cannot do it: `captureVisibleTab` only contains what the tab
  shows, so off-screen images would defer forever. A pixel source has to be
  chosen first (fetching each image file in the extension and decoding it
  offscreen is the recommended one; reusing the replica's images taints the
  canvas).
- **The mirror jumps to the top when the carousel advances.** Measured on
  freee.co.jp in Chrome for Testing over 40 s: 2 replica rebuilds on 0.3.3,
  0.4.0 and `main`, 2–3 on `.2`/`.4`/`.6`/`.8`, and 9–10 from **`.9` (D50,
  `8243ab0`)** onwards, which matches the owner's "it didn't used to do that".
  The dev build reports `recovery/privacy_rejected` ten times in that window:
  `applyPatchBatch` refuses a carousel batch and `#applyLivePatch` asks for a
  full recovery, so the replica is rebuilt from a checkpoint. That rebuild is
  the redraw; D55 restoring the reader's position onto the new scroller is the
  "scrolls back" half. Each rebuild also empties the image final cache.
- **Carousel images and buttons show no text.** Two halves: carousel slides
  never reached OCR in any build tested (a moving slide fails the stability
  check, a clipped one fails `hasSafeCaptureGeometry`, leaving only the D48
  caption band), and the missing button text is replica text, most likely the
  Page-only read scope that withholds control labels (the queued D54-addendum
  ruling changes that default to Full visible).

### D56. A carousel move is a live patch, not a mirror rebuild (2026-09-23)

Same branch / PR #22, second owner report from the D55 addendum: "when the top
image carousel scrolls, we redraw the screen from the top and it kind of jumps
back to the top and then scrolls back to the same place ... it didn't used to
do that in old versions."

- **Cause.** Every Swiper move on freee.co.jp sends one batch holding a
  `children` replacement for the slide that comes into view (its content is
  withheld while it is off screen and re-sent when it is painted, D49/D54) and
  an `attributes` update for the `.swiper-wrapper` that contains it (the new
  `transform`). `hasStructuralPatchTargetConflict` refused any batch in which
  one target was an ancestor of another and either was structural, so
  `applyPatchBatch` returned nothing, `#applyLivePatch` reported
  `privacy_rejected` and the engine rebuilt the whole replica from a fresh
  checkpoint. Logged in Chrome for Testing with an instrumented dev build: all
  ten refusals in 40 s came from that one check, each on the slide + wrapper
  pair. Before D50 the slides and wrapper were opaque placeholders, whose
  mutations were ignored, so the pair never reached the engine; that is why the
  jump starts at `.9`.
- **Change.** A batch conflicts only when an operation targets something
  *inside* a subtree the same batch replaces or reconciles (the replacement
  removes or re-parents it). An attribute update on an ancestor of a replaced
  subtree is accepted. This is safe because the attribute-dependent parts of
  the content context (private region, private-attribute region, public menu)
  are exactly what `privacyContextChanges` compares, and `applyPatchBatch`
  already refuses an attribute update that changes them unless that element's
  own children are replaced too, which makes the element structural and keeps
  the conflict. The new children are therefore validated against the context
  they will live in. The apply and rollback phases treat each target on its
  own, so nothing there relied on the broader refusal.
- **Verified in Chrome.** On freee.co.jp with the fix: 0 replica rebuilds in
  40 s after the first checkpoint (10 before), the mirror's wrapper transform
  and active slide follow the source through the full cycle, and a reader
  scrolled to 1500 px stays at 1500 through five moves.
- **Tests.** `structural-patch-conflict`: an update inside a structural target
  is still refused in either order and for two structural targets; an
  attribute update on the ancestor of a structural target is not. Engine: the
  freee move batch (slide replacement + wrapper transform) is applied in place
  with no recovery and the same wrapper and slide nodes; a wrapper that turns
  `role=textbox` beside a slide replacement is still refused and recovered.
  The carousel engine test fails on `4925bd8`.

Build identity `0.5.0 beta v.20260922.15`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,431 tests pass, 1 skipped** (+3). Publishing
0.5.0 moves to **D57**.

### D57. A carousel track is painted when the slide it overflows into is (2026-09-23)

Same branch / PR #22, third owner report from the D55 addendum: "For the very
first image in the carousel, we do not have text on top of the image, and we
do not have any text shown on top of the buttons." The owner's read profile is
Full visible, so the read scope was not the cause.

- **Cause.** The first freee.co.jp slide is page text over a background
  picture: a label, a heading and three buttons (無料で始める, 資料をダウンロード,
  製品一覧はこちら). In the mirror every element was there but every text node was
  empty. The carousel's previous/next buttons reference the `.swiper-wrapper`
  with `aria-controls` and carry no state, so D49 made the wrapper a readable
  stateless controlled region; D54 (`.13`) then required the wrapper's *own*
  box to survive its overflow-clipping ancestors. Swiper moves the track with
  `translate3d(-1068px, …)`, so the wrapper's own 1068 px box sits entirely
  beside the carousel window (measured: x −962 to 106, window 106 to 1174)
  while the slides it overflows into are on screen. The paint proof failed on
  every settled position, the wrapper stayed `withheld`, and the sanitizer
  emptied all slide text, button labels included (text in a withheld region is
  kept as empty strings; images and elements stay). Logged with an
  instrumented dev build: the only withholding reason on the heading was
  `controlled-withheld: div.swiper-wrapper`.
- **Change.** `sourceElementBoxIsPainted` also accepts a region that does not
  clip its own overflow when one of its element children is painted and
  survives the same clipping path (the region itself, then its ancestors). The
  P2 cases stay withheld: a panel collapsed with `overflow: hidden` clips its
  children too, a faded panel fails its own paint state first, and a panel
  clipped away by an ancestor has its children clipped with it. Children are
  bounded by the existing paint-rect cap.
- **Verified in Chrome.** On freee.co.jp the first slide's label, heading, both
  small captions and all three button labels are in the mirror and translate;
  the second text slide (`kvslide3`) has its text back too; 0 replica rebuilds
  over 30 s. The image-only slide (an `<img>` in a `<button>`) is read by OCR
  when it is on screen in the tab (Tesseract finds it, later passes hit the
  cache), and evidence selection shows its alt text as a caption band because
  the alt text already carries the same words; that is the existing D48
  behaviour, not this bug.
- **Tests.** `stateless-controlled-region`: a track whose own box is translated
  left of the carousel window, with a slide inside it, is a controlled region
  and its slide text is serialized; the same track that clips its own overflow,
  or whose slides are all outside the window, stays withheld. The P2 test
  (collapsed, faded, clipped-away panels) passes unchanged. The new test fails
  on `b839470`.
- **Docs.** `docs/replica-fidelity.md` states the child rule.

Build identity `0.5.0 beta v.20260922.16`; `dist/chrome-unpacked` re-synced
(`page-mirror.js`, manifest). Gate: `npm run check` green, **1,432 tests pass,
1 skipped** (+1). Publishing 0.5.0 moves to **D58**.

### D58. Images off screen are read from their own file (2026-09-23)

Same branch / PR #22, first owner report from the D55 addendum: "we should go
ahead and do the entire web page at once when it loads. We can do processing
in the background." Pixel OCR could only read a `captureVisibleTab` screenshot,
so an image not fully on screen in the source tab deferred with
`reason=hidden` forever.

- **Owner rulings.** Asked how to get pixels for images the tab is not
  showing, the owner asked whether Simul could use the image data already
  loaded instead of downloading it again, then chose **"tab first, then
  download"** after seeing that most sites serve images from a separate host
  the page cannot read (measured: readable in the tab without a new request,
  freee 35/35, Yahoo! JAPAN 0/356, ITmedia 0/12, GIGAZINE 0/45, note 0/116,
  Rakuten 0/184).
- **Finding that shaped the order.** In Chrome for Testing the side panel can
  read the *mirror's* already-loaded copies (the replica iframe is
  same-origin with the extension, and the host grant keeps the canvas clean:
  20/20 cross-origin Yahoo images readable), and a `force-cache` fetch of the
  same URLs was served from Chrome's disk cache in 1–2 ms. So the order is the
  mirror copy (no request), then the tab (same-site images, and Conservative
  fidelity), then a cache-first download, which honours the ruling and avoids
  new downloads almost everywhere.
- **Change.**
  - `PixelAcquisitionCoordinator` keeps the screenshot for on-screen images
    and falls back to `readFilePixels` when the screenshot defers with
    `hidden`, `unstable`, `too-small-visible` or `inactive` (a moving carousel
    slide and a background source tab are covered too). Quota, permission and
    API failures keep today's retry.
  - New tab request `simul:image-source-v2:pixels` (strict exact-document
    protocol). The tab re-checks the same read policy as `measure` (sticky
    secret ancestors, control images, withheld controlled content) and the
    image's own paint path (display, visibility, opacity, clip, mask, axis
    aligned), but not on-screen, clipping, overlap or text-cover checks: file
    pixels contain only the image. It answers with the box layout (size,
    border+padding, `object-fit`, `object-position`), the CSS natural size once
    loaded, the HTTP(S) URL, and with `includePixels` the painted region as a
    PNG when the page may read it (a tainted canvas returns nothing).
  - `readImageFilePixels` (side panel): mirror copy when it is loaded,
    readable, and offers the tab's URL among its `src`/`srcset`/`<picture>`
    candidates (a stale or different mirror picture is never read); else the
    tab's pixels; else, only under Passive fidelity with a host grant for the
    URL's origin, a credential-free `force-cache` fetch (image types only, no
    SVG, 16 MB and 15 s caps). Placement is computed per copy from the layout
    (`computeImageFilePlacement`: fill, contain, cover, none, scale-down, with
    percentage, pixel and `calc()` positions); `none`/`scale-down` need the
    tab's CSS natural size.
  - A lazy image the page has not fetched reports 0×0; the small-image rule
    treated that as a tiny icon. 0×0 is now "not loaded yet" and the rendered
    box decides (a real icon still skips once it loads).
  - Diagnostics: `job N pixels: source=screenshot|mirror|tab|download`.
- **Verified in Chrome.** Yahoo! JAPAN with the source tab left at the top:
  every image processed within ~20 s, 90 file reads all from the mirror copy,
  10 screenshots, no deferrals, no downloads (most are photos without text).
  A local page with five text images below the fold (plain, `loading=lazy`,
  `object-fit: cover`, `contain`, border+padding): all five got OCR text from
  the mirror copy, placed exactly on the picture text in the mirror. freee:
  42 mirror reads; OCR found text in 38 of 52 reads but alt text still wins
  the ranking (the next owner question). Rakuten: no rebuilds; its rotating
  top banner replaces overlays as it rotates, the same on `.16`.
- **Not verified here.** The harness build carries `<all_urls>` in its
  manifest; the owner's build holds it as a runtime grant. If Chrome treated
  the mirror canvas differently under a runtime grant, the reader falls back
  to the tab or the download (or defers); the Image diagnostics log shows the
  source used.
- **Tests.** `image-file-pixels` (placement math for every fit, insets,
  positions, fail-closed cases; rendering at copy resolution; reader order:
  mirror first with the tab only confirming, tab pixels when the mirror shows
  another picture, download only when allowed, lazy image via download,
  `none` without CSS size skipped, a refused image reads nothing, srcset and
  `<picture>` matching; the fake lease is a class so an unbound method call
  fails); `image-source-protocol` (strict request and reply, rejected URLs
  with credentials or non-HTTP schemes, oversized pixels, layout and identity
  mismatches, pixels without a natural size); `image-source-session` (an
  off-screen image answers although `measure` says hidden, tab pixels, tainted
  pixels omitted, style-hidden blocked, stale revision, lazy image keeps URL
  and layout only); `pixel-acquisition` (off-screen, moving and
  background-tab fallback; quota keeps the screenshot deferral);
  `small-image-policy` (0×0 unknown, 16×16 still small); diagnostic line.
- **Docs.** README "Image text" and `docs/image-translation-research.md`.

Build identity `0.5.0 beta v.20260922.17`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,447 tests pass, 1 skipped** (+15).
Publishing 0.5.0 moves to **D59**. Next: the owner's alt-text-versus-OCR ruling
(use Gemini Nano only when already available, never download it).

### D59. An installed on-device model breaks close alt-text-versus-OCR calls (2026-09-23)

Same branch / PR #22, from the owner's third report (the carousel's image
slide showed its alt caption, not text on the picture). Asked whether alt text
or OCR should win, the owner said: "OCR is probably more reliable, but it
really is hard to tell which one works better. Are there any other built-in
Chrome tools we can use that can do a very quick AI check on device?", and on
the options: "If we can detect when Nano is available and only use it without
doing the download, then we could use it. We never want to download and
install Gemini Nano."

- **Context.** The deterministic ranker (`selectImageTextEvidence`) already
  demotes placeholder-like alt text (repeated across images, very short) so OCR
  wins then; that logic is intact. What remained were close calls
  (`priority-tie`), which fall to the saved method order, alt text first by
  default. On freee.co.jp OCR read text in 38 of 52 reads and 29 of the
  comparisons were such ties.
- **Change.** `OnDeviceEvidenceJudge` (side panel, created lazily on the first
  tie) resolves once: Gemini Nano through the Prompt API only when
  `LanguageModel.availability()` is exactly `available` (first with image
  input, then text-only), else Chrome's Language Detector only when it is
  `available`, else none (re-checked every ten minutes). `create()` is never
  called for `downloadable` or `downloading`, so no model download is ever
  started. Nano gets the OCR crop (when it accepts images) and both texts,
  with a JSON `responseConstraint` (`A`, `B` or `either`) and a system prompt
  telling it not to follow instructions inside the candidates; a fresh clone
  per call, 10 s cap. The Language Detector picks OCR text that reads as the
  page's language with confidence ≥ 0.7, and alt text when OCR is noise
  (< 0.3) or another language. The controller consults the judge only for
  `priority-tie`, in all three comparison paths, caches verdicts by pixel key,
  language and both texts (256), and keeps the ranker's choice on `either`,
  failure or no model. Diagnostics: `evidence judge: nano-image|nano-text|
  language-detector|none` once, and reasons `nano-judge` / `language-check`.
- **Verified in Chrome for Testing** (no real Nano there, so a stand-in
  `LanguageModel` was injected): reported `available`, the judge resolved to
  `nano-image`, created one session, and its two answers put OCR text on the
  freee pictures (`ocr/nano-judge`); reported `downloadable`, availability was
  checked twice, `create()` and `prompt()` were never called, the log said
  `evidence judge: none`, and the 23 ties kept the saved order.
- **Tests.** `on-device-evidence-judge` (never creates a `downloadable`,
  `downloading` or `unavailable` model; image and text-only Nano prompts and
  structured choices; Language Detector rules; recheck interval; cancellation
  and empty candidates); controller (a close call goes to the judge once with
  the crop, both texts and language, and the verdict is applied and logged);
  diagnostic line.
- **Docs.** README step 5, `docs/image-translation-research.md`, and
  `docs/image-evidence-ranker-training.md` (the Prompt API row and a "Close
  calls" paragraph).

Build identity `0.5.0 beta v.20260922.18`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,454 tests pass, 1 skipped** (+7).
Publishing 0.5.0 moves to **D60**.

### D60. The mirror keeps a large stylesheet and the browser's own html and body (2026-09-23)

Same branch / PR #22. Owner report on Google's OAuth sign-in:
"accounts.google.com/signin/OAuth It's in a box in the center of the screen.
Our layout is not bounding things properly and not following the original
screen properly."

- **Reproduced in Chrome for Testing** on a real OAuth sign-in
  (`/o/oauth2/v2/auth` for the OAuth Playground client, which lands on
  `/v3/signin/identifier`) and on the bare `/signin/OAuth` URL, which is
  Google's 404 page. On the sign-in page the replica was fully unstyled: the
  page's only stylesheet is one inline `<style>` of 680 KB (706 KB as CSSOM),
  above the 512 KiB per-string cap, so the sanitizer dropped both its raw text
  and its resolved sheet. On the 404 page the text was left-aligned and
  full-width, without the robot, and in 11.25 px instead of 15 px.
- **Three causes.**
  1. *Stylesheet size.* Every CSS text shared the general 512 KiB string cap.
  2. *Shell rules.* The replica shell's own `html,body{margin:0;min-width:100%;
     min-height:100%}` (from the first isolated-mirror commit, no recorded
     reason) overrode the page: `min-width:100%` beats a body's `max-width`, so
     a body centred with auto margins filled the frame, and `margin:0` removed
     the 8px body margin of pages that never reset it.
  3. *Chrome's extension font.* Chrome inserts `body{font-family:<system
     font>;font-size:75%}` into every extension-origin document, which the
     same-origin srcdoc replica is. CDP lists it as an `injected` author sheet
     ahead of the page's sheets. Any page that sets its font on `html` (or
     relies on the default) showed body text at 75% in the system font; freee
     showed tofu boxes for Japanese in the harness for the same reason.
- **Change.** `MAX_HTML_MIRROR_STYLE_SHEET_STRING` (1 MiB) now bounds one
  stylesheet's text (inline text, resolved CSSOM, adopted sheets, and
  `sanitizeCss`, on both sides); other strings keep 512 KiB. A `<style>` whose
  rules are read from CSSOM no longer sends its raw text too (the receiver
  replaced it with the resolved sheet anyway), so a large inline sheet costs
  the page budget once; this also skips one sanitize pass (about 50 ms for
  700 KB). The shell keeps only `html,body{pointer-events:none}` and adds
  `body{font-family:inherit;font-size:inherit}`, which sits after Chrome's
  injected sheet at equal specificity, so any page rule for `body` still wins.
  The one difference left: a page's zero-specificity rule (`*`, `:where(body)`)
  with a relative font size no longer compounds on body.
- **Verified in Chrome for Testing.** Sign-in page: the replica shows the
  bordered card centred at the source's size and position, with the header,
  field, links and buttons laid out as in the source. 404 page: centred column,
  robot on the right, 15 px text. freee.co.jp: body text now in the page's own
  Japanese font; no other layout change.
- **Found, not changed.** (a) Quirks-mode pages render in standards mode: the
  doctype-free shell is loaded through `srcdoc`, and an `srcdoc` document is
  never in quirks mode, so `docs/replica-fidelity.md`'s "selects a doctype or
  doctype-free srcdoc shell" does not achieve quirks (the 404 page is a quirks
  page and happens to look right). (b) A `<style>` inside a privacy boundary
  (for example `role=textbox`) sends its resolved sheet even though its raw
  text is withheld, so the documented "a privacy boundary withholds both" holds
  only for the raw text; CSS, not user data. (c) Google's language picker shows
  as "Options" in the replica (the privacy rules for an editable combobox).
- **Tests.** Protocol: an inline sheet above 512 KiB is kept, travels once in
  Passive and as raw text in Conservative, and both checkpoints pass receiver
  validation; a sheet above 1 MiB is still omitted. Engine: the shell leaves
  html and body margins and sizes alone and resets body font. The hidden-region
  stylesheet test now reads the CSS the receiver applies (resolved or raw).
- **Docs.** `docs/replica-fidelity.md` (stylesheet size, single transport,
  shell defaults and the font reset).

Build identity `0.5.0 beta v.20260922.19`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,457 tests pass, 1 skipped** (+3).
Publishing 0.5.0 moves to **D61**.

**Queued by the owner during this session:**
1. "Often when opening a new tab we receive: Open a regular HTTP or HTTPS page,
   then select the extension from that page." (D61)
2. "Dropdowns do not show options when we cl[ick] the drop down menu."

### D61. Active following waits for a new tab's web page and then follows it (2026-09-23)

Same branch / PR #22, the owner's first queued report (above).

- **Reproduced in Chrome for Testing** (popout, tab following Active, all-site
  access granted): opening a new tab put the companion in its error state with
  "Open a regular HTTP or HTTPS page, then select the extension from that page.
  Active-tab following needs page access for each newly selected site.", and
  when that tab then loaded a site the companion stayed on the error until the
  user switched tabs. The follower read the new tab (Chrome hides a
  `chrome://newtab` URL), `identityFromTab` threw the access guidance, and the
  invalidation cleared the followed page, so `handleTabUpdated` ignored every
  later update of the new tab.
- **Change.** In `followActivatedSourceTab`, a tab without a readable web URL
  shows "Waiting for a web page in the active tab." when its URL is a visible
  non-web URL or Simul holds all-site access (`permissions.contains
  <all_urls>`; Chrome then hides only browser-page URLs). Without all-site
  access a hidden URL may be a site Simul cannot read, so the access guidance
  stays. `handleTabUpdated`, while nothing is followed and no follow is
  resolving, follows the active tab of a focused window once it completes
  loading a web page (Active mode in the popout only). This also recovers after
  the followed tab visits a restricted page and comes back. Locked mode and the
  side panel are unchanged.
- **Verified in Chrome for Testing**: new tab -> "Waiting for a web page in the
  active tab."; the tab loads Wikipedia -> the mirror shows Wikipedia with no
  tab switch.
- **Harness note.** The harness copy lists `<all_urls>` as a required host
  permission, so every preference reconcile answers "You cannot remove required
  permissions." and the status line shows "The preference service returned an
  invalid response." That is an artifact of the test manifest, not a product
  bug (the shipped manifest has it as optional).
- **Tests.** Follower: a new tab waits, then its loaded page is followed; a
  hidden URL without all-site access still asks for access; no follow in
  Locked mode, for a background tab, or while a follow resolves.
- **Docs.** `docs/translation-companion.md` (Detached window).

Build identity `0.5.0 beta v.20260922.20`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,460 tests pass, 1 skipped** (+3).
Publishing 0.5.0 moves to **D62**.

### D62. Dropdowns and menus open in the mirror on real pages (2026-09-23)

Same branch / PR #22, the owner's second queued report: "Dropdowns do not show
options when we cl[ick] the drop down menu." Asked which dropdowns, the owner
chose "Site menus in the mirror" and "Form select boxes in mirror".

- **What worked before.** A local page with a plain select and an
  `aria-controls` menu opened fine in the mirror. Real pages did not, for five
  reasons found in Chrome for Testing (Wikipedia's search language select,
  freee's header menus, Google sign-in's language picker, Yahoo! JAPAN).
- **1. Every semantic batch was refused on pages with links (since
  `a3fb374`, 2026-07-23, in v0.4.0).** With `controlSemantics` on (Full
  visible, the owner's profile) the page side sent a disabled-state proof for
  every control tag including plain `<a>` and `<summary>`; the receiver accepts
  that proof only on form controls and control roles, and one refused proof
  refuses the whole batch. So on any page with an ordinary link no option
  label, select state, menu, tab or ARIA state ever reached the replica. The
  page side now sends the proof only where the receiver accepts it.
- **2. Batch caps.** 128 records and 128 proofs, filled in document order by
  per-control disabled proofs (measured: Wikipedia 206 records and 492 proofs
  in 122 KB, freee 233 proofs, Yahoo! JAPAN 278). Caps are now 1,024 records
  and 2,048 proofs (the 256 KB byte cap still bounds a batch), and the bulk
  disabled-state proofs are assembled last, after the tab, disclosure and menu
  proofs and the records, so they can never starve what opens a dropdown.
- **3. Forms were `inert`.** The sanitizer marked every form `inert`, which
  also blocked clicks on Simul's own select facsimiles and menu triggers inside
  it. Submission stays impossible (sandbox without `allow-forms`, CSP
  `form-action 'none'`, the document-wide activation guard), so forms are no
  longer marked.
- **4. Transparent selects.** Wikipedia draws "EN ⌄" and lays an `opacity:0`
  select over it; the mirror treated it as hidden (no box, no option labels).
  A zero-opacity select that still takes pointer input over a rendered box is
  now a transparent click target (`isSourceTransparentSelectClickTarget`): it
  keeps its box and labels, its facsimile trigger is transparent, and the
  options panel opens opaque.
- **5. freee's menus.** The button carries `aria-expanded` and
  `aria-haspopup="menu"` but no `aria-controls`; its menu is the sibling
  `div.productMenu`. The ARIA path needs `aria-controls` and the structural
  (non-ARIA navigation) menu path refused any trigger with `aria-expanded`, so
  neither applied. A structural menu trigger may now carry a plain true/false
  `aria-expanded` (still no `aria-controls`). Two follow-on fixes: the receiver
  refused the structural menu on the second batch because the presenter had
  written `aria-controls`/`aria-expanded` onto the replica trigger (it now
  accepts its own presentation for the same relation, marked by
  `data-simul-source-disclosure-state`), and an opened preview is forced to
  `opacity:1` (freee collapses the menu with opacity as well as display).
- **Side effects of batches now applying, contained.** The control "label"
  presentation drew an accessible name (`aria-label`, `title`) as a visible
  span beside or inside the control, and the "selection" presentation drew the
  selected label under the select facsimile. Never visible on real pages
  before (the batches were refused), they squeezed Yahoo! JAPAN's search box
  and wrote "自動スライドを一時停止" over freee's carousel dots. Those spans
  are now always hidden; they still carry the text for translation and the
  dropdown trigger. An opened public (ARIA) menu overlay gets a plain
  `Canvas` background, since menu content has its backgrounds stripped.
- **Privacy note.** Two changes widen what reaches the replica, both within
  the owner's request: option labels of a transparent click-target select, and
  the hidden panel text of a navigation menu whose trigger has a plain
  `aria-expanded`. Both are public page content the source shows on click. The
  batch fix itself only lets through what the Full visible scope already
  admits.
- **Verified in Chrome for Testing.** Wikipedia: the language select opens
  with all 77 languages, trigger "English". freee: all three header menus open
  with their content and the header chevrons match the page. Google sign-in:
  the language picker reads "English (United States)" (was "Options") and
  opens its list. Yahoo! JAPAN: search box unchanged from before. Local page:
  selects plain, in a form, transparent, and transparent in a form all open
  with labels.
- **Tests.** Session: a plain link gets no disabled proof and menu proofs come
  first; a trigger with plain `aria-expanded` is a structural menu, a
  malformed one is not; a session batch from a page with a link, a select and
  a menu is accepted by the receiver and writes the option labels (fails with
  the old rule). Receiver: a presented structural menu survives the next
  batch, another relation's claim is still refused; label spans are hidden.
  Policy: a transparent clickable select keeps its option labels, a
  transparent select without pointer input does not. Sanitizer: a form is not
  inert. Engine: a transparent select keeps its box with a transparent
  trigger; the menu overlay has a canvas background. Disclosure: an opened
  panel is opaque. Protocol: the proof-cap test uses the constant.
- **Docs.** `docs/replica-fidelity.md` (forms, transparent selects, structural
  menus, hidden accessible names).

Build identity `0.5.0 beta v.20260922.21`; `dist/chrome-unpacked` re-synced.
Gate: `npm run check` green, **1,468 tests pass, 1 skipped** (+8).
Publishing 0.5.0 moves to **D63**.
