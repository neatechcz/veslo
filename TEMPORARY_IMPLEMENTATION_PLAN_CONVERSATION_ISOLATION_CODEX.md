# Temporary Implementation Plan — Conversation Isolation from Current Code Audit

Goal: hard-separate UI state from OpenCode runtime work so a conversation/run is
always bound to one workspace/branch, background work never blocks another
workspace UI, and passive browsing never starts or retargets an engine.

This plan is based on the current `local/sandbox-merge` code shape, not only the
existing sandbox docs.

## Current Findings

The backend is already closer to the target than the UI:

- `packages/orchestrator/src/engine-pool.ts` owns per-workspace engine
  processes, pending-spawn dedupe, LRU eviction, idle suspend and health checks.
- `packages/server/src/server.ts` has canonical
  `/workspace/:id/opencode/*` proxy routing and strips client-supplied
  `x-opencode-directory`.
- `packages/app/src/app/context/workspace-routing.ts` caches one SDK client per
  workspace and has `WorkspaceClientStaleError` guard proxies.

The UI is still the weak boundary:

- `sendPrompt`, `createSessionAndOpen`, `loadSessions`, `selectSession`,
  `loadEarlierMessages`, catch-up logic and SSE still call OpenCode SDK methods.
- `busy`, `error`, `engineReady`, `selectedSessionId`, messages and todos are
  still mostly global active-view state.
- `session.ts` stores inactive workspace snapshots in an in-memory
  `perWorkspaceCache`, but background SSE events are currently ignored and later
  repaired by reload.
- Passive local browsing uses a Tauri SQLite reader in the UI. This is not
  portable to Windows WSL2/bwrap and makes the UI aware of OpenCode storage.
- Server transcript prefetch exists, but its loader currently calls OpenCode
  HTTP via `fetchOpencodeJson`, so it can wake the engine and is not a true
  passive read boundary.

## Hard Invariants

These invariants should become tests and code-level assertions:

1. A user action is always scoped by `{ workspaceId, branchId?, conversationId? }`.
2. A run is bound to a workspace/branch at creation and can never be retargeted
   by later UI navigation.
3. Passive reads never call OpenCode HTTP and never spawn an engine.
4. UI never sends `x-opencode-directory`; server/orchestrator injects it from
   trusted workspace state.
5. Background workspace events update that workspace's store, not the active
   global view.
6. A background run can only affect the active UI through badges/toasts/status
   indicators, never by setting global `busy`, `error`, selected session,
   messages, todos or permissions.
7. If UI and server disagree on `workspaceId`, the request fails closed.

## Target Shape

UI talks to Veslo APIs only:

```text
UI
  -> Veslo conversation API
  -> Veslo event stream
  -> scoped UI store keyed by workspaceId/branchId/conversationId
```

Server/orchestrator owns OpenCode:

```text
Veslo server/orchestrator
  -> conversation read store
  -> run lifecycle manager
  -> OpenCode SDK/proxy as internal runner
  -> event mirror / durable projection
```

OpenCode becomes an implementation detail:

```text
OpenCode engine
  -> execution, tool calls, model streaming
  -> no direct UI SDK dependency
```

## Scope Model

Use explicit scope IDs everywhere:

```ts
type ConversationScope = {
  workspaceId: string;
  branchId?: string | null;
  conversationId: string;
  runId?: string | null;
};
```

Suggested server-facing objects:

```ts
type ConversationSummary = {
  workspaceId: string;
  branchId?: string | null;
  conversationId: string;
  title: string;
  status: "idle" | "running" | "error" | "archived";
  updatedAt: number;
  createdAt: number;
};

type ConversationRun = {
  workspaceId: string;
  branchId?: string | null;
  conversationId: string;
  runId: string;
  status: "queued" | "starting" | "running" | "completed" | "failed" | "aborted";
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
};
```

## Storage Direction

Add a Veslo-owned projection. OpenCode DB can be a temporary source, but not the
UI source of truth.

Minimal durable tables / JSON stores:

- `conversation_events`: append-only event log.
- `conversations`: latest conversation summary per workspace/branch.
- `messages`: message metadata per conversation.
- `message_parts`: stream parts keyed by message.
- `runs`: run lifecycle state.
- `permissions`: pending permission records keyed by workspace/run.

