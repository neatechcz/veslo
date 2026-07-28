---
title: Cold Runtime Readiness and Single-Engine Admission Plan
status: implemented
done: true
date: 2026-07-28
issue: unlinked
scope: local desktop cold first-message and missing-live-binding server-owned submit admission
related:
  - docs/plans/2026-07-28-production-runtime-remediation-implementation-plan.md
  - docs/plans/2026-07-28-server-owned-submit-missing-live-binding-recovery-kiss-plan.md
  - docs/plans/2026-07-27-kiss-optional-skills-nonblocking-runtime-remediation-plan.md
---

# Cold Runtime Readiness and Single-Engine Admission Plan

## Purpose

Remove a cold local server-owned submit race in which the app starts an engine
with a canonical empty Skill binding, then the server-owned first submit
resolves a different serving binding and replaces that engine immediately.

This is a readiness-boundary problem, not a reason to make fresh Skills a
foreground send dependency. The desired result is one engine generation for
one server-owned cold admission, using the binding that owns that admission.

## Implementation disposition

Implemented on 2026-07-28. The app now establishes only a daemon-backed
workspace proxy descriptor before a server-owned write; the server then owns
the single binding-aware engine admission. The pre-HTTP missing-binding path
uses the same port, while post-HTTP transport replay remains independent.

Focused app, server, orchestrator, and desktop-native checks cover this
contract. Desktop E2E and installed-app evidence remain intentionally deferred
to the requester-owned live-installation check; they are not missing
repository implementation work.

## Confirmed causal chain

The 2026-07-28 development capture established this sequence for a first
message in a workspace with three local Skills:

```text
app missing routed client
  -> engine-only preflight selects canonical empty binding
  -> desktop workspace prepare activates engine A
  -> engine A passes /global/health and app marks runtime ready
  -> app starts detached GET /session readiness probe against A
  -> server-owned first submit selects the serving three-Skill binding
  -> orchestrator retires/replaces A and starts engine B
  -> detached probe to A ends ECONNREFUSED
  -> server waits for B before it can create the session and submit the prompt
```

The capture identifies two different engine PIDs and two different Skill-view
revisions. It therefore does not support the weaker hypothesis that the first
engine was merely slow to expose `/session`. A global health success and a
later session failure can both be true because the engine was superseded.

The second submit used B without replacement and was fast. This identifies
duplicate cold admission, rather than ordinary warm prompt latency, as the
direct optimization target.

### Registration constraint to preserve

The present write preflight calls workspace registration with
`requireLiveOpencodeBaseUrl: true`, and its registration cache is keyed by that
base URL. This is a real contract: silently dropping the URL requirement would
weaken stale-binding protection.

For an orchestrated workspace, however, this is not necessarily a requirement
for a ready OpenCode process. Desktop `engine_info` exposes the workspace
orchestrator proxy URL as soon as the daemon is available; the proxy lazily
admits the engine on its first request. Therefore CRR must distinguish a
daemon-provided proxy transport descriptor from an app-routed, ready OpenCode
client. The implementation must prove which is available on the cold path
before changing the registration contract or introducing a server-owned
replacement registration API.

## Terminology and ownership

```text
service-ready
  Local Veslo server is reachable with valid local credentials. It is not
  evidence that any workspace engine exists.

admission-transport-ready
  The server can reach the local control-plane needed to perform a
  server-owned workspace admission. It does not itself activate a workspace
  engine or choose a Skill binding. Existing server-only readiness may provide
  this state, but only focused evidence can establish that it does.

process-ready
  A specific OpenCode process answered its process health endpoint. It is not
  evidence that it is the engine that will serve a server-owned write.

execution-ready
  The server selected a serving binding and the orchestrator accepted the
  server-owned session/write on the matching engine generation.
```

| Boundary     | Owner                         | Responsibility                                                                                                                                               |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop      | local process bootstrap       | Establish admission-transport readiness without activating a workspace engine for a server-owned write.                                                      |
| App          | user intent and presentation  | Request admission-transport readiness, submit once, and only present state; it does not choose a Skill view or declare execution ready from a routed client. |
| Server       | admission and serving binding | Read the durable serving binding or canonical empty fallback and perform the server-owned session/write.                                                     |
| Orchestrator | engine generation             | Start or reuse exactly the engine admitted for that binding, fence incompatible active runs, and expose the accepted generation.                             |

