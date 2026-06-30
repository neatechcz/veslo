# Fix 15: VSLO-261 Stale Run Lifecycle Recovery

## Problem

Desktop conversations could stay in `Answering` forever when Veslo's durable
`conversation_run` lifecycle row remained active after the underlying OpenCode
work had already ended or become unreachable.

Observed incident paths included:

- engine crash/replacement while a prompt was active,
- successful abort that only recorded `abort_requested`,
- successful OpenCode assistant response where lifecycle completion was not
  reconciled,
- existing conversations blocked by a stale active run while new conversations
  still worked,
- queued user input stuck behind an old active run,
- sidebar/session navigation exposing stale UI busy state after backend work
  completed.

The important invariant was that lifecycle terminalization must be owned by the
server/orchestrator. UI transcript append is a wake-up signal, not the business
authority for active-run admission or terminal state.

## Fix

- Added orchestrator lifecycle terminal helpers for `failed`, `aborted`, and
  completed-by-reconcile states.
- Added server-side bounded lifecycle reconciliation after accepted conversation
  runs.
- Reconciled successful aborts so stale/inactive runs can become terminal
  `aborted` instead of staying `running`.
- Woke per-conversation queue drains whenever lifecycle becomes terminal.
- Hardened the OpenCode conversation read store so bad/missing SQLite schema is
  reported as `source: "unavailable"` instead of a sidebar `/conversations`
  500.
- Added engine owner metadata to run rows and tied runs to the actual engine
  generation used at submit time.
- Added engine-loss cleanup for pooled and shared-unsandboxed engines.
- Added internal `x-veslo-conversation-run-id` correlation from the server
  submit helper to orchestrator proxy resolution, then stripped that header
  before OpenCode upstream.
- Kept `stale: true` probes non-terminal and retryable instead of silently
  converting unreachable runs to `completed`.

## Recovery Hardening

- Added a read-only app lifecycle recovery controller. It polls the backend for
  the latest known active run and only reacts when backend lifecycle is already
  terminal and non-stale.
- On backend terminal status, the app clears local busy state to `idle`, notifies
  workspace busy state, and schedules transcript ingestion for the owning
  workspace.
- UI recovery does not mutate lifecycle rows and does not decide completion.
- Added an orchestrator startup sweep for legacy active rows older than 24
  hours. It marks ordinary old active rows `failed` and old abort-requested rows
  `aborted`.
- The startup sweep can be disabled with
  `VESLO_RUN_LIFECYCLE_LEGACY_ACTIVE_SWEEP_AGE_MS=0` or
  `--run-lifecycle-legacy-active-sweep-age-ms 0`.

## Plan

The implementation plan is closed in:

```text
docs/plans/2026-06-30-vslo-261-stale-run-lifecycle-reconciliation-plan.md
```

Top-level `done`, KISS Slice 1, Phase 4 follow-up, Phase 5 recovery, and Phase 7
startup sweep are all marked complete.

## Validation

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts
bun test packages/orchestrator/src/tests/run-store.test.ts packages/orchestrator/src/tests/run-registry.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-orchestrator build:bin
bun test packages/orchestrator/src/tests/run-store.test.ts packages/orchestrator/src/tests/run-registry.test.ts packages/orchestrator/src/tests/run-activity-probe.test.ts packages/orchestrator/src/tests/engine-pool.test.ts packages/orchestrator/src/tests/shared-opencode-engine.test.ts packages/orchestrator/src/tests/router-proxy.test.ts
```

Result:

- UI lifecycle recovery controller: `2 pass`, `0 fail`
- initial orchestrator run-store/run-registry: `19 pass`, `0 fail`
- app and orchestrator typecheck passed
- `veslo-orchestrator` binary rebuilt successfully
- broader orchestrator lifecycle/proxy subset: `99 pass`, `0 fail`
- scoped `git diff --check` passed with only Windows LF-to-CRLF warnings

Earlier lifecycle slices also passed their focused server/orchestrator suites and
rebuilt `veslo-server` / `veslo-orchestrator` binaries; see the plan document
for the full command history.

## Status

VSLO-261 is complete for the KISS lifecycle recovery slice:

- stale active rows should no longer keep old chats blocked indefinitely,
- abort reconciliation no longer leaves an active lifecycle row forever,
- engine crash/replacement cleanup is tied to engine generation,
- UI recovery can clear stale visible `Answering` only after backend lifecycle is
  already terminal,
- existing legacy active rows have a conservative startup recovery path.

Real Tauri desktop E2E was not run for this checkpoint.
