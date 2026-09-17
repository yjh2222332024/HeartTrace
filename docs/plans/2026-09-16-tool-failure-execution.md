# Tool Failure Execution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make tool failures typed, bounded, cancellable, and automatically retryable once only when the failure is explicitly transient.

**Architecture:** A shared tool-error module defines stable error codes and normalization. The Run runtime owns timeout and retry policy, while the tool registry and ChatLab process runner receive the attempt abort signal so timeout and user cancellation stop real work rather than only abandoning the result.

**Tech Stack:** Node.js 22, Express, child_process, node:test, SSE.

---

### Task 1: Structured tool errors

**Files:**
- Create: `love-advisor/server/tool-errors.js`
- Modify: `love-advisor/server/tools.js`
- Test: `love-advisor/server/tools.test.js`

**Steps:**
1. Add failing tests for invalid arguments, permission failures, unknown tools, and error normalization.
2. Implement stable `code`, `retryable`, and public `message` fields.
3. Preserve existing human-readable error messages.
4. Run `node --test server/tools.test.js`.

### Task 2: Runtime timeout and one retry

**Files:**
- Modify: `love-advisor/server/runs.js`
- Test: `love-advisor/server/runs.test.js`

**Steps:**
1. Add failing tests proving transient errors retry once and validation errors do not retry.
2. Add a per-attempt timeout, clamped configuration, and `tool.retrying` event.
3. Keep `tool.failed.error` backward compatible while adding `errorCode`, `retryable`, and `attempts`.
4. Make cancellation escape the per-tool recovery block and transition the Run to `cancelled`.
5. Run `node --test server/runs.test.js`.

### Task 3: Stop ChatLab subprocesses

**Files:**
- Modify: `love-advisor/server/qce.js`
- Modify: `love-advisor/server/tools.js`
- Test: `love-advisor/server/qce.test.js`

**Steps:**
1. Add an injectable subprocess test for timeout and abort behavior.
2. Pass the attempt signal through tool handlers to `clb`.
3. Kill the child on timeout or cancellation and release the global queue.
4. Run the QCE and tool tests.

### Task 4: Verification

**Steps:**
1. Run `npm test`.
2. Run `npm run build`.
3. Run `git diff --check` on the completed change.

No commits are included because the workspace contains unrelated user changes.
