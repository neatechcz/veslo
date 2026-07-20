# VSLO-250 Root Cause and Fix Summary

Date: 2026-06-25

> Current installer override (2026-07-15): the WSL MSI path described below is
> historical. Current Windows MSI packages do not bundle, provision, or repair
> WSL/`VesloSandbox`; the supported fresh-install path is shared non-sandbox.

Status: root cause confirmed for the `AI gateway provider request did not start
within 30000ms` failure. Implementation plan is tracked separately in
`docs/dev/VSLO-250-fix-implementation-plan.md`.

## KISS Business Summary

The product rule is simple:

```text
A send may start only when the runtime that will execute OpenCode can reach the
AI provider URL written into that runtime's OpenCode config.
```

For this bug, the runtime is OpenCode inside WSL. Therefore the provider URL
must be reachable from WSL, not merely from the Windows desktop UI process.

The invariant to preserve across all layers:

```text
OpenCode provider baseURL must be runtime-facing, not UI-facing.
```

Decision table:

| Runtime state | Allowed managed AI provider URL | Send behavior |
| --- | --- | --- |
| Direct local runtime | Desktop loopback `baseUrl` is OK | Send may continue |
| Proven WSL runtime | Valid non-loopback `engineUrl` required | Send may continue only after bridge validation |
| Configured WSL, child kind unknown | Treat as WSL until proven direct | Block/retry setup; do not write loopback config |
| WSL bridge missing or failed probe | No provider URL is usable | Fail before `prompt_async` with setup error |

Non-goals:

- Do not use `0.0.0.0` as the normal clean-install default.
- Do not let the 30 s provider-start watchdog be the first detector of a known
  local routing problem.
- Do not write `127.0.0.1` into WSL OpenCode managed AI config and hope a later
  layer recovers.
- Do not treat unknown runtime state as direct/non-sandbox.

## Problem

On a clean Windows MSI install with the `windows-wsl2` sandbox and managed AI
gateway enabled, a local workspace prompt can fail even though the OpenCode
runtime eventually starts.

There are two related but distinct failure shapes:

1. Cold-start readiness failure:
   - UI shows `Odeslani selhalo`.
   - Runtime startup is still in progress or the orchestrator is not ready.
   - Example error: `engine_not_running` or `orchestrator daemon is not running`.

2. Managed AI provider-start timeout:
   - `prompt_async` reaches OpenCode and returns HTTP `204`.
   - The Veslo server then waits for OpenCode to call the managed AI gateway
     provider endpoint.
   - No provider request arrives within 30000 ms.
   - Server marks the run failed with:
     `AI gateway provider request did not start within 30000ms.`

This document focuses on the second failure. The first one still matters, but
it is a runtime readiness/cold-start issue, not the direct cause of the 30 s
provider-start timeout.

## Logs and Evidence

### YouTrack / attachment evidence

The extracted diagnostic bundle was provided under:

`C:\Users\jajse\Desktop\projekty\dev-specific\YT-attachments`

The reported environment was:

- Windows desktop MSI install.
- Veslo v2026.6.7.
- Sandbox backend: `windows-wsl2`.
- Managed AI gateway enabled.
- No manual `VESLO_DESKTOP_SERVER_HOST` override on the failing run.

Observed behavior:

- `veslo-server.exe` listened only on `127.0.0.1:8787`.
- From the `VesloSandbox` WSL distro, `127.0.0.1:8787` was not reachable.
- Starting Veslo with `VESLO_DESKTOP_SERVER_HOST=0.0.0.0` changed the server
  bind so WSL could reach the Windows host URL.
- After that override, prompts started working in the reported manual test.

Important interpretation:

- `127.0.0.1` inside WSL is the Linux guest loopback, not the Windows desktop
  process loopback.
- Therefore a provider base URL such as
  `http://127.0.0.1:8787/ai-gateway/providers/codex_oauth/v1` is valid for the
  desktop UI process, but invalid for OpenCode when OpenCode runs inside WSL.

### Manual local run on 2026-06-25

Built executable:

`C:\Users\jajse\Desktop\projekty\veslo\packages\desktop\src-tauri\target\release\veslo.exe`

Manual run directory:

`C:\Users\jajse\Desktop\projekty\veslo\.tmp\manual-ui-run-20260625-171513`

Trace file:

`C:\Users\jajse\Desktop\projekty\veslo\.tmp\manual-ui-run-20260625-171513\send-workflow-trace.ndjson`

First send:

- Prompt: `MANUAL_UI_SMOKE_1782400563095`
- UI failed with `Odeslani selhalo`.
- Trace included `sendPrompt:engine-not-started`.
- Recovery path logged that restarting the workspace runtime failed because the
  orchestrator daemon was not running.

