---
title: Accepted Run Connectivity and Transcript Recovery Plan
date: 2026-07-13
status: implementation-complete-pending-dev-runtime-validation
done: false
repository_snapshot: live veslo-main worktree on 2026-07-13; pre-existing local changes preserved
depends_on:
  - docs/plans/2026-07-12-missed-sse-completed-run-recovery-plan.md
related_audits:
  - docs/plans/2026-07-13-send-receive-ui-flow-architecture-audit.md
related_plans:
  - docs/plans/2026-07-13-local-runtime-chain-stale-run-remediation-implementation-plan.md
  - docs/plans/2026-07-13-sidebar-session-activity-projection-implementation-plan.md
acr01_trace_and_contract_done: true
acr02_disconnected_accepted_run_done: false
acr03_terminal_transcript_retry_done: false
acr04_chat_workspace_scope_coverage_done: true
acr05_unit_and_dev_runtime_verification_done: false
---

# Accepted Run Connectivity and Transcript Recovery Plan

## Canonical Status

done: false

This is a narrow app recovery plan for two user-visible failures:

1. an accepted prompt remains in an infinite `Answering` state after the local
   Veslo server disconnects; and
2. a completed response from an older session does not appear in the selected
   transcript when the live stream or one terminal transcript read is missed.

The plan extends the existing accepted-run recovery owner. It does not change
the server's durable run ownership, queue semantics, OpenCode event contract,
or session data model. It does add a small, explicit UI recovery presentation
contract so a transport failure cannot remain visually indistinguishable from
an actively generating answer.

This revision incorporates the adjacent UI writer audit. It deliberately keeps
three concerns separate:

```text
accepted run + no usable Veslo server client
  -> one exact foreground server-only recovery, then connection-unavailable UI

durable terminal run + first canonical transcript recovery misses
  -> one exact retry, then transcript-unavailable UI

ordinary selected-session/history browse
  -> passive read; never earns server-start authority from visibility alone
```

Remediation status (2026-07-13): the code and focused regression coverage for
the review findings are implemented, but this plan is deliberately **not
complete**. The focused suite now passes 176 tests and app typecheck passes.
Fresh normal-dev-runtime traces are still required before ACR02, ACR03, and
ACR05 can be closed; no desktop E2E/Pilot or synthetic fault scenario is part
of that validation. The macOS server-exit cause remains explicitly outside this
app recovery slice.

This remediation closes four concrete gaps found after the earlier completion
claim:

- foreground recovery always revalidates through the connection owner, even
  when a stale HTTP client object already exists;
- the connection owner bounds the entire local ensure operation, including
  Tauri info/restart IPC, and reports a disconnected outcome on expiry;
- only the exact terminal recovery call site may replace stale live parts with
  an authoritative empty canonical snapshot; and
- a superseding run clears terminal-recovery state and its pending retry timer,
  even after the corresponding watch has already been removed; and
- an accepted first-session submit promotes an already-created same-run SSE
  watch to admitted ownership instead of losing foreground recovery to the
  admission/SSE ordering race.

## Audit Result

### Confirmed: accepted run plus disconnected local server can spin indefinitely

After a validated `submitted` result, the app admits the exact durable run to
the session lifecycle controller. The controller correctly avoids treating an
OpenCode `session.idle` event as final truth. It polls the durable run instead.

The status-poll read is deliberately passive: it does not start a disconnected
local Veslo server. When no client is available, the poll yields no status and
the admitted `submitted`/`running` presentation remains active. The default
watch remains active for 600 five-second attempts before it is merely marked
`exhausted`; it does not become a user-visible connection failure.

This explains the observed sequence:

```text
new session -> server becomes available -> submit is accepted
            -> local server disconnects -> status reads cannot resolve
            -> UI retains Answering instead of surfacing a connection problem
```

The defect is in app recovery/presentation. The reason the server itself
disconnects on macOS remains unproven without its correlated runtime trace.

### Confirmed gap, plausible cause of the historical-session symptom

The accepted-run fix already handles a missed OpenCode SSE terminal event when
the durable status and transcript are readable. It is therefore not correct to
add a second generic transcript catch-up loop.

