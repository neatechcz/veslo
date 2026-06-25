# VSLO-250 Fix Implementation Plan

Last audit date: 2026-06-25

Status: audit complete, implementation not started.

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

- [ ] DONE=false Change app managed AI bridge requirement to use effective
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

- [ ] DONE=false Add a pure decision helper for managed AI bridge requirement.
  - Candidate shape:
    `requiresManagedAiBridgeForRuntime({ configuredBackend, effectiveBackend, childKind, workspaceType, isDesktopRuntime })`.
  - Expected outputs:
    - configured WSL + `childKind=wsl` => require bridge
    - configured WSL + `childKind=null` => require bridge
    - configured WSL + `childKind=direct` => do not require bridge
    - non-WSL or remote workspace => do not require bridge
  - Keep URL normalization separate: a URL being absent must not decide whether
    the bridge is required.

- [ ] DONE=false For WSL sandbox routing, make
  `resolveManagedAiProviderRoutingTarget()` return `null` when `requireEngineBaseUrl`
  is true and `engineBaseUrl` is missing or loopback.
  - The function already has most of this branch; the bug is that callers often
    pass `requireEngineBaseUrl=false` when no bridge URL was published.

- [ ] DONE=false Replace the current loopback fallback unit test.
  - Replace:
    `resolveManagedAiProviderRoutingTarget keeps loopback fallback when WSL bridge URL is absent`
  - With:
    `resolveManagedAiProviderRoutingTarget rejects WSL sandbox routing without a non-loopback engine URL`
  - Keep a separate direct/non-WSL test proving loopback remains valid outside
    WSL sandbox runtime.

- [ ] DONE=false Add a send/readiness regression test proving that managed AI
  bootstrap blocks before session creation when the target WSL runtime has no
  usable engine bridge URL.
  - Candidate files:
    - `packages/app/src/app/tests/context/send-runtime-readiness.test.ts`
    - `packages/app/src/app/tests/app-managed-ai-bootstrap-gate.test.ts`
  - Expected result: precise managed gateway setup error, no optimistic
    prompt submit.

- [ ] DONE=false Add a cold-start regression test.
  - Input: configured sandbox backend `windows-wsl2`, target local workspace,
    `childKind=null`, no `engineUrl`.
  - Expected result: provider routing is unavailable and no loopback managed AI
    config is considered usable or written.
  - This test is load-bearing for the first prompt after clean install.

### Phase 2: Publish a WSL-Reachable Engine URL Without Broad External Bind

- [ ] DONE=false Run a short bridge mechanism spike before choosing Option A/B/C.
  - The implementation choice is the highest-risk part of VSLO-250.
  - The spike must answer:
    - whether Windows Defender Firewall prompts when binding only to the WSL
      virtual adapter IP
    - whether the machine is using WSL NAT networking or mirrored networking
    - whether `127.0.0.1` is reachable from `VesloSandbox` in mirrored mode
    - whether a WSL adapter IP exists and remains stable enough for a listener
    - whether a TCP bridge preserves streaming AI gateway responses

- [ ] DONE=false Decide and implement the bridge mechanism.
  - Preferred direction: keep the primary `veslo-server` bind on
    `127.0.0.1:8787`, and add a bridge listener bound only to the WSL virtual
    adapter IP, for example `172.x.x.1:8787`.
  - Avoid making `0.0.0.0` the normal clean-install default.
  - If WSL mirrored networking makes Windows loopback reachable from
    `VesloSandbox`, the bridge resolver may accept loopback only after a WSL
    `/health` probe proves it. Do not assume mirrored networking from Windows
    version alone.

- [ ] DONE=false Choose the implementation layer.
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

- [ ] DONE=false Compute and validate the WSL bridge URL during desktop server
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

- [ ] DONE=false Publish `VesloServerInfo.engineUrl` only after WSL can reach
  `engineUrl/health`.
  - Do not publish loopback as `engineUrl`.
  - Do not publish an unprobed non-loopback URL.
  - Re-probe periodically because WSL interface addresses can change after
    sleep, reboot, WSL restart, or VPN/network transitions.

