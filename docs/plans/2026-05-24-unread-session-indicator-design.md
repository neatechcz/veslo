# Unread Session Indicator Design

## Goal

Show a visible unread indication in the left session menu when an assistant response arrives in a session the user is not actively reading.

The indication is local UI state for the current app run. It is not persisted, synced, or stored in the server.

## Behavior

A session becomes unread when a new assistant response is observed and either:

- the response belongs to a different session than the currently selected session, or
- the response belongs to the selected session, but the app window is not focused.

A session is considered actively read only when both conditions are true:

- the session is currently selected, and
- the app window has focus.

Unread state is cleared when:

- the user opens that session, or
- the app window regains focus while that session is already selected.

Unread state is not cleared merely because the app is visible or focused while another session is selected.

## UI

Unread sessions use bold session title text in the left menu.

The indicator appears in both session-list modes:

- Recent
- By Project

The existing running-session indicator remains separate. A running session may also be unread if it responds while the user is focused elsewhere.

No count badge is shown. The design only indicates whether at least one unread assistant response exists.

## Architecture

Keep unread tracking in the app shell, not in backend or durable session state.

The session event store should report that an assistant response became visible for a session. The app shell decides whether that session should become unread based on:

- selected session id
- app focus state
- response session id

The app shell passes an unread session-id map or set into the shared workspace session list. The shared list renders bold labels for matching rows.

## Event Source

Unread should be driven from assistant response events, not from sidebar refreshes or transcript prefetch.

The preferred trigger is a new assistant message/update observed through the live session event stream. This avoids false positives from:

- sidebar list reloads
- startup hydration
- transcript prefetch for visible rows
- offline database reads

The implementation should avoid repeatedly marking the same session from every streamed token once it is already unread.

## Edge Cases

- If the selected session receives a response while the app is focused, do not mark it unread.
- If the selected session receives a response while the app is blurred, mark it unread.
- If a different session receives a response while the app is focused, mark it unread.
- If a different session receives a response while the app is blurred, mark it unread.
- Opening an unread session clears its unread state.
- Focusing the app clears unread state only for the currently selected session.
- Deleting or archiving a session should not require special durable cleanup; hidden rows simply stop rendering. Clearing deleted ids opportunistically is acceptable.

## Out Of Scope

- unread counts
- OS notifications
- dock/taskbar badges
- persistence across restart
- cloud sync
- server API changes
- marking user messages unread

## Testing

Prefer an E2E path for the user-facing behavior if it can be made deterministic in the desktop runtime. Add focused lower-level tests for the decision model and rendering contract.

Minimum coverage:

- decision logic marks unread for inactive sessions even while the app is focused
- decision logic marks unread for the active session when the app is blurred
- decision logic does not mark unread for the active session while focused
- opening a session clears its unread state
- focus return clears unread only for the selected session
- the shared workspace session list renders unread rows with bold title text in Recent and By Project modes

