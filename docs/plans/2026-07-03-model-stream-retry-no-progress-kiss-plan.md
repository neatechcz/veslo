---
title: Model Stream Retry No-Progress KISS Plan
date: 2026-07-03
status: planned-kiss-refined
done: false
msr00_repro_fixture_done: false
msr01_orchestrator_diagnostics_done: false
msr02_run_registry_threshold_done: false
msr03_app_visible_status_done: false
msr04_installed_runtime_regression_done: false
source_issue: Installed app agent silently stalls in model-stream retry loop during Unity task
---

# Model Stream Retry No-Progress KISS Plan

## Goal

Make an installed Veslo desktop run visibly distinguish real work from a model
or provider retry loop that produces no user-visible progress.

The incident to cover is the 2026-07-03 installed app Unity task where:

- Veslo run `f164e323-2196-4c37-98f8-bef1056c451b` stayed `running`.
- OpenCode session `ses_0d8eca46fffexqldAJbOl6gTLf` repeatedly restarted
  model streams for the same assistant message.
- There was no active local tool subprocess during the silent retry window.
- The run eventually completed, so this is not the stale terminalization class
  by itself.
- The user saw a generic running/responding state for about 26 minutes without
  a useful explanation.

## Implementation Status Contract

This document starts with every implementation status set to `done: false`.

Agents implementing the plan must change a task's `done: false` to `done: true`
only after that task's code, focused tests, and listed verification are complete.
Do not flip the top-level `done` value until every non-deferred task in this
plan is implemented and verified in the original worktree.

If an agent completes only part of a task, append a dated note under that task
and leave its `done: false` line unchanged.

## Non-Goals

- Do not rewrite OpenCode stream handling.
- Do not parse production log files in the app UI.
- Do not treat long local filesystem tools as stuck just because they are slow.
- Do not change the normal provider-start watchdog behavior unless needed for
  the new no-progress signal.
- Do not solve VSLO-261 stale lifecycle recovery again.
- Do not bundle unrelated session UI refactors into this fix.

## Current Gap

The current runtime has three useful signals, but no joined no-progress state:

- OpenCode can report `retry`.
- Veslo lifecycle can report a run as active or terminal.
- The app can show a run indicator and has developer-only stall logging.

The missing product behavior is a bounded, user-visible state such as:

`Retrying model/API, no output for 4m. Last useful progress: apply_patch completed at 10:48.`

## KISS Shape

Use the smallest cross-layer contract that can be tested and owned by the
runtime layer that already owns run truth:

1. Orchestrator classifies active work with a reason, not only a boolean.
2. Orchestrator run-registry persists progress state across reconciliations and
   applies the bounded threshold.
3. Server lifecycle propagates the orchestrator diagnostic fields unchanged.
4. App displays the reason in the existing run indicator/status surface.
5. Desktop regression proves the installed runtime does not collapse the state
   into generic `running/responding`.

## Public Diagnostic Contract

Keep the public contract intentionally small:

- `activityKind`: `local_tool`, `assistant_output`, `model_retry`, `idle`,
  `unknown`
- `waitReason`: `running_tool`, `model_retry_no_output`,
  `assistant_message_open`, `session_idle`, `engine_unreachable`, `none`
- `lastUsefulProgressAt`
- `retrySince`
- `noProgressSeconds`

Keep implementation-only state out of the app contract:

- `lastProgressSignature` or equivalent may be stored in the orchestrator run
  record to compare probes across time.
- `lastToolCompletedAt` is optional and should only be exposed if it is cheap
  and reliable from the same progress signature.
- `retryAttemptCount` is out of scope unless OpenCode exposes it as a stable
  structured field.

## Hard Threshold Decision

Use `blocked` for the hard threshold in this KISS slice.

Rationale:

- `blocked` is already an active run status, so it keeps the conversation queue
  blocked and avoids starting a second run while the old OpenCode stream might
  still resume.
- The user-visible state becomes actionable instead of silently running.
- Switching the hard threshold to `failed` is allowed only in a future slice
  that also proves the OpenCode stream/session was safely aborted or stopped.

