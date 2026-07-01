---
title: Conversation Run Lifecycle Controller Implementation Plan
date: 2026-07-01
status: draft
done: false
core_done: false
deferred_followups_done: false
base_branch: local/sandbox-merge
base_commit: 6fb52b44
youtrack_issue: null
source_issue: none
target_area:
  - packages/server/src/server.ts
  - packages/server/src/routes/conversations.ts
  - packages/server/src/conversation-run-queue-store.ts
  - packages/server/src/orchestrator-lifecycle-client.ts
  - packages/orchestrator/src/run-registry.ts
  - packages/orchestrator/src/run-store.ts
  - packages/app/src/app/context/conversation-service.ts
---

# Conversation Run Lifecycle Controller Implementation Plan

## Goal

Make conversation run lifecycle easier to reason about and control by creating one narrow
server-side lifecycle owner.

The target is not a new lifecycle system. The target is a KISS owner around the logic that
already exists:

- server-authoritative run admission,
- durable server-side queued sends,
- OpenCode submit and abort coordination,
- AI gateway provider-start watch,
- lifecycle reconciliation polling,
- transcript-based wake-up,
- startup queue drain.

The orchestrator registry remains the durable source of truth for "is there an active run for this
conversation?" The app remains responsible for UI drafts and local editing flow only.

## Issue Scope

This plan is not tied to a YouTrack issue such as `VSLO-XXX`. It is an ownership refactor and
control-plane hardening plan.

Do not present this work as a new VSLO-261 product fix. VSLO-261 is useful historical context for
stale lifecycle risk, but this plan's success criteria are narrower:

- server lifecycle orchestration is owned by one controller,
- existing behavior is preserved unless a task explicitly says otherwise,
- current stale-run and queued-send regression tests keep passing,
- future lifecycle bugs become easier to inspect and test.

## Implementation Status Contract

This document starts with every implementation status set to `done: false`.

Agents implementing the plan must change a task's `done: false` to `done: true` only after that
task's code, tests, focused verification, and merge back into the original worktree are complete.

Do not flip `core_done` or the top-level `done` value until every required core task is merged and
the final core verification section passes in the original worktree.

Deferred follow-up tasks are useful future work, but they do not block `core_done` unless a
coordinator explicitly promotes them into the required slice before implementation starts.

## KISS Boundary

This plan is a mechanical ownership refactor with targeted hardening. It should not become a broad
runtime rewrite.

Do:

- create one server-side lifecycle controller module,
- move existing lifecycle orchestration into that controller,
- preserve current route response shapes,
- preserve current queue semantics,
- preserve current app abort API behavior in the core slice,
- preserve orchestrator registry semantics,
- keep behavior tests focused on lifecycle transitions and accepted-send contracts,
- add test/internal diagnostics only where they help verify controller state.

Do not:

- replace `run-registry.ts` or `run-store.ts`,
- merge the app draft queue with the server durable run queue,
- let transcript append directly mark lifecycle rows terminal,
- add a second lifecycle database,
- redesign the session UI,
- move desktop/Rust lifecycle behavior into this change,
- absorb AI gateway proxy/runtime internals into the lifecycle controller,
- add a public diagnostics endpoint in the core slice,
- change app/server abort API in the core slice,
- create many tiny helper files around one branch of logic.

## Core Slice And Deferred Follow-Up

The required KISS core is:

- LFC00 baseline/source map and behavior freeze,
- LFC01 controller shell and shutdown integration,
- LFC02 submit admission and queue acceptance owner,
- LFC03 OpenCode submit/provider-watch lifecycle orchestration through ports,
- LFC04 queue drain and lifecycle reconcile timers,
- LFC05 transcript/startup wake-up wiring,
- LFC06 abort side-effect consolidation with the current API,
- LFC08 final core verification, internal diagnostics, and docs.

LFC07 is intentionally deferred. It describes a likely useful product/API hardening path for
server-resolved active aborts, but it is not part of the core ownership refactor. Keeping it deferred
preserves the future direction without making the first implementation carry an app/server contract
change.

Core completion means the lifecycle owner boundary is fixed and current behavior is preserved. It
does not require changing how the app requests aborts.

## Current Audit Snapshot

The current architecture already has the right durable core:

- `packages/orchestrator/src/run-store.ts`
  - stores `conversation_run`,
  - enforces one active run per `(workspace_id, conversation_id)` with a SQLite partial unique
    index,
  - stores engine owner metadata for cleanup.
- `packages/orchestrator/src/run-registry.ts`
  - registers runs,
  - reconciles active rows through `probeRunActivity`,
  - rejects new runs while the reconciled active row is still active,
  - releases stale active rows when the probe proves the engine/session is inactive.
- `packages/orchestrator/src/run-activity-probe.ts`
  - treats OpenCode `busy` and `retry` as active,
  - treats `idle`, missing session transcript, or terminal assistant messages as inactive,
  - keeps non-404 engine failures as unreachable/stale instead of guessing.

The main control-plane risk is on the server side. Today the lifecycle flow is spread across:

