---
title: Session Queue Final Implementation Plan
date: 2026-07-10
status: complete
done: true
repository_snapshot: veslo-main main 7e0819a7
supersedes:
  - docs/dev/2026-07-10-session-queue-adjacent-files-deep-audit.md
  - docs/plans/2026-07-10-queue-message-read-only-audit.md
qf01_crash_safe_materialization_done: true
qf02_local_queue_envelope_done: true
qf03_explicit_retry_fifo_done: true
qf04_atomic_server_queue_claim_done: true
qf05_server_queue_read_api_done: true
qf06_app_queue_projection_done: true
qf07_canonical_contract_docs_done: true
qf08_desktop_e2e_gate_done: true
---

# Session Queue Final Implementation Plan

## Canonical Status

This is the single implementation plan for the session queue correctness and
read-only projection work. It supersedes the two source audits named in the
frontmatter. Those files remain evidence only; agents must not implement from
them independently or update their completion state.

The plan is based on `veslo-main` branch `main` at `7e0819a7`. Every phase starts
at `done: false`. The top-level `done: false` changes to `done: true` only after
QF01 through QF08 are all `done: true` and their completion-log entries contain
the required verification evidence.

## Goal

Close the confirmed duplicate-side-effect, retry, durability-visibility, and
queue-transition gaps without creating another queue owner or starting the
deferred server mutation API.

The finished behavior has two explicit models:

- the app-local queue owns editable, view-lifetime drafts that have not crossed
  Veslo server admission;
- `conversation_run_queue` is the only durable owner of accepted queued run
  requests;
- the app may render a read-only projection of server-owned rows, but that
  projection never becomes an execution owner.

## Agent Execution Protocol

Agents must implement this plan in QF order. Take the first phase whose
`done: false` remains and whose dependencies are complete.

1. Work only in `C:\Users\jajse\Desktop\projekty\veslo-main` and confirm the
   live branch, commit, and dirty worktree before editing.
2. Read the root `AGENTS.md` plus every scoped `AGENTS.md` governing files in
   the phase. Preserve unrelated user changes and untracked files.
3. Recheck the current code before applying the instructions. If earlier phases
   changed a named function or file, preserve the contract described here
   rather than blindly applying stale line-level assumptions.
4. Add or update the narrow behavior tests before the implementation. A source
   regex may guard architecture, but it is not sufficient proof of persistence,
   retry, reconnect, concurrency, or desktop behavior.
5. Make the smallest ownership-respecting implementation. Do not refactor
   adjacent modules merely to make the patch look cleaner.
6. Run the phase verification commands. If `packages/server/src` changed,
   rebuild the server binary before any runtime-dependent verification.
7. Change only the completed phase's `done: false` line and matching frontmatter
   flag to `true` after every acceptance criterion passes. Append one completion
   log entry with changed paths and exact command results.
8. If a required contract is unsupported or a test is blocked, leave the phase
   `done: false`, record the blocker in the completion log, and stop. Do not use
   timing guesses, metadata scans, UI-only mocks, or a weaker acceptance claim.
9. Never use raw Vite, `packages/web`, or a UI-only dev server as desktop proof.
   QF08 must run through the real Tauri binary and Tauri Pilot harness.

## Locked Architecture and Product Decisions

These decisions are final for this plan:

1. Do not add another durable queue or reuse the unpublished composer draft
   store as an execution queue.
2. `conversation_submit_attempt` owns idempotency, materialization checkpoints,
   and result pointers. It must not become a run lifecycle store.
3. One logical local queue row owns one Veslo `clientMessageId` until the user
   edits its body or deliberately starts a new request.
4. Veslo `clientMessageId`, OpenCode session identity, OpenCode prompt/message
   identity, `queueItemId`, and `reservedRunId` remain distinct identifiers.
5. The submit request hash remains based on the original client request. An
   internally restored materialized target must not change that hash.
6. Never retry an unknown side effect with a new idempotency key. Timeout expiry
   alone is not evidence that create or submit did not happen.
7. Local queue ordering is strict FIFO. An `error`, `editing`, or `sending` head
   row blocks later rows until the head is retried, edited/sent, completed, or
   cancelled. Later rows must not overtake it automatically.
8. Local `error` rows are never automatically retried. Retry is an explicit
   user action and reuses the unchanged row's `clientMessageId`.
9. Queue state `submitted` means that queue processing crossed the downstream
   OpenCode submit boundary. Later run completion or failure belongs to the
   lifecycle run identified by `reservedRunId`.
10. Every queue read is scoped by workspace plus conversation. A background
    refresh must use the captured source workspace, never the currently visible
    workspace by accident.
