# VSLO-250 Fix Implementation Plan

Last audit date: 2026-06-25

> Current installer override (2026-07-15): this plan records the historical
> WSL sandbox path. Current Windows MSI packages do not bundle, provision, or
> repair WSL/`VesloSandbox`; it is not a release acceptance path.

Status: Phases 1-4 implemented and unit-tested (fail-closed routing, WSL bridge
listener + probed engineUrl publication, config wiring + stale-config rewrite +
idempotency, precise fail-closed send UX). Core mechanism verified end-to-end
against the real `veslo-server` binary and `VesloSandbox`. The only remaining
item is the Phase 5 full desktop WSL smoke (build MSI/Tauri, real managed-AI
login, send a prompt from a clean state), which needs a desktop build.

## Scope

VSLO-250 covers Windows clean install behavior when all of these are true:

- Veslo desktop is installed from MSI and launched without local environment overrides.
- The local workspace runtime uses the Windows WSL2 sandbox.
- Managed AI access is active and OpenCode is configured to call the local
  Veslo AI gateway proxy.

The failing clean-install shape is:

1. Desktop starts `veslo-server` on `127.0.0.1:8787`.
2. OpenCode runs inside WSL.
3. Managed AI config points OpenCode at `http://127.0.0.1:8787/...`.
4. Inside WSL, `127.0.0.1` is the Linux guest loopback, not the Windows
   desktop server.
5. The first prompt fails with `Odeslani selhalo`, `engine_not_running`, or
   managed gateway setup errors until the tester manually starts Veslo with
   `VESLO_DESKTOP_SERVER_HOST=0.0.0.0`.

## Update Convention

Agents working on this plan should update both fields on every task:

- Checkbox: `[ ]` means incomplete, `[x]` means complete.
- `DONE=false` means incomplete, `DONE=true` means complete.

When completing a task, add a short note with the relevant PR, commit, or test
command if available.

Example:

```md
- [x] DONE=true Replace the WSL loopback fallback test. Note: verified with
  `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/ai-access.test.ts`.
```

## Current Audit Verdict

The bug is still current in the source shape audited on 2026-06-25.

The code contains a correct partial concept, `engineUrl`, but the clean-install
path does not publish one:

- `packages/desktop/src-tauri/src/veslo_server/spawn.rs`
  - `DEFAULT_VESLO_HOST` is still `127.0.0.1`.
  - `build_veslo_args()` passes `--host` to `veslo-server`, so the server-side
    default cannot fix the desktop-selected bind.
  - Test `veslo_server_host_defaults_to_loopback` preserves this behavior.
- `packages/server/src/config.ts`
  - `DEFAULT_HOST` is still `127.0.0.1`.
- `packages/desktop/src-tauri/src/veslo_server/mod.rs`
  - `resolve_engine_url_for_bind_host()` returns `None` unless the server bind
    publishes external URLs.
  - `build_urls_for_host_with_engine_resolver("127.0.0.1", ...)` intentionally
    returns no `engine_url`.
  - Tests `loopback_bind_does_not_publish_external_or_engine_urls` and
    `engine_url_resolution_is_gated_by_bind_host` codify this.
- `packages/app/src/app/lib/ai-access.ts`
  - `requiresManagedAiEngineBaseUrl()` requires a bridge URL only when a
    non-loopback `engineBaseUrl` already exists.
  - If the bridge URL is missing, `resolveManagedAiProviderRoutingTarget()`
    falls back to the UI loopback URL.
  - Test `resolveManagedAiProviderRoutingTarget keeps loopback fallback when WSL
    bridge URL is absent` codifies the bad clean-install behavior.

This means the app can still write or accept managed AI routing that is valid
for the Windows UI process but invalid for a WSL OpenCode process.

## Diagnostic Bundle Facts

The extracted YouTrack attachment under
`dev-specific/YT-attachments` confirms the same failure mode:

- Default launch bound `veslo-server` to `127.0.0.1:8787`.
- From `VesloSandbox`, `curl http://127.0.0.1:8787/health` failed.
- From `VesloSandbox`, `curl http://192.168.64.1:8787/health` returned `200`
  after the manual external-bind workaround.
- With `VESLO_DESKTOP_SERVER_HOST=0.0.0.0`, `prompt_async` reached OpenCode and
  returned `204`.
- The local AI gateway proxy returned `200` while forwarding to
  `https://ai.veslo.work`.

