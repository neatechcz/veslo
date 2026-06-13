# Non-Sandbox Shared OpenCode Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Veslo to run one shared OpenCode 1.17.4 engine for multiple local workspaces only when sandboxing is explicitly disabled. Sandbox, WSL sandbox, and any future isolated runtime must continue to use per-workspace engines.

**Architecture:** Add an orchestrator-level engine topology selector with two modes: existing `pooled-per-workspace` and new `shared-unsandboxed`. The shared mode is opt-in and guarded by `VESLO_DISABLE_SANDBOX=1` plus a new explicit shared-engine flag. The existing workspace-scoped URL contract (`/workspace/:id/opencode`) remains stable for the app and server; the orchestrator decides whether that route targets a workspace engine or the shared engine and injects the correct workspace directory.

**Tech Stack:** TypeScript/Bun monorepo, Veslo orchestrator, OpenCode 1.17.4 sidecar, Tauri desktop command bridge, existing Node/Bun tests, Windows/WSL runtime paths.

---

## Runtime Contract

Default behavior must not change.

- Without any new flag, every workspace uses the current `EnginePool` keyed by workspace id.
- With sandbox enabled, a shared OpenCode engine is invalid.
- With WSL sandbox enabled, a shared OpenCode engine is invalid.
- With sandbox unavailable but not explicitly disabled, Veslo may continue to fall back to unsandboxed per-workspace engines, but it must not silently enable one shared engine.
- With both `VESLO_DISABLE_SANDBOX=1` and `VESLO_SHARED_OPENCODE_ENGINE=1`, the orchestrator may start one shared OpenCode process and route all workspace mounts through it.
- If `VESLO_SHARED_OPENCODE_ENGINE=1` is set without `VESLO_DISABLE_SANDBOX=1`, startup must fail fast with a clear configuration error.

This keeps the dangerous behavior explicit: the user must choose both "no sandbox" and "shared engine".

## Scope

In scope:

- Runtime selection for shared unsandboxed OpenCode.
- Orchestrator process management for one shared engine.
- Workspace-scoped proxy compatibility, including directory injection.
- Health/capability reporting so the app and logs make the active topology visible.
- Tests proving sandbox modes cannot accidentally share an engine.
- Developer docs for environment variables and expected warnings.

Out of scope for this implementation:

- UI settings for toggling this mode. Keep it env/CLI only for the first cut.
- Sharing a single engine inside sandboxed workers.
- Replacing Veslo workspace ids with upstream OpenCode project ids as the primary Veslo identity.
- Cloud worker-manager behavior unless explicitly opted in later.

## Current Anchors

Use these files as the first implementation surface:

- `packages/orchestrator/src/sandbox-mode.ts`
- `packages/orchestrator/src/engine-pool.ts`
- `packages/orchestrator/src/cli.ts`
- `packages/orchestrator/src/engine-paths.ts`
- `packages/orchestrator/src/sandbox/windows-wsl2/runtime.ts`
- `packages/server/src/server.ts`
- `packages/server/src/workspaces.ts`
- `packages/desktop/src-tauri/src/commands/engine.rs`
- `packages/app/src/app/utils/local-runtime-lifecycle.ts`
- `packages/app/src/app/lib/opencode.ts`
- `packages/app/src/app/stores/remote-store.ts`
- `packages/opencode-router/src/opencode.ts`
- `packages/opencode-router/src/bridge.ts`

---

## Task 1: Add topology resolver tests first

Create a small resolver before changing daemon behavior. The important part is to encode the safety contract in tests.

Files:

- Create `packages/orchestrator/src/engine-topology.ts`
- Create `packages/orchestrator/src/tests/engine-topology.test.ts`
- Touch `packages/orchestrator/src/sandbox-mode.ts` only if current exports are not enough

Steps:

- [ ] Add tests for default pooled mode.
- [ ] Add tests for explicit shared mode with `VESLO_DISABLE_SANDBOX=1` and `VESLO_SHARED_OPENCODE_ENGINE=1`.
- [ ] Add tests proving shared mode rejects an active sandbox.
- [ ] Add tests proving shared mode rejects WSL sandbox.
- [ ] Add tests proving sandbox-unavailable fallback does not auto-enable shared mode.
- [ ] Run the test and confirm it fails before implementation.

