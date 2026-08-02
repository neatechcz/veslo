---
title: Server-Owned Runtime Operation Hardening
status: proposed
done: false
date: 2026-08-02
issue: unlinked
scope: move the current UI-triggered runtime recovery and reload decisions behind a small server owner
related:
  - docs/plans/2026-08-01-p0-p1-predictable-runtime-ownership-plan.md
  - docs/plans/2026-07-31-retry-error-containment-audit-plan.md
  - docs/dev/conversation-workflow-contract.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/features/session-runtime.md
---

# Server-Owned Runtime Operation Hardening

## Decision

This is an incremental ownership hardening, not a runtime rewrite.

Add one small server-side `RuntimeOperationOwner` for **UI-originated runtime
recovery and reload requests**. It is the only place that decides whether a
request can repair transport, reload an idle workspace, or must be blocked. It
reuses the existing conversation lifecycle controller, workspace execution gate,
reservation state, guarded reload route, native process commands, and UI
projection.

The app remains responsible for intent, safe control-plane bootstrap, and
presentation. It no longer selects `forceFreshRuntime`, maintains a separate
recovery budget, or invokes an unguarded reload for a normal user action.

P0 deliberately does not add a persistent workflow system, a second queue, or
a replacement native runtime API. It adds one bounded durable runtime-operation
lease beside the existing run queue records because a server control-plane
rebind can restart the very server that granted it. The lease is not a second
truth for conversation state and it never replays an operation automatically.

## Codebase validation

This plan was checked against the current implementation on 2026-08-02.

| Verified surface | Current behavior | P0 change |
| --- | --- | --- |
| SSE `session.error` invalid bearer | Releases the route and calls the app recovery callback directly. This bypasses the separate SSE outage episode budget. | Route through the app runtime-operation client and the server owner. |
| SSE connection failure | Has a one-attempt episode, but the budget is scoped to the stream connection key and calls the same UI fresh-runtime callback. | Retain reconnect presentation, but delegate the recovery decision to the server owner. |
| Send preflight recovery | Calls `ensureEngineForWorkspace(... forceFreshRuntime: true)` and then repeats it after 250 ms. | Replace both attempts with one typed owner request; no UI retry loop. |
| Remote reload button | Calls `reloadEngine(workspaceId)` without `ifIdle`. | Call the existing guarded server reload with `ifIdle: true`. |
| Local reload store | Calls `restartWorkspaceRuntime(... forceFreshRuntime: true)` directly. | Move the normal reload action behind the same app runtime-operation client in P1. |
| Server reload route | Already delegates `ifIdle` reloads to `reloadWorkspaceEngineIfIdle`, which holds the workspace execution gate and checks reservations and reconciliation. | Reuse it; do not duplicate its state. |
| Native prepare IPC | Derives fresh start from both `forceFreshRuntime` and free-form reason text. | Do not widen this contract in P0. Remove the P0 UI recovery callers first; narrow native authority only for migrated paths in P1. |
| Submit transport bootstrap | After native admission transport bootstrap, the app forces a local Veslo server restart. The restart carries the daemon lifecycle token into the server process when they differ. | Split harmless bootstrap from a server-authorized control-plane rebind; removing restart without rebind would leave invalid bearer unresolved. |

The existing lifecycle controller remains authoritative for accepted runs,
reservations, terminalization, release, and queue wake-up. `RuntimeOperationOwner`
must query it; it must not mirror its maps or infer run state from UI signals.
The controller must additionally treat a durable runtime-operation lease as an
exclusive workspace handoff: new sends are queued, not started, until the lease
is completed, becomes outcome-unknown, or expires under an explicit recovery
rule.

## P0 contract

### Owners

| Owner | P0 responsibility | Explicitly not responsible for |
| --- | --- | --- |
| `RuntimeOperationOwner` in the server | Coalesce automatic recovery requests per workspace, choose a typed safe action, apply the one-recovery budget, delegate guarded reload, and return a typed result. | Conversation admission/release, process implementation, UI presentation, or general scheduling. |
| Conversation lifecycle controller | Supplies the existing workspace execution gate, reservation count, and reconciliation state for reload safety. | Handling UI retries or native IPC. |
| Native desktop | Performs the existing narrow admission-transport bootstrap and a server-granted control-plane rebind. | Choosing whether a destructive runtime action is safe. |
| App runtime-operation client | Sends intent, performs the explicitly safe bootstrap only when the server cannot be reached, executes an admitted transport repair, and renders its typed result. | Fresh-runtime choice, independent retry budget, or active-run inference. |
| UI components and stores | Request an action and render `recovering`, `blocked`, or `degraded`. | Calling runtime preparation/restart as recovery logic. |

