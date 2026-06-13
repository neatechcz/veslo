# Workspace Multi-Workspace State Machine Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `packages/app/src/app/context/workspace.ts` into focused modules and introduce an explicit multi-workspace lifecycle state machine that preserves browse-first local workspace behavior while making concurrent per-workspace runtime state understandable and testable.

**Architecture:** Keep `createWorkspaceStore` as the public facade consumed by `app.tsx`, `sidebar-workspace-sessions.ts`, and `workspace-server-sync.tsx`. Move behavior behind small controller factories with explicit dependency objects, and use a pure lifecycle reducer to record each workspace's browse/connect/runtime phase without coupling it to Solid signals or Tauri calls.

**Tech Stack:** Solid.js signals, TypeScript, Tauri bridge helpers, OpenCode SDK clients, `node --test --import=tsx/esm`, pnpm.

---

## Scope And Constraints

The refactor targets `packages/app/src/app/context/workspace.ts`, currently about 3,170 lines. The current public API must remain source-compatible: `createWorkspaceStore` continues to return the same methods and signals.

The target product behavior is multi-workspace:

- Workspace clicks remain browse-first for local workspaces.
- Runtime startup remains lazy and happens through `ensureEngineForWorkspace` or explicit activation flows.
- `veslo-orchestrator` keeps other workspace busy state intact.
- Direct single-host runtime may clear other workspace busy state because the process is replaced.
- `connectToServer` uses `options.routing.ensure` and does not revive the old single-active client fallback.
- Remote Veslo and remote direct OpenCode workspaces remain supported.
- Existing session-scope and send-target behavior must keep using workspace IDs, directory/root, and route scope.

Known risk: several current tests read `workspace.ts` as text and search for function names or ordering. Those tests must move to module-aware source helpers before large extraction, otherwise a correct refactor fails tests for the wrong reason.

---

## Target File Structure

- Create: `packages/app/src/app/context/workspace-types.ts`
  - Shared types currently exported from `workspace.ts`: `WorkspaceActivationOptions`, connect context/options, lifecycle phases, and small dependency types that would otherwise cause import cycles.

- Create: `packages/app/src/app/context/workspace-lifecycle-state.ts`
  - Pure reducer and small state holder for multi-workspace lifecycle phases.
  - No Solid imports and no Tauri/OpenCode imports.

- Create: `packages/app/src/app/context/workspace-debug.ts`
  - `_wsLog`, `workspaceDebugStack`, `recordWorkspaceBusyTrace`, and `createWorkspaceDebugEvents`.

- Create: `packages/app/src/app/context/workspace-busy-state.ts`
  - `createWorkspaceBusyState` returning `workspaceBusy`, `markWorkspaceBusy`, `clearWorkspaceBusy`, and `clearWorkspaceBusyAllExcept`.

- Create: `packages/app/src/app/context/workspace-connection-state.ts`
  - `createWorkspaceConnectionState` returning `workspaceConnectionStateById`, update/clear helpers, and pruning effect.

- Create: `packages/app/src/app/context/workspace-server-registry.ts`
  - Veslo server local-workspace registry sync: add local workspace, activate host workspace, reconcile server workspaces, reconcile managed AI API keys.

- Create: `packages/app/src/app/context/workspace-skill-materialization.ts`
  - Runtime-start skill materialization gate and skill registry outage classification.

- Create: `packages/app/src/app/context/workspace-connection-controller.ts`
  - `connectToServer` implementation backed only by `WorkspaceRouting.ensure`.

- Create: `packages/app/src/app/context/workspace-runtime-controller.ts`
  - `connectToEngineQuiet`, `refreshActiveClient`, `ensureEngineForWorkspace`.

- Create: `packages/app/src/app/context/workspace-local-workspaces.ts`
  - Local workspace CRUD and path helpers: `createLocalWorkspace`, `createWorkspaceFlow`, scratch workspace, ensure folder, forget, picker, display-name update, private path test.

- Create: `packages/app/src/app/context/workspace-activation-controller.ts`
  - `activateWorkspace` controller split into remote Veslo, remote direct, local browse, and local runtime-switch branches.

- Create: `packages/app/src/app/context/workspace-bootstrap-controller.ts`
  - `bootstrapOnboarding`, startup handlers, DEN/language gate flow.

- Modify: `packages/app/src/app/context/workspace.ts`
  - Becomes the composition facade that creates signals, controllers, stores, and returns the public store object.

- Modify: `packages/app/src/app/stores/remote-store.ts`
  - Import `WorkspaceActivationOptions` from `workspace-types.ts`.

- Modify: context characterization tests under `packages/app/src/app/tests/context/`
  - Read targeted new source files or a module-aware source bundle.

---

## Verification Commands

Run these from the nested repo root `C:\Users\jajse\Desktop\Shoptet_upravy\neatech\veslo\veslo`.

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-lifecycle-state.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/workspace-forget-mode.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected after each completed task: the targeted test command passes. Expected after the final task: `typecheck` and `test:unit` pass.

---

### Task 1: Create Module-Aware Workspace Source Test Helper

**Files:**
- Create: `packages/app/src/app/tests/context/workspace-source.ts`
- Modify: `packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts`
- Modify: `packages/app/src/app/tests/context/workspace-skill-materialization-sync.test.ts`
- Modify: `packages/app/src/app/tests/context/workspace-forget-mode.test.ts`
- Modify if needed: `packages/app/src/app/tests/context/workspace-session-snapshots.test.ts`

- [x] **Step 1: Write the helper**

Create `packages/app/src/app/tests/context/workspace-source.ts`:

```typescript
import { readFileSync } from "node:fs";

const contextRoot = new URL("../../context/", import.meta.url);

export function readContextSource(fileName: string): string {
  return readFileSync(new URL(fileName, contextRoot), "utf8");
}

export function readWorkspaceFacadeSource(): string {
  return readContextSource("workspace.ts");
}

export function readWorkspaceBehaviorSources(): string {
  return [
    "workspace.ts",
    "workspace-types.ts",
    "workspace-lifecycle-state.ts",
    "workspace-debug.ts",
    "workspace-busy-state.ts",
    "workspace-connection-state.ts",
    "workspace-server-registry.ts",
    "workspace-skill-materialization.ts",
    "workspace-connection-controller.ts",
    "workspace-runtime-controller.ts",
    "workspace-local-workspaces.ts",
    "workspace-activation-controller.ts",
    "workspace-bootstrap-controller.ts",
  ]
    .map((name) => {
      try {
        return `\n/* ${name} */\n${readContextSource(name)}`;
      } catch {
        return "";
      }
    })
    .join("\n");
}
```

- [x] **Step 2: Update source-reading tests**

In tests that currently do this:

```typescript
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../context/workspace.ts", import.meta.url), "utf8");
```

replace it with this when the test asserts behavior that may move out of `workspace.ts`:

```typescript
import { readWorkspaceBehaviorSources } from "./workspace-source";

const source = readWorkspaceBehaviorSources();
```

Use this when the test intentionally asserts facade exports only:

```typescript
import { readWorkspaceFacadeSource } from "./workspace-source";

const source = readWorkspaceFacadeSource();
```

- [x] **Step 3: Run the context source tests**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/workspace-forget-mode.test.ts
```

Expected: PASS. This task should not change production behavior.

- [ ] **Step 4: Commit**

```powershell
git add packages/app/src/app/tests/context/workspace-source.ts packages/app/src/app/tests/context
git commit -m "test: make workspace context source tests module-aware"
```

---

### Task 2: Add Pure Multi-Workspace Lifecycle State Reducer

**Files:**
- Create: `packages/app/src/app/context/workspace-lifecycle-state.ts`
- Create: `packages/app/src/app/tests/context/workspace-lifecycle-state.test.ts`

- [x] **Step 1: Write failing lifecycle tests**

Create `packages/app/src/app/tests/context/workspace-lifecycle-state.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialWorkspaceLifecycleState,
  reduceWorkspaceLifecycleState,
} from "../../context/workspace-lifecycle-state";

test("local browse activation keeps another workspace connected", () => {
  let state = createInitialWorkspaceLifecycleState();

  state = reduceWorkspaceLifecycleState(state, {
    type: "connected",
    workspaceId: "ws-a",
    runtime: "veslo-orchestrator",
    reason: "existing-run",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "activation-started",
    workspaceId: "ws-b",
    version: 2,
    origin: "sidebar-click",
    workspaceType: "local",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "browse-ready",
    workspaceId: "ws-b",
    version: 2,
    root: "C:/work/b",
  });

  assert.equal(state.activeWorkspaceId, "ws-b");
  assert.equal(state.byWorkspace["ws-a"]?.phase, "connected");
  assert.equal(state.byWorkspace["ws-b"]?.phase, "browsing");
  assert.equal(state.byWorkspace["ws-b"]?.root, "C:/work/b");
});

test("superseded activation events do not overwrite newer workspace state", () => {
  let state = createInitialWorkspaceLifecycleState();

  state = reduceWorkspaceLifecycleState(state, {
    type: "activation-started",
    workspaceId: "ws-a",
    version: 1,
    origin: "first-click",
    workspaceType: "local",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "activation-started",
    workspaceId: "ws-b",
    version: 2,
    origin: "second-click",
    workspaceType: "local",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "connected",
    workspaceId: "ws-a",
    version: 1,
    runtime: "veslo-orchestrator",
    reason: "late-connect",
  });

  assert.equal(state.activeWorkspaceId, "ws-b");
  assert.equal(state.byWorkspace["ws-a"]?.phase, "activating");
  assert.equal(state.byWorkspace["ws-b"]?.phase, "activating");
});

