---
id: SPEC-passive-replica-fidelity
companions:
  - architecture.md
  - acceptance-matrix.md
  - ../../project-context.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the
> complete, preservation-validated contract for this fidelity-policy change.

# Passive Replica Fidelity

## Why

Simul's current conservative sanitizer keeps the replica safe but removes
ordinary visual resources and inert semantics that many sites need for basic
layout, SVG, and readable structure. Users need a higher-fidelity default that
still refuses website code, navigation, forms, active documents, and private
fields, while honestly disclosing that passive visuals may make additional
HTTP(S) requests from the replica.

## Capabilities

- **CAP-1**
  - **intent:** Users can save a replica-fidelity policy and use Passive Fidelity as the Isolated HTML default or Conservative as its stricter fallback.
  - **success:** The choice survives reloads, new installs and migrated settings resolve to Passive Fidelity, and Strict Local Mirror is absent from selectable UI until its no-network contract passes.
- **CAP-2**
  - **intent:** Passive Fidelity preserves safely representable CSS presentation and cascade channels, including passive visual resources.
  - **success:** Deterministic fixtures retain inline, embedded, linked, imported, adopted, open-shadow, query/layer, pseudo, font, background, fragment, ordering, media, and disabled-state behavior within declared limits.
- **CAP-3**
  - **intent:** Passive Fidelity follows ordinary CSSOM presentation changes without requiring a page rebuild.
  - **success:** Bounded `insertRule`, `deleteRule`, mutable declaration, media, order, and disabled-state fixtures automatically stage a fresh replica while the last-good view remains visible and Conservative behavior remains unchanged.
- **CAP-4**
  - **intent:** Passive Fidelity preserves inert HTML semantics and responsive/static visual state needed by selectors and layout.
  - **success:** Anchors retain normalized HTTP(S) identity without navigating; picture/source selection and static HTTP(S)/data posters reproduce in a validated standards-or-quirks shell without enabling forms, playback, or source mutation. Opaque source blobs and exact limited-quirks behavior are omitted or documented rather than unsafely approximated.
- **CAP-5**
  - **intent:** Passive Fidelity preserves bounded static SVG structure, effects, and passive visual resources.
  - **success:** Gradients, patterns, symbols, clips, masks, markers, filters, local references, and approved normalized HTTP(S) SVG visuals render in fixtures while active SVG content remains rejected.
- **CAP-6**
  - **intent:** Users and developers can understand what fidelity policy preserved, transformed, omitted, or blocked without exposing page content.
  - **success:** Diagnostics use bounded counters/reasons only, distinguish request-capable resources and browser inaccessibility, and contain no text, URLs, pixels, hashes, selectors, attributes, or node identity.
- **CAP-7**
  - **intent:** Simul ships this policy change as a documented, ready-to-load release without regressing translation, privacy, OCR, cache, scrolling, or sandbox guarantees.
  - **success:** The versioned source and unpacked artifact pass the complete deterministic suite, byte-equality check, security regression set, and fresh adversarial reviews.
- **CAP-12**
  - **intent:** Language selection is predictable while respecting how users expect each picker to be read.
  - **success:** Every supported language appears exactly once in one explicit English-name canonical order; From labels localize into the selected target language, To labels use native endonyms, Auto-detect is first and source-only, and Simplified and Traditional Chinese sort under Chinese.
- **CAP-13**
  - **intent:** Scroll matching again follows ordinary documents reliably without losing support for pages whose true reading viewport is nested.
  - **success:** The direct 0.2.3 document-coordinate path is authoritative; bounded nested ownership activates only from a qualifying nested scroll event, never heuristic discovery alone, and document, body, nested, zoom, rebuild, shrink, and open-shadow regression fixtures pass.

## Constraints

- The replica remains `sandbox="allow-same-origin"` without scripts, pointer interaction, forms, navigation, workers, connections, active frames, objects, embeds, portals, webviews, or website custom-element execution.
- Scripts, inline handlers, `javascript:`, CSS `expression()`, `behavior`, `-moz-binding`, form actions, active embedded documents, and password/private-field transport remain blocked under every policy.
- Passive Fidelity may issue normalized HTTP(S) requests only for inert visual resources; Settings and diagnostics must disclose that consequence.
- Conservative must preserve the current stricter behavior and remain saved/selectable.
- No new permissions, weaker sandbox, remotely hosted executable code, site-specific branch, or source-page mutation is allowed.
- CSS, CSSOM, SVG, blob, computed-style, transport, and diagnostics work must be bounded by explicit resource, byte, rule, node, time, and memory limits.
- Existing exact-content caches, OCR safeguards, generic scroll behavior, and privacy tests remain part of the release gate.
- Language ordering is data-defined and deterministic rather than derived from incidental catalog order, rendered labels, locale collation, or runtime `Intl` behavior.
- Scroll repair must remain generic and independent of replica-fidelity policy; no hostname rule or visually similar-node guess may replace a source document scroll with a replica nested scroll.

## Non-goals

- Strict Local Mirror selection or a no-second-request promise before its deferred resource/pixel substitution and explicit no-network acceptance suite are complete.
- Website JavaScript, custom-element lifecycle, interactive navigation/forms, media playback, or active embedded documents.
- SVG animation in this release; a future geometry/opacity/transform-only saved option requires separate review and defaults off.
- Perfect reconstruction of closed roots, protected cross-origin CSSOM, DRM/media pixels, or script-owned internal state.

## Success signal

Ordinary resource-heavy sites retain substantially more layout, styling, SVG,
and readable structure under the default policy, Conservative remains available,
and deterministic security tests prove the replica is still inert. The loaded
release visibly reports its new version and clearly discloses when its passive
visuals can produce replica-originated requests. Language lists remain stable
and readable under target-language changes, and ordinary source-page scrolling
matches the replica with the same direct-coordinate reliability as 0.2.3.

## Assumptions

- Replica fidelity is a global saved preference rather than a per-site rule.
- When existing authority cannot safely read or capture source blob bytes, the
  resource is omitted with a browser-inaccessibility diagnostic rather than
  expanding permissions.
- The canonical language order uses English reference names for stability even
  though the rendered From and To labels intentionally use different languages.
