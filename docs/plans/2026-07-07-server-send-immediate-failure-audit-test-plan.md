---
title: Server Send Immediate Failure Audit And Test Plan
date: 2026-07-07
status: implemented
done: true
source_audit: chat:2026-07-07-server-send-immediate-failure-deep-audit
related_finding: docs/testing/findings/2026-07-07-server-send-composer-production-parity.md
base_plan: docs/plans/2026-07-07-server-owned-composer-send-workflow-deep-audit-followups.md
e2e_status: targeted-tests-pass-runtime-smoke-pass
ssif00_submit_boundary_classifier_test_done: true
ssif01_workspace_identity_registration_test_done: true
ssif02_zombie_run_queue_test_done: true
ssif03_message_id_contract_test_done: true
ssif04_non_pilot_runtime_smoke_done: true
ssif04_skill_registry_404_residual_fixed: true
ssif04_sse_listener_warning_residual_fixed: true
---

# Server Send Immediate Failure Audit And Test Plan

## Goal

Turn the 2026-07-07 immediate send-failure audit into a small, test-first
remediation plan. The current evidence points to four production-parity gaps:

1. send failures need a phase classifier so auth, session-create, run-submit,
   and queue-zombie failures cannot collapse into one generic UI error,
2. app, Veslo server, and orchestrator workspace registries can disagree,
3. persistent active runs can block the server queue indefinitely,
4. the Veslo `clientMessageId` is still forwarded as OpenCode `messageID`.

This plan is intentionally KISS. It should add targeted route/lifecycle tests
that reproduce the failure classes before any broad workflow rewrite.

## Implementation Update 2026-07-07

Implemented SSIF00-SSIF04 in `veslo-main`:

- SSIF00: added a small send-boundary failure phase classifier in
  `packages/app/src/app/lib/send-boundary-validation.ts`. The classifier keeps
  runtime preflight, server `/session`, server run-submit, and queue/lifecycle
  blockage separate without making report-mode validation block production.
- SSIF01: added server-side orchestrator workspace registration before
  orchestrator-backed OpenCode calls. `fetchOpencodeJsonWithOrchestratorFallback`
  now idempotently posts local workspace identity to `POST /workspaces` before
  using `/workspace/:id/opencode/...`, including first-submit `/session`.
- SSIF02: added stale/no-progress active-run terminalization. Queue drain now
  fails a latest active run when lifecycle status is stale or beyond the
  no-progress budget, then wakes the queue. Lifecycle reconcile does the same
  after exhausting its polling budget.
- SSIF03: separated Veslo submit idempotency from OpenCode prompt identity.
  `clientMessageId` remains the app/server idempotency key, but fresh
  `prompt_async` and `command` submissions no longer forward it as upstream
  `messageID`; OpenCode allocates the fresh prompt id. Revert still sends the
  existing OpenCode `messageID`.
- SSIF04: replaced the planned Tauri Pilot smoke with a KISS non-Pilot runtime
  smoke by request. The smoke used the real `pnpm dev` Tauri runtime with
  rebuilt sidecars, `VESLO_TAURI_PILOT=0`, and explicit runtime/send trace
  files.

Targeted verification passed:

- `pnpm --dir packages/app exec node --import=tsx/esm --test src/app/tests/pages/session-send-workflow.test.ts`
  - 37 pass, 0 fail.
- `bun test packages/server/src/tests/conversation-run-lifecycle-controller.test.ts --timeout 30000`
  - 36 pass, 0 fail.
- `bun test packages/server/src/tests/server-conversations.test.ts --timeout 30000`
  - 41 pass, 0 fail.
- `pnpm --filter veslo-server typecheck`
  - passed.
- `pnpm --dir packages/app typecheck`
  - passed.
- `pnpm --filter veslo-server build:bin`
  - passed; rebuilt `packages/server/dist/bin/veslo-server.exe`.
