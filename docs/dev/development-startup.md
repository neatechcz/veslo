# Development Startup Guide

Use this guide whenever someone asks to start Veslo during development (for example `spust`, `start app`, `run in dev mode`).

## Scope

- Authoritative runtime: `packages/desktop` (Tauri desktop app)
- Primary development mode: local mode with local OpenCode (do not treat cloud-backed execution as the default startup path)
- Do not use `packages/web` or UI-only web servers as proof that the app is running correctly.
- Do not start `pnpm -w dev:ui`, `pnpm --filter @neatech/veslo-ui dev`, or raw Vite as the Veslo app runtime.
- Never launch a previously built desktop app as a substitute for development startup. Always run a new build from current sources before starting.
- Veslo desktop is single-tenant during development and testing. Agents must clear internally started dev/test runtime instances before launching another runtime.

## Workspace Engine Topology

The normal local topology is pooled-per-workspace: each canonical workspace owns
one engine slot, and all conversations in that workspace share the slot while
keeping independent conversation, OpenCode session, and run identities. A
process-wide shared-unsandboxed engine is diagnostic-only and must be selected
explicitly; it is not the fresh-profile default.

For headless verification of this contract, rebuild the compiled server before
starting the orchestrator-backed oracle:

```bash
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build
node packages/orchestrator/scripts/workspace-one-engine-many-conversations.integration.mjs
```

The oracle uses an isolated workspace and deterministic provider fixture. It
proves ten concurrent conversation/session/run bindings, abort isolation, and
generation-fenced engine-loss reconciliation without launching a desktop test
driver. Its JSON artifact is written under `.tmp/runtime-oracle/`.

To verify the shipped OpenCode binary independently of the desktop runtime,
also run:

```bash
node packages/orchestrator/scripts/opencode-workspace-concurrency.integration.mjs
node packages/orchestrator/scripts/opencode-directory-scoped-skills.integration.mjs
```

These are non-Tauri compatibility gates for concurrent prompts, restart-stable
session IDs, workspace/directory skill isolation, and the documented hot-update
fallback.

## Standard Dev Startup (Fresh Build Required, No Exceptions)

Run from repository root.

The public startup command is the same on macOS, Linux, and Windows:

```bash
pnpm dev
```

`pnpm dev` delegates to `packages/desktop`, which starts Tauri through
`packages/desktop/scripts/tauri-dev.mjs`. The wrapper preserves the previous
dev behavior while avoiding shell-specific inline environment syntax:

- `VESLO_DATA_DIR` defaults to `%LOCALAPPDATA%\com.neatech.veslo.dev\veslo-orchestrator-dev` on Windows (falling back to `%APPDATA%`), and `<home>/.veslo/veslo-orchestrator-dev` on macOS/Linux.
- On Windows, when `VESLO_DATA_DIR` is not explicitly set, the wrapper copies missing files from the legacy `<home>\.veslo\veslo-orchestrator-dev` dev store and merges legacy `conversation_binding` rows into the AppData store so existing local session history remains visible after the default path migration.
- `VESLO_SERVER_DEV_WATCH` defaults to `1`
- `VESLO_SERVER_DEV_DIR` defaults to `packages/server`
- `PORT` defaults to `5173`
- Tauri still receives `src-tauri/tauri.dev.conf.json` and a matching
  `build.devUrl`

Do not require Git Bash, `pnpm --config.script-shell`, or a POSIX shell just to
start the app on Windows. Developers can keep using the same `pnpm dev` command
they used before.

### Live signed-in profile: native WebDriver attach

For a high-fidelity, manual diagnostic of the currently signed-in development
profile, start the normal desktop development runtime with an explicit
loopback-only W3C WebDriver endpoint:

```bash
pnpm dev:webdriver
```

This does not create an E2E account, copied auth snapshot, isolated WebView
profile, or second Tauri application. It uses the same dev identifier and data
directory as `pnpm dev`. Startup prints the timestamped `runtime-info.json`;
from a second terminal, attach the read-only smoke client to that exact file:

```bash
pnpm test:webdriver:live -- <runtime-info.json>
```

The client attaches only and closes its WebDriver session when finished; it
does not stop or alter the app. WebDriverIO is the supported desktop E2E and
live-diagnostic driver. The embedded endpoint is only for a trusted
local development account: it binds to `127.0.0.1`, but W3C WebDriver itself
does not authenticate other processes running as the same OS user.

