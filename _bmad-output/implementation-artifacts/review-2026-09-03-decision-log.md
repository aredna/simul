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

### D7. Local toolchain notes

- Nothing in the dependency set had a release inside the 7-day window
  (cutoff 2026-08-27), so the rule excluded nothing; every resolved version
  is the newest available.
- The stale `.wxt/tsconfig.json` may list a temporary artifact build
  directory under `exclude`; it is regenerated by `wxt prepare` and ignored.