However, once durable status is terminal, the one exact transcript-recovery
attempt can return `null` or throw. The app clears the busy state but does not
automatically retry that exact recovery. A later reselect or live reconnect can
cause another latest-run probe, but a user who remains in the older session can
be left with the final answer absent from the UI.

This is a code-level recovery gap and a strong match for the reported older
chat failure. It is not proof that the macOS event was caused by this path;
that still requires the incident trace.

### Chat and workspace session semantics

There is one conversation/run pipeline after a prompt is successfully sent.
Both targets receive a server-owned conversation, OpenCode session, durable
run, scoped transcript, and the same lifecycle recovery.

| Target | Execution scope | Product behavior |
| --- | --- | --- |
| Chat | App-managed private/scratch workspace | Isolated files, tools, configuration, and sidebar grouping. |
| Workspace chat | User-selected workspace directory | Uses that workspace's files, tools, configuration, MCP, and permissions. |

Before first successful submission, a pending draft is not a server session.
The app keeps one local pending draft body and target metadata. A recovery fix
must preserve the resolved target's exact workspace and directory; it must
never fall back to whichever workspace happens to be active after navigation.

## Owners and Non-Negotiable Contracts

- The orchestrator/server remains the only durable run lifecycle authority.
  The app never invents a completed or failed run because its local transport
  disappeared.
- OpenCode SSE remains the fast render path. Durable run status and the
  canonical transcript are the recovery truth after a missed event.
- The existing session lifecycle controller remains the single app owner for
  admitted-run observation, foreground connection recovery, terminal
  reconciliation, and terminal transcript retry. Do not add a second catch-up
  controller, global timer, or page-local recovery state.
- The only recovery identity/map key is the exact durable
  `(workspaceId, conversationId, runId)`. A recovery generation is a monotonic
  in-memory field of that record, used only to fence timers and late async
  results; it is never part of a durable identity or an additional map key.
  The record carries the resolved directory, UI session id, and OpenCode-session
  alias. No active-workspace fallback is allowed.
- `sendTraceId` is optional diagnostic correlation metadata captured at
  admission. It is not a recovery identity, routing input, or fallback. Every
  trace can instead be joined by the required run id and client message id.
- The server-start permission is an exact foreground recovery capability, not
  a property of a selected session. An ordinary `activeVisibleSelectedSession`
  transcript read remains passive. Remove/narrow the current visibility-only
  recovery opt-in as part of ACR02; it must not be a parallel way to start the
  local server.
- The one recovery start uses the existing desktop connection owner with
  `requireRuntimeChainReady: false`: it may restore the managed Veslo server
  client, but it must not require or manufacture a ready engine/runtime chain.
  That owner, not the lifecycle controller, owns one named deadline for the
  complete ensure operation, including desktop IPC info/restart calls.
- A lost local connection is an explicit presentation state, not `idle`, not a
  fabricated durable failure, and not an indefinitely active loader. Its
  lifecycle diagnostic is `connection-unavailable`. It is a recovery notice,
  not a streaming indicator: the footer is non-pulsing and says no
  `Answering`, the composer is recovery-blocked with Retry/Reconnect and no
  Stop action, and the sidebar is an inactive error row rather than a running
  spinner.
- A missing final transcript is likewise presentation-only. A terminal durable
  status remains terminal; after one exact retry, `transcript-unavailable`
  gives a non-destructive Retry action without adding a fake assistant turn.
  It is also a recovery notice rather than a streaming indicator: the composer
  returns to its normal send/queue mode and no Stop action is shown.
- The shared run presentation exposes this distinction explicitly: an active
  streaming state, a recovery-blocked composer state, and an idle composer
  state are separate from whether a recovery notice is visible. Do not derive
  Stop visibility or composer enablement from the legacy `isStreaming` boolean.
- A correlated `connection-unavailable` or `transcript-unavailable` diagnostic
  wins over stale session-status/workspace-busy mirrors in the sidebar
  projection and yields `active: false`, `phase: "error"`. The sidebar remains
  a read-only consumer.
- A reconnect, explicit Retry, or reselect may resume exact recovery. Duplicate
  SSE events, retries, and an old run must not replace a newer run's transcript.
