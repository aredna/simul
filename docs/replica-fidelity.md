# Replica fidelity

Simul reconstructs a web page for visual comparison and translation. The
replica is not a second running copy of the site: website JavaScript never runs
inside it, its presentation surface is pointer-inert, and its security boundary
is enforced again when source data reaches the receiver.

Visual fidelity and replica networking are separate choices. Isolated HTML
therefore saves an explicit fidelity policy instead of treating every retained
resource as equally safe or equally private.

## Saved policies

| Policy | Availability | Resource behavior | Security behavior |
| --- | --- | --- | --- |
| **Passive Fidelity** | Selectable and the default | Preserves the broadest bounded set of passive CSS, images, fonts, link identity, responsive sources, posters, and static SVG references. These references may cause additional HTTP(S) requests from the replica. | Scriptless sandbox, pointer-inert presentation, no form submission, no navigation, no playback, and no active embedded documents. |
| **Conservative** | Selectable fallback | Uses the earlier stricter sanitizer and omits newer passive semantics such as anchor identity, responsive `<source>` candidates, static posters, external SVG references, and retained unreadable imports. It can still load allowlisted images, stylesheet links, fonts, and CSS URLs, so it is not a zero-network policy. | The same scriptless, inert receiver and active-content blocks as Passive Fidelity. |
| **Strict Local Mirror** | Hidden and deferred | Will become selectable only after every replica visual is local and deterministic no-network tests pass. | Must retain every current active-content block and add a restrictive no-network backstop. |

Changing the selected policy is saved with the other companion settings and
rebuilds Isolated HTML through that policy. The policy is fixed for the lifetime
of each source/receiver stream and is validated on both sides; a wider payload
cannot be replayed into a narrower Conservative session.

## What Passive Fidelity preserves

### CSS and cascade

Passive Fidelity keeps bounded, sanitized inline declarations, `<style>`
elements, stylesheet links, custom properties, media/support/container
queries, layers, pseudo-elements, passive fonts and HTTP(S) backgrounds,
same-document `url(#fragment)` references, readable constructed/adopted
stylesheets, and styles inside accessible open shadow roots. Stylesheet element
order, media attributes, disabled state, and the normal cascade remain
representable.

When CSSOM is readable, Simul serializes sanitized rules and recursively
flattens readable imports in order within rule, depth, string, and total payload
budgets. When Chrome makes an imported sheet unreadable, Passive Fidelity may
retain only a normalized HTTP(S) `@import`; that import is request-capable.
Conservative removes imports. Scriptable URLs, CSS `expression()`, `behavior:`,
`-moz-binding`, invalid schemes, and over-budget rule graphs are rejected.

A bounded maintenance signature detects ordinary stylesheet `insertRule`,
`deleteRule`, declaration, disabled-state, media, and order changes that do not
emit DOM mutations. A detected change requests a fresh staged checkpoint while
the last good replica remains visible. Simul does not patch website prototypes.

### Inert HTML semantics

Passive Fidelity can preserve a normalized HTTP(S) anchor `href` so selectors
such as `a[href]` and inert document semantics continue to work. The companion
still disables pointer events, strips targets/download behavior, and prevents
navigation from escaping or replacing the replica.

Responsive `<picture>`, `<source>`, `srcset`, `sizes`, and the browser-selected
image source are retained where they can be represented safely. A video is
retained only when it can carry a sanitized static poster; a posterless shell
is omitted rather than displayed as an empty player. Media source attributes,
controls, autoplay, preloading, and playback are disabled. Frames, objects,
embeds, portals, and webviews remain absent. Forms are inert and cannot submit
or mutate the source page.

Native dropdown popups are browser/OS presentation rather than observable DOM,
so Simul does not attempt to copy their ephemeral geometry. Instead, every
public native select receives a companion-owned, scriptless facsimile: the
selected label remains visible and a bounded disclosure reveals every
translated option and optgroup label. Long lists scroll locally. Disabled,
selected, and multiple state are presentation-only and cannot mutate or submit
the source control. For Chrome customizable selects, `:open` state and
toggle-driven refresh are mirrored progressively; rich website picker
descendants remain reduced to typed public labels at the privacy boundary.

Public, non-editable ARIA listbox/menu/option text remains visible and
translatable. Editable comboboxes, searchboxes, textboxes, contenteditable
regions, native inputs, and any menu branch containing private controls remain
masked. This distinction admits public navigation labels without transporting
user-entered data.

### Static SVG

The bounded static SVG profile includes ordinary geometry and text plus
definitions, gradients, patterns, symbols, same-document `<use>`, clip paths,
masks, markers, and common filters. Same-document references remain local to
the reconstructed SVG.

Passive Fidelity additionally admits normalized passive HTTP(S) references for
SVG `<image>`, `<feImage>`, and external `<use>`. Whether Chrome paints such a
reference is still controlled by normal browser fetch, CORS, MIME, and SVG
resource rules. Scripts, inline handlers, `javascript:` URLs,
`<foreignObject>`, navigation, external embedded documents, and SVG animation
remain blocked. Simul also applies an authoritative `animation: none` and
`transition: none` backstop to reconstructed inline SVG nodes. Passive visual
animation is not enabled in this release.

