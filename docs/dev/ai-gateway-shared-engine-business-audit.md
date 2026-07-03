# AI Gateway + Shared Engine Business Audit

Date: 2026-06-26
Scope: business logic only

## Context

This audit focuses on the business logic of the local desktop send workflow when
Managed AI Gateway is enabled and the product wants `shared unsandboxed engine`
to behave as the default runtime mode.

The business contract is simple:

1. The runtime mode visible in Settings must be the runtime mode used by Send.
2. A local prompt may start only when the OpenCode runtime can reach the AI
   Gateway URL written into its OpenCode config.
3. Runtime topology changes must be applied before the next prompt, or Send must
   block with a precise "runtime restart required / setup not ready" state.
4. Gateway config must be scoped to the runtime/workspace that will execute the
   prompt, not to a stale active workspace or stale server process.
5. Generic "send failed" should not hide a known runtime/gateway setup problem.

## Current Flow

Current desktop flow, simplified:

1. Settings reads and writes `sharedUnsandboxedEngine`.
2. Desktop spawns Veslo server and orchestrator with environment overrides.
3. App derives effective sandbox/runtime state from Veslo server capabilities,
   current engine info, and orchestrator engine snapshots.
4. Managed AI config sync writes provider routing into workspace
   `opencode.json[c]`.
5. Send readiness validates runtime health, validates Managed AI config, primes
   runtime gateway authorization, then creates/runs the conversation.
6. Veslo server expects a provider request to reach `/ai-gateway/...` shortly
   after `prompt_async` starts.

The recent WSL/AI Gateway fixes improved step 5: Send now recovers stale
runtime routes and validates that WSL runtimes do not receive loopback gateway
URLs. The remaining risks are higher-level business workflow risks around
runtime topology and workspace scoping.

## Problems

### 1. Shared engine default is not represented by one source of truth

Settings and runtime spawn do not currently consume exactly the same effective
preference.

Evidence:

- `packages/desktop/src-tauri/src/runtime_preferences.rs`
  - At audit time, `DesktopRuntimePreferences::default()` returned
    `shared_unsandboxed_engine: false`; current Windows/macOS desktop runtime
    config defaults this preference to `true`.
  - `read_runtime_preferences()` resolves persisted override or env fallback.
  - `read_shared_unsandboxed_engine_override()` returns only the persisted
    override.
- `packages/desktop/src-tauri/src/veslo_server/mod.rs`
  - Veslo server spawn reads `read_shared_unsandboxed_engine_override(app)`.
- `packages/desktop/src-tauri/src/commands/engine.rs`
  - orchestrator start also reads `read_shared_unsandboxed_engine_override(&app)`.

Business impact:

If the product changes the visible/default Settings state to shared engine but
spawn still treats a missing persisted override as "no override", a clean
install can display or assume one runtime mode while the actual server and
orchestrator start another mode. AI Gateway then calculates provider routing
from the wrong topology.

This is the same bug class as previous runtime issues: optimistic behavior on
unknown or split state.

### 2. Runtime preference changes are saved, but not applied atomically

The Settings toggle writes the preference and tells the user to restart the
local server.

Evidence:

- `packages/app/src/app/pages/settings.tsx`
  - `handleToggleSharedUnsandboxedEngine()` writes the preference.
  - The status says `Saved. Restart the local server to apply.`
  - The UI says `Restart local server to apply changes.`

Business impact:

This is acceptable for a devtools-only knob, but not for a default product
workflow. After the user changes runtime mode, the next prompt can still use a
healthy old runtime with old gateway topology. The app has enough information
to know that runtime topology changed; Send should not continue as if nothing
changed.

### 3. Inactive workspace Managed AI heal uses active workspace runtime state

The inactive workspace baseURL heal effect computes provider routing from
`resolveRuntimeSandboxStateForTarget()` without a target workspace, then patches
other workspaces.

Evidence:

- `packages/app/src/app/app.tsx`
  - inactive heal starts at the comment `VSLO-86: heal stale gateway baseURL`.
  - it calls `const runtimeSandboxState = resolveRuntimeSandboxStateForTarget();`
  - it then loops over `workspaceItems` and patches configs for inactive
    workspaces.

