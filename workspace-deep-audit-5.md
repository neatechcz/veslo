# Workspace Switching Deep Audit 5

Scope: synthesis of the "single active" ambiguity. The same behavior can be correct or wrong depending on runtime mode:

- **Non-sandbox / multi-workspace mode:** workspaces should be able to coexist. Background workspaces can have routed clients, pending permissions/questions, running sessions, sidebar rows, browsing state, and cached transcripts without stealing global active UI.
- **Sandbox / isolated mode:** one active runtime context is a valid constraint. Cross-workspace actions should be blocked, explicitly activated, or routed through an isolated per-workspace boundary. They should not silently fall back to the currently active workspace.

The bug class is not simply "single active exists". The bug class is **implicit active fallback**: code that receives or can infer a workspace/session scope, but drops it and calls the active client/store anyway.

## 1. Good single-active

Single-active is acceptable when it is deliberately modeling UI focus or sandbox isolation.

Examples of acceptable single-active state:

- visible main route/view
- focused composer
- active workspace label in the top-level UI
- route ownership of `/session/:id`
- sandbox runtime ownership when only one sandbox may execute at a time
- selected titlebar/session menu when it only applies to the currently displayed conversation

Expected behavior in sandbox mode:

- opening a foreign workspace action should activate that workspace first, or fail visibly
- send/create should require the target workspace to be activated
- question/permission replies should go to the workspace that owns the request, or be blocked if that workspace is not available in the sandbox
- a cached client from another workspace must not be used as an implicit substitute

## 2. Bad single-active

Single-active is wrong when the operation already has a workspace-scoped target.

Bad pattern:

```ts
const c = routing.active();
await c.someApi({ sessionID });
```

when any of these are available:

- explicit `workspaceId` argument
- selected session browse scope
- pending sidebar session metadata
- permission/question owner workspace
- sidebar row workspace
- conversation scope
- target workspace from send preflight
- route/cache snapshot workspace

Correct non-sandbox behavior:

```ts
const c = routing.client(workspaceId);
```

Correct sandbox behavior:

```ts
if (workspaceId !== activeWorkspaceId) {
  await activateWorkspace(workspaceId);
  if (!activationSucceeded) return false;
}
const c = routing.active();
```

The important point: sandbox mode can intentionally require activation, but it still must not silently execute against the wrong active workspace.

## 3. Places where the current code mixes these contracts

### Questions

`permissions` already behave like a multi-workspace system:

- refresh fans out across routed workspace clients
- records are tagged with `workspaceId`
- reply uses `permission.workspaceId`

`questions` still behave like a single-active system:

- `refreshPendingQuestions()` probes only `routing.active()`
- `respondQuestion()` uses only `routing.active()`
- `rejectQuestion()` uses only `routing.active()`
- `activeQuestion` reads only global `store.pendingQuestions`

Contract decision:

- non-sandbox: questions should mirror permissions and be workspace-tagged
- sandbox: foreign workspace question should either force activation or be invisible/blocked with a clear reason
- never: answer a B question through A's active client

### Session mutations

Rename/delete currently still lean on active client semantics.

Risky cases:

- selected session is browsed from workspace B while active workspace is A
- sidebar row passes `workspaceId = B`, but app code still uses `routedClient()`
- duplicate `sessionId` exists in A and B

Contract decision:

- non-sandbox: route by explicit sidebar workspace or selected browse scope
- sandbox: activate that workspace first, then mutate
- never: call active A with session ID from B

### Pending sidebar sessions

Pending rows are currently partly UI-scoped and partly workspace-scoped.

Correct split:

- UI focus can be single-active
- pending row existence must be workspace-scoped
- materialization must only happen after target workspace/session creation succeeds
- failed activation/create must clean up provisional rows

Contract decision:

- non-sandbox: a pending row can belong to a background workspace, but create/send must use that workspace's route
- sandbox: opening/sending from a pending row in workspace B must activate B first
- never: leave a fake pending session in B after failing to activate/create

