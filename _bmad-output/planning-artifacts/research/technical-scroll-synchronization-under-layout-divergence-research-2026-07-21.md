---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments:
  - '_bmad-output/project-context.md'
workflowType: 'research'
lastStep: 6
research_type: 'technical'
research_topic: 'Scroll synchronization under translation-induced layout divergence'
research_goals: 'Evaluate why matched scrolling feels too fast or slow when translated layout height differs, compare current and earlier Simul behavior, and recommend a robust implementation architecture without changing scroll code in this pass.'
user_name: 'Builder'
date: '2026-07-21'
web_research_enabled: true
source_verification: true
---

# Keeping the Same Place: Scroll Synchronization Under Layout Divergence

**Date:** 2026-07-21
**Author:** Builder
**Research Type:** technical

---

## Research Overview

This report evaluates source-to-replica scroll synchronization when translation,
font metrics, responsive layout, or incremental page updates make the two
documents different heights. It compares Simul's current and earlier Git
implementations with browser platform behavior and primary standards sources.
The output is an implementation recommendation and acceptance plan; this
research pass does not change scroll behavior.

## Executive Summary

Simul's current Isolated HTML document-scroll path projects the source's exact
CSS-pixel offset even when translation changes line wrapping and cumulative
height. That can stay visually close on similar layouts, but it cannot preserve
the same reading location when expansion is nonuniform. Global normalized
progress fixes endpoints but changes local apparent speed. The correct long-term
model is a hybrid: preserve a corresponding visible node, interpolate between a
small set of paired source/replica landmarks, and fall back to normalized
progress when identity is unavailable.

The Git comparison does not support a wholesale return to version 0.2.3. All
committed 0.2.0–0.2.5 versions used essentially the same direct document-pixel
projection. Version 0.3.0 added nested-owner classification, which is a plausible
separate regression when source and sanitized replica choose different nested
targets. Current progressive text replacement also schedules repeated extent
measurements and scroll reapplication.

