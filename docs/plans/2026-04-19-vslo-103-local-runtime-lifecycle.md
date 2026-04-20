# VSLO-103 Local Runtime Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate the desktop app's local runtime reconnect logic into one shared helper so workspace activation, browsing-mode attach, reload, and host start stay behaviorally aligned.

**Architecture:** Add a shared local runtime lifecycle helper in the app layer that owns engine snapshot syncing, auth derivation, reconnect decisions, and direct-vs-orchestrator restart logic. Keep workspace-specific branching in the workspace store, but route all actual local runtime reconnect work through the helper.

**Tech Stack:** SolidJS app store/context code, TypeScript, Node test runner, Tauri app API wrappers

---

### Task 1: Define the Shared Helper Contract

**Files:**
- Create: `packages/app/src/app/utils/local-runtime-lifecycle.ts`
- Test: `packages/app/src/app/utils/local-runtime-lifecycle.test.ts`

**Step 1: Write the failing test**

Add tests that describe:
- syncing an engine snapshot derives auth exactly once
- direct runtime restart reconnects through the shared helper
- orchestrator runtime reconnect reuses the shared helper path
- quiet reconnect is supported for browsing-mode attach

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- local-runtime-lifecycle.test.ts`

Expected: FAIL because the helper module does not exist yet.

**Step 3: Write minimal implementation**

Implement a helper factory that:
- publishes engine snapshots and derived auth
- starts a local host and reconnects
- restarts or reattaches a workspace runtime and reconnects
- supports normal reconnect and quiet reconnect modes

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- local-runtime-lifecycle.test.ts`

Expected: PASS

### Task 2: Refactor Engine Store and Workspace Store

**Files:**
- Modify: `packages/app/src/app/stores/engine-store.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Test: `packages/app/src/app/stores/engine-store-start-host-reset.test.ts`
- Test: `packages/app/src/app/context/workspace-activate-order-sync.test.ts`

**Step 1: Write the failing test**

Add or update focused tests so they assert the shared helper is used for:
- host start
- remote-to-local attach
- local-to-local switch
- reload

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- engine-store-start-host-reset.test.ts workspace-activate-order-sync.test.ts`

Expected: FAIL because the stores still inline their reconnect logic.

**Step 3: Write minimal implementation**

Refactor store code to:
- instantiate or call the shared helper
- remove duplicated auth derivation and engine reconnect sequences
- preserve browsing-mode and route-stability behavior

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui test:unit -- engine-store-start-host-reset.test.ts workspace-activate-order-sync.test.ts`

Expected: PASS

### Task 3: Verify Full Behavior

**Files:**
- Modify if needed: `docs/dev/` canonical docs only if durable runtime behavior changes

**Step 1: Run focused checks**

Run:
- `pnpm typecheck`
- `pnpm --filter @neatech/veslo-ui test:unit`
- `pnpm --filter @neatech/veslo-ui test:session-switch`

**Step 2: Run the full test suite requested by the user**

Inspect the workspace root package scripts and execute the full repo test command, plus any additional required runtime-targeted checks if the root command does not cover them.

**Step 3: Record exact evidence**

Report:
- every verification command run
- pass/fail status
- any gaps or environment limits
