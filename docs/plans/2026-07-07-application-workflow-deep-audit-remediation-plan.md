---
title: Application Workflow Deep Audit Remediation Plan
date: 2026-07-07
status: planned
done: false
plan_type: implementation
audit_checkout: 86ec8979
e2e_status: pending
awf_01_gateway_auth_precedence_done: true
awf_02_queue_starting_recovery_done: true
awf_03_submit_recoverable_replay_done: true
awf_04_logical_submit_failure_contract_done: true
awf_05_queue_duplicate_fingerprint_done: true
awf_06_sse_delta_coalescing_done: true
awf_07_unknown_session_sse_done: true
awf_08_transcript_workspace_switch_done: true
awf_09_transcript_read_fail_closed_done: true
awf_10_transcript_store_scoped_key_done: true
awf_11_ambiguous_ui_scope_done: false
awf_12_ui_conversation_key_scope_done: false
awf_13_displayed_guard_directory_done: false
awf_14_last_session_storage_v2_done: false
awf_15_legacy_opencode_submit_acceptance_done: false
---

# 2026-07-07 Application Workflow Deep Audit Remediation Plan

## Scope

This plan converts the 2026-07-07 deep audit findings around workspace
selection, conversation/session binding, server-owned send, OpenCode lifecycle,
AI Gateway inference, and UI transcript rendering into actionable repair tasks.

The plan is intentionally implementation-oriented. Each finding has:

- `done: false` until the exact fix, focused tests, and validation are complete.
- Code evidence from the audited checkout `86ec8979`.
- A KISS repair direction for future agents.

Do not flip a finding to `done: true` unless the code fix has landed, the
listed validation has passed, and `git diff --check` is clean.

## Implementation Plan Control

Use the front matter flags as the implementation ledger. Flip only the matching
`awf_*_done` flag after the code fix, regression test, required sidecar/E2E
validation, and implementation note are complete.

This file is a coordinating plan, not the sole owner for every overlapping
finding. If a task is implemented through a narrower related plan, update this
plan with a short cross-reference instead of duplicating a second patch.

Flag mapping:

- `awf_01_gateway_auth_precedence_done`: Finding 01
- `awf_02_queue_starting_recovery_done`: Finding 02
- `awf_03_submit_recoverable_replay_done`: Finding 03
- `awf_04_logical_submit_failure_contract_done`: Finding 04
- `awf_05_queue_duplicate_fingerprint_done`: Finding 05
- `awf_06_sse_delta_coalescing_done`: Finding 06
- `awf_07_unknown_session_sse_done`: Finding 07
- `awf_08_transcript_workspace_switch_done`: Finding 08
- `awf_09_transcript_read_fail_closed_done`: Finding 09
- `awf_10_transcript_store_scoped_key_done`: Finding 10
- `awf_11_ambiguous_ui_scope_done`: Finding 11
- `awf_12_ui_conversation_key_scope_done`: Finding 12
- `awf_13_displayed_guard_directory_done`: Finding 13
- `awf_14_last_session_storage_v2_done`: Finding 14
- `awf_15_legacy_opencode_submit_acceptance_done`: Finding 15

## Related Audit Inputs

- `docs/plans/2026-07-07-ai-gateway-authorization-system-deep-audit.md`
  currently classifies AI Gateway runtime authorization as structurally sound,
  with legacy `x-veslo-gateway-token` precedence as an operations/compatibility
  risk unless current E2E logs prove it is actively selecting a stale token.
- `docs/plans/2026-07-07-server-owned-composer-send-workflow-deep-audit-followups.md`
  owns several narrower server-owned composer send gaps. In particular,
  concurrent submit idempotency is adjacent to Finding 03 but is not the same
  bug as recoverable-result replay. Keep the two fixes coordinated without
  merging their acceptance criteria.
- `docs/plans/2026-07-07-tauri-pilot-e2e-parity-kiss-plan.md` owns the fresh
  E2E build and 95 second live-inference timeout policy. This plan must reuse
  that contract instead of inventing a second E2E path.
- `docs/plans/2026-07-07-opencode-old-conversation-submit-audit.md` documents
  the historical OpenCode-session binding failure class. Current code appears
  to partially address this through `resolveOpenCodeSessionForRead`; this plan
  still needs submit-route and E2E acceptance that proves the write path is
  covered.

## Global Constraints

- Keep the server-owned conversation submit path as the authoritative send path.
- Do not reintroduce hidden app-owned fallback sends for failures that should be
  fixed at the server/runtime boundary.
