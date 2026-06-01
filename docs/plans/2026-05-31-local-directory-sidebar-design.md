# Local Directory Sidebar Design

## Goal

When a user adds a local project directory, Veslo should immediately show that project in the left sidebar project/workspace list when the sidebar is grouped by project.

## Scope

This applies only to local workspaces. Remote workspaces and sandbox flows are unchanged.

## Design

The sidebar should derive the visible project list from the workspace store, not from runtime startup. A newly added local workspace with no sessions should be represented as a workspace-only project group. This keeps the project visible immediately while preserving the existing opening behavior: the current pending-draft and activation flow remains in the same order, and this change only inserts a sidebar publication step after the directory is registered.

The implementation should keep the existing `WorkspaceSessionList` model as the source of truth for empty local project rows. The app flow that adds a local directory should update the workspace list as soon as the directory is registered, then let the existing sidebar projection render it. Private scratch workspaces remain hidden when empty.

## Testing

Add a focused app-side test that proves the directory picker flow publishes the registered workspace before activation/opening continues. Keep the existing activation tests intact so the current workspace-opening flow does not move.
