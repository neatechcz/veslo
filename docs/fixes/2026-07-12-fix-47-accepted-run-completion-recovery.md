# Fix 47: Accepted Run Completion Recovery

Date: 2026-07-12

## Scope

Completed the focused plan
`docs/plans/2026-07-12-missed-sse-completed-run-recovery-plan.md`.

This closes the app-local gap where a server-accepted run could complete and
persist its transcript while the visible composer remained optimistic because
the matching OpenCode SSE completion was not observed.

The server and orchestrator remain the durable lifecycle and transcript
owners. This fix adds only an exact-run observation and reconciliation path in
the existing app session lifecycle controller.

## Problem

A validated server submit returned an exact durable `runId`, but that identity
was not admitted to lifecycle recovery. Recovery therefore depended on a
running UI status, a later SSE lifecycle event, or a selection-time latest-run
probe. If all three were absent, a completed durable response could remain
unreconciled until navigation or Stop.

## Fix

- Submitted results for existing and materialized first sessions now admit one
  exact lifecycle watch with the returned workspace, conversation, OpenCode
  session, run, directory, and client-message identities.
- The existing lifecycle controller immediately polls that exact run and keeps
  its existing bounded recovery policy. Queued, blocked, and failed submit
  results are not admitted by this path.
- Exact terminal evidence writes the scoped terminal diagnostic and releases
  only the matching optimistic presentation state.
- Exact transcript recovery returns its fetched snapshot to the app instead of
  discarding it. The existing transcript store hydrates that snapshot under the
  UI session id, including when the durable snapshot uses the OpenCode session
  alias.
- Late polls and late transcript reads are fenced by exact run identity, so a
  superseded run cannot clear or hydrate over a newer accepted run.
- Exhausted watches remain explicitly degraded and can resume only from a
  relevant lifecycle event, reconnect, or reopening/reselecting the exact
  scoped session.
- Latest-run probing now fails closed without an exact selected workspace and
  conversation scope; it does not borrow the active workspace.

## KISS Boundary

- No second transcript store, catch-up scheduler, or lifecycle controller was
  introduced.
- No server queue semantics, durable ownership, or OpenCode SSE routing was
  changed.
- The recovery path observes durable state and hydrates canonical durable
  transcript data; it does not terminalize runs itself.
- The separate abort-scope hardening performed in the same working tree is not
  part of this plan checkpoint.

## Verification

Run on 2026-07-12:

```powershell
pnpm --filter @neatech/veslo-ui exec tsx --test src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-run-presentation.test.ts
# 139 passed, 0 failed

pnpm --filter @neatech/veslo-ui typecheck
# exit 0

git diff --check
# exit 0
```

## Status

The accepted-run completion recovery plan is implemented, covered by focused
controller, integration, send-workflow, event-stream, conversation-service,
and presentation tests, and recorded as `done: true` in the plan.
