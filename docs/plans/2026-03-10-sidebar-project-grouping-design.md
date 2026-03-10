# Sidebar Project Grouping Design

## Goal
Refine the left session menu so users can see the project folder each session belongs to, create sessions directly inside an existing project, and switch between grouped and recency-based browsing without increasing visual weight.

## Product Decision
- The sidebar keeps a compact, subtle look. This is a refinement of the current rail, not a redesign.
- The two browsing modes are `By project` and `Recent`.
- `By project` is the default mode.
- The mode switch should stay compact, using icons in the rail and `By project` / `Recent` as tooltip and accessibility labels.

## Required Behavior
1. Keep the global `New session` button at the top of the session list.
2. Replace the wide text segmented control with a compact two-icon toggle:
   - folder icon = `By project`
   - list icon = `Recent`
3. In `By project`:
   - show project headers using only the basename of the worker directory
   - use a small folder icon and muted folder label color
   - keep the per-project `+` visible at all times
   - indent session rows under the project header
   - add extra vertical spacing before the next project header
4. Remove the per-session `+` button in all modes.
5. The per-project `+` creates a new session in that existing worker folder.
6. `Recent` shows one flat newest-first feed and keeps a muted secondary project basename on each row.
7. Project groups in `By project` are ordered by the latest edited session they contain.
8. Projects with zero sessions are not shown.
9. Sessions with blank directory metadata may appear under an empty grouped bucket in `By project`.
10. Remote and local workers are grouped the same way: by the folder they run from.

## Technical Approach
- Keep `workspaceSessionGroups` in `packages/app/src/app/app.tsx` as the source for sidebar sessions.
- Derive both views from the same data in `packages/app/src/app/components/session/workspace-session-list.tsx`.
- Persist the sidebar mode locally with a new preference such as `by-project | recent`.
- Derive the visible project label from:
  - local worker: basename of `workspace.path`
  - remote worker: basename of `workspace.directory`
  - fallback only when directory metadata is actually blank
- Reuse the existing `createTaskInWorkspace(workspaceId)` flow for the per-project `+`.
- Keep the existing global `New session` flow unchanged.

## Edge Cases
- If two projects share the same basename, keep the basename in the row and expose full path or host via hover title/tooltip.
- If a session has blank directory metadata, allow it to appear in `Recent` and optionally under an empty grouped bucket in `By project`.
- Keep existing worker-level loading and error indicators on project headers in `By project`.
- Do not repeat worker status badges on every row in `Recent`.

## Verification
- Switching between `By project` and `Recent` updates the list immediately and persists across reloads.
- The global `New session` button still works.
- The project-level `+` creates a session in the correct existing worker.
- Per-session `+` buttons are gone.
- Grouped sessions are visually indented beneath project headers.
- Project headers use the folder basename only, not the full path.
- Project ordering follows latest activity, not alphabetical order.
- Empty projects are hidden.

## Pencil Notes
- Grouped-state mock drafted in the active Pencil editor with:
  - compact icon toggle
  - indented session rows
  - muted project labels
  - always-visible project-level `+`
