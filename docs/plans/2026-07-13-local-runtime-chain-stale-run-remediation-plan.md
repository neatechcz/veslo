---
title: Local Runtime Chain And Stale Run Remediation Plan
date: 2026-07-13
status: proposed
done: false
repository_snapshot: veslo-main at the 2026-07-13 fresh-profile and first-send audit
scope: local Tauri runtime status semantics and bounded terminal handling after an accepted conversation submit
related_plans:
  - docs/plans/2026-07-07-server-send-immediate-failure-audit-test-plan.md
  - docs/plans/2026-07-11-event-driven-conversation-run-lifecycle-implementation-plan.md
lrs00_fresh_profile_evidence_done: false
lrs01_connection_state_semantics_done: false
lrs02_engine_unreachable_terminal_policy_done: false
lrs03_terminal_ui_recovery_done: false
lrs04_desktop_regression_verification_done: false
---

# Local Runtime Chain And Stale Run Remediation Plan

## Decision

Fix the two current user-visible contract failures without waiting for the
broader event-driven lifecycle redesign:

1. distinguish a reachable Veslo server from a workspace runtime chain that is
   still starting, reconnecting, or unavailable;
2. when an accepted local run has a confirmed `engine_unreachable` lifecycle
   state, fail it through the existing durable server-owned terminal path after
   a short bounded confirmation window, rather than polling for roughly ten
   minutes;
3. let the existing run-id-scoped UI lifecycle release the composer and
   activity state from that terminal result. A red status indicator must never
   by itself manufacture a terminal UI state.

This is a KISS remediation. It does not replace normal lifecycle polling with
an event bridge, move durable ownership into the desktop app, or create a
second chat-session implementation.

## Audit Boundary And Evidence

The reported path is:

```text
fresh profile and no login
  -> create New Chat
  -> Veslo Server indicator is red
  -> send first prompt
  -> server appears to connect, then disconnect
  -> UI remains Answering indefinitely
```

The latest available manual runtime traces did not capture a permanently
stuck instance. They contain 19 submitted runs, all terminal `completed`; the
longest completed in about 22.5 seconds. Therefore this plan treats the exact
fresh-profile incident as still requiring an instrumented desktop
reproduction. It does not present the historical trace as proof of a process
crash.

Two source-level contracts are nevertheless confirmed:

1. The app's local connection check reports `disconnected` when the server is
   reachable but its runtime-chain health is not ready. That conflates server
   reachability with orchestrator/OpenCode workspace readiness. The write path
   can subsequently start or use the server and accept the prompt, so the red
   indicator is not a reliable statement that the server process is off.
2. The server lifecycle treats an `engine_unreachable` probe as stale and
   schedules another one-second reconcile. Stale-run failure is considered
   only at the 600-attempt budget. App SSE deliberately defers idle/error to
   the durable lifecycle owner for an exact active run, so the UI can correctly
   remain busy until that server terminal transition occurs. The result is a
   roughly ten-minute apparent infinite answer state after engine loss.

The existing targeted lifecycle tests currently encode this delayed failure
policy. Passing tests are evidence of the current behavior, not evidence that
the behavior meets this user-facing contract.

## Chat Versus Workspace Chat

There is one durable conversation/run model, not a separate backend
`ChatSession` model.

| Surface | Workspace ownership | Session state before first prompt | Runtime implication |
| --- | --- | --- | --- |
| New Chat | a newly created app-private scratch workspace | one `new-private` pending draft | the first prompt can cold-start both the private workspace and the local runtime chain |
| Workspace chat | selected local or remote workspace | ordinary conversation bound to that workspace | uses that workspace's directory, config, files, skills, and runtime |

Durable run and binding records are scoped by workspace plus conversation.
After the first prompt, a New Chat is an ordinary conversation in its private
workspace. The scratch-workspace cold start makes it a more visible trigger
for this incident, but it is not a different session protocol.

## Source Ownership

Start each slice from these current owners:

- `packages/app/src/app/context/veslo-server-connection.ts`: local server
  health polling, runtime-chain readiness gate, and connection-state exposure.
- `packages/app/src/app/lib/veslo-server/types.ts`: public app-facing server
  connection status shape.
- `packages/server/src/routes/health.ts`: server reachability and
  `runtimeChain` health payload.
- `packages/server/src/conversation-run-lifecycle-controller.ts`: durable
  reconcile, stale/no-progress policy, terminalization, and queue wake-up.
- `packages/server/src/server.ts`: lifecycle poll defaults and server wiring.
- `packages/orchestrator/src/run-registry.ts`: classification of
  `engine_unreachable` and other stale probe states.
- `packages/app/src/app/context/session-event-stream.ts` and
  `packages/app/src/app/context/session-lifecycle-recovery.ts`: exact-run UI
  handoff after a durable terminal result.
- `packages/app/src/app/context/pending-session-draft-controller.ts` and
  `packages/app/src/app/context/workspace-local-workspaces.ts`: private
  scratch-workspace creation; inspect only to preserve New Chat semantics.