## Non-negotiable invariants

1. Fresh Skill discovery, registry materialization, and watcher reconciliation
   never block ordinary runtime start or send.
2. A server-owned cold first message never first activates a workspace engine
   solely to manufacture an app-routed OpenCode client.
3. A canonical empty binding remains a valid fail-open fallback, but it must
   not cause a disposable preliminary engine when the same server-owned write
   will immediately admit a different already-serving binding.
4. Every newly admitted write runs only on an engine whose Skill-view and
   authorization revisions equal the server-admitted binding. A stale engine
   may serve only the run already bound to it; it must never be silently reused
   for a newer write merely to reduce engine generations.
5. Engine owner, directory-instance epoch, and OpenCode config digest are
   binding evidence in traces and response handling. They do not substitute
   for the server's revision and authorization admission handshake.
6. A successful process `/global/health` response is `process-ready`, not
   `execution-ready`.
7. The first server-owned `POST /session` is the admission/readiness proof for
   the first message; do not add a competing app-side `GET /session` gate.
8. Reads, workspace browsing, passive event attachment, and abort remain
   non-starting. They must not acquire an engine just to prove readiness.
9. Existing pre-HTTP missing-live-binding recovery and post-HTTP transport
   replay remain separate bounded paths with the original `clientMessageId`.
10. A server-owned write registration may use the daemon-provided workspace
    proxy descriptor required by the existing safe registration contract, but
    must not require a ready engine, create an app-routed client, or select a
    binding. The descriptor must remain bound to the correct workspace and may
    not be reused as an arbitrary or stale engine URL.
11. No trace persists raw workspace paths, engine URLs, prompts, credentials,
    or upstream response bodies.

## Target flow

```text
server-owned first message
  -> ensure admission transport only
  -> obtain only the daemon proxy descriptor if current safe registration needs it
  -> register/resolve workspace without a ready app-routed engine
  -> submit one server-owned request with same clientMessageId
  -> server reads serving binding (or canonical empty fallback)
  -> orchestrator admits one matching engine generation
  -> server POST /session succeeds
  -> server prompt submit succeeds
  -> app attaches presentation/client state after acceptance
```

The app must not require a ready routed OpenCode client or a workspace engine
before this first submit. It may obtain the daemon proxy descriptor strictly
to satisfy the existing workspace-registration contract. The server already
owns first-message conversation materialization and is the only boundary that
can consistently choose the effective binding.

## CRR00 — Deterministic causal characterization

state: implemented
done: true

Owner: app/server/orchestrator test boundary

### Confirmed evidence

The development capture has already established the production-shaped causal
chain: one workspace, two engine owners, canonical empty then serving Skill
revisions, and a detached probe against the displaced generation. CRR00 is
not a second request to rediscover that cause.

Its remaining purpose is a deterministic regression test and a narrow answer
to whether current server-only bootstrap is admission-transport-ready. CRR00
does not block CRR01a implementation, but it blocks both CRR01b creation and
the `implemented` disposition of CRR01a.

### Required work

1. Add a focused deterministic scenario that models a local first message
   with no routed client, canonical empty fallback at app preflight, and a
   later serving binding at server admission.
2. Prove the current behavior creates two engine generations and that the
   displaced generation can produce the detached probe failure.
3. Capture only safe identity fields: trace ID, workspace ID, binding digest,
   engine owner/generation, operation phase, status class, and elapsed time.
4. Record whether current server-only bootstrap can guarantee
   admission-transport readiness without activating a workspace engine. If it
   cannot, specify the smallest desktop-owned daemon-only port required by
   CRR01b.
5. Independently prove the registration boundary: with the daemon available
   and no ready workspace engine, determine whether `engine_info` yields the
   workspace proxy descriptor and whether the current write registration plus
   server-owned submit accepts it. Preserve the base-URL-keyed stale-binding
   protection when it does. Only if this proof fails may CRR01a introduce a
   distinct server-owned registration contract; document its owner and
   migration rather than silently making writes URL-agnostic.

### Acceptance evidence

- The test distinguishes a generation replacement from a mere slow
  `/session` response.
- It proves that a global health success is insufficient for this flow.
- It identifies the exact owner that must establish service-ready state before
  server submission.

