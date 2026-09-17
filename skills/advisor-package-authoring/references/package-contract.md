# Advisor Package Contract

The imported ZIP must have one root directory named exactly as `manifest.id`:

```text
<advisor-id>/
  manifest.json
  SKILL.md
  references/
    core/
      boundaries.md
    ...
  style/
    voice.md
  scripts/
    normalize-source.py
```

`manifest.json` must contain a lowercase `id`, a non-empty `name`, and may declare these routes:

```json
{
  "id": "advisor-id",
  "name": "军师名称",
  "description": "来源与适用范围",
  "entry": "SKILL.md",
  "alwaysLoad": ["references/core/boundaries.md"],
  "style": ["style/voice.md"],
  "routes": [
    { "about": "聊天回复与冷场", "load": ["references/playbooks/communication.md"] }
  ]
}
```

Keep cited evidence and rule limitations in the routed documents. The assistant can only read documents listed in the package catalog, so reference a document from the manifest when it should be available to answer user questions.

The importer rejects path traversal, symlinks, encrypted archives, duplicate files, unsupported file types, unsafe route references, paths longer than 240 characters, files larger than 2MB, more than 200 files, archives larger than 30MB, and more than 15MB after extraction. `SKILL.md` must contain at least 20 non-whitespace characters. The importer does not execute `scripts/`.
