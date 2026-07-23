# Currency / Reality Review

## Verdict

**Revise before implementation.** The spine is directionally compatible with the brownfield extension and correctly preserves its strongest security boundary (scriptless, non-navigating replicas), but three high-impact policy seams are internally contradictory or not implementable as written. They must be resolved before this document can safely drive code.

## Review basis

- Compared the spine against `package.json`, `package-lock.json`, `wxt.config.ts`, the current preference coordinator, both replica source bridges, rrweb masking, the image-source protocol, OCR routing, transient storage, offscreen lifecycle, and the existing passive-fidelity contracts.
- Confirmed the project actually uses Node 24, WXT 0.20.27, TypeScript 7.0.2, Vitest 4.1.10, rrweb 2.1.0, Tesseract.js 7.0.0, tesseract-wasm 0.11.0, PaddleOCR.js 0.4.2, and ONNX Runtime Web 1.24.3.
- Checked registry currency on 2026-07-23. WXT, TypeScript, Vitest, Tesseract.js, tesseract-wasm, and PaddleOCR match current published versions. rrweb is published at 2.1.1 and ONNX Runtime Web at 1.27.0, so the spine's versions are accurate project pins but not current upstream releases.
- Confirmed the manifest's real runtime floor is Chrome 138 and that the only optional host grant is `<all_urls>`.

## Critical findings

### C1 — Setup-required state has no safe effective read scope

AD-2 repairs a missing or malformed policy to **Standard**; AD-16 says a missing/outdated setup version merely shows Standard preselected; AD-15 says reset stores feature-off defaults and setup version zero. Those statements do not define a different effective policy while setup is incomplete. Consequently a migrated install or just-reset install can execute Standard reads before the user accepts them, contradicting AD-16's explicit prevention of silent read broadening and AD-15's feature-off reset guarantee.

This is especially material because Standard enables `controlImages` and `disclosureContent`, which are broader than a no-consent pending state. A UI overlay alone is not a policy gate.

**Required fix:** define two separate objects: a persisted/draft choice and an effective runtime scope. While `readScopeSetupVersion` is missing/outdated/zero, effective scope must be a named fail-closed preset (for example `Page only` or an explicitly frozen legacy-compatible scope), regardless of the Standard radio button shown as a draft. Source starts must carry that effective scope. Reset defaults must persist the fail-closed scope, and only successful setup completion may make Standard effective.

### C2 — Standard exposes user choices through `controlSemantics`

AD-3 says Standard withholds current form and personal values, but AD-12 admits `selected` and `checked` state whenever `controlSemantics` is enabled. A selected option, checked radio, or checked checkbox is current user-provided form state and can reveal health, account, consent, or preference data just as clearly as text input. This makes the advertised independent privacy controls false and weakens Standard without saying so.

**Required fix:** keep public label, disabled state, and expanded/collapsed presentation under `controlSemantics`; gate selected option identity and checked/indeterminate state under a separately named `controlState` capability or under `formValues` plus `personalDataValues` classification. Specify how native select display behaves when labels are allowed but current selection is withheld (fixed redaction/placeholder independent of the source value).

## High findings

### H1 — Receiver-side category reconstruction cannot use the classifier AD-4 defines

AD-4 permits the source classifier to use computed `-webkit-text-security`, identifier/label metadata, and local CAPTCHA/password/OTP heuristics while forbidding transport of those inputs. AD-11 nevertheless requires the receiver to independently reconstruct the category using only canonical tag/type/autocomplete/role/ancestry proof. Those information sets are not equivalent, so the receiver cannot prove the same category for custom widgets. A source-provided category enum would validate shape, not independently validate classification.

The current code has two unrelated identity systems—rrweb's recorder mirror IDs and Integrated's `WeakNodeIdRegistry`—so the shared protocol can be engine-neutral, but each receiver still needs an explicitly specified proof model.

**Required fix:** define asymmetric validation. The source classifier may add deny-only evidence using local computed/heuristic facts. Receiver admission must be the intersection of source admission and a receiver-reconstructable, known-safe category from the sanitized base graph; an unprovable custom case remains withheld. Enumerate the exact metadata retained in both base replicas and the exact record-to-node proof for each engine. Do not claim full category reconstruction from data the protocol intentionally omits.

### H2 — OCR fallback rule contradicts the current coordinator behavior

AD-8 says every provider or host failure continues to later methods while existing retry/cache behavior remains intact. In the actual `ImageRecognitionCoordinator`, a second `host-unavailable` returns immediately, and an empty Paddle result breaks the provider loop (`lib/ocr/image-analysis-coordinator.ts`, around lines 270–300). This is the same brownfield behavior implicated by the user's Paddle/Chrome failures.

**Required fix:** make the intentional behavior change explicit. Distinguish provider-scoped failures from shared-host loss; either re-establish the host and continue with a bounded remaining route, or state that a shared-host failure terminates all OCR methods but can still fall through to a later non-OCR semantic method. Remove or justify Paddle's empty-result short circuit. Add ordered-route acceptance tests for `worker-lost`, `provider-unavailable`, `host-unavailable`, empty high-priority output, and a later successful provider.

### H3 — Reset can revoke a permission newly granted after reset began

AD-15 commits defaults and then asynchronously removes the origins returned by Chrome. Today permission requests are made directly from the side panel to preserve the user gesture, outside `PreferenceCoordinator`. A second panel can grant/re-enable access after the reset settings commit but before cleanup removes the earlier origin snapshot. `resetRevision` on preference commands does not serialize Chrome permission mutations, so stale cleanup can remove a newly authorized grant.