Every key includes `workspaceId`; every run includes `runId`; branch is nullable
for the initial implementation but part of the schema from day one.

## Phase 0 — Guardrail Audit

Purpose: make current leakage points visible before moving APIs.

Tasks:

- Add a small typed `ConversationScope` module shared by app/server.
- Add dev assertions in UI wrappers: mutating conversation calls require a
  workspaceId and conversationId.
- Add an audit list for every current OpenCode SDK call in UI:
  `session.list`, `session.get`, `session.messages`, `session.todo`,
  `session.create`, `session.promptAsync`, `session.command`,
  `permission.list`, `event.subscribe`, `global.health`.
- Add tests that background workspace state must not set global `busy/error`.

Acceptance:

- A grep over `packages/app/src/app` has an owned list of every direct OpenCode
  SDK conversation call.
- New code cannot add unscoped conversation operations without failing tests.

## Phase 1 — Passive Conversation Read Boundary

Purpose: make browsing workspace/session history engine-free and UI-agnostic.

Add server endpoints:

- `GET /workspace/:id/conversations`
- `GET /workspace/:id/conversations/:conversationId/transcript?limit=...`

Add server interface:

```ts
type ConversationReadStore = {
  listConversations(workspaceId: string): Promise<ConversationSummary[]>;
  getTranscript(input: {
    workspaceId: string;
    conversationId: string;
    limit: number;
  }): Promise<ConversationTranscriptSnapshot>;
};
```

Implementation notes:

- Start with a read adapter that can read the current OpenCode SQLite layout
  without going through OpenCode HTTP.
- Do not keep the current server transcript loader as-is; it calls
  `fetchOpencodeJson` and can wake the engine.
- Remove UI imports of `lib/db-reader` from browsing paths after the server
  endpoint exists.
- `loadSessions`, `selectSession` and `loadEarlierMessages` should read from
  Veslo conversation endpoints, not OpenCode SDK.

Acceptance:

- Clicking workspace/session in browse mode does not spawn `veslo-code serve`.
- Same UI read path works on macOS and Windows WSL2 runtime.
- No passive read path in UI calls `c.session.list` or `c.session.messages`.
- If the passive read store is unavailable, UI gets a typed empty/unavailable
  response instead of falling back to engine HTTP.

## Phase 2 — Scoped UI Store

Purpose: remove global active-session state as a concurrency boundary.

Replace single active store + snapshot cache with a store keyed by workspace:

```ts
type WorkspaceConversationState = {
  workspaceId: string;
  selectedConversationId: string | null;
  conversations: ConversationSummary[];
  statuses: Record<string, string>;
  transcripts: Record<string, ConversationTranscriptSnapshot>;
  pendingPermissions: PendingPermission[];
  error: string | null;
  runningRunIds: string[];
};
```

UI derives active values:

```ts
const activeWorkspaceState = () => workspaceStateById()[activeWorkspaceId()];
const visibleMessages = () => activeWorkspaceState()?.transcripts[selectedId]?.messages ?? [];
```

Rules:

- Background events update `workspaceStateById[workspaceId]`.
- Active view reacts only to the active workspace slice.
- Global `busy` is replaced by scoped run status. A modal/global overlay may be
  derived only for deliberate app-level operations.
- Global `error` becomes active-workspace error plus optional global system
  error.

Acceptance:

- A running task in workspace A shows progress/badge in A while workspace B
  composer stays usable.
- Switching workspaces does not copy messages/todos through a global snapshot.
- Background SSE/event bursts do not re-render the active transcript unless
  they belong to active workspace.

## Phase 3 — Conversation Run Boundary

Purpose: move first-send/cold-start/OpenCode calls behind Veslo server.

Add server endpoints:

- `POST /workspace/:id/conversations`
- `POST /workspace/:id/conversations/:conversationId/runs`
- `POST /workspace/:id/conversations/:conversationId/abort`
- `POST /workspace/:id/conversations/:conversationId/command`

Server responsibilities:

- Ensure engine only for explicit run creation.
- Run managed-AI bootstrap/preflight.
- Call OpenCode `session.create`, `promptAsync`, `command`, shell or compact.
- Bind the created OpenCode session to Veslo `conversationId`.
- Write run lifecycle events to Veslo store.
- Return typed errors: `engine_start_failed`, `ai_access_unavailable`,
  `workspace_not_found`, `permission_required`, `runtime_unavailable`.

