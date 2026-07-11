---
title: Session Queue Adjacent Files Audit and KISS Remediation Plan
date: 2026-07-10
status: ready-for-implementation
done: false
repository_snapshot: veslo-main main 7e0819a7
sq01_crash_safe_materialization_done: false
sq02_stable_local_send_identity_done: false
sq03_server_queue_read_projection_done: false
sq04_contract_docs_done: false
sq05_atomic_queue_claim_done: false
desktop_e2e_done: false
retention_decision_done: false
---

# Session Queue Adjacent Files Audit and KISS Remediation Plan

## Goal

Validate the queue-adjacent findings against the live code, remove duplicates
and speculative refactors, and leave a narrow implementation plan that protects
accepted work without creating a second queue owner.

This document is based on `veslo-main` branch `main` at `7e0819a7`. The audit
changed no production code.

## Executive Verdict

The original list was directionally useful but not implementation-ready. It
mixed confirmed defects, deferred product scope, documentation gaps, future
multi-worker hardening, and duplicate descriptions of the same missing read
model.

The live architecture has two intentional owners:

- the app-local queue owns editable drafts that have not been accepted by the
  Veslo server;
- `conversation_run_queue` owns accepted local-workspace run requests.

That split is valid. The narrow defects are at the handoff and recovery
boundaries:

1. a local queued draft does not retain one stable Veslo `clientMessageId`
   across retries;
2. a first-session submit can create a second OpenCode session after a process
   crash in the create-success/store-checkpoint window;
3. accepted server queue items have no conversation-scoped app read model or
   reload/reconnect projection;
4. local queue errors are drain-eligible without an explicit retry action or
   retry policy;
5. Stop pauses only pre-admission local drafts while already accepted server
   work continues, but the feature wording does not distinguish those states.

The smallest robust direction is therefore not a full queue migration. It is:

- make the local queued send envelope stable and explicitly retryable;
- make first-session materialization replay-identifiable at the downstream
  OpenCode boundary;
- add a read-only server queue projection before any server edit/cancel/move
  APIs;
- document the existing Stop and lifecycle semantics;
- add one atomic store claim guard and one real desktop regression scenario.

## Non-Negotiable Invariants

- Do not introduce another durable execution queue.
- Keep `conversation_run_queue` as the only durable owner of accepted queued
  runs.
- Keep `conversation_submit_attempt` limited to idempotency, materialization,
  and result pointers; it must not become a lifecycle store.
- Keep Veslo `clientMessageId` separate from OpenCode prompt/message identity.
- Scope every queue read and retry by workspace plus conversation identity.
- Never select a queue or session by the currently visible workspace after the
  send has captured its target.
- Do not retry an unknown side effect with a new idempotency key.
- Do not use timeout expiry alone as proof that a previous create or submit did
  not happen.
- Do not expose `bodyJson`, request hashes, or authorization token hashes in the
  app queue read API.
- Do not start server edit/cancel/move/pause APIs in the read-only projection
  slice.

## Finding Disposition

