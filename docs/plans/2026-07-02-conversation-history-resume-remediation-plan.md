---
title: Conversation History Resume Remediation Plan
date: 2026-07-02
target:
  - packages/app/src/app/context/session-selection-controller.ts
  - packages/app/src/app/context/conversation-service.ts
  - packages/app/src/app/context/workspace-session-selection.ts
  - packages/app/src/app/app.tsx
  - packages/app/src/app/app-view-props.ts
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/pages/session-conversation-flow.ts
  - packages/server/src/conversation-service.ts
  - packages/server/src/conversation-transcript-store.ts
  - packages/server/src/routes/conversations.ts
  - packages/server/src/server.ts
status: proposed
done: false
base_branch: local/sandbox-merge
source_audit: 2026-07-02 conversation history / OpenCode resume audit
---

# Conversation History Resume Remediation Plan

## Goal

Make old conversation selection and resume behavior explicit, recoverable, and
testable:

- Prefer Veslo host transcript reads for passive sidebar browsing.
- Use the original OpenCode session when submitting a new run.
- Do not render an empty/finished-looking transcript when the real state is
  "history unavailable".
- When the owning workspace is active and OpenCode can still serve the session,
  recover from a missing host transcript and backfill the Veslo host store.

This plan fixes the root cause: the app currently treats a scoped old
conversation as DB-only after selection. If the host transcript read returns
unavailable, the app does not try live OpenCode even when the original
OpenCode session may still exist and the workspace client is available.

## Context7 OpenCode Findings

Current OpenCode documentation supports a session-pinned model:

- Prompts/messages are sent to an existing session id.
- Message history is read by session id.
- Session creation can create or return a session identity, but the runtime
  state is still keyed by the OpenCode session id.
- The documented CLI has `opencode import <file|share-url>`, but Context7 did
  not surface a documented HTTP/SDK import endpoint for reconstructing a
  session from a Veslo transcript.
- `noReply` prompt injection exists, but that is context injection, not a
  faithful durable restore of prior OpenCode message state.

Implication:

- Normal resume must keep using the original `opencodeSessionId`.
- If the original OpenCode session is gone and only a Veslo transcript remains,
  the app cannot transparently resume with identical OpenCode history through
  the documented API.
- A CLI-import based restore path may be possible later, but it is a separate,
  guarded recovery feature and not the KISS first fix.

## Current Behavior Summary

Confirmed by audit:

- Sidebar/session-list clicks record `workspaceId`, `directory`,
  `conversationId`, and `opencodeSessionId` before `selectSession`.
- `selectSession` forces offline transcript reading when a browse scope exists.
- If that offline read is unavailable, `selectSession` returns without trying
  live `session.messages`.
- Server run submission is correct when binding exists:
  `conversationId` resolves to `opencodeSessionId`, lifecycle registers
  `engineSessionId = opencodeSessionId`, and OpenCode submit uses
  `/session/{opencodeSessionId}/...`.

## Non-Goals

- Do not replace the host-first passive browsing model.
- Do not auto-start inactive local workspaces just because a user browses an
  old session from the sidebar.
- Do not reconstruct OpenCode sessions from Veslo transcripts in this pass.
- Do not widen directory scoping or make workspace-wide fallbacks that can leak
  sibling project conversations.
- Do not alter queue/lifecycle semantics except where tests prove history
  recovery needs a trace or backfill hook.

## Proposed Fix Strategy

Treat old conversation history as a three-state authority, not a boolean:

1. Host transcript available: render host transcript and keep passive behavior.
2. Host transcript unavailable, live engine available for the same scoped
   workspace: read live OpenCode messages and backfill the host transcript
   store.
3. Host transcript unavailable and live engine unavailable: show an explicit
   unavailable state and keep enough identity data to retry after workspace
   activation.

## Coordination Protocol

Reservations happen in this file in the original worktree. Code changes happen
only in a reserved worktree.

1. Pick one task with `status: available`, `reserved_by: null`, and all
   dependencies done.
2. Change only that task's reservation fields.
3. Create the listed branch/worktree.
4. Write or update behavior tests before product code.
5. Run the focused verification listed by the task.
6. Record results in the Progress Log.
7. Do not mark `done: true` until the task is merged back and verified in the
   original worktree.

## Task Reservation Ledger

