---
title: Cold Send Admission Transport Warm-Up Plan
date: 2026-08-05
status: proposed
done: false
scope: remove daemon and control-plane initialization from the first server-owned send critical path without pre-activating a workspace engine
related:
  - docs/plans/2026-07-28-cold-runtime-readiness-single-engine-admission-plan.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/testing-playbook.md
---

# Cold Send Admission Transport Warm-Up Plan

## Outcome

Reduce the local, controllable portion of the first cold server-owned send.
The selected initial slice warms only the local admission daemon and its
control-plane binding before a user presses Send. It must not activate a
workspace engine, select a serving binding, create a routed OpenCode client,
or change server-owned admission.

Engine prewarming is deliberately excluded from this slice. It is a separate
product and resource decision, even though it can reduce a different portion
of the cold-send delay.

## Confirmed evidence

The 2026-08-05 first-cold-send capture correlates the renderer performance
recording with the UI, server, and orchestrator workflow traces. The measured
critical path was:

| Milestone | Elapsed from Send | Observed duration |
| --- | ---: | ---: |
| User invokes Send | 0 ms | -- |
| Admission daemon ready | 1.868 s | 1.868 s |
| Admission transport fully ready | 2.578 s | 0.669 s after daemon readiness |
| Server-owned submit begins | 2.638 s | -- |
| Live event-stream fence completes | 4.456 s | 1.818 s |
| Submit accepted in the UI | 4.931 s | -- |
| First generated model output visible | 12.189 s | -- |
| Terminal completion observed | 13.083 s | -- |

The transport binding was absent on the cold path. After the daemon became
available, the foreground request still had to rebind and verify the local
control plane. The code path confirms that the admission transport first
ensures the local server and daemon, then checks the binding and performs a
rebind when it is missing.

The later engine admission accounted for about 1.425 s of the accepted-submit
path. Provider and gateway work accounted for the majority of the remaining
time to first generated output. Those are not evidence that the local
admission transport is slow.

The renderer recording shows no sustained layout, paint, or garbage-collection
bottleneck on this path. It includes one over-budget input handler and some
outer transcript mutation churn, but neither explains the seconds spent before
server-owned submit. Profiling startup overhead is excluded from the timing
assessment.

An SSE socket closure occurred only after the run had already reached its
terminal state. It is not a cause of this cold-send latency and is not in scope
for this plan.

## Decision and boundaries

Keep the existing server-owned first-message contract:

```text
user intent
  -> admission transport is already warming or ready
  -> server-owned submit
  -> server resolves the serving binding
  -> orchestrator starts or reuses the matching engine
  -> server materializes the session and submits the prompt
```

The warm-up may establish only `admission-transport-ready`. It must not claim
`process-ready` or `execution-ready`, and it must not cause a workspace engine
generation to exist before the server admits a write.

### In scope

1. Start or join a background, idempotent admission-transport warm-up once a
   workspace becomes eligible for local server-owned submission.
2. Make a foreground send reuse the same single-flight operation and wait for
   it only when it is still incomplete.
3. Establish the initial local server/control-plane binding during that
   warm-up, so the normal fresh path does not report an unbound server after
   the user presses Send.
4. Add safe timing and outcome diagnostics sufficient to distinguish daemon
   start, binding verification, rebind, engine admission, and upstream model
   latency.

### Explicit non-goals

- Prewarm or retain an OpenCode workspace engine.
- Change binding selection, server-owned session materialization, retry rules,
  or event-stream ownership.
- Mask a failed warm-up as a successful runtime state.
- Treat provider/gateway latency, post-terminal SSE closures, or renderer
  mutation churn as part of this fix.

## Implementation slices

### CSW01 -- background admission warm-up

**Owner:** desktop runtime and server-owned submit composition.

1. Introduce one named readiness operation with the narrow contract
   `admission-transport-ready`.
2. Start it in the background after the local workspace target is known and
   eligible for server-owned submission. Do not wait for it in ordinary
   workspace browsing or rendering.
3. Make it idempotent and single-flight per local runtime/control-plane
   identity. A foreground send must join the in-flight work rather than start
   a second daemon or rebind operation.
4. Keep the operation non-starting for workspace engines: it may acquire a
   daemon descriptor and control-plane binding, but may not prepare a routed
   client or select a Skill view.
5. If warm-up fails or has not finished, preserve the current foreground
   readiness path and report its real safe failure. A background failure must
   never leave a misleading ready flag.

**Acceptance criteria:** when warm-up has completed, the first Send does not
perform daemon startup or an initial missing-binding rebind in its foreground
critical path. No workspace engine exists solely because warm-up ran.

### CSW02 -- eliminate the normal initial unbound binding

**Owner:** desktop native local-server/control-plane lifecycle.

1. Determine the smallest lifecycle point at which a fresh local server can
   receive the daemon-backed control-plane descriptor without an engine
   admission.
2. Bind it there, or make CSW01 perform the equivalent explicit binding once.
3. Retain the existing rebind as a recovery path for a stale, replaced, or
   genuinely unavailable control plane; do not remove that protection merely
   because the normal cold path is now warm.
4. Classify diagnostics as `already_bound`, `bound_by_warmup`,
   `recovered_rebind`, or a safe failure class. Do not log paths, URLs, ports,
   prompts, credentials, or upstream response bodies.

**Acceptance criteria:** a fresh standard local flow records a successful
binding before Send and does not use the recovery rebind. A simulated stale
descriptor still follows the bounded recovery path and does not attach the
server to the wrong workspace/control plane.

### CSW03 -- deferred engine-prewarm decision

**Status:** deferred pending product approval.

The capture shows that engine admission is a separate approximately 1.425 s
cost. Prewarming it would consume resources and changes lifecycle semantics;
it requires a separate proposal that defines eviction, binding revision
changes, shutdown behavior, and proof that it cannot create a disposable or
wrong-binding engine. It must not be bundled into CSW01 or CSW02.

## Verification

The primary proof is a real Tauri desktop WebDriverIO scenario, with the
normal local desktop runtime rather than a UI-only server.

1. From a fresh local runtime, make the workspace eligible and wait for the
   background admission warm-up. Assert that it reaches a valid bound transport
   and that no workspace engine was activated by the warm-up alone.
2. Send the first message. Assert one accepted server-owned submission and no
   daemon-start or missing-binding recovery event after the click.
3. Exercise two simultaneous readiness callers and assert one daemon/binding
   operation with both callers converging safely.
4. Simulate warm-up failure and stale control-plane state. Assert that Send
   keeps its existing bounded recovery/failure behavior and never reports
   execution readiness prematurely.
5. Keep focused lower-level tests for single-flight ownership, foreground
   joining, failure reset, and no-engine-start behavior where the desktop
   scenario cannot make those race conditions deterministic.
6. Repeat the first-cold-send trace capture. Compare equivalent milestones;
   the accepted-send timing must no longer include the measured daemon startup
   and normal initial rebind. Report external provider/gateway timing
   separately rather than treating it as a local regression.
7. Run the changed-surface quality gates and rebuild the server binary if the
   server source changes.

## Completion criteria

CSW01 and CSW02 are complete only when the real desktop scenario and the
repeat trace establish all of the following:

1. The background work is single-flight, safe on failure, and does not start a
   workspace engine.
2. A normal fresh first send reuses a valid pre-established binding rather than
   foreground daemon startup plus missing-binding rebind.
3. The server still owns binding choice, engine admission, session creation,
   and prompt submission.
4. Stale or replaced local control planes remain recoverable through an
   explicit bounded path.
5. Diagnostics distinguish local warm-up savings from engine and external
   model latency without exposing sensitive runtime data.