- Selected-session passive hydration and exact terminal recovery have different
  authority. The existing selected-session passive read is discarded if newer
  SSE transcript activity was observed while it was in flight. An exact
  terminal snapshot may replace the cache only while its current run key still
  matches. This slice does not pretend that every direct/prefetch snapshot
  caller has that common arbitration yet; do not apply a global "SSE always
  wins" merge rule here.

### Implementation touchpoints

| Concern | Primary owner | Required consumer/test surface |
| --- | --- | --- |
| Exact server-only status recovery | `context/conversation-service.ts`, `context/session-lifecycle-recovery.ts` | conversation-service and lifecycle controller unit tests |
| Accepted scope, trace correlation, and wiring | `pages/session-send-workflow.ts`, `context/session.ts`, `app.tsx` | send-workflow/session-store unit tests and dev-runtime trace |
| Connection/transcript recovery presentation | `pages/session-run-presentation.ts`, `pages/session.tsx`, `components/session/composer.tsx` | pure presentation/session-page unit tests and manual walkthrough |
| Sidebar non-spinner recovery state | `context/sidebar-session-activity-projection.ts` | sidebar projection/token unit tests and manual walkthrough |
| Passive versus terminal snapshot eligibility | `context/session-selection-controller.ts`, `context/session-transcript-controller.ts` | selection/hydration unit tests |

The sidebar plan remains UI-owned and read-only: this plan changes only the
projection's interpretation of an exact lifecycle diagnostic. It must not make
the sidebar a run owner or add another busy/status writer.

## Implementation Plan

### ACR01 - Capture the macOS incident boundary and make it diagnosable

done: true

Work:

1. Carry the existing `sendTraceId` from accepted submit as optional
   `diagnosticTraceId` metadata on the admitted lifecycle record. It is never
   fed into `recoveryKey`, scope resolution, or a server request. Do not try to
   reconstruct it later from the active page or a mutable global trace.
2. Add one privacy-safe dev-runtime lifecycle-recovery trace callback beside
   the current in-memory session-status trace. It records exact run identity,
   client message id, app workspace identity, generation, connection snapshot,
   and recovery outcome. It joins the existing send-workflow trace when a trace
   id exists, and remains useful with run id/client message id alone. It does
   **not** log prompt text, bearer data, raw error bodies, or raw directory
   paths.
3. Record distinct outcomes for: status client unavailable, foreground recovery
   declined because the run is no longer selected, server-only ensure started,
   server-only ensure failed, refreshed status HTTP failure, terminal
   transcript unavailable, terminal transcript error, retry exhausted, and
   successful terminal hydration.
4. For a reproduction, collect the dev-runtime app send-workflow trace,
   session-status trace, server trace, and orchestrator trace from the same
   run. Correlate them by run id/client message id, with trace id as an optional
   convenience, and determine why the local server transitioned from connected
   to disconnected.

Acceptance:

- A future report can distinguish an unaccepted send, an accepted run with
  unavailable status, a terminal run with failed hydration, and a server-side
  failure without relying on UI screenshots.
- The admitted-run dev trace continues after the submit workflow returns; it
  can be joined by client message id and run id, plus trace id when available,
  without inferring context from whichever session is selected later.
- Diagnostics contain no prompt body, bearer, raw user filesystem path, or raw
  response body.
- This phase does not claim a server-crash root cause before the trace proves
  one.

### ACR02 - Turn disconnected accepted runs into bounded foreground recovery

done: false

Implementation revision (2026-07-13): `recoverAcceptedConversationRunStatus`
now always calls the connection owner before its exact re-read, including when
the existing client object is non-null. The lifecycle controller sends a
visible selected transport error through the same one-per-generation recovery
path as an unavailable client, then publishes `connection-unavailable` when
the refreshed exact read cannot succeed. The connection owner has one 15-second
deadline over desktop info/check/restart IPC and publishes a disconnected probe
on expiry. If an SSE observation creates the exact watch before first-session
submit returns, admission now promotes that record in place, restores its
client correlation, and starts the same foreground recovery path. Focused tests
cover a stale non-null client, a rejected transport read, the SSE-before-
admission race, and hanging info/restart IPC. A normal dev-runtime trace of
these paths is still required to mark this ACR done.