- Preserve AI Gateway runtime authorization as the preferred inference path.
- Keep directory/conversation/session scope explicit; do not silently fall back
  to the active workspace when a scoped conversation is ambiguous.
- Prefer narrow contract fixes and tests over broad workflow rewrites.
- When touching server TypeScript that ships in the sidecar, rebuild/validate the
  relevant sidecar path before marking done.
- Do not use floating `latest` sidecar/runtime selection in E2E acceptance.
  Validate pinned/generated artifacts.

## Execution Guards

- Start every implementation pass with `git status --short --branch`; do not
  edit unrelated dirty files unless the target finding explicitly requires it.
- Re-check the referenced code before implementing because this plan was written
  against a moving `local/sandbox-merge` checkout.
- Treat a finding as `done: true` only when the relevant code path is fixed,
  tests cover the exact regression, E2E or sidecar validation is recorded where
  applicable, and no fallback-only workaround was introduced.
- Implement Finding 02 and Finding 05 as one queue/idempotency slice. They both
  affect the queue table contract and should not be split across parallel
  agents.
- Any queue, submit-attempt, transcript-store, or browser-storage schema change
  must include an explicit migration/backcompat path for existing local data.
- Existing tests already encode parts of the current behavior. When the plan
  intentionally changes a contract, update the old contract test in the same
  patch and name the new behavior in the assertion.
- If this plan is used as a handoff artifact, make sure the file is tracked or
  explicitly passed to the next worktree. Untracked `docs/plans` files are not
  visible to normal HEAD-based agents.
- Implement Findings 11-14 as one UI scope-contract slice. The key format,
  displayed guard, send target resolver, and last-session storage migration must
  change together.

## Finding 01: Legacy Gateway Token Can Override Runtime Authorization

done: true

Severity: Critical if current E2E/generated OpenCode config evidence shows a
stale legacy gateway token winning over runtime authorization; otherwise High.

Evidence:

- `packages/server/src/ai-gateway-runtime-owner.ts:343`
- `packages/server/src/server.ts:1932`
- `packages/server/src/routes/ai-gateway.ts:65`

Problem:

Provider requests with `x-veslo-gateway-token` are treated as legacy access
token requests before runtime/run-scoped authorization is consulted. A stale
OpenCode config or old test config can therefore send an invalid bearer token
even when the fresh codex gate/runtime authorization is already primed.

The AI Gateway design audit currently says runtime authorization is structurally
sound, so this finding should not be treated as a generic P0 unless the active
failure trace proves stale-token selection in the provider route.

Proposed fix:

- Make runtime/run-scoped authorization the primary path for provider routes.
- Treat `x-veslo-gateway-token` as a compatibility fallback only when there is
  no active run context and no runtime authorization entry.
- Explicitly reject placeholder/redacted/known-stale gateway token values.
- Add diagnostics that report which auth source was selected without leaking
  token material.
- Add a short pre-fix diagnostic step: inspect the generated E2E OpenCode config
  and local AI gateway logs for the selected auth source. If no stale legacy
  header is present, keep this as a compatibility hardening item rather than the
  first blocking E2E fix.

Validation:

- Add a server AI gateway test where both a stale `x-veslo-gateway-token` and a
  valid runtime authorization are present; upstream must receive the runtime
  authorization.
- Add a test for `[REDACTED]` or placeholder gateway-token rejection.
- Run targeted AI gateway tests and `git diff --check`.

Completed:

- Provider authorization now resolves runtime/run-scoped authorization before
  legacy `x-veslo-gateway-token`; legacy is only a compatibility fallback when
  there is no active run context and no runtime authorization entry.
- Redacted legacy gateway token placeholders are rejected instead of being
  treated as usable credentials.
- `startServer()` resets the module-scoped AI gateway runtime owner state so
  runtime auth, active run contexts, and active proxy requests do not leak across
  in-process server restarts or tests.
- Server route tests now prove a stale legacy gateway token does not override a
  primed runtime ai-access token, and owner tests cover runtime precedence,
  run-scoped runtime auth, placeholder rejection, and active-run fallback
  blocking.
- Verified with `pnpm --filter veslo-server exec bun test
  src/tests/ai-gateway-runtime-owner.test.ts src/tests/server.ai-gateway.test.ts`
  and `pnpm --filter veslo-server typecheck`.

## Finding 02: Queued Runs Can Be Lost Forever In `starting`

done: true

Severity: Critical

Evidence:

- `packages/server/src/conversation-run-queue-store.ts:269`
- `packages/server/src/conversation-run-queue-store.ts:330`
- `packages/server/src/conversation-run-lifecycle-controller.ts:1076`

Problem:

The queue persists `starting`, but startup recovery schedules only `pending`
items. A process crash between `markStarting` and `markSubmitted`/`markFailed`
leaves the item invisible to future queue drains.

Proposed fix:

- Implement this together with Finding 05 because both change the queue
  idempotency schema/contract.
- Add a queue recovery method that requeues stale `starting` items to `pending`
  on startup, optionally bounded by age.
- Include `starting` items in startup scheduling or run an explicit repair sweep
  before scheduling.
- Keep queue position semantics stable for both `pending` and recovered
  `starting` rows.
- Preserve existing rows on migration; startup recovery must work for rows
  written before any new queue schema columns exist.

Validation:

- Add a queue-store unit test for recovering stale `starting` rows.
- Add a lifecycle-controller test that startup scheduling drains a recovered
  row.
- Run targeted server tests and `git diff --check`.

Completed:

- Implemented `recoverStarting()` in the durable run queue store.
- Lifecycle startup now recovers `starting` rows before scheduling pending queue
  drains.
- Verified with targeted queue-store and lifecycle-controller tests,
  `pnpm --filter veslo-server build:bin`, forced `prepare:sidecar`, and
  `git diff --check`.

## Finding 03: Submit Idempotency Caches Temporary Failures

done: true

Severity: Critical

Evidence:

- `packages/server/src/conversation-submit-service.ts:125`
- `packages/server/src/conversation-submit-service.ts:251`
- `packages/server/src/conversation-submit-attempt-store.ts:215`

Problem:

`resultJson` is replayed before any current runtime, gateway, directory, or
binding state is checked. A recoverable `blocked` or `failed` response can
become permanent for the same `clientMessageId`, including retries after local
runtime recovery.

Proposed fix:

- Store completed success, queued, and materialized outcomes as replayable.
- Store recoverable failed/blocked outcomes with enough metadata to decide
  whether to retry or expire them.
- Add an attempt status such as `terminal_failed` versus `recoverable_failed`,
  or clear `resultJson` for recoverable states.
- Preserve hard idempotency conflict checks by keeping the request hash.
- Keep this separate from the concurrent same-hash submit race in the
  server-owned composer follow-up plan. This finding is about completed
  recoverable payload replay after runtime state changes.

Validation:

- Add submit-service tests where a first call returns recoverable runtime/gateway
  failure and the second same-hash call is allowed to reattempt after recovery.
- Add a test proving success replay remains idempotent.
- Run targeted submit tests and `git diff --check`.

Completed:

- `blocked` and `failed` submit attempt results are re-evaluated on identical
  retry instead of being permanently replayed from `resultJson`.
- Replay remains enabled for successful, queued, dry-run, and materialized
  outcomes.
- First-session retries reuse any previously materialized conversation/session
  target instead of creating a duplicate conversation.
- Verified with submit-service tests, `pnpm --filter veslo-server typecheck`,
  `pnpm --filter veslo-server build:bin`, forced `prepare:sidecar`, and
  `git diff --check`.

## Finding 04: Logical Submit Failures Return HTTP 200

done: true

Severity: High for observability, test correctness, and E2E failure detection;
defer a transport-status change until app clients are updated.

Evidence:

- `packages/server/src/conversation-submit-service.ts:250`
- `packages/server/src/conversation-submit-service.ts:324`
- `packages/server/src/conversation-submit-service.ts:357`

Problem:

Transport status is `200` even when the payload is `status: "failed"`. This
makes E2E, logs, and infrastructure treat a failed inference admission as a
successful request unless every caller inspects payload semantics correctly.

Proposed fix:

- Phase 1 KISS fix: keep the existing HTTP status contract unless every caller
  is audited, but make app/E2E callers treat `status: "failed"` and terminal
  `ok: false` payloads as failed inference admission.
- Add an explicit metric/trace/error field so logs and Pilot diagnostics can
  distinguish transport success from logical submit failure.
- Consider returning non-2xx for unrecoverable failures only after route
  callers, SDK/client wrappers, and tests are updated together.
- Prefer making recoverable `blocked` and terminal `failed` distinct at the HTTP
  layer.
- If a later patch changes `/conversations/submit` or `/runs` to return non-2xx,
  update the app Veslo server client first. `requestJson` throws
  `VesloServerError` on non-2xx, so typed submit payloads will be lost unless
  the domain facade uses a raw/typed result path or an equivalent bridge.