- `$env:VESLO_SIDECAR_FORCE_BUILD='1'; pnpm --filter @neatech/veslo run prepare:sidecar`
  - passed; rebuilt the desktop server sidecar.
- Non-Pilot runtime smoke:
  - evidence directory:
    `.tmp/ssif04-runtime-smoke-20260707-230800/`;
  - `pnpm dev` reached `Running target\debug\veslo.exe`;
  - orchestrator reconciled 3 workspaces and served workspace
    `ws-8df10915b772`;
  - managed OpenCode dependencies were vendored and present:
    `@opencode-ai/plugin` 1.17.13, `zod` 4.1.8,
    `@ai-sdk/openai-compatible` 3.0.5;
  - shared OpenCode health became `200` with version 1.17.13;
  - five real send traces were accepted/submitted through the rebuilt runtime;
  - first session create went through
    `/workspace/ws-8df10915b772/opencode/session` with upstream status `200`;
  - subsequent `prompt_async` submits went through
    `/workspace/ws-8df10915b772/opencode/session/:id/prompt_async` with
    upstream status `204`;
  - every captured `server:conversation-run:opencode-submit-body` had
    `messageID: null`;
  - no workspace/session `404`, validation failure, `zod` resolution failure,
    or zombie queue loop appeared in the runtime/send traces.

Runtime smoke residual observations before follow-up patch:

- The smoke did not use Tauri Pilot and therefore did not assert the visible
  composer-clears-only-after-acceptance UI detail. This was intentionally
  skipped because Pilot is currently too slow for this fix path.
- One non-causal `workspace-skill-materialization failed:configured-sync`
  event remained: `skill_registry_not_found`, status `404`.
- OpenCode stderr emitted an EventEmitter listener warning during the long
  live run. It did not block submit, provider proxying, transcript ingestion,
  or OpenCode health.

Follow-up residual fixes on 2026-07-07:

- `skill_registry_not_found` during configured workspace materialization sync
  is now handled server-side as a degraded workspace materialization result
  (`status: degraded`, `synced: false`, `reloadRequired: false`) instead of
  throwing into the app gate as `failed:configured-sync`. This keeps local
  runtime/send usable when Den/registry is configured but the registry does not
  expose the workspace skill-set resource.
- Session SSE cleanup now explicitly closes active subscription handles on
  cleanup and after stream end before reconnect. The Rust SSE wrapper also uses
  a one-shot abort listener and removes it on close. This targets the repeated
  `/event` subscriptions that can accumulate upstream OpenCode listeners during
  route/effect churn.
