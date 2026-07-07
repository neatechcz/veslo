# 2026-07-07 OpenCode Older Conversation Submit Audit

## Scope

Audit why `pnpm dev` can display older OpenCode conversations but cannot get a new answer when sending a follow-up into those conversations.

This is an audit-only report. No runtime code was changed.

## Executive Finding

The failure is not at the AI Gateway or live inference layer. The current evidence points to a pre-inference routing regression:

1. Older OpenCode sessions can be visible through the read path.
2. The new server-owned existing-session submit path requires a Veslo `conversation_binding` row.
3. Historical OpenCode sessions created before the binding model may not have that row.
4. When the binding is missing, the server returns `conversation_not_found` before OpenCode receives the prompt.
5. The frontend currently treats server-owned submit as authoritative for existing sessions and does not fall back to the older `runConversationFromVesloWriteApi` path.

Result: old conversations look selectable/readable, but follow-up send stops before provider streaming starts.

## Evidence

### Frontend Send Path

`packages/app/src/app/pages/session-send-workflow.ts`

- For an existing `sessionID`, `sendPrompt` enters `submitExistingSessionWithServer` whenever `submitConversationFromVesloWriteApi` exists.
- The submit target is built from UI scope:
  - `conversationId = scope?.conversationId || null`
  - `opencodeSessionId = scope?.opencodeSessionId || existingSessionId`
- If server submit throws, returns `null`, returns `blocked`, or returns `failed`, the workflow returns `false`.
- The legacy run path is only reached when `submitExistingSessionWithServer` returns `null` because server submit is not configured. Once configured, failed server submit blocks the send.

The test suite also codifies this behavior: `session send workflow blocks legacy run when server submit is unavailable` asserts no legacy `run:` action after server submit returns `null`.

### Server Submit Path

`packages/server/src/conversation-submit-service.ts`

- Existing targets are detected by `target.conversationId || target.opencodeSessionId`.
- Existing targets call the injected `submitResolvedRun`.
- If `submitResolvedRun` throws, the service returns a failed submit result with the upstream code/message.

`packages/server/src/routes/conversations.ts`

- `submitResolvedRun` chooses `targetId = request.target.conversationId || request.target.opencodeSessionId`.
- It then calls `resolveConversationExecutionTarget`.

`packages/server/src/server.ts`

- `resolveConversationExecutionTarget` requires:
  - an explicit resolved directory,
  - `conversationService.resolveOpenCodeSessionForRead(...)`,
  - a matching `conversation_binding` row.
- If no binding exists, it throws `ApiError(404, "conversation_not_found", ...)`.

### Read Path Can See Sessions Without Bindings

`packages/server/src/conversation-read-store.ts`

- `listConversations` and `getTranscript` read OpenCode SQLite directly.
- DB resolution falls back to `<home>/.local/share/opencode/opencode.db`.
- Rows from OpenCode `session` are returned as session summaries before they necessarily have Veslo conversation metadata.

`packages/server/src/conversation-service.ts`

- `listConversations` can seed bindings with `attachConversationBindings`.
- This seeding is opportunistic and read-path-driven. It is not guaranteed to have happened before a follow-up send.
- `resolveOpenCodeSessionForRead` itself does not read OpenCode SQLite. It only resolves through `conversation_binding`.

This creates an inconsistent state: OpenCode sessions can be readable/selectable while still not sendable through the new server-owned submit path.

## Local Data Evidence

Checked only metadata/counts, not message content.

Dev Veslo binding DB:

- Path pattern: `%LOCALAPPDATA%\com.neatech.veslo.dev\veslo-orchestrator-dev\conversations\bindings.sqlite`
- `conversation_binding` count: `16`
- Rows are mostly recent dev/test workspace directories.

Legacy dev binding DB:

- Path pattern: `%USERPROFILE%\.veslo\veslo-orchestrator-dev\conversations\bindings.sqlite`
- `conversation_binding` count: `15`
- AppData dev store appears to have copied/added one newer row.

Global OpenCode DB:

- Path pattern: `%USERPROFILE%\.local\share\opencode\opencode.db`
- OpenCode `session` count: `4`
- Binding comparison:
  - `1` session has a Veslo binding.
  - `3` sessions do not have a Veslo binding.
