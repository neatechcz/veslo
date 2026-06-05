# Temporary Implementation Plan — Veslo Conversation Service

Goal: move conversation/run ownership out of the UI and into a trusted Veslo
conversation boundary so OpenCode becomes an internal execution engine. The UI
should not decide which OpenCode session, directory, runtime, or workspace
receives work.

This is the pragmatic next step after the passive read boundary and the minimal
conversation binding store.

## Ownership Correction After Oponentura

There are two different ownership problems:

- Routing ownership: resolving `{ workspaceId, conversationId }` into a trusted
  directory, OpenCode session, engine target, and auth context.
- Lifecycle ownership: knowing whether a run is queued, running, blocked on
  permission, failed, completed, or aborted.

`packages/server` is a good first owner for routing/API facade work because it
already owns workspace auth, durable Veslo metadata, passive reads, and the
client-facing API. It is not a good standalone owner for authoritative run
lifecycle state unless it also consumes the engine event stream.

The authoritative run lifecycle owner should be the orchestrator or the planned
merged `orchestrator + veslo-server` process, because that is where engine
spawn/suspend/crash state and the OpenCode proxy/event path already live. Until
that lifecycle projection exists, any run row created by `packages/server` is
only submission/routing metadata, not truth about completion.

## Core Principle

UI sends scoped Veslo intent:

```ts
{
  workspaceId: string;
  conversationId: string;
  input: ...
}
```

The trusted conversation boundary resolves execution context:

```ts
{
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  directory: string;
  engineClient: ...
}
```

The UI may display OpenCode-compatible session IDs during migration, but it
must not use them as the authority for active work. Only trusted server/runtime
modules may convert `conversationId` into `opencodeSessionId`.

## Non-Goals for the First Pass

- Do not build a full durable message/event database yet.
- Do not replace OpenCode SQLite transcript reads yet.
- Do not migrate every UI state store at once.
- Do not redesign the whole orchestrator.
- Do not claim authoritative run lifecycle state in `packages/server` without
  server-side/orchestrator-side SSE projection.

The first pass should introduce the server boundary and prepare create/send
migration. Create can move first; send should move only when routing authority
is explicit and lifecycle truth is either projected server-side or consciously
left on the legacy desktop SSE path for the migration window. Passive read can
continue to use the current read store.

## Existing Pieces to Reuse

- `packages/server/src/conversation-read-store.ts`
  - passive OpenCode SQLite list/transcript reader
  - already scoped by workspace/directory

- `packages/server/src/conversation-binding-store.ts`
  - Veslo-owned mapping between `conversationId` and OpenCode `session.id`
  - stored under `VESLO_DATA_DIR/conversations/bindings.sqlite`
  - deterministic IDs allow rebuild from passive OpenCode history

- `packages/server/src/server.ts`
  - workspace auth and route registration
  - OpenCode proxy helpers

- `packages/orchestrator/src/engine-pool.ts`
  - current engine lifecycle owner
  - spawn/suspend/crash/health state

- `packages/orchestrator/src/router-proxy.ts`
  - current OpenCode proxy path, including event stream pass-through

- `packages/desktop/src-tauri/src/commands/engine_sse.rs`
  - current desktop SSE proxy into the webview

- New shared server module to extract from `server.ts`
  - `resolveWorkspace`
  - `resolveConversationReadDirectory`
  - directory authorization helpers
  - needed so `conversation-service.ts` does not depend on private
    implementation details inside the route file

- `packages/app/src/app/lib/veslo-server.ts`
  - Veslo client surface to extend

- `packages/app/src/app/context/workspace-routing.ts`
  - current UI-side OpenCode routing, useful during migration but should not
    remain the active-work authority long-term

## Target Server API

Keep the API small and workspace-scoped.

```text
GET  /workspace/:id/conversations
GET  /workspace/:id/conversations/:conversationId/transcript?limit=...&directory=...

POST /workspace/:id/conversations
POST /workspace/:id/conversations/:conversationId/runs
POST /workspace/:id/conversations/:conversationId/commands
POST /workspace/:id/conversations/:conversationId/abort

GET  /workspace/:id/conversation-runs
GET  /workspace/:id/conversations/:conversationId/runs/latest
```

