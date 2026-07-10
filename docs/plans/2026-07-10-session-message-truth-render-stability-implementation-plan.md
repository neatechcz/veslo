---
title: Session Message Truth And Render Stability Implementation Plan
date: 2026-07-10
status: ready-for-implementation
done: false
repository_snapshot: veslo-main main 7e0819a7 plus active queue and fix-46 working tree
depends_on:
  - docs/plans/2026-07-10-session-queue-final-implementation-plan.md
smt01_durable_lifecycle_error_contract_done: true
smt02_sse_lifecycle_arbitration_done: true
smt03_scoped_run_presentation_done: true
smt04_optimistic_transcript_adoption_done: true
smt05_render_geometry_gate_done: false
smt06_desktop_transition_gate_done: false
---

# Session Message Truth And Render Stability Implementation Plan

## Canonical Status

done: false

This is the implementation plan for the remaining session-message and rendered
UI stabilization gaps found after the queue deep audit and the narrow Fix 46
changes.

Implement this plan only after every QF phase in
`docs/plans/2026-07-10-session-queue-final-implementation-plan.md` is complete.
At the final plan review, QF01 through QF07 were complete and QF08 remained
`done: false`. The queue plan owns queue projection, queue controls, and its
desktop queue scenario; this plan must consume that finished contract, not
redesign it.

Every SMT phase starts at `done: false`. The top-level `done: false` changes to
`done: true` only after SMT01 through SMT06 are all `done: true`, the completion
log contains exact verification evidence, and the real desktop transition gate
passes against rebuilt sidecars.

## Goal

Make the selected conversation surface tell one predictable truth about:

- whether an admitted run is still active or terminal,
- why a durable run failed,
- whether a displayed user message is optimistic or canonical,
- whether the canonical transcript has safely adopted the optimistic row,
- and whether the real rendered session UI remains usable across supported
  desktop widths and important message states.

The goal is stabilization, not a session architecture rewrite. The plan adds
small contracts and behavior tests at the existing owner seams.

## Why This Requires A Plan

The confirmed gaps cross owner boundaries and cannot be fixed safely with one
local condition:

1. The orchestrator stores terminal run errors, the internal orchestrator HTTP
   response already exposes them, the server lifecycle client discards them,
   the Veslo route omits them, and the app clears terminal diagnostics before
   the UI can render the durable result.
2. OpenCode `session.error` currently writes `idle` directly, while app
   lifecycle watches are discovered and retained from active UI statuses. One
   event can therefore hide the run and remove the polling path before durable
   lifecycle truth is observed.
3. Session run phase currently depends on the app-wide `error` signal. An
   unrelated operational error can make an otherwise active session look like
   a failed run and change Stop/Retry presentation without a scoped durable
   failure.
4. Optimistic user-message cleanup is partly identity-based but normally falls
   back to exact text because Veslo deliberately does not send
   `clientMessageId` as the OpenCode `messageID`. Attachment-only sends have no
   text fallback, and ambiguous identical messages are not modeled explicitly.
5. The Tauri Pilot scenario named `visual-regression` only navigates through
   three routes. It does not seed a transcript, set representative window
   sizes, assert geometry, capture success screenshots, or detect message,
   composer, and sidebar overlap.

These boundaries span orchestrator, server, app state, message rendering, and
the authoritative Tauri runtime. Implementing only one layer would create a
new false-green state.

## Deep Audit Evidence

### Finding 1 - Durable failure data is lost before the app

Severity: P1

Confirmed owners:

- `packages/orchestrator/src/run-store.ts`
  - `RunRecord.error` is durable.
  - failed and aborted transitions persist an error and completion time.
- `packages/orchestrator/src/cli.ts`
  - `lifecycleRunPayload(...)` returns the public run record, including
    `error`, `clientMessageId`, and `origin`.
- `packages/server/src/orchestrator-lifecycle-client.ts`
  - `LifecycleRunStatusResult` and `parseLifecycleRunPayload(...)` retain
    no-progress diagnostics and internal client/origin correlation but drop
    `error`.
- `packages/server/src/routes/conversations.ts`
  - `GET /workspace/:id/conversations/:conversationId/runs/:runId` returns
    status and activity fields but omits the terminal error and client message
    id. Internal `origin` metadata does not need to become a new public field.
- `packages/app/src/app/lib/veslo-server/types.ts`
  - `VesloConversationRunStatusResult` has no terminal error or correlation
    fields.
- `packages/app/src/app/context/session-lifecycle-recovery.ts`
  - a non-stale terminal status is converted directly into local idle and the
    diagnostic is cleared; failed and completed are not distinguishable to the
    transcript UI.

Impact:

- if the OpenCode `session.error` event is missed during disconnect/reload, the
  app can learn that the run failed but cannot show the durable failure reason;
- a failed lifecycle can look like a normal idle completion after transcript
  refresh;
- support traces cannot reliably distinguish an app error from the terminal
  error stored by the run owner.

### Finding 2 - SSE can cancel the path to durable truth

Severity: P1

Confirmed owners:

- `packages/app/src/app/context/session-event-stream.ts`
  - `session.error` immediately writes session status `idle` and notifies idle;
  - scoped errors append a synthetic transcript error turn;
  - `MessageAbortedError` is handled separately;
  - local invalid bearer errors also trigger runtime-route recovery.
- `packages/app/src/app/context/session-lifecycle-recovery.ts`
  - desired watches are derived only from UI statuses
    `running/retry/submitted/blocked`;
  - `reconcile()` clears existing watches when they disappear from that desired
    set;
  - the controller has no public immediate-poll method for an SSE terminal
    observation.
- `packages/app/src/app/context/session.ts`
  - the event stream and lifecycle recovery controller are adjacent but have
    no explicit arbitration callback.
- `packages/app/src/app/context/workspace-session-selection.ts` and
  `packages/app/src/app/context/conversation-service.ts`
  - latest run ids are held in in-memory maps;
  - after an app reload, an idle selected conversation without a remembered
    run id does not start lifecycle recovery even though the server/orchestrator
    supports the `latest` run lookup.

Impact:

- a transient or early `session.error` can hide an admitted run that the
  lifecycle owner still considers running, retrying, or blocked;
- a later durable terminal transition may never reach the selected view;
- the visible Stop affordance can disappear while an abortable backend run
  still exists;
- after reload, the last durable failed outcome can be lost from the visible
  transcript because synthetic error turns are app memory and the latest run
  is not probed for an idle selected conversation.

### Finding 3 - App-wide error state can impersonate run failure

Severity: P1/P2

Confirmed owner:

- `packages/app/src/app/pages/session.tsx`
  - `runPhase()` returns `error` whenever `props.error` is non-null and local
    run state has started;
  - `props.error` is the app-wide error signal and is written by workspace,
    extension, runtime, selection, archive, auth, and send owners;
  - the same phase controls the footer indicator and the error label;
  - `hasAbortableBackendRun()` separately reads scoped lifecycle/session state.

Impact:

- phase, label, Stop behavior, and error origin can disagree;
- a non-run error can make the run indicator red while the durable run remains
  active;
- clearing the visual error path can be mistaken for stopping the backend run.

### Finding 4 - Optimistic transcript adoption is not deterministic enough

Severity: P1/P2

Confirmed owners:

- `packages/app/src/app/components/session/pending-submit-model.ts`
  - the optimistic row stores `clientMessageId`, a baseline list of transcript
    ids, draft content, and `sending/error` state;
  - it does not distinguish pre-admission from accepted admission and stores no
    accepted run id.
- `packages/app/src/app/pages/session.tsx`
  - `submittedDraftHasMessageInTranscript(...)` first tries to match
    `clientMessageId` against message/part ids;
  - it then falls back to the first post-baseline user message containing the
    same trimmed text;
  - an attachment-only draft returns false because the draft text is empty;
  - multiple post-baseline messages with identical text are not treated as an
    explicit ambiguity.
- `packages/app/src/app/pages/session-conversation-flow.ts`
  - accepted submit results already contain run and client correlation fields,
    but the optimistic row is not updated with an accepted-admission record.
- `packages/app/src/app/tests/pages/session-scroll-behavior.test.ts`
  - the critical cleanup is guarded mainly by source regex rather than direct
    behavior tests for identity, attachments, duplicates, and ambiguity.

Impact:

- an attachment-only optimistic row can remain beside its canonical user
  message;
- equal text can remove the wrong placeholder in an ambiguous transition;
- reload/remap timing can produce duplicate or disappearing user rows without
  violating the existing source-contract tests.

### Finding 5 - The successful UI gate does not validate rendered stability

Severity: P2

Confirmed owners:

- `packages/app/src/app/pages/session-layout-width.ts` and the sidebar layout
  models have useful pure width/state tests.
- many message-list and session-page tests are source-contract regex checks.
- `packages/e2e/pilot-scenarios/visual-regression.toml` only visits session,
  settings, and skills routes and checks that body text exists.
- `packages/e2e/helpers/pilot-runner.ts` captures screenshots and DOM snapshots
  on failure, not as successful visual/geometry evidence.
- `packages/desktop/src-tauri/src/commands/window.rs` already exposes the
  E2E-only `e2e_position_main_window` command needed for deterministic window
  dimensions.

Impact:

- the current gate can pass with clipped long paths, duplicated messages,
  composer overlap, unusable overlay sidebars, or a broken narrow layout;
- the scenario name creates stronger confidence than the assertions provide.

## Baseline Verification Run

The audit ran the existing focused tests on 2026-07-10. They are green, but do
not cover the cross-owner transitions above.

```powershell
cd packages/app
pnpm exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/session-layout-width.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/components/session/message-list-path-layout.test.ts
# pass 82, fail 0

cd ../server
pnpm exec bun test src/tests/orchestrator-lifecycle-client.test.ts
# pass 8, fail 0

cd ../orchestrator
pnpm exec bun test src/tests/run-registry.test.ts src/tests/run-store.test.ts
# pass 27, fail 0
```

The plan must add behavior coverage; it must not weaken or delete these tests
merely to make the new implementation pass.

