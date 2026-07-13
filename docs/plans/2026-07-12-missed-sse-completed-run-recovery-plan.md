---
title: Accepted Run Completion Recovery Plan
date: 2026-07-12
status: implemented
done: true
repository_snapshot: current veslo-main working tree
scope: app-local accepted-run observation and exact transcript hydration
arc01_admit_accepted_run_done: true
arc02_hydrate_terminal_run_done: true
arc03_regression_coverage_done: true
---

# Accepted Run Completion Recovery Plan

## Canonical Status

done: true

This is a narrow frontend correctness fix. It does not change the durable run
owner, queue semantics, OpenCode SSE ownership, or server transcript ingest.

## Verified Problem

After a validated server submit returns `status: "submitted"`, the app knows
the exact accepted `runId`, but does not give that run to the existing session
lifecycle recovery controller.

The controller currently creates a watch only when:

- UI session status is already `submitted`, `running`, `retry`, or `blocked`;
- a `session.idle` or `session.error` SSE event is observed; or
- the selected-session latest-run probe runs during selection/reload.

If the UI status is still `idle` and the relevant OpenCode SSE completion is
missed, none of those entry points is guaranteed. The optimistic accepted send
can therefore remain visible after the durable run and transcript are already
terminal.

This is a real correctness gap. It is also a plausible explanation for the
reported macOS symptom, but the plan does not claim that missing SSE routing is
the proven root cause of that specific runtime incident without a correlated
runtime trace.

## Existing Owners

- The orchestrator remains the durable `conversation_run` lifecycle owner.
- The server remains the canonical transcript-ingest and durable-queue owner.
- The app lifecycle controller only observes exact durable run status and
  reconciles presentation state.
- OpenCode SSE remains the low-latency render path, not the only completion
  guarantee.

The broader event-driven server/orchestrator work in
`docs/plans/2026-07-11-event-driven-conversation-run-lifecycle-implementation-plan.md`
is compatible with this fix. It may later make normal lifecycle observation
event-driven, while this exact-run path remains a disconnect/restart fallback.

## KISS Design

Add one method to the existing session lifecycle owner:

```ts
admitAcceptedConversationRun({
  sessionId,
  workspaceId,
  conversationId,
  opencodeSessionId,
  directory,
  runId,
  clientMessageId,
})
```

Call it once after each validated `status: "submitted"` server result.

The method must:

1. publish an exact scoped `submitted` lifecycle diagnostic;
2. write scoped session status `submitted`;
3. create or refresh the existing watch keyed by
   `(workspaceId, conversationId, runId)`;
4. perform one immediate exact-run status read and then reuse the controller's
   existing polling policy while the run is non-terminal;
5. on an exact non-stale terminal result, publish the terminal diagnostic,
   write scoped `idle`, and recover plus hydrate the exact transcript snapshot.

Do not add another controller, timer, catch-up scheduler, global active
workspace fallback, or frontend lifecycle writer.

## Required Contract Correction

The current `recoverTerminalRun()` skips transcript recovery for a selected
session on the normal watch path. That is valid only when live SSE already
hydrated the selected transcript. It is not valid for an explicitly admitted
accepted run whose SSE may have been missed.

Terminal handling must therefore distinguish an admitted exact run from a
legacy status-derived watch. An admitted exact run always requests one
idempotent exact transcript recovery, including when its session is selected.

The current recovery helper also reads the resulting transcript through a
non-hydrating server client. Change its narrow return contract so the fetched
snapshot is returned to the session store and passed through the existing
`hydrateTranscriptSnapshot()` owner. A successful HTTP read that is discarded
without store adoption does not satisfy this plan.

## Hard Contracts

1. Admission accepts only a boundary-validated `status: "submitted"` result.
   `queued`, `blocked`, and `failed` results are not admitted by this slice.
2. All identity comes from the validated submit result plus its captured send
   target. Never infer workspace or directory from the currently active view.
3. The same `(workspaceId, conversationId, runId)` admission is idempotent.
4. A newer admitted run for the same conversation supersedes the older watch.
   A late old poll cannot publish terminal state or hydrate the new view.
5. Terminal evidence may settle the optimistic send only when `runId` or
   `clientMessageId` matches the accepted submission.
6. Transcript recovery is workspace-scoped and carries `expectedRunId`.
7. Recovery must hydrate the returned snapshot through the existing session
   transcript owner. Do not add a second messages store or `setStreaming`
   flag.
8. A null, failed, stale, mismatched, or non-terminal status read must not
   fabricate `idle`, completion, or transcript content.
9. Duplicate admission, duplicate SSE, reconnect, and polling races may cause
   at most one terminal hydration for one admitted run.
10. The app observes durable lifecycle state only. It never terminalizes a
    durable run or drains the server queue.
11. Watch exhaustion preserves the accepted identity, publishes scoped
    `recoveryState: "exhausted"`, stops polling, and never fabricates `idle` or
    a terminal result. A relevant lifecycle event, live reconnect, or explicit
    open/reselect of that session may resume exact-run observation without
    starting a generic timer loop.

## Implementation Plan