### Operation kinds and outcome

P0 exposes only these operation kinds:

| Kind | Allowed source | Server decision | Native effect |
| --- | --- | --- | --- |
| `repair_admission_transport` | `sse`, `send_preflight` | One in-flight automatic request per workspace; repeated requests join it. | Run the existing admission-transport bootstrap only. It may start missing transport but does not stop or replace a live process. |
| `rebind_control_plane` | `sse`, `send_preflight` | Require a durable exclusive runtime-operation lease; active reservations and reconciliation remain durable and are rehydrated after replacement. | Rebind the Veslo server to the live daemon lifecycle credentials. It may respawn the server but never the engine or orchestrator. |
| `reload_workspace_if_idle` | `sse`, `send_preflight`, `user_reload` | Delegate to the existing lifecycle guarded reload. Active reservation or reconciliation returns `blocked`. | Server-routed reload only after admission. |

Automatic recovery never requests fresh runtime replacement. A future
`force_restart_runtime` remains a distinct, explicit administrative operation;
it is outside P0 and must not be introduced as a fallback.

The request payload is a finite union:

```ts
type RuntimeOperationRequest = {
  workspaceId: string;
  kind:
    | "repair_admission_transport"
    | "rebind_control_plane"
    | "reload_workspace_if_idle";
  source: "sse" | "send_preflight" | "user_reload";
  reasonCode:
    | "invalid_bearer_token"
    | "engine_unavailable"
    | "workspace_route_stale"
    | "transport_unavailable";
};
```

The server assigns `operationId`; a client correlation value, if retained for
tracing, is only an idempotency hint. Results are one of `accepted`, `joined`,
`completed`, `blocked`, `budget_exhausted`, `outcome_unknown`, or `failed`,
with a safe reason code. Raw errors, tokens, local paths, URLs, prompts, and
process output are not included in the response or traces.

Automatic and manual requests have separate policy. Automatic requests share
one recovery budget per workspace episode. `user_reload` does not consume that
budget, but it still obeys the lifecycle guard and an existing runtime-operation
lease.

### Recovery rules

1. `invalid_bearer_token` maps to `rebind_control_plane` when the server is
   reachable. It never maps to engine reload or fresh runtime.
2. `engine_unavailable` and `workspace_route_stale` may request
   `reload_workspace_if_idle`; an active or reconciling run yields `blocked`.
3. `transport_unavailable` first requests transport repair. It may not escalate
   to reload in the same automatic episode.
4. The owner keeps one bounded automatic recovery episode per workspace. Its
   current lease and terminal result are durable; its in-flight promise and UI
   subscribers are in memory. SSE reconnects, repeated events, and send
   preflight join it.
5. An episode closes only after the operation completes and the existing server
   or orchestrator readiness read is healthy. A socket reconnect alone is not
   health evidence.
6. On budget exhaustion, block, failure, or unavailable control plane, the app
   presents a stable degraded state. It may reconnect its stream but must not
   try a second runtime mutation itself.
7. After a server restart, the owner restores an unexpired lease but never
   replays its native operation. Completion from the reconnected app or a fresh
   authoritative read resolves it. Expiry becomes `outcome_unknown`; a later
   explicit request must re-read lifecycle/runtime state before it can replace
   the lease.
8. A block caused by an active run is terminal for destructive engine reload.
   It does not schedule a deferred reload when the run releases; a later send or
   explicit user retry creates a fresh request against current state. A
   control-plane rebind is not destructive to the engine and remains eligible.

### Safe bootstrap exception

The local server may be unreachable precisely when an operation needs its
decision. The app may therefore call the existing native admission-transport
bootstrap before submitting or retrying an owner request, but only under these
rules:

- it is limited to `runtime_ensure_admission_transport`;
- it may start missing transport processes, but must reuse live processes;
- its follow-up local server ensure uses a new reuse-only probe that never
  restarts a live server and never starts a missing server;
- if the server is still unreachable, return `control_plane_unavailable` and
  do not call runtime prepare, engine restart, engine stop, or server restart.

This exception repairs the path to the owner; it is not an authorization for a
runtime restart or control-plane rebind. `rebind_control_plane` is allowed only
after a reachable server has persisted its lease and granted that specific
operation.

## Durable rebind lease and effect order

Add one bounded `conversation_workspace_runtime_operation` record to the
existing run-queue SQLite store. It has a unique active workspace key and only
these fields: operation id, workspace id, kind, source class, safe reason code,
state, created/updated time, expiry time, and terminal safe result. It contains
no prompt, token, endpoint, or process output.

