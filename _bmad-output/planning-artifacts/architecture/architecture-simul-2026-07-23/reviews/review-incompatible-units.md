# Adversarial Review — Incompatible Units and Security/Data Integrity

## Verdict

**Revise before implementation.** The action firewall remains coherent, but the proposed selectable read policy cannot currently compose with the two base replica streams: several supposedly optional categories already enter those streams before the semantic supplement channel is consulted. Four other high-risk ambiguities would produce privacy-visible divergence between profiles, engines, upgrades, and interrupted resets.

## Critical

### C1 — Optional read categories already cross the base streams

**Conflicts:** AD-2, AD-3, AD-5, AD-11; Structural Seed.

AD-11 adds a policy-authorized semantic supplement while leaving the base rrweb and Integrated streams merely “conservatively sanitized.” That is not an admission boundary for all six capabilities. In the current brownfield code:

- rrweb masks input values and contenteditable text, but its full snapshot still observes and sends ordinary text under controls and collapsed/hidden disclosure subtrees;
- `RrwebStreamSanitizer` sanitizes the stream but has no `ReplicaReadScope`;
- Integrated serializes ordinary DOM text regardless of disclosure visibility and currently reads select state and `controlText` in `sanitizeSourceElementHints`;
- visible control labels and state can therefore arrive while `controlSemantics` or `disclosureContent` is false.

A supplement can add authorized evidence, but it cannot retroactively make evidence already present in a base stream “not read.” This also makes rrweb and Integrated differ because their existing private/control handling is not identical.

**Required fix:** Define one policy-independent *minimum base stream* that source-side adapters must emit and enumerate exactly which categories it excludes. All optional control semantics/state, disclosure subtrees, values, editable text, and related accessibility attributes must be masked/omitted before transport and reintroduced only through policy-bound supplements. If control labels or collapsed DOM text are intentionally always part of “Page only,” say so explicitly and remove the contradictory capability claim. Bind each engine-specific source stream start to the policy fingerprint/epoch, even if the recorder can share the same maximally restricted raw baseline.

## High

### H1 — `controlSemantics` leaks current state that the value controls claim to withhold

**Conflicts:** AD-3, AD-5, AD-12.

Standard is said to withhold current form and personal values, yet AD-12 admits `selected`, `checked`, and `expanded` state under `controlSemantics`. A selected option label is the current select value; a checkbox/radio state can reveal a health, identity, or consent choice; and state can be personal even when its public label is not. The six booleans do not let a user independently admit public labels while withholding current control state.

**Required fix:** Split static control semantics from current control state (for example, add `controlState`) or route every state through the existing value gates. At minimum, selected option text and slider/value semantics must require `formValues`, plus `personalDataValues` when classified personal. Enumerate the exact mapping for checked/selected/expanded/disabled and all three presets.

### H2 — Upgrade/setup repair can silently broaden reads before consent

**Conflicts:** AD-2, AD-3, AD-7, AD-16.

AD-2 repairs unknown/malformed policy to Standard; AD-7 inserts enabled accessibility text first by default; AD-16 says a missing/outdated setup version displays Standard preselected and must not silently broaden reads. The effective policy while setup is incomplete is not defined. On an existing installation, repair-to-Standard plus an already-enabled image feature can begin semantic image reads before the user completes setup. “Page only” is also not mapped to exact booleans.

**Required fix:** Make incomplete/outdated setup a hard runtime gate with an explicitly enumerated safe effective scope (normally Page only/all optional capabilities false), regardless of stored/repaired draft values. Treat Standard only as an uncommitted UI selection. Define migration of the legacy OCR order so adding `accessibility-text` does not activate it until setup is committed, and define exact preset matrices.

### H3 — Reset is not resumable after the commit boundary

**Conflicts:** AD-14, AD-15, AD-17.

The design commits `resetRevision`, then performs permission, IndexedDB, cache, panel, and offscreen cleanup. If the MV3 service worker is suspended or the response is lost after the settings write, a retry carrying the old expected revision is rejected. No persisted operation identity or cleanup phase lets the caller resume. Startup reconciliation mentions orphan origins only, not transient pixels, offscreen state, or other cleanup, so “cleanup failures remain retryable” is not enforceable.

**Required fix:** Persist an idempotent reset operation/cleanup-pending marker with the new revision, accept retries for that operation, and clear the marker only after every cleanup owner reports success. Startup must resume every pending cleanup phase, not only optional-origin removal. Define partial-result querying so a lost response cannot strand the caller.

### H4 — Disclosure validation is security-critical but undefined

**Conflicts:** AD-5, AD-10, AD-12, AD-13.

“Validated visible disclosure/menu relationship” has no enforceable definition. A page-controlled `aria-controls` can point at any hidden subtree, including unrelated account data or a credential widget. The spine does not specify same-tree/root constraints, ownership cardinality, which hidden mechanism is permitted, whether `aria-owns` participates, target mutation/replacement handling, subtree limits, or how the hard-secret classifier is applied recursively before any target text is accessed. Different adapters can therefore admit different content, and a renderer-owned disclosure can expose content never represented by a legitimate source disclosure.

**Required fix:** Specify an exact validation algorithm and a typed proof: visible admitted trigger; same exact document/root; bounded single target with a unique sanitized ID; allowed source role/state combinations; target hidden only by an allowlisted disclosure mechanism; no arbitrary ancestry crossing; bounded subtree/depth; recursive secret/private admission before reads; revision invalidation on trigger/target/relationship mutation. Invalid relationships must render as inert static content and transport no hidden supplement.

## Medium

### M1 — Cross-engine supplement identity is under-specified

