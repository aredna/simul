# OpenAI Build Week disclosure

This document records Simul's build provenance, third-party work, judging path,
and repository evidence for OpenAI Build Week. It is a factual project record,
not a substitute for the entrant's Devpost form, eligibility representations,
primary Codex Session ID, track choice, or demonstration video.

The requirements below were checked on July 21, 2026 PDT against the official
[OpenAI Build Week FAQ](https://openai.devpost.com/details/faqs) and
[Official Rules](https://openai.devpost.com/rules). The Official Rules and
event website control if either source changes or conflicts with this record.

## New work and cutoff evidence

The Official Rules define the Submission Period as July 13, 2026 at 9:00 AM PDT
through July 21, 2026 at 5:00 PM PDT. Simul was newly created during that
period. Its Git history has a single root commit. Separately, the entrant
attests that no pre-existing Simul source was imported.

| Evidence | PDT timestamp | What it establishes |
| --- | --- | --- |
| [`f1e8546`](https://github.com/aredna/simul/commit/f1e8546f65e70c2e4d270b39bd2f9b80dc2f7828) | July 18, 2026, 10:03 PM | First/root commit and project bootstrap. |
| [`c3e9b8a`](https://github.com/aredna/simul/commit/c3e9b8a12eab681f11176b3a2976902c2be0c3ce) | July 19, 2026, 12:03 AM | First side-by-side translation MVP. |
| [`17355d8`](https://github.com/aredna/simul/commit/17355d8537bcaa8be32389b070607d1d84c4e835) | July 19, 2026, 2:51 PM | Live-replica and OCR architectural research. |
| [`654d8e9`](https://github.com/aredna/simul/commit/654d8e9d8ce50d096599052bd17a6f7ae5ac7797) | July 20, 2026, 3:12 AM | Packaged local Tesseract image translation. |
| [`d558c6e`](https://github.com/aredna/simul/commit/d558c6e4f359840fd09f5dc7c7f34ddd43646a42) | July 20, 2026, 12:17 PM | Isolated HTML mirror and hardened OCR runtime. |
| [`2fde1c8`](https://github.com/aredna/simul/commit/2fde1c8dee0b022bae9846d25c292d44f34c4bf5) | July 21, 2026, 6:06 AM | Passive-fidelity policy and release privacy work. |
| [`90f8f4b`](https://github.com/aredna/simul/commit/90f8f4b3dfe789c8ea63083f625080bf46e18b80) | July 21, 2026, 10:42 AM | Installable Simul 0.3.2 release candidate. |
| [`ee8398d`](https://github.com/aredna/simul/commit/ee8398d84f37e59b1a1229825ec61129b405afec) | July 21, 2026, 10:58 AM | Immutable functional baseline immediately before non-runtime compliance work. |

The directly installable artifact at the functional cutoff is
`dist/chrome-unpacked`. Later disclosure, licensing, and synthetic-fixture
changes must not be described as new submitted functionality, and the cutoff
commits above must not be rewritten. The final compliance tree is identified by
the immutable
[`openai-build-week-2026-submission`](https://github.com/aredna/simul/tree/openai-build-week-2026-submission)
tag created before the submission deadline.

## Entrant, Codex, and GPT-5.6 collaboration

The entrant originated and directed the project. The entrant defined the user
problem and desired experience, supplied and prioritized requirements, selected
privacy/fidelity tradeoffs, approved implementation checkpoints, tested
installed builds on real websites in Chrome, reported failures, and made the
release decisions.

Codex, powered by GPT-5.6 Sol Ultra in the primary build thread, accelerated the
project by turning those decisions into structured BMAD Method artifacts,
technical research, architecture, TypeScript implementation, tests, debugging,
documentation, and release/security/license reviews. The collaboration remained
human-directed: Codex proposed and implemented within the entrant's approved
scope, while the entrant supplied browser observations and acceptance decisions
that automated tests could not replace.

Representative decision records are:

| Decision | Entrant/Codex result | Evidence |
| --- | --- | --- |
| Preserve the original page and compare it with a translated companion | A right-side MVP evolved into side-panel and detached read-only surfaces. | [Initial specification](../_bmad-output/implementation-artifacts/spec-side-by-side-page-translation.md), [`c3e9b8a`](https://github.com/aredna/simul/commit/c3e9b8a) |
| Reconstruct a live page without running website code | Isolated HTML became the default scriptless, pointer-inert engine; rrweb remains experimental. | [Isolated-mirror specification](../_bmad-output/implementation-artifacts/spec-isolated-html-mirror-engine.md), [`d558c6e`](https://github.com/aredna/simul/commit/d558c6e) |
| Translate image text locally | Research led to modular OCR, offscreen execution, bounded capture, and packaged Tesseract assets. | [Research](../_bmad-output/planning-artifacts/research/technical-live-dom-replication-ocr-extension-access-research-2026-07-19.md), [OCR specification](../_bmad-output/implementation-artifacts/spec-checkpoint-f-local-tesseract-image-translation.md), [`654d8e9`](https://github.com/aredna/simul/commit/654d8e9) |
| Balance fidelity, privacy, and network behavior explicitly | Passive Fidelity preserves passive presentation resources while the sandbox continues blocking active content; stricter modes remain disclosed separately. | [Fidelity specification](../_bmad-output/specs/spec-passive-replica-fidelity/SPEC.md), [architecture](../_bmad-output/specs/spec-passive-replica-fidelity/architecture.md), [`2fde1c8`](https://github.com/aredna/simul/commit/2fde1c8) |
| Ship something judges can install without rebuilding | The release process creates and byte-compares a checked-in unpacked Chrome artifact. | [Release specification](../_bmad-output/implementation-artifacts/spec-ready-to-install-chrome-release.md), [`90f8f4b`](https://github.com/aredna/simul/commit/90f8f4b3dfe789c8ea63083f625080bf46e18b80) |

GPT-5.6 Sol Ultra was a meaningful development-time model used through Codex.
It is not embedded in Simul and does not translate pages at runtime. The shipped
extension makes no OpenAI API request. Runtime text translation uses Chrome's
on-device Translator API; optional image analysis uses Chrome TextDetector when
available and locally packaged Tesseract.js assets.

## Third-party work and licensing

Simul's original implementation is open source under the standard
[MIT License](../LICENSE). Anyone may use, copy, modify, merge, publish,
distribute, sublicense, or sell copies subject to the license's notice and
permission-text requirement. This public grant also gives the Sponsor,
Administrator, and Judges clear, free permission to install, run, test,
evaluate, and use Simul throughout the Judging Period.

Third-party work is disclosed rather than represented as entrant-authored:

- Node.js, npm, WXT, TypeScript, and Vitest are development/build tools.
- rrweb and its dependencies provide the experimental replay engine.
- Tesseract.js, Tesseract Core, and pinned `tessdata_fast` models provide the
  packaged local OCR fallback.
- Chrome Manifest V3, Side Panel, Translator, TextDetector, storage, scripting,
  offscreen, and tab-capture capabilities are browser platform APIs.
- BMAD Method 6.10.0 supplied generated workflow/agent material under
  `.agents/` and `_bmad/`; it is development tooling, not extension runtime code.

Exact production dependency versions, model provenance, copyrights, license
texts, and packaged notice locations are recorded in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), the vendored OCR license
directory, and `legal/`. Development-only packages are pinned in
`package-lock.json`, are not shipped in the extension artifact, and retain the
licenses distributed with their packages. The ready-to-load artifact also
contains the controlling Simul license and applicable runtime notices.

## Judge installation and testing path

Judges do not need to rebuild Simul:

1. Download or clone the public repository.
2. Open `chrome://extensions` in desktop Chrome 138 or newer.
3. Enable **Developer mode**, choose **Load unpacked**, and select
   `dist/chrome-unpacked`.
4. Open a normal HTTP(S) page, select the Simul toolbar icon, choose the source
   and target languages, and select **Translate page** if Chrome requests the
   preparation gesture.
5. Optionally enable OCR and grant the requested page access to evaluate local
   image-text translation.

The [README](../README.md) contains the complete usage path, permissions,
privacy behavior, limitations, and troubleshooting guidance. No test account,
sample private data, cloud service, or paid API key is required.

The entrant must keep the public repository and ready-to-load artifact freely
accessible through the end of the Judging Period on August 5, 2026 at 5:00 PM
PDT.

## Entrant-owned Devpost actions

Repository automation cannot truthfully complete or infer the following. The
entrant must verify and submit them before the deadline:

- Run `/status` in the primary Codex build thread and provide its actual
  `/feedback` Codex Session ID. Do not use a guessed identifier or a side thread.
- Choose exactly one eligible track and provide the project text description.
- Provide the public repository URL and confirm the install/testing path.
- Upload a public YouTube video no longer than three minutes with narrated
  audio. The narration must be in English or accompanied by an English
  translation, and must explain what was built, how Codex accelerated the
  workflow, where important decisions were made, and how GPT-5.6 was used.
- Use only video music, images, logos, trademarks, and other third-party material
  the entrant is authorized to include. A live website used for compatibility
  testing should not be presented as entrant-owned material.
- Confirm entrant identity, age, residency, team or organization authority,
  eligibility, originality, and any conflict or support disclosures directly in
  Devpost. This repository makes no unverified representation about them.

No Session ID, track, video URL, team status, or eligibility claim is embedded
here because none can be derived reliably from repository contents alone.

## Requirement mapping

| Official requirement | Repository evidence | Remaining external action |
| --- | --- | --- |
| Working project built with Codex and GPT-5.6 | Collaboration record, decision artifacts, dated commits, ready-to-load 0.3.2 artifact | Demonstrate both in the narrated video and submit the primary Session ID. |
| New or meaningfully extended work during the Submission Period | Single root commit and dated timeline above | None for repository disclosure; entrant confirms submission facts. |
| Public repository with relevant licensing | `LICENSE`, this disclosure, and `THIRD_PARTY_NOTICES.md` | Submit the repository URL and keep the repository/artifact freely accessible through August 5, 2026 at 5:00 PM PDT. |
| README with setup, test guidance, Codex acceleration, decisions, and GPT-5.6 role | README installation and Build Week sections plus this detailed record | Keep Devpost description and video consistent. |
| Developer tool installation, supported platform, and no-rebuild testing path | Desktop Chrome 138+, `dist/chrome-unpacked`, and the steps above | None unless Devpost requests another access method. |
| Text description, one track, public narrated video, and Session ID | Deliberately not fabricated in Git | Entrant completes each Devpost field. |
