---
title: 'Admit accessible navigation images to OCR'
type: 'bugfix'
created: '2026-07-23'
status: 'draft'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-fix-public-navigation-image-ocr.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The NTA mega-menu script adds `role="button"`, `aria-controls`, and `aria-expanded` to six ordinary HTTP navigation links. Simul mistakes this public disclosure metadata for sensitive activation state and silently excludes their images before OCR; the 136×70 `gnav-news2.gif` therefore never reaches a provider regardless of the small-image setting.

**Approach:** Admit validated HTTP(S) navigation disclosures without weakening privacy/currentness. Add budgeted 2× compact-raster block processing so admitted labels clear the existing threshold, then rebuild the local trial with a new beta identity.

## Boundaries & Constraints

**Always:** Keep source DOM untouched and replicas inert. Use generic rules shared by both source paths. Require HTTP(S), sole `button` role, safe ancestry/geometry, and current document/revision. Disclosure attributes may be absent; if present, accept one trimmed non-whitespace `aria-controls` token ≤256 characters (syntax-only), `aria-expanded=true|false`, and `aria-haspopup=false|true|menu|listbox|tree|grid|dialog`, case-insensitively, in any combination. Only the nearest composed activation ancestor may consume the exception; another activation ancestor blocks. Preserve settings, routing, thresholds, permissions, CSP, local assets, and production defaults. Work on `feat/ocr-reliability-trials`; refresh `dist/chrome-unpacked` as `0.3.2 beta v.20260723.2`.

**Ask First:** Capturing protected controls, weakening privacy/overlap guards, changing default confidence, or adding permissions, hosts, providers, or assets.

**Never:** Add site-specific branches; use alt text as OCR output or the unsafe 1.5× scale; admit `aria-pressed`, unsafe links, multi-role anchors, malformed state, or protected ancestry; push, merge, or change `main`/origin.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Behavior | Failure Behavior |
|---|---|---|---|
| NTA-shaped link | Safe anchor; sole `role=button`; valid controls/expanded; 136×70 image | Observed and routed to Japanese OCR | Revalidate before commit |
| Live toggle | `aria-expanded` changes false↔true | New revision remains eligible | Stale work cannot commit |
| Disclosure metadata | Any allowed combination/value after trim/case normalization | Remains eligible; controls is syntax-only | Malformed value blocks |
| Protected state | Pressed/native/outer control, unsafe href, or private ancestry | Excluded before capture | Fail closed |
| Compact raster | No downscale needed; CSS width 96–192, height 49–72, aspect 1.5–3 | All providers receive 2× crop; Tesseract uses `SINGLE_BLOCK` | If axis/area bound fails, use native |

</frozen-after-approval>

## Code Map

- `lib/replica/source-privacy-policy.ts` -- premature disclosure rejection.
- `lib/ocr/{source-image-observer,image-source-session}.ts` -- discovery, mutations, and final gate.
- OCR preprocessing/acquisition and Tesseract runtime -- compact scaling and block mode.
- `tests/{source-image-observer,image-source-session,small-image-policy,pixel-acquisition,tesseract-provider}.test.ts` -- positive, privacy, currentness, scaling, and false-positive regressions.

## Tasks & Acceptance

**Execution:**
- [ ] `lib/replica/source-privacy-policy.ts` -- separate validated disclosure metadata from pressed-control state.
- [ ] `tests/{source-image-observer,image-source-session}.test.ts` -- add exact disclosure values/combinations, NTA toggle, nested activation, and privacy/currentness negatives.
- [ ] `lib/ocr/{preprocessing-profile,pixel-acquisition}.ts`, `lib/ocr/providers/tesseract/runtime.ts`, and focused tests -- after existing downscale/banner precedence, apply the exact CSS band globally, scale captured pixels 2× within bounds, retain block mode, and cover boundary/DPR inputs.
- [ ] `wxt.config.ts`, `README.md`, identity/artifact tests -- advance the label to `.2`; check and sync the four-provider trial into `dist/chrome-unpacked`.

**Acceptance Criteria:**
- Given the supplied post-script page, when scanned, then observed images move from 9 to 15: six navigation GIFs enter OCR, two native print buttons stay protected, and the empty dialog image stays zero-area.
- Given default confidence, when the packaged Japanese runtime is checked manually, then `gnav-news2.gif` yields accepted `お知らせ`, `gnav-procedure2.gif` improves from 0.64 to at least 0.65 with correct text, and blank/icon-only samples do not yield accepted text.
- Given either replica path or provider fallback, when OCR runs, then order and eligibility/currentness remain intact.
- Given the trial branch, when handed off, then checks, exact trial validation, beta identity, and branch/main/origin verification pass with no push or merge.

## Spec Change Log

## Verification

**Commands:**
- `npx vitest run tests/source-image-observer.test.ts tests/image-source-session.test.ts tests/small-image-policy.test.ts tests/pixel-acquisition.test.ts tests/tesseract-provider.test.ts tests/build-identity.test.ts`
- `npm run check`
- `npm run artifact:sync:ocr-trials && npm run check:ocr-all-trial`
- `git diff --check && git status --short --branch`

**Manual checks:**
- Run the packaged worker on temporary copies of the two GIFs plus blank/icon controls; record transcript/confidence without committing those pixels.
- Reload `dist/chrome-unpacked`; verify `.2`, then test the supplied page with skip-small both off and on.
