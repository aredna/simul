<!-- Converted from the review page published on 2026-09-03 (https://claude.ai/code/artifact/a7dde2d3-b6fd-4855-b435-7a08598fe473) so the findings live in the repository. Line references are against commit 2fde1c8 and the working tree of that day; see the decision log for what was fixed and D28 for how each finding maps onto origin/main. -->

Code review · Simul 0.3.0 · Chrome MV3 · 3 September 2026

# Simul Extension Review

The committed release is healthy and the privacy architecture holds up under a hostile-page reading. The uncommitted working tree does not build, the shipped scroll sync is broken for a now-understood reason, and a handful of state and sanitizer bugs are worth fixing before the next release.

Committed HEAD · 2fde1c8

- **687 / 687** tests pass
- **passes** artifact check, byte-for-byte against `dist/chrome-unpacked`
- **37.6 MiB** unpacked size, under the 42 MiB gate
- **broken** scroll following in the shipped build (B2)

Working tree · 154 files changed, uncommitted

- **55 / 693** tests fail (B1, B3)
- **fails** artifact check, wrong bundle checked for markers (B1)
- **45.7 MiB** fresh build, over the gate from stray files (B4)
- **passes** typecheck with TypeScript 7

## Read first

Five things that shape everything below.

**Your working tree is inconsistent, not your design.** Every failing test and the failing artifact check trace to three uncommitted edits plus three stray files. The committed HEAD passes its own full gate in a clean install. Fix the four blockers, run `artifact:sync`, and commit.

**The scroll regression you logged has a root cause.** The committed observer is injected with `executeScript({ func })`, but its scroll handler calls four helpers imported from `primary-scroll.ts`. Only the function body is serialized, so in the page those names do not exist. In the shipped chunk they are the minified identifiers `gt`, `pt`, `ft`, `Lt`, and `ht`. Every scroll event throws and no scroll message is ever sent. Your bundled `page-live-observer.js` bridge is the right fix.

**The default engine has two sanitizer gaps worth closing.** Colon-prefixed tag names slip past every tag-keyed rule and are materialized as real element classes, and camelCase SVG elements are lowercased into unknown elements, so gradients, clip paths, and filters are dead in the replica. Both are bounded by the sandbox, but both contradict documented invariants.

**The side panel has one high-impact race.** A live commit that lands while the initial availability check is in flight leaves Translate permanently disabled until a manual rebuild. It needs a page that mutates after load and From set to Auto-detect, which is the default.

**The rrweb engine should be quarantined.** Running in the isolated world it cannot see page-script CSSOM changes, it cannot converge on pages that mutate every frame, and its CSS sanitizer has an `@import` bypass. It is experimental and off by default, but it ships 151 KB of injected script and two dependencies for an engine that cannot be made correct inside the privacy model.

## Fix before anything else

These break the working tree's build or the shipped release. All four were reproduced in a clean install on this machine.

### B1 · Blocker · Artifact checker reads the wrong bundle after the required-bundle list grew

*Verification: Reproduced.*

Where: `tools/extension-artifact.mjs:38` · `:349` · `:355`

The uncommitted change prepends `page-live-observer.js` to `REQUIRED_UNLISTED_BUNDLES`, but `assertReplicaRuntimeMarkers` still indexes `[0]` for the recorder marker and `[1]` for the mirror marker. It now looks for the rrweb capture marker inside the live observer and the HTML mirror marker inside the recorder.

**Fails when** any build or test runs. 54 tests in `tests/extension-artifact.test.mjs` fail and `artifact:check` rejects the fresh build with "missing required local replica runtime marker: simul:replica-v2:capture-checkpoint".

**Fix** Key the marker checks by bundle name rather than array position, and add the live-observer marker check that the new constant at `:48` implies but nothing enforces.

### B2 · Blocker · Shipped 0.3.0 scroll following throws on every scroll event

*Verification: Reproduced in dist chunk.*

Where: `lib/live-page-mirror.ts:428-507` (HEAD) · `entrypoints/sidepanel/main.ts:1660` (HEAD) · `dist/chrome-unpacked/chunks/sidepanel-DYrc7WGu.js` offset 34178

`installLivePageObserver` is passed by reference to `scripting.executeScript`. Its `onScroll` handler and the frame callback call `isDocumentScrollTarget`, `readNestedScrollSnapshot`, `readDocumentScrollSnapshot`, `nestedScrollerOrdinal`, and the module-level `sameScrollPosition`. Installation succeeds because those are only referenced inside listeners, so the mirror looks fine and the failure is silent.

**Fails when** the user scrolls the source page with Follow source scrolling on. The replica never moves. This matches the 0.2.7 report in the BMAD memlog.

**Fix** Your uncommitted bridge is correct: bundle the observer as `page-live-observer.js` and invoke it through a closure-free global. The two `invoke*Bridge` helpers are closure-free as written. Add a regression test that evaluates each function passed to `executeScript({ func })` via `Function.prototype.toString` in a bare context so this class cannot return.

### B3 · Blocker · Privacy-policy change silently widened OCR pixel capture

*Verification: Reproduced.*

Where: `lib/replica/source-privacy-policy.ts:241-249` · `tests/image-source-session.test.ts:99-106`

The uncommitted edit removed `select` from the private tag set and dropped the `isSourcePrivateTagName` check from `hasSourcePrivateOrActivationElementAncestor`. A plain `<input>` is an eligible text control, so it no longer counts as a private region. An image overlapping any text, search, email, URL, or telephone field is now captured and sent to OCR.

**Fails when** the capture-safety test runs. It expects `hasSafeCaptureGeometry` to return false for an image overlapped by an input and now gets true.

**Fix** Decide the policy deliberately. If eligible text controls are meant to be capturable because their text is already readable, update the test and the README sentence about private controls. If not, keep the select change but restore the input rule for pixel capture. Either way, widen the private set to `autocomplete` tokens `cc-*` and `one-time-code` (see M15).

### B4 · Blocker · Three untracked .wasm files push the build over the size gate

*Verification: Reproduced.*

Where: `vendor/ocr/tesseract/core/*.wasm` (untracked, 8.6 MB) · `wxt.config.ts:56` · `tools/extension-artifact.mjs:33` · `:176`

The vendored `.wasm.js` loaders already embed the cores as base64, which is why `vendor-tesseract.mjs` never emits separate `.wasm` files and the asset manifest does not list them. The three copies sitting in `vendor/` are picked up because `publicDir` is `vendor`, so a fresh build is 47.96 MB, above the 42 MiB gate, and `.wasm` is a forbidden extension in the checker.

**Fails when** B1 is fixed and the checker reaches the size and asset-drift checks. Also affects `npm run build` and `npm run zip` today.

**Fix** Delete the three files and add `vendor/ocr/tesseract/core/*.wasm` to `.gitignore`. Consider copying only manifest-listed files in a build hook so stray vendor content can never ship.

## High severity

Wrong behavior a user or a hostile page can reach in the default configuration, or an engine-level defect that cannot be fixed locally. Each was verified against the source in this review.

### H1 · High · Availability result is discarded by a live commit, leaving Translate disabled for the session

*Verification: Verified.*

Where: `entrypoints/sidepanel/main.ts:2146-2208` · `:1966-1975` · `:2047-2079` · `:4257-4275`

`checkAvailability` records `availabilityCheckedForPair` and sets `availability` to unavailable before it awaits the provider. The result is kept only if `snapshot` is still the same object. But `resolveSelectedSourceLanguage` spreads `snapshot` into a new object on every call with a live context, and the post-commit reconcile calls it for any text change when From is Auto-detect. After the result is dropped the pair key already matches, so `needsPreparation` is false and the check never reruns.

**Fails when** a page with any post-load DOM text change (feeds, timers, ads) is opened with default preferences. The status stays "Building the initial live read-only mirror…", Translate stays disabled, automatic translation never fires. Recovery needs Rebuild or a language change.

**Fix** Signal a language refresh with a revision counter instead of replacing the snapshot object, and set `availabilityCheckedForPair` only after the result is accepted.

### H2 · High · Colon-prefixed tag names bypass every tag-keyed rule and become real elements

*Verification: Verified.*

Where: `lib/replica/html-mirror-sanitizer.ts:3615-3619` · `:1182` · `:3157-3163` · `lib/replica/isolated-html-engine.ts:1012`

`isSafeTagName` admits `:`. The source sends `localName` unchanged, and `isUnsafeElement`, the meta and link rules, and the style-region detection all compare the whole string. The receiver then calls `createElementNS(XHTML, "x:iframe")`, which by QName rules yields prefix `x` plus local name `iframe`: a real `HTMLIFrameElement`. The same applies to `x:script`, `x:style`, `x:meta`, and `svg:animate`.

**Fails when** a page contains `<x:style>@import url(https://…)</x:style>`: its text is never run through `sanitizeCss` and lands in a real style element. `<svg:animate>` runs SMIL, which the docs say stays blocked. `<a:b:c>` passes the regex but makes `createElementNS` throw, which fails the run and disables Isolated HTML for the companion's lifetime via `engine-selection.ts:118-131`. Script execution is still stopped by the sandbox and CSP.

**Fix** Reject `:` in tag names on both sides, or create elements with `createElement` so unknown names stay `HTMLUnknownElement`. Do not disable the engine for a single failed patch.

### H3 · High · camelCase SVG elements are lowercased into unknown elements

*Verification: Verified.*

Where: `lib/replica/html-mirror-sanitizer.ts:1182` · `:398` · `:3198-3216` · `lib/replica/isolated-html-engine.ts:1012` · `:1122`

The source lowercases `localName`, the allowlist contains `lineargradient` and `clippath` in lowercase, and the receiver calls `createElementNS(SVG_NS, "lineargradient")`. Chrome's SVG element factory is case-sensitive, so the result is a generic `SVGElement`. Only attribute names have a case map (`SVG_CASE_SENSITIVE_ATTRIBUTES`); element names have none.

**Fails when** any inline SVG uses `linearGradient`, `radialGradient`, `clipPath`, `feGaussianBlur`, `feColorMatrix`, or `textPath`. Paint servers, clips, and filters resolve to nothing in the replica. This contradicts the fidelity document's list of preserved SVG features, and the linkedom-based tests cannot catch it.

**Fix** Add one shared canonical SVG element-name map used by both sides, and add a real-Chrome smoke test for element factories.

### H4 · High · rrweb engine: three defects that make it unfit to ship as selectable

*Verification: Experimental engine · code-read.*

Where: `lib/replica/protocol-v2.ts:911-978` · `:1122-1130` · `lib/replica/rrweb-stream-sanitizer.ts:477-521` · `lib/replica/page-recorder.ts:112-113` · `lib/replica/live-recorder-session.ts:156-165` · `:436-451`

**Import bypass.** The sanitizer closes its `@import` window on any at-rule, including an invalid one like `@foo;`, but Chrome discards invalid at-rules without closing the window. A style text node added after connect can carry `@foo; @import "\68ttp://evil/x.css";`. `sanitizeCssString` is a raw regex that does not decode CSS escapes, and the topology reader never rejects a `CSSImportRule`. The extension-page CSP has no `style-src`, so the frame fetches and applies the sheet.

**CSSOM blindness.** rrweb patches `CSSStyleSheet.prototype` in the content-script world. Main-world CSS-in-JS (emotion, styled-components speedy mode, MUI, `replaceSync`) never fires those patches, so styles for anything mounted after the checkpoint are lost until the next full snapshot.

**Non-convergence.** After a checkpoint the recorder tolerates four unacknowledged batches before forcing another full snapshot. Checkpoint application on the panel takes far longer than four frames on a real page, so any page that mutates every frame reserializes its whole DOM indefinitely. The per-add sanitizer is also quadratic (`rrweb-stream-sanitizer.ts:480`).

**Fix** See recommendation 3. If it stays, neutralize `@import` at brace depth zero regardless of position, decode escapes, reject import rules, and add `style-src` and `font-src` to the extension CSP.

## Medium severity

Wrong behavior in reachable but narrower situations, or performance problems that show on real pages. Grouped by area.

#### Side panel and launch

### M1 · Medium · Detached window loses a pending navigation refresh on focus change

*Verification: Verified.*

Where: `entrypoints/sidepanel/main.ts:906-916` · `:934-968` · `:1554-1600` · `:4020-4030`

`onFocusChanged` and `followActivatedSourceTab` bump `identityRequestId` and clear the navigation timer before validating the target, and the same-page early return never re-queues a capture. A source navigation while the companion is focused sets `followedPageIdentity` to the new URL and arms a 350 ms timer. Focus moving to the source window inside that window clears the timer, then the same-page check compares new URL to new URL and returns.

**Fails when** that timing lines up in Active browser tab mode. The old snapshot stays, live updates are rejected because the generation was invalidated, and status reads "The source page is changing…" until Rebuild.

**Fix** Validate before side effects, and in the same-page branch queue a capture when `capturedPageIdentity.url` differs from the followed URL.

### M2 · Medium · Hash and pushState changes are treated as full navigations

*Verification: Code-read.*

Where: `entrypoints/sidepanel/main.ts:934-968` · `:1602-1627` · `:4497-4508`

Any `changeInfo.url` aborts translation, drops `translationDesired`, releases the replica, resets scroll, and rebuilds, even though `normalizedPageUrl` and `sameCompanionSourcePage` treat hash and query as the same page.

**Fails when** a docs site updates `#section` from scroll-spy or a tab bar changes `?tab=`. The user's in-flight translation is aborted and the page rebuilds untranslated on every change.

**Fix** When the normalized URL is unchanged and no `loading` status arrived, update the identity URL in place.

### M3 · Medium · Toolbar click always pre-opens the side panel and never reuses a detached window

*Verification: Verified · partly acknowledged in deferred-work.*

Where: `entrypoints/background.ts:74-78` · `:111-115` · `:128-130`

The side panel is opened synchronously on every click before preferences are read. With "Always detached window" the panel boots, reconciles, injects the observer into the tab, and is then torn down. On a restricted page the early return skips the close, so the panel is left open and the preference ignored. Every click in popout mode creates another window.

**Fix** Use the already-cached `launchPreferences` synchronously and skip the pre-open when the surface is popout, focus an existing companion window instead of creating one, and move panel teardown to the background.

### M4 · Medium · Image-analysis settings are rebuilt on every preference sync

*Verification: Code-read.*

Where: `entrypoints/sidepanel/main.ts:3243-3268` · `:3363-3521` · `:787` · `:3056-3063`

`syncPreferenceControls` calls `replaceChildren` on the whole section. It runs on every zoom-slider input tick, every preference patch, every capture, and every `storage.onChanged` from any window. A select that fires the change is removed from the DOM during its own event, focus drops to body, and the open OCR diagnostics `<details>` collapses. The zoom slider also writes one storage entry per tick.

**Fix** Make the render idempotent (update values and disabled state on existing nodes) and debounce view-preference writes about 150 ms.

### M5 · Medium · Preference reconcile may revoke site access the user granted in chrome://extensions

*Verification: Plausible · Chrome behavior not executed.*

Where: `lib/preference-coordinator.ts:208-213` · `:239-248` · `:392-401`

Reconcile removes `<all_urls>` whenever both automation and image translation are off, and treats any `https://host/*` as Simul-managed. It runs on every panel open and every capture. If Chrome reports UI-granted optional host permissions through `permissions.getAll`, they are removed.

**Fix** Record which patterns Simul granted and reconcile only those.

#### Isolated HTML engine

### M6 · Medium · Sensitive non-password controls are live-transported, and the receiver cannot enforce the rule

*Verification: Code-read.*

Where: `lib/replica/source-privacy-policy.ts:10-17` · `:84-106` · `lib/replica/html-mirror-source.ts:898-914` · `:1151-1207` · `lib/replica/html-mirror-sanitizer.ts:355-366` · `:3517`

Only `current-password` and `new-password` are excluded. `<input type="tel" autocomplete="cc-number">`, `cc-csc`, `one-time-code`, and a show-password toggle that flips `type` to text are all eligible, and their values are pushed on every input event and by the 500 ms poller. The source strips `autocomplete` before transport, so the receiver-side eligibility check can never see a password token. The docs describe both-sides validation.

**Fix** Widen the private token set, and transport a boolean `sensitive` flag instead of stripping the attribute.

### M7 · Medium · Fonts and container queries can leak translated text and the target language to the source origin

*Verification: Code-read.*

Where: `lib/replica/html-mirror-sanitizer.ts:2073-2178` · `:1455-1486` · `lib/replica/isolated-html-engine.ts:60` · `:1315-1317`

Both fidelity policies admit `@font-face` with remote `src` and `unicode-range`, external stylesheet links, and the shell CSP allows `font-src https:`. A font scoped to `U+0400-04FF` is requested only if Cyrillic appears in the translated text, which reveals the target language. Placeholder translations are written through the IDL property and reflect to an attribute selectable by CSS.

**Fix** In Conservative set `font-src` to self or data and strip `@font-face` with `unicode-range`. Document that Passive Fidelity can leak the target language. Strip `crossorigin` on img and link so the extension origin is not sent.

### M8 · Medium · Reverse node lookups are linear and every patch copies the whole state

*Verification: Code-read.*

Where: `lib/replica/isolated-html-engine.ts:2132-2137` · `:2283-2291` · `:2094-2101` · `:1955-1961` · `:2917` · `:2453-2460`

`findDomNodeId`, `hasDomId`, and `removeDomTree` scan `state.nodes`; `batchContainerContext` does it once per ancestor per attribute op. Rollback capture copies five maps, and metrics, record building, and language detection each walk all nodes on every patch.

**Fails when** a 50k-node page replaces a 5k-node subtree: on the order of 250 million map iterations on the side-panel thread. A steady stream of small patches copies millions of entries per second.

**Fix** Keep a `WeakMap<Node, number>` reverse index and record rollback as an undo log of touched entries.

### M9 · Medium · Source observer walks the whole subtree per record and can silently stop

*Verification: Code-read.*

Where: `lib/replica/html-mirror-source.ts:546-588` · `:1501-1513` · `:1698-1705`

`#observeOpenShadowRoots(record.target)` recursively visits the entire subtree for every mutation record. A childList mutation on body walks the whole document each time. The recursion has no depth guard and the observer callback has no try/catch, so a very deep DOM throws inside the callback, the batch is dropped, no `stream_gap` is sent, and the replica stops updating without any diagnostic. Target minimization is also quadratic in pending targets.

**Fix** Wrap the callback, post a gap on failure, make the walk iterative and bounded, and walk only `addedNodes`.

### M10 · Medium · One over-budget page disables Isolated HTML for the whole companion lifetime

*Verification: Code-read.*

Where: `lib/replica/html-mirror-sanitizer.ts:19` · `lib/replica/engine-selection.ts:118-131` · `entrypoints/sidepanel/main.ts:575` · `lib/replica/isolated-html-engine.ts:747-753`

Exceeding 50,000 nodes yields `stream_overflow`, the run fails, and the controller adds the mode to its disabled set until the user reselects an engine. Long threads and reference pages exceed that easily, and H2 lets any page trigger it. The 5 s recovery timer also covers checkpoint staging, so a slow large rebuild aborts mid-stage into the same path.

**Fix** Treat capacity and timeout failures per page, not per lifetime, and give staging its own deadline.

#### Image translation (OCR)

### M11 · Medium · Every source scroll tears down all overlays and re-captures every visible image

*Verification: Code-read.*

Where: `lib/ocr/source-image-observer.ts:273-282` · `:673-690` · `lib/ocr/image-translation-controller.ts:626-640` · `lib/ocr/image-scan-scheduler.ts:317-331` · `lib/ocr/pixel-acquisition.ts:148-149`

The observation token embeds viewport bounds, so any scroll marks every visible image as changed. The controller removes the projection and the scheduler re-queues the node, and each re-queue is a `captureVisibleTab` call spaced at least 550 ms apart even when the crop is a cache hit. Overlay geometry is image-relative, so removal is unnecessary.

**Fails when** the user scrolls 1 px on a page with five visible translated images: all five overlays vanish and return about three seconds later. During continuous scrolling the active job is aborted every frame, which also kills the Tesseract worker (M12).

**Fix** Keep a projection while the image-relative crop rectangle is unchanged and debounce observation until scroll settles.

### M12 · Medium · Tesseract worker is terminated on every cancel, and bootstrap counts against the job deadline

*Verification: Code-read.*

Where: `lib/ocr/providers/tesseract/runtime.ts:86-108` · `lib/ocr/image-analysis-coordinator.ts:247-258`

Worker creation, a 3.9 MB core fetch, WASM compile, and traineddata gunzip all run inside the single 30 s `withDeadline`, and both the catch and `cancelActive` call `#terminateWorker` unconditionally. A scroll during recognition destroys the worker, and the next job pays full initialization again. On slow hardware a `jpn+jpn_vert` job can time out during init, retry from scratch, and time out again.

**Fix** Let a cancelled recognize drain and keep the worker; give bootstrap its own longer timeout.

### M13 · Medium · Transient capture and host failures permanently settle the image

*Verification: Code-read.*

Where: `lib/ocr/image-translation-controller.ts:789-795` · `:875-876` · `lib/ocr/pixel-acquisition.ts:325-348` · `lib/ocr/transient-image-store.ts:88-101`

An `inactive` capture (user switched tabs) and any failed recognition, including `host-unavailable` and `host-overflow`, call `scheduler.settle`. Nothing re-triggers when the tab becomes visible again. Separately, the IndexedDB store caches a rejected open promise forever, so one `onblocked` makes every later put reject and OCR is dead until the panel reloads.

**Fix** Map transient reasons to `defer`, re-kick on `tabs.onActivated` and on replica commit, and reset the database promise on failure.

### M14 · Medium · Overlapping page content is OCR'd and projected as image text

*Verification: Code-read.*

Where: `lib/ocr/image-source-session.ts:295-307` · `:347-368`

`captureVisibleTab` paints everything. The safety check rejects only overlap with private or activation controls; ancestors are checked only for overflow clipping. A fixed header, caption, or modal partly covering an image has its text recognized, cached, and rendered onto the replica image.

**Fix** Sample `elementsFromPoint` on a small grid inside the image rect and defer or crop when a non-ancestor paints over it.

#### Translation

### M15 · Medium · UI-label localization and quick translation call create() for merely downloadable pairs

*Verification: Code-read.*

Where: `entrypoints/sidepanel/main.ts:2983-2990` · `:3771-3778` · `lib/chrome-translator.ts:96-102` · `:181-188`

Page translation correctly requires `available` or a Translate click, but the label set and the composer reject only `unavailable`. Picking a target language from the menu can start a multi-megabyte pack download as a side effect, and switching twice more starts two more. Without user activation Chrome throws `NotAllowedError`, which the wrapper collapses into "Try again", so the UI silently stays English with no hint why.

**Fix** Gate every `create()` on `available` unless it comes from an explicit click, and branch on `error.name` to say "needs a click".

### M16 · Medium · HTML lang always wins over content detection

*Verification: Code-read.*

Where: `lib/language-detection.ts:30-31` · `entrypoints/sidepanel/main.ts:2178-2184`

A canonical `lang` returns immediately; content detection runs only when it is absent. A Japanese article on a template that declares `lang="en"` resolves to en→en and the companion reports "languages match, original text unchanged". This is the most common "nothing happens" report on multilingual sites.

**Fix** When `lang` equals the target and the detector reports another supported language with confidence, prefer the detector.

### M17 · Medium · Coordinator staleness check is quadratic per drain

*Verification: Code-read.*

Where: `lib/translation/replica-translation-coordinator.ts:563-588` · `lib/replica/isolated-html-engine.ts:336-346`

`#isCurrentJob` takes a full `surface.snapshot()`, which materializes every record into a frozen array, then does a linear `find`. It runs twice per job. A 10k-record page with the 2,048-job cap performs on the order of 80 million element operations per drain on the panel thread.

**Fix** Expose an O(1) record lookup by node id and cache one snapshot per drain.

#### Legacy bridge and packaging

### M18 · Medium · Page-side bridges never stop after an extension reload, and messages are retried blindly

*Verification: Orphan verified · retry effect plausible.*

Where: `lib/live-page-mirror.ts:287-310` · `:199-236` · `lib/replica/page-recorder.ts:104-108` · `entrypoints/sidepanel/main.ts:831-878`

Neither bridge checks `chrome.runtime?.id`, so after an update or reload the isolated-world singletons survive with an invalidated runtime: the MutationObserver, seven capture-phase listeners per root, and the retry loop keep running for the page's lifetime, and a reopened companion on that tab cannot connect. The send helper retries each message twice on rejection; the panel listener never calls `sendResponse` for dirty and scroll messages, so if Chrome rejects those sends every dirty flush and scroll frame goes out three times and wakes the service worker each time.

**Fix** Self-disconnect when the runtime id is gone, key the singletons on the build identity rather than a hand-bumped revision, and have the listener respond.

### M19 · Medium · Every capture still pays for the legacy engine before the selected one runs

*Verification: Code-read.*

Where: `entrypoints/sidepanel/main.ts:1676-1735` · `lib/replica/legacy-transition-gate.ts:45-63` · `:542-577`

Each capture injects the observer bundle, installs the bridge, and runs `capturePageSnapshot` (about 130 `getPropertyValue` calls per node, up to 10k nodes) even though Isolated HTML is the default and the engine selector can never return legacy. The failure-recovery gate also allows a full rebuild after every commit with no rate limit, and rrweb live casting is frame-driven, so a hidden companion window reserializes the source tab every 10 to 15 s for as long as it stays hidden.

**Fix** Move scroll reporting into the HTML mirror source, make the v1 snapshot a lazy fallback, give the gate a budget with backoff, and pause live work while `document.hidden`.

### M20 · Medium · No extension icons, and anything in public/ is dropped by the default build

*Verification: Verified.*

Where: `dist/chrome-unpacked/manifest.json` · `wxt.config.ts:56` · `tools/extension-artifact.mjs:920-921`

The manifest has neither `icons` nor `action.default_icon`, so the toolbar shows a generic letter and a Web Store submission would be rejected. `publicDir` switches to `vendor` whenever Tesseract is enabled, which is the default, so an icon added to `public/` never ships. The validator only checks icons if present.

**Fix** Keep `public/` for icons, copy vendor assets in a build hook, and make the validator require icons.

## Low severity

Real but narrow, or cosmetic. Worth a ticket each; none needs to block a release.

| ID | Finding | Where |
| --- | --- | --- |
| L1 | Switching All sites → This site removes the broad grant before requesting the narrower one; denying the prompt lands the user on Off. | sidepanel/main.ts:3966-3971 |
| L2 | A language change in one companion window sets `translationDesired` in every other window and aborts their in-flight work. | sidepanel/main.ts:1022-1043 |
| L3 | Web Lock is held across `permissions.request`, so other windows' captures block until the prompt is answered. | sidepanel/main.ts:1231-1251 · background.ts:313-315 |
| L4 | Localization is not atomic in practice: titles, aria-labels, status strings, and loading states stay English while labels translate. | sidepanel/main.ts:241-276 · index.html:27-113 |
| L5 | Every newly seen dynamic label forces the whole UI back to English and re-localizes, a visible flash. | sidepanel/main.ts:2920-2928 |
| L6 | "Legacy mirror · fallback" badge shows during every ordinary navigation rebuild. | sidepanel/main.ts:1727-1729 · :4101-4113 |
| L7 | Dark-mode focus ring is near-invisible (28% green on `#18211c`). | sidepanel/style.css:75-78 · :394-411 |
| L8 | Two multi-hundred-character `console.info` lines per mirror batch plus per-scroll logging run in production. | sidepanel/main.ts:397-406 · :862-876 |
| L9 | Long-text chunking trims interior whitespace and rejoins with ASCII spaces; textarea newlines are lost. | lib/translation-pipeline.ts:248-271 |
| L10 | Hebrew is sent as `iw`; Chrome documents `he`. Unverified at runtime. | lib/translation-provider.ts:145-150 |
| L11 | 18 supported UI languages have no Tesseract route (bg, cs, da, el, fi, hr, hu, id, lt, nl, no, pl, ro, sk, sl, sv, th, tr) and fail with a misleading `provider-unavailable` code. | lib/ocr/providers/tesseract/language-catalog.ts:22-44 |
| L12 | TextDetector capability probe is dead code; the docs say it is probed in the offscreen document. Each image pays a failing round trip before Tesseract runs. | lib/ocr/providers/chrome-text-detector/probe.ts · docs/image-translation-research.md:10-11 |
| L13 | Anchor-deferred OCR jobs never recover until the source observation changes. | lib/ocr/image-translation-controller.ts:770-778 · image-scan-scheduler.ts:371-378 |
| L14 | Per-frame diagnostic fan-out: three diagnostics, a console line, and a DOM re-render per image per scroll frame. | lib/ocr/image-translation-controller.ts:651-666 · sidepanel/main.ts:4543-4550 |
| L15 | Forced layout hot spots: `refreshAll` per measure, a document-wide private-control scan per image, up to nine reflow cycles per overlay region per refresh. | lib/ocr/image-source-session.ts:113 · image-overlay-projector.ts:420-473 |
| L16 | `run()` releases the live stream before the staleness check, so a stale call leaves the last-good replica frozen with no failure signal. | lib/replica/isolated-html-engine.ts:223-227 |
| L17 | CSS-driven editability (`-webkit-user-modify`, `designMode`) is not detected as private. | lib/replica/source-privacy-policy.ts:84-93 |
| L18 | Unbounded recursion on deep DOMs in `forgetTree` and the snapshot walk; a hostile depth makes `executeScript` reject instead of degrading. | lib/live-page-mirror.ts:401-412 · lib/page-snapshot.ts:742-776 |
| L19 | rrweb: `value` masked on every element (progress, meter, li); comment stripping erases `rr_split` markers; viewport resize forces a full snapshot; the fallback `onMessage` returns a Promise the project's own comment says Chrome 138 ignores. | lib/replica/protocol-v2.ts:648-651 · :840-846 · live-recorder-session.ts:289-292 · page-recorder.ts:227-239 |
| L20 | Sourcemap stripping and its validator depend on the minifier emitting rrweb's inline worker as a template literal with real newlines. | wxt.config.ts:32-35 · tools/extension-artifact.mjs:1743-1756 |
| L21 | `artifact:sync` spreads the developer's environment (and Vite's `.env`) into the build; a local `WXT_*` override commits bytes CI cannot reproduce. | tools/extension-artifact.mjs:224-238 |
| L22 | Every Dependabot PR is red by construction because CI byte-compares against committed `dist/`. | .github/workflows/ci.yml:36-37 · dependabot.yml |
| L23 | `allowScripts` is not an npm field (inert); the `esbuild` override sits outside wxt's declared range. | package.json:29-41 |
| L24 | Legacy delta path can translate a new pair with the previous pair's availability and no Translate click. | sidepanel/main.ts:2097-2110 · :2557-2598 |