| Original | Disposition                        | Corrected conclusion                                                                                                                                                                                                                                            |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1       | Confirmed, P1/P2                   | Local queue retry creates a fresh `clientMessageId`. Merge the missing semantic send-policy fields into the same stable-envelope fix.                                                                                                                           |
| F2       | Confirmed, P2                      | Active-run Enter can be accepted by the server without a durable visible app row.                                                                                                                                                                               |
| F3       | Not a defect                       | Full server edit/cancel/move/pause migration is explicitly deferred as BSW08A. Keep it out of the KISS slice.                                                                                                                                                   |
| F4       | Confirmed, P2                      | `error` rows are eligible for a later drain trigger. This is not an immediate retry loop, but retry ownership is still implicit.                                                                                                                                |
| F5       | Duplicate of F2                    | Conversation-scoped list/hydration is the read half of the same projection gap.                                                                                                                                                                                 |
| F6       | Unproven product boundary          | Local state is mounted-view owned, but the audit did not prove that current navigation unmounts the owner or that view-lifetime drafts violate a product promise. Document the boundary; do not move state ownership now.                                       |
| F7       | Not a current defect               | No current production producer was found for raw `pending:`, `pending-draft:`, or `pending-workspace:` queue keys. Removal is cleanup only and needs a compatibility decision.                                                                                  |
| F8       | Confirmed documentation defect, P3 | Canonical feature text still describes running Enter as app-local queueing.                                                                                                                                                                                     |
| F9       | Policy gap, P3                     | Terminal queue retention is unspecified. Merge with F15 and resolve separately from correctness fixes.                                                                                                                                                          |
| F10      | Confirmed verification gap, P2     | There is no dedicated Tauri Pilot scenario for durable queue identity, visibility, reload, or terminal failure.                                                                                                                                                 |
| F11      | Rejected as a correctness finding  | Queue `submitted` means handed to OpenCode, not lifecycle success. The canonical server contract already separates queue processing from run lifecycle. `completedAt` is ambiguous naming, but changing queue rows on later lifecycle failure would mix owners. |
| F12      | Confirmed contract/UX mismatch, P2 | Stop pauses only local pre-admission drafts. Accepted server work is intentionally woken after abort and currently continues.                                                                                                                                   |
| F13      | Confirmed, P1/P2                   | A crash after OpenCode session creation and before the attempt pointer is stored can duplicate first-session materialization.                                                                                                                                   |
| F14      | Hardening, not a current incident  | The desktop server currently has one lifecycle controller. A compare-and-set claim is worthwhile; a lease/token refactor is not justified.                                                                                                                      |
| F15      | Merge with F9                      | The stored token value is a hash, not a raw credential. Prompt bodies still need the same retention decision as the submit-attempt and transcript stores.                                                                                                       |
| F16      | Merge with F2; narrow semantics    | A queue-drain failure needs queue projection. A failure after `submitted` belongs to the lifecycle run identified by `reservedRunId`, not to a rewritten queue terminal state.                                                                                  |

## Verified Current Contracts

The following are implemented and are not remediation work:

- durable idempotent server queue admission by
  `(workspaceId, conversationId, clientMessageId)`;
- request-fingerprint conflict detection;
- startup recovery from queue `starting` back to `pending`;
- server queue drain after lifecycle terminal reconciliation;
- workspace/conversation-scoped single-item queue status reads;
- same-fingerprint replay conversion to `queued_run_failed` when the queue row
  itself failed;
- active-run Enter submission through the server-owned queue path;
- queued transcript-policy events that do not grant a transcript read;
- same-process submit single-flight protection.

The audit baseline passed:

```text
App queue/flow/transcript-policy tests: 80 passed
Server submit-attempt/submit-service/queue/lifecycle tests: 63 passed
Dedicated durable queue Tauri Pilot scenario: absent
```

These tests prove the current source contracts. They do not close the crash
window, response-loss retry identity, reload projection, or real desktop
boundary.

## Recommended Implementation Order

1. SQ01 - crash-safe first-session materialization.
2. SQ02 - stable local queued-send identity and explicit retry.
3. SQ03 - read-only accepted server queue projection.
4. SQ04 - Stop/lifecycle wording and canonical feature documentation.
5. SQ05 - atomic queue claim/state guards.
6. Dedicated Tauri Pilot queue scenario.
7. Retention/data-classification decision as a separate policy slice.

SQ01 and SQ02 are the duplicate-side-effect fixes. SQ03 is deliberately read
only. Do not block the first three slices on the broader BSW08A mutation design.

## SQ01 - Crash-Safe First-Session Materialization

Status: `done: false`

Severity: P1/P2

Owner: server submit attempt/service plus the OpenCode session-create adapter

### Confirmed failure

The attempt store claims a durable `started` row before creation. The submit
service then calls `createConversation()` and stores the returned conversation
and OpenCode session pointers only when it completes the submit result.

If the process stops after OpenCode created the session but before the attempt
row receives those pointers, the next process sees the same `started` attempt
with no recoverable target and creates again.

The existing in-memory single-flight map protects overlapping calls in one
process only. Sequential failure tests protect retries after the materialized
target was successfully stored. Neither covers this crash window.

### KISS implementation

Do not call a post-create SQLite update alone "crash safe"; it only makes the
window smaller. The downstream create side effect must be discoverable by the
stable submit-attempt identity.

