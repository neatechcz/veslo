---
title: Queue Message Correctness and Read-Only Projection Plan
date: 2026-07-10
status: ready-for-implementation
done: false
source_audit: docs/dev/2026-07-10-session-queue-adjacent-files-deep-audit.md
---

# Queue Message Correctness and Read-Only Projection Plan

## Verdict

The original audit found several real problems, but it mixed four different
categories:

1. correctness defects that can duplicate work or lose visible state;
2. intentionally deferred product scope;
3. documentation and test debt;
4. hypotheses that are not supported strongly enough to call defects.

This corrected plan keeps the two existing queues explicit:

- the app-local queue owns editable drafts before server acceptance;
- `conversation_run_queue` is the only durable execution queue after server
  acceptance.

The first implementation work should fix three narrow correctness defects
before adding the read-only server queue UI. A full cancel/edit/move/pause API
migration remains out of scope.

## Finding Disposition

| Original finding | Verdict | Correct disposition |
| --- | --- | --- |
| QMSG-01 | confirmed, overlaps QMSG-02 and QMSG-11 | One read-side gap: no conversation-scoped list, app client, projection, activation hydration, or reconnect refresh. Track once as `QK04`. |
| QMSG-02 | confirmed, overlaps QMSG-01 and QMSG-11 | The active-run Enter path can return a durable queue identity without creating a visible row. Track as part of `QK04`. |
| QMSG-03 | not a defect | The full mutation API is explicitly deferred as `BSW08A`. Keep it out of this KISS plan. |
| QMSG-04 | confirmed documentation defect | The feature contract still describes the old local-first running-Enter path. Fix in `QK05`. |
| QMSG-05 | confirmed verification debt | There is no dedicated Tauri Pilot queue scenario. Add it only after the contracts below exist. |
| QMSG-06 | mechanism confirmed, impact decision-gated | `SessionView` owns the local queue and is unmounted outside the session view. This is an undocumented lifetime boundary, not proof that the queue must be lifted or persisted. Document it in `QK05`; do not refactor ownership in this plan. |
| QMSG-07 | valid operational debt, not a queue correctness defect | Terminal queue and submit-attempt retention needs a separate data-retention decision that covers prompt content and token hashes. Do not hide it inside read-only UI work. |
| QMSG-08 | confirmed P1 defect | A local queue row does not retain its logical `clientMessageId`; a response-loss retry can submit the same draft under a new id. Fix in `QK02`. |
| QMSG-09 | confirmed P2 defect | Every local `error` row is implicitly drain-eligible. There is no explicit retry boundary or FIFO behavior for a failed head item. Fix in `QK03`. |
| QMSG-10 | intentional architecture split | Durable unpublished composer state and pre-admission execution drafts have different owners. Clarify the boundary; do not reuse the pending-draft store as a queue. |
| QMSG-11 | duplicate of QMSG-01 | Reconnect is one required refresh trigger for `QK04`, not a separate finding. |
| QMSG-12 | confirmed P1 defect; severity raised | A first-session attempt is claimed before materialization, but the created conversation target is not checkpointed before downstream submit. A process exit in that window can create a second conversation on retry. Fix first in `QK01`. |
| QMSG-13 | not proven | Historical prefixes still protect older persisted/navigation inputs and are covered by compatibility tests. Do not remove them without upgrade-state evidence. |

## Findings Missing From the Original Plan

### QMSG-14 - Queue claim is not atomic for competing workers

Severity: P1/P2

`markStarting()` performs an expected-state update, but then returns the row by
id even when that update changed zero rows. Two store/controller instances can
therefore both observe the same row as `starting` and continue the submit.
`markSubmitted()` and `markFailed()` also lack expected prior-state guards.

The current in-memory drain set protects one controller instance only. The
SQLite store must be the durable concurrency boundary. Fix this narrowly in
`QK03`; do not add a lease system unless the atomic-claim test proves it is
needed.

### QMSG-15 - Stop wording does not match accepted server queue behavior

Severity: P2 contract mismatch

