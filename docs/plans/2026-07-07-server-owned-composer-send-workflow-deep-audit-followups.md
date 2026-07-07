---
title: Server-Owned Composer Send Workflow Follow-up Implementation Plan
date: 2026-07-07
status: planned
done: false
source_audit: chat:2026-07-07-server-owned-composer-send-workflow-deep-audit
base_plan: docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md
e2e_status: skipped
bsw_aud01_concurrent_submit_idempotency_done: true
bsw_aud02_replacement_failure_ui_surface_done: false
bsw_aud03_docs_status_alignment_done: false
bsw_aud04_typed_app_boundary_done: true
bsw_aud05_running_enter_server_queue_done: false
bsw_aud06_queued_live_transcript_semantics_done: false
bsw_aud07_queued_failure_surface_done: false
bsw_aud08_legacy_dependency_cleanup_done: false
---

# Server-Owned Composer Send Workflow Follow-up Implementation Plan

## Goal

Close the remaining non-E2E gaps found after the server-owned composer send
workflow rollout. The core migration is implemented, but this follow-up plan is
not complete. Each item below starts as `done: false`; implementation agents
must land the code/tests/docs for one item and then flip only that item's flag
to `true`.

This plan is intentionally narrower than the original workflow migration. It
does not reopen the full architecture, and it does not require tauri-pilot or
installed-runtime E2E. Acceptance is based on source review and focused
app/server tests.

## Agent Protocol

Use this document as an implementation checklist, not an audit note.

Rules for every agent:

1. Pick one `BSW-AUDxx` item unless explicitly asked to take a larger slice.
2. Keep the patch scoped to that item and its direct tests/docs.
3. Add or update a regression test that would fail on the current behavior.
4. Run that item's verification commands and `git diff --check`.
5. Update this file by setting only the completed item's front matter flag to
   `true`.
6. Add a short implementation note under the completed item with:
   - date,
   - changed files,
   - verification commands and result,
   - any intentionally deferred follow-up.
7. Do not set top-level `done: true` until every `bsw_aud*_done` flag is true.

Done flag mapping:

- `bsw_aud01_concurrent_submit_idempotency_done`: BSW-AUD01
- `bsw_aud02_replacement_failure_ui_surface_done`: BSW-AUD02
- `bsw_aud03_docs_status_alignment_done`: BSW-AUD03
- `bsw_aud04_typed_app_boundary_done`: BSW-AUD04
- `bsw_aud05_running_enter_server_queue_done`: BSW-AUD05
- `bsw_aud06_queued_live_transcript_semantics_done`: BSW-AUD06
- `bsw_aud07_queued_failure_surface_done`: BSW-AUD07
- `bsw_aud08_legacy_dependency_cleanup_done`: BSW-AUD08

Recommended implementation order:

1. BSW-AUD01: prevent duplicate side effects.
2. BSW-AUD04: make app results typed end-to-end.
3. BSW-AUD02 and BSW-AUD06: use typed results for replacement errors and
   queued event semantics.
4. BSW-AUD05 and BSW-AUD07: close the server queue contract slice.
5. BSW-AUD08: remove or gate legacy production dependencies.
6. BSW-AUD03: align docs after behavior is stable.

Dependency notes:

- BSW-AUD04 is the prerequisite for the cleanest BSW-AUD02, BSW-AUD05,
  BSW-AUD06, and BSW-AUD07 implementations.
- BSW-AUD01 is independent and should not wait for app refactors.
- BSW-AUD07 is allowed to split into a server status slice and an app surface
  slice if one patch would otherwise cross too many ownership boundaries. If it
  is split, keep the top-level `bsw_aud07_queued_failure_surface_done` flag
  `false` until both slices are implemented and documented under BSW-AUD07.
- BSW-AUD03 should stay last so docs describe the final implemented state.

## Scope Locks

These locks are intentionally strict. If an agent needs to exceed them, it must
update this plan first and leave the affected `done` flag `false`.

- Do not convert this follow-up into a new server-owned composer architecture
  plan. The base migration is already implemented; this file closes concrete
  gaps only.
- Do not implement tauri-pilot, installed-runtime, or browser E2E in this
  plan. E2E remains skipped unless the user explicitly changes that scope.
- Do not introduce frontend retry or debounce workarounds for BSW-AUD01. The
  duplicate side-effect bug belongs in the server submit service contract.
