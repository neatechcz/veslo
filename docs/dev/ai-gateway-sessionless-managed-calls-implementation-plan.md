# AI Gateway Sessionless Managed Calls Implementation Plan

Date: 2026-06-26
Scope: local Veslo server AI Gateway proxy, Managed AI provider calls, shared engine, skill-creator failure
Overall implementation done: true
Live Tauri verification done: false

## Business Problem

Managed AI provider requests can be valid even when OpenCode does not provide a
conversation session id. The concrete failing case is skill creation through the
`skill-creator` agent.

Current failing shape:

1. Veslo writes `x-veslo-session-id: ${OPENCODE_SESSION_ID}` into generated
   provider config.
2. OpenCode 1.17.4 does not substitute that placeholder for the skill-creator
   model call.
3. OpenCode also does not attach `x-session-id` for that call.
4. The call is still authenticated with the Managed AI gateway token.
5. The local Veslo server treats missing session correlation as a hard failure
   and returns `400 gateway_session_unresolved`.

Business mistake: session correlation is being treated as a required
authorization condition. It is not. Authorization is the gateway token / caller
auth. The session id is used for correlation, diagnostics, and the
provider-start watchdog.

## Target Contract

1. A provider request must be authorized before it can be proxied.
2. A provider request should use a strong session correlation when one exists.
3. Missing OpenCode session correlation must not block authenticated
   non-conversation Managed AI calls.
4. Sessionless fallback must not satisfy a prompt watchdog for the wrong run.
5. The local desktop proxy should behave consistently with the remote AI
   gateway, which already tolerates unresolved `OPENCODE_SESSION_ID` values.

## Current Status

| Item | done | Notes |
|---|---:|---|
| Generated provider config no longer writes `x-veslo-workspace-id` | true | Current working tree sanitizes legacy workspace headers and generated config omits them. |
| Local proxy reads OpenCode `x-session-id` as a second strong correlation source | true | `resolveAiGatewaySession()` handles `openCodeSessionId` after the Veslo session header. |
| Workspace fallback is hardened against obvious cross-workspace ambiguity | true | Workspace fallback no longer blindly resolves when multiple workspace contexts are active. |
| Skill-creator/sessionless Managed AI calls are tolerated and proxied | true | The local proxy now forwards literal `${OPENCODE_SESSION_ID}` for the sessionless placeholder case instead of returning `gateway_session_unresolved`. |
| Sessionless fallback avoids satisfying unrelated prompt watchdogs | true | Sessionless fallback traces the provider request but does not record session/workspace watchdog evidence. |
| Contract tests describe the new sessionless behavior | true | The previous 400 test now asserts forwarding, placeholder preservation, stripped workspace headers, and sessionless diagnostics. |
| Active gateway run contexts are cleaned up after provider-start watch | true | Registered contexts are removed after success, timeout, or submit failure instead of waiting for TTL. |
| Same-workspace ambiguous placeholder fallback is covered | true | Regression coverage verifies two active runs in one workspace do not resolve a placeholder through workspace fallback. |
| Live Tauri app verification completed | false | Not required for this planning pass; keep as manual/release verification. |

## Implementation Plan

### 1. Keep the strong resolution order

done: true

Keep the current strong session resolution order:

1. `x-veslo-session-id`, when OpenCode substituted it.
2. `x-session-id`, when OpenCode sends its real session id.
3. Unambiguous active-run workspace fallback, only as a legacy compatibility
   path.

This path is correct for normal conversation sends and should stay strict enough
to avoid cross-workspace wrong-run attribution.

