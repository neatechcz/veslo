---
title: One Workspace, One Engine, Many Concurrent Conversations
date: 2026-07-22
status: complete
done: true
scope: canonical workspace runtime identity, one-engine-per-workspace topology, and concurrent conversation lifecycle
depends_on:
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/testing-playbook.md
  - docs/dev/engineering-quality-gates.md
  - docs/plans/2026-07-20-managed-ai-send-lifecycle-remediation-plan.md
  - docs/plans/2026-07-21-skill-runtime-view-cold-start-implementation-plan.md
  - docs/plans/2026-07-21-shared-skill-view-self-deadlock-and-projection-migration-plan.md
---

# One Workspace, One Engine, Many Concurrent Conversations

## Executive decision

Adopt the following runtime model as the Veslo default:

```text
one Veslo workspace
  -> one logical OpenCode engine slot
  -> one OpenCode process generation at a time
  -> many OpenCode sessions
  -> many Veslo conversations
  -> at most one active run per conversation
  -> multiple active runs across the same workspace
```

The engine is shared by conversations **inside one workspace**, but never by
different workspaces. The current `pooled-per-workspace` topology is the
closest existing implementation and should become the authoritative product
path. The current `shared-unsandboxed` process-wide topology should be removed
from the normal runtime path or retained only as an explicit development and
diagnostic compatibility mode until it has a separately justified contract.

“One engine” means one logical engine slot per canonical workspace. The slot
may be suspended when idle and later recreated. A recreated process is a new
engine generation; it must not create new conversation identity or silently
reuse an old process owner.

## Goal

Make ten or more conversations in the same workspace behave as independent
session lifecycles while sharing one workspace-bound OpenCode process:

- each conversation has its own OpenCode session;
- each prompt attempt has its own Veslo run identity;
- events, transcripts, permissions, questions, aborts, retries, and errors are
  routed to the correct conversation;
- one active conversation cannot block unrelated conversations in the same
  workspace;
- one engine crash or restart is attributed to every affected run without
  mixing identities or producing stale “healthy” state;
- workspace skill/config/runtime state is shared by all sessions in that
  workspace and cannot leak across workspace boundaries.

## Out of scope

- Tauri Pilot and real-desktop acceptance automation; this implementation is
  verified through server, orchestrator, app event-stream, Rust, and
  non-Tauri bundled-runtime gates.
- allowing one engine process to serve multiple workspaces;
- changing OpenCode's internal session model;
- introducing a new conversation database when the existing binding and run
  stores can be made authoritative;
- making one conversation execute multiple simultaneous prompts;
- changing managed-AI provider policy or model selection semantics;
- changing transcript rendering or message/part identity semantics except where
  required to preserve session routing;
- enabling directory-scoped shared skill hot reload before the bundled
  OpenCode compatibility gate passes;
- unrelated MCP, WSL, document-runtime, or release work.

## Current implementation baseline

The live checkout already contains most of the necessary pieces, but their
contracts are not yet expressed as one end-to-end identity model.

### Existing behavior that can be reused

- The orchestrator engine pool is keyed by workspace ID and normally owns at
  most one engine process per workspace.
- The pool already has idle suspension, health checks, restart handling, LRU
  limits, and an active-work guard.
- The server run store has a uniqueness constraint allowing at most one active
  run per `(workspace, conversation)` while allowing active runs in different
  conversations within the same workspace.
- The queue store is also conversation-scoped and records reserved run IDs,
  queue item IDs, active run IDs, client message IDs, and directory.
- Conversation bindings map a Veslo conversation ID to an OpenCode session ID
  using workspace and directory scope.
- The app event stream already consumes workspace-level events and filters
  session-specific updates using OpenCode session IDs.
- The orchestrator run registry tracks process ownership using an engine owner
  ID plus PID, process start time, and base URL.
- The server submit path already forwards workspace, conversation, run,
  OpenCode session, client message, trace, and skill-view information through
  the OpenCode proxy path.

### Current topology that must be clarified

The checkout also contains a second topology, `shared-unsandboxed`, where one
process-wide engine is selected for multiple workspaces. That topology has a
process-wide skill view, a global engine owner, and a workspace-switch guard.
It is incompatible with the target product contract because workspace A and B
can require different runtime skill/config views and because one active run in
the process can affect another workspace's ability to switch views.

The target plan therefore treats `shared-unsandboxed` as a compatibility mode,
not as a second supported product behavior.

## Locked decisions before implementation

The following decisions close the blockers found in the review. They are
implementation gates, not follow-up cleanup:

1. `pooled-per-workspace` becomes the normal desktop topology. The current
   fresh Windows/macOS default for `shared-unsandboxed` must be migrated to the
   workspace pool. Existing persisted preferences are migrated on first start;
   an explicit development override remains available only with a visible
   diagnostic. Settings, runtime diagnostics, startup instructions, testing
   guidance, and the runtime architecture document must all describe the same
   default before desktop acceptance begins.
2. `engineOwnerId` is a process-generation token, never a workspace ID. A
   separate stable `engineSlotId` is derived from `workspaceId`. Every spawn
   creates a fresh opaque owner token, including a restart of the same
   workspace; the token is not derived from workspace ID, PID, or URL.
