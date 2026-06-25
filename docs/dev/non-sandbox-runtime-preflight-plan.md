# Non-Sandbox Runtime Preflight Plan

Last audit date: 2026-06-25

Status: core implementation complete for runtime fallback routing. The
orchestrator reports the actual engine child kind, the desktop/app layers
preserve it, and pre-send managed AI routing now uses effective sandbox state
after runtime preparation. Remaining work is mostly explicit UI/docs polish and
manual validation on a fresh Windows machine without ready WSL.

## Update Convention

Agents working on this plan should update both fields on every task:

- Checkbox: `[ ]` means incomplete, `[x]` means complete.
- `DONE=false` means incomplete, `DONE=true` means complete.

When completing a task, add a short note with the relevant PR, commit, or test
command if available.

Example:

```md
- [x] DONE=true Add childKind to app TS types. Note: tested with `bun run typecheck`.
```

## Current Audit Facts

- [x] DONE=true Onboarding sandbox repair is non-blocking.
  - `packages/app/src/app/pages/onboarding.tsx` renders `<WindowsSandboxRepair />` without `blocking`.
  - `packages/app/src/app/components/windows-sandbox-repair.tsx` auto-checks WSL state but does not force onboarding to stop.

- [x] DONE=true App-side local runtime prerequisite gate no longer blocks WSL fallback.
  - `packages/app/src/app/stores/engine-store.ts`
  - `ensureLocalRuntimeReadyForWorkspaceStart()` currently returns `true` so startup reaches the orchestrator, where direct fallback can happen.

- [x] DONE=true Orchestrator can fall back from WSL sandbox to direct non-sandbox engine.
  - `packages/orchestrator/src/sandbox-mode.ts`
  - `packages/orchestrator/src/cli.ts`
  - Resolver failures, unavailable sandbox launch, and sandbox build failures fall back to unsandboxed engine spawn.

- [x] DONE=true Non-sandbox fallback does not auto-enable shared multi-workspace engine.
  - `packages/orchestrator/src/engine-topology.ts`
  - Shared unsandboxed mode remains explicit: `VESLO_DISABLE_SANDBOX=1` plus `VESLO_SHARED_OPENCODE_ENGINE=1`.

- [x] DONE=true Managed AI routing no longer hard-blocks when the WSL bridge URL is absent.
  - `packages/app/src/app/lib/ai-access.ts`
  - `requiresManagedAiEngineBaseUrl()` now requires a non-loopback engine URL only when one is actually published.

- [x] DONE=true App has one pure owner for "effective sandbox" decisions.
  - File: `packages/app/src/app/lib/runtime-sandbox-state.ts`
  - Used by directory query path mode, managed AI routing/config validation, and send traces.
  - Note: verified with `pnpm run typecheck` and `runtime-sandbox-state.test.ts`.

- [x] DONE=true Orchestrator engine `childKind` is propagated end-to-end.
  - Node engine pool snapshots include `childKind`.
  - Rust `OrchestratorEngineSnapshot` preserves `childKind`.
  - App TS `OrchestratorEngineSnapshot`, `OrchestratorStatus`, and `EngineInfo` expose `childKind`.
  - Note: verified with orchestrator router tests, app typecheck, and Rust serde tests.

- [x] DONE=true Pre-send ordering uses one shared preflight context.
  - `sendPrompt`, `replaceUserMessage`, and `createSessionAndOpen` prepare runtime/health before managed AI.
  - The KISS implementation extends the existing `SendRuntimePreflightContext` and `createSendRuntimeReadiness()` instead of adding a new controller file.
  - Note: verified with `app-send-preflight-context.test.ts` and `app-managed-ai-bootstrap-gate.test.ts`.

## Implementation TODO

### 1. Propagate Actual Engine Kind

- [x] DONE=true Add optional `child_kind` to Rust `OrchestratorEngineSnapshot`.
  - File: `packages/desktop/src-tauri/src/types.rs`
  - Expected serialized field: `childKind`.
  - Note: verified with `cargo test orchestrator_engine_snapshot`.

