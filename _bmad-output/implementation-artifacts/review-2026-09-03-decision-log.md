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
