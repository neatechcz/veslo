# Server Send Composer Production-Parity Notes - 2026-07-07

This note records what the current server send-composer tests prove, where they
still differ from real production behavior, and the smallest follow-up backlog.

## Scope

- Worktree: `C:\Users\jajse\Desktop\projekty\veslo-main`
- Main test file: `packages/server/src/tests/server-conversations.test.ts`
- Related auth-loop E2E: `packages/e2e/specs/skill-registry-events-auth-loop.test.ts`
- App-side composer boundary tests:
  `packages/app/src/app/tests/context/conversation-service.test.ts`,
  `packages/app/src/app/tests/pages/session-send-workflow.test.ts`
- Polling tests: `packages/app/src/app/tests/lib/skill-registry-events.test.ts`,
  `packages/app/src/app/tests/context/skill-registry-orchestrator.test.ts`
- Runtime under test: Veslo server HTTP routes with fake OpenCode, fake lifecycle
  owner, fake managed AI gateway, and real filesystem-backed workspace fixtures.
- Dev-console incident source:
  `C:\Users\jajse\Desktop\projekty\dev-specific\dev-console-problem-07-07-2026.md`.
- Caveat: the incident log was captured while sidecars were not rebuilt, so
  source-level tests can confirm contracts but cannot prove packaged sidecar
  behavior until the sidecars are rebuilt and the run is repeated.

## What The Current Tests Actually Prove

The server tests now exercise the real server route layer, not just isolated
functions. They cover:

- `/workspace/:id/conversations/submit` dry-run behavior.
- Invalid composer payload rejection before any OpenCode contact.
- First-conversation materialization and idempotent retry.
- Duplicate sends with the same `clientMessageId` while OpenCode is slow.
- Existing conversation run admission.
- Queueing when lifecycle has an active run.
- Remote workspace lifecycle bypass.
- Workspace/conversation binding rejection before engine contact.
- Implicit skill resolution from a large local workspace skill inventory.
- Ambiguous high-score implicit skill candidates stay prompt runs instead of
  silently picking the lexicographically first skill command.
- Broken `SKILL.md` files in a large workspace inventory are ignored rather
  than crashing submit.
- Normal prompt fallback when no workspace skills or MCP config exist.
- Managed AI gateway provider-call correlation and run-scoped runtime
  authorization through the server-owned composer path.
- Placeholder session-id resolution for managed provider calls.
- Provider-start watchdog and ambiguous/stale active-run handling.
- App conversation service payload shaping before server submit: send intent
  source/origin, trace options, target directory injection, managed AI gateway
  expectation, and managed runtime authorization gating.
- Managed AI auth-prime cache expiry and request failure reporting: after the
  short success TTL expires, a failed `/ai-gateway/me/ai-access` refresh records
  `reason:"request-failed"` and the outer send trace carries that reason before
  the server submit boundary is contacted.
- App polling slow-network behavior: concurrent `pollNow()` calls share one
  in-flight request and do not create a request storm.
- Skill registry auth polling behavior: auth failures stop polling, preserve
  cursor, and restart only after the Veslo server client token rotates.

The tests are production-like at the server contract boundary because they use
HTTP, real temp workspaces, real `.opencode/skills` files, real token issuance,
the server's own runtime auth owner, and fake upstream services that record
requests.

## What They Do Not Yet Prove

They do not fully imitate shipped app behavior. Missing production evidence:

- Real Tauri desktop click/send flow.
- Real sidecar startup and restart timing.
- Real OpenCode process behavior and stream timing.
- Real MCP subprocess lifecycle.
- Browser-level typing/click interaction inside the composer component.
- Actual OS/browser timer throttling while polling in a backgrounded WebView.
- Streaming interruption after response headers are already sent.
- OS-level network failures, connection resets, and pipe/socket failures.
- Long-running app state across restart, suspend, resume, and stale local data.
- Actual WebView-visible draft restore/clear behavior after failed sends.

## Dev-Console Incident Addendum

The 2026-07-07 dev-console dump contains two sends in the same workspace:

- `send_97631bf2-1f29-4abc-8dc4-7760d820ddef`: first conversation creation
  and submit succeeded.
- `send_4ba61ed9-5079-4697-a000-216740e02121`: existing conversation submit
  failed before the server submit request was sent.

This means the most important incident path is not "composer failed to submit a
valid request to OpenCode". The second send was blocked by app-side managed AI
runtime authorization before it reached the server composer route.

### Causal Findings From The Log