Suggested test cases:

```ts
import { describe, expect, it } from "bun:test";
import { resolveEngineTopology } from "../engine-topology";

describe("resolveEngineTopology", () => {
  it("uses pooled engines by default", () => {
    expect(resolveEngineTopology({ env: {}, sandboxKind: "none" }).mode).toBe("pooled-per-workspace");
  });

  it("allows shared engine only when sandbox is explicitly disabled", () => {
    const topology = resolveEngineTopology({
      env: {
        VESLO_DISABLE_SANDBOX: "1",
        VESLO_SHARED_OPENCODE_ENGINE: "1",
      },
      sandboxKind: "none",
    });

    expect(topology.mode).toBe("shared-unsandboxed");
  });

  it("rejects shared engine when a sandbox is active", () => {
    expect(() =>
      resolveEngineTopology({
        env: {
          VESLO_SHARED_OPENCODE_ENGINE: "1",
        },
        sandboxKind: "wsl2",
      }),
    ).toThrow(/requires VESLO_DISABLE_SANDBOX=1/i);
  });
});
```

Implementation shape:

```ts
export type EngineTopologyMode = "pooled-per-workspace" | "shared-unsandboxed";
export type SandboxKind = "none" | "macos" | "linux" | "wsl2" | "windows-wsl2" | "unknown";

export interface EngineTopology {
  mode: EngineTopologyMode;
  reason: string;
}

export function sharedOpencodeEngineRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VESLO_SHARED_OPENCODE_ENGINE === "1" || env.VESLO_SHARED_OPENCODE_ENGINE === "true";
}

export function sandboxExplicitlyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VESLO_DISABLE_SANDBOX === "1" || env.VESLO_DISABLE_SANDBOX === "true";
}

export function resolveEngineTopology(input: {
  env?: NodeJS.ProcessEnv;
  sandboxKind: SandboxKind;
}): EngineTopology {
  const env = input.env ?? process.env;
  const requested = sharedOpencodeEngineRequested(env);

  if (!requested) {
    return { mode: "pooled-per-workspace", reason: "shared engine not requested" };
  }

  if (!sandboxExplicitlyDisabled(env)) {
    throw new Error(
      "VESLO_SHARED_OPENCODE_ENGINE=1 requires VESLO_DISABLE_SANDBOX=1. Shared OpenCode engines are not supported in sandboxed runtimes.",
    );
  }

  if (input.sandboxKind !== "none") {
    throw new Error(
      `Shared OpenCode engine requested, but sandbox kind '${input.sandboxKind}' is active. Disable sandboxing first.`,
    );
  }

  return { mode: "shared-unsandboxed", reason: "explicit non-sandbox shared engine requested" };
}
```

Verification:

- [ ] `bun test packages/orchestrator/src/tests/engine-topology.test.ts`
- [ ] Commit: `orchestrator: add engine topology guard`

---

## Task 2: Add a shared engine manager

Do not modify `EnginePool` into a mixed abstraction. Keep the current pool focused on per-workspace engines and add a separate manager for one shared process.

Files:

- Create `packages/orchestrator/src/shared-opencode-engine.ts`
- Create `packages/orchestrator/src/tests/shared-opencode-engine.test.ts`
- Reuse types from `packages/orchestrator/src/engine-pool.ts` where practical

Behavior:

- One shared OpenCode process per orchestrator daemon.
- Stable runtime directory, not a user workspace path.
- Stable shared OpenCode config dir, separate from per-workspace config dirs.
- Lazy start: start on first mutating request or explicit activation, not on browse-only GET/HEAD.
- Workspace dispose must not kill the shared engine.
- Orchestrator shutdown must kill the shared engine.

Suggested manager API:

```ts
export interface SharedOpenCodeEngineSnapshot {
  mode: "shared-unsandboxed";
  running: boolean;
  baseUrl?: string;
  pid?: number;
  startedAt?: string;
  runtimeDirectory: string;
  configDirectory: string;
}

export class SharedOpenCodeEngine {
  getRunning(): EngineProcess | null;
  ensureStarted(reason: string): Promise<EngineProcess>;
  snapshot(): SharedOpenCodeEngineSnapshot;
  dispose(): Promise<void>;
}
```

