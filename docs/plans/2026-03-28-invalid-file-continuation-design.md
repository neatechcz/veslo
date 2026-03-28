# Invalid File Continuation Design

Date: 2026-03-28  
Repo: /Users/vaclavsoukup/AI agent projects/Veslo

## Summary

Implement the best Veslo-side mitigation for `invalid_file` failures so runs do not terminate immediately when a file input is rejected.

Approved UX behavior:

- Preserve the existing session and its history.
- Keep the visible failure in the session timeline.
- Automatically continue once in the same session after an `invalid_file` failure.
- Filter obviously invalid user-provided attachments before they are sent.
- Stop auto-retrying after one continuation attempt in the same failure chain.

## Problem

Current behavior treats provider `invalid_file` responses as terminal session errors. In the observed failure, the provider rejected a file that had already entered OpenCode session history as a prior tool attachment. Veslo currently:

- formats the provider error as a user-facing `Invalid file` message
- marks the session `idle`
- leaves the run stopped unless the user manually retries

This is a poor recovery experience. The correct product behavior is to continue the task when a file is invalid, but the full history-level fix belongs inside the OpenCode runtime that serializes session history for the provider. That runtime source is not present in this repo, so this design targets the best recoverable behavior Veslo can implement directly.

## Goals

- Preserve the current session instead of bouncing the user into a new one.
- Prevent obviously bad new attachments from being sent in the first place.
- Automatically give the agent one in-context chance to recover after `invalid_file`.
- Keep error visibility and predictability for the user.
- Avoid infinite retry loops.

## Non-goals

- No history surgery inside existing OpenCode sessions.
- No changes to Chrome MCP or browser automation.
- No generic retry framework for all provider errors.
- No hidden endless retries.

## Chosen Approach

Primary: app-scoped mitigation with two layers.

Why this option:

- It preserves the same session and failure history.
- It addresses the easiest invalid-file cases up front for newly attached files.
- It gives the model one explicit chance to recover in context.
- It fits inside the current Veslo app codebase without requiring upstream OpenCode source.

## Design

### 1) Outgoing attachment sanitization

Before sending the current prompt, validate user-provided attachments built from the composer draft.

Scope:

- Inspect `draft.attachments` before `buildPromptParts()` includes them in the request.
- Decode `data:` URLs and inspect the first bytes / leading text.
- Reject obvious masquerades, especially:
  - `application/pdf` payloads that do not start with `%PDF-`
  - payloads that begin with HTML/XML error content when the declared MIME indicates a document upload

Behavior:

- Drop invalid attachments from the outgoing prompt.
- If any are dropped, surface a short non-blocking notice so the user is not surprised.
- If all attachments are dropped and the prompt has no text content, stop locally with a clear error instead of sending an empty request.

This does not solve poisoned historical tool attachments, but it does prevent new user-provided invalid files from entering the run.

### 2) `invalid_file` classification

Promote `invalid_file` detection from a formatting concern to a reusable classification helper.

Needed change:

- Export a helper from `packages/app/src/app/lib/session-error.ts` so session event handling can distinguish `invalid_file` from other provider failures without relying on formatted text.

This helper should remain focused on the provider error shape already handled today:

- explicit `code: invalid_file`
- parsed API body with `code: invalid_file`
- invalid-request responses whose message/param shape clearly indicate a file-format rejection

### 3) One-time same-session continuation

When the selected session receives a `session.error` event classified as `invalid_file`, Veslo should:

1. keep the existing synthetic error turn in the message history
2. mark the session as having an in-progress invalid-file recovery attempt
3. send one synthetic follow-up prompt in the same session

Proposed follow-up prompt intent:

> The previous step failed because one file input was invalid or corrupted. Do not rely on that file. Briefly explain what failed, then continue the task using another path.

Rules:

- only one automatic continuation attempt per failure chain
- if the continuation itself fails again with `invalid_file`, stop auto-retrying
- non-file errors keep existing behavior

### 4) Recovery state

Add a small per-session recovery state in the app layer.

Recommended model:

- `idle`
- `recovering`
- `exhausted`

Use this state to:

- suppress infinite loops
- avoid duplicate auto-continuations if multiple error signals arrive close together
- keep the behavior deterministic and debuggable

### 5) User-visible behavior

Keep the UI minimal.

- Preserve the synthetic `Invalid file` turn in the session timeline.
- Do not create a large new error UI component.
- Optionally surface a toast/status note such as `Continuing after invalid file…`.
- If the recovery attempt is exhausted, leave a clear final message that Veslo could not continue automatically.

## Error Handling

- Invalid current attachment: drop it before send and notify the user.
- Invalid-file provider error: auto-continue once in the same session.
- Second invalid-file in the same recovery chain: stop and surface a clear final error.
- Other provider/API errors: preserve current behavior.

## Testing Strategy

### Unit tests

- invalid PDF attachment bytes are rejected before send
- valid PDF attachment bytes remain attached
- HTML masquerading as PDF is rejected
- `invalid_file` errors are classified independently of the formatter output
- recovery state allows one continuation attempt and then exhausts

### App wiring tests

- automatic continuation is triggered once for `invalid_file`
- non-file errors do not trigger continuation
- continuation prompt builder produces the expected text-only recovery instruction

## Acceptance Criteria

- Sending a prompt with an obviously invalid attachment does not forward that attachment upstream.
- A session that hits `invalid_file` automatically attempts one same-session continuation.
- The original failure remains visible in session history.
- A second `invalid_file` in the same chain does not loop forever.
- Non-file errors behave exactly as before.
