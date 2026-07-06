---
title: Server-Owned Composer Send Workflow Implementation Plan
date: 2026-07-06
status: planned
done: false
issue: unlinked
source_audit: chat:2026-07-06-frontend-send-workflow-deep-audit
base_branch: local/sandbox-merge
bsw00_baseline_contract_done: false
bsw01_shared_submit_contract_done: true
bsw01a_submit_attempt_dedupe_store_done: true
bsw02_server_submit_route_shell_done: true
bsw03_server_session_materialization_done: false
bsw04_server_draft_resolution_done: false
bsw05_server_runtime_admission_done: false
bsw05a_remote_workspace_contract_done: false
bsw06_server_attachment_policy_and_parts_done: false
bsw07_server_compact_done: false
bsw07b_server_replacement_followup_done: false
bsw08_server_active_run_queue_admission_done: false
bsw08a_server_queue_ui_api_migration_done: false
bsw09_frontend_thin_submit_done: false
bsw10_delete_legacy_frontend_logic_done: false
bsw11_regression_gate_done: false
---

# Server-Owned Composer Send Workflow Implementation Plan

## Goal

Move the non-UI send workflow behind one server-owned command so the frontend
input field and send buttons do not decide how a conversation run is prepared,
created, queued, retried, compacted, or submitted.

The target app-side rule is:

- `Composer` builds a draft from the editor and calls one frontend function.
- The session page converts the button/keyboard intent into a submit command.
- A single app service calls the Veslo server.
- The Veslo server owns conversation materialization, draft resolution, runtime
  admission, run construction, durable queue admission, and typed submit results.
- The frontend only applies the returned result to UI state.

The target server-side rule is:

- One server command answers: "Given this draft, target, and intent, what
  happened?"
- The answer is typed enough for the frontend to clear, restore, show pending,
  show queued, show blocked, or show failed state without re-running submit
  logic locally.

## Why This Plan Exists

The current input send path is too frontend-heavy:

```text
Composer.sendDraft()
  -> Session.handleSendPrompt()
  -> SessionConversationFlow.handleSendPrompt()
  -> SessionConversationFlow.sendPromptImmediate()
  -> props.sendPromptAsync()
  -> sessionSendWorkflow.sendPrompt()
  -> runConversationFromVesloWriteApi()
  -> serverClient.runConversation()
```

The low-level server run call is centralized, but the meaningful workflow is
not. The app currently owns or participates in:

- clearing the composer before the send promise resolves,
- deciding queue versus send-now versus replacement,
- optimistic pending handoff and pending-session materialization,
- selected-session and workspace send-target correction,
- skill command resolution,
- document runtime skill blocking,
- runtime preflight and local recovery retry,
- attachment staging and model routing,
- `/compact` branching,
- command message display bookkeeping,
- pending draft cleanup,
- error rendering into the visible conversation.

Some UI state must remain in the frontend, but the server-facing workflow should
not depend on component state, route state, or ad-hoc frontend recovery logic.

## KISS Boundary

Do:

- add one server-side submit command on top of the existing conversation service
  and run lifecycle controller,
- reuse `conversationService.createConversation`,
  `conversationRunLifecycleController.submitRun`, the conversation binding
  store, and the existing durable run queue,
- make `clientMessageId` the required submit-attempt key and back it with a
  server store before any conversation materialization,
- return typed results instead of booleans,
- preserve current UX before deleting behavior,
- keep `Composer` responsible only for editor state, keyboard/button intent,
  local history, and focus,
- keep the frontend responsible for visual optimistic rows until the server
  exposes enough queue/pending state to replace them,
- migrate in small reversible slices.

Do not:

- build a second lifecycle system,
- replace the orchestrator run registry or queue store,
- move DOM/editor/IME/history logic to the server,
- move visual scrolling, focus, or toast rendering to the server,
- add a broad frontend state machine before the server contract exists,
- make the server depend on Solid/App component state,
- invent a new attachment storage system if existing file-session writes can be
  reused,
- combine this with unrelated app modularization or server access work.

## Core Gate Versus Follow-Ups

This plan has a core completion gate and explicit follow-ups. The core gate is
the smallest robust server-owned input submit migration:

- BSW00 through BSW05A,
- BSW06A: server-owned submit-time attachment policy and OpenCode part
  construction from existing staged references or bounded inline payloads,
- BSW07A: server-owned `/compact` handling,
- BSW08: active-run conflict admission through the existing server durable run
  queue,
