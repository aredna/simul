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

The policy is chosen under **Advanced & experimental** (moved there in D64,
since Passive Fidelity is the default and the truthful choice). Changing it is
saved with the other companion settings and rebuilds Isolated HTML through that
policy. The policy is fixed for the lifetime
of each source/receiver stream and is validated on both sides; a wider payload
cannot be replayed into a narrower Conservative session.

## What Passive Fidelity preserves

### CSS and cascade

Passive Fidelity keeps bounded, sanitized inline declarations, `<style>`
elements, stylesheet links, custom properties, media/support/container
queries, layers, pseudo-elements, passive fonts and HTTP(S) backgrounds,
fonts embedded as base64 data URLs (D72: often large CJK web fonts; they are
inert data the page already loaded), same-document `url(#fragment)`
references, readable constructed/adopted
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
`aria-controls` is ordinary page content while the page paints it, whatever
state the controls carry (D75): a carousel's slide container behind its
previous/next buttons, a slide whose dots are tabs, an open accordion panel.
Until D75 only regions whose every control was stateless qualified, so a
slider whose tab dots were not painted (a bank's homepage) lost every
slide's text. "Painted" means the region's own box is painted and survives its
overflow-clipping ancestors, or, when the region does not clip its own
overflow, one of its painted children does (a carousel track is translated
beside the carousel window while the slide it overflows into is on screen). A
panel collapsed to zero height, faded out or clipped away stays withheld until
a layout change proves it painted; off-screen slides fill in as they come into
view.

When CSSOM is readable, Simul serializes sanitized rules and recursively
flattens readable imports in order within rule, depth, string, and total payload
budgets. These budgets keep the tab and the panel responsive; they do not
protect data. Any one string (a stylesheet, a text node, an attribute value or
a data URL such as an inline image) may be up to 10 MiB; YouTube and freee link
stylesheets of about 3 MB, and Google's sign-in page carries one inline sheet of
700 KB. A page may have up to 200,000 nodes, 256 levels deep, and up to 60 MiB
counted at two bytes per character, because one checkpoint crosses the runtime
port as a single message and Chrome refuses messages above 64 MiB. A stylesheet
over its cap is omitted and the page still mirrors; a page over the total
budget or the node cap is not mirrored (the panel reports that the replica
could not be prepared). These three are **Advanced & experimental** settings:
largest single item (1–30 MB), largest page (1–60 MB) and most page elements
(1,000–1,000,000), with a button that restores the defaults above. Rule caps
follow them. The panel applies them before it opens a mirror and sends them in
the start message, so the page and the panel always use the same limits, and a
change rebuilds the mirror. Reading a page pauses its tab for about a second
per 40,000 nodes. An inline
`<style>` whose rules are read from CSSOM sends those rules once, not its raw
text as well. Chrome's CSSOM cannot write back a shorthand that holds `var()`
once a later declaration in the same rule sets one of its longhands
(`font:var(--f);line-height:2` reads back as empty longhands, and the font is
lost); for such a sheet a `<style>` sends its own text instead, but only when
re-parsing that text gives exactly the sheet's rules, so text a script has
changed through the CSSOM is never used (D83: every Reddit button had fallen
back to the browser's button font). An escaped character in a selector is
part of a name: Tailwind's `.before\:content-\[\'x\'\]` opens no string and
`.bg-\[url\(…\)\]` no function (D83: one such class had rejected Reddit's
whole 237 KB sheet). When Chrome makes an imported sheet unreadable, Passive Fidelity may
retain only a normalized HTTP(S) `@import`; that import is request-capable.
Conservative removes imports. An adopted (constructed) stylesheet is counted
and sent once per message however many shadow roots adopt it, and each further
use costs one index (D84): web components adopt the same few sheets into every
root, and counted per root Reddit's feed turned 0.34 MB of CSS into 23 MB, so a
longer feed stopped updating and a thread could not be mirrored at all.
Scriptable URLs, CSS `expression()`, `behavior:`,
`-moz-binding`, invalid schemes, and over-budget rule graphs are rejected.

The replica frame keeps the source viewport's size, scrollbar included, so the
page lays out at the width it has in the source tab; the panel crops that
scrollbar strip away, and its own scroller is the only one shown (D84).

The replica frame leaves `html` and `body` at the browser's defaults, as the
source has them, so a body sized with `max-width` and auto margins stays centred
and an unreset body keeps its 8px margin. The one exception is font: Chrome
gives every extension-origin document `body { font-size: 75% }` in its system
font, so the replica resets body font to inheritance, and any source rule for
`body` still wins.

A bounded maintenance signature detects ordinary stylesheet `insertRule`,
`deleteRule`, declaration, disabled-state, media, and order changes that do not
emit DOM mutations. A detected change requests a fresh staged checkpoint while
the last good replica remains visible. The signature reads at most 1 MiB of rule
text (25,000 rules) per half-second tick on the page's main thread. A sheet of
more than 4,000 rules or 256 KiB of text is watched by its shape instead: its
rule count and its first and last rules, which is what a script inserting or
deleting rules changes (D88). Before D88 one such sheet took the whole budget,
so a page carrying one (Wise's 2.4 M character design system, freee and
YouTube at about 3 MB) had no polling at all, and rules its scripts added later
never reached the replica: Wise's signed-in side navigation lost its fixed
position. An in-place edit inside a large sheet that keeps its count and ends
still waits for the next checkpoint. Simul does not patch website prototypes.

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

Custom elements keep the page's definition state (D83). Page CSS often
styles `:defined` and `:not(:defined)`: Reddit hides its sort bar, pulses
placeholders and sizes gaps between posts until its elements upgrade. The
page reports each element it has defined, and for each such name the replica
registers an empty class of Simul's own, so those rules match as they do on
the page. No page code runs: the class has no body, the replica's sandbox
still blocks its scripts, and an element the page has not defined stays
undefined in the replica.

Chrome draws its own controls on a video in a frame where scripts are
disabled, and the replica cannot play video, so the frame's shell style and a
Simul-owned style in each replica shadow root hide Chrome's play bar and
overlay play button (D87; Reddit's videos sit inside shadow roots, where a
document rule does not reach). The poster shows as on the page.

Native dropdown popups are browser/OS presentation rather than observable DOM,
so Simul does not attempt to copy their ephemeral geometry. Instead, each
approved public native select receives a companion-owned, scriptless facsimile
in the isolated replica. A single-row select keeps a compact trigger whose
popup flips and clamps inside the replica viewport, scrolls internally, and
repositions when either replica or companion scrolling/resizing moves its
anchor. Like a native select, it opens on click or keyboard (not on hover)
and closes when an enabled option is chosen, on Escape or on an outside click;
the choice is never applied to the source. A menu preview likewise closes when
one of its links, buttons or menu items is chosen, since the page would act on
it. `multiple` and authored `size>1` selects retain bounded inline-list
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

A painted ARIA listbox, menu or option is page content: it keeps its text,
which is translated (D75), and since D88 its styles, inline position, images
and adopted sheets, like any other element. Before D88 it was moved into an
isolated Simul-owned facsimile that cut off the page's styles and stripped
its images and `style` attributes, so Wise's currency list lost its flags and
layout and a menu positioned by its inline style drew in the wrong place. A
collapsed one is withheld until painted like any hidden region, and a
validated dropdown's items travel through the semantic channel. The text of
checkbox, radio, switch and non-editable combobox roles is their label or
current choice, like a button's label, and travels too (D75), as does the
displayed value of a non-editable spinbutton or slider and the result an
`<output>` shows (D76); their checked state and `aria-valuenow` still follow
**Ordinary visible form values**. A shared typed semantic
proof channel enables a local preview in the isolated replica only when a
public activation trigger maps through one unique same-document
`aria-controls` relation to a matching menu, or to a region containing
exactly one matching menu. The preview opens the page's own panel in place,
with the page's styles and position, as a structural menu does (D88; it was
an opaque facsimile popup). The receiver accepts no listbox as a disclosure
panel, since a listbox's selection is control state.

A container holding only a trigger and a collapsed panel is also a menu even
without ARIA roles when it sits inside navigation or a page header, or is
itself a list item (D82; before D82 only inside navigation, and only with a
button or link trigger). The trigger is a button, a link, or plain heading text
(a span, a heading, or an anchor without an href, with no link or button
inside); it may carry its own plain `aria-expanded` (freee's header buttons do)
but no `aria-controls`. The panel is a container, never a single link: a
hidden sibling link is usually the page's mobile-only copy of the heading.
Such a menu opens in place, drawn by the page's own styles where the page
draws it, when the reader hovers its trigger in the replica, and while the
source page shows it. A CSS `:hover` menu changes no DOM on the page, so the
page side reports the panel's painted state and the replica opens it to match.
Content the page fades in once a menu is open (opacity 0 or visibility hidden
until a script adds a class) is shown with it; content hidden with
`display: none`, such as a mobile-only copy, stays hidden. Only the trigger and
an open panel take pointer input. The preview state is extension-owned and
does not send events to the source or rewrite authored source state. Missing,
duplicate, stale, mismatched, editable, or private relations remain
pointer-inert. Editable comboboxes, searchboxes, textboxes, contenteditable
regions, native inputs, and any menu branch containing private controls remain
masked. This distinction admits public navigation labels without transporting
user-entered data. An accessible name (`aria-label`, `title`) or a select's
current choice travels with its control for translation and the dropdown
trigger, but is never drawn as extra text: the source page does not paint it
beside the control. Because nothing shows it, a hidden accessible name is not
translated (D67); option labels and a select's current choice are, since the
dropdown facsimile draws them.

Author-written attributes are page markup and travel with their elements
(D76): `aria-label`, `title` and `alt` (so a stylesheet's `content: attr(...)`
and a broken image's alt text show, untranslated), and `data-*` everywhere,
including inside buttons, menus, text inputs and editable regions (component
libraries such as Radix and shadcn/ui draw a switch's position, a checkbox's
tick and the selected tab from `data-state`). Control state (`checked`,
`selected`, `disabled`, `aria-checked`, `aria-selected`, `aria-pressed`,
`aria-current`, `aria-valuenow`), values and placeholders still come only
from the semantic channel under the read scope. Visibility is decided per
element: a `visibility: visible` child of a `visibility: hidden` parent is
painted and its text travels (D76), while `display: none` still withholds a
whole subtree.

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
  every `cc-*` autocomplete class, hidden inputs, file names and paths, and
  CSS text-security content regardless of the selected readable-content
  profile. A file input is drawn as the empty control the page shows (D75),
  and so is a credential input (D76): a password, card-number or
  one-time-code field keeps its box (`type`, `class`, `style`, `id`, `size`
  and the like) and never its value, placeholder, labels or `data-*`. Any
  other credential region, such as CSS-masked text or a container marked as a
  one-time-code area, is still replaced by an empty opaque shell.
  A node that was a credential stays one for the page's lifetime; only
  explicit evidence counts (an old password type, credential autocomplete or
  inline text-security). Until D75 a class or style that changed twice in one
  observer batch on a region holding a value-bearing control also counted,
  and frameworks do that on every focus and input, and on `<body>` when a
  dialog opens: whole form rows, or the whole page, disappeared. The
  **Show everything (testing)** switch lifts these blocks too (see below);
- native-select submission values, names, data attributes, datalist content,
  rich picker descendants, and private dropdown ancestry (only bounded visible
  labels and presentation state are eligible); and
- any sandbox weakening, new permission, or remotely hosted executable code.

### Show everything (testing)

**Show everything (testing)**, under **Advanced & experimental** (D75), turns
every privacy filter off so a missing part of a page can be traced to a
privacy rule or ruled out. Credential fields, file inputs and CSS-masked text
are drawn as the page draws them; hidden, collapsed and controlled regions,
the text of every control, `<output>`, and the attributes the mirror normally
strips (`value`, `placeholder`, `aria-*`, `data-*`, `title`, `alt`, `open`,
`checked`, `disabled`) travel as the page holds them; the semantic channel
reads at Full visible whatever the read scope, including dates, card numbers
and one-time codes. A typed password never travels: only its dots show, and
the replica shows none. Three attributes stay stripped because the replica's
own dropdown previews set them: `aria-expanded`, `aria-controls` and
`aria-haspopup`, so the replica does not open its own preview of an
ARIA-controlled dropdown while the switch is on (structural menus still
open). The mirror still cannot act on the page: every invariant in the
previous section other than the privacy blocks holds.

Both sides of one mirror use the same setting: the panel applies it before it
opens a session and sends it in the start message, and the page applies it
from there, as with the size limits. Turning it on or off rebuilds the mirror
and drops translations made under the other setting. It is off by default and
kept with the other companion settings.

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

- **Opaque source blobs and origin-locked images.** A source `blob:` URL
  belongs to the source page's environment, and an image the page loads with
  `crossorigin` may be served only to the page's own origin (Fastmail's
  account avatar answers 403 without `Origin: https://app.fastmail.com`).
  Neither loads in the replica. Since D89 the page sends the pixels it has
  already decoded as a data URL: a loaded `blob:` image up to 2048 x 2048
  pixels (WebP past 512 x 512) and a loaded `crossorigin` image up to 512 x
  512 (PNG), each encoded once per address. A canvas the page may not read,
  an image still loading and a larger one keep today's handling; a `blob:`
  CSS background is still omitted and counted as browser-inaccessible.
- **Source document mode.** The source's standards-versus-quirks state is
  transported as a validated enum. A standards page gets the doctype shell
  through `srcdoc`. An `srcdoc` document is always in no-quirks mode (HTML
  parsing rules), so a quirks page's replica is a blank frame into which the
  panel writes the doctype-free shell (D65, found in D60 on Google's 404 page).
  That document is in quirks mode like the source, keeps the same sandbox and
  shell CSP, and takes the panel's URL, the base URL an `srcdoc` shell inherits
  anyway. Chrome's distinct limited-quirks mode is not separately represented:
  such a page reports `CSS1Compat` and gets the standards shell.
- **Cross-origin CSSOM.** A stylesheet link may render while Chrome's same-origin
  rules prevent Simul from reading its rules. Passive Fidelity can retain the
  normalized link/import, but cannot flatten or inspect inaccessible CSSOM.
- **Shorthands CSSOM cannot write back.** A rule in an adopted (constructed)
  or linked sheet whose `var()` shorthand Chrome reads back as empty longhands
  loses that shorthand in the replica; only a `<style>` element has its own
  text to fall back on (D83). On Reddit this leaves the buttons inside its
  shadow roots ("Join", the sort and share buttons) in the browser's button
  font. Repairing an adopted rule from an identical rule in a `<style>`
  element's text was planned for D87 but not done: it could not be measured,
  because Reddit's archived pages no longer run their scripts here.
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
  `ElementInternals` and custom states, and virtualized content that does not
  exist in the browser-produced accessible DOM cannot be recreated without
  executing the website, which Simul will not do. Definition state is the
  exception: it is carried as a flag and matched with empty Simul-owned
  classes (D83).

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
