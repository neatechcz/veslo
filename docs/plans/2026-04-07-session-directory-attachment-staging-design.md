# Session Directory Attachment Staging Design

## Goal

When a user drags files (including screenshots) into the composer, sending the message must stage those files directly into the active session directory, not into `.opencode/veslo/inbox`. Agents should then read/write the files where the session actually works.

## Approved Product Behavior

1. Composer drag-and-drop keeps files as attachment chips before send.
2. On send, attachments are staged into the active session directory (`session directory override` first, otherwise active workspace root).
3. Staging uses collision-safe naming with suffixes: `name.ext`, `name (1).ext`, `name (2).ext`, etc.
4. Prompt and slash-command flows both receive staged file paths from the session directory.
5. Inline blob attachments are removed from outbound provider/tool payloads after successful staging.
6. If staging fails, send is blocked (hard fail) with an explicit error.
7. On hard fail, composer input and attachment chips remain intact (no silent drop / no clearing draft).
8. Inbox remains available as a separate panel feature, but composer send no longer depends on Inbox staging.

## Scope

In scope:

- `packages/app` send pipeline for composer attachments.
- Session-directory path resolution for staging.
- Filename collision handling for staged attachments.
- Error handling for staging failures.
- Unit/integration/UI E2E tests for attachment send behavior (including screenshot regression).

Out of scope:

- Changing Inbox panel semantics or permissions globally.
- Changing non-composer file flows (manual Inbox uploads, outbox, artifact mirroring).
- New server API endpoints (reuse existing file-session APIs).

## Architecture

Current flow uploads composer attachments to Inbox and appends Inbox paths to message content. That causes edited files to remain in staging storage instead of the active session directory.

New flow replaces Inbox staging for composer sends with direct session-directory staging via Veslo file-session APIs:

1. Resolve target session root from current session context.
2. Convert target to workspace-relative destination paths.
3. Stage attachment bytes via `createFileSession(..., write: true)` + `writeFileBatch(...)`.
4. Append staged paths to `resolvedText` (and slash-command arguments when applicable).
5. Clear `draft.attachments` before request dispatch.

This preserves existing session execution calls (`session.promptAsync`, `session.command`) while changing only the pre-send attachment normalization step.

## Components And Data Flow

### 1) Send pipeline normalization

In `packages/app/src/app/app.tsx`, replace Inbox-centric staging helper with session-directory staging helper:

- Input: `ComposerDraft`, `sessionID` context.
- Output: normalized `ComposerDraft` where:
  - `resolvedText` includes staged session-directory paths,
  - `command.arguments` includes staged paths for slash command flow,
  - `attachments` becomes `[]`.

### 2) Session directory resolution

Target directory is resolved in this order:

1. `sessionDirectoryOverrideById()[sessionID]` if present.
2. `workspaceProjectDir()` fallback.

Then derive workspace-relative path for server write calls. The helper must reject invalid or out-of-root targets and surface explicit errors.

### 3) Collision-safe destination names

For each attachment filename:

- Build base candidate in target directory.
- Check existing candidates in write session (batch read or cached snapshot).
- Pick first free name in sequence `name`, `name (1)`, `name (2)`, ... with extension preserved.

### 4) Byte staging through file sessions

Use existing Veslo client/server APIs:

- `createFileSession(workspaceId, { ttlSeconds, write: true })`
- `writeFileBatch(sessionId, [{ path, contentBase64 }])`
- optional `closeFileSession(sessionId)` best-effort cleanup

No new endpoint is required.

## Error Handling

Hard-fail model (approved):

1. If any attachment cannot be staged, abort send before provider call.
2. Show explicit error text (not silent abort).
3. Keep composer draft and attachment chips unchanged.
4. Do not fallback to Inbox or inline attachment upload.

This explicitly fixes the reported behavior where screenshots appeared attached, UI blinked, and nothing was sent.

## Testing Strategy

### Unit tests

1. Path helper tests:
   - session directory -> workspace-relative conversion.
   - invalid path rejection.
2. Filename helper tests:
   - collision suffix generation,
   - extension preservation.
3. Send normalizer tests:
   - `attachments` cleared only after successful staging,
   - staged paths appended to `resolvedText` and command arguments.

### Integration tests (app send flow)

1. Staging success:
   - send dispatches prompt/command with staged paths.
2. Staging failure:
   - send aborts,
   - error visible,
   - draft + chips retained,
   - no provider call.

### UI/E2E (required gate)

Desktop E2E through Tauri + WDIO:

1. Drag screenshot into composer.
2. Send message.
3. Verify message is sent (no flash-and-drop).
4. Verify staged file is written into active session directory.
5. Verify collision behavior creates `name (1).ext`.
6. Verify Inbox path is not injected for composer attachment staging.

## Risks And Mitigations

1. Session-directory/path mismatches in remote contexts.
   - Mitigation: reuse existing session-directory override resolution and workspace-relative normalization helpers.
2. Large attachment batches causing partial writes.
   - Mitigation: stage sequentially with explicit per-file errors and abort on first failure.
3. Filename conflicts under concurrent writes.
   - Mitigation: collision check immediately before write and retry suffix on conflict.

## Rollout

1. Ship with full unit + targeted integration + desktop E2E coverage.
2. Keep Inbox panel behavior unchanged to avoid unrelated UX regression.
3. Add explicit telemetry/debug logging around staging failures to aid field diagnosis.