UI responsibilities:

- Build a Veslo run request from composer state.
- Optimistically mark a run as queued/starting in scoped store.
- Never call `c.session.promptAsync`, `c.session.command` or
  `c.session.create` directly.

Acceptance:

- `sendPrompt()` no longer imports or uses OpenCode SDK client.
- Workspace switch during send cannot retarget the run, because the run lives
  under the workspaceId in the server request.
- Engine startup error for workspace A does not set an active error in
  workspace B.

## Phase 4 — Veslo Event Stream

Purpose: UI consumes stable Veslo events, not OpenCode SSE.

Add event stream:

- `conversation.created`
- `conversation.updated`
- `message.created`
- `message.part.updated`
- `run.started`
- `run.completed`
- `run.failed`
- `run.aborted`
- `permission.requested`
- `permission.resolved`

Event payload requirements:

```ts
type VesloConversationEvent = {
  eventId: string;
  workspaceId: string;
  branchId?: string | null;
  conversationId?: string | null;
  runId?: string | null;
  type: string;
  payload: unknown;
  createdAt: number;
};
```

Server maps OpenCode SSE to Veslo events and persists them before or while
emitting. UI can repair missed events through read endpoints.

Acceptance:

- UI has no `event.subscribe` call for conversation runtime.
- Reconnecting stream catches up by `eventId` or reloads scoped conversation
  state.
- Background workspace streams update background workspace state.

## Phase 5 — OpenCode SDK Removal from UI Conversation Flow

Purpose: complete the UI/runtime split.

Remove direct UI dependencies for conversation runtime:

- `session.list`
- `session.get`
- `session.messages`
- `session.todo`
- `session.create`
- `session.promptAsync`
- `session.command`
- `permission.list`
- `event.subscribe`

Allowed remaining UI OpenCode interaction, temporarily:

- non-conversation configuration screens, only if workspace-scoped and audited.

Acceptance:

- `packages/app/src/app/context/session.ts` is a Veslo conversation store, not
  an OpenCode SDK store.
- `workspace-routing.ts` is no longer needed by conversation flow.
- OpenCode can change DB/API shape without changing normal UI browsing/rendering.

## First PR Recommendation

Do not start with `sendPrompt`. Start with passive reads.

First PR contents:

- Add `ConversationReadStore`.
- Add `GET /workspace/:id/conversations`.
- Add/replace transcript endpoint so local passive reads do not call OpenCode
  HTTP.
- Add app client methods in `lib/veslo-server.ts`.
- Switch `loadSessions`, `selectSession`, `loadEarlierMessages` to Veslo read
  API when available.
- Keep existing SDK fallback behind a dev-only or explicit fallback flag while
  tests are being written, then remove it.

First PR tests:

- Server test: passive transcript endpoint does not call `fetchOpencodeJson`
  when local read store is available.
- App test: browse `selectSession()` hydrates from Veslo endpoint and does not
  call OpenCode SDK.
- E2E/manual regression: workspace click + session click keeps engine count at
  0.
- App test: background workspace event does not mutate active workspace
  messages/error/busy.

## Explicit Non-goals for First PR

- No full migration to Veslo-owned DB yet.
- No rewrite of `sendPrompt` yet.
- No UI redesign.
- No branch UI unless a branch ID already exists in current state.
- No removal of OpenCode proxy endpoints.

## Main Risks

- Reading the correct OpenCode DB on Windows WSL2: host UI DB reader is not a
  valid long-term source because the engine can run in a WSL-native home.
- Server currently runs in Bun; SQLite access should be implemented as a
  clean adapter with tests, not ad hoc parsing.
- Some UI screens still depend on global `busy/error`; replacing them should
  be incremental and scoped to conversation runtime first.
- Existing SSE logic has catch-up behavior that calls OpenCode SDK. It must be
  replaced by Veslo event catch-up before background events can be trusted.

## Done Definition

Conversation isolation is done when:

- UI cannot call OpenCode SDK for conversation read/write/run/event paths.
- Passive workspace/session browsing never starts an engine.
- Every conversation/run/event has explicit workspace scope.
- A running task in workspace A cannot block composer, errors, selected
  conversation, transcript or permissions in workspace B.
- Server/orchestrator is the only layer allowed to translate Veslo
  conversation intents into OpenCode operations.
