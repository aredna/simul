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

### D7. Local toolchain notes

- Nothing in the dependency set had a release inside the 7-day window
  (cutoff 2026-08-27), so the rule excluded nothing; every resolved version
  is the newest available.
- The stale `.wxt/tsconfig.json` may list a temporary artifact build
  directory under `exclude`; it is regenerated by `wxt prepare` and ignored.