11. Queue read responses never expose `bodyJson`, directory paths, request
    hashes, runtime authorization hashes, raw tokens, or arbitrary persisted
    body fields.
12. The read-only projection adds no server cancel, retry, edit, move, pause, or
    resume API. Those mutations remain deferred under `BSW08A`.
13. Remote workspaces fail closed for this local durable queue surface.
14. Stop aborts the active run and pauses app-local pre-admission drafts.
    Already accepted server work remains server-owned and may continue after
    the aborted lifecycle reaches a terminal state.
15. Terminal retention and data classification are a separate policy follow-up.
    They do not block this correctness plan and no isolated queue TTL is added.

## Verified Starting Point

At snapshot `7e0819a7`:

- `QueuedDraft` has a UI id and draft but no stable `clientMessageId` or captured
  `implicitSkillCommandPolicy`;
- `sendPromptImmediate()` creates a fresh client message id on every call;
- queue drain forwards the draft and session key but not a captured client id or
  implicit-skill policy;
- local `error` rows are drain-eligible;
- active-run Enter can be accepted by the server queue without creating a
  durable visible app row;
- the server has a workspace/conversation-scoped single-item queue status route
  but no conversation list route;
- first-session creation calls the OpenCode create side effect before a durable
  replay identity is checkpointed;
- stored attempt targets are restored only inside the `resultJson` branch;
- `markStarting()` returns the row even when its compare-and-set update changed
  zero rows, while terminal transitions have no expected-state guard;
- `docs/features/session-runtime.md` still describes running Enter as app-local
  queueing and does not distinguish Stop behavior across the ownership boundary;
- no dedicated Tauri Pilot scenario proves stable identity, server projection,
  reconnect hydration, terminal queue failure, and local/server control
  separation together.

Current upstream OpenCode documentation defines session create with an optional
caller-supplied `id` and says reuse returns the existing session identity. Veslo
uses a pinned `@opencode-ai/sdk@1.17.13` ecosystem and its own mounted `/session`
adapter, so QF01 must verify the actual routed runtime before relying on the
upstream contract.

Reference:
<https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md>

## Required Implementation Order

| Phase | Purpose | Depends on |
| --- | --- | --- |
| QF01 | Crash-safe first-session materialization | none |
| QF02 | Stable local queued-send envelope | QF01 |
| QF03 | Explicit retry and strict FIFO | QF02 |
| QF04 | Atomic server queue transitions | QF03 |
| QF05 | Safe conversation-scoped server queue reads | QF04 |
| QF06 | Read-only app projection and hydration | QF05 |
| QF07 | Canonical ownership and Stop documentation | QF06 |
| QF08 | Real desktop regression gate | QF01-QF07 |

Do not merge phases merely because they touch the same file. The phase boundary
is the review, verification, and rollback boundary for later agents.

## QF01 - Crash-Safe First-Session Materialization

done: true

Priority: P1 duplicate-side-effect correctness

Primary owners:

- `packages/server/src/conversation-submit-service.ts`
- `packages/server/src/conversation-submit-attempt-store.ts`
- `packages/server/src/conversation-service.ts`
- the OpenCode `/session` adapter in `packages/server/src/server.ts`
- focused server service/store/integration tests

### Objective

Retrying the same first send after process loss must recover one OpenCode session
identity instead of creating another session.

### Implementation Contract

1. Add one central helper that deterministically derives a valid, versioned
   OpenCode session id from the stable `(workspaceId, clientMessageId)` attempt
   identity. The value must contain no prompt, title, directory, user token, or
   UI route material.
2. Add a routed integration test against the mounted OpenCode `/session`
   endpoint proving that:
   - a caller-supplied id creates a session when absent;
   - repeating create with the same id returns the same session identity;
   - the pinned/routed runtime accepts the exact request shape Veslo will send.
3. If that test fails, stop QF01. Upgrade or add a real upstream idempotency
   contract as a separately reviewed prerequisite. Do not substitute title
   search, session-list scans, age heuristics, timeout expiry, or blind retry.
4. Persist the derived `opencodeSessionId` on the submit attempt before calling
   the OpenCode create side effect. Reuse the existing attempt row and schema;
   no lease table or second registry is introduced.
5. Extend the server-owned conversation create path to accept an optional
   requested OpenCode session id. The app must not choose or send this id.
6. Send the stored requested id through the existing `/session` adapter.
7. Bind the returned session id idempotently and then checkpoint the attempt as
   `materialized` with `conversationId` and `opencodeSessionId` before downstream
   run submission.
8. Apply `conversationSubmitRequestWithAttemptTarget()` whenever the attempt has
   usable target pointers, including when `resultJson` is null.
