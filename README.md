# Simul

Simul is a Chrome Manifest V3 extension project bootstrapped for learning the
[BMAD Method](https://docs.bmad-method.org/) while keeping implementation fast.
The repository currently provides a verified extension shell; product behavior
will be defined through the BMAD discovery workflow.

## Foundation

- [WXT](https://wxt.dev/) 0.20.27 with vanilla TypeScript
- Node.js 24 LTS and npm
- Chrome Manifest V3 with no production permissions
- Vitest unit tests
- BMAD Method 6.10.0 with 46 Codex skills in `.agents/skills/`
- GitHub Actions checks for type safety, tests, and a production build
- Weekly Dependabot checks for npm and GitHub Actions releases

## Get started

```sh
nvm use
npm install
npm run check
```

If you do not use `nvm`, install Node 24 and confirm `node --version` reports
`v24.x` before installing dependencies.

For WXT's live development runner:

```sh
npm run dev
```

For a manual Chrome load:

```sh
npm run build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select `.output/chrome-mv3`.

## BMAD workflow

Open a new Codex chat in this repository and invoke:

```text
$bmad-help
```

For this short project, `$bmad-quick-dev` is the fastest path once the extension
idea is clear. To learn the full BMAD process, use fresh chats for this sequence:

1. `$bmad-product-brief`
2. `$bmad-prd`
3. `$bmad-ux`
4. `$bmad-create-architecture`
5. `$bmad-create-epics-and-stories`
6. `$bmad-check-implementation-readiness`
7. `$bmad-sprint-planning`
8. `$bmad-create-story`
9. `$bmad-dev-story`
10. `$bmad-code-review`

Generated planning and implementation artifacts belong in `_bmad-output/`.
See [docs/BMAD.md](docs/BMAD.md) for installation and maintenance details.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start WXT's Chrome development runner |
| `npm run typecheck` | Type-check the project |
| `npm test` | Run unit tests once |
| `npm run test:watch` | Run unit tests in watch mode |
| `npm run build` | Build the unpacked Chrome extension |
| `npm run zip` | Create a Chrome Web Store archive |
| `npm run check` | Run type-checking, tests, and a production build |

## Repository layout

```text
.agents/                    BMAD-generated Codex skills
.github/workflows/          Continuous integration
_bmad/                      BMAD framework and configuration
_bmad-output/               BMAD planning and delivery artifacts
docs/                       Long-lived project knowledge
entrypoints/                WXT browser entrypoints
lib/                        Browser-independent application logic
tests/                      Unit tests
```