| id | task | status | reserved_by | done |
| --- | --- | --- | --- | --- |
| CHR01 | explicit history availability contract | merged | codex-20260702-chr01 | true |
| CHR02 | live fallback for active scoped sessions | merged | codex-20260702-chr02 | true |
| CHR03 | backfill host transcript after live recovery | merged | codex-20260702-chr03 | true |
| CHR04 | durable empty transcript marker | merged | codex-20260702-chr04 | true |
| CHR05 | unavailable-history UI/state and retry path | available | null | false |
| CHR06 | focused integration coverage and docs note | available | null | false |

## Tasks

### CHR01: Explicit History Availability Contract

```yaml
id: CHR01
status: merged
reserved_by: codex-20260702-chr01
reserved_at: 2026-07-02T02:32:49.8134941+02:00
branch: conversation-history/chr01-availability-contract
worktree: ../veslo-conversation-history-chr01-availability-contract
done: true
depends_on: []
target_files:
  - packages/app/src/app/context/session-selection-controller.ts
  - packages/app/src/app/context/conversation-service.ts
  - packages/app/src/app/context/session.ts
  - packages/app/src/app/app.tsx
  - packages/app/src/app/tests/context/session-selection-controller.test.ts
  - packages/app/src/app/tests/context/conversation-service.test.ts
```

Cause:

- `getTranscriptFromVesloReadApi()` currently maps
  `snapshot.source === "unavailable"` to `null`, and `loadOfflineTranscript`
  then exposes only `snapshot | null` to the selection controller. That
  collapses "not found", "host unavailable", "wrong directory", and "empty
  transcript" into the same app-level outcome.
- `selectSession` cannot decide whether live fallback is safe or useful.

Implementation:

- Introduce an app-local result type for offline transcript load:
  `HistoryLoadResult =
  { status: "loaded"; snapshot } |
  { status: "empty"; snapshot } |
  { status: "unavailable"; scope; reason }`.
- Preserve the unavailable state at the app boundary in
  `conversation-service.ts`; do not convert it to `null` before
  `session-selection-controller.ts` can inspect it.
- Update the `app.tsx` `loadOfflineTranscript` wiring so `source:
  "unavailable"` becomes `status: "unavailable"` and `source: "sqlite"` with
  zero messages becomes `status: "empty"`.
- Keep the existing public server payload shape if possible; adapt at the app
  boundary using `snapshot.source`, message count, and null errors.
- Update `selectSession` and `loadEarlierMessages` to reason on the explicit
  status while preserving current behavior for `loaded` and a successfully
  loaded empty transcript.
- Add tests that distinguish:
  - loaded host transcript
  - unavailable host transcript
  - empty but available transcript

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/session-selection-controller.test.ts \
  src/app/tests/context/conversation-service.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

### CHR02: Live Fallback For Active Scoped Sessions

```yaml
id: CHR02
status: merged
reserved_by: codex-20260702-chr02
reserved_at: 2026-07-02T02:42:04.1892652+02:00
branch: conversation-history/chr02-active-live-fallback
worktree: ../veslo-conversation-history-chr02-active-live-fallback
done: true
depends_on: [CHR01]
target_files:
  - packages/app/src/app/context/session-selection-controller.ts
  - packages/app/src/app/context/workspace-session-selection.ts
  - packages/app/src/app/app.tsx
  - packages/app/src/app/tests/context/session-selection-controller.test.ts
  - packages/app/src/app/tests/context/workspace-session-selection.test.ts
```

Cause:

- A scoped session forces DB browsing even when the scoped workspace is already
  active and `clientForSession(sessionID)` can reach OpenCode.

Implementation:

- Add an explicit read-policy exception for scoped selections:
  `browseFromDb` remains true for the initial host read, but `offline
  unavailable + scoped workspace is active + live client exists` enables a
  one-shot live recovery attempt. Do not generally disable host-first browsing.
- If offline status is `unavailable`, and the scoped session belongs to the
  active workspace with a live client, call live `session.messages` with the
  original OpenCode id.
- Split identities explicitly:
  - UI state key / route guard key stays the selected UI session id and scope
    key.
  - Engine read id is `scope.opencodeSessionId` from browse scope.
  - Never call live OpenCode with a Veslo `conv-*` id.
- After a live read succeeds, write the returned messages into UI state under
  the selected UI id/scope key, not under a new route id.
- Keep inactive cross-workspace browsing passive. Do not auto-activate a
  workspace in this task.
- Preserve stale-selection guards and `selectSessionScopeKey`.

Behavior tests:

- Scoped active workspace + host unavailable + live client available:
  hydrates live messages.
- Scoped active workspace + host unavailable + live NotFound:
  records unavailable, does not fake empty success.
- Scoped inactive workspace + host unavailable:
  does not call a foreign live client or activate workspace.