Business impact:

Gateway routing for workspace B can be derived from workspace A's runtime state.
That is incorrect when workspaces differ by runtime state, engine fallback, WSL
readiness, or topology transition. It can pre-write a gateway URL that is not
reachable from the runtime that will later execute workspace B.

The first Send in B may self-heal after runtime start, but the product should
not rely on a failed or blocked first Send to repair a background write.

### 4. Provider-start correlation falls back to workspace identity

Veslo server records active AI gateway runs by OpenCode session id and by
workspace id. The placeholder `${OPENCODE_SESSION_ID}` can be resolved through
the workspace id fallback.

Evidence:

- `packages/server/src/server.ts`
  - `activeAiGatewayRunsBySession`
  - `activeAiGatewayRunsByWorkspace`
  - `resolveActiveAiGatewayRunContext()`
  - `waitForAiGatewayProviderStart()`
- `packages/server/src/tests/server-conversations.test.ts`
  - test: `managed prompt provider-start watchdog matches placeholder session
    ids by workspace header`

Business impact:

This works for the common single active run case. It is weaker when multiple
managed AI prompt runs can overlap in the same workspace. Then a provider hit
can satisfy the wrong run's watchdog if the session placeholder is unresolved
and workspace fallback is the only correlation.

### 5. Runtime topology is not first-class in app-level AI Gateway decisions

The app derives Managed AI routing from sandbox capability, current engine
snapshot, and route host info. It does not treat runtime topology as one
explicit app-level value such as `pooled-per-workspace` vs
`shared-unsandboxed`.

Evidence:

- `packages/app/src/app/lib/runtime-sandbox-state.ts`
  - derives effective sandbox state from configured sandbox and child kind.
- `packages/app/src/app/app.tsx`
  - Managed AI config sync and Send validation consume that derived sandbox
    state.
- `packages/orchestrator/src/cli.ts`
  - orchestrator already has `engineTopology`, but the app-level Managed AI
    workflow mostly consumes sandbox state rather than a single runtime
    topology contract.

Business impact:

Shared engine is a runtime topology decision, not just a sandbox flag. AI
Gateway routing should consume the same runtime topology that actually decides
where OpenCode runs.

## Proposed Solution

### 1. Make runtime topology a single explicit business state

Create one desktop runtime preference resolver that returns:

```ts
type RuntimeTopologyPreference = {
  mode: "pooled-per-workspace" | "shared-unsandboxed";
  source: "persisted" | "environment" | "product-default";
  sandboxDisabled: boolean;
};
```

Rust equivalent can live next to `runtime_preferences.rs`.

Rules:

- Settings reads this effective value.
- Veslo server spawn reads this effective value.
- orchestrator spawn reads this effective value.
- Send readiness and Managed AI config sync receive this value or a derived
  status from host info/orchestrator status.
- Missing persisted preference must not mean "old default" in one layer and
  "new default" in another layer.

If shared engine becomes product default, the resolver should return
`shared-unsandboxed` on clean install, with source `product-default`.

### 2. Apply runtime topology changes before next Send

When the user changes runtime topology:

1. Persist the preference.
2. Stop/restart Veslo server and orchestrator using the new effective topology.
3. Release workspace routes.
4. Clear Managed AI config snapshots and inactive heal cache.
5. Re-read host info/capabilities.
6. Only then allow Send.

If automatic restart is not possible, Send must block with a precise error:

```text
Runtime mode changed. Restart local runtime before sending.
```

No prompt should continue through an old healthy runtime after the topology
preference changed.

### 3. Scope Managed AI config heal to each target workspace

Change inactive workspace heal from "use active runtime state for every
workspace" to one of these KISS options:

Preferred:

- Remove broad inactive patching.
- Patch Managed AI config during target workspace activation / send preflight,
  after the target runtime state is known.

Acceptable:

- Keep inactive heal, but calculate routing per workspace:
  - pass `{ workspaceId, workspaceRoot }` into
    `resolveRuntimeSandboxStateForTarget()`;
  - skip patching when target runtime state is unknown and bridge requirement
    cannot be proven;
  - never mark a workspace healed only because active workspace routing matched.