9. On retry, reuse the stored OpenCode id, recreate/get the same upstream
   identity, restore or create the Veslo conversation binding idempotently, and
   continue the original submit.
10. Fail closed on workspace or directory mismatch. A stored identity from one
    workspace must never recover a session in another scope.
11. Keep the in-memory same-process single-flight map as an optimization only;
    correctness must survive a new service/process instance.

### Required Tests

- the attempt contains the requested OpenCode id before the create adapter is
  invoked;
- a caller-supplied id is accepted by the real mounted route and exact reuse
  returns the same session identity;
- simulated process loss after upstream creation but before the conversation
  checkpoint, followed by a new service instance, yields one upstream session
  identity and one eventual run admission;
- the recovery test permits repeated idempotent create/get calls but proves that
  only one upstream session object exists;
- a stored materialized target with null `resultJson` resumes without a second
  conversation creation;
- the original request hash still controls conflict detection;
- workspace or directory mismatch fails without adopting a foreign session;
- existing failed/blocked-after-materialization retry tests remain green.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-submit-attempt-store.test.ts src/tests/conversation-service.test.ts src/tests/conversation-submit-service.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
git diff --check
```

### Acceptance

- a process crash in every create/checkpoint boundary leaves enough durable
  identity to recover the same OpenCode session;
- retry never depends on timing, title text, list ordering, or the active UI
  workspace;
- exactly one logical first send reaches run admission;
- `qf01_crash_safe_materialization_done` remains false until the routed runtime
  contract and cross-instance crash test both pass.

## QF02 - Stable Local Queued-Send Envelope

done: true

Priority: P1 duplicate-admission correctness

Depends on: QF01

Primary owners:

- `packages/app/src/app/components/session/session-queue-model.ts`
- `packages/app/src/app/pages/session-conversation-flow.ts`
- focused queue model and conversation-flow tests

### Objective

One unchanged local queue row must keep one Veslo idempotency identity and all
semantic send intent across queue delay and transport retry.

### Implementation Contract

1. Add a required `clientMessageId` to the local queued-send envelope. Generate
   it with the existing injected `createClientMessageId()` dependency when the
   local row is created, not when it is drained.
2. Capture the semantic `implicitSkillCommandPolicy` value needed after delay.
   Preserve `confirm`, `allow`, and `disable`. Do not capture a stale trace id,
   active workspace lookup, queue item id, reserved run id, or OpenCode id.
3. Keep the UI row id separate from `clientMessageId`.
4. Add an optional captured-client-id override to `sendPromptImmediate()`.
   Normalize the override and generate a fresh id only when no usable override
   exists.
5. Queue drain must forward the row's stored `clientMessageId` and captured
   implicit-skill policy.
6. Normal, send-now, replacement, and active-run direct server admission paths
   continue to generate or forward exactly one appropriate id.
7. Editing the body creates a new logical request and rotates the
   `clientMessageId` before the edited content can be sent. Merely entering edit
   mode does not rotate it; cancelling edit leaves the original envelope intact.
8. Never forward the Veslo client id as an OpenCode prompt/message id.

### Required Tests

- two independently appended local rows receive distinct client ids;
- an unchanged row uses the same id across queue delay, response loss, and
  explicit retry preparation;
- edit-and-save rotates the id, while edit cancellation preserves it;
- queue drain preserves `confirm`, `allow`, and `disable` policies;
- queue drain forwards no stale trace id or active-workspace-derived target;
- normal, send-now, replacement, pending-session, and active-run paths each
  create or forward exactly one intended client id;
- no code path maps the Veslo client id to an OpenCode `messageID`.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/session-queue-model.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-send-workflow.test.ts
git diff --check
```

### Acceptance

- one unchanged local queue row has one Veslo idempotency key for its lifetime;
- changed content cannot silently reuse the old request identity;
- implicit skill confirmation behavior is identical before and after queue
  delay;
- `qf02_local_queue_envelope_done` remains false until the response-loss and
  all-policy regression tests pass.

## QF03 - Explicit Retry and Strict Local FIFO

done: true

Priority: P2 user-controlled retry correctness

Depends on: QF02

Primary owners:

- `packages/app/src/app/components/session/session-queue-model.ts`
- `packages/app/src/app/components/session/queued-message-list.tsx`
- `packages/app/src/app/components/session/queued-message-list-model.ts`
- `packages/app/src/app/pages/session-conversation-flow.ts`
- related app tests and localized copy

### Objective

Unknown local failures wait for explicit user intent, and ordered local drafts
never overtake a blocked head row.

### Implementation Contract

1. Remove `error` from automatic drain eligibility.
2. Replace scan-for-any-eligible behavior with strict head semantics. The first
   row is the only candidate; if its state is `error`, `editing`, or `sending`,
   later rows do not drain.