### Controlled live UI workspace roundtrip

The separate roundtrip command uses visible UI controls to create one new
conversation and submit one real prompt in each of two explicitly named
workspaces. It is deliberately not part of `test:webdriver:live`, because it
persists messages and may trigger real model work.

It has no default workspace or prompt. Choose disposable workspaces, provide
both exact visible labels and single-line messages, then explicitly authorize
the mutation in the invoking shell:

```powershell
$env:WEBDRIVER_ALLOW_MUTATION = "1"
pnpm test:webdriver:workspace-roundtrip -- <runtime-info.json> `
  --initial-workspace "First workspace" `
  --second-workspace "Second workspace" `
  --first-message "WebDriver UI roundtrip one" `
  --second-message "WebDriver UI roundtrip two"
```

The script finds each workspace through the rendered sidebar, clicks its New
conversation control, types through the visible composer, clicks the visible
send button, and closes only its WebDriver session. It does not call a Veslo
conversation API directly or infer a workspace from the current selection.

### Controlled live same-conversation queue diagnostic

Use this mutating diagnostic for ordered sends in one new conversation. It
submits the second message after the first run is visibly active; an optional
third message is submitted in the same active window. The scenario waits for
one visible assistant output per submitted message, so it catches a queue item
that remains stuck after an earlier item completes.

```powershell
$env:WEBDRIVER_ALLOW_MUTATION = "1"
pnpm test:webdriver:same-conversation-queue-roundtrip -- <runtime-info.json> `
  --workspace "Disposable workspace" `
  --first-message "Reply with exactly: first" `
  --second-message "Reply with exactly: second" `
  --third-message "Reply with exactly: third" `
  --event-stream-gate true
```

All messages are explicit, single-line inputs. Omit `--third-message` for the
two-message version; the command never chooses a workspace or prompt by
itself. Omit `--event-stream-gate` for the ordinary queue roundtrip. With the
gate enabled, the scenario requires an E2E-fault-enabled pooled runtime,
disconnects only the app-facing workspace event stream, waits for the exact
queued turn to be claimed and admitted, and releases the reconnect barrier. It
fails if the pooled engine owner or generation changes. The resulting artifact
records content-free transcript and queue row transitions so a transient
orphan or duplicate assistant turn cannot be hidden by the final DOM.

For a freshly started runtime, first allow workspace skill discovery to settle.
An initial empty skill view may be replaced by the resolved view; that is a real
engine generation change and is intentionally outside this reconnect-ordering
diagnostic.

### Controlled live workspace-skill sidebar diagnostic

This mutating diagnostic covers the exact same-workspace regression path: a
first conversation asks the agent to create one new `.opencode` workspace
skill, then the scenario verifies the file exists, checks the sidebar in that
conversation, opens a second conversation in the same workspace, submits a
normal verification message, and checks the sidebar again. It intentionally
requires both the rendered workspace label and its absolute filesystem path so
the test never guesses or overwrites a pre-existing skill. Use a disposable
workspace and a previously unused kebab-case skill name:

```powershell
$env:WEBDRIVER_ALLOW_MUTATION = "1"
pnpm test:webdriver:skill-sidebar-refresh -- <runtime-info.json> `
  --workspace "Disposable workspace" `
  --workspace-path "C:\\path\\to\\disposable-workspace" `
  --skill-name "webdriver-sidebar-check"
```

### Owned live WebDriver scenario

The attach commands intentionally leave the development app open because they
may be used against a runtime that a developer started for debugging. For a
repeatable start-to-finish diagnostic, use the owned variant instead. It starts
one fresh runtime through the same desktop dev wrapper as `pnpm dev:webdriver`,
waits for its loopback endpoint, runs the same explicit mutation scenario,
writes the redacted artifact, and closes only that process tree. It never
attaches to or closes an existing runtime.

Use it only with an explicitly selected disposable workspace:

```powershell
$env:WEBDRIVER_ALLOW_MUTATION = "1"
pnpm test:webdriver:skill-sidebar-refresh:owned -- `
  --workspace "Disposable workspace" `
  --workspace-path "C:\\path\\to\\disposable-workspace" `
  --skill-name "webdriver-sidebar-check"