### 4. Make provider-start correlation run-scoped, not workspace-scoped

The provider request should carry or resolve a stable run/session correlation.
Workspace fallback can stay as diagnostics, but it should not be enough to
complete a specific provider-start watchdog when more than one run is active in
that workspace.

Options:

- Add an internal run id/header/token to the provider config/request path if
  OpenCode provider config supports it.
- Or keep workspace fallback only when there is exactly one active run for that
  workspace; otherwise wait for session-level correlation or fail with a clear
  diagnostic.

This prevents one request from satisfying the wrong run.

### 5. Expose runtime topology in diagnostics and config decisions

Every Managed AI routing trace should include:

- `runtimeTopology`
- `runtimeTopologySource`
- `configuredSandboxBackend`
- `effectiveSandboxBackend`
- `engineChildKind`
- `requiresEngineBridgeUrl`
- `localBaseUrl`
- `engineBaseUrl`
- `resolvedProviderBaseUrl`

This turns future failures into "wrong topology / wrong URL / missing bridge"
instead of generic "send failed".

## Regression Coverage

Add focused business-logic tests:

1. Clean install default:
   - no persisted runtime preference;
   - product default is shared;
   - Settings, Veslo server spawn, and orchestrator spawn all resolve
     `shared-unsandboxed`.

2. Runtime preference switch:
   - start in pooled WSL;
   - toggle shared;
   - next Send must not use old runtime route;
   - either restart completes and Send proceeds, or Send blocks with precise
     runtime restart error.

3. Managed AI inactive workspace heal:
   - workspace A active with one runtime state;
   - workspace B has different effective runtime state;
   - B config is not patched using A's routing.

4. Shared default Managed AI send:
   - clean desktop local workspace;
   - shared unsandboxed topology;
   - managed AI config uses local loopback Veslo server URL;
   - no WSL bridge URL is required;
   - prompt reaches provider route.

5. Provider-start correlation:
   - two active managed runs in one workspace;
   - unresolved `${OPENCODE_SESSION_ID}` plus workspace id must not satisfy the
     wrong run's watchdog.

## Definition of Done

- A clean install has one visible and executable runtime topology.
- Shared engine default does not require WSL bridge routing.
- Topology changes cannot leak into the next Send through stale runtime routes.
- Managed AI config writes are scoped to the workspace/runtime that will execute
  the prompt.
- Provider-start watchdog cannot be satisfied by an unrelated run in the same
  workspace.
- User-facing failures name the failing layer: runtime mode, gateway routing,
  gateway authorization, or provider start correlation.

---

# Code-Grounded Deep Audit (2026-06-26)

This section adds a code-grounded pass with concrete `file:line` evidence,
triggered by a real production failure during skill creation. It confirms,
sharpens, or extends the problems above and records one new high-severity issue.

## A. Reported production failure: `gateway_session_unresolved` (CONFIRMED)

Observed during skill creation:

```text
API error (400) gateway_session_unresolved
"Gateway session id placeholder could not be resolved"
details: { provider: "codex_oauth", incomingSessionId: "${OPENCODE_SESSION_ID}",
           workspaceId: "ws-e03db64eba58" }
```

### Failure chain (with evidence)

1. The provider config tells OpenCode to send
   `x-veslo-session-id: ${OPENCODE_SESSION_ID}` as a header template.
   - `packages/app/src/app/lib/opencode.ts:412` (`applyGatewayProviderRouting`)
2. OpenCode is expected to substitute `${OPENCODE_SESSION_ID}` with the real
   session id at request time. During skill creation (the `skill-creator` agent,
   `packages/app/src/app/data/skill-creator.md`) the model call runs in a context
   where OpenCode does **not** substitute it, so the literal placeholder reaches
   the gateway.
3. Every local provider completion route requires a resolvable session id:
   - `packages/server/src/server.ts:6158,6169,6180,6191` (`requireSessionId: true`
     for `codex_oauth`, `openai`, `anthropic`, `openai_compatible`).