This confirms a cold-start readiness issue, but it is not the provider-start
timeout root cause.

Second send:

- Prompt: `MANUAL_UI_RETRY_1782400640594`
- Trace id: `send_142f6634-c4fd-47d5-8255-e759cdb0e611`
- `prompt_async` reached OpenCode.
- Orchestrator proxy returned HTTP `204`.
- The workspace engine was ready and had `childKind: "wsl"`.
- The server then started
  `server:conversation-run:ai-gateway-provider-start-watch`.
- After about 30000 ms, the run failed with
  `AI gateway provider request did not start within 30000ms.`

Key trace facts:

- `server:conversation-run:opencode-submit` had `outcome: "ok"`.
- `orchestrator:proxy-upstream:done` for `prompt_async` had `statusCode: 204`.
- The only recorded `server:ai-gateway:provider-hit` events were for
  `/api/me/ai-access`.
- There was no provider hit for
  `/ai-gateway/providers/codex_oauth/v1/chat/completions`.

Runtime config for the failing workspace:

`C:\Users\jajse\AppData\Local\com.neatech.veslo\veslo-orchestrator\opencode-config\ws-5251eba6af25\opencode.jsonc`

Relevant config:

```jsonc
"model": "codex_oauth/gpt-5.5",
"provider": {
  "codex_oauth": {
    "options": {
      "baseURL": "http://127.0.0.1:8787/ai-gateway/providers/codex_oauth/v1",
      "apiKey": "{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}"
    }
  }
}
```

WSL reachability during the loopback run:

- From WSL, `http://127.0.0.1:8787/health` failed.
- From WSL, the Windows host route to `http://172.29.64.1:8787/health` timed
  out while Veslo was bound to loopback.
- From WSL, `http://127.0.0.1:60601/global/health` returned `401 Unauthorized`,
  proving the OpenCode engine existed inside the WSL network namespace.

### Workaround reachability test

A follow-up run used:

`VESLO_DESKTOP_SERVER_HOST=0.0.0.0`

Run directory:

`C:\Users\jajse\Desktop\projekty\veslo\.tmp\root-cause-hostbind-20260625-172716`

Observed server state:

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "baseUrl": "http://127.0.0.1:8787",
  "connectUrl": "http://10.83.16.180:8787",
  "lanUrl": "http://10.83.16.180:8787"
}
```

The Tauri `veslo_server_info` command later returned:

```json
{
  "baseUrl": "http://127.0.0.1:8787",
  "engineUrl": "http://172.29.64.1:8787"
}
```

WSL reachability with this bind:

- `http://172.29.64.1:8787/health` returned HTTP `200`.
- `http://10.83.16.180:8787/health` returned HTTP `200`.
- `http://127.0.0.1:8787/health` still failed from WSL, which is expected.

The prompt was not fully verified in this workaround run because the app exited
or restarted before the send attempt. The reachability test still confirms the
networking part of the root cause: when the Windows Veslo server is reachable
from WSL through a non-loopback URL, WSL can reach the managed gateway surface.

## Code Evidence

### Provider-start watchdog

`packages/server/src/server.ts`

- `hasAiGatewayProviderHitAfter()` checks whether a provider request hit was
  recorded after the send started.
- `waitForAiGatewayProviderStart()` waits up to the configured timeout.
- The conversation runner starts
  `server:conversation-run:ai-gateway-provider-start-watch` after `prompt_async`
  is submitted.
- Provider endpoints include:
  `/ai-gateway/providers/codex_oauth/v1/chat/completions`.

Because the trace has `prompt_async` status `204` but no provider hit for the
Codex OAuth provider endpoint, the timeout means OpenCode never reached the
Veslo managed AI gateway provider route.

### Managed AI routing allows loopback on WSL

`packages/app/src/app/lib/ai-access.ts`

Current behavior:

- `resolveManagedAiProviderRoutingTarget()` accepts local desktop loopback
  routing.
- It rejects missing or loopback `engineBaseUrl` only when
  `requireEngineBaseUrl` is already true.
- `requiresManagedAiEngineBaseUrl()` returns true only when a non-loopback
  `engineBaseUrl` already exists.

This is circular:

1. Clean install has no bridge `engineBaseUrl`.
2. Therefore `requiresManagedAiEngineBaseUrl()` returns false.
3. Therefore routing accepts loopback.
4. Therefore OpenCode config is written with a URL that WSL cannot reach.

### Runtime sandbox state is fail-open on cold start

`packages/app/src/app/lib/runtime-sandbox-state.ts`

Current behavior:

- `childKind` is `null` until the engine reports whether it is `wsl` or
  `direct`.
