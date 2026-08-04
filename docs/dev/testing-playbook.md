# Testing Playbook

This file describes the practical verification flow for coding work in Veslo.

## First Rule

Do not use `packages/web` or UI-only web servers as the runtime under test. Do not start `pnpm -w dev:ui`, `pnpm --filter @neatech/veslo-ui dev`, or raw Vite as the app runtime. Veslo's authoritative application runtime is the Tauri desktop app in `packages/desktop`.

When creating tests, always prefer E2E tests. Add lower-level tests only when an E2E test cannot cover the behavior reliably or when they provide useful support around a primary E2E path.

## Headless Shared-Engine Runtime Oracle

The one-workspace/many-conversations contract has a deterministic, non-desktop
runtime gate. Use it when changing workspace engine ownership, lifecycle
identity, queue admission, or generation recovery:

```bash
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build
node packages/orchestrator/scripts/workspace-one-engine-many-conversations.integration.mjs
```

The oracle must run against the freshly compiled server binary and records a
JSON artifact under `.tmp/runtime-oracle/`. A passing artifact contains ten
distinct conversation/session/run identities on one workspace engine slot,
workspace-wide owner identity, independent abort behavior, and a new owner
generation after engine loss. This gate is intentionally headless and does not
depend on a desktop test driver.

For the full service-chain proof, including the real compiled Veslo server,
compiled orchestrator, shipped OpenCode sidecar, and HTTP callback path, run:

```bash
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build
node packages/orchestrator/scripts/veslo-server-orchestrator-opencode.integration.mjs
```

This scenario starts an isolated loopback deterministic provider and then
drives the real server API without the UI. It creates ten conversations,
submits concurrent runs, observes one attached engine generation, exercises
queue admission and abort isolation, kills the actual OpenCode child, verifies
engine-loss reconciliation and replacement generation, and submits a recovery
run through the replacement. It also checks the authenticated and malformed
engine-loss HTTP contracts. It writes a redacted JSON artifact and service logs
under `.tmp/runtime-oracle/`. The scenario uses `VESLO_DISABLE_SANDBOX=1` for
the ephemeral local process; sandbox isolation remains a separate deployment
verification concern.

For the shipped OpenCode compatibility contract, run the bundled binary gates
separately:

```bash
node packages/orchestrator/scripts/opencode-workspace-concurrency.integration.mjs
node packages/orchestrator/scripts/opencode-directory-scoped-skills.integration.mjs
node packages/orchestrator/scripts/opencode-directory-scoped-runtime.integration.mjs
node packages/orchestrator/scripts/opencode-directory-scoped-scaling.integration.mjs
```

These gates create ten sessions, submit ten concurrent `prompt_async` requests
through a local deterministic provider, verify session reads and event-stream
availability, restart the same OpenCode process with the same state/config
roots, and confirm that all ten session IDs remain addressable. The skill gate
also fingerprints directory isolation, policy closure, and explicit
 directory-scoped disposal. It is capability evidence only: the production
 topology stays pooled until Veslo admission/epoch, event routing, placement,
 and Tauri acceptance are also proven. The separate experimental
 `VESLO_SHARED_OPENCODE_DIRECTORY_SCOPED=1` opt-in is for this verification
 path, not a substitute for those acceptance gates. Neither command launches
 Tauri Pilot.

The runtime oracle additionally exercises the Veslo-owned directory lifecycle:
two workspace roots share one process generation, a same-name skill remains
directory-scoped, and two proxied `/event` streams receive only their own new
session event with the matching Veslo binding. An active A run defers an A
refresh with retryable `409`; after A is terminal the directory lifecycle
disposes/reloads only A while the PID and B view stay unchanged; completion is
retried internally and does not depend on a later proxy request. It also proves
that placement is pinned for an admitted workspace after a project-config edit,
while a newly admitted incompatible workspace receives a pooled process.

The scaling oracle characterizes one shared process at 2, 5, and 10 workspace
directory instances. Its JSON artifact records startup/hydration latency,
process count, directory-instance count, process memory/CPU snapshot where the
host exposes it, idle residency, and an A refresh while B retains an active
run. It is a measurement gate, not a production capacity promise.

The former desktop handoff lane used Tauri Pilot. It is legacy coverage and
must not be run or extended; use a focused WebDriverIO scenario for new desktop
handoff proof.

## Desktop Test Runtime Preflight

Veslo desktop is single-tenant in development. Before any test that launches or depends on the desktop runtime, the agent must ensure it is not starting a second app instance.

This is an LLM/operator responsibility, not a step to duplicate inside individual specs.

