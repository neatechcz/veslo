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

### Manual dev runtime with Pilot

Use this when the goal is to inspect the app/local server/AI gateway path
through the normal `pnpm dev` loop, without the isolated E2E launcher.
`pnpm dev` enables the dev-only Pilot capability through an inline Tauri config
merge, compiles the `e2e` Cargo feature, and writes a runtime manifest plus
trace files under `dev-specific/tauri-pilot/manual-runtime-*-pnpm-dev/`.

```powershell
$env:VESLO_DEN_AUTH_SNAPSHOT_PATH = "C:\Users\jajse\.veslo\den-auth.json"
$env:E2E_MANAGED_AI_GATEWAY_FIXTURE = "0"

pnpm dev
```

At startup, copy the printed `[veslo:dev-runtime] pilotPing=...` command to
attach the raw Pilot CLI to the exact socket for that run. The same banner
prints `runtime-info.json`, `runtime-trace.ndjson`, `send-workflow-trace.ndjson`,
and `opencode-health.ndjson`.

For this path, do not set `HOME` or `USERPROFILE`. Corepack/pnpm and the
normal desktop profile should stay tied to the real Windows user. Do not set
`VESLO_DISABLE_DEV_AUTOSTART` unless the test is specifically about that
boundary. Set `VESLO_TAURI_PILOT=0` only when you need the old standard dev
runtime without Pilot or trace defaults.

### E2E debug binary with Pilot

Use this when the scenario must run through the same debug binary and isolated
profile model as `packages/e2e`.

```powershell
pnpm --filter @neatech/veslo-e2e run build:desktop:e2e

$env:E2E_TAURI_PILOT_BIN = "C:\Users\jajse\.cargo\bin\tauri-pilot.exe"
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario runtime-cold-start-session-handoff
```

`build:desktop:e2e` always builds `veslo-server`, force-prepares desktop
sidecars, and then builds the debug Tauri binary with
`src-tauri/tauri.e2e.conf.json` and the `e2e` feature. Use it instead of
copying only one of those steps.

The runner launches `packages/desktop/src-tauri/target/debug/veslo.exe`, sets
`TAURI_PILOT_SOCKET`, waits for Pilot readiness, runs the TOML scenario, and
tears the app down. On Windows the default socket is a named pipe:
`\\.\pipe\tauri-pilot-com.neatech.veslo.e2e`.

## What To Rebuild

Rebuild sidecars when server/orchestrator/router/runtime binaries changed or
when a pilot run could be using stale sidecars:

```powershell
pnpm --filter @neatech/veslo-e2e run build:desktop:e2e
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
pnpm --filter @neatech/veslo-e2e run build:desktop:e2e
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
- The package runner prepares a desktop auth snapshot before launch. It does
  not write WebView auth through Pilot or reload the app after boot; live
  scenarios verify that desktop snapshot hydration produced a signed-in state.
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
disabled. `test:pilot:live-inference` is the canonical production-path suite:
it runs the visible message-send flow only, requires `codex_oauth`, and caps
the scenario at 180 seconds (with five seconds of runner grace to collect a
failure result). This is an observation budget for a cold real-provider
response, not a product latency target; the independent desktop boot cap stays
at 95 seconds.

```powershell
$env:VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE = "C:\Users\jajse\.veslo\den-auth.json"
$env:E2E_MANAGED_AI_GATEWAY_FIXTURE = "0"
pnpm --filter @neatech/veslo-e2e test:pilot:live-inference
```

From the workspace root, the same gate is available as:

```powershell
pnpm test:e2e:ui:live-inference
```

The longer cold-start handoff check remains available as explicitly separate
lifecycle coverage; it is not acceptance evidence for the canonical
live-inference gate:

```powershell
pnpm --filter @neatech/veslo-e2e test:pilot:live-inference:lifecycle
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
- Pilot's current `type` bridge is value-element oriented. For a
  `contenteditable` composer, use the canonical narrow adapter: focus the
  visible target and use the WebView's own `document.execCommand("insertText")`
  editing path. Do not write Solid state or `textContent`, dispatch a synthetic
  `InputEvent`, or invoke the send button directly; retain a native Pilot
  `click` for submission. Raw OS-level `press` remains useful for keyboard
  accelerator checks, but it is not the canonical text-entry mechanism on
  Windows because foreground key delivery can be intermittent.
- Keep lifecycle/recovery checks outside `test:pilot:live-inference` unless
  their TOML `global_timeout_ms` and step `timeout_ms` values are at most
  180000.

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
- `storage-local-summary.json` and `storage-session-summary.json`: key names
  plus Den auth presence, token presence, email, and Den base; no stored values
  or bearer tokens.
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
- Canonical live inference rejects `E2E_USE_EXISTING_PROFILE` and
  `E2E_OPENCODE_HOME`; it always uses the harness-owned isolated profile and
  copied Den snapshot. The child desktop environment also removes
  `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_API_BASE` so a host API-key
  configuration cannot turn the gate into a direct OpenAI fallback.
