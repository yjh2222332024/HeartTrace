# Context Runtime Implementation Plan

> **For Claude:** Implement task-by-task. Keep conversation history fully injected. Do not pre-inject workspace, evidence packs, or L1 skill bodies.

**Goal:** Turn background context into on-demand `read_context` / `write_memory` tools, with same-run retention and next-turn re-read.

**Architecture:** A per-Run context session owns catalog, cache keys (`path` + params), pagination, and read/byte budgets. System prompt keeps identity, L0 safety, a thin runtime card, and the skill catalog. Tool results stay in the current Run’s `upstreamMessages`; the next user turn does not replay traces.

**Tech Stack:** Node.js built-in test runner, Express run loop, existing ChatLab `clb` loaders.

---

### Task 1: `server/context.js` + unit tests

Create the runtime: path catalog, cache key, pagination, budget, workspace slices, evidence page loaders, `write_memory`.

**Files:**
- Create: `love-advisor/server/context.js`
- Create: `love-advisor/server/context.test.js`
- Modify: `love-advisor/package.json` (add `context.test.js` to `npm test`)

### Task 2: Stop pre-injecting packs and L1 bodies

`buildUpstreamMessages` takes `runtimeCard` only (no fake user evidence/workspace). Skill assemble injects L0 + catalog, not SKILL/boundaries/style bodies.

**Files:**
- Modify: `love-advisor/server/prompt.js`
- Modify: `love-advisor/server/prompt.test.js`
- Modify: `love-advisor/server/skill.js`
- Modify: `love-advisor/server/skill.test.js`

### Task 3: Register tools and wire the Run

Add `read_context` / `write_memory`. Per Run: context session, intercept execute, keep tool results, persist `lastContextReads` as path hints only.

**Files:**
- Modify: `love-advisor/server/tools.js`
- Modify: `love-advisor/server/tools.test.js`
- Modify: `love-advisor/server/runs.js`
- Modify: `love-advisor/server/store.js`
- Modify: `love-advisor/server/runs.test.js`
- Modify: `love-advisor/server/cases.test.js` (memory provenance if needed)

### Task 4: Verify

Run `npm test` in `love-advisor`. Fix failures. No UI layout change; skip browser.

---

## Runtime contract (locked)

```
MAX_PATHS_PER_CALL = 3
MAX_CONTEXT_READS  = 4
MAX_CONTEXT_BYTES  = 32KB
DEFAULT_PAGE_LIMIT = 80
HARD_PAGE_LIMIT    = 200
```

Paths: `meta` `her` `me` `relationship` `baseline` `memories` `evidence.stats` `evidence.recent` `evidence.windows` `evidence.keywords`. `skill.*` stays on `read_skill_doc` and is **not** in the 32KB budget. ChatLab tools keep the 8-round / 8KB cap.

Cache key = canonical `path?params` (e.g. `memories?types=preference`, `evidence.recent?limit=80&cursor=abc`). Same key → `{ cached: true }` without re-embedding the body. Same Run keeps prior tool results. Next turn: path hints only, re-read for latest workspace.

`her.dislikes` = observed preference/aversion patterns. `relationship.boundaries` = explicitly confirmed relationship boundaries. Do not copy between them.

`write_memory` writes short conclusions with `type`, `runId`, optional `sourceMessageIds` / `confidence`. Raw chat stays in evidence.
