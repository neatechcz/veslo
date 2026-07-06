# Tauri Pilot Testing Playbook

This playbook captures the current Veslo desktop/Tauri Pilot practices that
are known to work. Keep speculative findings in `docs/testing/findings/` or
scenario-specific `dev-specific/tauri-pilot/` run folders; keep this document
for repeatable procedures and stable diagnostic boundaries.

## What Tauri Pilot Is

Tauri Pilot is the desktop automation surface for the real Tauri app. Use it
when a browser-only test cannot represent the behavior: desktop shell startup,
WebView behavior, sidecar startup, workspace activation, native window state,
or the real app profile.

The plugin is compiled only into debug builds with the `e2e` Cargo feature:

- `packages/desktop/src-tauri/src/lib.rs` registers `tauri_plugin_pilot::init()`
  behind `debug_assertions` and `feature = "e2e"`.
- `packages/desktop/src-tauri/tauri.e2e.conf.json` changes the app identifier
  to `com.neatech.veslo.e2e` and grants `pilot:default`.
- Release/default desktop capability must not contain `pilot:default`.

Use the E2E runner to launch a pilot scenario. Use the raw `tauri-pilot` CLI
only to inspect or drive an already-running app with the correct socket.

## Research Baseline

This guide is based on three sources:

- upstream Tauri Pilot docs: <https://mpiton.github.io/tauri-pilot/>
- Tauri v2 capability/permission docs:
  <https://v2.tauri.app/security/capabilities/>
- current local CLI help from `C:\Users\jajse\.cargo\bin\tauri-pilot.exe`
  (`tauri-pilot 0.7.2`)
- Veslo's pinned plugin integration in `packages/desktop/src-tauri`

Veslo currently pins `tauri-plugin-pilot = "0.7.2"` from crates.io. Keep the
local CLI on the same version:

```powershell
tauri-pilot --version
cargo install tauri-pilot-cli --version 0.7.2 --locked
```

Treat upstream docs as the API shape, but prefer local
`tauri-pilot.exe <command> --help` when a command's options matter for a live
run.

Relevant local compatibility points:

- `Cargo.toml` enables `e2e = ["tauri-plugin-pilot/press"]`; keyboard `press`
  support depends on the E2E feature build.
- `tauri.e2e.conf.json` is the config that grants `pilot:default`.
- The default app config does not grant Pilot permissions.
- The package runner uses `TAURI_PILOT_SOCKET` and `--window main` targeting;
  raw CLI calls must hit the same socket/window.

## Capability Matrix

The CLI has more surface area than our current pilot scenarios use. Keep this
matrix handy when choosing the narrowest probe.

| Area | Commands | Use in Veslo |
| --- | --- | --- |
| Attach and routing | `ping`, `windows`, `state`, `url`, `title`, `mcp` | Prove the right app/window/socket is attached before a scenario. `mcp` is useful when an external agent controls Pilot over stdio. |
| UI discovery | `snapshot`, `diff`, `text`, `html`, `value`, `attrs`, `forms` | Find stable refs/selectors, inspect text/value/attributes, and compare UI after one action. |
| User interaction | `click`, `fill`, `type`, `press`, `select`, `check`, `scroll`, `drag`, `drop`, `navigate` | Drive visible behavior first. Use `type` for keyboard-like input, `fill` for deterministic input replacement, and `drop` for file-drop UI. |
| Waiting and assertions | `wait`, `watch`, `assert` | Replace sleeps with selector waits, DOM stability waits, and explicit assertions. |
| Diagnostics | `logs`, `network`, `screenshot`, `screenshot_native`, `storage`, `eval`, `ipc` | Capture console/network evidence, browser storage, screenshots, app internals, and Tauri command results. |
| Scenario flow | `run`, `record`, `replay` | Run TOML scenarios, write JUnit reports, and record exploratory actions for later conversion. |

Prefer this order while debugging:

1. `ping` / `windows` / `state` to confirm the target.
2. `snapshot -i` or `forms` to identify the UI handle.
3. One real user action with `click`, `fill`, `press`, or `drop`.
4. `wait`, `watch`, or `assert` for the expected visible transition.
5. `logs`, `network`, `storage`, `eval`, or `ipc` only when the visible path
   does not explain the failure.

## Known-Good Launch Paths

### Manual dev runtime without Pilot

Use this when the goal is to isolate the app/local server/AI gateway path from
the E2E harness.