| Finding | Evidence | Current read |
| --- | --- | --- |
| First send submitted successfully | `server:conversation-run:opencode-submit` and `server:conversation-run:submitted` for `send_97631bf2...`; `sendPromptImmediate:result` has `accepted:true`, `status:"submitted"`, `draftDisposition:"clear"`. | Not a blanket OpenCode submit outage. |
| Second send failed at managed runtime auth-prime | `submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime:end` took `26759ms`, then `ready:false`, then `sendPrompt:server-submit-existing:error` with `Managed AI gateway authorization is not ready for this runtime.` | High confidence root gate for the visible send failure. |
| The exact auth-prime cause was not present in the captured trace | The captured source before this slice only recorded boolean `ready`; the inner `managed-ai-runtime-config.ts` path knew the reason but `conversation-service.ts` did not carry it into the outer send trace. | Fixed at source level: the outer send trace now includes `authPrimeDiagnosticReason` and `authPrimeDiagnostic` when auth-prime returns `false`. |
| Auth-prime cache expiry explains why first send could pass and second could re-prime | `RUNTIME_AUTH_PRIME_SUCCESS_TTL_MS = 15_000`; first auth-prime succeeded around `16:35:29`, second send started around `16:36:01`. | The second send had to revalidate runtime auth instead of using the first send's success cache. |
| Cloud/Den reachability was unhealthy around the same time | `[boot] validateDenAuth (bg) result= unreachable`; `/hub/mcp` timed out after `10000ms`; diagnostics upload to `https://api.veslo.work/v1/desktop-diagnostics` failed with Windows `os error 10060`. | Supports a network/upstream hypothesis, but does not prove the `/ai-gateway/me/ai-access` failure without the missing inner auth-prime event. |
| Skill registry event polling hit auth/fetch failures | Browser logged `GET /v1/skill-registry-events?... 401`, then later `502`; app logged `SkillRegistryEventsAuthError: HTTP 401` and `Error: HTTP 502`. | Real separate bug cluster. Browser status alone does not distinguish local Veslo client-token failure from upstream registry auth unless the response body/error code is captured. |
| Workspace skill materialization was degraded, but not the direct send blocker | Initial materialization sync timed out after `30000ms`; later `workspace-skill-materialization` recorded `degraded` with `skill_registry_fetch_failed`, `status:502`; immediately after that `ensure-engine:skills-ready` became `true` and runtime startup continued. | Nonblocking by current design for registry fetch errors. It can still create slow/noisy startup and should be tested separately. |
| SSE retry happened after the first send was already running | `session.sse:arrival-gap`, `sse-session-status status:"retry"` for the first session. | Worth watching, but it did not cause the second send's auth-prime rejection. |

### Code Paths To Keep In View

- `packages/app/src/app/context/conversation-service.ts`: app-side submit
  calls `ensureManagedAiRuntimeAuthorizationForSend`; if it returns `false`,
  it throws `Managed AI gateway authorization is not ready for this runtime.`
- `packages/app/src/app/context/managed-ai-runtime-config.ts`: auth-prime
  calls `runtimeClient.getMyAiAccess(userToken)`, caches success for 15 seconds,
  and records the real reason as `managed-ai-runtime-auth-prime:skip`,
  `managed-ai-runtime-auth-prime:result`, or
  `managed-ai-runtime-auth-prime:error`.
- `packages/app/src/app/lib/veslo-server/client.ts`: local runtime
  `/ai-gateway/me/ai-access` client timeout is `30000ms`.
- `packages/server/src/routes/ai-gateway.ts`: server route for
  `/ai-gateway/me/ai-access`.
- `packages/app/src/app/lib/skill-registry-events.ts`: 401/403 stops the
  registry event listener and calls `onUnauthorized`; other non-OK statuses
  report `HTTP <status>` and keep the listener schedulable.
- `packages/app/src/app/context/skill-registry-orchestrator.ts`: current
  dirty fix keeps the event listener stopped when server reacquire returns the
  same stale local client token.
- `packages/app/src/app/context/workspace-skill-materialization.ts`: registry
  fetch failures are classified as `degraded` and return `true`, so runtime
  boot can continue.
- `packages/server/src/skill-registry-client.ts`: upstream registry failures
  map to `skill_registry_unauthorized`, `skill_registry_forbidden`,
  `skill_registry_not_found`, or `skill_registry_fetch_failed`.

## Hypothesis Matrix

