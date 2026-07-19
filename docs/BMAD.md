# BMAD in Simul

## Installed distribution

This repository uses the official
[`bmad-code-org/BMAD-METHOD`](https://github.com/bmad-code-org/BMAD-METHOD)
distribution, pinned to stable version 6.10.0. The installed modules are:

- BMAD Core 6.10.0
- BMad Method (BMM) 6.10.0
- Codex integration with 46 project-local skills in `.agents/skills/`

The exact installed state is recorded in `_bmad/_config/manifest.yaml`.

## Reinstall or regenerate

Run this from the repository root:

```sh
npx --yes bmad-method@6.10.0 install \
  --directory . \
  --modules bmm \
  --tools codex \
  --yes \
  --set core.project_name=Simul \
  --set core.output_folder=_bmad-output \
  --set bmm.project_knowledge=docs
```

To personalize the user name, communication language, or experience level, run
the same pinned installer interactively. Personal `*.user.toml` files are
ignored by Git; team configuration is committed.

The BMAD installer owns `_bmad/` and `.agents/skills/`. Make team-level agent
customizations through `_bmad/custom/config.toml`, then regenerate skills with
the installer rather than editing generated files directly.

## Choosing a track

Use **Quick Flow** when the extension feature is clear and small:

```text
$bmad-quick-dev
```

It clarifies intent, writes a technical spec, implements, reviews, and presents
the change in one workflow.

Use the **full BMad Method** to experience the complete product lifecycle or
when the product idea needs discovery. Start at `$bmad-product-brief`, then move
through PRD, UX, architecture, epics and stories, readiness review, and story
implementation. Run `$bmad-help` at any point for context-aware routing.

After installing or regenerating skills, start a new Codex chat so the new skill
catalog is discovered.

## Artifact policy

- `_bmad-output/planning-artifacts/`: briefs, PRDs, UX, and architecture
- `_bmad-output/implementation-artifacts/`: specs, stories, and sprint records
- `_bmad-output/project-context.md`: shared implementation rules
- `docs/`: durable product and engineering knowledge

These are intended to be source-controlled. Do not put credentials, access
tokens, customer data, or other secrets in BMAD artifacts.
