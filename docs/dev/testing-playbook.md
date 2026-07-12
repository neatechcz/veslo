# Testing Playbook

This file describes the practical verification flow for coding work in Veslo.

## First Rule

Do not use `packages/web` or UI-only web servers as the runtime under test. Do not start `pnpm -w dev:ui`, `pnpm --filter @neatech/veslo-ui dev`, or raw Vite as the app runtime. Veslo's authoritative application runtime is the Tauri desktop app in `packages/desktop`.

When creating tests, always prefer E2E tests. Add lower-level tests only when an E2E test cannot cover the behavior reliably or when they provide useful support around a primary E2E path.

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

The `tauri-pilot` launcher waits for the Tauri process it started to exit during teardown and escalates to a force kill if the process ignores the graceful stop signal. This harness cleanup does not replace the preflight above; clear matching Veslo dev/test processes before each desktop runtime launch.

WebdriverIO is no longer part of the Veslo desktop E2E surface. Desktop E2E coverage lives in `packages/e2e/pilot-scenarios` or focused `*.pilot.ts` scripts, and the default `packages/e2e` `test` script runs the Tauri Pilot `current-gate` suite.

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

For internal end-to-end testing, follow the repo rule from `AGENTS.md`:

```bash
# First run the Desktop Test Runtime Preflight above.

cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test
```

`tauri-pilot` is the desktop test driver. Debug desktop builds include `tauri-plugin-pilot`; the `e2e` Cargo feature enables its `press` support, and `packages/e2e` launches the debug Tauri binary with a deterministic `TAURI_PILOT_SOCKET`. The desktop plugin is pinned to the upstream `tauri-pilot` 0.7.2 revision that routes macOS eval results through the Pilot IPC callback.

The E2E launcher uses an isolated app profile under `packages/e2e/.tmp-veslo-home` by default so local desktop state does not leak into tests. Set `E2E_USE_EXISTING_PROFILE=1` only when a test explicitly needs the current user profile.

For live Den auth, Tauri Pilot accepts the same production desktop snapshot input as the app:

```bash
VESLO_DEN_AUTH_SNAPSHOT_PATH="$HOME/.veslo/den-auth.json"
```

`VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE` remains available when a test needs an E2E-only snapshot path.

For core platform skill materialization coverage, build with the pilot-enabled E2E config and run the targeted pilot script:

Prerequisite: the `tauri-pilot` CLI must be on `PATH`. If it is installed elsewhere, set `E2E_TAURI_PILOT_BIN=/absolute/path/to/tauri-pilot`.

```bash
cargo install tauri-pilot-cli --version 0.7.2 --locked
```

```bash
# First run the Desktop Test Runtime Preflight above.

pnpm --filter veslo-server build:bin
VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar

cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e

cd ../e2e
pnpm test:pilot:core-platform-skills
```

For the verified skill publish request flow, use the same pilot-enabled desktop
build and run:

```bash
# First run the Desktop Test Runtime Preflight above.

cd packages/e2e
pnpm test:pilot:skill-publish
```

This scenario lives in `packages/e2e/specs/skill-publish-request.pilot.ts`. It
drives the Skills page bulk Publish button, opens the review dialog in request
mode, submits an organization publish request, and verifies the registry fixture
recorded `POST /v1/skills`, `POST /v1/skills/:skillId/versions`, and
`POST /v1/skills/:skillId/review-requests`. The fixture mutation endpoints are
implemented by the E2E skill registry fixture so the desktop app exercises the
real Tauri runtime and local server proxy without depending on a live registry.

The pilot config uses the isolated `com.neatech.veslo.e2e` app identifier and enables `pilot:default` only for the E2E build. Do not add pilot permissions to the default desktop capability.

Focused pilot scenarios can be run from `packages/e2e`:

```bash
pnpm test:pilot:skill-publish
pnpm test:pilot:smoke
pnpm test:pilot:navigation
pnpm test:pilot:google-mcp
pnpm test:pilot -- --suite current-gate
pnpm test:pilot -- --scenario sidebar-session-retention
pnpm test:pilot -- --scenario <name-or-path>
```

`test:pilot:google-mcp` runs the converted Google Workspace MCP connector
scenario with the local Den-compatible fixture enabled. It verifies separate
Gmail, Calendar, and Drive catalog cards plus Gmail-only install behavior
without completing Google OAuth.

The E2E launcher uses an isolated app profile under `packages/e2e/.tmp-veslo-home` by default so local desktop state does not leak into tests. It also assigns an isolated local Veslo server port so a user-launched production app on `8787` does not block desktop tests; set `E2E_VESLO_SERVER_PORT` only when a focused test needs a stable port. Set `E2E_USE_EXISTING_PROFILE=1` only when a test explicitly needs the current user profile.

The previous Windows sidecar runtime probe and visual snapshot flow were removed with the WebdriverIO suite. Use focused Tauri Pilot scenarios for those validations.