- The unbound sessions are OpenCode `1.17.4` sessions in the repo's `packages/app` directory.
- The bound session is OpenCode `1.17.13` in a newer dev runtime directory.

This is enough to reproduce the failing class without sending a live prompt: a visible old OpenCode session ID can exist in OpenCode SQLite while `resolveConversationExecutionTarget` has no binding row and therefore must return `conversation_not_found`.

## Recent Commit Window

Relevant commits in the current branch:

- `c062588f` added the server-owned conversation submit shell.
- `77f41c3a` materialized first-submit conversations.
- `5e353004` routed first sends through submit materialization.
- `18735844` moved existing-session sends into server-owned submit and hardened legacy fallback behavior.

The regression window is most likely `18735844`: existing-session sends now depend on server-owned submit, and unsafe fallback was intentionally removed. That is directionally correct, but it exposed missing migration/materialization for historical OpenCode sessions.

## Root Cause

The current write path assumes that every sendable conversation has a Veslo conversation binding.

That is true for newly materialized conversations, but false for older OpenCode sessions that predate the binding store or were loaded from global OpenCode SQLite without a guaranteed import/bind step.

The boundary mismatch is:

- Read path accepts OpenCode session rows as history.
- Write path accepts only Veslo-bound conversation rows as execution targets.
- UI can carry only `opencodeSessionId` for old sessions.
- Server refuses raw OpenCode session IDs unless they are already bound.

This is the correct security posture for arbitrary raw IDs, but missing a safe materialization path for "known OpenCode session in this exact workspace directory".

## Non-Causes

- Not primarily Den auth. Auth can fail independently, but this path fails before provider streaming when binding is missing.
- Not primarily AI Gateway or model inference. Local logs show the current runtime can start a `codex_oauth/gpt-5.5` stream for a newly bound session.
- Not just a frontend display issue. The hard failure condition is server-side `conversation_not_found`.

## Fix Direction

Preferred fix: server-side safe import-on-submit for known legacy OpenCode sessions.

1. Extend the server execution-target resolver or conversation service with a method like `resolveOrImportOpenCodeSessionForExecution`.
2. First try the existing binding lookup.
3. If missing and the target is an OpenCode session ID:
   - require explicit directory,
   - read OpenCode SQLite for a session with that exact ID under that exact directory,
   - reject if not found or directory mismatches,
   - bind it through `conversation_binding`,
   - retry target resolution and submit.
4. Keep rejecting raw IDs that cannot be proven from the workspace-scoped OpenCode DB.

Do not re-enable broad frontend legacy fallback. The server should own the migration/binding boundary so the same behavior works for app, Tauri Pilot, and API callers.

Secondary hardening:

- When `loadTranscript` reads a legacy OpenCode transcript and binding is missing, bind the session if the exact session row is found.
- When `listConversations` has partial host-owned bindings for a directory, provide an explicit sync/import path that can still backfill missing OpenCode rows.
- Surface the exact failed layer in UI: "legacy OpenCode session is not bound to Veslo yet" instead of generic send failure.

## Test Plan

Server tests:

- Seed an OpenCode SQLite DB with a legacy `session` row and no `conversation_binding`; submit to that `opencodeSessionId`; assert the server creates the binding and submits.
- Same setup with a wrong directory; assert `conversation_not_found`.
- Same setup with a raw non-OpenCode/unknown ID; assert rejection.
- Existing bound `conversationId` path still submits without re-import.

App tests:

- Existing session with only `opencodeSessionId` and no `conversationId` should still call server submit.
- A server-side successful legacy import result should clear draft and emit the normal live transcript policy event.

Tauri Pilot:

- Seed `%USERPROFILE%\.local\share\opencode\opencode.db` or an isolated E2E OpenCode data home with an old-style session row and no Veslo binding.
- Open it in the desktop app.
- Send a prompt.
- Assert:
  - provider request starts,
  - assistant response persists,
  - `conversation_binding` now contains the old session ID.

## Immediate Workaround

The current app may work for a specific old session after a successful read/import sync creates its binding. That is not reliable enough as product behavior. The durable fix is to make the server write path materialize a verified legacy OpenCode session at the moment of submit.
