---
done: false
status: in_progress
plan_type: implementation
agw_l01_provider_start_session_scoped_done: true
agw_l02_legacy_gateway_token_redaction_done: true
agw_l03_runtime_authorization_logout_ttl_done: false
agw_l04_runtime_auth_prime_singleflight_done: false
agw_s01_gateway_auth_before_body_parse_done: true
agw_s02_den_session_lookup_cache_done: false
agw_s03_gateway_async_error_boundary_done: true
agw_d01_local_provider_route_scope_decision_done: false
agw_d02_browser_gateway_token_cache_decision_done: false
agw_d03_sessionless_fallback_identity_decision_done: false
agw_deferred_followups_done: false
---

# 2026-07-07 AI Gateway Authorization System Implementation Plan And Deep Audit

## Scope

Audit the current Veslo AI Gateway authorization system, its runtime/session
correlation model, and the likely stability risks around managed AI gateway
traffic.

This file is both the evidence-backed audit and the implementation driver for
the AI Gateway authorization hardening work. Runtime code was not changed by
the audit itself; implementation agents should use the front matter flags and
the "Implementation Plan Control" section below as the live task state.

## Implementation Plan Control

Source of truth:

- Keep top-level `done: false` until all non-deferred implementation tasks and
  required decision gates are complete.
- Flip a task flag from `false` to `true` only after the implementation,
  targeted tests, and relevant documentation updates for that task are done.
- Keep deferred follow-ups separate from the first implementation batch. Do not
  block top-level progress on deferred work unless a maintainer explicitly moves
  it into scope.

Core versus conditional work:

- Core hardening for this plan is `AGW-L01`, `AGW-L02`, `AGW-S01`, and
  `AGW-S03`.
- `AGW-L03` is a second local-server batch item. Treat it as required only when
  logout/runtime-auth staleness is explicitly in scope for the active run.
- `AGW-L04` and `AGW-S02` are conditional optimization/hardening flags. They
  may remain `false` without blocking top-level completion unless a maintainer
  promotes them because duplicate runtime-auth priming or DEN lookup volume is
  an active incident class.
- Do not implement a conditional task solely because its flag is still `false`.
  First confirm the condition that makes it worth the extra moving parts.

Agent execution rule:

- Treat flags as progress checkpoints, not stopping boundaries. The preferred
  unit of work is a coherent owner-file batch that can be implemented, tested,
  and documented in one uninterrupted agent run.
- Do not stop merely because one flag was completed. If the worktree is still
  coherent, tests are green for the touched area, and the next task is not
  blocked by a decision gate or file-ownership conflict, continue into the next
  incomplete flag in the recommended order during the same run.
- Prefer completing `AGW-L01` and `AGW-L02` together in one uninterrupted local
  server pass because they share `packages/server/src/ai-gateway-runtime-owner.ts`
  and the same focused test file.
- `AGW-S01`, `AGW-S03`, and `AGW-S02` belong to `services/ai-gateway` and may be
  handled in a separate parallel pass from the local Veslo server work.
- Do not mix decision gates with code changes. Resolve `AGW-D01`, `AGW-D02`, or
  `AGW-D03` explicitly before implementing behavior that depends on the
  decision.
- If multiple agents are active, choose non-overlapping owner files. If an agent
  already owns the local server batch, another agent should prefer standalone
  gateway hardening or a decision/documentation gate.

Current recommended execution order:

1. `AGW-L01` then `AGW-L02` in one local server hardening pass.
2. `AGW-L03` if logout/runtime-auth staleness is in scope for the same run.
3. `AGW-S01` and `AGW-S03` as a separate standalone gateway pass.
4. `AGW-S02` only after `AGW-S03`, and only if DEN session lookup cost or
   lookup failure noise is an active problem.
5. `AGW-D01` before changing local provider route scopes.
6. `AGW-L04` only if duplicate auth priming is an active latency/request-volume
   issue.

## Executive Finding

The current AI Gateway authorization design is structurally sound. The desktop
path no longer depends on persisting the cloud gateway bearer into generated
OpenCode config. Instead, the generated OpenCode config uses the local Veslo
server client token and an `OPENCODE_SESSION_ID` placeholder, while the local
Veslo server keeps the cloud gateway authorization in runtime memory.

No P0 class issue was found in the reviewed state. The main remaining risks are
compatibility and operations risks:

1. Provider-start detection can be falsely satisfied by another run in the same
   workspace because `hasProviderHitAfter` falls back from session hits to
   workspace hits even when a session id is known.
2. Legacy `x-veslo-gateway-token` provider requests still take precedence over
   runtime authorization, including the redacted placeholder value
   `[REDACTED]`.
3. Runtime authorization has no TTL/expiry model and is not explicitly cleared
   by the desktop logout path.
4. The standalone AI Gateway parses provider JSON bodies before gateway auth, up
   to the current 10 MB limit.
5. Standalone gateway provider auth depends on a live DEN `/v1/me` session
   lookup per provider request; there is no visible short positive cache.
6. Standalone gateway auth/preflight handlers use Express 4 async functions
   without a shared rejection wrapper. Thrown DEN/session/repository errors can
   leave provider and `/api/me/ai-access` requests hanging as unhandled
   rejections instead of returning structured 5xx/401 responses.
7. Managed runtime authorization is primed more than once in a normal send path.
8. Browser/non-Tauri cache still persists a short-lived gateway access token in
   localStorage.
9. Redacted local-server credential states are accepted as usable without a
   non-secret server-side credential fingerprint.
10. Provider-hit evidence is recorded before the upstream standalone gateway has
   accepted/authenticated the request, so current traces can conflate local
   proxy arrival with downstream gateway acceptance.
11. Provider-start timeout is diagnostic and asynchronous, so the user can still
   see an accepted submit while the gateway start evidence is missing.

## Current Architecture

### Runtime authorization owner

`packages/server/src/ai-gateway-runtime-owner.ts`

- Owns in-memory runtime authorization entries keyed by actor token hash.
- Owns active AI Gateway run context indexes by session and workspace.
- Resolves provider authorization from either a legacy gateway-token header or
  from runtime authorization associated with the actor/scoped actor.
- Resolves provider request sessions by explicit Veslo session header, real
  OpenCode session header, then the constrained legacy workspace fallback.
- Records provider hits by both session and workspace and exposes
  provider-start detection for lifecycle watchdogs.

Key anchors:

- `registerRuntimeAuthorization` starts at line 285.
- `syncRuntimeAuthorizationFromAccessBundle` starts at line 307.
- `resolveProviderAuthorization` starts at line 334.
- Legacy `x-veslo-gateway-token` precedence is at lines 343-349.
- Workspace fallback in session resolution is at lines 462-472.
- Workspace hit recording is at lines 575-577.
- Provider hit detection starts at line 581, with workspace fallback at line
  597.

### Server proxy boundary