rrweb nodes use the recorder mirror’s IDs while Integrated nodes use `WeakNodeIdRegistry`; those IDs are not interchangeable. AD-11’s “one channel” and receiver-side reconstruction need a bridge discriminator, bridge-scoped identity namespace, and an explicit join to the engine’s committed graph. A receiver cannot independently reconstruct secret category from a sanitized graph if the facts needed for classification were stripped; it can only validate a source-classified, exact-schema record. Define what is independently verified and never describe page-authored metadata as a proof of truth.

### M2 — Image fallthrough conflates terminal policy denial with method-local absence

AD-7 says `blocked` evidence falls through, while AD-10 says policy and hard-secret gates also return blocked outcomes at read time. A later OCR method must never retry a hard-secret or disabled-`controlImages` denial. Use distinct terminal statuses (`secret-blocked`, `scope-blocked`) versus method-local `none`/`unsupported`; only the latter may continue. Clarify that “control-only” rejection means Unicode control-character-only text, not an image used as a control, or the target navigation-button case will be rejected.

### M3 — Narrowing failure behavior is incomplete

AD-6 purges the initiating panel before persistence but does not define what happens if the commit fails or another panel remains on the old revision. Specify that the local gate remains narrow after failure, old-epoch results stay rejected, other panels converge only from a successful committed revision, and the UI reports the durable/local mismatch without automatically restoring broader data.

## Confirmed Strengths

- The permanent separation between readable evidence and action authority is the right top-level boundary.
- Keeping rrweb input/contenteditable masking permanently enabled and using supplements for explicitly admitted current data is safer than weakening recorder masking.
- Source-side classification before value access, fixed-length credential facsimiles, exact-document epochs, and content-free diagnostics are sound constraints.
- Reset’s safety ordering—disable features before permission cleanup—is correct once cleanup becomes resumable.

## Gate Recommendation

Autofix C1 and H1–H4 in the spine before deriving implementation specs. Fold M1–M3 into the same rules because they determine protocol shape and runtime tests; none should be deferred to implementation judgment.

---

## Recheck Addendum — Revised Spine

### Verdict

**Still revise before implementation: one critical and two high issues remain.** The revision resolves current-control-state gating, setup-version gating, disclosure validation, narrowing coordination, and resumable reset cleanup. The remaining issues are narrower but still determine whether the source admission boundary is real.

### Critical — C1 remains partially unresolved

AD-11 now excludes optional current values, state, and disclosure payloads from both base streams, but it does not exclude the other optional evidence named by the spine: public control labels under `controlSemantics` and direct `alt`/`aria-label` strings under the disableable `accessibility-text` method. AD-12 says public labels are transported only when `controlSemantics` is enabled, yet an ordinary control's child text can still be ordinary base-stream text. Likewise, an image's alt text can remain in the base replica even when the accessibility method is disabled. A Page-only profile or disabled method therefore still cannot guarantee those strings were not read.

**Required fix:** AD-11 must say that the minimum base streams omit *every optional category*, explicitly including control-owned public labels and accessibility image strings, and that those return only through their policy/method-bound channels. Alternatively, ratify them as always-on page content and remove the contradictory switches. Add allow/deny base-stream tests for both engines.

### High — “Fail closed” still repairs malformed policy to Standard

AD-2 still repairs unknown or malformed scope data to Standard, which enables three capabilities. AD-14/AD-16 protect only missing or outdated setup versions; corruption or a forward-incompatible object with a current setup version can broaden a Page-only/Custom installation. That contradicts AD-2's fail-closed title and the non-broadening guarantee.

**Required fix:** malformed/unknown scope must have effective Page-only and require a fresh setup/repair commit (or preserve a separately authenticated last-known scope). Standard may remain an uncommitted UI suggestion, never the effective repair value.

### High — Shared semantic records still lack an engine-scoped join identity

AD-11 carries document/node/revision/policy identity but no bridge/engine identity. rrweb node IDs come from the recorder mirror; Integrated IDs come from `WeakNodeIdRegistry`, so equal integers do not denote equal nodes. “Used by both engines” is unsafe unless every record is scoped to one bridge namespace and joined to the same engine's committed graph. The current receiver rule validates category/shape but does not require the target node's committed canonical tag/type/role facts to agree where those facts are available.

**Required fix:** include a strict bridge/engine namespace (or guarantee a fresh engine-bound generation) in the session and every record; reject cross-bridge records; require the receiver to join to an existing committed node and compare all independently available canonical facts before projection. State explicitly that source classification is trusted extension logic, while page-authored metadata is evidence rather than cryptographic “proof.”

### Resolved at Critical/High Severity

- Current selected/checked/expanded data is now routed through explicit value/disclosure gates.
- Missing/outdated setup now enforces Page-only before user commitment.
- Disclosure admission now requires a unique, bounded, same-document collapsed relationship and excludes secret/form-value intersections.
- Tightening now coordinates purge acknowledgements/lease revocation.
- Reset now persists a cleanup-pending revision and resumes cleanup after background restart.

---

## Final Critical/High Recheck

### Verdict

**Pass — no unresolved critical or high findings.**

The final revision closes the remaining admission-boundary defects:

- both base streams now explicitly omit optional current/state/disclosure evidence and attribute-backed control/image labels, while defining already-visible text nodes as the always-public Page-only baseline;
- missing, unknown, malformed, and current-version-corrupt scope data now repairs to Page-only;
- semantic records now carry a strict bridge identifier and bridge-scoped node identity, resolve through that bridge, and are bounded by field, batch, pressure, and live-node limits;
- accessibility-text migration stays runtime-disabled until current setup is committed.

The earlier critical/high findings are therefore resolved at architecture altitude. Remaining implementation details are covered by the spine's exact parsing, epoch rejection, bounded-channel, hard-secret, and paired security-test conventions; none presently requires another architectural decision at critical/high severity.
