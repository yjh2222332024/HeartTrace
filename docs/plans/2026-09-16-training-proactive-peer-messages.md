# Training Proactive Peer Messages Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the simulated peer naturally send one or two delayed, proactive follow-up turns per training session without affecting real conversations.

**Architecture:** A training session persists a random initiative budget (`0`, `1`, or `2`) plus at most one pending initiative. The simulator is only invited to propose an initiative when budget remains; it may decline when there is no natural topic. The server owns cancellation, pause/resume, and one-time delivery. The Vue page merely schedules a local wake-up and renders delivered messages.

**Tech Stack:** Node.js/Express, JSON training-session store, Vue 3, node:test.

---

### Task 1: Persist and atomically operate on pending initiatives

**Files:**

- Modify: `love-advisor/server/store.js`
- Test: `love-advisor/server/training.test.js`

1. Add tests for the 0/1/2 initiative-budget distribution boundary, schedule/cancel, due-time delivery, and paused delivery.
2. Add validated session fields: `initiativeBudget`, `initiativeUsed`, and nullable `pendingInitiative`.
3. Add store operations to schedule one 3–12-second initiative, cancel it, atomically deliver it once, and pause/resume a session while preserving remaining delay.
4. Run `node --test server/training.test.js`.

### Task 2: Let the simulator propose, never force, a delayed follow-up

**Files:**

- Modify: `love-advisor/server/training.js`
- Test: `love-advisor/server/training.test.js`

1. Add a non-fatal `initiative` parser: at most two messages, 3–12 delivery seconds, bounded simulated delay, and a short source/reason.
2. Preserve normal peer replies at one to three messages.
3. Give the simulator an initiative allowance only if the session has unused budget and no pending message. Its prompt must use only existing training facts and return `null` when no natural lead exists.
4. On user turns cancel stale pending output before generating a new reply; schedule a valid initiative after persisting the ordinary reply.
5. Add `deliver-initiative` and `resume` APIs. A pause request freezes the pending delivery; a review clears it.
6. Run `node --test server/training.test.js`.

### Task 3: Render the delayed arrival without fake long-lived typing

**Files:**

- Modify: `love-advisor/src/api.js`
- Modify: `love-advisor/src/views/TrainingView.vue`

1. Add API helpers for due-initiative delivery and resume.
2. Maintain one cleared-on-unmount timer. It wakes at server `dueAt`, asks the server to claim the initiative, then shows a short typing indicator immediately before rendering each delivered message.
3. Keep the input usable during the 3–12-second wait. If the user writes first, the normal turn endpoint cancels the pending output.
4. Make “暂停点评” a real pause and show “继续实战” until resume. Show a compact waiting state without a countdown or external notification.
5. Run `npm run build` and the full test suite.

### Acceptance checks

- Normal peer turns remain capped at three messages.
- A delayed initiative is one or two messages, arrives only once, and waits 3–12 real seconds.
- It cannot survive an intervening user turn, pause, or end-of-training review.
- The peer may originate only grounded topics and never accesses normal-chat context or coach feedback.