### ARC01 - Admit validated submitted runs

done: true

Files:

- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/pages/session-send-workflow.ts`
- `packages/app/src/app/app.tsx`

Work:

1. Add `clientMessageId` to the exact recovery scope/diagnostic where needed.
2. Add `admitAcceptedConversationRun()` to the existing lifecycle controller
   and expose it through the session store.
3. Seed or refresh the existing watch directly; do not depend on a reactive
   `reconcile()` round trip to discover the admitted run.
4. Invoke the method after validation in both submitted-result branches:
   existing session and materialized first session.
5. Do not invoke it for a durable queued result. Queue admission remains
   server-owned and its `reservedRunId` becomes lifecycle-owned only when the
   server actually submits that queue item.

Acceptance:

- A submitted result creates one exact watch while prior UI status is `idle`.
- Existing-session and first-session submits pass returned durable IDs.
- First-session admission uses the materialized UI `sessionId`; the returned
  OpenCode session id is only its backend alias.
- Queued, blocked, failed, foreign-workspace, and malformed results do not
  create a watch.
- Re-admitting the same run does not create a second poll or hydration.

### ARC02 - Recover and hydrate the exact terminal transcript

done: true

Files:

- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/context/conversation-service.ts`

Work:

1. Mark watches created by explicit admission so terminal handling knows the
   selected session may still require hydration.
2. Preserve the existing terminal diagnostic and scoped `idle` writes.
3. Make `recoverConversationTranscript()` return the exact fetched transcript
   snapshot, or `null` when no safe snapshot is available.
4. In the session store, feed that snapshot through the existing
   `hydrateTranscriptSnapshot()` function.
5. Coalesce terminal hydration by exact run key and fence every asynchronous
   result against watch replacement/disposal.

Acceptance:

- With no target SSE event, durable completion displays the assistant response
  and clears the matching indicator without navigation or Stop.
- The same behavior works while the conversation is currently selected.
- A recovered snapshot keyed by the OpenCode session alias is adopted under
  the materialized UI session id, never as a second UI session.
- An older run cannot clear or hydrate over a newer accepted send.
- Failed and aborted runs release matching presentation state without
  inventing a successful assistant response.
- Missing or unavailable transcript data remains traceable and does not
  fabricate completion content.

### ARC03 - Focused regression coverage

done: true

Required tests:

1. Controller: admission from prior UI `idle` creates exactly one watch and
   performs an immediate exact-run read.
2. Controller: exact completed status writes `idle` and requests one recovery
   with `expectedRunId`, even while the session is selected.
3. Controller: duplicate admission/SSE/poll completion hydrates once.
4. Controller: a superseded old poll cannot terminalize or hydrate the newer
   run.
5. Send workflow: existing-session and materialized-first-session submitted
   results call admission with returned IDs; queued results do not.
6. Session integration: instantiate the real session store and verify that a
   returned recovery snapshot for `ses-open` is adopted under UI session
   `ses-ui`, not under `ses-open`, and releases the matching optimistic send.
7. Negative integration: terminal evidence from another run or workspace
   cannot settle the visible submission.
8. Exhaustion: opening or reselecting the exact session resumes only its
   exhausted watch; a foreign session does not resume it.

Before changing assertions, classify the currently failing
`session-event-stream.test.ts` expectations. Remove only assertions for
production behavior that was intentionally retired; do not weaken unrelated
foreground event coverage to make this plan green.

Validation:

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-run-presentation.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-event-stream.test.ts
corepack pnpm@10.27.0 --filter @neatech/veslo-ui typecheck
git diff --check
```

## Explicitly Out Of Scope

- Changing orchestrator or server durable lifecycle ownership.
- Implementing the broader event-driven lifecycle plan.
- Broadening or replacing OpenCode SSE routing.
- Adding a second transcript catch-up scheduler.
- Changing durable queue semantics.
- Fixing non-JSON Veslo transport diagnostics; that is a separate defect.
- Proving the exact root cause of the historical macOS incident without its
  correlated runtime trace.

## Completion Checklist

- [x] Every validated submitted result is admitted to one exact lifecycle
  watch.
- [x] A missed SSE completion cannot leave the matching accepted presentation
  active after durable terminal observation.
- [x] Terminal recovery actually hydrates the selected transcript snapshot.
- [x] Old, foreign, queued, and duplicate results remain fenced.
- [x] Watch exhaustion is visible, non-terminal, and resumable by reconnect,
  a relevant lifecycle event, or opening/reselecting the exact session.
- [x] No new lifecycle owner, message store, or independent timer was added.
- [x] Focused tests, event-stream classification, typecheck, and diff check
  pass.

## Verification Result

Implemented on 2026-07-12.

- Focused lifecycle, real session-store transcript adoption,
  conversation-service, event-stream, send-workflow, and presentation suite:
  139 passed, 0 failed.
- `@neatech/veslo-ui` typecheck: passed.
- `git diff --check`: passed.
- Broad `test:unit`: 2684 passed and 12 pre-existing source-contract tests
  failed outside this slice; none of the focused changed-surface tests failed.
