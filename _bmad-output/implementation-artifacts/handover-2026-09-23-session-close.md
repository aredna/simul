# Handover: session close after D60–D62, PR #22 (2026-09-23)

Chains from `handover-2026-09-23-bug-hunt-continued.md` (its "Third session"
section has the D60–D62 detail and harness notes), which chains from the
2026-09-22 handovers. Decision-log entries **D60**–**D62** and the **D62
addendum** hold the reasoning. The owner closed this session with: *"Go ahead
and put everything into a handover file, and then don't do any code here. We
will do all of the work in the next handover session."* Nothing below has
been started.

## Where things stand

| Item | State |
| --- | --- |
| Branch / PR | `feat/ui-string-catalogue`, PR #22, **open**. Last code commit `b3157d9` (D62); docs commits after it. Description covers D40–D62. |
| Version / identity | `0.5.0` / `0.5.0 beta v.20260922.21` (next is `.22`). |
| Gate | `npm run check` green at `b3157d9`: **1,468 tests pass, 1 skipped**; `dist/chrome-unpacked` byte-verified. |
| NAS | `Dev/simul/` mirrors head; the owner loads `Dev/simul/dist/chrome-unpacked` (`Build 0.5.0 beta v.20260922.21`). |
| `main` / release | `eb09813` (through D39); only `v0.4.0` released. Publishing 0.5.0 is **D63**, only when the owner says so; do not ask. |

## Owner ruling this session: truthful recreation first

> "We want to recreate the page as truthfully as we can. This is all ran
> locally, so privacy is only a very minimal concern."

> On the stylesheet limit: "I'm not sure of any reason to have a limit, but
> maybe ten megabytes could be our limit. I mean, we're running it locally, so
> if we can load the web page, we can load it in the mirror, and it's just two
> copies of the page being loaded."

How to apply it: when fidelity and a privacy-motivated withholding conflict,
prefer showing what the page shows. Size limits exist to keep the tab and panel
responsive, not to protect data, so they should be set by what the browser can
comfortably load. Some rulings from earlier sessions assumed privacy was the
main constraint (for example "changes that loosen a privacy default need an
explicit owner ruling"). This ruling now takes precedence. Still keep anything
that stops the mirror from acting on the page: no scripts, no navigation, no
form submission, no source mutation.

## What shipped this session (all verified in Chrome for Testing)

- **D60 (`.19`)**: Google OAuth sign-in rendered unstyled. Its one 680 KB
  inline stylesheet exceeded the 512 KiB string cap; one stylesheet may now be
  1 MiB, and a CSSOM-resolved `<style>` no longer also sends its raw text. The
  shell stopped forcing `html,body{margin:0;min-width:100%;min-height:100%}`,
  and it resets Chrome's injected extension-origin `body{font-size:75%}` to
  inheritance.
- **D61 (`.20`)**: with Active tab following, a new tab showed "Open a regular
  HTTP or HTTPS page…" and stayed stuck after the tab loaded a site. It now
  shows "Waiting for a web page in the active tab." and follows the tab once it
  loads a web page.
- **D62 (`.21`)**: dropdowns and menus in the mirror. Since v0.4.0, under Full
  visible, every semantic batch was refused on any page with a plain link (a
  disabled-state proof for `<a>` the receiver rejects, and batches are
  all-or-nothing), so no option label, menu or tab state ever reached the
  replica on real pages. Also fixed: 128/128 batch caps (now 1,024 records,
  2,048 proofs, bulk proofs last), `inert` forms, transparent click-target
  selects (Wikipedia), freee's `aria-expanded` menu triggers (structural
  menus), invisible opened menus (opacity), and visible accessible-name spans
  (now hidden).

## Work for the next session, in order

### 1. Raise the stylesheet limit to about 10 MB (owner request)

Today `MAX_HTML_MIRROR_STYLE_SHEET_STRING` is 1 MiB
(`lib/replica/html-mirror-sanitizer.ts`). Raising only that constant is not
enough, because the limits around it would then fail the whole page:

