# Local Execution + Expanded Session Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Veslo execute tasks locally only, sync expanded chat/session history to the backend for cross-device visibility, and keep existing worker/cloud backend capabilities intact for compatibility.

**Architecture:** Introduce a local-sync runtime policy in the app layer, remove cloud-only local blockers, and hide remote/cloud controls in member UX while preserving remote codepaths. Add a dedicated Den session-sync API + schema for expanded replicated history (messages, tool events, artifact metadata, fingerprints, fork lineage). Add a local-first sync queue/replicator in the app that streams local session lifecycle/events to Den and enforces mandatory fork on workspace mismatch.

**Tech Stack:** SolidJS + TypeScript (`packages/app`), Tauri desktop bridge (`packages/desktop/src-tauri`), Express + Drizzle + MySQL (`services/den`), Node assert scripts (`packages/app/scripts`), Node test runner via `tsx --test` (`services/den/test`).

---

## Skills and Workflow

- Use `@test-driven-development` for each behavior change.
- Use `@verification-before-completion` before claiming completion.
- If implementing in this repo branch, keep commits small and reversible.
- Keep backend compatibility: do not delete worker/cloud endpoints; gate UX and runtime behavior instead.

### Task 1: Introduce Local-Sync Runtime Policy (without deleting cloud/remote code)

**Files:**
- Create: `packages/app/src/app/lib/runtime-policy.impl.js`
- Create: `packages/app/src/app/lib/runtime-policy.ts`
- Modify: `packages/app/src/app/lib/cloud-policy.ts`
- Modify: `packages/app/src/app/lib/cloud-policy.impl.js`
- Create: `packages/app/scripts/runtime-policy.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

```js
// packages/app/scripts/runtime-policy.mjs
import assert from "node:assert/strict";
import {
  APP_RUNTIME_MODE,
  isLocalExecutionOnly,
  isRemoteUiEnabled,
} from "../src/app/lib/runtime-policy.impl.js";

assert.equal(APP_RUNTIME_MODE, "local_sync");
assert.equal(isLocalExecutionOnly(), true);
assert.equal(isRemoteUiEnabled(), false);

console.log(JSON.stringify({ ok: true, checks: 3 }));
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui node scripts/runtime-policy.mjs`  
Expected: FAIL (`ERR_MODULE_NOT_FOUND`) because runtime policy module does not exist.

**Step 3: Write minimal implementation**

```js
// packages/app/src/app/lib/runtime-policy.impl.js
export const APP_RUNTIME_MODE = "local_sync";

export const isLocalExecutionOnly = () => APP_RUNTIME_MODE === "local_sync";
export const isRemoteUiEnabled = () => false;
```

```ts
// packages/app/src/app/lib/runtime-policy.ts
import {
  APP_RUNTIME_MODE as runtimeModeImpl,
  isLocalExecutionOnly as isLocalExecutionOnlyImpl,
  isRemoteUiEnabled as isRemoteUiEnabledImpl,
} from "./runtime-policy.impl.js";

export const APP_RUNTIME_MODE: "local_sync" | "cloud_only" | "hybrid" = runtimeModeImpl;
export const isLocalExecutionOnly = () => Boolean(isLocalExecutionOnlyImpl());
export const isRemoteUiEnabled = () => Boolean(isRemoteUiEnabledImpl());
```

```ts
// packages/app/src/app/lib/cloud-policy.ts (compat shim)
import { APP_RUNTIME_MODE } from "./runtime-policy";
export const CLOUD_ONLY_MODE: boolean = APP_RUNTIME_MODE === "cloud_only";
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui node scripts/runtime-policy.mjs`  
Expected: PASS with `{ "ok": true, "checks": 3 }`.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/runtime-policy.impl.js packages/app/src/app/lib/runtime-policy.ts packages/app/src/app/lib/cloud-policy.ts packages/app/src/app/lib/cloud-policy.impl.js packages/app/scripts/runtime-policy.mjs packages/app/package.json
git commit -m "feat(app): add local-sync runtime policy with compatibility shim"
```

### Task 2: Remove Cloud-Only Local Execution Blocks and Restore Local-First Bootstrap

**Files:**
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/utils/index.ts`
- Create: `packages/app/scripts/local-workspace-mode.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

