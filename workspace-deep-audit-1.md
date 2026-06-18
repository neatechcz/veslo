# Workspace Deep Audit 1

## Scope

This audit maps the current workspace switching behavior across the app, Tauri, local Veslo server, and orchestrator layers.

No code changes were made for this audit.

## High-Level Summary

Workspace switching is not handled by a single UI click handler. It is spread across:

- Solid app runtime state (`activeWorkspaceId`)
- Tauri persisted workspace state (`active_id`)
- per-workspace OpenCode routing clients
- local Veslo server workspace activation
- orchestrator workspace activation
- session/pending-draft flows that can switch workspace implicitly

The primary frontend entrypoint is `workspaceStore.activateWorkspace()`, implemented through `createWorkspaceActivationController()`.

The most important behavior: local workspace activation updates the app-level `activeWorkspaceId` early, before the full runtime connection is complete. Reactive effects keyed only on `activeWorkspaceId` can therefore run while the switch is still in progress.

## Main App State

The frontend workspace runtime state is rooted in:

- `packages/app/src/app/context/workspace.ts`
- `packages/app/src/app/context/workspace-activation-controller.ts`
- `packages/app/src/app/context/workspace-activation-local.ts`
- `packages/app/src/app/context/workspace-activation-remote.ts`

`workspace.ts` owns the `activeWorkspaceId` signal and exposes `syncActiveWorkspaceId()`.

`createWorkspaceActivationController()` handles the public `activateWorkspace()` call:

- validates the workspace id
- finds the target workspace
- enters the activation guard
- sets `connectingWorkspaceId`
- marks the target connection state as `connecting`
- runs the local or remote activation body
- clears connecting state in `finally`
- manages the switch timeout

## Local Workspace Activation Flow

Local activation happens in `workspace-activation-local.ts`.

The sequence is:

1. Compute previous and next workspace scope.
2. Detect whether the workspace scope changed.
3. Clear displayed session state if the scope changed.
4. Batch update:
   - `activeWorkspaceId`
   - `projectDir`
5. Read `.opencode/veslo.json`.
6. Update authorized roots.
7. Persist active workspace through Tauri `workspaceSetActive()`.
8. Branch into one of:
   - remote-to-local reattach
   - local browse mode from SQLite
   - local runtime restart
9. Refresh skills/plugins.
10. Mark workspace connection state as `connected`.

Important finding: `syncActiveWorkspaceId(id)` runs before Tauri `workspaceSetActive()` and before runtime reconnect/restart. This is intentional enough to be supported by guards, but it means app effects can observe the new workspace before the runtime is fully ready.

## Remote Workspace Activation Flow

Remote activation happens in `workspace-activation-remote.ts`.

For Veslo remotes:

1. Resolve the Veslo host.
2. Resolve the OpenCode base URL, directory, workspace metadata, and auth.
3. Connect to server through `connectToServer()`.
4. Optionally provision workspace system files via the remote Veslo server.
5. Update local Tauri remote workspace metadata.
6. Persist remote selection:
   - `syncActiveWorkspaceId(id)`
   - `setProjectDir(directory)`
   - clear workspace config/authorized dirs
   - Tauri `workspaceSetActive()`
7. Mark connection state as `connected`.

For direct OpenCode remotes:

1. Connect to the direct base URL.
2. Persist remote selection.
3. Mark connection state as `connected`.

Remote activation generally sets `activeWorkspaceId` later than local activation, after successful connection.

## Explicit Frontend Switch Entry Points

Direct or wrapped `activateWorkspace()` calls exist in these flows:

- Sidebar/project row open
- Session navigation when opening a session in another workspace
- Creating a session in another workspace
- Opening a pending draft in another workspace
- Sending to a selected session that belongs to another workspace
- Opening an existing private pending draft
- Creating a new private scratch workspace
- Opening a directory pending draft from a picker
- Composer target changes to workspace/private chat
- Soul workspace open from dashboard/session page
- Active workspace engine reload
- Preferred remote workspace connection flow
- Remote workspace recovery
- Forget workspace selecting and activating the next workspace

The origin tags found in the app include:

