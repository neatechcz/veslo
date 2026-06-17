# Workspace Deep Audit 3

Date: 2026-06-17

Scope: current workspace switching behavior across the Veslo desktop app, Solid app shell, local Tauri commands, Veslo server, and orchestrator.

This started as a code-reading audit. A later live Tauri Pilot pass was added on 2026-06-17 after starting the real `packages/desktop` dev runtime.

## Executive Summary

Workspace switching is not a single operation in the current codebase. There are multiple active-workspace state layers that are kept in sync through best-effort registration and activation flows:

- App/Solid runtime state in `packages/app/src/app/context/workspace.ts`
- Tauri persisted workspace state in `packages/desktop/src-tauri/src/commands/workspace.rs` and `packages/desktop/src-tauri/src/workspace/state.rs`
- Veslo server active workspace state, represented as `config.workspaces[0]` in `packages/server/src/server.ts`
- Orchestrator router state, represented as `activeId` in `packages/orchestrator/src/cli.ts`

The most important behavioral distinction: opening a normal session from another workspace generally does not activate that workspace. It records a browse scope and can load the transcript through offline/SQLite-backed paths. Actual activation happens later when the user performs an action that needs runtime ownership, such as sending a prompt, opening a pending draft, creating a session, switching composer target, opening Soul for a workspace, or explicitly opening a project/workspace.

## Sources Of Truth

### Solid App Runtime

The main frontend source of truth is `createWorkspaceStore()` in `packages/app/src/app/context/workspace.ts`.

Important runtime signals:

- `workspaces`
- `activeWorkspaceId`
- `projectDir`
- `connectingWorkspaceId`
- `workspaceConnectionStateById`
- `activeWorkspaceInfo`
- `activeWorkspacePath`
- `activeWorkspaceRoot`

`workspaceConnectionStateById[workspaceId].status === "connected"` means the app-surface activation flow succeeded. For local workspaces this can mean "SQLite browse mode is ready", not "OpenCode engine/client is attached".

### Tauri Persisted State

Tauri stores persisted workspace state with an `active_id`. The relevant commands are:

- `workspace_set_active`
- `workspace_create`
- `workspace_create_remote`
- `workspace_import_config`
- `workspace_forget`

Several creation/import flows set `active_id` directly before the frontend has completed runtime activation.

### Veslo Server

The local Veslo server treats the first workspace in `config.workspaces` as active:

- `GET /workspaces` returns `activeId: config.workspaces[0]?.id`
- `POST /workspaces/local` prepends a new workspace, making it active
- `POST /workspaces/:id/activate` moves that workspace to the front
- `DELETE /workspaces/:id` removes it; the next first workspace becomes active

This active state is separate from Tauri `active_id`.

### Orchestrator

The orchestrator has its own `activeId`.

Key behavior:

- `POST /workspaces` registers local workspace and sets `activeId` only if none exists or the previous active id was legacy/remapped
- `POST /workspaces/remote` registers remote workspace and sets `activeId` only if none exists
- `POST /workspaces/:id/activate` sets `activeId = workspace.id`

Current source also waits for local engine readiness during explicit orchestrator activation. Some tests use surrogate helpers/comments that still describe activation as pure state update without engine spawn; those comments look stale relative to runtime code.

## Primary Activation Flow

The canonical UI-level entry point is `activateWorkspace(...)` in `packages/app/src/app/context/workspace-activation-controller.ts`.

It performs:

- workspace lookup and local/remote validation
- cloud-only blocking for local workspaces
- activation version guard through `wsActivateGuard`
- `connectingWorkspaceId` and connection state updates
- activation timeout handling
- delegation to local or remote activation body
- guarded cleanup of `connectingWorkspaceId`

## Local Workspace Activation

Local activation lives in `packages/app/src/app/context/workspace-activation-local.ts`.

The important ordering:

1. Compute old/next workspace scopes.
2. Clear displayed session state if the workspace root changed.
3. Publish `activeWorkspaceId` and `projectDir` early in one batch.
4. Read workspace config from `.opencode/veslo.json`.
5. Persist selection through Tauri `workspace_set_active`.
6. Decide whether to reuse local host, enter browse mode, or restart runtime.