1. Detect running Veslo dev/test processes from this repo:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

2. If the matches are internally started dev/test runtime processes from this repo, stop them before launching the test runtime:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

3. Verify the post-check is empty before continuing:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If a match looks like a user-launched production/bundled app or otherwise cannot be identified as an internally started dev/test runtime, stop and report what is running instead of force-killing it.

### Convenience script

`scripts/veslo-kill-zombies.sh` automates steps 1–3 above for the sidecar set (veslo-server, veslo-orchestrator, veslo-code-router, veslo-code). It preserves the currently-running `pnpm dev` process group by default and only terminates orphans from earlier sessions:

```bash
./scripts/veslo-kill-zombies.sh           # dry run (default)
./scripts/veslo-kill-zombies.sh --kill    # actually terminate orphans
./scripts/veslo-kill-zombies.sh --all     # terminate everything, including the live dev session
```

In debug builds (`pnpm dev`), Veslo also runs an equivalent best-effort cleanup at startup — orphan sidecars whose process group differs from the booting Tauri process are SIGTERM'd before the new sidecars spawn. Release builds do not run this cleanup so a shipped Veslo never kills unrelated processes.

WebDriverIO scenarios close only the driver session for an attached runtime, or the process tree they explicitly own. This cleanup does not replace the preflight above; clear matching Veslo dev/test processes before each desktop runtime launch.

WebDriverIO is the Veslo desktop E2E surface. Scenarios live in `packages/desktop-webdriver` and drive visible controls in the real Tauri runtime. Tauri Pilot scenarios under `packages/e2e` are legacy and must not be used for new validation.

### Focused VSLO-281 attachment gate

The MSG regression uses the real Tauri app, compiled Veslo server, actual
Composer file input, and deterministic OpenCode/lifecycle fixture. It covers an
unsupported MSG as both the first message of a new chat and in an existing
chat, verifies that no Veslo conversation, OpenCode prompt, or run is admitted,
and then proves a visible text-only recovery response in the same chat.

The former automated scenario for this regression used Tauri Pilot and is
legacy. New coverage must use a focused WebDriverIO scenario.

## Fast Checks by Surface

### App-only documentation or copy changes

Run from repo root:

```bash
pnpm typecheck
```

If you touched app logic or page composition, also run the most relevant UI checks from `packages/app/package.json`.

### Solid app changes in `packages/app`

Start with:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Then run focused script tests relevant to the changed area, for example:

- `pnpm --filter @neatech/veslo-ui test:cloud-onboarding`
- `pnpm --filter @neatech/veslo-ui test:desktop-auth-onboarding`
- `pnpm --filter @neatech/veslo-ui test:session-switch`
- `pnpm --filter @neatech/veslo-ui test:fs-engine`
- `pnpm --filter @neatech/veslo-ui test:browser-entry`
- `pnpm --filter @neatech/veslo-ui test:renderer-recovery`

### AI Gateway provider transport changes

Run the gateway tests and build from the repo root. When changing the
OpenAI-compatible discovery transport, also run its compiled smoke under the
production Node.js major version:

```bash
pnpm --dir services/ai-gateway test
pnpm --dir services/ai-gateway build
docker run --rm -v "$PWD:/workspace" -w /workspace/services/ai-gateway node:22-bookworm-slim node test/node22-openai-compatible-smoke.mjs
```

The Node 22 smoke starts an explicit loopback-only model endpoint and exercises
the default discovery fetch plus its pinned dispatcher. It must not inject a
fake fetch or bypass the transport's default connection path.

### Desktop runtime or native command changes

Use the real desktop runtime:

```bash
pnpm dev
```

For internal end-to-end testing, start the real desktop runtime with the
loopback-only WebDriver endpoint, then run a focused scenario with explicit
workspace and mutation inputs:

```powershell
# First run the Desktop Test Runtime Preflight above.
pnpm dev:webdriver

# From a second terminal, use the runtime-info.json printed at startup.
$env:WEBDRIVER_ALLOW_MUTATION = "1"
pnpm test:webdriver:same-conversation-queue-roundtrip -- <runtime-info.json> `
  --workspace "Disposable workspace" `
  --first-message "Reply with exactly: first" `
  --second-message "Reply with exactly: second" `
  --event-stream-gate true
```

The optional event-stream gate is available only when the desktop runtime has
E2E fault injection enabled and the workspace uses pooled-per-workspace engine
topology. It disconnects and holds only the app-facing workspace event stream;
the pooled engine, queue drain, admitted run, and submit path remain live. The
scenario releases the gate only after the exact queued item is claimed and its
client message is admitted, then verifies that the same engine owner and
generation reconnect. Its MutationObserver artifact contains row roles,
identities, parents, placeholder kinds, and queue ownership, but no prompt or
answer content.