1. Derive one valid, versioned OpenCode session id from the existing
   `(workspaceId, clientMessageId)` attempt identity. Use a central helper; do
   not encode the prompt, title, directory, or a UI route into the id.
2. Verify in an integration test that the mounted OpenCode `POST /session`
   endpoint supports the current v2 create contract: a caller-supplied id
   creates the session when absent and returns the same session when reused.
   Current upstream documentation specifies this behavior, but the repository's
   pinned `@opencode-ai/sdk@1.17.13` create type does not expose the id yet, so
   the routed runtime must be tested before implementation.
   Reference: [OpenCode v2 session specification](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md).
3. Persist the chosen `opencodeSessionId` on the attempt before the create side
   effect, then pass that same id to OpenCode session creation.
4. Immediately after create and binding succeed, update the attempt row to
   `materialized` with `conversationId` and `opencodeSessionId` before run
   submission.
5. Apply `conversationSubmitRequestWithAttemptTarget()` whenever an attempt has
   stored target pointers, even when `resultJson` is still null.
6. On retry, create/get the session with the stored id, bind the returned
   session idempotently, checkpoint `conversationId`, and continue.
7. If the mounted OpenCode version cannot reuse a caller-supplied id, stop this
   slice and upgrade/add a real upstream idempotency contract. Do not substitute
   metadata scans, title searches, age heuristics, or blind timeout retries.

This keeps the fix inside the existing submit-attempt and conversation
materialization owners. It does not add a lease service or a second session
registry.

### Required tests

- A RED test creates the upstream session, simulates process loss before the
  attempt checkpoint, constructs a new submit-service instance on the same
  attempt database, and proves that retry returns the original session.
- The crash-window test asserts exactly one upstream create and one eventual
  run admission.
- A stored materialized pointer with null `resultJson` resumes the existing
  target.
- A different request hash still returns `idempotency_conflict`.
- Reusing the preallocated id returns the original upstream session.
- Workspace and directory mismatch cannot recover another session.

### Acceptance

- Retrying the same first send after process restart cannot create a second
  OpenCode session.
- The result is based on stable identity, not timing or title text.
- The preallocated id contains no raw prompt or authorization material.
- `sq01_crash_safe_materialization_done` stays false until the cross-instance
  crash-window test passes.

## SQ02 - Stable Local Queued-Send Identity and Explicit Retry

Status: `done: false`

Severity: P1/P2

Owner: app queue model and conversation flow

### Confirmed failure

`QueuedDraft` stores a UI row id and draft only. Every
`sendPromptImmediate()` call creates a fresh `clientMessageId`. A response-loss
or timeout after server acceptance can therefore leave the local row in
`error`, and a later drain can submit the same logical draft under a new
idempotency key.

The local row also drops semantic send intent such as
`implicitSkillCommandPolicy` when it is appended and later drained. That can
change confirmation behavior between enqueue and send.

### KISS implementation

1. Add a dedicated `clientMessageId` to the local queued-send envelope when the
   row is appended. Keep it separate from the UI row id.
2. Store only semantic send options that must survive the delay, currently
   `implicitSkillCommandPolicy`. Do not persist a stale trace id.
3. Let `sendPromptImmediate()` accept an optional captured `clientMessageId`;
   generate a fresh one only for sends that do not already have one.
4. Drain a row with its stored identity and semantic policy.
5. Remove `error` from automatic drain eligibility. Add an explicit Retry
   action that moves the row back to `queued` and reuses the same
   `clientMessageId`.
6. When the user edits the draft, treat that as a new logical request: rotate
   the `clientMessageId` through the injected identity factory and clear the
   previous error. This avoids changing a request underneath an already-used
   idempotency key.
7. Keep cancel/reorder local. Do not add server mutation APIs here.

This policy avoids hard-coded error-code allowlists. Unknown and terminal
errors wait for user intent; response-loss retries are safe because they reuse
the original identity.

### Required tests

- Response is lost after server acceptance; explicit Retry reuses the same
  `clientMessageId` and the server observes one logical request.