3. A run starts with `engineOwnerState=pending`. The selected generation is
   attached atomically before any upstream OpenCode dispatch. A missing or
   rejected attachment is fail-closed: no upstream request is sent. Engine-loss
   reconciliation matches the exact generation token plus PID, start time, and
   base URL; a workspace ID alone is insufficient. If the generation is lost
   while the run is still pending and no upstream request was sent, the server
   requeues the same lifecycle identity once; after the bounded retry, it
   terminalizes as `owner_attach_failed`.
4. `clientMessageId` is workspace-wide. The submit-attempt store is the
   authority for `(workspaceId, clientMessageId, requestHash)`, and the queue
   must enforce the same idempotency scope. Same key plus same hash replays or
   joins the original attempt; same key plus a different hash returns a
   structured `409 idempotency_conflict`, including when the conversation ID
   differs. The canonical request hash includes the resolved conversation
   target whenever one is present, so a client-message key cannot silently
   attach to another conversation. `queueItemId` remains only the queue-row
   identity.
5. `opencodeSessionId` is the canonical public lifecycle name. The existing
   `engineSessionId` database field may remain as a migration-compatible storage
   column, but adapters must expose one canonical name and no caller may treat
   both as independent IDs. `reservedRunId` is lifecycle-bearing: it is
   allocated before queue admission and remains the same run identity when the
   item becomes active.
6. SSE has two separate identity mechanisms. `Last-Event-ID` is a stream-level
   cursor owned by one workspace SSE connection and reconnect generation.
   Per-session/part duplicate suppression is a separate event-level cache. An
   unknown session may not mutate UI state: a `session.created` event is
   accepted only after authoritative workspace binding/containment validation;
   all other unknown-session events are ignored fail-closed and trigger a
   workspace session refresh. The current selected-session foreground fallback
   is removed.
7. The skill/config fallback and projection migration are hard prerequisites.
   The concurrency plan is not verified while bundled OpenCode lacks a safe
   per-directory hot-update contract. Fallback owner timing, projection
   migration, revision handshake, and structured `409` propagation to the UI
   must be green first.
8. Conversation binding is created before the first run. The server persists
   the workspace/directory/OpenCode-session binding, then allocates the run;
   a deterministic submit-attempt session ID is retained only for the legacy
   materialization path and must converge to that same binding.
9. The orchestrator is authoritative for engine generation/readiness, the
   server lifecycle controller is authoritative for run terminal status, and
   the app is a projection. Engine-loss is reported by the orchestrator but
   terminalization/requeue is committed by the server with the exact owner
   tuple.
   The concrete notification contract is `POST
   /internal/orchestrator/engine-loss` on the server, authenticated with
   `X-Veslo-Orchestrator-Token` and carrying `schema=veslo-engine-loss/v1`,
   `eventId`, workspace/slot/owner identity, reason, and terminalized
   `runIds`. The server deduplicates by `eventId`, releases only matching
   workspace reservations, and schedules queue drain; the orchestrator retries
   delivery with bounded backoff and remains locally authoritative if the
   callback is unavailable.
10. A recoverable process restart preserves the OpenCode session binding by
    preserving the workspace state/config root. If the binding cannot be
    restored, the server marks the session/run as explicitly unrecoverable;
    it never silently creates a replacement session under the old identity.

The implementation order below follows these decisions. No acceptance result
may be used to mark this plan complete while one of them is still open.

## Identity contract

New cross-boundary code must not use an unqualified `sessionId`, `runId`, or
`workspaceId` when the value could belong to another layer. Use explicit names
in request types, trace payloads, and owner functions.

| Identity | Owner | Lifetime | Meaning | Must never be used as |
| --- | --- | --- | --- | --- |
| `workspaceId` | Veslo server/runtime registry | Workspace lifetime | Canonical workspace routing key | Engine process ID or conversation ID |
| workspace path/root | Workspace registry | Workspace lifetime | Filesystem authority and engine working root | Stable identity by itself |
| `directory` | OpenCode request/session context | Session/request lifetime | Validated directory inside the workspace root | Workspace identity |
| `uiSessionId` | App | UI lifetime | Local selected-session alias used by SolidJS state | Canonical conversation identity |
| `conversationId` | Veslo server binding store | Conversation lifetime | Stable Veslo identity, normally `conv-*` | OpenCode process identity |
| `opencodeSessionId` | OpenCode, persisted by Veslo binding | Conversation/session lifetime | Upstream session target, normally `ses_*` | Veslo run identity |
| `clientMessageId` | App submit workflow | One submit attempt/retry window | Idempotency key for the original user action | Active engine owner |
| `runId` | Server lifecycle controller | One accepted prompt/command run | Lifecycle and abort/status identity | OpenCode session identity |
| `reservedRunId` | Server queue | Queued run lifetime | Run identity allocated before admission | Proof that OpenCode accepted work |
| `queueItemId` | Server queue store | Queue row lifetime | Queue persistence identity | OpenCode run identity |
| `engineSlotId` | Orchestrator | Workspace lifetime | Stable one-engine slot key derived from `workspaceId` | Process generation identity |
| `engineOwnerId` | Orchestrator | Process generation lifetime | Fresh opaque token created at every spawn and used for run reconciliation | Workspace identity or slot identity |
| engine PID/start time/base URL | Orchestrator | Process generation lifetime | Generation fence against stale process state | Conversation identity |
| orchestrator process run ID | Orchestrator daemon | Daemon lifetime | Diagnostic/service instance identity | Conversation `runId` |
| `traceId` / send trace ID | App/server/orchestrator diagnostics | One traced request | Correlation only | Admission or routing authority |
| OpenCode `messageID` / `partID` | OpenCode transcript/event model | Message/part lifetime | Transcript data identity | Run ownership |