## Recommendations

Ranked by value. The first two are cheap and prevent whole classes of regressions.

1. **Restore the working tree, then commit.** Fix B1 by name-keying the marker checks, keep the bridge fix for B2, decide B3 on purpose, delete the stray wasm for B4, then `artifact:sync`. Add a test that every entry in the required-bundle list has a marker rule, so growing the list cannot silently shift indices again.

2. **Make closure-free injection a build-time guarantee.** Every function passed to `executeScript({ func })` should be evaluated from its `toString()` in a bare VM context in a test. B2 shipped for two releases because nothing checks this. The same test covers `capturePageSnapshot` and the two invoke helpers.

3. **Quarantine or remove the rrweb engine.** Isolated-world CSSOM blindness cannot be fixed without main-world injection, which your privacy model forbids, and the flow control cannot converge on animated pages. Removing it drops about 6,500 lines, a 151 KB injected script, and two dependencies. If it must stay, gate it behind a build flag defaulting off, exclude it from the shipped entrypoints, and fix the import bypass first.

4. **Harden the isolated sanitizer at both boundaries.** Reject colons in tag names, add one canonical SVG element-name map shared by source and receiver, and collapse the duplicated attribute policy tables (they already drift on `srcset`). Add a real-Chrome smoke test that renders a checkpoint with gradients, clip paths, `<x:iframe>`, and SMIL and asserts on element classes; linkedom cannot validate factories, sandbox flags, or CSP.

