# App Server Flow Delay and Blackbox Audit

Date: 2026-07-06
Status: read-only audit, no runtime code changes
Scope: app to Veslo server to OpenCode send flow, workspace lists, long-run streaming, lifecycle/status recovery

## Summary

The biggest risk is not one missing `async`; the flow is already asynchronous at
the transport level. The weak points are serial await barriers and opaque
cross-process calls where the caller waits for readiness, registration,
lifecycle admission, or provider-start proof before the next visible step can
continue.

Highest-risk delay points:

1. Send preflight is a serial gate before any prompt reaches the server.
2. Conversation workspace registration may list/register server workspaces on
   the send path.
3. Server run submission waits through lifecycle active/register and OpenCode
   submit, and managed AI additionally waits for provider-start observation.
4. Desktop SSE is safe only when the Rust-side SSE proxy is used; legacy SDK
   SSE fallback can still reproduce the Tauri HTTP IPC blocking class.
5. Run progress is split between `POST /runs`, OpenCode `/event`, transcript
   ingestion, and lifecycle polling, which makes failures hard to attribute.

Most blackbox area:

`submitRun -> submitAcceptedRun -> fetchOpencodeJsonWithOrchestratorFallback`
is the most opaque boundary. It combines lifecycle state, queue behavior,
OpenCode proxy routing, orchestrator fallback, AI gateway provider observation,
and broad timeout surfaces. A delay there can look like "send is stuck" even
though the actual wait may be engine spawn, OpenCode headers, gateway provider
start, lifecycle registry, or fallback routing.

## Request Surface Map

App Veslo server transport:

- `packages/app/src/app/lib/veslo-server/transport.ts`
- `requestJson` uses Tauri `@tauri-apps/plugin-http` in desktop and
  `globalThis.fetch` in web.
- GETs are brokered/coalesced by `request-broker.ts`, so one slow shareable GET
  can delay multiple callers that joined the same in-flight request.

OpenCode SDK/runtime transport:

- `packages/app/src/app/lib/opencode.ts`
- `createClient(baseUrl, directory, auth)` creates `@opencode-ai/sdk/v2`
  clients.
- Desktop requests use `tauriFetch` with a 60s default timeout.

Desktop SSE transport:

- `packages/app/src/app/lib/engine-sse.ts`
- `packages/desktop/src-tauri/src/commands/engine_sse.rs`
- The Rust proxy exists specifically because JS-side SDK SSE through Tauri
  fetch holds a long-lived IPC body read and can block parallel short requests.

Server OpenCode transport:

- `packages/server/src/server.ts`
- `fetchOpencodeJson` reads bounded JSON responses and times out.
- `proxyOpencodeRequest` proxies `/workspace/:id/opencode/*` and only bounds
  time to upstream response headers; streaming responses are intentionally not
  timed out after headers.

## Weak Point 1: Send Preflight Serial Gate

Path:

- `packages/app/src/app/pages/session-send-workflow.ts`
- `packages/app/src/app/context/send-runtime-readiness.ts`

Before the app posts a run, `sendPrompt` waits for:

- scoped workspace activation,
- optional skill/command resolution,
- runtime readiness,
- OpenCode health plus `engineInfo`,
- optional runtime recovery,
- managed AI bootstrap readiness,
- session creation when this is the first message,
- attachment staging.

Evidence:

- `sendPrompt:ensure-scoped-workspace-active` is awaited before runtime
  preparation.
- `prepareSendRuntimeForSend` awaits `ensureLocalRuntimeReachableForSendResult`
  and then `ensureManagedAiBootstrapReady`.
- `createSessionAndOpen` is awaited before `runConversationFromVesloWriteApi`
  when there is no materialized session.

Why it can delay:

- A first send cannot reach `POST /runs` until all gates pass.
- Some gates are correctness checks, but they are still user-visible latency.
- Runtime health is wrapped by `withLocalRuntimeHealthTimeout` at 3s, but that
  helper races an already-created promise. It does not itself abort the
  underlying SDK request. If the underlying SDK fetch has a 60s timeout, the
  short health gate can return while the original request continues in the
  background.

Impact:

- The send button can look blocked by "runtime connecting" or "creating" while
  the real wait is a health probe, engine info, managed AI bootstrap, or
  workspace attach.
- This can also delay queue drain for app-owned drafts because the drain path
  calls the same send workflow.

KISS audit recommendation:

- Add per-gate duration counters to the visible send trace summary:
  `workspace-active`, `skill-resolution`, `runtime-health`, `engine-info`,
  `runtime-recovery`, `managed-ai-bootstrap`, `conversation-create`,
  `conversation-run`.
- Prefer abortable readiness probes over `Promise.race` wrappers where the
  caller believes the operation has timed out.

## Weak Point 2: Workspace Registration on Conversation Path

Path:

- `packages/app/src/app/context/conversation-service.ts`
- `packages/app/src/app/context/workspace-server-registry.ts`
- `packages/app/src/app/lib/veslo-server-domains/workspace.ts`

Workspace list endpoints:

- App: `client.listWorkspaces()` -> `GET /workspaces`
- Server: `routes/workspace-management.ts` returns `{ items, activeId }`

Conversation-service registration does:

1. optional `engineInfo` for local OpenCode registration metadata,
2. `listWorkspaces`,
3. match by id/path/directory/opencode directory,
4. maybe `addLocalWorkspace`,
5. cache result per server client and normalized directory.

Why it can delay:

- This sits on read and write follow-up paths, including send-time create/run.
- `listWorkspaces` has an 8s frontend timeout.
- `addLocalWorkspace` has a 10s frontend timeout.
- If local server auth/base URL state is stale, registration can trigger local
  server recovery first.

Important nuance:

`workspace-server-registry.reconcileVesloServerWorkspaces` only detects missing
local paths and logs `workspace_registry_unsynced`; it does not eagerly add
them. Conversation-service can still lazily add workspaces later on the send or
read path.

Impact:

- A user-visible send can pay for workspace registry repair.
- Multiple app surfaces also call `listWorkspaces` independently. The request
  broker coalesces identical GETs, which reduces request storms, but it also
  means a single slow list call can fan out delay to all coalesced callers.

KISS audit recommendation:

- Make one explicit "workspace attach/registry" trace event with duration and
  outcome: `cache-hit`, `listed`, `added`, `fallback-id`, `server-started`.
- Consider moving lazy add/repair out of the critical first-message path when a
  safe cached mapping exists.

## Weak Point 3: Server Run Submit Is Synchronous Until Admission Completes

Path:

- `packages/server/src/routes/conversations.ts`
- `packages/server/src/conversation-run-lifecycle-controller.ts`
- `packages/server/src/server.ts`

Endpoint:

- `POST /workspace/:id/conversations/:conversationId/runs`

Server route waits for:

1. payload parse,
2. conversation execution target resolution,
3. lifecycle active peek,
4. lifecycle register,
5. OpenCode submit if admitted,
6. optional AI gateway provider-start watch,
7. JSON response to the app.

Timeouts and polling:

- OpenCode conversation submit timeout: 30s server-side.
- App-side `conversationRun` timeout: 90s.
- AI gateway provider-start default timeout: 30s.
- Queue drain poll: 1500ms.

Why it can delay:

- `POST /runs` is not fire-and-forget. The app waits for the server to admit or
  queue the run.
- If lifecycle says another run is active, the server returns queued quickly,
  but actual execution waits for queue drain.
- If no active run exists, the server waits for OpenCode submit.
- Managed AI prompt runs wait for provider-start proof after submit. That means
  OpenCode may have accepted the prompt, but the app still waits for the
  provider-start watchdog before receiving success.

Impact:

- A long `POST /runs` does not necessarily mean model generation is slow. It
  can mean lifecycle register, engine spawn, OpenCode headers, provider-start
  detection, or orchestrator fallback.
- The response payload includes debug trace, but unless surfaced in the UI or
  logs, the user only sees a broad send delay.

KISS audit recommendation:

- Return `submitted` as soon as OpenCode accepts the run, and move provider-start
  validation to lifecycle/status where possible. If provider-start must remain
  blocking, expose it as a distinct run phase.
- Keep lifecycle active/register timings separate from OpenCode submit timings.