### Runtime/client readiness

The code often treats "has a client" as equivalent to "target workspace runtime is usable".

That is only valid if the client is scoped to the target workspace and health was checked for that workspace.

Contract decision:

- non-sandbox: `routing.client(workspaceId)` plus per-workspace readiness
- sandbox: active workspace client only after successful activation
- never: infer target readiness from global `client()` or overloaded `connected`

### Session identity

Raw `sessionId` is not enough for multi-workspace state.

Single-active UI can display one `selectedSessionId`, but cross-workspace registries need scoped identity:

- `{ workspaceId, sessionId }`
- or the UI conversation key
- or `{ workspaceId, conversationId, opencodeSessionId }`

Contract decision:

- non-sandbox: message/status/sidebar/archive/cache identity should be scoped
- sandbox: raw `sessionId` can be tolerated only inside the active workspace boundary
- never: accept SSE/message/status updates for raw `sessionId` without checking source workspace when multiple workspace routes exist

## 4. Practical rule for implementation

Every call site should answer two questions before touching runtime/session state:

1. What workspace owns this operation?
2. Is this execution mode allowed to operate on that workspace without activation?

Then choose one of three paths:

```ts
// Multi-workspace allowed.
const c = routing.client(ownerWorkspaceId);
if (!c) return blocked("workspace client unavailable");
return run(c);
```

```ts
// Sandbox isolated.
if (ownerWorkspaceId !== activeWorkspaceId) {
  const ok = await activateWorkspace(ownerWorkspaceId);
  if (!ok) return blocked("workspace activation failed");
}
const c = routing.active();
return run(c);
```

```ts
// No owner can be resolved.
return blocked("workspace scope required");
```

Avoid this fallback:

```ts
const c = routing.client(ownerWorkspaceId) ?? routing.active();
```

That fallback hides the exact bug class we are hunting: a missing or failed target route turns into an operation against the wrong workspace.

## 5. Test matrix to lock the contract

For every workspace-owned operation, test both modes.

Operations:

- open sidebar session
- open Soul
- create pending sidebar session
- send first prompt from pending sidebar row
- send prompt to existing scoped session
- rename session
- delete session
- archive/unarchive
- permission reply
- question reply/reject
- abort session
- refresh latest artifacts
- load earlier messages
- SSE status/message handling

Mode cases:

- active workspace target
- inactive workspace target with routed client available
- inactive workspace target with no routed client
- inactive workspace target with failed activation
- duplicate `sessionId` across two workspaces
- stale cached client for previous workspace
- sandbox enabled
- sandbox disabled

Expected assertions:

- non-sandbox inactive target uses `routing.client(targetWorkspaceId)`
- sandbox inactive target calls activation first
- failed activation does not change route/view/sidebar selection
- missing target client blocks instead of falling back to active
- duplicate session IDs never cross-write messages/status/archive records

## 6. Suggested naming cleanup

The current naming makes this harder than it needs to be:

- `activeWorkspaceId` should mean focused UI/sandbox owner
- `targetWorkspaceId` should mean operation owner
- `connected` should not mean runtime-ready
- `client()` should be treated as legacy active client
- `routedClient(workspaceId)` should be preferred for workspace-owned operations
- `selectedSessionId` should be considered incomplete without `selectedSessionBrowseScope` or `activeUiScopeToken`

Recommended invariant:

> If an operation can affect persisted session/runtime state, raw `sessionId` plus global active client is not enough.

## 7. Concrete follow-up from this audit

The next targeted tests should not just assert "multi-workspace everywhere". They should encode the mode split:

1. In non-sandbox mode, background workspace question reply routes to the background workspace client.
2. In sandbox mode, background workspace question reply activates the workspace first or blocks.
3. In both modes, failed activation never falls back to active workspace client.
4. Delete/rename with explicit sidebar `workspaceId` never uses active workspace client unless that workspace is active or activation succeeded.
5. Pending sidebar session cleanup happens on every failed activation/create path.