- [x] DONE=true Ensure Rust orchestrator health/status deserialization preserves `childKind`.
  - Files:
    - `packages/desktop/src-tauri/src/orchestrator/mod.rs`
    - `packages/desktop/src-tauri/src/commands/orchestrator.rs`
  - Note: covered by the shared `OrchestratorEngineSnapshot` serde test in `types.rs`.

- [x] DONE=true Add optional `child_kind` to Rust `EngineInfo` for workspace-scoped `engine_info()`.
  - File: `packages/desktop/src-tauri/src/types.rs`
  - Source of truth: matching orchestrator engine snapshot for the resolved workspace.
  - Note: serialized as `childKind`.

- [x] DONE=true Populate `EngineInfo` child kind in `engine_info(workspaceId, workspacePath)`.
  - File: `packages/desktop/src-tauri/src/commands/engine.rs`
  - Rule: if engine snapshot exists, copy its `childKind`; otherwise leave null/undefined.
  - Note: direct runtime snapshots report `direct` while running.

- [x] DONE=true Update app TS types.
  - File: `packages/app/src/app/lib/tauri.ts`
  - Add `childKind?: "direct" | "wsl" | null` to `OrchestratorEngineSnapshot`.
  - Add `engines: OrchestratorEngineSnapshot[]` to `OrchestratorStatus`.
  - Add `childKind?: "direct" | "wsl" | null` to `EngineInfo`.
  - Note: verified with `pnpm run typecheck`.

### 2. Add Effective Sandbox State Helper

- [x] DONE=true Create a small pure helper for effective runtime sandbox state.
  - Suggested file: `packages/app/src/app/lib/runtime-sandbox-state.ts`

- [x] DONE=true Helper input includes:
  - configured sandbox capability from Veslo server,
  - target workspace id/root,
  - `EngineInfo`,
  - orchestrator engine snapshots.

- [x] DONE=true Helper output includes:
  - `configuredBackend`,
  - `effectiveBackend`,
  - `childKind`,
  - `isSandboxed`,
  - `directoryQueryMode`,
  - `requiresEngineBridgeUrl`,
  - `sandboxFallback`.

- [x] DONE=true Effective sandbox rules:
  - `childKind === "wsl"` means effective backend is `windows-wsl2`.
  - `childKind === "direct"` means effective backend is `none`, even if configured backend is `windows-wsl2`.
  - missing child kind falls back to configured capability only as "unknown/configured", not as proof of WSL runtime.
  - shared unsandboxed mode stays explicit and must not be inferred from fallback.
  - Note: verified with `runtime-sandbox-state.test.ts`.

- [x] DONE=true Add unit tests for the helper.
  - Suggested file: `packages/app/src/app/tests/lib/runtime-sandbox-state.test.ts`
  - Cases:
    - configured WSL + childKind direct => effective none,
    - configured WSL + childKind wsl => effective windows-wsl2,
    - configured none => effective none,
    - unknown childKind preserves conservative configured state without blocking direct fallback.
  - Note: verified with targeted app test run.

### 3. Create One Send/Runtime Preflight Owner

- [x] DONE=true Add one owner for send/runtime preflight state.
  - Suggested file: `packages/app/src/app/context/send-preflight-controller.ts`
  - Alternative: extend `createSendRuntimeReadiness()` if that keeps the diff smaller.
  - Note: KISS implementation extends `SendRuntimePreflightContext` and `createSendRuntimeReadiness()` instead of adding a new file.

- [x] DONE=true Owner stores a single `SendPreflightContext`.
  - Existing context fields:
    - `traceId`
    - `runtimeHealthOk`
    - `targetWorkspace`
  - Add:
    - `managedAiReady`
    - `effectiveSandbox`
    - `enginePrepared`

- [x] DONE=true Preflight order is:
  1. resolve target workspace,
  2. ensure local runtime/engine for target workspace,
  3. refresh/read engine info and effective sandbox state,
  4. run runtime health/connect check,
  5. refresh effective sandbox state after recovery,
  6. run managed AI bootstrap/routing with effective sandbox,
  7. return one preflight result.