| Hypothesis | Confidence | Existing coverage | Missing proof |
| --- | --- | --- | --- |
| H1: second send failed because `/ai-gateway/me/ai-access` was unreachable, timed out, or returned an unusable access bundle after auth-prime cache expiry. | Medium-high for the gate, medium for the exact upstream reason. | `managed-ai-runtime-config.test.ts` now covers first success, TTL expiry, second request failure, stable `request-failed` diagnostic, and retained diagnostic state. `conversation-service.test.ts` covers false auth-prime blocking submit and the outer send trace carrying that diagnostic before server contact. | A live Pilot rerun after sidecar rebuild to confirm the packaged desktop runtime emits the same diagnostic in the visible dev console. |
| H2: stale local Veslo server client token caused registry event 401 and could restart a polling loop. | High for the failure mode targeted by the current dirty fix. | `packages/e2e/specs/skill-registry-events-auth-loop.test.ts` starts a source server, verifies stale token `401` vs live token `200`, and asserts the listener does not restart against the same stale token. | Re-run after sidecar rebuild to confirm packaged runtime token rotation behaves the same. |
| H3: upstream registry/Den outage caused registry event `502` and skill materialization `degraded`, but send should continue. | Medium-high. | `message-send-registry-degraded.toml` is a Pilot scenario that waits for AI access, sends a real message, and asserts skill registry errors do not leak into the send flow. | Need a fresh run after sidecar rebuild/live auth. Also add a source-level server route test that captures upstream registry `401/502` response bodies so browser logs can be classified. |
| H4: `/hub/mcp` Den catalog timeout is startup noise, not the direct second-send cause. | Medium. | `server.hub-mcp.test.ts` covers missing-token and happy-path catalog behavior. | Add timeout/error-path coverage for the Den catalog fetch and assert diagnostics do not block send readiness. |
| H5: repeated provider routing/config patching is drift from startup or stale sidecars, not the immediate send failure. | Medium. | Server composer tests cover provider-call correlation, but not sidecar config patch timing. | After rebuilding sidecars, rerun `pnpm dev` and compare `apply-gateway-provider-routing`, `/workspace/:id/config`, and `/status.runtimeChain` logs. |

## Proposed Reproduction Plan

Use the smallest source-level tests first, then one live Pilot scenario only
after sidecars are rebuilt.

1. Source-level managed AI auth-prime reproduction. Done in this slice.

   - Add a test around `createManagedAiRuntimeConfigSync` where the first
     `getMyAiAccess` succeeds, time advances past the success TTL, then the
     second `getMyAiAccess` rejects or never resolves until timeout.
   - Assert it records `managed-ai-runtime-auth-prime:error` with
     `reason:"request-failed"`.
   - Add a companion `conversation-service` test proving the submit path records
     `ready:false`, does not call `submitConversation`, and carries the stable
     diagnostic reason into the outer send trace.

2. App/Pilot send-after-cache-expiry imitation.

   - Start with the existing live-inference harness pattern from
     `message-send-registry-degraded.toml`.
   - Send one message and wait for submit success.
   - Wait more than 15 seconds, then force `/ai-gateway/me/ai-access` to fail
     through a fixture/proxy or explicit dev toggle.
   - Send a second message to the existing session.
   - Assert the second send fails before `/workspace/:id/conversations/submit`,
     the draft is restored, and the visible/logged reason includes the inner
     auth-prime diagnostic, not only the generic boolean `ready:false`.

3. Registry degraded send imitation.

   - Run the existing Pilot scenario:

     ```text
     pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario message-send-registry-degraded
     ```

   - This confirms registry degradation is not supposed to break a real send.
     It does not prove the second-send auth-prime failure.

4. Registry auth-loop source E2E.

   - Run:

     ```text
     pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm specs/skill-registry-events-auth-loop.test.ts
     ```

   - This confirms the stale-token loop hypothesis at the source-server level.

## Diagnostics Gap

Before this slice, the outer send trace lost the causal reason for auth-prime
failures: `submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime:result`
recorded only `ready:false`. The source fix now carries a stable diagnostic
reason from `ensureManagedAiRuntimeAuthorizationForSend` into the send trace:

- `missing-user-token`
- `provider-routing-target-missing`
- `access-profile-unavailable`
- `request-failed`

The remaining useful diagnostic is a response-status/error-body classifier for
`/ai-gateway/me/ai-access`; keep that as a narrow follow-up only if the next
run still cannot distinguish timeout from HTTP failure.

## Validation Run

Latest focused validation:

```text
pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts src/tests/skill-resolver.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/managed-ai-runtime-config.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/skill-registry-events.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/skill-registry-orchestrator.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-e2e exec tsc --noEmit
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm specs/skill-registry-events-auth-loop.test.ts
git diff --check
git diff --cached --check
```

Observed result:

- `server-conversations.test.ts` + `skill-resolver.test.ts`: 48 passed.
- `managed-ai-runtime-config.test.ts`: 16 passed.
- `conversation-service.test.ts`: 20 passed.
- `session-send-workflow.test.ts`: 31 passed.
- `skill-registry-events.test.ts`: 6 passed.
- `skill-registry-orchestrator.test.ts`: 7 passed.
- E2E auth-loop test: 1 passed.
- App typecheck passed.
- Server typecheck passed.
- E2E typecheck passed.
- Diff checks passed with Windows CRLF warnings only.

## Implemented In This Slice

- Added a server submit scenario where two workspace skills tie at high score;
  the route must submit a normal `prompt_async` run, not a command.
- Added a resolver unit test for the same tied high-score implicit skill case.
- Fixed `resolveSkillMatch` so a score-1 tie is still ambiguous unless the best
  candidate has a unique exact-name or alias mention.
- Added a malformed skill fixture to the large-inventory path.
- Isolated HOME/USERPROFILE/XDG_CONFIG_HOME in the no-skills and many-skills
  submit scenarios so real user global skills cannot affect the contract.
- Added app conversation-service tests for the composer-to-server submit
  boundary: target directory overwrite, source/origin preservation, trace
  forwarding, managed prompt authorization gating, and shell submit without AI
  gateway expectation.
- Added managed AI auth-prime diagnostics plumbing from runtime config into the
  outer send trace, plus tests for success-cache expiry followed by
  `request-failed` and submit blocked before server contact.
- Added a slow-network polling test proving concurrent `pollNow()` calls share
  one in-flight request and advance cursor/revision only once.

## KISS Follow-Up Backlog

Highest-value next tests, in order:

1. Rebuild sidecars, then rerun one desktop/Pilot smoke that sends once, waits
   past the 15s auth-prime success TTL, sends again, and confirms the dev
   console includes `authPrimeDiagnosticReason` if the second send is blocked.
2. Add one narrow server route test for registry `401/502` response-body
   classification only if browser logs still cannot identify local-token versus
   upstream failure.
3. Add one browser/component-level composer test only if the next failure smells
   like DOM key handling, draft state, or button intent. The current app-service
   boundary already proves the server payload shape.
4. Keep richer chaos cases out unless a real bug needs them.

## Practical Test Best Practices For This Area

- Prefer server HTTP tests for route contracts and admission behavior.
- Prefer Pilot only when the desktop shell, WebView, sidecars, or visible UI
  state are the thing under test.
- Assert upstream request history, not only response status.
- Assert key trace/debug events for gateway/lifecycle flows.
- Use real workspace files for skills and MCP config instead of synthetic
  resolver mocks.
- Keep fake upstreams simple and local to each scenario until duplication hurts.
- Avoid broad fixture frameworks until at least three tests need the same shape.

## Follow-Up Audit: Later Immediate Send Failures

This pass checked the later 20:51-21:07 incident report against the current
source tree, persistent app-data stores, and available spool logs. Sidecars were
not assumed to be rebuilt. The exact handles from the pasted report
(`ae9c6ef8`, `ws-f61de366244b`, orchestrator port `60700`) were not present in
the local spool snapshot available during this audit, so those handles remain
externally reported rather than locally re-proven. The failure classes are still
confirmed by source and persistent state.

### Confirmed Causal Classes

1. The client message id is still passed through as OpenCode `messageID`.

   `packages/server/src/routes/conversations.ts` still builds the OpenCode
   prompt/command body with `body.messageID = request.clientMessageId`.
   `packages/app/src/app/lib/session-send-contract.ts` still creates that id
   from `crypto.randomUUID()`, and `session-conversation-flow.ts` generates a
   fresh id for sends. Persistent submit attempts also show OpenCode submit
   bodies containing random `msg_...` values as `messageID`.

   This confirms the original payload shape has not been changed. The remaining
   contract question is whether OpenCode expects `messageID` to be omitted for a
   new user message, or to reference a durable server/OpenCode message id. A
   route-level contract test should lock that down before changing broad send
   behavior.

