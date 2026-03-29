# Sidebar New Session Pill Relocation Design

Date: 2026-03-29  
Repo: `/Users/vaclavsoukup/AI agent projects/Veslo`

## Summary

Move the primary "new session" action into the sidebar control row and make it behave like the surrounding oval controls.

Target order (left to right):

1. `folder`
2. `recents`
3. `new`
4. `search`
5. `new folder`

The new button shows `+ nová` in compact width and expands to `+ nová relace` (or `+ new session`) once the sidebar width reaches at least `300px`.

## Goals

1. Place `new session` directly in the same visual control line as the adjacent navigation/action controls.
2. Keep a compact, pill-shaped control language across the row.
3. Add tooltip coverage for all five controls.
4. Preserve existing click behavior for session creation.
5. Keep behavior responsive to left sidebar resizing.

## Non-goals

1. No change to backend/session creation logic.
2. No change to command-palette search behavior.
3. No new custom tooltip system (native tooltip only).

## Selected Approach

Selected: **self-measure inside `WorkspaceSessionList` using `ResizeObserver`**.

Rationale:

1. Keeps the responsive label logic encapsulated in the component that owns the controls.
2. Avoids widening parent-level prop surfaces just for label switching.
3. Keeps behavior consistent across both dashboard and session hosts without parent coupling.

Trade-off:

1. Slightly more runtime logic in the component.
2. Requires a small amount of lifecycle cleanup for observer teardown.

## UX and Layout Specification

## Control row structure

1. Remove the current top standalone full-width `New session` button block.
2. Keep the row container (`mb-3 flex items-center gap-2`) as the main control line.
3. Left cluster remains an oval (`rounded-full`) pill group and now contains:
   1. `folder` toggle icon button
   2. `recents` toggle icon button
   3. new session pill button with plus icon and text
4. Right cluster (`ml-auto`) continues to contain:
   1. `search` icon button
   2. `new folder` icon button

## New button visual behavior

1. Shape: rounded pill, matching surrounding oval style language.
2. Base text label:
   1. `<300px`: short label (`sidebar.new`) => `Nová` / `New`
   2. `>=300px`: long label (`sidebar.new_session`) => `Nová relace` / `New session`
3. Always show plus icon.
4. Keep hover/focus styling aligned with adjacent controls.

## Tooltip and accessibility spec

Add `title` and `aria-label` on all five controls:

1. folder (`sidebar.by_project`)
2. recents (`sidebar.recent`)
3. new session (`sidebar.new_session`) even when visible label is short
4. search (`session.command_palette_search_sessions`)
5. new folder (`sidebar.add_directory_session`)

## Interaction and Data Flow

## Click behavior for new button

Unchanged from current behavior:

1. If `onQuickNewSession` exists, invoke it directly.
2. Otherwise toggle the existing add-workspace dropdown menu.

## Width-based label switching

1. Add a root ref for `WorkspaceSessionList` width observation.
2. Observe width with `ResizeObserver`.
3. Maintain `listWidth` signal.
4. Derive `isExpandedNewButton = listWidth >= 300`.
5. Render short or long label based on derived state.
6. Clean up observer on unmount.

Fallback:

1. If width cannot be measured initially, use compact label until first observer callback.

## Error Handling and Edge Cases

1. Keep dropdown logic unchanged to avoid regressions in `onQuickNewSession` optional flow.
2. Ensure no runtime error if observer target is temporarily undefined.
3. Avoid label flicker by only updating on observer events.
4. Preserve disabled state behavior for `new folder` action (`newTaskDisabled`).

## Testing Plan

## Static/layout tests

Update `workspace-session-list-layout.test.ts` assertions to reflect:

1. no standalone top full-width new-session button block
2. action row structure with left pill group + right cluster
3. presence of the add-directory action in right cluster

## Interaction/accessibility tests

Add or update tests to validate:

1. new button is inside the left pill cluster between recents and right-side actions
2. all five controls have `title`/`aria-label`
3. new button uses existing click branching (`onQuickNewSession` vs dropdown toggle)

## Responsive-label unit coverage

Add focused unit coverage for label-threshold logic (`>=300` long label, otherwise short).

## Manual verification checklist

1. Resize left sidebar below and above `300px` and verify `nová` -> `nová relace` transition.
2. Hover all five controls and verify tooltips.
3. Click `new` and confirm behavior matches current flow.
4. Verify no regressions in folder/recent toggle behavior.

## Risks

1. Minor layout tightening may be needed if translated labels are long.
2. Width threshold may need tuning after visual QA.

## Acceptance Criteria

1. Control order is exactly `folder • recents • nová • search • new folder`.
2. New control is oval and includes plus icon.
3. Label expands from compact to full at `>=300px` sidebar width.
4. Tooltips exist on all five controls.
5. Existing new-session action behavior remains intact.