### Required identity relationships

```text
workspaceId
  -> engineSlotId
  -> one current engine process generation
  -> many conversation bindings
  -> many OpenCode session IDs
  -> many run IDs

conversationId <-> opencodeSessionId
workspaceId + clientMessageId + requestHash -> one idempotent submit attempt
conversationId + runId -> one lifecycle run
runId + engineOwner generation -> one process ownership record
```

The server must reject or diagnose any request where these relationships do
not agree. In particular:

- a conversation binding from workspace A must not be resolved under workspace
  B;
- an OpenCode session ID must not be accepted without a workspace and
  directory scope;
- a run ID must not be used to address a different conversation;
- a stale engine owner from a previous process generation must not terminalize
  a newly recreated engine's runs;
- a UI selected session must not be used as a workspace fallback when its
  stored scope is missing or contradictory.

## Target runtime topology

### Workspace engine slot

The orchestrator owns a registry keyed by canonical `workspaceId`:

```text
WorkspaceEngineSlot {
  workspaceId
  workspaceRoot
  configRoot
  state: absent | starting | ready | idle | suspended | crashed
  processGeneration: {
    engineOwnerId
    pid
    startedAt
    baseUrl
  } | null
  activeRunCount
  activeSessionCount
  runtimeSkillRevision
}
```

There must be no second live slot for the same canonical workspace. Legacy
workspace IDs may be accepted only during migration and must converge to the
canonical slot before engine lookup. `engineOwnerId` is generated after the
spawn succeeds and is persisted with the process snapshot; it is never derived
from `workspaceId`. During a generation transition, the slot may temporarily
have a pending replacement, but dispatch remains fenced to the attached current
generation.

### Conversations and OpenCode sessions

Every durable Veslo conversation maps to exactly one OpenCode session in the
workspace/directory binding scope. Ten conversations therefore mean ten
distinct OpenCode session IDs, not ten engines.

OpenCode's current session contract pins a session to its directory/workspace
context. The bundled OpenCode version must be tested explicitly, but the Veslo
contract should preserve that pinning:

- store the validated directory in the conversation binding;
- resolve the binding before every read, write, abort, revert, and transcript
  operation;
- never retarget an existing OpenCode session because another conversation was
  opened in the same engine;
- allow multiple directories only when they are contained by the same Veslo
  workspace root and the skill/config contract remains workspace-wide.

### Concurrency rule

The admission boundary is conversation-scoped, not engine-scoped:

- conversation A and conversation B may both have active runs;
- two sends for conversation A are either idempotently replayed, queued, or
  rejected according to the existing conversation policy;
- an abort for A must not abort B;
- engine-level restart/reload is blocked while any workspace run is active;
- engine health failure is attributed to all active runs owned by that process
  generation.

## Phase 0 — Freeze the contract, migrate the topology, and audit identity

### Deliverables

- Add a canonical identity matrix to runtime diagnostics and developer docs.
- Identify every caller that currently accepts a bare `sessionId`, `runId`, or
  workspace fallback.
- Define a single normalized workspace identity helper shared by app/server and
  orchestrator boundaries.
- Define the process-generation owner shape once and reuse it in run storage,
  lifecycle registration, engine pool events, and recovery.
- Decide and implement the desktop migration from fresh-profile
  `shared-unsandboxed` to `pooled-per-workspace`: persisted preferences,
  environment precedence, Settings copy, runtime diagnostics, and tests.
- Define lifecycle statuses for `pending`, `queued`, `accepted`, `submitted`,
  `running`, `completed`, `failed`, `aborted`, `rejected`, `conflict`, and
  `engine_lost`;
  document which transitions are legal and which are terminal.
- Define the one idempotency state machine for submit-attempt, queue replay,
  timeout replay, and payload conflict before changing either store.
- Define the non-Tauri runtime verification harness and its artifact contract:
  `packages/orchestrator/scripts/workspace-one-engine-many-conversations.integration.mjs`
  is invoked only after the compiled server and orchestrator are built and
  writes a machine-readable result under the run artifact directory.

### Audit targets

- App workspace activation, session routing, conversation scope cache, send
  correlation, provisional session creation, abort, retry, transcript recovery,
  and SSE reconciliation.
- Server conversation create/read/submit/run/abort routes, binding resolution,
  submit-attempt idempotency, queue admission, lifecycle reconciliation,
  transcript ingest, OpenCode proxy headers, and workspace registration.
- Orchestrator workspace registration, engine pool lookup, engine spawn and
  restart, run registry ownership, lifecycle HTTP routes, proxy target
  selection, SSE forwarding, and skill revision handoff.
- Desktop/Tauri runtime preparation, engine info snapshots, Rust SSE bridge,
  engine stop/restart, and stale local runtime recovery.