- `requiresEngineBridgeUrl` is true only when
  `effectiveBackend === "windows-wsl2" && childKind === "wsl"`.

On clean cold start:

- Configured backend is `windows-wsl2`.
- `childKind` is often still `null`.
- The app does not yet know whether the runtime will be WSL or direct.
- The current code treats that as "bridge not required".

That is the same business-logic smell as VSLO-254: unknown runtime state is
handled optimistically instead of fail-closed.

### Desktop server publishes engineUrl only for external binds

`packages/desktop/src-tauri/src/veslo_server/spawn.rs`

- `DEFAULT_VESLO_HOST` is `127.0.0.1`.

`packages/desktop/src-tauri/src/veslo_server/mod.rs`

- `resolve_engine_url_for_bind_host()` returns `None` unless the server bind
  publishes external URLs.
- `build_urls_for_host_with_engine_resolver()` returns no `engineUrl` for
  loopback binds.

This means the clean default is secure for desktop-local traffic, but it does
not produce a runtime-facing URL that a WSL process can use for managed AI.

### Existing tests codify the bad contract

`packages/app/src/app/tests/lib/ai-access.test.ts`

- Test `resolveManagedAiProviderRoutingTarget keeps loopback fallback when WSL
  bridge URL is absent` expects WSL routing to fall back to loopback when
  `engineBaseUrl` is missing.

`packages/app/src/app/tests/lib/runtime-sandbox-state.test.ts`

- The unknown child-kind case currently expects
  `requiresEngineBridgeUrl === false`.

Both expectations should be reversed for the clean-install WSL path.

## Root Cause

Immediate root cause:

OpenCode runs inside WSL but is configured to call the managed AI gateway at
`http://127.0.0.1:8787/...`. That URL points to the WSL guest loopback, not the
Windows Veslo desktop server. OpenCode therefore never reaches the provider
endpoint, and the Veslo server times out waiting for the provider request to
start.

Systemic root cause:

The app has fail-open routing logic for an unknown WSL runtime state:

- Missing bridge URL is interpreted as "bridge not required".
- Unknown `childKind` is interpreted as "bridge not required".
- Managed AI config can be written before the runtime-facing gateway route is
proven reachable from WSL.

The correct business rule is the inverse:

For a configured `windows-wsl2` sandbox, require a WSL-reachable gateway URL
until a direct non-WSL runtime is explicitly proven.

## Why `0.0.0.0` Is Not The Long-Term Fix

Binding Veslo server to `0.0.0.0` proves the diagnosis because it makes the
server reachable from WSL. It is useful as a diagnostic override.

It should not become the broad clean-install default because:

- It can expose the desktop server on LAN interfaces.
- It may trigger Windows Defender Firewall prompts.
- It changes the security posture for all users, not just WSL sandbox users.
- The UI and the WSL runtime have different routing needs; one global bind is
  too coarse.

The long-term fix should preserve loopback for the UI while providing a
separate, validated runtime-facing route for WSL.

## Correct Layering

The fix should be composed so each layer owns one decision:

1. Desktop owns gateway reachability.
   - It decides whether a WSL-reachable `engineUrl` exists.
   - It must prove that with a WSL-side health probe before publishing it.

2. Runtime sandbox state owns runtime classification.
   - `childKind === "direct"` means loopback is allowed.
   - `childKind === "wsl"` means bridge is required.
   - `childKind === null` with configured `windows-wsl2` means bridge is still
     required because direct runtime has not been proven.

3. Managed AI routing owns provider target selection.
   - For direct runtime, choose `baseUrl`.
   - For WSL runtime or unknown WSL runtime, choose validated `engineUrl`.
   - If the required URL is missing, return no routing target.

4. Config sync owns OpenCode config correctness.
   - It must write only a provider `baseURL` that the target runtime can reach.
   - It must not write or preserve loopback managed AI provider config for WSL.

5. Send preflight owns user-facing readiness.
   - If managed AI routing is not usable, block before `prompt_async`.
   - The user should see a setup/readiness state, not a failed assistant bubble
     caused by a predictable provider timeout.

6. Server provider-start watchdog owns late anomaly detection only.
   - It remains useful for unexpected provider/model failures.
   - It should not be the normal path for detecting local WSL gateway routing.

## Proposed Long-Term Solution

The implementation should follow the layering above. The important point is to
fix the business invariant first, then wire the individual code paths to obey
it.

### 1. Publish a WSL-reachable `engineUrl`

Desktop should expose two separate concepts:

- `baseUrl`: UI-facing URL, normally `http://127.0.0.1:8787`.
- `engineUrl`: runtime-facing URL that OpenCode inside WSL can reach.

For `windows-wsl2`, `engineUrl` must be published only after a real probe from
the actual WSL distro succeeds, for example `GET <engineUrl>/health`.