- Do not change the submit-attempt SQLite schema for BSW-AUD01 unless the
  focused concurrent test proves an in-process single-flight guard cannot
  satisfy the contract.
- Do not start the broad BSW08A durable queue UI migration while implementing
  BSW-AUD05 or BSW-AUD07. Those tasks cover only server queue admission for
  running Enter and visible terminal failure surfacing for accepted queued
  submits.
- Do not remove compatibility/test helpers just because their names contain
  `legacy` or `fallback`. BSW-AUD08 is limited to high-signal production
  dependency injection on the normal composer input path.
- Do not move workflow logic into the Composer component while implementing
  BSW-AUD04. Composer should remain a typed-result consumer.
- Do not mark docs-only alignment in BSW-AUD03 before the code behavior it
  describes is implemented and verified.

## Current Baseline

- `docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md`
  is marked `status: implemented` and `done: true`.
- E2E validation remains skipped by decision for this line of work.
- Focused app tests passed during audit: 130 passed, 0 failed.
- Focused server tests passed during audit: 90 passed, 0 failed.
- Second focused audit pass:
  - app queue/send/replacement/live-transcript tests: 101 passed, 0 failed.
  - server submit/lifecycle/queue tests: 84 passed, 0 failed.
  - `packages/app/scripts/legacy-symbol-audit.mjs --limit=40` scanned 726
    files, found 583 symbols, and reported 4 dependency-object matches.
- `git diff --check` passed.
- `git status --short --untracked-files=all` was clean at the time of the
  audit, except for unrelated work that may appear in later local checkouts.

## Implementation Steps

### BSW-AUD01: Concurrent submit idempotency guard

Status: `done: true`

Severity: P1/P2

Owner: server submit service

Depends on: none

Problem:

The server submit-attempt store protects completed retries, but it does not
protect an identical retry that arrives while the first request is still
running. A second request with the same `(workspaceId, clientMessageId)` and
the same request hash can continue into `submitResolvedRun` before the first
request writes `resultJson`.

Evidence:

- `packages/server/src/conversation-submit-service.ts` claims the attempt,
  checks for a completed `resultJson`, and otherwise continues processing.
- `packages/server/src/conversation-submit-attempt-store.ts` treats an existing
  same-hash attempt as non-conflicting even when its status is still `started`
  and `result_json` is null.
- Existing tests cover sequential retry after completion, not concurrent
  duplicate delivery.
- An inline audit reproduction with two parallel identical `service.submit`
  calls produced two upstream submit calls:

```json
{"submitRunCalls":2,"statuses":["submitted","submitted"],"runIds":["run-1","run-2"]}
```

Why this matters:

The composer send contract depends on `clientMessageId` idempotency. If a
browser retry, double delivery, or caller race reaches the server before the
first attempt completes, the same user prompt can create multiple runs.

Acceptance:

- Concurrent identical submit requests for the same `(workspaceId,
  clientMessageId, requestHash)` must not call the upstream runtime more than
  once.
- The second caller must either:
  - wait for and return the same completed `SessionSubmitResult`, or
  - receive a typed in-progress response that cannot be mistaken for a second
    accepted submit.
- Different request hash with the same `(workspaceId, clientMessageId)` must
  continue to return the existing idempotency conflict.
- Behavior must be covered by a focused server test that starts two identical
  submit promises before releasing the mocked upstream `submitResolvedRun`.

Implementation checklist:

1. Add a failing concurrent test in
   `packages/server/src/tests/conversation-submit-service.test.ts`.
2. Key the test by one workspace, one `clientMessageId`, and one request hash.
3. Hold the mocked `submitResolvedRun` promise open until both submit calls are
   in flight.
4. Prove the current behavior calls `submitResolvedRun` twice.
5. Add an in-flight guard around active submit attempts in
   `conversation-submit-service`, keyed by the persisted attempt identity.
6. Make the second identical caller wait for and return the first caller's
   result, or return a typed in-progress result that cannot submit upstream.
7. Keep different-hash conflict behavior unchanged.
8. Do not add a frontend retry workaround.
9. Flip `bsw_aud01_concurrent_submit_idempotency_done` to `true` only after the
   new test fails before the fix and passes after it.

