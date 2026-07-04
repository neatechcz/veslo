# Fix 22: VSLO-269 Model Stream Retry No-Progress Visibility

## Problem

The 2026-07-03 installed app Unity incident showed a run that stayed visibly
`running/responding` while OpenCode repeatedly restarted model streams without
user-visible output. There was no active local tool process during the long
retry gap, but the UI did not distinguish provider/model retry from real work.

Source issue:

```text
VSLO-269: Installed app agent silently stalls in model-stream retry loop during Unity task
```

Related issues used for comparison were VSLO-261, VSLO-268, and VSLO-183, but
this checkpoint specifically closes the KISS mitigation slice for VSLO-269.

## Fix

- Extended orchestrator run activity probing so OpenCode `retry` status fetches
  the session message payload before deciding whether work is useful progress,
  local tool work, assistant output, or model retry with no output.
- Added additive orchestrator run diagnostics:
  - `activityKind`
  - `waitReason`
  - `lastUsefulProgressAt`
  - `retrySince`
  - internal `lastProgressSignature`
- Persisted the diagnostics in the run registry with additive SQLite columns.
- Kept `lastProgressSignature` private to orchestrator and omitted it from
  lifecycle responses.
- Bounded `model_retry_no_output` with a hard blocked transition using
  `model_retry_no_output_timeout`, while preserving the active queue/admission
  lock.
- Propagated public diagnostic fields through the server lifecycle client and
  conversation run status route.
- Threaded active run diagnostics through the app session lifecycle recovery
  state and visible session run indicator.
- Added English and Czech labels for:
  - `Retrying model/API, no output for ...`
  - `Model/API retry blocked after ...`
- Added deterministic desktop coverage with the Tauri-pilot scenario
  `model-stream-retry-no-progress`.
- Added a test-only orchestrator probe mode,
  `E2E_RUN_ACTIVITY_PROBE_MODE=model-retry-no-progress`, and a configurable
  registry hard-threshold override for E2E runtime validation. Production
  defaults remain unchanged.

## Plan

The implementation plan is closed in:

```text
docs/plans/2026-07-03-model-stream-retry-no-progress-kiss-plan.md
```

Top-level `done` and MSR00 through MSR04 are all marked complete.

## Coverage

- Orchestrator tests cover retry/no-output classification, local tool
  separation, registry persistence, active-lock behavior, hard blocked
  threshold, and shortened threshold injection.
- Server tests cover diagnostic pass-through in the lifecycle client and
  conversation run status route.
- App tests cover active diagnostic polling and visible run label plumbing.
- E2E runner tests cover the new model-stream retry scenario fixture selection.
- Tauri-pilot coverage runs the installed desktop runtime path with managed AI
  fixture, real local Veslo server, orchestrator sidecar, lifecycle polling, and
  visible UI assertions for retry and blocked status.

## Verification

Run on 2026-07-03:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/run-activity-probe.test.ts src/tests/run-registry.test.ts src/tests/run-store.test.ts
pnpm --filter veslo-server exec bun test src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/app-view-props.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build:bin
$env:VESLO_SIDECAR_FORCE_BUILD='1'; pnpm --filter @neatech/veslo run prepare:sidecar
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/pilot-runner.test.ts
pnpm test:pilot -- --scenario model-stream-retry-no-progress
git diff --check
```

Result:

- Orchestrator focused tests passed.
- Server focused tests passed.
- App focused tests passed.
- Orchestrator, server, and app typechecks passed.
- Server and orchestrator sidecar binaries were rebuilt.
- E2E debug Tauri binary rebuilt successfully.
- E2E runner tests passed.
- `model-stream-retry-no-progress` passed: `4 passed`, `0 failed`.
- `git diff --check` passed with Windows LF-to-CRLF warnings only.

## Status

Complete for this KISS checkpoint. Installed app runs can now surface a
model/API retry no-progress state and transition to a visible blocked state
instead of remaining indistinguishable from useful local work.
