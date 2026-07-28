# Fix 64: Long-Run Transcript Completion Recovery

Date: 2026-07-29

## Scope

Repairs the long-run case in which OpenCode has persisted a visible assistant
answer, but the lifecycle remains `running` because the response omitted a
terminal finish marker. It also preserves a final transcript-recovery attempt
when bounded reconciliation exhausts its poll budget.

This is a lifecycle and transcript-recovery repair. It does not change engine
topology, skill staging, queue policy, or the desktop runtime launch path.

## Root cause

The activity probe treated an assistant message without an explicit terminal
field as open work, even when the exact admitted turn had visible output and
OpenCode explicitly reported the session as `idle`. The registry therefore kept
the run active until its long reconciliation budget expired.

At budget exhaustion, the server marked the run failed but did not request the
same terminal transcript ingest used by normal completed and failed lifecycle
transitions. A response that had already reached OpenCode could therefore stay
hidden from the durable transcript and the UI continued to present the run as
unresolved.

## Fix

- Exact admitted assistant output plus an explicit OpenCode `idle` status is a
  non-authoritative completion candidate, even if no provider finish marker is
  present.
- The candidate must be observed twice with the same stable evidence before the
  durable run becomes `completed`.
- A missing session-status entry remains a non-completion signal. `busy` state,
  active tool work, and newer user activity continue to keep the run active.
- When bounded reconciliation still exhausts against an unresolved active run,
  the server requests terminal transcript ingestion before recording the
  durable failed state.

## KISS Boundary

The repair does not use a wall-clock timeout to decide that a response is done,
does not infer completion from arbitrary assistant text, and does not relax the
exact admission-message correlation. It only handles the known provider shape:
the answer is present, it belongs to the admitted turn, and OpenCode explicitly
reports that session idle.

## Verification

- Orchestrator activity-probe and run-registry tests: 54 passed.
- Server lifecycle-controller tests: 47 passed.
- App lifecycle-recovery tests: 36 passed.
- Orchestrator and server typechecks passed.
- Server binary build passed.
- `git diff --check` passed.

The broad `pnpm check` completed lint and typecheck stages but stopped at
pre-existing, unrelated dirty-worktree UI unit-test assertions. Manual
installed-runtime and Tauri Pilot verification were intentionally not run in
this slice.

## Status

Code and focused regression coverage are complete. The next release/manual
runtime should validate the original long-run reproduction: a persisted exact
assistant response with explicit idle must settle the visible run, and a forced
reconcile exhaustion must ingest the response before surfacing failure.
