# Fix 56: Tauri Pilot Native UI Parity and Actionable Live Artifacts

Date: 2026-07-17

## Scope

This checkpoint covers the Tauri Pilot parity and per-run diagnostic slice:
real Desktop UI interaction for VSLO-270, isolated and bounded Pilot artifacts,
and safe diagnostic redaction. It records live Den evidence exactly as observed.
It does not claim that a live AI Gateway/provider incident was fixed by a test
fixture or a cached credential.

## Problem

VSLO-270 still used browser `eval` to navigate, replace the contenteditable
composer value, and invoke Send/Stop directly. That proves internal handlers,
but not the production interaction path a signed-in desktop user uses.

The first complete live normal-send checks also exposed two diagnostics gaps:

- generic text redaction was applied to raw JUnit XML, turning attributes such
  as `message="..."` into invalid `message=<redacted>` markup;
- a real provider failure could leave a submitted lifecycle run in `running`,
  producing a long, actionable Pilot timeout rather than a fabricated green
  result.

## Implemented

- VSLO-270 now uses Pilot-native navigation, focus, type, Send, and Stop
  actions. Lifecycle observation and readiness markers remain in browser `eval`,
  but no longer mutate the composer or invoke button handlers directly.
- Added the reusable contenteditable typing adapter to the Pilot browser
  prelude. It uses the browser editing path and preserves native Pilot clicks.
- Added a stable `session-composer-stop-button` selector to the production
  composer and source contracts preventing the scenario from returning to
  label-based button discovery or direct `.click()` calls.
- Kept workspace recovery on the atomic `runtime_prepare_workspace` contract;
  the old raw engine-start plus orchestrator-activate race is not reintroduced.
- Pilot artifacts are owned by one `packages/e2e/.pilot-runs/<run-id>/` root,
  include manifest/heartbeat state, launch logs, traces, per-scenario results,
  and failure diagnostics. Retention keeps ten recognized terminal runs only.
- Added XML-aware JUnit redaction. It preserves test-suite/test-case structure
  and valid quoted attributes while replacing failure/error/system-output
  diagnostics and private attributes with XML-safe markers. JSON and line-log
  redaction retain their existing compact diagnostic representation.

## Live Evidence

### Passing VSLO-270 production-path run

Run `20260717T124000100Z-vslo-270-stop-reload-reconnect-8a2e1ab8` used
`authMode: live-den`, the retry and skill-registry fixtures required by that
scenario, and no managed-AI gateway fixture.

- Main scenario: 19/19 Pilot steps passed in 48.651 s.
- Relaunch scenario: 4/4 Pilot steps passed in 17.822 s.
- The real Pilot flow navigated, typed, clicked Send, observed the runtime,
  clicked Stop, and completed the relaunch.
- A single clean-start `orchestrator activate -> fresh start` recovery was
  recorded by `runtime_prepare_workspace`. It is the intended atomic recovery
  when no daemon exists yet, not the removed raw port/start race.

### Normal live-send evidence: real incident, not a test fallback

Both normal runs used `authMode: live-den` and no fixtures.

- Run `20260717T124448185Z-message-send-registry-degraded-ffc55388` reached
  the real native Send click (19/20 steps) but failed closed during runtime
  authorization. The local server recorded four upstream `502` responses from
  `GET /api/me/ai-access`; the UI restored the draft with
  `session_creation_failed`.
- Run `20260717T125020292Z-message-send-registry-degraded-298e26d6` reached a
  submitted session and an assistant SSE update, then failed its final response
  check after 150.044 s (19/20 steps, command duration 160.017 s). The
  run-owned server trace recorded six real
  `/providers/codex_oauth/v1/chat/completions` attempts: three upstream `502`
  responses followed by three upstream `402` responses. Its lifecycle remained
  `running` for 145 reconciliation polls and did not emit a terminal result.

The second finding is a production lifecycle/provider incident to fix at the
server/AI-Gateway boundary. The Pilot scenario deliberately does not replace
it with a fixture, cache bypass, artificial success, or shortened assertion.
The run artifacts contain the redacted request ids, timings, lifecycle state,
and failure probes needed for that owner-level follow-up.

## Artifact Lifecycle Evidence

- A harness-interrupted run with a dead local owner PID was left intact until
  its 120 s heartbeat lease expired. Standard reconciliation marked it
  `abandoned` with `owner-process-not-alive`; no live process or fresh run was
  removed.
- The two verified isolated child processes of that interrupted run were
  stopped only after matching their expected executable name, temporary Pilot
  profile marker, and owned port. No unverified process was terminated.
- Standard retention then removed only the oldest recognized terminal run and
  left exactly ten run directories. Invalid, active, and root-level unowned
  `.pilot-runs/` artifacts were not touched.

## Verification

```powershell
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm --test helpers/pilot-redaction.test.ts helpers/pilot-runner.test.ts
# passed: 62/62

pnpm --filter @neatech/veslo-e2e typecheck
# passed

pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm --test helpers/pilot-run-store.test.ts
# passed: 3/3

pnpm --filter @neatech/veslo-e2e run build:desktop:e2e
# passed before the live VSLO-270 acceptance run

pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario vslo-270-stop-reload-reconnect
# passed: main 19/19, relaunch 4/4, authMode=live-den
```

The two normal live scenarios above were intentionally retained as failing
production evidence. They are not a passing latency baseline.

## Status

Implemented and locally verified for native Pilot interaction, bounded
per-run artifacts, stale-run safety, and valid redacted JUnit output. The
remaining live provider/lifecycle failure is precisely diagnosed but not
claimed resolved in this checkpoint.