5. **Split `sidepanel/main.ts` and unify its currency guards.** At 4,587 lines with about sixty module-level `let`s, H1, M1, and L24 are all "guard checked the wrong counter" bugs. Cut it into source-follower, capture-pipeline, translation-driver, preference-client, localization, image-analysis-panel, and quick-composer modules over a single state object, with one immutable currency token instead of six counters. Never replace the snapshot object identity as a signal.

6. **Fix the launch path.** Resolve the surface from cached preferences synchronously, pre-open the panel only when it is the target, focus an existing detached window instead of creating another, and move panel teardown to the background. Also do not size the detached window to the full bounds of the source window; it covers the page the user is trying to read alongside.

7. **Stabilize the OCR lifecycle.** Keep overlays while the image-relative crop is unchanged, keep the Tesseract worker alive across cancels with its own bootstrap timeout, treat transient failures as deferrals with a re-kick on tab activation, harden the IndexedDB store, and either vendor the 18 missing models or grey out image translation for unrouted languages.

8. **Match Translator usage to the documented gate.** Only call `create()` on `available` unless the call comes from an explicit click, branch on `NotAllowedError` and `QuotaExceededError`, and cross-check `lang` against content detection when it equals the target.

9. **Give the isolated engine O(patch) costs.** A `WeakMap` reverse index, an undo-log rollback, an iterative bounded shadow-root walk inside a try/catch that posts a gap, and per-page rather than per-lifetime handling of capacity and timeout failures.

