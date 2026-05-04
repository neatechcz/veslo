# Session Titlebar New Session Context Design

## Goal

Make the chat titlebar show enough context before the first message is sent, especially after the user opens `New session` or starts a new draft for a specific directory.

## Approved Direction

Use a compact centered titlebar label with separate state and location parts:

- `New session` for an unsent/pending chat.
- `New session · <directory>` when the pending chat is tied to a concrete directory.
- `<directory>` for an existing chat that already has messages.

`New session` must be styled as a state label, not as a path. The directory remains path-styled and uses the full path as the tooltip when the UI shows only the leaf folder name.

## Behavior

- Empty pending private drafts show `New session`.
- Empty pending directory drafts show `New session · <directory>`.
- Empty non-pending session surfaces with a known active local workspace show `New session · <directory>`, because the user is composing a new chat in that workspace.
- Existing chats keep the current directory-only titlebar context.
- Remote workspaces keep the existing remote label behavior and may still show `New session` as the state prefix for an empty chat.
- If no workspace or directory context is available, the titlebar shows only `New session` for the new-chat state.

## UI Notes

- Keep the label in the shared centered titlebar slot.
- Use the existing product font, not monospace.
- Keep the label single-line and truncating so it does not collide with titlebar controls.
- Visually separate `New session` and the directory with a subdued dot separator.
- Do not add explanatory in-app copy.

## Technical Approach

- Derive a titlebar context model in the session page from:
  - selected session id,
  - message count,
  - active workspace display,
  - active workspace root,
  - pending draft state passed from the app shell if needed.
- Keep directory formatting close to the existing `resolveComposerWorkspaceLabel` behavior.
- Add or update focused tests around the session titlebar source to cover empty new-chat states.

## Acceptance Criteria

- Opening `New session` shows `New session` in the centered titlebar before any message exists.
- Opening a new draft in a directory shows `New session · <directory>` before any message exists.
- Existing sessions with messages still show the directory context without a `New session` prefix.
- Long paths truncate cleanly and expose the full path through a tooltip.
- The change is covered by focused app tests.