**Required fix:** define a reset cleanup epoch for permission operations. Panels must disable/reject permission gestures while that revision is cleaning, and direct permission request flows must re-check committed `resetRevision` before and after Chrome's request. Cleanup must operate on a captured set and abort/reconcile if the revision or owning preferences change. State the failure transition for an interrupted narrowing/reset, not only its happy path.

## Medium findings

### M1 — Source references do not identify all brownfield contracts being renegotiated

The spine cites the canonical passive-fidelity SPEC and architecture, but omits the implemented `_bmad-output/implementation-artifacts/spec-passive-replica-fidelity.md` that records the existing approved guarantee that password/private-field transport remains blocked. The new spine intentionally renegotiates “private field” into narrower secret and selectable categories; that is valid user direction, but the conflict should be explicit in frontmatter/companions and reconciled into project context. The current source list also elevates an unapproved OCR fix draft alongside canonical sources without marking its authority.

**Recommended fix:** add the implemented artifact as a source, mark the OCR draft as evidence/non-authoritative, and identify the exact inherited constraint being replaced. Update `_bmad-output/project-context.md` only after this spine is final.

### M2 — Stack is accurate but omits the real browser floor and upstream-drift decision

The code pins rrweb 2.1.0 and ONNX Runtime Web 1.24.3, while current registry releases are 2.1.1 and 1.27.0. This feature does not require dependency upgrades, but a “verified-current” stack should label these as intentionally retained project pins rather than imply latest. The architecture also says only Manifest V3 even though `wxt.config.ts` requires Chrome 138, which is operationally relevant to TextDetector/offscreen/runtime behavior.

**Recommended fix:** add `Chrome >=138`, pin npm as `12.0.1` (with the supported range in a note), and annotate rrweb/ORT as retained brownfield pins with upgrades explicitly out of scope or decide to upgrade/test them separately.

### M3 — Reset lifecycle methods named by the spine do not exist yet

The current transient input store exposes `put/get/remove/clearExpired`, not clear-all/close, and `OcrOffscreenDocumentManager` exposes only `ensure`, not close. AD-15 is implementable with Chrome 138 but the structural seed does not name these required API extensions or ownership of an in-flight close-vs-ensure race.

**Recommended fix:** add explicit `clearAll()/dispose()` and serialized `close()` seams to the structural seed, specify that pending OCR jobs are aborted before deletion/close, and test reset concurrent with `put`, `ensure`, and recognition retry.

### M4 — Narrowing persistence failure has no state transition

AD-6 purges locally before saving, but the state diagram only shows `Purged -> Committed`. If storage commit fails, the saved broad policy can return on the next panel/service-worker start even though the user just narrowed it.

**Recommended fix:** add a fail-closed `NarrowingFailed` state that keeps the local read gate closed, clearly reports the unsaved state, retries through the coordinator, and prevents automatic recapture under the stored broader scope for that panel. Define what can and cannot be guaranteed after a full browser restart if Chrome storage itself is unavailable.

## Brownfield confirmations

- AD-1 ratifies the existing real boundary: Integrated uses `sandbox="allow-same-origin"`, a CSP with scripts/workers/connections/forms/frames disabled, stripped active attributes, and parent-installed event guards. rrweb presentation is pointer-inert. This is grounded and should remain adopted.
- AD-11's decision to keep rrweb `maskAllInputs: true` and contenteditable masking matches `createLiveRecorderOptions`; a supplement channel is the correct direction if its proof/identity rules are fixed.
- The existing image-source protocol is already exact-document, strict-keyed, content-free at discovery, and split by `rrweb | isolated-html`; adding an explicit semantic evidence request is a natural bounded extension.
- Keeping `accessibility-text` outside `ImageTextProviderId` and the compile-time OCR registry correctly avoids breaking provider asset/runtime checks.
- Resetting one canonical preference object rather than calling `storage.local.clear` matches the repository's single current storage key and is forward-safe.
- No new permission or remote code is required by the proposed design, so it remains compatible with the project's Manifest V3 and local-runtime constraints.

## Gate recommendation

Resolve C1, C2, H1, H2, and H3 in the spine before setting `status: final`. M1–M4 are clear author fixes and should also be incorporated during finalization. No user decision is required: the user's stated priorities already select the fail-closed outcomes above.

## Addendum — Revised spine recheck

### Verdict

**One high issue remains; all previously reported critical issues and the other high issues are resolved.** The revised spine now makes setup-pending Page-only, gates checked/selected state as form data, constrains classification to content-free structural facts, explicitly changes OCR short-circuit behavior, and makes reset cleanup revision-aware.

### Remaining high — Malformed current-version scope still fails open to Standard

AD-2 still says an unknown or malformed policy repairs to Standard. AD-14/AD-16 protect only a missing or outdated `readScopeSetupVersion`. A stored object can therefore retain the current setup version while its scope is absent, malformed, partially written, or from an incompatible schema; parsing it as Standard enables control semantics, control images, and disclosure content even though the architecture labels admission fail-closed.

**Required fix:** a malformed persisted scope must invalidate setup and enforce Page-only (or directly repair to Page-only). Standard may be an uncommitted UI suggestion, never the runtime repair target. Strict command-boundary parsing should continue to reject malformed input rather than repair it. Include the scope schema version in the policy fingerprint and setup-validity check.

No other unresolved critical/high currency or brownfield-implementability issue was found in the revision.

## Addendum — Final high/critical recheck

**Pass.** AD-2 now repairs missing, unknown, or malformed scopes—including malformed data carrying the current schema version—to Page-only, while strict protocol/command parsing remains exact. The policy fingerprint includes schema/setup version, and accessibility-text remains disabled until current setup is committed. No unresolved critical or high currency, brownfield-truth, browser-operational, or implementability issue remains.
