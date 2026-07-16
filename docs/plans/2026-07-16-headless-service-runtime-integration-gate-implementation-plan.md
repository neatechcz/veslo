---
title: Headless service-runtime integration gate implementation plan
date: 2026-07-16
target: local Veslo server, orchestrator, deterministic fake OpenCode engine, quality gate
status: implementation-in-progress
done: false
base_branch: main
baseline_worktree: dirty
related:
  - docs/dev/engineering-quality-gates.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/plans/2026-07-15-engineering-quality-gates-and-actionable-crash-diagnostics-kiss-implementation-plan.md
---

# Headless service-runtime integration gate

## Goal

Add one deterministic, UI-free integration gate that starts the real local
service topology and proves the critical first-message path across process and
HTTP boundaries:

```text
veslo-orchestrator start owner
  -> veslo-server -> fake OpenCode executable
```

The gate must catch a broken server binary, bad orchestrator startup arguments,
direct local OpenCode wiring regressions, first-message route regressions and
unbounded failure handling before a desktop build is needed.

It is deliberately **not** a replacement for the focused Tauri recovery lane.
It cannot prove Solid rendering, WebView behavior, native commands, or a
renderer crash fallback.

## Verified starting point

- `dev:headless-web` is useful evidence of the intended dev service command
  shape, but it owns Vite and an optional OpenCode Router. This plan does not
  refactor or otherwise change that developer command.
- The orchestrator accepts an external `--opencode-bin` with
  `--allow-external`; it launches that program as
  `serve --hostname <host> --port <port>`. This is the supported seam for a
  deterministic fake engine. Do not add a production-only test bypass to the
  orchestrator.
- In the current development `start` mode, the orchestrator owns the local
  server and OpenCode child processes, while the server talks to the configured
  local OpenCode URL directly. Workspace-mount registration belongs to the
  daemon topology, not this 1:1 dev-mode gate.
- The current route audit extracts registrations and app client paths from
  source; it is a hard duplicate-route guard, not a generated typed API schema.
  Its current report is 178 server routes, 95 client path strings, six
  non-blocking unmatched client warnings, and 83 informational server routes.
- The existing quality plan explicitly avoids a general orchestration runner.
  This follow-up therefore adds only a narrow test fixture with one topology,
  fixed lifecycle, and ordinary test output. It does not add a task DSL, cache,
  generic daemon, JSON result protocol, or changed-file routing.

## Decisions and boundaries

| Decision | Chosen approach | Explicitly not doing |
| --- | --- | --- |
| Runtime under test | Exactly three service processes: real server binary, real orchestrator, fake OpenCode child | Mock either production owner in the integration test or start OpenCode Router |
| Engine | `scripts/test-fixtures/fake-opencode.js`, run by Node through the existing `--opencode-bin` seam; retain start-mode OpenCode Basic auth and require it in the fake | A generic executable script, a provider call, provider credentials, network, or a real model response |
| UI | No Vite, Tauri, browser, Solid, or Pilot process | Renaming this as desktop E2E |
| Isolation | Unique ports, tokens, data directory, workspace directory and trace directory per test run | Reusing a developer profile or repository data store |
| Cleanup | Await normal shutdown; on timeout terminate only recorded child process trees and report their logs | Global process-name cleanup or deleting a shared directory |
| Determinism | Explicit external server/fake-engine binaries, Router disabled, `VESLO_DISABLE_SANDBOX=1` | Default sidecar/OpenCode resolution or Windows WSL sandbox auto-selection |
| Gate placement | New `check:services` in Ubuntu `Quality / Unit` and a dedicated Windows job in the existing Quality workflow | A second workflow or a silent optional command |

### Dev-parity rule

The service test uses the same `veslo-orchestrator dev -- start` ownership and
startup surface as local development. Its only intentional deviations are the
temporary loopback profile, explicit external server/fake-engine paths,
`--no-veslo-code-router`, and `VESLO_DISABLE_SANDBOX=1`. Those deviations are
part of the test contract and must be visible in its launch log. The test does
not change `dev:headless-web` to obtain that parity.

