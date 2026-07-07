# Manual Runtime Click Send Stability Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or execute this plan task-by-task. Keep the critical remediation order strict through Task 6; Task 7 is deferred cleanup.

**Goal:** Stabilize the manual Tauri Pilot click-send path by fixing the confirmed post-submit runtime blockers instead of masking them with timeouts.

**Architecture:** Server-owned submit already works: OpenCode accepted `/prompt_async` and Veslo returned submit success in about one second. The blocker starts after prompt acceptance, so this plan focuses on sidecar/runtime recursion, honest readiness/auth states, managed-AI config churn, and receive correlation.

**Tech Stack:** TypeScript/Solid app, Bun server tests, Node desktop scripts, Tauri sidecars, OpenCode managed AI gateway, Windows manual Tauri Pilot runtime.

## Global Constraints

- Do not raise provider-start timeouts as the fix.
- Do not start another manual runtime until Task 1 and Task 2 are done.
- Do not edit generated `packages/desktop/src-tauri/target/debug` output directly.
- Do not log bearer tokens, host tokens, gateway tokens, or raw model bodies.
- Keep queue drain, lifecycle wake-up, broad E2E, and workflow migrations out of this plan unless new evidence makes them causal.
- Treat Task 7 as non-blocking cleanup. Do not delay the critical runtime gate on Task 7 unless a remaining symptom blocks send/receive after Tasks 1-6.

## Source Evidence

- Primary runtime audit: `docs/dev/2026-07-07-manual-runtime-click-send-audit.md`
- Second-agent business audit: `docs/dev/2026-07-07-send-receive-business-blocker-deep-audit.md`
- Runtime logs: `dev-specific/tauri-pilot/manual-runtime-20260707-130824-clicking-pilot-logs/`
- Dev logs: `.codex/dev-logs/pnpm-dev-clicking-pilot-20260707-130824.*.log`

Key measured facts:

- `/prompt_async` accepted in about `0.73s`.
- App returned `server-submit-first-success` in about `1.1s`.
- Provider-start watchdog timed out at about `30.8s`.
- Real model provider POST started at about `57.6s`.
- Transcript completed at about `70.2s`.
- `chrome-devtools-mcp.exe` process recursion and later dev fast-fail were observed.

## Second-Agent Evaluation Updates

The second audit changes the remediation priorities:

- Keep Chrome DevTools MCP shim recursion as P0.
- Promote managed-AI config healing churn from diagnostic noise to P1 because it runs during runtime admission.
- Treat skill materialization false-ready and registry 401 retry loop as P1 for skill/command sends.
- Add gateway chat-completion session correlation as P1 latent: current run succeeded through OpenCode `x-session-id`, but normal chat completions must not silently forward a literal `${OPENCODE_SESSION_ID}` through sessionless fallback.
- Keep queue drain/lifecycle wake-up outside this plan; current evidence shows prompt acceptance, provider success, terminal lifecycle, and transcript persistence.

## Priority Table

| Priority | Finding | Fix direction | Acceptance |
| --- | --- | --- | --- |
| P0 | Chrome DevTools MCP shim recursion | Honor forwarded vendored `.js` entrypoints such as `telemetry/watchdog/main.js` instead of always importing MCP `index.js`. | Watchdog invocation imports watchdog, process count stays bounded. |
| P0 | Stale sidecars/processes | Force rebuild sidecars and clean repo-owned orphan processes before runtime. | No stale `veslo-*` or recursive `chrome-devtools-mcp.exe` processes before launch. |
| P1 | Skill materialization false-ready | If registry is configured and status is pending/reload-required, sync failure is not ready. | Runtime admission does not log `skills-ready true` after failed required sync. |
| P1 | Registry event 401 loop | Stop polling on 401/403 and force local server client reacquisition. | One auth-invalid report, no infinite 401 polling. |
| P1 | Managed-AI config churn | During send/runtime admission, sync only target workspace and defer inactive healing. | No broad inactive workspace config patch loop during send. |
| P1 latent | Chat-completion session correlation | Keep OpenCode `x-session-id` fallback, but fail closed for normal chat completions if no real session can be resolved. | No normal chat completion enters `sessionless-forward` with literal `${OPENCODE_SESSION_ID}`. |
| Deferred | Composer detached selection | Guard `addRange()` against detached editor refs. | UI focus no longer throws after first-send handoff. |
| Deferred | Trace/debug clarity | Rename noisy trace classes and debug-log messages only after critical runtime behavior is stable. | Cleanup does not change send/receive semantics. |

