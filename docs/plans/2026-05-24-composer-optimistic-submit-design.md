# Composer Optimistic Submit Design

## Goal

When a user submits a Composer draft while the target workspace or session is still being materialized, Veslo should make the draft feel sent immediately: the text appears in the conversation timeline, the Composer can no longer edit that submitted draft, and the run indicator shows that the agent is waiting or thinking.

## Current Behavior

The Composer keeps a local `sending` state while it awaits `onSend(draft)`, but only the send button is effectively blocked. The editable `contentEditable` surface and some Composer actions remain available while the app may still be starting the engine, creating a real session from a pending draft, and handing the prompt to OpenCode.

The session run indicator starts only after `sendPromptAsync(draft)` returns success. For pending drafts, that means the UI can appear idle while the app is still doing the expensive pre-message work.

## Design

Use a two-phase optimistic submit:

1. On submit, Session view creates a local pending submitted draft and renders it as a temporary user message at the end of the message list.
2. The Composer clears and locks the submitted draft while `onSend(draft)` is in flight, so the message cannot be edited in the Composer during handoff.
3. The run indicator starts immediately with the existing sending/thinking language while the workspace, session, and prompt handoff complete.
4. When `sendPromptAsync(draft)` succeeds, remove the temporary user message and let the real server transcript/SSE message replace it.
5. If handoff fails before a real message exists, remove the temporary user message and restore the original draft to the Composer.
6. If a real message exists and the later model/run fails, keep the real message in the transcript and rely on the existing undo/edit/resend/retry flows.

## Scope

Touch the shared app UI and tests only:

- Composer submit locking and draft clearing.
- Session view optimistic pending user message rendering.
- Focused tests that prove submit starts the visible waiting state before `sendPromptAsync` resolves and that Composer remains locked until the send settles.

Do not change server APIs, OpenCode message semantics, or durable pending draft storage.

## Error Handling

`onSend(draft)` remains the commit boundary:

- `true`: the prompt handoff succeeded, so optimistic UI is cleared and real runtime state owns the transcript.
- `false` or thrown error: the handoff did not commit; remove optimistic UI and restore the original Composer draft.

The implementation should not invent edit/resend behavior for local-only placeholders because existing message editing and retry tools require a real server message id.

## Testing

Prefer E2E for desktop behavior, but start with focused app tests around the existing source-level contracts because this behavior spans async UI state and pending draft handoff. Then run package checks from the Veslo testing playbook. If a desktop E2E run is practical in the current session, run it through the `packages/desktop` plus `packages/e2e` WebdriverIO flow after the required preflight.