- Two drain triggers cannot send the same local row concurrently.
- An `error` row does not drain merely because a later status changes to idle.
- Explicit Retry reuses identity; edit-then-send rotates identity.
- `confirm`, `allow`, and `disable` implicit-skill policies survive queue delay.
- The stable Veslo id never becomes an OpenCode `messageID`.

### Acceptance

- One unchanged local queued row has one Veslo idempotency key for its lifetime.
- Edited content has a deliberate new identity.
- No automatic retry of an unknown terminal error occurs.
- `sq02_stable_local_send_identity_done` stays false until the response-loss
  regression test passes.

## SQ03 - Read-Only Accepted Server Queue Projection

Status: `done: false`

Severity: P2

Owner: server queue read route, typed app client, and app read projection

### Confirmed failure

Active-run Enter submits directly to the server queue path. The app clears an
accepted draft but does not create a durable visible row. The server can read
one known queue item, but it cannot list a conversation's queue for activation
or reconnect hydration, and the app client exposes neither queue read.

F2, F5, and the queue-drain portion of F16 are this one missing read model.

### KISS implementation

1. Add a paginated, workspace/conversation-scoped queue list method to the
   existing queue store and route. Use typed state filters and a cursor; do not
   return unbounded history.
2. Return a narrow summary:
   `queueItemId`, `reservedRunId`, `clientMessageId`, `state`, position/order
   fields, timestamps, and terminal queue error. Exclude `bodyJson`, request
   hashes, and authorization hashes.
3. Add typed `getQueueItemStatus` and `listConversationQueue` methods to the
   existing conversations client.
4. Keep server-owned rows in a separate read-only app model keyed by
   `queueItemId`. Do not merge them into editable `QueuedDraft` rows.
5. Create the read-only row immediately from an accepted `status: "queued"`
   response, then reconcile it from the server.
6. Refresh the read model on:
   - session activation;
   - Veslo server/runtime reconnect catch-up;
   - a relevant session idle/terminal transition;
   - bounded status polling while a visible row is `pending` or `starting`.
7. Preserve queue/lifecycle ownership:
   - `pending` and `starting` mean waiting/queue processing;
   - `failed` means the queue could not hand the run to OpenCode;
   - `submitted` means the queue handed off successfully and the row can
     transition to the existing lifecycle/transcript projection;
   - a later run failure is read from lifecycle status using
     `reservedRunId`, not by rewriting the queue row to `failed`.
8. Leave edit, cancel, move, and pause/resume for BSW08A.

### Required tests

- The list route rejects foreign workspace/conversation scope.
- Pagination is stable for equal timestamps.
- The route never serializes `bodyJson` or authorization hashes.
- Running Enter creates a read-only server-owned row from the typed result.
- Reload/session activation hydrates a pending or starting row.
- Reconnect refreshes only the source workspace and conversation.
- Queue drain failure becomes visible with the stored server error.
- `submitted` hands off to lifecycle/run status instead of being mislabeled as
  full lifecycle completion.

### Acceptance

- A user can distinguish an empty queue from accepted waiting work after
  reload.
- Accepted queue failure is visible without replaying the original submit.
- The first slice adds no server queue mutations.
- `sq03_server_queue_read_projection_done` stays false until both server and app
  read-path tests pass.

## SQ04 - Stop Semantics and Canonical Documentation

Status: `done: false`

Severity: P2/P3

Owner: feature contract and queue UI wording

### Corrected contract

The current KISS behavior should remain:

- Stop aborts the active lifecycle run.
- Stop pauses local drafts that have not crossed server admission.
- Work already accepted into `conversation_run_queue` remains server-owned and
  may start after the abort reaches terminal state.
- Full "pause accepted queue" behavior requires a new durable server contract
  and is out of this slice.

### Changes

1. Update `docs/features/session-runtime.md` so running Enter means server queue
   admission, not a guaranteed app-local row.
2. Name the two states explicitly in user-visible/help text:
   "local editable draft" and "accepted server queue item".
3. State that Stop affects the current run plus local pre-admission drafts; it
   does not cancel or pause accepted server work.
4. Document that local pre-admission drafts are view-lifetime/non-durable until
   accepted. Do not move their owner above `SessionView` without a product
   requirement.
5. Document `submitted` as queue-processing completion, not run lifecycle
   completion. Keep `completedAt` only as a compatibility field unless a
   separate API version deliberately renames it.