- OpenCode session create/get/prompt/abort/event behavior using the bundled
  binary, not only current upstream documentation.

### Questions that must be answered before implementation

- Does the queue uniqueness migration preserve the locked workspace-wide
  idempotency contract for all existing rows?
- Does the materialization path converge to the binding-first decision without
  leaving a deterministic submit-attempt session as a second identity?
- Does OpenCode allow concurrent prompts in different sessions on one process
  with the bundled version, and how are their SSE events distinguished?
- Does the restart test prove the locked state/config-root preservation and the
  explicit unrecoverable path?
- Are all requested directories guaranteed to remain inside the workspace root?
- Does the UI consume the orchestrator generation/readiness snapshot while the
  server remains the lifecycle status authority?
- Does every final transition pass through the server lifecycle controller,
  including engine-loss reports from the orchestrator?
- Which exact lifecycle record owns `reservedRunId` while queued, and how is
  that same ID carried into the active run without allocating a second ID?
- Which existing `engineSessionId` callers are storage adapters only, and where
  is the public `opencodeSessionId` contract enforced?
- Which server event or binding snapshot authorizes a new OpenCode session ID
  before the app accepts its first event?
- Does the documented runtime command start the compiled server/orchestrator
  pair, inject a deterministic provider, force generation loss, and emit the
  oracle artifact without a desktop-specific flow?

### Acceptance criteria

- No unresolved identity alias remains in the reviewed send, abort, recovery,
  and event paths.
- The audit can trace one sample request through every layer using explicit
  names without guessing whether `sessionId` means UI, Veslo, or OpenCode.
- The exact bundled OpenCode concurrency and restart behavior is recorded.
- The fresh-profile topology migration and the existing-config migration are
  both covered by automated preference tests and a runtime-diagnostics check.
- The submit-attempt and queue stores agree on conflict/replay behavior for
  same-key/same-payload, same-key/different-payload, timeout replay, and
  cross-conversation reuse.
- The runtime oracle has a reproducible command, deterministic provider,
  forced-crash hook, exit code, and artifact schema.

## Phase 1 — Make pooled-per-workspace the canonical engine topology

### Implementation

- Make `pooled-per-workspace` the default and only normal local topology.
- Keep `shared-unsandboxed` behind an explicit development-only flag, with a
  loud diagnostic and no product path depending on it.
- Change the fresh Windows/macOS preference from shared-unsandboxed to the
  workspace pool. On first startup, migrate an existing implicit/default
  shared preference to pooled; preserve an explicitly selected diagnostic
  override only when its source is recorded as explicit. Show the effective
  topology and override source in Settings/runtime diagnostics.
- Version the persisted preference migration. Legacy files that contain only
  the old boolean have no reliable way to distinguish an implicit platform
  default from an explicit opt-in, so migrate them to pooled and require a
  fresh explicit diagnostic opt-in. New persisted data records
  `topologySource=default|migrated|explicit-diagnostic`; environment opt-in
  has precedence only when both shared-engine flags are present and is never
  silently persisted.
- Add preference tests for fresh Windows/macOS, legacy boolean files, explicit
  diagnostic opt-in, partial environment flags, and downgrade/restart after
  migration. A partial environment pair resolves to pooled and emits a
  diagnostic rather than enabling the shared engine.
- Update the canonical architecture, startup, testing, and quality-gate docs
  in the same change as the preference migration. The old default must not
  remain documented while the new runtime is under acceptance.
- Ensure workspace registration, activation, proxy lookup, lifecycle routes,
  health, and shutdown all use the canonical workspace ID.
- Make the engine pool's one-entry-per-workspace invariant explicit and tested.
- Separate stable `engineSlotId` from process-generation `engineOwnerId`.
- Generate a fresh opaque owner token for every successful spawn and expose it
  in engine snapshots, lifecycle registration, traces, and diagnostics.
- Add `engineOwnerState: pending | attached | lost` to the lifecycle record.
  Register a run with `pending` owner state before engine selection. After
  selecting a ready engine, atomically compare-and-set the record from
  `pending` to `attached` using the exact workspace, `engineSlotId`, owner
  token, PID, start time, and base URL immediately before upstream dispatch.
- Make owner attachment idempotent only for the same run and the same complete
  owner tuple. A second attach to a different generation returns
  `owner_attach_conflict`; a missing, stale, or already-lost attach returns
  `owner_attach_failed`. Both are hard failures and prevent the upstream
  request. The lifecycle record must be terminalized or safely requeued by one
  documented owner, never by the proxy after it has skipped dispatch.
- On process recreation, issue a new generation fence and reconcile only runs
  whose complete owner tuple matches the lost generation. Workspace ID alone
  must never authorize reconciliation. `markEngineLost` only considers
  `engineOwnerState=attached`; pending records follow the bounded requeue
  policy and cannot be swept as work that reached OpenCode.
- Prevent idle suspension, LRU eviction, manual reload, or workspace removal
  while that workspace has an active or reconciliation-pending run.
- Preserve the existing max-engine limit as a limit on simultaneously alive
  workspace processes, not as a limit on conversations within one engine.

### Tests