## Non-Negotiable Contracts

1. **Server availability is not runtime readiness.** A healthy authenticated
   Veslo HTTP server remains reachable even if its local workspace runtime is
   starting or unavailable.
2. **The server remains terminal authority.** The app may display readiness
   and request recovery, but it must not mark durable runs failed or idle.
3. **Only a confirmed engine-loss state takes the short failure path.** A
   healthy long tool/model run must not be failed merely because it has been
   active for a while or because one transient health request timed out.
4. **One active run produces one terminal outcome.** Repeated probes, app
   reconnect, abort races, and late engine recovery must join existing durable
   terminalization rather than double-ingest or double-drain the queue.
5. **No fake success.** On terminal engine loss, preserve the submitted user
   message and expose a retryable failure; do not synthesize an assistant
   answer or silently leave the composer busy.
6. **No new session model.** New Chat continues to create one private scratch
   workspace and pending draft; workspace chat continues to use the same
   conversation/run contracts.

## Pre-Implementation Reproduction And Diagnostic Capture

Before changing policy, run the real desktop runtime with a clean development
profile using the repository testing preflight. Do not use raw Vite or a
browser-only UI server.

Capture one trace bundle for each case:

1. fresh profile -> New Chat -> send a short prompt while the local runtime is
   initially stopped;
2. existing local workspace -> send the same short prompt;
3. accepted prompt followed by a controlled local engine/runtime-chain loss;
4. if practical, a remote workspace control case.

For every capture record: workspace id, conversation id, run id, OpenCode
session id, client message id, visible status label, `/health` result,
`runtimeChain` result, each lifecycle probe disposition, terminal outcome, and
queue state. Do not include prompt content in durable trace output.

Stop and reclassify the plan if the fresh-profile failure is instead a
deterministic auth, workspace-registration, or submit-route failure. Those
are different incident families and must not be hidden by a stale-run timer
change.

## Implementation Slices

### LRS00 — Freeze the reproduction contract

Status: `planned`

**Owner:** desktop E2E/runtime evidence plus focused source-owner tests

1. Add a deterministic diagnostic seam or test fixture only if needed to
   make the runtime chain unavailable after an accepted submit. It must not
   alter production retry behavior.
2. Capture the four cases above in the Tauri desktop runtime and classify each
   boundary: server unreachable, server reachable/runtime starting, accepted
   then engine unreachable, or successful terminal run.
3. Record the current timings: first server health, first runtime-chain-ready
   result, accepted submit, first stale probe, terminal transition, and UI
   activity release.

Acceptance:

- The incident is represented by durable ids and correlated traces, not only
  by a red icon or a user report.
- The test/reproduction can distinguish server-process loss from engine-chain
  loss.
- No code-policy slice starts until the reproduction is classified.

### LRS01 — Expose two truthful local connection dimensions

Status: `planned`

**Owner:** app connection context and the existing server health response

Keep the current health endpoint as the source of truth, but split what the
app exposes and renders:

- `serverReachability`: authenticated Veslo server request succeeded or
  failed;
- `runtimeReadiness`: `ready`, `starting`, `degraded`, or `unavailable`, with
  the existing runtime-chain reason retained for diagnostics.

The header/status control must say that the runtime is starting or unavailable
when that is the failure, rather than presenting the whole server as
disconnected. Existing callers that genuinely require a ready local runtime
must opt into `runtimeReadiness === ready`; passive reads and server-only
operations retain their current server-reachability behavior.

Do not make a status-poll transition submit a prompt, retry a prompt, or clear
the active UI run.

Focused tests:

1. reachable health plus `runtime_chain_ready` reports reachable/ready;
2. reachable health plus `orchestrator_unavailable`, `proxy_unreachable`, or
   runtime starting reports reachable with the corresponding non-ready state;
3. an unreachable authenticated health request reports server unreachable;
4. a first fresh-profile observation does not need a previous green state to
   be truthful;
5. the send path does not treat a visual non-ready state as proof that a
   previously accepted run is terminal.

Acceptance:

- A red/failed server label is reserved for an actually unreachable server.
- A user can distinguish "server is off" from "server is up, runtime is
  starting/reconnecting".
- Existing transient-error stabilization does not hide a sustained runtime
  failure or falsely turn it into server loss.

### LRS02 — Give confirmed engine loss a short bounded terminal policy

Status: `planned`

**Owner:** server lifecycle controller, using the existing orchestrator probe
classification and terminalization path

Replace only the `engine_unreachable` stale branch's unbounded user-facing
wait. Preserve normal polling for an active engine and preserve the broader
event-driven plan as a future normal-path improvement.

1. Define one explicit, non-configurable initial policy in the lifecycle
   controller: a run may take the fast terminal path only when the same active
   run receives a confirmed `engine_unreachable` result across a short bounded
   confirmation window. Start with two correlated probes and a total deadline
   no longer than 15 seconds; choose the exact delays from LRS00 evidence and
   encode them as named constants.
