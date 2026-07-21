# Architecture

## Policy boundary

`ReplicaFidelityPolicy` is a saved, exact-valued preference:

- `passive` is the default and admits normalized inert visual resources that
  may request over HTTP(S).
- `conservative` routes through the existing stricter sanitizer behavior.
- `strict-local` is reserved in the type/model only; it is not exposed by the
  UI or accepted as a selectable preference until the deferred implementation
  and no-network tests are complete.

The selected policy is copied into every Isolated HTML session identity/start
message. Source capture and extension-side validation both apply the same
policy. A receiver never trusts the source's claim that a resource is passive.
Policy changes restart the Isolated HTML stream and atomically replace the
last-good replica after validation.

## Typed presentation transport

The mirror graph retains DOM order and carries bounded presentation metadata:

- stylesheet nodes preserve order, `media`, and disabled state;
- readable CSSOM is serialized as sanitized rule text, allowing imports to be
  flattened and CSSOM-only changes to be detected by a bounded signature poll;
- unreadable Passive Fidelity imports/links retain normalized HTTP(S) resource
  identity, while Conservative follows its existing omission rules;
- responsive-image metadata carries normalized `srcset`, `sizes`, picture
  source state, and the browser-selected `currentSrc` without script;
- passive anchors carry normalized HTTP(S) `href` only as inert selector/layout
  identity; the protected iframe and pointer-inert presentation prevent use;
- source `blob:` references are never reused across the boundary. The current
  synchronous graph cannot safely obtain every blob's bytes, so opaque blobs
  are omitted and diagnosed; a future independently bounded localization path
  must own and revoke any object URLs it creates;
- SVG resource attributes are tag/attribute-specific, normalized, and checked
  again at receipt. Active SVG elements and resource-changing animation remain
  unrepresentable, and Simul-owned inline declarations keep the reconstructed
  SVG tree static even when retained cross-origin CSS targets it. Intrinsic
  animation inside an opaque external SVG visual remains a disclosed browser
  access boundary;
- broad computed-style serialization remains deferred. The existing bounded
  canvas-color and canonical visually-hidden facts are the only computed-style
  fallbacks in this release; a future host/subtree fallback needs a separate
  property/node/byte budget and privacy review.

## CSS update path

MutationObserver remains the primary DOM signal. A bounded maintenance tick
also signatures readable ordinary and adopted stylesheet CSSOM. A changed
signature requests one bounded automatic recovery checkpoint while keeping the
last-good replica visible. This favors transactional correctness over a new
stylesheet-only patch type in this release. No website prototypes are
monkey-patched and no source script is injected.

`@import` handling is policy-specific:

1. Flatten already-loaded readable imported rules through the same CSS
   sanitizer, preserving their position.
2. In Passive Fidelity only, retain a canonical HTTP(S) import when CSSOM is
   unreadable; record that it may request from the replica.
3. Block unsupported schemes, executable/legacy CSS, recursive/capacity
   overflow, and imports under Conservative.

## Inert resource model

Passive resources are allowed only where the element/property has visual,
non-document semantics: stylesheets/fonts/CSS images, image/picture sources,
static posters, and reviewed SVG image/filter/use attributes. URL admission is
scheme-, tag-, and attribute-specific. The iframe continues to block scripts,
workers, connections, frames, objects, media playback, forms, and navigation;
the extension presentation keeps pointer events disabled and controls inert.

The existing CSP may be widened only to the minimum passive visual directives
already represented by the policy. It must not add script, connect, frame,
worker, object, form, or navigation capability. No permission expansion is
part of this design.

## Diagnostics

Representability summaries add bounded counters, never resource identity:

- preserved/flattened/omitted/blocked stylesheet and SVG resources;
- block reasons: execution risk, navigation, unsupported scheme, browser
  inaccessibility, capacity, or strict policy;
- browser-inaccessible or unsupported resources, including omitted source
  blobs;
- `replicaRequestCapableResourceCount` and a boolean policy disclosure.

Counters flow through checkpoint, patch, recovery, and console diagnostics;
Settings contains the policy/request disclosure. Neither path includes page
content, URL, selector, tag, attribute, hash, pixel, or node identifiers.
The policy name is stream-bound, and an ever-request-capable flag remains true
after a successful resource-bearing patch even when later patches contain only
text.

## Language presentation

The translation catalog owns one complete, unique, explicitly ordered list of
supported language codes. Its order is based on stable English reference names,
not on the current rendered label or the host's locale collation. The From
picker renders those codes through `Intl.DisplayNames` in the selected target
language with the existing English fallback. The To picker renders a reviewed,
deterministic endonym table, using script-qualified endonyms for Simplified and
Traditional Chinese. Auto-detect is a source-only sentinel before the catalog.

## Scroll ownership

The 0.2.3 document pipeline is the baseline invariant: a source document scroll
is read from `document.scrollingElement`/window and projected directly to the
replica iframe plus the scaled outer track. Nested scrolling is an extension of
that path, not a replacement for it. A nested element may take ownership only
after an actual qualifying scroll event from that connected, viewport-scale
element. Status announcements and DOM rebuilds may refresh an existing owner,
but may not discover and take over a nested element heuristically. A document
scroll event or changed authoritative document coordinate immediately restores
document ownership. Replica-side nested projection is attempted only for a
qualified target; otherwise progress falls back to the document track without
suppressing the known-good direct document projection.

## Lifecycle and failure behavior

Every candidate owns its temporary styles and blobs. Candidate rejection or
abort revokes its objects. Commit transfers ownership; the previous committed
lease is revoked only after the new one becomes visible. A malformed or
over-budget presentation patch is rejected transactionally and triggers the
existing last-good recovery path. Conservative is always available when a
user prefers fewer replica-originated requests.
