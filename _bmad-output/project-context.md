---
project_name: Simul
project_type: chrome-extension
planning_track: quick-flow
status: release-ready
---

# Simul Project Context

## Current product state

The repository contains the approved side-by-side translation MVP. A user can
open a read-only active-page snapshot in Chrome's native side panel and
translate eligible Japanese or English text locally with Chrome's Translator
API. The approved quick-flow spec under `_bmad-output/implementation-artifacts/`
is the source of truth for its behavior and boundaries. A validated production
build is checked in at `dist/chrome-unpacked/` for direct Developer mode
installation without contributor tooling.

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
- `lib/`: safe snapshot, provider adapter, and translation pipeline logic
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
