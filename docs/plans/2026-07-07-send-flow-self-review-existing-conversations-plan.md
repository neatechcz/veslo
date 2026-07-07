---
title: Send Flow Self Review And Existing Conversations Plan
date: 2026-07-07
status: active
source_audit: chat:2026-07-07-send-flow-self-review-after-skill-registry-fix
related_plans:
  - docs/plans/2026-07-07-server-send-immediate-failure-audit-test-plan.md
  - docs/plans/2026-07-07-opencode-old-conversation-submit-audit.md
  - docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md
verification_status: source-tests-pass-trace-audit-only
source_tests_done: true
managed_ai_auth_prime_classifier_done: true
trace_summary_tool_done: true
orchestrator_proxy_trace_classifier_done: true
runtime_trace_audit_done: true
latest_manual_pnpm_dev_trace_review_done: true
fresh_runtime_send_done: false
runtime_done: false
pilot_done: false
tauri_pilot_status: skipped
---

# Send Flow Self Review And Existing Conversations Plan

## Goal

Capture the post-fix self-review for the 2026-07-07 send failure family, with
special focus on whether older conversations fail through the same foundation as
new chats.

This is intentionally KISS: keep the causal tree small, preserve evidence, and
avoid turning every possible send symptom into one broad rewrite.

## Current Verdict

The current codebase has multiple separate failure layers. The recent fixes are
causal for several of them, but not all layers share the same root cause.

1. Workspace skill registry/materialization is a runtime-start gate.
   It can block runtime attach/recovery before any model request starts. The
   current fix makes missing workspace registry state non-blocking by returning
   `not-configured` or `degraded` and skipping sync when there is no actionable
   workspace skill-set.

2. New first-session sends and existing-session sends share the server submit
   contract, but they enter it differently.
   First-session sends materialize a session and can fail before run lifecycle
   on `/session`. Existing-session sends go through `server-submit-existing`
   and then through target resolution plus run lifecycle.

3. Existing-session sends have a managed-AI auth-prime gate before server
   `/conversations/submit`.
   `submitConversationFromVesloWriteApi` can stop at
   `managed-ai-runtime-auth-prime` before the server submit request is made.
   This is separate from skill materialization and stale queue cleanup.

4. Older conversations are not only a skill-registry problem.
   They depend on the server being able to resolve or import the OpenCode
   session identity into a Veslo conversation binding. The earlier audit found a
   real risk here. Current tests now cover legacy OpenCode import-on-submit and
   transcript import, so this layer appears addressed in the current tree.

5. Zombie/stale runs are a separate run-lifecycle layer.
   Queue drain and lifecycle reconcile now fail stale or no-progress active runs
   and wake queued work. This addresses the old-conversation case where a later
   prompt is stuck behind a persistent active run.

6. `clientMessageId` is still an internal idempotency/tracing key, not an
   upstream OpenCode prompt id.
   `packages/server/src/routes/conversations.ts` builds the internal run body
   with `clientMessageId`; `packages/server/src/server.ts` then whitelists the
   final OpenCode submit body by run kind. Fresh prompt/command submits no
   longer forward `clientMessageId` or random `messageID` upstream.

## Source Evidence

- App existing-session server submit starts in
  `packages/app/src/app/pages/session-send-workflow.ts` at
  `submitExistingSessionWithServer`.
- Existing-session server submit can stop before the HTTP submit request when
  `packages/app/src/app/context/conversation-service.ts` runs
  `submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime`.
- App first-session server submit skips legacy runtime preflight when server
  submit is available, then creates/materializes a session before returning the
  terminal submit result.
- Runtime skill sync is called by
  `packages/app/src/app/context/workspace-runtime-controller.ts` before local
  runtime attach/start.
- Skill materialization status is decided by
  `packages/server/src/routes/skill-materialization.ts`, including
  workspace-registry-not-found and degraded registry outcomes.
- The app materialization gate in
  `packages/app/src/app/context/workspace-skill-materialization.ts` skips sync
  for `not-configured`, `workspaceRegistryConfigured: false`, and non-reload
  `degraded` status.
- Internal submit body construction starts in
  `packages/server/src/routes/conversations.ts` at
  `buildConversationSubmitRunBody(...)`; final OpenCode submit body
  sanitization happens in `packages/server/src/server.ts` through
  `buildConversationRunBody(...)`, which only copies fields allowed for the
  current run kind.
- Stale active queue handling lives in
  `packages/server/src/conversation-run-lifecycle-controller.ts` through
  `shouldFailStaleActiveLifecycleRun(...)`, queue-drain stale failure, and
  reconcile-budget stale failure.