## Already Addressed Or Owned Elsewhere

Do not reopen these areas in this plan:

- failed live/offline transcript reads now enter the existing unavailable state
  with Retry under Fix 46;
- incomplete reconnect catch-up now remains `degraded` under Fix 46;
- Tauri/dev-child exit attribution is implemented under Fix 46 and SRSH00;
- app-local and server-owned queue identity, FIFO retry, atomic claims,
  read-only projection, queue docs, and queue E2E belong to QF01-QF08;
- old OpenCode conversation import/binding is already owned by the server
  continuation path;
- server-resolved active abort, durable abort intent, and reload stop gating are
  complete under the VSLO-270 plan; preserve those contracts and do not revive
  deferred LFC07 instructions literally;
- broad `session.tsx`, app-state, server-route, or lifecycle-store refactoring
  is not required for this stabilization slice.

## Locked Architecture Decisions

1. After server admission, the orchestrator lifecycle record is authoritative
   for run terminal status and terminal failure reason.
2. OpenCode SSE is a low-latency observation source. `session.error` alone is
   not allowed to declare a known admitted run durably terminal.
3. An existing lifecycle watch survives an engine/UI status change to `idle`.
   It ends only on a non-stale terminal lifecycle result, explicit run-scope
   replacement, controller disposal, or bounded exhaustion.
4. Selecting an exactly scoped Veslo conversation performs one passive latest
   run probe when no exact run id is remembered. It does not activate OpenCode
   or probe a guessed raw session scope.
5. `MessageAbortedError` and durable `aborted` are not user-visible run
   failures. They must not create a red failure turn.
6. Local invalid-bearer route recovery remains operational recovery. It must
   not be reclassified as durable run failure.
7. A durable `failed` result produces at most one session-scoped error turn for
   that run id and then releases the local active indicator.
8. App-wide operational errors remain visible, but they do not set session run
   phase, terminal state, or abortability.
9. Do not send Veslo `clientMessageId` as OpenCode `messageID`. Those identities
   remain distinct.
10. An optimistic user row can be adopted only after server admission and a
   unique canonical user-message match in the same scoped transcript. Text
   equality alone is not sufficient when more than one candidate exists.
11. Ambiguous adoption fails visible-safe: keep one clearly optimistic row and
    record a diagnostic; never delete an arbitrary canonical or optimistic row.
12. The UI render gate uses semantic DOM and geometry assertions as its pass/fail
    oracle. Screenshots are retained as evidence, not brittle full-page pixel
    equality.
13. Desktop validation uses the real Tauri binary, isolated profile, local
    server, and rebuilt sidecars. Raw Vite and browser-only tests are not final
    proof.

## Agent Execution Protocol

Agents implement this plan in SMT order. Take the first phase whose
`done: false` remains and whose dependencies are complete.

1. Confirm the queue plan is fully complete before SMT01. If any QF phase is
   still false, do not edit SMT implementation files.
2. Work only in `C:\Users\jajse\Desktop\projekty\veslo-main` and inspect the
   branch, HEAD, worktrees, and dirty status before every phase.
3. Read root and scoped `AGENTS.md` files. Preserve all unrelated changes,
   especially the existing queue and Fix 46 hunks.
4. Re-read each named function before editing because QF06-QF08 may have moved
   or extended the same app and E2E surfaces.
5. Add behavior tests before implementation. Source regex may protect a seam,
   but it is not accepted as the sole test for state arbitration, message
   adoption, or rendered geometry.
6. Make the smallest contract-respecting change. Do not introduce a second run
   state store, transcript store, queue, or error bus.
7. If `packages/server/src` changes, run server typecheck and rebuild
   `veslo-server` before runtime-dependent verification.
8. Change only the completed phase's `done: false` line and matching
   frontmatter flag after all required tests and acceptance criteria pass.
9. Append one completion-log entry with paths and exact command results.
10. If a locked decision is unsupported by the live code, leave the phase
    false, record the blocker, and stop. Do not substitute timeouts, text
    matching, arbitrary sleeps, or global state guesses.

## Required Implementation Order

| Phase | Purpose | Depends on |
| --- | --- | --- |
| SMT01 | Preserve sanitized durable run failure/correlation data end to end | completed QF01-QF08 |
| SMT02 | Arbitrate SSE observations against durable lifecycle watches | SMT01 |
| SMT03 | Derive scoped run presentation independently of global errors | SMT02 |
| SMT04 | Adopt optimistic user messages deterministically | SMT01-SMT03 |
| SMT05 | Seed and validate real rendered transcript geometry | SMT04 |
| SMT06 | Prove lifecycle/message transitions in Tauri and align docs | SMT01-SMT05 |

## SMT01 - Durable Lifecycle Error And Correlation Contract

done: true

Priority: P1 durable run truth

Primary owners:

- `packages/server/src/orchestrator-lifecycle-client.ts`
- `packages/server/src/routes/conversations.ts`
- `packages/app/src/app/lib/veslo-server/types.ts`
- `packages/app/src/app/context/conversation-service.ts`
- focused server and app client/service tests

### Objective