Work:

1. Keep `readConversationRunStatus` as the passive default. Add a separate
   exact-run executor (for example
   `recoverAcceptedConversationRunStatus(scope)`) rather than an optional
   broad "start server" flag on every status read. The executor receives no
   lifecycle generation/recovery key and owns no dedupe, timer, or TTL map;
   those remain in the lifecycle controller.
2. Invoke that operation only after a passive read returns unavailable **and**
   the admitted run is still the selected visible session/conversation. Check
   this condition both before the server start and after its asynchronous
   result. Background rows, historical browse, latest probes, and a session
   that was navigated away from never receive this capability.
3. The controller captures the exact durable run key and its current generation
   before calling the executor. The executor calls the existing desktop
   connection owner with
   `ensureLocalVesloServerRunning({ requireRuntimeChainReady: false })`, reads
   the refreshed client, then re-reads that same durable run. It does not start
   an OpenCode engine, resolve an active workspace, or use a generic runtime
   recovery path. It relies on the connection owner's one named deadline; the
   lifecycle controller adds no competing timeout.
4. Coalesce one server-only start per exact durable run key and current
   generation in the lifecycle record. A reconnect, explicit lifecycle Retry,
   or explicit reselect advances that record's generation; repeated passive
   polls do not. A new run supersedes, cancels, and clears all recovery state
   for the older run.
5. If the exact recovery still cannot read the run, retain the durable run
   identity but publish `recoveryState: "connection-unavailable"`. Do not set
   the session to `idle`, do not create a durable failure, and do not call a
   fake busy release merely to hide the UI.
6. Make the shared presentation contract explicit. A recovery notice is
   separate from the legacy streaming indicator so `isStreaming` cannot
   accidentally control Stop visibility or submit enablement:

   | Surface | `connection-unavailable` result |
   | --- | --- |
   | Session presentation/footer | `recoveryNotice: "connection-unavailable"`; no streaming indicator or `Answering` wording; error-styled and non-pulsing. |
   | Composer | `composerMode: "recovery-blocked"`; ordinary submit is disabled, Retry/Reconnect is available, and Stop is absent. |
   | Sidebar activity projection | `active: false`, `phase: "error"`; it overrides stale `submitted/running` session-status and workspace-busy mirrors for that exact diagnostic. |
   | Retry/Reconnect | Calls the lifecycle owner's exact resume method, never resends the prompt. |

7. Export one shared `SessionRunRecoveryState` union from the lifecycle owner
   and consume it from the run presentation and sidebar projection. Do not keep
   duplicate literal unions in page-level types.
8. Remove/narrow the existing `activeVisibleSelectedSession` transcript-read
   server-start opt-in. Visibility alone is not an accepted-run capability;
   normal history reads, including explicit history retry, remain passive.

Acceptance:

- If a send fails before acceptance, its existing visible error behavior is
  unchanged.
- If a send is accepted and the local server disappears, the user leaves the
  pulsing `Answering` presentation in a bounded time and sees the exact
  connection-recovery notice. The composer is neither a fake Stop control nor
  accidentally enabled by the old streaming boolean.
- If the server returns, the app reads the same durable run and either renders
  its transcript or presents its durable terminal failure.
- The app never starts a disconnected local server just because an old
  transcript is being browsed, a merely selected session is loaded, or a
  background status is polled.
- An unrelated workspace/session, an old run, or a post-navigation async
  completion cannot resume, clear, hydrate, or present this run.
- The sidebar has no running spinner after this exact state, even if legacy
  status/busy mirrors still say `submitted` until durable truth becomes
  readable again.

### ACR03 - Retry exact terminal transcript hydration without navigation

done: false

Implementation revision (2026-07-13): selected-session hydration keeps its
existing live-part preservation by default. The lifecycle's exact terminal
callback instead passes `preserveLiveParts: false`, so an authoritative terminal
snapshot is allowed to clear stale partial content without creating a global
merge rule. Superseding an accepted run now separately clears every terminal
recovery record for that conversation, including a retry timer left after its
watch was cleared. A healthy terminal transcript read now stays direct; only a
missing client or direct transport error falls back to the owned server-only
ensure path. Focused tests cover the empty-terminal-snapshot, old-terminal-
retry cancellation, healthy direct terminal read, and stale-client fallback
contracts. A normal dev-runtime terminal transcript trace is still required to
mark this ACR done.