test("runtime-starting and failed events are scoped per workspace", () => {
  let state = createInitialWorkspaceLifecycleState();

  state = reduceWorkspaceLifecycleState(state, {
    type: "runtime-starting",
    workspaceId: "ws-a",
    runtime: "veslo-orchestrator",
    reason: "browse-attach",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "failed",
    workspaceId: "ws-a",
    message: "engine_info timed out",
  });

  state = reduceWorkspaceLifecycleState(state, {
    type: "connected",
    workspaceId: "ws-b",
    runtime: "veslo-orchestrator",
    reason: "background-run",
  });

  assert.equal(state.byWorkspace["ws-a"]?.phase, "error");
  assert.equal(state.byWorkspace["ws-a"]?.message, "engine_info timed out");
  assert.equal(state.byWorkspace["ws-b"]?.phase, "connected");
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-lifecycle-state.test.ts
```

Expected: FAIL with module not found for `workspace-lifecycle-state`.

- [x] **Step 3: Implement the reducer**

Create `packages/app/src/app/context/workspace-lifecycle-state.ts`:

```typescript
import type { EngineRuntime } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";

export type WorkspaceLifecyclePhase =
  | "idle"
  | "activating"
  | "browsing"
  | "runtime-starting"
  | "connected"
  | "degraded"
  | "error";

export type WorkspaceLifecycleEntry = {
  workspaceId: string;
  phase: WorkspaceLifecyclePhase;
  workspaceType?: WorkspaceInfo["workspaceType"];
  runtime?: EngineRuntime;
  origin?: string;
  reason?: string;
  root?: string;
  message?: string | null;
  activationVersion?: number;
  updatedAt: number;
};

export type WorkspaceLifecycleState = {
  activeWorkspaceId: string | null;
  activationVersion: number;
  byWorkspace: Record<string, WorkspaceLifecycleEntry>;
};

export type WorkspaceLifecycleEvent =
  | {
      type: "activation-started";
      workspaceId: string;
      version: number;
      origin: string;
      workspaceType: WorkspaceInfo["workspaceType"];
    }
  | { type: "browse-ready"; workspaceId: string; version?: number; root: string }
  | {
      type: "runtime-starting";
      workspaceId: string;
      runtime: EngineRuntime;
      reason: string;
    }
  | {
      type: "connected";
      workspaceId: string;
      version?: number;
      runtime: EngineRuntime;
      reason: string;
    }
  | { type: "degraded"; workspaceId: string; message: string; reason: string }
  | { type: "failed"; workspaceId: string; version?: number; message: string }
  | { type: "cleared"; workspaceId: string };

const now = () => Date.now();

export function createInitialWorkspaceLifecycleState(): WorkspaceLifecycleState {
  return {
    activeWorkspaceId: null,
    activationVersion: 0,
    byWorkspace: {},
  };
}

function shouldIgnoreVersion(
  state: WorkspaceLifecycleState,
  event: { workspaceId: string; version?: number },
) {
  if (event.version === undefined) return false;
  if (event.version === state.activationVersion) return false;
  return state.activeWorkspaceId !== event.workspaceId;
}

function setEntry(
  state: WorkspaceLifecycleState,
  workspaceId: string,
  patch: Omit<Partial<WorkspaceLifecycleEntry>, "workspaceId" | "updatedAt">,
): WorkspaceLifecycleState {
  const current = state.byWorkspace[workspaceId] ?? {
    workspaceId,
    phase: "idle" as const,
    updatedAt: now(),
  };
  return {
    ...state,
    byWorkspace: {
      ...state.byWorkspace,
      [workspaceId]: {
        ...current,
        ...patch,
        workspaceId,
        updatedAt: now(),
      },
    },
  };
}

export function reduceWorkspaceLifecycleState(
  state: WorkspaceLifecycleState,
  event: WorkspaceLifecycleEvent,
): WorkspaceLifecycleState {
  if (event.type === "activation-started") {
    return setEntry(
      {
        ...state,
        activeWorkspaceId: event.workspaceId,
        activationVersion: event.version,
      },
      event.workspaceId,
      {
        phase: "activating",
        workspaceType: event.workspaceType,
        origin: event.origin,
        message: null,
        activationVersion: event.version,
      },
    );
  }

  if (event.type === "cleared") {
    const next = { ...state.byWorkspace };
    delete next[event.workspaceId];
    return { ...state, byWorkspace: next };
  }

  if (shouldIgnoreVersion(state, event)) return state;

  if (event.type === "browse-ready") {
    return setEntry(
      { ...state, activeWorkspaceId: event.workspaceId },
      event.workspaceId,
      {
        phase: "browsing",
        root: event.root,
        message: null,
      },
    );
  }

  if (event.type === "runtime-starting") {
    return setEntry(state, event.workspaceId, {
      phase: "runtime-starting",
      runtime: event.runtime,
      reason: event.reason,
      message: null,
    });
  }

  if (event.type === "connected") {
    return setEntry(state, event.workspaceId, {
      phase: "connected",
      runtime: event.runtime,
      reason: event.reason,
      message: null,
    });
  }

  if (event.type === "degraded") {
    return setEntry(state, event.workspaceId, {
      phase: "degraded",
      reason: event.reason,
      message: event.message,
    });
  }

  return setEntry(state, event.workspaceId, {
    phase: "error",
    message: event.message,
  });
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-lifecycle-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/app/src/app/context/workspace-lifecycle-state.ts packages/app/src/app/tests/context/workspace-lifecycle-state.test.ts
git commit -m "feat: add workspace lifecycle reducer"
```

---

### Task 3: Move Shared Workspace Types Out Of The Facade

**Files:**
- Create: `packages/app/src/app/context/workspace-types.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/stores/remote-store.ts`
- Modify: `packages/app/src/app/context/workspace-send-target.ts`
- Modify if needed: `packages/app/src/app/pages/session-navigation.ts`

- [x] **Step 1: Write source assertion**

Add this test to `packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts`:

```typescript
test("workspace activation options live in the shared workspace-types module", () => {
  const typesSource = readContextSource("workspace-types.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(
    typesSource,
    /export type WorkspaceActivationOptions = \{/,
    "WorkspaceActivationOptions should live in workspace-types.ts",
  );

  assert.doesNotMatch(
    facadeSource,
    /export type WorkspaceActivationOptions = \{/,
    "workspace.ts should re-export shared activation types instead of owning them",
  );
});
```

Also update the imports at the top of the test:

```typescript
import {
  readContextSource,
  readWorkspaceBehaviorSources,
  readWorkspaceFacadeSource,
} from "./workspace-source";
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-activate-order-sync.test.ts
```

Expected: FAIL because `workspace-types.ts` does not exist or does not export the type.

- [x] **Step 3: Create shared type module**

Create `packages/app/src/app/context/workspace-types.ts`:

```typescript
import type { OpencodeAuth } from "../lib/opencode";
import type { WorkspaceInfo } from "../lib/tauri";

export type WorkspaceActivationOptions = {
  origin: string;
  promoteToFront?: boolean;
};

export type WorkspaceConnectContext = {
  workspaceId?: string;
  workspaceType?: WorkspaceInfo["workspaceType"];
  targetRoot?: string;
  reason?: string;
};

export type WorkspaceConnectOptions = {
  quiet?: boolean;
  navigate?: boolean;
  forceRefresh?: boolean;
};

export type ConnectToServer = (
  nextBaseUrl: string,
  directory?: string,
  context?: WorkspaceConnectContext,
  auth?: OpencodeAuth,
  connectOptions?: WorkspaceConnectOptions,
) => Promise<boolean>;
```

- [x] **Step 4: Update imports and re-export**

In `packages/app/src/app/context/workspace.ts`, replace the local `WorkspaceActivationOptions` type with:

```typescript
export type {
  ConnectToServer,
  WorkspaceActivationOptions,
  WorkspaceConnectContext,
  WorkspaceConnectOptions,
} from "./workspace-types";
import type {
  ConnectToServer,
  WorkspaceActivationOptions,
  WorkspaceConnectContext,
  WorkspaceConnectOptions,
} from "./workspace-types";
```

In `packages/app/src/app/stores/remote-store.ts`, replace:

```typescript
import type { WorkspaceActivationOptions } from "../context/workspace";
```

with:

```typescript
import type { WorkspaceActivationOptions, WorkspaceConnectOptions } from "../context/workspace-types";
```

Then update the `connectToServer` dependency type to use `WorkspaceConnectOptions`.

- [x] **Step 5: Run typecheck and source test**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-activate-order-sync.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/app/src/app/context/workspace-types.ts packages/app/src/app/context/workspace.ts packages/app/src/app/stores/remote-store.ts packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts
git commit -m "refactor: share workspace context types"
```

---

### Task 4: Extract Debug And Busy State Helpers

**Files:**
- Create: `packages/app/src/app/context/workspace-debug.ts`
- Create: `packages/app/src/app/context/workspace-busy-state.ts`
- Create: `packages/app/src/app/tests/context/workspace-busy-state.test.ts`
- Modify: `packages/app/src/app/context/workspace.ts`

- [x] **Step 1: Write busy-state test**

Create `packages/app/src/app/tests/context/workspace-busy-state.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import { createWorkspaceBusyState } from "../../context/workspace-busy-state";

test("workspace busy state tracks and clears by session id", () => {
  createRoot((dispose) => {
    const events: Array<{ event: string; payload?: Record<string, unknown> }> = [];
    const busy = createWorkspaceBusyState((event, payload) => {
      events.push({ event, payload });
    });

    busy.markWorkspaceBusy(" ws-a ", "session-1");
    assert.equal(busy.workspaceBusy()["ws-a"]?.sessionId, "session-1");

    busy.clearWorkspaceBusy("ws-a", "different-session");
    assert.equal(busy.workspaceBusy()["ws-a"]?.sessionId, "session-1");

    busy.clearWorkspaceBusy("ws-a", "session-1");
    assert.equal(busy.workspaceBusy()["ws-a"], undefined);
    assert.deepEqual(events.map((entry) => entry.event), ["mark", "clear"]);

    dispose();
  });
});

test("clear all except preserves the selected workspace only", () => {
  createRoot((dispose) => {
    const busy = createWorkspaceBusyState();

    busy.markWorkspaceBusy("ws-a", "session-a");
    busy.markWorkspaceBusy("ws-b", "session-b");
    busy.clearWorkspaceBusyAllExcept("ws-b");

    assert.equal(busy.workspaceBusy()["ws-a"], undefined);
    assert.equal(busy.workspaceBusy()["ws-b"]?.sessionId, "session-b");

    dispose();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-busy-state.test.ts
```

Expected: FAIL with module not found.

- [x] **Step 3: Create debug helpers**

Create `packages/app/src/app/context/workspace-debug.ts`:

```typescript
import { createSignal } from "solid-js";

import type { WorkspaceDebugEvent } from "./workspace";

export type WorkspaceBusyMap = Record<string, { sessionId: string; startedAt: number }>;

type WorkspaceBusyTraceRoot = typeof window & {
  __vesloWorkspaceBusyTrace?: Array<Record<string, unknown>>;
  __vesloWorkspaceBusySnapshot?: WorkspaceBusyMap;
};

export function recordWorkspaceBusyTrace(
  event: string,
  payload?: Record<string, unknown>,
) {
  if (typeof window === "undefined") return;
  try {
    const root = window as WorkspaceBusyTraceRoot;
    const logs = root.__vesloWorkspaceBusyTrace ?? [];
    logs.push({
      at: new Date().toISOString(),
      ts: Date.now(),
      source: "workspace",
      event,
      ...(payload ?? {}),
    });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    root.__vesloWorkspaceBusyTrace = logs;
    if (payload?.next && typeof payload.next === "object") {
      root.__vesloWorkspaceBusySnapshot = payload.next as WorkspaceBusyMap;
    }
    console.log("[workspace:busy]", event, payload ?? {});
  } catch {
    // ignore
  }
}

export function wsLog(msg: string, data?: unknown) {
  const line = `[${new Date().toISOString()}] ${msg}${
    data !== undefined ? " " + (typeof data === "string" ? data : JSON.stringify(data)) : ""
  }`;
  console.log(line);
  try {
    (window as any).__wsActivateLog = ((window as any).__wsActivateLog || "") + line + "\n";
  } catch {
    // ignore
  }
  try {
    void import("../lib/tauri")
      .then((mod) => mod.logUiEvent("workspace", msg, data))
      .catch(() => {});
  } catch {
    // ignore
  }
}

export const workspaceDebugStack = () => {
  try {
    return (new Error().stack ?? "")
      .split("\n")
      .slice(2, 9)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

export function createWorkspaceDebugEvents(enabled: () => boolean) {
  const limit = 200;
  const [workspaceDebugEvents, setWorkspaceDebugEvents] = createSignal<WorkspaceDebugEvent[]>([]);

  const clearWorkspaceDebugEvents = () => setWorkspaceDebugEvents([]);

  const pushWorkspaceDebugEvent = (label: string, payload?: unknown) => {
    if (!enabled()) return;
    const entry: WorkspaceDebugEvent = { at: Date.now(), label, payload };
    setWorkspaceDebugEvents((prev) => {
      if (!prev.length) return [entry];
      const sliceStart = Math.max(0, prev.length - limit + 1);
      const next = prev.slice(sliceStart);
      next.push(entry);
      return next;
    });
  };

  const wsDebug = (label: string, payload?: unknown) => {
    if (!enabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
      pushWorkspaceDebugEvent(label, payload);
    } catch {
      // ignore
    }
  };

  return {
    workspaceDebugEvents,
    clearWorkspaceDebugEvents,
    wsDebug,
  };
}
```

- [x] **Step 4: Create busy state helper**

Create `packages/app/src/app/context/workspace-busy-state.ts`:

```typescript
import { createSignal } from "solid-js";

import {
  recordWorkspaceBusyTrace,
  type WorkspaceBusyMap,
} from "./workspace-debug";

export type WorkspaceBusyTraceRecorder = (
  event: string,
  payload?: Record<string, unknown>,
) => void;

export function createWorkspaceBusyState(
  recordTrace: WorkspaceBusyTraceRecorder = recordWorkspaceBusyTrace,
) {
  const [workspaceBusy, setWorkspaceBusy] = createSignal<WorkspaceBusyMap>({});

  function markWorkspaceBusy(workspaceId: string, sessionId: string) {
    const id = workspaceId.trim();
    if (!id || !sessionId) return;
    setWorkspaceBusy((prev) => {
      const next = {
        ...prev,
        [id]: { sessionId, startedAt: Date.now() },
      };
      recordTrace("mark", {
        workspaceId: id,
        sessionId,
        previous: prev,
        next,
      });
      return next;
    });
  }

  function clearWorkspaceBusy(workspaceId: string, sessionId?: string) {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceBusy((prev) => {
      const entry = prev[id];
      if (!entry) return prev;
      if (sessionId && entry.sessionId !== sessionId) return prev;
      const next = { ...prev };
      delete next[id];
      recordTrace("clear", {
        workspaceId: id,
        sessionId: sessionId ?? null,
        previous: prev,
        next,
      });
      return next;
    });
  }

  function clearWorkspaceBusyAllExcept(workspaceId: string) {
    const keep = workspaceId.trim();
    setWorkspaceBusy((prev) => {
      const next: WorkspaceBusyMap = {};
      if (keep && prev[keep]) next[keep] = prev[keep];
      recordTrace("clear-all-except", {
        keepWorkspaceId: keep || null,
        previous: prev,
        next,
        droppedWorkspaceIds: Object.keys(prev).filter((id) => id !== keep),
      });
      return next;
    });
  }

  return {
    workspaceBusy,
    markWorkspaceBusy,
    clearWorkspaceBusy,
    clearWorkspaceBusyAllExcept,
  };
}
```

- [x] **Step 5: Wire workspace.ts**

In `workspace.ts`, import:

```typescript
import {
  createWorkspaceDebugEvents,
  wsLog as _wsLog,
  workspaceDebugStack,
} from "./workspace-debug";
import { createWorkspaceBusyState } from "./workspace-busy-state";
```

Replace local debug signal setup with:

```typescript
const {
  workspaceDebugEvents,
  clearWorkspaceDebugEvents,
  wsDebug,
} = createWorkspaceDebugEvents(() => options.developerMode());
```

Replace local busy signal/functions with:

```typescript
const {
  workspaceBusy,
  markWorkspaceBusy,
  clearWorkspaceBusy,
  clearWorkspaceBusyAllExcept,
} = createWorkspaceBusyState();
```

Remove the old local `WorkspaceBusyMap`, `WorkspaceBusyTraceRoot`, `recordWorkspaceBusyTrace`, `_wsLog`, `workspaceDebugStack`, debug event helpers, and busy functions from `workspace.ts`.

- [x] **Step 6: Run targeted tests and typecheck**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-busy-state.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/app/src/app/context/workspace-debug.ts packages/app/src/app/context/workspace-busy-state.ts packages/app/src/app/context/workspace.ts packages/app/src/app/tests/context/workspace-busy-state.test.ts
git commit -m "refactor: extract workspace debug and busy state"
```

---

### Task 5: Extract Workspace Connection State Map

**Files:**
- Create: `packages/app/src/app/context/workspace-connection-state.ts`
- Create: `packages/app/src/app/tests/context/workspace-connection-state.test.ts`
- Modify: `packages/app/src/app/context/workspace.ts`

- [ ] **Step 1: Write connection-state tests**

Create `packages/app/src/app/tests/context/workspace-connection-state.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { createRoot, createSignal } from "solid-js";

import { createWorkspaceConnectionState } from "../../context/workspace-connection-state";
import type { WorkspaceInfo } from "../../lib/tauri";

const workspace = (id: string): WorkspaceInfo =>
  ({
    id,
    name: id,
    path: `C:/work/${id}`,
    preset: "starter",
    workspaceType: "local",
  }) as WorkspaceInfo;

test("connection state is updated with checkedAt", () => {
  createRoot((dispose) => {
    const [workspaces] = createSignal([workspace("ws-a")]);
    const state = createWorkspaceConnectionState(workspaces);

    state.updateWorkspaceConnectionState(" ws-a ", {
      status: "connecting",
      message: null,
    });

    const entry = state.workspaceConnectionStateById()["ws-a"];
    assert.equal(entry.status, "connecting");
    assert.equal(entry.message, null);
    assert.equal(typeof entry.checkedAt, "number");

    dispose();
  });
});

test("connection state can be cleared by workspace id", () => {
  createRoot((dispose) => {
    const [workspaces] = createSignal([workspace("ws-a")]);
    const state = createWorkspaceConnectionState(workspaces);

    state.updateWorkspaceConnectionState("ws-a", {
      status: "error",
      message: "failed",
    });
    state.clearWorkspaceConnectionState("ws-a");

    assert.equal(state.workspaceConnectionStateById()["ws-a"], undefined);

    dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-connection-state.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement connection-state module**

Create `packages/app/src/app/context/workspace-connection-state.ts`:

```typescript
import { createEffect, createSignal } from "solid-js";

import type { WorkspaceConnectionState } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";

export function createWorkspaceConnectionState(
  getWorkspaces: () => WorkspaceInfo[],
) {
  const [workspaceConnectionStateById, setWorkspaceConnectionStateById] =
    createSignal<Record<string, WorkspaceConnectionState>>({});

  const updateWorkspaceConnectionState = (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      const current = prev[id] ?? { status: "idle", message: null, checkedAt: null };
      return {
        ...prev,
        [id]: {
          ...current,
          ...next,
          checkedAt: Date.now(),
        },
      };
    });
  };

  const clearWorkspaceConnectionState = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  createEffect(() => {
    const ids = new Set(getWorkspaces().map((workspace) => workspace.id));
    setWorkspaceConnectionStateById((prev) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [id, state] of Object.entries(prev)) {
        if (!ids.has(id)) {
          changed = true;
          continue;
        }
        next[id] = state;
      }
      return changed ? next : prev;
    });
  });

  return {
    workspaceConnectionStateById,
    setWorkspaceConnectionStateById,
    updateWorkspaceConnectionState,
    clearWorkspaceConnectionState,
  };
}
```

- [ ] **Step 4: Wire workspace.ts**

In `workspace.ts`, import:

```typescript
import { createWorkspaceConnectionState } from "./workspace-connection-state";
```

Replace the local `workspaceConnectionStateById`, `setWorkspaceConnectionStateById`, `updateWorkspaceConnectionState`, `clearWorkspaceConnectionState`, and pruning `createEffect` with:

```typescript
const {
  workspaceConnectionStateById,
  setWorkspaceConnectionStateById,
  updateWorkspaceConnectionState,
  clearWorkspaceConnectionState,
} = createWorkspaceConnectionState(workspaces);
```

- [ ] **Step 5: Run targeted tests and typecheck**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-connection-state.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/app/src/app/context/workspace-connection-state.ts packages/app/src/app/context/workspace.ts packages/app/src/app/tests/context/workspace-connection-state.test.ts
git commit -m "refactor: extract workspace connection state"
```

---

### Task 6: Extract Routing-Only connectToServer Controller

**Files:**
- Create: `packages/app/src/app/context/workspace-connection-controller.ts`
- Create: `packages/app/src/app/tests/context/workspace-connection-controller-source.test.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts`

- [ ] **Step 1: Write source test for the controller boundary**

Create `packages/app/src/app/tests/context/workspace-connection-controller-source.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("connectToServer lives in routing-only connection controller", () => {
  const controllerSource = readContextSource("workspace-connection-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(
    controllerSource,
    /export function createWorkspaceConnectionController\(/,
    "connection controller factory should own connectToServer",
  );
  assert.match(
    controllerSource,
    /routing\.ensure\(/,
    "connectToServer must use WorkspaceRouting.ensure",
  );
  assert.doesNotMatch(
    controllerSource,
    /const run = \(async \(\) => \{/,
    "old single-active connect fallback must not move into the controller",
  );
  assert.doesNotMatch(
    facadeSource,
    /async function connectToServer\(/,
    "workspace.ts should receive connectToServer from the controller",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-connection-controller-source.test.ts
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Create controller shell**

Create `packages/app/src/app/context/workspace-connection-controller.ts` with the dependency interface and `connectRequestKey` helpers:

```typescript
import type { Accessor } from "solid-js";

import { reportError } from "../lib/error-reporter";
import type { OpencodeAuth } from "../lib/opencode";
import type { WorkspaceRouting } from "./workspace-routing";
import type {
  WorkspaceConnectContext,
  WorkspaceConnectOptions,
} from "./workspace-types";

export type WorkspaceConnectionControllerDeps = {
  routing: WorkspaceRouting;
  activeWorkspaceId: Accessor<string>;
  activeWorkspaceRoot: Accessor<string>;
  baseUrl: Accessor<string>;
  client: Accessor<unknown>;
  clientDirectory: Accessor<string>;
  selectedSessionId: Accessor<string | null>;
  setClient: (value: any) => void;
  setConnectedVersion: (value: string | null) => void;
  setBaseUrl: (value: string) => void;
  setClientDirectory: (value: string) => void;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setSseConnected: (value: boolean) => void;
  setTab: (value: any) => void;
  setView: (value: any) => void;
  setOpencodeConnectStatus?: (status: any) => void;
  loadSessions: (scopeRoot?: string) => Promise<void>;
  refreshPendingPermissions: () => Promise<void>;
  onEngineStable?: () => void;
  wsDebug: (label: string, payload?: unknown) => void;
};

const connectRequestKey = (
  nextBaseUrl: string,
  directory?: string,
  context?: WorkspaceConnectContext,
  auth?: OpencodeAuth,
  connectOptions?: WorkspaceConnectOptions,
) =>
  [
    nextBaseUrl.trim(),
    (directory ?? "").trim(),
    context?.workspaceId?.trim() ?? "",
    context?.workspaceType ?? "",
    context?.targetRoot?.trim() ?? "",
    context?.reason ?? "",
    auth?.mode ?? (auth ? "basic" : "none"),
    String(connectOptions?.quiet ?? false),
    String(connectOptions?.navigate ?? true),
  ].join("::");

export function createWorkspaceConnectionController(
  deps: WorkspaceConnectionControllerDeps,
) {
  const connectInFlightByKey = new Map<string, Promise<boolean>>();

  async function connectToServer(
    nextBaseUrl: string,
    directory?: string,
    context?: WorkspaceConnectContext,
    auth?: OpencodeAuth,
    connectOptions?: WorkspaceConnectOptions,
  ) {
    const requestKey = connectRequestKey(nextBaseUrl, directory, context, auth, connectOptions);
    const existing = connectInFlightByKey.get(requestKey);
    if (existing) {
      deps.wsDebug("connect:dedupe", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        workspaceType: context?.workspaceType ?? null,
      });
      return existing;
    }

    const incomingDirectory = directory?.trim() ?? "";
    const activeRoot = deps.activeWorkspaceRoot().trim();
    if (
      context?.workspaceType === "local" &&
      activeRoot &&
      incomingDirectory &&
      activeRoot !== incomingDirectory
    ) {
      deps.wsDebug("connect:abort-stale-workspace", {
        baseUrl: nextBaseUrl,
        directory: incomingDirectory,
        activeRoot,
        reason: context?.reason ?? null,
      });
      return false;
    }

    const guardWorkspaceId = (context?.workspaceId ?? deps.activeWorkspaceId() ?? "").trim();
    const cachedRoutingClient = guardWorkspaceId ? deps.routing.client(guardWorkspaceId) : null;
    if (
      !connectOptions?.forceRefresh &&
      deps.client() &&
      cachedRoutingClient &&
      (deps.baseUrl()?.trim() ?? "") === nextBaseUrl &&
      (deps.clientDirectory()?.trim() ?? "") === incomingDirectory
    ) {
      deps.wsDebug("connect:idempotent-skip", {
        baseUrl: nextBaseUrl,
        directory: incomingDirectory || null,
        reason: context?.reason ?? null,
      });
      return true;
    }

    const workspaceId = context?.workspaceId ?? deps.activeWorkspaceId().trim() ?? "";
    if (!workspaceId) {
      deps.wsDebug("connect:no-workspace-id", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
      });
      deps.setError("Connect requires a workspace id");
      return false;
    }

    const run = (async () => {
      const connectStart = Date.now();
      const quiet = connectOptions?.quiet ?? false;
      const quietPortRefresh = quiet && context?.reason === "port-rotation";
      const navigate = connectOptions?.navigate ?? true;
      deps.setError(null);
      if (!quiet) {
        deps.setBusy(true);
        deps.setBusyLabel("status.connecting");
        deps.setBusyStartedAt(Date.now());
      }
      deps.setSseConnected(false);

      try {
        const entry = await deps.routing.ensure(workspaceId, nextBaseUrl, {
          directory: incomingDirectory || undefined,
          auth,
          skipHealth: quietPortRefresh,
          context: {
            workspaceType: context?.workspaceType,
            targetRoot: context?.targetRoot,
            reason: context?.reason,
          },
        });
        if (!entry) {
          const detail = deps.routing.lastEnsureError(workspaceId);
          const message = detail
            ? `Failed to ensure workspace client: ${detail}`
            : "Failed to ensure workspace client";
          deps.setError(message);
          deps.setOpencodeConnectStatus?.({
            at: Date.now(),
            baseUrl: nextBaseUrl,
            directory: directory ?? null,
            reason: context?.reason ?? null,
            status: "error",
            error: message,
          });
          return false;
        }

        const currentActiveId = deps.activeWorkspaceId().trim();
        const currentActiveRoot = deps.activeWorkspaceRoot().trim();
        if (
          context?.workspaceType === "local" &&
          ((currentActiveId && currentActiveId !== workspaceId) ||
            (currentActiveRoot && incomingDirectory && currentActiveRoot !== incomingDirectory))
        ) {
          deps.wsDebug("connect:abort-stale-after-ensure", {
            workspaceId,
            activeWorkspaceId: currentActiveId || null,
            baseUrl: nextBaseUrl,
            directory: incomingDirectory || null,
            activeRoot: currentActiveRoot || null,
            reason: context?.reason ?? null,
            ms: Date.now() - connectStart,
          });
          return false;
        }

        deps.setClient(entry.client);
        deps.setConnectedVersion(null);
        deps.setBaseUrl(nextBaseUrl);
        deps.setClientDirectory(entry.directory ?? incomingDirectory);

        if (quietPortRefresh) {
          deps.wsDebug("connect:proxy-bound", {
            workspaceId,
            ms: Date.now() - connectStart,
            reason: context?.reason ?? null,
          });
          return true;
        }

        try {
          await deps.loadSessions(context?.targetRoot);
        } catch (error) {
          reportError(error, "workspace.connect.loadSessions");
        }

        try {
          await deps.refreshPendingPermissions();
        } catch (error) {
          reportError(error, "workspace.connect.refreshPendingPermissions");
        }

        if (navigate && !deps.selectedSessionId()) {
          deps.setTab("scheduled");
          deps.setView("session");
        }
        deps.onEngineStable?.();
        deps.setOpencodeConnectStatus?.({
          at: Date.now(),
          baseUrl: nextBaseUrl,
          directory: directory ?? null,
          reason: context?.reason ?? null,
          status: "connected",
          error: null,
        });
        deps.wsDebug("connect:done", { ok: true, ms: Date.now() - connectStart });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown connect error";
        deps.setError(message);
        deps.setOpencodeConnectStatus?.({
          at: Date.now(),
          baseUrl: nextBaseUrl,
          directory: directory ?? null,
          reason: context?.reason ?? null,
          status: "error",
          error: message,
        });
        return false;
      } finally {
        if (!quiet) deps.setBusy(false);
      }
    })();

    connectInFlightByKey.set(requestKey, run);
    try {
      return await run;
    } finally {
      connectInFlightByKey.delete(requestKey);
    }
  }

  return { connectToServer };
}
```

- [ ] **Step 4: Wire workspace.ts**

In `workspace.ts`, import:

```typescript
import { createWorkspaceConnectionController } from "./workspace-connection-controller";
```

Instantiate after `activeWorkspaceRoot` and before any dependent stores:

```typescript
const connectionController = createWorkspaceConnectionController({
  routing: options.routing,
  activeWorkspaceId,
  activeWorkspaceRoot,
  baseUrl: options.baseUrl,
  client: options.client,
  clientDirectory: options.clientDirectory,
  selectedSessionId: options.selectedSessionId,
  setClient: options.setClient,
  setConnectedVersion: options.setConnectedVersion,
  setBaseUrl: options.setBaseUrl,
  setClientDirectory: options.setClientDirectory,
  setError: options.setError,
  setBusy: options.setBusy,
  setBusyLabel: options.setBusyLabel,
  setBusyStartedAt: options.setBusyStartedAt,
  setSseConnected: options.setSseConnected,
  setTab: options.setTab,
  setView: options.setView,
  setOpencodeConnectStatus: options.setOpencodeConnectStatus,
  loadSessions: options.loadSessions,
  refreshPendingPermissions: options.refreshPendingPermissions,
  onEngineStable: options.onEngineStable,
  wsDebug,
});
const connectToServer = connectionController.connectToServer;
```

Remove the old local `connectInFlightByKey`, `connectRequestKey`, `resolveConnectHealthTimeoutMs`, provider-list fallback code, and old single-active unreachable block from `workspace.ts`.

- [ ] **Step 5: Update characterization test expectations**

In `workspace-activate-order-sync.test.ts`, update `connectStart` source slicing to use `readContextSource("workspace-connection-controller.ts")`.

Replace assertions that search for `options.setClient(nextClient)` with assertions for the routing-only path:

```typescript
const connectSource = readContextSource("workspace-connection-controller.ts");
assert.match(connectSource, /const entry = await deps\.routing\.ensure\(/);
assert.match(connectSource, /deps\.setClient\(entry\.client\);/);
assert.doesNotMatch(connectSource, /createClient\(nextBaseUrl/);
```

- [ ] **Step 6: Run targeted tests and typecheck**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-connection-controller-source.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/app/src/app/context/workspace-connection-controller.ts packages/app/src/app/context/workspace.ts packages/app/src/app/tests/context/workspace-connection-controller-source.test.ts packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts
git commit -m "refactor: extract routing workspace connection controller"
```

---

### Task 7: Extract Skill Materialization Gate

**Files:**
- Create: `packages/app/src/app/context/workspace-skill-materialization.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/tests/context/workspace-skill-materialization-sync.test.ts`

- [ ] **Step 1: Update source test target**

In `workspace-skill-materialization-sync.test.ts`, replace ranges based on `workspace.ts` function order with:

```typescript
const source = readContextSource("workspace-skill-materialization.ts");
```

Keep assertions for:

```typescript
/export function createWorkspaceSkillMaterializationGate\(/
/getWorkspaceSkillMaterializationStatus\(/
/syncWorkspaceSkillMaterialization\(/
/denApiBase:\s*denAuth\?\.denApiBase\?\.trim\(\)\s*\|\|\s*undefined/
/activeRun: true/
/function isSkillRegistryMaterializationError\(error: unknown\): boolean \{/
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-skill-materialization-sync.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Create skill materialization module**

Create `packages/app/src/app/context/workspace-skill-materialization.ts` by moving the exact current implementations of:

```typescript
function isSkillRegistryMaterializationError(error: unknown): boolean
async function syncWorkspaceSkillMaterializationBeforeRuntime(workspace: WorkspaceInfo, context?: { reason?: string })
```

Wrap the sync function in this factory:

```typescript
export type WorkspaceSkillMaterializationGateDeps = {
  workspaceBusy: () => Record<string, { sessionId: string; startedAt: number }>;
  ensureLocalVesloServerRunning?: () => Promise<boolean>;
  vesloServerClient?: () => VesloServerClient | null;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  setError: (value: string | null) => void;
  updateWorkspaceConnectionState: (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => void;
  wsDebug: (label: string, payload?: unknown) => void;
};

export function createWorkspaceSkillMaterializationGate(
  deps: WorkspaceSkillMaterializationGateDeps,
) {
  async function syncWorkspaceSkillMaterializationBeforeRuntime(
    workspace: WorkspaceInfo,
    context?: { reason?: string },
  ): Promise<boolean>;

  return { syncWorkspaceSkillMaterializationBeforeRuntime };
}
```

Move the current `syncWorkspaceSkillMaterializationBeforeRuntime` body from `workspace.ts` into the function above. Preserve every branch and make only these dependency-name replacements:

```text
options.ensureLocalVesloServerRunning -> deps.ensureLocalVesloServerRunning
options.vesloServerClient -> deps.vesloServerClient
options.refreshSkills -> deps.refreshSkills
options.setError -> deps.setError
workspaceBusy -> deps.workspaceBusy
updateWorkspaceConnectionState -> deps.updateWorkspaceConnectionState
wsDebug -> deps.wsDebug
```

- [ ] **Step 4: Wire workspace.ts**

In `workspace.ts`, import:

```typescript
import { createWorkspaceSkillMaterializationGate } from "./workspace-skill-materialization";
```

Instantiate:

```typescript
const skillMaterializationGate = createWorkspaceSkillMaterializationGate({
  workspaceBusy,
  ensureLocalVesloServerRunning: options.ensureLocalVesloServerRunning,
  vesloServerClient: options.vesloServerClient,
  refreshSkills: options.refreshSkills,
  setError: options.setError,
  updateWorkspaceConnectionState,
  wsDebug,
});
const syncWorkspaceSkillMaterializationBeforeRuntime =
  skillMaterializationGate.syncWorkspaceSkillMaterializationBeforeRuntime;
```

Remove the old local `isSkillRegistryMaterializationError` and `syncWorkspaceSkillMaterializationBeforeRuntime` from `workspace.ts`.

- [ ] **Step 5: Run tests**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/app/src/app/context/workspace-skill-materialization.ts packages/app/src/app/context/workspace.ts packages/app/src/app/tests/context/workspace-skill-materialization-sync.test.ts
git commit -m "refactor: extract workspace skill materialization gate"
```

---

### Task 8: Extract Veslo Server Workspace Registry Sync

**Files:**
- Create: `packages/app/src/app/context/workspace-server-registry.ts`
- Create: `packages/app/src/app/tests/context/workspace-server-registry-source.test.ts`
- Modify: `packages/app/src/app/context/workspace.ts`

- [ ] **Step 1: Write source test**

Create `packages/app/src/app/tests/context/workspace-server-registry-source.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("veslo server registry sync lives outside workspace facade", () => {
  const registrySource = readContextSource("workspace-server-registry.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(registrySource, /export function createWorkspaceServerRegistry\(/);
  assert.match(registrySource, /addLocalWorkspace\(\{ path: trimmed/);
  assert.match(registrySource, /reconcileManagedAiApiKeys/);
  assert.match(registrySource, /activateWorkspace\(match\.id\)/);
  assert.doesNotMatch(facadeSource, /const reconcileManagedAiApiKeys = async/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-server-registry-source.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Create server registry module**

Create `packages/app/src/app/context/workspace-server-registry.ts` and move the current implementations of:

```typescript
async function activateVesloHostWorkspace(workspacePath: string)
async function addLocalWorkspaceOnServer(path: string, name?: string)
async function reconcileVesloServerWorkspaces()
async function reconcileManagedAiApiKeys()
```

Use this factory wrapper:

```typescript
import type { WorkspaceInfo } from "../lib/tauri";
import type { VesloServerClient } from "../lib/veslo-server";

export type WorkspaceServerRegistryDeps = {
  getWorkspaces: () => WorkspaceInfo[];
  vesloServerClient?: () => VesloServerClient | null;
  vesloServerHostInfo?: () => {
    baseUrl?: string | null;
    engineUrl?: string | null;
    clientToken?: string | null;
  } | null;
  wsDebug: (label: string, payload?: unknown) => void;
};

export function createWorkspaceServerRegistry(deps: WorkspaceServerRegistryDeps) {
  async function addLocalWorkspaceOnServer(path: string, name?: string): Promise<void>;

  async function activateVesloHostWorkspace(workspacePath: string): Promise<void>;

  async function reconcileManagedAiApiKeys(): Promise<void>;

  async function reconcileVesloServerWorkspaces(): Promise<void>;

  return {
    activateVesloHostWorkspace,
    addLocalWorkspaceOnServer,
    reconcileVesloServerWorkspaces,
    reconcileManagedAiApiKeys,
  };
}
```

Move the current bodies from `workspace.ts` into the declarations above. Preserve the existing 409 handling, active-workspace short circuit, token/baseURL rewrite logic, and final `await reconcileManagedAiApiKeys()` call. Apply only these dependency replacements:

```text
options.vesloServerClient -> deps.vesloServerClient
options.vesloServerHostInfo -> deps.vesloServerHostInfo
workspaces() -> deps.getWorkspaces()
wsDebug -> deps.wsDebug
```

- [ ] **Step 4: Wire workspace.ts**

In `workspace.ts`, import:

```typescript
import { createWorkspaceServerRegistry } from "./workspace-server-registry";
```

Instantiate:

```typescript
const serverRegistry = createWorkspaceServerRegistry({
  getWorkspaces: workspaces,
  vesloServerClient: options.vesloServerClient,
  vesloServerHostInfo: options.vesloServerHostInfo,
  wsDebug,
});
const activateVesloHostWorkspace = serverRegistry.activateVesloHostWorkspace;
const addLocalWorkspaceOnServer = serverRegistry.addLocalWorkspaceOnServer;
const reconcileVesloServerWorkspaces = serverRegistry.reconcileVesloServerWorkspaces;
```

Keep `reconcileVesloServerWorkspaces` in the returned store object.

- [ ] **Step 5: Run tests**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-server-registry-source.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/app/src/app/context/workspace-server-registry.ts packages/app/src/app/context/workspace.ts packages/app/src/app/tests/context/workspace-server-registry-source.test.ts
git commit -m "refactor: extract veslo server workspace registry"
```

---

### Task 9: Extract Runtime Ensure Controller

**Files:**
- Create: `packages/app/src/app/context/workspace-runtime-controller.ts`
- Create: `packages/app/src/app/tests/context/workspace-runtime-controller-source.test.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts`

- [ ] **Step 1: Write source test**

Create `packages/app/src/app/tests/context/workspace-runtime-controller-source.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("lazy runtime ensure lives in workspace runtime controller", () => {
  const runtimeSource = readContextSource("workspace-runtime-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(runtimeSource, /export function createWorkspaceRuntimeController\(/);
  assert.match(runtimeSource, /async function ensureEngineForWorkspace/);
  assert.match(runtimeSource, /connectMode: "quiet"/);
  assert.match(runtimeSource, /clearWorkspaceBusyAllExcept\(workspace\.id\)/);
  assert.doesNotMatch(facadeSource, /async function ensureEngineForWorkspace/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-runtime-controller-source.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Create runtime controller**

Create `packages/app/src/app/context/workspace-runtime-controller.ts` and move:

```typescript
async function connectToEngineQuiet(...)
async function refreshActiveClient(...)
async function ensureEngineForWorkspace(...)
```

Use this factory wrapper:

```typescript
import type { Accessor } from "solid-js";

import type { OpencodeAuth } from "../lib/opencode";
import type { EngineInfo, WorkspaceInfo } from "../lib/tauri";
import type { WorkspaceRouting } from "./workspace-routing";
import type { ConnectToServer } from "./workspace-types";
import type { createLocalRuntimeLifecycle } from "../utils/local-runtime-lifecycle";

export type WorkspaceRuntimeControllerDeps = {
  activeWorkspaceId: Accessor<string>;
  workspaces: Accessor<WorkspaceInfo[]>;
  workspacesHydrated: Accessor<boolean>;
  routing: WorkspaceRouting;
  resolveEngineRuntime: () => EngineInfo["runtime"];
  localRuntimeLifecycle: ReturnType<typeof createLocalRuntimeLifecycle>;
  connectToServer: ConnectToServer;
  loadSessions: (scopeRoot?: string) => Promise<void>;
  setClient: (value: any) => void;
  setConnectedVersion: (value: string | null) => void;
  setBaseUrl: (value: string) => void;
  setClientDirectory: (value: string) => void;
  setEngineReady?: (value: boolean) => void;
  setError: (value: string | null) => void;
  updateWorkspaceConnectionState: (workspaceId: string, next: any) => void;
  onEngineStable?: () => void;
  clearWorkspaceBusyAllExcept: (workspaceId: string) => void;
  syncWorkspaceSkillMaterializationBeforeRuntime: (
    workspace: WorkspaceInfo,
    context?: { reason?: string },
  ) => Promise<boolean>;
  createClient: (baseUrl: string, directory: string, auth?: OpencodeAuth) => any;
  waitForHealthy: (
    client: any,
    options?: { timeoutMs?: number },
  ) => Promise<{ healthy: boolean; version?: string }>;
  wsLog: (msg: string, data?: unknown) => void;
};

export function createWorkspaceRuntimeController(deps: WorkspaceRuntimeControllerDeps) {
  return {
    connectToEngineQuiet,
    refreshActiveClient,
    ensureEngineForWorkspace,
  };
}
```

Move the current bodies for `connectToEngineQuiet`, `refreshActiveClient`, and `ensureEngineForWorkspace` from `workspace.ts` into this factory. Preserve the existing single-flight wrapper, the five-second `workspacesHydrated` wait loop, the quiet port-rotation path, and the cold-start fallback from `restartWorkspaceRuntime` to `startHost`. Replace captured names with the matching `deps.*` fields from `WorkspaceRuntimeControllerDeps`.

Preserve the current behavior in `ensureEngineForWorkspace`:

```typescript
if (deps.resolveEngineRuntime() !== "veslo-orchestrator") {
  deps.clearWorkspaceBusyAllExcept(workspace.id);
}
```

- [ ] **Step 4: Wire workspace.ts**

Instantiate the runtime controller after `localRuntimeLifecycle` exists:

```typescript
const runtimeController = createWorkspaceRuntimeController({
  activeWorkspaceId,
  workspaces,
  workspacesHydrated,
  routing: options.routing,
  resolveEngineRuntime,
  localRuntimeLifecycle,
  connectToServer,
  loadSessions: options.loadSessions,
  setClient: options.setClient,
  setConnectedVersion: options.setConnectedVersion,
  setBaseUrl: options.setBaseUrl,
  setClientDirectory: options.setClientDirectory,
  setEngineReady: options.setEngineReady,
  setError: options.setError,
  updateWorkspaceConnectionState,
  onEngineStable: options.onEngineStable,
  clearWorkspaceBusyAllExcept,
  syncWorkspaceSkillMaterializationBeforeRuntime,
  createClient,
  waitForHealthy,
  wsLog: _wsLog,
});
const refreshActiveClient = runtimeController.refreshActiveClient;
const ensureEngineForWorkspace = runtimeController.ensureEngineForWorkspace;
```

Remove the local runtime-controller functions from `workspace.ts`.

- [ ] **Step 5: Run tests**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-runtime-controller-source.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/app/src/app/context/workspace-runtime-controller.ts packages/app/src/app/context/workspace.ts packages/app/src/app/tests/context/workspace-runtime-controller-source.test.ts packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts
git commit -m "refactor: extract workspace runtime controller"
```

---

### Task 10: Extract Local Workspace CRUD And Path Helpers

**Files:**
- Create: `packages/app/src/app/context/workspace-local-workspaces.ts`
- Create: `packages/app/src/app/tests/context/workspace-local-workspaces-source.test.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/tests/context/workspace-forget-mode.test.ts`

- [ ] **Step 1: Write source test**

Create `packages/app/src/app/tests/context/workspace-local-workspaces-source.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("local workspace CRUD lives outside workspace facade", () => {
  const localSource = readContextSource("workspace-local-workspaces.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(localSource, /export function createWorkspaceLocalWorkspaces\(/);
  assert.match(localSource, /async function createLocalWorkspace/);
  assert.match(localSource, /const mode = forgetOptions\?\.deleteLocalData \? "delete_local_data" : "detach_only";/);
  assert.match(localSource, /return \[existing, \.\.\.rest\];/);
  assert.doesNotMatch(facadeSource, /async function createLocalWorkspace/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-local-workspaces-source.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Create local workspace module**

Create `packages/app/src/app/context/workspace-local-workspaces.ts` and move:

```typescript
openEmptySession
activateFreshLocalWorkspace
createLocalWorkspace
createWorkspaceFlow
createScratchWorkspace
findLocalWorkspaceByPath
ensureWorkspaceForFolder
isPrivateWorkspacePath
ensureLocalWorkspaceActive
forgetWorkspace
pickWorkspaceFolder
updateWorkspaceDisplayName
normalizeRoots
resolveWorkspacePath
buildPrivateWorkspaceRoot
```

Use this dependency shape:

```typescript
export type WorkspaceLocalWorkspacesDeps = {
  workspaces: () => WorkspaceInfo[];
  setWorkspaces: (value: WorkspaceInfo[] | ((prev: WorkspaceInfo[]) => WorkspaceInfo[])) => void;
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  activeWorkspaceInfo: () => WorkspaceInfo | null;
  privateWorkspaceRoot: () => string;
  setPrivateWorkspaceRoot: (value: string) => void;
  syncActiveWorkspaceId: (id?: string) => void;
  routing: WorkspaceRouting;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean>;
  startHost: (opts?: { workspacePath?: string; navigate?: boolean }) => Promise<boolean>;
  openSessionState: {
    loadSessions: (scopeRoot?: string) => Promise<void>;
    setSelectedSessionId: (value: string | null) => void;
    setMessages: (value: any[]) => void;
    setTodos: (value: any[]) => void;
    setPendingPermissions: (value: any[]) => void;
    setSessionStatusById: (value: Record<string, string>) => void;
    setView: (value: any) => void;
    setTab: (value: any) => void;
  };
  updateWorkspaceConnectionState: (workspaceId: string, next: any) => void;
  clearWorkspaceConnectionState: (workspaceId: string) => void;
  setProjectDir: (value: string) => void;
  setCreateWorkspaceOpen: (value: boolean) => void;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  markOnboardingComplete: () => void;
  makeRunId: () => string;
  blockLocalAction: (code: string, detail: string) => boolean;
};
```

Move the existing bodies and replace captured names with `deps.*`.

- [ ] **Step 4: Wire workspace.ts**

Instantiate after `engineStore` and before `configStore`:

```typescript
const localWorkspaces = createWorkspaceLocalWorkspaces({
  workspaces,
  setWorkspaces,
  activeWorkspaceId,
  activeWorkspaceRoot,
  activeWorkspaceInfo,
  privateWorkspaceRoot,
  setPrivateWorkspaceRoot,
  syncActiveWorkspaceId,
  routing: options.routing,
  activateWorkspace,
  startHost: engineStore.startHost,
  openSessionState: {
    loadSessions: options.loadSessions,
    setSelectedSessionId: options.setSelectedSessionId,
    setMessages: options.setMessages,
    setTodos: options.setTodos,
    setPendingPermissions: options.setPendingPermissions,
    setSessionStatusById: options.setSessionStatusById,
    setView: options.setView,
    setTab: options.setTab,
  },
  updateWorkspaceConnectionState,
  clearWorkspaceConnectionState,
  setProjectDir,
  setCreateWorkspaceOpen,
  setError: options.setError,
  setBusy: options.setBusy,
  setBusyLabel: options.setBusyLabel,
  setBusyStartedAt: options.setBusyStartedAt,
  markOnboardingComplete,
  makeRunId,
  blockLocalAction,
});
```

Expose local variables from `localWorkspaces` for existing store wiring:

```typescript
const openEmptySession = localWorkspaces.openEmptySession;
const activateFreshLocalWorkspace = localWorkspaces.activateFreshLocalWorkspace;
const createWorkspaceFlow = localWorkspaces.createWorkspaceFlow;
const createScratchWorkspace = localWorkspaces.createScratchWorkspace;
const ensureLocalWorkspaceActive = localWorkspaces.ensureLocalWorkspaceActive;
const ensureWorkspaceForFolder = localWorkspaces.ensureWorkspaceForFolder;
const forgetWorkspace = localWorkspaces.forgetWorkspace;
const pickWorkspaceFolder = localWorkspaces.pickWorkspaceFolder;
const updateWorkspaceDisplayName = localWorkspaces.updateWorkspaceDisplayName;
const normalizeRoots = localWorkspaces.normalizeRoots;
const resolveWorkspacePath = localWorkspaces.resolveWorkspacePath;
const isPrivateWorkspacePath = localWorkspaces.isPrivateWorkspacePath;
```

- [ ] **Step 5: Run tests**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-local-workspaces-source.test.ts src/app/tests/context/workspace-forget-mode.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/app/src/app/context/workspace-local-workspaces.ts packages/app/src/app/context/workspace.ts packages/app/src/app/tests/context/workspace-local-workspaces-source.test.ts packages/app/src/app/tests/context/workspace-forget-mode.test.ts
git commit -m "refactor: extract local workspace operations"
```

---

### Task 11: Extract Activation Controller And Wire Lifecycle State

**Files:**
- Create: `packages/app/src/app/context/workspace-activation-controller.ts`
- Create: `packages/app/src/app/tests/context/workspace-activation-controller-source.test.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts`
- Modify: `packages/app/src/app/tests/context/workspace-skill-materialization-sync.test.ts`

- [ ] **Step 1: Write source test**

Create `packages/app/src/app/tests/context/workspace-activation-controller-source.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("activateWorkspace is implemented by activation controller", () => {
  const activationSource = readContextSource("workspace-activation-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(activationSource, /export function createWorkspaceActivationController\(/);
  assert.match(activationSource, /async function activateWorkspace/);
  assert.match(activationSource, /type: "activation-started"/);
  assert.match(activationSource, /type: "browse-ready"/);
  assert.match(activationSource, /type: "runtime-starting"/);
  assert.match(activationSource, /activateRemoteVesloWorkspace/);
  assert.match(activationSource, /activateRemoteDirectWorkspace/);
  assert.match(activationSource, /enterLocalBrowseMode/);
  assert.match(activationSource, /restartLocalRuntimeForSwitch/);
  assert.doesNotMatch(facadeSource, /async function activateWorkspace/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-activation-controller-source.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Create activation controller**

Create `packages/app/src/app/context/workspace-activation-controller.ts`. Move the current `activateWorkspace` implementation and split it into these internal functions:

```typescript
async function activateRemoteVesloWorkspace(...)
async function activateRemoteDirectWorkspace(...)
async function prepareLocalWorkspaceSelection(...)
async function enterLocalBrowseMode(...)
async function restartLocalRuntimeForSwitch(...)
async function reconnectRemoteToLocalHost(...)
async function activateWorkspace(...)
```

Use this factory shape:

```typescript
import type { Accessor, Setter } from "solid-js";

import type { EngineInfo, WorkspaceInfo } from "../lib/tauri";
import type { WorkspaceRouting } from "./workspace-routing";
import type {
  WorkspaceActivationOptions,
  ConnectToServer,
} from "./workspace-types";
import type {
  WorkspaceLifecycleEvent,
  WorkspaceLifecycleState,
} from "./workspace-lifecycle-state";

export type WorkspaceActivationControllerDeps = {
  workspaces: Accessor<WorkspaceInfo[]>;
  setWorkspaces: Setter<WorkspaceInfo[]>;
  activeWorkspaceId: Accessor<string>;
  syncActiveWorkspaceId: (id?: string) => void;
  projectDir: Accessor<string>;
  setProjectDir: (value: string) => void;
  authorizedDirs: Accessor<string[]>;
  setAuthorizedDirs: (value: string[]) => void;
  activeWorkspaceRoot: Accessor<string>;
  routing: WorkspaceRouting;
  connectToServer: ConnectToServer;
  lifecycleState: Accessor<WorkspaceLifecycleState>;
  dispatchLifecycle: (event: WorkspaceLifecycleEvent) => void;
  wsActivateGuard: {
    enter(workspaceId: string): number;
    isSuperseded(version: number): boolean;
    exit(version: number, clearConnecting: (updater: (current: string | null) => string | null) => void): void;
  };
  localRuntimeLifecycle: {
    reattachOrchestratorWorkspace(input: any): Promise<boolean>;
    restartWorkspaceRuntime(input: any): Promise<boolean>;
  };
  engine: Accessor<EngineInfo | null>;
  startHost: (opts?: { workspacePath?: string; navigate?: boolean }) => Promise<boolean>;
  resolveEngineRuntime: () => EngineInfo["runtime"];
  syncWorkspaceSkillMaterializationBeforeRuntime: (
    workspace: WorkspaceInfo,
    context?: { reason?: string },
  ) => Promise<boolean>;
  setWorkspaceConfig: (value: any) => void;
  setWorkspaceConfigLoaded: (value: boolean) => void;
  setConnectingWorkspaceId: Setter<string | null>;
  setEngineReady?: (value: boolean) => void;
  populateSidebarFromDb?: (workspaceId: string, directory: string) => Promise<void>;
  hydrateLatestSessionFromDb?: (workspaceId: string, directory: string) => Promise<void>;
  updateWorkspaceConnectionState: (workspaceId: string, next: any) => void;
  blockLocalAction: (code: string, detail: string) => boolean;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setStartupPreference: (value: any) => void;
  setSelectedSessionId: (value: string | null) => void;
  setMessages: (value: any[]) => void;
  setTodos: (value: any[]) => void;
  setPendingPermissions: (value: any[]) => void;
  setSessionStatusById: (value: Record<string, string>) => void;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshPlugins: () => Promise<void>;
  vesloServerSettings: () => any;
  updateVesloServerSettings: (next: any) => void;
  resolveVesloHost: (...args: any[]) => Promise<any>;
  wsDebug: (label: string, payload?: unknown) => void;
  wsLog: (msg: string, data?: unknown) => void;
};
```

Inside `activateWorkspace`, dispatch lifecycle events at these points:

```typescript
deps.dispatchLifecycle({
  type: "activation-started",
  workspaceId: id,
  version: myVersion,
  origin: activationOptions.origin,
  workspaceType: next.workspaceType,
});
```

When browse-only SQLite hydration succeeds:

```typescript
deps.dispatchLifecycle({
  type: "browse-ready",
  workspaceId: id,
  version: myVersion,
  root: next.path,
});
```

Before local runtime restart:

```typescript
deps.dispatchLifecycle({
  type: "runtime-starting",
  workspaceId: id,
  runtime,
  reason: runtime === "veslo-orchestrator" ? "workspace-orchestrator-switch" : "workspace-restart",
});
```

After successful remote or local connect:

```typescript
deps.dispatchLifecycle({
  type: "connected",
  workspaceId: id,
  version: myVersion,
  runtime: deps.resolveEngineRuntime(),
  reason: activationOptions.origin,
});
```

On caught activation errors that return false:

```typescript
deps.dispatchLifecycle({
  type: "failed",
  workspaceId: id,
  version: myVersion,
  message,
});
```

- [ ] **Step 4: Wire lifecycle state in workspace.ts**

In `workspace.ts`, import:

```typescript
import {
  createInitialWorkspaceLifecycleState,
  reduceWorkspaceLifecycleState,
} from "./workspace-lifecycle-state";
import { createWorkspaceActivationController } from "./workspace-activation-controller";
```

Add signals near other workspace state:

```typescript
const [workspaceLifecycleState, setWorkspaceLifecycleState] =
  createSignal(createInitialWorkspaceLifecycleState());
const dispatchWorkspaceLifecycle = (event: WorkspaceLifecycleEvent) => {
  setWorkspaceLifecycleState((prev) => reduceWorkspaceLifecycleState(prev, event));
};
```

Instantiate the activation controller after `localRuntimeLifecycle`, server registry, skill materialization, and connection controller exist:

```typescript
const activationController = createWorkspaceActivationController({
  workspaces,
  setWorkspaces,
  activeWorkspaceId,
  syncActiveWorkspaceId,
  projectDir,
  setProjectDir,
  authorizedDirs,
  setAuthorizedDirs,
  activeWorkspaceRoot,
  routing: options.routing,
  connectToServer,
  lifecycleState: workspaceLifecycleState,
  dispatchLifecycle: dispatchWorkspaceLifecycle,
  wsActivateGuard,
  localRuntimeLifecycle,
  engine: engineStore.engine,
  startHost: engineStore.startHost,
  resolveEngineRuntime,
  syncWorkspaceSkillMaterializationBeforeRuntime,
  setWorkspaceConfig,
  setWorkspaceConfigLoaded,
  setConnectingWorkspaceId,
  setEngineReady: options.setEngineReady,
  populateSidebarFromDb: options.populateSidebarFromDb,
  hydrateLatestSessionFromDb: options.hydrateLatestSessionFromDb,
  updateWorkspaceConnectionState,
  blockLocalAction,
  setError: options.setError,
  setBusy: options.setBusy,
  setBusyLabel: options.setBusyLabel,
  setBusyStartedAt: options.setBusyStartedAt,
  setStartupPreference: options.setStartupPreference,
  setSelectedSessionId: options.setSelectedSessionId,
  setMessages: options.setMessages,
  setTodos: options.setTodos,
  setPendingPermissions: options.setPendingPermissions,
  setSessionStatusById: options.setSessionStatusById,
  refreshSkills: options.refreshSkills,
  refreshPlugins: options.refreshPlugins,
  vesloServerSettings: options.vesloServerSettings,
  updateVesloServerSettings: options.updateVesloServerSettings,
  resolveVesloHost: remoteStoreRef.resolveVesloHost,
  wsDebug,
  wsLog: _wsLog,
});
const activateWorkspace = activationController.activateWorkspace;
```

Return `workspaceLifecycleState` from the store object for debugging:

```typescript
workspaceLifecycleState,
```

- [ ] **Step 5: Update tests that slice activation source**

In tests that find:

```typescript
const activationStart = source.indexOf("async function activateWorkspace(");
```

change the source to:

```typescript
const activationSource = readContextSource("workspace-activation-controller.ts");
```

Keep behavioral assertions, but point them at the new controller file.

- [ ] **Step 6: Run tests**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-activation-controller-source.test.ts src/app/tests/context/workspace-lifecycle-state.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts src/app/tests/context/workspace-skill-materialization-sync.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/app/src/app/context/workspace-activation-controller.ts packages/app/src/app/context/workspace-lifecycle-state.ts packages/app/src/app/context/workspace.ts packages/app/src/app/tests/context/workspace-activation-controller-source.test.ts packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts packages/app/src/app/tests/context/workspace-skill-materialization-sync.test.ts
git commit -m "refactor: move workspace activation into lifecycle controller"
```

---

### Task 12: Extract Bootstrap And Startup Handlers

**Files:**
- Create: `packages/app/src/app/context/workspace-bootstrap-controller.ts`
- Create: `packages/app/src/app/tests/context/workspace-bootstrap-controller-source.test.ts`
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts`

- [ ] **Step 1: Write source test**

Create `packages/app/src/app/tests/context/workspace-bootstrap-controller-source.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("bootstrap onboarding lives outside workspace facade", () => {
  const bootstrapSource = readContextSource("workspace-bootstrap-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(bootstrapSource, /export function createWorkspaceBootstrapController\(/);
  assert.match(bootstrapSource, /async function bootstrapOnboarding/);
  assert.match(bootstrapSource, /validateDenAuth/);
  assert.match(bootstrapSource, /populateSidebarFromDb/);
  assert.match(bootstrapSource, /setEngineReady\?\.\(false\)/);
  assert.doesNotMatch(facadeSource, /async function bootstrapOnboarding/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-bootstrap-controller-source.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Create bootstrap controller**

Create `packages/app/src/app/context/workspace-bootstrap-controller.ts` and move:

```typescript
withTimeout
bootTrace
bootstrapConfiguredRemoteServer
bootstrapOnboarding
onSelectStartup
onBackToWelcome
onStartHost
onAttachHost
onConnectClient
onConfirmLanguage
onRememberStartupToggle
markOnboardingComplete
hasPersistedLanguagePreference
resolveWelcomeOnboardingStep
```

Use a factory dependency object with these groups:

```typescript
export type WorkspaceBootstrapControllerDeps = {
  startupPreference: () => StartupPreference | null;
  setStartupPreference: (value: StartupPreference | null) => void;
  onboardingStep: () => OnboardingStep;
  setOnboardingStep: (step: OnboardingStep) => void;
  rememberStartupChoice: () => boolean;
  setRememberStartupChoice: (value: boolean) => void;
  clientDirectory: () => string;
  setBaseUrl: (value: string) => void;
  activeWorkspaceInfo: () => WorkspaceInfo | null;
  activeWorkspacePath: () => string;
  workspaces: () => WorkspaceInfo[];
  setWorkspaces: (value: WorkspaceInfo[]) => void;
  syncActiveWorkspaceId: (id?: string) => void;
  setWorkspaceConfig: (value: WorkspaceVesloConfig | null) => void;
  setWorkspaceConfigLoaded: (value: boolean) => void;
  setAuthorizedDirs: (value: string[]) => void;
  setWorkspacesHydrated: (value: boolean) => void;
  setWorkspaceConnectionStateById: (value: Record<string, WorkspaceConnectionState>) => void;
  setEngineReady?: (value: boolean) => void;
  populateSidebarFromDb?: (workspaceId: string, directory: string) => Promise<void>;
  hydrateLatestSessionFromDb?: (workspaceId: string, directory: string) => Promise<void>;
  vesloServerSettings: () => VesloServerSettings;
  preferServerByDefault?: () => boolean;
  connectToServer: ConnectToServer;
  createRemoteWorkspaceFlow: (...args: any[]) => Promise<boolean>;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean>;
  reconcileVesloServerWorkspaces: () => Promise<void>;
  refreshEngine: () => Promise<unknown>;
  refreshEngineDoctor: () => Promise<unknown>;
  startHost: (opts?: { workspacePath?: string; navigate?: boolean }) => Promise<boolean>;
  engine: () => EngineInfo | null;
  engineAuth: () => OpencodeAuth | null;
  blockLocalAction: (code: string, detail: string) => boolean;
  wsLog: (msg: string, data?: unknown) => void;
};
```

Move existing bodies and replace captured names with `deps.*`.

- [ ] **Step 4: Wire workspace.ts**

Instantiate the bootstrap controller after activation, local workspaces, engine store, and remote store are available:

```typescript
const bootstrapController = createWorkspaceBootstrapController({
  startupPreference: options.startupPreference,
  setStartupPreference: options.setStartupPreference,
  onboardingStep: options.onboardingStep,
  setOnboardingStep: options.setOnboardingStep,
  rememberStartupChoice: options.rememberStartupChoice,
  setRememberStartupChoice: options.setRememberStartupChoice,
  clientDirectory: options.clientDirectory,
  setBaseUrl: options.setBaseUrl,
  activeWorkspaceInfo,
  activeWorkspacePath,
  workspaces,
  setWorkspaces,
  syncActiveWorkspaceId,
  setWorkspaceConfig,
  setWorkspaceConfigLoaded,
  setAuthorizedDirs,
  setWorkspacesHydrated,
  setWorkspaceConnectionStateById,
  setEngineReady: options.setEngineReady,
  populateSidebarFromDb: options.populateSidebarFromDb,
  hydrateLatestSessionFromDb: options.hydrateLatestSessionFromDb,
  vesloServerSettings: options.vesloServerSettings,
  preferServerByDefault: options.preferServerByDefault,
  connectToServer,
  createRemoteWorkspaceFlow: remoteStore.createRemoteWorkspaceFlow,
  activateWorkspace,
  reconcileVesloServerWorkspaces,
  refreshEngine: engineStore.refreshEngine,
  refreshEngineDoctor: engineStore.refreshEngineDoctor,
  startHost: engineStore.startHost,
  engine: engineStore.engine,
  engineAuth: engineStore.engineAuth,
  blockLocalAction,
  wsLog: _wsLog,
});
```

Expose:

```typescript
const bootstrapOnboarding = bootstrapController.bootstrapOnboarding;
const onSelectStartup = bootstrapController.onSelectStartup;
const onBackToWelcome = bootstrapController.onBackToWelcome;
const onStartHost = bootstrapController.onStartHost;
const onAttachHost = bootstrapController.onAttachHost;
const onConnectClient = bootstrapController.onConnectClient;
const onConfirmLanguage = bootstrapController.onConfirmLanguage;
const onRememberStartupToggle = bootstrapController.onRememberStartupToggle;
const markOnboardingComplete = bootstrapController.markOnboardingComplete;
const resolveWelcomeOnboardingStep = bootstrapController.resolveWelcomeOnboardingStep;
```

- [ ] **Step 5: Run tests**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-bootstrap-controller-source.test.ts src/app/tests/context/workspace-activate-order-sync.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/app/src/app/context/workspace-bootstrap-controller.ts packages/app/src/app/context/workspace.ts packages/app/src/app/tests/context/workspace-bootstrap-controller-source.test.ts packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts
git commit -m "refactor: extract workspace bootstrap controller"
```

---

### Task 13: Final Facade Cleanup And Full Verification

**Files:**
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/context/workspace-types.ts`
- Modify: context tests as needed

- [ ] **Step 1: Remove stale imports and dead constants**

In `workspace.ts`, remove imports no longer used by the facade, especially direct imports that moved into controllers:

```typescript
createClient
waitForHealthy
workspaceCreate
workspaceForget
workspacePrivateRoot
workspaceSetActive
workspaceUpdateDisplayName
workspaceUpdateRemote
workspaceVesloRead
homeDir
readDenAuth
validateDenAuth
clearDenAuth
mapConfigProvidersToList
```

Keep imports used by facade wiring:

```typescript
createMemo
createSignal
createSingleFlight
createWorkspaceActivateGuard
createConfigStore
createEngineStore
createRemoteStore
createLocalRuntimeLifecycle
```

- [ ] **Step 2: Assert facade size and public API**

Add this test to `packages/app/src/app/tests/context/workspace-activate-order-sync.test.ts`:

```typescript
test("workspace facade remains a composition root", () => {
  const facadeSource = readWorkspaceFacadeSource();
  const lineCount = facadeSource.split("\n").length;

  assert.ok(
    lineCount < 1400,
    `workspace.ts should stay below 1400 lines after controller extraction, got ${lineCount}`,
  );
  assert.match(facadeSource, /export function createWorkspaceStore\(/);
  assert.match(facadeSource, /return \{/);
  assert.match(facadeSource, /activateWorkspace,/);
  assert.match(facadeSource, /ensureEngineForWorkspace,/);
  assert.match(facadeSource, /workspaceLifecycleState,/);
});
```

- [ ] **Step 3: Run targeted context suite**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/*.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```powershell
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

- [ ] **Step 5: Run full app unit suite**

Run:

```powershell
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

- [ ] **Step 6: Review final workspace imports**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec tsc -p tsconfig.json --noEmit --pretty false
```

Expected: no unused import diagnostics and no type errors.

- [ ] **Step 7: Commit**

```powershell
git add packages/app/src/app/context packages/app/src/app/tests/context
git commit -m "refactor: slim workspace store facade"
```

---

## Manual QA After Implementation

Run the app in the normal local mode used for this checkout. If a dev server is already running, reuse it. Validate these paths:

- Launch app, confirm active local workspace shows sidebar sessions without eager runtime startup.
- Click another local workspace, confirm sidebar history appears quickly and engine ready is false until send/runtime action.
- Start a send from workspace A, switch to workspace B, confirm workspace A busy dot remains when runtime is `veslo-orchestrator`.
- In direct runtime mode, switch workspace and confirm other-workspace busy state is cleared.
- Re-open a remote Veslo workspace and confirm it resolves host/workspace metadata and updates the workspace entry.
- Trigger `refreshActiveClient` with a changed base URL and confirm quiet port rotation binds the route without loading sessions.

Evidence to record in the implementation summary:

- Exact commands run.
- Whether validation used source tests, unit tests, UI automation, or a mixed path.
- Any tests skipped and why.

---

## Self-Review

Spec coverage:
- Multi-workspace state is covered by Task 2 and wired in Task 11.
- Browse-first local workspace behavior is preserved in Tasks 9 and 11.
- Runtime lazy start is preserved in Task 9.
- Routing-only `connectToServer` is covered in Task 6.
- Existing source-characterization tests are protected by Task 1 and updated throughout.
- Public facade compatibility is protected by Task 13.

Placeholder scan:
- The plan avoids unfinished-work markers and names every task, file, command, and verification step.
- Large move steps explicitly identify source functions and exact dependency replacement rules.

Type consistency:
- `WorkspaceActivationOptions`, `WorkspaceConnectContext`, `WorkspaceConnectOptions`, and `ConnectToServer` are introduced in Task 3 and reused in later tasks.
- Lifecycle event names in Task 2 match the dispatch calls in Task 11.
- Verification commands use the existing `@neatech/veslo-ui` package scripts and Node test runner.
