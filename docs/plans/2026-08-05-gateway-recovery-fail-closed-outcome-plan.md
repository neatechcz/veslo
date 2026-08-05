---
title: Gateway Recovery Fail-Closed Outcome Plan
date: 2026-08-05
status: proposed
done: false
scope: give a managed-AI gateway request whose run correlation could not be restored a dedicated fail-closed outcome, instead of letting it fall through to a generic authorization rejection
related:
  - docs/plans/2026-08-04-long-submit-run-failure-and-restart-investigation-plan.md
  - docs/dev/opencode-workspace-runtime-architecture.md
---

# Gateway Recovery Fail-Closed Outcome Plan

## Executive verdict

The worker-replacement recovery work closes the common path: a new worker
hydrates active run descriptors before the gateway processes a request that
requires a session, and a failed hydration is now retried for the request's
workspace and recorded as `server:ai-gateway-recovery:bootstrap-unrecovered`.

One half of invariant 4 remains open. When correlation still cannot be restored,
the request continues and can surface as an ordinary
`gateway_runtime_authorization_required` rejection. That is indistinguishable
from "this run is unknown", which is exactly the confusion the recovery path
exists to remove: the original incident was diagnosed only because someone
correlated PIDs by hand.

This plan is deliberately small and is written because the correct repair needs
the gateway response contract read properly. Guessing a response shape on an
authorization path is worse than leaving the gap documented.

## Established

- Recovery bootstrap is awaited before a session-scoped gateway request is
  processed; the ordering is correct.
- A bootstrap failure no longer proceeds silently: the workspace hydration is
  re-attempted, and an unrecovered outcome is traced with its workspace scope.
- Server suite passes with that change (1276 passing, 0 failing).

## Not established

- What the gateway proxy currently returns, and with which status and body
  shape, when no active run context matches a session-scoped request.
- Whether OpenCode distinguishes a retryable rejection from a terminal one, and
  which shape makes it stop rather than retry into the same wall.
- Whether a dedicated outcome should terminalize the run immediately or let the
  existing owner-fenced handoff decide.

Read these before implementing. The failure being repaired is a late,
misattributed rejection; a second misattributed shape would repeat it.

## Required invariants

1. A request that could not restore its run correlation must never be answered
   as though the run does not exist.
2. The distinct outcome names the cause — recovery unavailable — and is
   attributable to a workspace and, where known, a run.
3. Fail closed: an unrestored correlation never authorizes, never retries the
   model request, and never asserts the engine died.
4. Terminal state is still recorded only through the existing owner-fenced
   handoff, which proves the engine exited. This plan adds a response outcome,
   not a new authority over run death.
5. The outcome carries no bearer, actor token, or organization identifier.

## Implementation plan

### Slice 1 — read the contract (blocking)

1. Determine the current response for a session-scoped gateway request with no
   matching active run context.
2. Determine how OpenCode treats that response: retry, fail the run, or stall.
3. Decide the distinct outcome's status and body from those two answers, not
   from preference.

**Exit criterion:** the chosen shape is justified by observed client behavior.

### Slice 2 — return the dedicated outcome (P1)

1. Return the distinct recovery-unavailable outcome when hydration could not
   restore correlation for a session-scoped request.
2. Keep the existing generic rejection for genuinely unknown sessions, so the
   two remain distinguishable in traces and in support captures.
3. Record the outcome content-free with its workspace, run when known, and the
   reason correlation was unavailable.
4. Add tests: unrestored correlation yields the dedicated outcome; an unknown
   session still yields the generic one; neither authorizes; neither marks the
   run terminal on its own.

**Exit criterion:** a support capture can tell "recovery failed" apart from
"unknown run" without correlating process identifiers by hand.

## Explicit non-goals

- retrying the model request, raising timeouts, or auto-restarting the engine;
- terminalizing a run from the gateway path instead of through the owner-fenced
  handoff;
- persisting any credential to make recovery easier;
- changing the already-correct bootstrap ordering.

## Why this is the boundary

```text
an unrestored correlation
  --must not be answered as--> an unknown run

a distinct failure
  --must have--> a distinct, attributable outcome

a response shape on an authorization path
  --must come from--> the observed contract, never from a guess
```