## Task 1: Fix Chrome DevTools MCP Shim Recursion

**Files**

- `packages/desktop/scripts/chrome-devtools-mcp-shim.ts`
- `packages/desktop/scripts/chrome-devtools-mcp-shim.test.mjs`
- Optional helper: `packages/desktop/scripts/chrome-devtools-mcp-shim-invocation.mjs`

**Problem**

Upstream `chrome-devtools-mcp` starts its watchdog with `spawn(process.execPath, [watchdog/main.js, ...])`. In Veslo, `process.execPath` is the shim executable. The shim ignores the forwarded JS entrypoint and imports MCP `index.js`, so watchdog becomes another MCP server and can recurse.

**Fix**

- Detect when argv contains an existing `.js` entrypoint under the vendored `chrome-devtools-mcp-package`.
- If present, import that JS file and rewrite `process.argv` to match normal Node semantics.
- Inject `--isolated` only for normal MCP entrypoint runs, not watchdog entrypoint runs.

**Tests**

Add focused tests proving:

- `chrome-devtools-mcp.exe <vendored>/build/src/telemetry/watchdog/main.js --parent-pid=123` resolves to that watchdog file.
- Normal `chrome-devtools-mcp` still resolves to vendored `build/src/index.js` and injects `--isolated` when no explicit browser profile arg exists.

Run:

```powershell
pnpm --filter @neatech/veslo exec node --test scripts/chrome-devtools-mcp-shim.test.mjs
```

## Task 2: Force Rebuild And Clean Runtime State

**Files**

- `packages/desktop/scripts/cleanup-dev-processes.mjs`
- `packages/desktop/scripts/cleanup-dev-processes.test.mjs`

**Fix**

- Verify cleanup catches repo-owned `veslo-orchestrator.exe`, `veslo-code.exe`, `veslo-server.exe`, and `chrome-devtools-mcp.exe` from `sidecars` or `target/debug`.
- Include command lines that reference `chrome-devtools-mcp-package` so recursive watchdog children are cleaned.
- Rebuild sidecars after Task 1.

Run:

```powershell
pnpm --filter @neatech/veslo exec node --test scripts/cleanup-dev-processes.test.mjs
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD = "1"; pnpm --filter @neatech/veslo run prepare:sidecar; Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
pnpm --filter @neatech/veslo run dev:cleanup
```

Pre-runtime process check:

```powershell
Get-CimInstance Win32_Process -Filter "name = 'chrome-devtools-mcp.exe'" |
  Where-Object { $_.ExecutablePath -like '*\veslo\packages\desktop\src-tauri\*' } |
  Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine
```

Expected: no rows before launch.

## Task 3: Make Skill Materialization Readiness Honest

**Files**

- `packages/app/src/app/context/workspace-skill-materialization.ts`
- `packages/app/src/app/tests/context/workspace-skill-materialization-sync.test.ts`

**Problem**

Runtime traces showed `registryConfigured=true`, `status=pending`, `reloadRequired=true`, then `skip:unsupported-server`, then `skills-ready true`. That is false readiness for configured registry workspaces.

**Fix**