- `packages/server/src/routes/conversations.ts`
  - route-level active peek,
  - route-level register/queue/submit decision,
  - transcript wake-up decision,
  - abort endpoint parsing.
- `packages/server/src/server.ts`
  - `submitConversationRunToOpenCode`,
  - `enqueueConversationRun`,
  - `drainConversationQueue`,
  - `scheduleConversationRunLifecycleReconcile`,
  - `reconcileConversationRunLifecycle`,
  - `reconcileConversationLifecycleAfterTranscriptAppend`,
  - startup pending queue drain wiring,
  - AI gateway provider-start watch cleanup.
- `packages/server/src/conversation-run-queue-store.ts`
  - durable queue item persistence,
  - idempotent enqueue by client message id,
  - pending/starting/submitted/failed transitions.
- `packages/app/src/app/context/conversation-service.ts`
  - remembers latest run ids in app runtime memory,
  - maps `submitted` and `queued` results into app-side state,
  - sends abort requests with the app's latest known run id.

The product contract already says this should be server-authoritative:

- `POST /workspace/:id/conversations/:conversationId/runs` accepts or queues sends.
- `status: "queued"` is an accepted send, not a failure.
- `run_already_active` is an internal lifecycle lock signal.
- active lifecycle reads are reconciled before they block new work.
- transcript append can wake lifecycle reconciliation, but it does not directly mark lifecycle rows
  terminal.

## Current Verification Baseline

The audit that produced this plan ran the following focused checks successfully:

```bash
pnpm --filter veslo-orchestrator exec bun test src/tests/run-registry.test.ts src/tests/run-store.test.ts src/tests/run-activity-probe.test.ts
```

Result:

```text
34 pass
0 fail
```

```bash
pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts
```

Result:

```text
27 pass
0 fail
```

Before reserving any task, re-run `git status --short --untracked-files=all`. The original audit
worktree already had unrelated dirty files in app dashboard and server owner work. Do not revert or
reuse unrelated changes for this plan.

## Pre-Implementation Hygiene Gate

LFC implementation must not start on top of unrelated dirty lifecycle-adjacent files.

Before LFC00 is reserved, the coordinator must make one of these true:

- the original worktree is clean except for this plan file and explicit reservation edits, or
- unrelated work is committed/merged first, or
- unrelated work is parked in a separate branch/worktree, or
- the Progress Log records exactly which dirty files are intentionally part of the base.

If `packages/server/src/server.ts`, `packages/server/src/routes/conversations.ts`, or lifecycle
owner files are dirty for unrelated work, LFC00 should be treated as blocked. This refactor is
mostly mechanical; starting from a drifting `server.ts` makes review and merge risk much higher
than the code change itself.

## Target Shape

Add one server module:

```text
packages/server/src/conversation-run-lifecycle-controller.ts
```

The controller should own the server lifecycle choreography:

```ts
export interface ConversationRunLifecycleController {
  submitRun(input: SubmitConversationRunInput): Promise<ConversationRunSubmitResult>;
  abortRun(input: AbortConversationRunInput): Promise<ConversationRunAbortResult>;
  onTranscriptSnapshot(input: TranscriptLifecycleSignal): Promise<void>;
  start(): void;
  stop(): void;
  snapshotForTests?(): ConversationRunLifecycleSnapshot;
}
```

The exact type names may change during implementation. The boundary should not change:

- route files parse HTTP and call the controller,
- `server.ts` constructs dependencies and wires the controller,
- queue drain and reconcile scheduling are controller-owned internals,
- queue store remains persistence only,
- lifecycle client remains HTTP adapter to orchestrator,
- orchestrator registry remains durable lifecycle truth,
- app code does not gain lifecycle authority.

## State Contracts

### Orchestrator Lifecycle Statuses

Active:

- `submitted`
- `running`
- `blocked`

Terminal:

- `completed`
- `failed`
- `aborted`

Only the orchestrator registry should decide whether a lifecycle row is still active after probing
OpenCode. Server transcript append may trigger a reconcile, but it must not mark the row terminal by
itself.

### Server Queue Statuses

Durable queue statuses remain:

- `pending`
- `starting`
- `submitted`
- `failed`
- `cancelled`

The queue item reaching `submitted` means the queued request has been handed to OpenCode. It does not
mean the conversation lifecycle is terminal.

### App Contract

The app can own:

- local draft queues,
- optimistic send state,
- visible session/run indicators,
- retry affordances,
- display of accepted queued sends.

The app must not own:

- active run admission,
- stale active terminalization,
- server queue drain,
- OpenCode engine activity probing.

### Remote Workspace Contract

Remote workspaces currently do not use the local orchestrator lifecycle owner. The current server
path sets the lifecycle owner to `null` for `workspaceType === "remote"`.

Unless a later product decision explicitly changes remote lifecycle ownership, this refactor must
preserve the remote invariant:

- remote submit does not call local lifecycle `active`,
- remote submit does not call local lifecycle `register`,
- remote submit does not enqueue through the local durable lifecycle queue merely because local
  lifecycle is unavailable,
- remote abort keeps the current compatibility behavior,
- remote route response shapes remain compatible.

Add or preserve tests for this before moving admission logic into the controller.