- BSW09 through BSW11.

The following are follow-ups and must not block the core gate unless a later
implementation decision explicitly promotes them:

- BSW06B: full server-side raw attachment byte staging beyond existing
  file-session behavior,
- BSW07B: edit-message replacement as a server-owned compensating workflow,
- BSW08A: durable server APIs for the full app-local draft queue UI
  semantics.

Top-level `done` means the core gate is complete. Follow-up flags may remain
`false` after the core gate if their current app-side behavior is preserved,
tested, and documented as a compatibility path.

## Current Code Anchors

Frontend send entry points:

- `packages/app/src/app/components/session/composer.tsx`
- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/session-conversation-flow.ts`
- `packages/app/src/app/pages/session-send-workflow.ts`
- `packages/app/src/app/pages/session-mutation-workflow.ts`

Current low-level app/server bridge:

- `packages/app/src/app/context/conversation-service.ts`
- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`
- `packages/app/src/app/lib/veslo-server/types.ts`

Server conversation runtime:

- `packages/server/src/routes/conversations.ts`
- `packages/server/src/conversation-service.ts`
- `packages/server/src/conversation-run-lifecycle-controller.ts`
- `packages/server/src/conversation-run-queue-store.ts`
- `packages/server/src/conversation-binding-store.ts`
- `packages/server/src/conversation-transcript-store.ts`

Existing tests to keep green while migrating:

- `packages/app/src/app/tests/components/session/composer-send-intent.test.ts`
- `packages/app/src/app/tests/pages/session-conversation-flow.test.ts`
- `packages/app/src/app/tests/pages/session-send-workflow.test.ts`
- `packages/app/src/app/tests/context/conversation-service.test.ts`
- `packages/server/src/tests/server-conversations.test.ts`
- `packages/server/src/tests/conversation-run-lifecycle-controller.test.ts`
- `packages/server/src/tests/conversation-run-queue-store.test.ts`

## Hard Contract Clarifications

These clarifications are part of the implementation contract. They prevent this
plan from being implemented as a vague "move logic to backend" rewrite.

### Idempotence

`clientMessageId` by itself is not sufficient unless the server persists the
submit attempt before side effects.

The server submit service must create a submit-attempt record before calling
`conversationService.createConversation`, staging attachments, reverting a
message, compacting, or submitting a run.

Minimum store contract:

```ts
type ConversationSubmitAttempt = {
  workspaceId: string;
  clientMessageId: string;
  requestHash: string;
  status:
    | "started"
    | "materialized"
    | "completed"
    | "blocked"
    | "failed";
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  runId?: string | null;
  queueItemId?: string | null;
  resultJson?: string | null;
  createdAt: number;
  updatedAt: number;
};
```

Required behavior:

- Key is at least `(workspaceId, clientMessageId)`.
- Repeating the same normalized request returns the stored terminal result or
  resumes from the stored materialized conversation.
- Reusing the same `clientMessageId` with a different normalized request hash
  returns `409 idempotency_conflict`.
- First send with no existing conversation must not create a second conversation
  on retry.
- Existing lifecycle/queue dedupe remains useful, but it is not the first-send
  idempotency boundary.
- The submit-attempt store is not a lifecycle store. It does not drain runs,
  poll terminal run state, or decide active-run ownership. It only protects
  submit side effects and stores the typed submit command result.
- After the submit service reaches `conversationRunLifecycleController`, the
  lifecycle controller and durable run queue remain the source of truth for run
  admission and queue state.

### Remote Workspaces

Current remote-workspace behavior must stay explicit. Local lifecycle ownership
and local durable queue admission are for local workspaces only.

Initial KISS rule:

- For `workspace.workspaceType === "remote"`, the local server submit route must
  not write local lifecycle rows and must not enqueue into the local
  `conversation_run_queue`.
- First implementation should return `blocked` with
  `code: "remote_submit_unavailable"` and `draftDisposition: "restore"`.
- Delegation to a remote Veslo server is a follow-up only if that remote server
  already exposes the same submit contract and tests cover both sides.
- While the rollout flag is not fully `on`, the app may fall back to the current
  remote path, but the fallback must be explicit and tested.

### Queue Scope

There are two queues today:

- server durable run queue for active-run conflicts,
- app-local draft queue with edit/cancel/move/pause UI state.

This plan must not pretend they are the same queue. BSW08 moves active-run
conflict admission to the server. BSW08A is the separate UI queue API migration
and is not part of the core gate.