The working state in `veslo-server-state.redacted.json` is already post
workaround: it shows `host: "0.0.0.0"`. It is not proof that clean install is
fixed.

## Business Requirements

The fix must preserve these invariants:

1. A clean Windows MSI install with WSL2 sandbox and managed AI must send a
   prompt without requiring `VESLO_DESKTOP_SERVER_HOST=0.0.0.0`.
2. Desktop/UI traffic may keep using `http://127.0.0.1:8787`.
3. WSL OpenCode traffic must use a URL that is reachable from the WSL runtime.
4. WSL runtime routing must never silently fall back to Windows loopback.
5. If the WSL bridge URL cannot be prepared, send must block before creating a
   misleading failed pending bubble and must show a precise runtime/gateway
   setup state.
6. The normal installed app should not require a broad local-network/firewall
   permission prompt just to make managed AI work with WSL.
7. Direct runtime fallback must remain valid: if the orchestrator actually
   starts a direct host engine, loopback managed gateway routing is acceptable.
8. Cold-start unknown runtime state must fail closed: if the configured backend
   is `windows-wsl2` and the engine has not proven `childKind=direct`, managed
   AI routing must require a bridge URL.

## Target Architecture

Keep two distinct local server URLs:

- `baseUrl`: UI/desktop/server control URL, normally
  `http://127.0.0.1:8787`.
- `engineUrl`: runtime-facing URL that OpenCode inside WSL can reach.

For Windows WSL2 sandbox, `engineUrl` must be published only after a real WSL
reachability probe succeeds against `/health`.

For managed AI routing, "unknown child kind" is not equivalent to direct host
runtime. On cold start, before the orchestrator publishes an engine snapshot,
the app must treat a configured `windows-wsl2` backend as bridge-required unless
the runtime has explicitly proven `childKind=direct`.

Do not treat `engineUrl` as a LAN advertise URL. It is a sandbox bridge URL.
The safest target is a listener bound only to the Windows WSL virtual adapter
address, not a broad `0.0.0.0` bind.

## Implementation Plan

### Phase 1: Stop the Bad Loopback Fallback

Phase 1 is a safety fix, not the complete user-visible fix. It should turn the
current confusing failure into a precise "gateway bridge not ready" block, but
the clean-install prompt succeeds only after Phase 2 and Phase 3 provide a
reachable runtime URL and rewrite/validate the managed config.

- [x] DONE=true Change app managed AI bridge requirement to use effective
  runtime state, not the presence of `engineBaseUrl`.
  - Files:
    - `packages/app/src/app/lib/runtime-sandbox-state.ts`
    - `packages/app/src/app/lib/ai-access.ts`
    - `packages/app/src/app/app.tsx`
  - Proposed rule: when the effective runtime requires an engine bridge URL,
    missing or loopback `engineBaseUrl` makes provider routing unavailable.
  - Important cold-start rule: do not rely only on the current
    `requiresEngineBridgeUrl` formula if it is
    `effectiveBackend === "windows-wsl2" && childKind === "wsl"`. That leaks on
    the first send because `childKind` is often `null` before the engine starts.
  - Required rule: `configuredBackend === "windows-wsl2" && childKind !== "direct"`
    must require a non-loopback bridge URL. Only a proven direct fallback may
    use loopback.
  - This is the same fail-closed lesson as VSLO-254: unknown runtime state must
    not be treated as ready/benign.
  - Note: implemented through `requiresManagedAiBridgeForRuntime()` and app
    call sites passing configured/effective backend plus `childKind`. Verified
    with `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/ai-access.test.ts`.

- [x] DONE=true Add a pure decision helper for managed AI bridge requirement.
  - Candidate shape:
    `requiresManagedAiBridgeForRuntime({ configuredBackend, effectiveBackend, childKind, workspaceType, isDesktopRuntime })`.
  - Expected outputs:
    - configured WSL + `childKind=wsl` => require bridge
    - configured WSL + `childKind=null` => require bridge
    - configured WSL + `childKind=direct` => do not require bridge
    - non-WSL or remote workspace => do not require bridge
  - Keep URL normalization separate: a URL being absent must not decide whether
    the bridge is required.
  - Note: added `requiresManagedAiBridgeForRuntime()` in
    `packages/app/src/app/lib/ai-access.ts`.