Implementation notes:

- Reuse the existing `startOpencode` path from `packages/orchestrator/src/cli.ts` only after extracting it into a testable helper if needed.
- Pass `sandbox: null` or the equivalent explicit no-sandbox marker to the spawn path.
- Use a synthetic workspace label such as `shared-unsandboxed` only for logs. Never expose it as a user workspace id.
- Use a runtime directory under the orchestrator data dir, for example:

```ts
const runtimeDirectory = path.join(orchestratorDataDir, "shared-opencode-runtime");
const configDirectory = path.join(orchestratorDataDir, "shared-opencode-config");
```

Tests:

- [ ] `ensureStarted()` starts once and returns the same process on subsequent calls.
- [ ] concurrent `ensureStarted()` calls coalesce into one spawn.
- [ ] failed start clears the pending promise.
- [ ] `dispose()` stops the process and clears state.
- [ ] `snapshot()` reports mode and directories without requiring a running process.

Verification:

- [ ] `bun test packages/orchestrator/src/tests/shared-opencode-engine.test.ts`
- [ ] Commit: `orchestrator: add shared opencode engine manager`

---

## Task 3: Wire topology into orchestrator daemon startup

The daemon should resolve topology once and fail before opening ports when the configuration is invalid.

Files:

- Modify `packages/orchestrator/src/cli.ts`
- Modify `packages/orchestrator/src/sandbox-mode.ts` only if the daemon needs a cleaner public helper
- Add or update `packages/orchestrator/src/tests/cli*.test.ts` if a CLI test harness already exists

Steps:

- [ ] Add `--shared-opencode-engine` CLI flag as an alternative to `VESLO_SHARED_OPENCODE_ENGINE=1`.
- [ ] Read env and CLI flag into one `sharedRequested` boolean.
- [ ] Determine effective sandbox kind for topology without spawning a workspace engine.
- [ ] If shared mode is requested and sandbox is not explicitly disabled, fail with the same error as the resolver.
- [ ] Instantiate either:
  - existing `EnginePool`, or
  - new `SharedOpenCodeEngine`.
- [ ] Log a visible startup warning when shared mode is enabled.

Warning text should be hard to miss and include the reason:

```txt
[VESLO][OPEN-CODE][UNSANDBOXED SHARED ENGINE]
VESLO_DISABLE_SANDBOX=1 and VESLO_SHARED_OPENCODE_ENGINE=1 are enabled.
One OpenCode process will serve multiple workspaces without filesystem isolation.
Do not use this mode for untrusted workspaces.
```

Important rule:

- [ ] Keep the existing red `VESLO_DISABLE_SANDBOX=1` warning from `sandbox-mode.ts`.
- [ ] Add the shared-engine warning in addition to it, not instead of it.

Verification:

- [ ] Start orchestrator with no env and confirm health reports pooled mode.
- [ ] Start orchestrator with `VESLO_SHARED_OPENCODE_ENGINE=1` only and confirm it exits with a configuration error.
- [ ] Start orchestrator with `VESLO_DISABLE_SANDBOX=1 VESLO_SHARED_OPENCODE_ENGINE=1` and confirm it starts and prints both warnings.
- [ ] Start Windows WSL sandbox path with shared flag and confirm it refuses shared mode.
- [ ] Commit: `orchestrator: select shared engine topology at startup`

---

## Task 4: Route workspace OpenCode proxy through the selected topology

Keep the external contract stable:

```txt
/workspace/:id/opencode/*
```

The app, server, and SDK clients should not need to know whether the underlying engine is shared or pooled.

Files:

- Modify `packages/orchestrator/src/cli.ts`
- Extract helper if needed: `packages/orchestrator/src/opencode-proxy-target.ts`
- Add tests near existing orchestrator proxy tests, or create `packages/orchestrator/src/tests/opencode-proxy-target.test.ts`

Routing behavior:

- In pooled mode:
  - Use current `EnginePool.ensure(workspaceId, workspacePath)` behavior.
  - Use the workspace engine base URL.
  - Inject `x-opencode-directory` with the workspace engine directory.