Validation:

- Add route-level tests for failed submit payload contract and caller behavior.
- Add app/E2E tests that a `200` response with failed payload still fails the
  inference run instead of passing.
- Run server conversation tests and affected app tests.

Completed:

- App send and replacement workflows now return structured
  `SessionSubmitResult` values and treat server `status: "blocked"` /
  `status: "failed"` payloads as non-accepted inference admission, even when the
  HTTP transport status is `200`.
- Failed existing-target submit responses preserve `workspaceId`,
  `conversationId`, `opencodeSessionId`, `clientMessageId`, and
  `pendingClientSessionId` metadata so app/E2E diagnostics can identify the
  exact inference target.
- Route and app tests now cover first-session failed submit metadata, retry
  behavior after failed submit attempts, failed server submit transcript
  handling, and typed replacement `blocked` / `failed` states.
- Verified with `pnpm --filter veslo-server exec bun test
  src/tests/conversation-submit-service.test.ts
  src/tests/server-conversations.test.ts`, `pnpm --filter veslo-server
  typecheck`, `pnpm --filter veslo-server build:bin`, `pnpm --filter
  @neatech/veslo-ui exec node --test --import=tsx/esm
  src/app/tests/pages/session-send-workflow.test.ts`, `pnpm --filter
  @neatech/veslo-ui exec node --test --import=tsx/esm
  src/app/tests/context/managed-ai-runtime-config.test.ts
  src/app/tests/pages/session-mutation-workflow.test.ts`, `pnpm --filter
  @neatech/veslo-ui typecheck`, forced `prepare:sidecar`, and
  `git diff --check`.

## Finding 05: Queue Idempotency Ignores Body Hash

done: true

Severity: High

Evidence:

- `packages/server/src/conversation-run-queue-store.ts:120`
- `packages/server/src/conversation-run-queue-store.ts:200`
- `packages/server/src/conversation-run-queue-store.ts:207`

Problem:

Queue uniqueness is only `(workspace_id, conversation_id, client_message_id)`.
When a matching row exists, `enqueue` returns the previous queue item without
checking `bodyJson`, `kind`, `directory`, or `opencodeSessionId`. The returned
row also keeps the original `reservedRunId`, which is correct only for exact
duplicate retries.

Proposed fix:

- Implement this together with Finding 02 because both change queue persistence,
  duplicate detection, and migration expectations.
- Persist a deterministic `body_hash` or request fingerprint in the queue table.
- The fingerprint must exclude generated transport identifiers such as
  `queueItemId` and `reservedRunId`; exact duplicate retries can legitimately
  arrive with a newly proposed `reservedRunId` and must still reuse the original
  queued row.
- On duplicate `clientMessageId`, compare the fingerprint and return a conflict
  if it differs.
- Keep existing behavior only for exact duplicate retries.
- Backfill or lazily compute fingerprints for legacy rows so old queued work is
  not discarded on upgrade.

Validation:

- Add queue-store tests for exact duplicate reuse and different-body conflict.
- Cover both `/submit` and direct `/runs` callers where possible.
- Update the existing queue idempotency test that currently asserts duplicate
  reuse with a different `reservedRunId`; preserve that behavior only when the
  semantic request body is identical.

Completed:

- Added a durable queue request fingerprint for duplicate `clientMessageId`
  detection.
- Exact duplicate retries reuse the existing queue item and reserved run id;
  changed request intent now raises an idempotency conflict.
- Verified with targeted queue-store and lifecycle-controller tests,
  `pnpm --filter veslo-server build:bin`, forced `prepare:sidecar`, and
  `git diff --check`.

## Finding 06: SSE Coalescing Can Drop Incremental Text Deltas

done: true

Severity: High

Evidence:

- `packages/app/src/app/context/session-event-stream.ts:619`
- `packages/app/src/app/context/session-event-stream.ts:760`
- `packages/app/src/app/context/session-event-stream.ts:989`

Problem:

The event queue coalesces `message.part.updated` by `messageID:partID`, but the
event applier treats `record.delta` as incremental text. Replacing earlier
queued delta events with later delta events can drop streamed tokens.

Proposed fix:

- Do not coalesce delta-bearing `message.part.updated` events.
- If coalescing is still required for performance, accumulate deltas rather than
  replacing the previous event.
- Only coalesce full snapshot updates where the later event is known to contain
  the full part state.

