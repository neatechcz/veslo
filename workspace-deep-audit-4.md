# Workspace Switching Deep Audit 4

Scope: follow-up audit beyond the 7 already confirmed targeted failures. This focuses on paths that are not obvious "switch workspace" UI flows, but still depend on the active/routed workspace boundary: questions, session mutations, pending sidebar materialization, stale routed clients, and duplicate session IDs.

## 1. Questions are still single-active, while permissions are per-workspace

**Code evidence**

- `packages/app/src/app/context/session.ts:1009` `refreshPendingQuestions()` uses only `options.routing.active()`.
- `packages/app/src/app/context/session.ts:1289` `respondQuestion()` uses only `options.routing.active()`.
- `packages/app/src/app/context/session.ts:1307` `rejectQuestion()` uses only `options.routing.active()`.
- `packages/app/src/app/context/session.ts:1375` `activeQuestion` reads only `store.pendingQuestions`.
- In contrast, permissions already fan out per workspace and route replies through `perm.workspaceId` around `packages/app/src/app/context/session.ts:925` and `packages/app/src/app/context/session.ts:1271`.

**Why this is a real workspace-switching bug**

If workspace A is active and workspace B has a running opencode question, the app does not probe B for questions. If a B question somehow reaches the UI after a switch/cache restore, reply/reject still goes through A's active client. This can make the question invisible, stuck, or answered against the wrong runtime.

**Targeted test**

Create a `createSessionStore` routing mock with clients for `ws-a` and `ws-b`, active `ws-a`, and `question.list()` returning a question only for `ws-b`. The expected contract should mirror permissions:

- `refreshPendingQuestions()` probes all routed clients.
- questions are tagged with `workspaceId`.
- `respondQuestion("q-b")` calls `ws-b.question.reply`, not active `ws-a`.

## 2. Current-session mutations can hit the active client, not the selected session's workspace

**Code evidence**

- `packages/app/src/app/context/session.ts:874` `renameSession()` uses `options.routing.active()`.
- `packages/app/src/app/app.tsx:4567` `renameSessionTitle()` delegates to `renameSession(sessionID, trimmed)` and refreshes the active sidebar.
- `packages/app/src/app/app.tsx:4577` `deleteSessionById(sessionID, workspaceID?)` accepts a workspace id, but then calls `const c = routedClient()` and deletes via the active client.
- `packages/app/src/app/pages/session.tsx:3239` the generic session menu opens delete using `props.activeWorkspaceId`, not the selected session browse scope.

**Why this is a real workspace-switching bug**

The app supports browsing a session from another workspace without making that workspace active. In that state, selected session identity can be foreign to the active workspace. Rename and delete still use the active route. The destructive case is especially bad: deleting a sidebar/browsed session from workspace B while A is active can send `session.delete` to A with B's `sessionID` and B-ish directory params.

This becomes catastrophic when session IDs collide across workspaces, but it is still wrong without collision because the active runtime receives a request for a foreign directory/session.

**Targeted test**

Source-level or unit contract:

- selected session has browse scope `{ workspaceId: "ws-b", directory: "/repo/b" }`
- active workspace is `ws-a`
- `deleteSessionById("s1", "ws-b")`
- expected: calls `routedClient("ws-b").session.delete({ sessionID: "s1", directory: "/repo/b" })`
- current: calls `routedClient()` / active `ws-a`

Same shape for rename:

- expected: rename routes by selected session scope or explicit workspace id
- current: active route only

## 3. `connectToServer` idempotent skip can leave the global client bound to the previous workspace

**Code evidence**

- `packages/app/src/app/context/workspace-connection-controller.ts:159` reads `cachedRoutingClient` for the guard workspace.
- `packages/app/src/app/context/workspace-connection-controller.ts:162` checks only that `deps.client()` exists, the cached route exists, base URL matches, and directory matches.
- `packages/app/src/app/context/workspace-connection-controller.ts:167` returns from `connect:idempotent-skip` without `commitRoutedClient(...)`.
- `packages/app/src/app/context/workspace-connection-controller.ts:276` only real ensure path commits the routed client globally.

**Why this is a real workspace-switching bug**

If workspace A and B share the same base URL and normalized directory, and B already has a routed client, activating B can skip without rebinding the global `client()` to B's cached route. Most new code should use `routing.client(workspaceId)`, but there are still legacy/global reads. After the skip, active workspace can be B while the global client still points to A.

This is subtle because all guard conditions look "idempotent", but the idempotence is not scoped to the same client object or same workspace id.

**Targeted test**

Mock deps:

- active global `client()` is `clientA`
- `routing.client("ws-b")` returns `clientB`
- `baseUrl` and `clientDirectory` match the incoming B connection
- call `connectToServer(..., { workspaceId: "ws-b" })`

Expected contract:

- either `setClient(clientB)` is called before returning true, or skip requires `deps.client() === cachedRoutingClient`

## 4. Pending sidebar rows can leak permanently after send/create failure

**Code evidence**

- `packages/app/src/app/app.tsx:3536` registers `pendingSidebarSession` before engine/runtime/create success is guaranteed.
- `packages/app/src/app/app.tsx:3680` handles `sendPrompt:blocked-no-session` without removing the pending sidebar row.
- `packages/app/src/app/app.tsx:10161` `createSessionAndOpen:error` returns `undefined`.
- `packages/app/src/app/app.tsx:10167` finally clears busy/creating state, but does not remove the pending sidebar row.
- `packages/app/src/app/app.tsx:10088` materializes pending row on success, but there is no symmetric failure cleanup.

**Why this is a real workspace-switching bug**