Before building the hybrid mapper, inspect and neutralize site-authored
`scroll-behavior: smooth` and scroll snapping on the inert companion scroller.
The standards confirm that programmatic behavior `auto` may honor computed
smooth scrolling, so frequent synchronization writes can repeatedly restart a
smooth operation. Then coalesce layout work, add unequal-height fixtures, and
roll out anchor-first mapping behind a reversible boundary.
[CSSOM View scrolling algorithm](https://drafts.csswg.org/cssom-view-1/#scrolling)

**Key findings:**

- Exact pixels are correct only for effectively equal layouts.
- One global percentage is endpoint-correct but locally speed-incorrect under
  nonuniform expansion.
- Semantic paired landmarks provide local continuity and naturally vary the
  replica speed through longer or shorter translated regions.
- Nested-owner identity and projection policy are independent concerns and
  should be tested and implemented separately.
- Translation-driven extent refresh must be coalesced by layout epoch to avoid
  repeated read/write cycles.

**Top recommendations:**

1. Diagnose smooth-scroll/snap interference and enforce instant writes only on
   the companion-owned scroller.
2. Add deterministic unequal-layout and progressive-reflow fixtures before
   changing projection.
3. Implement anchor-first piecewise interpolation with normalized fallback.
4. Send stable ephemeral identity for document landmarks and nested owners.
5. Measure numeric drift locally and retain exact/normalized rollback paths.

## Table of Contents

1. [Research scope](#technical-research-scope-confirmation)
2. [Integration patterns](#integration-patterns-analysis)
3. [Technology stack](#technology-stack-analysis)
4. [Architecture and design](#architectural-patterns-and-design)
5. [Implementation and adoption](#implementation-approaches-and-technology-adoption)
6. [Technical recommendations](#technical-research-recommendations)
7. [Research synthesis](#research-synthesis)
8. [Methodology and sources](#methodology-and-source-verification)
9. [Conclusion](#technical-research-conclusion)

## Technical Research Scope Confirmation

**Research Topic:** Scroll synchronization under translation-induced layout divergence

**Research Goals:** Evaluate why matched scrolling feels too fast or slow when
translated layout height differs, compare current and earlier Simul behavior,
and recommend a robust implementation architecture without changing scroll
code in this pass.

**Technical Research Scope:**

- Architecture analysis — current source capture, ownership, and replica projection.
- Implementation approaches — normalized progress, semantic anchors, and bounded correction.
- Technology stack — CSSOM View, ResizeObserver, MutationObserver, requestAnimationFrame, and scroll anchoring.
- Integration patterns — source observer, live replica commits, nested scrollers, and translation projection.
- Performance considerations — coalescing, layout reads, feedback-loop suppression, and measurable drift.

**Research Methodology:**

- Current web data with primary-source verification.
- Read-only comparison of current and historical Simul Git revisions.
- Explicit confidence levels for browser-boundary assumptions.
- No production scroll-code changes before the recommendation is reviewed.

**Scope Confirmed:** 2026-07-21, from the user's explicit instruction to
research scroll-speed/layout divergence autonomously before making changes.

---

## Integration Patterns Analysis

### Current source-to-companion protocol

Simul already uses the right transport shape: a source observer identifies the
active scroll owner, reads bounded geometry, and sends a snapshot that adds no
page text or form data to the companion. The current message also carries the
page URL for page/session validation. Source scroll events are coalesced once
per animation frame; the replica then projects the newest snapshot after replay
and layout commits.
Nested scrollers use normalized progress, while the default Isolated HTML
document path currently applies the source CSS-pixel offset directly. CSSOM
View confirms that scroll events and offsets describe one document's current
scrolling area; it does not imply that the same offset identifies equivalent
content in a differently laid-out document.
[CSSOM View](https://www.w3.org/TR/cssom-view-1/)

The resulting protocol is event-driven and local. It needs no REST API,
WebSocket, message broker, or persisted event log: `chrome.runtime` messages
between existing extension contexts are sufficient. Keeping this narrow avoids
new networking, permissions, serialization dependencies, and privacy exposure.

### Engine-neutral scroll intent

The wire contract should evolve from a raw position snapshot into a bounded
`ScrollProjectionIntent` while retaining the current fields for fallback:

- scroll-owner kind and existing private owner identity;
- absolute offset, maximum offset, viewport size, and normalized progress;
- monotonically increasing sequence and layout epoch;
- active-versus-settled phase;
- when available, an ephemeral private mirror-node identifier and that node's
  offset from the source viewport's block-start edge.

The anchor identifier should reuse Simul's in-memory source-to-replica identity
map. It must not contain text, selectors, form values, resource URLs, or durable
browsing identity. The existing page URL may remain solely as the message's
page/session validation field. The isolated source mirror can supply semantic
anchors because it already owns that identity mapping; the generic live-page
observer and engines without a resolvable node can continue sending
geometry-only intents.

### Replica projection interoperability

Each renderer should implement the same small adapter boundary:

1. resolve an ephemeral anchor identity to a replica element;
2. measure the active replica scroll range and anchor geometry;
3. apply one clamped target offset;
4. report numeric, content-free diagnostics.

Projection should use the strongest information available, in this order:

1. preserve the resolved anchor's source viewport offset;
2. interpolate between the nearest valid mapped landmarks;
3. use normalized progress when no anchor is available;
4. use absolute pixels only when source and replica geometry are effectively
   equal, or as a compatibility fallback during initial connection.

This matches the browser's own scroll-anchoring principle: preserve a visible
node's position when layout changes rather than preserving an unrelated
absolute offset. [CSS Scroll Anchoring](https://www.w3.org/TR/css-scroll-anchoring-1/)

### Layout invalidation and reconciliation

DOM mutation and box-size change signals should invalidate cached landmark
geometry, not immediately read and write layout. MutationObserver delivery is
microtask-based, while ResizeObserver participates in rendering and has loop
protection. Simul should increment a layout epoch, mark the map dirty, and
schedule one later animation-frame measurement followed by one write. This
keeps translation commits, font/image settling, responsive changes, and live
source patches interoperable without recursive layout work.
[DOM mutation observers](https://dom.spec.whatwg.org/#mutation-observers)
[Resize Observer](https://www.w3.org/TR/resize-observer/)
[HTML rendering update](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)

### Feedback suppression and final correction

The source remains authoritative. Replica writes should be tagged with their
sequence/layout epoch, and any matching echo should be ignored. During active
motion, apply at most the newest projection per animation frame and avoid
easing that would create visible lag. At the end of a sequence, `scrollend`
where available—or a short inactivity fallback—can trigger one
final anchor correction after pending layout changes settle.
[CSSOM View scrolling events](https://www.w3.org/TR/cssom-view-1/#scrolling-events)

### Security and privacy boundary

This design adds no host permission, network request, persistent browsing
record, or page-content log. Diagnostics should contain only engine, owner
kind, chosen projection tier, sequence/epoch, range ratios, and numeric drift.
Existing masking and read-only replica invariants remain unchanged. Confidence:
**high** for the protocol and invalidation boundaries; **medium** for landmark
selection and correction thresholds until measured against diverse translated
layouts.

## Technology Stack Analysis

### Programming language and execution boundary

Simul's relevant implementation is strict TypeScript compiled into Chrome MV3
extension entrypoints. The source-page observer executes in Chrome's isolated
world, sends bounded numeric scroll snapshots, and the companion projects those
snapshots into a scriptless replica. No server, database, or cloud component is
in the control loop. That is the correct boundary to retain: layout comparison
uses ephemeral geometry and must not persist page content or add permissions.

### Browser geometry primitives

The available platform primitives describe different layers of the problem:

- CSSOM View defines `scrollTop` as a scrolling-area coordinate and
  `scrollHeight` from the current scrolling-area height. It also distinguishes
  root/body behavior and clamps programmatic element scrolling to the element's
  current range. These are exact geometric measurements, not semantic position
  equivalence between different layouts. [CSSOM View](https://www.w3.org/TR/cssom-view-1/)
- Scroll events are queued and dispatched during rendering updates; `scrollend`
  indicates that the gesture/sequence and pending offset changes have ended.
  Simul should continue sampling ordinary scroll motion once per animation
  frame and may use `scrollend` only for a final correction, never as the main
  transport. [CSSOM View scroll events](https://www.w3.org/TR/cssom-view-1/#scrolling-events)
- `requestAnimationFrame` runs in the rendering update sequence after scroll
  steps and before the subsequent style/layout update. It is the appropriate
  coalescing clock, but reading and writing layout repeatedly inside one frame
  can still force extra work. [HTML rendering update](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)
- `ResizeObserver` reports element box-size changes during rendering and can
  observe insertion/removal and `display:none` transitions. It is useful for
  invalidating a mapping after translation or a live patch, but its own loop
  safeguards mean callbacks should schedule one later reconciliation rather
  than write geometry recursively. [Resize Observer](https://www.w3.org/TR/resize-observer/)
- `MutationObserver` batches records into a microtask. It signals that a map may
  be stale but does not prove that layout has settled; geometry must be sampled
  on a rendering opportunity. [DOM mutation observers](https://dom.spec.whatwg.org/#mutation-observers)

### Browser-native precedent: scroll anchoring

CSS Scroll Anchoring exists because keeping an absolute scroll offset during
layout changes moves the content a person was reading. The browser selects a
visible anchor node near the block-start edge and adjusts the offset by that
node's movement. This is strong architectural precedent for Simul: preserve a
visible content anchor first, with normalized progress as fallback, instead of
treating source and translated pixel offsets as interchangeable.
[CSS Scroll Anchoring](https://www.w3.org/TR/css-scroll-anchoring-1/)

### Development and validation tools

The implementation can stay within the existing stack: TypeScript, Vitest,
synthetic DOM geometry fixtures, and content-free diagnostics. The additional
test need is a deterministic dual-layout harness that varies translated block
heights over time and measures anchor drift. No new framework, storage system,
remote service, or extension permission is justified.

### Adoption and compatibility implications

Chrome 138 already supplies every primitive needed for a hybrid algorithm.
`scrollend` is progressive enhancement; correctness must remain based on
ordinary scroll events plus animation-frame coalescing. Browser scroll
anchoring inside the replica can otherwise compete with Simul's explicit
projection, so the eventual implementation must deliberately define whether
the replica scroller opts out with `overflow-anchor:none` while Simul owns
correction. Confidence: **high** for the geometry/event model; **medium** for
the exact best anchor-selection heuristic until it is tested on representative
translated pages.

---

## Architectural Patterns and Design

### System architecture pattern: anchor-first hybrid projection

Use one engine-neutral coordinator with pluggable source and replica adapters.
The source adapter emits intent; the replica adapter resolves equivalent
ephemeral nodes and applies the target; the coordinator chooses the projection
tier. The algorithm should be anchor-first, then piecewise proportional, then
global normalized, with absolute pixels reserved for equal-layout cases.

This is deliberately a small in-process architecture rather than a distributed
system. Its components are:

- **Source sampler:** selects the authoritative owner and a viable visible
  anchor near the viewport's block-start edge.
- **Intent channel:** carries bounded geometry, private identity, sequence, and
  layout epoch over the existing extension message path.
- **Replica resolver:** maps the private identity or nearby landmarks to current
  replica geometry.
- **Projection coordinator:** selects a tier, clamps one target, and suppresses
  stale or echoed work.
- **Layout invalidator:** expires cached measurements after mirror, translation,
  font, image, viewport, or box-size changes.
- **Numeric diagnostics:** measures drift without recording content.

The browser's scroll-anchoring design validates the central choice: a visible
node near the block-start edge is a better continuity reference than an
absolute offset after layout changes. The specification also excludes fixed,
fully clipped, and unsuitable positioned content; Simul should adopt equivalent
candidate filters rather than anchoring to overlays or chrome.
[CSS Scroll Anchoring](https://www.w3.org/TR/css-scroll-anchoring-1/)

### Design principles and ownership

Maintain a single authority: source input drives the companion, while replica
scrolling caused by projection never drives the source. Separate measurement
from mutation, retain the newest intent only, and make every mapping decision
deterministic for a given layout epoch. The coordinator should not rewrite text,
replica construction, or source-page behavior; it consumes existing private
identity and geometry boundaries.

Native browser scroll anchoring may otherwise adjust the replica at the same
time as Simul. The implementation spike should compare the default behavior
with `overflow-anchor: none` on the coordinator-owned replica scroller. If Simul
can resolve anchors reliably, opting out avoids two competing controllers; if
it cannot, native anchoring remains valuable during independent replica layout
settling. This must be decided by fixtures and traces, not assumed.
[Scroll anchoring exclusion API](https://www.w3.org/TR/css-scroll-anchoring-1/#exclusion-api)

### Projection model and unequal layout speed

Neither absolute offsets nor one global percentage solve uneven translation
growth:

- Absolute pixels keep a similar instantaneous velocity but drift permanently
  after content above the viewport expands or contracts.
- Global normalized progress reaches matching endpoints but changes effective
  local velocity whenever source and replica height ratios differ.
- A resolved anchor preserves the reading location across arbitrary changes
  above it, but needs a fallback when that node is absent, virtualized, or not
  represented by an engine.

Therefore use a piecewise map between a bounded set of corresponding landmarks.
Within the interval surrounding the source viewport, interpolate progress using
that interval's source and replica coordinates. At an exact mapped landmark,
preserve its viewport offset. This produces local speed proportional to nearby
content expansion instead of the entire document's height ratio.

### Scalability and performance pattern

Cache landmark geometry by `(owner, layoutEpoch)` and sample a bounded set near
the viewport; never walk the full DOM on every scroll event. During motion,
coalesce to one read phase and one write phase per animation frame. Mutation
records and resize notifications only mark an epoch dirty. This follows the
platform rendering model, where scroll steps, animation callbacks, layout, and
ResizeObserver delivery occupy distinct portions of the update cycle.
[HTML rendering update](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)
[Resize Observer](https://www.w3.org/TR/resize-observer/)

Do not add smoothing by default. Easing every target makes the companion lag at
high source velocity. Instead, apply the current mapped target directly and use
a bounded correction only when a layout-epoch change would otherwise produce a
large discontinuity. A settled-event correction handles the final few pixels.

### Integration and communication pattern

Extend the existing versioned scroll message rather than introduce a second
transport. Old receivers can ignore optional anchor/epoch fields and preserve
their geometry fallback. New receivers should reject stale sequences and
unknown owner epochs. Document, nested, shadow-root, and engine-specific
scrollers use the same intent shape but independent owner-local maps.

`scrollend` is useful as progressive enhancement for reconciliation, while
ordinary scroll events plus animation-frame coalescing remain the compatible
path. [CSSOM View scrolling events](https://www.w3.org/TR/cssom-view-1/#scrolling-events)

### Security and data architecture

All mapping state is ephemeral and tab-scoped. Store only numeric geometry,
generated private node IDs, owner keys, epochs, and short-lived weak references.
Never add page text, accessible names, selectors, resource URLs, editable
values, or password data to an intent or diagnostic. The current page URL may
remain only as the existing page/session validation field. No data crosses the
existing extension boundary, no new origin request is required, and no new
permission is justified.

### Deployment and operational architecture

Introduce the architecture behind an internal rollout boundary:

1. diagnostics-only landmark discovery with no behavior change;
2. anchor-first document projection in Isolated HTML;
3. piecewise fallback and layout-epoch reconciliation;
4. nested-scroller support;
5. adapters for the visual/rrweb paths after equivalent fixtures pass.

Every stage retains normalized and current absolute fallbacks, allowing a fast
rollback without reverting unrelated replica work. Confidence: **high** that a
hybrid is structurally superior to either global mapping alone; **medium** on
candidate budget, discontinuity limit, and native-anchoring interaction until
the proposed harness supplies measurements.

---

## Implementation Approaches and Technology Adoption

### Git archaeology and the actual regression boundary

The repository has no release tags, so `package.json` history is the available
version map:

| Version | Commit | Relevant scroll behavior |
| --- | --- | --- |
| 0.2.0 | `d558c6e` | Isolated HTML, direct document coordinates |
| 0.2.1 | `c45d171` | Same scroll semantics |
| 0.2.2 | `05e2463` | Same scroll semantics |
| 0.2.3 | `12b62b9` | Same scroll semantics |
| 0.2.4 | `6326669` | Same scroll semantics |
| 0.2.5 | `28e0301` | Same scroll semantics |
| 0.3.0 | `2fde1c8` | Nested-owner detection and proportional nested projection |
| 0.3.2 | `90f8f4b` | Current; no material projection change from 0.3.0 |

There are no committed 0.2.6, 0.2.7, or 0.3.1 artifacts. The 0.3.0 planning
record mentions a transient “0.2.7 working tree,” so that exact state cannot be
reconstructed from Git.

Version 0.2.3 is not a general solution to translated-height divergence. Its
document path also used direct pixels and therefore looked aligned only while
cumulative source and replica heights happened to remain close. The only
committed semantic boundary that can explain a broad ownership regression is
0.3.0: viewport-scale nested-scroller classification and independent replica
target discovery were added there. Translation and sanitization can change
candidate eligibility or ordinal order, yielding a wrong or stalled target.

There are two additional current implementation gaps:

- The legacy visual path chooses exact pixels for faithful layout and normalized
  progress for adaptive layout. `VisibleReplayHost`, used by Isolated HTML, is
  not given `textLayoutMode` and always applies exact document pixels even when
  translated text reflows.
- Each isolated text projection mutates a text node or control text and queues
  an uncoalesced extent refresh that measures the document and reapplies
  scroll/layout. Progressive translation can therefore cause repeated geometry
  work and visible jumps.

### First diagnostic: site-authored scrolling behavior

Before changing mapping, verify computed `scroll-behavior` and
`scroll-snap-type` on every companion-owned scroll target. The CSSOM scrolling
algorithm uses behavior `auto` for ordinary programmatic scrolling, which can
honor a computed smooth-scroll policy; frequent updates may then restart or
abort an in-flight animation. Scroll snapping can likewise alter the applied
position. The first implementation spike should use explicit instant writes
and neutralize smooth behavior and snapping only on the inert replica-owned
scroller, while leaving the source untouched.
[CSSOM View scrolling algorithm](https://drafts.csswg.org/cssom-view-1/#scrolling)
[CSS Overflow smooth scrolling](https://drafts.csswg.org/css-overflow/#smooth-scrolling)
[CSS Scroll Snap](https://drafts.csswg.org/css-scroll-snap/)

### Technology adoption strategy

Adopt the mapper incrementally rather than replacing ownership and projection
together:

1. Add content-free diagnostics for chosen owner, computed smooth/snap policy,
   mapping tier, layout epoch, and drift.
2. Make companion projection latest-wins and explicitly instant; coalesce
   translation extent refreshes into one rendering opportunity.
3. Extract a pure piecewise-mapping function in `lib/` with no browser global.
4. Add ephemeral paired landmarks for Isolated HTML document scrolling behind
   an internal rollout switch.
5. Add stable identity for nested owners, then roll the same coordinator into
   visual/rrweb adapters.

Retain current exact and normalized implementations as fallbacks throughout.
Do not wholesale revert to 0.2.3: that would lose valid SPA/nested scrolling and
would not solve nonuniform translation reflow.

### Landmark mapping implementation

For a source focal coordinate
`x = sourceScrollTop + f × sourceClientHeight`, bracket `x` with two paired
landmarks `(sᵢ, rᵢ)` and `(sᵢ₊₁, rᵢ₊₁)`, then calculate:

```text
u = (x - sᵢ) / (sᵢ₊₁ - sᵢ)
mappedFocus = rᵢ + u × (rᵢ₊₁ - rᵢ)
targetTop = mappedFocus - f × replicaClientHeight
```

A focal fraction around 0.25–0.35 is a hypothesis for testing, not a shipped
constant. Include top and bottom edges of tall corresponding blocks so speed
can adapt within a long translated region. Retain the current anchor with
hysteresis, and reject fixed/sticky, transformed, zero-area, fully clipped, or
non-monotonic candidates. Use exact top/bottom clamps and normalized progress
when fewer than two valid landmarks exist.

Preserve fractional offsets and compare endpoints with an epsilon: CSSOM View
defines `scrollTop` with double precision while common extent properties are
integer values. Root/body behavior must continue through
`document.scrollingElement`. [CSSOM View](https://drafts.csswg.org/cssom-view-1/)

### Development workflow and tooling

No dependency is needed. Implement the mapping math and candidate filtering as
small TypeScript modules, then integrate through existing adapters. Batch all
geometry reads before writes; Chrome's performance guidance explicitly warns
that alternating geometry reads and mutations causes forced layout and layout
thrashing. [Avoid layout thrashing](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)

Use numeric debug counters in the existing diagnostics surface and Chrome
DevTools Performance traces for manual validation. The Performance panel exposes
scroll, layout invalidation, layout scope, and affected-node information needed
to confirm that a frame does not contain repeated full-document measurement.
[Chrome DevTools performance reference](https://developer.chrome.com/docs/devtools/performance/reference)

### Testing and quality assurance

Add a deterministic dual-layout fixture rather than relying only on public
sites. Current tests cover exact document offsets, scaling, delayed extent,
normalized nested progress, owner replacement, body/root fallback, and shadow
panes, but omit the failure modes at issue. Required fixtures are:

- equal geometry, uniform expansion, and nonuniform expansion above, inside,
  and below the viewport;
- progressive translation reflow during slow scroll, fast wheel/trackpad-like
  bursts, direction reversals, and a mid-gesture layout commit;
- inherited `scroll-behavior: smooth` and scroll snapping;
- fractional offsets, exact endpoints, quirks/body ownership, horizontal/RTL
  axes, and negative-capable ranges;
- nested and shadow scrollers whose source/replica candidate orders differ;
- multiple plausible viewport-scale containers and owner replacement;
- one coalesced extent measurement for a batch of translated nodes;
- Chrome integration of the outer scaled track plus iframe document scroll.

Pure tests should inject synthetic geometry and assert the mapping formula.
Browser fixtures should assert actual computed scrolling behavior and render
timing. Public sites remain manual compatibility checks, not deterministic test
dependencies.

### Deployment and operations practices

Ship diagnostics first, then enable the mapper for Isolated HTML document
scrolling. Compare exact, normalized, and anchor-first decisions in development
without sending telemetry. A rollback switches projection tier locally; it does
not alter sanitization, translation, permissions, or source ownership.

During a translated-text batch, record the active replica landmark's viewport
offset, apply all text mutations, measure once afterward, and compensate by the
offset delta. Once this explicit correction is verified, set
`overflow-anchor: none` on the owned replica scroller to prevent native and
Simul anchoring from both moving it. ResizeObserver and MutationObserver remain
invalidation signals, not write locations.

### Cost, skills, and resource management

Maintain approximately 32–64 nearby landmark edges per active owner and cache
them by layout epoch. IntersectionObserver may maintain a candidate window but
must not drive per-pixel mapping because it reports threshold crossings rather
than every scroll position. [Intersection Observer](https://w3c.github.io/IntersectionObserver/)

The work requires browser layout/scrolling knowledge and TypeScript test design,
but no new runtime, server, model, network budget, or extension permission. The
main resource risk is main-thread layout cost, controlled by bounded candidates,
latest-wins messages, and batched reads/writes.

### Risk assessment and mitigation

| Risk | Mitigation |
| --- | --- |
| Wrong nested owner after sanitization | Send stable ephemeral owner identity; fall back to owner-local normalized progress, not ordinal alone. |
| Virtualized or missing anchor | Retain hysteresis, try nearby paired landmarks, then normalized fallback. |
| Double movement from native anchoring | Measure first; disable `overflow-anchor` only when explicit compensation owns the replica. |
| Smooth/snap policy distorts writes | Use explicit instant writes and neutralize policy only on the inert replica scroller. |
| Repeated forced layouts | Invalidate by epoch; batch reads before one write; coalesce translated-node extent refresh. |
| Sticky/transformed geometry breaks monotonicity | Exclude unsuitable landmarks and validate increasing source/replica coordinates. |
| Stale intent after navigation or replay | Reject by session, generation, sequence, owner, and layout epoch. |
| Anchor identity exposes content | Use generated, ephemeral numeric IDs only; never transport text or selectors. |

## Technical Research Recommendations

### Implementation roadmap

1. **Regression guard:** diagnose and neutralize replica smooth-scroll/snap;
   verify one newest write per frame and add unequal-height fixtures.
2. **Reflow stability:** coalesce translation extent refresh and compensate the
   active anchor once per translation/layout batch.
3. **Pure hybrid mapper:** add bounded piecewise interpolation with exact-edge
   clamps and normalized fallback.
4. **Isolated HTML rollout:** connect existing source/replica identities and
   record numeric drift.
5. **Owner hardening:** replace ordinal-only nested matching with stable private
   owner identity.
6. **Engine expansion:** adopt the same adapter contract in visual/rrweb paths
   only after equivalent acceptance fixtures pass.

### Technology stack recommendation

Stay with the current TypeScript, Vitest, WXT, Chrome MV3, DOM observers, and
runtime messaging stack. Add no library or permission. Use `scrollend` only for
final settlement/map rebuilding; ordinary events plus one animation-frame
projection remain the continuous path.

### Success metrics and acceptance gates

Proposed engineering targets are:

- no more than one replica-frame lag during continuous source scrolling;
- paired landmark displacement below 8 CSS pixels during active input and below
  2 CSS pixels after settlement;
- no oscillation or visible backward correction after translation commits;
- exact top and bottom reachability;
- at most one projection and one extent measurement per replica frame;
- no new page-content diagnostics, permissions, networking, or persistence;
- all existing privacy, inertness, artifact, and full-check gates remain green.

These pixel thresholds are initial acceptance targets and should be adjusted
only from fixture and manual-browser evidence. Confidence: **high** on the
implementation order and immediate smooth/snap diagnostic; **medium** on the
specific landmark budget, focal fraction, and drift thresholds.

---

## Research Synthesis

### Decision framework

The mapping tier should follow observable capability, not a global user-facing
mode:

| Available evidence | Projection policy | Rationale |
| --- | --- | --- |
| Equal source/replica geometry | Exact pixels | Preserves source velocity without drift. |
| Resolved paired anchor | Preserve anchor viewport offset | Best continuity through changes above the viewport. |
| Two or more ordered landmarks | Piecewise interpolation | Matches local expansion/contraction and apparent speed. |
| Geometry only | Normalized owner-local progress | Reaches endpoints and remains deterministic. |
| Incomplete initial extent | Clamped current offset, then reconcile | Avoids guessing before layout exists. |

This ordering resolves the user's observed “faster or slower” behavior without
deliberately animating at a different rate. The companion target changes by the
local source-to-replica height ratio around the current reading position. It is
therefore faster only where translated content is genuinely taller and slower
where it is shorter.

### Immediate technical conclusion

The first change should be a narrow regression-and-diagnostics checkpoint, not
the full landmark algorithm. It should prove whether inherited smooth scrolling,
snap policy, nested-owner mismatch, or repeated extent refresh is responsible
for each observed failure. Those issues are independently testable and can hide
the benefit of a correct mapper.

Once the baseline is instant, latest-wins, and coalesced, implement the pure
piecewise mapper and connect it to existing mirror identity in Isolated HTML.
The browser's native scroll anchoring provides the design precedent, but it
cannot align two independent documents by itself; Simul must pair the nodes.
[CSS Scroll Anchoring](https://www.w3.org/TR/css-scroll-anchoring-1/)

### Future technical outlook

No emerging service or dependency is needed. Near-term improvement comes from
better use of stable platform primitives and Simul's existing identity model.
Later work may extend the same owner-local mapping to horizontal writing modes,
pinch-zoom/VisualViewport movement, and virtualized replicas, but those should
follow document and nested vertical acceptance. IntersectionObserver can keep
a candidate window bounded; `scrollend` can settle and rebuild; neither should
replace continuous scroll-event plus animation-frame synchronization.

### Remaining uncertainties

- The optimal focal fraction and landmark count require browser measurements.
- Native `overflow-anchor` interaction must be measured before disabling it.
- Some virtualized or closed-shadow content will not provide a corresponding
  landmark and must use normalized fallback.
- The report did not instrument the user's live browsing session, so it cannot
  attribute every current stall to one cause before diagnostics ship.
- Proposed pixel thresholds are acceptance hypotheses, not platform standards.

## Methodology and Source Verification

Research combined four evidence layers:

1. line-level inspection of current source capture, owner selection, replica
   projection, translation updates, and tests;
2. read-only Git comparison of every committed 0.2.x release state through
   0.3.2;
3. current primary standards for scrolling, rendering order, mutation, resize,
   intersection, snapping, and anchoring;
4. Chrome's official performance and scroll-anchoring documentation.

Searches were constrained to primary specifications and official browser
documentation. No secondary benchmark was treated as fact, and no performance
number was invented from repository inspection. Confidence is stated where the
recommendation still requires an implementation trace.

### Primary technical sources

- [CSSOM View Module](https://www.w3.org/TR/cssom-view-1/)
- [CSS Scroll Anchoring Module](https://www.w3.org/TR/css-scroll-anchoring-1/)
- [CSS Overflow Module](https://www.w3.org/TR/css-overflow-3/)
- [CSS Scroll Snap Module](https://drafts.csswg.org/css-scroll-snap/)
- [HTML rendering update](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)
- [DOM MutationObserver](https://dom.spec.whatwg.org/#mutation-observers)
- [Resize Observer](https://www.w3.org/TR/resize-observer/)
- [Intersection Observer](https://w3c.github.io/IntersectionObserver/)
- [Chromium scroll anchoring overview](https://blog.chromium.org/2017/04/scroll-anchoring-for-web-developers.html)
- [Chrome rendering-performance guidance](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)
- [Chrome DevTools performance reference](https://developer.chrome.com/docs/devtools/performance/reference)

## Technical Research Conclusion

Simul should not try to correct unequal translated layouts by tuning one global
scroll-speed multiplier. It should preserve reading position using stable
paired content geometry, interpolate locally, and fall back safely when semantic
identity is unavailable. The implementation can remain entirely local,
permission-neutral, dependency-free, testable, and reversible.

The next approved engineering checkpoint is: neutralize replica smooth/snap
behavior, coalesce extent work, add unequal-layout diagnostics and fixtures,
then implement the pure hybrid mapper. This research pass intentionally makes
no production scroll-code change.

---

**Technical Research Completion Date:** 2026-07-21

**Source Verification:** Current primary standards and official Chrome sources

**Overall Confidence:** High on architecture and regression boundaries; medium
on tuning constants pending deterministic and manual browser measurement.
