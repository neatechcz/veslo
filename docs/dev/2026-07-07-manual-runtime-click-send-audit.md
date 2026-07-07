# Manual Runtime Click Send Audit

Date: 2026-07-07
Branch: `sandbox-merge`
Scope: manual Tauri Pilot runtime after a user-clicked first send. No new app run was started for this audit.

## Runtime Evidence

Runtime directory:

```text
dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs
```

Primary logs:

```text
.codex/dev-logs/pnpm-dev-clicking-pilot-20260707-130824.out.log
.codex/dev-logs/pnpm-dev-clicking-pilot-20260707-130824.err.log
dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/runtime-trace.ndjson
dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/send-workflow-trace.ndjson
dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/opencode-health.ndjson
```

Observed browser console symptoms:

```text
[SENDTRACE] app:createSessionAndOpen:success
[SENDTRACE] app:sendPrompt:create-session-and-open:end
[SENDTRACE] app:sendPrompt:server-submit-first-success
[SENDTRACE] composer:sendDraft:onSend:result
composer.tsx:792 addRange(): The given range isn't in document.
GET http://127.0.0.1:8787/v1/skill-registry-events?... 401 (Unauthorized)
[skills.registry.events] Error: HTTP 401
```

User-observed behavior:

- The first message response arrived after roughly 1 minute and 10 seconds.
- The sidebar showed only MCP after that delay.
- The app/dev runtime then appeared to crash.
- The user manually aborted a previous run; this audit focuses on the later first-send behavior, not the manual abort.

## Timeline

Trace id:

```text
send_bab1f775-0fa1-4c58-9a02-98c063e02a2b
```

All UTC timestamps below correspond to local Prague time +02:00.

| Relative | Time UTC | Event | Interpretation |
| --- | --- | --- | --- |
| +0.000s | 11:12:31.125 | `sendDraft:start` | User send begins. |
| +0.075s | 11:12:31.200 | `sendPrompt:create-session-needed` | First-send path creates a session. |
| +0.222s | 11:12:31.347 | `managed-ai-runtime-auth-prime:end` | Managed AI auth prime succeeded. |
| +0.563s | 11:12:31.688 | OpenCode `/session` status 200 | OpenCode session creation succeeded. |
| +0.730s | 11:12:31.855 | OpenCode `/prompt_async` status 204 | Prompt was accepted quickly. |
| +1.095s | 11:12:32.220 | `server-submit-first-success` | Client submit path returned `submitted`. |
| +30.779s | 11:13:01.904 | `ai-gateway-provider-start-watch:timeout` | No correlated provider request had started within 30s. |
| +57.563s | 11:13:28.688 | Gateway `POST /providers/codex_oauth/v1/chat/completions` starts | Actual model call starts very late. |
| +66.148s | 11:13:37.273 | Gateway POST returns 200 | Model/gateway request succeeds. |
| +69.121s | 11:13:40.246 | `run-state:reset` | UI run state resets after completion. |
| +70.174s | 11:13:41.299 | transcript ingest done | Final transcript flush completes. |

Conclusion: the server-owned submit path is not the 70 second delay. Submit was accepted in about 1 second. The delay is between OpenCode prompt acceptance and the actual AI gateway provider request.

## Primary Finding: Chrome DevTools MCP Shim Recursion

The strongest root cause candidate is a recursive process chain in the bundled `chrome-devtools-mcp` shim.

Observed process state during the audit:

- `veslo-orchestrator.exe` remained running as an orphan after the dev shell died.
- `veslo-code.exe` remained running under the orchestrator.
- Around the response window, `veslo-code.exe` spawned two `chrome-devtools-mcp --isolated` processes.
- Those processes created a long chain of `chrome-devtools-mcp.exe` children.
- A later process count showed about 101 `chrome-devtools-mcp.exe` processes.
- Subsequent process queries started timing out, consistent with local process churn.

Code path:

- `packages/desktop/scripts/chrome-devtools-mcp-shim.ts`
- `packages/desktop/src-tauri/target/debug/chrome-devtools-mcp-package/build/src/telemetry/watchdog-client.js`
- `packages/desktop/src-tauri/target/debug/chrome-devtools-mcp-package/build/src/telemetry/watchdog/main.js`

The upstream package starts the telemetry watchdog like this:

```text
spawn(process.execPath, [
  ".../telemetry/watchdog/main.js",
  "--parent-pid=...",
  "--app-version=...",
  "--os-type=..."
])
```

In a normal Node process, `process.execPath` is `node.exe`, so the JavaScript file argument runs the watchdog entrypoint.

In the Veslo packaged sidecar, `process.execPath` is `chrome-devtools-mcp.exe`, which is our shim. The shim currently resolves and imports the main MCP `index.js` entrypoint regardless of whether argv includes a direct `.js` entrypoint. That means the watchdog subprocess becomes another MCP subprocess, which starts another watchdog, and so on.

This explains all of these together:

- provider request starts only after a long delay,
- sidebar/MCP state appears late and incomplete,
- many `chrome-devtools-mcp.exe` processes remain,
- `opencode-health.ndjson` later logs `MaxListenersExceededWarning`,
- the dev runtime becomes unstable after the run.

## Secondary Finding: Provider-Start Watchdog Is Correctly Firing, But Not Root Cause

The server logs show:

```text
server:conversation-run:ai-gateway-provider-start-watch:timeout
```

This should not be interpreted as "AI gateway rejected the request". The actual gateway POST later started and returned 200.

The useful interpretation is:

```text
OpenCode accepted the prompt, but something delayed the provider call for about 57 seconds.
```

Given the concurrent Chrome MCP process recursion, MCP/runtime startup is the more likely upstream blocker than gateway auth.

## Secondary Finding: `skill-registry-events` 401

The browser repeatedly logged:

```text
GET /v1/skill-registry-events?... 401 Unauthorized
{"code":"unauthorized","message":"Invalid bearer token"}
```

Relevant code:

- `packages/app/src/app/lib/skill-registry-events.ts`
- `packages/app/src/app/context/skill-registry-orchestrator.ts`
- `packages/server/src/routes/skill-registry.ts`
- `packages/server/src/server.ts`

The app event listener uses the local Veslo server client bearer token:

```text
Authorization: Bearer <client.token>
```

The server route is client-authenticated. A 401 means the local server does not recognize that bearer token. This is likely a stale client token after a server restart/recreate, or the listener outliving the client it was created for.

Impact:

- It pollutes logs with repeated errors.
- It can leave skill registry orchestration in a degraded/stale state.
- It is not the primary explanation for the 70 second send delay, because the AI gateway auth prime and the final provider POST succeeded.

Fix direction:

- On 401/403, stop the registry event poller and force Veslo server client reacquisition.
- Do not keep polling forever with a known-invalid token.
- Add trace fields that identify the client generation/server generation without logging token values.

## Secondary Finding: Skill Materialization Gate Is Too Permissive

Runtime traces showed repeated skill materialization cycles similar to:

```text
workspace-skill-materialization:start
status: registryConfigured=true, status=pending, reloadRequired=true
skip:unsupported-server
workspace-runtime ensure-engine:skills-ready true
```

Relevant code:

- `packages/app/src/app/context/workspace-skill-materialization.ts`
- `packages/app/src/app/lib/veslo-server-domains/skills.ts`
- `packages/server/src/routes/skill-materialization.ts`
- `packages/server/src/server.ts`

The route exists in source:

```text
POST /workspace/:id/skills/materialization/sync
```

But the app handled a 404-like path as `skip:unsupported-server`, then still allowed runtime to proceed as skills-ready. That is logically wrong when the status endpoint says:

```text
registryConfigured=true
status=pending
reloadRequired=true
```

Impact:

- The sidebar can show MCP but not a healthy skill inventory.
- Runtime proceeds even though skills are not materialized.
- This can hide server/client route drift or auth mismatch.