3. Add an explicit Retry control for an `error` row. Retry changes the unchanged
   row to `queued`, preserves its `clientMessageId` and semantic options, and
   triggers one drain only when the captured session is idle and unpaused.
4. Edit/Send uses the rotated identity from QF02. Edit cancellation restores the
   unchanged failed row and its original identity.
5. Cancel removes the head and schedules at most one safe drain for the next row.
6. Reorder remains local and cannot move `sending` or actively edited rows.
   Reordering must not create a second send or bypass a blocked head implicitly.
7. Do not classify retryability from localized error text. Typed bounded
   automatic retry is outside this plan.
8. Preserve the existing queue-drain in-flight guard and prove that overlapping
   triggers cannot submit one row concurrently.

### Required Tests

- idle, status, reconnect, session-selection, and later-enqueue signals do not
  retry an `error` row;
- a failed head blocks a later queued row;
- explicit Retry submits once with the unchanged client id and policy;
- Edit/Send rotates identity and submits the edited body once;
- cancelling edit preserves the failed envelope;
- cancelling the failed head releases and drains the next row once when safe;
- paused or non-idle sessions do not drain after Retry or Cancel;
- two overlapping drain triggers cannot submit the same row concurrently;
- Retry is rendered only for local failed drafts, never server projections.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/queued-message-list.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts
git diff --check
```

### Acceptance

- no failed local row is retried without an explicit action;
- later rows never overtake an unresolved head;
- Retry, Edit/Send, and Cancel each cause at most one intended drain;
- `qf03_explicit_retry_fifo_done` remains false until the head-blocking and
  overlapping-trigger tests pass.

## QF04 - Atomic Server Queue Claim and State Guards

done: true

Priority: P3 durable-store hardening

Depends on: QF03

Primary owners:

- `packages/server/src/conversation-run-queue-store.ts`
- `packages/server/src/conversation-run-lifecycle-controller.ts`
- focused queue store and lifecycle controller tests

### Objective

SQLite must be the durable transition boundary even if two store/controller
instances race the same queue item.

### Implementation Contract

1. `markStarting(queueItemId)` returns the claimed row only when the
   `pending -> starting` update changed exactly one row. It returns null on a
   lost race.
2. `markPending(queueItemId, activeRunId)` returns a row only when the expected
   `starting -> pending` transition changed exactly one row.
3. `markSubmitted(queueItemId)` and `markFailed(queueItemId, error)` update only
   an expected `starting` row and return null for stale transitions.
4. The lifecycle controller treats a null claim as a lost race and performs no
   downstream submit for that item.
5. Record a bounded diagnostic for a lost claim or stale terminal transition.
   Do not overwrite the winner's state.
6. Preserve startup `starting -> pending` recovery.
7. Do not add a lease, worker token, heartbeat, or multi-process coordinator.
   Those require a separate demonstrated runtime need.

### Required Tests

- two queue store instances against one SQLite file race the same pending row
  and exactly one receives a successful claim;
- the losing lifecycle controller performs no downstream submission;
- stale `markPending`, `markSubmitted`, and `markFailed` calls return null and
  do not overwrite the stored state;
- the winning controller can complete the expected transition;
- startup recovery still returns `starting` rows to `pending`;
- the existing single-controller queue drain tests remain green.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/conversation-run-lifecycle-controller.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
git diff --check
```

### Acceptance

- one durable queue row can be claimed by at most one competing transition;
- stale callbacks cannot rewrite terminal state;
- the fix remains a compare-and-set hardening rather than a worker-lease system;
- `qf04_atomic_server_queue_claim_done` remains false until the real shared-file
  two-store race test passes.

## QF05 - Safe Conversation-Scoped Server Queue Read API

done: true

Priority: P2 durable visibility contract

Depends on: QF04

Primary owners:

- `packages/server/src/conversation-run-queue-store.ts`
- `packages/server/src/routes/conversations.ts`
- focused queue store and route tests

### Objective

Expose enough durable queue state to reconstruct accepted waiting work without
leaking prompt bodies, directories, authorization data, or mutation authority.

### Implementation Contract

1. Add a workspace-and-conversation-scoped list method to the existing queue
   store. It accepts validated state filters, an opaque cursor, and a bounded
   limit.
2. Order deterministically by `created_at ASC, queue_item_id ASC`. The cursor
   must include both ordering fields so equal timestamps cannot duplicate or
   skip rows.
3. Add `GET /workspace/:id/conversations/:conversationId/queue`. Support only
   validated repeated `status` filters for `pending`, `starting`, and `failed`
   in this read-only slice. Reject unknown states, malformed cursors, and
   unbounded limits.
