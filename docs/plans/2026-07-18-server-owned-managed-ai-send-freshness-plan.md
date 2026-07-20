---
title: Server-owned Managed AI Send Freshness
date: 2026-07-18
status: proposed
done: false
scope: server-owned managed-AI conversation submission
---

# Server-owned Managed AI Send Freshness

## Problem

The managed-AI config-sync hardening adds a descriptor freshness boundary to
`send-runtime-readiness.ts`. That owner is not used by the normal server-owned
conversation submit path.

The latest manual trace in `.tmp/send-workflow-trace.ui.ndjson` proves the
actual route for a browse-session prompt:

```text
sendPrompt:server-submit-existing
  -> submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime
  -> submitConversationFromVesloWriteApi:submit
```

There is no `managed-ai-bootstrap-config-sync:*` event and no
`managed-ai-config-sync:flight` with `reason: "send-preflight"` for that send.
The route only performs runtime authorization priming. In this run it was a
`managed-ai-runtime-auth-prime:cache-hit`, which is a short-lived gateway-auth
cache, not a model-response or inference cache.

The server-owned route is legitimate: it is selected when the local workspace
has a Veslo write API adapter. It should remain the submit owner. The bug is
only that it bypasses the descriptor freshness boundary before submission.

## Non-goals

- Do not route server-owned submits through the local runtime bridge.
- Do not add polling, timers, or another configuration owner.
- Do not invalidate the active-workspace completed-intent cache.
- Do not change transcript, composer draft, SSE, or skill materialization.

## KISS design

Add one explicit managed-AI config freshness gate to the existing
server-owned submit owner:

```text
resolve server workspace
  -> managed-ai config freshness (send-preflight)
  -> server engine reload (only when config changed and no run is active)
  -> runtime gateway authorization prime
  -> server submitConversation
```

The gate must be reached only when `expectAiGatewayStart` is true: a prompt
with a live managed-AI profile. Non-managed submits retain their current path.

`managed-ai-runtime-config.ts` remains the only config reconciliation owner.
The conversation service only requests its existing `send-preflight` behavior.
It supplies the exact server workspace that it has just resolved; the config
owner must not re-resolve an active workspace behind the submit owner's back.

## Implementation

### 1. Expose a typed send-freshness result

In `context/managed-ai-runtime-config.ts`, expose the existing internal
`ManagedAiConfigSyncOutcome` through a thin public method such as:

```ts
prepareManagedAiRuntimeConfigForServerSend(input: {
  workspaceId: string;
  workspaceRoot: string;
  directory: string;
  serverWorkspaceId: string;
  traceId: string;
}): Promise<ManagedAiConfigSyncOutcome>;
```

It must invoke `syncWorkspaceManagedAiConfig` with
`reason: "send-preflight"`, which deliberately bypasses the active completed
intent shortcut.

`serverWorkspaceId` is an authority input, not a hint. The config owner uses
it directly for `getConfig`/`patchConfig`; it must not call the normal mapping
resolver and silently select the current active workspace. For an active
workspace it additionally checks that the connection authority, when it is
`server`, names the same ID. A mismatch is a stable failed outcome. For a
background workspace it uses the supplied ID and never falls back to the
project config path.

The public result is not a new config owner. It makes the existing explicit
outcome available to the submit boundary so it can distinguish `verified` from
`failed`, `cancelled`, `skipped-pending`, and the explicit
`verified-reload-required` safety outcome.

### 2. Inject the gate into the server submit owner

In `app.tsx`, pass the method to `createConversationService` as a dependency.

In `context/conversation-service.ts`, add one helper used by both:

- `submitConversationFromVesloWriteApi`;
- `submitConversationRunViaVesloWriteApi`.

After `resolveConversationServerWorkspaceForSend` succeeds and before the
existing runtime auth prime, it shall:

1. call the injected config freshness method with the resolved
   `resolution.serverWorkspaceId`, the snapshotted app workspace/root/directory,
   and the current send trace ID;
2. trace `*:managed-ai-config-freshness:start` and `:end`, including the
   typed outcome only;
3. continue only for `{ kind: "verified" }`;
4. throw a stable, actionable error for every other outcome.

