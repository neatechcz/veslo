# Opencode Runtime Diagnostics KISS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend existing Veslo trace logging so an OpenCode inference handoff can be followed from server submit through provider response into SSE assistant events and transcript ingestion.

**Architecture:** Reuse the existing `recordSendWorkflowTrace` and server `debugTrace` paths. Do not add a new logging subsystem, UI panel, or diagnostic bundle in this first pass.

**Tech Stack:** TypeScript, Solid app context modules, Bun server tests, Node app tests.

## Global Constraints

- KISS: no new runtime logging framework.
- Do not log prompt text, assistant text, file content, tokens, or secrets.
- Log ids, event names, statuses, counts, text lengths, durations, and transport metadata only.
- Keep existing env/localStorage trace toggles unchanged.
- Do not touch unrelated dirty files.

---

### Task 1: Preserve submit debugTrace

**Files:**
- Modify: `packages/server/src/routes/conversations.ts`
- Test: `packages/server/src/tests/server-conversations.test.ts`

**Interfaces:**
- Consumes: lifecycle `result.payload.debugTrace`.
- Produces: `debugTrace` on `/workspace/:id/conversations/submit` success payloads when lifecycle returned it.

- [ ] **Step 1: Write the failing test**

Add a server test that calls `/workspace/:id/conversations/submit` with `X-Veslo-Send-Trace-Id` and asserts the `submitted` response contains lifecycle trace entries such as `server:conversation-run:opencode-submit`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts`

- [ ] **Step 3: Write minimal implementation**

When mapping lifecycle submitted/queued payloads to conversation-submit payloads, copy `payload.debugTrace` if present.

- [ ] **Step 4: Run test to verify it passes**

Run the same server test command.

### Task 2: Add assistant SSE handoff trace

**Files:**
- Modify: `packages/app/src/app/context/session-event-stream.ts`
- Test: `packages/app/src/app/tests/context/session-unread-events.test.ts` or a focused nearby source-contract test.

**Interfaces:**
- Consumes: existing `recordSendWorkflowTrace`.
- Produces: durable app trace events under source `session-sse`.

- [ ] **Step 1: Write the failing test**

Assert that accepted assistant `message.updated` events record a `session-sse:assistant-message-updated` event and accepted text `message.part.updated` events record `session-sse:assistant-part-updated`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-unread-events.test.ts`

- [ ] **Step 3: Write minimal implementation**

In accepted active stream branches, call `recordSendWorkflowTrace("session-sse", ...)` with metadata only: workspace id, session id, message id, part id, part type, delta length, text length, and whether text is non-empty.

- [ ] **Step 4: Run test to verify it passes**

Run the same app test command.

### Task 3: Add transcript ingestion trace

**Files:**
- Modify: `packages/app/src/app/context/session-transcript-controller.ts`
- Test: `packages/app/src/app/tests/context/session-transcript-controller.test.ts`

**Interfaces:**
- Consumes: existing `recordSendWorkflowTrace`.
- Produces: `session-transcript:ingest-scheduled`, `session-transcript:ingest-flush-start`, `session-transcript:ingest-flush-done`, and `session-transcript:ingest-flush-error`.

- [ ] **Step 1: Write the failing test**

Assert scheduling and flushing transcript ingestion records metadata-only trace events.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-transcript-controller.test.ts`

- [ ] **Step 3: Write minimal implementation**

Call `recordSendWorkflowTrace("session-transcript", ...)` around schedule and writer flush paths.

- [ ] **Step 4: Run test to verify it passes**

Run the same app test command.

### Task 4: Verification

- [ ] Run targeted server test.
- [ ] Run targeted app context tests.
- [ ] Run app typecheck if app exports/types changed.
- [ ] Run server typecheck if server route types changed.
- [ ] Inspect `git diff --check`.
