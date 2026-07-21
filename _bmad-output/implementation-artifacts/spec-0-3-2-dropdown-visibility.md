---
title: '0.3.2 dropdown visibility'
type: 'feature'
created: '2026-07-21'
status: 'complete'
baseline_commit: '2fde1c8dee0b022bae9846d25c292d44f34c4bf5'
context:
  - '_bmad-output/project-context.md'
  - '_bmad-output/implementation-artifacts/spec-0-3-1-compatibility-repair.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Native select popups are browser/OS chrome rather than observable DOM, while Simul's read-only replicas cannot open native controls. The visual engine also omitted native option children, and broad ARIA privacy rules hid public menu labels.

**Approach:** Transport only typed native option/optgroup labels and presentation state, render companion-owned scriptless expandable facsimiles in both engines, admit public non-editable ARIA menu content while retaining editable-control privacy, and progressively mirror Chrome customizable-select open state without popup geometry.

## Boundaries & Constraints

**Always:** Keep the replica script-disabled, sandboxed, read-only, and unable to mutate the source or submit forms. Keep passwords, editable comboboxes, searchboxes, textboxes, contenteditable values, raw option values, names, data attributes, URLs, and form semantics private. Bound option text, nodes, list height, and protocol state. Preserve selected, disabled, multiple, and optgroup presentation. Route every public label through normal translation and caching.

**Never:** Add `allow-scripts`, site JavaScript, `innerHTML`, data-bearing `srcdoc`, native-popup geometry capture, real replica selection changes, new permissions, or rich website dropdown descendants.

## Acceptance

- Native selects show selected labels and reveal all translated options/optgroups through companion-owned scriptless UI; long lists scroll.
- Both Isolated HTML and visual/PageSnapshot paths preserve selected, disabled, and multiple presentation without transporting form values.
- Public ARIA listbox/menu/option labels translate; editable combobox/searchbox/textbox/contenteditable data remains blank.
- Customizable selects propagate bounded `:open` state and toggle/beforetoggle-driven refresh while universal facsimiles remain the fallback.
- Sanitizer fixed-point, budget, sandbox/CSP, full test, and unpacked-artifact gates pass.

</frozen-after-approval>

## Tasks

- [x] Harden typed select source/protocol/receiver grammar and live insert/update handling.
- [x] Add the Isolated HTML expandable facsimile and translation projection.
- [x] Add PageSnapshot capture and visual-renderer disclosure facsimile.
- [x] Split public ARIA menu roles from editable/private roles.
- [x] Complete visual live-delta and customizable-select open-state parity.
- [x] Update docs/version/artifact and pass full validation plus adversarial review.