The app pause flag affects only local drafts. Server abort completion schedules
the durable queue to drain, so a request accepted before Stop can start after
the aborted run becomes terminal.

The KISS default is to document current ownership precisely:

- Stop pauses only app-local, not-yet-accepted drafts;
- accepted server queue work remains server-owned and may continue.

If product instead requires Stop to pause already accepted work, that is a
separate server pause/resume API decision under `BSW08A`; it must not be implied
by a local boolean.

## Test-Audit Disposition

- `TEST-01` is a useful contract warning, not a production defect by itself.
  Local and server results may both clear the composer, but tests for a
  server-owned `queued` result must also require `queueItemId`,
  `reservedRunId`, `clientMessageId`, and a server submit trace.
- `TEST-02` through `TEST-06` are valid coverage gaps. They collapse into the
  focused tests for `QK01` through `QK04` and one final Tauri Pilot scenario.
- Source-regex tests may remain architecture guards, but they are not evidence
  that persistence, retry, reconnect, or desktop projection works.

## Hard Contracts

1. Do not create another durable queue or reuse the pending-draft store as one.
2. One logical local queue row owns one `clientMessageId` until the draft body
   is edited or the user explicitly starts a new logical request.
3. The original submit request hash remains the idempotency key even after a
   materialized conversation target is checkpointed internally.
4. A durable queue row is claimed by at most one worker transition.
5. Queue state `submitted` means that the queued request crossed the downstream
   OpenCode submit boundary. Later run completion/failure belongs to the
   lifecycle run identified by `reservedRunId`; do not keep the queue row open
   as a second lifecycle state machine.
6. A queue read DTO must never expose `bodyJson`, directory paths, runtime
   authorization hashes, or arbitrary fields copied from the persisted body.
7. Server-backed rows and local editable drafts remain separate app models in
   the read-only slice.
8. Remote workspaces remain fail-closed for this local durable queue.

## Implementation Order

### QK01 - Crash-safe first-session materialization checkpoint

Priority: P0

Status: `done: false`

Owners:

- `packages/server/src/conversation-submit-service.ts`
- `packages/server/src/conversation-submit-attempt-store.ts`
- focused submit service/store tests

Implementation:

1. Immediately after `createConversation()` succeeds, persist the attempt as
   `materialized` with `conversationId` and `opencodeSessionId` before calling
   `submitResolvedRun()`.
2. Do not write a replayable terminal `resultJson` at this checkpoint. It is a
   resume pointer, not a completed submit result.
3. On every non-conflicting retry, restore the request target from the stored
   attempt whenever the original request did not contain a real target. Do this
   even when `resultJson` is still null.
4. Keep request-hash comparison based on the original client request. The
   internally restored target must not create a new idempotency contract.
5. Reuse the existing attempt schema and statuses. Do not add leases, timeouts,
   or another recovery table for this fix.

Required tests:

- during the first downstream submit, the attempt store already contains the
  materialized conversation target;
- a new service instance with a persisted materialized attempt resumes the
  existing target and does not call `createConversation()` again;
- same id plus a different original request still returns the existing
  idempotency conflict;
- the existing failed/blocked-after-materialization retries remain green.

Acceptance:

- a process exit after conversation creation cannot cause the same
  `(workspaceId, clientMessageId)` request to create a second conversation;
- the resumed submit reaches the existing target exactly once per retry call.

### QK02 - Stable logical identity for local queued drafts

Priority: P0

Status: `done: false`

Owners:

- `packages/app/src/app/components/session/session-queue-model.ts`
- `packages/app/src/app/pages/session-conversation-flow.ts`
- focused queue model and conversation-flow tests

Implementation:

1. Add a required `clientMessageId` to `QueuedDraft` and generate it through the
   existing `createClientMessageId()` dependency when the local row is created.
2. Add an optional client-message-id override to `sendPromptImmediate()` and
   use the override after trimming it; generate a new id only when no override
   is supplied.
3. Queue drain and unchanged explicit retry must pass the row's stored id.
4. Editing the draft body must rotate to a newly generated id before the edited
   body can be sent. This avoids reusing one id with a different request hash.