`packages/server/src/server.ts`

- Requires local caller authorization before proxying AI Gateway provider
  requests.
- Reads the legacy gateway-token header only as compatibility input.
- Resolves the provider session before forwarding.
- Rejects unresolved non-sessionless requests with `gateway_session_unresolved`.
- Does not count `sessionless-fallback` requests as watchdog evidence.
- Forwards provider requests with a resolved `Authorization` header and strips
  internal/local-only/hop-by-hop headers before upstream fetch.
- Normalizes upstream non-2xx failures as redacted `502` gateway errors.

Key anchors:

- Gateway constants and header names are around lines 238-251.
- Runtime authorization registration wrapper is at line 1517.
- Provider authorization wrapper is at line 1540.
- Provider proxy request processing starts at line 1888.
- Incoming gateway-token compatibility read is at line 1912.
- Unresolved session rejection starts at line 1968.
- `sessionless-fallback` watchdog suppression is at lines 2042-2051.
- Forwarded header construction and internal header stripping start at line
  2105.
- Upstream failure normalization starts at line 2325.

### Standalone AI Gateway service boundary

`services/ai-gateway/src/index.ts`

- Mounts provider JSON parsers for `/providers` and `/ai-gateway/providers`
  before the proxy auth router.
- The parser limit is `10mb`.
- Mounts the same proxy router both at root and under `/ai-gateway`.

Key anchors:

- `MANAGED_AI_PROXY_JSON_LIMIT` is at line 28.
- Provider JSON parsers are mounted at lines 33-35.
- Proxy routers are mounted at lines 46-47.

`services/ai-gateway/src/http/proxy.ts`

- Requires a gateway session for `/providers/*` requests.
- Reads gateway auth from `Authorization: Bearer ...` first, then from
  `x-veslo-gateway-token`.
- Resolves the caller through `gatewaySessions.resolveSession(token)`.
- Applies AI access policy before reaching provider-specific routers when an
  access repository is configured.
- Uses async Express middleware for session and access lookup. With the current
  Express 4 dependency, rejected promises in this middleware are not converted
  into structured HTTP responses unless the handler catches them explicitly.

Key anchors:

- Provider auth middleware starts at line 42.
- Gateway session resolution is at line 49.
- AI access lookup is at line 57.
- `x-veslo-gateway-token` compatibility read is at line 81.

`services/ai-gateway/src/http/providers/openai-compatible.ts`

- Resolves assigned custom-provider credential bindings before entering the
  transport failure `try/catch`.

Key anchors:

- Assigned binding lookup starts at line 58.
- The transport `try/catch` starts at line 105.

`services/ai-gateway/src/http/providers/codex-oauth.ts`

- Resolves assigned Codex credential bindings and auth JSON before entering the
  transport failure `try/catch`.

Key anchors:

- Assigned binding lookup starts at line 75.
- The transport `try/catch` starts at line 113.

`services/ai-gateway/src/auth/user-session.ts`

- `DenUserSessionResolver` resolves every token by calling DEN `/v1/me`.
- No positive/negative cache is visible in this resolver.

Key anchors:

- DEN `/v1/me` fetch starts at line 34.

`services/ai-gateway/src/http/providers/session-id.ts`

- Unresolved `OPENCODE_SESSION_ID` placeholders are normalized to a
  `veslo_fallback_${provider}_${digest}` id derived from user id and provider.

Key anchors:

- Fallback session id generation is at line 26.

### Server-owned submit and lifecycle

`packages/server/src/conversation-run-lifecycle-controller.ts`

- Registers an active AI Gateway run only for `prompt_async` runs that declare
  `expectAiGatewayStart`.
- Registers the active run before OpenCode submit.
- Unregisters on submit failure or when the provider-start watch owns the
  lifecycle.
- Runs provider-start observation asynchronously after accepted submit.

Key anchors:

- `registerActiveAiGatewayRun` starts at line 467.
- Provider-start watch logic starts at line 527.
- Active-run registration around submit starts at line 594.

`packages/server/src/routes/conversations.ts`

- Carries `expectAiGatewayStart` from server-owned conversation submit into the
  lifecycle controller.

Key anchors:

- Submit route `expectAiGatewayStart` handling is around lines 937-972.

### App runtime bootstrap

`packages/app/src/app/context/send-runtime-readiness.ts`

- Checks whether the current managed AI runtime config is usable.
- Calls `ensureManagedAiRuntimeAuthorizationForSend` before managed sends.
- This readiness-level prime is intentionally defensive, but it currently
  overlaps with a second submit-level prime in `conversation-service.ts`.

Key anchors:

- Managed AI runtime authorization priming is at lines 312-314.
- Runtime readiness preparation begins around line 605.

`packages/app/src/app/context/conversation-service.ts`

- Computes `expectAiGatewayStart` for managed prompt submits.
- Primes runtime authorization before server-owned submit.
- Keeps the legacy prompt path aligned with the same runtime authorization
  priming rule.

Key anchors:

- Server-owned submit managed runtime authorization priming is around lines
  724-765.
- Legacy run path runtime authorization priming is around lines 817-899.

`packages/app/src/app/context/managed-ai-runtime-config.ts`

- Fetches `/ai-gateway/me/ai-access` through the local Veslo server.
- Applies the managed AI access profile and gateway access token in memory.
- Syncs generated OpenCode config through the server-backed/project-file config
  paths.
- Heals inactive workspace config only when a valid gateway token is available.

Key anchors:

- `ensureManagedAiRuntimeAuthorizationForSend` starts at line 534.
- Server-backed config sync starts at line 827.
- Project-file config sync starts at line 943.
- Inactive workspace config healing starts at line 1050.

### Generated OpenCode config contract

`packages/app/src/app/lib/opencode.ts`

- Defines `OPENCODE_SESSION_ID_TEMPLATE` as `${OPENCODE_SESSION_ID}`.
- Defines the Veslo server client token template as
  `{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}`.
- Writes generated provider routing headers with:
  - `Authorization: Bearer {env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}`
  - `x-veslo-session-id: ${OPENCODE_SESSION_ID}`
- Does not write the live cloud gateway bearer into generated desktop OpenCode
  config.

Key anchors:

- Template constants are at lines 48-50.
- Gateway provider routing generation starts around line 388.
- Header generation is around lines 458-459.

`packages/app/src/app/lib/ai-access.ts`

- Treats the expected env template, expected local server token, and redacted
  values as usable local server credential states.
- Rejects stale legacy `x-veslo-workspace-id` routing state for current managed
  provider routing.
- Ignores redacted/env-template values when extracting managed API keys.

Key anchors:

- Stale workspace header rejection is at line 220.
- Usable server client credential checks are around lines 228-265.
- Redacted/env-template extraction skip is around lines 474-497.

### Access cache split

`packages/app/src/app/context/managed-ai-access-store.ts`