- Legacy OpenCode session import is covered by
  `packages/server/src/tests/server-conversations.test.ts`:
  `POST /workspace/:id/conversations/submit imports verified legacy OpenCode session targets`
  and `GET /workspace/:id/sessions/:sessionId/transcript imports legacy OpenCode session identity`.

## Runtime Trace Evidence

Latest inspected `.tmp/send-workflow-trace.ndjson` had file mtime
`2026-07-07 23:40:51` local time. The relevant existing-conversation trace
events were at `2026-07-07T21:40Z` UTC and showed existing sends going through:

- `sendPrompt:server-submit-existing:start`
- `submitConversationFromVesloWriteApi:submit`
- `server:conversation-submit-run:start`
- `server:conversation-run:opencode-submit-body`
- `server:conversation-run:opencode-submit`
- `sendPrompt:server-submit-existing-success`
- lifecycle reconcile to `completed`

The captured OpenCode submit-body summaries had:

- `messageID: null`
- fields limited to normal OpenCode submit fields such as `model`, `parts`, and
  `variant`
- no generic workspace/session `404`
- no permanent queued state in the sampled run

Concrete sampled traces:

- `send_eacc6161-6b4e-43a0-abab-b31a8483e23e`
  - run `8f94b9c9-6210-4095-b924-35de0eb36b36`
  - conversation `conv-e9c36a6cb0978a78d718`
  - session `ses_0c19689a4ffehBIPRBTenXrHj9`
  - OpenCode body fields: `model,parts,variant`
  - `messageID: null`
  - lifecycle reached `completed`
- `send_4015a9ce-9b79-4ea5-bc03-951c54132d93`
  - run `1cd57bbd-353f-4490-bca3-415c19f4b294`
  - conversation `conv-e9c36a6cb0978a78d718`
  - session `ses_0c19689a4ffehBIPRBTenXrHj9`
  - OpenCode body fields: `model,parts,variant`
  - `messageID: null`
  - lifecycle reached `completed`

## Verification Run

Targeted tests passed on 2026-07-07:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/workspace-skill-materialization-sync.test.ts
bun test packages/server/src/tests/conversation-run-lifecycle-controller.test.ts packages/server/src/tests/server-stale-active-run.integration.test.ts --timeout 60000
bun test packages/server/src/tests/server.skill-materialization.test.ts --timeout 60000
bun test packages/server/src/tests/server-conversations.test.ts --timeout 90000
```

Observed results:

- app send workflow: 38 pass
- app skill materialization gate: 12 pass
- server lifecycle plus stale-active integration: 37 pass
- server skill materialization: 28 pass
- server conversations: 41 pass

This is source-level and trace-audit verification. It is not a fresh runtime
send close-out. `fresh_runtime_send_done`, `runtime_done`, and `pilot_done`
remain false in the metadata until a new dev runtime send is executed and
recorded after this plan.

## Implementation Update 2026-07-08

Implemented the first KISS follow-ups from this plan:

- Added a distinct `managed-ai-auth-prime` send-boundary failure phase in
  `packages/app/src/app/lib/send-boundary-validation.ts`.
  `submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime` failures
  no longer collapse into generic app runtime preflight classification.
- Added focused classifier coverage in
  `packages/app/src/app/tests/pages/session-send-workflow.test.ts`.
- Added `scripts/send-trace-summary.mjs`, a dependency-free NDJSON summarizer
  for `.tmp/send-workflow-trace.ndjson`. It groups traces by trace id, run id,
  or request id and reports phases, ids, statuses, and problem events.

Verification after this update:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts
pnpm --filter @neatech/veslo-ui typecheck
node --check scripts/send-trace-summary.mjs
node scripts/send-trace-summary.mjs .tmp/send-workflow-trace.ndjson --limit=3
node scripts/send-trace-summary.mjs .tmp/send-workflow-trace.ndjson --limit=1 --json
```

Observed results:

- app send workflow: 38 pass
- app typecheck: pass
- trace summary script syntax check: pass
- trace summary text mode parsed 1693 line(s), skipped 0, grouped 126 trace(s)
- trace summary JSON mode honored `--limit=1`
- latest manual runtime trace summary parsed 833 line(s), skipped 0, grouped
  53 trace(s)
- latest manual runtime `GET /opencode/event` socket-close rows are classified
  as `orchestrator-proxy` with `problems: 0`

Additional runtime-log review on 2026-07-08:

- Inspected `.tmp/manual-pnpm-dev-20260707-235514`.
- The run started `pnpm dev` in manual dev runtime mode and produced
  `.tmp/manual-pnpm-dev-20260707-235514/send-workflow-trace.ndjson`.