5. Keep `queueItemId` and `reservedRunId` out of the pre-admission row. They are
   server result identities, not local draft identity.

Required tests:

- a transport failure followed by retry of the unchanged row uses the same
  `clientMessageId`;
- editing the row produces a different id;
- two separately appended local drafts receive distinct ids;
- normal, send-now, replacement, and active-run direct server admission still
  generate or forward exactly one id.

Acceptance:

- response loss after server acceptance cannot duplicate the logical queued
  request merely because the app retried it;
- edited content cannot silently collide with the prior request hash.

### QK03 - Explicit local retry boundary and atomic server claim

Priority: P1

Status: `done: false`

This slice contains two small state-transition fixes. They may be implemented
as separate commits but must keep their contracts aligned.

App retry policy:

1. Remove `error` from automatic drain eligibility.
2. Preserve FIFO: a failed head row blocks later local rows until the user
   chooses Retry, Edit/Send, or Cancel.
3. Add an explicit Retry action that moves the unchanged row back to `queued`,
   keeps its `clientMessageId`, and triggers one drain when the session is idle.
4. Edit rotates identity as required by `QK02`; Cancel removes the row and
   triggers the next drain when safe.
5. Do not infer retryability from localized error text. Typed transient retry
   policy can be added later if product wants bounded automatic retry.

Server claim policy:

1. Return a claimed row from `markStarting()` only when the
   `pending -> starting` update changed exactly one row.
2. Guard `markSubmitted()` and `markFailed()` with the expected `starting`
   state so a late callback cannot overwrite another terminal transition.
3. Keep startup `starting -> pending` recovery. Do not add a worker lease while
   the single-process startup contract and atomic claim are sufficient.

Required tests:

- an idle/status/session-selection signal does not retry an error row;
- explicit Retry submits once with the unchanged id;
- a failed head row prevents a later row from overtaking it;
- Edit or Cancel releases the head and drains the next row once;
- two queue store instances using the same SQLite file race the same row and
  exactly one receives a successful claim;
- stale terminal updates return null and do not overwrite the stored state.

### QK04 - Minimal read-only durable queue projection

Priority: P1

Status: `done: false`

Owners:

- the existing server queue store and conversation routes;
- the typed app Veslo server conversation client;
- a small server-queue projection owned by the session view;
- focused server route/client/projection tests.

Server contract:

1. Add one workspace-and-conversation-scoped list method to the existing queue
   store with deterministic ordering and cursor pagination.
2. Add `GET /workspace/:id/conversations/:conversationId/queue` with validated
   queue-state filters. The app read slice needs `pending`, `starting`, and
   `failed`; submitted work moves to the lifecycle/transcript projection.
3. Return a dedicated typed DTO containing only safe status fields:
   `workspaceId`, `conversationId`, `opencodeSessionId`, `queueItemId`,
   `reservedRunId`, `clientMessageId`, `kind`, `status`, queue position,
   timestamps, and sanitized error text.
4. Never return `bodyJson`, directory, runtime authorization data, or a spread
   of the stored body. Hydrated rows may use a generic localized label based on
   the typed `kind`; preserving prompt text across reload is deliberately not
   part of this read-only slice.
5. Keep the existing single-item status route and expose it through the app
   client for a row already known from a submit result.

App projection:

1. Introduce a separate `ServerQueuedRunProjection` keyed by `queueItemId` and
   scoped by the existing UI conversation identity. Do not add server fields to
   `QueuedDraft` and do not give server rows edit/cancel/move controls.
2. Create a row immediately from an accepted server `queued` result so the
   composer cannot clear into an invisible state.
3. Hydrate the selected conversation on activation, after reconnect completes,
   and when returning from a background workspace/session.
4. Poll only known `pending`/`starting` rows with one named bounded backoff
   policy; stop polling on terminal state, scope change, or disposal.
5. Show server `failed` state and its sanitized message. Remove a `submitted`
   queue projection once the downstream run/transcript projection owns the
   `reservedRunId`.
6. Keep all reads workspace-scoped. A background reconnect must never query the
   same conversation id through the active workspace client by accident.