```js
// packages/app/scripts/local-workspace-mode.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workspaceSource = readFileSync(new URL("../src/app/context/workspace.ts", import.meta.url), "utf8");
const utilsSource = readFileSync(new URL("../src/app/utils/index.ts", import.meta.url), "utf8");

assert.equal(
  workspaceSource.includes("CLOUD_ONLY_MODE ? filterRemoteWorkspaces(ws.workspaces) : ws.workspaces"),
  false,
  "bootstrap must not filter out local workspaces in local-sync mode",
);

assert.equal(
  utilsSource.includes('if (pref === "local" || pref === "server") return "server";'),
  false,
  "startup preference reader must no longer coerce local->server",
);

console.log(JSON.stringify({ ok: true, checks: 2 }));
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui node scripts/local-workspace-mode.mjs`  
Expected: FAIL because current workspace bootstrap still filters remotes and startup preference is coerced.

**Step 3: Write minimal implementation**

```ts
// packages/app/src/app/context/workspace.ts
const nextWorkspaces = ws.workspaces;
...
if (startupPref === "local") {
  options.setOnboardingStep("local");
  return;
}
```

```ts
// packages/app/src/app/utils/index.ts
export function readStartupPreference(): "local" | "server" | null {
  ...
  if (pref === "local" || pref === "server") return pref;
  if (pref === "host") return "local";
  if (pref === "client") return "server";
  ...
}

export function writeStartupPreference(nextPref: "local" | "server") {
  ...
  window.localStorage.setItem(STARTUP_PREF_KEY, nextPref);
  ...
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui node scripts/local-workspace-mode.mjs && pnpm --filter @neatech/veslo-ui typecheck`  
Expected: PASS and no TypeScript errors.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/workspace.ts packages/app/src/app/utils/index.ts packages/app/scripts/local-workspace-mode.mjs packages/app/package.json
git commit -m "feat(app): restore local-first workspace bootstrap and startup preference"
```

### Task 3: Hide Remote/Cloud Controls in Member UX (keep codepaths for compatibility)

**Files:**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/sidebar.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/onboarding.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Create: `packages/app/scripts/local-ui-guards.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

```js
// packages/app/scripts/local-ui-guards.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const listSource = readFileSync(new URL("../src/app/components/session/workspace-session-list.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../src/app/pages/session.tsx", import.meta.url), "utf8");

assert.equal(
  listSource.includes("showRemoteActions"),
  true,
  "workspace list must gate remote actions behind explicit prop",
);

assert.equal(
  sessionSource.includes("Connect remote worker") && !sessionSource.includes("showRemoteActions"),
  false,
  "session empty state remote CTA must be gated",
);

console.log(JSON.stringify({ ok: true, checks: 2 }));
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui node scripts/local-ui-guards.mjs`  
Expected: FAIL because remote CTAs are not yet gated by member mode.

**Step 3: Write minimal implementation**

```tsx
// workspace-session-list.tsx
export type WorkspaceSessionListProps = {
  ...
  showRemoteActions?: boolean;
};

<Show when={props.showRemoteActions !== false}>
  <button>Connect remote</button>
</Show>
```

```tsx
// app.tsx
const showRemoteActions = false; // member local-sync mode default
...
<WorkspaceSessionList showRemoteActions={showRemoteActions} ... />
```

```tsx
// session.tsx onboarding empty state
<Show when={props.showRemoteActions !== false}>
  <Button>Connect remote worker</Button>
</Show>
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui node scripts/local-ui-guards.mjs && pnpm --filter @neatech/veslo-ui typecheck`  
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/components/session/workspace-session-list.tsx packages/app/src/app/components/session/sidebar.tsx packages/app/src/app/pages/session.tsx packages/app/src/app/pages/onboarding.tsx packages/app/src/app/app.tsx packages/app/scripts/local-ui-guards.mjs packages/app/package.json
git commit -m "feat(app): hide remote/cloud controls in member local-sync UX"
```

### Task 4: Add Den Data Model for Expanded Session Sync (append-only + idempotent)

**Files:**
- Modify: `services/den/src/db/schema.ts`
- Create: `services/den/drizzle/0004_session_sync.sql`
- Create: `services/den/src/http/session-sync-contract.ts`
- Create: `services/den/test/session-sync-contract.test.ts`

**Step 1: Write the failing test**

```ts
// services/den/test/session-sync-contract.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { sessionEventBatchSchema } from "../src/http/session-sync-contract.js";