### Replacement Scope

Replacement is not an ACID transaction over OpenCode. It is a server-owned
compensating workflow. The server owns the sequence and restore contract, but
the plan must not promise database transaction semantics across abort, revert,
submit, and restore.

### Draft And Attachment Sources Of Truth

Submit-time authority moves to the server; UI assistance stays in the frontend.

- Command autocomplete and slash popups remain advisory UI.
- The server resolves the final command/skill at submit time using server-owned
  command and skill resolver sources.
- The server checks document runtime readiness from server-owned runtime status.
- The app sends serialized draft parts and already staged file references or
  bounded inline attachment payloads; the server owns submit-time conversion to
  OpenCode parts and staged file paths.
- The app must not be trusted as the authority for model attachment support.
  The server must verify model capability from server-visible provider/model
  metadata or return `model_capabilities_unavailable`.

## Target Contract

Add a server-owned command, naming to be finalized during BSW01:

```text
POST /workspace/:id/conversations/submit
```

The command accepts a serialized composer draft and explicit submit intent:

```ts
type ConversationSubmitRequest = {
  clientMessageId: string;
  origin: string;
  source?: "button" | "enter" | "ctrl-enter" | string | null;
  target?: {
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    directory?: string | null;
    pendingClientSessionId?: string | null;
  };
  draft: {
    mode: "prompt" | "shell";
    text: string;
    resolvedText?: string | null;
    parts: Array<unknown>;
    command?: { name: string; arguments: string } | null;
    attachments?: Array<{
      name: string;
      kind: string;
      mimeType: string;
      dataUrl?: string;
      contentBase64?: string;
      fileSessionPath?: string;
    }>;
  };
  options?: {
    sendNow?: boolean;
    replaceMessageId?: string | null;
    submitQueuePolicy?: "normal" | "send-now" | "server-queue-only";
    model?: unknown;
    agent?: string | null;
    variant?: string | null;
    expectAiGatewayStart?: boolean;
    /**
     * Temporary BSW02 validation-shell option. Keep it in the request hash so
     * a dry-run attempt cannot be replayed as a later real submit result.
     */
    dryRun?: boolean;
  };
};
```

The command returns a typed result, not `boolean`:

```ts
type ConversationSubmitResult =
  | {
      status: "submitted";
      workspaceId: string;
      conversationId: string;
      opencodeSessionId: string;
      runId: string;
      clientMessageId: string;
      materializedSession?: SidebarSessionPayload | null;
      draftDisposition: "clear";
    }
  | {
      status: "queued";
      workspaceId: string;
      conversationId: string;
      opencodeSessionId: string;
      queueItemId: string;
      reservedRunId: string;
      queuePosition: number;
      clientMessageId: string;
      materializedSession?: SidebarSessionPayload | null;
      draftDisposition: "clear";
    }
  | {
      status: "blocked";
      code: string;
      message: string;
      draftDisposition: "restore" | "keep";
      recoverable: boolean;
    }
  | {
      status: "failed";
      code: string;
      message: string;
      draftDisposition: "restore" | "mark-failed";
      debugTrace?: unknown[];
    };
```

The exact shape can change during implementation, but the invariants cannot:

- `clientMessageId` is required.
- The server persists the submit attempt before any create/revert/run side
  effect.
- Success and queued results identify the server conversation and engine session.
- The response tells the frontend what to do with the draft.
- The response carries a stable code for blocked/failed states.
- The frontend never infers server acceptance from a boolean.

## Rollout Strategy

This must be implemented as a compatibility migration, not a flag day rewrite.

For most of the plan, keep the current frontend path as a fallback behind a
temporary feature flag or internal switch:

```text
serverOwnedComposerSubmit: "off" | "shadow" | "on"
```

The expected rollout is:

1. `off`: current behavior only.
2. `shadow`: server submit command validates and returns a dry-run plan, but the
   app still uses the current path.
3. `on`: app uses server submit for normal sends.
4. Remove the old app workflow only after targeted app/server tests and one
   installed-runtime smoke pass.

## BSW00 - Baseline Contract And Behavior Freeze

Status: `done: false`

Capture the current behavior before moving ownership.

Implementation notes:

- Add a short source-map test or doc section listing every send path:
  normal prompt, shell, command, `/compact`, send-now, queue-drain, retry, and
  replace-user-message.