- In shared mode:
  - Use `sharedEngine.getRunning()` for GET/HEAD requests.
  - Use `sharedEngine.ensureStarted()` for mutating requests and explicit activation.
  - Use the shared engine base URL.
  - Inject `x-opencode-directory` with the requested Veslo workspace path.
  - Preserve `x-veslo-workspace-id`.
  - Strip any user-supplied `x-opencode-directory` before adding Veslo's trusted value.

Suggested helper:

```ts
export async function resolveOpencodeProxyTarget(input: {
  topology: EngineTopologyMode;
  method: string;
  workspaceId: string;
  workspacePath: string;
  pooledEngine: EnginePool;
  sharedEngine?: SharedOpenCodeEngine;
}): Promise<{
  baseUrl: string | null;
  directory: string;
  engineKind: "pooled" | "shared";
}> {
  if (input.topology === "shared-unsandboxed") {
    const process =
      input.method === "GET" || input.method === "HEAD"
        ? input.sharedEngine?.getRunning()
        : await input.sharedEngine?.ensureStarted(`proxy ${input.method} ${input.workspaceId}`);

    return {
      baseUrl: process?.baseUrl ?? null,
      directory: input.workspacePath,
      engineKind: "shared",
    };
  }

  const process = await input.pooledEngine.ensure(input.workspaceId, input.workspacePath);
  return {
    baseUrl: process.baseUrl,
    directory: process.engineDirectory,
    engineKind: "pooled",
  };
}
```

Tests:

- [ ] GET/HEAD in shared mode does not start the engine when it is not already running.
- [ ] POST in shared mode starts exactly one engine and injects workspace A path.
- [ ] POST for workspace B reuses the same engine but injects workspace B path.
- [ ] User-supplied directory header is ignored.
- [ ] Pooled mode still uses per-workspace engine directories.

Verification:

- [ ] `bun test packages/orchestrator/src/tests/opencode-proxy-target.test.ts`
- [ ] Existing orchestrator test suite, if available.
- [ ] Commit: `orchestrator: proxy workspace routes through shared engine`

---

## Task 5: Make activation, dispose, and health topology-aware

Files:

- Modify `packages/orchestrator/src/cli.ts`
- Modify `packages/desktop/src-tauri/src/commands/engine.rs` if health response structs need new fields
- Modify app-side health typing only where strict types require it

Behavior:

- `/workspaces/:id/activate`
  - pooled mode: existing behavior.
  - shared mode: ensure the shared engine is running, but do not create a per-workspace engine.
- workspace dispose / instance dispose
  - pooled mode: existing behavior.
  - shared mode: do not terminate the shared process for a single workspace.
  - if OpenCode 1.17.4 supports directory-scoped `/instance/dispose?directory=...`, call it with the workspace directory; otherwise log that workspace-scoped dispose is a no-op in shared mode.
- `/health`
  - add `engineTopology`.
  - add `sharedEngine` snapshot when shared mode is configured.
  - keep existing `engines` / pool data in pooled mode.

Suggested health shape:

```json
{
  "ok": true,
  "engineTopology": "shared-unsandboxed",
  "sharedEngine": {
    "mode": "shared-unsandboxed",
    "running": true,
    "baseUrl": "http://127.0.0.1:...",
    "runtimeDirectory": "...",
    "configDirectory": "..."
  }
}
```

Tests:

- [ ] health reports `pooled-per-workspace` by default.
- [ ] health reports `shared-unsandboxed` when enabled.
- [ ] activating two workspaces in shared mode starts one engine.
- [ ] disposing workspace A does not stop the shared engine used by workspace B.

Verification:

- [ ] `bun test packages/orchestrator/src/tests/*health*.test.ts` or relevant suite.
- [ ] Manual curl health check in both modes.
- [ ] Commit: `orchestrator: expose shared engine health and lifecycle`

---

## Task 6: Preserve server and app contracts

The server and app should continue using workspace-scoped base URLs. This reduces blast radius and keeps current Veslo workspace identity stable.

Files:

- Inspect and change only if required:
  - `packages/server/src/server.ts`
  - `packages/server/src/tests/server.multi-workspace.test.ts`
  - `packages/server/src/tests/server-conversations.test.ts`
  - `packages/app/src/app/utils/local-runtime-lifecycle.ts`
  - `packages/app/src/app/lib/opencode.ts`
  - `packages/app/src/app/stores/remote-store.ts`

Rules:

- [ ] Do not change `createOpencodeClient({ baseUrl, directory })` semantics.
- [ ] Do not remove workspace-scoped base URLs.
- [ ] Do not let the app talk directly to the raw shared OpenCode base URL.
- [ ] Preserve browse-first behavior: selecting/browsing a workspace should not start OpenCode unless the current flow already intentionally activates the runtime.
- [ ] Preserve the existing server tests proving workspace A and workspace B get distinct `x-opencode-directory` values.

Add tests only where behavior changes:

- [ ] If health typing changes, update app/desktop tests.
- [ ] If lifecycle start arguments change, add a test that the app still receives `/workspace/:id/opencode` as the base URL.

Verification:

- [ ] `pnpm --filter @veslo/server test -- --runInBand` or the repo's existing server test command.
- [ ] relevant app test command from package scripts.
- [ ] Commit: `app/server: preserve workspace opencode contract`

---

## Task 7: Add optional OpenCode 1.17 project API probe

Do not make upstream project/session APIs a hard dependency for the first shared-engine cut. Add a probe so Veslo can observe and later adopt OpenCode project ids safely.

Files:

- Create `packages/orchestrator/src/opencode-project-api.ts`
- Add tests in `packages/orchestrator/src/tests/opencode-project-api.test.ts`
- Optionally add debug output in `packages/orchestrator/src/cli.ts`

Behavior:

- On shared engine startup, probe:
  - `GET /project`
  - `GET /config?directory=<workspace path>`
  - `GET /provider?directory=<workspace path>`
- If supported, log `opencodeProjectApi: available`.
- If unsupported or unexpected, log `opencodeProjectApi: unavailable` and continue with existing directory-based routing.
- Do not change Veslo workspace identity in this task.

Purpose:

- Gives us evidence from actual OpenCode 1.17.4 behavior.
- Keeps the shared engine implementation useful immediately.
- Avoids a risky identity migration in the same PR.

Verification:

- [ ] Unit tests for available/unavailable probe responses.
- [ ] Manual smoke against installed OpenCode 1.17.4.
- [ ] Commit: `orchestrator: probe opencode project api`

---

## Task 8: Re-check OpenCodeRouter behavior

The router currently caches clients by directory and has its own identity/directory mapping. Shared engine support must not accidentally send all router traffic through one workspace directory.

Files:

- Inspect:
  - `packages/opencode-router/src/config.ts`
  - `packages/opencode-router/src/opencode.ts`
  - `packages/opencode-router/src/bridge.ts`
- Add or update tests only if current router tests can exercise directory routing.

Rules:

- [ ] The router may keep using `createClient(config, resolvedDir)`.
- [ ] In the first implementation, the router should continue to operate through the workspace-scoped Veslo route for the active workspace.
- [ ] Do not add a raw global OpenCode URL route unless it has explicit directory authorization.
- [ ] If multi-workspace router fanout is required, add a later adapter that maps router identity directory to Veslo workspace id and then calls `/workspace/:id/opencode`.

Decision point:

- [ ] If the router is only used for the active workspace, document that shared engine does not change router fanout yet.
- [ ] If the router must handle multiple workspaces concurrently, implement directory-to-workspace resolution before enabling that path.

Verification:

- [ ] Router smoke in default pooled mode.
- [ ] Router smoke in shared mode for one active workspace.
- [ ] Commit only if code changes are needed.

---

## Task 9: Installer and distribution checks

The shared engine mode depends on the OpenCode 1.17.4 sidecar already being distributed correctly. Confirm this remains project-level, not local-machine-only.

Files:

- `packages/desktop/package.json`
- `packages/orchestrator/package.json`
- `packages/app/package.json`
- `packages/desktop/scripts/prepare-sidecar.mjs`
- `packages/desktop/src-tauri/tauri.conf.json`
- `packages/orchestrator/scripts/windows-wsl2-sandbox-provision.ps1`
- `packages/orchestrator/src/sandbox/windows-wsl2/runtime.ts`

