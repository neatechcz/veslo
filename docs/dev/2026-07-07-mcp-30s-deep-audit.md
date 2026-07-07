# MCP 30s Deep Audit

Date: 2026-07-07
Branch: `sandbox-merge`
Scope: static code audit plus local redacted config inspection. No runtime configs were changed.

## Executive Summary

The 30s MCP failures are probably not caused by the Veslo MCP config routes themselves. The MCP config facade is mostly a JSONC mutation/listing layer. The 30s boundary lines up with OpenCode prompt submission/provider-start watchdogs and with runtime MCP/plugin startup that happens after config write.

The strongest current root-cause candidate is contaminated OpenCode startup:

1. The current active dev workspace has `plugin: ["opencode-scheduler"]` and local `chrome-devtools` MCP enabled.
2. The shared-unsandboxed runtime config has the same `opencode-scheduler` and local `chrome-devtools` MCP enabled.
3. `opencode-scheduler` is present in active configs but the corresponding `node_modules/opencode-scheduler` package is missing in the inspected runtime config dirs.
4. The quick-connect Chrome MCP command looks bundled in config, but the bundled sidecar is a shim that still executes `npm exec --yes chrome-devtools-mcp@0.17.0`.
5. The global OpenCode config also contains a local `browser` MCP using `npx -y @browsermcp/mcp@latest`.

This creates a path where OpenCode can reach `/health`, then block on plugin/MCP readiness before `/project`, `/config`, `/provider`, MCP status, or the managed AI provider request becomes usable. In Veslo this often surfaces as `AI gateway provider request did not start within 30000ms`, which only proves that no matching provider hit happened in time; it does not prove that the remote AI gateway rejected the request.

## Current Local Evidence

Redacted config inspection showed:

```text
./opencode.jsonc
  plugin=[]
  mcp.control-chrome={"command":["chrome-devtools-mcp","--isolated"],"type":"local"}

C:\Users\jajse\.config\opencode\opencode.jsonc
  plugin=[]
  mcp.browser={"type":"local","command":["npx","-y","@browsermcp/mcp@latest"],"enabled":true}

C:\Users\jajse\AppData\Local\com.neatech.veslo.dev\veslo-orchestrator-dev\opencode-config\shared-unsandboxed\opencode.jsonc
  plugin=["opencode-scheduler"]
  mcp.chrome-devtools={"command":["chrome-devtools-mcp","--isolated"],"type":"local"}

active orchestrator workspace ws-a8910abb29ff / mw-gamma
  dev-specific\multi-workspace-tauri\gamma\opencode.jsonc
  plugin=["opencode-scheduler"]
  mcp.chrome-devtools={"command":["chrome-devtools-mcp","--isolated"],"type":"local"}
```

Dependency checks showed:

```text
shared-unsandboxed/package.json
  @opencode-ai/plugin: 1.17.13
  node_modules/opencode-scheduler/package.json: missing

opencode-config/ws-a8910abb29ff/package.json
  missing
  node_modules/opencode-scheduler/package.json: missing

dev-specific/multi-workspace-tauri/gamma/.opencode/package.json
  @opencode-ai/plugin: 1.14.29
```

That means active configs can request `opencode-scheduler`, but the runtime dependency set does not contain an installable package by that name. This matches the older cold-start finding where `plugin: ["opencode-scheduler"]` made `/health` return while `/project`, `/config`, and `/provider` timed out.

## 30s Boundaries

Relevant constants and call sites:

- `packages/server/src/server.ts`
  - `OPENCODE_CONVERSATION_SUBMIT_TIMEOUT_MS = 30_000`
  - `AI_GATEWAY_PROVIDER_START_DEFAULT_TIMEOUT_MS = 30_000`
  - conversation submit calls OpenCode `/session/:id/prompt_async` with `timeoutMs: OPENCODE_CONVERSATION_SUBMIT_TIMEOUT_MS`
- `packages/server/src/conversation-run-lifecycle-controller.ts`
  - records `AI gateway provider request did not start within ${timeoutMs}ms.`
- `packages/server/src/ai-gateway-runtime-owner.ts`
  - waits until a provider hit is observed for the OpenCode session/workspace/run

So if MCP/plugin/tool bootstrap blocks OpenCode before the provider call, the user sees a 30s managed-AI/provider-start failure even though the failing component is upstream of the gateway.

## MCP Flow Shape

There are two different MCP planes:

1. Veslo server config plane
   - `packages/server/src/routes/mcp.ts`
   - `packages/server/src/mcp.ts`
   - lists/adds/removes JSONC MCP entries
   - emits reload events
   - does not itself run MCP servers

2. OpenCode runtime plane
   - `packages/app/src/app/context/mcp-connection-workflow.ts`
   - `activeClient.mcp.add({ directory, name, config })`
   - `activeClient.mcp.status({ directory })`
   - this is where OpenCode starts/connects MCP servers and can hang/fail

The UI connect path writes config and then immediately calls runtime activation:

```text
connectMcp -> vesloClient.mcp.add or local config write -> activateInstalledMcp -> activeClient.mcp.add
```

That means a config write can succeed, but the UI still reports a connection failure because the OpenCode runtime activation timed out. For server-managed OAuth hub entries the code skips immediate runtime activation, which is why those entries have a different failure profile.

## Specific Findings

### P1: Stale `opencode-scheduler` is back in active runtime configs

Docs and fixes already say raw `opencode-scheduler` should not be in active OpenCode config. Current active dev/shared configs do contain it again. It is configured as a hidden platform policy with `autoInstall: false`, `activationPhase: "background-runtime"`, and `coldStartCritical: false`, yet it appears in startup config.

Impact: OpenCode can block in useful readiness while Veslo sees only a generic 30s provider-start timeout.

Fix direction:

- Remove/migrate `opencode-scheduler` out of active project/shared OpenCode configs unless explicitly installed by the user.
- Add a startup/config guard that fails fast if active generated config contains platform plugins marked `coldStartCritical: false`.
- Make config generation compare against `platform-managed-plugins.ts` instead of allowing raw plugin specs through.

### P1: Chrome MCP is not actually self-contained

`MCP_QUICK_CONNECT` now writes `["chrome-devtools-mcp", "--isolated"]`, and desktop spawn prepends sidecar paths to `PATH`. But `packages/desktop/scripts/chrome-devtools-mcp-shim.ts` implements that command by running:

```text
npm exec --yes chrome-devtools-mcp@0.17.0 -- ...
```

Impact: explicit Control Chrome activation can still depend on npm, cache, package resolution, and network. That can easily exceed a 30s MCP startup budget or fail offline.

Fix direction:

- Make the sidecar truly self-contained, or vendor the resolved package into the sidecar/runtime dependency bundle.
- Add a preflight that classifies this as `chrome_mcp_npm_resolution_failed` or `chrome_mcp_startup_timeout`, not a generic MCP failure.
- Do not allow `npx`/`npm exec` local MCP commands in generated/default configs without an explicit "network command" warning.

### P1: Global local MCP leaks into every project unless explicitly disabled

Global OpenCode config contains:

```json
{"mcp":{"browser":{"type":"local","command":["npx","-y","@browsermcp/mcp@latest"],"enabled":true}}}
```

Veslo MCP listing merges global MCPs first and project MCPs over them. Unless OpenCode itself disables this via `tools` or project override, the runtime can inherit another local npx MCP into startup/status/tool discovery.

Fix direction:

- In Veslo-managed/shared runtime configs, default-deny or ignore user-global local MCPs for cold-start unless the workspace explicitly opts in.
- Surface inherited global MCPs separately in the UI with source and startup risk.
- Add a diagnostic field: `effectiveMcpEntries`, including source `global/project/shared-runtime`.

### P1/P2: UI conflates "configured" with "activated"

`connectMcp` treats runtime `mcp.add` failure as the overall connect result. There is no stable intermediate state like "configured but runtime activation failed".

Impact: users can retry and accumulate confusion while config is already written; failures look nondeterministic because they depend on runtime state, npm cache, auth state, and active engine.

Fix direction:

- Split the workflow into:
  - `configured`
  - `activation_pending`
  - `runtime_connected`
  - `runtime_failed`
- Preserve the installed row if config write succeeded.
- Add a "retry activation/test connection" action that does not rewrite config.

### P2: MCP runtime status errors are swallowed

`createMcpRuntimeStatusRefresher` catches all status errors and sets `{}`. It records skip events, but not failure duration/error details.

Impact: a timed-out `/mcp` status request becomes an empty status map, hiding whether the failure was runtime not ready, MCP startup timeout, auth, command missing, or OpenCode API blocked.

Fix direction:

- Record `runtime-status-error` with duration, target directory, entry names, and sanitized error code/message.
- Keep last-known statuses and attach a transient error instead of clearing to `{}`.
- Add tests for error event recording.

### P2: OpenCode fetch timeout resolver is dead code

`packages/app/src/app/lib/opencode.ts` defines `resolveRequestTimeoutMs` with 5-minute OAuth and 90s MCP auth handling, but `createTauriFetch` calls `fetchWithTimeout(..., DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS)` directly. So the intended MCP auth timeout resolver is not applied.

Impact: not the observed 30s issue, but still a contract drift. MCP auth can time out at the generic OpenCode client timeout instead of the path-specific one.

Fix direction:

- Use `resolveRequestTimeoutMs(input, DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS)` for all OpenCode fetch paths.
- Add a unit guard that `/mcp/:name/auth` uses the MCP auth timeout.

### P2: E2E scenarios do not verify real MCP runtime/tool execution

Current Pilot scenarios for Google/SharePoint MCP validate catalog cards, install rows, and login button/status messaging. They do not verify:

- OpenCode `/mcp` status after install
- a real MCP tool list
- a prompt that actually invokes an MCP tool
- whether a provider request starts after MCP is enabled

Fix direction:

- Add a minimal Control Chrome MCP runtime smoke that expects `mcp.status.chrome-devtools` to leave `failed`/blank state.
- Add one managed connector smoke that proves token refresh/auth failure is classified before model send.
- Add one send scenario with MCP enabled and trace assertions:
  - `server:conversation-run:opencode-submit` completed
  - `server:conversation-run:ai-gateway-provider-start-watch` started
  - provider hit present or explicit pre-provider failure classified

## Answer: Shared Engine Default

In the inspected dev profile, `runtime-preferences.json` is missing. The code default on Windows/macOS is:

```text
default_shared_unsandboxed_engine_enabled() -> true
read_shared_unsandboxed_engine_override(None) -> Some(true)
shared_unsandboxed_engine_env_overrides(Some(true)) -> VESLO_DISABLE_SANDBOX=1 and VESLO_SHARED_OPENCODE_ENGINE=1
```

So yes: for this Windows desktop dev profile, absent an explicit saved preference, sandbox is effectively off and shared OpenCode engine is effectively on. This does not mean every launch path globally defaults to shared mode; bare orchestrator/server paths can still differ. The UI/debug output must show effective runtime topology, not only sandbox capability.

## Most Likely Failure Chain

For the current active dev workspace:

1. Desktop starts with shared-unsandboxed default.
2. OpenCode effective config includes active project/shared config.
3. Config contains `opencode-scheduler`, but that package is not installed.
4. Config contains local `chrome-devtools` MCP.
5. User sends or refreshes MCP/runtime status.
6. OpenCode blocks before a managed provider request or while starting MCP.
7. Veslo sees no provider hit within 30s and records provider-start timeout, or the runtime MCP call times out.

## Recommended Next Fix Order

1. Clean active/generated OpenCode configs from `opencode-scheduler` and add a regression guard so it cannot reappear in startup config.
2. Disable or quarantine inherited global local MCPs in Veslo-managed shared runtimes unless explicitly opted in.
3. Replace the Chrome MCP shim's `npm exec` path with a deterministic packaged runtime, or classify it as network/npm startup with a clear error.
4. Split MCP connect into config write versus runtime activation states.
5. Add MCP status failure logging and keep last-known state.
6. Add Pilot coverage for real `/mcp` status and one actual MCP tool-use send.

## Fast Manual Confirmation

Without changing configs, the next live repro should capture:

```text
active workspace id/path
effective OPENCODE_CONFIG_DIR
effective plugin list
effective MCP list with source global/project/shared
OpenCode /health duration
OpenCode /project duration
OpenCode /config?directory=... duration
OpenCode /provider?directory=... duration
OpenCode /mcp status duration/error
server:conversation-run:opencode-submit start/end
server:conversation-run:ai-gateway-provider-start-watch timeout or provider hit
```

Decision rule:

- `/health` ok but `/project`/`/provider`/`/mcp` blocked means OpenCode startup/plugin/MCP readiness, not AI gateway.
- `opencode-submit` returns but no provider hit means OpenCode did not reach the provider layer in time.
- `mcp.add` or `/mcp` status hangs while `chrome-devtools-mcp` is active means local MCP startup/handshake is the next target.
