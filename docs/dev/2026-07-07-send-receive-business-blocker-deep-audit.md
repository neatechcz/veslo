# Send/Receive Business Blocker Deep Audit

Date: 2026-07-07
Scope: causal blockers for basic prompt send and assistant receive. No E2E work.
Source audit: `docs/dev/2026-07-07-manual-runtime-click-send-audit.md`

## Executive Summary

The server-owned submit route is not the observed blocker. In the manual runtime, the first send reached OpenCode `/prompt_async` and the server returned `submitted` in about one second. The blocker window begins after OpenCode accepted the prompt: the AI gateway provider request did not start for 30 seconds, then finally started about 57 seconds after acceptance, succeeded, and the transcript was persisted.

The strongest causal blocker is the packaged `chrome-devtools-mcp` shim recursion. It can consume the local runtime while OpenCode is trying to start MCP/tooling, delaying provider start and destabilizing the app after the response. Secondary blockers are false-ready skill materialization, stale registry polling with invalid server credentials, broad managed-AI config churn during runtime admission, and fragile gateway session resolution through OpenCode fallback headers.

## Finding 1 - P0: Chrome DevTools MCP Shim Runs Watchdog Entrypoints As MCP Entrypoints

Status: confirmed root-cause candidate and highest priority blocker.

Causal chain:

1. Upstream `chrome-devtools-mcp` telemetry starts its watchdog by spawning `process.execPath` with a direct JavaScript file argument.
2. In a normal Node process, `process.execPath <watchdog/main.js>` runs the watchdog.
3. In the Veslo sidecar, `process.execPath` is `chrome-devtools-mcp.exe`, which is the Veslo shim.
4. The shim ignores the forwarded `.js` entrypoint and always imports the main MCP `build/src/index.js`.
5. The watchdog process becomes another MCP server process; that process starts another watchdog; the chain repeats.
6. OpenCode/runtime startup becomes saturated around MCP/tooling, provider start is delayed, and the dev runtime later dies.

Evidence:

- Upstream watchdog spawn uses `process.execPath`: `packages/desktop/src-tauri/target/debug/chrome-devtools-mcp-package/build/src/telemetry/watchdog-client.js:32`.
- Veslo shim resolves only its own package main entrypoint and imports that result: `packages/desktop/scripts/chrome-devtools-mcp-shim.ts:32`, `packages/desktop/scripts/chrome-devtools-mcp-shim.ts:58`.
- Current shim tests only assert vendoring/no direct npm import; no test covers `process.execPath <watchdog-main.js>` behavior: `packages/desktop/scripts/chrome-devtools-mcp-shim.test.mjs:18`.
- Runtime trace timed out waiting for the provider request: `dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/send-workflow-trace.ndjson:500`.
- The actual model call only appeared later and succeeded: `dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/send-workflow-trace.ndjson:581`.
- OpenCode emitted `MaxListenersExceededWarning` shortly after the run: `dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/opencode-health.ndjson:53`.
- The dev shell exited with Windows fast-fail-style status `3221226505`: `.codex/dev-logs/pnpm-dev-clicking-pilot-20260707-130824.out.log:85`.

Business impact:

- First prompt can appear "accepted" while the user waits around a minute for the model to actually start.
- MCP/skill sidebar state can arrive late or incomplete.
- After the response, the app can lose the live client and fall into offline transcript mode, making the next send/receive cycle unreliable.

Stop rule:

- Fix this before timeout tuning. Timeout increases would hide the primary symptom while process recursion remains active.

## Finding 2 - P1: Skill Materialization Gate Can Report Runtime Ready After A Failed Required Sync

Status: confirmed policy bug in current code.

Causal chain:

1. The app checks skill materialization before local runtime startup.
2. Runtime evidence shows `registryConfigured=true`, `status=pending`, and `reloadRequired=true`.
3. The sync call then hits the unsupported/failure branch.
4. The gate returns `true` anyway.
5. `workspace-runtime` records `ensure-engine:skills-ready` and continues runtime admission with skills not actually current.

Evidence:

- Runtime evidence: `skip:unsupported-server` immediately followed by `ensure-engine:skills-ready`: `dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/send-workflow-trace.ndjson:12`, `dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/send-workflow-trace.ndjson:13`, repeated at lines `154-155` and `233-234`.
- The gate reads materialization status and traces registry state: `packages/app/src/app/context/workspace-skill-materialization.ts:92`.
- The 404 branch returns ready: `packages/app/src/app/context/workspace-skill-materialization.ts:149`, `packages/app/src/app/context/workspace-skill-materialization.ts:154`.
- Skill-registry classified errors also return ready: `packages/app/src/app/context/workspace-skill-materialization.ts:157`, `packages/app/src/app/context/workspace-skill-materialization.ts:169`.
- The current characterization test explicitly locks "degrade without blocking runtime start": `packages/app/src/app/tests/context/workspace-skill-materialization-sync.test.ts:79`.

Business impact:

- Plain text prompt can still succeed, but skill/command sends can run with stale or missing materialized skills.
- The UI can show MCP/skills as partly ready while the active workspace is actually pending reload/materialization.
- This can turn a send into "accepted but tool/skill unavailable" or "assistant starts without expected tool context".

Suggested remediation direction:

- Keep non-configured servers permissive.
- When `registryConfigured=true` and status is `pending` or `reloadRequired=true`, failed sync should be degraded/not-ready for send admission, not `skillsReady=true`.

## Finding 3 - P1: Registry Event 401 Polling Has No Credential-Reacquire Path

Status: confirmed behavior, secondary blocker for skill/command send.

Causal chain:

1. Browser/runtime logs show `/v1/skill-registry-events` returning 401.
2. The event listener converts any non-OK response to `Error("HTTP <status>")`.
3. The orchestrator forwards that to `reportError`.
4. The listener remains running and will poll again on the same key unless the server client/token accessor changes.
5. Pending registry updates and replays can remain stale.

Evidence:

- Manual audit observed `GET /v1/skill-registry-events?... 401 Unauthorized`: `docs/dev/2026-07-07-manual-runtime-click-send-audit.md:33`, `docs/dev/2026-07-07-manual-runtime-click-send-audit.md:130`.
- Listener reports HTTP failures but has no auth-specific stop/reacquire path: `packages/app/src/app/lib/skill-registry-events.ts:97`, `packages/app/src/app/lib/skill-registry-events.ts:132`, `packages/app/src/app/lib/skill-registry-events.ts:140`.
- Orchestrator only reports listener errors: `packages/app/src/app/context/skill-registry-orchestrator.ts:248`.
- Listener identity includes the token fingerprint, but a stale client object with stale token keeps the same listener key: `packages/app/src/app/context/skill-registry-orchestrator.ts:55`, `packages/app/src/app/context/skill-registry-orchestrator.ts:65`, `packages/app/src/app/context/skill-registry-orchestrator.ts:195`.

Business impact:

- Not the direct cause of the 70 second provider delay.
- Can block correct skill inventory refresh/materialization after a server restart or token generation change.
- Can compound Finding 2 by leaving the app believing stale skill state is acceptable.

Suggested remediation direction:

- On 401/403, stop the poller, invalidate the Veslo server client, and force client reacquisition.
- Do not keep polling indefinitely with a known-invalid bearer token.

## Finding 4 - P1: Managed-AI Config Healing Churns Across Workspaces During Runtime Admission

Status: confirmed runtime load and likely contributor to unstable runtime readiness.

Causal chain:

1. Startup/send warmup triggers active config sync plus inactive workspace healing.
2. The inactive healer iterates every local workspace, reads config, compares desired managed-AI routing, and patches when mismatch is detected.
3. Runtime evidence shows 59 provider-routing applications and 48 config comparisons in this manual run.
4. The active workspace alone was touched 31 times.
5. Repeated `matches=false` after config writes keeps reload/config churn alive while runtime and send are settling.

Evidence:

- Inactive healer iterates all local workspaces: `packages/app/src/app/context/managed-ai-runtime-config.ts:1178`, `packages/app/src/app/context/managed-ai-runtime-config.ts:1239`.
- Active/send config sync functions also run independently: `packages/app/src/app/context/managed-ai-runtime-config.ts:927`, `packages/app/src/app/context/managed-ai-runtime-config.ts:936`.
- Config compare trace is emitted by the shared comparison helper: `packages/app/src/app/lib/opencode.ts:368`.
- Runtime aggregation from `send-workflow-trace.ndjson`: `apply-gateway-provider-routing:start` = 59, `managed-config-compare` = 48; active workspace `ws-a8910abb29ff` = 31 provider-routing starts.
- Manual audit flags stale compare after current file write: `docs/dev/2026-07-07-manual-runtime-click-send-audit.md:313`.