This means the app can look "already switched" before Tauri persistence and before runtime restart/reattach are done.

Local activation can finish in browse mode:

- sidebar/session history is loaded from SQLite
- `engineReady` is false
- connection state may still be marked `connected`
- engine attaches later through `ensureEngineForWorkspace`

Runtime restart/reattach path:

- direct runtime stops and starts engine
- orchestrator runtime calls `orchestrator_workspace_activate`, then reads `engine_info`, then reconnects routed client
- Veslo server registry activation by path is also attempted through `activateVesloHostWorkspace`

## Remote Workspace Activation

Remote activation lives in `packages/app/src/app/context/workspace-activation-remote.ts`.

Veslo remote path:

- resolve host URL, token, workspace, and directory
- connect through `connectToServer` with reason `workspace-switch-veslo`
- provision/update remote metadata where needed
- persist active workspace through Tauri `workspace_set_active`

Direct remote path:

- connect through `connectToServer` with reason `workspace-switch-direct`
- persist active workspace through Tauri `workspace_set_active`

Remote activation is more eagerly connection-oriented than local browse mode.

## Runtime Attach After Browse Mode

`ensureEngineForWorkspace(...)` in `packages/app/src/app/context/workspace-runtime-controller.ts` is the lazy runtime attach path.

It is used when a local workspace has been selected/browsed without a live engine. It can:

- wait for workspace hydration
- sync workspace skill materialization
- restart or reattach the workspace runtime
- fall back from restart to `startHost`
- for orchestrator timeout cases, try reattach
- call `loadSessions`
- mark the workspace connected
- mark `engineReady` only if the workspace is still active

This is a separate phase from selecting or browsing a workspace.

## Direct And Indirect Switch Entry Points

### Explicit Workspace/Project Open

The workspace/project row click in `workspace-session-list.tsx` calls activation with origin:

- `workspace-session-list:project-open`

The app wrapper clears stale `/session/:id` route state before activating when this origin is used.

### Session Navigation

Normal real-session click:

- records `SessionBrowseScope`
- selects/navigates to the session
- does not activate the workspace by default

Pending session click:

- opens pending view immediately
- calls `openSessionWithWorkspaceActivation` with `activateWorkspaceBeforeOpen: true`
- activates with origin `session-navigation:open-session-before-open`

Session creation:

- cross-workspace create activates first with origin `session-navigation:create-session`

Pending draft navigation:

- activates with origin `session-navigation:open-pending-draft`

### Send-Time Activation

`workspace-send-target.ts` checks whether the selected session belongs to another workspace. If yes, it activates that workspace before sending:

- `send-target:selected-session-workspace`

This is the main bridge between browse-only cross-workspace reading and runtime-owned writing.

### Pending Drafts And New Session

`pending-session-draft-controller.ts` contains several hidden switch paths:

- existing private draft: `app:new-private-existing-pending-draft`
- fresh scratch private workspace: `app:new-private-scratch-workspace`
- project pending draft: `app:open-pending-directory-draft-workspace`
- directory picker draft: `app:open-directory-session-from-picker`

Fresh scratch workspace creation calls Tauri workspace creation first, which can update active id before activation completes. Failure handling then attempts to forget/delete the scratch workspace.

### Composer Target Switch

`composer-target-controller.ts` can activate workspace when the composer target changes:

- `composer-target:workspace`
- `composer-target:chat`
- `composer-target:create-private`

It can also create a scratch workspace for private target creation.

### Directory Session / Move From Private Workspace

Directory selection flows call `ensureWorkspaceForFolder(...)`, which can create or promote a workspace. They snapshot the previous active workspace id before this call because creation can mutate active workspace state before runtime activation.

The app later calls `ensureLocalWorkspaceActive(...)` to force real activation and runtime readiness for the target workspace.

### Soul

Opening Soul for a non-active workspace activates first:

- `dashboard:open-soul-workspace`
- `session:open-soul-workspace`

### Remote Recovery

Remote workspace recovery activates if the workspace is already active:

- `remote-store:recover-active-workspace`

Otherwise it tests the workspace connection without switching.

### Startup Preferred Remote

Startup configured remote flow can activate an existing remote workspace:

- `workspace:connect-preferred-remote`

