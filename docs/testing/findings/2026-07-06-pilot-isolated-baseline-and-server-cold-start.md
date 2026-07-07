# Pilot scenario isolated baseline + local server cold-start evidence — 2026-07-06

Follow-up to `2026-07-06-full-test-sweep-failure-handoff.md`. This documents the
isolated (one-at-a-time) rerun of the 16 previously failing Tauri Pilot desktop
scenarios and the root-cause evidence gathered while doing it.

Per request, no Veslo server / app-runtime fixes were implemented here — the
local-server findings below are a handoff for the colleague already working on
those fixes. Only test-harness and scenario-file fixes were made (branch
`codex/pilot-scenarios`, worktree `Veslo-pilot-fixes`).

## Method

- Clean git worktree at `12924db70` (no uncommitted WIP baked in).
- Debug desktop build. Important gotcha: the build MUST use
  `--config src-tauri/tauri.e2e.conf.json -- --features e2e`. Building with
  `tauri.dev.conf.json` (as one older playbook block still suggests) produces an
  app without the `pilot:default` capability: the pilot socket never opens and
  every scenario dies with `Cannot connect to socket … tauri-pilot ping`.
- Scenarios executed strictly one at a time with a hard inter-scenario process
  barrier (no `Veslo-pilot-fixes` processes may survive between runs).
- `smoke` used as a harness canary before the failing set (passed, 2 s).

## Per-scenario verdicts (isolated, cold profile)

Passed in isolation — sweep failures were environmental, scenarios are valid:

- `loopback-request-broker-idle` (25 s; passed twice)
- `composer-draft-workspace-move` (11 s) — the suspected P1 "draft leaks across
  workspace move" did NOT reproduce
- `vslo-270-stop-reload-reconnect` (67 s) — NOT legacy; maps to current UI
  (`session-reload-banner`/`session-reload-action`) and passes

Failed with the tauri-pilot 10 s eval cap (test-side defect, scenario refactor
in progress on `codex/pilot-scenarios`):

- `vslo-235-local-host-no-workspace` — single 90 s polling eval; also blocked
  by the server cold-start issue below
- `startup-sidebar-existing-sessions` — step 4 bootstrap eval `eval timed out after 10s`
- `message-send-registry-degraded` — kick-off eval shape not auto-wrappable +
  cap; fails in ~12 s before doing anything
- `sidebar-session-retention` — seed eval reported `eval timed out after 182s`
  (long-eval pattern; same family)
- `google-mcp-connectors` — in-eval 15 s waits for catalog cards; note the
  equivalent `sharepoint-mcp-connectors.toml` was already converted to native
  `wait` steps in `12924db70` — google needs the same conversion

Failed on the local server cold-start cascade (product-side, for the colleague;
details below):

- `skills-enabled-state` (workspace-scope skill rows never enabled)
- `soul-dashboard` (source summaries never idle)
- `soul-den-local` (page never reaches ready marker)
- `automations` (page shows "Local Veslo server unavailable" for the entire run)
- `model-stream-retry-no-progress` (send path dead; no progress marker ever)

Superseded:

- `sidebar-context-menu` TOML no longer exists — replaced by
  `specs/sidebar-context-menu.pilot.ts` (run via `test:pilot:sidebar-context-menu`).

(Verdicts for `global-unpublished-draft` and `pending-session-instance-isolation`
in the addendum at the end of this file.)

## Root cause 1 — e2e teardown leaks sidecars (fixed, test harness)

`packages/e2e/helpers/app-launcher.ts` `stopApp()` only reaped child processes
on Windows (`stopManagedChildProcessesForParent` early-returns on non-win32).
On macOS the orchestrator (`daemon run`, re-parented), veslo-server, veslo-code
and router keep running after teardown resolves. The next scenario's app
instance then (a) SIGTERMs the orphans at startup and (b) can defer to the
lingering instance via `tauri-plugin-single-instance` and exit 0 immediately —
observed as `[e2e] App process exited with code 0` followed by a 120 s pilot
socket timeout. This alone explains a large share of the broad-sweep carnage
(each scenario poisoned its successor).

Fix on `codex/pilot-scenarios`: POSIX descendant snapshot + TERM/KILL escalation
+ a safety sweep keyed to the launched binary's absolute directory (never by
process name, so user-installed production Veslo is untouchable).

## Root cause 2 — tauri-pilot 0.7.2 caps every `eval` at 10 s (test-side)