- Two simultaneous `ensure(workspaceId)` calls return the same engine process.
- Repeated activation does not spawn a second process for the same workspace.
- A second workspace gets a different process and owner.
- Ten sessions in one workspace do not increase engine count above one.
- Engine recreation changes process-generation identity but not workspace,
  conversation, or OpenCode session identity.
- A stale old owner cannot mark a new generation's runs as lost.
- A pending run cannot reach OpenCode without an atomic owner attachment.
- An attach failure produces a structured lifecycle error and zero upstream
  requests for that run.
- A duplicate attach of the same tuple is harmless; an attach of a different
  generation cannot overwrite an attached record.
- A pending run at generation loss is not treated as an active run of the lost
  generation and follows the explicit requeue/failure policy.
- Two concurrent dispatches cannot attach the same run to different owner
  generations.

## Phase 2 — Normalize conversation/session binding

### Implementation

- Make the binding store the authoritative mapping:

  ```text
  (workspaceId, directory, opencodeSessionId)
    -> conversationId
  ```

- Return a complete scope object from every server conversation lookup:
  `workspaceId`, `directory`, `conversationId`, `opencodeSessionId`.
- Make app caches store the same scope object and keep UI session aliases
  separate.
- Remove fallback resolution that silently substitutes the active workspace or
  selected UI session when an exact binding exists but disagrees.
- Define the new-conversation path once: create/bind the OpenCode session,
  persist the binding, return both IDs, then submit the first run against that
  binding.
- Make branch/subagent parent relationships explicit in both Veslo and
  OpenCode IDs.
- Validate directory containment and canonical path variants at the binding
  boundary.
- Make submit-attempt idempotency workspace-wide: `(workspaceId,
  clientMessageId, requestHash)` is authoritative. Align queue uniqueness with
  `(workspaceId, clientMessageId)` and migrate existing conversation-scoped
  uniqueness without silently merging rows.
- Before creating the new unique index, run one transaction that materializes a
  request hash for every non-empty queued `clientMessageId`, keeps the earliest
  canonical row for each `(workspaceId, clientMessageId)`, and marks later
  duplicates as terminal `conflict` with `idempotency_conflict` metadata. Do
  not execute or delete those rows. Null/empty client IDs remain outside the
  idempotency index.
- Make `requestHash` mandatory for non-empty queue client IDs and compare it
  across the workspace before enqueue. Same hash joins/replays the canonical
  row only for the same conversation target; a different hash, including a
  different conversation target, returns `409 idempotency_conflict`.
- Keep `activeRunId` semantically separate: it references the currently active
  run that blocks this conversation's queue drain, while `reservedRunId` is the
  queued item's own lifecycle identity. It may therefore differ from
  `reservedRunId` and must be workspace/conversation scoped.
- Define the replay contract: same key and hash replays or joins the original
  materialized/queued/submitted result; an in-flight `started` or
  `materializing` attempt is joined/reconciled; a timeout retry never creates a
  second session or provider request; a different hash, including from another
  conversation, returns structured `409 idempotency_conflict`.
- Allocate `reservedRunId` before queue admission and carry that exact value
  into the active run. `runId` and `reservedRunId` are two lifecycle views of
  one run, not two generated identities.
- Rename the public lifecycle contract from `engineSessionId` to
  `opencodeSessionId`; keep the database column only behind an explicit
  compatibility adapter and migration. Rename the server-to-orchestrator
  registration payload first, then keep a one-way read adapter for old stored
  records. No new HTTP payload, trace, queue item, or app state may emit
  `engineSessionId`; add a contract test that fails on that outgoing field.

### Tests

- Create ten conversations in one workspace and verify ten unique bindings.
- Read, submit, abort, revert, and recover using either conversation ID or
  OpenCode session ID and get the same target.
- The same OpenCode session ID under another workspace is rejected.
- A directory spelling variant resolves to the same binding; an out-of-root
  directory is rejected.
- Retrying one submit with the same client message ID returns the original
  result and does not create another session or run.
- Reusing one client message ID with another payload or another conversation
  returns `409 idempotency_conflict`; it never returns the original
  conversation's result under a new target.
- Migrating duplicate queue rows never sends the later row upstream and leaves
  an auditable terminal conflict record.
- A timeout retry joins the existing attempt and preserves its original
  `reservedRunId`, `runId`, conversation, and OpenCode session.
- Two different conversations can use different client message IDs and run in
  parallel.

## Phase 3 — Make the app multi-conversation-safe inside one workspace

### Implementation

- Keep workspace routing as the engine boundary and session routing as the
  conversation boundary.
- Ensure send preflight, runtime preparation, and server client selection use
  the target workspace from the conversation scope, not only the active UI
  workspace.
- Keep one workspace-level OpenCode SSE connection where possible, but ensure
  every event is filtered by the authoritative OpenCode session ID before it
  mutates messages, parts, status, permissions, questions, or lifecycle state.
- Ensure `workspaceSessionIds` is populated from the complete workspace session
  list and from session-created events, not only the selected session.
- Keep the `Last-Event-ID` cursor at stream level: one cursor per workspace SSE
  connection and reconnect generation. Keep duplicate suppression separate at
  event level, keyed by stream generation, source workspace, OpenCode session,
  message/part, and upstream event ID where available.