If activation fails, it may forget that remote workspace and sync the next active id returned by Tauri.

### Engine Reload

Current active workspace reload path calls:

- `app:reload-workspace-engine`

This reuses activation machinery for the current active workspace.

### Forget Active Workspace

When forgetting the active workspace, Tauri selects the next active id. Frontend then calls activation for the new active workspace:

- `workspace:forget-next-active`

## Paths That Change State Without Full Activation

### Tauri Create/Import

These commands set persisted active state directly:

- `workspace_create`
- `workspace_create_remote`
- `workspace_import_config`

Frontend then usually performs runtime activation afterward, but active id may already be changed.

### `ensureWorkspaceForFolder`

For an existing workspace, this promotes it to the top of the frontend list without activating it. For a new workspace, it creates it, and creation mutates active state.

### `startHost({ workspacePath })`

`startHost` can attach runtime to a path and set `projectDir`, but it does not by itself set `activeWorkspaceId` unless the caller has already established the active local workspace. This is correct in current call sites but easy to misuse.

### Server Registry Sync

The frontend/desktop side registers and activates server workspaces by path as part of runtime lifecycle. That can reorder Veslo server `config.workspaces` independently of Tauri `active_id`.

## Browse-Only Behavior

Normal session browsing across workspaces uses `SessionBrowseScope` and conversation scope tracking.

Key state:

- `selectedSessionBrowseScope`
- `conversationScopeBySessionId`
- localStorage key `veslo.workspace-last-session.v1`
- active UI conversation scope token

This lets the UI display a session from a non-active workspace without switching active runtime ownership. When the user sends, send-time activation corrects the runtime target.

## Guards And Race Controls

### Activation Guard

`workspace-activate-guard.ts` prevents stuck overlays and stale cleanup when activations overlap.

### Routing Guard

`workspace-routing.ts` wraps implicit active client lookups. If a caller gets the active client and then the active workspace changes before the async SDK method is invoked, it throws `WorkspaceClientStaleError`.

Explicit `routing.client(workspaceId)` lookups intentionally remain valid for background/multi-workspace flows.

### Connection Guard

`workspace-connection-controller.ts` aborts stale local connects before and after `routing.ensure` if the active workspace/root no longer matches the incoming local directory.

The strongest stale guard is local-specific. Remote connect is guarded by activation supersession and routing identity, but does not use the same root-scope stale abort as local.

### Sidebar Sync Guard

`sidebar-session-sync-guard.ts` prevents target workspace sidebar rows from being wiped by stale previous-workspace session store data or startup-empty stores during a switch.

### Session Snapshot Guard

`workspace-session-snapshots.ts` saves outgoing workspace session state and loads incoming workspace snapshots. It avoids overwriting outgoing snapshots when the selected session is scoped to another workspace.

### Navigation Queues

`session-navigation.ts` serializes and supersedes rapid session, pending draft, and create navigation flows through module-level queues/tokens.

### Runtime Attach Single-Flight

`workspace-runtime-controller.ts` uses single-flight behavior for lazy engine attach per workspace.

## Unexpected Or Risky Findings

1. `activeWorkspaceId` can change before runtime activation completes.
   This is intentional in local activation and Tauri create/import flows, but it creates transient windows where app state says "active" while runtime is not yet attached.

2. `connected` does not always mean "live engine client attached".
   Local browse mode can mark workspace connected after SQLite hydration.

3. Session click is not always a workspace switch.
   Normal real-session click across workspaces is browse-only. Pending session and send are the places where activation occurs.

4. Tauri, Veslo server, and orchestrator active states can diverge temporarily.
   The code reconciles by path/id, but there is no single atomic cross-layer switch transaction.

5. `workspace-lifecycle-state.ts` looks like a lifecycle model but is not wired into runtime.
   It is tested, but current runtime source of truth remains the older signals/controllers.

6. Orchestrator test comments appear stale.
   Runtime activation now waits for local engine readiness, while some surrogate test comments still describe activation as pure activeId update with no spawn.

7. `startHost({ workspacePath })` is a footgun if called without prior active id setup.
   Current call sites appear aware of this, but the function itself is path-first.