- Browser/non-Tauri cache stores `gatewayAccessToken` in localStorage for the
  current short TTL path.
- Tauri/desktop proof cache avoids persisting the token and returns
  `gatewayAccessToken: ""`.

Key anchors:

- Browser cache record includes `gatewayAccessToken` at lines 43-50.
- Browser localStorage cache read/write is around lines 225-295.
- Desktop proof cache no-token result is around lines 313-356.

## Strengths

1. The desktop runtime no longer writes the cloud gateway bearer into generated
   OpenCode config.
2. The runtime authorization owner has a clear ownership boundary: runtime auth,
   active run context, session resolution, and provider-hit evidence live in one
   server module.
3. The server-owned submit path explicitly tells lifecycle when an AI Gateway
   provider start is expected.
4. Non-sessionless unresolved session routing fails closed with
   `gateway_session_unresolved`.
5. `sessionless-fallback` traffic remains forwardable for diagnostic/runtime
   compatibility, but does not count as provider-start evidence.
6. The proxy strips internal headers before forwarding and redacts upstream
   failure details.
7. The app primes local runtime authorization before managed sends in both the
   server-owned and legacy submit paths.

## Findings And Risks

### P1: Provider-start evidence can be falsely satisfied by another run

`hasProviderHitAfter` checks both session-level and workspace-level provider
hits. The workspace path is not constrained by the session id that the lifecycle
watchdog already knows. Because `recordSessionHit` mirrors every resolved hit
into `workspaceHits`, a provider request from run B can satisfy run A's
provider-start watchdog when both runs share a workspace.

Minimal reproduction from this audit:

1. Register active run A for `workspaceId: "ws"` and `opencodeSessionId:
   "sess-a"`.
2. Register active run B for the same workspace and `opencodeSessionId:
   "sess-b"`.
3. Record a provider hit for `sess-b` / `ws`.
4. Call `hasProviderHitAfter({ sessionId: "sess-a", workspaceId: "ws",
   startedAt: 1000 })`.

Observed result:

```json
{"runAStartedByRunBWorkspaceHit":true}
```

Impact:

- A real provider-start failure for run A can be hidden by unrelated traffic
  from run B in the same workspace.
- Support traces can make an accepted submit look healthier than it is.
- This is a stability/correlation issue, not an unauthenticated access issue.

Recommended follow-up:

1. Add a failing test in `ai-gateway-runtime-owner.test.ts` for the two-run
   same-workspace case. The expected value for run A must be `false` after only
   run B records provider evidence.
2. If `sessionId` is present, require a matching session hit.
3. Keep workspace hits as diagnostics only, or allow them only when there is no
   session id and exactly one active context for the workspace.
4. Prefer storing `runId`/`conversationId` on hit evidence before any future
   workspace-level matching.

### P3: Provider-hit is recorded before upstream gateway acceptance

The local Veslo server records `server:ai-gateway:provider-hit` and updates the
provider-start watchdog evidence before the upstream standalone gateway fetch is
attempted and before any downstream gateway auth/policy response is known.

This is useful for proving that OpenCode reached the local provider proxy, but
it is weaker than proving that the standalone gateway accepted/authenticated the
request.

Impact:

- A downstream `401`, `403`, `502`, or timeout from the standalone gateway can
  still appear as a successful provider-hit signal at the local proxy layer.
- Support traces can mix "local proxy received the request" with "gateway auth
  accepted the request".
- This compounds the existing provider-start false-positive risk, especially
  when the upstream failure is caused by auth/session lookup rather than by the
  provider transport itself.

Recommended follow-up:

1. Keep the current local proxy hit trace, but name/interpret it as local-proxy
   evidence.
2. Add or reuse a later trace state for upstream gateway headers received or
   upstream gateway accepted.
3. Make watchdog diagnostics state which layer satisfied the evidence:
   `local-proxy-hit`, `upstream-headers`, or `provider-body-start`.

### P2: Legacy gateway-token header still bypasses runtime auth precedence

`resolveProviderAuthorization` accepts `x-veslo-gateway-token` first, before it
checks runtime authorization for the actor token hash.

This keeps older configs working, but it preserves the exact class of risk that
the newer design is trying to retire: a stale generated config containing a live
gateway token can still authorize a provider request without the runtime-memory
auth path.

Current mitigations:

- Provider proxy still requires local Veslo server caller auth.
- New generated config uses the Veslo server client token env placeholder.
- Tests still cover the legacy compatibility path explicitly.

Additional validation from this audit:

```json
{"authorization":"Bearer [REDACTED]","source":"legacy-header"}
```

That result was produced with a valid runtime authorization already registered
for the actor and an incoming `x-veslo-gateway-token: [REDACTED]`. In other
words, the redacted placeholder still wins over usable runtime auth.

Recommended follow-up:

1. Add telemetry for every legacy gateway-token provider request.
2. Treat `[REDACTED]` and known redaction placeholders as absent, not as bearer
   credentials.
3. Add a local warning/diagnostic that identifies the stale config path.
4. Remove the legacy path or gate it behind an explicit temporary compatibility
   flag after one release window.

### P2: Runtime authorization entries have no TTL

Runtime authorization is cleared when `/ai-gateway/me/ai-access` says managed AI
access is not enabled. It is also refreshed before managed sends. However, the
server-side runtime authorization map itself has no expiry, and the desktop DEN
logout workflow only clears app-side DEN auth/cache. A local server clear helper
exists, but the desktop logout path does not currently call back into the local
Veslo server to clear runtime gateway authorization.

Operational impact:

- Token rotation/revocation outside a send may only surface on the next provider
  request as a 401/502-style failure.
- A server restart correctly drops runtime auth, but any provider request that
  arrives before priming fails with `gateway_runtime_authorization_required`.
- A user logout does not necessarily clear already-registered runtime
  authorization until a later access-bundle sync disables it, a server restart
  drops it, or a replacement authorization overwrites it.
- Diagnostics do not currently expose runtime auth age as a first-class signal.

Recommended follow-up:

1. Add a local-server clear endpoint or logout hook for the current actor's
   runtime authorization.
2. Store `expiresAt` if the access bundle exposes one, otherwise enforce a short
   conservative TTL.
3. Include runtime auth age/source in local diagnostics without exposing secret
   values.
4. On stale runtime auth, refresh through `/ai-gateway/me/ai-access` before
   failing where the caller context is available.

### P2: Standalone gateway parses provider bodies before auth

`services/ai-gateway/src/index.ts` mounts `express.json({ limit: "10mb" })` for
`/providers` and `/ai-gateway/providers` before `createProxyRouter()` mounts the
gateway auth middleware. The current test suite explicitly asserts this
behavior in `services/ai-gateway/test/proxy-auth.test.ts` with
`provider proxy accepts large model request bodies before gateway auth`.

Impact:

- An unauthenticated caller can force JSON parsing and memory allocation before
  receiving `401`.
