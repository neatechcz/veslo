# Fix 53: Headless Service-Runtime Integration Gate

Date: 2026-07-16

## Scope

This checkpoint records the deterministic local service gate for the critical
first-message path: real direct orchestrator `start` and daemon
`orchestrator daemon run` topologies, compiled Veslo server, and a test-private
OpenCode executable. It also records the managed-AI correlation defect found
while extending that gate.

It is intentionally a service-only proof. It does not start Vite, Tauri,
Solid, a browser, OpenCode Router, a real provider, or a live AI Gateway.

## Problem

Focused unit and route tests did not prove that the production service owners
could start together, preserve their authentication boundaries, and handle a
first message across process and HTTP boundaries. In particular, the direct
`orchestrator start` topology has no lifecycle daemon: a managed-AI run was
registered before `prompt_async`, then immediately unregistered. A following
provider request with `${OPENCODE_SESSION_ID}` therefore failed locally with
`gateway_session_unresolved` before reaching AI Gateway.

## Fix

- Added `pnpm check:services`: builds only the compiled server binary and runs
  the Node service integration suite. It is included in Linux `check:unit` and
  in the existing required Windows Quality job.
- The launchers start real orchestrator/server children with generated client,
  host, lifecycle, and OpenCode Basic credentials; explicit external
  server/OpenCode binaries; no OpenCode Router; and
  `VESLO_DISABLE_SANDBOX=1`. The daemon launcher deliberately supplies the
  OpenCode Basic credentials that direct `orchestrator start` otherwise derives
  for itself. Every profile, workspace, port, trace, and log path is isolated
  below the test-owned temp root.
- The fake OpenCode executable requires the actual generated Basic header and
  records only redacted request metadata. It covers success, delayed concurrent
  submission, deterministic session/prompt failures, and one-shot prompt retry.
- Added durable idempotency coverage across a complete local service restart.
- Direct start now retains a managed-AI active-run correlation until the
  runtime-owner TTL. Daemon-backed lifecycle runs retain their existing
  provider-watch and terminal-reconcile cleanup behavior.
- A placeholder with an ambiguous active-run context now fails locally instead
  of being forwarded without a correlatable run/session identity.
- Active-run lookup now scopes a concrete session id by the supplied workspace
  when it is available. A malformed upstream duplicate across workspaces is
  resolved only in its matching workspace and otherwise fails closed.
- A loopback fake AI Gateway inside the Node test process proves access priming,
  runtime authorization, `${OPENCODE_SESSION_ID}` resolution, header stripping,
  and redacted diagnostics without a live credential or network call.

## KISS Boundary

- No production test bypass or mock replaces the server or orchestrator.
- The gateway fake is an external HTTP seam only; it is not an AI Gateway
  implementation test, provider emulator, or fourth production child process.
- No UI, desktop, real provider, manual procedure, or `dev:headless-web`
  behavior changed.
- The active-run retention is bounded by the existing runtime-owner TTL; it
  does not introduce a new persistent queue, cache, or background daemon.

## Coverage

`check:services` now proves twenty-nine isolated scenarios:

1. authenticated first submit, replay, conflict, direct engine health, and
   send-trace propagation;
2. typed prompt failure with draft restoration;
3. concurrent first-submit single-flight;
4. invalid payload rejection before OpenCode contact;
5. session-materialization failure with no prompt;
6. retry after a one-shot prompt failure without a second session;
7. a dropped upstream prompt connection restores the draft; retrying the same
   client message reuses its materialized session and succeeds;
8. a conflicting request with the same client message id is rejected while the
   original prompt is still in flight, without a second upstream call;
9. a client-aborted HTTP response after OpenCode receives the prompt is
   replayed idempotently with no second upstream prompt;
10. that completed-but-unobserved submit remains replayable after a full
   service topology restart, also with no second upstream call;
11. a failed first prompt survives a full topology restart; retrying the same
   client message id reuses the materialized conversation/OpenCode session
   and sends only the missing prompt;
12. completed-submit replay after a full service restart with no upstream call;
13. an existing conversation is resolved through the server-owned canonical
   binding: a tampered client-supplied OpenCode session id cannot redirect the
   follow-up prompt;
14. an unknown existing conversation target returns a typed failure without
   creating or prompting an OpenCode session;
15. managed-AI runtime authorization and active-run session correlation through
   the local proxy.
16. cold-start rejection of a legacy placeholder before run admission, followed
   by success after the managed run is admitted;
17. fail-closed handling of two active runs in one workspace, with a real
    legacy OpenCode `x-session-id` still resolving the intended run;
18. cleared runtime authorization rejecting both redacted and stale legacy
    gateway tokens, then recovering only after a fresh access prime; and
19. typed AI Gateway upstream 5xx redaction followed by a retry through the
    same managed session; and
20. eight concurrent new chats in one workspace receive distinct OpenCode and
    conversation ids, and each concrete provider request retains its own id.
21. an existing-conversation queue admission is idempotent before its upstream
    prompt starts; an altered replay is rejected and no duplicate queue item
    or prompt is produced;
22. a pending queued follow-up survives a complete service topology restart and
    drains through the existing session without materializing another one;
23. two fast queued follow-ups for one conversation drain FIFO, proven by the
    ordered server-owned run ids in the sanitized server trace; and
24. a terminal queued upstream failure is replayed as a typed draft-restoring
    failure, while a new client message can be admitted and complete normally;
25. a real server, lifecycle daemon, pooled engine proxy, and external OpenCode
    complete one authenticated first-submit route with correlatable
    server/orchestrator traces;
26. six concurrent new chats fan out to distinct conversation/OpenCode session
    pairs while the daemon starts exactly one pooled engine;
27. a client-aborted response replays through the lifecycle daemon without a
    duplicate session, prompt, registration, or engine spawn;
28. legacy bearer and host headers cannot read daemon lifecycle state, whereas
    the real `X-Veslo-Orchestrator-Token` can read the terminal run record; and
29. disposing the daemon-owned engine is followed by a lazy respawn and a new
    successful server submit without reusing the previous chat session.

The focused runtime-owner suite additionally injects the same malformed
OpenCode session id into two workspaces. It proves resolution uses the matching
workspace and returns no active run for an unrelated or omitted workspace.

On failure the suite preserves the owned profile and reports its sanitized
direct-orchestrator or daemon/server logs, fake request summary, and
server/orchestrator traces. Tokens, prompt content, and environment dumps are
not written to those artifacts.

## Verification

```powershell
pnpm check:services
# passed: 29/29

pnpm --filter veslo-server exec bun test src/tests/ai-gateway-runtime-owner.test.ts
# passed: 14/14

pnpm audit:session-identity
# passed: scans all production source roots and enforces session-correlation invariants

pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts
# passed: 37/37

pnpm --filter veslo-server exec tsc -p tsconfig.json --noEmit
# passed

node --test scripts/quality-workflow.test.mjs
# passed: 3/3

git diff --check
# passed; CRLF notices only in the pre-existing dirty worktree
```

## Status

Implemented and locally verified. The workflow wiring is protected by the
quality-workflow contract test; this checkpoint does not claim a remote CI run
or a desktop/UI acceptance run.