## Public commands after implementation

| Command | Contract |
| --- | --- |
| `pnpm check:services` | Builds only the required local service binary, starts the isolated service topology, runs the service-runtime integration suite, and tears it down. No UI process starts. |
| `pnpm check` | Continues to be the normal handoff command; its `check:unit` stage invokes `check:services`. |

`check:desktop-recovery` remains a separate required desktop lane. It must not
be folded into `check:services`.

## Implementation phases

### HS00 — Freeze the test contract and baseline the duration

done: false

1. Record cold and warm timings for the existing server build, orchestrator
   startup and one current focused server/orchestrator test. Record platform and
   Bun/Node versions with the result.
2. Define the first stable service suite around these core scenarios:
   - server and orchestrator reach ready health with no UI process;
   - the server exposes its start-mode workspace through the generated client
     token;
   - the atomic first-submit route materializes one session and sends one run
     to the fake engine;
   - replaying the same client message/run identity does not cause a second
     upstream prompt submission, and an upstream 5xx returns a bounded server
     failure while both owner processes remain healthy.
3. Confirm the exact current request bodies and terminal response shapes from
   the server's existing conversation route tests. The new suite must assert
   public HTTP behavior, not copied internal helper calls.

Acceptance:

- no scenario needs a cloud token, a live provider, an existing workspace or a
  user profile;
- the expected request count and terminal statuses are written down before the
  harness implementation;
- scope remains the service boundary, not UI crash reproduction.

### HS01 — Implement a standalone, service-test launcher

done: false

Create a small launcher module under `scripts/` used only by
`check:services`. It must not modify, import, or refactor `dev:headless-web`.
It owns only:

1. resolving unique loopback ports and random server/host tokens;
2. creating an isolated temporary data/workspace/trace directory;
3. locating or building `veslo-server` when the caller permits a build;
4. spawning `veslo-orchestrator dev -- start` with this explicit test command
   shape:

   ```text
   --workspace <temporary workspace>
   --approval auto
   --allow-external
   --sidecar-source external
   --opencode-source external
   --veslo-server-bin <absolute built veslo-server path>
   --opencode-bin <absolute scripts/test-fixtures/fake-opencode.js path>
   --no-veslo-code-router
   --veslo-host 127.0.0.1
   --veslo-port <reserved loopback port>
   --veslo-token <random token>
   --veslo-host-token <random token>
   ```

   Its child environment sets `VESLO_DISABLE_SANDBOX=1` unconditionally. This
   is the existing cross-platform kill switch for automatic sandbox/WSL
   selection; it is a deterministic test setting, not a production fallback.
   It also sets these existing trace controls to test-owned paths:

   ```text
   VESLO_SEND_WORKFLOW_TRACE=1
   VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE=<temporary trace>/server.ndjson
   VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE=<temporary trace>/orchestrator.ndjson
   ```

5. polling server and orchestrator readiness with a bounded timeout; client
   authentication is asserted by the first protected HTTP call, not by public
   `/health`;
6. capturing stdout/stderr per owned process and stopping only those children.

The launcher returns a typed/structural handle containing base URLs, tokens,
workspace id/path, log paths, trace paths, child PIDs and `close()`. It must
expose no generic command runner API. The test runner itself is not part of the
three-process topology.

Acceptance:

- a launcher smoke test proves no Vite or OpenCode Router process is spawned;
- all *runtime* profiles, workspace directories, logs and traces are below the
  test-owned temporary root. The prebuilt server binary remains the intentional
  build artifact under `packages/server/dist/bin` and is not runtime state;
- timeout errors include service logs and the last health response without
  emitting secrets;
- normal completion and a deliberately failed readiness path leave no owned
  child alive;
- no production CLI flag or runtime fallback is added solely for testing.

### HS02 — Add the deterministic fake OpenCode Node entrypoint

done: false