Current route reality:

- Existing transcript reads are still mounted as
  `/workspace/:id/sessions/:sessionId/transcript`.
- That route already accepts either OpenCode `session.id` or Veslo
  `conversationId` through binding resolution.
- The `/conversations/:conversationId/transcript` route above is the target
  alias for the UI route-param migration, not a current route.

Optional later:

```text
POST /workspace/:id/conversations/:conversationId/permissions/:permissionId/reply
GET  /workspace/:id/conversations/:conversationId/permissions
```

## Minimal Types

```ts
type ConversationScope = {
  workspaceId: string;
  conversationId: string;
  directory?: string | null;
};

type ConversationCreateInput = {
  directory?: string | null;
  title?: string | null;
  parentConversationId?: string | null;
};

type ConversationCreateResult = {
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  directory: string;
  title: string;
  createdAt: number;
};

type ConversationRunInput = {
  message: string;
  parts?: unknown[];
  model?: unknown;
  agent?: string | null;
  variant?: string | null;
  system?: string | null;
  reasoningEffort?: string | null;
};

type ConversationCommandInput = {
  command: string;
  arguments?: string;
  messageId?: string | null;
  model?: string | null;
  agent?: string | null;
  variant?: string | null;
  parts?: unknown[];
  reasoningEffort?: string | null;
};

type ConversationRun = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  opencodeSessionId: string;
  directory: string;
  status: "submitted" | "queued" | "starting" | "running" | "completed" | "failed" | "aborted";
  kind: "prompt" | "command" | "compact" | "abort";
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  error?: string | null;
};
```

Do not use engine `idle` as a Veslo run status. `idle` is an engine/session
signal; when lifecycle projection proves the run is finished, map it to
`completed`.

## Minimal Durable Storage

Keep the existing binding table. Add a run table only in the process that owns
or receives lifecycle projection.

If the first PR adds a table inside `packages/server`, treat it as a
non-authoritative submission table. Do not update it to `completed` or `failed`
from synchronous `prompt_async`/`command` return values alone.

```sql
CREATE TABLE conversation_run (
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  engine_session_id TEXT NOT NULL,
  directory TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  PRIMARY KEY (workspace_id, run_id)
);

CREATE INDEX conversation_run_conversation_idx
  ON conversation_run (workspace_id, conversation_id, created_at DESC);

CREATE INDEX conversation_run_status_idx
  ON conversation_run (workspace_id, status, created_at DESC);
```

Storage location:

- Default: `VESLO_DATA_DIR/conversations/runs.sqlite` or the same
  `bindings.sqlite` DB with a second table.
- Prefer same DB for the first pass to reduce moving parts.
- Allow env override only if it remains under a trusted host path.
- If the lifecycle owner is orchestrator while `packages/server` remains a
  separate process, store runs in the lifecycle owner's trusted data dir or use
  an explicitly shared trusted host path. Do not put authoritative run state in
  two SQLite files.
- For high-frequency run status updates, do not use open/close-per-write like
  the binding store. Use one long-lived SQLite handle or a serialized writer.

## Conversation Service Interface

Add `packages/server/src/conversation-service.ts`.

```ts
type ConversationService = {
  listConversations(input: {
    workspace: WorkspaceInfo;
    directory: string | null;
  }): Promise<ConversationListResult>;

  getTranscript(input: {
    workspace: WorkspaceInfo;
    conversationId: string;
    directory: string | null;
    limit: number;
  }): Promise<ConversationTranscriptResult>;

  createConversation(input: {
    workspace: WorkspaceInfo;
    directory: string | null;
    title?: string | null;
  }): Promise<ConversationCreateResult>;

  runPrompt(input: {
    workspace: WorkspaceInfo;
    conversationId: string;
    directory: string | null;
    payload: ConversationRunInput;
  }): Promise<ConversationRun>;

  runCommand(input: {
    workspace: WorkspaceInfo;
    conversationId: string;
    directory: string | null;
    payload: ConversationCommandInput;
  }): Promise<ConversationRun>;

  abortConversation(input: {
    workspace: WorkspaceInfo;
    conversationId: string;
    directory: string | null;
    runId: string;
  }): Promise<ConversationRun>;
};
```