Validation:

- Add app unit tests feeding multiple queued deltas through the SSE queue before
  flush and asserting final text contains every delta in order. Calling
  `applyEvent` directly is not enough because direct application bypasses the
  coalescing bug.
- Add a full-snapshot test to preserve performance-safe coalescing behavior.

Completed:

- `message.part.updated` events that carry a string `delta` no longer receive a
  coalescing key, so queued incremental text deltas for the same part are all
  applied in order before flush.
- Full-snapshot `message.part.updated` events without `delta` still coalesce by
  `messageID:partID`, preserving the existing queue performance behavior.
- Added app tests that drive events through `setupSseStream` queue/flush rather
  than `applyEvent` directly, proving both delta preservation and snapshot
  coalescing.
- Verified with `pnpm --filter @neatech/veslo-ui exec node --test
  --import=tsx/esm src/app/tests/context/session-event-stream.test.ts` and
  `pnpm --filter @neatech/veslo-ui typecheck`.

## Finding 07: SSE Drops Events For Unknown Sessions

done: true

Severity: High

Evidence:

- `packages/app/src/app/context/session-event-stream.ts:222`
- `packages/app/src/app/context/session-event-stream.ts:549`
- `packages/app/src/app/context/session-event-stream.ts:610`

Problem:

Live `message.updated` and `message.part.updated` events are ignored when the
session is not already known to the UI store. Event ordering, old-session
selection, or delayed session hydration can therefore lose assistant output.

Proposed fix:

- Create a scoped placeholder session/message only when the event or current
  binding map proves workspace, directory, and conversation identity.
- Buffer unknown-session events briefly and replay them after session scope is
  learned.
- For background workspaces or events without complete scope, route unknown
  events into background transcript ingestion or server-side binding lookup
  instead of dropping them or guessing active workspace scope.
- Do not regress the current background-workspace path: it already schedules
  background transcript ingestion for `message.updated` and `message.part.updated`.
  The primary gap is foreground/active-stream delivery before store hydration.

Validation:

- Add tests where part events arrive before session list hydration.
- Add tests that unknown events with ambiguous directory are buffered or
  persisted, not attached to the active workspace.
- Add background workspace event tests.

Completed:

- Foreground SSE `message.updated` and `message.part.updated` events now accept
  the routed active workspace as scope proof before the session list has
  hydrated, seed `workspaceSessionIds`, and preserve the assistant message/part
  in the live store instead of dropping it.
- Ambiguous no-source events still fail closed. Background workspace events still
  avoid mutating the active transcript and route message/part updates to durable
  background transcript ingestion.
- Added app tests for foreground pre-hydration message/part delivery and
  background `message.part.updated` transcript ingestion.
- Verified with `pnpm --filter @neatech/veslo-ui exec node --test
  --import=tsx/esm src/app/tests/context/session-event-stream.test.ts` and
  `pnpm --filter @neatech/veslo-ui typecheck`.

## Finding 08: Transcript Ingestion Drops On Workspace Switch

done: true

Severity: High

Evidence:

- `packages/app/src/app/context/session-transcript-controller.ts:156`
- `packages/app/src/app/context/session-transcript-controller.ts:246`
- `packages/app/src/app/context/session-transcript-controller.ts:293`

Problem:

Foreground transcript ingestion is debounced, then refuses to build a payload if
the active workspace changed. Switching workspace shortly after a response can
drop the final transcript snapshot.

Proposed fix:

- Capture both `workspaceId` and a trusted directory/session-scope snapshot when
  scheduling the ingest. Capturing only `workspaceId` is insufficient because
  the current payload builder can still fall back to `activeWorkspaceRoot`.
- Resolve directory from stored session scope for that workspace, the captured
  schedule-time scope, or workspace routing metadata; never from the newly
  active workspace root.
- Keep active-workspace checks only as diagnostics, not a write blocker.

Validation:

- Add a test where an ingest is scheduled, active workspace changes, and the
  snapshot is still appended for the original workspace/session.
- Add a variant where the session is not present in the foreground store at
  flush time but the schedule-time scope/routing entry still provides the
  original directory.

Completed:

- Live transcript ingestion now captures the schedule-time directory scope and
  uses the original `workspaceId/sessionID` at flush time instead of refusing to
  write after an active workspace switch.
- Flush payload building no longer falls back blindly to the current active
  workspace root. Directory resolution is session directory, schedule-time
  scope, routed workspace entry, then active root only when the target workspace
  is still active.