- Live fallback calls OpenCode with `opencodeSessionId` while caching/rendering
  under the selected UI session id.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/session-selection-controller.test.ts \
  src/app/tests/context/workspace-session-selection.test.ts \
  src/app/tests/pages/session-navigation.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

### CHR03: Backfill Host Transcript After Live Recovery

```yaml
id: CHR03
status: merged
reserved_by: codex-20260702-chr03
reserved_at: 2026-07-02T02:49:52.4436881+02:00
branch: conversation-history/chr03-live-backfill
worktree: ../veslo-conversation-history-chr03-live-backfill
done: true
depends_on: [CHR02]
target_files:
  - packages/app/src/app/context/conversation-service.ts
  - packages/app/src/app/context/session-selection-controller.ts
  - packages/app/src/app/app.tsx
  - packages/server/src/conversation-service.ts
  - packages/server/src/routes/conversations.ts
  - packages/app/src/app/tests/context/conversation-service.test.ts
  - packages/server/src/tests/conversation-service.test.ts
  - packages/server/src/tests/server-conversations.test.ts
```

Cause:

- Live recovery would fix the current selection but would not repair the host
  transcript store, so the next passive browse would fail again.

Implementation:

- Reuse the existing app/server append path:
  - app `appendTranscriptSnapshot()`
  - app client `appendSessionTranscript()`
  - server route `POST /workspace/:id/sessions/:sessionId/transcript`
  - server `conversationService.appendTranscript()`
- Do not introduce a new restore/import API in this task.
- After live fallback succeeds, persist the recovered messages/parts under the
  resolved `opencodeSessionId` and `conversationId`.
- Make the write best-effort for UI rendering, but trace failures so they are
  diagnosable.
- Keep append idempotent with current transcript-store behavior.

Behavior tests:

- Live fallback success calls the backfill path once with `opencodeSessionId`.
- A later offline transcript read serves the backfilled host transcript without
  live OpenCode.
- Backfill failure does not hide the live messages already recovered for the
  user.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/conversation-service.test.ts \
  src/app/tests/context/session-selection-controller.test.ts
bun test \
  packages/server/src/tests/conversation-service.test.ts \
  packages/server/src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
```

### CHR04: Durable Empty Transcript Marker

```yaml
id: CHR04
status: merged
reserved_by: codex-20260702-chr04
reserved_at: 2026-07-02T02:56:35.4841713+02:00
branch: conversation-history/chr04-durable-empty-marker
worktree: ../veslo-conversation-history-chr04-durable-empty-marker
done: true
depends_on: [CHR03]
target_files:
  - packages/server/src/conversation-transcript-store.ts
  - packages/server/src/conversation-service.ts
  - packages/server/src/routes/conversations.ts
  - packages/app/src/app/context/conversation-service.ts
  - packages/server/src/tests/conversation-service.test.ts
  - packages/server/src/tests/server-conversations.test.ts
  - packages/app/src/app/tests/context/conversation-service.test.ts
```

Cause:

- The current transcript store is message-driven. A durable "loaded empty"
  transcript can be lost because no message rows exist to distinguish "empty
  but available" from "unavailable".
- If CHR03 live recovery backfills zero messages, the next passive browse can
  fall back into the same unavailable path.

Implementation:

- Add the smallest durable marker needed to represent "known empty transcript"
  for `(workspaceId, opencodeSessionId)`.
- Keep the marker scoped by workspace and engine session id; do not widen by
  directory.
- Make empty transcript appends idempotent and preserve the same response shape
  as a successful empty snapshot.
- Do not use this marker to suppress a later non-empty append.

Behavior tests:

- Appending an empty but available snapshot makes a later host read return
  `source: "sqlite", messages: []`.
- An unavailable read without a marker still returns unavailable.
- A later non-empty append replaces/augments the empty marker behavior and
  returns messages normally.

Verification:

```bash
bun test \
  packages/server/src/tests/conversation-service.test.ts \
  packages/server/src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/conversation-service.test.ts
```

### CHR05: Unavailable-History UI/State And Retry Path

```yaml
id: CHR05
status: available
reserved_by: null
reserved_at: null
branch: conversation-history/chr05-unavailable-retry
worktree: ../veslo-conversation-history-chr05-unavailable-retry
done: false
depends_on: [CHR03, CHR04]
target_files:
  - packages/app/src/app/context/session-selection-controller.ts
  - packages/app/src/app/context/session.ts
  - packages/app/src/app/app.tsx
  - packages/app/src/app/app-view-props.ts
  - packages/app/src/app/pages/session-conversation-flow.ts
  - packages/app/src/app/pages/session.tsx
  - packages/app/src/app/tests/pages/session-conversation-flow.test.ts
  - packages/app/src/app/tests/pages/session-navigation.test.ts
  - packages/app/src/app/tests/app-view-props.test.ts