8. Remote activation stale protection is not identical to local activation stale protection.
   Local connect checks normalized active root before and after `routing.ensure`; remote relies more on activation supersession and workspace id.

9. `ensureWorkspaceForFolder` can mutate perceived ordering/active state before explicit activation.
   Tests explicitly snapshot active workspace before this call for that reason.

10. Private scratch workspace flows are complex rollback paths.
    Creation mutates workspace state; activation/persistence failures then try to forget/delete the scratch workspace.

## Test Coverage Observed

Strong coverage exists around:

- local activation order and `workspace_set_active` response syncing
- browse mode and lazy boot policy
- project-open route clearing
- send-time activation for scoped selected sessions
- normal cross-workspace session browsing without activation
- pending draft activation flows
- picker-driven directory session/draft flows
- rapid back-and-forth switching
- stale routed client protection
- sidebar sync protection during switches
- workspace snapshot preservation
- Tauri workspace create/set-active/forget behavior
- server workspace CRUD active-id behavior

Much of the app-layer coverage is source-contract testing via regex over source files. That protects exact ordering but can become noisy if the implementation is refactored.

## Live Tauri Pilot Findings

Runtime setup used the real desktop flow:

- Windows dev/test preflight found no stale Veslo dev processes.
- `prepare:sidecar --force` rebuilt the sidecars.
- `cargo clean` and `cargo build --no-default-features` completed.
- `pnpm dev` started `target/debug/veslo.exe`, Vite on `5173`, Veslo server on `8787`, and `veslo-orchestrator.exe`.
- `tauri-pilot.exe ping`, `windows`, `state`, and `snapshot -i` all worked against the `main` window at `http://localhost:5173/#/session`.

### Confirmed Runtime Mismatch

The runtime debug probe reported:

- Frontend active workspace: `ws-5251eba6af25`
- Frontend active root/project dir: `C:/Users/jajse/Desktop/test-repo/test-repo1`
- Frontend routed OpenCode base URL: `http://127.0.0.1:65140/workspace/ws-5251eba6af25/opencode`
- Orchestrator active id: `ws-5251eba6af25`
- Veslo server active workspace id: `ws-bc7813b4e2a9`
- Veslo server active workspace path: `C:/Users/jajse/.veslo/scratch`

The probe emitted:

```text
app-server-active-path-mismatch
Frontend active local workspace path differs from Veslo server active workspace path.
```

This is no longer theoretical. On boot, the app and orchestrator agreed on `test-repo1`, while the Veslo server still considered `scratch` active. The server's `scratch` workspace also carried an OpenCode base URL pointing at the `test-repo1` orchestrator mount, so the mismatch is both identity and path-level.

Impact to verify next:

- Any code reading server `/status` or server `workspaces.activeId` may see `scratch` while the visible UI is on `test-repo1`.
- Server-scoped calls that implicitly use active workspace state can route through the wrong workspace unless they always pass an explicit workspace id/path.
- The server may retain a stale scratch active workspace during desktop bootstrap instead of aligning to the Tauri/orchestrator active workspace.

Attempted click-based switching through an old Pilot snapshot ref was not treated as evidence, because the accessible refs changed after bootstrap and the target ref was no longer a stable `test-repo2` project button.

## Recommended Follow-Up Checks

1. Decide whether normal cross-workspace session click should remain browse-only or become an explicit workspace switch. Current code intentionally treats it as browse-only.

2. Rename or retire `workspace-lifecycle-state.ts` if it is not part of the runtime model, or wire it in as the canonical lifecycle representation.

3. Clean up stale orchestrator test comments and, if needed, add a direct test for current `POST /workspaces/:id/activate` runtime readiness behavior.

4. Document the distinction between "active", "browse connected", and "engine attached" in a user-facing or developer-facing runtime note.

5. Audit remote stale-connect behavior against the local root-scope stale guards.

6. Consider making `startHost` require an explicit `workspaceId` when used with `workspacePath`, or at least assert when it is starting a path that does not match the active local workspace.

7. Trace why Veslo server `/status` remains on the scratch workspace during desktop bootstrap when Tauri/orchestrator/app state are active on `test-repo1`. The first concrete runtime failure to chase is the server active workspace reconciliation, not the frontend sidebar state.