10. **Decide the privacy posture explicitly and write it down.** Widen the private-control set, transport a `sensitive` flag instead of stripping `autocomplete`, set `font-src` for Conservative, strip `crossorigin`, and document that Passive Fidelity can reveal the target language through fonts.

11. **Release hygiene.** Ship icons and stop swapping `publicDir`; sanitize the artifact build environment; automate `artifact:sync` on Dependabot branches; remove the inert `allowScripts` block; gate verbose `console.info` behind a diagnostics toggle. The size gate has 4.4 MiB of headroom, so any new language pack needs a plan.

12. **Add the tests that would have caught these.** Behavioral side-panel tests with fake `browser.*` APIs (the current file asserts on source-text substrings), a convergence test with a viewer slower than four frames, a perf test for 1k adds on a 20k-node state, and a CSS fuzz asserting no `@import` or `url(` survives browser canonicalization including escapes.

## What held up

Things the reviews specifically tried to break and could not. Worth knowing so the fixes above do not disturb them.

- No remotely hosted code path survives: worker, core, and language paths are explicit,
   
   `workerBlobURL`
   
   is false, the vendored worker contains no CDN strings, and the validator fails closed on any residual reference.

- The isolated shell's
   
   `srcdoc`
   
   is a constant never built from page content;
   
   `sandbox`
   
   is set before navigation; the meta CSP carries
   
   `script-src 'none'`
   
   ,
   
   `form-action 'none'`
   
   , and
   
   `base-uri 'none'`
   
   ; links are inert via
   
   `inert`
   
   ,
   
   `tabindex`
   
   , and pointer events.

