# New Session Button + Directory Picker Design

## Goal
Replace the sidebar "Add a worker" primary action with a simpler "New session" action that immediately starts chat flow.

## Product Decision
- Primary user action should be session-first, not worker-management-first.
- Clicking the primary button should open a standard system directory chooser.
- The chosen directory defines the local workspace context for the new session.

## Required Behavior
1. Rename primary sidebar CTA from `Add a worker` to `New session`.
2. On click, open native directory picker (Tauri dialog `open(..., directory: true)`).
3. Directory picker default path precedence:
   - first: currently opened worker/session directory
   - fallback: last interacted worker directory
4. After selection:
   - if a local workspace already exists for that path, activate it
   - otherwise create a local workspace for that path
   - then open a new session in that workspace
5. If picker is canceled, do nothing.

## Technical Approach
- Add an app-level handler in `app.tsx` for "new session with directory".
- Extend `workspaceStore.pickWorkspaceFolder` to accept optional `defaultPath`.
- Use normalized paths to match existing local workspaces (`normalizeDirectoryPath`).
- Reuse existing `createWorkspaceFlow(...)`, `activateWorkspace(...)`, and `createSessionAndOpen(...)`.
- Wire the handler into `WorkspaceSessionList` (used by Session and Dashboard sidebars).

## Non-Goals
- No changes to advanced workspace modals/flows beyond primary button behavior.
- No remote/cloud worker UX expansion in this task.

## Acceptance Criteria
- Sidebar primary button label is `New session`.
- Clicking it always opens directory picker in desktop app.
- Picker opens with expected initial directory using stated precedence.
- Selecting a directory opens a new session in the selected workspace context.
- Existing workspace/session lists continue working.