- Add or update tests that pin the current `Composer -> onSend` handoff:
  `source`, `sendTraceId`, `sendNow`, and draft clear behavior.
- Add a failing-contract note for the current known flaw:
  `Composer` clears before the parent promise resolves.
- Verify direct app callers of `runConversationFromVesloWriteApi` and document
  which ones are allowed after the migration.

Acceptance:

- A maintainer can tell which behavior is intentionally preserved and which is
  intentionally targeted for deletion.
- No runtime code behavior changes in this task.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/composer-send-intent.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-send-workflow.test.ts src/app/tests/context/conversation-service.test.ts
git diff --check
```

## BSW01 - Shared Submit Contract

Status: `done: true`

Implementation note 2026-07-06:

- Added server submit request/result contract and request hash helpers in
  `packages/server/src/conversation-submit-contract.ts`.
- Added matching app client request/result types in
  `packages/app/src/app/lib/veslo-server/types.ts`.
- Added app client facade methods `conversations.submit` and
  `submitConversation`.
- Verified with server/app typechecks and app client tests.

Create a shared app/server submit contract without changing runtime behavior.

Implementation notes:

- Add shared request/result types near the existing Veslo server conversation
  types.
- Require `clientMessageId`.
- Preserve `origin` and forward `source`; do not drop button/enter attribution.
- Include `draftDisposition`.
- Include materialized conversation/session fields so the frontend does not
  infer created session ids from selected UI state.
- Include stable error codes for:
  `empty_draft`, `runtime_not_ready`, `workspace_unavailable`,
  `document_runtime_blocked`, `attachment_rejected`,
  `conversation_create_failed`, `run_rejected`, `run_submit_failed`,
  `idempotency_conflict`, `remote_submit_unavailable`,
  `model_capabilities_unavailable`.
- Define a normalized request hash for idempotency. It must exclude volatile
  trace-only fields and include submit target, draft content, command, options,
  and attachment identity/content hashes.
- Keep the result shape broad enough for follow-up workflows, but do not force
  replacement or full queue UI semantics into the first implementation slice.

Acceptance:

- The contract can represent every existing current result:
  submitted, queued, blocked, failed, compact success, and replacement failure
  when the replacement follow-up is enabled.
- The contract is app-independent: it does not mention Solid signals,
  localStorage, route state, or component names.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
git diff --check
```

## BSW01A - Submit Attempt Dedupe Store

Status: `done: true`

Implementation note 2026-07-06:

- Added `packages/server/src/conversation-submit-attempt-store.ts`.
- Store is keyed by `(workspaceId, clientMessageId)`, records `requestHash`,
  result pointers and `resultJson`, and reports idempotency conflicts without
  tracking terminal run lifecycle.
- Added focused store tests for idempotent claim, hash conflict, result pointer
  storage, and DB path resolution.

Add a server-side submit-attempt store before enabling materialization or run
submission through the new route.

Implementation notes:

- Add a small persistent store, for example
  `packages/server/src/conversation-submit-attempt-store.ts`.
- Store at least `(workspaceId, clientMessageId, requestHash, status,
  conversationId, opencodeSessionId, runId, queueItemId, resultJson,
  createdAt, updatedAt)`.
- Insert or claim the attempt before `createConversation`, attachment staging,
  revert, compact, or run submit.
- If the same `(workspaceId, clientMessageId)` appears with the same
  `requestHash`, return the stored terminal result or resume using the stored
  materialized conversation.
- If the request hash differs, return `409 idempotency_conflict`.
- Store `runId` and `queueItemId` only as result pointers. Do not use this store
  to track terminal run lifecycle.
- Keep retention simple: old completed/blocked/failed attempts can be pruned by
  age; do not add a second lifecycle database.

Acceptance:

- Retrying the first send for an empty pending conversation does not create a
  second conversation.
- Retrying a submitted or queued request returns the original submitted/queued
  result.
- Reusing a `clientMessageId` with different draft content is rejected.

Verification:

```powershell
bun test packages/server/src/tests/server-conversations.test.ts packages/server/src/tests/conversation-binding-store.test.ts
pnpm --filter veslo-server typecheck
git diff --check
```

## BSW02 - Server Submit Route Shell

Status: `done: true`

Implementation note 2026-07-06:

- Added `packages/server/src/conversation-submit-service.ts` and exact route
  `POST /workspace/:id/conversations/submit`.