4. Return a dedicated DTO with only:
   - `workspaceId`;
   - `conversationId`;
   - `opencodeSessionId`;
   - `queueItemId`;
   - `reservedRunId`;
   - `clientMessageId`;
   - typed `kind`;
   - typed `status`;
   - queue position/order metadata;
   - safe timestamps;
   - sanitized terminal queue error;
   - next cursor when more rows exist.
5. Never spread a persisted queue item into the response. Explicitly prove the
   absence of `bodyJson`, directory, request hash, runtime authorization hash,
   raw token, and unrelated internal fields.
6. Preserve the existing single-item status route and align its safe DTO naming
   with the list response where compatibility permits.
7. `submitted` remains available through the known-item handoff/status contract
   but is not hydrated as waiting work. Lifecycle/transcript owns the
   `reservedRunId` after handoff.
8. Apply existing client authorization and workspace resolution. A foreign
   workspace/conversation pair returns no data.
9. Add no mutation route and no terminal-row acknowledgement behavior.

### Required Tests

- stable ordering and cursor pagination with equal timestamps;
- state and limit validation;
- workspace and conversation isolation;
- missing/foreign rows do not leak existence across scope;
- response serialization proves every forbidden field is absent;
- pending, starting, and failed rows serialize to the typed safe DTO;
- submitted work is not returned as waiting hydration state;
- the existing single-item status route remains compatible;
- remote/non-local workspace access fails closed.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/server-conversations.test.ts src/tests/server.conversation-session-routes.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
git diff --check
```

### Acceptance

- the server can distinguish an empty scoped queue from accepted waiting work;
- pagination is deterministic and bounded;
- safe serialization is proven by behavior tests, not code review alone;
- no server queue mutation surface is introduced;
- `qf05_server_queue_read_api_done` remains false until isolation, pagination,
  and redaction tests all pass.

## QF06 - Read-Only App Queue Projection and Hydration

done: true

Priority: P2 user-visible durability

Depends on: QF05

Primary owners:

- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`
- `packages/app/src/app/lib/veslo-server/types.ts`
- `packages/app/src/app/context/conversation-service.ts`
- a small dedicated server-queue projection model/controller
- a separate read-only server queue row/list component
- `packages/app/src/app/pages/session.tsx` composition only
- focused client, projection, flow, and render tests

### Objective

An accepted server-queued request is visible immediately and can be reconstructed
after activation or reconnect without becoming an editable local draft.

### Implementation Contract

1. Add typed app-client methods for:
   - listing the selected conversation's pending/starting/failed queue rows;
   - reading one known queue item by id.
2. Add a separate `ServerQueuedRunProjection` model keyed by `queueItemId` and
   scoped by the captured workspace plus UI conversation identity.
3. Do not add server fields to `QueuedDraft`, merge the two arrays by index or
   display text, or use the same controls for both owners.
4. When submit returns accepted `status: "queued"`, immediately create one
   server projection with the returned `queueItemId`, `reservedRunId`,
   `clientMessageId`, and scoped target. Clearing the composer must never leave
   accepted work invisible.
5. Hydrate pending/starting/failed rows on:
   - selected conversation activation;
   - completed Veslo server/runtime reconnect catch-up;
   - return to a background workspace/session;
   - explicit scoped refresh after a relevant lifecycle transition.
6. Every async result must verify that its captured workspace/conversation scope
   is still the intended target before updating projection state.
7. Poll only known visible `pending`/`starting` rows using one named bounded
   backoff policy. Stop on submitted/failed, scope change, reconnect teardown,
   or controller disposal.
8. A `failed` queue row remains visible with sanitized server error text.
9. A `submitted` row leaves the queue projection once the existing lifecycle or
   transcript projection owns the matching `reservedRunId`.
10. Hydrated rows use a generic localized label derived from typed `kind`.
    Prompt text is intentionally unavailable after reload in this slice.
11. Render server rows read-only with no Retry, Edit, Cancel, Move, Pause, or
    Resume controls. Keep local draft controls unchanged.
12. Do not create a global queue store or broadly extract `SessionView`.

### Required Tests