test("session event batch enforces monotonic seq and required workspace canonical id", () => {
  const parsed = sessionEventBatchSchema.safeParse({
    workspaceCanonicalId: "",
    events: [{ seq: 2, type: "message", payload: {} }, { seq: 1, type: "tool", payload: {} }],
  });
  assert.equal(parsed.success, false);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/den test -- test/session-sync-contract.test.ts`  
Expected: FAIL (`Cannot find module '../src/http/session-sync-contract.js'`).

**Step 3: Write minimal implementation**

```ts
// services/den/src/http/session-sync-contract.ts
import { z } from "zod";

const eventSchema = z.object({
  seq: z.number().int().positive(),
  type: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.string().datetime().optional(),
  idempotencyKey: z.string().min(1).optional(),
});

export const sessionEventBatchSchema = z.object({
  workspaceCanonicalId: z.string().min(1),
  events: z.array(eventSchema).min(1),
});
```

```sql
-- services/den/drizzle/0004_session_sync.sql
CREATE TABLE `session_replica` (...);
CREATE TABLE `session_replica_event` (..., UNIQUE KEY `session_replica_event_unique_seq` (`org_id`,`workspace_canonical_id`,`session_id`,`seq`));
CREATE TABLE `session_replica_artifact` (...);
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @neatech/den test`  
Expected: PASS including new session-sync contract tests.

**Step 5: Commit**

```bash
git add services/den/src/db/schema.ts services/den/drizzle/0004_session_sync.sql services/den/src/http/session-sync-contract.ts services/den/test/session-sync-contract.test.ts
git commit -m "feat(den): add expanded session sync schema and request contract"
```

### Task 5: Add Den Session Sync API Endpoints (compatibility-preserving)

**Files:**
- Create: `services/den/src/http/session-sync.ts`
- Modify: `services/den/src/index.ts`
- Create: `services/den/test/session-sync-router.test.ts`

**Step 1: Write the failing test**

```ts
// services/den/test/session-sync-router.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionEventRows } from "../src/http/session-sync.js";

test("buildSessionEventRows generates idempotency key when missing", () => {
  const rows = buildSessionEventRows({
    orgId: "org_1",
    sessionId: "sess_1",
    workspaceCanonicalId: "ws_main",
    events: [{ seq: 1, type: "message", payload: { text: "hi" } }],
  });
  assert.equal(rows[0].idempotency_key.length > 0, true);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/den test -- test/session-sync-router.test.ts`  
Expected: FAIL because `session-sync.ts` does not exist.

**Step 3: Write minimal implementation**

```ts
// services/den/src/http/session-sync.ts
export const sessionSyncRouter = express.Router();

sessionSyncRouter.post("/sessions/:id/head", ...);      // upsert session metadata + lineage/fingerprint
sessionSyncRouter.post("/sessions/:id/events", ...);    // append/idempotent events by seq
sessionSyncRouter.post("/sessions/:id/artifacts", ...); // upsert artifact metadata
sessionSyncRouter.get("/sessions", ...);                // list session heads
sessionSyncRouter.get("/sessions/:id", ...);            // read head + paged events + artifacts
```

```ts
// services/den/src/index.ts
import { sessionSyncRouter } from "./http/session-sync.js";
...
app.use("/v1/sync", sessionSyncRouter);
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @neatech/den test && pnpm --filter @neatech/den build`  
Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/session-sync.ts services/den/src/index.ts services/den/test/session-sync-router.test.ts
git commit -m "feat(den): add session sync API for local-first expanded history"
```

### Task 6: Add App Sync Client + Persistent Queue (local-first delivery)

**Files:**
- Create: `packages/app/src/app/lib/session-sync-client.impl.js`
- Create: `packages/app/src/app/lib/session-sync-client.ts`
- Create: `packages/app/src/app/lib/session-sync-queue.impl.js`
- Create: `packages/app/src/app/lib/session-sync-queue.ts`
- Create: `packages/app/scripts/session-sync-queue.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

```js
// packages/app/scripts/session-sync-queue.mjs
import assert from "node:assert/strict";
import { createQueueState, enqueueEvent, drainBatch } from "../src/app/lib/session-sync-queue.impl.js";

const q = createQueueState();
enqueueEvent(q, { key: "sess:1", payload: { seq: 1 } });
enqueueEvent(q, { key: "sess:1", payload: { seq: 1 } });

assert.equal(q.items.length, 1, "queue must dedupe by idempotency key");

const batch = drainBatch(q, 10);
assert.equal(batch.length, 1);
assert.equal(q.items.length, 0);

console.log(JSON.stringify({ ok: true, checks: 3 }));
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui node scripts/session-sync-queue.mjs`  
Expected: FAIL (`ERR_MODULE_NOT_FOUND`).

**Step 3: Write minimal implementation**

```js
// packages/app/src/app/lib/session-sync-queue.impl.js
export const createQueueState = () => ({ items: [], seen: new Set() });

export const enqueueEvent = (state, item) => {
  if (state.seen.has(item.key)) return;
  state.seen.add(item.key);
  state.items.push(item);
};

export const drainBatch = (state, size) => state.items.splice(0, Math.max(1, size));
```

```js
// packages/app/src/app/lib/session-sync-client.impl.js
export const postJson = async (baseUrl, path, token, body) => {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sync_http_${res.status}`);
  return res.json();
};
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @neatech/veslo-ui node scripts/session-sync-queue.mjs && pnpm --filter @neatech/veslo-ui typecheck`  
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/session-sync-client.impl.js packages/app/src/app/lib/session-sync-client.ts packages/app/src/app/lib/session-sync-queue.impl.js packages/app/src/app/lib/session-sync-queue.ts packages/app/scripts/session-sync-queue.mjs packages/app/package.json
git commit -m "feat(app): add local-first session sync queue and client"
```

### Task 7: Wire Session/Event/Artifact Replicator into App Session Lifecycle

**Files:**
- Modify: `packages/app/src/app/context/session.ts`
- Modify: `packages/app/src/app/app.tsx`
- Create: `packages/app/src/app/lib/session-sync-projection.impl.js`
- Create: `packages/app/src/app/lib/session-sync-projection.ts`
- Create: `packages/app/scripts/session-sync-projection.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

```js
// packages/app/scripts/session-sync-projection.mjs
import assert from "node:assert/strict";
import { projectEventForSync } from "../src/app/lib/session-sync-projection.impl.js";

const projected = projectEventForSync({ type: "message.part.updated", properties: { part: { id: "p1", messageID: "m1" } } });
assert.equal(projected.type, "message.part.updated");
assert.equal(projected.payload.part.id, "p1");

console.log(JSON.stringify({ ok: true, checks: 2 }));
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui node scripts/session-sync-projection.mjs`  
Expected: FAIL due missing projection module.

**Step 3: Write minimal implementation**

```js
// session-sync-projection.impl.js
export const projectEventForSync = (event) => ({
  type: String(event?.type ?? "unknown"),
  payload: event?.properties ?? null,
  occurredAt: new Date().toISOString(),
});
```

```ts
// context/session.ts (inside SSE/event apply path)
const projected = projectEventForSync(event);
enqueueSessionSyncEvent({ sessionId, workspaceCanonicalId, projected });
```

```ts
// app.tsx (on create session + prompt flow)
enqueueSessionSyncHead({
  sessionId: session.id,
  workspaceCanonicalId,
  title: session.title,
  status: "active",
});
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @neatech/veslo-ui node scripts/session-sync-projection.mjs && pnpm --filter @neatech/veslo-ui typecheck`  
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/session.ts packages/app/src/app/app.tsx packages/app/src/app/lib/session-sync-projection.impl.js packages/app/src/app/lib/session-sync-projection.ts packages/app/scripts/session-sync-projection.mjs packages/app/package.json
git commit -m "feat(app): replicate expanded session lifecycle and event stream"
```

### Task 8: Enforce Workspace Fingerprint Mismatch => Mandatory Fork

**Files:**
- Create: `packages/app/src/app/lib/workspace-fingerprint.impl.js`
- Create: `packages/app/src/app/lib/workspace-fingerprint.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Create: `packages/app/scripts/workspace-fingerprint.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

```js
// packages/app/scripts/workspace-fingerprint.mjs
import assert from "node:assert/strict";
import { shouldForceFork } from "../src/app/lib/workspace-fingerprint.impl.js";

const source = { gitRemote: "a", gitCommit: "111", dirty: false, workspaceRootKey: "root-a" };
const target = { gitRemote: "a", gitCommit: "222", dirty: false, workspaceRootKey: "root-a" };

assert.equal(shouldForceFork(source, target), true);

console.log(JSON.stringify({ ok: true, checks: 1 }));
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui node scripts/workspace-fingerprint.mjs`  
Expected: FAIL due missing module.

**Step 3: Write minimal implementation**

```js
// workspace-fingerprint.impl.js
export const fingerprintEquals = (a, b) =>
  a?.gitRemote === b?.gitRemote &&
  a?.gitCommit === b?.gitCommit &&
  a?.dirty === b?.dirty &&
  a?.workspaceRootKey === b?.workspaceRootKey;

export const shouldForceFork = (source, target) => !fingerprintEquals(source, target);
```

```ts
// app.tsx / session.tsx continue flow guard
if (shouldForceFork(sourceFingerprint, currentFingerprint)) {
  openForkRequiredModal({ sourceFingerprint, currentFingerprint, parentSessionId: sessionId });
  return;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @neatech/veslo-ui node scripts/workspace-fingerprint.mjs && pnpm --filter @neatech/veslo-ui typecheck`  
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/workspace-fingerprint.impl.js packages/app/src/app/lib/workspace-fingerprint.ts packages/app/src/app/app.tsx packages/app/src/app/pages/session.tsx packages/app/scripts/workspace-fingerprint.mjs packages/app/package.json
git commit -m "feat(app): require fork when workspace fingerprints mismatch"
```

### Task 9: Documentation + Compatibility Verification Matrix

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT.md`
- Modify: `INFRASTRUCTURE.md`
- Create: `docs/plans/2026-03-08-local-execution-expanded-sync-rollout-checklist.md`

**Step 1: Write the failing test (doc consistency check)**

```bash
# Add a simple consistency script if desired, or manual grep gate in CI notes.
rg -n "Cloud Worker Connect Flow \(Current\)" ARCHITECTURE.md PRODUCT.md
```

Expected: Existing cloud execution wording still dominates and needs local-sync clarification.

**Step 2: Run check to verify baseline mismatch**

Run: `rg -n "local-only|local execution|sync-only" ARCHITECTURE.md PRODUCT.md INFRASTRUCTURE.md`  
Expected: Missing or incomplete local-sync language.

**Step 3: Write minimal implementation**

- Document runtime split explicitly:
  - Local execution authority
  - Expanded server sync scope
  - Fork-required mismatch policy
  - Backend compatibility promise (remote APIs retained)

**Step 4: Run verification commands**

Run:
- `pnpm --filter @neatech/veslo-ui typecheck`
- `pnpm --filter @neatech/veslo-ui node scripts/runtime-policy.mjs`
- `pnpm --filter @neatech/veslo-ui node scripts/local-workspace-mode.mjs`
- `pnpm --filter @neatech/veslo-ui node scripts/local-ui-guards.mjs`
- `pnpm --filter @neatech/veslo-ui node scripts/session-sync-queue.mjs`
- `pnpm --filter @neatech/veslo-ui node scripts/session-sync-projection.mjs`
- `pnpm --filter @neatech/veslo-ui node scripts/workspace-fingerprint.mjs`
- `pnpm --filter @neatech/den test`
- `pnpm --filter @neatech/den build`

Expected: PASS.

**Step 5: Commit**

```bash
git add ARCHITECTURE.md PRODUCT.md INFRASTRUCTURE.md docs/plans/2026-03-08-local-execution-expanded-sync-rollout-checklist.md
git commit -m "docs: codify local execution with expanded sync and compatibility guardrails"
```

## Rollout Notes

- Keep remote/cloud backend endpoints (`/v1/workers`, provisioning, tokens) unchanged.
- Member UX runs in local-sync mode; admin/internal toggles can still access remote flows when explicitly enabled.
- Use flag-based rollback:
  - `APP_RUNTIME_MODE=cloud_only` to revert old behavior quickly if needed.

