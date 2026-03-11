# Private Workspace Bundle Design

## Goal
Adjust the sidebar `By project` grouping so Veslo-created private workspaces do not appear as many generated folder names. Instead, they should collapse into one unnamed bundled group.

## Product Decision
- Veslo-created/private workspaces are an implementation detail, not a primary navigation concept.
- In the sidebar they should be visually bundled into one group with no visible project name.
- The existing `Recent` view remains flat, but private-workspace sessions should also omit any secondary project label there.

## Required Behavior
1. Detect Veslo-created/private workspaces using the app's real `isPrivateWorkspacePath(...)` logic.
2. In `By project`, collapse all private-workspace sessions into one synthetic bundled group.
3. That bundled group has:
   - no visible project name
   - the same layout chrome as other groups
   - sessions sorted the same way as `Recent`
4. The bundled group itself is still ordered among other project groups by its latest contained activity.
5. Non-private local workspaces and all remote workspaces keep the current basename-based grouping behavior.
6. In `Recent`, sessions from private workspaces show no secondary project label.

## Technical Approach
- Pass a small predicate from `app.tsx` into the sidebar path:
  - `isPrivateWorkspacePath(path: string) => boolean`
- Thread that predicate through the `DashboardView` / `SessionView` page props to `WorkspaceSessionList`.
- In `WorkspaceSessionList`:
  - classify each row as private or non-private from the actual project root
  - remap private rows to a shared synthetic group key
  - blank the visible label for that shared group
  - use recent-style sorting inside that shared group
- Keep project-scoped `+` behavior unchanged by attaching the bundled group action to the workspace from the most recent session in that group.

## Edge Cases
- If every visible session is in a private workspace, `By project` should show a single unnamed group.
- If a private session later gets moved to a real folder, it should leave the bundled group automatically because its directory metadata no longer matches the private root.
- Remote workspaces are never bundled by this rule, even if their names look generated.

## Verification
- Multiple private workspaces collapse into one unnamed group in `By project`.
- Sessions inside that unnamed group use the same ordering as `Recent`.
- Non-private projects still group by basename.
- `Recent` hides project labels for private-workspace sessions only.
- The bundled group still creates new sessions correctly using the project-level `+`.