## Coordination Protocol For Multiple Agents

### Reservation Rule

Agents reserve work in the original worktree only. Code changes happen only in the agent's own
worktree.

From the original worktree:

```bash
git status --short --untracked-files=all
```

Reservation steps:

1. Open this plan in the original worktree.
2. Pick one task with `status: available`, `reserved_by: null`, and dependencies that are already
   `done: true` or merged.
3. Change only that task's reservation fields:
   - `status: reserved`
   - `reserved_by: <agent-name-or-session-id>`
   - `reserved_at: <ISO timestamp>`
   - keep or fill `branch`
   - keep or fill `worktree`
4. Save the plan in the original worktree.
5. Create the agent worktree from the original checkout:

```bash
git worktree add ../veslo-lifecycle-<task-id>-<slug> -b lifecycle/<task-id>-<slug> HEAD
```

Rules:

- Do not edit product code in the original worktree.
- Do not reserve a task that already has a non-null `reserved_by`.
- Do not change another agent's reservation.
- Do not mark `done: true` from an agent worktree.
- Mark `done: true` only in the original worktree after the branch has been merged and verification
  has passed there.
- If a task becomes blocked, set `status: blocked` and add one short blocker note.

### Branch Hygiene

Each branch should contain:

- the task's tests first,
- the smallest implementation needed for those tests,
- no unrelated formatting churn,
- no broad import sorting,
- no unrelated dashboard/Soul/skills/app-shell changes,
- no `docs/fixes` note unless the task explicitly asks for one.
- no changes on top of unrelated dirty `server.ts` lifecycle work unless the Progress Log says that
  work is intentionally part of the base.

### Merge Order

Merge in task order unless the dependencies below allow a clearly independent follow-up:

1. LFC00 baseline/source map,
2. LFC01 controller test harness and shell,
3. LFC02 submit/admission owner,
4. LFC03 OpenCode submit and AI gateway watch owner,
5. LFC04 queue drain and reconcile timers,
6. LFC05 transcript/startup wake-up wiring,
7. LFC06 abort flow consolidation,
8. LFC08 core diagnostics and final verification docs.

LFC07 is a deferred follow-up after the core is merged. Do not reserve it during the core refactor
unless a coordinator explicitly promotes it.

After each merge into the original worktree:

```bash
pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts
git diff --check
```

Run the task-specific verification too.

## Task Reservation Ledger

Use this ledger for quick discovery. The authoritative task details are below.

| id | module | status | reserved_by | done |
| --- | --- | --- | --- | --- |
| LFC00 | baseline lifecycle source map and contract freeze | done | codex-20260701-lfc00-baseline | true |
| LFC01 | controller shell and isolated test harness | blocked | codex-20260702-lfc01-shell | false |
| LFC02 | submit admission and queue acceptance owner | available | null | false |
| LFC03 | OpenCode submit and AI gateway provider watch owner | available | null | false |
| LFC04 | queue drain and lifecycle reconcile timers | available | null | false |
| LFC05 | transcript and startup wake-up wiring | available | null | false |
| LFC06 | abort flow consolidation | available | null | false |
| LFC08 | core diagnostics, docs, and final verification | available | null | false |
| LFC07 | deferred app latest-run and abort contract hardening | deferred | null | false |

## Task Details

### Task LFC00: Baseline Lifecycle Source Map And Contract Freeze

```yaml
id: LFC00
status: done
reserved_by: codex-20260701-lfc00-baseline
reserved_at: 2026-07-01T23:59:18.5632470+02:00
branch: lifecycle/lfc00-baseline-lifecycle-contract
worktree: ../veslo-lifecycle-lfc00-baseline-lifecycle-contract
done: true
depends_on: []
target_module: none
source_ranges:
  - packages/server/src/server.ts
  - packages/server/src/routes/conversations.ts
  - packages/server/src/conversation-run-queue-store.ts
  - packages/orchestrator/src/run-registry.ts
  - packages/orchestrator/src/run-store.ts
  - packages/app/src/app/context/conversation-service.ts
```

Purpose:

- Freeze the current lifecycle behavior before extraction.
- Record the source locations that later tasks will move.
- Confirm current tests are green before any ownership move.
- Avoid mixing this controller refactor with unrelated stale-run product behavior changes.
- Freeze the current remote-workspace lifecycle-disabled behavior.
- Freeze the current app queued-run abort baseline before app hardening happens later.

Target files:

- Modify:
  - this plan's Progress Log section,
  - optionally `docs/dev/veslo-server-app-contract.md` only if it contains stale lifecycle wording.
- Add or modify tests only if the existing focused tests miss a current contract that must not
  regress.

Test-first contract:

- If a new baseline test is added, it must assert existing behavior, not future controller placement.
- It should pass before any controller implementation.
- Baseline coverage should include remote workspaces:
  - no lifecycle `active` call,
  - no lifecycle `register` call,
  - no local lifecycle queueing caused only by remote workspace type.
- Baseline app coverage should include queued run id handling:
  - when a queued response contains both `activeRunId` and `reservedRunId`, the app must keep the
    active run as the stop/abort target for the current answer,
  - current abort behavior that requires an available run id should be documented before LFC07
    changes it.