Create exactly `scripts/test-fixtures/fake-opencode.js`, consumed as its
absolute `.js` path through the existing external `--opencode-bin` contract.
The orchestrator's existing command resolution runs a `.js` entrypoint through
Node on Windows and Linux; do not rely on a shebang, executable bit, `.mjs`, or
an implicit shell wrapper. It must parse the normal
`serve --hostname --port` arguments and implement only these required
endpoints:

- `GET /global/health` for orchestrator readiness;
- `POST /session` returning a deterministic engine session id;
- `POST /session/:id/prompt_async`, recording a redacted request counter and
  returning an accepted terminal envelope;
- the minimal read/event endpoint that the selected server flow actually
  requires, discovered in HS00.

Its behavior is controlled exclusively by a test-private environment variable:
normal success, a bounded prompt delay, deterministic session/prompt 5xx, or a
single prompt 5xx followed by success for retry coverage.
It must never inspect real
OpenCode configuration, read provider credentials, or make an outbound request.
It must require the generated start-mode OpenCode Basic authorization header on
every request and record only whether it was accepted, never its value.
The fixture emits a compact redacted request log to the test-owned trace
directory so the integration test can assert one upstream prompt and diagnose
failures.

Acceptance:

- the `.js` fake runs on Windows and Linux using the orchestrator's existing
  Node resolution;
- it succeeds when invoked with the actual orchestrator argument form;
- it records no message body or token in logs;
- its endpoint surface stays minimal and is not presented as an OpenCode mock
  framework.

### HS03 — Implement HTTP-level service integration tests

done: false

Create one Node integration test file under `scripts/` that uses the launcher
and talks only to the server's public loopback HTTP API. It may use a small
request helper local to this suite; it must not import server or orchestrator
implementation internals.

The initial HTTP matrix is fixed before coding:

| Case | Request | Required headers/body | Expected result |
| --- | --- | --- | --- |
| Server readiness | `GET /health` | no auth; this route is intentionally public | `200`; server pid/instance health is usable |
| Workspace lookup | `GET /workspaces` | `Authorization: Bearer <client token>` | `200`; capture the start-mode workspace id and temporary directory |
| Local auth and topology | `GET /approvals`, `GET /status` | correct `X-Veslo-Host-Token`, then `Authorization: Bearer <client token>` | host token is required; direct start reports `runtimeChain.status: "server_running"` with no daemon configured |
| Atomic first submit | `POST /workspace/<id>/conversations/submit` | `Authorization: Bearer <client token>`, `x-veslo-send-trace-id: service-gate-first-submit`, JSON `{ clientMessageId: "service-gate-message-1", origin: "session:normal", source: "enter", target: { directory: <temporary workspace>, pendingClientSessionId: "pending-service-gate" }, draft: { mode: "prompt", text: "service gate", parts: [{ type: "text", text: "service gate" }] } }` | `200`, `status: "submitted"`; exactly one fake `POST /session` with a server-chosen id and one fake `POST /session/<id>/prompt_async`; the normalized upstream prompt body has only one text part and the trace id |
| Direct OpenCode health | `GET /workspace/<id>/opencode/global/health` after first submit | bearer token | `200`; fake engine observes the server-injected directory context |
| Idempotent replay | identical atomic first-submit request, then same `clientMessageId` with a changed draft | same headers/body | exact replay gives the identical `200` payload; changed replay gives `409 idempotency_conflict`; neither causes a second fake `/session` or `prompt_async` |
| Concurrent retry | two identical first-submit requests while the fake delays `prompt_async` | same headers/body | both receive the same `200` payload; exactly one fake `/session` and `prompt_async` prove in-flight deduplication |
| Retry after prompt failure | identical first-submit request after a fake one-shot `prompt_async` 5xx | same headers/body and client message id | first result restores the draft; retry submits through the already materialized conversation/session; exactly one fake `/session` and two prompts |
| Durable replay after restart | identical completed first-submit request after stopping and starting the full local service topology with the same isolated data profile | same headers/body and client message id | exact `200` replay; the restarted fake receives no `POST /session` or `prompt_async` |
| Managed-AI gateway handoff | prime `GET /workspace/<id>/ai-gateway/me/ai-access`, submit with `expectAiGatewayStart: true`, then send a provider request carrying `${OPENCODE_SESSION_ID}` | generated client/caller credentials, workspace id and placeholder session header | runtime authorization reaches the loopback gateway fake; placeholder resolves through the active run context; the upstream sees only its resolved session id and no local/internal headers or message content in diagnostics |
| Cold managed-AI startup | prime access but send `${OPENCODE_SESSION_ID}` before any managed run, then repeat after first-run admission | generated client/caller credentials and workspace id | first request is local `400 gateway_session_unresolved` with no upstream contact; admitted run resolves and forwards normally |
| Ambiguous managed-AI runs | submit two managed runs in one workspace, then send a placeholder; retry with the second run's legacy OpenCode `x-session-id` | generated credentials, same workspace id, placeholder plus optional OpenCode session header | ambiguous placeholder is local `400 gateway_session_unresolved` with no upstream contact; explicit legacy session header resolves the intended run and internal headers remain stripped |
| Runtime-auth clear/reprime | clear runtime authorization after admission, try redacted and stale legacy gateway tokens, then read access again | generated client/caller credentials and admitted session | both stale forms reject locally with typed `401`; no legacy fallback reaches upstream; only a fresh access prime restores provider forwarding |
| Gateway 5xx and retry | fake gateway returns one provider `503`, then success for the same admitted session | generated credentials and resolved session | server maps the failure to typed `502 ai_gateway_upstream_failed`, redacts the runtime token from diagnostics, and a retry succeeds without a new conversation/session |
| Invalid request | malformed `draft.parts` | authenticated submit with a non-array `parts` value | `400 invalid_payload`; fake receives no `/session` or `prompt_async`; subsequent `/health` remains `200` |
| Upstream prompt failure | atomic first submit in a fresh fake-5xx profile | same headers with a new message id; fake returns `500` only from `prompt_async` | `200` with `status: "failed"`, `code: "opencode_request_failed"`, `draftDisposition: "restore"`, and `debugTrace[0].upstreamStatus: 502`; subsequent `/health` remains `200` |
| Upstream session failure | first atomic submit in a fresh fake-5xx profile | same headers with a new message id; fake returns `500` from `/session` | `200` with `status: "failed"`, `code: "conversation_create_failed"`, `draftDisposition: "restore"`, upstream `opencode_request_failed/502`, no `prompt_async`, and subsequent `/health` remains `200` |