The trusted conversation boundary must be the only place that converts
`conversationId` into `opencodeSessionId`. During the split-process phase this
can be a `packages/server` facade calling an orchestrator/merged runtime owner.

## Transcript Identity Contract

During migration, transcript routes may accept either `conversationId` or the
legacy OpenCode `session.id`. The response must be explicit:

```ts
type ConversationTranscriptResult = {
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  uiSessionId: string;
  messages: unknown[];
  partsByMessageId: Record<string, unknown[]>;
};
```

Rules:

- `conversationId` is the stable Veslo identity.
- `opencodeSessionId` is engine/debug identity.
- `uiSessionId` is temporarily equal to `opencodeSessionId` until routes migrate.
- `hydrateTranscriptSnapshot()` must key cache entries by the UI identity it is
  asked to display. Before route params move to `conversationId`, that remains
  OpenCode session ID. After route params move, hydration must not silently store
  transcript only under the OpenCode ID or the active conversation will render
  empty.

## Runtime Boundary

For active work, the service needs an internal OpenCode execution client.

Routing facade first pass:

- Use existing server `fetchOpencodeJson(workspace, path, options)` for active
  create/routing calls.
- Do not expose this to UI.
- Keep directory injection on the server.
- Explicitly reject client-supplied OpenCode directory if it is outside the
  authorized workspace path.
- Service owns runtime targeting: workspace, directory, OpenCode session,
  engine base URL, and auth.

Lifecycle owner requirement:

- Authoritative run status must come from server-side/orchestrator-side
  OpenCode SSE interpretation, not only from HTTP return values.
- The lifecycle owner should be orchestrator or the merged orchestrator/server
  process because it already owns engine lifecycle and sits on the proxy/event
  path.
- Event mirroring from OpenCode SSE into normalized Veslo conversation events is
  not a cosmetic later feature. It is the precondition for truthful run status,
  permission state, abort confirmation, reconnect catch-up, and mobile/web
  parity.

## Responsibility Split During Migration

The current UI active path does more than call `promptAsync`. The service
migration must avoid creating a thin proxy that still leaves runtime ownership
in UI.

Temporary UI responsibilities:

- Composer text/draft UX.
- Attachment blob/file acquisition from browser/Tauri.
- Optional optimistic display state.
- Local command palette resolution until command inventory moves server-side.

Server Conversation Facade responsibilities:

- Workspace/directory authorization.
- OpenCode session creation and binding.
- OpenCode run/command routing.
- Managed runtime target selection and auth when the facade is the caller;
  otherwise delegate this to the lifecycle/runtime owner with explicit scope.
- Runtime reachability check for active operations, either directly or by
  delegating to the orchestrator/merged runtime.
- Validation that staged attachment references belong to the scoped workspace
  and conversation.
- Submission persistence and typed failure recording for routing/preflight
  failures.

Orchestrator or merged runtime lifecycle responsibilities:

- Engine SSE subscription/interpretation.
- Authoritative run status transitions.
- Normalized Veslo conversation event stream.
- Permission/blocking state projection.
- Abort confirmation and reconnect catch-up.

Explicit migration note:

- Attachment staging can remain UI-initiated in the first pass because the UI
  owns browser `File` objects. The server endpoint should accept only staged
  attachment references or normalized prompt parts, and it must validate their
  scope before execution.
- Run endpoints must not accept arbitrary client-supplied file paths. They may
  accept only server-verifiable attachment IDs/staged refs bound to the scoped
  `{ workspaceId, conversationId }`. During UI migration, a staged ref may also
  include the temporary `uiSessionId`, but the server must resolve it back to
  the trusted conversation scope before execution.