Checks:

- [ ] Confirm all package-level OpenCode dependencies remain pinned to `1.17.4`.
- [ ] Confirm `prepare-sidecar.mjs` downloads `opencode-ai-opencode@1.17.4` for desktop builds.
- [ ] Confirm orchestrator sidecar fallback/download path resolves `1.17.4`.
- [ ] Confirm WSL sandbox provision keeps using `1.17.4`, even though shared engine is not allowed there.
- [ ] Confirm CI/build scripts do not rely on a locally installed `opencode` binary.

Verification:

- [ ] Clean sidecar preparation on a machine without a preinstalled OpenCode binary.
- [ ] Windows desktop build preparation.
- [ ] WSL sandbox provision dry run or script inspection.
- [ ] Commit docs/test updates only if needed.

---

## Task 10: Documentation

Files:

- Create `docs/dev/opencode-shared-non-sandbox-runtime.md`
- Optionally link it from an existing developer setup doc

Document:

- [ ] What the mode does.
- [ ] Why it is non-sandbox only.
- [ ] Required env:

```powershell
$env:VESLO_DISABLE_SANDBOX = "1"
$env:VESLO_SHARED_OPENCODE_ENGINE = "1"
```

- [ ] Expected startup warnings.
- [ ] How to confirm it is active:

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/health | ConvertTo-Json -Depth 5
```

- [ ] How to confirm only one OpenCode process is running.
- [ ] How to disable it.
- [ ] Security warning: do not use this for untrusted workspaces.
- [ ] Current limitation: OpenCodeRouter multi-workspace fanout, if not implemented in Task 8.

Verification:

- [ ] Read docs against the implemented flags and health payload.
- [ ] Commit: `docs: document non-sandbox shared opencode engine`

---

## Task 11: End-to-end smoke matrix

Run this before considering the implementation complete.

Default pooled mode:

- [ ] Start desktop/dev runtime with no shared env.
- [ ] Add workspace A and workspace B.
- [ ] Send a prompt in A.
- [ ] Send a prompt in B.
- [ ] Confirm health shows pooled mode.
- [ ] Confirm each workspace has its own engine process or pool entry.

Shared non-sandbox mode:

- [ ] Start with:

```powershell
$env:VESLO_DISABLE_SANDBOX = "1"
$env:VESLO_SHARED_OPENCODE_ENGINE = "1"
```

- [ ] Add workspace A and workspace B.
- [ ] Send a prompt in A.
- [ ] Send a prompt in B.
- [ ] Confirm health shows `shared-unsandboxed`.
- [ ] Confirm one OpenCode process serves both workspaces.
- [ ] Confirm OpenCode requests for A carry A's directory.
- [ ] Confirm OpenCode requests for B carry B's directory.
- [ ] Confirm sessions/conversations do not bleed across workspaces.

Invalid config:

- [ ] Start with only `VESLO_SHARED_OPENCODE_ENGINE=1`.
- [ ] Confirm startup fails with a clear error.
- [ ] Start WSL sandbox with shared flag.
- [ ] Confirm startup fails or refuses shared mode before spawning a shared engine.

Regression:

- [ ] Run relevant server tests.
- [ ] Run relevant orchestrator tests.
- [ ] Run app unit tests touched by health/lifecycle typing.
- [ ] Run desktop build/sidecar prep command used by the repo.

Final commit:

- [ ] Commit: `orchestrator: enable non-sandbox shared opencode engine`

---

## Rollback Plan

The feature must be easy to disable.

- Remove `VESLO_SHARED_OPENCODE_ENGINE=1` and restart the daemon.
- The orchestrator falls back to `pooled-per-workspace`.
- Existing workspace ids and workspace-scoped URLs remain unchanged.
- No data migration should be required because this plan does not replace Veslo workspace identity.

If shared mode causes issues in the field:

- [ ] Disable the env in launcher scripts.
- [ ] Keep `VESLO_DISABLE_SANDBOX=1` behavior unchanged for users who still need unsandboxed per-workspace engines.
- [ ] Use health payloads and logs to confirm topology after restart.