- Targeted verification for the residual fixes:
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/session-event-stream.test.ts src/app/tests/lib/engine-sse.test.ts`
    - 20 pass, 0 fail.
  - `bun test packages/server/src/tests/server.skill-materialization.test.ts --timeout 30000`
    - 26 pass, 0 fail.
  - `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-skill-materialization-sync.test.ts src/app/tests/context/session-routing-runtime.test.ts src/app/tests/context/session-unread-events.test.ts`
    - 18 pass, 0 fail.
  - `pnpm --filter @neatech/veslo-ui typecheck`
    - passed.
  - `pnpm --filter veslo-server typecheck`
    - passed.
  - `git diff --check`
    - passed; only existing LF-to-CRLF warnings were reported.

## Current Evidence Boundary

The pasted runtime report described:

- a new private workspace `ws-f61de366244b` created by
  `POST /workspaces/local`,
- an immediate orchestrator `404` on
  `/workspace/ws-f61de366244b/opencode/session`,
- an older persistent run `ae9c6ef8` that stayed `running` and kept later
  work queued behind it,
- repeated queue drain scheduling around the same conversation,
- noisy but likely non-causal errors such as missing `zod`, registry event
  `401`, and filesystem `EPERM`.

The exact runtime handles from that report were not available in the local
spool snapshot during audit, so they remain externally reported evidence. The
source-level failure classes are still confirmed by code paths and existing
tests.

Follow-up audit notes from the live `veslo-main` checkout:

- The audit ran on HEAD `ce277072` against a dirty worktree. Several
  submit/auth files were already modified by other work, including
  `packages/server/src/routes/conversations.ts`, so fixes should re-read the
  current diff before editing.
- No currently running Veslo/orchestrator process was found during the audit.
  `veslo-server-runtime.json` pointed at stale PID `21752`; local verification
  therefore used persisted state and spool logs rather than live HTTP calls.
- The local dev orchestrator state did not contain the externally reported
  `ws-f61de366244b`, and the local spool snapshot did not contain
  `ae9c6ef8`. Those exact ids are report evidence, not local evidence.
- The local dev `runs.sqlite` still contained the same failure class: active
  run `2734ec7a-74a6-436a-803f-e43a411f1b79` in workspace
  `ws-8df10915b772`, conversation `conv-de8cbc9ce1a2b451afb5`, status
  `running`, created `2026-07-07T15:55:37.241Z`, while the persisted
  orchestrator state had `engines: {}`. That is a concrete zombie-run sample,
  even though it is not the same id as the pasted report.
- The installed local OpenCode SDK was `@opencode-ai/sdk@1.17.13`. Context7
  OpenCode docs describe prompt ids as optional caller-provided ids for a new
  prompt/admission, with generated ids when omitted. This weakens the claim
  that a random `messageID` is inherently invalid, but it does not make the
  current Veslo coupling safe.
- `zod` is present in the current workspace: `pnpm --filter veslo-server exec
  bun -e "import 'zod'; console.log('zod ok')"` passed. Treat missing `zod` in
  the runtime report as dependency-install/runtime churn unless fresh logs tie
  it to send admission.

## Source Anchors

Start from these files before implementing or reviewing fixes:

- `packages/server/src/routes/conversations.ts`
  - `buildConversationSubmitRunBody(...)` copies
    `request.clientMessageId` into upstream `body.messageID` for prompt and
    command submits.
  - `POST /workspace/:id/conversations/submit` passes the same
    `clientMessageId` into `conversationRunLifecycleController.submitRun(...)`.
- `packages/server/src/conversation-submit-service.ts`
  - first submit without an existing conversation materializes a session through
    `conversationService.createConversation(...)` before run lifecycle starts.
    Immediate new-chat orchestrator 404s therefore happen on upstream
    `/session`, not on `/prompt_async`.
- `packages/app/src/app/lib/session-send-contract.ts`
  - `createSessionClientMessageId()` creates `msg_...` from
    `crypto.randomUUID()`.
- `packages/app/src/app/pages/session-conversation-flow.ts`
  - send flow creates a new client message id before submit.
- `packages/server/src/conversation-run-lifecycle-controller.ts`
  - submit failure uses lifecycle `markFailed(...)`,
  - provider-start timeout records diagnostics and schedules reconcile,
  - reconcile exhaustion records
    `server:conversation-run:lifecycle-reconcile-exhausted` but does not
    terminalize the run,
  - queue drain checks latest lifecycle state and reschedules when it is active.
- `packages/server/src/orchestrator-lifecycle-client.ts`
  - `markFailed(workspaceId, runId, error)` already exists, so the missing part
    is policy/use, not basic API plumbing.
- `packages/server/src/tests/conversation-run-lifecycle-controller.test.ts`
  - the provider-start timeout test currently asserts no `markFailed` call.
    Update this contract carefully instead of adding a contradictory test beside
    it.
- `packages/server/src/routes/workspace-management.ts`
  - `POST /workspaces/local` updates Veslo server workspace/config state, but
    does not register the workspace with orchestrator.
- `packages/desktop/src-tauri/src/commands/orchestrator.rs`
  - `register_workspace_with_orchestrator(...)`,
    `reconcile_orchestrator_workspaces(...)`, and
    `orchestrator_workspace_activate(...)` are the current orchestrator
    registration owners.
- `packages/orchestrator/src/cli.ts`
  - unknown workspace proxy requests return `404 { error: "workspace not found" }`.
- `packages/app/src/app/context/conversation-service.ts`
  - `submitConversationFromVesloWriteApi(...)` resolves/registers a workspace
    with the Veslo server before submit, but does not itself prove the
    orchestrator knows that workspace.
- `packages/app/src/app/context/workspace-activation-controller.ts`
  - `app:new-private-scratch-workspace`,
    `app:new-private-existing-pending-draft`,
    `composer-target:create-private`, and `composer-target:chat` are passive
    local browse origins.
- `packages/app/src/app/context/workspace.ts`
  - `browseWorkspace(...)` updates app local state and calls
    `workspaceSetActive(...)`, but it does not run the full
    `activateOrchestratorWorkspace(...)` path.
- `packages/app/src/app/context/pending-session-draft-controller.ts` and
  `packages/app/src/app/context/composer-target-controller.ts`
  - private-chat creation does call `activateWorkspace(...)`, but the relevant
    origins route through the passive browse policy. Treat the new-chat failure
    as registry split, not simply as "activateWorkspace was not called".

## Pre-Implementation Validation Checklist

If the app still reproduces the issue, capture these before changing source:

- exact server workspace id, app workspace id, conversation id, run id, and
  `clientMessageId`;
- `/status.runtimeChain` output, including server and orchestrator URL/PID
  agreement;
- whether the orchestrator knows the workspace before the first
  `/workspace/:id/opencode/session` call;
- which submit boundary failed: app auth/preflight, server session-create,
  server run-submit, or queued-run drain;
- upstream response body for any `404 workspace not found` or OpenCode
  prompt/message error;
- lifecycle row status, `wait_reason`, `activity_kind`,
  `last_useful_progress_at`, engine pid/base URL, and terminal timestamp;
- queue row state for the same conversation;
- submit-attempt trace events around `opencode-submit-body`,
  `queue-drain-scheduled`, provider-start timeout, and reconcile exhaustion.

Do not use `/health` alone to declare the runtime healthy for this incident
class. It can be green while the effective server-orchestrator chain is stale.

## Hypothesis Matrix

| ID | Hypothesis | Why this could be true | Current confidence | How to confirm |
| --- | --- | --- | --- | --- |
| H0 | The app needs a submit-boundary classifier before root-cause fixes are easy to trust. | Auth-prime failures, session-create 404s, run-submit 404s, and queue-zombie waits can all surface as generic send failure. Current app-side validation checks payload shape, but it does not by itself prove which runtime boundary failed. | High | Add a small classifier test that maps representative responses/traces into the four phases and preserves the typed reason in send diagnostics. |
| H1 | Workspace identity can split between app, Veslo server, and orchestrator registries. | Private-chat origins are passive browse origins. `browseWorkspace(...)` can update app state and server active workspace state without running full orchestrator activation. A workspace can therefore be known to the app and Veslo server while missing from the orchestrator router. | High | Add app/source and server HTTP tests that cover the private browse path, assert app workspace id/server workspace id/orchestrator mount id mapping, and verify server registration before the first `/workspace/:id/opencode/session` call. |
| H2 | A persistent active run can hold the conversation queue forever. | Provider-start timeout currently records diagnostics and schedules reconcile, but does not fail the run. Queue drain sees the latest lifecycle run as active and schedules another drain every poll interval. Reconcile exhaustion records diagnostics but does not terminalize the run. | High | Add lifecycle and queue tests where the latest run stays active/no-progress past the hard budget, then assert the run becomes non-active terminal, queue drain wakes, and the queued item drains. |
| H3 | Forwarding Veslo `clientMessageId` as OpenCode `messageID` may break second and later messages, or at least conflates two contracts. | The app creates a fresh random `msg_...` id for sends, and the server forwards it as the upstream OpenCode `messageID`. Current OpenCode docs describe the prompt id/message id as optional caller-provided prompt/admission identity, so the bug is plausible but not proven without the real error body or a contract test against the installed OpenCode behavior. | Medium-low as root cause, high as contract risk | Add an outbound-body contract test first. If the chosen contract is to let OpenCode allocate prompt message ids, assert `messageID` is omitted while Veslo still stores `clientMessageId` for submit idempotency. If the chosen contract is caller-provided ids, add same-id retry and different-prompt same-id conflict tests. |
| H4 | `zod`, registry `401`, and `EPERM` are correlated runtime noise, not the immediate send root cause. | They affect startup/dependency health, auth polling, or filesystem scanning, but they do not explain an orchestrator workspace `404` or an active-run queue blocker by themselves. | Medium-high | Keep them out of the root fix. Only promote one if a confirming test or fresh runtime log ties it to submit admission. |

## Test-First Plan

### SSIF00: Submit-boundary classifier

Status: `implemented-targeted-tests-pass`

Owner: app send workflow diagnostics plus server submit result shape

Purpose:

- Keep this as a small classifier, not a broad validation framework.
- Distinguish the phase that failed before applying root-cause fixes:
  - app auth/runtime preflight before server submit,
  - server session materialization through upstream `/session`,
  - server run submit through upstream `/prompt_async` or command submit,
  - queued run blocked behind a stale active lifecycle row.
- Preserve the typed phase in send trace/debug output so a later generic
  `Odeslani selhalo` can be traced to the correct boundary.

Primary test shape:

1. Add narrow app/service tests or server result tests with representative
   shaped failures for each phase above.
2. Assert the visible submit result keeps `draftDisposition`, stable `code`,
   phase, and recoverability.
3. Assert malformed payload validation remains separate from root-cause
   classification. Zod/send-boundary validation can fail closed on bad shape,
   but it must not be treated as the workspace-registration or queue fix.

Expected GREEN behavior:

- Auth/preflight failures never look like orchestrator 404s.
- `/session` 404s are classified as `conversation_create_failed` or a more
  specific workspace-registration code.
- `/prompt_async` failures are classified as run-submit failures.
- Queued work blocked behind a stale active run is classified as queue/lifecycle
  blockage, not as a first-submit failure.

### SSIF01: Workspace identity and orchestrator registration before submit

Status: `implemented-targeted-tests-pass`

Owner: Veslo server route/orchestrator integration

Implementation ownership:

- The fix must be observable from the Veslo server route layer. App-side
  `activateWorkspace(...)` can remain a useful caller preflight, but it is not
  an acceptable root fix by itself because server-owned submit routes must work
  when no app activation call happens between `POST /workspaces/local` and
  conversation submit.
- The root issue is registry split, not only workspace creation. The app
  registry, Veslo server registry, and orchestrator registry must agree on the
  local workspace identity before an orchestrator-backed OpenCode request.
- Preferred KISS owner: a server-side idempotent orchestrator workspace
  registration preflight before local orchestrator-backed OpenCode calls.
- If the server cannot reach or authenticate to the orchestrator, return a
  typed server error instead of relying on the later opaque
  `/workspace/:id/opencode/*` `404`.

Primary test shape:

1. Start a fake orchestrator server with:
   - `POST /workspaces` that records registered workspace ids and paths,
   - `/workspace/:id/opencode/session` that returns `404` unless the workspace
     id was registered first,
   - normal fake OpenCode session/prompt responses after registration.
2. Start the Veslo server test harness with an orchestrator-derived local
   workspace base URL.
3. Cover the private-chat browse path at source/app-test level:
   `composer-target:create-private` or `app:new-private-scratch-workspace`
   routes through passive browse and does not itself prove orchestrator
   registration.
4. Call `POST /workspaces/local` through the Veslo server route to create or
   confirm the same local/private workspace.
5. Submit a server-owned composer prompt for that workspace with no existing
   conversation target.

Expected RED behavior today:

- the submit path reaches `/workspace/:id/opencode/session` before the fake
  orchestrator has seen `POST /workspaces`, so it receives `404`.
- the failure happens during session materialization (`/session`) before run
  lifecycle and before queue logic can help.

Expected GREEN behavior:

- the Veslo server ensures orchestrator registration for server-known local
  workspaces before the first orchestrator-backed OpenCode call,
- the fake orchestrator sees `POST /workspaces` before
  `/workspace/:id/opencode/session`,
- app workspace id, server workspace id, resolved path, and orchestrator mount
  id are asserted as the same intended identity or as an explicitly documented
  alias mapping,
- the submit returns a typed accepted result instead of an opaque immediate
  send failure.

Acceptance:

- The test asserts request order, workspace id, workspace path, and final
  submit result.
- The test asserts server ownership. The route must pass even when the app does
  not call `activateWorkspace(...)` after creating the workspace.
- The route should register through the same orchestrator public contract that
  Tauri uses: `POST /workspaces` with enough identity to preserve the Veslo
  server workspace id and resolved local path.
- The first-submit test must cover upstream `/session`; prompt/run submit can
  be a second assertion, not the only assertion.
- The fake orchestrator should reject unknown workspace ids at the same layer
  as the real router: `/workspace/:id/opencode/*` returns `404 workspace not
  found` until `POST /workspaces` has registered that id.
- Cover both new workspace and existing workspace idempotency. Repeated
  `POST /workspaces/local` with opencode metadata currently returns `200` or
  `409` depending on payload shape; registration preflight must tolerate the
  already-known case without turning it into a send failure.
- If registration fails, the returned error is typed, for example
  `workspace_not_registered_in_orchestrator`, and includes enough diagnostic
  context for the app/dev console.

### SSIF02: Zombie active run terminalization and queue unblock

Status: `implemented-targeted-tests-pass`

Owner: conversation run lifecycle controller

Primary test shape:

1. Seed a lifecycle store with a latest run that is still active
   (`running`, no terminal timestamp).
2. Seed a pending queue item behind that run.
3. Simulate provider-start never being observed and lifecycle reconcile staying
   active/no-progress until the hard budget is exhausted.
4. Run queue drain/reconcile through the real controller, not a hand-rolled
   isolated branch.

Expected RED behavior today:

- the run remains active,
- queue drain schedules another poll,
- the queued item never submits.

Expected GREEN behavior:

- the stale/no-progress active run is marked `failed` or another non-active
  terminal status with a clear reason,
- queue drain is woken,
- the pending queue item is submitted or reaches a typed terminal failure,
- the submit-attempt cache does not keep replaying a stale `queued` result if
  the durable queue item is already failed.
- lifecycle diagnostics preserve the original stale run id, conversation id,
  wait reason, last progress timestamp, engine pid/base URL, and
  terminalization reason.

Additional coverage required:

- Add a case where the lifecycle owner returns `stale: true` with an active
  status. Current server reconcile records `lifecycle-reconcile-stale` and
  schedules the next attempt, but does not terminalize the run.
- Add an ownerless/restart case: an active lifecycle row points to an engine
  owner or runtime that no longer exists after restart. It must not remain
  `running` or `blocked` forever just because the 24h legacy sweep has not
  reached it.
- Add a queue-drain case where `latest` returns an active stale run. Current
  queue drain only checks active status, not `stale`, so it can schedule another
  drain forever.
- Add a startup/restart case below the current 24h legacy sweep age. A run from
  20:29 should not require waiting until the next day before it stops blocking
  a user-visible conversation.
- Add an explicit `blocked` regression case if the fix touches status
  semantics. Today `blocked` is still active, so a `blocked` latest run must
  keep blocking queue drain unless the implementation deliberately changes the
  active-status contract and updates both server and orchestrator tests.

Important constraint:

- Do not fail a run solely because provider-start diagnostics timed out. The
  existing docs/tests intentionally treat provider-start timeout as diagnostic
  evidence. The terminalization condition must require stronger no-progress
  evidence, such as hard reconcile exhaustion, stale runtime state, unreachable
  engine, or no live session progress across the bounded window.
- Be explicit about `blocked` versus `failed`. `blocked` is currently part of
  `ACTIVE_RUN_STATUSES` in both server and orchestrator code; using it as the
  "terminal" outcome will not unblock the queue unless the active-status set or
  queue semantics change too. The KISS default for this incident is
  `markFailed(...)` with a no-progress/stale-runtime reason.
- Update the existing provider-start timeout test rather than keeping a stale
  assertion that timeout diagnostics can never lead to failure. The intended
  behavior should be: provider-start timeout is diagnostic at first, but bounded
  no-progress evidence eventually terminalizes the run.
- The terminalization path must call the lifecycle owner and then schedule
  queue drain immediately. A trace-only fix does not satisfy this plan.

### SSIF03: OpenCode `messageID` contract test

Status: `done`

Owner: server conversation submit payload

Primary test shape:

1. Use server HTTP routes and fake OpenCode endpoints to capture outbound
   `prompt_async` and command bodies for both server-owned entrypoints:
   - `POST /workspace/:id/conversations/submit`,
   - `POST /workspace/:id/conversations/:conversationId/runs`.
2. Cover:
   - first prompt in a new conversation,
   - second prompt in an existing conversation,
   - same `clientMessageId` retry of the same prompt.
3. Assert the intended contract explicitly.

Implemented GREEN contract:

- Veslo keeps `clientMessageId` as the server/app idempotency key.
- OpenCode `messageID` is omitted for fresh user prompts so OpenCode can
  allocate the upstream message id.
- If a same-fingerprint retry must reuse an upstream id, it uses a durable
  upstream/OpenCode message id, not a fresh UI-generated UUID.
- Direct run-route compatibility follows the same omission rule for fresh
  prompt/command sends, while retaining
  `messageID` only as a legacy fallback input for Veslo `clientMessageId`.

Why this needs a test:

- The current source definitely forwards random `msg_...` ids as upstream
  `messageID`, but the audit did not locally prove that this alone causes the
  reported second-send failure. A test makes the chosen contract durable and
  prevents future accidental coupling between Veslo idempotency and OpenCode
  prompt identity.
- If the team chooses to keep caller-provided OpenCode prompt ids, rename or
  split the variables in code/tests anyway: `clientMessageId` should not be the
  only name for both Veslo submit idempotency and OpenCode prompt identity.
  Tests should assert same `clientMessageId` retry reuse and different prompt
  conflict behavior explicitly.
- Do not change only `buildConversationSubmitRunBody(...)` while leaving the
  direct run route to forward the same ambiguous identity under another path.

### SSIF04: Non-Pilot runtime smoke after source fixes

Status: `done`

Owner: desktop runtime smoke without Tauri Pilot

Tauri Pilot was intentionally skipped for this plan because it is currently too
slow for this fix path. The replacement smoke keeps the useful production
signals: rebuilt sidecars, real Tauri dev runtime, real local server, real
orchestrator, real OpenCode sidecar, and real send traces.

Smoke scenario:

1. Clean repo-owned Veslo dev/test processes.
2. Rebuild `veslo-server` binary and desktop sidecars.
3. Launch the real Tauri desktop runtime with `VESLO_TAURI_PILOT=0` and
   explicit runtime/send trace files.
4. Send a first message and assert from traces:
   - orchestrator registration happens before first OpenCode workspace call,
   - no immediate `workspace not found` `404` appears,
   - `/workspace/:id/opencode/session` returns upstream status `200`,
   - `sendPromptImmediate:result` is `accepted: true`,
   - `status` is `submitted`.
5. Send at least one second message in the same conversation and assert:
   - no random upstream `messageID` rejection,
   - no permanent queued state behind a stale previous run,
   - `prompt_async` returns upstream status `204`,
   - OpenCode provider proxying returns status `200`.

Commands used:

```powershell
pnpm --filter veslo-server exec bun test src/tests/server-conversations.test.ts src/tests/conversation-run-lifecycle-controller.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD = "1"; pnpm --filter @neatech/veslo run prepare:sidecar; Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD
$env:VESLO_TAURI_PILOT = "0"
$env:VESLO_RUNTIME_TRACE = "1"
$env:VESLO_SEND_WORKFLOW_TRACE = "1"
$env:VITE_VESLO_SEND_WORKFLOW_TRACE = "1"
pnpm dev
pnpm --filter @neatech/veslo dev:cleanup
git diff --check
git diff --cached --check
```

## Diagnostic Output Expectations

The fixes should produce typed, searchable diagnostics instead of only generic
`Odeslani selhalo` UI failure text:

- workspace registration failures should include workspace id, path,
  orchestrator URL, request phase, and upstream status/body when available;
- stale run terminalization should include run id, conversation id, previous
  status, wait reason, last useful progress timestamp, engine pid/base URL, and
  terminalization trigger;
- message-id contract failures should include Veslo `clientMessageId`, upstream
  prompt/message id if known, conversation id, and whether the send was first
  prompt, subsequent prompt, or retry;
- non-causal noise such as registry `401`, missing `zod`, and filesystem
  `EPERM` should stay separately classified unless a submit trace ties it to
  admission.

## KISS Fix Order

1. Add SSIF00 as a small classifier so future failures preserve the exact
   failed boundary.
2. Add SSIF01 and SSIF02 as failing source-level tests.
3. Implement server-owned orchestrator workspace registration as an idempotent
   preflight for local orchestrator-backed submits.
4. Implement bounded active-run terminalization to `failed` or another
   non-active terminal status, and wake queue drain immediately. Do not treat
   provider-start timeout alone as failure.
5. Add SSIF03 for both server-owned submit and direct run routes, then settle
   the `messageID` contract. Keep this after workspace/session 404 and zombie
   queue fixes unless fresh OpenCode error evidence reprioritizes it.
6. Run SSIF04 as the only live desktop runtime smoke for this issue family.

This order was followed: SSIF01 and SSIF02 fixed the strongest causal blockers
first, then SSIF03 removed the remaining prompt-identity contract risk.

## Out Of Scope

- Broad chaos testing.
- Full durable queue UI migration.
- A generic retry loop around failed sends.
- Treating registry polling, `zod`, or unrelated filesystem errors as root
  causes without a confirming test.
- Starting a new manual desktop runtime before the source-level contracts are
  pinned.
- Restoring Tauri Pilot coverage for this issue family in this KISS pass.

## Done Criteria

Set the front matter flags to `true` only when:

- `ssif00_submit_boundary_classifier_test_done`: auth/preflight,
  session-create, run-submit, and queue-zombie failures are classified into
  distinct typed phases.
- `ssif01_workspace_identity_registration_test_done`: the workspace
  identity/registration test is implemented and passing against the fix,
  including the private browse path and first-submit `/session` registration.
- `ssif02_zombie_run_queue_test_done`: lifecycle/queue tests prove active
  no-progress runs become terminal and queue drain resumes.
- `ssif03_message_id_contract_test_done`: outbound OpenCode prompt identity is
  explicitly tested and matches the chosen contract.
- `ssif04_non_pilot_runtime_smoke_done`: one rebuilt non-Pilot desktop runtime
  smoke proves the real runtime no longer hits immediate workspace `404`, random
  upstream `messageID` rejection, or permanent queue blockage in the covered
  flow.

Top-level `done: true` means the revised KISS plan is complete. Tauri Pilot UI
coverage is intentionally skipped here and is not a blocker for this plan.
