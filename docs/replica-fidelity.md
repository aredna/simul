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
representable. A `<style>` element inside a hidden or controlled disclosure
region keeps its CSS (those rules are often what hides the region); only the
region's page text is withheld. Inside a privacy boundary (for example an
editable `role="textbox"` region) the page text is withheld too; under Passive
Fidelity the `<style>`'s rules still travel, read from CSSOM, because they are
presentation rather than page content, while Conservative withholds that
`<style>`'s text with the region. Whether
a region is hidden is decided by computed style and geometry: content a script
declares `hidden` or `aria-hidden` but the stylesheet paints anyway is ordinary
page text. "Paints" means a positive box that is not at zero opacity, not
skipped by `content-visibility: hidden` (which is how Chrome renders
`hidden="until-found"`), and not cut away by `clip` or `clip-path`; unreadable
style keeps the declaration. A region that controls reference with
`aria-controls` but never collapse or select is ordinary page content too: a
carousel's previous/next buttons carry no `aria-expanded`, `aria-selected`,
pressed, checked or popup state and are not native controls or tabs, so the
slide container they control keeps its text and images. That holds only while
the region's own box is painted and survives its overflow-clipping ancestors,
or, when the region does not clip its own overflow, while one of its painted
children does (a carousel track is translated beside the carousel window while
the slide it overflows into is on screen): a stateless "Show details" button
that controls a panel collapsed to zero height, faded out or clipped away
leaves the panel withheld until a layout change proves it painted. A controlled region is also withheld while a stateful
control references it and no unique tab relation proves it open.

When CSSOM is readable, Simul serializes sanitized rules and recursively
flattens readable imports in order within rule, depth, string, and total payload
budgets. One stylesheet may carry up to 1 MiB of text (large sites ship a single
inline sheet of several hundred kilobytes); other strings stay within 512 KiB.
An inline `<style>` whose rules are read from CSSOM sends those rules once, not
its raw text as well. When Chrome makes an imported sheet unreadable, Passive Fidelity may
retain only a normalized HTTP(S) `@import`; that import is request-capable.
Conservative removes imports. Scriptable URLs, CSS `expression()`, `behavior:`,
`-moz-binding`, invalid schemes, and over-budget rule graphs are rejected.

The replica frame leaves `html` and `body` at the browser's defaults, as the
source has them, so a body sized with `max-width` and auto margins stays centred
and an unreset body keeps its 8px margin. The one exception is font: Chrome
gives every extension-origin document `body { font-size: 75% }` in its system
font, so the replica resets body font to inheritance, and any source rule for
`body` still wins.

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
embeds, portals, and webviews remain absent. Forms cannot submit or mutate the
source page: the frame sandbox omits `allow-forms`, the shell CSP sets
`form-action 'none'`, and the document-wide activation guard blocks every
activation event. A form is not marked `inert`, because that would also block
Simul's own dropdown facsimiles inside it, where most real select boxes sit.

Native dropdown popups are browser/OS presentation rather than observable DOM,
so Simul does not attempt to copy their ephemeral geometry. Instead, each
approved public native select receives a companion-owned, scriptless facsimile
in the isolated replica. A single-row select keeps a compact trigger whose
popup flips and clamps inside the replica viewport, scrolls internally, and
repositions when either replica or companion scrolling/resizing moves its
anchor. `multiple` and authored `size>1` selects retain bounded inline-list
presentation. Labels and disabled/shape semantics are independent from the
selected state: the latter appears only when ordinary form state is enabled.
Every admitted state is presentation-only and cannot mutate or submit the
source control. No source clipping ancestor is rewritten. A select at zero
opacity that still takes pointer input over a rendered box is the page's click
target for a label the site draws beneath it (Wikipedia's search language
picker); it counts as visible, keeps its box and option labels, and its
facsimile trigger is transparent so the site's own label shows through while
the options panel opens opaque. For Chrome
customizable selects, `:open` state and toggle-driven refresh are mirrored
progressively; rich website picker descendants remain reduced to typed public
labels at the privacy boundary.

Public, non-editable ARIA listbox/menu/option text remains visible and
translatable when the matching read scope is enabled. A shared typed semantic
proof channel enables a local preview in the isolated replica only when a
public activation trigger maps through one unique same-document
`aria-controls` relation to a matching menu/listbox, or to a region containing
exactly one matching public menu. Inside navigation, a container holding only a
trigger and a collapsed panel of public links is also a menu even without ARIA
roles; its trigger may carry its own plain `aria-expanded` (freee's header
buttons do) but no `aria-controls`. An opened preview is forced opaque and
drawn on a plain canvas background. The preview state is extension-owned and
does not send events to the source or rewrite authored source state. Missing,
duplicate, stale, mismatched, editable, or private relations remain
pointer-inert. Editable comboboxes, searchboxes, textboxes, contenteditable
regions, native inputs, and any menu branch containing private controls remain
masked. This distinction admits public navigation labels without transporting
user-entered data. An accessible name (`aria-label`, `title`) or a select's
current choice travels with its control for translation and the dropdown
trigger, but is never drawn as extra text: the source page does not paint it
beside the control. Such hidden accessible names are still sent for
translation even though nothing shows them (except option labels and the
current choice, which the dropdown facsimile displays); skipping that work is
open.

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
- passwords, password/authentication autocomplete, one-time codes, WebAuthn,
  every `cc-*` autocomplete class, hidden/file inputs, file paths, and CSS
  text-security content regardless of the selected readable-content profile
  (a class or style that changes twice within one observer batch on a region
  that holds a value-bearing control, such as a native input, select or
  textarea, editable text, or a text-entry, checked or selected role, is
  treated as a possible masking transition and that region stays a credential
  secret for the page's lifetime; a region that holds only activation
  controls, such as links, buttons, tabs and menu items, is ordinary content,
  so a carousel's slides and bullets keep their text and images through every
  move);
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
- **Source document mode (open gap, to fix).** The source's
  standards-versus-quirks state is transported as a validated enum and selects
  a doctype or doctype-free shell, but the shell is loaded through `srcdoc`,
  and an `srcdoc` document is always in no-quirks mode (HTML parsing rules), so
  a quirks-mode page renders in standards mode in the replica. Found in D60 on
  Google's 404 page, which has no doctype. Quirks rules that differ (for
  example percentage heights, table font inheritance, body sizing) can
  therefore lay out differently. Loading the quirks shell another way, such as
  writing the doctype-free shell into a blank frame, would close the gap.
  Chrome's distinct limited-quirks mode is not separately represented either.
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
