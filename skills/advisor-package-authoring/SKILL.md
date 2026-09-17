---
name: advisor-package-authoring
description: Turn approved relationship-advice source material into a reviewable Love Advisor Skill folder and ZIP package. Use when creating, revising, validating, or packaging a custom advisor for import into Love Advisor; do not use for ordinary relationship consultation.
---

# Advisor Package Authoring

Create an importable advisor package from user-provided material. The deliverable is a folder whose name equals `manifest.id`, then a ZIP containing exactly that folder.

## Workflow

1. Inspect the source material and separate direct evidence from inference. Do not invent a source, quotation, outcome, or rule that the material does not support.
2. Start from `assets/advisor-template/`. Choose a stable lowercase `manifest.id`, rename the root folder to the same value, and fill the manifest, `SKILL.md`, and the routed Markdown documents.
3. Keep the entry document short. It should route questions to focused documents instead of embedding the entire knowledge base.
4. Put reproducibility helpers only under `scripts/`. They may be included in the ZIP, but Love Advisor will preserve them as static files and will never run them.
5. Run `node scripts/validate-advisor-folder.mjs <advisor-folder>` before packaging. Then run `scripts/pack-advisor-folder.ps1` on Windows to create the ZIP.
6. Inspect the ZIP in Love Advisor and confirm import. Fix any gate failure in the folder rather than weakening the package contract.

## Package Rules

- `manifest.json` and `SKILL.md` are mandatory at the package root.
- `manifest.entry`, when present, must be `SKILL.md`.
- Every path in `alwaysLoad`, `style`, and `routes[].load` must point to an existing Markdown file in the package.
- Do not declare `default: true`; imported advisors never replace the built-in default advisor.
- Keep source notes, prompts, and helper scripts inside the package if they are useful for audit or revision. They are not executable in Love Advisor.

Read [references/package-contract.md](references/package-contract.md) before designing a new directory or route structure.