```powershell
$RunDir = "dev-specific\tauri-pilot\manual-runtime-YYYYMMDD-HHMMSS-ai-gateway-dev"
New-Item -ItemType Directory -Force $RunDir | Out-Null

$env:VESLO_DEN_AUTH_SNAPSHOT_PATH = "C:\Users\jajse\.veslo\den-auth.json"
$env:VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE = $env:VESLO_DEN_AUTH_SNAPSHOT_PATH
$env:E2E_MANAGED_AI_GATEWAY_FIXTURE = "0"

$env:VESLO_RUNTIME_TRACE = "1"
$env:VESLO_RUNTIME_TRACE_FILE = "$PWD\$RunDir\runtime-trace.ndjson"
$env:VESLO_SEND_WORKFLOW_TRACE = "1"
$env:VESLO_SEND_WORKFLOW_TRACE_FILE = "$PWD\$RunDir\send-workflow-trace.ndjson"
$env:VESLO_SEND_WORKFLOW_TRACE_CONSOLE = "1"
$env:VITE_VESLO_SEND_WORKFLOW_TRACE = "1"
$env:VESLO_OPENCODE_HEALTH_DIAG = "1"
$env:VESLO_OPENCODE_HEALTH_DIAG_FILE = "$PWD\$RunDir\opencode-health.ndjson"

pnpm dev
```

For this path, do not set `HOME` or `USERPROFILE`. Corepack/pnpm and the
normal desktop profile should stay tied to the real Windows user. Do not set
`VESLO_DISABLE_DEV_AUTOSTART` unless the test is specifically about that
boundary.

### E2E debug binary with Pilot

Use this when the scenario must run through the same debug binary and isolated
profile model as `packages/e2e`.

```powershell
pnpm --filter veslo-server build:bin

$env:VESLO_SIDECAR_FORCE_BUILD = "1"
pnpm --filter @neatech/veslo run prepare:sidecar
Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD

Push-Location packages\desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
Pop-Location

$env:E2E_TAURI_PILOT_BIN = "C:\Users\jajse\.cargo\bin\tauri-pilot.exe"
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff
```

The runner launches `packages/desktop/src-tauri/target/debug/veslo.exe`, sets
`TAURI_PILOT_SOCKET`, waits for Pilot readiness, runs the TOML scenario, and
tears the app down. On Windows the default socket is a named pipe:
`\\.\pipe\tauri-pilot-com.neatech.veslo.e2e`.

## What To Rebuild

Rebuild sidecars when server/orchestrator/router/runtime binaries changed or
when a pilot run could be using stale sidecars:

```powershell
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD = "1"
pnpm --filter @neatech/veslo run prepare:sidecar
Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
```

Rebuild the E2E debug Tauri binary when any of these changed:

- Rust desktop code
- Tauri config/capabilities
- Pilot plugin setup or the `e2e` feature surface
- bundled frontend assets used by the debug binary
- sidecar files that must be bundled into the debug binary

Changing only a TOML pilot scenario or `packages/e2e/helpers/pilot-runner.ts`
does not require a Tauri rebuild. Rerun the package script.

## E2E Build Verification

Use this build path when validating the actual desktop binary that Pilot will
drive:

```powershell
pnpm --filter veslo-server build:bin

$env:VESLO_SIDECAR_FORCE_BUILD = "1"
pnpm --filter @neatech/veslo run prepare:sidecar
Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD

Push-Location packages\desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
Pop-Location
```

After the build, these invariants should hold:

- `packages/desktop/src-tauri/target/debug/veslo.exe` exists and has a fresh
  timestamp.
- `packages/desktop/src-tauri/tauri.e2e.conf.json` uses identifier
  `com.neatech.veslo.e2e`.
- `packages/desktop/src-tauri/tauri.conf.json` keeps the release identifier
  `com.neatech.veslo`.
- `pilot:default` appears only in `tauri.e2e.conf.json`; it must not appear in
  the default capability files or release config.
- `tauri_plugin_pilot::init()` remains guarded by
  `#[cfg(all(debug_assertions, feature = "e2e"))]`.
- `packages/desktop/src-tauri/Cargo.toml` keeps the `e2e` feature wired to
  `tauri-plugin-pilot/press`.
- `tauri-pilot --version` reports `tauri-pilot 0.7.2`, matching
  `tauri-plugin-pilot = "0.7.2"`.