A deliberate gate disconnect is test-fault evidence only. It must not be used
to infer that a production admission intentionally replaces its event stream.
Run ordering diagnostics after the workspace skill view has stabilized; a
fresh runtime can legitimately replace an initial empty-view engine during
skill discovery, and the scenario rejects that unrelated generation change.

For historical-conversation projection and continuation, create a seed chat,
an intervening chat, then reopen the seed through the visible sidebar:

```powershell
$env:WEBDRIVER_ALLOW_MUTATION = "1"
pnpm test:webdriver:historical-conversation-roundtrip -- <runtime-info.json> `
  --workspace "Disposable workspace" `
  --seed-message "Reply with exactly: historical seed" `
  --interlude-message "Reply with exactly: intervening chat" `
  --continuation-message "Reply with exactly: historical continuation"

# Verify the same scenario's server-side causal path without sending another request.
pnpm test:webdriver:historical-conversation-trace-verify -- `
  .tmp/webdriver-scenarios/<historical-scenario-artifact>.json
```

For the stronger preserved-state regression, the owned scenario starts a
desktop, creates both conversations, stops only that owned runtime, then starts
a new desktop against the same development profile before continuing the first
conversation. It has the same direct-admission causal proof:

```powershell
$env:WEBDRIVER_ALLOW_MUTATION = "1"
pnpm test:webdriver:historical-conversation-restart-owned -- `
  --workspace "Disposable workspace" `
  --seed-message "Reply with exactly: historical restart seed" `
  --interlude-message "Reply with exactly: historical restart interlude" `
  --continuation-message "Reply with exactly: historical restart continuation"
```

The scenario fails if the reopened chat displays the intervening user's
transcript, or if its continuation ends with a visible app or assistant error.
The read-only verifier derives the continuation's durable scope from the
server trace and requires one direct admission, one successful OpenCode submit,
and terminal readiness. It writes a redacted local companion summary, records
unrelated workspace failures separately, and fails closed if the trace cannot
prove the exact operation.

To audit an already persisted conversation, first select its visible sidebar
row through the desktop UI and use its visible `data-session-id` with an
explicit workspace. The scenario proves that an existing transcript rendered
before it sends the continuation; it does not create a second local queue.

```powershell
$env:WEBDRIVER_ALLOW_MUTATION = "1"
pnpm test:webdriver:historical-existing-continuation -- <runtime-info.json> `
  --workspace "Disposable workspace" `
  --session-id "<visible-sidebar-session-id>" `
  --continuation-message "Reply with exactly: historical existing continuation"
```

WebDriverIO is the desktop test driver. It uses an explicit loopback endpoint
and records redacted per-scenario evidence under `.tmp/webdriver-scenarios/`.
Use disposable workspaces for every mutating scenario.

### Focused local-host recovery gate

For a server-child lifecycle or recovery change, follow the Desktop Test Runtime
Preflight and run a focused WebDriverIO recovery scenario against the emitted
`runtime-info.json`. The former `pnpm check:desktop-recovery` command depends
on legacy Tauri Pilot coverage and must not be used.

`pnpm check:desktop-recovery` currently invokes legacy Tauri Pilot tooling and
must not be used. Add a focused owned WebDriverIO recovery scenario before
claiming desktop recovery coverage; meanwhile use the headless lifecycle and
workspace-engine gates for recovery changes.

### Windows production-shaped packaged smoke

After the Desktop Test Runtime Preflight, run this Windows-only developer gate:

```bash
pnpm desktop:smoke-packaged
```

The command forces the UI and sidecar rebuild and builds the real desktop
binary with the normal Windows and release configuration. Its current legacy
Pilot overlay is not a supported validation mechanism; do not use it as desktop
E2E evidence until the lane is migrated to WebDriverIO.

The test owns a fresh desktop profile, waits for the redacted durable
`desktop-bootstrap-ready.json` marker, and uses a loopback-only
OpenAI-compatible fixture for the first workspace and first server-owned send.
It removes inherited `E2E_*`, `VESLO_*`, `VITE_*`, `OPENCODE_*`, provider, and
credential inputs before the build, then rejects direct scenario execution with
such overrides. The harness only terminates recognized Veslo sidecars descended
from its launched app process and verifies their exit.

This is not an MSI installer acceptance test. It is the fast production-shaped
desktop regression gate; clean install, upgrade, and second-start evidence
belongs to the installed-MSI VM gate.

### Windows installed-MSI VM gate