- rrweb's replayer iframe gets
   
   `sandbox="allow-same-origin"`
   
   before append and the recorder options match the "fully masked" claim.

- `visual-renderer.ts`
   
   never touches
   
   `innerHTML`
   
   ; every element and attribute comes from an allowlist.

- `capturePageSnapshot`
   
   and the two invoke helpers are closure-free, and the shipped chunk contains no esbuild helpers that would break serialization.

- One Translator per pair, de-duplicated concurrent creation, destroyed on pair change and
   
   `pagehide`
   
   ; cancellation is layered and there are no retry storms.

- Translation memory is a true LRU keyed on provider, pair, and exact string, bounded by entries and characters; a rejected leader does not poison later lookups.

- UI labels are all-or-nothing and guarded against stale async results by request id, controller identity, target, and input key.

- Offscreen document creation is serialized and the "already exists" error is recovered; background, offscreen, and panel listeners discriminate messages exactly; the callback-plus-return-true pattern is used where it matters.

- OCR cache keys include pixel hash, dimensions, preprocessing version, and route; the 4 MP ceiling is enforced on both sides; transient blobs are removed in
   
   `finally`
   
   plus a TTL sweep; diagnostics are allowlisted and content-free.

- The optional host grant is checked before enabling image translation; capture is spaced at least 550 ms apart under a cross-context Web Lock.