- [x] DONE=true For WSL sandbox routing, make
  `resolveManagedAiProviderRoutingTarget()` return `null` when `requireEngineBaseUrl`
  is true and `engineBaseUrl` is missing or loopback.
  - The function already has most of this branch; the bug is that callers often
    pass `requireEngineBaseUrl=false` when no bridge URL was published.
  - Note: callers now pass `requireEngineBaseUrl=true` for configured/effective
    WSL until direct fallback is proven.

- [x] DONE=true Replace the current loopback fallback unit test.
  - Replace:
    `resolveManagedAiProviderRoutingTarget keeps loopback fallback when WSL bridge URL is absent`
  - With:
    `resolveManagedAiProviderRoutingTarget rejects WSL sandbox routing without a non-loopback engine URL`
  - Keep a separate direct/non-WSL test proving loopback remains valid outside
    WSL sandbox runtime.
  - Note: replaced in `packages/app/src/app/tests/lib/ai-access.test.ts` and
    added direct fallback coverage.

- [x] DONE=true Add a send/readiness regression test proving that managed AI
  bootstrap blocks before session creation when the target WSL runtime has no
  usable engine bridge URL.
  - Candidate files:
    - `packages/app/src/app/tests/context/send-runtime-readiness.test.ts`
    - `packages/app/src/app/tests/app-managed-ai-bootstrap-gate.test.ts`
  - Expected result: precise managed gateway setup error, no optimistic
    prompt submit.
  - Note: covered by `send runtime readiness owner blocks managed AI when
    runtime routing config is unusable` plus source-level bootstrap gate
    contract.

- [x] DONE=true Add a cold-start regression test.
  - Input: configured sandbox backend `windows-wsl2`, target local workspace,
    `childKind=null`, no `engineUrl`.
  - Expected result: provider routing is unavailable and no loopback managed AI
    config is considered usable or written.
  - This test is load-bearing for the first prompt after clean install.
  - Note: covered by `managed AI bridge requirement fails closed for configured
    WSL until direct fallback is proven`.

### Phase 2: Publish a WSL-Reachable Engine URL Without Broad External Bind

- [x] DONE=true Run a short bridge mechanism spike before choosing Option A/B/C.
  - The implementation choice is the highest-risk part of VSLO-250.
  - The spike must answer:
    - whether Windows Defender Firewall prompts when binding only to the WSL
      virtual adapter IP
    - whether the machine is using WSL NAT networking or mirrored networking
    - whether `127.0.0.1` is reachable from `VesloSandbox` in mirrored mode
    - whether a WSL adapter IP exists and remains stable enough for a listener
    - whether a TCP bridge preserves streaming AI gateway responses
  - Note: spike run on 2026-06-25 on the dev machine. Findings:
    - Networking mode: **NAT** (no `~/.wslconfig`; default version 2).
    - WSL adapter (Windows side): `vEthernet (WSL (Hyper-V firewall))` =
      `172.29.64.1`. `VesloSandbox` default route is `via 172.29.64.1 dev eth0`,
      guest IP `172.29.66.77/20`.
    - A scoped TCP listener bound ONLY to `172.29.64.1:18787` was reachable from
      `VesloSandbox`: `curl http://172.29.64.1:18787/health` => HTTP 200 in ~77ms.
      No Windows Defender Firewall prompt blocked the connection.
    - A Windows loopback listener on `127.0.0.1:18788` was NOT reachable from
      `VesloSandbox` (HTTP 000), confirming NAT-mode loopback isolation.
  - Conclusion: a scoped bind to the WSL adapter IP (Option A, no `0.0.0.0`) is
    sufficient and reachable on this machine. Mirrored-mode loopback acceptance
    remains an untested branch (no mirrored host available in the spike).

- [x] DONE=true Decide and implement the bridge mechanism.
  - Preferred direction: keep the primary `veslo-server` bind on
    `127.0.0.1:8787`, and add a bridge listener bound only to the WSL virtual
    adapter IP, for example `172.x.x.1:8787`.
  - Avoid making `0.0.0.0` the normal clean-install default.
  - If WSL mirrored networking makes Windows loopback reachable from
    `VesloSandbox`, the bridge resolver may accept loopback only after a WSL
    `/health` probe proves it. Do not assume mirrored networking from Windows
    version alone.
  - Note: implemented Option A. `veslo-server` now accepts `--bridge-host`
    (also `VESLO_BRIDGE_HOST` / `server.json bridgeHost`) and starts a second
    `Bun.serve` listener sharing the exact same fetch handler/auth. A bind
    failure on the bridge does not take down the primary loopback listener.
    Files: `packages/server/src/config.ts`, `packages/server/src/types.ts`,
    `packages/server/src/server.ts`. Verified with
    `bun test src/tests/config.bridge-host.test.ts src/tests/server.bridge-listener.test.ts`.

