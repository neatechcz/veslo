# Session Message Editing And Queue Design

## Summary

Veslo should let users correct the latest user message only while doing so is safe, and should let users compose multiple follow-up messages while an agent run is active without posting them into the runtime immediately.

The approved direction uses the existing OpenCode revert model for transcript message replacement and adds a session-local queued-drafts model for follow-up messages. The runtime remains sequential by default. Enter respects the queue; Ctrl+Enter is an explicit "send now" action for steering the active run or temporarily bypassing a paused queue.

## Goals

- Allow safe editing of the latest user message after a run was stopped before any answer or mutating action happened.
- Hide the edit pencil completely whenever it cannot be used.
- Queue follow-up messages while an agent is running instead of posting them immediately.
- Let queued messages be edited, cancelled, and reordered before they are sent.
- Resume queued work only after the current assistant response reaches idle.
- Preserve a clear escape hatch for immediate steering with Ctrl+Enter.

## Non-Goals

- Adding a server-side durable queue contract in the first version.
- Rewriting OpenCode message persistence or adding true in-place message mutation.
- Allowing transcript editing after visible assistant text or mutating tool activity.
- Reordering or cancelling a message after it has already been handed to the runtime.

## Approved Direction

Use a session-local queue in app state and keep the actual runtime sequential.

When a run is active, Enter adds the current draft to the queue. Ctrl+Enter sends the current draft immediately as "Poslat hned". After the current assistant response finishes, Veslo sends the first queued item, waits for that response to finish, then sends the next queued item.

The latest user message edit flow uses revert plus prefilled composer state. Clicking the pencil does not immediately remove the original message. It puts the original content back into the composer and marks the composer as replacing that message. On submit, Veslo revalidates editability, reverts to the original message boundary, and sends the revised draft.

## UX Rules

### Idle session

- Enter sends the current draft immediately.
- Ctrl+Enter can behave the same as Enter; it has no special visible role while idle.
- If queued messages exist because the queue was paused after Stop, Enter adds the new draft to the end of the queue and starts the first queued item.
- If queued messages exist because the queue was paused after Stop, Ctrl+Enter sends the current draft immediately outside the queue, then the queue continues after that response finishes.

### Running session

- The composer remains usable while the agent is running.
- Enter queues the current draft and clears the composer.
- Ctrl+Enter sends the current draft immediately as "Poslat hned".
- The visible send affordance should make the queued-send behavior clear without replacing the existing Stop control.
- Stop remains the required way to stop a running agent before transcript message editing is available.

### Queue display

Show the queue near the composer as a compact "waiting in queue" list.

Each queued item should include:

- a drag handle
- a concise text preview
- an edit pencil
- a cancel X

Items can be dragged to reorder as long as they have not been sent. A sending item shows progress and does not expose edit, cancel, or drag controls.

### Queue editing

Editing a queued item puts that item back into the composer and marks it as the active queued edit. Pressing Enter updates the queued item instead of adding a new one. Pressing Ctrl+Enter sends the edited item immediately and removes it from the queue.

### Stop and paused queue

Stop aborts the active run and leaves queued items intact. The queue enters a paused-after-stop state and does not auto-drain just because the aborted run becomes idle.

From paused-after-stop:

- Enter appends the current draft to the queue and starts the first queued item.
- Ctrl+Enter sends the current draft immediately and then resumes queue draining after that response finishes.

Ctrl+Enter is a temporary bypass, not a permanent queue pause.

## Transcript Message Editing

The edit pencil next to transcript messages is rendered only when the action can be used.

It appears only for the latest user message in the currently visible history when all of these are true:

- the selected session is idle
- there are no queued messages for the selected session
- the composer does not contain an unrelated draft that would be overwritten
- no visible assistant text exists after that user message
- no mutating or unknown tool activity exists after that user message

The post-message activity check should be conservative. Known non-mutating activity can allow editing, for example reasoning, thinking, read, list, grep, glob, or search-style context gathering. Known mutating tools block editing, including write, edit, apply_patch, and task/tool categories that mutate files or external state. Shell or terminal activity should block editing by default because the UI cannot reliably prove it was read-only.

Messages with attachments are editable only when Veslo can safely reconstruct the original composer draft. If a binary attachment cannot be restored into the composer, the pencil is hidden for that message in the first version.

## State Model

Add session-local queue state in the app layer, keyed by session id or by the pending draft key before a real session exists.

Recommended queued item shape:

- id
- draft
- createdAt
- updatedAt
- state: queued, editing, sending, or error
- error message, when a send attempt fails

Add a small replacement state for transcript editing:

- original message id
- original draft reconstructed from that message

This replacement state is separate from queued-item editing. Transcript replacement is available only when the queue is empty.

## Data Flow

Normal send path:

1. Build the composer draft.
2. If the selected session is idle and no paused queue needs resuming, send immediately.
3. If the selected session is running, add the draft to the selected session's queue.
4. If the queue is paused after Stop and Enter was used, append the draft and start the first queued item.
5. If Ctrl+Enter was used, send the draft immediately.

Queue drain path:

1. Observe the selected session status transition to idle.
2. If the idle transition came from Stop, leave the queue paused.
3. If the queue is active and has items, send only the first item.
4. Mark that item sending while the send is being accepted by the runtime.
5. Remove it after a successful send acceptance.
6. Wait for the next idle transition before sending the next item.

Transcript replacement path:

1. User clicks the transcript pencil.
2. Veslo reconstructs the original draft and puts it into the composer.
3. Veslo records replacement state for the original message id.
4. On submit, Veslo revalidates editability.
5. Veslo reverts to the original message boundary.
6. Veslo sends the revised draft through the normal immediate send path.
7. On success, Veslo clears replacement state.

## Error Handling

- If queue drain fails before the runtime accepts an item, keep the item in the queue with an error state.
- If the session starts running for another reason while the queue is about to drain, do not send; wait for the next idle transition.
- If transcript replacement validation fails after the user edited the draft, keep the draft in the composer and show a clear error.
- If queued item editing is cancelled, restore the item to the queue without changing order.
- If the selected session is deleted, discard its queue.
- If the user switches sessions, show the queue for the newly selected session only.

## Documentation Updates Required

If implemented, update the durable session runtime documentation to cover:

- Enter queues during active runs.
- Ctrl+Enter is the explicit send-now steering action.
- Queued items can be edited, cancelled, and reordered before send.
- Stop pauses automatic queue draining.
- Transcript message editing is available only when no response or mutating activity happened after the message.

## Testing Requirements

Required app-level tests:

- Enter while streaming adds a draft to the queue rather than sending it immediately.
- Ctrl+Enter while streaming calls the immediate send-now path.
- A running-to-idle transition sends exactly the first queued item.
- The next queued item waits for the next idle transition.
- Stop leaves the queue paused and does not auto-drain.
- Enter from a paused queue appends the current draft and starts the first queued item.
- Ctrl+Enter from a paused queue sends the current draft immediately and resumes queue draining after that response finishes.
- Queued items can be edited, cancelled, and reordered before sending.
- The transcript pencil renders only when the selected session is idle, the queue is empty, and the latest user message has no visible assistant text or mutating activity after it.

Required desktop E2E coverage:

- In the real Tauri runtime, send one message, queue another while the agent is running, and verify the second message is accepted only after the first response finishes.
- Stop a running response with queued messages and verify the queue remains visible and paused.