```

Cause:

- When both host and live history are unavailable, the app lacks a distinct
  state. This can look like an empty conversation and mislead later resume
  decisions.

Implementation:

- Represent "history unavailable" separately from an empty loaded transcript.
- Add the state/properties needed to carry this through the app composition
  boundary. `SessionViewProps` currently only has earlier-message loading
  controls, so this task must update `app.tsx`, `app-view-props.ts`, and
  `SessionViewProps`, not only `session-conversation-flow.ts`.
- Surface a retry/reload action that activates the owning workspace only when
  the user explicitly chooses it.
- Retry should preserve `conversationId`, `opencodeSessionId`, workspace id,
  and directory.
- If retry recovers live history, route through CHR03 backfill.

Behavior tests:

- Unavailable history does not mark the session as message-complete.
- Retry activates the owning workspace and re-runs selection with the same
  identity scope.
- Empty but successfully loaded transcript still renders as an empty session,
  not an error state.

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-conversation-flow.test.ts \
  src/app/tests/pages/session-navigation.test.ts \
  src/app/tests/context/session-selection-controller.test.ts \
  src/app/tests/app-view-props.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

### CHR06: Focused Integration Coverage And Docs Note

```yaml
id: CHR06
status: available
reserved_by: null
reserved_at: null
branch: conversation-history/chr06-integration-docs
worktree: ../veslo-conversation-history-chr06-integration-docs
done: false
depends_on: [CHR05]
target_files:
  - packages/app/src/app/tests/pages/session-navigation.test.ts
  - packages/app/src/app/tests/context/session-selection-controller.test.ts
  - packages/app/src/app/tests/context/conversation-service.test.ts
  - packages/server/src/tests/server-conversations.test.ts
  - docs/dev/conversation-history-resume.md
```

Cause:

- Existing tests cover many local contracts, but not the full old-session
  recovery story from browse scope to live recovery to host backfill.

Implementation:

- Add one focused app workflow test:
  old scoped session -> host unavailable -> active workspace live fallback ->
  recovered messages -> backfill requested.
- Add/extend one server test proving:
  `conversationId` transcript/run/abort paths always resolve to the same
  `opencodeSessionId` and reject cross-workspace ids before engine contact.
- Add a concise dev note documenting:
  - host-first passive browse
  - live fallback limits
  - why Veslo transcript alone is not equivalent to OpenCode resume
  - the CLI import option as future recovery research, not current behavior

Verification:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/pages/session-navigation.test.ts \
  src/app/tests/context/session-selection-controller.test.ts \
  src/app/tests/context/conversation-service.test.ts
bun test \
  packages/server/src/tests/conversation-binding-store.test.ts \
  packages/server/src/tests/conversation-service.test.ts \
  packages/server/src/tests/conversation-run-lifecycle-controller.test.ts \
  packages/server/src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
git diff --check
```

## Final Acceptance

Run in the original worktree after all CHR branches are merged:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/context/session-selection-controller.test.ts \
  src/app/tests/context/conversation-service.test.ts \
  src/app/tests/context/workspace-session-selection.test.ts \
  src/app/tests/pages/session-navigation.test.ts \
  src/app/tests/pages/session-conversation-flow.test.ts \
  src/app/tests/app-view-props.test.ts
bun test \
  packages/server/src/tests/conversation-binding-store.test.ts \
  packages/server/src/tests/conversation-service.test.ts \
  packages/server/src/tests/conversation-run-lifecycle-controller.test.ts \
  packages/server/src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