- app-client path construction, filters, cursor parsing, and typed response;
- accepted queued submit creates exactly one projection with matching ids;
- a duplicate submit response or hydration page does not duplicate the row;
- activation hydrates pending/starting/failed rows in the selected scope;
- reconnect refresh uses the original workspace client, not the active one;
- return from a background workspace/session hydrates the correct queue;
- stale async responses cannot populate a newly selected conversation;
- bounded polling stops on terminal state, scope change, and disposal;
- failed status and sanitized message remain visible;
- submitted status hands off by `reservedRunId` and removes the queue row;
- local drafts and server projections never merge by index, label, or client id;
- server rows render no local mutation controls.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/context/live-transcript-read-policy.test.ts src/app/tests/components/session/queued-message-list.test.ts
git diff --check
```

Add focused tests for every new projection/controller/component file to this
command before changing the phase to `done: true`.

### Acceptance

- accepted waiting work is visible immediately;
- reopening or reconnecting reconstructs durable waiting/failure state in the
  correct workspace and conversation;
- server rows remain visibly and behaviorally read-only;
- lifecycle handoff does not turn queue `submitted` into run success;
- `qf06_app_queue_projection_done` remains false until activation, reconnect,
  stale-scope, redaction, and rendering tests pass.

## QF07 - Canonical Ownership, Stop, and Lifecycle Contract

done: true

Priority: P3 contract alignment

Depends on: QF06

Primary owners:

- `docs/features/session-runtime.md`
- localized queue/help copy
- focused source/render tests protecting the documented ownership split

### Objective

Code, UI copy, and canonical feature documentation must describe the same queue
owners and Stop behavior.

### Implementation Contract

1. Update the canonical feature documentation so running Enter means direct
   server queue admission, not guaranteed app-local queueing.
2. Define the two user-visible states:
   - local editable draft: pre-admission, view-lifetime, not restart durable;
   - accepted server queue item: durable, read-only projection, server-owned.
3. State that local drafts disappear when their owning session view is destroyed
   unless they have crossed server admission. Do not lift or persist their owner
   in this plan.
4. State the Stop contract exactly:
   - abort the active lifecycle run;
   - pause local pre-admission drafts;
   - accepted server queue work may continue after abort reaches terminal state.
5. State that queue `submitted` is queue-processing completion and later run
   failure comes from lifecycle/transcript state by `reservedRunId`.
6. Keep legacy pending-key compatibility prefixes. Removal needs separate
   upgrade-state evidence.
7. Do not imply server Retry, Edit, Cancel, Move, Pause, or Resume controls.
8. Keep retention/data-classification explicitly deferred and non-blocking for
   this plan.

### Required Tests

- the running-Enter architecture guard matches direct server admission;
- Stop still pauses local drafts before abort;
- server abort completion still wakes accepted durable work;
- server projection copy does not imply local mutation controls;
- canonical feature docs contain no contradictory local-first running-Enter or
  accepted-work pause wording.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/components/session/queued-message-list.test.ts
git diff --check
```

### Acceptance

- implementation, UI, and `docs/features/session-runtime.md` agree on ownership,
  durability, Retry, Stop, and lifecycle handoff;
- no deferred mutation API is presented as implemented;
- `qf07_canonical_contract_docs_done` remains false until documentation and the
  matching behavior tests are updated together.

## QF08 - Real Desktop Queue Regression Gate

done: true

Priority: P1 final completion gate

Depends on: QF01 through QF07

Primary owners:

- `packages/e2e/pilot-scenarios/session-queue-durability.toml`
- deterministic local E2E fixture/controller support as narrowly required
- `packages/e2e` Tauri Pilot runner registration and tests
- `docs/dev/testing-playbook.md` only if the runnable workflow changes

### Objective

Prove the full contract in the authoritative desktop runtime without relying on
a live model response or browser-only UI.

### Scenario Contract

Add one deterministic isolated-profile Tauri Pilot scenario that:

1. starts the real desktop app with rebuilt sidecars and a local deterministic
   runtime fixture;
2. creates or opens one scoped conversation and holds one lifecycle run active;
3. submits a follow-up through running Enter;
4. verifies one accepted server-owned read-only row appears with no local Edit,
   Retry, Cancel, or Move controls;
5. verifies Stop pauses local pre-admission drafts while the already accepted
   server row remains server-owned;
6. restarts or reconnects the server/runtime using the supported harness path;
7. reopens the same workspace and conversation and hydrates the same queue item
   identity without duplication;
8. releases the active lifecycle and proves exactly one logical downstream
   submission for the stable request;
9. uses a deterministic fixture transition to force one queue-drain failure and
   verifies the sanitized failure is visible after refresh/reconnect;
10. proves a local failed draft requires explicit Retry and blocks a later local
    row, while the server failed projection has no Retry control;
11. tears down only the app/runtime processes launched by the harness.

Do not use a live provider response, arbitrary sleeps as the primary oracle, an
existing user profile, WebdriverIO, raw Vite, or an already-running Pilot socket.

### Required Preflight and Verification

Follow `docs/dev/testing-playbook.md` Desktop Test Runtime Preflight first.