This is separate from the confirmed "pending row visually opens before workspace activation" bug. Even if the row is not opened early, the row can still be inserted optimistically and never removed when engine start, runtime health, Veslo conversation creation, legacy `session.create`, or selection fails.

The result is a fake session row in a workspace sidebar that never materializes. Later clicks operate on a pending id that cannot be loaded from runtime or DB.

**Targeted test**

Use the send/create path with a pending sidebar session and force `createSessionAndOpen` to fail after `registerPendingSidebarSession`. Expected:

- pending row is removed from `sidebarSessionsByWorkspaceId[workspaceId]`
- selected session / active UI scope does not remain on the pending id
- no workspace last-session storage is written for that pending id

## 5. Standalone `createSessionAndOpen` continues after failed runtime reachability if a client exists

**Code evidence**

- `packages/app/src/app/app.tsx:9889` runs `ensureLocalRuntimeReachableForSend(...)`.
- If that returns false, `packages/app/src/app/app.tsx:9898` only records `createSessionAndOpen:runtime-unreachable-continue`.
- `packages/app/src/app/app.tsx:9899` then continues to `routedClientForSendTarget(targetWorkspace)`.

**Why this is a real workspace-switching bug**

`sendPrompt()` blocks on runtime unreachable before creating a session. But standalone create flows can continue after failed reachability as long as a routed client object still exists. That is exactly the state that produced several of the current workspace bugs: a cached or provisional client exists, while activation/runtime health has failed.

This can create or open a session through stale runtime state after the app already detected runtime was not reachable.

**Targeted test**

Call `createSessionAndOpen()` with:

- `ensureLocalRuntimeReachableForSend` returning false
- `routedClientForSendTarget(...)` returning a cached client

Expected contract:

- session creation is blocked unless an explicit "offline create" path is selected
- no `session.create`, no sidebar materialization, no route change

## 6. Duplicate session IDs are still unsafe in the active store and SSE filter

**Code evidence**

- `packages/app/src/app/context/session.ts:330` `workspaceSessionIds` is a plain `Set<string>`.
- `packages/app/src/app/context/session.ts:1428` `isKnownSessionId()` accepts by raw id.
- `packages/app/src/app/context/session.ts:1441` accepts the currently selected raw id even when workspace membership is out of sync.
- message/status/todo stores are keyed by raw `sessionID`.
- `packages/app/src/app/lib/conversation-scope.ts:150` only resolves a scope by active workspace or when exactly one candidate exists; ambiguous duplicate IDs return `null`.
- `packages/app/src/app/context/workspace-session-selection.ts:307` `activeWorkspaceLastSessionId()` stores/restores only the raw session id. If `resolveSelectedSessionBrowseScope(stored)` returns `null` due ambiguity, the stored id is still accepted.

**Why this is a real workspace-switching bug**

The sidebar prefetch code explicitly avoids attributing ambiguous clicked/selected IDs across workspaces, which confirms duplicate IDs are a known hazard. The active session store does not have the same protection.

Problem scenario:

1. Workspace A and B both have `session.id === "shared"`.
2. User browses B's `shared` while A remains active.
3. Active A emits SSE for `shared`.
4. `isKnownSessionId()` accepts it because the selected session id is also `shared`.
5. `store.messages["shared"]`, `store.sessionStatus["shared"]`, and active UI can now reflect A events while displaying B scope.

This also affects workspace last-session restore: because storage is `workspaceId -> raw sessionId`, an ambiguous `shared` id can be restored without a scope and later resolve through the active runtime.

**Targeted test**

Use two workspace scopes for the same session id:

- selected browse scope is B/shared
- active workspace is A
- feed an active A SSE `session.status` or `message.part.updated` for `shared`

Expected contract:

- event must be rejected unless source workspace matches selected scope/workspace membership
- status/message maps should be keyed by a scoped conversation key, or SSE filtering should compare `(workspaceId, sessionId)` rather than `sessionId`

## 7. Sidebar archive identity is workspace-aware for snapshot, but unarchive is raw-session-id only

**Code evidence**

- `packages/app/src/app/app.tsx:6317` archives with `(workspaceId, sessionId)` and builds a snapshot that includes workspace metadata.
- `packages/app/src/app/app.tsx:6340` unarchives by `sessionId` only.
- `packages/app/src/app/app.tsx:11903` and `packages/app/src/app/app.tsx:12265` ignore the workspace id argument for unarchive.

**Why this is a real workspace-switching bug**

Archive has enough information to distinguish `ws-a/shared` from `ws-b/shared`, but unarchive collapses identity to `shared`. With duplicate session IDs, unarchive can restore/remove the wrong archive record or all matching records depending on server behavior.

This is not strictly runtime activation, but it is a sidebar workspace identity bug and will show up as "wrong workspace session disappeared/reappeared" after switching.

**Targeted test**

Archive two sidebar sessions with the same `sessionId` in different workspaces. Unarchive only `ws-b/shared`.

Expected contract:

- archive API and local records address `(workspaceId, sessionId)` or a stable archive id
- `ws-a/shared` remains archived

## Suggested priority

1. Fix questions per-workspace routing first. It mirrors the permission fix and can strand real opencode flows.
2. Fix destructive/current-session actions to route by selected scope or explicit workspace id.
3. Fix `connectToServer` idempotent skip so global client rebinding cannot be skipped across workspace ids.
4. Add cleanup for pending sidebar rows on send/create failure.
5. Block standalone create after failed runtime health.
6. Decide whether raw session IDs are allowed to collide. If yes, the active store and SSE filter need scoped keys; if no, add explicit collision detection and hard guards.