Focused verification:

```bash
pnpm --filter veslo-orchestrator exec bun test src/tests/run-registry.test.ts src/tests/run-store.test.ts src/tests/run-activity-probe.test.ts
pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/pages/session-send-workflow.test.ts
git diff --check
```

Acceptance:

- Current lifecycle behavior is documented in the Progress Log.
- Worktree hygiene gate is resolved or explicitly recorded.
- Focused tests pass.
- No product behavior changes.

### Task LFC01: Controller Shell And Isolated Test Harness

```yaml
id: LFC01
status: blocked
reserved_by: codex-20260702-lfc01-shell
reserved_at: 2026-07-02T00:10:58.9291786+02:00
branch: lifecycle/lfc01-controller-shell
worktree: ../veslo-lifecycle-lfc01-controller-shell
done: false
depends_on:
  - LFC00
target_module: packages/server/src/conversation-run-lifecycle-controller.ts
source_ranges:
  - packages/server/src/server.ts
  - packages/server/src/routes/conversations.ts
```

Purpose:

- Add the lifecycle controller module without moving all behavior at once.
- Define dependency ports for lifecycle client, queue store, OpenCode submit, AI gateway watch,
  timers, and tracing.
- Add isolated controller tests using fake dependencies and fake timers.

Target files:

- Add:
  - `packages/server/src/conversation-run-lifecycle-controller.ts`
  - `packages/server/src/tests/conversation-run-lifecycle-controller.test.ts`
- Modify only if necessary:
  - `packages/server/src/server.ts` for construction-only wiring.

Test-first contract:

- Add tests for controller construction, `start()`, `stop()`, timer cleanup, and no-op diagnostics.
- The first focused run may fail because the controller module does not exist.
- After implementation, the tests should pass without changing route behavior.
- Add an integration-oriented assertion that the server shutdown path calls `controller.stop()` once
  the controller is wired. Unit cleanup alone is not enough; timers must be cleared through
  `server.stop()`.

Focused verification:

```bash
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts
pnpm --filter veslo-server typecheck
git diff --check
```

Acceptance:

- Controller shell exists and is importable.
- It has no product behavior change yet.
- It does not import app or orchestrator internals directly.
- It depends on explicit server-side ports.
- Server shutdown wiring cannot leak controller timers.

### Task LFC02: Submit Admission And Queue Acceptance Owner

```yaml
id: LFC02
status: available
reserved_by: null
reserved_at: null
branch: lifecycle/lfc02-submit-admission-owner
worktree: ../veslo-lifecycle-lfc02-submit-admission-owner
done: false
depends_on:
  - LFC01
target_module: packages/server/src/conversation-run-lifecycle-controller.ts
source_ranges:
  - packages/server/src/routes/conversations.ts
  - packages/server/src/server.ts
  - packages/server/src/conversation-run-queue-store.ts
```

Purpose:

- Move the submit admission decision into the controller.
- Route code should parse HTTP input and call `controller.submitRun(...)`.
- The controller should own active peek, register, `RunAlreadyActiveError` handling, and queue
  acceptance.

Preserve behavior:

- If lifecycle is inactive, return `status: "submitted"` with `runId`.
- If lifecycle is active, persist a durable queue item and return `status: "queued"` with
  `queueItemId`, `reservedRunId`, `activeRunId`, and `queuePosition`.
- `queued` remains accepted work.
- `run_already_active` remains internal and should not normally surface to the app.
- Idempotent enqueue by `clientMessageId` remains unchanged.
- Remote workspace submit keeps current lifecycle-disabled behavior.

Test-first contract:

- Add controller tests for:
  - inactive active-peek registers and proceeds to submit,
  - active active-peek queues,
  - register 409 queues,
  - remote workspace submit bypasses local lifecycle active/register/queue paths,
  - lifecycle request failure maps to existing API error behavior,
  - idempotent client message id returns the existing queue item.
- Retarget existing route tests only after controller tests describe the behavior.

Focused verification:

```bash
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/conversation-run-queue-store.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
git diff --check
```

Acceptance:

- `routes/conversations.ts` no longer owns active/register/queue branching.
- Current route response JSON remains compatible.
- Existing server conversation tests pass.

### Task LFC03: OpenCode Submit And AI Gateway Provider Watch Owner

```yaml
id: LFC03
status: available
reserved_by: null
reserved_at: null
branch: lifecycle/lfc03-submit-provider-watch
worktree: ../veslo-lifecycle-lfc03-submit-provider-watch
done: false
depends_on:
  - LFC02
target_module: packages/server/src/conversation-run-lifecycle-controller.ts
source_ranges:
  - packages/server/src/server.ts
  - packages/server/src/ai-gateway-runtime-owner.ts
```

Purpose:

- Move `submitConversationRunToOpenCode` lifecycle orchestration into the controller or behind a
  controller-owned method.
- Keep the AI gateway provider-start watch tied to the accepted lifecycle run.
- Ensure submit failures and provider-start timeouts terminalize or reconcile exactly as they do
  today.