- The package runner still seeds WebView Den auth from
  `VESLO_E2E_DEN_AUTH_JSON` or `VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE` before a
  TOML scenario runs.
- Managed-AI/inference scenarios still reject
  `E2E_MANAGED_AI_GATEWAY_FIXTURE=1` and do not auto-enable that fixture.

Useful local checks:

```powershell
Test-Path packages\desktop\src-tauri\target\debug\veslo.exe
Select-String -Path packages\desktop\src-tauri\tauri.e2e.conf.json -Pattern "com.neatech.veslo.e2e|pilot:default"
Select-String -Path packages\desktop\src-tauri\tauri.conf.json,packages\desktop\src-tauri\capabilities\*.json -Pattern "pilot:default"
Select-String -Path packages\desktop\src-tauri\src\lib.rs -Pattern "debug_assertions, feature = `"e2e`"|tauri_plugin_pilot::init"
Select-String -Path packages\desktop\src-tauri\Cargo.toml -Pattern "e2e =|tauri-plugin-pilot"
tauri-pilot --version
```

Then run a non-inference Pilot smoke to prove the rebuilt binary accepts the
socket and Pilot capability:

```powershell
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario smoke
```

For managed-AI/inference acceptance, add the live seed and keep the fixture
disabled:

```powershell
$env:VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE = "C:\Users\jajse\.veslo\den-auth.json"
$env:E2E_MANAGED_AI_GATEWAY_FIXTURE = "0"
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario message-send-registry-degraded
```

## Scenario Authoring Boundaries

Pilot scenarios should prove the same user-facing path the desktop app uses in
production.

- Prefer visible UI actions and app/server readiness checks over direct Tauri
  command shortcuts.
- Do not call `engine_start`, `engine_info`, or
  `orchestrator_workspace_activate` from ordinary active-workspace send
  scenarios. Those commands are legacy/debug control points and can bypass the
  current lazy workspace runtime path. Use them only when the scenario
  explicitly tests lifecycle recovery, workspace switching, isolation, or debug
  command behavior.
- Long-running eval steps should start an async task, write a hidden DOM
  progress/error/complete marker, and let a following `wait` step observe the
  marker. That keeps the Pilot command responsive while preserving rich failure
  detail.
- Eval scripts with `await` must still parse as valid JavaScript before Pilot
  runs them. A syntax error in the script body can surface as Pilot's
  "top-level await detected" wrapper error. For large TOML scripts, run a
  local parse check against the `script = '''...'''` body before starting a
  full live scenario.
- For managed-AI/inference scenarios, read Den auth from WebView storage first
  and then from `den_auth_snapshot_read`; never use a hardcoded
  `veslo-e2e-*` token.

## Automatic Failure Diagnostics

The package runner captures a diagnostic bundle whenever `tauri-pilot run`
fails. Look under:

```text
packages/e2e/tauri-pilot-failures/diagnostics-<timestamp>-<scenario>/
```

Start with these files:

- `failure.txt`: original runner error with the tauri-pilot step output tail.
- `summary.json`: command list, exit codes, and artifact names.
- `snapshot.txt`: accessibility tree around the failed state.
- `logs.json`: recent browser console logs.
- `network.json` and `network-failed.json`: recent requests and failed
  requests.
- `veslo-server-info.json` and `workspace-bootstrap.json`: app-side Tauri IPC
  state.
- `storage-local.json` and `storage-session.json`: WebView storage, including
  whether Den auth was seeded.
- `webview.png`: full-page WebView screenshot when screenshot capture succeeds.

Use these artifacts before rerunning a scenario. They usually answer whether
the failure was UI targeting, missing auth seed, local server startup,
workspace bootstrap, runtime recovery, or remote gateway/network behavior.

Set `E2E_PILOT_FAILURE_DIAGNOSTICS=0` only for narrow runner debugging where
the diagnostic probes themselves would obscure the original process failure.

## E2E Profile And Auth Knobs

The E2E runner does not behave like `pnpm dev`.

- By default it creates an isolated profile under `packages/e2e/.tmp-veslo-home`
  and an isolated `OPENCODE_HOME`.
- In isolated mode it intentionally sets `HOME`, `USERPROFILE`, `APPDATA`,
  `LOCALAPPDATA`, and `WEBVIEW2_USER_DATA_FOLDER`.
- It chooses an isolated local Veslo server port unless `E2E_VESLO_SERVER_PORT`
  is set.
- `E2E_USE_EXISTING_PROFILE=1` is only for scenarios that explicitly need the
  current desktop profile.

For live Den auth in the E2E runner, set the E2E seed input:

```powershell
$env:VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE = "C:\Users\jajse\.veslo\den-auth.json"
```

The runner copies that snapshot into the isolated profile, launches the app
with `VESLO_DEN_AUTH_SNAPSHOT_PATH` pointing at the copied file, and seeds the
WebView Den localStorage from the same snapshot before the TOML scenario runs.
Setting only `VESLO_DEN_AUTH_SNAPSHOT_PATH` is correct for a manual `pnpm dev`
run, but it is not the primary input for the E2E launcher.

Managed-AI/inference pilot scenarios must use the live Den auth seed. They
fail fast when the seed is missing, when it uses an `@example.test` user,
when it carries an E2E fixture token, when it points Den at loopback, or when
a managed-AI gateway loopback override is set. Keep this explicit no-fixture
setting in live runs:

```powershell
$env:E2E_MANAGED_AI_GATEWAY_FIXTURE = "0"
```

`E2E_MANAGED_AI_GATEWAY_FIXTURE=1` is not valid acceptance evidence for
managed-AI/inference pilot scenarios. It can still be used for narrow fixture
debugging outside those scenarios, but record it as fixture-only evidence.

To remove Veslo automations from a pilot diagnosis without deleting files:

```powershell
$env:VESLO_ENABLE_AUTOMATIONS = "0"
$env:VESLO_ENABLE_AUTOMATIONS_PLUGIN = "0"
```

The expected profile evidence is an inert disabled automation marker, not an
active `.opencode/plugins/veslo-automations.js` plugin.

## AI Gateway Debugging

Use this quick gate before blaming the live desktop run:

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.ai-gateway.test.ts src/tests/server.ai-gateway-routes.test.ts src/tests/ai-gateway-runtime-owner.test.ts
```