```

The command prints one concise JSON result. A failed assertion still writes a
redacted scenario artifact before it shuts down the runtime. It does not delete
the skill created by the model, so that filesystem result remains available as
evidence and must use an otherwise-unused test skill name.

Owned scenarios always force local runtime, send-workflow, UI-mutation, and
OpenCode-health diagnostics on. Their run directory under `.tmp` retains the
separate runtime, UI, server, orchestrator, and health trace files even when a
failure is unrelated to the scenario assertion. The scenario artifact records
a content-free manifest of those channels; inspect the corresponding files in
the run directory for the full redacted evidence.

### Reusable live WebDriver scenarios

`packages/desktop-webdriver/src/scenario-kit/` contains the shared primitives
for trusted local development diagnostics. It is deliberately split by domain:
workspace navigation, composer input, state waits, UI snapshots, assertions,
timeline measurement, console capture, redaction, and artifact writing.
`src/scenarios/` contains compact scenario definitions; their CLI entrypoints
remain at `src/` and are exposed through root `pnpm test:webdriver:*` scripts.

The shared UI primitives intentionally map one-for-one to visible app actions:

- `selectWorkspaceForNewConversation()` selects an explicitly named rendered
  workspace and uses its New conversation button.
- `focusComposer()`, `writeComposer()`, and `submitComposer()` act only on the
  visible composer and send button. Writing refuses a non-empty composer so a
  retry cannot append a duplicate prompt.
- `waitForAppReady()` is route-agnostic. `waitForSessionSidebarReady()` is
  intentionally stricter and may only be used after a scenario has entered the
  session shell; `waitForSubmittedRunToSettle()` is required before a scenario
  moves from one workspace to another.

Every scenario executed through `runLiveScenario()` saves a local JSON artifact
under `.tmp/webdriver-scenarios/`. It includes a minimal runtime identity,
scenario result or error, automatic initial/final UI snapshots, named measured
steps, and renderer console logs observed during that scenario. It never
captures cookies, page source, screenshots, or the transcript. Secret-like
values are redacted. Console capture is injected into the trusted local page;
the scenario deliberately does not call the optional W3C `browser` log endpoint
because the loopback native endpoint does not implement it reliably.

Scenarios should use `step(name, operation)` around each meaningful UI action
and `snapshot(label)` at state transitions. This produces comparable cold/warm
latency evidence without asserting timing budgets prematurely. Use the focused
assertions for a missing runtime error or a completed run rather than adding
ad-hoc polling to a scenario.

New scenarios must use the runner and declare `mutations: true` for any action
that persists state. They then require `WEBDRIVER_ALLOW_MUTATION=1`; read-only
scenarios do not. Mutating scenarios are the supported desktop E2E lane when
their explicit workspace and prompt inputs describe the behavior under test.

### Read-only sidebar flicker diagnostic

The sidebar flicker scenario observes animation frames while it expands the
conversation accordions for two explicitly named workspaces. It does not create
a conversation, send a prompt, or start an engine. Its artifact records frame
gaps of 50 ms or more, visibility flaps, geometry changes of two pixels or
more, and DOM mutation volume for the root, sidebar, session pane, and composer.
These are diagnostic signals, not an automatic visual-regression verdict.

```powershell
pnpm test:webdriver:sidebar-flicker -- <runtime-info.json> `
  --initial-workspace "First workspace" `
  --second-workspace "Second workspace" `
  --observe-ms 1500
```

1. Verify whether app/dev processes are already running.
2. Stop previous app/dev processes and verify they are fully stopped.
3. Rebuild desktop artifacts from source.
4. Start Tauri dev runtime.
5. Confirm the expected runtime signals.

Never launch a second app/dev instance. This rule applies to normal development startup and to test runs, and it is an agent runbook responsibility rather than per-test spec logic.

```bash
# 1) Mandatory pre-check: detect already-running instances
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri-dev\\.mjs|tauri(\\.js)? dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true

# 2) Stop previous internally started dev/test runs (safe if nothing is running)
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri-dev\\.mjs|tauri(\\.js)? dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true

# 2b) Mandatory post-check: must be empty before continuing
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri-dev\\.mjs|tauri(\\.js)? dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true

# 3) Fresh rebuild (desktop native layer)
pnpm --filter @neatech/veslo exec cargo clean --manifest-path src-tauri/Cargo.toml
pnpm --filter @neatech/veslo exec cargo build --manifest-path src-tauri/Cargo.toml --no-default-features

# 4) Start dev runtime
pnpm dev
```