Suggested verification:

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-submit-service.test.ts src/tests/conversation-submit-attempt-store.test.ts
```

The new test should fail before the fix by observing two upstream calls.

Implementation note:

- 2026-07-07:
  - Changed `packages/server/src/conversation-submit-service.ts` and
    `packages/server/src/tests/conversation-submit-service.test.ts`.
  - Added a server-side in-flight single-flight guard keyed by
    `(workspaceId, clientMessageId, requestHash)`. Completed retries and
    different-hash conflicts remain owned by the persisted submit-attempt
    store.
  - Added a regression test that starts two identical submit promises before
    releasing the mocked upstream submit. Before the fix, the test failed with
    the second caller receiving `run-existing-2`.
  - Verification:
    `pnpm --filter veslo-server exec bun test src/tests/conversation-submit-service.test.ts src/tests/conversation-submit-attempt-store.test.ts`
    passed with 16 tests and 90 assertions. `git diff --check` passed with
    CRLF warnings only.
  - Additional check: `pnpm --filter veslo-server typecheck` is not part of
    this item's acceptance and currently fails on unrelated existing test/type
    issues outside the BSW-AUD01 slice.
  - Deferred: no frontend debounce/retry workaround, no submit-attempt schema
    change, and no queue UI migration.

### BSW-AUD02: Replacement failure UI surface

Status: `done: false`

Severity: P2

Owner: app mutation/conversation flow

Depends on: BSW-AUD04 preferred; may be implemented first with a small typed
error bridge if needed.

Problem:

The server-owned replacement path returns typed failure states, but the app
replacement branch collapses blocked/failed/null submit results to `false`.
The conversation flow then often shows a generic error instead of the server's
specific replacement state.

Evidence:

- `packages/server/src/routes/conversations.ts` returns typed replacement
  failures such as:
  - `replacement_state_unavailable`
  - `replacement_abort_failed`
  - `replacement_revert_failed`
  - `replacement_submit_failed_restore_succeeded`
  - `replacement_submit_failed_restore_failed`
- `packages/app/src/app/pages/session-mutation-workflow.ts` records trace data
  for replacement submit failures, but returns `false` without setting a
  user-visible error or returning the typed failure.
- `packages/app/src/app/pages/session-conversation-flow.ts` receives only a
  boolean from `replaceUserMessageAsync`; on `false`, it can fall back to a
  generic "connect server" style message.

Why this matters:

Server-owned replacement is now part of the implemented workflow. If the server
successfully restores a draft, fails to restore, or cannot revert after abort,
the UI should show the relevant state. Otherwise users and logs see a generic
failure even though the server already knows the exact reason.

Acceptance:

- Replacement submit failure must propagate a typed result or a typed
  user-facing error from `session-mutation-workflow` to
  `session-conversation-flow`.
- The UI must distinguish at least:
  - blocked before replacement,
  - replacement state unavailable,
  - abort/revert failure,
  - submit failed and restore succeeded,
  - submit failed and restore failed.
- Composer draft clearing/restoration behavior must continue to follow
  `draftDisposition`.
- Add focused app tests for replacement blocked/failed server responses, not
  only the happy path.

Implementation checklist:

1. Add tests in `session-mutation-workflow.test.ts` for at least one blocked
   and one failed replacement server result.
2. Add a conversation-flow level test proving the visible toast/error uses the
   server message instead of the generic connect-server fallback.
3. Replace the replacement branch's boolean-only return with a typed result, or
   add a narrow failure bridge that sets the same visible error channel used by
   normal submit failures.
4. Preserve server-owned replacement compensation; do not reintroduce frontend
   abort/revert/retry choreography on the primary local path.
5. Keep composer draft clearing/restoration tied to `draftDisposition`.
6. Flip `bsw_aud02_replacement_failure_ui_surface_done` to `true` only after
   replacement blocked/failed states are visible and tested.

Suggested verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-conversation-flow.test.ts
```

Implementation note:

- Pending.

### BSW-AUD03: Documentation status alignment

Status: `done: false`

Severity: P3

Owner: docs

Depends on: BSW-AUD02, BSW-AUD04, BSW-AUD06, BSW-AUD08 preferred.

Problem:

The implementation plan marks the replacement follow-up as complete, but some
supporting docs still describe replacement as outside the completed gate.

Evidence:

- `docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md`
  has `bsw07b_server_replacement_followup_done: true`.