Then classify the failing runtime by trace evidence:

| Evidence | Meaning |
| --- | --- |
| No `server:ai-gateway:provider-hit` for the run | OpenCode did not call the local gateway route. Check generated OpenCode config, E2E profile, stale debug binary/sidecars, dev autostart state, plugin stalls, and workspace/session routing. |
| `provider-hit` exists and `server:ai-gateway:proxy:timing` has `401`, `403`, or `504` | The request reached the local proxy and failed in auth/upstream/gateway timing. Inspect gateway auth source, session id, workspace id, upstream status, and timeout. |
| `server:ai-gateway:proxy:timing` has `status:200`, `outcome:"ok"`, and `upstreamContentType:"text/event-stream"` | The AI gateway provider route responded. If the UI still has no answer, look downstream at OpenCode event consumption, transcript reconcile, lifecycle status, or UI render. |

Useful trace patterns:

```powershell
Select-String -Path .\dev-specific\tauri-pilot\<run>\send-workflow-trace.ndjson `
  -Pattern "server:ai-gateway:provider-hit|server:ai-gateway:proxy:timing|ai-gateway-provider-start-watch|transcript-reconcile"

Select-String -Path .\dev-specific\tauri-pilot\<run>\runtime-trace.ndjson `
  -Pattern "shared-opencode-spawn-ready|orchestrator:proxy-upstream:error|opencode/event"
```

Known 2026-07-03 evidence:

- A manual `pnpm dev` run with live Den auth, no Tauri Pilot, and
  `E2E_MANAGED_AI_GATEWAY_FIXTURE=0` reached `/api/me/ai-access` with `200`.
- The same manual run reached
  `/providers/codex_oauth/v1/chat/completions` twice with `200` SSE responses.
- The server later marked the conversation run `completed` through transcript
  reconcile.
- E2E Pilot runs with the corrected live login and automations disabled could
  still log `AI gateway provider request did not start within 30000ms`.

The practical conclusion is: if `pnpm dev` proves a `200` SSE provider route
but E2E Pilot logs provider-start timeout, treat the next investigation as an
E2E debug build/profile/config/harness difference, not as proof that the hosted
AI gateway is down.

## Pilot CLI Notes

On Windows, prefer the explicit binary path or `E2E_TAURI_PILOT_BIN`. Avoid
shell wrappers that trigger PowerShell download/security prompts; those block
automation and make the run look like a hung CLI instead of a Veslo failure.

