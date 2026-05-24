# Resizable Chat Sidebar Design

## Goal

Temporary/private sessions are presented as chats in the by-project sidebar. The top-level Chat control is removed, and the Chaty section owns chat creation, resizing, and collapsing.

## Behavior

- By-project mode shows normal project groups in the main scroll area and Chaty as a bottom section.
- Recent mode is unchanged; chat sessions remain mixed into the recent conversation stream.
- The top control rail no longer includes the Chat button.
- The Chaty header includes the Chat button and calls the same quick-new-session action previously owned by the top rail. The button is enabled whenever that action exists.
- The divider above Chaty is a vertical resize handle. Dragging upward grows the Chaty list; dragging downward shrinks it.
- If the dragged height drops below the minimum useful visible-list height, Chaty collapses instead of showing an unusable sliver.
- Collapsed Chaty renders as a compact bottom row with the Chaty label and an upward chevron. Clicking it restores the last useful height.
- Chaty height and collapsed state persist in local sidebar preferences.

## Implementation Shape

Sidebar state stays local to `WorkspaceSessionList` and persists through `workspace-session-list-prefs.ts`. Pure clamp/collapse math lives in `workspace-session-list-windowing.ts` so it can be tested without DOM setup. The TSX component owns pointer events, captures the pointer while resizing, writes preferences when drag finishes, and uses a CSS height style for the Chaty list container.

## Testing

Use existing source-level sidebar tests for structural regressions and pure unit tests for persisted preferences and height/collapse logic. Run the focused component tests first, then the full UI unit suite and typecheck.