- Preserve old-server permissive behavior only when materialization status cannot be read or registry is not configured.
- If status was read and says configured plus pending/reload-required, failed sync returns `false`.
- Surface the concrete sync status/message in connection state and trace as `failed:configured-sync`.

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-skill-materialization-sync.test.ts
```

## Task 4: Stop Registry Event Polling On 401/403

**Files**

- `packages/app/src/app/lib/skill-registry-events.ts`
- `packages/app/src/app/context/skill-registry-orchestrator.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/tests/lib/skill-registry-events.test.ts`
- `packages/app/src/app/tests/context/skill-registry-orchestrator.test.ts`

**Problem**

`/v1/skill-registry-events` 401 is treated like any HTTP error. The listener keeps its stale key/token and polls again.

**Fix**

- Add an auth-specific error or callback for 401/403.
- Stop the listener on auth-invalid.
- Reset orchestrator listener key.
- Use the existing app-level callback only: add `ensureLocalVesloServerRunning?: (options?: { requireRuntimeChainReady?: boolean }) => Promise<boolean>` to `SkillRegistryOrchestratorDeps`, pass it from `app.tsx` in the `createSkillRegistryOrchestrator({ ... })` call, and call `deps.ensureLocalVesloServerRunning?.({ requireRuntimeChainReady: false })` after stopping the stale listener.
- Report a single `skills.registry.events.auth` error without exposing token values.

**Tests**

- Listener-level test: a 401/403 response stops the listener, preserves cursor, and does not schedule another poll.
- Orchestrator test: `onUnauthorized` stops the listener, clears the listener key, reports `skills.registry.events.auth`, and calls `ensureLocalVesloServerRunning` exactly once with `{ requireRuntimeChainReady: false }`.
- App wiring test/source assertion: the `createSkillRegistryOrchestrator` call in `packages/app/src/app/app.tsx` passes `ensureLocalVesloServerRunning` rather than introducing a new reacquire mechanism.

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/skill-registry-events.test.ts src/app/tests/context/skill-registry-orchestrator.test.ts
```

## Task 5: Gate Managed-AI Config Healing During Active Send

**Files**

- `packages/app/src/app/context/managed-ai-runtime-config.ts`
- `packages/app/src/app/lib/opencode.ts`
- `packages/app/src/app/tests/context/managed-ai-runtime-config.test.ts`

**Problem**

The audited run had broad config churn during startup/send: many `apply-gateway-provider-routing` and `managed-config-compare` events across active and inactive workspaces. This can keep reload/config state moving while runtime admission is trying to settle.

**Fix**

- During send preflight/runtime admission, sync only the target workspace.
- Skip inactive workspace healing while `sendPromptInFlight()` or `anyActiveRuns()` is true.
- Add `configSource`, `configPath`, `workspaceId`, and `readAt` to config compare traces.
- After a successful project/server config write, update the known snapshot so the next compare does not keep reporting stale `matches=false`.

**Failing test acceptance**

