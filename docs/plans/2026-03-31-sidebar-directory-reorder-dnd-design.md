# Sidebar Directory Reorder (Drag-and-Drop) Design

## Context
When the left menu is in **By Project** mode, directory groups are currently rendered in computed order only. The user wants to manually reorder these directory groups via simple drag-and-drop and keep that order persistent across app restarts.

## Goals
- Enable drag-and-drop reorder of directory groups in left sidebar **only in By Project mode**.
- Persist reordered directory group order in local storage.
- Keep ordering global across the sidebar (not per workspace).
- Avoid behavior changes in Recent mode.

## Non-Goals
- No drag-and-drop for sessions inside groups.
- No drop zone outside existing groups (no explicit "drop-to-end" area).
- No backend/API persistence.
- No new external DnD dependency.

## Approach
Implement native HTML5 drag-and-drop in `workspace-session-list.tsx` for project group headers, following the existing local DnD style already used in `session/sidebar.tsx`.

Store global order of `ProjectSessionGroup.key` values in sidebar preferences (`workspace-session-list-prefs.ts`) via local storage.

`buildProjectGroups()` remains the source for grouping and base order; a lightweight ordering layer in `workspace-session-list.tsx` applies persisted key order before rendering.

## Detailed Design

### 1) UI + Interaction
- Add `GripVertical` drag handle in each project group header.
- DnD state in `WorkspaceSessionList`:
  - `draggingProjectKey: string | null`
  - `dragOverProjectKey: string | null`
- Event flow:
  - `dragstart`: set dragging key and dataTransfer move effect.
  - `dragover`: prevent default and set active drop target key.
  - `drop`: reorder when source/target differ, then persist.
  - `dragleave` / `dragend`: clear hover/drag transient state.
- Visual feedback: subtle drop target highlight (`ring`/tone class), matching existing sidebar language.

### 2) Persistence Model
In `workspace-session-list-prefs.ts`, add:
- `SIDEBAR_PROJECT_ORDER_KEY`
- `readProjectOrder(storage?) => string[]`
- `writeProjectOrder(order, storage?)`
- Normalization helper that accepts only non-empty string arrays.

Order is stored globally as an ordered list of `ProjectSessionGroup.key` values.

### 3) Ordering Algorithm
Render order pipeline in `workspace-session-list.tsx`:
1. Compute `projectGroups()` as today.
2. Build `orderedProjectGroups()` by applying stored key order.
3. Append unknown/new keys in their computed base order.

On drop:
- Reorder currently visible keys.
- Merge with previously stored keys so temporarily missing groups keep relative stability when they return.
- Persist merged result.

## Edge Cases and Failure Handling
- Ignore no-op self-drop (`from === to`).
- Ignore invalid drag payload or unknown target key.
- Storage failures are swallowed (existing prefs behavior); UI remains functional in-memory.
- If groups disappear from current dataset, rendering simply skips them; if they reappear later, stored order applies again.

## Testing Strategy

### Unit tests (`workspace-session-list-prefs.test.ts`)
- `readProjectOrder` default is `[]`.
- Reads valid stored array of strings.
- Invalid payload is normalized to `[]`.
- `writeProjectOrder` persists expected JSON.

### Interaction/layout source tests (`workspace-session-list-*.test.ts`)
- Confirm project rows expose drag handlers (`draggable`, `onDragStart`, `onDragOver`, `onDrop`, `onDragEnd`).
- Confirm presence of grip handle icon import/usage.
- Confirm ordered rendering path uses persisted ordering layer.
- Confirm self-drop guard exists.

### Regression guard
- Existing `workspace-session-list-model.test.ts` continues validating grouping semantics unchanged.
- Recent mode behavior remains unchanged.

## Files Expected to Change
- `packages/app/src/app/components/session/workspace-session-list.tsx`
- `packages/app/src/app/components/session/workspace-session-list-prefs.ts`
- `packages/app/src/app/components/session/workspace-session-list-prefs.test.ts`
- `packages/app/src/app/components/session/workspace-session-list-interactions.test.ts` (or new focused interaction test)
- Potentially `packages/app/src/app/components/session/workspace-session-list-layout.test.ts` if UI affordance assertions are added.

## Rollout and Risk
- Risk is low-to-medium: UI interaction change scoped to one sidebar mode.
- No server or schema changes.
- Easy rollback by removing ordering layer + prefs key.