- The current configured limit is bounded, but 10 MB is still large enough to be
  a cheap public-edge resource pressure vector if the standalone gateway is
  internet-facing.
- This does not bypass provider auth or reach credentials, but it moves work to
  the wrong side of the boundary.

Recommended follow-up:

1. Move a cheap auth precheck before the provider JSON parser.
2. Keep the 10 MB body limit for authenticated provider traffic.
3. Add a regression test that unauthenticated large provider requests are
   rejected before body parsing reaches provider/dependency code.

### P2: Standalone gateway provider auth depends on live DEN lookup

`DenGatewaySessionResolver` delegates to `DenUserSessionResolver`, and that
resolver calls DEN `/v1/me` for each token resolution. The default proxy
dependencies wire this resolver directly; no short in-memory positive cache is
visible.

Impact:

- A DEN outage or slow `/v1/me` path can make otherwise healthy provider
  inference fail before AI access policy, lease selection, or upstream provider
  routing are reached.
- This makes AI Gateway availability more tightly coupled to DEN availability
  than the user-visible product model suggests.
- Revocation semantics are strong, but every provider request pays the DEN
  lookup cost.

Recommended follow-up:

1. Add a short positive session cache in the gateway session resolver, for
   example 15-60 seconds, keyed by bearer token hash.
2. Do not cache negative auth failures unless there is a very short
   single-flight guard.
3. Emit diagnostics that distinguish DEN-auth lookup failure from provider
   credential/provider failures.

### P2: Standalone gateway async auth failures can hang requests

The standalone AI Gateway package depends on Express 4, and the provider auth
middleware in `services/ai-gateway/src/http/proxy.ts` is an async middleware
that awaits `gatewaySessions.resolveSession(token)` and
`aiAccess.getUserAiAccess(session.user.id)` without an explicit rejection
wrapper.

The same async-without-wrapper pattern exists on the user credential route in
`services/ai-gateway/src/http/user-credentials.ts`, where `/api/me/ai-access`
awaits `sessionResolver.resolveSession(token)` before returning the current
managed AI access policy.

Confirmed repros from the deep-audit continuation:

```json
{"fetchError":"AbortError","unhandled":["den_lookup_failed"]}
```

This was produced by a provider request whose gateway session resolver throws.
The request did not receive a structured response within the 500 ms repro
window; the process emitted an unhandled rejection.

```json
{"fetchError":"AbortError","unhandled":["den_me_failed"]}
```

This was produced by `/api/me/ai-access` with a throwing user session resolver.

Impact:

- DEN `/v1/me` network exceptions can leave provider and runtime-auth-prime
  requests hanging until the local proxy/client timeout fires.
- The app/server layer then sees a generic timeout or request failure instead
  of a stable gateway auth/session failure code.
- This is more severe than the no-cache finding: a short positive cache reduces
  lookup frequency, but it does not handle thrown resolver failures.

Recommended follow-up:

1. Add a shared `asyncHandler`/`asyncMiddleware` wrapper for Express 4 routes and
   middleware in `services/ai-gateway`.
2. Wrap provider auth middleware, `/api/me/ai-access`, and provider-specific
   preflight handlers.
3. Map session resolver failures to a redacted structured response such as
   `503 gateway_session_resolution_failed`.
4. Add tests where `gatewaySessions.resolveSession`,
   `sessionResolver.resolveSession`, and `aiAccess.getUserAiAccess` throw and
   assert a bounded HTTP response plus no unhandled rejection.

### P2: Provider-specific assigned-credential preflight can hang before transport catch

`openai_compatible` and `codex_oauth` provider routers resolve assigned
credential bindings before entering their main provider transport `try/catch`.
If `deps.credentials.getBindingByCredentialId` throws, Express 4 does not turn
the rejected promise into the provider's normal structured 503 path.

Confirmed repro from the deep-audit continuation:

```json
{"fetchError":"AbortError","unhandled":["credential_lookup_failed"]}
```

That repro used an `openai_compatible` AI access policy with an assigned
credential and a throwing `getBindingByCredentialId` repository call.

Impact:

- A transient DB/repository failure in assigned credential lookup can hang the
  provider request before lease selection or upstream provider transport starts.
- Credential failure alerts are skipped because the throw happens before the
  current alert-producing branch.
- Custom provider and Codex OAuth routes have different preflight shapes, so a
  piecemeal fix can leave one route family uncovered.

Recommended follow-up:

1. Use the same async handler/error-boundary fix as the auth middleware.
2. Move provider-specific preflight awaits inside a full-route `try/catch`, or
   make the shared route wrapper map them to a structured gateway 503.
3. Add route tests for throwing assigned-binding lookup in both
   `proxy-openai-compatible.test.ts` and `codex-oauth-proxy.test.ts`.

### P2: Runtime authorization priming is duplicated in one send

The app can prime managed runtime authorization in readiness and then prime it
again in the submit path:

- `send-runtime-readiness.ts` calls
  `ensureManagedAiRuntimeAuthorizationForSend` before managed sends.
- `conversation-service.ts` calls the same dependency before server-owned
  submit.
- The legacy prompt path in `conversation-service.ts` also keeps the same prime
  behavior for compatibility.

This is robust, but it adds avoidable latency and one more DEN/gateway access
call surface during a user send.

Recommended follow-up:

1. Keep both call sites allowed, but make the implementation single-flight.
2. Cache successful prime results for a short window keyed by local server URL,
   local server client token hash, and DEN actor token hash.
3. Keep the cache in memory only and invalidate it on logout, workspace/server
   change, failed provider auth, or runtime auth clear.

### P3: Redacted credential state is accepted as usable

`hasUsableServerClientCredential` treats `[REDACTED]` as usable for local server
credentials. This avoids endless rewrites when the server returns redacted
config, and `managedConfigContentsMatchForServerPatch` still protects against
known stale legacy header shapes. The blind spot is observability: app-side
readiness cannot prove which secret is actually behind a redacted value.

Recommended follow-up:

1. Expose non-secret credential metadata from the server, for example
   `authMode` and a stable credential/source fingerprint.
2. Treat redacted-only state as "usable but unverified" in diagnostics.
3. Keep generated config secret-free; do not solve this by writing live gateway
   credentials back into OpenCode config.

### P3: Sessionless gateway fallback collapses unrelated calls

The standalone gateway rewrites unresolved `OPENCODE_SESSION_ID` placeholders to
`veslo_fallback_${provider}_${digest}` where the digest is derived from user id
and provider. This is useful because it
keeps sessionless managed calls working, and it matches the local server's
decision to forward sessionless requests without counting them as prompt
provider-start evidence.

The tradeoff is that all unresolved sessionless calls for one user and provider
share a single lease/session identity.

Impact:

- Credential stickiness and usage grouping can be broader than the actual user
  workflow.
- A bad lease or failover decision from one sessionless context can affect
  another unrelated sessionless context for the same user/provider.