### Tauri Pilot live desktop testing

Tauri Pilot is available in Veslo E2E/debug automation builds. The repo carries the Rust plugin dependency in `packages/desktop/src-tauri/Cargo.toml`, registers it in `packages/desktop/src-tauri/src/lib.rs` under debug/E2E gates, and grants `pilot:default` only through the E2E Tauri config. Keep pilot permissions out of the default desktop capability. It is the desktop E2E driver for the real Tauri app, not a release-runtime feature.

Use Tauri Pilot when the behavior under test depends on the running desktop shell, the system WebView, sidecar startup, native dialogs, workspace activation, or real app state that a browser-only test cannot represent. It is especially useful for exploratory regression checks, timing probes, reproducing UI bugs with the user's current profile, and validating that the real desktop UI reaches the expected state after a fix.

Tauri Pilot can support these live-testing actions:

- discover and target real Tauri windows
- capture accessibility snapshots of the current UI
- click, fill, and assert against snapshot refs such as `@e3`
- diff UI snapshots after an interaction
- inspect frontend logs and network activity when the MCP tools are available
- run JavaScript in the live WebView for DOM checks, app-state probes, and `performance.now()` timing
- exercise Tauri IPC through the Pilot MCP surface when that is the narrowest useful probe

Keep the test anchored in user-visible behavior first. Use JavaScript eval or IPC only to observe state, gather timings, or isolate a lower-level failure after the normal UI path is understood.

For Windows desktop behavior, run the Desktop Test Runtime Preflight first, start the app with the Windows-native toolchain from the repo root, and use the Windows Tauri Pilot executable:

```bash
pnpm dev

# Use the exact socket printed by pnpm dev as:
# [veslo:dev-runtime] pilotPing=...
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe --socket '\\.\pipe\tauri-pilot-com.neatech.veslo.dev' ping
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe --socket '\\.\pipe\tauri-pilot-com.neatech.veslo.dev' --window main snapshot -i
```

For complex interactions or timing probes, run JavaScript through stdin:

```bash
/mnt/c/Users/jajse/.cargo/bin/tauri-pilot.exe --window main eval - <<'EOF'
performance.now()
EOF
```

Recommended live loop:

1. take an initial interactive snapshot and identify stable refs
2. drive one user action through Pilot
3. take a fresh snapshot or diff
4. assert the visible outcome and inspect logs if the UI did not reach the expected state
5. repeat with small steps so the failing transition is identifiable

When validating workspace opening, workspace-to-server binding, or the first message path, do not replace Tauri Pilot with the local `opencode` CLI. The test must exercise Veslo's configured project runtime, local Veslo server write API, orchestrator-mounted OpenCode endpoint, and selected project model.

For a workspace-to-first-message latency check, measure these checkpoints separately:

1. workspace create/open until the app has the active workspace and engine binding
2. first message submit until the run is accepted by the server/OpenCode write path
3. first assistant content or terminal error visible in the desktop UI

For a three-message pass, use one fresh workspace, send three short prompts, and record each result separately. Label the first send as `cold run`; do not average it together with runs 2 and 3. Record the workspace id, workspace path, runtime, model/provider/variant, exact prompt text, exact Tauri Pilot command or script path, and any frontend/server error text.

If a send fails before model streaming with errors such as `OpenCode base URL is missing`, `Conversation directory is outside this workspace`, or `OpenCode request timed out`, classify the result as workspace/server/OpenCode binding failure rather than model latency. Fix that binding path before moving down to lower-level function timing.

See `docs/testing/tauri-pilot/README.md` for the current Tauri Pilot workflow
and AI gateway/E2E debugging notes. `docs/sandbox/tauri-pilot.md` is historical
scenario material.

### Live feedback-to-YouTrack smoke

Use this only when a real feedback report and a real YouTrack issue are acceptable. This is not a CI gate.

The live smoke uses Tauri Pilot to open the real desktop feedback UI. Keep it opt-in because it can create a real feedback report and a real YouTrack issue.

Requirements:

- run the Desktop Test Runtime Preflight first
- build the E2E desktop binary with `pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e`
- use a signed-in Den desktop profile with `E2E_USE_EXISTING_PROFILE=1`, or provide `E2E_DEN_AUTH_JSON`
- set `E2E_YOUTRACK_URL` and `E2E_YOUTRACK_TOKEN`
- set `E2E_YOUTRACK_PROJECT_KEY` if the target project differs from `VSLO`

When `E2E_DEN_AUTH_JSON` is provided, the live spec treats it as authoritative and does not replace loopback Den auth from the desktop snapshot. This allows a Coding Agent run to point the real desktop UI at a locally started Den instance whose projector uses the configured YouTrack REST API.

Run `pnpm --filter @neatech/veslo-e2e test:pilot:feedback-youtrack-live` for the Pilot version of this flow.

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

This is still not a replacement for the Tauri + `tauri-pilot` runtime gate when the user asked to test the real app.

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