Read-only scope exclusions:

- server cancel, edit, move, retry, pause, and resume;
- persistence of app-local pre-admission drafts;
- terminal-row acknowledgment or retention policy;
- exposing full queued prompt bodies;
- a new global queue store or broad `SessionView` extraction.

Required tests:

- server list ordering, pagination, state validation, and workspace/conversation
  isolation;
- response serialization proves secret/body fields are absent;
- app client path construction and typed response parsing;
- accepted submit result creates one read-only row with matching identities;
- activation and reconnect hydrate pending/starting rows without duplicates;
- failed status remains visible with the server message;
- submitted status hands off to the run/transcript identity and removes the
  queue projection;
- local editable rows and server read-only rows never merge by array index or
  display text.

Acceptance:

- an accepted server-queued request is visible immediately;
- reopening or reconnecting the conversation reconstructs durable waiting work;
- workspace isolation and response redaction are proven by behavior tests;
- the slice makes no claim that `BSW08A` mutation migration is complete.

### QK05 - Canonical documentation and real desktop gate

Priority: P1 after `QK01` through `QK04`

Status: `done: false`

Documentation:

1. Update `docs/features/session-runtime.md` to describe the actual split:
   active-run Enter uses server queue admission; local rows are pre-admission
   editable drafts; accepted rows are read-only server projections.
2. State the local queue lifetime explicitly: it is not restart durable and is
   destroyed when the session view is unmounted unless it has crossed server
   admission.
3. State the KISS Stop rule: local drafts pause; already accepted server work
   may continue. If product rejects that rule, open a separate `BSW08A`
   pause/resume decision before changing code.
4. Clarify that queue `submitted` is an admission terminal state and later run
   failure is read from lifecycle/transcript state by `reservedRunId`.

Desktop verification:

Add one deterministic Tauri Pilot scenario using an isolated profile and local
fixtures. It must prove:

1. an active run accepts one follow-up and shows one server-owned read-only row;
2. a server restart/reconnect rehydrates that row in the same workspace and
   conversation;
3. a fixture-induced queue failure is visible;
4. exactly one downstream submit occurs for the stable logical request;
5. local draft controls are not rendered for the server row.

Do not use a live model response as the queue-state fixture. The scenario should
control the active lifecycle and failure transition deterministically through
the existing local test runtime.

## Verification Commands

Run the narrowest relevant checks after each slice, then the desktop gate after
all source slices are complete.

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-submit-attempt-store.test.ts src/tests/conversation-submit-service.test.ts src/tests/conversation-run-queue-store.test.ts src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/queued-message-list.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/context/live-transcript-read-policy.test.ts src/app/tests/context/conversation-service.test.ts
pnpm --filter @neatech/veslo-ui typecheck

git diff --check
```

For the final desktop proof, follow the process preflight in
`docs/dev/testing-playbook.md`, rebuild the server sidecar and E2E desktop
binary, then run the focused Tauri Pilot queue scenario.

## Completion Checklist

- [ ] `QK01` checkpoint is persisted before downstream submit and restart
      recovery reuses the conversation.
- [ ] `QK02` local queue identity is stable across unchanged retry and rotates
      on edit.
- [ ] `QK03` local errors require an explicit action and server claim is atomic.
- [ ] `QK04` server queue read DTO, list/status client, hydration, reconnect,
      redaction, and read-only rendering are complete.
- [ ] `QK05` canonical feature text matches runtime behavior.
- [ ] Focused app/server tests, typechecks, server binary rebuild, and
      `git diff --check` pass.
- [ ] The real Tauri Pilot scenario passes in an isolated profile.
- [ ] `BSW08A` remains `done: false` unless its full mutation acceptance
      criteria are separately implemented.

## Explicit Non-Goals

- no queue-store replacement;
- no broad `SessionView` or app-state refactor;
- no server editing of accepted run bodies;
- no cancel/move/pause/resume API in this plan;
- no automatic retry classification based on error strings;
- no raw queue body in a read response;
- no removal of legacy pending-key prefixes without upgrade evidence;
- no claim that terminal retention/data classification is solved.
