---
title: Lifecycle-Authoritative Terminal Assistant Event Ordering Plan
date: 2026-07-19
status: in_progress
done: false
core_done: false
deferred_followups_done: false
base_branch: main
base_commit: 96390d32
source_issue: terminal assistant output is rendered before the authoritative terminal run state
target_area:
  - packages/server/src/conversation-run-lifecycle-controller.ts
  - packages/server/src/conversation-run-queue-store.ts
  - packages/server/src/routes/conversations.ts
  - packages/app/src/app/context/session.ts
  - packages/app/src/app/context/session-lifecycle-recovery.ts
  - packages/app/src/app/context/session-event-stream.ts
  - packages/app/src/app/context/terminal-delivery-coordinator.ts (new)
  - packages/app/src/app/context/conversation-service.ts
  - packages/app/src/app/context/workspace-session-selection.ts
  - packages/app/src/app/app.tsx
  - packages/app/src/app/pages/session-send-workflow.ts
  - packages/app/src/app/pages/session-conversation-flow.ts
  - packages/app/src/app/pages/session-run-presentation.ts
  - packages/app/src/app/pages/session.tsx
  - packages/e2e/helpers/session-queue-runtime-fixture.ts
  - packages/e2e/helpers/pilot-runner.ts
  - packages/e2e/helpers/pilot-scenario-plan.ts
  - packages/e2e/package.json
  - .github/workflows/e2e-ui.yml
---

# Lifecycle-Authoritative Terminal Assistant Event Ordering Plan

## Goal

Guarantee the visible terminal ordering for one **eligible** accepted conversation run:

```text
server-mediated lifecycle service confirms terminal runId
  -> app removes the active run presentation ("Odpovídám")
  -> app publishes the retained final assistant update to the transcript
```

This is not a request to hide the indicator when arbitrary assistant text arrives. Streaming text
can arrive while a run remains active. The terminal decision stays authoritative to the
server-mediated lifecycle-service exact-run response and remains bound to one exact `runId`.

An eligible run has a materialized OpenCode session alias before its engine can emit output. The
current first/pending-session path does not provide that alias to the browser until after the server
has started submission; it is explicitly outside this core guarantee until a separate pre-start
server handoff exists (see Deferred Follow-Ups).

## Audit Evidence

The latest development trace (`.tmp/send-workflow-trace.ui.ndjson`) for
`runId=c2be90a5-f18f-41e8-9f6c-e35a0cee63b1` showed:

| UTC time | Event | Effect |
|---|---|---|
| 17:35:47.706 | `session-sse:assistant-part-updated` | final visible text part arrives |
| 17:35:47.722 | `session-ui:dom-mutation-batch` | that text becomes visible |
| 17:35:47.756–.757 | two `session-sse:assistant-message-updated` | metadata follows the final text part |
| 17:35:47.758 | `session-sse:status-idle-deferred-to-lifecycle` | raw engine idle arrives |
| 17:35:47.824 | `session-lifecycle-recovery:poll` | exact-run response reports `completed` |
| 17:35:47.869 | `session-ui:state-change` | run presentation becomes `idle`; indicator disappears |
| 17:35:48.528 | `server:conversation-run:lifecycle-reconcile` | server controller later reconciles `completed` |

The same run also received an earlier raw `session.idle` at 17:35:43.428. Lifecycle recovery read
the exact run as `queued` at 17:35:43.495, and assistant output continued afterwards. Therefore an
assistant update or raw engine idle is not sufficient evidence to clear the active-run presentation.

## Current Owner Split

- `packages/app/src/app/context/global-sdk.tsx` receives the global engine event stream directly
  through the Rust SSE proxy (SDK fallback only when needed). The server is not today a global
  event relay.
- `packages/app/src/app/context/session-event-stream.ts` applies assistant message/part events to
  the local transcript and forwards raw idle/error observations to lifecycle recovery.
- `packages/app/src/app/context/session-lifecycle-recovery.ts` reads the exact conversation run;
  after a terminal result it writes UI status `idle` before its asynchronous terminal transcript
  hydration.
- `packages/app/src/app/context/session.ts` is the composition owner: it constructs both the
  lifecycle recovery controller and the event-stream controller, connects raw lifecycle
  observations, owns their disposal, and is therefore the only safe place to join the barrier.