4. The placeholder normalizes to empty, then the server falls back to an active
   run resolved by session id, then by workspace id:
   - `normalizeAiGatewaySessionId` returns `""` for the placeholder —
     `packages/server/src/server.ts:1552-1555`.
   - `resolveActiveAiGatewayRunContext` (session → workspace fallback) —
     `packages/server/src/server.ts:1875-1891`.
5. An active gateway run is registered **only** for managed `prompt_async` sends:
   - `registerActiveAiGatewayRun` is called only under
     `kind === "prompt_async" && expectAiGatewayStart` —
     `packages/server/src/server.ts:5345`.
   - `expectAiGatewayStart = kind === "prompt_async" && Boolean(managedProfile)` —
     `packages/app/src/app/app.tsx:2457`.
   - Skill creation does not flow through that path, so no run exists for the
     workspace, the fallback is empty, and the server throws a hard 400 —
     `packages/server/src/server.ts:2434-2459`.

### Key inconsistency: local server is stricter than the remote gateway

The **remote** gateway tolerates an unresolved placeholder by deriving a
deterministic fallback session id, while the **local** desktop server hard-rejects
it before it ever proxies:

- Remote tolerance: `normalizeGatewaySessionId` returns
  `veslo_fallback_<provider>_<digest>` when the value still contains
  `OPENCODE_SESSION_ID` —
  `services/ai-gateway/src/http/providers/session-id.ts:5-31`.
- Local strictness: `packages/server/src/server.ts:2453` throws 400 instead.

So the desktop path fails exactly where the cloud path would have succeeded.

### Failure class (not just skill creation)

Any managed-AI model call where (a) OpenCode does not substitute the session
header **and** (b) no `prompt_async` run is registered for the workspace will hit
the same 400. Candidates: the `skill-creator` agent, OpenCode sub-agents/tasks,
and in principle `command` / `shell` / `summarize` kinds — none of which register
a run (`app.tsx:2457`). `summarize` (session compaction, `app.tsx:4400`) is bound
to an existing session id and is therefore usually safe; the dangerous cases are
model calls with no substitutable session at all.

### Recommended fix (primary, lowest risk)

Mirror the remote gateway: when the local server cannot resolve the session id,
**proxy with a fallback/workspace correlation instead of returning 400**, and use
the resolved session id only where it is actually available. This is safe for the
provider-start watchdog because:

- `recordAiGatewaySessionHit` already records hits by workspace id as well as by
  session id — `packages/server/src/server.ts:1946-1977`.
- `hasAiGatewayProviderHitAfter` matches by session id **or** workspace id —
  `packages/server/src/server.ts:1979+`.

So a registered run is still detected via the workspace key, while non-conversation
managed calls stop being hard-blocked. (Alternative/complementary: register a
transient active run for non-`prompt_async` managed operations such as skill
creation.)

### Current in-progress mitigation (uncommitted) and the remaining gap

The working tree already contains an uncommitted partial fix in
`packages/server/src/server.ts` that this audit must account for:

- A second resolution source: the request's `x-session-id` header (OpenCode's
  real session id) is read as `incomingOpenCodeSessionId` and used by a new
  `resolveAiGatewaySession()` when the `x-veslo-session-id` placeholder did not
  resolve — `server.ts:2512`, `server.ts:1930-1958`.
- The workspace fallback is hardened against the Problem #4 risk: it only resolves
  by workspace when exactly one workspace has active runs; otherwise it returns
  `unresolved` with `workspaceFallbackSuppressedReason: "ambiguous-active-run-context"`
  — `server.ts:1960-1981`.

This is a real improvement (adds a correct second correlation source and removes
wrong-run correlation), but it does **not** fix the reported skill-creation case.
`resolveAiGatewaySession` still returns `source: "unresolved"` (and the caller
still throws 400) when **all** of these hold — which is exactly the skill-creator
path — `server.ts:1983-1988`, `server.ts:2539`:

1. `x-veslo-session-id` is the literal placeholder (normalizes to empty),
2. `x-session-id` is absent or empty (OpenCode did not attach a session id for the
   `skill-creator` agent call), and