- The route currently performs dry-run validation only: it parses the request,
  claims the submit attempt, resolves directory for local workspaces, returns a
  typed `dry_run` result, blocks remote workspaces with
  `remote_submit_unavailable`, and does not contact OpenCode.
- Added route tests for dry-run, idempotency conflict, and remote blocked
  behavior.
- `options.dryRun` is included in the normalized request hash so the BSW02
  validation shell cannot poison the future real-submit idempotency record for
  the same `clientMessageId`.

Add the server route and app client method, initially as a dry-run shell.

Implementation notes:

- Add a route under `packages/server/src/routes/conversations.ts` or a small
  route adapter if the file is already too broad.
- Add a focused service module such as
  `packages/server/src/conversation-submit-service.ts`.
- Add a client method under
  `packages/app/src/app/lib/veslo-server-domains/conversations.ts`.
- In dry-run mode, parse and validate the request, resolve workspace, resolve
  target directory, and return a typed `blocked` or `dry_run` result without
  creating a run.
- Wire the route to the submit-attempt store in validation mode so hash
  conflicts are caught before side effects exist.
- Add route registration tests.

Acceptance:

- The app can call one server submit endpoint in tests.
- The server validates malformed requests with stable error codes.
- No existing send path changes yet.

Verification:

```powershell
bun test packages/server/src/tests/server.conversation-session-routes.test.ts packages/server/src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/lib/veslo-server-session-prefetch.test.ts
git diff --check
```

## BSW03 - Server Session Materialization

Status: `done: false`

Move no-session create-and-run materialization to the server submit service.

Implementation notes:

- When no real conversation target is provided, the submit service claims a
  submit-attempt record and then calls `conversationService.createConversation`.
- The server returns the materialized `conversationId`, `opencodeSessionId`,
  sidebar payload, and `pendingClientSessionId` echo.
- The frontend stops relying on selected-session state to infer the
  materialized session after submit.
- Keep current pending sidebar visual behavior, but drive materialization from
  the server response.
- Keep `createSessionAndOpen` for explicit New Session flows; remove it from
  normal prompt submit once this task is complete.
- Persist the materialized `conversationId` and `opencodeSessionId` into the
  submit-attempt record before any run submit.

Current implementation checkpoint:

- The server submit route has a single `submit` service entrypoint. `options.dryRun`
  remains a request mode, not a separate HTTP/service workflow.
- No-target local submits now materialize a conversation through
  `conversationService.createConversation`, persist the materialized pointers in
  the submit-attempt row, and return `status: "materialized"`.
- Frontend pending-session handoff still needs to consume the materialized
  submit result before this task can be marked done.

Acceptance:

- First prompt in an empty pending session can be submitted through the server
  command.
- A failed create returns `blocked` or `failed` with `draftDisposition:
  "restore"`.
- App-side pending handoff code no longer needs to guess the materialized
  session id from `selectedSessionId`.
- Retrying the same first submit reuses the already materialized conversation.

Verification:

```powershell
bun test packages/server/src/tests/server-conversations.test.ts packages/server/src/tests/conversation-binding-store.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/app-send-prompt-session-creation.test.ts
git diff --check
```

## BSW04 - Server Draft Resolution

Status: `done: false`

Move prompt mode, shell mode, slash command, skill command, and document runtime
blocking out of the frontend send workflow.

Implementation notes:

- Move or duplicate only pure parsing helpers first; do not move UI popup logic.
- Server resolves:
  - empty draft rejection,
  - `mode: "shell"` to shell run input,
  - explicit slash command to command run input,
  - implicit skill command resolution,
  - document runtime skill readiness blocking.
- Server sources of truth:
  - `packages/server/src/commands.ts` for command listing/resolution inputs,
  - server skill resolver/materialization state for implicit skill commands,
  - server document-runtime status for document skill blocking.
- The app can still show command autocomplete, but autocomplete is advisory.
  The server is authoritative at submit time.
- Remove `maybeResolveSkillCommand` from the active app submit path after server
  tests cover it.

Acceptance:

- A command typed into the input produces the same run kind as before.
- A document skill blocked by runtime readiness returns
  `status: "blocked"` with `code: "document_runtime_blocked"`.
- The frontend no longer calls command listing or skill resolution during
  submit.

Verification:

```powershell
bun test packages/server/src/tests/server-conversations.test.ts packages/server/src/tests/skill-resolver.test.ts packages/server/src/tests/resource-owner.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/app-send-latency-trace.test.ts
git diff --check
```