- `packages/server/src/routes/conversations.ts` mediates the exact-run read, but returns
  `lifecycleClient.status(...)` directly. The authoritative terminal fact for this UI contract is
  therefore the exact-run response of the lifecycle service, mediated by the server.
- `packages/server/src/conversation-run-lifecycle-controller.ts` remains the server-side owner of
  run admission and background reconciliation. Its later reconcile trace is not a prerequisite
  for the exact-run response to be terminal.
- The current app recovery and presentation maps are deliberately **single-run** per conversation
  or session alias (`currentRunKeyByConversation`, latest-run maps, session status, and lifecycle
  diagnostics). They cannot safely host a running A plus queued B without the ownership split in
  TEO01A below.

The direct engine event stream is intentional. Replacing it with a server-owned global SSE relay
would broaden this work into a transport replatform and is explicitly out of scope.

## Target Contract

Introduce a narrow, internal **terminal delivery barrier**. It is not a second run state machine.

```text
direct engine assistant events --> app prepares a last-visible-mutation tail
raw engine idle/error ----------> existing lifecycle observation
server-mediated lifecycle-service exact-run terminal result -> terminal delivery barrier
                              -> app commits idle/error presentation
                                  -> next render frame commits all retained final display paths
```

The barrier identity is always:

```ts
type TerminalDeliveryKey = {
  workspaceId: string;
  conversationId: string;
  runId: string;
};
```

`opencodeSessionId` is a verified alias attached to the entry, not a key dimension. One run must
produce one barrier entry even while the UI session id, OpenCode session id, and conversation id
are being reconciled. No matching `runId`, no terminal ordering privilege. A terminal result for
an older run must not release, suppress, or clear the tail of a newer run.

## KISS Boundary

Do:

- retain the last **visible assistant transcript mutation** per active run scope;
- keep concurrent exact run scopes and route each raw engine event through one active alias owner;
- use the existing exact-run lifecycle read as terminal authority;
- preserve direct Rust-proxied engine SSE and the SDK fallback;
- coordinate direct SSE writes, terminal transcript hydration, and terminal error-turn display;
- commit terminal presentation before committing any retained final display mutation;
- add non-secret ordering traces and focused tests.

Do not:

- introduce a second app lifecycle state machine;
- treat `message.updated`, `message.part.updated`, or raw `session.idle` as terminal;
- replace the global engine stream with a server SSE proxy;
- delay all assistant output until a run completes;
- let metadata-only `message.updated` events release a retained text mutation;
- mark a text-delta event as deduplicated before it is actually committed;
- change queue admission, add a queued-run cancellation action, or change transcript persistence
  ownership; preserve the existing visible Stop action by resolving it to the active alias owner;
- use a latest-run cache as the owner of raw SSE, terminal hydration, or the visible Stop action;
- change the public conversation submit response shape.

## Preconditions And Design Gate

### TEO00 - Freeze the exact current contract

Status: `done: false`

1. Reproduce one streamed managed-AI send with send-workflow tracing enabled.
2. Capture, for the same run, the ordered timestamps for:
   - final assistant part/message update,
   - raw `session.idle` or `session.error`,
   - exact-run lifecycle read result and `runId`,
   - `runIndicatorVisible=false`,
   - final transcript DOM mutation.
3. Verify the existing exact-run status route returns `runId`, status, and `stale` without relying
   on a latest-message-derived identifier.
4. Map the app-side resolver from SSE `(workspaceId, OpenCode session id)` to one active exact
   lifecycle scope `(workspaceId, conversationId, runId)`. It must live in the `session.ts`
   composition owner, not in the page.
5. Verify that the exact-run route reads `lifecycleClient.status(workspaceId, conversationId, runId)`
   directly, and separately record the later controller reconciliation trace when it exists. The
   controller's reconciliation is diagnostic/recovery ownership, not the release predicate.
6. Verify the first/pending-session send path separately. Today its `opencodeSessionId` and `runId`
   arrive in the materialized submit result after server submission has begun; a pending client
   session id or `clientMessageId` is not present in engine SSE. Do not claim pre-admission coverage
   for this path without a pre-start server identity handoff.
7. Reproduce/fixture the queue shape `A=running`, `B=queued` for the same conversation and
   OpenCode session alias. Record exact status reads, raw SSE events, terminal hydration, visible
   session status, lifecycle diagnostics, and Stop target for both run ids.