- Active workspace switches are recorded as diagnostics rather than write
  blockers.
- Added app tests for scheduled ingestion after workspace/root switch and for
  routed directory resolution when the session is missing from the foreground
  store at flush time.
- Verified with `pnpm --filter @neatech/veslo-ui exec node --test
  --import=tsx/esm src/app/tests/context/session-transcript-controller.test.ts`
  and `pnpm --filter @neatech/veslo-ui typecheck`.

## Finding 09: Transcript Read Fails Open To Raw Session Id

done: true

Severity: High

Evidence:

- `packages/server/src/conversation-service.ts:306`
- `packages/server/src/conversation-service.ts:473`
- `packages/server/src/conversation-service.ts:480`

Problem:

Binding resolution errors are swallowed as `null`, and `loadTranscript` then
uses the raw request id as the OpenCode session id. Binding-store failures and
true missing bindings become indistinguishable.

Proposed fix:

- Make binding-store errors fail closed for transcript reads.
- Only fall back to raw OpenCode session id when the request id is explicitly a
  non-Veslo OpenCode session id and the directory is verified.
- Return a structured `conversation_binding_unavailable` error for DB/read
  failures.
- Keep exact raw OpenCode session import behavior for verified legacy sessions;
  do not turn missing bindings into a blanket regression for old conversations.

Validation:

- Add conversation-service tests for binding-store throw versus binding-not-found.
- Add route-level tests for old conversation ids and raw OpenCode ids.

Completed:

- Binding/read-store exceptions during `resolveOpenCodeSessionForRead` now throw
  structured `conversation_binding_unavailable` `ApiError`s instead of returning
  `null` and letting callers read the raw request id.
- `loadTranscript` now rejects missing `conv-*` bindings with
  `conversation_not_found` and only retains raw OpenCode fallback for scoped
  non-Veslo session ids.
- Added service tests proving binding-store failure does not hit sandbox
  transcript reads and missing Veslo conversation ids do not fail open to raw
  session reads.
- Re-ran route-level transcript/prefetch tests covering raw legacy session ids
  and bound conversation ids.
- Verified with `pnpm --filter veslo-server exec bun test
  src/tests/conversation-service.test.ts`,
  `pnpm --filter veslo-server exec bun test
  src/tests/server-session-transcript-prefetch.test.ts`,
  `pnpm --filter veslo-server typecheck`,
  `pnpm --filter veslo-server build:bin`, and forced
  `VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar`.

## Finding 10: Transcript Store Key Omits Directory

done: true

Severity: High if engine session id collisions across directories are possible
with current or imported OpenCode data; otherwise Medium contract hardening.

Evidence:

- `packages/server/src/conversation-binding-store.ts:254`
- `packages/server/src/conversation-transcript-store.ts:139`
- `packages/server/src/conversation-transcript-store.ts:223`

Problem:

The binding store permits the same engine session id in different directories,
but transcript persistence is keyed only by workspace and engine session id.
That can merge or overwrite transcript rows across directory-scoped bindings.

The transcript store currently documents the opposite assumption: engine session
ids are globally unique. Do not start a transcript-key migration until that
assumption is validated against current OpenCode ids, legacy imported ids, and
test fixtures.

Proposed fix:

- First add a focused validation/repro test for same `engineSessionId` in two
  directories. If the product cannot create or import such a collision, record
  this finding as deferred hardening rather than changing storage.
- If the collision is possible, add `conversation_id` or normalized `directory`
  to transcript keys.
- Prefer `conversation_id` because it is already deterministic over
  workspace/directory/engine session.
- Add a migration or compatibility read that can map legacy rows into the new
  scoped key without losing old history.

Validation:

- Add transcript-store tests with same `engineSessionId` in two directories.
- Add migration/backcompat tests for existing rows.

Completed:

- `conversation-transcript-store` now accepts optional `directory` on append/read
  and keys `conversation_message`, `conversation_part`, and empty transcript
  markers by `(workspace_id, directory, engine_session_id, ...)`.
- Added SQLite migration from legacy unscoped transcript tables into
  `directory = ""` rows, plus scoped reads that fall back to those legacy rows
  only when no exact directory-scoped transcript exists.
- `conversation-service` now passes the conversation directory into host
  transcript read/write paths, so two bindings with the same OpenCode
  `engineSessionId` in different directories no longer overwrite each other.
- Added transcript-store tests for same engine session id across directories and
  legacy unscoped fallback, plus a service-level collision test across two
  directory-scoped bindings.