- This is acceptable only if sessionless traffic remains diagnostic/auxiliary,
  not normal prompt execution.

Recommended follow-up:

1. Keep normal prompt traffic session-correlated.
2. Add diagnostics that mark `veslo_fallback_*` usage as sessionless, not a real
   prompt session.
3. If sessionless traffic becomes common, derive a narrower fallback id from an
   explicit local request/workflow id rather than only user id and provider.

### P3: Browser/non-Tauri cache persists gateway access token

The desktop proof cache avoids persisting the token, but the browser cache stores
`gatewayAccessToken` in localStorage. This is likely a conscious web-mode
tradeoff, but it does not share the stronger desktop threat model.

Recommended follow-up:

1. Document this as web/non-Tauri-specific behavior if it is intentional.
2. Prefer a no-token proof cache model for web if the product can support it.
3. Keep the browser cache TTL short and audit all reads/writes for redaction.

### P3: Provider-start timeout is diagnostic after accepted submit

The provider-start watch runs asynchronously after submit acceptance. This avoids
blocking or failing a run that may still recover, but it can make UX ambiguous:
the user can see an accepted send while the gateway never started and recovery
depends on lifecycle diagnostics/reconcile.

Recommended follow-up:

1. Surface provider-start timeout as an explicit run diagnostic.
2. Include the last session-resolution source and whether watchdog evidence was
   recorded.
3. Keep the submit response accepted, but make the missing provider-start layer
   visible to the UI and support logs.

### P3: User-facing auth failure reasons are too coarse

The trace layer records useful causes such as `missing-user-token`,
`non-local-workspace`, and `provider-routing-target-missing`, but the user-facing
send/readiness error remains mostly generic. This is not a correctness bug, but
it makes AI Gateway incidents harder to triage.

Recommended follow-up:

1. Map the main auth-prime skip/error reasons to stable, redacted UI/support
   diagnostics.
2. Add a local diagnostics endpoint that reports runtime auth age/source,
   active-context counts, and last provider-start evidence source without
   exposing tokens.

### P3: Local AI Gateway route scope is implicit

Local AI Gateway routes are registered as `client` routes, but they do not
declare a route-local minimum token scope. For the modern runtime-auth path this
is mostly contained by actor-token hashing: a provider request needs runtime
authorization for the same actor hash, or the submit-run scoped actor hash. The
legacy gateway-token header path is not scope-aware in the same way.

Impact:

- The intended minimum capability for inference-spending provider POSTs is not
  encoded at the route boundary.
- Compatibility auth makes the effective policy harder to reason about than the
  rest of conversation submit, which explicitly requires collaborator scope.

Recommended follow-up:

1. Decide whether provider proxy POSTs should require collaborator scope.
2. If yes, add an explicit route/local check while confirming generated OpenCode
   still uses a collaborator-capable local server token.
3. If viewer tokens are intentionally allowed for inference, document that
   product rule in the audit and route contract tests.

## Implementation Readiness Cut

This audit is ready as backlog input, but it should not be implemented as one
wide "AI Gateway auth rewrite". The low-friction path is to split local Veslo
server fixes from standalone gateway hardening and keep each patch testable in
isolation.

### First implementation batch

Ship the first batch as local Veslo server hardening only. This removes the
highest-signal false positives without changing the standalone gateway service
or browser cache behavior.

#### AGW-L01: Provider-start evidence is session-scoped

Status: implemented.
Done flag: `agw_l01_provider_start_session_scoped_done: true`.

Owner files:

- `packages/server/src/ai-gateway-runtime-owner.ts`
- `packages/server/src/tests/ai-gateway-runtime-owner.test.ts`

Implementation contract:

1. Add a regression test where run A and run B share a workspace, only run B
   records provider evidence, and run A's `hasProviderHitAfter` result is
   `false`.
2. If `hasProviderHitAfter` receives a non-empty normalized `sessionId`, only
   matching `sessionHits` may satisfy the call.
3. Keep `workspaceHits` for diagnostics and possible sessionless/legacy
   diagnostics, but do not use them to satisfy a session-scoped provider-start
   watchdog.

Acceptance:

- The minimal reproduction in this audit changes from
  `runAStartedByRunBWorkspaceHit: true` to `false`.
- A matching session hit for run B still returns `true`.
- `bun test packages/server/src/tests/ai-gateway-runtime-owner.test.ts` passes.

#### AGW-L02: Legacy gateway-token redaction and precedence hardening

Status: implemented.
Done flag: `agw_l02_legacy_gateway_token_redaction_done: true`.

Owner files:

- `packages/server/src/ai-gateway-runtime-owner.ts`
- `packages/server/src/tests/ai-gateway-runtime-owner.test.ts`
- `packages/server/src/tests/server.ai-gateway.test.ts`

Implementation contract:

1. Treat `[REDACTED]` and other known redaction placeholders in
   `x-veslo-gateway-token` as absent.
2. When a valid runtime authorization exists and the incoming legacy header is a
   redaction placeholder, resolve to runtime authorization.
3. Preserve live legacy-token compatibility for one release window unless a
   separate decision removes it.
4. Emit a trace/diagnostic for live legacy-header use if there is an existing
   low-friction trace surface; do not add a new telemetry subsystem for this
   patch.

Acceptance:

- `x-veslo-gateway-token: [REDACTED]` never produces
  `Authorization: Bearer [REDACTED]`.
- Existing live legacy-token compatibility tests still pass or are explicitly
  retargeted to the compatibility flag/decision.
- `bun test packages/server/src/tests/ai-gateway-runtime-owner.test.ts packages/server/src/tests/server.ai-gateway.test.ts`
  passes.

### Second local-server batch

These fixes are still local runtime auth work, but they touch app logout or
runtime diagnostics and should be separate from AGW-L01/AGW-L02.

#### AGW-L03: Runtime authorization clear on logout plus bounded age

Status: ready after choosing the smallest app-to-server clear call.
Done flag: `agw_l03_runtime_authorization_logout_ttl_done: false`.

Owner files:

- `packages/server/src/ai-gateway-runtime-owner.ts`
- `packages/server/src/routes/ai-gateway.ts`
- `packages/app/src/app/context/den-desktop-auth-workflow.ts`
- `packages/server/src/tests/ai-gateway-runtime-owner.test.ts`
- `packages/server/src/tests/server.ai-gateway-routes.test.ts`
- `packages/app/src/app/tests/context/den-desktop-auth-workflow.test.ts`

Implementation contract:

1. Add a client/host-auth local route or reuse an existing local-server action
   to clear the current actor's runtime gateway authorization.
2. Call it from desktop DEN logout best-effort after app-side auth/cache is
   cleared.
3. Add a conservative runtime auth max age in the owner. Keep it in memory; do
   not persist gateway authorization.
4. Expose age/source only through redacted diagnostics or trace payloads.

