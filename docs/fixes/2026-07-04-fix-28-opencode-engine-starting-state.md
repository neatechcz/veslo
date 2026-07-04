# Fix 28: OpenCode Engine Starting State And MCP Cold Path

## Problem

Installed Veslo could probe the OpenCode proxy while an engine was still
starting and see the same public failure shape used for a truly absent engine.
That made the app's quiet reconnect path vulnerable to treating an in-flight
start as `engine_not_running`, especially around shared-unsandboxed OpenCode
cold start and pooled sandbox startup.

Source plan:

```text
docs/plans/2026-07-04-opencode-shared-starting-state-and-mcp-cold-path-kiss-plan.md
```

Issue link status:

```text
unlinked
```

## Fix

- Added a canonical public runtime engine state contract:
  `absent`, `starting`, `process_ready`, `workspace_api_waiting`, `ready`,
  `stopped`, and `failed`.
- Made shared OpenCode startup observable as `engineState: "starting"` while
  the health check is still pending.
- Changed read-only proxy probes to report `engine_starting` with
  `engineState: "starting"` for in-flight starts, while keeping
  `engine_not_running` for truly absent or stopped engines.
- Exposed the same public state through Tauri `EngineInfo`.
- Taught app quiet reconnect/readiness recovery to wait through
  `engineState: "starting"` and to skip stale quiet proxy connects for
  absent/stopped/failed orchestrator engines.
- Kept MCP/plugin cold-path behavior KISS: default cold start does not
  autoload the Chrome MCP path unless explicitly configured.

## Validation

Focused tests and typechecks run during the implementation:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/runtime-engine-state.test.ts src/tests/shared-opencode-engine.test.ts src/tests/opencode-proxy-target.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/router-proxy.test.ts src/tests/opencode-proxy-target.test.ts src/tests/runtime-engine-state.test.ts src/tests/shared-opencode-engine.test.ts
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-topology.test.ts src/tests/sandbox-mode.test.ts src/tests/engine-paths.test.ts src/tests/opencode-proxy-target.test.ts src/tests/router-proxy.test.ts
pnpm --filter veslo-server exec bun test src/tests/server.mcp-routes.test.ts src/tests/server.hub-mcp.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/utils/local-runtime-lifecycle.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/runtime-owner.test.ts src/app/tests/context/workspace-connection-state.test.ts src/app/tests/context/workspace-lifecycle-state.test.ts src/app/tests/context/send-runtime-readiness.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-engine-warmup.test.ts src/app/tests/app-send-latency-trace.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/mcp-connection-workflow.test.ts src/app/tests/app-send-latency-trace.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter @neatech/veslo-ui typecheck
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml engine_info
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml runtime_preferences
```

Installed-runtime validation used a rebuilt E2E debug binary and live Den auth:

```powershell
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD = "1"; pnpm --filter @neatech/veslo run prepare:sidecar; Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
Push-Location packages\desktop; pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e; Pop-Location
$env:E2E_TAURI_PILOT_BIN = "C:\Users\jajse\.cargo\bin\tauri-pilot.exe"
$env:VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE = "C:\Users\jajse\.veslo\den-auth.json"
$env:E2E_MANAGED_AI_GATEWAY_FIXTURE = "0"
$env:E2E_SKILL_REGISTRY_FIXTURE = "0"
$env:VESLO_ENABLE_AUTOMATIONS = "0"
$env:VESLO_ENABLE_AUTOMATIONS_PLUGIN = "0"
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff
```

Pilot result:

- exit `0`
- `5 passed`, `0 failed`, `0 skipped`
- trace directory:
  `dev-specific/tauri-pilot/runtime-cold-start-session-handoff-20260704-live-auth/`
- `connect-quiet:routing-error`: `0`
- `engine_not_running`: `0`
- `orchestrator:proxy-engine-starting`: `14`
- `engineState:"starting"`: `14`
- `shared-opencode-spawn-ready`: `1`
- `connect-quiet:done`: `3`

## Follow-Up

The live-auth pilot still logged
`AI gateway provider request did not start within 30000ms.` That is separate
from the engine-starting state bug fixed here. If the next acceptance target is
"first send must produce a model response", continue from the live gateway /
OpenCode provider-start trace rather than reopening `engine_not_running`.

## Status

The KISS engine-starting state slice is complete. MCP/plugin lazy-load work
remains intentionally limited to keeping non-explicit MCP paths out of the cold
start.
