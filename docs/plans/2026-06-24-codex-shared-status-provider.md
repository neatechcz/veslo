# Codex Shared Status Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent AI Gateway from causing Codex refresh-token reuse by ensuring all default server surfaces share one Codex status/probe provider per process.

**Architecture:** Runtime state owns the shared `CodexCredentialStatusProvider`. Default dependency factories read it from runtime instead of creating independent providers. Admin service accepts an explicit shared provider from `createApp`/`startServer` so admin, capacity monitoring, routing, and user credential paths use the same in-flight map and cache.

**Tech Stack:** TypeScript, Node test runner, AI Gateway runtime/dependency wiring.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `services/ai-gateway/test/runtime-persistence.test.ts`

**Step 1: Write the failing test**

Add a test that:
- creates a persistent runtime with one healthy `codex_oauth` credential and one auth JSON secret
- injects one shared status provider into runtime
- creates default proxy and user credential dependencies from that runtime
- calls proxy binding selection and user assignment-repair paths concurrently for the same credential
- asserts the underlying probe ran exactly once

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- --test-name-pattern "shares one Codex status provider"
```

Expected: fail because the default dependency factories still create independent providers or admin is not wired to the runtime provider.

### Task 2: Move Provider Ownership To Runtime

**Files:**
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`

**Step 1: Add runtime field**

Extend `RuntimeState` with `codexStatusProvider: CodexCredentialStatusProvider`.

**Step 2: Create provider once**

In `createDefaultRuntimeState`, construct one `CachedCodexCredentialStatusProvider` using runtime credentials and secrets, then return it on the runtime object.

**Step 3: Reuse provider**

Change `createDefaultProxyDependencies` and `createDefaultUserCredentialDependencies` to use `runtime.codexStatusProvider` instead of creating their own providers.

### Task 3: Share Provider With Admin

**Files:**
- Modify: `services/ai-gateway/src/index.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`

**Step 1: Add optional factory input**

Allow `createDefaultAdminService` to receive `codexStatusProvider` from callers.

**Step 2: Wire app/startup**

When `createApp` creates default admin service, pass the runtime's shared provider. When `startServer` builds admin service before app creation, create runtime first and pass the same provider into both app and admin service.

### Task 4: Verify And Update Docs

**Files:**
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Update durable behavior docs**

Document that Codex probes are shared process-wide across AI Gateway surfaces and that this prevents server-side duplicate refresh attempts.

**Step 2: Run focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- --test-name-pattern "shares one Codex status provider"
```

Expected: pass.

**Step 3: Run broader package checks**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
pnpm --filter @neatech/ai-gateway build
```

Expected: pass.

### Task 5: Commit, Push, Deploy

**Files:**
- All changed files

**Step 1: Commit**

Commit the code, tests, and docs together.

**Step 2: Push**

Push branch `codex/shared-codex-status-provider`.

**Step 3: Deploy**

Trigger the owned-server deployment workflow and verify the production AI Gateway container reports the new commit and healthy readiness.