- `docs/fixes/2026-07-07-fix-37-server-owned-composer-send-workflow-complete.md`
  still says BSW07B remains a follow-up outside the core gate.
- `docs/dev/server-owned-composer-submit.md` still says edit-message
  replacement remains a separate follow-up.

Why this matters:

Future agents can miss BSW-AUD02 or incorrectly treat replacement as either
unimplemented or entirely finished. The docs should say that the server-owned
replacement path is implemented, while replacement failure surfacing remains a
follow-up in this audit plan.

Acceptance:

- Update the fix/dev docs so they agree with the current plan status.
- Keep BSW08A and full queue UI API migration explicitly marked as follow-up.
- Keep BSW06B raw attachment byte staging explicitly marked as follow-up.
- Mention this audit file as the owner for replacement failure surfacing.

Implementation checklist:

1. Re-read the final state of the implementation plan, fix note, and dev doc.
2. Update docs that still say BSW07B replacement is only a follow-up.
3. Make docs say the server-owned replacement path is implemented, while
   replacement failure surfacing is owned by this follow-up plan until
   BSW-AUD02 is true.
4. Keep BSW06B and BSW08A as explicit follow-ups unless those were separately
   implemented.
5. Run the documentation `rg` command below.
6. Flip `bsw_aud03_docs_status_alignment_done` to `true` only after docs agree
   with the final code state.

Suggested verification:

```powershell
rg -n "BSW07B|edit-message replacement|replacement remains|server-owned replacement" docs
git diff --check
```

Implementation note:

- Pending.

### BSW-AUD04: Typed app submit boundary

Status: `done: true`

Severity: P2

Owner: app session/conversation flow

Depends on: none; recommended before BSW-AUD02, BSW-AUD05, BSW-AUD06,
BSW-AUD07.

Problem:

The composer component awaits a typed `ComposerSendResult`, but the session
layer still gets a boolean from the conversation flow facade and then rebuilds a
generic result with `sessionSubmitResultFromAccepted`. This collapses
`submitted`, `queued`, `blocked`, and `failed` into `accepted` or `blocked`.

Evidence:

- `packages/app/src/app/pages/session.tsx` calls
  `sessionFlowFacade.handleSendPrompt(...)`, stores the boolean as `accepted`,
  and returns `sessionSubmitResultFromAccepted(accepted, props.error)`.
- `packages/app/src/app/lib/session-send-contract.ts` maps all truthy outcomes
  to `{ status: "accepted", draftDisposition: "clear" }`.
- `packages/app/src/app/pages/session-conversation-flow.ts` keeps
  `sendPromptAsync`, `replaceUserMessageAsync`, `sendPromptImmediate`, and
  `handleSendPrompt` as `Promise<boolean>`.
- `packages/app/src/app/tests/pages/session-message-queue.test.ts` currently
  asserts that the session handler wraps the boolean facade result for the
  composer.
- The base plan explicitly says:
  - replace `Promise<boolean>` with a typed result at the component boundary,
  - the app must not infer server success from `true`,
  - there must be no boolean send result masking server states.

Why this matters:

Several later bugs come from this shape. Once `queued` and replacement failures
are reduced to `true` or `false`, the UI cannot distinguish a queued accepted
draft from a submitted run, and it cannot surface typed server failure details.

Acceptance:

- The production path from `Composer.onSend` through `Session`,
  `SessionConversationFlow`, `SessionMutationWorkflow`, and
  `SessionSendWorkflow` carries a typed result.
- `sessionSubmitResultFromAccepted` is not used as the normal production
  adapter for composer input submits. If retained, it is test-only or a narrow
  compatibility adapter with an explicit owner.
- Typed results preserve at least:
  - accepted submitted,
  - accepted queued,
  - blocked,
  - failed,
  - draft disposition,
  - server code/message when present.
- Tests that currently assert the boolean wrapper are updated to fail if the
  typed boundary regresses.

Implementation checklist:

1. Define or extend one app-facing submit result type that can represent:
   submitted, queued, blocked, failed, local queued, and draft disposition.
2. Change `SessionConversationFlow` transport/facade methods from
   `Promise<boolean>` to the typed result.
3. Change `Session.handleSendPrompt` so it no longer uses
   `sessionSubmitResultFromAccepted` as the normal production adapter.
