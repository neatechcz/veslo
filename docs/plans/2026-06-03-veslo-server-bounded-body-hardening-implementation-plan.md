# Veslo Server Bounded Body Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `veslo-server` reject or stream large request/response bodies instead of buffering them into Bun/JSC heap.

**Architecture:** Add bounded body helpers in `packages/server/src/server.ts`, apply route-specific limits to risky request and upstream response paths, and add byte-aware eviction to the transcript prefetch store. Keep the OpenCode and provider proxy fast paths streaming.

**Tech Stack:** Bun test runner, TypeScript, Bun `Request`/`Response` streams, Node test upstream servers.

---

### Task 1: AI Gateway Response Limits

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/server.ai-gateway.test.ts`

**Step 1: Write failing tests**

Add tests that prove:

- an upstream error response larger than the diagnostic limit returns a truncated diagnostic snippet
- a successful large JSON provider response is streamed through without JSON redaction/parsing

**Step 2: Verify RED**

Run:

```bash
pnpm --filter veslo-server exec bun test src/server.ai-gateway.test.ts
```

Expected: the new tests fail because the current code reads the whole upstream response body.

**Step 3: Implement minimal code**

Add bounded response preview helpers and change AI gateway error/success JSON handling:

- error bodies read only a bounded snippet
- large JSON success bodies stream through with sanitized response headers
- small JSON responses continue to be redacted

**Step 4: Verify GREEN**

Run the same targeted test command and confirm all tests pass.

### Task 2: Bounded JSON Request Helpers

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/server.debug-logs-route.test.ts`
- Test: existing server route tests or a new focused server test file

**Step 1: Write failing tests**

Add tests that prove oversized local JSON requests return `413` before normal route validation for:

- `/debug-logs`
- a file-session write route
- a representative small JSON mutation route

**Step 2: Verify RED**

Run the focused test files. Expected: oversized requests currently parse fully or fail with the wrong behavior.

**Step 3: Implement minimal code**

Replace `readJsonBody` and `readOptionalJsonBody` with bounded versions. Give routes explicit caps where they legitimately accept larger payloads.

**Step 4: Verify GREEN**

Run focused tests and then `pnpm --filter veslo-server exec bun test src/server.debug-logs-route.test.ts`.

### Task 3: Bounded OpenCode JSON Fetches

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/session-artifacts.test.ts`
- Test: transcript prefetch-related server tests

**Step 1: Write failing tests**

Add tests that prove oversized OpenCode JSON responses for transcript/artifact helpers are rejected with a clear upstream payload error.

**Step 2: Verify RED**

Run the focused tests. Expected: current code reads full `response.text()`.

**Step 3: Implement minimal code**

Change `fetchOpencodeJson` to read response text through a byte-limited helper with route-specific caps.

**Step 4: Verify GREEN**

Run the focused tests and the AI gateway tests to make sure proxy behavior is unchanged.

### Task 4: Transcript Prefetch Byte Budget

**Files:**
- Modify: `packages/server/src/session-transcript-prefetch.ts`
- Test: `packages/server/src/session-transcript-prefetch.test.ts`

**Step 1: Write failing tests**

Add tests that prove the store evicts cached snapshots when estimated bytes exceed the workspace budget, even when entry count is below the count limit.

**Step 2: Verify RED**

Run:

```bash
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts
```

Expected: the new test fails because the store only evicts by entry count.

**Step 3: Implement minimal code**

Estimate snapshot bytes, track workspace cache bytes, add `maxBytesPerWorkspace`, and evict least-recently-used snapshots until count and byte budgets are both satisfied.

**Step 4: Verify GREEN**

Run the transcript prefetch tests.

### Task 5: Multipart Inbox Preflight

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: existing inbox route coverage or a new focused server route test

**Step 1: Write failing test**

Add a test that posts multipart upload with `Content-Length` above the configured inbox max and expects `413` before `formData()`.

**Step 2: Verify RED**

Run the focused test. Expected: current code calls `formData()` before enforcing max file size.

**Step 3: Implement minimal code**

Check `Content-Length` against `resolveInboxMaxBytes()` before reading the multipart body. Keep unknown-length multipart behavior unchanged unless a test requires explicit rejection.

**Step 4: Verify GREEN**

Run the focused test.

### Task 6: Docs and Verification

**Files:**
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Update docs**

Document bounded parsing, streaming proxy behavior, and byte-bounded transcript cache.

**Step 2: Verify**

Run:

```bash
pnpm --filter veslo-server exec bun test src/server.ai-gateway.test.ts
pnpm --filter veslo-server exec bun test src/server.debug-logs-route.test.ts
pnpm --filter veslo-server exec bun test src/session-transcript-prefetch.test.ts
pnpm --filter veslo-server test
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
git diff --check -- packages/server/src docs/features/session-runtime.md docs/dev/state-and-config-reference.md
```

Expected: all commands pass.