Acceptance:

- the plan names the real exact-run read and route owner;
- the captured run has one unambiguous `TerminalDeliveryKey` and verified OpenCode-session alias;
- the first/pending-session limitation is documented and covered by a narrow regression test, or a
  separately approved server pre-start handoff replaces that limitation;
- the captured queue case proves that A and B have distinct exact keys while sharing one alias;
- if the status read cannot prove matching `runId`, this plan is blocked rather than falling back
  to session-only terminality.

### TEO01A - Make app-side run ownership multi-run safe

Status: `done: false`

This is a narrow routing/index refactor, not a second lifecycle authority. Exact status remains
read from the existing lifecycle service; this slice only prevents one queued run from replacing
the app-local identity and cleanup state of another run.

1. Replace conversation-wide replacement semantics in lifecycle recovery. `watches`, exhausted
   watches, terminal transcript recoveries, and their retry guards must remain keyed by the exact
   `(workspaceId, conversationId, runId)`. Remove the behavior equivalent to
   `clearReplacedConversationWatches` for a merely newer/queued run.
2. Maintain a small app-local ownership index:
   - `exactRunsByKey`: all admitted and queued exact scopes;
   - `activeAliasOwnerByAlias`: only the run currently allowed to consume engine SSE and write the
     visible session status/active diagnostic for that OpenCode-session alias;
   - queued reservations: exact scopes with no alias ownership and no direct SSE matching.
3. Split the current overloaded "latest run" lookup:
   - raw `session.idle`/`session.error` and assistant SSE resolve through `activeAliasOwnerByAlias`;
   - exact polling/hydration receives the requested exact scope directly;
   - queued reservation lookup is separate and must never overwrite the active alias-owner pointer.
   Update `conversation-service.ts` and `workspace-session-selection.ts` so a queued B cannot
   overwrite A through `rememberLatestConversationLifecycleRunId`.
4. Make terminal transcript recovery per-run. A terminal A hydration/retry remains valid while B is
   queued; it is cancelled only by A disposal, selection invalidation, or an explicit A abort—not
   because B was admitted.
5. Keep presentation single-run by design, but derive it from the active alias owner only. Queued
   reservations may drive queue UI and blocking policy, but must not overwrite `sessionStatus` or
   `conversationRunDiagnosticsBySessionKey` for A. Audit the sidebar, skill reload guard, and
   active reload blocking set so their aggregate busy result remains conservative.
6. Product contract: the visible Stop control targets the current active alias owner A. Cancelling a
   queued B, if supported, is a separate explicit queue action; it must not be inferred from the
   one visible Stop button or from a latest-run map.

Likely files:

- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/context/session-event-stream.ts`
- `packages/app/src/app/context/conversation-service.ts`
- `packages/app/src/app/context/workspace-session-selection.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/session-run-presentation.ts`
- `packages/app/src/app/pages/session-conversation-flow.ts`

Acceptance:

- A running run and B queued run survive concurrently with the same workspace, conversation, and
  OpenCode session alias;
- raw idle/error and assistant events route to A until exact terminality of A and exact active
  confirmation of B **and** completion of A's terminal delivery render boundary;
- B cannot cancel A's watch, terminal hydration, retry, visible diagnostic, or tail;
- Stop during A-running/B-queued sends the explicit A run id; queued B state remains inspectable
  but does not become the active control target;
- sidebar activity, reload blocking, and current session presentation do not become idle merely
  because an alias-local map was overwritten by queued B.

### TEO01 - Arm and bind the barrier before engine output can escape

Status: `done: false`

Rules:

- Reuse the existing exact-run endpoint/result; do not add a server endpoint or response shape.
- Use the TEO01A ownership index: all exact entries are keyed by
  `(workspaceId, conversationId, runId)`, while at most one **alias owner** exists per
  `(workspaceId, OpenCode-session alias)`. Exact entries are not evicted merely because a newer
  run for the same conversation is accepted or queued.
- Before sending an eligible request, create a **provisional entry** only when its alias has no
  active exact owner and no queued exact entry is awaiting handover. Its identity is the known
  workspace, UI/OpenCode-session alias, known conversation alias, and unique `clientMessageId`;
  it has no `runId` yet.
- A direct assistant event may match only the current alias owner or that one unambiguous
  provisional entry. It is prepared and retained even if the exact
  `(workspaceId, conversationId, runId)` resolver is not yet published. This closes the period
  where the server has started the engine but the browser has not received the submit result; the
  server currently generates `runId` itself, so arming only after the HTTP response is insufficient.
- On a `submitted` response, atomically promote that provisional entry to the exact
  `TerminalDeliveryKey` and make it alias owner. Promotion preserves prepared event/delta state
  and must not replay or pre-commit it. The lifecycle watch, active-run presentation, and barrier
  promotion share the same accepted-run callback ordering.
- On a `queued` response, create an exact queued entry for its `reservedRunId`, but leave it
  **unarmed**: it is not an alias owner and it has no alias-matchable provisional entry. A running
  run A and queued run B may therefore coexist with the same OpenCode session alias. Register an
  exact status watch for B without allowing it to write A's session status or diagnostic.
- Move alias ownership from A to queued B only after all three conditions hold: A has matching
  exact terminality, A's terminal presentation and retained final display paths have crossed their
  render boundary, and an exact lifecycle read confirms B is engine-active/started. Until then SSE
  belongs to A. This deliberately holds B's candidate events even if the server starts B immediately
  after A, so the shared alias cannot make the UI busy again or render B text before A's terminal
  tail has visibly committed. If a first candidate B event arrives while these conditions are being
  resolved, retain it in a bounded uncommitted alias-transition slot and commit it only after the
  handover completes; do not guess B from queue order or send it through the immediate path.
- An assistant event with a genuinely unknown alias and no current owner/provisional/handover
  scope keeps the current immediate path. It is not permitted to use that fallback merely because
  a normal submitted-run binding has not arrived yet.
- If submission is definitively blocked/failed, dispose only its provisional entry and preserve
  current failure behavior. If transport outcome is unknown while the provisional entry has
  retained output, keep recovery/active presentation and resolve via the existing lifecycle probe;
  do not silently early-flush the retained event.
- Before a terminal release, the app must enforce
  `returnedRunId === requestedBarrierKey.runId` and `stale !== true`.
- A status with another `runId`, stale state, unavailable status, or ambiguous alias is not a
  barrier release and must leave the entry owned by normal stream/recovery behavior.
- The resolver is explicit: it accepts `(workspaceId, OpenCode session id)`, finds the active
  lifecycle scope through existing session/conversation binding, and returns `null` on ambiguity.
- Dispose an exact entry only on its own terminal completion/abort after all owned display paths,
  session/workspace disposal, or an explicit cancellation for that same `runId`.

Likely files:

- `packages/app/src/app/context/session.ts`
- `packages/app/src/app/context/session-lifecycle-recovery.ts`
- `packages/app/src/app/context/terminal-delivery-coordinator.ts` (new)
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/pages/session-send-workflow.ts`
- existing exact-run read route/service under `packages/server/src/routes/conversations.ts`

Acceptance:

- focused app tests cover provisional arm-before-submit, assistant output before/while submitted
  binding is published, atomic promotion without duplicate commit, resolver success, unknown
  session alias, ambiguity, returned-run mismatch, stale status, and queue handover: A streams,
  B returns `queued` with the same alias, A retains and terminally flushes, then B alone receives
  alias ownership only after exact lifecycle confirmation and A's completed terminal delivery
  boundary;
- focused server tests confirm the reused exact-run result includes the requested `runId`, status,
  and stale bit;
- no route accepts a caller-supplied terminal declaration and no new endpoint is introduced.

## Implementation Slices

### TEO02 - Add an app-local last-visible-mutation coordinator

Status: `done: false`

Create one small coordinator at `terminal-delivery-coordinator.ts`, composed and disposed by
`session.ts`. It owns the commit order of final display mutations; it does not own lifecycle state,
queue admission, or transcript durability.

Algorithm for each `TerminalDeliveryKey`:

1. Classify every assistant event before it writes the transcript store:
   - **visible mutation:** a text-bearing part update or a message update that changes displayed
     assistant content;
   - **metadata mutation:** message bookkeeping that does not change visible assistant content.
2. Retain only the latest visible mutation. A newer visible mutation commits the previously
   retained visible mutation through the normal commit path, then replaces it. A metadata mutation
   never commits, replaces, or clears a retained visible mutation.