| Limit | Where | Today | Why it matters for a 10 MB sheet |
| --- | --- | --- | --- |
| `MAX_HTML_MIRROR_STYLE_SHEET_STRING` | `html-mirror-sanitizer.ts` | 1 MiB | The per-sheet cap itself (inline text, resolved CSSOM, adopted sheets, `sanitizeCss`, both sides). |
| `MAX_HTML_MIRROR_BYTES` | `html-mirror-sanitizer.ts` | 8 MiB, counted as 2 bytes per character | Total page budget. Overflow throws `HtmlMirrorCapacityError`, and the source posts `stream_overflow`, so the **whole mirror fails**, not just the sheet. A 10 MB sheet costs 20 MB of this budget. It must rise well above the sheet cap (for example 64 MiB), or a sheet over budget must be omitted instead of failing the checkpoint. |
| Style work `maxCharacters` | `createHtmlMirrorStyleWorkBudget` | `MAX_HTML_MIRROR_BYTES / 2` | Total CSSOM text per checkpoint; follows the total budget. |
| `MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER` | `html-mirror-sanitizer.ts` | = sheet cap | Adopted sheets per document or shadow root. |
| `MAX_STYLE_CHARACTERS_PER_TICK` / `_RULES_PER_TICK` | `html-mirror-source.ts` | 1 MiB / 25,000 | Style-change polling per tick. Larger pages hit `capacity` and fall back to the retry path, so change detection gets slower. |
| `MAX_ADOPTED_STYLE_RULES_PER_OWNER` | `html-mirror-sanitizer.ts` | 20,000 rules | A 10 MB sheet can have more rules than this (Google's 680 KB has 2,924). |
| `MAX_RETAINED_REPLICA_BYTES` | `isolated-html-engine.ts` | 4 × total | Follows the total. |
| `MAX_HTML_MIRROR_STRING` | `html-mirror-sanitizer.ts` | 512 KiB | Every other string: text nodes, attributes (large `data:` URIs, long inline `style`). Same reasoning under the ruling. |
| `MAX_STATIC_SVG_DATA_IMAGE_LENGTH` | `static-svg-data-image.ts` | 512 KiB | Inline SVG as a data image. |
| `MAX_SEMANTIC_SOURCE_BATCH_BYTES` / `_TEXT` | `semantic-source-protocol.ts` | 256 KB / 3,500 chars | Semantic batch size and per-record text. Measured pages fit (Wikipedia 122 KB), but a large page may not. |

Costs to measure, not guess:
- **CPU:** `sanitizeCss` took about 50 ms per 700 KB pass in Node. The source
  pays it on the page's main thread per checkpoint (resolved rules plus a
  final pass), and the receiver pays it again. For 10 MB that is roughly 0.7 s
  of blocking per pass. Consider chunking the rule loop across frames if it
  shows.
- **Transport:** the checkpoint crosses the runtime port as one message, so
  check that a 20–40 MB message is acceptable in Chrome.
- **Memory:** the panel keeps the previous replica while staging the next one.

Suggested rule for the owner's review, simplest first: per-sheet 10 MB, total
budget sized to the largest page Chrome shows comfortably (start at 64 MiB and
measure), and when the total is exceeded, omit the largest stylesheets instead
of failing the whole mirror. Verify on Google sign-in (680 KB inline sheet) and
on a synthetic 5 MB and 12 MB sheet page.

### 2. Quirks-mode pages render in standards mode (found in D60)

The source's quirks state is transported and selects a doctype-free shell.
But the shell is loaded via `iframe.srcdoc`, and an `srcdoc` document is
always no-quirks, so `document.compatMode` in the replica is `CSS1Compat` for
a `BackCompat` source. Observed on Google's 404 page
(`https://accounts.google.com/signin/OAuth`); it happens to look right there
after D60. Fix direction: when `documentMode === 'quirks'`, create the iframe
blank and write the doctype-free shell with `document.open()` /
`document.write()` from the extension side. The frame is same-origin; check
the result is `BackCompat`. The shell marker, CSP meta and trust check
(`isTrustedIsolatedShellDocument`, `initializeIframeDocument`) must still pass,
and the sandbox (`allow-same-origin` only) must stay. Now documented as an open
gap in `docs/replica-fidelity.md`; update it when fixed.

### 3. Review privacy-driven withholding under the new ruling

The ruling favours truthful recreation, and some behaviour withholds what the
page visibly shows. Candidates to bring to the owner, **not to change without
a ruling on each**:
- **Default read scope.** Already queued (D54 addendum): default to Full
  visible with no forced setup question. The ruling supports doing it.