- Verified with `pnpm --filter veslo-server exec bun test
  src/tests/conversation-transcript-store.test.ts src/tests/conversation-service.test.ts`,
  `pnpm --filter veslo-server exec bun test
  src/tests/server-session-transcript-prefetch.test.ts`,
  `pnpm --filter veslo-server typecheck`,
  `pnpm --filter veslo-server build:bin`, and forced
  `VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar`.

## UI Scope Contract Slice For Findings 11-14

Findings 11-14 must be implemented as one coherent UI scope migration. The
target contract should define one stable identity shape that includes:

- `workspaceId`
- normalized workspace root
- normalized directory
- Veslo `conversationId` when present
- OpenCode `opencodeSessionId` when present
- legacy raw session id only as an untrusted compatibility input

Required order:

1. Define and test the canonical scope serializer/parser.
2. Route send/read/abort target resolution through the canonical scope.
3. Migrate queue/draft/run UI keys.
4. Migrate `veslo.workspace-last-session.v1` reads into a scoped v2 format.
5. Update displayed-conversation guards to compare directory and workspace root.
6. Add ambiguity diagnostics before enabling auto-selection from stored state.

Do not weaken the existing `resolveUiConversationScope` ambiguity behavior: it
already returns `null` for multiple candidates without a selected scope. The bug
is the caller fallback from unresolved scope to the active workspace.

## Finding 11: Ambiguous UI Scope Falls Back To Active Workspace

done: false

Severity: High

Evidence:

- `packages/app/src/app/lib/conversation-scope.ts:143`
- `packages/app/src/app/context/workspace-session-selection.ts:407`
- `packages/app/src/app/context/workspace-session-selection.ts:420`

Problem:

When the UI has multiple candidate scopes for a session id and cannot resolve
one, send target resolution silently falls back to the active workspace root.
That can route a follow-up prompt into the wrong workspace/directory.

Proposed fix:

- Make ambiguous scope a blocking state for send/abort/read actions.
- Surface a clear error asking the user to select the conversation from the
  scoped sidebar entry.
- Include candidate workspace/directory ids in debug diagnostics.

Validation:

- Add unit tests for multiple scope candidates and send target resolution.
- Verify send refuses to continue without a resolved scope.

## Finding 12: UI Conversation Key Loses Directory And Conversation Identity

done: false

Severity: High

Evidence:

- `packages/app/src/app/lib/ui-conversation-scope.ts:43`
- `packages/app/src/app/context/workspace-session-selection.ts:370`
- `packages/app/src/app/pages/session-conversation-flow.ts:121`

Problem:

Queue, draft, and run UI keys are based on workspace id plus a session-like id.
They do not include directory, conversation id, or OpenCode session id as stable
scope dimensions, even though the rest of the system treats those as part of
conversation identity.

Proposed fix:

- Extend `UiConversationKey` to include a stable scope signature for
  directory/conversation/opencode id.
- Keep a compatibility parser for legacy keys long enough to clean old local
  state.
- Route queue and pending-submitted draft state through the scoped key.

Validation:

- Add key parser/serializer tests.
- Add queue remap tests for same session id in different directories.

## Finding 13: Displayed Conversation Guard Ignores Directory

done: false

Severity: High

Evidence:

- `packages/app/src/app/context/workspace-session-selection.ts:38`
- `packages/app/src/app/context/workspace-session-selection.ts:137`
- `packages/app/src/app/context/workspace-session-selection.ts:148`

Problem:

The guard used to decide whether async send results still belong to the current
view checks workspace/conversation/opencode ids, but not directory. A stale async
result can still match the visible session if directory changed underneath.

Proposed fix:

- Add `directory` and `workspaceRoot` to `DisplayedConversationGuard`.
- Compare normalized directory as part of `displayedConversationStillMatches`.
- Fail closed when scope cannot be resolved.

Validation:

- Add tests where same session/opencode id appears in two directories and stale
  result is rejected.

## Finding 14: Last Session Storage Is Workspace-Only

done: false

Severity: High

Evidence:

- `packages/app/src/app/context/workspace-session-selection.ts:21`
- `packages/app/src/app/context/workspace-session-selection.ts:309`
- `packages/app/src/app/context/workspace-session-selection.ts:321`

Problem:

`veslo.workspace-last-session.v1` stores only `workspaceId -> sessionId`. After
restart, the app may not have the rich conversation scope map yet, so it can
return a raw id and later resolve it against the active workspace/directory.