Port boundary:

- The controller decides when to register, mark failed, abort, schedule reconcile, and clear active
  context.
- OpenCode submit remains an injected port.
- AI gateway runtime/proxy internals remain in their existing owner modules and are called through
  explicit ports.
- Do not turn the controller into a god object that owns gateway forwarding, provider resolution, or
  proxy request implementation.

Preserve behavior:

- OpenCode submit still uses orchestrator fallback with the conversation run id.
- Submit error marks lifecycle failed and schedules reconciliation.
- Managed prompt provider-start timeout marks lifecycle failed, schedules reconciliation, aborts
  OpenCode, and clears transient AI gateway active context.
- Successful submit schedules lifecycle reconciliation after the initial delay.

Test-first contract:

- Add controller tests for:
  - successful submit schedules reconcile,
  - OpenCode submit failure marks failed and clears AI gateway context,
  - provider-start timeout marks failed, aborts upstream, and clears context,
  - provider-start success does not leak active context.
- Keep existing AI gateway route tests intact.

Focused verification:

```bash
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts src/tests/ai-gateway-runtime-owner.test.ts
pnpm --filter veslo-server typecheck
git diff --check
```

Acceptance:

- `server.ts` no longer owns the submit/watch lifecycle choreography.
- AI gateway active context lifetime is explicit in the controller.
- The controller consumes AI gateway/OpenCode behavior through ports, not by absorbing runtime
  internals.
- Existing managed prompt watchdog tests pass.

### Task LFC04: Queue Drain And Lifecycle Reconcile Timers

```yaml
id: LFC04
status: available
reserved_by: null
reserved_at: null
branch: lifecycle/lfc04-queue-drain-reconcile
worktree: ../veslo-lifecycle-lfc04-queue-drain-reconcile
done: false
depends_on:
  - LFC03
target_module: packages/server/src/conversation-run-lifecycle-controller.ts
source_ranges:
  - packages/server/src/server.ts
  - packages/server/src/conversation-run-queue-store.ts
```

Purpose:

- Move queue drain timers, reconcile timers, and in-flight maps into the controller.
- Make the controller the only server owner that decides when to retry stale lifecycle reads and when
  to wake the durable queue.

Preserve behavior:

- Active latest lifecycle keeps the queue blocked and reschedules drain.
- Stale lifecycle keeps polling until terminal or inactive.
- Terminal lifecycle wakes the queue.
- `abortRequested` plus missing lifecycle marks aborted.
- `RunAlreadyActiveError` during drain moves the queue item back to pending and retries.
- Drain errors mark the queue item failed.

Test-first contract:

- Add controller tests for:
  - active latest reschedules drain,
  - stale latest reschedules reconcile,
  - terminal latest drains the next pending item,
  - missing lifecycle with abort request marks aborted,
  - register conflict during drain re-pends the item,
  - drain submit failure marks failed,
  - `stop()` clears pending timers.
- Add or preserve a server shutdown integration assertion that pending lifecycle timers are cleared
  when `server.stop()` is called.

Focused verification:

```bash
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/conversation-run-queue-store.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
git diff --check
```

Acceptance:

- `server.ts` no longer owns lifecycle timer maps or drain in-flight maps.
- Queue drain remains durable and restart-safe.
- Stale lifecycle tests keep passing.
- Shutdown cleanup is wired through the actual server stop path.

### Task LFC05: Transcript And Startup Wake-Up Wiring

```yaml
id: LFC05
status: available
reserved_by: null
reserved_at: null
branch: lifecycle/lfc05-transcript-startup-wakeup
worktree: ../veslo-lifecycle-lfc05-transcript-startup-wakeup
done: false
depends_on:
  - LFC04
target_module: packages/server/src/conversation-run-lifecycle-controller.ts
source_ranges:
  - packages/server/src/routes/conversations.ts
  - packages/server/src/server.ts
```

Purpose:

- Move transcript lifecycle wake-up and startup pending queue drain into the controller boundary.
- Route code should decide whether a transcript snapshot is terminal-looking, then notify the
  controller.
- Startup should call the controller to schedule drains for pending conversation keys.

Preserve behavior:

- `session.idle`, `session.error`, and terminal-looking assistant transcript snapshots trigger
  lifecycle reconcile.
- Transcript append does not directly mark lifecycle terminal.
- Startup schedules drain for every pending `(workspaceId, conversationId)` key.

Test-first contract:

- Add controller tests for:
  - transcript wake-up reconciles latest run and wakes queue only when terminal,
  - transcript wake-up does not mark terminal without orchestrator confirmation,
  - startup schedules drains for pending keys.
- Keep existing route test:
  - `POST /workspace/:id/sessions/:sessionId/transcript reconciles lifecycle and wakes queued runs`.

Focused verification:

```bash
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
git diff --check
```

Acceptance:

- `reconcileConversationLifecycleAfterTranscriptAppend` is no longer a free function in `server.ts`.
- Startup queue drain wiring is controller-owned.
- Transcript routes remain thin.

### Task LFC06: Abort Flow Consolidation