Carry the durable run's sanitized terminal error and stable correlation fields
from the orchestrator response through Veslo server to the app without exposing
internal run-store or secret material.

### Implementation Contract

1. Extend `LifecycleRunStatusResult` with `error?: string | null`. Preserve the
   already available internal `clientMessageId` and `origin` parsing.
2. Parse `error` only when it is a string or null. A malformed optional error
   becomes null; malformed required `runId/status` still rejects the payload.
3. In the Veslo run-status route, return:
   - `error`, sanitized and truncated using one shared run/queue-safe sanitizer,
   - `clientMessageId`.
   Keep internal `origin` private unless a separate consumer-backed contract
   requires it later.
4. The client response must not include directory, request body, prompt text,
   runtime authorization hashes, tokens, engine pid, or engine owner metadata.
5. Preserve enough failure detail for the user to act. Redact bearer and token/
   authorization assignments and cap the rendered error at 500 characters.
6. Extend `VesloConversationRunStatusResult` and
   `SessionLifecycleRecoveryStatus` with the same optional fields.
7. Let `readConversationRunStatus(...)` return the fields unchanged after the
   server boundary. Do not parse error strings in the app to infer status.
8. Keep `completed`, `failed`, and `aborted` as explicit status values. Do not
   encode terminal state only in the error string.

### Required Tests

- orchestrator lifecycle client preserves string and null error values plus
  existing internal client/origin correlation;
- malformed optional error is normalized safely;
- Veslo route returns a failed status with sanitized error and correlation;
- bearer/token assignments are redacted and long errors are truncated;
- no directory, body, token, or engine-owner field is exposed;
- app Veslo client and conversation service preserve the typed fields;
- completed and aborted records can carry null error without being treated as
  failed.

### Verification

```powershell
pnpm --filter veslo-server exec bun test src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### Acceptance

- a durable failed run reaches the app with its exact status, sanitized error,
  run id, and client correlation;
- completed and aborted remain distinguishable from failed;
- no secret or request body data crosses the client route;
- `smt01_durable_lifecycle_error_contract_done` remains false until server bin
  rebuild and all focused tests pass.

## SMT02 - SSE And Durable Lifecycle Arbitration

done: true

Priority: P1 false-terminal prevention

Depends on: SMT01

Primary owners:

- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- `packages/app/src/app/context/session-event-stream.ts`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/context/conversation-service.ts`
- `packages/app/src/app/context/workspace-session-selection.ts`
- `packages/app/src/app/context/session-store-model.ts`
- `packages/app/src/app/types.ts`
- focused controller/model tests

### Objective

Make SSE error/idle events trigger durable reconciliation without letting them
cancel a known admitted-run watch or invent terminal state.

### Implementation Contract

1. Once a lifecycle watch exists, do not delete it merely because the engine/UI
   session status becomes idle. Continue until:
   - a non-stale terminal result,
   - the known run scope is explicitly replaced by another run,
   - controller disposal,
   - or the existing bounded exhaustion policy.
2. Add an immediate reconcile entry point to the lifecycle controller. It must:
   - resolve or reuse the exact workspace/conversation/run scope,
   - remain single-flight per recovery key,
   - cancel a later scheduled poll when an immediate poll starts,
   - and preserve the normal polling cadence after a non-terminal result.
3. Add one selected-conversation bootstrap path for reload/navigation:
   - only an exact browse scope with workspace id and Veslo conversation id is
     eligible;
   - if no exact run id is remembered, read run id `latest` once through the
     passive Veslo status client;
   - remember the actual returned run id under the scoped conversation/session
     aliases;
   - if it is active, create/continue the normal watch;
   - if it is terminal, reconcile it once and remember that the terminal run id
     was observed so reactive reruns do not poll forever;
   - do not cold-start or activate OpenCode for this read.
4. Add one explicit event-stream callback for `session.error` and
   `session.idle` lifecycle observations. The callback returns whether a known
   admitted run owns the event.
5. For a known admitted run:
   - `session.error` records the observation and requests immediate lifecycle
     polling;
   - it does not directly declare durable failure or clear abortability;
   - generic terminal failure text is not appended until lifecycle confirms
     `failed`;
   - `session.idle` may update engine status and schedule transcript ingestion,
     but it does not dispose the lifecycle watch.
6. For a session without a known admitted run, preserve the current fail-soft
   behavior: scoped error turn plus local idle.
7. Preserve the existing local-invalid-bearer recovery branch. Its operational
   message may remain visible, but it does not terminalize the run.
8. Preserve `MessageAbortedError` suppression. Durable `aborted` also produces
   no red failure turn.
9. On non-stale durable terminal result:
   - always release local busy status and refresh the transcript;
   - for `failed`, append one sanitized session error turn correlated by run id;
   - for `completed`, append no error;
   - for `aborted`, append no failure error.
10. Extend `SessionErrorTurn` or its append input with an optional durable run
   correlation key. Deduplicate the same terminal run even if SSE, polling, and
   transcript refresh arrive repeatedly.
11. Keep all status and error updates workspace-scoped. Background workspace
    terminal results must not mutate the active workspace's session key.