Acceptance:

- Logout invalidates the current actor's runtime authorization without server
  restart.
- Expired runtime authorization is not used for provider requests.
- A fresh `/ai-gateway/me/ai-access` prime still restores runtime
  authorization.

#### AGW-L04: Runtime auth prime single-flight

Status: optional optimization, not a correctness blocker for the first fix
batch. Not required for top-level `done` unless a maintainer promotes duplicate
runtime-auth priming to an active incident class.
Done flag: `agw_l04_runtime_auth_prime_singleflight_done: false`.

Owner files:

- `packages/app/src/app/context/managed-ai-runtime-config.ts`
- `packages/app/src/app/tests/context/managed-ai-runtime-config.test.ts`
- `packages/app/src/app/tests/context/send-runtime-readiness.test.ts`
- `packages/app/src/app/tests/context/conversation-service.test.ts`

Implementation contract:

0. Before implementing, verify duplicate `/ai-gateway/me/ai-access` priming is
   measurable in the current send path. If not, leave this flag `false` and keep
   the simpler existing flow.
1. Keep both readiness and submit call sites valid.
2. Make `ensureManagedAiRuntimeAuthorizationForSend` single-flight with a short
   in-memory success TTL keyed by local server URL, local server token hash, and
   DEN actor token hash.
3. Invalidate on logout, server/workspace change, failed provider auth, or
   runtime auth clear.
4. Do not add persistent token state, a cross-process cache, or a new auth
   ownership layer for this optimization.

Acceptance:

- A normal managed send does not issue duplicate `/ai-gateway/me/ai-access`
  primes within the short TTL.
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/managed-ai-runtime-config.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/conversation-service.test.ts`
  passes.

### Standalone gateway hardening

Do these in a separate PR/batch from local Veslo server runtime auth. They are
valid findings, but they belong to `services/ai-gateway` and have different
deployment risk.

#### AGW-S01: Authenticate before parsing large provider bodies

Status: implemented.
Done flag: `agw_s01_gateway_auth_before_body_parse_done: true`.

Owner files:

- `services/ai-gateway/src/index.ts`
- `services/ai-gateway/src/http/proxy.ts`
- `services/ai-gateway/test/proxy-auth.test.ts`

Implementation contract:

1. Add a cheap provider-auth precheck before the 10 MB JSON parser.
2. Keep the 10 MB JSON limit for authenticated provider traffic.
3. Retarget the current test that says large unauthenticated bodies are accepted
   before auth. The new contract is that unauthenticated provider requests are
   rejected before expensive body parsing/dependency code.

Acceptance:

- Missing or malformed gateway auth returns `401` before provider JSON parsing
  and without invoking gateway session resolver, lease broker, token broker, or
  provider transport.
- Syntactically valid but unauthorized bearer tokens may invoke the session
  resolver, but they must still fail before lease broker, token broker, provider
  transport, or provider-specific business logic.
- Authenticated large provider requests still work within the configured limit.
- `pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy-auth.test.ts`
  passes.

#### AGW-S03: Add Express async error boundary for gateway auth/preflight

Status: implemented.
Done flag: `agw_s03_gateway_async_error_boundary_done: true`.

Owner files:

- `services/ai-gateway/src/http/proxy.ts`
- `services/ai-gateway/src/http/user-credentials.ts`
- `services/ai-gateway/src/http/providers/openai-compatible.ts`
- `services/ai-gateway/src/http/providers/codex-oauth.ts`
- `services/ai-gateway/test/proxy-auth.test.ts`
- `services/ai-gateway/test/user-credentials.test.ts`
- `services/ai-gateway/test/proxy-openai-compatible.test.ts`
- `services/ai-gateway/test/codex-oauth-proxy.test.ts`

Implementation contract:

1. Add a small shared Express 4 async wrapper or local `try/catch` boundary for
   async middleware/route handlers.
2. Provider auth middleware must convert thrown session/access lookup failures
   into bounded, redacted HTTP responses.
3. `/api/me/ai-access` must convert thrown session/access lookup failures into
   bounded, redacted HTTP responses.
4. Provider-specific assigned credential preflight must not sit outside the
   route error boundary.
5. Preserve existing provider transport error sanitization and alert behavior.

Acceptance:

- Throwing `gatewaySessions.resolveSession` does not leave a provider request
  hanging and does not emit an unhandled rejection.
- Throwing `sessionResolver.resolveSession` does not leave `/api/me/ai-access`
  hanging and does not emit an unhandled rejection.
- Throwing `getBindingByCredentialId` in `openai_compatible` and `codex_oauth`
  returns a structured gateway failure rather than hanging.
- `pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy-auth.test.ts test/user-credentials.test.ts test/proxy-openai-compatible.test.ts test/codex-oauth-proxy.test.ts`
  passes.

#### AGW-S02: Bound DEN session lookup cost

Status: conditional gateway hardening. Ready after choosing cache TTL, but not
required for top-level `done` unless DEN lookup volume, latency, or lookup
failure noise is an active operations problem. Implement after or alongside
`AGW-S03`; lookup caching does not replace async error handling.
Done flag: `agw_s02_den_session_lookup_cache_done: false`.

Owner files:

- `services/ai-gateway/src/auth/user-session.ts`
- `services/ai-gateway/src/auth/gateway-session.ts`
- `services/ai-gateway/src/runtime/default-runtime.ts`
- `services/ai-gateway/test/proxy-auth.test.ts`
- `services/ai-gateway/test/user-credentials.test.ts`
- `services/ai-gateway/test/gateway-session-cache.test.ts`

Implementation contract:

0. Before implementing, confirm the gateway is paying meaningful repeated DEN
   `/v1/me` lookup cost or producing noisy repeated lookup failures. If not,
   leave this flag `false`.
1. Add a short positive cache for successful DEN `/v1/me` lookups, keyed by
   bearer token hash.
2. Default TTL should be small, for example 15-60 seconds.
3. Do not persist sessions and do not cache negative failures beyond a very
   short single-flight guard.
4. Add diagnostics that distinguish DEN auth lookup failure from
   provider/credential failures.
5. Do not introduce distributed cache, revocation webhooks, or new DEN auth
   ownership. The bounded stale-auth window must stay explicit and small.

Acceptance:

- Repeated provider requests with the same valid token inside the TTL do not
  call DEN for every request.
- Revoked/invalid tokens are still rejected after the short TTL.
- DEN lookup failures surface as auth/session lookup diagnostics, not generic
  provider failures. This failure-path assertion depends on `AGW-S03` being
  complete or implemented in the same patch.
- `pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy-auth.test.ts test/user-credentials.test.ts`
  passes.

### Decision gates

These items need a product/security decision before code changes.

#### AGW-D01: Local provider route minimum scope

Decision needed: should local provider proxy POST routes require
`collaborator` scope, matching conversation submit, or are `viewer` tokens
allowed to spend inference?
Decision flag: `agw_d01_local_provider_route_scope_decision_done: false`.

Default recommendation: require `collaborator` unless there is a documented
read-only inference product rule.

Implementation note: local Veslo server route registration only distinguishes
`none`, `client`, and `host` auth modes. A `collaborator` decision cannot be
implemented by changing the `addRoute` auth mode alone; it needs an explicit
scope check such as `requireClientScope(ctx, "collaborator")` or the local
equivalent inside the provider route handler/dependency boundary.

Acceptance after decision:

- The route contract test states the expected minimum scope.
- Generated OpenCode/local runtime tokens are verified to satisfy the scope.

#### AGW-D02: Browser/non-Tauri gateway token cache

Decision needed: is localStorage persistence for web/non-Tauri gateway tokens an
intentional web-mode tradeoff?
Decision flag: `agw_d02_browser_gateway_token_cache_decision_done: false`.

Default recommendation: document it explicitly now; remove it only if the web
mode can use a no-token proof/cache flow without breaking current auth UX.

#### AGW-D03: Sessionless fallback identity width

Decision needed: is sessionless managed traffic only diagnostic/auxiliary, or
can it become a normal prompt path?
Decision flag: `agw_d03_sessionless_fallback_identity_decision_done: false`.

Default recommendation: keep current fallback for compatibility, add
diagnostics, and only narrow the fallback id if sessionless traffic becomes
common enough to affect lease/usage isolation.

### Deferred follow-ups

These are useful but should not block the first implementation batch:
Done flag: `agw_deferred_followups_done: false`.

1. Non-secret credential metadata for redacted config states.
2. Provider-start timeout surfaced as an explicit run diagnostic.
3. More precise user-facing auth-prime error messages.
4. Full removal of live legacy `x-veslo-gateway-token` after telemetry or a
   compatibility-window decision.
5. Provider-start/watchdog diagnostics split into local-proxy-hit versus
   upstream-gateway-accepted evidence.

Completion rule:

- Keep `agw_deferred_followups_done: false` while these items remain explicitly
  out of the active implementation batch.
- Flip it only after a maintainer either implements all listed deferred items or
  moves each one into a separately tracked plan/decision with its own owner and
  acceptance criteria.

## Optimization Direction

The safest optimization path is to shrink compatibility surface, not to
restructure the whole system.

Recommended order:

1. Implement AGW-L01.
2. Implement AGW-L02.
3. Implement AGW-L03 if logout/runtime-auth staleness is the next active
   incident class.
4. Implement AGW-S01 and AGW-S03 as a separate standalone gateway hardening
   batch.
5. Resolve AGW-D01 before changing local provider route scopes.
6. Add AGW-S02 only if DEN lookup volume, latency, or repeated lookup-failure
   noise justifies a small bounded stale-auth window. Prefer AGW-S03 first
   because lookup caching does not handle thrown async dependencies.
7. Add AGW-L04 only if duplicate auth priming shows measurable latency or
   request pressure.
8. Keep browser cache, sessionless fallback narrowing, redacted credential
   metadata, and provider-start UI diagnostics as follow-up work unless they
   become active incidents.

Avoid large rewrites of the gateway proxy or submit lifecycle. The current
ownership split is good enough; the risk is mostly in old escape hatches and
missing observability.

## Verification Performed

This section records the historical verification for the audit snapshot. Later
implementation agents must re-run `git status --short` and `git ls-files` before
assuming this plan is tracked or that the worktree is still clean.

Implementation verification on 2026-07-07:

- `AGW-L01` and `AGW-L02`: `bun test packages/server/src/tests/ai-gateway-runtime-owner.test.ts`
  passed with 7 tests.
- Local server AI gateway regression: `bun test packages/server/src/tests/server.ai-gateway.test.ts`
  passed with 21 tests.
- Provider-start lifecycle regression: `bun test packages/server/src/tests/server-conversations.test.ts`
  passed with 34 tests.
- `AGW-S01` and `AGW-S03`: `pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy-auth.test.ts test/user-credentials.test.ts test/proxy-openai-compatible.test.ts test/codex-oauth-proxy.test.ts`
  passed with 22 tests.
- Gateway typecheck: `pnpm --filter @neatech/ai-gateway exec tsc --noEmit`
  passed.

The original audit was performed against the live checkout on branch
`local/sandbox-merge...origin/local/sandbox-merge`. At that time, the worktree
was reported clean before this audit document was added.

Server verification:

```powershell
bun test packages/server/src/tests/ai-gateway-runtime-owner.test.ts packages/server/src/tests/server.ai-gateway.test.ts packages/server/src/tests/server-conversations.test.ts
```

Result:

```text
61 pass, 0 fail
```

App verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/managed-ai-runtime-config.test.ts src/app/tests/context/send-runtime-readiness.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/lib/provider-routing.test.ts src/app/tests/context/managed-ai-access-store.test.ts
```

