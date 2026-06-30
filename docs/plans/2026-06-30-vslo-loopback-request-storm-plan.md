---
title: VSLO Loopback Request Storm KISS Fix Plan
date: 2026-06-30
status: implemented_and_validated_current_source
done: true
source_issue: YouTrack showstopper - WebView polling exhausts local 8787 sockets
---

# VSLO Loopback Request Storm KISS Fix Plan

## Goal

Stop the Windows desktop WebView from producing enough short-lived requests to
`http://127.0.0.1:8787` that local sockets are exhausted and send preflight
fails on:

```text
error sending request for url (http://127.0.0.1:8787/workspace/ws-.../config)
```

The fix must keep the app honest: no fake green status when the server is truly
down, and no bypass of managed-AI config or authorization checks.

## Evidence To Preserve

- `veslo-server.exe` stayed alive; this is not primarily a server crash loop.
- There was one listening socket on 8787 and roughly 13.5k-13.9k `TIME_WAIT`
  connections involving that port.
- `Get-NetTCPConnection` attributed the established client side to
  `msedgewebview2`, so the pressure came from the desktop UI/WebView path.
- The visible failure happened before model/orchestrator work, while reading
  `/workspace/:id/config`.
- The checkout and sidecar metadata are consistently `2026.6.26`; if the
  validation line expected `6.29`, that is a separate release metadata/artifact
  question.

## Five Findings

### 1. Transport has no shared local Veslo request broker

The modular client already gives us one narrow place to intervene:
`packages/app/src/app/lib/veslo-server/transport.ts`.

Existing request dedupe exists in feature-specific places, but not at the shared
Veslo server transport boundary. The first fix should therefore be transport
level and small: coalesce identical in-flight JSON GETs and expose counters.

Do not add a priority queue or global concurrency cap until baseline data proves
single-flight and status/backoff are insufficient.

### 2. Status polling treats one transient socket failure as disconnected

The desktop status loop calls `/health` and then `/capabilities`. A single
transport failure currently turns the UI red, clears stable capabilities, and
switches into a faster disconnected retry cadence.

The KISS fix is a tiny helper around the live status loop:

- remember the last connected/limited result
- keep that visible state through a small number of transient failures
- preserve cold-start retries when there has never been a success
- keep real repeated failures visible as disconnected

Do not revive unused stores or build a new scheduler.

### 3. Send preflight depends on `/workspace/:id/config`

Managed-AI send readiness reads workspace config before model/orchestrator work
starts. Under loopback socket pressure that can fail the send even when the
server and orchestrator are alive.

The KISS fix is narrow:

- retry only this send-critical config read
- retry only local loopback transport/socket failures
- retry only when the server was recently reachable
- use 1-2 short jittered retries
- keep HTTP status/auth/config errors as real failures

### 4. The storm is cumulative, not one obvious isolated poller

Likely contributors include status, workspace/config sync, skill inventory,
MCP, soul, session archive/sidebar refreshes, diagnostics, and workspace list
reconciliation. A stale dev-profile workspace in production state can multiply
some fan-out, but it does not explain a 14k `TIME_WAIT` storm by itself.

Validation also found a non-WebView contributor: the desktop native
debug-log forwarder could repeatedly post the same pending debug-log file to
local `/debug-logs` when the local server accepted the batch but cloud upload
was disabled. That path was not the original WebView evidence, but it used the
same 8787 listener and inflated idle `TIME_WAIT`, so the final KISS fix trims
accepted local-only batches and retains only direct-fallback diagnostics.

Follow-up cleanup should target measured top contributors only. No broad
polling rewrite in the first patch.

### 5. Diagnostics exist but need idle acceptance evidence

Startup request audit already exists and should remain the primary request-rate
evidence source. The missing acceptance evidence is Windows desktop idle socket
sampling over time.

The mandatory gate is:

- run desktop idle for 10 minutes
- sample `netstat` / `Get-NetTCPConnection` around port 8787
- record request counters and top endpoints
- capture workspace count and stale dev-profile state

## KISS Implementation Plan

### Phase 0: Baseline Gate

Status: completed

- 10-minute Windows desktop idle run.
- Socket sampling around `:8787`.
- Request audit/counter snapshot.
- Workspace/dev-profile state captured.

This is not optional paperwork. It decides whether Phase 4 is needed.

### Phase 1: Transport GET Single-Flight And Counters

Status: implemented

- Add a small transport helper for JSON request counters.
- Coalesce identical in-flight GETs by method, full URL, timeout, and auth
  headers.
- Do not coalesce mutations, multipart, binary, or raw response consumers.
- Do not add a concurrency cap yet.

Expected effect: simultaneous `/health`, `/capabilities`, `/workspaces`, and
`/workspace/:id/config` readers join an existing in-flight request instead of
opening another socket.

### Phase 2: Status Stability Helper

Status: implemented

- Apply hysteresis directly in the live status polling effect.
- Keep recent connected/limited state through up to two transient failures
  inside a 30s grace window.
- Keep cold-start disconnected retry capped at 5s.
- Back off repeated post-success failures up to 30s.

Expected effect: one Windows socket allocation miss no longer flips the UI red
or increases status retry pressure.

### Phase 3: Send-Critical `/config` Retry

Status: implemented

- Wrap only the managed-AI send preflight config read.
- Retry only loopback transport/socket errors.
- Require recent server reachability.
- Use at most two short jittered retries.
- Trace retry attempts for diagnostics.