- Remove the foreground selected-session fallback for unknown IDs. Accept a
  `session.created` event only after server-authoritative workspace binding and
  directory-containment validation. The server must emit either a bound-session
  authorization envelope containing `workspaceId`, `opencodeSessionId`, and a
  binding revision, or no app-visible session event. Ignore other unknown-
  session data fail-closed, emit a diagnostic, and refresh the authoritative
  workspace session list. The app must never authorize a raw upstream event
  merely because its source workspace is active.
- Do not replace an active workspace stream merely because the selected
  conversation changed.
- When one conversation is aborted or errors, leave other conversations'
  composer state, busy state, transcript, and permissions untouched.
- Expose per-session busy/status state even though engine readiness is
  workspace-scoped.

### Tests

- Start ten sessions and receive interleaved `message.updated`,
  `message.part.updated`, `session.status`, `session.idle`, and `session.error`
  events; each update lands only in its own session.
- Switch the selected conversation while another conversation is generating;
  the background response continues and is not rerouted.
- Reconnect the workspace SSE stream while multiple sessions are active and
  verify that the stream-level cursor resumes delivery while the independent
  session/part duplicate cache suppresses only repeated events.
- Inject an unknown session event and verify it cannot mutate the selected or
  foreground conversation; verify a raw upstream `session.created` without a
  binding envelope is rejected, while an authorized event with a matching
  workspace/session/revision is admitted.
- Abort A while B streams output; A becomes aborted and B remains running.
- A session error in A does not set B idle or show an A error in B.

## Phase 4 — Make server admission explicitly workspace-capable

### Implementation

- Preserve the existing one-active-run-per-conversation invariant.
- Remove any accidental workspace-global admission check that blocks unrelated
  conversations.
- Keep active-run uniqueness scoped to the conversation, but make submit
  idempotency and queue duplicate detection workspace-wide by
  `clientMessageId`. This prevents a retry from another UI route or
  conversation from creating a second provider request.
- Add workspace-level diagnostics:
  active conversation count, active run count, queued count, engine owner,
  engine generation, and runtime skill revision.
- Define fairness/backpressure for ten concurrent runs:
  bounded request body/attachment sizes, queue limits, provider limits, and
  clear status codes for accepted, queued, blocked, and failed.
- Preserve structured `409` errors for same-conversation active conflicts and
  shared/runtime stale conditions. Do not collapse them into generic OpenCode
  `502` errors.
- Ensure every accepted run registers with the lifecycle owner using the exact
  workspace, conversation, OpenCode session, run, client message, directory,
  and pending/attached engine generation fields.
- Ensure release/terminalization happens on completed, failed, aborted,
  rejected, queue-drain failure, engine loss, and server shutdown paths.
- Preserve structured error classes through the server response and app state:
  `idempotency_conflict`, `active_run_conflict`, `owner_attach_failed`,
  `engine_lost`, and `skill_view_conflict` must not be flattened into a generic
  upstream `502`.

### Tests

- Ten concurrent conversations are accepted or queued independently.
- Two submits for one conversation follow the documented idempotency/queue
  policy and do not violate the active-run uniqueness constraint.
- One queued conversation drains after its own active run ends without waiting
  for unrelated conversations.
- Engine reload is blocked while any workspace run is active.
- Engine loss terminalizes all and only the runs owned by that process
  generation.
- A retry after a network timeout is idempotent and does not duplicate provider
  work.
- A queued run exposes and accepts `reservedRunId` for status, abort, replay,
  recovery, and reconciliation before activation.

## Phase 5 — Align orchestrator proxy and OpenCode dispatch

### Implementation

- Resolve every non-passive proxy request through canonical workspace ID and
  workspace root before selecting the engine.
- Use one workspace engine process for all session paths in that workspace.
- Forward the OpenCode session ID in the URL and preserve the conversation run
  ID in the dedicated header/context used by the orchestrator.
- Keep `directory` request-scoped and validate it against the workspace slot.
- Require the lifecycle record to be in `attached` owner state before upstream
  dispatch. The attach operation must compare-and-set the pending record to the
  exact selected `engineOwnerId`, PID, start time, and base URL. If it returns
  null, conflicts, or observes a generation change, fail closed and do not
  call OpenCode.
- Record the selected process generation in the run trace and use that exact
  token for engine-loss reconciliation.
- Make OpenCode project/skill discovery fail closed for the managed runtime so
  all conversations in the workspace observe the same Veslo effective skill
  revision.
- Do not mutate process-wide skill/config state per conversation. Skill view
  changes require an idle workspace engine transition and a new process
  generation until the bundled OpenCode hot-update gate passes.
- Treat the fallback owner timing, projection migration, revision handshake,
  and structured `409 skill_view_conflict` propagation into UI state as hard
  prerequisites. The concurrency implementation is not verified until the
  selected bundled OpenCode fallback path is green.
- Make that gate measurable: pause one run after admission and before upstream
  dispatch, attempt a skill/config revision change, and require
  `409 skill_view_conflict`, zero upstream POSTs for the blocked transition, and
  an unchanged owner/revision snapshot for the in-flight run. After all runs
  are idle, start exactly one new generation, publish the new revision, and
  verify two concurrent sessions see the same revision with no mixed
  projection.
- Verify concurrent requests do not overwrite shared proxy headers,
  authorization, directory, or skill revision state.