The states are:

`granted -> executing -> completed | blocked | failed | outcome_unknown`

For `rebind_control_plane`, the required order is:

1. The server enters the existing workspace execution gate.
2. It observes no current runtime-operation lease. Existing reservations and
   reconciliation are durable state that the replacement server rehydrates;
   they do not prevent this non-engine rebind.
3. It durably writes `granted` with a short fixed expiry and makes conversation
   admission treat it as an exclusive handoff.
4. The app receives the grant and calls a new narrow native rebind command.
5. Native reuses the current engine and orchestrator, but starts or respawns
   the Veslo server with the daemon's current lifecycle configuration.
6. The app reconnects using the new server descriptor and posts completion with
   the original operation id.
7. The new server instance reloads the lease, verifies control-plane readiness,
   records `completed`, and releases the handoff. If the app never completes,
   expiry records `outcome_unknown`; it never causes native replay. The
   controller releases queued sends only after a fresh readiness read proves a
   safe terminal state. Otherwise it keeps the workspace degraded and exposes
   explicit retry rather than silently starting a successor.

The lifecycle controller must consult this lease in the same admission path
that owns workspace reservations. A send arriving after step 3 is retained in
the existing durable queue and cannot begin before step 7. This closes the
otherwise unsafe gap between server approval and native execution.

## Implementation steps

### 1. Freeze current behavior with focused tests

Before changing production code, add failing tests that prove the boundary:

1. In the session event-stream tests, emit repeated invalid-bearer errors for
   one workspace while a run remains active. Assert one shared blocked/degraded
   operation result and no call to the current fresh-runtime callback or native
   rebind executor.
2. In the send readiness tests, trigger a recoverable failure and assert that
   the 250 ms fresh-runtime retry no longer exists; the dependency receives one
   typed operation request.
3. In server tests for the runtime owner, race SSE and send-preflight requests
   for one idle workspace. Assert one `operationId`, one durable lease, one
   rebind grant, and one automatic budget use.
4. In workspace management route tests, assert a user reload with `ifIdle` is
   rejected for active reservations and reconciliation, with no reload effect.
5. In transport tests, assert bootstrap of an already running, unauthorized, or
   missing local server never requests forced restart; it returns
   `control_plane_unavailable` when the server owner cannot be reached.
6. In lifecycle tests, admit a rebind lease, then race a new send before native
   completion. Assert that the send stays queued. Restart the server before
   completion, rehydrate the lease, and assert that expiry reaches
   `outcome_unknown` without native replay.
7. In app runtime-operation-client tests, resolve an event for a non-active
   workspace. Assert that it uses only its matching control plane or returns
   unavailable; it must never fall back to the active workspace client.

Keep existing lifecycle controller tests unchanged: they prove the reservation
owner itself and must remain the source of truth.

### 2. Add the minimal durable lease beneath the existing lifecycle owner

Extend `conversation-run-queue-store.ts` with the bounded
`conversation_workspace_runtime_operation` table described above. Provide
operations to create/get one active lease per workspace, transition its state,
list unexpired leases at server start, and expire a lease to `outcome_unknown`.
Use the existing run-queue SQLite location and migration pattern; do not create
another database.

Extend the conversation lifecycle controller with a narrow runtime-operation
port. It must acquire/release the lease under `withWorkspaceExecutionGate` and
make accepted-run admission and queue drain refuse to start a successor while a
lease is active. Queued user intent remains in the existing queue. The port
must expose facts and transitions, not its internal reservation maps.

On lifecycle controller startup, load unexpired leases before scheduling queue
drain. Mark expired or unverifiable leases `outcome_unknown`; never invoke a
native action as startup recovery.

Add lifecycle and queue-store tests for: active-run rejection; a send racing a
grant; restart between grant and completion; expiry; and no native replay after
restart.

### 3. Add a focused server runtime-operation owner

Create `packages/server/src/runtime-operation-owner.ts` with a small factory.
Its dependencies are deliberately narrow:

- the lifecycle runtime-operation port from step 2;
- `reloadWorkspaceEngineIfIdle` from the lifecycle controller;
- a server-routed reload callback already used by the workspace route;
- workspace resolution and a clock/id generator for deterministic tests;
- a readiness read callback used only to close a completed lease.

Keep a `Map<workspaceId, RecoveryEpisode>` only for in-process promise joining
and UI subscribers. The durable lease, rather than the map, is the operation
truth across a server restart. Equivalent automatic requests join it; a
different automatic kind during a live episode returns the existing typed
result rather than replacing the action.

Expose three methods:

- `request(input)`: validate the finite request, join/create the episode, and
  either admit safe transport bootstrap, acquire a rebind lease, or invoke the
  existing guarded reload;
- `beginRebind(input)`: transition the persisted lease from `granted` to
  `executing` immediately before native execution;
- `complete(input)`: verify the operation id and kind, perform an authoritative
  readiness read, terminalize the lease, and release its admission handoff.

The owner calls no Tauri command and holds no second reservation map. For
`reload_workspace_if_idle`, its only execution path is the existing
`reloadWorkspaceEngineIfIdle` callback.

Add `packages/server/src/tests/runtime-operation-owner.test.ts` for join,
automatic/manual budget separation, active-run block, concurrent-send lease
protection, completion after a reconstructed owner instance, expiry, and no
automatic replay.

### 4. Expose the owner through the existing workspace API boundary

Extend `WorkspaceManagementRouteDependencies` and its composition in
`server.ts` with the owner. Add two client-scoped routes in the existing
workspace management route module:

- `POST /workspace/:id/runtime-operations` accepts the finite request and
  returns the typed owner result;
- `POST /workspace/:id/runtime-operations/:operationId/begin` transitions only
  an admitted `rebind_control_plane` lease to `executing`;
- `POST /workspace/:id/runtime-operations/:operationId/complete` accepts a
  matching transport-repair or rebind completion and a safe success/failure
  code.

Do not add a second engine reload implementation. Both the runtime-operation
request and the existing engine reload route delegate `reload_workspace_if_idle`
to the established guarded reload callback, preserving its current response and
error shape for established callers.

Add a `requestRuntimeOperation` and `completeRuntimeOperation` method to the
workspace client domain. Keep `reloadEngine` for established non-UI callers,
but when it receives `ifIdle: true`, make the existing engine reload route
delegate to the same owner rather than directly invoking a reload.

### 5. Add the narrow native control-plane rebind executor

Add `runtime_rebind_control_plane` beside the existing desktop runtime commands.
Its input is only workspace identity/path and the server-issued operation id;
it accepts neither `forceFreshRuntime` nor a free-form reason. It must:

1. read the live orchestrator daemon endpoint and lifecycle credentials through
   the existing native state/auth helpers;
2. preserve the current engine and orchestrator process;
3. call the existing Veslo server launch/reuse path with those credentials, so
   an equivalent server is reused and a lifecycle-token mismatch causes only
   the Veslo server to respawn;
4. return a redacted refreshed server descriptor for app reconnection.

It must not call engine start, engine stop, workspace activation, or
orchestrator stop. Add Rust-focused tests for the executor decision and rely on
the desktop scenario for the real process-chain assertion.

### 6. Add one app-side runtime-operation client and workspace resolver

Create a focused app module, for example
`packages/app/src/app/context/runtime-operation-client.ts`. It owns no state
other than a request in flight and receives dependencies for a workspace-scoped
control-plane resolver, `runtimeEnsureAdmissionTransport`, the new native
control-plane rebind command, and the existing non-forced local server ensure.

Add `resolveRuntimeOperationTarget(workspaceId)`. It returns the exact server
client and server workspace id for that workspace, or `unavailable`. A local
workspace may use the local server only after its registered server workspace
identity matches. A remote workspace may use the configured remote client only
after its configured remote workspace id matches. It must never silently use
the active workspace's client for a different workspace.

Its algorithm is fixed:

1. Resolve the exact workspace control plane, then submit the typed request to
   the server owner.
2. If the exact target is local but has no server connection, run the safe
   bootstrap exception once, then retry the same owner request once. A remote
   target mismatch or an unresolved workspace mapping returns unavailable and
   never bootstraps the active workspace by accident.
3. For a completed or joined server-routed reload, return the typed result.
4. For admitted transport repair, call only
   `runtimeEnsureAdmissionTransport`, report completion to the owner, and
   reconnect/catch up.
5. For admitted control-plane rebind, call `begin`, invoke only the new native
   rebind command, reconnect using the refreshed server descriptor, and call
   `complete` with the same operation id. Never call native rebind without the
   persisted server grant.
6. Map `blocked`, `budget_exhausted`, `failed`, `outcome_unknown`, and
   `control_plane_unavailable` directly to presentation; do not invoke
   `ensureEngineForWorkspace`, `restartWorkspaceRuntime`, or an arbitrary
   retry.

Do not change the established first-submit transport helper in P0. Its current
rebind behavior belongs to a separately classified send-start path. The new
runtime-operation client has its own safe bootstrap path: it never calls the
helper's forced-restart branch and returns `control_plane_unavailable` when it
cannot reach the owner.

