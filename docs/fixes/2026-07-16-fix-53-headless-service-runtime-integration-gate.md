# Fix 53: Headless Service-Runtime Integration Gate

Date: 2026-07-16

## Scope

This checkpoint records the deterministic local service gate for the critical
first-message path: real orchestrator `start`, compiled Veslo server, and a
test-private OpenCode executable. It also records the managed-AI correlation
defect found while extending that gate.

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
- The launcher starts real orchestrator/server children with generated client,
  host, and OpenCode Basic credentials; explicit external server/OpenCode
  binaries; no OpenCode Router; and `VESLO_DISABLE_SANDBOX=1`. Every profile,
  workspace, port, trace, and log path is isolated below the test-owned temp
  root.
- The fake OpenCode executable requires the actual generated Basic header and
  records only redacted request metadata. It covers success, delayed concurrent
  submission, deterministic session/prompt failures, and one-shot prompt retry.
- Added durable idempotency coverage across a complete local service restart.
- Direct start now retains a managed-AI active-run correlation until the
  runtime-owner TTL. Daemon-backed lifecycle runs retain their existing
  provider-watch and terminal-reconcile cleanup behavior.
- A placeholder with an ambiguous active-run context now fails locally instead
  of being forwarded without a correlatable run/session identity.
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

`check:services` now proves twelve isolated scenarios:

1. authenticated first submit, replay, conflict, direct engine health, and
   send-trace propagation;
2. typed prompt failure with draft restoration;
3. concurrent first-submit single-flight;
4. invalid payload rejection before OpenCode contact;
5. session-materialization failure with no prompt;
6. retry after a one-shot prompt failure without a second session;
7. completed-submit replay after a full service restart with no upstream call;
8. managed-AI runtime authorization and active-run session correlation through
   the local proxy.
9. cold-start rejection of a legacy placeholder before run admission, followed
   by success after the managed run is admitted;
10. fail-closed handling of two active runs in one workspace, with a real
    legacy OpenCode `x-session-id` still resolving the intended run;
11. cleared runtime authorization rejecting both redacted and stale legacy
    gateway tokens, then recovering only after a fresh access prime; and
12. typed AI Gateway upstream 5xx redaction followed by a retry through the
    same managed session.

On failure the suite preserves the owned profile and reports its sanitized
orchestrator log, fake request summary, and server/orchestrator traces. Tokens,
prompt content, and environment dumps are not written to those artifacts.

## Verification

```powershell
pnpm check:services
# passed: 12/12

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
