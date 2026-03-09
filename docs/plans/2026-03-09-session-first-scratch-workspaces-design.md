# Session-First Scratch Workspaces Design

## Summary

Veslo should optimize for the simplest possible BFU flow:

- `New session` always opens a new chat immediately.
- The user should not need to choose a folder before chatting.
- Every new session should run in its own persistent Veslo-managed local workspace folder.
- A real folder can be chosen later from inside the session.
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
- `Private workspace`: a Veslo-managed local workspace created automatically for a new session.
- `Folder`: an optional real user-selected filesystem location the session can be switched to later.

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

### Choose folder (in-session)

`Choose folder` is a secondary in-session action that is available only while the session is still backed by a private workspace.

Behavior:

1. Open the native system folder picker.
2. Compare the private workspace contents against the chosen target folder.
3. If no filename conflicts exist:
   - copy the current private workspace contents into the chosen folder
   - switch the session/workspace backing path to that folder
   - continue the same session in that real folder
4. If filename conflicts exist:
   - ask the user whether Veslo should replace the conflicting files
   - alternatively allow `Choose another folder`
   - alternatively allow `Cancel`
5. After a successful switch:
   - hide or disable `Choose folder` for that session
   - treat the chosen real folder as the permanent backing workspace for that session
6. Keep the old private workspace as a hidden backup for now.

Implementation note:

- OpenCode does not rewrite the stored `session.directory` when a session starts operating in a new folder.
- Veslo should therefore persist a local session-to-workspace override for migrated sessions so the sidebar, routing, and restart behavior continue to treat the same session as belonging to the chosen folder.

## Scratch Workspace Model

Scratch workspaces should be implemented as first-class local workspaces, not a separate virtual mode.

Properties:

- one isolated app-managed folder per `New session`
- fully persistent across app restarts and crashes
- visible in sidebar/history until the user deletes them
- safe for generated files without polluting other projects
- retained as hidden backup after a successful folder switch

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
- Top-level `Open project/folder`: adds a second creation path the user does not need to think about.
- Reuse the current project on `New session`: too stateful and surprising for casual chat usage.
- Shared global scratch workspace: mixes unrelated files from different chats.

## UI and Copy

User-facing copy should be updated to:

- primary CTA: `New session`
- scratch workspace label: `Private workspace` or equivalent
- in-session secondary action for private-workspace sessions: `Choose folder`

Avoid default copy that says:

- `worker`
- `connect remote`
- `server`
- `runtime`

Suggested empty state:

- title: `Start a new session`
- body: `Begin in a private workspace. You can choose a folder later if you need one.`

## Error Handling

- If scratch workspace creation fails: show a clear error like `Couldn't start a new session`.
- If local engine startup fails: do not silently no-op.
- If session creation fails after workspace creation: keep the workspace and show a retryable error.
- If `Choose folder` picker is cancelled: no-op, no error.
- If copying into a chosen folder finds conflicts: show a simple all-or-nothing conflict dialog with:
  - `Replace conflicting files`
  - `Choose another folder`
  - `Cancel`
- Do not require per-file merge UI.

## Documentation Changes Required

The repo documentation is currently inconsistent and must be aligned:

- [`AGENTS.md`](/Users/vaclavsoukup/AI%20agent%20projects/Openwork/AGENTS.md) already reflects local-first execution.
- [`PRODUCT.md`](/Users/vaclavsoukup/AI%20agent%20projects/Openwork/PRODUCT.md) must be updated to describe:
  - `New session`
  - `Choose folder` later inside the session
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
- local engine startup is guaranteed before session creation
- private-workspace sessions show `Choose folder`
- real-folder-backed sessions do not show `Choose folder`
- choosing a folder copies files and switches the current session to the chosen folder
- conflict cases show overwrite/choose another/cancel options
- successful folder switch keeps the old private workspace as hidden backup
- end-user UI no longer exposes remote connect flow by default
- old worker-first empty-state copy is removed or hidden from normal local-first UX

## Open Follow-Up Work

Later design work will still be needed for:

- naming rules for scratch workspaces in the sidebar
- cleanup strategy for hidden backup private workspaces
- any future reintroduction of remote execution into end-user UI