## BSW05 - Server Runtime Admission And Recovery Boundary

Status: `done: false`

Move runtime readiness admission and retry decision behind the server command.

Implementation notes:

- The app may still ensure a Veslo server exists before calling the server.
  After that, runtime-chain admission belongs to the server command.
- Server submit checks the workspace runtime chain before admitting the run.
- If the runtime is not ready, return typed `blocked` with a reason code rather
  than relying on app-side busy/retry heuristics.
- Preserve exactly one bounded retry for the current local-runtime stale route
  class if that behavior is still required, keyed by `clientMessageId`.
- Do not broaden recovery to remote/cloud paths.
- Do not enqueue local durable runs or run local lifecycle recovery for remote
  workspaces.

Acceptance:

- The app submit path no longer calls `prepareSendRuntimeForSend`.
- Runtime failures are reported as server result codes.
- The retry remains idempotent and local-runtime-only.
- Tests prove remote workspace submit does not enter local lifecycle/queue
  paths.

Verification:

```powershell
bun test packages/server/src/tests/server-conversations.test.ts packages/server/src/tests/server-stale-active-run.integration.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-stale-local-runtime-recovery.test.ts src/app/tests/app-send-preflight-context.test.ts
git diff --check
```

## BSW05A - Remote Workspace Submit Contract

Status: `done: false`

Make remote workspace behavior explicit before enabling server-owned submit by
default.

Implementation notes:

- Preserve the existing invariant that local lifecycle controller and local
  durable run queue do not own remote workspaces.
- Add server tests for `workspaceType === "remote"` submit.
- Initial behavior should return `blocked` with
  `code: "remote_submit_unavailable"` and let the app use an explicit
  compatibility fallback while the rollout flag is not `on`.
- Delegation to a remote Veslo server is allowed only as a later enhancement
  when that server already exposes the same submit endpoint and both local and
  remote contracts are tested.
- Do not silently route remote submits through local recovery or local queue.

Acceptance:

- Remote submit behavior is documented in the route/service tests.
- Local-only retry/recovery cannot trigger for remote workspace failures.
- The frontend can distinguish remote unsupported from local runtime failure.

Verification:

```powershell
bun test packages/server/src/tests/server-conversations.test.ts packages/server/src/tests/conversation-run-lifecycle-controller.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts
git diff --check
```

## BSW06 - Server Attachment Policy And Run Parts

Status: `done: false`

Move submit-time attachment policy, model capability routing, and run part
construction behind the server command.

Implementation notes:

- Reuse existing file-session write behavior where possible.
- Keep attachment body limits explicit and aligned with the existing composer
  limits.
- BSW06A core: the app sends serialized draft parts plus existing file-session
  paths, staged file references, or bounded inline payloads. The server owns
  final submit-time validation and OpenCode part construction.
- BSW06B follow-up: if raw byte staging still needs to move, do it through the
  existing file-session behavior or a narrow extension of it. Do not invent a
  new attachment storage system in this plan.
- Server owns in BSW06A:
  - collision-safe attachment paths,
  - image capability rejection,
  - path injection into prompt/command arguments,
  - final OpenCode `parts` construction.
- Server resolves model attachment support from server-visible provider/model
  metadata. If the metadata is unavailable, return `blocked` with
  `code: "model_capabilities_unavailable"` instead of trusting the frontend.
- File mentions remain serialized as draft parts; submit-time path resolution is
  server-owned and scoped to the target workspace directory.
- Keep editor-visible mentions and file chips in the frontend; only submit-time
  conversion moves.

Acceptance:

- The app submit path no longer calls
  `routeStagedAttachmentsForModel`, `buildPromptParts`, or
  `buildCommandFileParts`.
- `stageAttachmentsIntoSessionDirectory` is either removed from the submit path
  or retained only as a bounded compatibility adapter that produces refs for
  the server submit request.
- Non-vision image rejection returns `status: "blocked"` and
  `code: "attachment_rejected"`.
- Existing screenshot/doc attachment tests pass or are replaced by server
  contract tests with equivalent coverage.

Verification:

```powershell
bun test packages/server/src/tests/server-conversations.test.ts packages/server/src/tests/server.file-sessions-routes.test.ts packages/server/src/tests/file-sessions.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-attachment-staging.test.ts src/app/tests/lib/attachment-prompt-routing.test.ts
git diff --check
```

## BSW07 - Server Compact, Replacement Follow-Up

Status: `done: false`