The matrix deliberately asserts only server-owned HTTP fields and fake request
counts. It does not assert UI drafts, renderer state, a provider response, or
an unspecified generic bounded failure.

The managed-AI row uses a loopback listener inside the Node test process, not a
fourth production child or a live gateway. It records a redacted request summary
under the isolated profile and proves the server proxy boundary: caller auth for
the access read, runtime auth for the provider call, resolved session correlation,
and stripping of local/internal headers before forwarding.

Implement the matrix in one serial suite. Each ordinary case gets a fresh
launcher/profile so database state, ports and engine request counts cannot leak
between cases; the durable-replay case intentionally reuses one isolated profile
across a complete stop/start cycle. Assert:

1. readiness contains the expected server instance identity; client and host
   protected calls reject a wrong credential and accept the generated runtime
   credential; direct start reports its non-daemon runtime topology explicitly;
2. the protected workspace lookup returns the start-mode workspace and direct
   OpenCode health reaches the fake engine with the configured directory;
3. atomic first submit materializes a server-owned session and produces exactly
   one fake `/session` plus one `prompt_async` request;
4. replay preserves idempotency; the fake 5xx yields the typed `failed`
   `opencode_request_failed` result with upstream status `502`, and subsequent
   health proves the service topology has not crashed.

The successful submit must carry the supplied trace id through
`server:conversation-run:opencode-submit`; the test-owned server and
orchestrator trace files must record the OpenCode completion and engine spawn.

On failure, print the profile directory, sanitized child logs, fake-engine
request summary, the server/orchestrator send-trace event names and the exact
failing HTTP status. Do not print bearer tokens, message content or environment
dumps. A passing first-submit assertion must find the server submit event and
the orchestrator engine-spawn event in the test-owned traces/logs.