Windows PowerShell equivalent for the process check/cleanup:

```powershell
$pattern = 'pnpm|tauri-dev\.mjs|tauri(\.js)? dev|target\\debug\\veslo|vite[/\\]bin[/\\]vite\.js|veslo-orchestrator|veslo-server|veslo-code-router'

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match $pattern } |
  Select-Object ProcessId,Name,CommandLine

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match $pattern } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

pnpm --filter @neatech/veslo exec cargo clean --manifest-path src-tauri/Cargo.toml
pnpm --filter @neatech/veslo exec cargo build --manifest-path src-tauri/Cargo.toml --no-default-features
pnpm dev
```

## Required Runtime Confirmation

Consider startup complete only when both appear in logs:

- `VITE ... ready` with local URL (default `http://localhost:5173/`)
- `Running target/debug/veslo`

If only Vite runs, desktop runtime is not fully started; stop it and use the desktop startup flow.

## Send Boundary Validation Diagnostics

App-side send boundary validation is controlled by
`VITE_VESLO_SEND_BOUNDARY_VALIDATION`:

- `off` skips validation and produces no validation trace events.
- `report` is the default; malformed send boundary payloads are recorded but do
  not block the send.
- `strict` records and fails closed. Use this only for focused debugging or
  tests.

During `pnpm dev`, validation events are written to the existing send trace:

- A stable gitignored mirror is written to `.tmp/send-workflow-trace.ndjson`.
  It includes app-forwarded events plus server and orchestrator send trace
  events when those processes inherit the trace environment.
- The timestamped dev runtime archive is printed at startup as
  `sendWorkflowTrace=.../send-workflow-trace.ndjson`.
- WebView DevTools console shows `[SENDTRACE] app:<event>`.
- The Tauri dev terminal receives `[ui:send-trace] <event> <json>`.
- The current WebView keeps recent entries in `window.__vesloSendTrace`.
- Successful checks use `validation-checked`; malformed payloads use
  `validation-failed`.

From DevTools, filter validation events with:

```js
window.__vesloSendTrace?.filter((entry) =>
  String(entry.event ?? "").includes("validation-")
)
```

PowerShell examples:

```powershell
# Report-only diagnostics, same mode as default production behavior.
$env:VITE_VESLO_SEND_BOUNDARY_VALIDATION = "report"
pnpm dev
```

```powershell
# Strict debugging: validation failures can block send.
$env:VITE_VESLO_SEND_BOUNDARY_VALIDATION = "strict"
pnpm dev
```

The `pnpm dev` wrapper enables workflow tracing by default. To override the
stable mirror path:

```powershell
$env:VITE_VESLO_SEND_WORKFLOW_TRACE = "1"
$env:VESLO_SEND_WORKFLOW_TRACE = "1"
$env:VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE = "$PWD\.tmp\send-workflow-trace.ndjson"
pnpm dev
```

Then inspect `window.__vesloDumpSendWorkflowTrace?.()` in DevTools or the
configured NDJSON file. The mirror is an append-only developer convenience; if
you need a single clean run, delete `.tmp/send-workflow-trace.ndjson` before
starting `pnpm dev`.

## Browser Web Dev With Services

For browser-based web development that still needs local Veslo services, run:

```bash
pnpm dev:web
```

This starts the Vite web UI plus the headless Veslo orchestrator/server flow via
`scripts/dev-headless-web.ts`. It is not a substitute for the authoritative
Tauri desktop runtime above, but it is different from `pnpm dev:ui`, which starts
only raw Vite.

## After Server-Side Changes

If changes touched `packages/server/src`, rebuild server binary before relying on orchestrator-backed flows:

```bash
pnpm --filter veslo-server build:bin
```

Then run the standard dev startup flow above.

## PATH / Tooling Fallback

If shell PATH in automation sessions cannot find `pnpm`/`cargo`, use an explicit PATH prefix:

```bash
PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" /opt/homebrew/bin/pnpm dev
```

Use the same PATH prefix for the rebuild commands when needed.

## Interpretation Rule For Agents

When asked to "start" the app for development in this repo, always execute this fresh-build startup flow. Do not skip rebuild and do not launch stale prebuilt binaries as the startup path.

If the same session previously started Veslo in dev mode, stop that instance before launching tests. If an existing Veslo process cannot be identified as an internally started dev/test runtime from this repo, report it and ask for direction instead of force-killing it.