- `workspace-session-list:project-open`
- `session-navigation:open-session-before-open`
- `session-navigation:create-session`
- `session-navigation:open-pending-draft`
- `send-target:selected-session-workspace`
- `app:new-private-existing-pending-draft`
- `app:new-private-scratch-workspace`
- `app:open-pending-directory-draft-workspace`
- `app:open-directory-session-from-picker`
- `composer-target:create-private`
- `composer-target:workspace`
- `composer-target:chat`
- `dashboard:open-soul-workspace`
- `session:open-soul-workspace`
- `workspace:activate-fresh-local`
- `workspace:ensure-local-active`
- `workspace:forget-next-active`
- `workspace:connect-preferred-remote`
- `remote-store:recover-active-workspace`
- `app:reload-workspace-engine`

## Unexpected Or Indirect Switch Entry Points

### Workspace Creation

Creating a workspace sets it active.

This happens in Tauri:

- `workspace_create` sets `state.active_id = id`.
- `workspace_create_remote` sets `state.active_id = id`.
- workspace config import also sets the imported workspace active.

Frontend then applies that active id with `syncActiveWorkspaceId(ws.activeId)`.

### `ensureWorkspaceForFolder()`

`ensureWorkspaceForFolder()` can be surprising.

If the folder already exists as a local workspace, it moves the existing workspace to the front of the frontend list but does not directly call `activateWorkspace()`.

If the folder does not exist, it creates a new local workspace. Because Tauri creation sets `active_id`, the frontend receives and syncs the new active id before a full runtime activation.

`session-navigation.ts` explicitly snapshots the active workspace before calling `ensureWorkspaceForFolder()` because of this behavior.

### Private Chat And Pending Drafts

Opening a new private chat can switch workspace.

The flow:

1. Reuse an existing private pending draft, or create a scratch workspace.
2. Activate the pending/scratch workspace.
3. Restore/create the pending draft.
4. Navigate to the session view.

This means the user action may look like "open chat", but the implementation performs a workspace switch.

### Send Path

Sending to a selected session can switch workspace.

`ensureSelectedSessionWorkspaceActiveForSend()` resolves the selected session's browse scope. If the selected session belongs to a different workspace, it calls `activateWorkspace(targetWorkspaceId, { origin: "send-target:selected-session-workspace" })`.

After that, `ensureEngineForWorkspace()` may start or reattach the runtime for the target workspace.

Important distinction: `ensureEngineForWorkspace()` itself does not change `activeWorkspaceId`; the switch happens before it if needed.

## Session State Side Effects

Workspace switching affects session state through multiple layers.

### Last Session Per Workspace

`workspace-session-selection.ts` stores the last selected session per workspace under:

`veslo.workspace-last-session.v1`

The selected session and selected session browse scope can therefore change as a consequence of workspace switching.

### Session Snapshots

`workspace-session-snapshots.ts` watches `activeWorkspaceId`.

On workspace change, it:

- saves outgoing workspace session state
- loads incoming workspace session state
- clears stale selected session when no snapshot exists and the route allows clearing

This effect is disabled while `connectingWorkspaceId` is set, but the underlying trigger is still `activeWorkspaceId`.

### Displayed Session Clearing

Local activation clears displayed session state early when workspace scope changes:

- selected session id
- messages
- todos
- pending permissions when requested
- session status map

This happens before runtime connection completes.

## Workspace Routing

`workspace-routing.ts` owns per-workspace OpenCode clients.

Important behavior:

- `routing.ensure(workspaceId, baseUrl, ...)` creates or reuses a client for a specific workspace.
- `routing.client(workspaceId)` is an explicit lookup and can be used for background/multi-workspace flows.
- `routing.client()` and `routing.active()` are implicit active-client lookups.
- Implicit active-client calls are wrapped in a guard that throws `WorkspaceClientStaleError` if the active workspace changes between lookup and method invocation.

This is a key protection against accidentally sending SDK calls to the previous workspace after a switch.

## Runtime And Engine Behavior

`workspace-runtime-controller.ts` owns `ensureEngineForWorkspace()`.

It can:

- sync skill materialization before runtime start
- restart workspace runtime
- start host on cold start
- reattach orchestrator workspace on timeout fallback
- load sessions after engine start
- mark workspace connection state as `connected`