Use PowerShell quoting for Pilot refs:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe click '@e28'
C:\Users\jajse\.cargo\bin\tauri-pilot.exe fill '@e52' "Return exactly one line: PILOT_OK"
```

Refs are snapshot-local. Take a new `snapshot -i` after route changes,
workspace switches, modal opens, reloads, or large sidebar updates.

For Windows command-line work, prefer the package runner for scenarios:

```powershell
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario <name-or-path>
```

Use the raw CLI only after the correct app is already running and the socket is
known:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe ping
C:\Users\jajse\.cargo\bin\tauri-pilot.exe windows
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main snapshot -i
```

Use JSON mode when another script will parse the output:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main --json state
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main snapshot --json --save .\snapshot.json
```

Use scoped snapshots/diffs for dense UI:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main snapshot -i --selector '[data-testid="session-view"]' --depth 6
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main diff -i --selector '[data-testid="session-view"]'
```

Use DOM stability waits after actions that trigger async UI updates:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main watch --selector '#root' --stable 750 --timeout 15000
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main wait --selector '[data-testid="session-run-indicator"]' --gone --timeout 180000
```

Use console and network buffers before and after a scenario. Clear buffers at
the beginning of a focused run to avoid mixing old evidence with the current
transition.

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main logs --clear
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main network --clear

C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main logs --last 200 --json
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main network --failed --json
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main network --filter "/ai-gateway" --last 50
```

Use storage and forms when the problem may be auth/profile/UI-state related:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main storage list --json
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main storage get veslo.den.auth --json
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main forms --json
```

Use `ipc` only when the diagnosis needs a Tauri command result. Prefer the
normal UI path first.

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main ipc veslo_server_info --json
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main ipc workspace_bootstrap --json
```

Use screenshots as visual evidence. `screenshot` captures through the WebView;
`screenshot_native` captures by platform window id from `windows`.

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main screenshot .\veslo-webview.png
C:\Users\jajse\.cargo\bin\tauri-pilot.exe windows --json
C:\Users\jajse\.cargo\bin\tauri-pilot.exe screenshot_native --window-id 123456 --output .\veslo-native.png
```

Record/replay is useful for exploratory debugging, but do not commit raw
recordings as the durable test. Convert the useful part into a small TOML
scenario or a focused helper script.

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main record start
# perform the interaction
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main record stop --output .\recording.json
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main replay .\recording.json --export sh
```

## Scenario Authoring

Veslo's current `packages/e2e/pilot-scenarios/*.toml` files use a conservative
subset of Pilot scenario actions:

- `wait`
- `eval`
- `assert-visible`
- `assert-url`

Use `[scenario]` for scenario metadata and repeated `[[step]]` blocks for
actions:

```toml
[scenario]
name = "example"
fail_fast = true
global_timeout_ms = 120000

[[step]]
name = "root exists"
action = "wait"
target = "#root"
timeout_ms = 15000

[[step]]
name = "state marker appears"
action = "assert-visible"
target = "[data-testid=\"example-complete\"]"
timeout_ms = 60000
```

For deterministic Veslo regression scenarios, prefer:

- stable `data-testid` selectors over snapshot refs,
- `wait`/`assert-visible` over sleeps,
- one causal transition per step,
- `eval` only when the scenario needs to orchestrate app internals or expose a
  hidden diagnostic marker,
- hidden `<pre data-testid="...">` markers for large diagnostic payloads,
- `run --junit <file>` when a CI or artifact bundle needs machine-readable
  scenario results.

Example:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main run --junit .\pilot-smoke.junit.xml .\packages\e2e\pilot-scenarios\smoke.toml
```

## What To Record

Every run should leave enough evidence for another agent to classify it without
re-running it:

- exact command and scenario
- app binary path
- whether the run used `pnpm dev` or the E2E debug binary
- profile mode: real profile, isolated profile, or custom `E2E_OPENCODE_HOME`
- auth source and expected Den user email
- fixture state, especially that `E2E_MANAGED_AI_GATEWAY_FIXTURE` is unset or
  `0` for managed-AI/inference runs
- automation plugin state
- selected workspace id, conversation id, run id, and OpenCode session id
- `runtime-trace.ndjson`, `send-workflow-trace.ndjson`, and app stdout/stderr
- first failing transition, not just final UI state

Prefer causal labels. `AI gateway provider request did not start within 30000ms`
means OpenCode did not produce a matching provider hit in time; it does not, by
itself, prove that the remote gateway rejected the request.
