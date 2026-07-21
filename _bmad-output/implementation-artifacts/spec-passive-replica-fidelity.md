---
title: 'Passive Replica Fidelity and Release Regressions'
type: 'feature'
created: '2026-07-21'
status: 'done'
review_loop_iteration: 0
baseline_commit: '28e030147c62f2110ee7aabeafba475bd9f1ae46'
context:
  - '{project-root}/_bmad-output/project-context.md'
  - '{project-root}/_bmad-output/specs/spec-passive-replica-fidelity/SPEC.md'
  - '{project-root}/_bmad-output/specs/spec-passive-replica-fidelity/architecture.md'
  - '{project-root}/_bmad-output/specs/spec-passive-replica-fidelity/acceptance-matrix.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Isolated HTML's single conservative sanitizer removes ordinary CSS, inert URL semantics, responsive images, and static SVG resources, reducing fidelity on normal sites. The 0.2.7 working tree also regressed source-scroll matching and renders both language lists with target-localized labels in an incidental catalog order.

**Approach:** Add a saved Passive Fidelity policy as the Isolated HTML default while retaining Conservative. Carry the policy through the typed source/receiver boundary, preserve bounded passive presentation resources, and expose content-free diagnostics plus an explicit network disclosure. Restore the direct 0.2.3 document-scroll path as authoritative and limit nested ownership to real qualifying events. Use one tested language order: From labels localize to the target language; To labels are deterministic native endonyms.

## Boundaries

**Always:** Keep the iframe `sandbox="allow-same-origin"` without scripts and keep presentation pointer-inert. Revalidate every URL at the receiver. Preserve last-good atomic replacement, exact-content caches, password/private-field blocking, no source mutation, and current permissions. Bound CSS/SVG/rule/resource bytes and diagnostic counts. Passive HTTP(S) visuals may request again and must be disclosed. Conservative must retain its existing behavior. Strict Local Mirror remains hidden/deferred. Treat unreadable cross-origin CSSOM, opaque source blobs, closed roots, and protected media as browser boundaries, not reasons to weaken safety.

**Never:** Execute website scripts/custom-element lifecycle, handlers, JavaScript URLs, legacy executable CSS, navigation, form submission, frames/objects/embeds/portals/webviews, or audio/video playback. Do not add permissions, host-specific branches, remote executable code, unbounded computed styles, SVG `foreignObject`, or resource-changing animation.

## Code Map

- `lib/preferences.ts`, `lib/preference-coordinator.ts`, sidepanel HTML/TS: saved policy, migration/default, disclosure, restart, language labels.
- `lib/replica/html-mirror-{protocol,client,source,sanitizer}.ts`: policy transport, CSS/HTML/SVG capture, counters, CSSOM signatures.
- `lib/replica/isolated-html-engine.ts`: dual validation, passive CSP, resolved styles, inert semantics, request/revocation diagnostics.
- `lib/live-page-mirror.ts`, `lib/primary-scroll.ts`, `lib/replica/visible-replay-host.ts`: document-first ownership and nested fallback.
- `tests/`, docs, package files, `dist/chrome-unpacked/`: deterministic/security proof and ready-to-load release.

## Tasks

- [ ] Add exact `passive | conservative` preference parsing/default/view patching and Settings choice/help. Restart Isolated HTML atomically on change. Reserve but do not accept/show `strict-local`.
- [ ] Add fidelity policy to the Isolated stream start/session and enforce it source- and receiver-side. Default standalone sanitizer calls to Conservative so existing callers/tests do not silently widen.
- [ ] Under Passive, preserve normalized anchor HTTP(S) identity, picture/source `srcset`/`sizes`/selected source, stylesheet order/media/disabled state, static video poster without media sources, local fragments, and passive HTTP(S) image/style/font URLs. Keep controls inert and all active attributes/elements blocked.
- [ ] Preserve readable CSSOM as sanitized resolved rule text; flatten readable imports in order and retain sanitized HTTP(S) imports only when unreadable. Extend the bounded maintenance signature to ordinary stylesheets so `insertRule`, `deleteRule`, and declaration changes recover/update without prototype patching.
- [ ] Expand the bounded static SVG profile for defs, gradients, patterns, symbols, clips, masks, markers, filters, and safe primitives. Permit reviewed HTTP(S) `image`, `feImage`, and external `use` references only under Passive. Block scripts, handlers, navigation, `foreignObject`, animation, and unsupported schemes.
- [ ] Add aggregate diagnostics for preserved/flattened/omitted/blocked styles and SVGs, reason categories, browser-inaccessible blobs, and request-capable resources. Never log content or identity. Localize/revoke source blobs only where existing authority can actually obtain bytes; otherwise omit and diagnose.
- [ ] Define one explicit complete language order by English reference name. Render From through target-locale `Intl.DisplayNames` with English fallback; render To through a reviewed endonym map, including script-qualified Chinese variants. Test uniqueness/completeness/ordering and Auto-detect placement.
- [ ] Remove heuristic nested discovery from status announcements. Restore direct document-coordinate projection from 0.2.3, retain event-qualified nested ownership, and prove document/body/window, zoom, rebuild, dimension shrink, removed nested owner, and open-shadow cases.
- [ ] Update architecture/fidelity/README/Settings help, bump the minor release version, synchronize `dist/chrome-unpacked`, run `npm run check` and `git diff --check`, then run fresh blind/edge/security reviews and resolve actionable findings.