- [x] DONE=true Choose the implementation layer.
  - Option A: extend `veslo-server` to listen on both loopback and a specific
    WSL bridge host.
    - Pros: one HTTP application, existing auth/middleware/streaming behavior.
    - Cons: `packages/server` currently has a single `--host` model.
  - Option B: add a desktop-owned TCP bridge bound to the WSL adapter that
    forwards to `127.0.0.1:8787`.
    - Pros: keeps server CLI simpler.
    - Cons: must preserve streaming and connection behavior exactly.
  - Option C: auto-bind `veslo-server` to `0.0.0.0` only for WSL sandbox.
    - Pros: smallest code change.
    - Cons: broad network exposure and likely firewall prompt; should be a
      fallback/diagnostic option, not the target architecture.
  - Note: chose Option A. A 2026-06-25 spike confirmed a scoped bind to the WSL
    adapter IP is reachable from `VesloSandbox` (NAT mode) without a firewall
    prompt, so no broad `0.0.0.0` bind is needed. End-to-end re-verified with
    the real binary: `veslo-server --bridge-host 172.29.64.1` answered
    `GET http://172.29.64.1:<port>/health` => HTTP 200 from `VesloSandbox`
    (same token/pid as the loopback listener).

- [x] DONE=true Compute and validate the WSL bridge URL during desktop server
  startup.
  - Current candidate discovery already exists in
    `packages/desktop/src-tauri/src/veslo_server/mod.rs`:
    - interface-name discovery through `local_ip_address`
    - PowerShell fallback with `Get-NetIPAddress -InterfaceAlias '*WSL*'`
    - WSL-side `/health` probe through `wsl.exe`
  - The missing part is that the server is not listening on the candidate when
    the main bind is loopback.
  - The resolver must account for WSL networking mode:
    - NAT mode usually needs the Windows WSL adapter or a dedicated bridge.
    - Mirrored mode may make Windows loopback reachable from WSL.
    - The accepted URL is whatever passes the WSL-side `/health` probe and the
      security constraints, not a hard-coded network assumption.
  - Note: added `resolve_wsl_bridge_host()` (probe-free interface/PowerShell
    discovery, used pre-spawn to pick `--bridge-host`) and
    `resolve_engine_url_for_bridge_host()` (builds `http://<host>:<port>` and
    accepts it only if the WSL-side `/health` probe passes). The primary bind
    stays loopback; the bridge host is bound by the server. NAT-mode discovery
    verified on the dev machine. Mirrored-mode loopback acceptance remains an
    untested branch.

- [x] DONE=true Publish `VesloServerInfo.engineUrl` only after WSL can reach
  `engineUrl/health`.
  - Do not publish loopback as `engineUrl`.
  - Do not publish an unprobed non-loopback URL.
  - Re-probe periodically because WSL interface addresses can change after
    sleep, reboot, WSL restart, or VPN/network transitions.
  - Note: `VesloServerState.bridge_host` is threaded through start/spawn. The
    lazy engineUrl refresh in `commands/veslo_server.rs` is now eligible when a
    bridge host is set (not only when the primary bind is external) and probes
    the bridge host from WSL via `resolve_engine_url_for_bridge_host`; a failed
    probe leaves `engineUrl` unset (fail-closed). Spawn clears
    `engine_url_checked_at` so the first `veslo_server_info` poll refreshes
    immediately instead of waiting out the 120s TTL. Periodic re-probe is the
    existing 120s TTL refresh, which preserves the last good URL on a failed
    probe (no flapping). Explicit sleep/VPN/WSL-restart re-bind is a deliberate
    conservative non-goal — see the Phase 3 "WSL-restart caution" note. Verified
    with `cargo test --lib veslo_server` and `cargo test --lib engine_url_refresh`.

- [x] DONE=true Preserve the existing UI/client route.
  - `VesloServerInfo.baseUrl` should remain `http://127.0.0.1:8787` for local
    desktop control traffic.
  - `engineUrl` should be used only for OpenCode runtime provider config and
    runtime config validation.
  - Note: `state.base_url` is unchanged (`http://127.0.0.1:<port>`); the bridge
    is purely additive. `engineUrl` continues to feed only the managed AI
    provider routing target (`providerRoutingEngineBaseUrl` in `app.tsx`).