- Managed AI bootstrap/config patching can remain in the existing flow for the
  create endpoint PR. Before migrating `sendPrompt`, decide whether the service
  directly performs the bootstrap or calls a shared server helper that applies
  the same managed config before launching the run.

## Parallelism and Isolation

Parallelism is part of the boundary, not an optimization added later.

Rules:

- Every active operation is scoped by `{ workspaceId, conversationId, runId }`.
  There is no process-wide "current conversation" or "current workspace" in the
  run path.
- Work in workspace A must not block UI browsing, create, or send operations in
  workspace B beyond ordinary shared resource limits such as CPU or SQLite
  writer serialization.
- Background workspace events must update only their scoped run/conversation
  state. They must not mutate active workspace global error/busy state unless
  that scoped conversation is currently displayed.
- Same-conversation concurrency must be explicit. Either allow one active run
  and reject/queue the next request, or persist queued runs with distinct
  `runId`s and deterministic order. Do not infer "latest run" for commands or
  aborts.
- SQLite writes for run lifecycle should be serialized through a small writer,
  but that writer must not hold a global lock while waiting on OpenCode HTTP,
  engine startup, tool execution, or SSE consumption.
- The lifecycle owner should process events per workspace/engine with bounded
  queues so one noisy stream cannot starve another workspace.

Acceptance:

- Two workspaces can submit runs concurrently and get distinct `runId`s.
- A long-running run in workspace A does not prevent conversation list or
  create/send in workspace B.
- Two submitted runs in the same conversation are either rejected with a typed
  "run already active" error or recorded as ordered queued runs.
- Abort always targets an explicit `{ workspaceId, conversationId, runId }`.

## Server Route Migration

### Phase 1 — Service Wrapper Around Existing Passive Routes

Tasks:

- Extract workspace/directory resolution helpers from `server.ts` into a shared
  server module.
- Create `conversation-service.ts`.
- Move current `/workspace/:id/conversations` logic into service.
- Move current transcript binding resolution into service.
- Keep route behavior unchanged.
- Add tests proving the service does not call OpenCode HTTP for passive reads.

Acceptance:

- Existing passive read tests still pass.
- Routes are thinner and only resolve auth/workspace/directory before calling
  service.
- No behavior change in UI.

### Phase 1.5 — UI Scope Sidecar Before Active Migration

Tasks:

- Add a small `conversationScopeBySessionId` or `conversationScopeByUiId` map
  before changing `sendPrompt`.

```ts
type UiConversationScope = {
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  directory: string;
};
```

- Populate from passive list responses.
- Populate from transcript responses.
- Populate from create conversation responses once Phase 2 lands.
- Add a helper that resolves selected UI session to a scoped conversation and
  fails closed when a known scoped session would otherwise fall back to active
  workspace guesses.

Acceptance:

- UI can answer "which workspace/conversation owns this selected row" without
  reading `activeWorkspaceId`.
- `sendPrompt` migration cannot accidentally use active workspace as an
  implicit fallback for a known scoped conversation.

### Phase 2 — Create Conversation Endpoint

Tasks:

- Add `POST /workspace/:id/conversations`.
- Request body accepts `{ directory?, title? }`.
- Service validates directory via shared server directory resolver before
  creating.
- Service calls OpenCode `session.create`.
- This is an active operation, not a passive read. It may contact/start the
  workspace engine through the trusted runtime path.
- Service persists binding immediately.
- Response returns `conversationId`, `opencodeSessionId`, `directory`.

Acceptance:

- New conversation is bound before UI navigates to it.
- Creating a conversation in workspace A cannot write to workspace B directory.
- Same OpenCode session ID in another workspace still maps to a different
  Veslo `conversationId`.

### Phase 3 — Prompt/Command Routing Endpoints

Tasks:

- Add `POST /workspace/:id/conversations/:conversationId/runs`.
- Add `POST /workspace/:id/conversations/:conversationId/commands`.
- Resolve binding inside service.
- Allocate explicit `runId`.
- Create a submission/routing row with `submitted` or hand the request directly
  to the lifecycle owner.