## CRR01a — App server-owned cold admission preflight

state: implemented
done: true

Owner: desktop app and server-owned submit composition boundary

### Required implementation

1. Introduce a narrow dependency for server-owned submit transport readiness.
   Its contract is service/daemon reachability only; it must not call workspace
   engine activation, select a Skill binding, create a routed OpenCode client,
   load sessions, or run Managed AI configuration.
2. Start by adapting the existing server-only local-server readiness capability
   behind that narrow dependency. It is not assumed to establish
   admission-transport readiness until CRR00 proves it; CRR01b owns the
   conditional native extension.
3. Preserve the current write-registration identity guarantee. If CRR00 proves
   the daemon exposes the workspace proxy descriptor before engine admission,
   use that descriptor for registration while keeping the base-URL-keyed cache;
   it is not a routed-client or process-ready requirement. If it does not,
   stop CRR01a at this boundary and implement the explicit owner-approved
   server-owned registration contract identified by CRR00. Do not make the
   existing registration URL-agnostic or reuse a prior engine URL.
4. In the server-owned first-message path, call this narrow dependency in
   place of full local runtime reachability when no live routed client exists.
5. Apply the same rule to the pre-HTTP retry of that same first-message
   creation. It must not reintroduce a canonical-empty workspace activation
   after a stale-token or missing-binding failure.
6. Keep `runtimeHealthOk` false for this route until server-owned admission
   succeeds. Consequently, do not require an app-routed client before the
   server-owned first submit.
7. After a successful submit, allow normal routed-client attachment and event
   presentation to converge against the accepted engine generation.
8. Keep legacy/non-server-owned conversation creation behavior unchanged.

### Call-site matrix

| Call site                                                             | CRR handling                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| First server-owned conversation submit with no routed client          | CRR01a: admission-transport only, then server-owned session admission.     |
| Pre-HTTP retry of that first creation                                 | CRR01a: same admission-transport rule and original `clientMessageId`.      |
| Existing server-owned session with exact missing-live-binding failure | CRR02: reevaluate engine-only recovery against the server-admission owner. |
| Existing healthy session and its post-HTTP transport replay           | Unchanged by CRR01a.                                                       |
| Legacy/non-server-owned conversation creation                         | Unchanged by CRR01a.                                                       |
| Browsing, reads, event attachment, and abort                          | Unchanged and non-starting.                                                |

### Non-goals

- no fresh Skill refresh before first send;
- no app-selected replacement binding;
- no new generic retry loop;
- no direct OpenCode session creation from the app;
- no behavioral change for browsing or abort.

### Acceptance evidence

1. For one fixed admitted binding, a cold server-owned first message creates
   at most one engine generation.
2. No app-side workspace activation or routed-client requirement precedes its
   server-owned session materialization.
3. The accepted `/session` and prompt use one matching binding and engine
   owner.
4. If no serving binding exists, canonical empty starts one engine and still
   permits the server-owned send.
5. Managed AI bootstrap/configuration remains absent from this narrow path.
6. Registration either succeeds from a daemon proxy descriptor with no ready
   engine, or uses the separately specified server-owned registration contract;
   no stale prior URL is accepted as a substitute.

## CRR01b — Conditional daemon-only admission transport

state: implemented
done: true

Owner: desktop native/runtime boundary

### Entry condition

Implement this step only if CRR00 proves that the current server-only
bootstrap can reach the Veslo server but cannot perform a server-owned
admission without first activating a workspace engine.

### Required implementation

1. Expose one desktop-owned operation that starts or validates only the local
   daemon/control-plane needed for server-owned submit transport.
2. It must not register or activate a workspace, select a Skill binding,
   create an OpenCode client, or report a workspace as execution-ready.
3. Wire it behind CRR01a's narrow dependency; do not reuse full workspace
   preparation or make the app select an engine mode.
4. Provide a bounded timeout, explicit failure classification, and safe trace
   fields that distinguish server reachability from admission transport.

### Acceptance evidence

- Cold server-owned first submit reaches server admission without a preliminary
  workspace engine generation.
- A failed daemon-only operation leaves no workspace engine, routed client, or
  false `runtimeHealthOk` state behind.
- Legacy workspace preparation and read-only paths retain their current owner
  and behavior.

## CRR02 — Existing-session missing-binding alignment