Fix direction:

- Treat `registryConfigured=true` plus failed sync as degraded/not-ready, not `skills-ready true`.
- Log the actual sync response status/body safely.
- Distinguish unsupported older server from current server route/auth failure.

## Secondary Finding: Composer Selection Race

Console error:

```text
composer.tsx:792 addRange(): The given range isn't in document.
```

Relevant code:

```text
packages/app/src/app/components/session/composer.tsx
```

`focusEditorEnd()` creates a range over `editorRef`, removes all ranges, then calls `selection.addRange(range)`. During first-send handoff/session remount, `editorRef` can be detached from the current document.

Impact:

- This is a real UI bug.
- It is not the root cause of the 70 second delay.
- It can add noise or interrupt UI focus behavior after submit.

Fix direction:

- Guard with `editorRef.isConnected` and `document.contains(editorRef)` before range creation/use.
- Prefer focusing only the currently mounted editor after session handoff.

## Additional Finding: Gateway Provider-Hit Diagnostics Are Too Broad

The trace contains multiple `server:ai-gateway:provider-hit` events for:

```text
GET /api/me/ai-access
```

Those events have:

```text
provider=null
sessionId=null
workspaceId=null
runId=null
watchdogHitRecorded=true
```

Only the later request is the actual model call:

```text
POST /providers/codex_oauth/v1/chat/completions
```

Impact:

- The phrase `provider-hit` is overloaded. It can mean an access check, not a model provider request.
- `watchdogHitRecorded=true` on sessionless `/api/me/ai-access` requests is misleading when auditing provider-start latency.
- In this run, the access-check hits did not satisfy the active run watchdog, but the logs make the sequence harder to reason about.

Fix direction:

- Split trace names into `gateway-access-check` and `model-provider-hit`.
- Only count provider-start watchdog evidence for model provider paths or explicitly label the evidence layer.
- Include `gatewayPath` in any concise console-level provider-start warning.

## Additional Finding: Managed AI Config Sync Is Churning Across Workspaces

The trace had:

```text
59 apply-gateway-provider-routing:start
58 apply-gateway-provider-routing:done
48 managed-config-compare
```

The routing sync was not limited to the active workspace. It touched many workspace ids:

```text
ws-a8910abb29ff 31 times
other local workspaces 3-4 times each
```

The first startup request summary also showed broad config activity in the first 30 seconds:

```text
174 total startup requests
77 distinct request keys
17 POST read_opencode_config
12 POST engine_info
11 GET /workspaces
config GET/PATCH calls across multiple inactive workspaces
```

Impact:

- Boot warmup is doing broad cross-workspace config work while the active runtime is still settling.
- This increases noise around provider routing, reload-required state, and sidebar readiness.
- It can hide the actual active workspace failure under many unrelated config writes.

Fix direction:

- Gate inactive workspace healing behind idle state or a lower-priority background queue.
- During send/runtime admission, trace only the target workspace by default.
- Add per-reason counters for `active-workspace`, `send-preflight`, `boot-warmup`, and inactive healing.

## Additional Finding: Config Compare Reads A Stale Snapshot After The File Is Current

The active gamma workspace config on disk ended up at:

```text
dev-specific/multi-workspace-tauri/gamma/opencode.jsonc
bytes=1911
LastWriteTime=2026-07-07 13:12:17
```

The shared unsandboxed runtime config also ended at:

```text
%LOCALAPPDATA%/com.neatech.veslo.dev/veslo-orchestrator-dev/opencode-config/shared-unsandboxed/opencode.jsonc
bytes=1911
```

But after the active file was already written, the trace still repeatedly reported:

```text
managed-config-compare matches=false currentBytes=1843 desiredBytes=1911
```

Examples occurred after 13:12:30, 13:12:31, 13:12:32, 13:12:45, 13:13:16, 13:13:27, 13:13:40, and 13:13:45 local time.

Impact:

- At least one managed-AI config path is comparing against an old config snapshot, not the current file state.
- This causes repeated `apply-gateway-provider-routing` churn even after the desired config exists on disk.
- It can trigger unnecessary reload-required state and extra OpenCode config sync work during a run.

Fix direction:

- Add `configPath`, `configSource`, and `readAt` to `managed-config-compare` traces.
- After writing project config, refresh or invalidate the snapshot used by subsequent comparisons.
- Add a test that a second sync after a successful project config write logs `matches=true` and does not rewrite.

## Additional Finding: Session Header Resolution Depends On OpenCode Fallback Headers

For the actual model request, the server trace showed:

```text
incomingSessionId="${OPENCODE_SESSION_ID}"
sessionId="ses_0c3b86c47ffelJdmHIHuZ2T6BH"
sessionResolutionSource="opencode-session-header"
forwardedSessionHeaderMode="resolved"
```

Interpretation:

- The configured `x-veslo-session-id` model header remains the literal template.
- OpenCode also sends local session headers such as `x-session-id`.
- Veslo resolves the real session id from those OpenCode headers and rewrites the forwarded gateway session header.

This is currently handled intentionally by the server, but it is a fragile dependency.

Impact:

- If OpenCode changes or omits its local `x-session-id` header, the gateway path can fail with `gateway_session_unresolved`.
- The configured Veslo header alone does not prove session correlation works.

Fix direction:

- Keep the server fallback, but add a runtime diagnostic that states which header actually resolved the session.
- Consider writing a direct, non-template session header only when OpenCode exposes a stable interpolation mechanism.
- Keep tests covering placeholder plus `x-session-id` behavior.

## Additional Finding: Tiny User Prompt Produced An 83 KB Model Request

The model request diagnostic for the `ahoj` prompt was skipped because:

```text
contentLength=83115
skipped="content-length-too-large"
```

Impact:

- The request body is large for a trivial message. Some size is expected from system prompts, tools, and runtime context, but this should be tracked.
- Because the body diagnostic is skipped, the trace does not identify which part of the request dominates the payload.
- Large prompt context can compound startup latency when MCP/tool definitions are unstable.

Fix direction:

- Add non-sensitive request body shape metrics: message count, tool count, MCP/tool names count, system/developer/user byte buckets.
- Keep the content redacted; only log size buckets and counts.

## Additional Finding: Debug Log Forwarding Is Degraded

The dev stderr repeatedly showed:

```text
[debug-logs-forwarder] direct fallback delivery failed: HTTP 400
[debug-logs-forwarder] local debug-log post accepted without cloud upload
```

and once:

```text
[debug-logs-forwarder] direct fallback skipped: missing cloud diagnostics context
```

Impact:

- Local logs are available, but cloud diagnostics are incomplete for this run.
- Any remote/debug dashboard view would under-report the failing sequence.

Fix direction:

- Include the diagnostics context state in `runtime-info.json`.
- Make the local log say whether this is expected in manual runtime mode.

## Additional Finding: "Offline Fallback" Is Used Even With A Live Client

During the successful first-send handoff:

```text
read-policy hasClient=true browseModeOnly=false browseFromDb=true
offline-transcript-fallback:start reason="read policy"
```

Later, after the dev runtime had died:

```text
read-policy hasClient=false browseModeOnly=true
offline-transcript-fallback:start reason="client unavailable"
```

Impact:

- The first fallback is policy-driven DB browsing, not true offline recovery.
- The later fallback is genuine client unavailability.
- The identical event name makes the logs look worse than the behavior in the first case.

Fix direction:

- Split trace names, for example `db-transcript-read:start` and `offline-transcript-fallback:start`.
- Keep `client unavailable` reserved for actual lost-client cases.

## Dev Runtime Crash

`pnpm dev` stdout ended with Vite HMR updates and then:

```text
@neatech/veslo-ui dev: vite
Exit status 3221226505
```

The decimal code is:

```text
3221226505 = 0xC0000409
```