- **Conservative fidelity policy.** It exists to reduce replica requests and
  withholds CSS in more places (for example a `<style>` inside a privacy
  boundary keeps its CSS only under Passive; documented). Consider removing
  Conservative, in line with the owner's wish to simplify the tool.
- **Masked form values and editable text.** Shown only when the read scope
  admits them; under Full visible ordinary values show. Passwords and one-time
  codes stay masked, which is truthful too: the page shows dots.
- **Hidden-region text.** It is withheld until painted, which matches what the
  page shows. Keep it.

### 4. Skip translating hidden accessible names (efficiency)

Since D62, label records for `aria-label` / `title` accessible names reach the
replica on real pages, but they are drawn nowhere except option labels and the
select's current choice. They are still translated (about 200 labels on
Wikipedia), which is wasted work. Fix direction: keep the records (they carry
the dropdown and option text), but skip translation for `label` records bound
to a hidden owned span. Documented in `docs/replica-fidelity.md`.

### 5. Watch the owner's next reports

Semantic presentation (tab and ARIA states, menu previews, label records) now
runs on real pages for the first time under Full visible. D62 contained the
visible side effects it found (label spans on Yahoo! JAPAN and freee), and
Wikipedia, freee, Google sign-in and Yahoo! JAPAN look right. New visual
differences the owner reports may come from this. The receiver still refuses a
whole batch when any one record or proof fails. Under the new ruling, consider
dropping only the failing item and logging it, rather than the batch. The
session-to-receiver test in `tests/semantic-source-session.test.ts` is the
guard to extend.

### 6. Carried over, unchanged

1. Rest of the bug-hunt review (`review-2026-09-22-pr22-bug-hunt.md`):
   L2–L9, T1–T3, O3, P3–P6, and the process items.
2. D54-addendum rulings: default read scope Full visible (see 3), tab follow
   defaults to `active` with two clearer words, mirror size defaults to 1:1,
   toolbar buttons stay until the owner reviews them one by one.
3. Publish 0.5.0 as **D63** when the owner says so. The release-notes draft
   (`handover-2026-09-22-release-readiness.md`) needs lines for D51–D62.
4. F6 stays declined; `deferred-work.md` holds the research-sized entries.

## Reproduction and verification

- Harness: `~/.cache/simul-harness/` (memory note `simul-chrome-repro-harness`),
  runnable from the 2026-09-22 scratchpad `harness/` (node_modules, Chrome for
  Testing 153). Serve `site/` with `python3 -m http.server 8765`.
- Scripts from this session: `google-shots.mjs` (source and panel screenshots),
  `google-styles.mjs` (stylesheets, compat mode, body font), `matched-body.mjs`
  (CDP matched rules in the replica), `dump-source-css.mjs`,
  `newtab-follow.mjs`, `dropdown-click.mjs`, `select-labels.mjs`,
  `select-click-debug.mjs`, `find-text.mjs`, `measure-semantic.mjs`,
  `select-style.mjs`, `select-host.mjs`, `pref-probe.mjs`.
- Test pages: `site/dropdown.html`, `selects.html`, `selects2.html`,
  `bigselect.html`. Always include a plain `<a href>` in semantic fixtures: a
  page without links hid the D62 refusal bug.
- Real pages used: Google OAuth sign-in
  (`https://accounts.google.com/o/oauth2/v2/auth?client_id=407408718192.apps.googleusercontent.com&redirect_uri=https://developers.google.com/oauthplayground&response_type=code&scope=email`),
  Google's 404 (`/signin/OAuth`), Wikipedia portal, freee.co.jp, Yahoo! JAPAN.
- Known harness artifact: the harness manifest makes `<all_urls>` a required
  permission, so the status line shows "The preference service returned an
  invalid response." That is not a product bug.

## Working notes

- Toolchain: `export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`.
- Per shipped change: bump `betaBuildSuffix` (`.22` next) in `wxt.config.ts`,
  README (two places) and the two identity tests; `npm run artifact:sync &&
  npm run check` in the background (read the `exit=` and `Tests` lines);
  decision log; commit; push; mirror to the NAS (dry run first, read the
  deletion list; `*.user.toml` excluded).
- PR #22 description: `gh pr view 22 --json body -q .body`, edit, then
  `gh pr edit 22 --body-file`.
- Owner preferences: no publish prompts; simplest rule and fewer controls;
  questions go through the question tool with a Notes option; multi-step shell
  work goes in a script file.