```powershell
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD='1'
pnpm --filter @neatech/veslo run prepare:sidecar

Push-Location packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
Pop-Location

pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario session-queue-durability
pnpm --filter @neatech/veslo-e2e test:pilot -- --suite current-gate
git diff --check
```

### Acceptance

- the focused queue scenario passes in the real Tauri runtime and isolated
  profile;
- the existing current-gate suite remains green;
- diagnostics contain enough scoped ids to distinguish local draft,
  `clientMessageId`, `queueItemId`, `reservedRunId`, conversation, and workspace
  without logging prompt bodies or authorization data;
- no manual-only step is needed to prove queue correctness;
- `qf08_desktop_e2e_gate_done` remains false until both focused and current-gate
  Pilot runs pass against rebuilt sidecars.

## Combined Source Verification

Before QF08, run the complete focused source bundle once against the integrated
implementation:

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-submit-attempt-store.test.ts src/tests/conversation-service.test.ts src/tests/conversation-submit-service.test.ts src/tests/conversation-run-queue-store.test.ts src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts src/tests/server.conversation-session-routes.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin

pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/queued-message-list.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/context/live-transcript-read-policy.test.ts src/app/tests/context/conversation-service.test.ts

git diff --check
```

Agents must add new focused test files introduced by QF01-QF07 to the combined
command before final completion.

## Explicit Non-Goals

- no queue-store replacement;
- no second durable queue;
- no broad `SessionView` or app-state extraction;
- no persistence of app-local pre-admission drafts;
- no server edit, cancel, move, retry, pause, or resume API;
- no automatic retry classification based on error strings;
- no raw prompt body or directory in queue reads;
- no lifecycle-success state machine inside queue rows;
- no lease/heartbeat worker system;
- no legacy pending-key removal;
- no isolated queue retention TTL;
- no claim that `BSW08A` is complete.

## Completion Checklist

- [x] QF01 proves true downstream replay identity across process loss.
- [x] QF02 preserves one local identity and all semantic send policy.
- [x] QF03 requires explicit retry and enforces strict FIFO.
- [x] QF04 makes server queue transitions atomic and state-guarded.
- [x] QF05 exposes a scoped, paginated, redacted read API only.
- [x] QF06 hydrates a separate read-only server projection safely.
- [x] QF07 aligns feature docs, UI copy, Stop, and lifecycle semantics.
- [x] QF08 passes focused and current-gate Tauri Pilot runs.
- [x] Every frontmatter phase flag is `true`.
- [x] Every phase has a completion-log entry with exact verification results.
- [x] Top-level `done` is `true` only after all items above pass.

## Completion Log

Append entries; do not rewrite prior evidence.

```text
2026-07-10 - QFxx - changed: <paths> - verification: <exact commands and pass/fail counts> - notes: <scope or blocker> - done: false
```

2026-07-10 - QF01 - changed: packages/server/src/conversation-submit-attempt-store.ts, packages/server/src/conversation-submit-service.ts, packages/server/src/conversation-service.ts, packages/server/src/server.ts, focused server tests - verification: `pnpm --filter veslo-server exec bun test src/tests/conversation-submit-attempt-store.test.ts src/tests/conversation-service.test.ts src/tests/conversation-submit-service.test.ts src/tests/server-conversations.test.ts` (90 pass, 0 fail); `pnpm --filter veslo-server typecheck` (pass); `pnpm --filter veslo-server build:bin` (pass); `git diff --check` (pass) - notes: mounted `/session` accepts and reuses the versioned requested id; recovery reuses the persisted pre-create id across a new service instance - done: true
2026-07-10 - QF02 - changed: packages/app/src/app/components/session/session-queue-model.ts, packages/app/src/app/pages/session-conversation-flow.ts, packages/app/src/app/pages/session.tsx, focused app tests - verification: `pnpm --filter @neatech/veslo-ui typecheck` (pass); `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/session-queue-model.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-send-workflow.test.ts` (136 pass, 0 fail); `git diff --check` (pass) - notes: new local rows own one generated client id and captured implicit-skill policy; drain forwards that envelope, while edited content rotates its id - done: true
2026-07-10 - QF03 - changed: packages/app/src/app/components/session/session-queue-model.ts, packages/app/src/app/components/session/queued-message-list-model.ts, packages/app/src/app/components/session/queued-message-list.tsx, packages/app/src/app/context/session-flow-facade.ts, packages/app/src/app/pages/session-conversation-flow.ts, packages/app/src/app/pages/session.tsx, focused app tests - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/session-queue-model.test.ts src/app/tests/components/session/queued-message-list.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts` (99 pass, 0 fail); `pnpm --filter @neatech/veslo-ui typecheck` (pass); `git diff --check` (pass) - notes: failed local heads block all automatic drains; Retry preserves its envelope and uses the existing in-flight guard; cancelled heads safely release one next row; discarded failed edits restore their error state and envelope - done: true
2026-07-10 - QF04 - changed: packages/server/src/conversation-run-queue-store.ts, packages/server/src/conversation-run-lifecycle-controller.ts, focused server tests - verification: `pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/conversation-run-lifecycle-controller.test.ts` (46 pass, 0 fail); `pnpm --filter veslo-server typecheck` (pass); `pnpm --filter veslo-server build:bin` (pass); `git diff --check` (pass) - notes: all transitions are compare-and-set by expected state; shared-file competing claims admit exactly one winner and a losing controller does not submit - done: true
  2026-07-10 - QF05 - changed: packages/server/src/conversation-run-queue-store.ts, packages/server/src/routes/conversations.ts, focused server tests - verification: `pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/server-conversations.test.ts src/tests/server.conversation-session-routes.test.ts` (54 pass, 0 fail); `pnpm --filter veslo-server typecheck` (pass); `pnpm --filter veslo-server build:bin` (pass); `git diff --check` (pass) - notes: read-only scoped pagination returns only typed safe rows and redacts queue errors; body, directory, origin, authorization material, and submitted rows are excluded - done: true
  2026-07-10 - QF06 - changed: packages/app/src/app/lib/veslo-server/types.ts, packages/app/src/app/lib/veslo-server-domains/conversations.ts, packages/app/src/app/lib/veslo-server/client.ts, packages/app/src/app/components/session/server-queue-projection-model.ts, packages/app/src/app/components/session/server-queue-projection-controller.ts, packages/app/src/app/components/session/server-queued-run-list.tsx, packages/app/src/app/pages/session.tsx, localized labels, focused app tests - verification: `pnpm --filter @neatech/veslo-ui typecheck` (pass); `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts src/app/tests/context/live-transcript-read-policy.test.ts src/app/tests/components/session/queued-message-list.test.ts src/app/tests/components/session/server-queue-projection-model.test.ts src/app/tests/components/session/server-queue-projection-controller.test.ts src/app/tests/components/session/server-queued-run-list.test.ts src/app/tests/lib/veslo-server-conversations-queue.test.ts` (132 pass, 0 fail); `git diff --check` (pass) - notes: accepted server rows project immediately by queue item id; activation, reconnect, background return, and lifecycle transitions hydrate the captured scope; stale results cannot alter a newer scope; bounded polling stops for terminal, scope-change, and disposal cases; server rows remain read-only - done: true
  2026-07-10 - QF07 - changed: docs/features/session-runtime.md, packages/app/src/app/components/session/server-queued-run-list.tsx, localized server-queue labels, focused source/render tests - verification: `pnpm --filter @neatech/veslo-ui typecheck` (pass); `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/components/session/queued-message-list.test.ts src/app/tests/components/session/server-queued-run-list.test.ts` (87 pass, 0 fail); `git diff --check` (pass) - notes: canonical documentation and UI copy now distinguish local editable pre-admission drafts from read-only durable server rows; it documents direct running Enter admission, Stop, lifecycle handoff, and legacy-key compatibility - done: true
  2026-07-10 - QF08 - changed: packages/e2e/helpers/app-launcher.ts, packages/e2e/helpers/session-queue-runtime-fixture.ts, packages/e2e/helpers/pilot-runner.ts, packages/e2e/pilot-scenarios/session-queue-durability.toml, packages/e2e/pilot-scenarios/navigation.toml, packages/e2e/helpers/desktop-auth-seed.ts, packages/app/src/app/components/session/composer.tsx, focused tests - verification: `pnpm --filter veslo-server build:bin` (pass); `pnpm --filter @neatech/veslo run prepare:sidecar` with `VESLO_SIDECAR_FORCE_BUILD=1` (pass); `pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e` (pass); focused `session-queue-durability` Pilot run with the real user auth snapshot and managed-AI fixture disabled (4 passed, 0 failed); `pnpm --filter @neatech/veslo-e2e test` with the same isolated real-auth setup (current-gate pass); focused helper tests (68 pass, 0 fail, 1 Windows skip); app and E2E typechecks (pass); `git diff --check` (pass) - notes: Tauri Pilot drives the rebuilt desktop binary, holds a deterministic lifecycle fixture, sends the follow-up with Enter into the materialized conversation, restarts the fixture server, verifies read-only hydration and drain failure, and uses real auth only in the isolated copied profile; no live model response is used - done: true

Change the entry's final value to `done: true` only when the corresponding phase
flag is also changed to true.