- [x] DONE=true Rewire `sendPrompt` to use the shared preflight context and runtime-before-managed ordering.
  - File: `packages/app/src/app/app.tsx`
  - Note: verified by `app-send-preflight-context.test.ts`.

- [x] DONE=true Rewire `createSessionAndOpen` to reuse the same preflight context.
  - File: `packages/app/src/app/app.tsx`
  - Important: managed AI must not run before runtime/effective sandbox preparation.
  - Note: verified by `app-send-preflight-context.test.ts`.

- [x] DONE=true Preserve cross-workspace behavior.
  - Target workspace id/root must be passed through all preflight steps.
  - Do not collapse back to only active workspace state.
  - Note: `resolveRuntimeSandboxStateForTarget()` matches by workspace id/root and runtime readiness probes target workspace clients.

### 4. Use Effective Sandbox in Consumers

- [x] DONE=true Managed AI routing uses effective sandbox state, not raw server capabilities.
  - Files:
    - `packages/app/src/app/app.tsx`
    - `packages/app/src/app/lib/ai-access.ts`
  - Note: verified with `app-managed-ai-bootstrap-gate.test.ts` and `ai-access.test.ts`.

- [x] DONE=true Directory query path mode prefers effective sandbox state.
  - Files:
    - `packages/app/src/app/app.tsx`
    - `packages/app/src/app/utils/paths.ts`
  - Keep current broad variant matching as fallback.
  - Note: `directoryQueryPathMode()` now delegates to `resolveRuntimeSandboxStateForTarget()`.

- [ ] DONE=false Settings/devtools should show configured vs effective sandbox separately.
  - Suggested display:
    - configured backend: `windows-wsl2`
    - effective engine: `direct`
    - status: `running without sandbox fallback`

- [x] DONE=true Keep server `/capabilities` as configured capabilities unless a separate explicit field is added.
  - Do not silently redefine existing `sandbox.enabled` as effective runtime state without updating callers.

### 5. Tests

- [x] DONE=true Orchestrator health test confirms engine snapshots include `childKind`.
  - Existing area: `packages/orchestrator/src/tests/router-proxy.test.ts`
  - Note: verified with `bun test src/tests/router-proxy.test.ts src/tests/engine-pool.test.ts`.

- [x] DONE=true Desktop Rust test or serde fixture confirms `childKind` is preserved in `OrchestratorEngineSnapshot`.
  - Area: `packages/desktop/src-tauri`
  - Note: verified with `cargo test orchestrator_engine_snapshot`.

- [x] DONE=true App type tests confirm TS status includes `engines` and child kind fields.
  - File: `packages/app/src/app/lib/tauri.ts`
  - Note: verified with `pnpm run typecheck`.

- [x] DONE=true Preflight owner/helper tests confirm configured WSL + direct engine does not require WSL bridge URL.
  - Suggested file: `packages/app/src/app/tests/context/send-preflight-controller.test.ts`
  - Note: covered by `runtime-sandbox-state.test.ts` plus `ai-access.test.ts`.

- [x] DONE=true Send flow source/behavior test confirms `createSessionAndOpen` does not run managed AI before runtime preparation.
  - Existing area:
    - `packages/app/src/app/tests/app-send-preflight-context.test.ts`
    - `packages/app/src/app/tests/context/send-runtime-managed-ai-bootstrap-contract.test.ts`
  - Note: `sendPrompt` ordering is also asserted.

- [x] DONE=true Onboarding test confirms Windows sandbox repair remains non-blocking.
  - Existing file: `packages/app/src/app/tests/components/windows-sandbox-repair.test.ts`
  - Note: verified with targeted app onboarding/runtime test run.

- [x] DONE=true Regression test for multi-workspace non-sandbox fallback.
  - Expected: two local workspaces can each get a routed client/engine with childKind direct.
  - Existing areas:
    - `packages/orchestrator/src/tests/opencode-proxy-target.test.ts`
    - `packages/app/src/app/tests/context/workspace-routing.test.ts`
  - Note: covered by `router-proxy.test.ts` health snapshot for two workspaces and runtime owner target-client tests.