Result:

```text
69 pass, 0 fail
```

Additional validation from the 2026-07-07 follow-up:

```powershell
bun --eval '
import { createAiGatewayRuntimeOwner } from "./packages/server/src/ai-gateway-runtime-owner.ts";

let now = 1000;
const owner = createAiGatewayRuntimeOwner({
  now: () => now,
  recordTrace: () => {},
});

owner.registerActiveRun({
  traceId: null,
  workspaceId: "ws",
  conversationId: "conv-a",
  runId: "run-a",
  opencodeSessionId: "sess-a",
  clientMessageId: null,
  origin: null,
  runtimeAuthorizationActorTokenHash: null,
});
owner.registerActiveRun({
  traceId: null,
  workspaceId: "ws",
  conversationId: "conv-b",
  runId: "run-b",
  opencodeSessionId: "sess-b",
  clientMessageId: null,
  origin: null,
  runtimeAuthorizationActorTokenHash: null,
});

now = 1100;
owner.recordSessionHit({
  sessionId: "sess-b",
  workspaceId: "ws",
  requestId: "req-b",
  provider: "codex_oauth",
  gatewayPath: "/v1/chat/completions",
});

console.log(JSON.stringify({
  runAStartedByRunBWorkspaceHit: owner.hasProviderHitAfter({
    sessionId: "sess-a",
    workspaceId: "ws",
    startedAt: 1000,
  }),
  runBStarted: owner.hasProviderHitAfter({
    sessionId: "sess-b",
    workspaceId: "ws",
    startedAt: 1000,
  }),
}));
'
```

Result:

```json
{"runAStartedByRunBWorkspaceHit":true,"runBStarted":true}
```

Typecheck status in the same checkout is not clean. These failures are not all
AI-gateway-specific, but they should not be ignored when treating this audit as
implementation-ready evidence:

```powershell
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
```

Current failures:

- `packages/server/src/tests/conversation-submit-service.test.ts` expects
  `ConversationSubmitResult.code` on a union variant that can be dry-run.