state: implemented
done: true

Owner: desktop app/server-owned submit boundary

### Required implementation

1. Re-evaluate the PRR01 missing-live-binding recovery against the CRR01a
   transport port. When the server-owned submit is capable of admitting the
   correct binding itself, recovery must not proactively create a canonical
   empty workspace engine.
2. Preserve the exact pre-HTTP typed failure filter, a single recovery, the
   snapshotted workspace target, and the original `clientMessageId`.
3. Keep the independent one-time transport replay after an actual transport
   attempt. Do not combine it with admission recovery.
4. Retain unconditional backend provisional-run and busy-lock cleanup even if
   the user changed conversations while recovery was pending.

### Acceptance evidence

- Missing live binding -> service/daemon recovery -> server submit creates or
  reuses only the server-admitted generation.
- Missing live binding -> recovery -> transport exception still performs one
  independent transport replay with the same message ID.
- Generic server, remote, Managed AI, missing-target, and post-HTTP failures
  do not invoke this recovery.

## CRR03 — Readiness state and causal diagnostics

state: implemented
done: true

Owner: desktop diagnostics and orchestrator tracing

### Required implementation

1. Make readiness traces distinguish `service-ready`,
   `admission-transport-ready`, `process-ready`, and `execution-ready`; do
   not use one ambiguous `ready` result for all four.
2. Emit one engine-generation transition record for replacement, with safe
   previous/new owner identity, previous/new Skill-view and authorization
   revision digests, replacement reason, triggering operation ID, and elapsed
   duration. A legitimate changed/revoked binding must remain distinguishable
   from an avoidable duplicate start for one unchanged binding.
3. Record detached app probes as diagnostic only, including the generation
   they targeted when known. A rejected detached probe must never overwrite a
   later accepted server-owned readiness state.
4. Redact loopback engine URL/port, raw workspace path, workdir, config
   directory, query directory, and response body excerpts in all new and
   adjacent traces.
5. Coalesce repeated identical transient readiness events so a cold start
   remains inspectable rather than noisy.

### Acceptance evidence

- One trace can explain: app intent -> service readiness -> binding decision
  -> engine owner -> session acceptance -> prompt acceptance/failure.
- A binding-driven replacement is explicit rather than inferred from two PIDs.
- Trace fixtures prove no prohibited raw fields are persisted.

## CRR04 — Focused verification and rollout boundary

state: implemented
done: true

Owner: affected package maintainers

### Required verification

1. Focused app tests for server-owned first-message preflight and retry,
   missing-binding recovery, UI switch cleanup, and one transport replay.
2. Focused orchestrator tests for one binding-admitted engine generation and
   safe replacement diagnostics.
3. Focused server tests for serving-binding/canonical-empty admission and
   stable `clientMessageId` behavior.
4. Affected app, server, orchestrator, and desktop typechecks; formatting and
   diff checks.
5. Rebuild the server binary if server source changes.

Desktop E2E and installed-app validation are intentionally deferred at the
requester's direction. They remain requester-owned follow-up evidence, not a
gate for marking a scoped repository step `implemented`.

## Rollback trigger

Stop and revert the scoped CRR implementation if focused or requester-supplied
runtime evidence shows any of the following:

1. more than one accepted prompt for a single `clientMessageId`;
2. more than one cold engine generation for an unchanged admitted binding, or
   a newer write silently executes on the old binding instead of being fenced
   or safely re-admitted;
3. a server-owned first message cannot submit when the app has no routed
   client but the local service transport is reachable;
4. browsing, reads, or abort begin starting engines;
5. fresh Skill work becomes a hard foreground send gate; or
6. diagnostics expose a raw path, URL/port, credential, prompt, or upstream
   body.

The rollback must preserve PRR01's stale-binding protections and never restore
stale URL reuse.

## Completion criteria

Each CRR step may change to `done: true` only with its acceptance evidence and
an explicit disposition of `implemented`, `production-verified`, `disproved`,
`externally-blocked`, `superseded`, or `tracked-separately`.

All CRR00--CRR04 steps are implemented. CRR01b was required: existing
server-only bootstrap did not establish a daemon-backed workspace proxy
descriptor on a cold workspace. A later installed-app capture may promote the
applicable steps to `production-verified` without broadening the repository
implementation scope.