- The trace contains a successful first-session send:
  `send_72336155-f42c-4d0b-a6a2-492ac2b1867d`, session
  `ses_0c16b2830ffekcWFLpPqaALFuw`, run
  `67b10d18-6b6c-4f01-a6f4-620727b7863f`, `accepted: true`,
  `status: submitted`.
- The trace contains successful existing-session sends into the same OpenCode
  session, including `send_549fec5b-6bab-45c8-91de-8eb648834dcd`, run
  `3cfad31b-88fb-4c50-94d0-1759a6e2b604`, `accepted: true`,
  `status: submitted`.
- Managed AI auth-prime was ready on the sampled sends:
  `submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime:result`
  had `ready: true`.
- Late `orchestrator:proxy-upstream:error` rows were long-lived
  `GET /opencode/event` streams closed by the socket after successful sends.
  They are not submit-path failures and are now classified separately by
  `scripts/send-trace-summary.mjs` as `orchestrator-proxy`.

This is still not marked as `fresh_runtime_send_done` because the runtime was
not re-run after the 2026-07-08 diagnostic-only trace parser/classifier update.
The evidence does, however, show the current send path shape that the plan
needed to audit.

## Remaining Risks

### Risk 1: Configured sync failure still reports a UI error

The materialization gate intentionally lets runtime continue when configured
sync fails with auth/route style errors after an observed pending status. That
matches the product goal of keeping the app usable, but it can still surface a
workspace error even though sending may continue.

KISS next step: leave behavior non-blocking, but ensure the UI error is clearly
classified as skill-registry degraded, not generic send failure.

### Risk 2: Registry status lookup can still add latency

The app now calls workspace materialization status before sync. If the registry
is slow, send/runtime attach can wait up to the existing server/client timeout.

KISS next step: keep existing timeout behavior unless live traces show this is a
real send delay. Do not add another retry layer yet.

### Risk 3: Managed AI auth-prime can fail before server submit

Existing-session send can fail at
`submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime` before the
request reaches `/workspace/:id/conversations/submit`.

Status: implemented at source classifier level on 2026-07-08.
Runtime close-out remains open.

### Risk 4: Old conversations can still fail for non-shared reasons

Existing conversations share the server submit foundation, but they can fail in
layers that a brand-new chat does not hit:

- missing or wrong directory for the historical session,
- unimportable raw OpenCode session id,
- stale active lifecycle row,
- active run queue conflict,
- transcript/session scope mismatch in the UI.

KISS next step: when an older conversation fails, classify the failed layer
first before applying a generic send fix.

### Risk 5: Tauri Pilot was intentionally skipped

The source-level tests and runtime trace evidence are strong, but no Pilot UI
smoke was run in this self-review path.

KISS next step: do not block this fix line on Pilot. Add Pilot only when it is
fast enough or when the next bug is explicitly visual/UI-only.

## KISS Follow-Up Plan

1. Keep the current fixes scoped.
   Do not merge skill registry, legacy session import, stale queue cleanup, and
   AI gateway attribution into one larger abstraction.

2. Add one small runtime evidence parser if failures recur. Done 2026-07-08.
   It should summarize send traces by phase:
   `managed-ai-auth-prime`, `runtime-preflight`, `server-submit-first`,
   `server-submit-existing`, `session-create`, `run-submit`, `queue-drain`,
   `ai-gateway`, `transcript`, `skill-materialization`, and
   `orchestrator-proxy`.

3. Add one older-conversation regression test only if a fresh failure appears.
   Preferred test shape: seed a legacy OpenCode DB row, no binding, explicit
   workspace directory, submit follow-up, assert binding creation and upstream
   prompt submit without `messageID`.

4. Add one stale-run regression only for the exact observed live condition.
   Preferred shape: active run with `stale: true` or large
   `noProgressSeconds`, queued follow-up, assert `markFailed` then queue wake.

5. Keep `clientMessageId` as Veslo idempotency only.
   Any future OpenCode prompt id should be explicit and contract-owned. Do not
   reuse random client ids as upstream prompt ids by accident.

## Done Criteria

Current status against done criteria:

- source tests: done
- runtime trace audit: done
- latest manual `pnpm dev` trace review: done
- fresh runtime send close-out: not done
- Tauri Pilot close-out: not done

This plan is done only when:

- a fresh dev runtime send into a new chat succeeds,
- a fresh dev runtime send into an existing bound conversation succeeds,
- an imported legacy OpenCode conversation can receive a follow-up,
- stale active runs do not keep queued work blocked indefinitely,
- traces show the failed layer when any of the above fails,
- no fresh OpenCode submit body includes random `messageID` for normal prompt or
  command sends.