2. On confirmation, use the existing server-owned failure/terminalization
   operation. It must unregister active gateway state, persist one retryable
   failure reason, and wake the conversation queue through the existing
   idempotent finalization path.
3. Keep the existing longer stale/no-progress budget as a recovery backstop
   for other ambiguous stale states. Do not globally shorten it as a proxy for
   engine loss.
4. Fence the confirmation by workspace id, conversation id, run id, engine
   owner/session identity, and lifecycle generation/current-row check. A late
   failure probe cannot terminalize a replaced or already completed run.
5. Use one specific user-safe failure code/reason for this path, such as
   `local_runtime_engine_unreachable`; preserve the lower-level reason in
   diagnostics only.

Required focused tests:

1. one `engine_unreachable` observation remains non-terminal during the
   confirmation window;
2. confirmed repeated engine loss terminalizes once before the 600-attempt
   backstop, persists the retryable reason, and wakes one queued successor;
3. a healthy long-running status never takes this path;
4. a transient probe error, changed run id, late completed status, abort, and
   duplicate scheduled reconcile cannot produce duplicate terminalization;
5. the old test asserting stale polling until the full budget is replaced with
   the new reason-specific contract, not left contradictory beside it.

Acceptance:

- A local engine loss after accepted submit cannot leave the durable run active
  for roughly ten minutes.
- One terminal failure causes at most one transcript/queue finalization.
- A later submit is no longer permanently blocked behind the failed run.

### LRS03 — Verify exact-run UI release and retry presentation

Status: `planned`

**Owner:** app session event/lifecycle recovery and conversation send result
presentation

Do not introduce a second client-side watchdog. Verify and narrowly extend
the existing exact-run terminal handoff as required:

1. when the server returns the new terminal failure, the matching UI run moves
   from submitted/running to an error or retryable-idle presentation exactly
   once;
2. the original user draft/message remains visible and retryable according to
   the existing send contract;
3. a `session.idle` SSE frame remains deferred while the durable run is active,
   but a completed durable terminal failure promptly releases the activity
   projection;
4. status polling changes alone cannot reset a different session or a pending
   private draft.

Focused tests:

1. exact run id terminal failure releases the spinner and displays the
   retryable error;
2. stale or mismatched session/run terminal events do not release the active
   session;
3. app reconnect during the confirmation window joins the server result and
   does not create a parallel recovery loop;
4. New Chat pending-draft materialization retains its workspace-scoped session
   identity through the failure and retry.

Acceptance:

- The visible Answering state ends within the LRS02 bound once engine loss is
  confirmed.
- The user can retry without creating a duplicate prompt or a duplicate
  private workspace.
- The app has no durable terminal writer.

### LRS04 — Desktop regression verification and documentation

Status: `planned`

**Owner:** real Tauri desktop runtime; server/app focused tests support it

Run the repository desktop preflight and then a Tauri Pilot scenario that:

1. starts from a clean profile;
2. creates New Chat while the runtime is cold;
3. sends a short prompt and observes server reachability and runtime readiness
   independently;
4. verifies one normal successful response;
5. induces the LRS00 controlled engine-loss case after accepted submit and
   verifies the bounded retryable terminal result;
6. retries once and verifies one submitted successor, with no duplicate run or
   scratch workspace;
7. repeats the normal send in an existing local workspace chat.

Required codebase verification:

```powershell
bun test packages/server/src/tests/conversation-run-lifecycle-controller.test.ts --timeout 30000
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm <focused-connection-and-lifecycle-tests>
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

If `packages/server/src` changes, rebuild the server binary before relying on
the orchestrator-backed desktop result. Record the actual Tauri Pilot command,
fresh runtime trace directory, and observed timing in the completion note.

Completion checklist:

- [ ] Fresh New Chat distinguishes reachable server from runtime warming.
- [ ] Accepted local run with confirmed engine loss ends retryably within the
  bounded policy, not the 600-poll budget.
- [ ] Normal long-running work is not falsely failed.
- [ ] Queue and transcript finalization remain idempotent.
- [ ] Workspace chat and New Chat retain one workspace-scoped conversation
  model.
- [ ] Targeted tests, real desktop scenario, typechecks, and diff check pass.

## Explicit Non-Goals

- Implementing the orchestrator-owned event bridge from the 2026-07-11 plan.
- Replacing all lifecycle polling or queue-drain logic.
- Reworking remote workspace lifecycle ownership.
- Changing private scratch-workspace creation, login persistence, or chat data
  deletion semantics.
- Treating one slow provider response as an engine-loss failure.
- Hiding failures by changing the UI spinner without a durable server terminal
  result.

## Relationship To Existing Plans

The 2026-07-07 immediate-send plan already added stale/no-progress
terminalization, but its full poll-budget behavior is the remaining UX gap
addressed here. This plan refines that narrow reason-specific policy.

The 2026-07-11 event-driven lifecycle plan remains the long-term way to remove
normal-path polling. It is not a prerequisite for this remediation. Any future
event-driven implementation must preserve LRS01's two-dimensional status
semantics and LRS02's bounded engine-loss user contract.