Work:

1. Keep terminal status reconciliation separate from transcript hydration: a
   valid durable terminal status releases its matching active run presentation,
   while transcript recovery becomes a separately stored operation under the
   same exact run key.
2. Replace the current one-shot `terminalHydrations` behaviour with one small
   per-run-key state record: current generation, first-attempt result, retry
   timer or in-flight promise, and outcome (`pending`, `hydrated`, or
   `unavailable`). It replaces rather than duplicates the old one-shot set.
   On success it clears only transient timer/promise state and retains the
   `hydrated` outcome as idempotency protection; the record is removed only on
   superseding accepted run, scope loss, or controller disposal.
3. Make at most one automatic retry of the exact
   `recover -> fetch canonical snapshot -> hydrate` sequence after a failed
   first attempt. Use one named bounded delay constant and no recurring
   transcript poller. The public Retry action starts a new exact recovery
   generation; it never resends the prompt or retries a different/latest run.
4. If no server client is available at terminal hydration, retain the pending
   exact operation and join the ACR02 foreground connection-recovery path. Do
   not start a second server recovery mechanism. If the server is reachable but
   both exact attempts return no safe snapshot, publish
   `recoveryState: "transcript-unavailable"` with a non-destructive Retry
   action. Its presentation is `recoveryNotice: "transcript-unavailable"`, no
   streaming indicator/Stop action, and `composerMode: "idle"`; the sidebar
   remains an inactive error row.
5. Fence every timer, retry, and asynchronous snapshot by exact run key and the
   newest admitted generation for that conversation. Retarget a valid OpenCode
   alias snapshot only to its existing UI session. A late old completion must
   be a no-op before either UI state or cache hydration.
6. Do not introduce a partially wired generic snapshot-origin API in this
   slice. The terminal recovery callback may hydrate only after its exact
   run-key/generation fence passes. Existing selected-session passive reads
   retain their read-bound SSE-observation fence. SR06/SR07 owns the later
   central migration of every passive/direct-live snapshot caller; do not solve
   it here with a generic text merge or a flag that only some callers honor.

Acceptance:

- In an already-open older session, missing the final SSE event and failing the
  first transcript read still renders the persisted assistant response after
  bounded recovery or reconnect, without switching chats.
- Existing selected-session passive fallback keeps discarding a result when SSE
  observation changed during that read. A matching exact terminal snapshot
  remains permitted to repair the cache after its run/generation fence passes.
- A duplicate terminal event after successful hydration is a no-op; it does not
  fetch or overwrite the transcript again.
- An old completion cannot hydrate over a newer send in the same conversation.
- Failed/aborted terminal runs release their matching indicator but do not add
  a fake assistant response.
- A reachable server with two safe-snapshot misses yields one exact
  `transcript-unavailable` notice and one Retry action, not a silent absence,
  generic poll loop, second submit, or an inactive-but-hidden terminal error.

### ACR04 - Preserve private Chat and workspace scope identity

done: true

Work:

1. Capture the exact resolved scope at admission and reuse that stored scope at
   passive poll, foreground recovery, reconnect, Retry, and terminal hydration
   boundaries. Do not re-resolve recovery through a generic helper that may
   fall back to the current active workspace.
2. Add/retain a fail-closed exact-scope resolver for selected historical/latest
   probes. It requires trustworthy workspace, directory, and conversation
   identity; it may not synthesize them from the selected route id or active
   workspace.
3. Check selected visibility by the admitted UI/OpenCode/conversation aliases,
   but never change the stored workspace/directory just because navigation
   changed while a recovery promise was in flight.
4. Cover both a private Chat scratch workspace and a regular workspace-bound
   session in the focused scope matrix and manual dev-runtime walkthrough.
   Treat them as the same run protocol with different valid target roots.