2. A stale active run can block the queue indefinitely.

   The lifecycle controller has `markFailed` plumbing, but the provider-start
   timeout path records diagnostics and schedules reconcile instead of failing
   the run. Reconcile exhaustion records
   `server:conversation-run:lifecycle-reconcile-exhausted` and returns; it also
   does not fail the run. Queue drain checks the latest lifecycle run first and,
   if it is active, only schedules another drain.

   Current tests encode this behavior:
   `conversation-run-lifecycle-controller.test.ts` has
   `submitRun provider-start timeout records diagnostics without failing or
   aborting OpenCode` and asserts no `markFailed` call.

   Persistent state confirms this is not theoretical. The local
   `runs.sqlite` still had a `running` row for
   `2734ec7a-74a6-436a-803f-e43a411f1b79` with engine
   `http://127.0.0.1:51768`, `wait_reason = assistant_message_open`, and no
   terminal timestamp, while the current runtime/process state was stale or
   gone. The exact queued row from the pasted incident was not present locally
   anymore, but the controller behavior explains why a subsequent submit would
   return queued and then never drain while the stale active run stays active.

3. Server-created local workspaces are not guaranteed to be registered in the
   orchestrator before submit.

   `packages/server/src/routes/workspace-management.ts` handles
   `POST /workspaces/local` by adding the workspace to server config and
   automation metadata. It does not register that workspace with the
   orchestrator. Orchestrator registration is owned by Tauri-side paths:
   `register_workspace_with_orchestrator`,
   `reconcile_orchestrator_workspaces`, and
   `orchestrator_workspace_activate` in
   `packages/desktop/src-tauri/src/commands/orchestrator.rs`.

   The orchestrator returns `404 { error: "workspace not found" }` for
   `/workspace/:id/opencode/...` when its router does not know the workspace.
   Therefore a server-owned composer/private-workspace submit can fail
   immediately with a 404 if activation/registration did not complete, raced, or
   was bypassed. Some UI private workspace creation paths do call
   `activateWorkspace(...)`, but `submitConversationFromVesloWriteApi` only
   resolves/registers the workspace with the Veslo server before calling server
   submit; it does not itself assert orchestrator readiness.

### Non-Causal Noise In The Same Window

- `Cannot find package 'zod'` fits a transient dependency/install or stale
  sidecar state during development. It is a startup/runtime health problem, but
  not the causal path for the confirmed queue blockage or orchestrator 404.
- Repeated `GET /v1/skill-registry-events 401` appears in spool logs and should
  stay classified as diagnostic noise unless a send attempt explicitly depends
  on that stream.
- The live runtime state during audit was not a reliable reproduction target:
  the advertised server/orchestrator ports had changed or gone stale, and
  `/health`/`/status` could not be used as proof of current readiness.

### Minimum Test Additions

1. Lifecycle watchdog test: simulate a submitted run whose provider never starts
   and whose lifecycle status remains active through the reconcile budget. The
   expected behavior should become `markFailed(...)`, queue-drain wakeup, and a
   terminal run state. This replaces the current test expectation that timeout
   diagnostics are enough.
2. Queue unblock test: create an active stale/latest run plus a pending queue
   item. After watchdog/reconcile exhaustion, assert the active run is terminal
   and the queued item is submitted instead of endlessly rescheduled.
3. Private workspace registration test: create or fake a server-local workspace
   that is known to Veslo server but absent from orchestrator, then send through
   the server-owned composer path. Assert a structured
   `workspace_not_registered_in_orchestrator` or equivalent diagnostic, and add
   the success variant where orchestrator activation happens before submit.
4. Message id contract test: capture the outbound OpenCode body for first and
   subsequent prompt sends. Assert the intended contract explicitly: either
   `messageID` is omitted for new user messages, or it is mapped to a durable
   server/OpenCode message id rather than a fresh UI UUID.

### Fix Direction

The lowest-risk order is:

1. Fix lifecycle terminalization first. A stale active run should not survive
   watchdog/reconcile exhaustion as `running`, because that blocks unrelated
   later sends in the same conversation.
2. Add an app/server preflight for server-owned local workspace sends so Veslo
   does not call `/workspace/:id/opencode/session` until the orchestrator knows
   that workspace, or surfaces a precise registration error.
3. Resolve the OpenCode `messageID` contract and update the route payload only
   after a narrow contract test proves the intended shape.

## Current Conclusion

The current server and app-boundary tests are meaningful, but the later incident
shows the send path still has three unclosed production-parity gaps: stale run
terminalization, orchestrator registration for server-owned local workspaces,
and the OpenCode `messageID` contract. The next KISS step is not a broad chaos
suite; it is the four targeted tests above, followed by one packaged
desktop/Pilot smoke after sidecar rebuild.