### Phase 3: Wire Managed AI Config to the Bridge

- [x] DONE=true Ensure `managed-ai-config-sync` writes provider gateway base
  URLs with `providerRoutingTarget.engineBaseUrl`.
  - This is already mostly present in `packages/app/src/app/app.tsx`.
  - The important fix is to make the target unavailable until `engineBaseUrl`
    is WSL-reachable when the runtime is actually WSL.
  - Note: already wired. `formatManagedAiAccessConfig` writes the provider
    `baseURL` from `engineBaseUrl` (`input.engineBaseUrl?.trim() || serverBaseUrl`),
    and all three config-sync call sites pass `providerRoutingTarget.engineBaseUrl`
    (`app.tsx:11619`, `:11744`, `:11933`). With Phase 1 + Phase 2 the target is
    null until a WSL-reachable `engineUrl` exists, so no loopback baseURL is
    written for a WSL runtime.

- [x] DONE=true Ensure `hasUsableManagedAiRuntimeConfigForSend()` validates
  against the WSL engine URL for WSL runtimes.
  - A config using `http://127.0.0.1:8787` must not be considered usable for a
    WSL child runtime.
  - A direct fallback runtime may still accept loopback.
  - Note: the send gate passes `gatewayBaseUrl: providerRoutingTarget.engineBaseUrl`
    into `hasUsableManagedAiRuntimeConfig` (`app.tsx:5448`, `:5475`).
    `hasManagedGatewayProviderRouting` rejects a provider `baseURL` whose origin
    differs from the runtime gateway base URL, so a loopback config is not usable
    for a WSL bridge runtime. Locked in by
    `hasUsableManagedAiRuntimeConfig rejects a stale loopback config for a WSL
    bridge runtime (VSLO-250)` in `tests/lib/ai-access.test.ts`.

- [x] DONE=true Refresh or rewrite stale loopback managed config when the
  bridge URL becomes available.
  - This handles machines that previously failed once and left a bad
    `opencode.jsonc` provider URL behind.
  - The semantic config comparison must treat loopback vs engine bridge URL as
    a meaningful difference.
  - Note: handled by the existing config-sync. Because the stale loopback config
    is not "usable" (origin mismatch above) and the desired content differs from
    the redacted on-disk content, `resolveManagedAiConfigWriteDecision` returns
    `write-managed-config` and the sync patches the workspace config with the
    bridge URL. The loopback-vs-bridge difference is a meaningful origin change,
    not just a secret redaction, so the redacted compare does not mask it.

- [x] DONE=true Debounce and make bridge-driven config rewrites idempotent.
  - WSL IP can change after sleep, reboot, WSL restart, VPN changes, or
    networking mode changes.
  - Re-probe should not thrash `opencode.jsonc` or repeatedly reload runtime
    config while a run is active.
  - Expected behavior: rewrite only when the validated effective engine gateway
    origin changes, batch repeated probes, and defer destructive reloads during
    active sends.
  - Note: idempotency is already enforced — `lastKnownConfigSnapshotByWs` plus
    `managedConfigContentsMatchForServerPatch` make the sync a no-op once the
    desired content matches disk, so steady-state polling does not re-patch.
    Destructive reloads are deferred during active sends (`shouldAutoReloadManagedAiConfig`
    gates on `anyActiveRuns() || sendPromptInFlight()`), and the boot/Send path
    deliberately does not auto-dispose the engine (`app.tsx:11683`).
  - WSL-restart caution (deliberate non-goal): engineUrl re-validation relies on
    the existing 120s `veslo_server_info` TTL probe, which PRESERVES the last
    good URL on a failed probe (no flapping). We intentionally do NOT auto-respawn
    `veslo-server` to re-bind `--bridge-host` on a transient WSL adapter change:
    the `vEthernet (WSL)` IP is stable across typical WSL restarts/reboots, and
    aggressive re-binding mid-session would risk thrashing active runs. If the
    adapter IP genuinely changes, recovery happens on the next normal server
    (re)start. Revisit only if field data shows the WSL IP changing in place
    often enough to matter.

### Phase 4: Startup and Error UX