### 7. Migrate exactly the P0 UI callers

Make the following targeted substitutions:

1. In the app wiring for `recoverWorkspaceRuntimeForEventStream`, replace the
   direct `ensureEngineForWorkspace(... forceFreshRuntime: true)` callback with
   the app runtime-operation client.
2. In `session-event-stream.ts`, preserve error/transcript handling and
   reconnect presentation. Pass only the classified workspace, source, and
   reason code to the new callback; remove its local fresh-runtime episode as
   the authority for mutation.
3. In `send-runtime-readiness.ts`, replace both current fresh-runtime calls and
   the 250 ms retry with the same callback. Keep preflight result semantics, but
   derive `recoveryAttempted` from the typed owner result.
4. In the remote reload action, use `requestRuntimeOperation` with
   `reload_workspace_if_idle` and display `reload_blocked_active_runs` as a
   normal blocked result. The existing engine reload route also delegates to
   this owner when an established caller supplies `ifIdle: true`.

Do not change normal workspace activation, cold start, browse activation, or
the local engine reload store in this step. They are not recovery call sites and
need separate classification before migration.

### 8. Tighten the migrated boundary and document it

Add source-level tests that the migrated SSE and send paths no longer reference
`forceFreshRuntime` or direct engine preparation. Keep the existing native
`runtime_prepare_workspace` command compatible for non-migrated callers.

Update the canonical runtime and session documentation after implementation to
state: server owns recovery/reload admission and rebind leases, lifecycle owns
active-run safety, native executes only a granted rebind or safe bootstrap, and
UI projects typed results.

## P1 follow-up, intentionally not a prerequisite

Inventory every remaining UI-originated native runtime mutation. For each,
record its current owner, whether it can stop or replace a runtime, whether it
may happen with an accepted run, and the exact target:

| Current family | P1 disposition |
| --- | --- |
| Local engine reload store | Route the normal user reload through `reload_workspace_if_idle`; retain a separately confirmed admin force action only if product requires it. |
| Settings engine/server/router restart | Make default actions return an active-run block; design force behavior as an explicit administrative command. |
| MCP/config application and attachment recovery | Use the owner only if the operation can replace a running runtime; otherwise retain its current narrow owner. |
| Migration and host shutdown | Keep their established server/native owners and document their shutdown contract; do not funnel them through UI recovery. |
| Native `runtime_prepare_workspace` | Replace free-form fresh-start selection with a closed operation mode only after all callers have been classified. |

Do not expand the P0 runtime-operation lease into a generic operation store. Any
new persisted operation kind requires the same proof: it protects a concrete
server-to-native crash window and remains subordinate to existing lifecycle
reservations and queue dispatch.

The UI local draft queue is explicitly outside this plan. A separate P2 can
move durable admitted queue timing to the server after preserving draft edit,
cancel, retry, and reorder semantics.

## Verification and acceptance

### Required automated checks

- Focused server owner and workspace route tests pass.
- Focused session event-stream, send-readiness, submit-transport, and runtime
  client tests pass.
- Existing conversation lifecycle controller tests pass unchanged.
- `pnpm --filter veslo-server build:bin` passes after server changes.
- `pnpm check` passes for the complete implementation handoff.

### Required real desktop scenario

Add a Tauri Pilot scenario against a fresh desktop runtime with two phases.
First, while one controlled run is active, inject three invalid-bearer SSE
errors and a send-preflight recovery signal. Verify one shared blocked/degraded
episode, no native rebind, no fresh engine/orchestrator generation, and no
interruption of the active run. Second, after lifecycle release, inject the
same invalid-bearer condition. Verify exactly one granted control-plane rebind,
server reconnect and completion against the durable lease, unchanged
engine/orchestrator generation, and a responsive UI. Normal reload must remain
blocked during a run and succeed only after lifecycle release.

### P0 is complete only when

1. SSE and send preflight share one server-owned recovery decision per
   workspace and cannot each start a fresh runtime.
2. Invalid bearer performs server-authorized control-plane rebind only while
   the lifecycle owner confirms the workspace is idle; otherwise it degrades
   without native mutation.
3. The automatic recovery budget is not bypassed by repeated SSE events or the
   send retry loop.
4. Normal remote reload always uses the existing lifecycle guarded path.
5. A native rebind cannot run after a new send has been admitted: its durable
   lease keeps that send in the existing queue until terminal resolution.
6. Safe bootstrap never forces restart of an already live local server.
7. Active or reconciling runs remain protected by the existing lifecycle owner.
8. The Tauri desktop scenario proves both safe active-run blocking and one
   idle control-plane rebind.