```yaml
id: LFC06
status: available
reserved_by: null
reserved_at: null
branch: lifecycle/lfc06-abort-flow-consolidation
worktree: ../veslo-lifecycle-lfc06-abort-flow-consolidation
done: false
depends_on:
  - LFC05
target_module: packages/server/src/conversation-run-lifecycle-controller.ts
source_ranges:
  - packages/server/src/routes/conversations.ts
  - packages/server/src/server.ts
  - packages/server/src/orchestrator-lifecycle-client.ts
```

Purpose:

- Move abort behavior into the lifecycle controller.
- Keep the existing API compatible while centralizing the lifecycle side effects.

Preserve behavior:

- Abort still requires the same route authentication and workspace/session target resolution.
- Abort requests call OpenCode abort.
- Active gateway proxy requests for the run are aborted.
- Lifecycle gets `markAbortRequested`.
- Reconcile is scheduled after abort request.
- If the orchestrator later proves the run inactive, the row becomes `aborted` where current behavior
  expects that.

Test-first contract:

- Add controller tests for:
  - successful abort calls OpenCode abort, aborts active gateway proxy requests, marks abort
    requested, and schedules reconcile,
  - abort OpenCode failure preserves existing error behavior,
  - inactive reconcile after abort marks aborted,
  - missing lifecycle after abort request marks aborted.
- Keep existing route-level abort tests.

Focused verification:

```bash
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
git diff --check
```

Acceptance:

- Route abort handler delegates lifecycle side effects to the controller.
- No app-side behavior change is required in this task.
- Current abort response shape remains compatible.

### Task LFC08: Core Diagnostics, Docs, And Final Verification

```yaml
id: LFC08
status: available
reserved_by: null
reserved_at: null
branch: lifecycle/lfc08-diagnostics-final-verification
worktree: ../veslo-lifecycle-lfc08-diagnostics-final-verification
done: false
depends_on:
  - LFC06
target_module: packages/server/src/conversation-run-lifecycle-controller.ts
source_ranges:
  - packages/server/src/conversation-run-lifecycle-controller.ts
  - docs/dev/veslo-server-app-contract.md
```

Purpose:

- Make the new owner inspectable enough to debug future stuck-run reports.
- Update docs after core code is merged.
- Run final verification in the original worktree.

Diagnostics guidance:

- Use controller-level trace events and optional test-only snapshots.
- Do not add a public product/admin diagnostics endpoint in the core slice.
- Test/internal diagnostics may expose:
  - pending reconcile timers,
  - pending drain timers,
  - in-flight reconcile keys,
  - in-flight drain keys,
  - queue pending count for a conversation,
  - latest lifecycle status,
  - active lifecycle status,
  - last wake-up reason.
- Keep diagnostics dependency-injected or test-only.

Docs:

- Update `docs/dev/veslo-server-app-contract.md` only if the core controller ownership changes
  documented server/app responsibilities.
- Do not change app abort contract docs in the core slice.
- Add a `docs/fixes/YYYY-MM-DD-...md` note only if explicitly requested after implementation is
  complete and verified.
- Do not add a YouTrack/VSLO reference unless a concrete issue id is explicitly assigned later.
- Update this plan's Progress Log after every merged task.

Final verification:

```bash
pnpm --filter veslo-orchestrator exec bun test src/tests/run-registry.test.ts src/tests/run-store.test.ts src/tests/run-activity-probe.test.ts
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/conversation-run-queue-store.test.ts src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-orchestrator typecheck
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Acceptance:

- The final focused verification passes in the original worktree.
- `server.ts` no longer owns conversation run lifecycle orchestration.
- `routes/conversations.ts` is thin around lifecycle run endpoints.
- The controller owns lifecycle timers and drain scheduling.
- Orchestrator registry remains the lifecycle source of truth.
- App UI queue remains separate from server durable queue.
- `core_done` and the top-level `done` can be changed to `true` for the core slice even while LFC07
  remains deferred.

## Deferred Follow-Up

### Task LFC07: App Latest-Run And Abort Contract Hardening

```yaml
id: LFC07
status: deferred
reserved_by: null
reserved_at: null
branch: lifecycle/lfc07-app-abort-contract
worktree: ../veslo-lifecycle-lfc07-app-abort-contract
done: false
deferred_followup: true
depends_on:
  - LFC08
target_module: packages/app/src/app/context/conversation-service.ts
source_ranges:
  - packages/app/src/app/context/conversation-service.ts
  - packages/app/src/app/context/workspace-session-selection.ts
  - packages/app/src/app/pages/session-send-workflow.ts
  - packages/server/src/routes/conversations.ts