- Call OpenCode `session.promptAsync` or `session.command` through the trusted
  server/runtime path.
- On routing/preflight error, mark the submission failed and include a typed
  error in response.
- Make runtime preflight explicit in service: resolve engine target, verify
  reachability, apply required managed config or fail with typed 503.
- Accept only normalized prompt parts/staged attachment references; do not let
  the UI provide arbitrary server paths outside the scoped workspace.

Acceptance:

- UI sends prompt using `workspaceId + conversationId`, not OpenCode session ID.
- Workspace switch during request does not retarget the run.
- Background workspace run cannot set active workspace global error unless that
  workspace/conversation is active.
- If there is no lifecycle SSE projection yet, the API response is explicit
  that the run is submitted/routing-only and not final completion truth.

### Phase 3.5 — Lifecycle Projection Owner

Tasks:

- Add an SSE consumer in orchestrator or the merged runtime process.
- Project OpenCode engine events into Veslo run state keyed by
  `{ workspaceId, conversationId, runId }`.
- Emit a normalized Veslo conversation event stream for clients.
- Reconcile state after reconnect by fetching current session status/messages
  for scoped conversations.
- Map engine `idle` to Veslo run `completed` only from event/catch-up truth.

Acceptance:

- `conversation_run.status` changes are driven by the lifecycle owner, not by
  UI event handlers.
- A run that fails or idles after a tool/error event does not remain
  permanently `running`.
- Desktop can still use the old stream during migration, but the new stream is
  proven on at least one client surface before removing UI SSE ownership.

### Phase 4 — Abort Endpoint

Tasks:

- Add `POST /workspace/:id/conversations/:conversationId/abort`.
- Require explicit `runId` in the request body.
- Call the existing OpenCode abort/delete/control mechanism used by UI today.
- Confirm `aborted`/`completed` through lifecycle projection. Before projection
  exists, return only best-effort routing result.

Acceptance:

- Abort only targets the scoped conversation.
- Aborting active conversation does not affect another workspace's running
  conversation.
- Queued and running runs in the same conversation are not conflated.

### Phase 5 — UI Migration

Tasks:

- Extend `VesloServerClient` with:
  - `createConversation`
  - `runConversationPrompt`
  - `runConversationCommand`
  - `abortConversation`
  - `listConversationRuns`

- Change `createSessionAndOpen`:
  - call `client.createConversation(workspaceId, { directory, title })`
  - navigate using current UI session compatibility ID initially
  - store `conversationId` sidecar on sidebar/session browse scope

- Change `sendPrompt`:
  - resolve selected session to `{ workspaceId, conversationId }`
  - call Veslo run endpoint
  - do not call `c.session.promptAsync` from UI except behind a temporary
    legacy fallback flag
  - legacy fallback must never be silent: log/dev-assert when used, and do not
    allow it when a conversation scope is already known
  - after every await, apply UI mutations only if the resolved
    `{ workspaceId, conversationId }` still matches the displayed conversation

- Change slash command path:
  - call Veslo command endpoint
  - keep local optimistic command display if needed

Acceptance:

- Grep shows no active `c.session.create`, `c.session.promptAsync`,
  `c.session.command` in the normal UI send/create path.
- The only remaining UI `c.session.*` calls are browse/live hydration legacy
  paths with explicit comments.
- Run status UI is either fed by normalized lifecycle events or explicitly kept
  on the legacy desktop SSE path until the normalized stream is ready.

### Phase 6 — Basic Scoped UI State

Tasks:

- Extend the Phase 1.5 sidecar to all active operations:
  - `sendPrompt`
  - `loadOfflineTranscript`
  - `abortSession`
  - `replaceUserMessage`
  - `compactCurrentSession`
- Define the transcript cache key rule for both migration states:
  - before route param migration, UI rows are keyed by OpenCode session ID
  - after route param migration, UI rows are keyed by Veslo `conversationId`
  - hydration must write/read the same key the visible route uses

Acceptance:

- UI never guesses workspace from active workspace when selected session has a
  known scope.
- If scope is missing, active work fails closed or creates a new conversation
  explicitly.
- A transcript fetched through `conversationId` renders in the active
  conversation instead of being cached only under `opencodeSessionId`.

### Phase 7 — Tests and Guardrails

Add tests:

- Passive conversation list still does not hit OpenCode HTTP.
- `POST /conversations` persists binding before response.
- `POST /conversations/:conversationId/runs` resolves OpenCode session by
  `workspaceId + directory + conversationId`.
- Run status tests prove lifecycle owner updates state from SSE/catch-up, not
  from `prompt_async` return value alone.
- A conversation ID from workspace A returns 404/403 in workspace B.
- Same OpenCode session ID in two directories maps to two Veslo conversation
  IDs.
- UI send path calls Veslo client, not `c.session.promptAsync`.
- UI create path calls Veslo client, not `c.session.create`.
- Workspace switch while send is in flight does not write error/messages into
  the new active workspace.

Add grep/contract tests:

- No direct UI import of `lib/db-reader` in app browse paths.
- No normal send/create path direct calls to:
  - `session.create`
  - `session.promptAsync`
  - `session.command`

## Failure Behavior

Fail closed:

- Unknown `conversationId`: 404.
- Directory outside workspace: 403.
- Binding exists but OpenCode session is missing: 409 or 404 with typed error.
- Passive DB unavailable: return `source: "unavailable"` for read routes, but
  do not use this for active run routing.
- OpenCode engine unavailable during active routing/preflight: return 503 and
  mark the submission failed. Post-submission engine failures must come from
  lifecycle projection.

Do not:

- Fall back from active Veslo run endpoint to UI OpenCode SDK silently.
- Use active workspace ID if the selected conversation has a different stored
  workspace scope.
- Create bindings in workspace-local files.

## Migration Policy

Temporary compatibility:

- Continue using OpenCode `session.id` as UI row `id`.
- Add `conversationId` and `opencodeSessionId` sidecar fields.
- Allow transcript endpoint to accept OpenCode session ID while binding rollout
  completes.

End state:

- UI route params should use Veslo `conversationId`.
- OpenCode session ID should not appear in user-facing routing.
- OpenCode session ID stays server-side or debug-only.

## Suggested Implementation Order

1. Extract workspace/directory resolver helpers from `server.ts`.
2. Add `conversation-service.ts` and move passive route logic into it.
3. Add create conversation endpoint and tests.
4. Extend app `VesloServerClient`.
5. Add read-populated UI scope sidecar map before active migration.
6. Add prompt/command routing endpoint that returns explicit `runId` and
   `submitted` status, or delegates directly to lifecycle owner.
7. Add lifecycle projection in orchestrator/merged runtime.
8. Add authoritative run store/writer in the lifecycle owner.
9. Switch UI `createSessionAndOpen`.
10. Switch UI `sendPrompt` and command path.
11. Use scope sidecar for abort/compact/replace.
12. Add grep tests to prevent regressions.
13. Remove legacy direct active OpenCode calls after one stable pass.

## First PR Boundary

Keep the first PR small enough to review:

- `conversation-service.ts`
- extracted workspace/directory resolver module
- passive route moved through service
- create conversation endpoint
- tests for binding/service/create endpoint
- app client methods only, no full UI migration yet
- no authoritative run table unless lifecycle projection is included

PR 1.5:

- read-populated UI conversation scope sidecar
- transcript identity/cache-key contract tests
- no active create/send migration yet

Second PR:

- run/command routing endpoints with explicit `runId`
- lifecycle owner decision implemented: orchestrator now, or merged runtime
  first
- normalized lifecycle event projection started
- managed/runtime preflight ownership decision implemented in service or shared
  runtime helper
- guard tests

Third PR:

- migrate one UI/client surface to normalized lifecycle stream
- UI create/send migration once routing and lifecycle ownership are both
  explicit
- abort/permission routing
- route params move toward `conversationId`
- remove direct active OpenCode SDK calls from UI.