### OpenCode compatibility checks

Using the bundled binary, verify:

- ten sessions can be created in one process;
- prompts in different sessions can run concurrently;
- a prompt in session A cannot affect session B's event stream;
- session IDs remain valid after process restart if the data/config contract
  says they should;
- `/session/:id`, `/prompt_async`, `/event`, `/abort`, and transcript reads all
  remain directory/session scoped;
- only the Veslo effective skill view is visible to every session in the engine.
- the fallback owner cannot change while a run is between admission and
  upstream dispatch;
- a stale skill-view revision reaches the UI as a structured conflict and does
  not become a generic proxy error.
- the paused-run revision-change scenario satisfies the zero-upstream-POST and
  unchanged-owner assertions.

Context7's current OpenCode documentation indicates that sessions are pinned
to a directory/workspace context and that the server supports multiple
contexts. The shipped binary remains the acceptance authority because the
checkout currently bundles a specific older version.

## Phase 6 — Restart, recovery, and runtime behavior

### Implementation

- Define the user-visible behavior for engine suspend, crash, manual reload,
  and process generation change.
- Keep conversation and OpenCode session IDs stable across a recoverable engine
  restart.
- Mark runs from a lost generation terminal or recoverable according to the
  server lifecycle controller's explicit policy; never leave them falsely
  active.
- Reconnect the workspace SSE stream after recreation without dropping events
  for unrelated sessions.
- Make the desktop runtime preparation/reporting surface expose workspace
  engine state and process generation, not a global singleton OpenCode state.
- Keep stale local runtime recovery workspace-scoped.
- Ensure workspace removal stops and forgets exactly that workspace engine and
  does not invalidate another workspace's conversations.

### Desktop acceptance matrix

- cold start one workspace, create ten sessions, run concurrent prompts;
- switch selected conversation while background runs continue;
- close/reopen the app with active or recently completed sessions;
- idle suspend and resume;
- engine crash and automatic restart;
- manual reload while idle;
- attempted reload while active and queued runs exist;
- workspace A and B each have one engine and no cross-session/cross-workspace
  events;
- stale server/orchestrator/UI routes recover to the canonical workspace.

### Runtime oracle

The concurrency and recovery checks run against the bundled OpenCode,
orchestrator, server, and app event-stream surfaces. They do not depend on a
desktop-specific fixture. The oracle is exact, not a visual impression:

The reproducible command is:

```text
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build
node packages/orchestrator/scripts/workspace-one-engine-many-conversations.integration.mjs
```

The command is preceded by the focused contract lanes: the server queue,
submit-attempt, lifecycle, and orchestrator-client tests; the orchestrator
engine-pool, run-registry, proxy-target, and shared-engine tests; and the app
session-event-stream/reactivity tests. The integration script is responsible
for the cross-process ten-conversation and generation-loss assertions; the app
unit lane is responsible for event authorization and UI projection isolation.

The script starts an isolated compiled server and orchestrator pair, uses a
deterministic provider fixture, creates ten conversations/sessions, performs
the concurrent sends, invokes the orchestrator's test-only generation-loss
hook, and exits non-zero on any identity mismatch. It writes
`workspace-one-engine-many-conversations.json` with these required fields:

```text
workspaceId
engineSlotId
engineGenerations: [{ engineOwnerId, pid, startedAt, baseUrl }]
conversations: [{ conversationId, opencodeSessionId, clientMessageId, runId, reservedRunId, status, engineOwnerId }]
abortIsolation
generationLoss
eventRouting
skillRevision
errors
compiledServerSha256
```

The generation-loss hook must be an explicit test-only control guarded from
production startup; sending an OS signal as an undocumented manual step is not
an acceptable oracle. The script must also prove the compiled server binary is
the one under test and preserve server/orchestrator logs as artifacts. App
event authorization and projection isolation remain covered by the focused app
event-stream lane; the runtime artifact records that handoff in `eventRouting`.

```text
topology == pooled-per-workspace
one engine slot for workspace W
one engineOwnerId/generation for all ten runs before a forced crash
10 distinct conversationId values
10 distinct opencodeSessionId values
10 distinct runId values, with reservedRunId == runId for each lifecycle
all records remain scoped to W and the same engineSlotId
abort A => A is terminal/aborted while B remains independently active
forced crash => old generation != replacement generation
old-generation runs reconcile; a new run attaches only to the replacement
no event from session A mutates B's transcript or status
```

The check must use a deterministic test provider/model, bounded timeouts,
explicit process cleanup, and retain orchestrator/server logs as artifacts. A
green result requires the identity assertions above; merely
seeing ten completed messages is insufficient.

## Phase 7 — Observability and documentation

### Required trace fields

Every send, event-stream, lifecycle, engine, and recovery trace should include
only the fields relevant to that layer, with explicit names:

```text
traceId
workspaceId
workspaceRoot or directory
conversationId
opencodeSessionId
clientMessageId
runId
queueItemId / reservedRunId
engineSlotId
engineOwnerId
engineOwnerState
enginePid
engineStartedAt
engineBaseUrl
runtimeSkillRevision
```

Do not use the orchestrator daemon process run ID as the conversation run ID.
Add a diagnostic warning when a trace contains an ambiguous legacy field.

