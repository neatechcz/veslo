# Sidebar Add Directory Session Design

**Date:** 2026-03-28  
**Status:** Approved  
**Branch:** main

## Goal

Add a new left-sidebar action that lets the user pick a local directory, adds that directory to the worker list when needed, and immediately opens a new session in that directory.

## Scope

- Left sidebar session list actions in:
  - `packages/app/src/app/components/session/workspace-session-list.tsx`
  - `packages/app/src/app/pages/session.tsx`
  - `packages/app/src/app/pages/dashboard.tsx`
- Local workspace/session orchestration through existing workspace store and session navigation helpers.
- Layout adjustment for the top action row in the left sidebar.

Out of scope:

- Remote worker creation or connection flows.
- Changes to the existing `New session` scratch-workspace flow.
- New modals, toasts, or extra configuration UI.

## Validated Product Decisions

1. The new action is a dedicated icon in the left sidebar.
2. Clicking the icon opens the native directory picker immediately.
3. The action is visible in both `Session` and `Dashboard`.
4. The new icon is right-aligned in the left menu.
5. If the chosen directory already exists as a local worker, Veslo must not create another worker.
6. In the duplicate-directory case, Veslo activates the existing worker and opens a new session in it.
7. Canceling the picker is a silent no-op.

## Options Considered

### Option 1: Direct picker-driven flow

Add a new sidebar icon that triggers:

- `pick directory`
- `ensure workspace`
- `activate workspace`
- `create session`

Pros:

- Matches the requested UX exactly.
- Reuses existing path-based workspace deduplication.
- Avoids temporary scratch-workspace churn.

Cons:

- Needs a new action callback plumbed through both page shells.

### Option 2: Menu or modal before picker

Add a new icon but route it through an intermediate menu/modal before opening the picker.

Pros:

- Leaves room for more actions later.

Cons:

- Adds an extra click with no current product value.
- Breaks the requested direct interaction.

### Option 3: Reuse scratch-session then move-directory flow

Start a new private-workspace session, then ask the user to move it into a selected directory.

Pros:

- Reuses existing move-session machinery.

Cons:

- Wrong mental model for a user who already knows the target directory.
- Slower and more failure-prone.
- Creates unnecessary temporary workspace state.

## Recommended Approach

Use Option 1 and build the new icon as a thin entry point into the existing local workspace/session primitives.

- Keep `WorkspaceSessionList` presentational.
- Put the picker + orchestration logic in the page/app layer.
- Reuse `workspaceStore.pickWorkspaceFolder()`.
- Reuse `workspaceStore.ensureWorkspaceForFolder()` so deduplication stays path-based and centralized.
- Reuse `createSessionWithWorkspaceActivation(...)` so activation and session creation stay single-flight.

## Architecture

### Sidebar layout

- Split the top action row in `workspace-session-list.tsx` into:
  - left cluster: `By project / Recent`
  - right cluster: search icon when available, plus the new add-directory icon
- In `Dashboard`, where session search is not shown, the add-directory icon still sits in the right cluster.
- Use the same visual button treatment as the existing search action.

### Component contract

Add a new callback prop to `WorkspaceSessionList`, such as:

- `onAddDirectorySession?: () => void`

This callback is wired from both:

- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/dashboard.tsx`

### New flow

Add a new app-level flow alongside the current scratch-session flow:

1. Open native directory picker with `workspaceStore.pickWorkspaceFolder()`.
2. If the user cancels, exit silently.
3. Call `workspaceStore.ensureWorkspaceForFolder(selectedFolder)`.
4. If the workspace already exists for that normalized path, reuse it.
5. If it does not exist, create it through the existing workspace store path.
6. Call `createSessionWithWorkspaceActivation(...)` with the resolved workspace ID.
7. Let existing activation/session routing logic handle selection and navigation.

## State And Error Handling

- The new action respects `newTaskDisabled`.
- Duplicate local directory selection is expected behavior, not an error.
- No separate deduplication logic should be added in the sidebar component.
- Canceling the picker does not show an error.
- Failures from pick/create/activate reuse existing app error handling.
- If workspace activation fails, no session is created.
- If needed for UX safety, use a dedicated pending flag for this action instead of a global shared `busy`.

## Testing Strategy

### Unit tests

1. Existing workspace path:
- pick folder
- resolve to existing local worker
- activate that worker
- create session

2. New workspace path:
- pick folder
- create local worker
- activate new worker
- create session

3. Cancel picker:
- no workspace creation
- no workspace activation
- no session creation

### Component/layout tests

- Verify the new icon renders in the right-aligned action cluster.
- Verify `Session` shows search + add-directory actions together.
- Verify `Dashboard` shows the add-directory action right-aligned even without search.

### Manual verification

1. Open `Session` and click the new icon.
2. Pick an existing worker directory and confirm Veslo switches to that worker and opens a new session.
3. Pick a brand-new local directory and confirm Veslo adds a worker and opens a new session there.
4. Cancel the picker and confirm nothing changes.
5. Repeat the flow from `Dashboard`.

## Acceptance Criteria

- A new add-directory icon is visible in the left sidebar in both `Session` and `Dashboard`.
- The icon is right-aligned in the left sidebar action row.
- Clicking the icon opens the native directory picker directly.
- Selecting an existing local worker directory opens a new session in that worker without creating a duplicate worker.
- Selecting a new local directory adds a worker and opens a new session in it.
- Canceling the picker causes no visible error and no state change.