5. Reject recovery when an old session lacks a trustworthy scope; surface a
   scope/readiness diagnostic instead of sending or hydrating through the
   current active workspace.

Acceptance:

- Changing workspaces while a recovery is pending cannot retarget its server
  read, transcript, busy state, or Retry action.
- A private Chat never adopts a workspace-chat transcript, and the reverse is
  also impossible.
- The behavior is identical for a materialized first session and an existing
  historical session once their exact identities are resolved.
- A recovery with incomplete scope fails closed even when another workspace is
  active and healthy.

### ACR05 - Focused unit contracts and dev-runtime manual verification

done: false

Earlier normal-dev-runtime trace `manual-runtime-20260713-165154-pnpm-dev`
recorded all of the following without a test-only fault:

- a submit begun with `vesloServerStatus: disconnected` and no cached client;
  the existing connection owner restored the runtime, the original submit was
  accepted, and the durable run terminalized without resending the prompt;
- a first-session run that received an in-flight SSE `APIError`/invalid bearer
  observation, then resolved to durable `completed` and
  `terminal-transcript-hydrated`; and
- subsequent existing-session runs whose assistant text events reached the UI
  trace and whose terminal state released the run presentation.

It predates the remediation above and therefore cannot close its new runtime
acceptance criteria. Current focused verification passes 176 tests across
lifecycle, conversation service, selection, transcript, sidebar,
run-presentation, send-workflow, and connection-owner contracts; app typecheck
passes. The complete app suite was also run after the earlier slice. It still has 16
pre-existing failures in unrelated source-contract areas (workspace browse,
sidebar sync, pending-instance/skill confirmation, app routing/server-state,
archives, send-boundary validation, queue, and modularization). They are
documented rather than changed here because they are outside this narrow
recovery ownership boundary.

This slice adds no automated desktop scenario, isolated desktop fixture, or
test-only fault injection. The regression gate is focused unit coverage plus
the correlated normal-dev-runtime trace above.

Work:

1. Add focused controller/service/presentation tests for:

   - passive `readConversationRunStatus` and every browse/history read cannot
     start the local server, including a merely selected visible session;
   - a no-client admitted visible run starts at most one server-only
     (`requireRuntimeChainReady: false`) recovery per run key/generation and
     then reaches the non-streaming `connection-unavailable` presentation;
   - an explicit exact Retry/Reconnect advances generation once, while repeated
     passive reads do not; a superseding run or late completion is a no-op;
   - composer/footer/sidebar consume the explicit recovery notice/mode:
     connection loss has no Stop and blocks ordinary submit, while terminal
     transcript loss has no Stop and restores normal composer mode;
   - terminal snapshot `null`/throw retries once, hydrates only the current
     exact run, and retains a successful outcome against duplicate terminal
     events;
   - private Chat, workspace chat, incomplete scope, foreign scope, queued
     run, and workspace/session switch preserve the exact-scope fence; and
   - existing selected-session passive snapshot/SSE-observation fencing remains
     covered without claiming the broader SR06/SR07 migration is complete.

2. Use the existing dev-runtime trace surfaces. Before manual testing, enable
   the send workflow trace in the desktop devtools:

   ```js
   localStorage.setItem("veslo.sendWorkflowTrace", "1");
   window.__vesloSendWorkflowTraceConsole = true;
   ```

   After each relevant run, preserve the matching
   `window.__vesloDumpSendWorkflowTrace?.()` output,
   `window.__vesloSessionStatusTrace`, and the server/orchestrator logs. The
   lifecycle trace added in ACR01 must include run id, client message id,
   generation, connection snapshot, and outcome so it is useful after submit
   has returned.