git diff --check
```

## Open Questions Before Implementation

- Should active-workspace live fallback happen automatically only after host
  transcript is `unavailable`, or also when host transcript is empty but the
  binding has a known `opencodeSessionId`? Current plan chooses unavailable
  only; empty is a successful loaded state once CHR04 lands.
- Should the explicit retry action activate local workspaces only, or remote
  Veslo workspaces too?
- Do we want a future CLI-import restore task for "Veslo transcript exists but
  OpenCode session is gone", or should that remain a manual recovery procedure?

## Progress Log

- 2026-07-02: Plan created after read-only audit and Context7 OpenCode docs
  check. No code changes made.
- 2026-07-02: Incorporated plan review findings: app boundary added to CHR01,
  active scoped live fallback made explicit in CHR02, CHR03 tied to existing
  appendTranscriptSnapshot/appendSessionTranscript paths, durable empty marker
  split into CHR04, and unavailable UI/retry moved to CHR05 with wider props
  targets.
- 2026-07-02: Added CHR01 conversation-service verification, server typecheck
  to server-touching slices, wider frontmatter targets, and a final acceptance
  command block for the whole plan.
- 2026-07-02: CHR01 implementation in
  `conversation-history/chr01-availability-contract`: added explicit
  `HistoryLoadResult` handling, preserved unavailable transcript snapshots at
  the app boundary, and verified with
  `session-selection-controller.test.ts`, `conversation-service.test.ts`,
  `session-select-background-hydration.test.ts`,
  `session-navigation.test.ts`, and app typecheck.
- 2026-07-02: CHR01 merged into `local/sandbox-merge` and re-verified in the
  original worktree with the same 56 focused app tests, app typecheck, and
  `git diff --check`.
- 2026-07-02: CHR02 behavior tests added first in
  `conversation-history/chr02-active-live-fallback`. Pre-implementation
  focused run
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm
  src/app/tests/context/session-selection-controller.test.ts` failed as
  expected: 9 passed, 2 failed. The failures prove active scoped
  `unavailable` history does not yet call live `session.messages` with the
  OpenCode session id.
- 2026-07-02: CHR02 implementation in
  `conversation-history/chr02-active-live-fallback`: active scoped
  `unavailable` history now performs one live recovery read through the
  OpenCode session id while keeping UI state under the selected Veslo session
  id. Inactive scoped workspaces remain passive, and live NotFound keeps
  history unavailable. Verified with focused controller test (12 passed),
  CHR02 focused suite (51 passed), app typecheck, and `git diff --check`.
- 2026-07-02: CHR02 merged into `local/sandbox-merge` and re-verified in the
  original worktree with the CHR02 focused suite (51 passed), app typecheck,
  and `git diff --check`.
- 2026-07-02: CHR03 behavior tests added first in
  `conversation-history/chr03-live-backfill`. Pre-implementation focused run
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm
  src/app/tests/context/session-selection-controller.test.ts` failed as
  expected: 12 passed, 3 failed. The failures prove live recovery does not yet
  call the transcript append path, backfill failures are not traced, and a
  later passive browse cannot read a recovered transcript without another live
  call.
- 2026-07-02: CHR03 implementation in
  `conversation-history/chr03-live-backfill`: live recovery now backfills
  recovered messages through the existing app `appendTranscriptSnapshot` path
  under the OpenCode session id, traces append failures without hiding live
  messages, and retargets loaded host snapshots to the selected UI session key.
  Verified with focused controller test (15 passed), app focused suite (20
  passed), server append-path suite (31 passed), app typecheck, server
  typecheck, and `git diff --check`.
- 2026-07-02: CHR03 merged into `local/sandbox-merge` and re-verified in the
  original worktree with the app focused suite (20 passed), server append-path
  suite (31 passed), app typecheck, server typecheck, and `git diff --check`.
- 2026-07-02: CHR04 behavior tests added first in
  `conversation-history/chr04-durable-empty-marker`. Pre-implementation focused
  runs failed as expected: server transcript/service tests had 19 passed, 2
  failed, and app conversation-service test had 5 passed, 1 failed. The
  failures prove empty transcript appends are currently dropped/rejected and no
  durable empty marker exists.
- 2026-07-02: CHR04 added a boundary controller test for zero-message live
  recovery backfill. Pre-implementation
  `session-selection-controller.test.ts` failed as expected: 15 passed, 1
  failed, proving the CHR03 backfill payload builder currently skips empty live
  recovery results.
- 2026-07-02: CHR04 implementation in
  `conversation-history/chr04-durable-empty-marker`: added a durable empty
  transcript marker in the server transcript store, allowed empty transcript
  append through server/app append paths, treated host empty snapshots as valid
  sqlite transcripts, and allowed zero-message live recovery backfill payloads.
  Verified with server transcript/service/routes suite (40 passed), app
  conversation-service + selection-controller suite (22 passed), app
  typecheck, server typecheck, and `git diff --check`.
- 2026-07-02: CHR04 merged into `local/sandbox-merge` and re-verified in the
  original worktree with server transcript/service/routes suite (40 passed),
  app conversation-service + selection-controller suite (22 passed), app
  typecheck, server typecheck, and `git diff --check`.