- `packages/server/src/tests/server-conversations.test.ts` expects `stop` on a
  `{ port: number }` value.
- `packages/app/src/app/tests/pages/session-creation-workflow.test.ts` passes a
  prompt object missing `mode` and `parts`.
- `packages/app/src/app/tests/pages/session-send-workflow.test.ts` has nullable
  string/object narrowing issues around the existing-session workflow test.

Additional gateway-auth validation from the later deep-audit pass:

```powershell
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy-auth.test.ts test/codex-oauth-proxy.test.ts test/user-credentials.test.ts
bun test packages/server/src/tests/ai-gateway-runtime-owner.test.ts packages/server/src/tests/server.ai-gateway-routes.test.ts
```

Result:

```text
@neatech/ai-gateway targeted tests: 14 pass, 0 fail
server AI gateway owner/routes tests: 7 pass, 0 fail
```

Additional validation from the async-error deep-audit continuation:

```powershell
cd services/ai-gateway

pnpm exec tsx --eval "(async () => { const { createApp } = await import('./src/index.ts'); const http = await import('node:http'); const unhandled = []; process.on('unhandledRejection', (error) => unhandled.push(error instanceof Error ? error.message : String(error))); const app = createApp({ proxy: { gatewaySessions: { resolveSession: async () => { throw new Error('den_lookup_failed'); } }, aiAccess: { getUserAiAccess: async () => ({ enabled: true }) }, credentials: {}, secrets: {}, usageRepository: {}, leaseBroker: {}, openAiTransport: {}, anthropicTransport: {}, codexOAuthTransport: {}, openAiCompatibleTransport: {} } }); const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 500); let fetchError = null; try { await fetch('http://127.0.0.1:' + port + '/providers/openai/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer den-user-token', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', messages: [] }), signal: controller.signal }); } catch (error) { fetchError = error instanceof Error ? error.name : String(error); } finally { clearTimeout(timer); await new Promise((resolve) => server.close(resolve)); } await new Promise((resolve) => setTimeout(resolve, 0)); console.log(JSON.stringify({ fetchError, unhandled })); })();"

pnpm exec tsx --eval "(async () => { const { createApp } = await import('./src/index.ts'); const http = await import('node:http'); const unhandled = []; process.on('unhandledRejection', (error) => unhandled.push(error instanceof Error ? error.message : String(error))); const app = createApp({ userCredentials: { sessionResolver: { resolveSession: async () => { throw new Error('den_me_failed'); } }, aiAccess: { getUserAiAccess: async () => null } } }); const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 500); let fetchError = null; try { await fetch('http://127.0.0.1:' + port + '/api/me/ai-access', { method: 'GET', headers: { authorization: 'Bearer den-user-token' }, signal: controller.signal }); } catch (error) { fetchError = error instanceof Error ? error.name : String(error); } finally { clearTimeout(timer); await new Promise((resolve) => server.close(resolve)); } await new Promise((resolve) => setTimeout(resolve, 0)); console.log(JSON.stringify({ fetchError, unhandled })); })();"

pnpm exec tsx --eval "(async () => { const { createApp } = await import('./src/index.ts'); const http = await import('node:http'); const unhandled = []; process.on('unhandledRejection', (error) => unhandled.push(error instanceof Error ? error.message : String(error))); const aiAccessRecord = { id: 'access-1', userId: 'user-1', enabled: true, provider: 'openai_compatible', credentialId: 'cred-1', defaultModel: 'model-a', allowedModels: ['model-a'], assignmentOrigin: 'admin_assigned', createdAt: new Date(), updatedAt: new Date() }; const app = createApp({ proxy: { gatewaySessions: { resolveSession: async () => ({ token: 'den-token', user: { id: 'user-1' } }) }, aiAccess: { getUserAiAccess: async () => aiAccessRecord }, credentials: { getBindingByCredentialId: async () => { throw new Error('credential_lookup_failed'); } }, secrets: {}, usageRepository: {}, leaseBroker: {}, openAiTransport: {}, anthropicTransport: {}, codexOAuthTransport: {}, openAiCompatibleTransport: {} } }); const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 500); let fetchError = null; try { await fetch('http://127.0.0.1:' + port + '/providers/openai_compatible/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer den-user-token', 'x-veslo-session-id': 'session-1', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'model-a', messages: [] }), signal: controller.signal }); } catch (error) { fetchError = error instanceof Error ? error.name : String(error); } finally { clearTimeout(timer); await new Promise((resolve) => server.close(resolve)); } await new Promise((resolve) => setTimeout(resolve, 0)); console.log(JSON.stringify({ fetchError, unhandled })); })();"

pnpm exec tsx --test test/proxy-auth.test.ts test/user-credentials.test.ts test/proxy-openai-compatible.test.ts test/codex-oauth-proxy.test.ts
```

Results:

```text
provider auth resolver throw: {"fetchError":"AbortError","unhandled":["den_lookup_failed"]}
/api/me/ai-access resolver throw: {"fetchError":"AbortError","unhandled":["den_me_failed"]}
openai_compatible assigned binding lookup throw: {"fetchError":"AbortError","unhandled":["credential_lookup_failed"]}
gateway regression subset with codex_oauth coverage: 18 pass, 0 fail
```

## Acceptance Criteria For Follow-Up Fixes

Any follow-up implementation that claims to resolve this audit should satisfy:

1. No generated desktop OpenCode config contains a live cloud gateway bearer.
2. Provider proxy requests still require local Veslo server caller auth.
3. New provider routing authorizes through runtime memory, not
   `x-veslo-gateway-token`.
4. Sessionless requests can be forwarded when intentional, but never count as
   provider-start evidence for a prompt run.
5. Provider-start evidence is session-correlated for the modern path and cannot
   be satisfied by another run in the same workspace.
6. Logout clears or invalidates the current actor's runtime gateway
   authorization in the local server.
7. Runtime authorization expiry/age is visible in diagnostics without exposing
   secrets.
8. Standalone gateway provider routes reject unauthenticated requests before
   parsing large JSON bodies.
9. Standalone gateway DEN session lookup failures are distinguishable from
   provider/credential failures, and normal success lookups have bounded
   positive caching or an explicit no-cache rationale.
10. Standalone gateway async auth/preflight dependency failures return bounded,
   structured HTTP responses and do not emit unhandled rejections.
11. Legacy redacted placeholders such as `[REDACTED]` never override valid
   runtime authorization.
12. Browser/non-Tauri token persistence is either removed or explicitly
   documented as a separate web-mode tradeoff.

## Non-Goals

- Do not reintroduce broad frontend fallback around server-owned submit.
- Do not make OpenCode config own cloud gateway bearer lifetime.
- Do not parse full provider request bodies in the local proxy for diagnostics.
- Do not fail accepted conversation submits synchronously only because
  provider-start evidence has not arrived yet.