## Invariants in every policy

Both selectable policies continue to block:

- `<script>`, website custom-element constructors, lifecycle code, and inline
  event handlers;
- `javascript:` URLs and legacy executable CSS;
- navigation, form actions, automatic submission, and source-page mutation;
- frames, objects, embeds, portals, webviews, and media playback;
- request modifiers that add attribution, Topics, or Shared Storage side
  effects, plus base-URL overrides that could externalize local SVG fragments;
- password/private-field transport and unsupported editable values;
- native-select submission values, names, data attributes, datalist content,
  rich picker descendants, and private dropdown ancestry (only bounded visible
  labels and presentation state are eligible); and
- any sandbox weakening, new permission, or remotely hosted executable code.

The iframe remains `sandbox="allow-same-origin"` without `allow-scripts`.
Allowing same-origin access lets extension code inspect and translate the inert
tree; it does not authorize website scripts because no scripts are transported
and the sandbox does not permit execution.

## Diagnostics without page content

`[Simul isolated mirror]` console entries are aggregate diagnostics. They do
not include page text, URLs, tag names, attribute values, pixels, hashes, or
node IDs. Baseline and event counters distinguish:

- stylesheets and SVG resources preserved, flattened, omitted, or blocked;
- blocks caused by execution risk, navigation, an unsupported scheme, browser
  inaccessibility, a capacity limit, or the selected strict resource policy;
- request-capable passive resources; and
- patch/reconciliation stages, retained/replaced node counts, and recovery
  outcomes.

`request-capable` means the reconstructed resource reference could cause Chrome
to make a request. It is deliberately conservative and is not proof that a
request occurred, that it reached the network instead of cache, or that it
succeeded. Conversely, these counters are not a no-network test harness.

## Browser-boundary gaps

Some gaps cannot be fixed by admitting more sanitizer syntax:

- **Opaque source blobs.** A source `blob:` URL belongs to the source page's
  environment. The extension cannot safely reuse it, and it does not always
  have access to the underlying bytes needed to create a Simul-owned blob.
  Such resources are omitted and counted as browser-inaccessible unless a
  separately authorized local pixel/byte path exists. Temporary local blobs
  are not yet a general fallback.
- **Source document mode.** The source's standards-versus-quirks state is
  transported as a validated enum and selects a doctype or doctype-free
  `srcdoc` shell. Chrome's distinct limited-quirks mode is not separately
  represented, so a legacy limited-quirks page can still have different layout
  metrics.
- **Cross-origin CSSOM.** A stylesheet link may render while Chrome's same-origin
  rules prevent Simul from reading its rules. Passive Fidelity can retain the
  normalized link/import, but cannot flatten or inspect inaccessible CSSOM.
- **Computed-style fallback.** Simul intentionally does not serialize every
  computed property. A broad snapshot would be large, slow, privacy-sensitive,
  and likely to freeze responsive cascade behavior. A future fallback must be
  narrowly targeted and independently budgeted.
- **External SVG.** Passive external references are admitted, but Chrome can
  still refuse them because of CORS, MIME type, document policy, or SVG-specific
  fetch rules. The sanitizer cannot override those browser decisions or inspect
  and pause intrinsic animation inside an opaque, non-executable external SVG
  image; the inline reconstructed SVG tree remains static.
- **Browser-managed pixels.** Usable static posters can be represented; the current
  pixels of canvas, video, audio visualization, DRM/protected media, and active
  embedded documents cannot cross the current isolated boundary.
- **Script-owned state.** Closed shadow roots, generated runtime state,
  `ElementInternals`, `:defined` behavior, and virtualized content that does not
  exist in the browser-produced accessible DOM cannot be recreated without
  executing the website, which Simul will not do.

These are product limits, not exceptions that weaken the sandbox. OpenAI.com,
Reddit, Y Combinator, and D-U-N-S are useful manual compatibility checks, but
fixes must remain generic and covered by deterministic fixtures.

## Strict Local Mirror follow-up

Strict Local Mirror remains absent from Settings. Its future spike must:

- remove or neutralize every original `src`, `srcset`, CSS `url()`/`@import`,
  remote font, poster, frame, and external SVG resource reference;
- substitute already-rendered visible images/backgrounds with locally owned
  pixels or temporary Simul `blob:` URLs, capture additional resources lazily,
  and revoke every temporary blob on navigation or teardown;
- add a restrictive extension-origin network backstop while preserving the
  current scriptless sandbox, DOM/layout, and translated text; and
- prove through explicit acceptance tests that the original page can continue
  its normal networking while the Simul replica initiates no requests.

That work must not add `debugger`, `pageCapture`, new host permissions, or MHTML
parsing without separate review and approval.