6. Keep the legacy pending-key prefixes unchanged in this slice. Remove them
   only with an explicit compatibility test/decision.

### Required tests

- App Stop still pauses the local draft queue before abort.
- Server abort still wakes accepted durable work.
- The accepted server row explains that it is not controlled by local queue
  edit/cancel/pause actions.
- Documentation contains no contradictory running-Enter description.

### Acceptance

- Code, UI wording, and canonical feature docs describe the same ownership.
- No pause/cancel API is implied where none exists.
- `sq04_contract_docs_done` stays false until canonical docs and focused tests
  are updated together.

## SQ05 - Atomic Queue Claim and Expected-State Guards

Status: `done: false`

Severity: P3 hardening

Owner: server queue store

F14 does not justify worker leases or a multi-process redesign. The narrow
hardening is a compare-and-set contract:

1. `markStarting(queueItemId)` returns a row only when its
   `pending -> starting` update changed exactly one row.
2. `markSubmitted` and `markFailed` update only the expected `starting` state.
3. `markPending` remains `starting -> pending` only.
4. Add a test with two store instances against one SQLite file; only one claim
   may succeed and only that caller may submit.
5. Record a diagnostic when an expected-state update loses the race. Do not
   overwrite the winner's terminal state.

Do not add a lease token until Veslo actually supports multiple live lifecycle
workers or requires recovery of a still-running worker. Startup recovery
already covers the current single-process crash model.

## Deferred Policy Decision - Retention and Data Classification

Status: `done: false`

F9 and F15 are a real policy gap, not evidence of a current queue correctness
failure.

- Queue `bodyJson` contains a copy of prompt/command content.
- `runtimeAuthorizationActorTokenHash` is a hash, not the raw actor token, but
  it is still internal correlation data.
- Submit-attempt results, queue terminal rows, transcripts, and backups have
  related retention semantics.

Do not add an isolated hard-coded queue TTL in the correctness patch. Decide
retention with the transcript/backup policy, expose one centrally configured
duration if deletion is required, prune only terminal rows, and preserve any
queue row referenced by a retained submit attempt. Tests must prove
`pending`/`starting` rows and replay-required pointers cannot be removed.

## Desktop E2E Gate

The implementation is not complete on unit/source tests alone. Add one focused
Tauri Pilot scenario after SQ01-SQ04:

1. start one active run;
2. queue a follow-up and capture its server queue identity;
3. verify the read-only row is visible;
4. stop the active run and observe the documented accepted-work behavior;
5. restart/reconnect the real desktop/server runtime;
6. reopen the conversation and hydrate the same queue identity;
7. prove exactly one eventual OpenCode submission;
8. inject a queue-drain failure and show the server error on the row.

Follow `docs/dev/testing-playbook.md` preflight. Rebuild the server binary before
the scenario because SQ01, SQ03, and SQ05 change server source.

## Verification Commands

Run the focused checks for each slice, then the combined gate:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm `
  src/app/tests/pages/session-conversation-flow.test.ts `
  src/app/tests/pages/session-message-queue.test.ts `
  src/app/tests/context/live-transcript-read-policy.test.ts

pnpm --filter veslo-server exec bun test `
  src/tests/conversation-submit-service.test.ts `
  src/tests/conversation-submit-attempt-store.test.ts `
  src/tests/conversation-run-queue-store.test.ts `
  src/tests/conversation-run-lifecycle-controller.test.ts `
  src/tests/server-conversations.test.ts

pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
git diff --check
```

Run the new queue-specific Tauri Pilot scenario through the repository's
current E2E runner; do not use a web/Vite runtime as a substitute.

## Completion Rules

- Keep every `*_done` flag false until its targeted tests pass.
- Keep top-level `done: false` until SQ01-SQ05, the desktop E2E, and the
  explicit retention decision are complete or are moved to a separately owned
  follow-up with that deferral recorded here.
- A green unit suite does not close the desktop gate.
- A post-create checkpoint without downstream replay identity does not close
  SQ01.
- A single-item status endpoint without activation/reconnect hydration does not
  close SQ03.
- Documentation wording alone does not close the accepted queue visibility
  gap.
