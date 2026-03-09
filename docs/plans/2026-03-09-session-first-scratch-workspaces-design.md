# Session-First Scratch Workspaces Design

## Summary

Veslo should optimize for the simplest possible BFU flow:

- `New session` always opens a new chat immediately.
- The user should not need to choose a folder before chatting.
- Every new session should run in its own persistent Veslo-managed local workspace folder.
- `Open project/folder` should be a separate explicit action for working in a real user-selected folder.
- Remote/cloud execution support remains in the platform, but it is not exposed in the current end-user UI.

This design supersedes the earlier folder-first `New session` design in [`docs/plans/2026-03-09-new-session-directory-flow-design.md`](/Users/vaclavsoukup/AI%20agent%20projects/Openwork/docs/plans/2026-03-09-new-session-directory-flow-design.md).

## Goals

- Remove worker-management thinking from the primary UX.
- Make first-run and repeat-run behavior obvious for non-technical users.
- Support both casual chat usage and folder-backed project usage.
- Preserve local-first processing and persistence.
- Keep the existing remote/runtime code paths available without surfacing them in default UI.

## Non-Goals

- Removing remote/cloud runtime support from the codebase.
- Designing the full later-stage `Attach folder` migration flow in detail.
- Reworking backend session APIs away from their existing directory-backed model.

## User Model

User-facing concepts:

- `Session`: a chat/task run.
- `Project/folder`: an explicit user-selected filesystem location.
- `Private workspace`: a Veslo-managed local workspace created automatically for a new session.

Internal/runtime concepts:

- `Worker`: internal/runtime terminology only. Do not use as the default user-facing concept in the current UI.

## Primary Actions

### New session

`New session` is the primary CTA across the app.

Behavior:

1. Create a brand-new persistent Veslo-managed scratch workspace folder.
2. Create or register a normal local workspace record for that folder.
3. Ensure the local engine/client is running for that workspace.
4. Create and open a new session immediately.

Important rule:

- `New session` must create a fresh private workspace even if another real project/folder is currently open.

### Open project/folder

`Open project/folder` is the explicit filesystem action.

Behavior:

1. Open the native system folder picker.
2. If the folder is not yet known to Veslo:
   - bootstrap it as a local workspace/project
   - ensure local metadata/config exists
   - start the local runtime
   - create and open a new session immediately
3. If the folder is already known:
   - activate it
   - create and open a new session immediately
4. If the folder is known but missing required metadata:
   - repair/bootstrap metadata
   - then create and open a new session

Both top-level actions always end with a new chat opening.

## Scratch Workspace Model

Scratch workspaces should be implemented as first-class local workspaces, not a separate virtual mode.

Properties:

- one isolated app-managed folder per `New session`
- fully persistent across app restarts and crashes
- visible in sidebar/history until the user deletes them
- safe for generated files without polluting other projects

Illustrative storage shape:

- app data root / `projects/auto/<workspace-id>/`

The exact storage path can vary by platform, but the product rule is that each scratch workspace has its own folder.

## Why This Approach

Recommended approach:

- Treat every scratch workspace as a normal local workspace with an app-managed path.

Reasons:

- reuses the existing directory-backed runtime model
- avoids inventing a special “session without directory” execution path
- keeps files, reload, permissions, and session APIs aligned with current architecture
- minimizes regression risk compared to a virtual/folderless runtime abstraction

Rejected alternatives:

- Always ask for a folder on `New session`: too much friction for BFUs.
- Reuse the current project on `New session`: too stateful and surprising for casual chat usage.
- Shared global scratch workspace: mixes unrelated files from different chats.

## UI and Copy

User-facing copy should be updated to:

- primary CTA: `New session`
- secondary filesystem action: `Open project/folder`
- scratch workspace label: `Private workspace` or equivalent

Avoid default copy that says:

- `worker`
- `connect remote`
- `server`
- `runtime`

Suggested empty state:

- title: `Start a new session`
- body: `Begin in a private workspace, or open an existing project folder.`

## Error Handling

- If scratch workspace creation fails: show a clear error like `Couldn't start a new session`.
- If local engine startup fails: do not silently no-op.
- If session creation fails after workspace creation: keep the workspace and show a retryable error.
- If `Open project/folder` picker is cancelled: no-op, no error.
- If opening a real folder requires repair/bootstrap: complete that automatically before session creation.

## Documentation Changes Required

The repo documentation is currently inconsistent and must be aligned:

- [`AGENTS.md`](/Users/vaclavsoukup/AI%20agent%20projects/Openwork/AGENTS.md) already reflects local-first execution.
- [`PRODUCT.md`](/Users/vaclavsoukup/AI%20agent%20projects/Openwork/PRODUCT.md) must be updated to describe:
  - `New session`
  - `Open project/folder`
  - local-first end-user UX
  - remote support retained in platform but hidden in current UI
- [`ARCHITECTURE.md`](/Users/vaclavsoukup/AI%20agent%20projects/Openwork/ARCHITECTURE.md) must be updated to describe:
  - persistent scratch workspaces as normal local workspaces
  - session creation always targeting a real directory, including scratch workspaces
  - remote support as capability, not current default UX surface

## Testing Requirements

Required verification after implementation:

- `New session` creates a new isolated scratch workspace and opens a session
- repeated `New session` calls create distinct scratch workspaces
- scratch workspaces persist across app restart
- `Open project/folder` bootstraps unknown folders and opens a new session
- `Open project/folder` on known folders still opens a new session immediately
- local engine startup is guaranteed before session creation
- end-user UI no longer exposes remote connect flow by default
- old worker-first empty-state copy is removed or hidden from normal local-first UX

## Open Follow-Up Work

Later design work will still be needed for:

- `Attach folder` / `Move to project/folder`
- naming rules for scratch workspaces in the sidebar
- deletion semantics for scratch workspaces and their files
- any future reintroduction of remote execution into end-user UI
