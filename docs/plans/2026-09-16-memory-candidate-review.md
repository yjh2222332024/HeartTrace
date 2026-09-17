# Memory Candidate Review Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace direct model memory writes with reviewable memory candidates that become active memories only after user confirmation.

**Architecture:** The existing Agent Run exposes `propose_memory`, which validates and buffers at most two proposals in the Run-local context session. A successful Run atomically persists the proposals as pending candidates under the bound case and emits SSE events. Chat and workspace UIs share one candidate card; accepting a candidate atomically creates one active memory and marks the candidate accepted.

**Tech Stack:** Node.js, Express, local JSON store, Vue 3, Tailwind-style utility CSS, lucide-vue-next, node:test.

---

### Task 1: Candidate storage and transitions

**Files:**
- Modify: `love-advisor/server/store.js`
- Test: `love-advisor/server/cases.test.js`

**Steps:**
1. Add failing tests for candidate creation, normalization, duplicate suppression, edit, reject, and idempotent atomic acceptance.
2. Add `memoryCandidates` compatibility defaults to cases.
3. Add store functions to persist proposals and transition pending candidates.
4. Keep pending candidates outside `case.memories`; only acceptance creates an active memory.
5. Run `node --test server/cases.test.js` and expect all tests to pass.

### Task 2: Proposal tool and evidence validation

**Files:**
- Modify: `love-advisor/server/context.js`
- Modify: `love-advisor/server/tools.js`
- Test: `love-advisor/server/context.test.js`
- Test: `love-advisor/server/tools.test.js`

**Steps:**
1. Replace the model-facing `write_memory` tool with `propose_memory`.
2. Track numeric ChatLab message IDs observed through selected messages, `read_context`, and cached ChatLab tool results.
3. Reject proposals with unseen source IDs, more than two proposals, oversized content, or exact duplicates.
4. Expose buffered proposals from the context session without persisting them.
5. Run the context and tool tests.

### Task 3: Successful-Run persistence and SSE

**Files:**
- Modify: `love-advisor/server/runs.js`
- Modify: `love-advisor/server/store.js`
- Test: `love-advisor/server/runs.test.js`

**Steps:**
1. Persist buffered proposals only on the successful completion path.
2. Emit one `memory.candidate` event per persisted candidate.
3. Ensure failed and cancelled Runs leave no candidates.
4. Update the system prompt with concrete proposal criteria.
5. Run `node --test server/runs.test.js`.

### Task 4: Candidate HTTP API

**Files:**
- Modify: `love-advisor/server/cases.js`
- Test: `love-advisor/server/cases.test.js`

**Steps:**
1. Add list, edit, accept, and reject endpoints scoped by case ID and candidate ID.
2. Return idempotent results for repeated accept/reject actions.
3. Reject cross-case candidate access and invalid state transitions.
4. Run the case route/store tests.

### Task 5: Shared confirmation card

**Files:**
- Create: `love-advisor/src/components/MemoryCandidateCard.vue`
- Modify: `love-advisor/src/components/MessageList.vue`
- Modify: `love-advisor/src/views/ChatView.vue`
- Modify: `love-advisor/src/App.vue`
- Modify: `love-advisor/src/api.js`
- Modify: `love-advisor/src/lib/sse.js`
- Modify: `love-advisor/src/composables/useChatRun.js`
- Modify: `love-advisor/src/composables/useAdvisorApp.js`
- Test: `love-advisor/src/lib/sse.test.js`

**Steps:**
1. Parse `memory.candidate` SSE events into the live assistant message.
2. Render pending candidates below the matching assistant response.
3. Support inline edit, accept, reject, loading, success, and error states.
4. Refresh cases after a Run or candidate decision so state survives reload.
5. Remove direct whole-answer memory saving from assistant actions.

### Task 6: Workspace review list

**Files:**
- Modify: `love-advisor/src/components/WorkspaceModal.vue`

**Steps:**
1. Add `Pending` and `Saved` segments inside the existing Memory tab.
2. Reuse `MemoryCandidateCard` for pending candidates.
3. Keep manual memory creation and imported memories unchanged.
4. Add accurate empty states and update the old full-injection copy.

### Task 7: Verification and documentation

**Files:**
- Modify: `docs/adr/0001-structured-memory-routing.md`

**Steps:**
1. Run `npm test` and expect the entire suite to pass.
2. Run the production build.
3. Start the local app and inspect desktop and mobile candidate-card states.
4. Record the accepted candidate workflow in the ADR.

No commits are included because the current workspace contains unrelated uncommitted work that must remain untouched.