The error is intentional: a managed-AI send must not claim it checked the
current descriptor when the check was pending, cancelled, or failed. A later
retry can re-enter the same explicit preflight.

The same helper and exact-ID rule apply to both
`submitConversationFromVesloWriteApi` and
`submitConversationRunViaVesloWriteApi`. This prevents a background run or an
active-workspace switch from syncing one server workspace and submitting to
another.

### 3. Preserve ordering

The freshness check is after server workspace resolution because the config
target depends on it. It is before auth prime because a successful config
write may change the server-client/gateway routing consumed by the prime.

No explicit config read is added to the auth-prime cache. The cache remains a
15-second optimization of gateway authorization only.

### 4. Make the trace a per-send proof

Add `traceId` to the config-sync request and include it in every config-sync
record emitted for that request: `managed-ai-config-sync:flight`, preflight,
`read-current`, `managed-decision`, `patch-done`, and reload decision.

The trace ID is diagnostic context only: it must not be part of the desired
descriptor hash or completed-intent key. A trace-less active UI flight must not
make a send appear verified without a traceable send-preflight. The
single-flight policy must therefore either attach the send trace to all of the
joined operation's records, or start a distinct trace-owned send flight. The
implementation chooses one explicitly and tests it; it may not leave
`traceId: null` on the read/write events.

### 5. Resolve config-write versus engine-reload semantics before submit

Current server behavior is insufficient to assume immediate freshness:
`PATCH /workspace/:id/config` writes `opencode.json` and emits a reload event,
but it does not itself reload an OpenCode engine or wait for an acknowledgement
before `submitConversationRunToOpenCode` posts the prompt. The app-side
`markReloadRequired` is likewise only UI state and cannot prove the server
engine has adopted the file.

Use the existing server-owned acknowledgement endpoint; do not introduce a new
revision endpoint in this fix:

```text
POST /workspace/:id/engine/reload
  -> reloadOpencodeEngine(workspace)
  -> { ok: true, reloadedAt }
```

The existing app client already exposes this as
`vesloServerClient.reloadEngine(serverWorkspaceId)`. Extend that existing
endpoint and client method with an explicit `{ ifIdle: true }` mode; do not add
a parallel reload route. Extend the narrow config client type to include this
method and call it from the config owner, not from `conversation-service.ts`.

`ifIdle` is a server contract, not a client-side `anyActiveRuns()` check. Add a
workspace execution coordinator owned by the conversation-run lifecycle
controller. It owns one asynchronous gate per server workspace and is used by
both run admission and reload:

```text
reloadEngine(workspaceId, { ifIdle: true })
  -> acquire workspace execution gate
  -> if another run is starting or active: 409 reload_blocked_active_runs
  -> otherwise reloadOpencodeEngine(workspace)
  -> acknowledge only after reload succeeds

admit conversation run
  -> acquire the same workspace execution gate
  -> reserve/register the run as starting before releasing it
```

The coordinator's active state is server-owned and covers all server conversation
run admission paths, including queue drains. It is not derived from the app's
global `anyActiveRuns()` signal or only the managed-AI gateway registry. The
existing unconditional UI reload keeps its current semantics; only the config
owner calls the guarded mode.

The lifecycle owner is
`packages/server/src/conversation-run-lifecycle-controller.ts`. Add the
coordinator there, wire its guarded reload port through `server.ts`, and pass it
to the existing `workspace-management.ts` reload route. Its reservation
contract is explicit:

```text
admission accepted/registering -> reserveStarting(workspaceId, runId)
terminal completed|failed|aborted -> releaseRun(workspaceId, runId)
admission/queue-drain failure before an accepted run -> releaseRun(workspaceId, runId)
```

`releaseRun` is idempotent. Invoke it in the terminal reconciliation path, the
upstream-submit failure path, successful and failed abort paths, and every
queue-drain `finally`/terminal transition. The existing AI-gateway unregister
calls are not substitutes: they only cover gateway correlation, whereas this
reservation covers every server-owned conversation run.