- `healInactiveManagedAiWorkspaceConfigs()` with `sendPromptInFlight() === true` or `anyActiveRuns() === true` must not call `vesloClient.listWorkspaces()`, `vesloClient.getConfig()`, or `vesloClient.patchConfig()`.
- Two consecutive active workspace config syncs after one successful write must produce only one write/patch. The second sync must classify the config as current, not produce another stale `managed-config-compare` with `matches=false` for the same `configSource`, `configPath`, and `workspaceId`.
- Trace assertions must prove the second sync includes `configSource`, `configPath`, `workspaceId`, and `readAt`, so stale snapshots are debuggable if this regresses.

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/managed-ai-runtime-config.test.ts src/app/tests/lib/provider-routing.test.ts
```

## Task 6: Fail Closed For Unresolved Normal Chat Completions

**Files**

- `packages/server/src/server.ts`
- `packages/server/src/ai-gateway-runtime-owner.ts` only if owner evidence type changes
- `packages/server/src/tests/server.ai-gateway.test.ts`
- `packages/server/src/tests/ai-gateway-runtime-owner.test.ts` only if owner interface changes

**Problem**

The successful run resolved a real session through OpenCode `x-session-id` while `x-veslo-session-id` remained `${OPENCODE_SESSION_ID}`. If that fallback header is missing or ambiguous, normal chat completions can lose receive correlation or enter sessionless fallback.

**Fix**

- Keep OpenCode `x-session-id` fallback.
- This task is intentionally narrow: apply the fail-closed rule to normal `/providers/*/v1/chat/completions` requests requiring a session. Do not broaden to other provider write/read endpoints in this plan unless new test evidence shows they carry active conversation responses.
- For those chat-completion requests, reject unresolved/sessionless placeholder forwarding with `400 gateway_session_unresolved`.
- Reserve sessionless fallback for explicitly sessionless endpoints.
- Split traces:
  - `server:ai-gateway:access-check` for `/api/me/ai-access`
  - `server:ai-gateway:model-provider-hit` for real provider requests
- Only record provider-start watchdog evidence for model provider requests with a resolved session.

Run:

```powershell
pnpm --filter veslo-server exec bun test src/tests/server.ai-gateway.test.ts src/tests/ai-gateway-runtime-owner.test.ts
```

## Task 7: Deferred Cleanup - Low-Risk UI And Diagnostic Noise

**Files**

- `packages/app/src/app/components/session/composer.tsx`
- `packages/app/src/app/tests/components/session/composer-send-intent.test.ts`
- `packages/app/src/app/context/session-selection-controller.ts`
- `packages/app/src/app/tests/context/session-selection-controller.test.ts`
- `packages/desktop/src-tauri/src/debug_logs_forwarder.rs`

**Fixes**

- This task is not part of the critical blocker remediation gate. Run it only after Tasks 1-6 and the first clean manual runtime gate, or if one of these symptoms remains disruptive during verification.
- Guard composer `focusEditorEnd()` with `editorRef.isConnected` and `document.contains(editorRef)` before `selection.addRange(range)`.
- Rename policy DB transcript reads separately from true offline fallback, for example `db-transcript-read:*` vs `offline-transcript-fallback:*`.
- Clarify debug-log forwarding messages so local acceptance without cloud upload does not look like app failure.
- Add redacted model request body shape metrics only if provider-start diagnosis still needs it after P0/P1 fixes.

Run focused checks for touched files:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/composer-send-intent.test.ts src/app/tests/context/session-selection-controller.test.ts
pnpm --filter @neatech/veslo exec node --test scripts/tauri-config.test.mjs
```

## Final Manual Runtime Gate

Run this after Tasks 1-6 pass. Task 7 is not required before this gate unless its symptom still blocks manual verification.

1. Rebuild and clean:

```powershell
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD = "1"; pnpm --filter @neatech/veslo run prepare:sidecar; Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
pnpm --filter @neatech/veslo run dev:cleanup
```

2. Start dev:

```powershell
pnpm --filter @neatech/veslo dev
```

3. User sends one trivial prompt, for example `ahoj`.

4. Required evidence:

- `/prompt_async` accepts in under 2 seconds.
- Model provider POST starts before the 30 second provider-start watchdog.
- No recursive `chrome-devtools-mcp.exe` chain.
- No infinite `skill-registry-events` 401 loop.
- No `skills-ready true` after configured required materialization sync failure.
- Normal chat completions either resolve a real session or fail with `gateway_session_unresolved`; they do not enter `sessionless-forward` with `${OPENCODE_SESSION_ID}`.
- Composer detached `addRange()` console error is absent or recorded as deferred cleanup if send/receive is otherwise stable.
- Sidebar skill/MCP state appears without the previous roughly 70 second wait.
- Dev runtime does not fast-fail after response.

Append the measured runtime directory, send trace id, prompt acceptance latency, provider POST start latency, response completion latency, Chrome MCP process count, and any remaining console errors to `docs/dev/2026-07-07-manual-runtime-click-send-audit.md`.

## Out Of Scope

- Timeout increases.
- Broad queue UI or durable queue migration.
- Replacement workflow cleanup.
- Full E2E expansion.
- Removing the OpenCode `x-session-id` fallback entirely.
- Deleting registry/materialization support because it is noisy.