Move `/compact` behind the server-owned submit workflow. Keep edit-message
replacement as an explicit follow-up unless it is promoted after the normal
submit path is stable.

Implementation notes:

- `/compact` should be parsed by the server submit service and translated into
  the existing `kind: "summarize"` run.
- BSW07A core is complete when input `/compact` and explicit compact actions no
  longer branch through app-side run submit logic.
- BSW07B follow-up: replace-message submit should be a server-owned
  compensating workflow:
  abort active run if needed, revert to the target message, submit the new
  draft, and restore the revert state on failure.
- The BSW07B server response must distinguish:
  - replacement submitted,
  - replacement blocked before revert,
  - replacement submit failed and restore succeeded,
  - replacement submit failed and restore failed.
- Keep explicit dashboard/session "compact" actions as thin calls to the same
  server contract or to a small server compact endpoint that shares the same
  implementation.

Acceptance:

- The app input submit path no longer branches locally on `/compact`.
- `session-mutation-workflow` no longer calls `runConversationFromVesloWriteApi`
  directly for summarize.
- Replacement can remain on the current app-side compatibility path after core
  completion, but only with a tracked BSW07B follow-up and tests proving the
  compatibility path still works.
- When BSW07B is implemented, replacement failure restores the prior state
  without app-side revert choreography.
- The plan and tests do not call replacement an ACID transaction.

Verification:

```powershell
bun test packages/server/src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/pages/session-message-replacement.test.ts
git diff --check
```

## BSW08 - Server Active-Run Queue Admission

Status: `done: false`

Move active-run conflict admission to the existing server durable run queue.

Implementation notes:

- Preserve the current local queue UI in this task.
- When the server submit command detects an active local run and the request is
  a normal queued send, it should return the existing server lifecycle
  controller's `status: "queued"` result.
- `sendNow` must have an explicit server rule:
  - either reject while another run is active with `blocked`,
  - or enqueue with priority if the queue store supports priority,
  - or preserve the current product behavior through a documented fallback.
- Do not claim edit/cancel/move/pause queue UI is migrated in this task.
- Remote workspaces must not enter the local durable run queue.

Acceptance:

- Plain Enter during a running conversation results in a server queued run, not
  only a frontend-only queued draft, for local workspaces under the rollout flag.
- The typed result includes `queueItemId`, `reservedRunId`, `queuePosition`, and
  `draftDisposition`.
- Send-now active-run behavior is explicitly tested.
- Remote active-run submit does not enqueue locally.

Verification:

```powershell
bun test packages/server/src/tests/conversation-run-queue-store.test.ts packages/server/src/tests/conversation-run-lifecycle-controller.test.ts packages/server/src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts
git diff --check
```

## BSW08A - Server Queue UI API Migration Follow-Up

Status: `done: false`

Migrate the app-local draft queue UI to server queue APIs. This is not part of
the core gate.

Implementation notes:

- Start this only after BSW08 proves the server durable run queue can own
  active-run conflict admission without regressing the existing UI queue.
- Add only the queue APIs required by existing UI:
  - list queued runs for a conversation,
  - cancel queued run,
  - update queued draft,
  - move queued run,
  - pause/resume drain if pause remains a product requirement.
- Extend `conversation-run-queue-store.ts` deliberately; do not introduce a
  second queue store.
- Decide whether queued draft editing is still allowed after the draft becomes
  a server run body. If yes, update must rewrite the queued run body and request
  hash according to the submit-attempt contract.
- The frontend may keep transient optimistic rows but must refresh queue truth
  from the server.
- Until BSW08A is done, the app-local draft queue may remain the UI source of
  truth for edit/cancel/move/pause semantics.

Acceptance:

- This task is explicitly allowed to remain `done: false` when the core gate is
  complete.
- Existing queued-message list can be populated from server state.
- Cancel/edit/move actions persist across app reload.
- Queue pause/resume behavior is either implemented on the server or removed
  from product scope with a documented decision.
- Local app memory is not the durable queue source.

Verification:

```powershell
bun test packages/server/src/tests/conversation-run-queue-store.test.ts packages/server/src/tests/conversation-run-lifecycle-controller.test.ts packages/server/src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-message-queue.test.ts
git diff --check
```

## BSW09 - Frontend Thin Submit Function

Status: `done: false`

Collapse frontend send into one function and make components result-driven.

Implementation notes:

- Introduce one app-side function, for example:

  ```ts
  submitComposerDraft(draft, intent): Promise<ConversationSubmitResult>
  ```