3. Split the existing event path into `prepare` and `commit`:
   - `prepare` validates scope, session identity, and potential delta identity without mutating the
     transcript store or `seenTextDeltaEventIdsByPart`;
   - `commit` atomically records the delta id as seen and applies the same event to the transcript
     store exactly once.
4. The coordinator may retain events with a resolvable exact barrier key, the current unambiguous
   pre-admission entry, or the guarded alias-transition slot created by TEO01. User messages,
   tools, permissions, todos, status events, and assistant events with no matching active,
   provisional, or handover scope keep their current immediate path.
5. Clear an entry on its own session/workspace disposal, terminal completion, or terminal
   failure/abort after all owned display paths have been handled. A queued/newer exact entry never
   clears another run's entry or tail.

There is intentionally no fixed 750 ms watchdog in the guarantee path. A timer that releases the
last visible mutation before terminal confirmation would make the ordering best-effort. If a
bounded failure policy is needed, it must be an explicit product decision with a separate degraded
state and acceptance criteria; it is not part of this core guarantee.

Acceptance:

- regular streaming commits prior visible mutations in order while retaining only its current tail;
- metadata `message.updated` after the final text cannot release that text;
- reconnect/dedupe cannot apply a retained delta twice and does not mark it seen before commit;
- buffering is scoped by workspace, conversation, and runId, with OpenCode session as a verified
  alias only;
- a visible assistant event that arrives after engine start but before the accepted response is
  retained by its provisional entry and remains retained after atomic run-id promotion;
- queue handover keeps A's visible events and tail bound to A while B is queued on the same alias;
- alias handover cannot make B active in the shared presentation or commit B's prepared event until
  A's `idle` presentation and retained final display paths have completed their render boundary;
- unresolved terminality has explicit, tested degraded behavior rather than a silent early flush.

### TEO03 - Gate every terminal display path

Status: `done: false`

Wire the `session.ts` composition owner, `session-lifecycle-recovery.ts`, and the coordinator so
that no terminal path can bypass the ordering barrier:

1. Validate returned terminal `runId` against the coordinator key before release.
2. Preserve the current terminal path that writes UI session status and clears the active-run
   presentation.
3. After that status write has reached a render boundary, commit the matching retained visible
   mutation through the coordinator's `commit` path.
4. Do not let terminal transcript hydration publish or hydrate a final assistant snapshot directly
   while a matching retained visible mutation exists. Submit its visible assistant content to the
   coordinator: a newer canonical snapshot replaces the retained mutation and commits only after
   the terminal render boundary; a hydration that changes no visible assistant content may publish
   its metadata after that boundary.
5. Route `appendSessionErrorTurn` and equivalent terminal error presentation through the same
   coordinator decision. A failed/aborted run has no permission to bypass a retained final text or
   a newer run's transcript.

Use an explicit render boundary (`requestAnimationFrame` or an existing UI scheduler) between
status commit and final mutation commit. A JavaScript call order inside one Solid batch is not sufficient
evidence of visible order.

The order requirement is:

```text
matching terminal lifecycle result for run R
  -> `runIndicatorVisible=false` for R is observable
  -> retained assistant mutation and terminal transcript snapshot for R may enter the transcript store
```

Acceptance:

- trace and DOM tests prove the sequence above;
- a raw idle whose exact run remains queued/running leaves both the indicator and tail behavior
  active;
- a terminal result for old run A cannot clear or flush new run B.
- a queued B cannot receive A's alias events or discard A's tail before A has terminally completed.
- a queued/already-started B cannot re-activate the shared alias presentation or render B output
  before A's terminal boundary and final A display paths have completed.
- terminal hydration and terminal error-turn tests prove neither can render final content before
  the terminal presentation boundary.

### TEO04 - App coordinator diagnostics and no-ambiguity traces

Status: `done: false`

Add bounded, non-secret traces in the app-side coordinator. Server lifecycle traces remain the
existing evidence for durable terminality; do not duplicate them under `terminal-delivery:*`.

