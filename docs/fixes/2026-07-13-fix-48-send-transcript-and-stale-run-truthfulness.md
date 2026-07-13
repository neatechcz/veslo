# Fix 48: Send, Transcript, And Stale-Run Truthfulness

Date: 2026-07-13

## Scope

Completed the incident-driven remediation for three observed desktop-runtime
symptoms:

- an assistant's first response could be received but disappear from the UI;
- a new chat could remain in `Answering` after its local runtime became
  unavailable; and
- an early `idle` stream event could release optimistic UI state before the
  durable run lifecycle had reached a terminal state.

## Problem

A passive transcript snapshot with no parts could overwrite already-observed
live assistant parts. Separately, `session.status: idle` bypassed the existing
lifecycle arbitration used by `session.idle`. On the server, queue draining
could terminalize a generically stale active run merely because it had a queued
successor, without precise evidence that its engine owner had been lost.

## Fix

- Passive empty transcript snapshots now retain observed live parts. Non-empty
  snapshots remain authoritative. The guarded path emits a content-free
  runtime trace for diagnosis.
- `session.status: idle` now follows the same durable-lifecycle arbitration as
  `session.idle` in foreground and background workspace streams. The UI stays
  active until the durable owner confirms a terminal state.
- Queue draining now delegates a generically stale active run to the existing
  exact lifecycle reconciliation instead of immediately failing it due to a
  queued successor.
- Added focused regression coverage for all three contracts and runtime trace
  assertions for the two client-side deferrals.

## KISS Boundary

- The server/orchestrator remains the durable run and transcript owner.
- No second transcript store, controller, queue policy, or fast-fail classifier
  was introduced.
- The app does not infer completion from transport ordering; it observes the
  durable lifecycle.

## Runtime Confirmation

A fresh desktop dev-runtime trace from 2026-07-13 17:27:45--17:28:18 local
time confirmed the first-message path from a missing app client:

- `createSessionAndOpen` began with `hasClient: false`, joined the already
  running runtime bootstrap in 495 ms, passed health, materialized the new
  conversation, and accepted the first prompt.
- Three prompts in that conversation were accepted. Server and orchestrator
  requests completed only with HTTP 200 or 204, and all three durable runs
  reached `completed`.
- The UI received text for all three assistant messages through SSE. Duplicate
  early `session.idle` / `session.status: idle` observations were deferred to
  lifecycle arbitration; the queued successor remained active, while the final
  run became inactive only after its exact durable lifecycle read returned
  `completed`.
- The final visible run reset `run-state` and hydrated its canonical terminal
  transcript. No Tauri Pilot or E2E scenario was run, by explicit scope
  decision; confirmation used the dev runtime and its content-free diagnostic
  traces.

### Runtime Evidence Boundary

This is successful manual runtime validation of the reported new-chat/runtime
bootstrap path and of normal accepted-run completion. It is not positive
evidence for a server transport failure after a prompt has already been
accepted: this trace contains no `disconnected`, `unreachable`,
`status-http-error`, `connection-unavailable`, or deadline-expiry event.

Accordingly, this checkpoint must not be read as proof that every post-accept
connectivity-loss branch has executed. The production behavior is fixed and
validated for the reported flow; a future trace with an actual post-accept
transport failure is required only to validate that separate recovery branch.

## Verification

Run on 2026-07-13:

```powershell
bun test packages/server/src/tests/conversation-run-lifecycle-controller.test.ts packages/server/src/tests/server.health-status-routes.test.ts --timeout 30000
# 43 passed, 0 failed

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-transcript-controller.test.ts src/app/tests/context/session-transcript-hydration.test.ts src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/veslo-server-connection.test.ts src/app/tests/pages/session-run-presentation.test.ts src/app/tests/context/sidebar-session-activity-projection.test.ts
# 84 passed, 0 failed

pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
# both exit 0

git diff --check
# exit 0; only pre-existing CRLF warnings
```

The repository-wide UI unit suite is still non-green because of 16 failures in
other, already-dirty worktree areas. Those failures are outside this slice and
were not changed here.

## Remaining Decision-Gated Work

One item intentionally remains open: positive, run-correlated evidence of
engine-owner loss has not been demonstrated. Until that signal exists, the
separate rapid terminalization branch remains deferred; the normal bounded
lifecycle reconciler is the terminal owner. The remediation implementation
plan therefore correctly remains `done: false`.

## Status

The three observed incident paths are fixed, covered by focused tests, and
manually validated in the latest desktop runtime for the reported new-chat and
accepted-run flow. The explicit post-accept transport-failure validation and
the separate positive engine-owner-loss decision gate remain open.