## Weak Point 4: Rust SSE Proxy Has a Legacy Fallback Trap

Path:

- `packages/app/src/app/context/session-event-stream.ts`
- `packages/app/src/app/context/global-sdk.tsx`
- `packages/app/src/app/lib/engine-sse.ts`
- `packages/desktop/src-tauri/src/commands/engine_sse.rs`

Good path:

- Desktop uses `engineSseSubscribe`.
- JS calls Tauri `listen()` and `invoke("engine_sse_subscribe")`.
- Rust opens `${baseUrl}/event` with reqwest and emits parsed events back to JS.

Known bad class:

- JS-side `eventClient.event.subscribe()` through Tauri fetch can hold the Tauri
  HTTP plugin IPC channel open for the lifetime of the SSE body.
- The code comments explicitly state that this used to block parallel short
  requests such as sidebar session listing until frontend timeouts fired.

Current residual risk:

- `session-event-stream.ts` uses Rust SSE only when desktop is available and a
  routing entry has a `baseUrl`.
- If `sourceWsId` is missing/legacy or the route entry is not available, it
  falls back to `c.event.subscribe`.
- That fallback is theoretically the highest-risk "blocks other requests" path
  in desktop because it revives the same long-lived Tauri fetch shape that the
  Rust proxy was added to avoid.

Impact:

- A stream bug can masquerade as unrelated slow sidebar/workspace/server calls.
- This is especially blackbox because the blocked request is not the one that
  caused the blockage; the long-lived SSE fetch is.

KISS audit recommendation:

- In desktop, treat SDK SSE fallback as an explicit degraded mode and log a
  high-signal event with workspace id, source id, and missing route reason.
- Prefer failing/recovering the route over silently opening JS-side SDK SSE in
  desktop.

## Weak Point 5: Event Stream Batching Adds Intentional Latency

Path:

- `packages/app/src/app/context/session-event-stream.ts`
- `packages/app/src/app/context/global-sdk.tsx`

Behavior:

- Session event stream coalesces updates by event key.
- It flushes non-part events around a 16ms cadence.
- It flushes part updates around a 48ms cadence.
- It logs only when debug mode is enabled and thresholds are exceeded.

Why it can delay:

- The 48ms part-update batch is deliberate and usually good.
- Under heavy output, large batches are processed in one Solid `batch`.
- `applyEvent` is async-shaped but called with `void applyEvent(...)` inside the
  batch, so event side effects are not awaited by the flush. That prevents the
  stream from blocking on every side effect, but it also makes ordering and
  failure attribution less transparent.

Impact:

- Small latency is expected.
- A large output burst may produce UI update jitter.
- Debug visibility depends on developer-mode logs, not a normal user-visible
  progress diagnostic.

KISS audit recommendation:

- Keep batching, but expose a compact stream health metric:
  queue wait, peak queue depth, dropped/coalesced count, last event age.

## Weak Point 6: Queue Drain and Lifecycle Recovery Are Correct but Opaque

Server queue drain:

- `conversation-run-lifecycle-controller.ts`
- Queued run drain checks latest lifecycle status before submitting the next
  item.
- It reschedules at 1500ms when active, conflicted, or status errored.

App lifecycle recovery:

- `session-lifecycle-recovery.ts`
- Polls `readConversationRunStatus` every 5000ms by default.
- Max attempts default to 600.
- This is read-only recovery, not the primary stream.

Why it can delay:

- A queued draft can wait for the previous active run plus the poll interval.
- If lifecycle status calls fail, queue drain reschedules instead of forcing a
  terminal decision.
- App recovery is intentionally conservative, so it can take seconds to correct
  stale UI status.

Impact:

- Delays are bounded by polling cadences, but the reason for waiting is not
  obvious in normal UI.
- This can make "agent has been running a long time" hard to distinguish from
  "lifecycle status stale" or "queue drain waiting".

KISS audit recommendation:

- Surface queue state distinctly from run state: `running`, `queued position N`,
  `waiting for lifecycle idle`, `status recovery polling`.

## Most Likely "Blocks Other Parts" Candidates

Ranked by likelihood and blast radius:

1. Desktop SDK SSE fallback via `c.event.subscribe` in Tauri.
   - This is the only path with an explicit historical mechanism for blocking
     unrelated short requests through Tauri HTTP IPC.
   - It should be treated as a hard degraded path, not a quiet fallback.

2. Non-aborted health probe after `withLocalRuntimeHealthTimeout`.
   - The wrapper times out the caller, but the underlying SDK request may keep
     running until its own timeout.
   - That can keep transport resources busy after the send gate has moved on.

3. Server run submit waiting for managed AI provider-start proof.
   - The app sees a delayed `POST /runs`.
   - The real wait may be provider-start detection, not OpenCode acceptance.

4. Workspace list/add repair in the send path.
   - It is correct for consistency but can add 8-10s class waits before the
     user sees actual run submission.

5. Coalesced `GET /workspaces` and other brokered GETs.
   - Coalescing reduces storms, but a stuck leader request delays every joined
     caller.

## Most Opaque Blackboxes

1. `fetchOpencodeJsonWithOrchestratorFallback`
   - Primary OpenCode request may fail, then fallback to orchestrator.
   - From the app perspective this is one server request.
   - A delay can hide two attempts and two routing layers.

2. Managed AI provider-start watch
   - The server waits for a side effect observed through the gateway runtime
     owner.
   - If observation misses the provider hit, the run can be marked failed after
     OpenCode accepted the prompt.

3. Runtime readiness recovery
   - `ensureLocalRuntimeReachableForSendResult` can release route, clear
     readiness, ensure engine, reconnect client, and retry health.
   - That is operationally useful but too broad to diagnose from a single
     "runtime connecting" UI state.

4. Multi-source progress model
   - Run admission comes from `POST /runs`.
   - Text progress comes from OpenCode SSE.
   - Durable transcript comes from transcript ingestion.
   - Stale correction comes from lifecycle polling.
   - If these disagree, the app has to infer which source is authoritative.

## Recommended Next Audit Steps

1. Add a diagnostic-only "send critical path" timeline that records duration
   of every awaited gate in one trace object.
2. Add a desktop assertion/log that flags any SDK SSE subscription fallback.
3. Make `withLocalRuntimeHealthTimeout` take an abortable operation or an
   AbortController so the losing health request is cancelled.
4. Split server run response timing into:
   - target resolution,
   - lifecycle active peek,
   - lifecycle register,
   - OpenCode submit,
   - provider-start watch,
   - response serialization.
5. Make workspace registry repair explicit in send diagnostics.
6. Surface queue/lifecycle wait state separately from "Answering".

## Plan Integration And KISS Mapping

Follow-up note 2026-07-06:

This audit should feed the server-access implementation plan as a diagnostics
and decision gate, not as a direct mandate for a broad runtime refactor.

Concrete mapping:

1. Map the diagnostic work to `VSA11A: Respawn And Blackbox Diagnostics Gate` in
   `docs/plans/2026-07-06-veslo-server-access-implementation-plan.md`.
2. Use existing trace owners instead of creating a new diagnostics subsystem:
   - app send gates: `sendTraceStep` / `recordSendTrace`;
   - server run/OpenCode path: `recordSendWorkflowTrace` and run trace events;
   - desktop lifecycle: launch diagnostics and `veslo://server-state` events.
3. Keep VSA06/VSA07 satisfied through the existing `VesloServerInfo` snapshot
   plus descriptor event bridge. Do not add a second parallel frontend
   state-machine model unless a concrete bug proves the bridge insufficient.
4. Treat full VSA11 runtime-config hot-swap as conditional. Build
   `POST /runtime/engine-config` only after VSA11A evidence shows dynamic
   orchestrator/OpenCode config is still a material respawn or delay cause.
5. Split VSA13 validation so unit/contract/docs progress can land before the
   full installed-runtime release gate:
   - VSA13A: unit, contract, and docs;
   - VSA13B: installed-runtime smoke;
   - VSA13C: full release gate.

This keeps the audit KISS-aligned: first make the remaining waits and respawns
attributable, then decide whether the expensive runtime hot-swap API is still
needed.

## Current Checkout Note

The worktree was dirty during this audit and continued to move during earlier
inspection. This document describes the live code read in the current checkout,
not a clean committed revision.