- [ ] DONE=false Preserve the existing UI/client route.
  - `VesloServerInfo.baseUrl` should remain `http://127.0.0.1:8787` for local
    desktop control traffic.
  - `engineUrl` should be used only for OpenCode runtime provider config and
    runtime config validation.

### Phase 3: Wire Managed AI Config to the Bridge

- [ ] DONE=false Ensure `managed-ai-config-sync` writes provider gateway base
  URLs with `providerRoutingTarget.engineBaseUrl`.
  - This is already mostly present in `packages/app/src/app/app.tsx`.
  - The important fix is to make the target unavailable until `engineBaseUrl`
    is WSL-reachable when the runtime is actually WSL.

- [ ] DONE=false Ensure `hasUsableManagedAiRuntimeConfigForSend()` validates
  against the WSL engine URL for WSL runtimes.
  - A config using `http://127.0.0.1:8787` must not be considered usable for a
    WSL child runtime.
  - A direct fallback runtime may still accept loopback.

- [ ] DONE=false Refresh or rewrite stale loopback managed config when the
  bridge URL becomes available.
  - This handles machines that previously failed once and left a bad
    `opencode.jsonc` provider URL behind.
  - The semantic config comparison must treat loopback vs engine bridge URL as
    a meaningful difference.

- [ ] DONE=false Debounce and make bridge-driven config rewrites idempotent.
  - WSL IP can change after sleep, reboot, WSL restart, VPN changes, or
    networking mode changes.
  - Re-probe should not thrash `opencode.jsonc` or repeatedly reload runtime
    config while a run is active.
  - Expected behavior: rewrite only when the validated effective engine gateway
    origin changes, batch repeated probes, and defer destructive reloads during
    active sends.

### Phase 4: Startup and Error UX

- [ ] DONE=false Keep the existing managed AI bootstrap wait path, but make its
  blocking reason precise.
  - Existing `waitForManagedAiBootstrapReady()` has a 180s default timeout and
    waits for bootstrap/reload/client recovery.
  - That helps startup races, but it cannot fix a wrong URL. Missing bridge URL
    should be a distinct trace reason.

- [ ] DONE=false Add send trace fields that make the failure layer obvious.
  - Include:
    - configured sandbox backend
    - effective backend
    - child kind
    - `requiresEngineBridgeUrl`
    - `baseUrl` present/origin
    - `engineUrl` present/origin
    - provider routing target present
    - bridge probe status/reason

- [ ] DONE=false Avoid creating UI pending state when managed AI routing is
  known to be unavailable for the target runtime.
  - The expected user-facing state is "runtime/gateway setup still starting" or
    a precise setup error, not generic `Odeslani selhalo`.

### Phase 5: Tests and Verification

- [ ] DONE=false App unit tests.
  - `packages/app/src/app/tests/lib/ai-access.test.ts`
  - `packages/app/src/app/tests/lib/runtime-sandbox-state.test.ts`
  - `packages/app/src/app/tests/context/send-runtime-readiness.test.ts`
  - `packages/app/src/app/tests/app-managed-ai-bootstrap-gate.test.ts`

- [ ] DONE=false Desktop Rust tests.
  - Keep a test proving the normal desktop server default does not become broad
    `0.0.0.0`.
  - Add a test proving a loopback primary server can still publish a validated
    WSL bridge `engineUrl` once the bridge listener is available.
  - Add a test proving no `engineUrl` is published when WSL probe fails.
  - Add fixtures for NAT and mirrored WSL networking discovery, where possible
    without depending on the host machine's actual networking mode.

- [ ] DONE=false Server tests if multi-bind is implemented in
  `packages/server`.
  - Verify both loopback and WSL bridge listeners use the same auth model.
  - Verify streaming gateway responses still work.
  - Verify shutdown closes both listeners.

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