Reality check on the workspace fallback (#3): the generated provider config no
longer writes `x-veslo-workspace-id` (`packages/app/src/app/lib/opencode.ts:410-416`)
and the validation now requires it to be absent
(`packages/app/src/app/lib/ai-access.ts:214-225`). So for managed provider calls
no `x-veslo-workspace-id` reaches the gateway, which means the workspace fallback
can effectively never fire for this path - it is now inert/dead code for managed
provider traffic, not just "legacy". Consequently the VSLO-250 provider-start
watchdog now relies **entirely on session correlation** (`x-veslo-session-id`
substituted, or `x-session-id`). That is fine for normal prompts because the
provider hit carries a session that matches the registered run's
`opencodeSessionId`, but it must be protected by a regression test (see step 6.6).

Files:

- `packages/server/src/server.ts`
- `packages/server/src/tests/server.ai-gateway.test.ts`
- `packages/server/src/tests/server-conversations.test.ts`

### 2. Add an explicit sessionless forwarding outcome

done: true

Replace the current hard 400 for the "truly unresolved" case with a distinct
proxy outcome:

```ts
type AiGatewaySessionResolutionSource =
  | "veslo-session-header"
  | "opencode-session-header"
  | "workspace-active-run-context"
  | "sessionless-fallback"
  | "unresolved";
```

The sessionless fallback applies when:

- the request is already authorized,
- `x-veslo-session-id` is the literal `${OPENCODE_SESSION_ID}`,
- `x-session-id` is absent,
- no active run can be safely resolved.

The proxy should forward the request instead of returning 400.

A missing `x-veslo-session-id` header remains a setup/config error. The remote
gateway also rejects a missing session header with `missing_session_id`; its
fallback only starts when the forwarded header still contains `OPENCODE_SESSION_ID`.

KISS rule: do not invent app-side session semantics for OpenCode internals we do
not control. If OpenCode provides no session for a valid non-conversation call,
Veslo should treat that as sessionless Managed AI traffic.

### 3. Forward with deterministic fallback correlation

done: true

Choose one forwarding strategy and use it consistently:

Preferred:

- Preserve the unresolved placeholder when forwarding to the remote gateway so
  the remote gateway's existing `normalizeGatewaySessionId()` derives its
  `veslo_fallback_<provider>_<digest>` id.
- Locally record a trace-only fallback marker such as
  `sessionResolutionSource: "sessionless-fallback"`.

Acceptable:

- Derive a local fallback id with the same visible shape:
  `veslo_fallback_<provider>_<digest>`.
- Digest input should be non-secret and stable for the local actor, for example
  `actor.tokenHash + provider`. Do not include raw tokens.

Do not set an empty `x-veslo-session-id` header. Empty session ids are worse than
an explicit placeholder/fallback because they erase the reason the request was
sessionless.

Concrete code site (load-bearing):

- The upstream session header is currently overwritten unconditionally at
  `packages/server/src/server.ts:2644`:
  `headers.set(GATEWAY_SESSION_ID_HEADER, sessionId ?? "")`. For the sessionless
  case `sessionId` is `""`, so as written this forwards an **empty**
  `x-veslo-session-id` - exactly the failure mode warned about above.
- Fix: in the sessionless branch, forward the **literal placeholder**
  `${OPENCODE_SESSION_ID}` (carry `incomingSessionId` through) instead of `""`.
- This is required for the Preferred strategy to work at all: the remote gateway
  only derives its fallback when the value it receives still
  `includes("OPENCODE_SESSION_ID")` -
  `services/ai-gateway/src/http/providers/session-id.ts:29-31`. An empty header
  would not trigger the remote fallback and could be rejected upstream.

Files:

- `packages/server/src/server.ts` (resolution + the `:2644` forward site)
- optionally extract a small helper near `normalizeAiGatewaySessionId()`

### 4. Separate provider-hit diagnostics from watchdog evidence

done: true

Sessionless fallback must be observable, but it must not mark an unrelated
conversation run as having started.

Required behavior:

- If a request resolved to a real session or active run, keep recording provider
  hits in the existing session/workspace hit stores.
- If a request is `sessionless-fallback` with no active run, trace it but do not
  record it as workspace watchdog evidence.
- If active run context is ambiguous, forward the authenticated request but do
  not record workspace watchdog evidence.

This prevents a skill-creator provider call from satisfying a prompt watchdog in
the same workspace by accident.

Possible implementation:

- Add a flag to the provider-hit recording path, for example
  `recordWorkspaceWatchdogHit: boolean`.
- Set it to `true` only for real session or resolved active-run sources.
- Set it to `false` for `sessionless-fallback`.

Scope note (keep this step small): because the generated config no longer emits
`x-veslo-workspace-id`, a sessionless managed provider call arrives with neither a
session id nor a workspace id, and `recordAiGatewaySessionHit` already early-returns
when both are empty (`packages/server/src/server.ts:1954-1956`). So in practice a
skill-creator call records **no** watchdog evidence today. This step is therefore
mostly defense-in-depth for any path that could still carry a workspace id (e.g. a
legacy/stale config, or a future change that reintroduces the header). Implement
the flag for robustness, but do not build elaborate machinery - the source-level
guarantee already comes from omitting the workspace header.

Files:

- `packages/server/src/server.ts`

### 5. Replace `gateway_session_unresolved` with diagnostics for this class

done: true

Keep diagnostic visibility, but change the user-facing behavior:

- stop throwing `400 gateway_session_unresolved` for authenticated
  sessionless Managed AI provider calls;
- record a trace event such as `server:ai-gateway:sessionless-forward`;
- include:
  - `provider`
  - `gatewayPath`
  - `incomingSessionId`
  - `incomingOpenCodeSessionId`
  - `incomingWorkspaceId`
  - `sessionResolutionSource`
  - `workspaceFallbackSuppressedReason`
  - `activeContextCount`
  - `forwardedSessionHeaderMode`

Keep hard failures for real security/setup problems:

- missing/invalid gateway authorization;
- missing provider authorization;
- remote gateway failure;
- malformed provider route.

### 6. Update tests

done: true

Server tests:

1. Update the current unresolved-placeholder test in
   `packages/server/src/tests/server.ai-gateway.test.ts`.
   - Before: expects `400 gateway_session_unresolved`.
   - After: expects `200`.
   - Assert the upstream receives either the unresolved placeholder or the
     deterministic fallback session id, depending on the chosen forwarding
     strategy.
   - Assert `x-veslo-workspace-id` is not forwarded.
   - Assert trace contains `server:ai-gateway:sessionless-forward`.

2. Add a test for placeholder plus real `x-session-id`.
   - This already exists in the current working tree.
   - Keep it as a regression test for the strong correlation path.

3. Add a test for sessionless fallback with no active run.
   - Request has valid gateway token.
   - Request has `x-veslo-session-id: ${OPENCODE_SESSION_ID}`.
   - Request has no `x-session-id`.
   - Request has no active run.
   - Expected: proxied to upstream, no 400.
   - Assert the upstream receives `x-veslo-session-id: ${OPENCODE_SESSION_ID}`
     (the literal placeholder), **not** an empty header - this is what lets the
     remote gateway derive its `veslo_fallback_*` id. Guards the `:2644` fix.

4. Add a test for sessionless fallback while an unrelated/ambiguous run exists.
   - Expected: proxied to upstream.
   - Expected: no workspace watchdog hit is recorded for that run.
   - The prompt watchdog must not be satisfied by this sessionless request.
   - Includes the same-workspace case: two active runs in one workspace must keep
     placeholder/workspace fallback unresolved.

5. Keep conversation tests for workspace fallback hardening.
   - Placeholder plus stale workspace header must not attribute provider hits to
     the wrong workspace/run.
   - Placeholder plus `x-session-id` should resolve by `x-session-id`, not
     workspace.

6. Guard the VSLO-250 provider-start watchdog under session-only correlation.
   - Because the provider config no longer emits `x-veslo-workspace-id`, the
     watchdog can no longer rely on a workspace hit. Add/keep a test proving that
     a normal managed `prompt_async` run is still satisfied by a provider hit that
     carries only the resolved session id (no workspace header).
   - Conversely, assert a `sessionless-fallback` provider hit in the same window
     does **not** satisfy that run's watchdog.
   - This is the one true regression risk of removing workspace correlation, so it
     must be explicitly covered (the existing VSLO-250 watchdog tests in
     `server-conversations.test.ts` should be re-run and, if they depended on the
     workspace header, updated to the session-only contract).

Commands:

```powershell
bun test packages/server/src/tests/server.ai-gateway.test.ts packages/server/src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
```

App tests:

Run targeted config tests because provider header generation is part of this
bug class:

```powershell
pnpm exec node --test --import=tsx/esm src/app/tests/lib/provider-routing.test.ts src/app/tests/lib/ai-access.test.ts src/app/tests/app-managed-ai-config-sync-contract.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

### 7. Live Tauri app verification

done: false

Not required before the initial code fix, but should be used as release/manual
verification.

Manual scenario:

1. Start desktop with Managed AI gateway enabled and shared engine default.
2. Open a clean workspace.
3. Install/run `skill-creator` from chat.
4. Assert no `gateway_session_unresolved` appears in server logs or DevTools.
5. Assert provider request reaches `/ai-gateway/providers/...`.
6. Assert skill creation proceeds past the first model call.

Concurrency smoke:

1. Start a normal prompt in a workspace.
2. Trigger a sessionless Managed AI call in the same workspace if the UI path
   allows it.
3. Assert the sessionless call is proxied.
4. Assert it does not falsely complete the prompt's provider-start watchdog.

## Definition of Done

Overall done becomes true only when all of these are true:

| Requirement | done |
|---|---:|
| Authenticated skill-creator provider call no longer returns `gateway_session_unresolved` only because OpenCode did not provide session correlation | true |
| Normal prompt sends still use strong session correlation when available | true |
| Placeholder plus `x-session-id` resolves by `x-session-id` | true |
| Workspace fallback cannot attribute provider hits across active workspaces | true |
| Sessionless fallback does not satisfy unrelated prompt watchdogs | true |
| VSLO-250 provider-start watchdog still fires for a normal managed prompt under session-only correlation (no `x-veslo-workspace-id`) | true |
| Server regression tests cover sessionless fallback and ambiguity behavior | true |
| Active AI gateway run contexts are unregistered after the provider-start watch completes | true |
| Same-workspace ambiguous placeholder fallback is covered | true |
| App config tests confirm stale workspace headers are not generated or accepted as usable config | true |
| Targeted typechecks pass | true |
| Live Tauri verification is documented as optional/manual for this phase | true |

## Verification Run

Done on 2026-06-26:

```powershell
bun test packages/server/src/tests/server.ai-gateway.test.ts
bun test packages/server/src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm exec node --test --import=tsx/esm src/app/tests/lib/provider-routing.test.ts src/app/tests/lib/ai-access.test.ts src/app/tests/app-managed-ai-config-sync-contract.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Results:

- server AI Gateway tests: 20/20 passed.
- server conversation/watchdog tests: 15/15 passed.
- app Managed AI config tests: 56/56 passed.
- server typecheck passed.
- app typecheck passed.
- Live Tauri app verification was not run; it remains manual/release verification.

## Decision

Forward the placeholder. No local consumer needs a concrete fallback
id, and the remote gateway only derives its fallback when the forwarded value
still `includes("OPENCODE_SESSION_ID")`
(`services/ai-gateway/src/http/providers/session-id.ts:29-31`). A local fallback id
would either have to be forwarded as a non-placeholder string (which the remote
would then treat as a real session, defeating its own fallback) or kept local-only
(useless). So the placeholder path is both simpler and the only one that keeps a
single fallback algorithm. Switch to a local fallback only if a concrete local
consumer appears.