It only sets `engineReady` if the target workspace is the current active workspace.

It does not itself switch `activeWorkspaceId`.

## Tauri Workspace State

Tauri stores its own active workspace id in persisted workspace state.

Key commands:

- `workspace_bootstrap`
- `workspace_set_active`
- `workspace_create`
- `workspace_create_remote`
- `workspace_forget`
- `workspace_import_config`

`workspace_set_active` validates the workspace id, optionally promotes the workspace to the front, and writes `state.active_id`.

`workspace_forget` changes active id to the first remaining workspace when the forgotten workspace was active.

On load, Tauri workspace state can also mutate active id:

- stale legacy ids are remapped to stable SHA1 ids
- invalid active ids are replaced by the first workspace id
- imported workspace states can influence active id

## Local Veslo Server Active State

The local Veslo server exposes:

`POST /workspaces/:id/activate`

This:

- resolves the workspace
- moves it to the front of `config.workspaces`
- provisions internal system files
- emits reload events if provisioning changed files
- records a `workspace.activate` audit event
- returns `activeId`

The frontend can call this through `VesloServerClient.activateWorkspace()`.

`workspace-server-registry.ts` can activate a local Veslo server workspace while reconciling app workspaces to server workspaces. This does not directly update Solid `activeWorkspaceId`, but it does mutate server-side active/order state and can affect subsequent server reads.

## Orchestrator Active State

The orchestrator exposes:

`POST /workspaces/:id/activate`

This:

- finds the workspace in orchestrator state
- sets `state.activeId`
- updates `lastUsedAt`
- persists router state
- for local workspaces, waits for the engine to be ready
- returns `activeId`

The CLI command `workspace switch` calls the same endpoint.

Tauri `orchestrator_workspace_activate` registers the local workspace with the orchestrator first, then posts to `/workspaces/:id/activate`.

## Multiple Sources Of Truth

There are at least four active workspace concepts:

1. Solid app `activeWorkspaceId`
2. Tauri persisted `active_id`
3. local Veslo server `activeId` / workspace order
4. orchestrator `activeId`

The app coordinates these best-effort. A partial failure can leave one layer switched while another layer is still stale or failed.

This is especially relevant because local activation updates the Solid app signal before Tauri and runtime activation finish.

## Main Risks

### Early App-Level Switch

Local activation changes `activeWorkspaceId` before runtime connection completes. Effects tied to `activeWorkspaceId` can run during the transition.

Existing guards reduce the risk, but any new effect should check `connectingWorkspaceId`, `workspaceConnectionStateById`, or `engineReady` where runtime readiness matters.

### Implicit Workspace Switches

User actions that may not look like switching can switch:

- new private chat
- existing private draft restore
- opening a directory from picker
- creating a workspace
- importing workspace config
- sending in a session scoped to another workspace
- opening Soul for another workspace

### Server/Orchestrator Desync

The frontend, Tauri, server, and orchestrator active states can diverge after partial failures.

This can produce symptoms where:

- UI shows the new workspace
- Tauri active id is old or failed to persist
- server active workspace order changed independently
- orchestrator active id changed but engine spawn failed

### Session Snapshot Timing

Session snapshot save/load follows active workspace changes. If `activeWorkspaceId` changes optimistically and the activation later fails, session UI may already have been cleared or restored for the target workspace.

### Workspace Creation Side Effects

Creating or importing a workspace sets it active at the Tauri layer. Callers that only wanted to register a workspace need to account for this.

## Practical Debug Checklist

When debugging a workspace switch issue, check:

1. App logs for `activate:start` and activation `origin`.
2. `connectingWorkspaceId`.
3. App `activeWorkspaceId`.
4. Tauri workspace state active id.
5. `workspaceConnectionStateById[target].status`.
6. Whether runtime is in local browse mode or connected mode.
7. `workspaceRouting.entry(targetWorkspaceId)`.
8. Local Veslo server `/workspaces` active id/order.
9. Orchestrator `/workspaces` active id.
10. Session snapshot save/load logs.
11. Whether the switch came from a direct click or an implicit flow such as send, pending draft, or workspace creation.