3. Manually walk the following real dev-runtime cases when they recur; do not add a synthetic
   runtime fault just to make a case reproducible:

   | Case | Manual action | Required observed result |
   | --- | --- | --- |
   | Private Chat connection loss | Create a new Chat, submit successfully, then reproduce/observe the red or unavailable local server boundary. | The same accepted run leaves pulsing `Answering` within the owner deadline; no Stop, composer is recovery-blocked, sidebar is inactive/error. |
   | Workspace-chat connection loss | Repeat in a normal workspace session, including an older reopened session. | The exact workspace/directory/run is retained; no other row or workspace is affected. |
   | Exact reconnect | Restore the local server and press Retry/Reconnect. | Only the original run id/client message id is re-read; the prompt is not resent. |
   | Scope fence | Switch session or workspace while a recovery is pending, then return. | A late old result changes neither the newly selected transcript nor its sidebar/run presentation. |
   | Terminal transcript recovery | When the dev runtime naturally reproduces a missed terminal stream or first transcript-read miss in an already-open older session, keep it selected. | One exact retry hydrates the canonical answer, or one visible `transcript-unavailable` notice remains with Retry; no fake assistant turn appears. |

4. Treat the manual walkthrough as trace-backed diagnosis, not as proof of an
   unobserved server-crash cause. If the terminal-transcript case cannot be
   reproduced manually, its deterministic behavior remains proven by the unit
   tests and the runtime log records the limitation.

Verification required before marking this plan complete:

```powershell
# Run all 176 ownership-critical focused tests first.
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm `
  src/app/context/session-lifecycle-recovery.test.ts `
  src/app/tests/context/conversation-service.test.ts `
  src/app/tests/context/session-selection-controller.test.ts `
  src/app/tests/context/session-transcript-controller.test.ts `
  src/app/tests/context/session-transcript-hydration.test.ts `
  src/app/tests/context/sidebar-session-activity-projection.test.ts `
  src/app/tests/context/veslo-server-connection.test.ts `
  src/app/tests/pages/session-run-presentation.test.ts `
  src/app/tests/pages/session-send-workflow.test.ts

# The complete app unit suite was also run. Its 16 unrelated pre-existing
# failures are recorded above and are not a gate for this recovery slice.
corepack pnpm@10.27.0 --filter @neatech/veslo-ui test:unit

# Start the normal dev runtime, enable the two devtools trace surfaces above,
# and complete the manual table with the matching app/server/orchestrator logs.
corepack pnpm@10.27.0 dev

git diff --check
```

## Explicitly Out of Scope

- Diagnosing or fixing the root cause of a macOS Veslo-server exit without a
  correlated runtime trace.
- Changing server/orchestrator durable run ownership or terminalization rules.
- The separate server cold-transcript-seed versus canonical-ingest writer race
  (SR09 in the related audit). Record it as a server-owned follow-up; do not
  reintroduce a UI durable writer to compensate for it.
- Replacing OpenCode SSE or building a new global transcript polling service.
- The broad direct-live/full-read cache arbitration work beyond the explicit
  selected-session-versus-terminal boundary in ACR03. That remains the SR06/
  SR07 follow-up slice in the related audit and is required before claiming
  global transcript-cache race closure.
- Altering durable queue behavior, model execution, Chat product semantics, or
  private-workspace retention.
- Starting local servers for ordinary history browsing or background status
  reads.
- Adding a synthetic runtime fault, a special desktop test profile, or another
  automated desktop test harness for this slice. Diagnosis is via the normal
  dev runtime and correlated logs.

## Completion Checklist

- [x] The accepted-run connection-loss path has an explicit bounded user state,
  not an infinite `Answering` indicator.
- [x] A terminal transcript hydration miss retries safely without reselecting
  the old chat.
- [x] Recovery remains exact-run and exact-scope fenced across Chat and normal
  workspace sessions.
- [x] A passive/visible browse read cannot obtain server-start authority; only
  the exact foreground admitted-run recovery can.
- [x] `connection-unavailable` is non-pulsing and non-abortable in the session
  view, has no Stop action, blocks ordinary composer submit, and is
  non-active/error in the sidebar without mutating durable truth.
- [x] Terminal transcript retry is bounded, cancellable on supersession, and
  retains successful terminal hydration as duplicate-event idempotency.
- [x] Focused unit contracts (176) and app typecheck pass. The complete app
  unit-suite result has 16 unrelated pre-existing failures, recorded above.
- [ ] Fresh normal dev-runtime traces exercise the remediated stale-client
  recovery and terminal snapshot paths. No special test runtime or synthetic
  fault injection may be added.
- [x] The macOS incident's server-exit cause is explicitly recorded as
  unresolved outside this app-recovery slice.