- On Windows, every isolated live managed-AI scenario additionally mirrors the
  dev profile's `runtime-preferences.json` when it exists at
  `%APPDATA%\com.neatech.veslo.dev\runtime-preferences.json`. It copies only
  `sharedUnsandboxedEngine` and `supportDiagnostics` into the isolated app
  config; unknown fields, auth/access-proof files, workspaces, and WebView
  storage are never copied. Set
  `E2E_LIVE_PARITY_RUNTIME_PREFERENCES_SOURCE` to select another explicit
  `runtime-preferences.json` source.

For live Den auth in the E2E runner, use the same production desktop snapshot
path accepted by the app:

```powershell
$env:VESLO_DEN_AUTH_SNAPSHOT_PATH = "C:\Users\jajse\.veslo\den-auth.json"
```

`VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE` remains available when a test needs a
separate E2E-only input. In both cases the runner copies that snapshot into the
isolated profile, launches the app with `VESLO_DEN_AUTH_SNAPSHOT_PATH` pointing
at the copied file, and lets the desktop startup hydration restore the WebView
state before onboarding. The runner never copies raw auth JSON into a Pilot
command or reloads the app after boot.

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

Current live gateway behavior can return `/api/me/ai-access` with
`aiAccess.enabled:true` and no top-level `accessToken`. That is valid: the local
Veslo server then forwards the caller Den authorization to the provider route.
The generated OpenCode provider must still contain
`env:["VESLO_OPENCODE_SERVER_CLIENT_TOKEN"]` and
`apiKey:"{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}"`. For
`@ai-sdk/openai-compatible` gateway providers it must also contain
`options.headers.Authorization:"Bearer {env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}"`
so the local Veslo server receives the internal client auth header. If this is
missing, OpenCode may surface only `AI_APICallError: Unauthorized` /
`Invalid bearer token`, and the server watchdog may see no provider hit. This is
not a provider API-key mode; the upstream credential still comes from the
managed AI gateway runtime authorization.

For managed `prompt_async` sends, runtime authorization must be primed before
the app calls `/workspace/:id/conversations/:conversationId/runs`. The expected
send trace contains
`runConversationFromVesloWriteApi:managed-ai-runtime-auth-prime` before
`runConversationFromVesloWriteApi:run`. The priming request uses the same local
Veslo server routing target and `VESLO_OPENCODE_SERVER_CLIENT_TOKEN` that the
generated OpenCode provider uses; it is not a direct provider API call.

The server may correlate a provider request with the active run's actor token
hash, but it must never fall back to a global "latest runtime authorization".
Parallel sends can have different actors, sessions, and gateway credentials.
If a provider request fails locally with `401` before `proxy-start`, inspect
whether `gatewayAuthorizationSource` is `missing` and whether the active run
diagnostics report `runtimeAuthorizationActorTokenHashPresent:true`.

If the provider route returned `200` and the OpenCode SQLite transcript has
the assistant text, but the UI still renders no assistant answer, compare the
host transcript cache in `.veslo/conversations/bindings.sqlite`. A same-ID text
part with `text: ""` in `conversation_part.payload_json` means a stale
streaming snapshot overwrote the richer engine transcript. That is an app/server
transcript ingestion bug, not an auth or AI gateway failure.

Provider-start timeout is diagnostic evidence, not a valid reason to fail or
abort a live inference by itself. After OpenCode accepts `prompt_async`, the
conversation run route should return `submitted`; the provider-start watch keeps
the active gateway context long enough to correlate the first provider request
and records `server:conversation-run:ai-gateway-provider-start-watch:timeout`
only if that request is not observed. If the UI still receives no answer, keep
following OpenCode errors/events, lifecycle status, transcript reconcile, and
gateway proxy traces. Do not treat the watchdog timeout alone as proof that the
hosted AI gateway rejected the request.

If the OpenCode log has `background dependency install failed` or
`ReleaseError: metadata missing`, inspect the orchestrator runtime trace for
`opencode-managed-dependencies:manifest-tree-vendored`. A healthy shared config
vendors the managed provider packages before inference and declares the same
managed runtime packages in the generated config `package.json`, including
`@opencode-ai/plugin` because Veslo managed tools import it. The package must
also exist locally at `node_modules/@opencode-ai/plugin/package.json`; OpenCode
should not have to discover or repair that dependency during inference. In that
state the next expected gateway evidence is a provider route hit under
`/ai-gateway/providers/<provider>/v1/chat/completions`.

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
- E2E Pilot runs with the corrected live login and automations disabled used to
  fail the app request on provider-start timeout; current behavior keeps this as
  a background diagnostic and lets OpenCode/lifecycle/gateway errors be the
  source of truth.

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

Use forms when the problem may be auth/profile/UI-state related:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe --window main forms --json
```

Do not collect raw `storage list` or `storage get veslo.den.auth` output in a
failure bundle, terminal transcript, or uploaded artifact: it can contain a
live bearer token. The package runner records only the redacted storage
summaries described above.

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
