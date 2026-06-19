# Missaligned UI Response Workspace Mismatch

## Executive summary

The most plausible path for an answer from one workspace to appear in the UI for another workspace is not a simple late workspace switch. It is a mismatch between workspace-aware routing and a session UI store that still caches timeline data by session/message IDs only.

Several newer layers already treat a conversation as workspace-scoped:

- conversation scope resolution can distinguish the same UI/OpenCode session ID across workspaces
- selected-session routing uses workspace plus conversation/opencode identity
- Veslo server transcript prefetch is workspace-scoped
- SSE multiplex streams tag events with a source workspace id

But the active session store still keeps messages, parts, transcript freshness, todos, and some status/error state under plain `sessionId` or `messageId` keys. If two workspaces ever contain the same session ID, or if a stale/background stream emits events for a session ID that is currently selected in another workspace, the UI can read the wrong content through the shared key.

## Primary mismatch

The scope layer understands that `sess-same` in workspace A and `sess-same` in workspace B can be different conversations. The message/timeline cache does not.

The dangerous shape is:

1. Workspace A is active and selected session is `sess-same`.
2. Workspace B also has a session/conversation resolving to `sess-same`.
3. A background read, prefetch, DB hydrate, latest-session warmup, or stale SSE event for workspace B returns data for `sess-same`.
4. The frontend writes that data into the global session store under `messages["sess-same"]` / `parts[messageId]`.
5. The visible UI for workspace A reads by `selectedSessionId === "sess-same"` and renders the newly written data from workspace B.

This is especially plausible because background prefetch and local DB warmup are intentionally passive and do not change selected session. That means they can mutate cache state while the user remains visually in another workspace.

## High-risk paths

### 1. Transcript hydration is keyed only by session id

`hydrateTranscriptSnapshot` accepts a workspace-scoped snapshot, but the write target is the plain session id from the snapshot. The snapshot carries workspace identity, but that identity is not part of the cache key used by the active UI message store.

Risk:

- background transcript for workspace B can overwrite warm messages for the same session id currently selected in workspace A
- transcript freshness can suppress or allow updates based on session id only
- a later workspace snapshot can save already-contaminated message state

### 2. Background prefetch hydrates directly into active session store

The hydrated Veslo server client wraps `prefetchSessionTranscripts` and hydrates every returned item immediately. Prefetch interest can be reported from dashboard/session sidebar for a specific workspace, including a workspace that is not the currently displayed conversation.

Risk:

- sidebar hover/loaded-session prefetch for workspace B can write timeline data into the same global message store used by workspace A
- this is a passive background path, so it can happen without explicit user intent to switch workspace

### 3. Local browse/latest-session warmup hydrates without selection change

Local workspace browse mode and boot paths can call latest-session DB hydration to warm cache without selecting the session. The comments explicitly say this should only populate cache and not change selected session.

Risk:

- warming workspace B's latest session can overwrite `messages[sessionId]` while workspace A remains displayed
- because no selection change happens, normal selection staleness guards do not protect the visible timeline

### 4. SSE multiplex guard has a legacy fallback gap

Multiplexed SSE streams use a source workspace id. If the source workspace differs from active workspace, the event is reduced to background busy state and does not mutate the active session store.

However, the legacy fallback stream uses an empty source workspace id. That path behaves like a global stream and bypasses the background-workspace early return.

Risk:

- a fallback/stale stream can mutate the active store without workspace attribution
- if the fallback client is not the current active workspace client, the event source cannot be rejected by workspace id

### 5. `isKnownSessionId` accepts the selected session by id only

The event guard accepts events for a session if the id is already known, exists in the store, or equals the selected session id. This protects normal reconnect races, but it is not workspace-aware.

Risk:

- an event from workspace B for `sess-same` passes when workspace A has selected `sess-same`
- `message.updated` and `message.part.updated` then write into the visible timeline for that shared id

### 6. Some event branches are less guarded than message update

`message.updated` and `message.part.updated` are guarded through known-session checks. Other event types are weaker or unguarded in comparison.

Risk:

- `session.error` can append an error turn to a session id from another workspace
- `message.removed` can remove a message/parts by plain ids
- `message.part.removed` can remove a part by plain message id and part id
- status/idle changes can affect run UI for the wrong visible session if ids collide

These may not insert a full assistant response, but they can create visible corruption that looks like cross-workspace response leakage.

### 7. AI gateway active-run context is session-id-first

The server-side AI gateway active-run registry stores active contexts by session id and workspace id. Resolution first checks session id, then workspace id. Provider-start hit detection also succeeds if either session id or workspace id has a hit.

Risk:

- duplicate session ids across workspaces can attach provider traffic or start detection to the wrong active run context
- this can falsely mark a run as started or associate trace metadata with a different workspace
- not necessarily direct UI transcript leakage, but it can drive wrong runtime/status behavior around a response

The normal managed provider config should include `x-veslo-workspace-id`, which reduces this risk. The risk remains for older config, imported/redacted config, custom provider routing, or any request path where the workspace header is missing or stale.

## Why existing guards are not enough

The system has several good guards, but they operate at different layers:

- selected-session routing uses workspace-aware scope keys
- send flow captures displayed conversation guards
- stale active clients throw on implicit workspace mismatch
- multiplex SSE rejects background source workspaces
- server prefetch cache is workspace-scoped

The leak can still occur because the final UI content store collapses multiple scoped identities into one plain session id key. Once data is written there, the visible session memo reads by selected session id and does not re-check workspace identity per message/part.

## Concrete reproduction target

The cleanest reproduction should not require a full runtime race:

1. Create or mock two workspaces A and B.
2. Give both a transcript snapshot with the same `sessionId`, but different assistant text.
3. Select `sessionId` under workspace A.
4. Hydrate workspace A snapshot and assert A text is visible.
5. Without changing selected session, hydrate workspace B snapshot.
6. Assert the visible messages changed to B text.

If this reproduces at unit level, it proves the root issue independent of Tauri, OpenCode, and network timing.

Secondary reproduction:

1. Selected workspace A/session `sess-same`.
2. Simulate SSE `message.part.updated` from a fallback empty-source stream for `sess-same`.
3. Verify it writes into the visible timeline.
4. Repeat with source workspace B and confirm the multiplex guard blocks it.

This distinguishes the fallback stream gap from the general session-id-only cache issue.

## Recommended fix direction

The durable fix is to make UI timeline state keyed by a workspace/conversation scope key, not plain session id.

Possible scope key:

```text
workspaceId + conversationId/opencodeSessionId/sessionId
```

Specific areas to align:

- message cache
- parts cache
- transcript freshness
- message load limits/completeness
- todos
- session error turns
- session status/run status where visible UI reads it
- command display keyed by message id if message ids are not globally unique

Shorter-term hardening:

- make `hydrateTranscriptSnapshot` validate or require an explicit UI scope key before writing to the active store
- do not hydrate background prefetch directly into the active session store; keep it in a separate workspace-scoped warm cache until selected
- make `isKnownSessionId` workspace-aware, especially the selected-session fast path
- reject empty-source SSE fallback once per-workspace routing entries exist
- add guards to `session.error`, `message.removed`, and `message.part.removed`
- make AI gateway active-run resolution require workspace match when both session id and workspace id exist, and do not let a session-id hit from another workspace satisfy provider-start detection

## Test plan

Recommended tests:

- transcript hydration does not overwrite visible messages for the same session id in another workspace
- background prefetch stores warm data without mutating selected-session messages unless scope matches
- latest-session DB warmup cannot mutate visible timeline for another workspace
- fallback SSE stream is ignored or disabled when workspace routing has entries
- `isKnownSessionId` rejects same-session-id events from a different source workspace
- removal/error event branches require the same workspace/session scope as message update
- AI gateway provider-start detection requires matching workspace for duplicate session ids

## Severity

High. The issue class can make the user see assistant output, error state, or run status from another workspace while the UI still indicates the current workspace. Even if session id collisions are uncommon in normal OpenCode usage, the application already has code and tests acknowledging that duplicate UI/opencode session ids across workspaces are possible at the scope layer.