Update these canonical surfaces after behavior is verified and before the
acceptance verdict:

- `docs/dev/opencode-workspace-runtime-architecture.md`: one pooled engine
  slot per workspace, generation owner semantics, and shared-unsandboxed as
  diagnostic-only compatibility mode;
- `docs/dev/development-startup.md`: fresh profile and existing preference
  migration behavior;
- `docs/dev/testing-playbook.md`: server-binary rebuild, preflight, bundled
  OpenCode concurrency/recovery checks, and the runtime identity oracle;
- `docs/dev/engineering-quality-gates.md`: owner-attach, skill fallback, SSE,
  and ten-conversation desktop gates;
- Settings/runtime diagnostics copy and the relevant public feature contract:
  effective topology, engine slot/generation, skill revision, and structured
  conflict states.

Keep this plan as implementation history and use `docs/dev/` for the final
runtime contract. Fresh Windows/macOS profiles now use the pooled-per-workspace
topology; shared-unsandboxed remains only as an explicit compatibility mode.

## Definition of done

This plan is complete because all of the following are true:

- normal local runtime is one engine slot per canonical workspace;
- one workspace can run at least ten independent OpenCode sessions at once;
- active runs are limited per conversation, not per workspace;
- all response/event/transcript/abort paths preserve the correct conversation
  and OpenCode session identity;
- the same workspace never has two live engine processes without an explicit
  generation transition;
- stale process owners cannot affect new generations;
- restart, suspend, recovery, and workspace removal are workspace-scoped;
- runtime skill/config revision is workspace-wide and cannot leak across
  workspaces;
- no run reaches OpenCode while its owner state is pending or its generation
  attachment is stale;
- submit replay, queue replay, timeout replay, payload conflict, and
  `reservedRunId` recovery follow the locked idempotency contract;
- legacy queue duplicate migration completes transactionally and installs the
  workspace-wide unique index; pending/starting duplicates become terminal
  `conflict`, while submitted duplicates retain their upstream handoff evidence
  and expose the conflict without claiming that upstream work did not run;
- no new public lifecycle payload emits `engineSessionId`; only the documented
  storage adapter can read it;
- unknown SSE session events cannot mutate UI state, while authorized session
  creation passes workspace binding validation;
- the authorized-session envelope includes a matching workspace/session binding
  revision;
- the skill fallback owner timing, projection migration, revision handshake,
  and structured `409` UI path are green before concurrency acceptance;
- the non-Tauri runtime harness exits non-zero on identity mismatch, proves the
  compiled server binary is under test, and stores the required oracle artifact;
- the deterministic non-Tauri concurrency/recovery oracle proves ten distinct
  conversation/session/run identities, abort isolation, and generation
  fencing after engine loss; any separate bundled OpenCode compatibility gate
  must remain green before treating the runtime as production-ready;
- structured queue, conflict, stale, and engine-loss states reach the UI;
- focused tests, package typechecks, and the defined runtime integration matrix
  pass;
- server binary is rebuilt before any orchestrator-backed runtime verification;
- canonical `docs/dev/` runtime documentation reflects the verified behavior.

## Verification record — 2026-07-22

The implementation gates currently pass as follows:

- headless services: 29/29;
- orchestrator owner, registry, proxy, activity, and notifier tests: 95/95;
- server lifecycle, queue, submit, and orchestrator-client tests: 84/84;
- app event-stream, reactivity, skill/config, and queue-projection tests:
  47/47 and 35/35 respectively;
- skill strict diagnostics: 0 findings;
- bundled OpenCode directory-scope gate: passed, with
  `directoryScopedHotUpdateCompatible=false` and the documented fallback
  required;
- bundled OpenCode concurrency/restart gate: passed against the shipped
  OpenCode 1.17.13 with ten `204` concurrent `prompt_async` responses, ten
  distinct deterministic-provider requests with observed overlap, ten routed
  session-created events, transcript reads, abort isolation, and all ten
  session IDs preserved after restart; JSON evidence is written under
  `.tmp/runtime-oracle/bundled-opencode-*/`;
- typecheck, lint, architecture audits, and Rust checks: passed;
- deterministic non-Tauri runtime oracle: passed with ten distinct
  conversation/session/run identities, abort isolation, generation loss, a
  new owner after restart, and compiled-server SHA-256 verification.

The repository-wide app unit catalog is not yet green because it contains
unrelated stale source-shape assertions from the current checkout merge. This
pre-existing catalog debt is outside this plan's focused acceptance matrix and
does not change the verified runtime result; no Tauri Pilot result is required
for this plan.

## Recommended implementation order

1. Lock the topology migration, generation owner, lifecycle statuses, and
   idempotency scopes in Phase 0.
2. Implement generation-fenced owner attachment with fail-closed dispatch.
3. Normalize binding, queue identity, `reservedRunId`, and public session-name
   aliases.
4. Harden app recovery and SSE fan-out with separate stream cursor and event
   duplicate contracts.
5. Close the bundled OpenCode skill/config fallback and revision gates.
6. Run the bundled concurrency/recovery checks, including abort isolation and
   crash/restart generation fencing.
7. Keep canonical `docs/dev/` documentation aligned with the verified runtime
   contract; the implementation and acceptance gates above are complete.