The bridge should prefer a scoped route over a broad global bind:

- Prefer a WSL host/gateway interface or a dedicated bridge listener.
- Avoid making `0.0.0.0` the normal default.
- Keep the same client-token/host-token security model.
- Do not write host tokens into OpenCode config.

The route must be revalidated when network state changes:

- app boot,
- WSL restart,
- sleep/resume,
- VPN changes,
- Windows network adapter changes,
- WSL NAT vs mirrored networking changes.

### 2. Make managed AI routing fail-closed for WSL

Change the rule from:

```text
require bridge only when engineBaseUrl is already non-loopback
```

to:

```text
configuredBackend == windows-wsl2 && childKind != direct => require bridge
```

That means:

- If `childKind === "wsl"`, require non-loopback, WSL-reachable `engineUrl`.
- If `childKind === null`, also require it because the runtime is not proven
  direct yet.
- Only if `childKind === "direct"` may the local loopback route be accepted.

This prevents the clean-install cold-start leak where config is written before
the WSL engine has reported its child kind.

### 3. Refuse loopback managed AI config for WSL runtimes

Managed AI config sync should not write an OpenCode provider `baseURL` pointing
at `127.0.0.1` when the effective or configured runtime path is WSL.

For WSL, the generated provider config should use:

```text
<engineUrl>/ai-gateway/providers/<providerId>/v1
```

not:

```text
<baseUrl>/ai-gateway/providers/<providerId>/v1
```

If no valid `engineUrl` is available, config sync should skip writing and
surface a precise runtime/gateway setup state.

### 4. Add a send preflight gate before `prompt_async`

The send path should validate that the current managed AI runtime config is
usable before it submits a prompt to OpenCode.

For WSL managed AI sends, "usable" means:

- `engineUrl` is present,
- `engineUrl` is non-loopback,
- `engineUrl/health` is reachable from WSL or was recently validated,
- OpenCode config for the workspace points at the same runtime-facing URL.

If this is not true, the app should fail before creating misleading pending UI
state or before submitting `prompt_async`.

The user-facing error should be specific, for example:

```text
Managed AI gateway is starting or is not reachable from the WSL runtime.
```

This is better than waiting 30 s and reporting a provider-start timeout.

### 5. Fix cold-start readiness separately

The first-send `engine-not-started` failure should be handled as a related but
separate issue:

- After starting the host/orchestrator, wait for workspace engine registration.
- Retry workspace health once the orchestrator has reported the engine.
- Do not proceed with stale readiness.
- Do not convert known runtime setup states into generic `Odeslani selhalo`.

This prevents the first prompt from failing while the runtime is merely still
booting.

## Regression Coverage

Required unit tests:

- `windows-wsl2` with `childKind: "wsl"` requires a bridge URL.
- `windows-wsl2` with `childKind: null` requires a bridge URL.
- `windows-wsl2` with `childKind: "direct"` may use loopback.
- `requiresManagedAiEngineBaseUrl()` returns true for configured WSL even when
  `engineBaseUrl` is missing.
- `resolveManagedAiProviderRoutingTarget()` returns null for WSL when the bridge
  URL is missing or loopback.
- Managed AI config generation refuses to write `127.0.0.1` provider base URLs
  for WSL runtime routing.

Required integration/smoke coverage:

- Start desktop with WSL sandbox enabled.
- Resolve or publish `engineUrl`.
- From `VesloSandbox`, verify `GET <engineUrl>/health` returns HTTP `200`.
- Send a managed AI prompt and assert:
  - OpenCode receives `prompt_async`,
  - Veslo records a provider hit for
    `/ai-gateway/providers/codex_oauth/v1/chat/completions`,
  - no `AI gateway provider request did not start within 30000ms` error occurs.

Negative coverage:

- If WSL cannot reach the gateway, the app should block before `prompt_async`
  with a precise setup error.
- It should not write loopback provider config and then wait for the 30 s
  watchdog.

## Definition of Done

The fix is complete only when all of these are true:

- A clean Windows MSI install with `windows-wsl2` sandbox can send a managed AI
  prompt without setting `VESLO_DESKTOP_SERVER_HOST=0.0.0.0`.
- OpenCode config for WSL workspaces uses a WSL-reachable `engineUrl`.
- `127.0.0.1` is not used as the managed AI provider base URL for WSL engines.
- The app fails closed while bridge setup is missing or unverified.
- Direct/non-sandbox local runtimes still use loopback normally.
- The provider-start watchdog no longer acts as the first detector for a known
  local gateway routing problem.
- Tests cover cold-start unknown `childKind`, WSL bridge absence, direct
  fallback, and provider-route reachability.
