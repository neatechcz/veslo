# VSLO-195 Pending Session Submit Design

## Goal

Fix `VSLO-195` so Composer submit behaves as if the target session already exists, even while Veslo is still materializing or attaching the real session in the background.

The user-visible rule is: once a draft is sent, it belongs to the timeline, not to the Composer. The Composer immediately becomes available for the next draft.

## Current Failure

The existing optimistic submit path renders a temporary user message, but Composer remains tied to the asynchronous handoff. During session creation and prompt handoff, the local submit lock and global busy state can keep the Composer unavailable. This makes the UI feel like it is waiting for session creation instead of accepting the message as sent.

The previous rollback behavior is also unsafe for a non-blocking Composer. If the user has already started another draft or moved to another new session, automatically restoring the failed message into Composer can overwrite unrelated work or put text into the wrong context.

## Design

Use a committed pending message model for first sends into an unmaterialized session.

On submit:

- create a pending timeline message immediately
- clear Composer immediately
- release Composer for further input
- start or continue the backend handoff in the background
- keep the pending message associated with the pending-session key until a real session id exists

If handoff succeeds, remap pending state to the real session and let the real transcript take over once the backend emits the message/run.

If handoff fails before a real message exists, keep the submitted message in the timeline with a failed pending state. Do not restore it into Composer automatically. The user can explicitly edit the pending message with the pencil action, which loads that specific message back into Composer only by user intent.

## Message And Queue Semantics

Messages sent while the first pending session is materializing stay ordered under the same pending-session key. Once the real session id is known, that queue transfers to the real session and drains in original order.

If the user opens or creates another new session while the first pending session is still materializing, that new session gets its own pending-session key and queue. No automatic rollback or retry may move text between those sessions.

## Error Handling

There are two failure classes:

- Before real message commit: mark the pending timeline message failed and expose edit/retry affordances.
- After real message commit: keep the real transcript message and use existing edit, retry, and resend flows.

The Composer is never used as an implicit rollback buffer after submit.

## UI Requirements

- Composer clears and becomes editable immediately after submit.
- The submitted message remains visible in the timeline while handoff runs.
- The message can show a pending/sending state until real session/message state arrives.
- Failed pending messages show an explicit failed state and an edit affordance.
- Editing a failed pending message is explicit and scoped to that message.

## Testing

Prefer a desktop E2E path for the final verification because this is session-runtime behavior.

Focused app tests should also cover:

- Composer is released immediately after submit, before `sendPromptAsync` settles.
- A failed pre-commit handoff does not call `setComposerDraft(draft)` automatically.
- The failed pending message remains in rendered messages.
- Additional drafts in the same pending session preserve queue order.
- A separate new pending session does not receive rollback text from the first failed send.

## Documentation

When implemented, update `docs/features/session-runtime.md` to replace the old rollback-to-Composer wording with committed pending-message semantics.
