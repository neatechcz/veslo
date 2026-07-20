# Fix 58: Lifecycle-Authoritative Terminal Assistant Event Ordering

Date: 2026-07-19

## Scope

This checkpoint fixes the visible ordering race where the final assistant text
could appear before the session's active-response presentation (`Odpovidam`)
disappeared. It covers existing, materialized conversation sessions and their
server-owned run lifecycle. It does not replace the direct engine SSE transport
or add a server event relay.

## Symptom

The client previously committed an assistant text-part event immediately. The
authoritative exact-run lifecycle read could report `completed` only afterwards,
so the final transcript text became visible while the UI still showed an active
response. Raw `session.idle` was not a safe substitute: an audited run received
an earlier idle event while its durable lifecycle status remained queued.

## Root Cause

Three independent paths had no common visible-order boundary:

1. Direct SSE applied text parts to the transcript immediately and committed
   text-delta dedupe at receipt time.
2. Lifecycle recovery cleared the active presentation after an exact durable
   terminal result, then asynchronously hydrated the terminal transcript.
3. A queued run could share an OpenCode session alias with a running run,
   while conversation-wide latest-run state could otherwise let the queued run
   replace the running run's local ownership.

## Implemented

- Added an app-local terminal delivery coordinator. It retains only the last
  visible assistant mutation for an exact `(workspaceId, conversationId, runId)`
  scope and commits it after the terminal presentation crosses a render frame.
- Split assistant text-delta handling into prepare and commit phases. Dedupe is
  recorded only immediately before a retained event is actually applied.
- Routed terminal transcript hydration and terminal error turns through the
  same coordinator, so they cannot bypass the terminal display boundary.
- Added exact multi-run ownership. A running run A and queued run B can coexist;
  B stays unarmed for the shared alias until A has terminally delivered and B
  has an exact active lifecycle status.
- Split the alias handover into two phases. Candidate B events are held while
  A is crossing its render boundary and while A's terminal transcript recovery
  remains unsettled; B can become alias owner only after both conditions hold.
  If no queued successor exists, delayed A events are flushed and the alias
  latch is cleared. A queued successor that terminalizes before activation also
  clears the latch instead of blocking later runs.
- Added a strict `returnedRunId === requestedRunId` fence for exact lifecycle
  status reads. A stale, missing, or mismatched response cannot clear the
  active presentation or release a terminal tail.
- Kept terminal transcript retry independent from active presentation ownership.
  A terminal hydration retry can finish after its visible alias has transferred
  to B, while a never-active queued B still cannot alter A's presentation.
- Added a known-alias provisional binding before an existing-session submit.
  A fast first assistant SSE event can be retained before the accepted HTTP
  response supplies the exact run id, then is promoted without duplicate
  application.
- Added an explicit degraded release for a provisional binding whose submit
  cannot establish terminality, preventing an already-received text tail from
  being silently lost.
- Extended the deterministic session queue fixture and the existing
  `session-run-truthfulness` desktop scenario. That scenario is now a separate
  required CI gate after the normal UI suite.

## Contract

For an eligible existing-session run, the visible order is now:

```text
exact lifecycle-service terminal result for the same runId
  -> active response presentation becomes idle
  -> next render boundary
  -> retained final assistant mutation, hydration, or terminal error display
```

`message.updated` metadata cannot release a retained text part. Raw engine idle
cannot establish terminality. A stale or mismatched exact status does not
release the terminal tail.

The first/pending-session flow remains outside this guarantee: the browser does
not receive a stable OpenCode alias and run id before the server may start its
engine. It needs a separate server pre-start identity handoff.

## Verification

```powershell
pnpm --filter veslo-server typecheck
# passed

pnpm --filter @neatech/veslo-ui typecheck
# passed

pnpm --filter @neatech/veslo-e2e typecheck
# passed

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm `
  src/app/context/conversation-run-ownership.test.ts `
  src/app/context/terminal-delivery-coordinator.test.ts `
  src/app/context/session-lifecycle-recovery.test.ts `
  src/app/tests/context/conversation-service.test.ts `
  src/app/tests/app-conversation-abort.test.ts `
  src/app/tests/pages/session-send-workflow.test.ts
# passed: 145 tests, 0 failures

pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm `
  helpers/session-queue-runtime-fixture.test.ts
# passed: 2 tests, 0 failures

git diff --check
# passed (only pre-existing CRLF conversion warnings)
```

## Desktop Gate

The fixture-backed Tauri-Pilot command is present and required in CI:

```powershell
pnpm --filter @neatech/veslo-e2e run test:pilot:session-run-truthfulness
```

It is intentionally not treated as local verification in this checkpoint. The
local Pilot run was skipped at request after rebuilding the desktop E2E binary
with the `e2e` feature and `tauri-plugin-pilot` enabled. CI remains the release
gate for the full desktop-visible ordering assertion.
