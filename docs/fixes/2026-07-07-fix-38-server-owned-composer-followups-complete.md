# Fix 38: Server-Owned Composer Follow-ups Complete

Date: 2026-07-07

## Scope

Completed the focused follow-up plan in
`docs/plans/2026-07-07-server-owned-composer-send-workflow-deep-audit-followups.md`.

This fix note covers the non-E2E follow-up closure after the core
server-owned composer send workflow. It does not claim installed-runtime,
desktop, or tauri-pilot validation; E2E remains intentionally skipped for this
plan.

## Fix

- Closed BSW-AUD07 by adding a server queue status contract for accepted queued
  runs and by surfacing terminal queued failures back into app queue rows.
- Closed BSW-AUD08 by removing legacy run fallback injection from normal
  production send wiring. The fallback remains an explicit compatibility hook
  for tests or opt-in callers, and missing compatibility now fails closed.
- Aligned BSW-AUD03 and BSW-AUD06 status notes after reviewing the actual docs
  and live-transcript behavior.
- Marked the follow-up plan `status: implemented` and `done: true` after all
  `bsw_aud*_done` flags were true.
- Updated canonical composer submit docs and the previous core-gate fix note so
  promoted BSW07B is described as implemented, not as a pending replacement
  follow-up.

## Self Review

No blocking implementation findings remain from the backward review.

Quality checks that held up:

- The new queue status route is workspace/conversation scoped and has route,
  store, and integrated submit retry coverage.
- Stale queued-submit replay now reads durable queue state before replaying the
  cached queued result, so terminal queue failure is not hidden behind
  idempotency.
- The app preserves `queueItemId` and `reservedRunId` on failed submit results,
  so UI queue rows can show the real server failure.
- Normal production send wiring no longer constructs or injects
  `legacyConversationRunFallback`.
- The remaining legacy-symbol audit dependency-object matches are documented
  with owners and removal rules.

Review issues fixed during the self-audit:

- AUD08 implementation notes were initially inserted under the wrong audit
  section and then moved under BSW-AUD08.
- AUD06 live-transcript notes were initially sitting under BSW-AUD03 and were
  moved under BSW-AUD06.
- AUD03 docs evidence used stale "still says" wording after the docs were
  corrected; that wording is now historical baseline evidence.

Residual risk and boundaries:

- Full durable queue polling/edit/cancel/move UI remains BSW08A and was not
  implemented here.
- E2E and real desktop runtime validation remain skipped by plan scope.
- The working tree contains unrelated dirty files from adjacent work; this fix
  note covers only the composer follow-up closure.
- A full `server-conversations.test.ts` run previously exposed unrelated
  managed-AI gateway watchdog failures. The queue/submit cases touched by this
  plan passed in focused runs.

## Verification

Run on 2026-07-07:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/live-transcript-read-policy.test.ts src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/pages/session-message-replacement.test.ts src/app/tests/pages/session-message-queue.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node scripts/legacy-symbol-audit.mjs --limit=40
pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/server.conversation-session-routes.test.ts src/tests/conversation-submit-service.test.ts src/tests/conversation-run-lifecycle-controller.test.ts
pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts --test-name-pattern "returns queued for send-now"
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
git diff --check
```

Results:

- App live-transcript/send workflow bundle: `34` passed, `0` failed.
- App send/mutation/replacement/queue bundle: `63` passed, `0` failed.
- App typecheck passed.
- Legacy symbol audit reports `3` dependency-object matches, all documented in
  the follow-up plan.
- Server queue/submit/lifecycle/route bundle: `54` passed, `0` failed.
- Focused server queued send-now route case: `1` passed, `0` failed.
- Server typecheck passed.
- Server binary rebuild passed.
- `git diff --check` passed with LF/CRLF warnings only.

## Status

The server-owned composer follow-up plan is implemented and documented. The
remaining queue UI API migration and E2E runtime validation are explicit
follow-up boundaries, not hidden unfinished work in this plan.