4. Keep `Composer` as a typed-result consumer and do not move workflow logic
   into the component.
5. Update source-contract tests that currently assert the boolean wrapper.
6. Add behavior tests proving a queued server result reaches the composer as
   queued, not generic accepted.
7. Flip `bsw_aud04_typed_app_boundary_done` to `true` only when the production
   input path no longer masks server states behind `true`.

Suggested verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/components/session/composer-send-intent.test.ts
pnpm --filter @neatech/veslo-ui exec node scripts/legacy-symbol-audit.mjs --limit=40
git diff --check
```

Implementation note:

- 2026-07-07:
  - Changed `packages/app/src/app/lib/session-send-contract.ts`,
    `packages/app/src/app/pages/session.tsx`,
    `packages/app/src/app/context/session-flow-facade.ts`,
    `packages/app/src/app/pages/session-conversation-flow.ts`,
    `packages/app/src/app/pages/session-send-workflow.ts`, and
    `packages/app/src/app/pages/session-mutation-workflow.ts`.
  - Added app-level typed submit statuses for `submitted`, `queued`,
    `blocked`, and `failed`, plus queue/run identity fields. Normal
    `Composer.onSend` now receives the typed flow result directly instead of
    rebuilding it through `sessionSubmitResultFromAccepted`.
  - `SessionConversationFlow` transport, `sendPromptImmediate`, and
    `handleSendPrompt` now return `SessionSubmitResult`. Local queue-only
    branches return explicit typed `queued` results, while server
    `submitted`/`queued` results preserve run id, queue item id, and draft
    disposition.
  - `SessionSendWorkflow` and `SessionMutationWorkflow` map server submit
    results into the app submit result. The legacy fallback remains a narrow
    compatibility adapter and is still owned by BSW-AUD08 cleanup.
  - Updated source-contract and behavior tests in:
    `session-message-queue.test.ts`, `session-conversation-flow.test.ts`,
    `composer-send-intent.test.ts`, `session-flow-facade.test.ts`,
    `session-message-replacement.test.ts`,
    `session-view-modularization.test.ts`,
    `session-send-workflow.test.ts`, and
    `session-creation-workflow.test.ts`.
  - Verification passed:
    `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/components/session/composer-send-intent.test.ts`
    with 75 tests; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-flow-facade.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-view-modularization.test.ts src/app/tests/pages/session-send-workflow.test.ts`
    with 40 tests; `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-creation-workflow.test.ts`
    with 7 tests; `pnpm --filter @neatech/veslo-ui exec tsc --noEmit --pretty false`;
    `pnpm --filter @neatech/veslo-ui exec node scripts/legacy-symbol-audit.mjs --limit=40`.
  - `legacy-symbol-audit.mjs` still reports four dependency-object matches:
    `createSessionSendWorkflow.isWorkspaceClientStaleError`,
    `createSessionSendWorkflow.legacyConversationRunFallback`,
    `createSessionMutationWorkflow.prepareSendRuntimeForSend`, and
    `createSessionCreationWorkflow.isWorkspaceClientStaleError`. These remain
    intentionally deferred to BSW-AUD08.

### BSW-AUD05: Running Enter uses server queue admission

Status: `done: false`

Severity: P2

Owner: app send/queue flow plus server submit contract if needed

Depends on: BSW-AUD04 recommended.

Problem:

The BSW08 acceptance says plain Enter during a running conversation should
result in a server queued run. The current app flow only appends the draft to
the app-local queue when the run indicator is visible.

Evidence:

- `docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md`
  says: "Plain Enter during a running conversation results in a server queued
  run, not only a frontend-only queued draft".
- `packages/app/src/app/pages/session-conversation-flow.ts` resolves this case
  as `append-to-running-queue`.
- The `append-to-running-queue` branch calls only
  `deps.queue.appendDraftToCurrentQueue(draft)` and returns `true`; it does not
  call `submitConversationFromVesloWriteApi`.
- `packages/app/src/app/tests/pages/session-message-queue.test.ts` asserts that
  running non-sendNow sends append to the queue before any immediate send path.

Why this matters:

The user sees the composer clear, but the server does not know about the queued
draft until a later local drain. If the app reloads or crashes before drain, the
queued work is not durable server state. This is weaker than the server-owned
queue contract.

Acceptance:

- For local workspaces, plain Enter during an active run submits the draft to
  the server queue before the composer clears, or the base plan is explicitly
  downgraded and BSW08 is no longer marked complete for this behavior.
- If server queue admission returns `blocked` or `failed`, the composer draft
  must be preserved and a typed error/block reason must be surfaced; the app
  must not clear the draft merely because the local optimistic queue path was
  entered.
- App-local queue rows may remain as optimistic UI rows until BSW08A, but their
  server ownership must be represented by `queueItemId`/`reservedRunId`.
- Remote workspace behavior remains fail-closed or explicitly documented; it
  must not enter the local durable queue.
- Add tests that prove running Enter reaches the server submit path and returns
  a queued typed result for local workspaces.

Implementation checklist:

1. Update conversation-flow tests so running Enter must reach the server submit
   path for local workspaces.
2. Replace the local-only `append-to-running-queue` behavior for local
   workspaces with server queue admission.
3. Use `submitQueuePolicy: "server-queue-only"` or the documented normal
   active-run queue admission path.
4. Preserve an optimistic local queue row only as UI projection of the server
   queue item.
5. Preserve the composer draft and surface the typed server reason when queue
   admission returns `blocked` or `failed`.
6. Keep remote workspaces fail-closed or explicitly documented; do not enqueue
   remote work in the local durable queue.
7. Keep broad edit/cancel/move/pause queue UI migration under BSW08A unless
   needed for this item.
8. Flip `bsw_aud05_running_enter_server_queue_done` to `true` only after plain
   Enter during active local run produces a server queued result and failed or
   blocked admission preserves the draft.

Suggested verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
git diff --check
```

Implementation note:

- Pending.

### BSW-AUD06: Queued live-transcript semantics

Status: `done: false`

Severity: P2/P3

Owner: app send workflow and live transcript policy

Depends on: BSW-AUD04 recommended.

Problem:

The app emits `conversation-run.succeeded` live-transcript policy events for
both `submitted` and `queued` server submit results. A queued result means the
server accepted work into the queue, not that the run has completed or that the
transcript should be treated as readable.

Evidence:

- `packages/app/src/app/pages/session-send-workflow.ts` emits
  `conversation-run.succeeded` after existing-session server submit success
  without distinguishing `result.status === "queued"`.
- The same file emits `conversation-run.succeeded` for first-session
  `serverFirstSubmitResult` without distinguishing queued from submitted.
- `packages/app/src/app/context/live-transcript-read-policy.ts` allows transcript
  reads for a workspace when it receives `conversation-run.succeeded` or
  `conversation-compact.succeeded`.
- `packages/app/src/app/tests/pages/session-send-workflow.test.ts` currently
  expects the queued server submit path to emit `conversation-run.succeeded`.

Why this matters:

This can allow transcript reads too early and makes diagnostics misleading.
Queue acceptance and run success are different lifecycle events.

Acceptance:

- `queued` submit results do not emit `conversation-run.succeeded` or
  `conversation-compact.succeeded`.
- If the UI needs an event for queued acceptance, introduce a separate event
  such as `conversation-run.queued` that does not grant live transcript read
  permission by itself.
- Live transcript read policy only becomes allowed after actual submitted/run
  success semantics or a later terminal/wakeup signal that proves the transcript
  is available.
- Existing tests that assert `conversation-run.succeeded` for queued results are
  updated to assert the new semantics.

Implementation checklist:

1. Add or update tests so queued server submit results do not emit
   `conversation-run.succeeded`.
2. Add a separate queued event if UI/diagnostics still need one.
3. Ensure queued events do not grant live transcript read permission.
4. Keep submitted and compact success events granting read permission only when
   the semantics are actually success/available transcript.
5. Update tests currently asserting `conversation-run.succeeded` for queued.
6. Flip `bsw_aud06_queued_live_transcript_semantics_done` to `true` only after
   queued and submitted have distinct event semantics.

Suggested verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/live-transcript-read-policy.test.ts src/app/tests/pages/session-send-workflow.test.ts
git diff --check
```

Implementation note:

- Pending.

### BSW-AUD07: Queued failure surface

Status: `done: false`

Severity: P2/P3

Owner: server queue status plus app queue projection

Depends on: BSW-AUD04 recommended; BSW-AUD05 useful.

Scope guard:

This is the broadest item in this plan. Prefer a single implementation only if
the server status contract, cache semantics, and app visible failure surface
stay small and directly connected. If the patch starts to grow, split the work
inside this section before coding:

- BSW-AUD07A: server queue terminal-status contract and submit-attempt cache
  interaction.
- BSW-AUD07B: app queue projection/error surface for terminal queue failure.

Do not flip `bsw_aud07_queued_failure_surface_done` to `true` until both
sub-slices are complete, tested, and noted here.

Problem:

Once a submit returns `status: "queued"`, the submit-attempt result is cached as
an accepted queued result. If the later queue drain fails, the queue store
records the failure, but the composer/session UI has no queue status API path
or typed update to surface that failure.

Evidence:

- `packages/server/src/conversation-submit-service.ts` stores `queueItemId` in
  submit attempt result pointers and caches the queued payload in `resultJson`.
- `packages/server/src/conversation-run-lifecycle-controller.ts` can later call
  `queueStore.markFailed(...)` when queue drain registration or submit fails.
- `packages/server/src/conversation-run-queue-store.ts` stores failed queue
  state and error text.
- App types contain `queueItemId`/`reservedRunId`, but the app has no production
  queue status read path wired to the visible composer/session queue UI.
- `rg` over app/server routes found queue store mutation and type usage, but no
  app-consumed queue status API for `queueItemId`.

Why this matters:

The user can see a cleared composer after accepted queue admission, while the
actual queued run later fails silently or only through indirect diagnostics.
Retrying the same submit can return the cached queued result rather than the
later failed queue state.

Acceptance:

- There is a visible UI path from `queueItemId` to terminal queued run failure.
- Queue failure includes a useful server error message and enough identity to
  map back to the queued UI row/session.
- Re-reading or retrying a queued submit must not permanently hide a terminal
  queue failure behind stale cached `resultJson`.
- If full edit/cancel/move queue UI remains BSW08A, this narrower failure
  surface must still be tracked explicitly.
- If split into BSW-AUD07A/07B, the server slice must be useful on its own:
  terminal queue failure must be observable through a typed contract before the
  app UI slice begins.

Implementation checklist:

1. Add a minimal server read path for queue item status, keyed by `workspaceId`,
   `conversationId`, and `queueItemId`, or expose the same state through an
   existing event/status path.
2. Ensure queue drain failures include a useful error message.
3. Ensure the submit attempt cache cannot permanently hide terminal queue
   failure behind the original queued `resultJson`.
4. If this becomes more than a narrow patch, document BSW-AUD07A completion
   here before starting the app UI slice.
5. Wire app queued UI rows to receive or poll terminal failure state.
6. Add server tests for queued item failed status after drain failure.
7. Add app tests proving a queued item failure becomes visible in the session
   queue/composer error surface.
8. Flip `bsw_aud07_queued_failure_surface_done` to `true` only after a queued
   run can fail after acceptance, the terminal failure is observable through
   the server contract, and the UI surfaces that failure.

