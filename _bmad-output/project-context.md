---
project_name: Simul
project_type: chrome-extension
planning_track: quick-flow
status: foundation
---

# Simul Project Context

## Current product state

The repository is a working extension shell. The user-facing product problem,
audience, and feature set have not been defined yet. BMAD discovery artifacts
are the source of truth for future behavior and scope.

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
```

`npm run check` runs all three gates. Add focused unit tests for pure logic and
browser-level tests when behavior depends on extension APIs or page integration.

## Source layout

- `entrypoints/background.ts`: Manifest V3 service worker entrypoint
- `entrypoints/popup/`: toolbar popup shell
- `lib/`: browser-independent logic
- `tests/`: unit tests
- `docs/`: durable project knowledge
- `_bmad-output/`: BMAD planning and implementation artifacts

## Decision rules

1. Prefer the smallest implementation that satisfies approved acceptance
   criteria.
2. Keep browser permissions least-privileged and explain additions in the BMAD
   spec or story.
3. Keep WXT and generated BMAD files within their documented extension points.
4. Update this file when architecture or engineering conventions change.
