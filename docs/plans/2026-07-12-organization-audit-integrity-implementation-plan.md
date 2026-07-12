# Organization Audit Integrity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Serve a truthful merged organization audit and prevent stale model-policy loads from overwriting browser state.

**Architecture:** DEN provides the authoritative scoped audit feed for DEN-owned changes. AI Gateway merges it with only genuinely Gateway-owned scoped events and fails closed on partial reads. Browser model-policy loads use generation, abort, route, and dirty guards.

**Tech Stack:** TypeScript, Express, Drizzle ORM/MySQL, browser ES modules, Node test runner.

---

### Task 1: DEN organization audit endpoint

**Files:**
- Modify: `services/den/src/http/admin-runtime.ts`
- Modify: `services/den/src/http/admin.ts`
- Test: `services/den/test/admin-managed-ai-user-access.test.ts` or a focused admin audit test

1. Write failing tests for organization authorization, SQL-scoped order/limit, and secret-free serialization.
2. Run the focused test and confirm the expected missing-endpoint failure.
3. Add the narrow dependency, route, and runtime query implementation.
4. Run the focused test and confirm green.

### Task 2: Browser model-policy load safety

**Files:**
- Modify: `services/ai-gateway/public-admin/model-policy-editor-state.js`
- Modify: `services/ai-gateway/public-admin/app.js`
- Test: `services/ai-gateway/test/model-policy-editor-state.test.ts`
- Test: `services/ai-gateway/test/admin-ui.test.ts`

1. Write failing executable tests for stale generations, dirty drafts, route changes, and abort wiring.
2. Run the focused tests and confirm the intended failures.
3. Add load request state plus scoped AbortController handling.
4. Run the focused tests and confirm green.

### Task 3: Gateway merged audit facade and honest Gateway mutations

**Files:**
- Modify after coordination: `services/ai-gateway/src/http/admin.ts`
- Test: `services/ai-gateway/test/admin-actions.test.ts`
- Test: `services/ai-gateway/test/admin-user-access.test.ts`

1. Write failing tests for DEN facade status/body, source labels, stable composite IDs, newest-first merge, final limit, partial-source failure, no DEN-owned duplicates, explicit organization-route scope, target membership validation, real AI-access actor, pre-transaction response preparation, and audit failure behavior.
2. Run focused tests and confirm expected failures.
3. Implement the typed DEN facade, server-side merge, duplicate-write removal, and required Gateway audit behavior.
4. Run focused tests and confirm green.

### Task 4: Documentation and verification

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/dev/app-map.md` or the closest canonical admin contract

1. Update audit ownership, source labels, failure semantics, and browser load-safety contracts.
2. Run DEN tests/typecheck, AI Gateway tests/typecheck/build, public-admin tests, and diff checks.
3. Request independent review and address Critical or Important feedback.
4. Stage only this task's files and create one local commit after approval; do not push.
