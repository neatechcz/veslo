# Fix 14: VSLO Loopback Request Storm

## Problem

Windows desktop validation found a showstopper where Veslo could exhaust local
loopback sockets on `127.0.0.1:8787`. The visible symptom was service status
flapping between connected and unavailable while `veslo-server.exe` stayed
alive. A send could then fail before model or orchestrator work started because
the managed-AI preflight could not read:

```text
http://127.0.0.1:8787/workspace/ws-.../config
```

The captured failing machine had roughly 13.5k-13.9k connections involving
port 8787, mostly `TIME_WAIT`, with one listening server socket. Client-side
evidence pointed at the desktop WebView path rather than an external script.

## Fix

- Added a shared local Veslo request broker at the transport boundary for JSON
  GETs.
- Coalesced identical in-flight GETs while leaving mutations, multipart, raw
  responses, and distinct auth contexts untouched.
- Added request counters and an E2E-readable broker snapshot for diagnostics.
- Added status hysteresis/backoff in the live desktop status loop so one
  transient loopback socket failure does not immediately flip the app red.
- Added a narrow managed-AI send preflight retry for `/workspace/:id/config`.
  It retries only local loopback transport/socket failures, only when the
  server was recently healthy, and keeps HTTP/auth/config failures as real
  failures.
- Added a measured native follow-up for the desktop debug-log forwarder: when
  local `/debug-logs` accepts a batch while cloud upload is disabled, ordinary
  local-only events are dropped and only direct-fallback diagnostics are
  retained. This prevents accepted debug-log batches from being posted to 8787
  repeatedly.
- Added a Windows loopback storm smoke script that launches the Tauri desktop
  app, samples `Get-NetTCPConnection` around 8787, and records broker counters.
- Updated the KISS plan in
  `docs/plans/2026-06-30-vslo-loopback-request-storm-plan.md`.

## Validation

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-request-broker.test.ts src/app/tests/lib/veslo-server-status-stability.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-local-veslo-server-ensure.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml debug_logs_forwarder
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
$env:E2E_VESLO_SERVER_PORT='8787'; $env:E2E_LOOPBACK_STORM_DURATION_MS='600000'; $env:E2E_LOOPBACK_STORM_SAMPLE_INTERVAL_MS='10000'; $env:E2E_LOOPBACK_STORM_OUTPUT='C:\Users\jajse\Desktop\projekty\veslo\docs\sandbox\loopback-request-storm-10min-final.json'; pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./scripts/loopback-request-storm-smoke.ts
git diff --check
```

Result:

- UI targeted tests passed: `80 pass`, `0 fail`.
- Rust debug-log forwarder tests passed: `16 pass`, `0 fail`.
- Tauri E2E debug build passed.
- 10-minute Windows desktop idle loopback smoke passed.
- `git diff --check` passed with only line-ending warnings.

Final 10-minute socket evidence:

- max connections involving port 8787: `80`
- max `TIME_WAIT`: `79`
- max `ESTABLISHED`: `2`
- final samples held around `63-65 TIME_WAIT`
- broker snapshot: `started=166`, `completed=152`, `failed=14`,
  `coalesced=5`, `inFlight=0`
- `/health`: `61 completed`, `0 failed`
- `/capabilities`: `60 completed`, `0 failed`
- `/workspace/ws-ef57f20e8102/config`: `21 completed`, `0 failed`

The remaining broker failures were isolated-fixture
`GET /ai-gateway/me/ai-access` no-auth responses, not socket exhaustion.

## Status

The original 8787 socket-storm acceptance criteria are satisfied for the
current-source Windows Tauri E2E desktop runtime. The send-critical
`/workspace/:id/config` path was exercised during normal idle polling and did
not fail.

Release QA still needs installed-package validation for the 6.29 line and the
separate `6.29` versus `2026.6.26` metadata question.