- `terminal-delivery:visible-mutation-prepared`
- `terminal-delivery:visible-mutation-replaced`
- `terminal-delivery:pre-admission-armed`
- `terminal-delivery:pre-admission-promoted`
- `terminal-delivery:pre-admission-disposed`
- `terminal-delivery:queue-entry-unarmed`
- `terminal-delivery:alias-handover-awaiting-lifecycle`
- `terminal-delivery:alias-handover-awaiting-terminal-boundary`
- `terminal-delivery:alias-handover-completed`
- `terminal-delivery:terminal-confirmed`
- `terminal-delivery:visible-mutation-commit-after-terminal`
- `terminal-delivery:terminal-hydration-held`
- `terminal-delivery:terminal-error-turn-held`
- `terminal-delivery:terminal-ignored-run-mismatch`

Every trace includes sanitized workspace/conversation/session scope, `runId`, event type, reason,
and elapsed hold duration. It must not include prompt text, assistant text, bearer tokens, or full
config payloads.

Acceptance:

- the latest `.tmp` can explain one output event from hold through flush;
- traces distinguish a direct stream commit, terminal-ordered commit, and a held hydration/error
  display path;
- trace volume is bounded during high-frequency text deltas.

### TEO05 - Regression suite and rollout gate

Status: `done: false`

Add focused tests:

1. Server lifecycle/controller tests:
   - existing exact-run read exposes the requested `runId`, status, and stale state;
   - queued/running remains non-terminal after raw idle;
   - stale/mismatched run status cannot release a tail.
   - a queued B retains its own `reservedRunId` and records A as active without replacing A's
     lifecycle ownership.
2. App stream coordinator tests:
   - arm a provisional entry before submit, inject an assistant text event before the accepted
     callback, then promote it to `runId` without an early or duplicate commit;
   - a later metadata `message.updated` does not release a retained final text part;
   - a later visible text mutation commits the prior visible mutation and retains the new one;
   - prepare/commit delta dedupe accepts once at commit and reconnect cannot double-apply;
   - A streams, B is queued on the same alias, and A's final part/message/terminal hydration all
     remain owned by A; B is unarmed until A terminality, A's completed delivery boundary, and B
     active lifecycle confirmation;
   - state is cleared on workspace/session disposal and its own terminal/abort, not by a newer
     queued run.
3. App lifecycle/presentation tests:
   - lifecycle recovery retains concurrent exact A/B watches and terminal hydration state; a queued
     B cannot trigger the old conversation-wide watch replacement;
   - conversation service and workspace selection retain separate active-run and queued-reservation
     identities, so raw SSE lookup resolves A while B is queued;
   - visible session status, diagnostic, sidebar/reload activity, and Stop resolve through A's
     alias ownership rather than B's reserved run id;
   - when B becomes engine-active before A's final render boundary, its first prepared event and
     active presentation remain held until A has visibly gone idle and committed its final display
     paths; only then may B take the shared alias owner;
   - terminal result commits `idle` before retained assistant event;
   - old terminal run cannot affect a newer accepted send;
   - terminal hydration and error-turn paths obey the same boundary;
   - failed/aborted terminal states preserve their current UI semantics.
   - the current first/pending-session flow does not create an alias-matchable provisional entry
     from `pendingClientSessionId` or `clientMessageId`; it remains explicitly excluded until a
     pre-start server identity handoff is introduced.
4. Browser/DOM test and desktop acceptance:
   - assert the visible order: active label absent first, final assistant row visible afterwards.
   - extend the existing isolated `session-run-truthfulness` scenario with the controlled terminal
     assistant part, exact lifecycle completion, and raw idle transition. It already owns the
     session-queue fixture and avoids maintaining a near-duplicate desktop bootstrap scenario.
   - keep `test:pilot:session-run-truthfulness` as a separate required workflow step after
     `current-gate` in `.github/workflows/e2e-ui.yml`. It cannot join `current-gate`: fixture
     scenarios intentionally reject mixed scenario selection. This focused command is the release
     gate, not opt-in diagnostics.

Focused verification target commands:

```powershell
pnpm --filter veslo-server exec bun test src/tests/conversation-run-lifecycle-controller.test.ts src/tests/server-conversations.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/terminal-delivery-coordinator.test.ts src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/workspace-session-selection.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/pages/session-run-presentation.test.ts
pnpm --filter @neatech/veslo-ui run test:renderer-recovery
pnpm --filter @neatech/veslo-e2e exec node --test --import=tsx/esm helpers/session-queue-runtime-fixture.test.ts helpers/pilot-scenario-plan.test.ts helpers/pilot-runner.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-e2e run test:pilot:session-run-truthfulness
git diff --check
```

Runtime acceptance gate:

- run a fresh managed-AI streamed send;
- inspect `.tmp/send-workflow-trace.ui.ndjson`;
- prove one matching run has `terminal-confirmed` before
  `visible-mutation-commit-after-terminal`;
- prove the final transcript DOM mutation occurs after `runIndicatorVisible=false`;
- prove an injected/observed false raw idle while the server reports `queued` or `running` does not
  hide the indicator.
- exercise A-running/B-queued with their shared alias and prove all A final display paths finish
  before an exact lifecycle-confirmed alias handover to B; include the case where the server has
  already started B before A's final render boundary.

## Rollback And Failure Behavior

- Ship the multi-run ownership index enabled with the change. It is a correctness prerequisite for
  queue routing and remains active even if the terminal-tail experiment is temporarily disabled.
- Use one injected internal coordinator switch only for tests and staged desktop validation. It is
  `false` in tests that assert the legacy path and `true` in the new focused suite.
- Before implementation is marked done, set the production default to `true`, run the Tauri-Pilot
  gate plus fresh runtime traces, and record that activation in the Progress Log.
- The switch and legacy bypass must be removed in the same follow-up after one release cycle with
  no run-mismatch, duplicate-commit, or ordering regression. It is not a permanent user setting.
- If exact-run terminality is unavailable, stale, or mismatched, preserve the active presentation
  and surface the existing recovery state. Do not silently early-flush the final visible mutation.
- No schema migration or server data cleanup is required for rollback.

## Deferred Follow-Ups

- Replacing the global direct engine SSE/Rust proxy path with a server event relay is explicitly
  deferred. It has materially different availability, auth, reconnect, and throughput risks.
- Broader cross-client event ordering guarantees belong to a later transport architecture proposal.
- First/pending-session sends need a separate server pre-start identity handoff (materialized
  OpenCode-session alias plus run identity before engine start) before they can join this
  guarantee. `pendingClientSessionId` and `clientMessageId` cannot identify engine SSE by themselves.
- Product copy may later distinguish "waiting for first output" from "stream still active", but
  that is not required for the terminal ordering contract.

## Progress Log

- 2026-07-19 — Plan rewritten after review. It now treats the tail as the last visible transcript
  mutation (not any assistant event), requires prepare/commit dedupe, gates terminal hydration and
  error turns, and uses the existing exact-run result with strict run-id equality. The terminal
  source is now named precisely as the server-mediated lifecycle-service response; a provisional
  pre-admission barrier closes the engine-start-to-HTTP-response race. Queue entries are now
  concurrent exact scopes with an explicit alias-owner handover, so queued B cannot steal A's
  stream or terminal tail. First/pending-session sends are explicitly deferred pending a server
  identity handoff.
- 2026-07-19 — Codebase re-audit added TEO01A: current lifecycle recovery, latest-run lookup,
  session status, and diagnostics are single-run and would otherwise discard A when B queues.
  The plan now includes multi-run ownership, per-run hydration guards, an explicit Stop target,
  and a separate fixture-backed Pilot CI step. No application code has been changed by this
  planning update.
- 2026-07-19 — Queue-handover contract tightened: matching terminality of A alone cannot transfer
  the shared alias to B. The coordinator must first expose A idle and commit A's held terminal
  display paths across the render boundary; B's already-started first event remains prepared until
  that handover point. This prevents a shared presentation from reactivating or rendering B before
  A's final text.

- 2026-07-19 — Implementation added the app-local terminal delivery coordinator, deferred
  prepare/commit delta handling, exact multi-run alias ownership, queued-run handover after A's
  render boundary, and a known-alias provisional binding before existing-session submit. Terminal
  hydration and error display now use the same boundary. Focused UI tests, UI typecheck, E2E
  fixture tests, and E2E typecheck pass. The fixture-backed desktop scenario is integrated into
  `session-run-truthfulness` and required in CI; local execution remains pending because the
  desktop launcher exited before Tauri-Pilot opened its named pipe.

## Completion Criteria

Set top-level `done: true` and `core_done: true` only when TEO00, TEO01A, and TEO01-TEO05 are
complete; focused tests and the separate required fixture-backed desktop workflow pass; a live
trace proves the visual order for a matching run; and no unresolved false-idle, queue-handover,
or newer-run regression remains. Until then, this document stays `status: in_progress` and `done: false`.