Expected effect: a send does not fail immediately when it collides with a
transient local socket pressure window.

### Phase 4: Measured Follow-Up Only

Status: one measured follow-up implemented; broad cleanup still deferred

The 10-minute idle probe before the native forwarder cleanup already passed the
"not thousands" gate, but still showed more `TIME_WAIT` than the WebView broker
could explain. The measured follow-up was limited to the debug-log forwarder:
when local `/debug-logs` accepts a batch while cloud upload is disabled, drop
non-direct local events and keep only direct-fallback diagnostics for direct
delivery. This avoids repeatedly posting the same accepted local-only events to
8787.

Possible follow-ups, gated by measured top contributors:

- targeted refresh coalescing for a specific noisy feature
- stale workspace cleanup or profile migration
- endpoint-specific backoff
- request budget/concurrency cap for local Veslo origin
- deeper Tauri/Rust transport pooling investigation if request count is low but
  `TIME_WAIT` still grows quickly

Explicitly out of the first patch:

- app-wide mini scheduler
- priority queue
- broad feature cleanup epic
- hiding disconnected forever behind stale status

## Acceptance Criteria

- After a 10-minute Windows desktop idle run, port 8787 does not accumulate
  thousands of loopback `TIME_WAIT` sockets.
- Status stays green/limited while `/health` is reachable and capabilities are
  recently known.
- Send during normal polling does not fail on
  `/workspace/:id/config` due to local socket allocation pressure.
- Targeted tests cover GET single-flight, status hysteresis, and send config
  retry guardrails.
- Any remaining heavy endpoint is listed by counter evidence before Phase 4 is
  opened.

## Validation Run

Code validation completed on 2026-06-30:

- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-request-broker.test.ts src/app/tests/lib/veslo-server-status-stability.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/app-send-preflight-context.test.ts`
- `pnpm --filter @neatech/veslo-ui typecheck`
- `git diff --check`

Additional validation completed after self-review:

- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-request-broker.test.ts src/app/tests/lib/veslo-server-status-stability.test.ts src/app/tests/lib/veslo-server.test.ts src/app/tests/app-send-preflight-context.test.ts src/app/tests/app-local-veslo-server-ensure.test.ts`
- `pnpm --filter @neatech/veslo-ui test:health`
- `pnpm --filter @neatech/veslo-ui build`
- `pnpm --filter @neatech/veslo exec tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e`
- `pnpm --filter @neatech/veslo-e2e test:pilot:smoke`
- `pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario loopback-request-broker`
- `E2E_VESLO_SERVER_PORT=8787 pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario loopback-request-broker-idle`
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml debug_logs_forwarder`
- `pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e`

Short desktop idle socket sample:

- runtime: fresh Tauri E2E debug build, isolated E2E profile, local server forced
  to `127.0.0.1:8787`
- duration: about 24 seconds of idle after WebView render
- sampling cadence: 2 seconds via `Get-NetTCPConnection`
- maximum observed connections involving port 8787: 33
- maximum observed `TIME_WAIT`: 32
- no growth toward hundreds or thousands during the smoke window

Self-review follow-ups applied:

- coalesced JSON GET responses are cloned per caller so single-flight does not
  change the old "one JSON parse result per request caller" object identity
  expectation.
- desktop smoke waits for `#root > *` instead of checking children immediately
  after `#root` exists.
- native debug-log forwarding no longer retries local-only accepted batches
  forever when cloud upload is disabled.

Full Windows desktop idle socket validation:

- command:
  `$env:E2E_VESLO_SERVER_PORT='8787'; $env:E2E_LOOPBACK_STORM_DURATION_MS='600000'; $env:E2E_LOOPBACK_STORM_SAMPLE_INTERVAL_MS='10000'; $env:E2E_LOOPBACK_STORM_OUTPUT='C:\Users\jajse\Desktop\projekty\veslo\docs\sandbox\loopback-request-storm-10min-final.json'; pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./scripts/loopback-request-storm-smoke.ts`
- runtime: Tauri E2E debug build, isolated E2E profile, local server forced to
  `127.0.0.1:8787`
- duration: 10 minutes
- samples: 56
- maximum observed connections involving port 8787: 80
- maximum observed `TIME_WAIT`: 79
- maximum observed `ESTABLISHED`: 2
- final samples were stable around 63-65 `TIME_WAIT`, not growing toward
  thousands
- broker snapshot: `started=166`, `completed=152`, `failed=14`,
  `coalesced=5`, `inFlight=0`
- `/health`: 61 completed, 0 failed
- `/capabilities`: 60 completed, 0 failed
- `/workspace/ws-ef57f20e8102/config`: 21 completed, 0 failed
- the 14 broker failures were `GET /ai-gateway/me/ai-access` in the isolated
  fixture/no-auth setup, not loopback socket exhaustion

Close state:

- The socket-storm acceptance criteria are satisfied in the current-source
  Windows Tauri E2E desktop runtime.
- The send-critical `/workspace/:id/config` path was exercised repeatedly
  during normal idle polling and had zero failures.
- A literal model send with real installed profile credentials was not run in
  this isolated fixture, because model/auth availability is a separate
  environment dependency.
- Installed 6.29 package validation and the `6.29` versus `2026.6.26` metadata
  question remain release QA follow-ups, not blockers for the source fix.