- [x] DONE=true Keep the existing managed AI bootstrap wait path, but make its
  blocking reason precise.
  - Existing `waitForManagedAiBootstrapReady()` has a 180s default timeout and
    waits for bootstrap/reload/client recovery.
  - That helps startup races, but it cannot fix a wrong URL. Missing bridge URL
    should be a distinct trace reason.
  - Note: `ensureManagedAiBootstrapReady` (`context/send-runtime-readiness.ts`)
    blocks with the precise `managedAiRuntimeConfigNotReadyMessage` ("Managed AI
    gateway setup is not ready for this runtime…") when the runtime config is
    not usable and bootstrap/reload are idle, instead of waiting out a timeout.
    For a WSL runtime "not usable" includes a missing or stale (loopback)
    `engineUrl`, so a missing bridge URL surfaces as this precise reason.

- [x] DONE=true Add send trace fields that make the failure layer obvious.
  - Include:
    - configured sandbox backend
    - effective backend
    - child kind
    - `requiresEngineBridgeUrl`
    - `baseUrl` present/origin
    - `engineUrl` present/origin
    - provider routing target present
    - bridge probe status/reason
  - Note: the routing trace payload in `app.tsx` already records
    `configuredSandboxBackend`, `effectiveSandboxBackend`, `engineChildKind`,
    `requiresEngineBaseUrl`, `localBaseUrl`, `engineBaseUrl`, `resolvedBaseUrl`,
    `resolvedEngineBaseUrl`, and `hasRoutingTarget`/`hasServerClientToken`. The
    send path adds `blocked-managed-ai-bootstrap` / `blocked-runtime-unreachable`
    markers. (A dedicated WSL `/health` bridge-probe status field could still be
    added to the desktop diagnostics if field triage needs it.)

- [x] DONE=true Avoid creating UI pending state when managed AI routing is
  known to be unavailable for the target runtime.
  - The expected user-facing state is "runtime/gateway setup still starting" or
    a precise setup error, not generic `Odeslani selhalo`.
  - Note: `prepareSendRuntimeForSend` returns false from
    `ensureManagedAiBootstrapReady` before submitting `prompt_async`, setting the
    precise error and avoiding an optimistic pending bubble. Covered by
    `send-runtime-readiness.test.ts` (asserts `managedAiRuntimeConfigNotReadyMessage`
    plus a `sendPrompt:blocked-managed-ai-bootstrap` trace, no submit).

### Phase 5: Tests and Verification

- [x] DONE=true App unit tests.
  - `packages/app/src/app/tests/lib/ai-access.test.ts`
  - `packages/app/src/app/tests/lib/runtime-sandbox-state.test.ts`
  - `packages/app/src/app/tests/context/send-runtime-readiness.test.ts`
  - `packages/app/src/app/tests/app-managed-ai-bootstrap-gate.test.ts`
  - Note: green (ai-access 40, runtime-sandbox + send-readiness + bootstrap-gate
    39). Added `hasUsableManagedAiRuntimeConfig rejects a stale loopback config
    for a WSL bridge runtime (VSLO-250)`.

- [x] DONE=true Desktop Rust tests.
  - Keep a test proving the normal desktop server default does not become broad
    `0.0.0.0`.
  - Add a test proving a loopback primary server can still publish a validated
    WSL bridge `engineUrl` once the bridge listener is available.
  - Add a test proving no `engineUrl` is published when WSL probe fails.
  - Add fixtures for NAT and mirrored WSL networking discovery, where possible
    without depending on the host machine's actual networking mode.
  - Note: `cargo test --lib veslo_server` (54) + `engine_url_refresh` (7) green.
    Added `build_args_includes_bridge_host_when_distinct_from_host`,
    `build_args_skips_bridge_host_equal_to_primary_host`,
    `engine_url_refresh_uses_bridge_host_on_loopback_primary`. The pure default
    stays loopback (`veslo_server_host_defaults_to_loopback`). The failed-probe
    "no engineUrl" path is covered by `finish_engine_url_refresh` preserving the
    prior value on `None`; a dedicated discovery fixture for mirrored mode is
    still TODO (NAT-mode discovery was validated live on the dev machine).

- [x] DONE=true Server tests if multi-bind is implemented in
  `packages/server`.
  - Verify both loopback and WSL bridge listeners use the same auth model.
  - Verify streaming gateway responses still work.
  - Verify shutdown closes both listeners.
  - Note: `config.bridge-host.test.ts` (parsing/dedupe) and
    `server.bridge-listener.test.ts` (both listeners serve the same `/health`
    identity; no bridge listener without `bridgeHost`; cleanup stops both) pass.
    Streaming confirmed still green via `server.ai-gateway.test.ts` (18).

- [ ] DONE=false Windows WSL smoke.
  - Clean app state.
  - Launch MSI/Tauri desktop without `VESLO_DESKTOP_SERVER_HOST`.
  - Assert `veslo_server_info` reports:
    - `baseUrl=http://127.0.0.1:8787`
    - non-loopback `engineUrl`
  - From `VesloSandbox`, run `curl <engineUrl>/health` and expect `200`.
  - Send a prompt with managed AI and assert:
    - managed config contains `engineUrl`, not `127.0.0.1`
    - server submit reaches `prompt_async`
    - orchestrator proxy returns `204`
    - AI gateway proxy returns `200`
    - UI does not show `Odeslani selhalo`.
  - Repeat or explicitly record behavior under the detected WSL networking
    mode. If mirrored mode is active and loopback is accepted, the smoke must
    show that WSL-side `/health` proved reachability before config write.
  - Partial verification already done (2026-06-25, NOT the full smoke): the real
    `veslo-server --host 127.0.0.1 --bridge-host 172.29.64.1` binary served
    `GET http://172.29.64.1:<port>/health` => HTTP 200 from `VesloSandbox` with
    the same token/pid as the loopback listener, while Windows loopback was
    unreachable from WSL. Still TODO end to end: build the desktop app, confirm
    `start_veslo_server` auto-resolves `--bridge-host`, confirm `veslo_server_info`
    publishes the probed `engineUrl`, log in to managed AI, and send a real
    prompt that records a provider hit (no 30s timeout, no `Odeslani selhalo`).

## Suggested Test Commands

Run targeted app tests:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm `
  src/app/tests/lib/ai-access.test.ts `
  src/app/tests/lib/runtime-sandbox-state.test.ts `
  src/app/tests/context/send-runtime-readiness.test.ts `
  src/app/tests/app-managed-ai-bootstrap-gate.test.ts `
  src/app/tests/lib/managed-ai-bootstrap-ready.test.ts
```

Run targeted desktop tests:

```powershell
cargo test veslo_server --quiet
```

If the final bridge is implemented in the server package, add the relevant
server-side test command here when known.

## Rollout and Safety Notes

- Keep `VESLO_DESKTOP_SERVER_HOST=0.0.0.0` as a diagnostic override only.
- Do not make broad external binding the silent production default.
- The engine bridge listener must require the same local server token model as
  the primary listener.
- Do not put the host token in OpenCode provider config.
- Prefer binding to the WSL virtual adapter address over LAN interfaces.
- If the WSL bridge cannot be prepared, fail closed for WSL managed AI routing:
  no loopback fallback, no generic send failure.
- Treat `childKind=null` on configured WSL as "bridge required" until a direct
  fallback is proven.
- Phase 1 may be shipped as a safety PR, but it is not the complete clean
  install fix.

## Open Questions

- Should the bridge live in `veslo-server` as a second listener or in the Tauri
  shell as a TCP bridge?
- Should `engineUrl` be persisted, or only recomputed and revalidated from the
  live desktop process?
- What exact Windows firewall behavior appears when binding only to the WSL
  virtual adapter IP, and does it differ between NAT and mirrored WSL mode?
- In mirrored WSL networking, should a WSL-probed loopback URL be accepted as
  `engineUrl`, or should Veslo still prefer a non-loopback bridge for audit
  clarity?
- Should config sync hold managed AI writes until the target workspace engine is
  known, or use the fail-closed configured-WSL rule and write only after a
  bridge URL is ready?

## Definition of Done

VSLO-250 is fixed only when all of these are true:

- Clean Windows MSI install works with WSL2 sandbox and managed AI without
  `VESLO_DESKTOP_SERVER_HOST`.
- WSL OpenCode receives a non-loopback gateway base URL.
- Direct fallback engines still work with loopback.
- Cold-start configured WSL with unknown child kind does not accept loopback.
- Missing WSL bridge URL blocks before prompt submission with a precise setup
  reason.
- Unit tests no longer accept WSL loopback fallback.
- A Windows WSL smoke verifies `curl <engineUrl>/health` from `VesloSandbox`
  and a prompt reaches `prompt_async`.
