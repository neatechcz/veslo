# Temporary Implementation Plan — Conversation Isolation

Goal: oddělit UI od OpenCode SDK, engine lifecycle a platformních sandbox detailů.
UI má pracovat s Veslo conversation API; OpenCode zůstane interní runner.

## Current Problem

- UI dnes přímo volá OpenCode SDK (`session.list`, `session.create`,
  `session.messages`, `session.promptAsync`).
- Browse mode má vlastní Tauri SQLite reader, který čte host
  `~/.local/share/opencode/opencode.db`.
- Na Windows běží OpenCode uvnitř WSL2/bwrap s vlastním HOME/XDG storem, takže
  host DB reader není stabilní source of truth.
- `veslo-server` už má transcript endpoint, ale čte přes OpenCode HTTP API a
  může tím probudit engine.

## Target Shape

UI:

- renderuje workspace/session/conversation state
- posílá intent: create conversation, send message, abort, archive
- nikdy přímo nevolá OpenCode SDK ani nečte OpenCode SQLite

Veslo server/orchestrator:

- vlastní conversation read/write API
- rozhoduje, kdy se engine startuje
- mapuje Veslo conversation operace na OpenCode session operace
- publikuje Veslo event stream do UI

OpenCode:

- interní runner implementation detail
- může změnit DB/API bez přepsání UI

## Phase 1 — Conversation Read Boundary

Add server endpoints:

- `GET /workspace/:id/conversations`
- `GET /workspace/:id/conversations/:sessionId/transcript?limit=...`

Replace UI read paths:

- `loadSessions()` přestat volat `c.session.list()`.
- `selectSession()` a `loadEarlierMessages()` číst přes Veslo endpoint.
- `populateSidebarFromDb` a `hydrateLatestSessionFromDb` odstranit z UI API
  surface nebo je schovat za server adapter.

Acceptance:

- klik workspace/session v browse mode nikdy nespawne engine
- stejný read path funguje na macOS i Windows WSL2
- UI nemá přímý import `db-reader` pro session list/transcript

## Phase 2 — Backend Transcript Adapter

Implement server-side transcript source:

- macOS/current host mode: read OpenCode SQLite read-only
- Windows WSL2: read correct WSL engine store or use exported/mirrored data
- remote Veslo workspace: call remote Veslo conversation API

Keep this behind one interface:

```ts
type ConversationReadStore = {
  listConversations(workspaceId: string): Promise<ConversationSummary[]>;
  getTranscript(workspaceId: string, sessionId: string, limit: number): Promise<TranscriptSnapshot>;
};
```

Acceptance:

- no UI platform branching
- no OpenCode HTTP call for passive transcript reads
- clear fallback when transcript store is unavailable

## Phase 3 — Conversation Run Boundary

Add server endpoints:

- `POST /workspace/:id/conversations`
- `POST /workspace/:id/conversations/:sessionId/runs`
- `POST /workspace/:id/conversations/:sessionId/abort`
- `POST /workspace/:id/conversations/:sessionId/command`

Move from UI into backend:

- engine start before first send
- managed-AI bootstrap check
- OpenCode `session.create`
- OpenCode `session.promptAsync`
- shell/command/compact dispatch

Acceptance:

- `sendPrompt()` in UI builds a Veslo request and updates local optimistic UI
- no direct `c.session.promptAsync()` in UI
- engine lifecycle errors return typed Veslo errors

## Phase 4 — Veslo Event Stream

Introduce event stream:

- `conversation.created`
- `conversation.updated`
- `message.created`
- `message.part.updated`
- `run.started`
- `run.completed`
- `run.failed`
- `permission.requested`

Server/orchestrator maps OpenCode SSE into Veslo events.

Acceptance:

- UI subscribes to Veslo events, not OpenCode `/event`
- missed events can be repaired by conversation read API
- event payloads contain `workspaceId`, `conversationId`, `runId`

## Phase 5 — Veslo-Owned Conversation Store

Mirror OpenCode events into Veslo-owned storage:

- conversations
- messages
- parts
- runs
- permissions
- archive metadata

OpenCode DB becomes upstream/runtime cache, not UI source of truth.

Acceptance:

- passive UI reads do not depend on OpenCode process or OpenCode DB layout
- history survives engine runtime changes
- branch/workspace isolation is explicit in stored keys

## Branch Isolation Model

Use explicit IDs everywhere:

```ts
type ConversationScope = {
  workspaceId: string;
  branchId?: string;
  conversationId: string;
  runId?: string;
};
```

Rules:

- UI selection is `workspaceId + conversationId`, not active OpenCode client.
- A run is bound to one workspace/branch at creation time.
- Workspace switch cannot retarget an in-flight run.
- Background branches can keep running without owning global UI state.

## First PR

Do Phase 1 only.

Files likely touched:

- `packages/server/src/server.ts`
- `packages/server/src/session-transcript-prefetch.ts`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/lib/veslo-server.ts`

Tests:

- server test: conversation transcript endpoint does not call OpenCode HTTP when
  local read store is available
- app test: browse `selectSession()` does not call OpenCode SDK
- app test: `loadSessions()` uses Veslo conversation client

Non-goals for first PR:

- no full Veslo DB migration
- no sendPrompt rewrite
- no OpenCode replacement
- no UI redesign