## Acceptance

- Passive is the saved/default Isolated policy and visibly discloses possible replica-originated passive requests; Conservative survives reload and keeps stricter outcomes; Strict Local is not selectable.
- Fixtures preserve cross-origin links/fonts, inline/linked imports, CSSOM mutations, backgrounds/fragments, responsive pictures, dark canvas/custom hosts, and bounded static SVG effects while adversarial fixtures prove scripts, handlers, JavaScript URLs, forms, playback, and active embeds remain disabled.
- Diagnostics distinguish policy, outcome, reason, and request capability using counts only.
- From and To contain every supported code once in the specified order, with target-localized From labels and native To endonyms.
- Ordinary scrolling again follows 0.2.3 direct-coordinate semantics; nested scrolling cannot take over without a qualifying source event.
- Source and ready-to-load artifact report the same new version and the full check plus byte-exact artifact and fresh review gates pass.

</frozen-after-approval>

## Approval Note

The user explicitly approved autonomous planning and implementation, including assumptions, testing, release synchronization, and follow-up fixes. This specification is therefore marked `ready-for-dev` without an additional checkpoint.

## Suggested Review Order

**Policy and receiver boundary**

- Defines the only selectable fidelity policies and keeps Strict Local unavailable.
  [`fidelity-policy.ts:15`](../../lib/replica/fidelity-policy.ts#L15)

- Makes Passive Fidelity the saved default with fail-closed preference parsing.
  [`preferences.ts:120`](../../lib/preferences.ts#L120)

- Binds the selected policy and content-free diagnostics into the active replica engine.
  [`main.ts:389`](../../entrypoints/sidepanel/main.ts#L389)

- Keeps the iframe scriptless while permitting only policy-approved passive visual resources.
  [`isolated-html-engine.ts:60`](../../lib/replica/isolated-html-engine.ts#L60)

**Capture fidelity and security**

- Sanitizes inert HTML semantics and passive resources through one typed source boundary.
  [`html-mirror-sanitizer.ts:1284`](../../lib/replica/html-mirror-sanitizer.ts#L1284)

- Flattens readable CSSOM while distinguishing unreadable imports from bounded failures.
  [`html-mirror-sanitizer.ts:1725`](../../lib/replica/html-mirror-sanitizer.ts#L1725)

- Validates bounded static SVG data images without admitting executable SVG behavior.
  [`html-mirror-sanitizer.ts:3257`](../../lib/replica/html-mirror-sanitizer.ts#L3257)

- Centralizes private-control eligibility across capture, mutation tracking, and receiver validation.
  [`source-privacy-policy.ts:56`](../../lib/replica/source-privacy-policy.ts#L56)

**Scroll restoration**

- Restores direct document coordinates and event-qualified nested ownership at the source.
  [`live-page-mirror.ts:426`](../../lib/live-page-mirror.ts#L426)

- Normalizes standards, quirks, body, nested-pane, and composed-editor scroll ownership.
  [`primary-scroll.ts:27`](../../lib/primary-scroll.ts#L27)

- Projects pre-commit document and keyed nested positions into the committed replica.
  [`visible-replay-host.ts:202`](../../lib/replica/visible-replay-host.ts#L202)

**Language presentation**

- Specifies complete English-reference ordering and deterministic native target endonyms.
  [`language-options.ts:7`](../../lib/language-options.ts#L7)

- Populates native To labels while relocalizing From labels into the target language.
  [`main.ts:2854`](../../entrypoints/sidepanel/main.ts#L2854)

**Proof and release handoff**

- Proves import fallback, capacity, SVG, resource, and receiver security behavior deterministically.
  [`html-mirror-protocol.test.ts:591`](../../tests/html-mirror-protocol.test.ts#L591)

- Regresses 0.2.3 document scrolling plus SPA pane insertion and rebuild mapping.
  [`live-page-mirror.test.ts:467`](../../tests/live-page-mirror.test.ts#L467)

- Proves catalog completeness, stable ordering, target localization, and native endonyms.
  [`language-options.test.ts:15`](../../tests/language-options.test.ts#L15)

- Documents policy disclosure, installation, compatibility limits, caching, and release behavior.
  [`README.md:51`](../../README.md#L51)

- Ships the ready-to-load Chrome artifact at the same visible 0.3.0 version.
  [`manifest.json:1`](../../dist/chrome-unpacked/manifest.json#L1)