Reservations must survive a server restart long enough to be reconciled. Store
the minimal `{ workspaceId, conversationId, runId, state }` record with the
existing durable run/queue state. On `conversationRunLifecycleController.start`,
reconcile each restored reservation with lifecycle status before marking that
workspace idle. Until reconciliation says terminal and `releaseRun` has run,
the workspace is `unknown` and `reloadEngine({ ifIdle: true })` returns a 409
blocked outcome (mapped by the client to `verified-reload-required`). Never
initialize a restarted coordinator as idle merely because its in-memory map is
empty.

The concrete policy is:

1. A no-op read (descriptor already current) returns `verified` and may submit.
2. After a config patch and with no active conversation run, call
   `reloadEngine(serverWorkspaceId, { ifIdle: true })` synchronously. Only a
   successful response returns `verified`; a failed reload is `failed` and
   blocks auth prime and submit.
3. A `409 reload_blocked_active_runs` maps to
   `verified-reload-required`. It never retries or falls back to an
   unconditional reload; the submit owner blocks it with a stable actionable
   error.
4. The send currently being prepared is not an active run. It becomes starting
   only when the server admits/registers it after freshness has returned. Thus
   its first submit waits for the reload acknowledgement, while a competing run
   either starts first and blocks the guarded reload or waits until that reload
   is complete.

This is an atomic acknowledgement of a successful server-owned reload for the
exact resolved workspace. It intentionally does not add a config revision/hash
to the existing PATCH/reload responses. If concurrent external config patching
becomes a real requirement, add revision correlation later; it is not required
to close the current send bypass. Do not treat a reload event, local app reload
banner, or a later config-file read as an acknowledgement.

## Tests

Add targeted conversation-service tests.

1. Managed server-owned prompt calls config freshness with the snapshotted
   target before runtime auth prime and before `submitConversation`.
2. A `verified` outcome continues to auth prime and submit.
3. Each non-verified outcome blocks submit and exposes the stable error:
   `failed`, `cancelled`, `skipped-pending`, and `verified-reload-required`.
4. A non-managed server-owned submit does not call the freshness gate.
5. The run-submit variant has the same ordering and blocking behavior.
6. A background send and an active-workspace switch use the resolved server
   workspace ID, never the subsequently active workspace.
7. Every config trace record created by a send freshness flight contains that
   send's trace ID. An active UI flight cannot satisfy this assertion with a
   trace-less record.
8. A patched config with no active run calls `reloadEngine` for the exact
   resolved workspace in `ifIdle` mode before auth prime and submit; a reload
   failure blocks it.
9. A `409 reload_blocked_active_runs` performs no reload, maps to
   `verified-reload-required`, and cannot submit.
10. Race test: patch config; hold send A before guarded reload; admit run B;
    release A. The server does not reload, A receives the stable blocked
    outcome, and A never submits. The reciprocal ordering test proves that if
    guarded reload wins, it completes before B's admission and before A submit.
11. Queue-drained and direct run admissions both use the same coordinator; no
    route can begin a workspace run outside the reload-if-idle gate.
12. Completed, failed, and aborted runs each release their reservation; a
    subsequent guarded reload succeeds. A duplicate terminal event calls the
    idempotent release without making the gate permanently blocked.
13. After restart, a workspace with a restored reservation rejects guarded
    reload until lifecycle reconciliation determines its terminal state; it is
    never assumed idle solely from an empty in-memory coordinator.

Keep the existing `send-runtime-readiness` test. It remains coverage for the
local runtime bridge; it is not coverage for the server-owned API route.

## Manual verification

From the initial browse session, send one normal managed-AI prompt. The trace
must show this order for the same send trace ID:

```text
submitConversationFromVesloWriteApi:managed-ai-config-freshness:start
managed-ai-config-sync:flight (reason=send-preflight)
managed-ai-config-sync:read-current
managed-ai-config-sync:engine-reload (only after a config patch)
submitConversationFromVesloWriteApi:managed-ai-config-freshness:end
submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime
submitConversationFromVesloWriteApi:submit
```

Every line above carries the same trace ID. For a stable config, one intentional
`send-preflight` read is allowed. A config change with no active run has exactly
one acknowledged `reloadEngine({ ifIdle: true })` call before submit. A config
change racing another active or starting run receives
`reload_blocked_active_runs`, ends in `verified-reload-required`, and cannot
submit. Ordinary active-workspace invalidations must still produce only
`completed-intent-skip`, never additional config reads.
