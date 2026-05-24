# Temporary Sessions as Chats Design

## Context

Veslo already supports unassigned conversations by creating temporary private workspaces under the desktop-managed private workspace root. These sessions are technically normal OpenCode sessions, but the current UI can expose the generated temporary directory or hash-like folder name. That makes private, directory-less conversations feel like broken project sessions instead of plain chats.

The approved product change is to treat the existing temporary/private-folder sessions as "chats" in the UI. This is a presentation and grouping change only. It must not introduce a new backend session type, change OpenCode session semantics, or migrate existing data.

## Goals

- Rename the primary "New session" action for this flow to "Chat".
- In the project-grouped sidebar view, show existing temporary/private sessions in a distinct bottom section named "Chaty".
- Add a "+ Chat" action in the "Chaty" section header that starts the same private-session flow used by the current new-session button.
- Keep the recent sidebar view as a single activity-sorted mix of all sessions, including chats and project sessions.
- Show the discussion/session title for chats in the sidebar and titlebar. Do not show the generated temporary folder name or hash.
- Use "Chat" as the fallback label when a chat session has no generated title yet.

## Non-Goals

- No new persisted `chat` session type.
- No backend API changes.
- No migration for existing temporary sessions.
- No behavior change for project-scoped sessions.
- No behavior change for the recent sidebar view beyond copy changes shared with the new-session action.

## Classification

The app should classify a session as a chat when its resolved session directory or containing workspace path is inside the existing private workspace root, using the same `isPrivateWorkspacePath` logic already used by the sidebar model.

This keeps the change compatible with existing temporary sessions and avoids adding product semantics to OpenCode session records.

## Sidebar Behavior

The project-grouped sidebar should split renderable groups into:

- Normal project groups, shown in the current scrollable project list.
- The private/temporary group, shown as a separate bottom-anchored "Chaty" section.

The "Chaty" section should reuse the existing session row behavior:

- current selection state
- running indicator
- archive/unarchive behavior
- subagent branch indentation and expansion where relevant
- relative activity time
- pagination or load-more behavior where needed
- opening sessions through the existing workspace activation path

The section should not expose workspace/project actions such as rename workspace, share workspace, reveal in Finder, Soul settings, or remote connection actions, because chats are not user-facing projects.

The recent sidebar view should remain unchanged: it lists all visible sessions together by activity.

## Labels

For chat sessions, the visible label should be:

1. trimmed session title, when available
2. trimmed session slug, if title is missing and slug is meaningful
3. "Chat" fallback

For project sessions, the existing labeling behavior should remain unchanged.

The top-level sidebar action currently labeled "New session" should use "Chat" for this private-session flow. The add-directory/project action remains separate and keeps its current meaning.

## Titlebar

The session titlebar should hide generated private workspace locations for all private/temporary sessions, not just brand-new empty drafts.

For an existing selected chat, titlebar context should prefer the selected chat title. If there is no usable title yet, it should show "Chat". It must not display the private workspace directory. Project sessions continue to show their workspace/project context as they do today.

## Error Handling

If private workspace classification is unavailable, the UI should fall back to existing behavior rather than hiding sessions. A failure to create a new chat should continue to use the existing private session error path.

## Testing

Focused tests should cover:

- project grouping separates private sessions from normal project groups
- empty private workspaces remain hidden
- project-grouped render data exposes a private chat section only when private sessions exist
- recent mode still includes private sessions in the normal activity order
- chat row labels use the session title and fall back to "Chat"
- titlebar hides private directory names and shows the chat title/fallback for selected private sessions
- localization copy for "Chat" and "Chaty"

Manual verification should use the real Tauri desktop runtime after implementation: create a new chat, send a message, confirm the sidebar bottom section and titlebar labels, then switch to recent mode and confirm the chat appears in the mixed recent list.