The hard-threshold reason should be explicit, for example
`model_retry_no_output_timeout`.

## MSR00: Repro Fixture And Baseline Tests

done: false

Create a deterministic fixture for an OpenCode session that is active but makes
no useful progress.

Implementation scope:

- Add an orchestrator-level test fixture where `/session/status` returns
  `retry` for the same session/message while `/session/:id/message` shows no
  new text, tool call, tool output, terminal `finish`, or `time.completed`.
- Include a contrasting fixture where a long-running local tool remains active
  and must not be classified as model retry no-progress.
- Preserve the incident handles in test names or comments where useful:
  `ws-d8520858f77f`, `conv-a193a04c3c367d41c275`,
  `f164e323-2196-4c37-98f8-bef1056c451b`,
  `ses_0d8eca46fffexqldAJbOl6gTLf`.

Acceptance:

- A focused test fails before the implementation because retry is only
  considered active.
- The fixture does not need the real OpenCode binary or a real provider.
- The test clearly separates "tool is still running" from "model retry with no
  useful output".

Verification:

- `pnpm --filter veslo-orchestrator exec bun test src/tests/run-activity-probe.test.ts src/tests/run-registry.test.ts`
- `pnpm --filter veslo-orchestrator typecheck`

## MSR01: Orchestrator Activity Diagnostics

done: false

Extend the run activity probe with additive diagnostics while keeping existing
active/inactive behavior compatible.

Implementation scope:

- Keep returning the existing `active` and `unreachable` fields for current
  callers.
- Add the public diagnostic fields from "Public Diagnostic Contract".
- When `/session/status` reports `retry`, do not return immediately from the
  probe. Fetch `/session/:id/message` and derive whether the retry has useful
  message/tool progress.
- Treat OpenCode `retry` as active but diagnostic, not as generic useful work.
- Derive useful progress from completed tools, text growth, tool output growth,
  terminal assistant fields, or other durable transcript/message changes.
- Avoid a broad log parser. Prefer OpenCode status/message payloads and the
  existing probe paths.

Acceptance:

- Existing stale-run reconciliation tests still pass.
- A retrying session with static assistant content returns
  `activityKind: "model_retry"` and `waitReason: "model_retry_no_output"`.
- A long-running tool still returns an active local-tool reason.
- No persistence or threshold transition is owned by this task; it only
  produces a diagnostic probe result that MSR02 can persist.

Verification:

- `pnpm --filter veslo-orchestrator exec bun test src/tests/run-activity-probe.test.ts`
- `pnpm --filter veslo-orchestrator typecheck`

## MSR02: Run Registry Persistence And Threshold

done: false

Persist no-progress model retry diagnostics in the orchestrator run registry
and make the retry loop bounded.

Implementation scope:

- Extend `RunRecord` and `conversation_run` with additive nullable fields:
  - `activityKind`
  - `waitReason`
  - `lastUsefulProgressAt`
  - `retrySince`
  - `lastProgressSignature`
- Use the existing `ensureColumn()` pattern in `run-store.ts`; this is an
  additive SQLite migration.
- Keep `lastProgressSignature` internal to orchestrator/store. Do not pass it
  through to the app.
- Compute `noProgressSeconds` when serving lifecycle status instead of storing
  it.
- Update `run-registry` reconcile so:
  - useful progress updates `lastUsefulProgressAt` and
    `lastProgressSignature`,
  - entering `model_retry_no_output` sets `retrySince` only once,
  - leaving `model_retry_no_output` clears `retrySince`,
  - active local tools do not count as model retry no-progress.
- Add a conservative threshold policy:
  - soft threshold: show diagnostic while run remains active,
  - hard threshold: mark the run `blocked` with
    `model_retry_no_output_timeout`.
- Add a registry-owned `markBlocked` transition contract or internal helper:
  - status becomes `blocked`,
  - `completedAt` stays `null`,
  - `error` or a dedicated reason field records
    `model_retry_no_output_timeout`,
  - the run remains active for admission-control and queue-drain purposes.
- Keep the threshold constants near `run-registry`; server code should not own
  the threshold decision.