### Required Tests

- a running session receives `session.error`, durable status still says
  running, and the lifecycle watch plus abortability remain active;
- the same watch later receives `failed`, writes idle, refreshes transcript,
  and appends exactly one sanitized error turn;
- repeated failed polls and a duplicate SSE error do not add another turn;
- `session.idle` does not cancel a watch before completed status is read;
- completed clears busy without an error turn;
- aborted and `MessageAbortedError` clear/ignore without a failure turn;
- a no-scope session error retains the existing local fallback behavior;
- stale terminal status keeps polling;
- immediate polls are single-flight and do not create timer storms;
- selecting an exactly scoped idle conversation after app reload probes
  `latest`, remembers the returned real run id, and restores one failed turn;
- repeated reactive selection effects do not repeat the latest-run probe for
  the already observed terminal run;
- a raw/unbound session without exact conversation scope does not use `latest`;
- background workspace results update only scoped keys.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-workspace-cache.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/workspace-session-selection.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### Acceptance

- no SSE event can make a known admitted run permanently disappear before
  durable terminal truth is read;
- one durable failed run produces one visible scoped error turn;
- completed and aborted runs never show the failed-run treatment;
- `smt02_sse_lifecycle_arbitration_done` remains false until behavior tests
  cover all terminal statuses and workspace scoping.

## SMT03 - Scoped Run Presentation Projection

done: true

Priority: P1/P2 predictable run UI

Depends on: SMT02

Primary owners:

- new small pure model under `packages/app/src/app/pages/`, for example
  `session-run-presentation.ts`
- `packages/app/src/app/pages/session.tsx`
- focused behavior tests under `packages/app/src/app/tests/pages/`

### Objective

Derive run phase, label source, indicator visibility, and abortability from
session-scoped local/lifecycle/engine evidence instead of app-wide error state.

### Implementation Contract

1. Add one pure presentation function. It consumes only:
   - current session key/workspace scope,
   - local optimistic run state,
   - scoped engine session status,
   - scoped lifecycle diagnostic,
   - assistant-response progress,
   - and runtime warmup state.
2. Return a compact projection containing at least:
   - `phase`: idle/sending/thinking/retrying/responding/error,
   - `showIndicator`,
   - `abortable`,
   - `source`: local/lifecycle/engine,
   - optional diagnostic label kind.
3. `props.error` must not be an input to the run projection.
4. A non-stale active lifecycle diagnostic wins over an engine status that has
   already flipped idle.
5. A blocked `model_retry_no_output` diagnostic remains visibly blocked/error
   and abortable; clearing its UI must not pretend to abort it.
6. Existing optimistic pending and response-started behavior remains intact.
7. Render app-wide operational error separately from the run indicator with a
   neutral operational-error boundary. It may not change run phase,
   abortability, Stop, or Retry semantics.
8. Use the projection in Escape/Stop visibility and footer rendering so the
   same evidence cannot produce contradictory UI branches.
9. Preserve the completed VSLO-270 rule: a visually failed/blocked run that is
   still backend-abortable must call the server-resolved active abort path;
   only a non-abortable local error may be cleared locally.
10. Do not move all `SessionView` signals into a new store. This phase extracts
   only the pure derivation and replaces duplicated conditionals.

### Required Tests

- unrelated app/workspace error during lifecycle `running` leaves phase active
  and abortable;
- engine idle plus lifecycle running remains active until terminal;
- completed terminal becomes idle after SMT02 reconciliation;
- blocked model retry is error-styled and still abortable;
- optimistic pre-admission send remains sending/responding as today;
- assistant response progress changes thinking to responding;
- no selected session produces idle/non-abortable;
- operational error remains visible without changing phase;
- Escape/Stop uses the same projection as the footer.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-run-presentation.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-conversation-flow.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### Acceptance

- global operational errors cannot impersonate run failure;
- footer, Stop, Escape, and abortability agree on one scoped projection;
- no new app-wide state owner is introduced;
- `smt03_scoped_run_presentation_done` remains false until direct behavior
  tests replace source-regex-only confidence for the phase rules.

## SMT04 - Deterministic Optimistic Transcript Adoption

done: true

Priority: P1/P2 duplicate and disappearing message prevention

Depends on: SMT01 through SMT03

Primary owners:

- `packages/app/src/app/components/session/pending-submit-model.ts`
- new pure reconciliation model near the pending-submit owner
- `packages/app/src/app/pages/session-conversation-flow.ts`
- `packages/app/src/app/pages/session.tsx`
- focused behavior tests

### Objective

Remove an optimistic user row only when the same accepted send has one
unambiguous canonical transcript candidate, including attachment-only sends.

### Implementation Contract

1. Extend the pending submitted model with explicit admission metadata:
   - `admission: "pending" | "accepted"`,
   - accepted `runId` or `reservedRunId` when returned,
   - accepted server `clientMessageId`.
2. Add a pure `markPendingSubmittedAccepted(...)` transition. A returned
   non-empty client id that differs from the local client id is a correlation
   failure: retain the optimistic row, record a diagnostic, and do not guess.