Business impact:

- This is not the direct submit blocker, but it can delay runtime readiness and produce unnecessary reload-required state during send.
- It increases the odds that OpenCode/tooling starts under changing config, which makes provider start and skill readiness harder to stabilize.

Suggested remediation direction:

- During send admission, limit config sync to the target workspace.
- Move inactive healing to an idle queue and suppress it while a send is in flight.
- Add `configSource`, `configPath`, and `readAt` to compare traces so stale snapshots can be isolated.

## Finding 5 - P1 Latent: Gateway Session Correlation Depends On OpenCode Fallback Headers

Status: observed as working in this run, but still a business-critical latent blocker.

Causal chain:

1. Managed OpenCode config writes `x-veslo-session-id: ${OPENCODE_SESSION_ID}`.
2. In the actual provider request, the incoming Veslo session header was still the literal template.
3. The server resolved the real session through OpenCode's `x-session-id` fallback header.
4. If OpenCode stops sending that fallback header, or active-run context is ambiguous/unregistered, the server can either raise `gateway_session_unresolved` or enter `sessionless-fallback`.
5. In `sessionless-fallback`, watchdog evidence is not recorded and the literal placeholder can be forwarded upstream.

Evidence:

- Runtime provider request resolved via `opencode-session-header`: `dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/send-workflow-trace.ndjson:581`.
- Server reads OpenCode's `x-session-id` as fallback: `packages/server/src/server.ts:1919`.
- Server can throw `gateway_session_unresolved`: `packages/server/src/server.ts:2002`.
- Sessionless fallback disables watchdog hit recording: `packages/server/src/server.ts:2047`.
- Tests intentionally accept sessionless fallback and `watchdogHitRecorded=false`: `packages/server/src/tests/server.ai-gateway.test.ts:542`, `packages/server/src/tests/server.ai-gateway.test.ts:555`.
- Runtime owner tests show ambiguous active-run context falls to `sessionless-fallback`: `packages/server/src/tests/ai-gateway-runtime-owner.test.ts:62`.

Business impact:

- Current run succeeded, so this is not the present delay root cause.
- It can become a hard receive blocker if the provider call cannot be correlated to the active run/session or if upstream rejects the placeholder.
- It can hide provider-start watchdog evidence exactly when the user needs it for "accepted but no response" cases.

Suggested remediation direction:

- Keep the OpenCode header fallback, but fail closed for normal managed model calls when no real session can be resolved.
- Reserve `sessionless-fallback` for known sessionless endpoints, not chat completions for an active conversation.
- Add a route/runtime regression that omits `x-session-id` for a normal chat completion and asserts a clear failure instead of silent placeholder forwarding.

## Not Current Blocker Findings

- Server-owned submit route: not the bottleneck in this run. Submit succeeded quickly; the delay starts after OpenCode prompt acceptance.
- Queue drain and lifecycle wake-up: current code has focused tests and the manual run reached terminal lifecycle/transcript persistence.
- Composer `addRange()` detached selection: real UI bug, but not a send/receive business blocker for model start or transcript persistence.
- Offline transcript naming: confusing trace taxonomy, but the first `offline-transcript-fallback` was policy-driven DB read with a live client; the later one was after runtime loss.

## Recommended Order

1. Fix and test the `chrome-devtools-mcp` shim watchdog entrypoint handling.
2. Rebuild sidecars and clean orphan dev runtime processes.
3. Change skill materialization gate policy for configured/pending/reload-required workspaces.
4. Add 401/403 stop-and-reacquire behavior for skill-registry events.
5. Gate inactive workspace managed-AI config healing behind idle/no-send state.
6. Tighten chat-completion session resolution so placeholder/sessionless fallback cannot silently pass active conversation sends.

## Non-E2E Verification Targets

- Shim unit test: `chrome-devtools-mcp.exe <vendored>/build/src/telemetry/watchdog/main.js --parent-pid=...` imports that exact file, not MCP `index.js`.
- App unit/contract test: configured skill registry with pending/reload-required plus failed sync returns not-ready for send/runtime admission.
- App unit test: registry event 401 stops listener and triggers Veslo server client reacquisition.
- Server unit test: normal chat completion with `${OPENCODE_SESSION_ID}` and no `x-session-id` does not enter sessionless placeholder forwarding.
- Focused trace assertion: provider start for a trivial prompt happens before the provider-start watchdog timeout once shim recursion is gone.