Run this only in an elevated, disposable Windows VM against one exact signed
MSI. It does not use a desktop test driver and does not rely on a
repository dev server, host Node, npm, Bun, or a pre-existing Veslo profile.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release/verify-windows-msi-installed.ps1 -Scenario clean -MsiPath <exact-signed-msi> -ReleaseTag <tag> -Commit <commit> -SummaryPath C:\VesloEvidence\clean.json
```

For the observation-only `updater` scenario, record an ISO-8601 UTC timestamp
immediately before initiating the real in-app update and pass it as
`-UpdaterLogNotBeforeUtc <timestamp>`. This rejects an old successful updater
log from a previous transaction.

The JSON output contains the tag/commit, MSI SHA-256, Windows build, WebView2
and WSL state, installed `versions.json`, Program Files process evidence,
authenticated runtime status, document-runtime status, and the redacted ready
diagnostic. The command keeps the verbose `msiexec` log beside the requested
summary. Before `/i`, it also rejects a candidate MSI whose extracted payload or
`CustomAction` table mentions WSL/`VesloSandbox`; this candidate-only check does
not retroactively reject the historical baseline in an upgrade test. It is a
failure for `msiexec` to return zero without the ready signal.

Run each scenario from a suitable VM snapshot:

| Scenario | Required additional input | What it proves |
| --- | --- | --- |
| `clean` | fresh Windows user and no host Node/npm/Bun | first install and first owned startup |
| `clean-no-wsl` | clean image with WSL optional feature disabled | default local runtime does not depend on WSL |
| `upgrade` | `-BaselineMsiPath <26.6.26-msi>` | new Program Files payload replaces the old version |
| `normal-second-start` | none | a normal close leaves a second startup healthy |
| `forced-runtime-second-start` | none | a hard stop of the verifier-owned runtime reconciles on next start |
| `foreign-listener` | none | the app leaves an occupant of port 8787 alive and uses its safe branch |
| `updater` | run after a real in-app update | installed payload matches the target MSI and `C:\ProgramData\veslo-updater-msi.log` records the actual updater transaction |

`updater` never invokes `msiexec` itself, so it cannot forge updater evidence.
The harness only terminates desktop or listener process trees that it launched;
an existing Veslo process or port occupant causes a safe failure instead.

### Legacy Tauri Pilot coverage

The former Pilot scenarios for authentication, skills, navigation, managed-AI
policy, and recovery are retained only as historical implementation material.
They are not a test surface, must not be run, and must not receive new
scenarios. Port a behavior to `packages/desktop-webdriver` before using it as
desktop acceptance evidence. A WebDriverIO scenario must use the real Tauri
runtime, visible controls, explicit inputs for mutations, and a redacted
scenario artifact.

The retained session-queue durability Pilot fixture is also historical, not
acceptance evidence. It documents deterministic restart, queue hydration,
single-dispatch, and durable-failure assertions that do not yet have an
equivalent owned WebDriverIO fixture lifecycle. Do not delete it on the basis
of the ordinary same-conversation queue scenario alone. Its replacement must
first give the WebDriver runner ownership of the isolated Veslo server and
fake OpenCode lifecycle across server restarts; after that WebDriver scenario
passes, remove the Pilot scenario and its fixture together.

The macOS build requires every `externalBin` resource declared by the Tauri
config to exist. The documented `prepare:sidecar` command provisions the pinned
Node.js runtime from the official `nodejs.org` macOS archive for the resolved
Apple target triple, verifies the exact asset against the published
`SHASUMS256.txt`, rejects unsafe archive paths, extracts in a private temporary
directory, and atomically publishes executable base and target-suffixed copies.
Do not create an ad-hoc symlink or copy a sidecar from another checkout. Before
relying on a newly provisioned runtime, verify the worktree's base and
target-suffixed executables both report the pinned version.

The former Google Workspace connector scenario is legacy Pilot coverage. Port
it to WebDriverIO before using it as desktop acceptance evidence.

The E2E launcher uses an isolated app profile under `packages/e2e/.tmp-veslo-home` by default so local desktop state does not leak into tests. It also assigns an isolated local Veslo server port so a user-launched production app on `8787` does not block desktop tests; set `E2E_VESLO_SERVER_PORT` only when a focused test needs a stable port. Set `E2E_USE_EXISTING_PROFILE=1` only when a test explicitly needs the current user profile.

### WebDriverIO live desktop testing

WebDriverIO is the supported driver for the real Tauri desktop app. Start the
development runtime with `pnpm dev:webdriver`, then attach a focused scenario
using the emitted `runtime-info.json`. Scenarios must act through visible
controls, require explicit workspace and mutation inputs, and retain a redacted
artifact under `.tmp/webdriver-scenarios/`.

Keep the test anchored in user-visible behavior first. Injected page code may
capture diagnostics or inspect timing only after the normal UI path is known;
it must not call Veslo conversation APIs or bypass a user interaction.

### E2E-only recovery fault controls

`VESLO_E2E_FAULT_INJECTION=1` is available only in a dedicated test runtime.
It enables narrow, loopback test controls; production and normal development
server processes do not register them.

- `POST /e2e/fail-next-lifecycle-mark-failed` on the local Veslo server accepts
  `{ "count": 1..10 }` and fails that many lifecycle `markFailed` writes before
  they reach the orchestrator. It is the deterministic control for durable
  terminalization and restart recovery.
- The shared-engine proxy fault control accepts an optional `count` and makes
  that many following shared-engine proxy requests fail. It is the
  deterministic control for one-outage SSE/runtime recovery. One outage may
  request one fresh runtime only; that budget resets only after the replacement
  stream delivers `server.connected` and completes its catch-up successfully.

Arm only the failure required by the scenario, assert its trace/run identity,
and let the scenario prove the visible convergence. Do not add the controls to
the default desktop capability or use them as a replacement for normal user
actions.

For Windows desktop behavior, run the Desktop Test Runtime Preflight first,
start `pnpm dev:webdriver`, and use the emitted `runtime-info.json` with a
focused WebDriverIO scenario. Do not replace the real desktop runtime with the
local `opencode` CLI. The scenario must exercise Veslo's configured project
runtime, local Veslo server write API, orchestrator-mounted OpenCode endpoint,
and selected project model.

For a workspace-to-first-message latency check, measure these checkpoints separately:

1. workspace create/open until the app has the active workspace and engine binding
2. first message submit until the run is accepted by the server/OpenCode write path
3. first assistant content or terminal error visible in the desktop UI

For a three-message pass, use one fresh workspace, send three short prompts,
and record each result separately. Label the first send as `cold run`; do not
average it together with runs 2 and 3. Record the workspace id, workspace path,
runtime, model/provider/variant, exact prompt text, exact WebDriverIO command
or scenario path, and any frontend/server error text.

If a send fails before model streaming with errors such as `OpenCode base URL is missing`, `Conversation directory is outside this workspace`, or `OpenCode request timed out`, classify the result as workspace/server/OpenCode binding failure rather than model latency. Fix that binding path before moving down to lower-level function timing.

The Tauri Pilot material is historical only. For the current desktop workflow,
use the WebDriverIO commands in `docs/dev/development-startup.md`.

### Feedback diagnostic verification

Feedback reports and their optional diagnostic attachments are stored in Den; current feedback persistence does not project to YouTrack. The legacy feedback-to-YouTrack smoke is not valid verification for this flow.

Use the focused app and native queue tests for implementation changes. For an opt-in signed-in desktop check, submit feedback with diagnostics attached, keep the modal and Veslo open until the attachment reaches a terminal state, then inspect the stored capture with the runbook in `docs/dev/feedback-diagnostics.md`.

### Server changes in `packages/server/src`

Run server tests if relevant, and rebuild the server binary used by orchestrator-driven flows:

```bash
pnpm --filter veslo-server build:bin
```

If app behavior depends on that server change, refresh the desktop sidecar with `VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar` and verify the app against the rebuilt binary.

### Orchestrator changes

Run the orchestrator-focused tests from the workspace root:

```bash
pnpm test:orchestrator
```

### Full app sanity

For a broad app-level check from the repo root:

```bash
pnpm test:e2e
```

This is still not a replacement for a focused WebDriverIO scenario when the
user asked to test the real app.

## High-Risk Flow Validation

For onboarding, sharing, runtime recovery, or other user-visible multi-step flows:

1. Start the Veslo dev stack if required.
2. Validate in the real desktop runtime.
3. If the task requires feature-complete flow validation, use Docker plus Chrome MCP per `AGENTS.md`.

If you cannot run Docker or Chrome MCP, report exactly what you verified instead.

## What to Record

In the final summary for implementation work, report:

- exact commands run
- whether they passed or failed
- any gaps you could not execute

## Anti-Patterns

- using `packages/web`, `pnpm -w dev:ui`, `@neatech/veslo-ui dev`, or raw Vite as proof that the app works
- claiming Tauri behavior based only on `vite` dev server checks
- changing `packages/server/src` without rebuilding the binary that orchestrator actually runs
- running only broad tests when a targeted script exists for the changed behavior
