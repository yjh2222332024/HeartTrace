# Love Advisor Hardening Implementation Plan

> **For Codex:** Implement the plan task by task and verify each behavior before delivery.

**Goal:** Close the identified URL/token, prompt-injection, settings-persistence, and machine-path issues without changing the product workflow.

**Architecture:** Keep QCE access local to the configured QCE origin, pass ChatLab evidence as explicitly untrusted context, make `App.vue` the single owner of browser settings state, and resolve data paths from each Python script's repository location.

**Tech Stack:** Express, Node.js built-in test runner, Vue 3, Python `pathlib`.

---

### Task 1: Protect QCE export downloads

Modify `love-advisor/server/qce.js` to resolve download URLs against the configured QCE origin, reject cross-origin or credential-bearing URLs, and send the QCE token only to that validated origin. Add Node tests for accepted relative URLs and rejected external URLs.

### Task 2: Isolate ChatLab evidence

Add pure message-building helpers under `love-advisor/server/prompt.js`. Normalize client messages to `user` or `assistant`, put evidence in a separate untrusted context message before the latest user message, and add tests for role normalization and evidence placement.

### Task 3: Unify browser settings persistence

Pass the reactive settings object from `App.vue` to `ImportDialog.vue`, emit settings patches from the dialog, and persist deep settings changes from the app owner.

### Task 4: Make Python extraction reproducible

Replace hard-coded `D:\\code\\lianai` paths in the four extraction scripts with paths derived from `Path(__file__).resolve().parent`. Clarify the documentation that 68 source files produced 57 valid cases.

### Task 5: Verify

Run Node tests, Python syntax and extraction checks, `git diff --check`, and the frontend build after installing dependencies when needed.