3. Replace the inline `submittedDraftHasMessageInTranscript(...)` with a pure
   adoption decision.
4. Candidate messages must be:
   - user-role messages,
   - in the same scoped session transcript,
   - absent from `transcriptMessageIdsAtSubmit`,
   - and observed only after admission becomes accepted.
5. Strong identity match wins when canonical info or part metadata explicitly
   carries the accepted client id.
6. Otherwise compare a normalized display fingerprint covering:
   - prompt/shell mode,
   - resolved text/text,
   - file-part path/label identity,
   - attachment filename and MIME identity.
7. Do not include attachment data URLs, file contents, prompt bodies, or paths
   in traces. Diagnostics report only counts, boolean match reasons, ids, and
   scope.
8. Content fallback adopts only when exactly one post-baseline candidate has
   the same fingerprint. Zero or multiple candidates are `unresolved`.
9. Attachment-only and file-only drafts must be matchable by their file
   fingerprint without requiring text.
10. `unresolved` keeps the optimistic row visibly marked as optimistic. It does
    not delete canonical messages and does not create a second retry/send.
11. Preserve pending-to-real session remap and queue-key workspace checks.
12. Do not use lifecycle completion, assistant response, elapsed time, or idle
    status alone as evidence that the canonical user row exists.

### Required Tests

- accepted text submit adopts one unique post-baseline canonical user message;
- a matching pre-baseline message is ignored;
- two same-text post-baseline candidates remain unresolved;
- attachment-only submit adopts one matching canonical file message;
- mismatched attachment name/MIME remains unresolved;
- explicit strong client-id match adopts even when display text is normalized
  differently;
- mismatched accepted client id fails closed;
- pre-admission transcript changes cannot remove the optimistic row;
- pending-to-real session remap preserves admission metadata;
- workspace/session mismatch cannot adopt;
- failed optimistic messages remain editable and are never auto-adopted;
- no test relies only on source regex.

### Verification

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/pending-submit-model.test.ts src/app/tests/components/session/pending-submit-reconciliation.test.ts src/app/tests/components/session/pending-session-instance-model.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-transcript-viewport.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

### Acceptance

- the visible transcript contains one user row after canonical adoption;
- attachment-only sends reconcile without permanent optimistic duplication;
- ambiguity retains the optimistic row and never deletes arbitrary content;
- no upstream OpenCode message-id contract is changed;
- `smt04_optimistic_transcript_adoption_done` remains false until identity,
  attachment, ambiguity, remap, and scope behavior tests pass.

## SMT05 - Deterministic Render Fixture And Geometry Gate

done: false

Priority: P2 rendered UI stability

Depends on: SMT04

Primary owners:

- `packages/e2e/pilot-scenarios/session-render-stability.toml`
- minimal reusable E2E fixture support under `packages/e2e/helpers/` if needed
- stable selectors in session/message/sidebar components only where absent
- Pilot runner registration and contract tests

### Objective

Validate the real rendered session surface with deterministic transcript data
at supported narrow, medium, and wide desktop dimensions without a live model.

### Fixture Contract

Use the isolated Tauri profile and existing local Veslo server APIs:

1. Resolve or create one deterministic local workspace through supported Tauri
   commands.
2. Read local server URL/token from `veslo_server_info`.
3. Import one scoped conversation through
   `POST /workspace/:id/conversations/import`.
4. Seed a host transcript through
   `POST /workspace/:id/sessions/:sessionId/transcript` containing:
   - a normal user text message,
   - an attachment-only user message,
   - a long unbroken path/identifier,
   - assistant text,
   - reasoning and tool/progress parts,
   - and a long tool/error detail suitable for overflow checks.
5. Use the completed QF08 deterministic lifecycle fixture to expose one
   terminal failed run for the same conversation. Let the SMT02 passive latest
   run probe create the synthetic error turn; do not inject a DOM node or mutate
   an app signal directly.
6. Open `/session/:id` and wait for host-first hydration. Do not start OpenCode
   or call a provider merely to populate the fixture.

### Geometry And Semantic Assertions

Use `e2e_position_main_window` and assert at minimum:

- 390 x 844,
- 768 x 900,
- 1440 x 1000.

At every size assert:

1. canonical message count and order are exact;
2. no optimistic/canonical duplicate user row exists;
3. the conversation pane has positive width and height;
4. message rows stay inside the center column;
5. long text/path content wraps or uses an intentional local scroller without
   increasing the page/root width;
6. the composer is visible, inside the viewport, and not overlapped by the
   transcript footer or titlebar safe strip;
7. the latest-message control and run/operational banners do not cover the
   composer;
8. narrow mode uses overlay sidebars and returns to an unobscured center pane
   after close;
9. wide mode restores the configured docked sidebars without shrinking the
   center below the layout model's minimum;
10. opening/closing left and right sidebars does not change message order or
    reset the transcript viewport.

### Success Artifacts

1. Capture WebView screenshots for all three widths after assertions pass.
2. Capture a scoped accessibility/DOM snapshot for the session conversation
   pane.