- Same-language short-circuit is exact after canonicalization (zh-CN and zh-Hans to zh, pt-BR to pt, nb and nn to no);
   
   `sidePanel.close`
   
   is feature-detected, so Chrome 138 as the minimum is consistent.

- The side panel has no leaked listeners or timers and no unhandled rejections; every id it requires exists in the HTML.

- The artifact check is byte-for-byte, ignores timestamps, rejects symlinks, flags unexpected paths, and CI uploads the verified directory.

## Method and housekeeping

How the findings were produced, and three local issues that are not code bugs.

About 66,000 lines were reviewed: five subsystem passes (side panel and preferences, isolated HTML engine, rrweb and legacy path, OCR, translation and tooling) plus an independent pass over the background worker, entrypoints, build configuration, and git state. Every Blocker and High finding was re-verified against the source or the shipped bundle in this review. Findings marked "code-read" were verified by reading; "plausible" marks a Chrome runtime behavior that was not executed. The full gate was run in a clean `npm ci` against both a pristine export of HEAD and the working tree, in a scratch directory, without touching the project.

**Local environment.** The `node_modules` in the project was installed on a Mac: it holds darwin-arm64 binaries for esbuild, rolldown, and TypeScript 7, and has no `.bin` shims. The machine has npm 11.9 while `package.json` requires npm 12 with `engine-strict`. `npm run check` therefore fails at `tsc: not found`. A fresh `corepack npm ci` fixes it. Node 24.14 is also below the 24.15 that npm 12.0.1 supports; `.nvmrc` asks for 24.18.

**Mode bits.** All 522 tracked files show a 100644 to 100755 mode change and `core.fileMode` is true, so every file appears modified. Either `chmod -x` the tree or set `core.fileMode false` before committing, or the next commit will rewrite every file's mode.

**Uncommitted work.** 154 files carry real edits (620 insertions, 86 deletions) beyond the mode noise, plus the untracked `entrypoints/page-live-observer.ts`. The committed `dist/` and `vendor/` content is byte-identical to HEAD.

Simul 0.3.0 at commit 2fde1c8 with uncommitted working-tree changes, reviewed 3 September 2026. Line numbers refer to the working tree unless marked HEAD.