Pinned plugin rev `a6c5baa` dispatches `"eval"` with `DEFAULT_TIMEOUT` (10 s);
step-level `timeout_ms` is NOT honored for eval (only `wait`/`watch` honor long
timeouts since the #91 fix). Any scenario step that polls inside one eval for
longer than ~8 s fails with `RPC error (-32603): Eval error: eval timed out after 10s`.
This also explains the sweep's `core-platform-skills` failure signature.

Required scenario pattern (already used by the healthy scenarios and by the
`sharepoint-mcp-connectors` conversion): short kick-off eval installs an async
task + DOM marker nodes → `action = "wait"` on the marker with a long
`timeout_ms` → short collect/assert eval.

## Root cause 3 — local server cold-start restart storm + availability latch (FOR THE COLLEAGUE)

Observed on every cold-profile boot in E2E (isolated app profile, first run):

1. Boot warmup calls
   `syncWorkspaceSkillMaterializationBeforeRuntime` up to 6 times with 500 ms
   gaps (`packages/app/src/app/context/workspace-runtime-controller.ts`,
   `skillSyncMaxAttempts = isBootWarmup ? 6 : 1`, ~line 345).
2. Each attempt first awaits `ensureLocalVesloServerRunning()`
   (`packages/app/src/app/context/veslo-server-connection.ts`, ~line 523). That
   function loads host info, health-checks ONCE, and if not ready calls
   `restartVesloServer()` (Tauri `veslo_server_restart`) — which kills and
   respawns the server that was still starting — then health-checks ONCE again.
3. Result: a restart storm. Telemetry from a failing run
   (`workspace.requests:startup-summary`): `veslo_server_restart` invoked 7×,
   `/health` 13×, `/capabilities` 11× — all within the first ~4.5 s — then ALL
   traffic to the local server stops for the rest of the 30 s window.
4. The warmup loop exhausts its ~3 s budget while the server needs ~4.5 s, so
   `skillsReady=false` (trace:
   `ensure-engine:skills-ready … "skillsReady":false,"reason":"boot-warmup","attempt":6,"maxAttempts":6`)
   and the controller dispatches a workspace lifecycle `failed`.
5. Nothing re-probes afterwards: the UI latches "unavailable". The final server
   process IS healthy seconds later (its own log: `[veslo-server] reconciled 2 workspace(s)`),
   but the Automations page shows "Local Veslo server unavailable. Start or
   reload Veslo to manage automations." for the entire 240 s scenario, Skills
   workspace rows never enable, Soul never reaches ready, and prompt sends
   (model-stream-retry scenario) never start.

Suggested fix direction (not implemented, per instruction):

- In `ensureLocalVesloServerRunning`: after triggering one restart, poll
  readiness (500 ms steps, ~10 s budget) instead of a single immediate check;
  add a restart cooldown so repeated ensure calls converge on one restart plus
  patient polling instead of serial kills.
- In the boot-warmup loop: deadline-based budget (~15 s) instead of 6×500 ms,
  and treat "server still starting" as retry/defer — do not dispatch lifecycle
  `failed` for a server that has not finished starting; keep `failed` for real
  materialization errors.
- Unit-test seams already exist (`veslo-server-connection.test.ts`,
  `workspace-engine-warmup.test.ts`).

## Coordination notes

- Two checkouts must not run desktop E2E at the same time: both use the
  `com.neatech.veslo.e2e` identifier; the second launch exits via
  single-instance and its orphan cleanup kills the other checkout's sidecars.
  Check `pgrep -f "<other-checkout>/packages/desktop/src-tauri/target/debug"`
  before launching, and wait rather than kill.
- The playbook's "internal end-to-end testing" block still shows a
  `tauri.dev.conf.json` build for pilot runs; only the `tauri.e2e.conf.json`
  build carries the pilot capability (see gotcha above). Worth a docs touch-up
  after the current e2e work settles.

## Addendum — final baseline verdicts and test-side verification

Remaining baseline results:

- `global-unpublished-draft` — task starts, send-dependent work never completes
  (420 s cap): server cold-start cascade family.
- `pending-session-instance-isolation` — task fails at stage
  `waiting-ai-access`: "AI access endpoint did not become ready. Latest=null".
  The isolation behavior itself was never exercised. Cascade family.
- `specs/sidebar-context-menu.pilot.ts` (replacement for the retired TOML) —
  fails with `[pilot-e2e] server_info eval error`; same eval/server-readiness
  family, in the freshly migrated spec.

Test-side fixes verified against the real app (branch `codex/pilot-scenarios`):

- Launcher teardown reap: two back-to-back `smoke` runs green with
  `lingering-after-teardown=0` after each run (previously sidecars survived
  >20 s and needed an external force kill).
- All four refactored scenarios now get PAST the 10 s eval cap; their
  remaining failures are substantive and produce structured diagnostics:
  - `vslo-235-local-host-no-workspace`: server now reports `workspaceCount: 1`
    with the auto-registered `scratch` workspace
    (`…/app-local-data/scratch`, `runtimeChain.status: shared_engine_unhealthy`).
    This is handoff Open Question 1 made concrete — the runtime deliberately
    registers a scratch workspace; the scenario encodes zero-workspace. Needs a
    product decision, then either the scenario or the autostart changes.
  - `message-send-registry-degraded`: kick-off step fixed (previously died in
    ~12 s); task runs its full internal budget and stalls on the dead send
    path (cascade).
  - `startup-sidebar-existing-sessions`: bootstrap check runs fully; seeded
    inactive workspaces do not appear in `workspace_bootstrap` — workspace
    registration/bootstrap area (currently being reworked).
  - `google-mcp-connectors`: with a native 60 s wait the Gmail catalog card
    still never renders. The app calls the fixture's `/v1/me` (2×) but never
    requests `/v1/orgs/:orgId/mcp/catalog` — the connector workflow stalls
    before the catalog stage. This is in the actively-changed MCP connection
    workflow area and is the one confirmed app-side defect outside the server
    cold-start cascade.