Acceptance:

- the suite makes no intentional non-loopback request and CI provides no
  provider credential to it;
- a deliberate wrong server token, wrong workspace id, duplicate replay and
  fake upstream 5xx each fail or pass according to their specified contract;
- failure reproduces with the single new command;
- repeated runs do not leave port listeners, child processes or tracked files.

### HS04 — Wire the gate into quality and document its limits

done: false

1. Add root `check:services` that builds the required server binary and runs
   the service integration test. It does not build OpenCode Router and fails if
   the launcher starts one.
2. Invoke it from `check:unit` after the focused server/orchestrator suites, so
   the existing Ubuntu `Quality / Unit` CI job runs the same command.
3. Add a `Quality / Services (Windows)` job to the existing
   `.github/workflows/quality.yml`. It installs the existing Node/pnpm/Bun
   toolchain and runs `pnpm check:services`; the aggregate `Quality / Gate`
   explicitly requires this job. This is a new job, not a new workflow.
4. Add a direct quality-workflow contract test that fails if `check:services`
   disappears from `check:unit`, the Windows service job stops calling it, or
   the aggregate stops requiring that job.
5. Update the engineering quality-gates and testing documentation with:
   - what service failures this lane catches;
   - that it starts no UI and is not a renderer/desktop proof;
   - the single reproduction command;
   - where sanitized test artifacts are retained on failure.

Acceptance:

- `pnpm check:services` is non-interactive, fail-fast and does not silently
  skip a missing binary or fixture;
- `pnpm check` includes the new lane exactly once;
- Ubuntu `Quality / Unit` and `Quality / Services (Windows)` each run the same
  required command, and the aggregate requires both;
- no existing desktop/Pilot scenario is removed or relabelled as covered.

### HS05 — Verify reliability and gate value

done: false

Run the focused suite repeatedly on Windows and Linux CI-equivalent
environments. Verify the process inventory during the run contains the
orchestrator, its real server child and its fake OpenCode child, but no Vite or
OpenCode Router. Then perform controlled mutations in a disposable worktree:

- break an orchestrator argument or server-binary path;
- make the direct local OpenCode target incorrect;
- make first-run submission issue two upstream prompt requests;
- make the fake engine return 5xx.

Each mutation must make `check:services` fail for the correct reason. Restore
the mutations before handoff.

Final verification:

```text
pnpm check:services
pnpm check:unit
pnpm check
pnpm check:desktop-recovery
```

Record cold/warm time separately. If the service lane is too slow, first remove
unnecessary router/UI work or duplicate builds; do not make it optional,
baseline a known failure, or reduce its assertions without an explicit follow-up
decision.

## Expected file surface

| Action | Surface |
| --- | --- |
| Create | standalone headless-service test launcher and its focused tests under `scripts/` |
| Create | deterministic `fake-opencode.js` fixture under `scripts/test-fixtures/` |
| Create | service-runtime HTTP integration test under `scripts/` |
| Modify | root package scripts, existing Quality workflow, and quality-workflow contract test |
| Modify | engineering quality-gate and testing/startup documentation |

No app UI component, `dev:headless-web` behavior, Tauri production command,
cloud deployment, provider credential, global reactivity rule, or full Pilot
suite belongs to this plan.

## Risks and stop conditions

- If real server plus orchestrator cannot start against the explicit `.js` fake
  entrypoint without adding test-only production branching, stop after HS01 and document
  the missing public seam. Do not hide the issue behind a mock of either owner.
- If child cleanup cannot be made reliable on Windows using only recorded PIDs,
  do not add broad process-name cleanup; fix the launcher lifecycle first.
- If first-message behavior requires an unbounded OpenCode API surface, narrow
  the first gate to health/direct-engine wiring and create a separately reviewed
  fake-engine contract plan. Do not grow the fixture opportunistically.
- A passing service gate never closes a renderer-crash report. Keep the
  desktop-recovery lane and collect a fresh desktop trace for UI-only failures.