- Extend the orchestrator lifecycle status endpoint and
  `orchestrator-lifecycle-client.ts` with the public diagnostic fields.
- Do not fail a run just because a real local tool has been running for a long
  time.

Suggested initial thresholds:

- soft diagnostic after 120 seconds of `model_retry_no_output`,
- hard `blocked` state after 10 minutes of `model_retry_no_output`.

These values are intentionally conservative and can be tuned after product
review.

Acceptance:

- Orchestrator lifecycle status can represent "active but waiting on
  model/provider" separately from "active local tool".
- Queue draining does not start another run while the current run is still
  active, but the current run no longer looks indistinguishable from useful
  work.
- After the hard threshold, the run becomes `blocked` and user-actionable with
  a clear error/reason.
- Provider-start timeout behavior remains covered and unchanged.

Verification:

- `pnpm --filter veslo-orchestrator exec bun test src/tests/run-activity-probe.test.ts src/tests/run-registry.test.ts`
- `pnpm --filter veslo-orchestrator typecheck`
- Focused server lifecycle/client tests proving diagnostic fields pass through.
- Existing provider-start watchdog tests still pass.
- `pnpm --filter veslo-server build:bin` after changing `packages/server/src`.

## MSR03: App Visible Status

done: false

Show the retry/no-progress state in the installed app without a broad session UI
rewrite.

Implementation scope:

- Read the new lifecycle diagnostic fields from the existing server client path.
- Thread the fields into the active run/session status model as active
  diagnostics, not only as terminal lifecycle recovery.
- Reuse the existing run indicator/status area instead of creating a new panel.
- Display a concise status when `waitReason` is `model_retry_no_output`, such as:
  `Retrying model/API, no output for 4m`.
- Include last useful progress time when available.
- Keep developer-only perf logging as support data, not as the only signal.
- Preserve normal `thinking`, `responding`, and local tool labels.

Acceptance:

- A retrying model stream after response start does not collapse to generic
  `responding`.
- The user can distinguish model/API wait from local filesystem/tool work.
- `session-lifecycle-recovery` or its replacement polls active diagnostics and
  can update the visible label while the run is still active.
- Existing send/composer busy behavior remains compatible.
- Czech and English locale strings exist for the new visible status.

Verification:

- Focused app model/unit tests for status normalization and visible run label.
- Existing session-send/session-status tests still pass.
- `pnpm --filter @neatech/veslo-ui typecheck`.

## MSR04: Installed Runtime Regression

done: false

Prove the fix in a desktop/Tauri runtime path, not only in isolated unit tests.

Implementation scope:

- Add or extend a Tauri-pilot scenario with a fake OpenCode/provider surface
  that repeatedly reports retry/no-output for a bounded interval.
- Assert the visible UI status includes the model/API retry reason.
- Assert no active local tool text is shown for the retry-only period.
- Assert the run becomes `blocked` and user-actionable after the hard
  threshold.
- Keep the scenario deterministic and avoid a real provider dependency.

Acceptance:

- The scenario fails against the old behavior because the UI only shows generic
  running/responding.
- The scenario passes after MSR01-MSR03.
- The test uses the desktop preflight and cleanup rules from
  `docs/dev/testing-playbook.md`.

Verification:

- Targeted Tauri-pilot scenario under `packages/e2e`.
- If the scenario needs new server source, rebuild with
  `pnpm --filter veslo-server build:bin` before running desktop validation.
- `git diff --check`.

## Completion Criteria

Top-level `done: true` is allowed only after:

- MSR00 through MSR04 are all `done: true`.
- The installed app can show a model/API retry no-progress reason.
- The retry loop is bounded by a soft diagnostic threshold and a hard
  `blocked` user-actionable threshold.
- Long-running local tools remain distinguishable from provider/model retry.
- Regression coverage includes a desktop/Tauri runtime path.
- Relevant durable behavior docs under `docs/dev/` or `docs/features/` are
  updated if the user-visible status semantics become part of the public
  behavior contract.

## Progress Log

Use this format when implementing:

`2026-07-03 - MSRxx - changed: <paths> - verification: <commands/results> - done: false`