- `Composer` calls `onSend` and awaits the typed result before clearing.
- `Session.handleSendPrompt` forwards all intent fields, including `source`.
- `SessionConversationFlow` stops deciding server workflow. It may only:
  - build UI intent,
  - render optimistic pending state,
  - apply typed server result,
  - update visible queue state from server data after BSW08A.
- Replace `Promise<boolean>` with a typed result at the component boundary.

Acceptance:

- There is exactly one frontend function that starts submit from the input.
- `Composer` does not clear the draft until the result says `draftDisposition:
  "clear"`.
- The app does not infer server success from `true`.
- Button, Enter, and Ctrl/Meta+Enter all use the same submit function.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/composer-send-intent.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/components/session/pending-submit-model.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

## BSW10 - Delete Legacy Frontend Submit Logic

Status: `done: false`

Remove app-side submit logic that is now server-owned.

Implementation notes:

- Delete or shrink `session-send-workflow.ts` until it is only a thin adapter,
  or replace it with a better named app submit client.
- Remove dependencies from the submit path:
  `prepareSendRuntimeForSend`, `maybeResolveSkillCommand`,
  `stageAttachmentsIntoSessionDirectory`, `routeStagedAttachmentsForModel`,
  `buildPromptParts`, `buildCommandFileParts`, `compactCurrentSession`,
  direct `setView`, direct `setSelectedSessionId`, and direct
  `setPrompt` submit side effects.
- Keep non-submit callers of these helpers only if they have a separate product
  reason.
- Update source tests that currently preserve legacy structure.

Acceptance:

- The input/send path has no direct calls to `runConversationFromVesloWriteApi`.
- App-side direct calls to `runConversationFromVesloWriteApi` are limited to
  allowed non-input surfaces or removed.
- The app submit adapter dependency list is small and UI-focused.

Verification:

```powershell
rg -n "runConversationFromVesloWriteApi|prepareSendRuntimeForSend|maybeResolveSkillCommand|stageAttachmentsIntoSessionDirectory|routeStagedAttachmentsForModel|buildPromptParts|buildCommandFileParts|compactCurrentSession" packages/app/src/app/pages packages/app/src/app/context packages/app/src/app/app.tsx
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/**/*.test.ts
git diff --check
```

## BSW11 - Final Regression Gate

Status: `done: false`

Run the end-to-end validation bundle and update docs.

Implementation notes:

- Update docs that describe the send workflow and app/server boundary.
- Add a concise dev doc showing the new submit state diagram:
  `Composer -> submitComposerDraft -> Veslo server submit -> lifecycle`.
- Include a before/after dependency count for the app submit adapter.
- Verify dirty worktree state carefully because this area often overlaps with
  server access and runtime-chain work.

Required validation:

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/**/*.test.ts
pnpm --filter veslo-server typecheck
bun test packages/server/src/tests/server-conversations.test.ts packages/server/src/tests/conversation-run-lifecycle-controller.test.ts packages/server/src/tests/conversation-run-queue-store.test.ts packages/server/src/tests/conversation-service.test.ts
git diff --check
```

Optional installed-runtime smoke, if the local environment is healthy:

```powershell
pnpm test:e2e:ui:smoke
```

Acceptance:

- Top-level `done` remains `false` until the core gate is complete:
  BSW00 through BSW11, including BSW01A and BSW05A, but excluding explicit
  follow-ups BSW06B, BSW07B, and BSW08A unless they were promoted before
  implementation.
- Any follow-up left incomplete has an implementation note explaining the
  retained compatibility path and the test coverage that protects it.
- If E2E is skipped, record why and rely on the codebase gate only for that
  rollout.
- No task is marked done without tests and an implementation note.

## Expected End State

After the core gate is complete:

- `Composer` is a UI input component, not a submit lifecycle owner.
- There is one frontend submit entry point for button/Enter/Ctrl-Enter.
- The app calls one Veslo server submit command for input sends.
- The server owns draft-to-run conversion, session creation, runtime admission,
  command resolution, submit-time attachment policy and part construction,
  compact, and durable local queue admission.
- The frontend applies typed results and renders UI state.
- There is no boolean send result masking server states.
- The server conversation lifecycle controller remains the only run lifecycle
  owner.
- Edit-message replacement and full queue UI persistence are either implemented
  follow-ups or documented compatibility paths, not hidden requirements of the
  core migration.