3. there is no registered `prompt_async` run for the workspace to fall back to.

Both session signals are OpenCode-internal and OpenCode 1.17.4 evidently runs the
`skill-creator` agent outside a substitutable session context, so VESLO cannot
make it emit a session id from the app side. The only VESLO-side options for this
truly-unresolved class are therefore:

- **(Recommended) Tolerate + forward** for the unresolved case instead of 400,
  mirroring the remote gateway's `veslo_fallback_*` behavior, recording the
  watchdog hit by workspace only. This keeps the hardened ambiguity handling but
  stops hard-blocking sessionless managed calls.
- **(Alternative) Register a transient active run** around non-`prompt_async`
  managed operations (skill creation, agent runs) so the workspace fallback can
  resolve them. More invasive and per-path.

Note: reversing the hard 400 means updating the contract test
`packages/server/src/tests/server.ai-gateway.test.ts` (which currently asserts
`gateway_session_unresolved`); the unresolved-but-ambiguous case can keep a
distinct, safe behavior from the unresolved-and-sessionless case.

## B. Provider-start watchdog correlation (confirms Problem #4)

`resolveActiveAiGatewayRunContext` returns the **latest** run for the workspace
(`server.ts:1888`). With two concurrent managed runs in the same workspace a
provider hit can satisfy the wrong run's watchdog. The shared engine (one process
serving multiple workspaces/sessions) increases the chance of overlap, so
correlation should become run-scoped rather than workspace-scoped.

## C. Runtime preference precedence can silently override `.env` (NEW, extends Problem #1)

`read_runtime_preferences` resolves as persisted override `unwrap_or(env)`, and
`shared_unsandboxed_engine_env_overrides(Some(false))` actively emits
`VESLO_DISABLE_SANDBOX=0`:

- `packages/desktop/src-tauri/src/runtime_preferences.rs:66-71` (persisted wins
  over env).
- `packages/desktop/src-tauri/src/runtime_preferences.rs:93-105`
  (`Some(false)` => `VESLO_DISABLE_SANDBOX=0`, `Some(true)` => `=1`,
  `None` => no override).

Consequences:

- If non-sandbox is configured via `.env` but `runtime-preferences.json` still
  holds a stale `false` (e.g. the toggle was once turned off in Settings), spawn
  emits `VESLO_DISABLE_SANDBOX=0` and **overrides the `.env`**, so the engine runs
  sandboxed (WSL) despite the `.env` requesting non-sandbox.
- Source split: Settings reads `read_runtime_preferences` (env-resolved) while
  spawn reads `read_shared_unsandboxed_engine_override` (persisted-only) —
  `commands/engine.rs:762`, `commands/orchestrator.rs:457`,
  `veslo_server/mod.rs:849`. Settings can display one mode while the runtime
  starts another. This is the same split-source-of-truth class as Problem #1.

## D. Still to verify (not yet confirmed)

- **Per-workspace config under the shared engine.** Managed config is written
  per-workspace via `patchConfig(workspaceId, …)`, but whether one shared OpenCode
  process actually reads per-workspace `opencode.json[c]` (vs a single global
  config) was not verified. If it reads a single config, per-workspace managed AI
  (different model / `allowedModels`) would clash. Verify in the orchestrator
  engine spawn / config path.
- **Inactive workspace heal cross-workspace** (Problem #3) — pre-writes a gateway
  URL from the active workspace's runtime state onto other workspaces.

## E. Priority

| # | Risk | Severity | Status |
|---|---|---|---|
| A | Local gateway hard-400 vs remote tolerance (skill creation) | High — blocks real functionality | Confirmed; fix is small |
| B | Watchdog workspace-scoped correlation under concurrency | Medium | Confirmed |
| C | Runtime preference overrides `.env` / source split | Medium-High (silent, confusing) | Confirmed |
| D | Shared-engine per-workspace config read | Unknown | To verify |
| E | Inactive heal cross-workspace | Low-Medium | From earlier audit |

Item **A** is the highest-value fix: it is the reported failure and the fix is
small and safe (align the local server with the remote gateway's tolerant
session-id handling).