This is a Windows fast-fail style native exit, not a normal handled JavaScript exception. It happened after the assistant response had completed and after additional HMR updates:

```text
13:13:52 hmr update /src/app/app.tsx, /src/app/index.css
13:13:55 hmr update /src/app/app.tsx, /src/app/index.css
```

Interpretation:

- The app/dev shell died after the send flow, while the orchestrator/OpenCode children stayed alive.
- Later reads then saw `hasClient=false`, `browseModeOnly=true`, and `offline-transcript-fallback:start` with reason `client unavailable`.
- This explains why the app looked fallen/offline after the response.

Do not treat this crash as proof that the server-owned submit path is broken. The submit path had already completed.

## What Not To Fix First

Do not start by raising timeouts.

Reasons:

- `/prompt_async` returned in about 730 ms.
- The actual provider request succeeded once it finally started.
- The 30 second watchdog correctly exposed a provider-start delay.
- The local MCP process recursion is a more concrete root cause.

Do not treat the `skill-registry-events` 401 as the main send delay cause.

Reasons:

- The managed AI auth prime succeeded.
- The final gateway `POST /chat/completions` returned 200.
- The 401 endpoint is registry polling, not the model provider route.

## Recommended Fix Sequence

1. Fix `chrome-devtools-mcp` shim entrypoint handling.

   If the first forwarded argument is an existing `.js` file inside the vendored `chrome-devtools-mcp-package`, import that file instead of always importing `build/src/index.js`.

2. Add a unit test for the watchdog entrypoint case.

   The current shim test only proves vendoring and no `npm exec`; it does not prove that `process.execPath <watchdog-main.js>` behaves like Node.

3. Rebuild sidecars forcefully.

   The fixed shim must be present in `packages/desktop/src-tauri/target/debug/chrome-devtools-mcp.exe`.

4. Clean orphan runtime processes.

   Remove stale `veslo-orchestrator.exe`, `veslo-code.exe`, and `chrome-devtools-mcp.exe` from the repo target/debug lineage before the next manual runtime.

5. Re-run manual runtime once.

   Expected evidence:

   - no `chrome-devtools-mcp.exe` process explosion,
   - no late provider-start timeout for a trivial prompt,
   - gateway provider POST starts shortly after prompt acceptance,
   - sidebar skill/MCP state is available without the 70 second delay,
   - no Vite fast-fail after the run.

6. Then fix secondary issues:

   - skill registry event listener 401 recovery,
   - skill materialization readiness policy,
   - composer detached editor selection guard.

## Acceptance Checks For The Next Runtime

Use the same manual Tauri Pilot runtime logging setup.

Minimum checks:

```text
send-workflow-trace.ndjson:
  prompt_async accepted quickly
  provider POST starts quickly
  no provider-start timeout for trivial prompt

runtime-trace.ndjson:
  no repeated chrome-devtools process startup loops
  /opencode/mcp does not hang behind the model run

opencode-health.ndjson:
  no MaxListenersExceededWarning after one send

PowerShell process state:
  small bounded number of chrome-devtools-mcp.exe processes
  no parent-child chain recursion

Browser console:
  no composer addRange detached range error
  no infinite skill-registry-events 401 loop
```

## Current Confidence

High confidence:

- Server-owned submit is fast and not the 70 second bottleneck.
- Actual gateway provider POST starts late but succeeds.
- `chrome-devtools-mcp` process recursion is real and dangerous.
- The app/dev runtime dies after the run, leaving orphan orchestrator/OpenCode processes.

Medium confidence:

- Chrome MCP recursion is the main cause of delayed provider start.
- Skill materialization false-ready state explains why only MCP appears in the sidebar.

Lower confidence / needs one clean rerun after shim fix:

- Whether the Vite `0xC0000409` exit is directly caused by process pressure, HMR, WebView/native crash, or a combination.
- Whether `skill-registry-events` 401 is stale client token generation, wrong listener lifetime, or server token reset race.
