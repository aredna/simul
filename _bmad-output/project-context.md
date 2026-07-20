---
project_name: Simul
project_type: chrome-extension
planning_track: quick-flow
status: release-ready
---

# Simul Project Context

## Current product state

The repository contains a content-first live translation companion. A user can
open a read-only active-page mirror in Chrome's native side panel or a detached
extension window, translate Chrome-supported language pairs locally, follow
bounded DOM/style/image/scroll deltas, zoom the mirror, and compose a reverse
translation. An initial sanitized capture bootstraps stable isolated-world
node IDs; normal synchronization replaces only coalesced dirty subtrees. A
validated production build is checked in at `dist/chrome-unpacked/` for direct
Developer mode installation without contributor tooling. A development-only
rrweb engine can retain one masked recorder per source document and atomically
promote a live preview with `WXT_SIMUL_RRWEB_SHADOW=1`. A second development
flag, `WXT_SIMUL_RRWEB_TRANSLATION=1`, keeps canonical text in an
exact-document, revisioned source model and projects bounded pair-scoped Chrome
translations through rrweb Mirror-owned text nodes. Capture ACKs never wait for
translation; document, source revision, translation epoch, pair, replay lease,
and node type must all match before a projection commits. Same-language and
pair changes restore source text without recapture, and matching projections
are reconciled before a same-document recovery swap. Production and unflagged
builds remain on the legacy renderer. Exact-document Ports carry
bounded, statefully sanitized DOM, CSS, and scroll batches. Applied-state and
checkpoint ACKs advance only after rrweb casts the admitted events; gaps recover
once through a hidden checkpoint and atomic swap while preserving the last-good
replica. The flagged preview retains source viewport geometry, applies zoom
outside the replay iframe, maps extension/source scrolling, and returns to a
labeled legacy fallback after a bounded failure. Legacy dirty notices are coalesced
while rrweb is authoritative so that transition performs at most one fresh v1
capture.

A dormant OCR foundation reserves five stable provider IDs and persists a
complete provider permutation, three scan policies, conservative small-image
filtering, and two independent Prompt preferences. The default compile-generated
provider registry is empty, so no OCR control, provider import, runtime, model,
Worker, Wasm, permission, CSP change, pixel acquisition, recognition, or overlay
ships yet. Browser-independent image records are exact-document and rrweb-node
owned with separate content/observation revisions and tombstones. A shared,
bounded source-frame `<img>` adapter keeps URL-like source tokens private and
emits only opaque geometry/revision facts; a deterministic bounded scheduler
orders manual, visible, near, and gated background work across the three saved
policies. These are fixed inputs to Checkpoint F rather than provider behavior.

## Fixed engineering baseline

- Chrome Manifest V3 extension built with WXT and strict TypeScript.
- Node.js 24 LTS and npm with a committed lockfile.
- Vanilla HTML, CSS, and TypeScript until a documented UX need justifies a UI
  framework.
- No production permissions or host permissions by default. Every requested
  permission must map to an explicit requirement and use the narrowest scope.
- No remotely hosted executable code and no secrets in extension bundles.
- Background and popup entrypoints stay thin; testable domain logic lives in
  `lib/`.

## Quality gates

Every implementation change must pass:

```sh
npm run typecheck
npm test
npm run build
npm run artifact:check
```

`npm run check` runs typechecking, tests, and the non-mutating artifact check;
that check performs the production build in a temporary directory. Add focused
unit tests for pure logic and browser-level tests when behavior depends on
extension APIs or page integration.

## Source layout

- `entrypoints/background.ts`: Manifest V3 service worker entrypoint
- `entrypoints/popup/`: active-page side-panel launcher
- `entrypoints/sidepanel/`: translation companion UI and browser orchestration
- `entrypoints/page-snapshot.ts`: unlisted top-frame snapshot entrypoint
- `entrypoints/page-recorder.ts`: development-only unlisted rrweb checkpoint
  and exact-document live recorder bridge
- `lib/replica/visible-replay-host.ts`: development-only candidate/committed
  replay ownership, atomic presentation, protected iframe layout, zoom, and
  scroll projection
- `lib/replica/live-protocol.ts`, `lib/replica/live-recorder-session.ts`, and
  `lib/replica/live-stream-client.ts`: bounded ordered transport, shared recorder
  ownership, independent subscriber watermarks, and recovery requests
- `lib/replica/rrweb-stream-sanitizer.ts`: transactional incremental privacy,
  identity, and resource validation
- `lib/replica/source-value-model.ts`: transactional canonical rrweb text,
  monotonic revisions/tombstones, and committed text-change records
- `lib/translation/`: bounded exact-source memory and the single-session,
  revision/epoch/lease-safe rrweb translation coordinator
- `lib/ocr/`: provider-neutral contracts and IDs, empty compiled-provider
  registry, exact-document image ledger, injected `<img>` observation adapter,
  small-image decisions, and dormant visibility scheduler
- `tools/ocr-build-profile.ts`: strict compile-profile flags and virtual empty
  registry generation; enabled-but-unimplemented providers fail the build
- `lib/`: safe bootstrap/delta boundaries, inert renderer, preferences,
  provider adapter, translation pipeline logic, and replica-engine adapters
- `tests/`: unit tests
- `tools/extension-artifact.mjs`: guarded release build, validation, sync, and
  byte comparison
- `dist/chrome-unpacked/`: canonical checked-in Chrome installation directory
- `docs/`: durable project knowledge
- `_bmad-output/`: BMAD planning and implementation artifacts

## Decision rules

1. Prefer the smallest implementation that satisfies approved acceptance
   criteria.
2. Keep browser permissions least-privileged and explain additions in the BMAD
   spec or story.
3. Keep WXT and generated BMAD files within their documented extension points.
4. Update this file when architecture or engineering conventions change.
5. Never edit `dist/chrome-unpacked/` by hand; refresh it only with `npm run
   artifact:sync` after the temporary build passes release validation.
6. OCR providers must consume the stable E contracts and compile registry;
   adding a provider never weakens exact-document currency, descriptor privacy,
   bounded scheduling, saved-order preservation, or current-revision override.