Proposed fix:

- Version the storage format to include session id, directory, conversation id,
  OpenCode session id, and workspace root.
- Keep a read-only migration for v1 entries that treats raw ids as untrusted
  until scope is hydrated.
- Never auto-select a stored raw id when multiple candidate scopes exist.

Validation:

- Add storage migration tests.
- Add active-workspace hydration tests after app restart with multiple
  directory-scoped sessions.
- Add a compatibility test proving v1 raw ids are not auto-selected when more
  than one scoped candidate exists after hydration.

## Finding 15: Legacy OpenCode Submit Import Needs Route And E2E Acceptance

done: false

Severity: High

Evidence:

- `docs/plans/2026-07-07-opencode-old-conversation-submit-audit.md:14`
- `packages/server/src/conversation-service.ts:268`
- `packages/server/src/server.ts:3764`
- `packages/server/src/tests/conversation-service.test.ts:412`

Problem:

Historical OpenCode sessions can be visible from the read path even when they
were created before Veslo persisted a `conversation_binding`. Current
`resolveOpenCodeSessionForRead` appears to import an exact legacy session from
source rows, and unit tests cover that helper. The remediation plan still needs
route-level and E2E acceptance proving that server-owned submit uses that import
path for existing-session follow-up sends.

Without that acceptance, a regression can keep the UI readable/selectable while
the write path fails with `conversation_not_found` before provider streaming
starts.

Proposed fix:

- Re-check current `resolveConversationExecutionTarget` and
  `resolveOpenCodeSessionForRead` before changing code; do not duplicate the
  import logic if it already exists.
- Add a route/service integration test where submit targets a raw legacy
  OpenCode session id in the exact requested directory with no existing binding.
  Expected result: the server imports/binds it and the run is admitted.
- Add negative tests for wrong directory and unknown raw id; both must remain
  `conversation_not_found`.
- Add Pilot coverage, or explicit manual E2E evidence, that opening a legacy
  OpenCode conversation and sending a follow-up starts the provider request and
  persists assistant output.

Validation:

- Targeted server conversation route tests pass.
- Existing `conversation-service` legacy-import tests still pass.
- E2E live-inference or old-conversation Pilot evidence shows a provider request
  starts after a legacy-session follow-up send.
- No frontend legacy fallback is reintroduced.

## Suggested Implementation Order

1. Reproduce and classify the current live-inference failure. If stale legacy
   gateway-token selection is proven, fix Finding 01 first; otherwise keep it
   as high-priority compatibility hardening.
2. Fix queue `starting` recovery and queue duplicate fingerprinting together
   (Findings 02 and 05).
3. Fix submit attempt replay semantics for recoverable failures (Finding 03).
4. Fix logical submit-failure handling in callers/tests without broad HTTP
   contract churn (Finding 04).
5. Fix legacy OpenCode submit import acceptance (Finding 15), then transcript
   read fail-closed behavior (Finding 09).
6. Fix SSE delta coalescing and unknown-session handling (Findings 06 and 07).
7. Fix transcript ingestion and validated transcript-store scoping (Findings 08
   and 10).
8. Fix UI scope keys, displayed guards, and last-session storage as one contract
   migration (Findings 11-14).
9. Re-run E2E with forced sidecar rebuild after server/app changes.

## Acceptance Checklist

- [ ] All findings above either remain `done: false` or were individually
  changed to `done: true` with the matching front matter flag, tests, and
  validation noted in commit/PR text.
- [ ] Server tests cover queue recovery, submit idempotency, transcript scoping,
  legacy OpenCode submit import, and AI Gateway auth precedence.
- [ ] App tests cover SSE deltas, unknown-session events, workspace-switch
  transcript ingestion, scoped UI keys, displayed guards, and last-session
  storage migration.
- [ ] Fresh E2E validation follows the parity plan on Windows PowerShell:

  ```powershell
  pnpm --filter veslo-server build:bin
  $env:VESLO_SIDECAR_FORCE_BUILD = "1"
  pnpm --filter @neatech/veslo run prepare:sidecar
  Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
  pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
  pnpm --filter @neatech/veslo-e2e test:pilot:live-inference
  ```

- [ ] Canonical live-inference Pilot scenarios cap `global_timeout_ms` and step
  `timeout_ms` at `95000`.
- [ ] Live inference evidence proves `codex_oauth` through the local AI gateway,
  not OpenAI API-key fallback or fixture gateway login.
- [ ] `git diff --check` passes.