```

Purpose:

- Reduce app-side lifecycle authority around latest run id selection.
- Prefer a server-resolved conversation abort intent where possible, while preserving the legacy
  explicit run id path.

Why deferred:

- This is probably valuable, but it changes app/server API behavior.
- The core controller refactor should first land without changing app abort semantics.
- LFC00 already freezes the current queued-result baseline so the follow-up can be deliberate.

KISS target:

- The app may still remember run ids for diagnostics and compatibility.
- The server should be able to resolve the currently active run for a conversation when the app asks
  to abort the active conversation run.
- Queued sends should remain accepted; app should not treat `reservedRunId` versus `activeRunId` as
  lifecycle truth.

Implementation guidance:

- If the current API can be extended compatibly, allow abort requests with an omitted `runId` or an
  explicit `mode: "active"`.
- The server controller resolves active lifecycle through the orchestrator client before aborting.
- Keep the old explicit `runId` route path for compatibility.
- Do not remove the app latest-run memory map in this task unless tests prove it is no longer needed
  for other flows.

Test-first contract:

- Add app tests for:
  - queued result is accepted and does not become an error,
  - abort can use server-resolved active run when available,
  - legacy explicit run id abort still works,
  - app does not overwrite active abort target with a queued reserved run id in a way that blocks
    stopping the current answer.
- Add server tests for:
  - active conversation abort resolves the active lifecycle row,
  - no active lifecycle returns the current compatible error shape.

Focused verification:

```bash
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Acceptance:

- App no longer needs to be the final authority for which active run to abort.
- Backward compatibility is preserved.
- UI draft queue behavior is unchanged.

## Required Core Test Coverage Matrix

Each row must be covered by at least one focused test before `core_done` is marked true.

| Scenario | Required owner | Test location |
| --- | --- | --- |
| inactive conversation submits immediately | server controller | `conversation-run-lifecycle-controller.test.ts`, `server-conversations.test.ts` |
| active conversation queues accepted send | server controller | `conversation-run-lifecycle-controller.test.ts`, `server-conversations.test.ts` |
| register conflict queues accepted send | server controller | `conversation-run-lifecycle-controller.test.ts` |
| remote workspace bypasses local lifecycle owner | server route/controller | `server-conversations.test.ts`, controller test if remote support is routed through controller |
| idempotent client message id returns same queue item | queue store/controller | `conversation-run-queue-store.test.ts`, controller test |
| successful submit schedules lifecycle reconcile | server controller | controller test |
| submit failure marks failed and wakes reconcile/drain | server controller | controller test |
| provider-start timeout marks failed and clears gateway context | server controller | controller test, `server-conversations.test.ts` |
| stale lifecycle keeps polling | server controller/orchestrator | controller test, `server-conversations.test.ts` |
| inactive probe releases stale active row | orchestrator registry | `run-registry.test.ts`, `run-activity-probe.test.ts` |
| terminal transcript wakes queue without directly terminalizing | server controller | controller test, `server-conversations.test.ts` |
| startup pending queue keys schedule drain | server controller | controller test |
| abort marks abort requested and reconciles terminal state | server controller/orchestrator | controller test, `server-conversations.test.ts` |
| app treats queued as accepted | app conversation service | app context/page tests |
| queued response keeps active run as current stop/abort target when present | app conversation service | app context test |

Deferred LFC07 adds this non-core coverage if it is later promoted:

| Scenario | Required owner | Test location |
| --- | --- | --- |
| app can abort active conversation without owning lifecycle truth | app + server controller | app context test, server route/controller test |

## Risks And Guardrails

### Risk: Moving too much at once

Guardrail:

- Keep each task small and test-first.
- Do not move app behavior until the server controller is merged.
- Do not alter orchestrator registry semantics while extracting server ownership.

### Risk: Starting from a dirty lifecycle worktree

Guardrail:

- LFC00 must enforce the Pre-Implementation Hygiene Gate.
- Unrelated `server.ts` or lifecycle-owner diffs must be merged, parked, or explicitly recorded
  before implementation starts.

### Risk: Two owners for queue drain

Guardrail:

- After LFC04, queue drain timers and in-flight maps should exist only in the controller.
- `server.ts` should construct the controller but not keep separate drain functions.

### Risk: Transcript append becomes lifecycle truth

Guardrail:

- Tests must prove transcript wake-up asks orchestrator status before waking queue.
- No route should call `markCompleted` or equivalent from transcript data alone.

### Risk: App latest-run memory remains a hidden lifecycle owner

Guardrail:

- LFC00 should freeze the current queued-result abort target behavior before server extraction.
- The core slice must not make app latest-run behavior worse.
- LFC07 can later make active abort server-resolved when the API change is intentionally accepted.
- App latest-run ids may remain aliases/diagnostics in core, not final lifecycle truth.

### Risk: Controller becomes a gateway/runtime god object

Guardrail:

- LFC03 moves lifecycle orchestration only.
- OpenCode submit and AI gateway runtime/proxy behavior must remain injected ports with their
  existing owners.

### Risk: Remote workspaces accidentally enter local lifecycle ownership

Guardrail:

- LFC00 and LFC02 must cover the current remote lifecycle-disabled invariant.
- Any future remote lifecycle product change needs its own plan and tests.

### Risk: Diagnostics become a public API commitment

Guardrail:

- Prefer internal trace/test diagnostics.
- If a public or admin endpoint is needed later, make it a separate follow-up plan instead of part
  of the core refactor.

## Progress Log

### 2026-07-01 Initial Audit

Status:

- `done: false`
- no implementation started from this plan

Evidence:

- Orchestrator lifecycle tests passed: 34 pass, 0 fail.
- Server lifecycle/queue/conversation tests passed: 27 pass, 0 fail.
- Existing durable lifecycle core is good enough to keep.
- Server-side orchestration is the main control-plane debt.
- App latest-run memory is a secondary hardening target, not the first extraction target.

Notes:

- The plan was created from `local/sandbox-merge` at `6fb52b44`.
- The original worktree had unrelated dirty files. Future agents must reserve from the original
  worktree, create their own worktree, and avoid unrelated changes.
- The plan is explicitly not linked to a YouTrack/VSLO issue.
- Follow-up review added guardrails for remote workspaces, app queued-run abort baseline,
  server shutdown cleanup, and LFC03 port-only ownership.

### 2026-07-01 KISS Scope Revision

Status:

- `done: false`
- `core_done: false`
- `deferred_followups_done: false`
- no implementation started from this plan

Changes:

- Required core scope is now LFC00-LFC06 plus LFC08.
- LFC07 was moved to a deferred follow-up because server-resolved app abort is an app/server API
  hardening change, not required for the lifecycle ownership refactor.
- The controller public surface was narrowed to submit, abort, transcript signal, start, stop, and
  optional test snapshot.
- Queue drain and reconcile scheduling remain controller-owned internals instead of public
  controller API.
- Core diagnostics are limited to trace events and test/internal snapshots; no new public diagnostics
  endpoint belongs in the core slice.

### 2026-07-01 LFC00 Baseline Contract Worktree

Status:

- `status: done`
- `reserved_by: codex-20260701-lfc00-baseline`
- `done: true`
- implementation branch: `lifecycle/lfc00-baseline-lifecycle-contract`
- implementation worktree: `../veslo-lifecycle-lfc00-baseline-lifecycle-contract`
- merged into original worktree at `d6246b5e`

Scope:

- Added an app behavior baseline for queued conversation run results: when the server returns
  `status: "queued"` with both `reservedRunId` and `activeRunId`, the app keeps the active run id
  as the current abort target.
- Added a server behavior baseline for remote workspaces: remote conversation sends keep the local
  lifecycle owner disabled, do not call active/register/queue lifecycle paths, and submit directly
  to the remote OpenCode session endpoint.
- Added a Windows cleanup retry helper in `server-conversations.test.ts` because the existing
  temporary directory cleanup can intermittently hit `EBUSY` after the route tests close servers.
- No runtime code was changed in LFC00; this slice freezes behavior before extraction.

Evidence:

- `pnpm install --frozen-lockfile` completed in the fresh implementation worktree after the first
  focused test attempt exposed missing local dependencies.
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts`
  passed: 4 pass, 0 fail.
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/pages/session-send-workflow.test.ts`
  passed: 7 pass, 0 fail.
- `pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts` passed on
  retry before the cleanup helper: 19 pass, 0 fail.
- `pnpm --filter veslo-orchestrator exec bun test src/tests/run-registry.test.ts src/tests/run-store.test.ts src/tests/run-activity-probe.test.ts`
  passed: 34 pass, 0 fail.
- `pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts`
  passed after the cleanup helper: 28 pass, 0 fail.
- `pnpm --filter veslo-server typecheck` passed.
- `pnpm --filter @neatech/veslo-ui typecheck` passed.
- `git diff --check` passed; Git reported LF-to-CRLF working-copy warnings only.

### 2026-07-02 LFC00 Merge Verification

Status:

- `done: true`
- merged commit: `d6246b5e`
- original branch: `local/sandbox-merge`

Evidence from original worktree after merge:

- `pnpm --filter veslo-orchestrator exec bun test src/tests/run-registry.test.ts src/tests/run-store.test.ts src/tests/run-activity-probe.test.ts`
  passed: 34 pass, 0 fail.
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts src/app/tests/pages/session-send-workflow.test.ts`
  passed: 8 pass, 0 fail.
- `pnpm --filter veslo-server exec bun test src/tests/conversation-run-queue-store.test.ts src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts`
  passed: 28 pass, 0 fail.
- `git diff --check` passed; Git reported LF-to-CRLF working-copy warnings in unrelated dirty
  files only.

Notes:

- Original worktree still contains unrelated dirty app/server owner work that is outside LFC00.
- The pre-merge untracked copy of this plan was moved to a temporary backup before fast-forward
  merge because the LFC00 branch version contained the same plan plus the LFC00 progress log.

### 2026-07-02 LFC01 Merge Blocker

Status:

- `status: blocked`
- `reserved_by: codex-20260702-lfc01-shell`
- `done: false`
- implementation branch commit: `5d6face5`

Blocker:

- LFC01 implementation and focused verification are complete in
  `../veslo-lifecycle-lfc01-controller-shell`, but merge into the original worktree is blocked
  because `packages/server/src/server.ts` has unrelated dirty owner-refactor changes. Git refuses
  fast-forward merge because LFC01 also adds construction-only wiring in `server.ts`.
- Do not mark LFC01 done or reserve LFC02 until the unrelated `server.ts` work is committed,
  merged, or parked and LFC01 is merged/verified in the original worktree.