### 6. Docs and Diagnostics

- [ ] DONE=false Update runtime docs after implementation.
  - Suggested files:
    - `docs/dev/opencode-workspace-runtime-architecture.md`
    - `docs/dev/opencode-shared-non-sandbox-runtime.md`
    - `docs/dev/state-and-config-reference.md`

- [x] DONE=true Add trace fields for configured vs effective sandbox.
  - Suggested trace keys:
    - `configuredSandboxBackend`
    - `effectiveSandboxBackend`
    - `engineChildKind`
    - `sandboxFallback`
  - Note: fields are emitted in managed AI runtime config check and config sync traces.

- [ ] DONE=false Confirm debug logs clearly distinguish:
  - WSL not installed/not ready,
  - WSL launch unavailable,
  - direct fallback started,
  - real runtime failure.

## Acceptance Criteria

- [ ] DONE=false Fresh Windows machine without ready WSL can complete onboarding and start a local workspace.

- [ ] DONE=false First send on that machine starts a direct non-sandbox engine instead of blocking on WSL repair.

- [x] DONE=true Managed AI does not block on missing WSL bridge URL after direct fallback.
  - Note: automated coverage verifies configured WSL + `childKind=direct` resolves to non-sandbox and does not require engine bridge URL.

- [x] DONE=true Windows machine with ready Veslo WSL sandbox still uses `childKind=wsl` and sandbox path mapping.
  - Note: covered by runtime sandbox helper and orchestrator path mapping tests; still needs manual Windows smoke validation.

- [x] DONE=true Multi-workspace mode remains per-workspace in direct fallback.
  - Note: orchestrator router test confirms separate local workspace engines report `childKind=direct`.

- [x] DONE=true Direct fallback never auto-enables shared unsandboxed mode.
  - Note: topology remains explicit and unchanged.

- [ ] DONE=false UI/debug traces expose both configured sandbox and effective engine runtime.
  - Trace fields are present; explicit settings/devtools UI display remains open.

## Non-Goals

- [x] DONE=true Do not make onboarding block on WSL installation or repair.

- [x] DONE=true Do not auto-run elevated WSL installation from app startup.

- [x] DONE=true Do not infer shared unsandboxed mode from direct fallback.

- [x] DONE=true Do not redefine server `/capabilities.sandbox` as effective runtime state without a separate migration plan.

## Useful Source Map

- App onboarding repair:
  - `packages/app/src/app/components/windows-sandbox-repair.tsx`
  - `packages/app/src/app/pages/onboarding.tsx`

- App startup/runtime:
  - `packages/app/src/app/stores/engine-store.ts`
  - `packages/app/src/app/utils/local-runtime-lifecycle.ts`
  - `packages/app/src/app/context/workspace-runtime-controller.ts`
  - `packages/app/src/app/context/send-runtime-readiness.ts`
  - `packages/app/src/app/app.tsx`

- App routing/capabilities:
  - `packages/app/src/app/lib/ai-access.ts`
  - `packages/app/src/app/lib/tauri.ts`
  - `packages/app/src/app/lib/veslo-server.ts`
  - `packages/app/src/app/utils/paths.ts`

- Desktop IPC/runtime:
  - `packages/desktop/src-tauri/src/types.rs`
  - `packages/desktop/src-tauri/src/commands/engine.rs`
  - `packages/desktop/src-tauri/src/commands/orchestrator.rs`
  - `packages/desktop/src-tauri/src/orchestrator/mod.rs`

- Orchestrator:
  - `packages/orchestrator/src/cli.ts`
  - `packages/orchestrator/src/engine-pool.ts`
  - `packages/orchestrator/src/engine-topology.ts`
  - `packages/orchestrator/src/sandbox-mode.ts`
  - `packages/orchestrator/src/engine-paths.ts`

- Server:
  - `packages/server/src/server.ts`