Suggested verification:

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-message-queue.test.ts src/app/tests/pages/session-conversation-flow.test.ts
git diff --check
```

Implementation note:

- Pending.

### BSW-AUD08: Legacy dependency cleanup

Status: `done: false`

Severity: P3

Owner: app dependency graph

Depends on: BSW-AUD04, BSW-AUD02, BSW-AUD05 preferred.

Problem:

The normal wired send path prefers server submit, but legacy/compat submit
dependencies are still injected into production workflow objects. This keeps
old frontend-owned routing, runtime admission, and direct run construction close
to the production path.

Evidence:

- `packages/app/scripts/legacy-symbol-audit.mjs --limit=40` reported four
  dependency-object matches:
  - `createSessionSendWorkflow.legacyConversationRunFallback`
  - `createSessionSendWorkflow.isWorkspaceClientStaleError`
  - `createSessionMutationWorkflow.prepareSendRuntimeForSend`
  - `createSessionCreationWorkflow.isWorkspaceClientStaleError`
- `packages/app/src/app/app.tsx` still constructs
  `legacyConversationRunFallback` with `buildPromptParts`,
  `buildCommandFileParts`, `compactCurrentSession`,
  `prepareSendRuntimeForSend`, and `runConversationFromVesloWriteApi`.
- `packages/app/src/app/pages/session-send-workflow.ts` keeps
  `createLegacyConversationRunFallback` and a final
  `legacyConversationRunFallback.submit(...)` path when server submit is not
  used.
- `packages/app/src/app/pages/session-mutation-workflow.ts` still has a
  fallback replacement branch that calls `prepareSendRuntimeForSend`,
  direct abort/revert/unrevert, and `sendPrompt`.

Why this matters:

These paths may be legitimate temporary compatibility paths, but leaving them
as production dependencies makes it harder to prove that the server-owned
contract is the only active submit path. It also increases the chance that a
future feature accidentally reuses a legacy path.

Acceptance:

- `legacyConversationRunFallback` is removed from the normal
  `createSessionSendWorkflow` dependency object, or it is gated behind an
  explicit compatibility mode with source-contract tests that prove normal
  production sends cannot enter it.
- Replacement fallback either becomes unnecessary after BSW-AUD02/AUD04 or is
  explicitly documented as the only remaining compatibility path.
- `legacy-symbol-audit.mjs --limit=40` no longer reports high-signal
  production dependency-object matches for the normal composer input path, or
  every remaining match is listed in this plan with an owner and removal rule.

Implementation checklist:

1. Run `legacy-symbol-audit.mjs --limit=40` before editing and record the
   dependency-object matches.
2. Remove `legacyConversationRunFallback` from the normal
   `createSessionSendWorkflow` dependency object, or gate it behind an explicit
   compatibility mode that normal production sends cannot enter.
3. Remove primary-path dependencies on frontend prompt part construction,
   runtime admission, and direct run submit from normal composer input send.
4. Keep compatibility/test helpers only where explicitly documented.
5. Add source-contract tests proving normal input send does not depend on the
   legacy fallback object.
6. Re-run the legacy symbol audit and either reach zero high-signal production
   matches for the normal input path or document each remaining match with an
   owner and removal rule.
7. Flip `bsw_aud08_legacy_dependency_cleanup_done` to `true` only after the
   audit output is explained and normal production send is clean.

Suggested verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node scripts/legacy-symbol-audit.mjs --limit=40
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/pages/session-message-replacement.test.ts
git diff --check
```

Implementation note:

- Pending.

## Non-Findings And Explicit Boundaries

These items were reviewed during the audit and should not be reopened as hidden
legacy bugs without new evidence:

- Existing-session normal send failure handling already has visible blocked and
  failed result paths.
- First-session server submit failure after materialization preserves the draft
  and appends an error turn.
- Attachment handling is intentionally hybrid for now: the app stages bounded
  file-session references and inline payloads; the server owns prompt parts,
  capability checks, and policy. Full raw attachment byte staging remains a
  separate BSW06B follow-up.
- Durable queue UI API migration remains BSW08A and is allowed to stay
  incomplete. BSW-AUD05 and BSW-AUD07 are narrower than full BSW08A: they cover
  durable queue admission for running Enter sends and visible failure surfacing
  for already accepted queued submits.
- Compatibility/test-only direct-run helpers may remain as long as the wired
  production composer input path uses the server submit contract. BSW-AUD08 is
  about high-signal production dependency injection, not deleting every
  compatibility helper symbol from the repo.

## Recommended Order

1. Fix BSW-AUD01 first. It is the only finding that can duplicate real run
   side effects.
2. Fix BSW-AUD04 next. Typed app results are the shared prerequisite for clean
   replacement, queued, and failure handling.
3. Fix BSW-AUD02 and BSW-AUD06 after typed results are available. They close
   replacement failure surfacing and queued/live-transcript semantics.
4. Fix BSW-AUD05 and BSW-AUD07 as the queue contract slice before any broad
   BSW08A UI migration.
5. Fix BSW-AUD08 as cleanup once normal typed/queued flows no longer need the
   legacy fallback hooks.
6. Fix BSW-AUD03 last, after the code behavior is stable, so docs describe the
   final status accurately.

## Final Gate

This follow-up plan can be marked `done: true` only when:

- BSW-AUD01 through BSW-AUD08 are all `done: true`.
- Focused app and server tests pass.
- `packages/app/scripts/legacy-symbol-audit.mjs --limit=40` has no unexplained
  high-signal production dependency-object matches for the normal composer input
  path.
- `git diff --check` passes.
- E2E remains either intentionally skipped here or is recorded separately if a
  later decision changes that scope.