3. Store artifacts under the normal isolated E2E run directory.
4. Screenshots are review evidence. Do not fail on full-image pixel equality;
   fail on semantic and geometry assertions.

### Required Tests

- Pilot runner registers the new scenario and success-artifact path;
- fixture helpers redact tokens and do not persist prompt/file contents in
  logs;
- geometry helper tests cover overflow tolerance and intentional scroll
  containers;
- current layout-model and message-list behavior tests remain green;
- scenario cleanup removes only its isolated workspace/profile resources.

### Verification

```powershell
pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm --test helpers/pilot-runner.test.ts helpers/session-render-fixture.test.ts helpers/session-geometry.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-layout-width.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/components/session/message-list-path-layout.test.ts src/app/tests/components/session/message-list-hybrid-timeline.test.ts src/app/tests/components/session/session-center-width.test.ts

pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD='1'
pnpm --filter @neatech/veslo run prepare:sidecar
Push-Location packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
Pop-Location
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario session-render-stability
git diff --check
```

### Acceptance

- the seeded transcript renders exact content once at all three widths;
- semantic/geometry assertions catch clipping and overlap independently of
  screenshot review;
- successful runs retain width-specific screenshots and a scoped DOM snapshot;
- no live provider or existing user profile is required;
- `smt05_render_geometry_gate_done` remains false until the real Tauri scenario
  passes against rebuilt artifacts.

## SMT06 - Real Desktop Lifecycle And Message Transition Gate

done: false

Priority: P1 final stabilization gate

Depends on: SMT01 through SMT05

Primary owners:

- `packages/e2e/pilot-scenarios/session-run-truthfulness.toml`
- the deterministic QF08 runtime fixture/controller support
- narrowly scoped E2E-only server/orchestrator fixture hooks if QF08 cannot yet
  emit a real SSE event and transition the same durable run
- `packages/e2e/helpers/pilot-runner.ts`
- canonical session runtime/workflow documentation

### Objective

Prove the lifecycle/error/message-adoption behavior through the real desktop
app and align the documented ownership contract with the shipped behavior.

### Scenario Contract

Reuse the deterministic local runtime fixture completed by QF08. Do not create
a second lifecycle or queue test server.

If QF08 lacks one required transition, extend that same fixture behind the
existing E2E-only build/config gate. The hook must emit through the real event
stream or lifecycle HTTP boundary; it must not mutate Solid signals, DOM nodes,
or production runtime state directly.

The focused scenario must:

1. start the real debug Tauri app with an isolated profile and rebuilt
   sidecars;
2. open one scoped conversation and submit one deterministic text request;
3. hold its durable lifecycle in `running`;
4. inject/produce a scoped OpenCode `session.error` observation while lifecycle
   remains running;
5. verify the run indicator and Stop remain active and no durable failure turn
   is shown yet;
6. terminalize the same durable run as `failed` with a token-bearing fixture
   error;
7. verify the UI becomes idle, renders exactly one red error turn, and shows
   only the sanitized error;
8. repeat the event/poll/refresh signal and verify no duplicate error turn;
9. run a completed case and an aborted case and verify neither renders failed
   treatment;
10. submit an attachment-only deterministic user message, append its canonical
    transcript row, and verify exactly one visible user row remains;
11. reload or reconnect the app and verify canonical transcript content and
    terminal state remain stable;
12. create an unrelated operational app error while a second run remains
    active and verify run phase/Stop do not change;
13. tear down only processes and fixture state created by the harness.

Use fixture state transitions, observable DOM/state, durable run reads, and
trace ids as oracles. Arbitrary sleeps, live model output, screenshot-only
judgment, or app-internal signal mutation are not accepted.

### Documentation Contract

Update the canonical session runtime/workflow docs to state:

- durable lifecycle owns terminal run truth after admission;
- SSE error/idle events trigger reconciliation but do not override the durable
  owner;
- global operational errors do not change run phase;
- optimistic rows remain until unique canonical adoption;
- ambiguous adoption stays visibly optimistic rather than deleting content;
- completed, failed, and aborted have distinct visible outcomes.

Do not document server queue controls beyond what QF07/QF08 actually shipped.

### Required Verification

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/run-registry.test.ts src/tests/run-store.test.ts
pnpm --filter veslo-orchestrator typecheck

pnpm --filter veslo-server exec bun test src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/tests/components/session/pending-submit-reconciliation.test.ts src/app/tests/pages/session-run-presentation.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/session-layout-width.test.ts
pnpm --filter @neatech/veslo-ui typecheck

$env:VESLO_SIDECAR_FORCE_BUILD='1'
pnpm --filter @neatech/veslo run prepare:sidecar
Push-Location packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
Pop-Location

pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario session-run-truthfulness
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario session-render-stability
pnpm --filter @neatech/veslo-e2e test:pilot -- --suite current-gate
git diff --check
```

### Acceptance

- the real app never treats a transient SSE error as durable failure while the
  lifecycle owner remains active;
- failed/completed/aborted each have the correct stable visible outcome;
- one admitted send produces one visible canonical user row after adoption;
- unrelated operational errors cannot change scoped run phase or Stop;
- both focused scenarios and the full current gate pass with rebuilt sidecars;
- docs describe the same ownership and visible outcomes;
- `smt06_desktop_transition_gate_done` remains false until all requirements
  above pass.

## Combined Source Verification

Before SMT05 runtime work, run the complete integrated source bundle once:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/run-registry.test.ts src/tests/run-store.test.ts
pnpm --filter veslo-orchestrator typecheck

pnpm --filter veslo-server exec bun test src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-workspace-cache.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/tests/components/session/pending-submit-reconciliation.test.ts src/app/tests/components/session/pending-session-instance-model.test.ts src/app/tests/pages/session-run-presentation.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-transcript-viewport.test.ts src/app/tests/pages/session-layout-width.test.ts
pnpm --filter @neatech/veslo-ui typecheck

git diff --check
```

Add every new focused test file introduced during implementation to this
command before marking SMT06 complete.

## Explicit Non-Goals

- no rewrite of `SessionView` or app-wide state management;
- no new lifecycle database, run store, transcript store, or queue;
- no change to OpenCode upstream `messageID` semantics;
- no automatic prompt replay or retry based on an error string;
- no promotion of the historical invalid-file auto-continuation plan; existing
  invalid-file formatting remains, but retry policy is outside this plan;
- no lifecycle inference from elapsed time, message text, or assistant arrival;
- no persistence of full prompt/file contents for correlation;
- no global pixel-perfect screenshot baseline;
- no broad Tailwind/design refresh;
- no mobile-web support claim beyond the desktop app's configured minimum
  window width;
- no queue mutation API or queue lifecycle redesign;
- no raw Vite/browser-only sign-off.

## Completion Checklist

- [ ] SMT01 carries sanitized durable failure and correlation end to end.
- [ ] SMT02 keeps lifecycle watches alive and arbitrates SSE observations.
- [ ] SMT03 scopes run presentation independently of global error state.
- [ ] SMT04 adopts optimistic user rows only through a unique canonical match.
- [ ] SMT05 proves exact transcript rendering and geometry at three widths.
- [ ] SMT06 passes lifecycle/message transition and current-gate desktop runs.
- [ ] Canonical docs match shipped status, error, adoption, and Stop behavior.
- [ ] Every frontmatter phase flag is `true`.
- [ ] Every phase has a completion-log entry with exact command results.
- [ ] Top-level `done` is `true` only after all items above pass.

## Completion Log

Append entries; do not rewrite earlier evidence.

```text
2026-07-10 - SMTxx - changed: <paths> - verification: <exact commands and pass/fail counts> - notes: <scope or blocker> - done: false
2026-07-10 - SMT01 - changed: packages/server/src/orchestrator-lifecycle-client.ts, packages/server/src/routes/conversations.ts, packages/app/src/app/lib/veslo-server/types.ts, focused server/app tests - verification: `pnpm --filter veslo-server exec bun test src/tests/orchestrator-lifecycle-client.test.ts src/tests/server-conversations.test.ts` (54 pass, 0 fail); `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/context/conversation-service.test.ts` (34 pass, 0 fail); server and app typechecks passed; `pnpm --filter veslo-server build:bin` passed; `git diff --check` passed - notes: durable error is sanitized at the public route and origin remains private - done: true
2026-07-10 - SMT02 - changed: lifecycle recovery, session SSE arbitration, durable error-turn model, conversation latest-run recovery, focused app tests - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-event-stream.test.ts src/app/tests/context/session-store-model.test.ts src/app/tests/context/session-workspace-cache.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/workspace-session-selection.test.ts` (80 pass, 0 fail); app typecheck passed; `git diff --check` passed - notes: SSE errors and idle observations now trigger a scoped immediate durable poll without disposing an admitted-run watch; exact selected conversations probe `latest` once after reload - done: true
2026-07-10 - SMT03 - changed: packages/app/src/app/pages/session-run-presentation.ts, session page integration, focused presentation/Escape tests - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-run-presentation.test.ts src/app/tests/pages/session-inline-loading.test.ts src/app/tests/pages/session-escape-stop-confirmation.test.ts src/app/tests/pages/session-conversation-flow.test.ts` (80 pass, 0 fail); app typecheck passed; `git diff --check` passed - notes: run indicator, Stop/Escape affordance, and abortability consume one scoped projection; operational errors render separately - done: true
2026-07-10 - SMT04 - changed: pending-submit admission/reconciliation model, session adoption effect, pending-message visibility, focused app tests - verification: `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/pending-submit-model.test.ts src/app/tests/components/session/pending-submit-reconciliation.test.ts src/app/components/session/pending-session-instance-model.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-scroll-behavior.test.ts src/app/tests/pages/session-transcript-viewport.test.ts` (100 pass, 0 fail); app typecheck passed; `git diff --check` passed - notes: accepted rows adopt only through a unique scoped identity/fingerprint candidate; attachment-only sends are covered and ambiguities stay visibly optimistic - done: true
```

Change an entry's final value to `done: true` only when the matching phase flag
and phase-local `done` value are also changed to true.
