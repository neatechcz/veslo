---
title: Runtime Projection Isolation, Durable Startup Status, and Legacy Queue Safety Plan
status: implemented
done: true
date: 2026-08-03
issue: unlinked
scope: prevent cross-conversation UI projection, make durable queue state readable during lifecycle startup, preserve safe legacy-owner handling, retain one OpenCode message id across a queued retry, and reject legacy queue work when its lifecycle owner is unavailable
related:
  - docs/plans/2026-08-02-terminal-runtime-owner-loss-root-cause-plan.md
  - docs/plans/2026-08-01-conversation-run-lifecycle-ownership-plan.md
  - docs/dev/conversation-workflow-contract.md
  - docs/dev/opencode-workspace-runtime-architecture.md
---

# Runtime Projection Isolation, Durable Startup Status, and Legacy Queue Safety Plan

## Decision

Address four related, but distinct, runtime safety concerns without moving
lifecycle ownership into the desktop app:

1. prevent a session switch from rendering a previous conversation's transcript
   under the newly selected conversation;
2. make server-owned durable queue and terminal-handoff state readable while
   the orchestrator lifecycle owner is still starting;
3. retain the existing fail-closed treatment of historical engine owners whose
   identity cannot be proven gone; and
4. give each queued run one stable OpenCode admission message id across a
   failed submit and retry.
5. prevent the standalone legacy topology from retaining work that only the
   daemon lifecycle owner can safely dispatch.

This enriches the existing ownership model. The desktop app remains a
projection and intent client. The server remains the queue, admission, release,
and status-projection owner. The orchestrator remains the owner of exact engine
generation evidence. No change may replay a prompt, infer engine death from an
empty in-memory pool or timeout, or create a second queue.

### Legacy topology boundary

The durable queue, reservation, terminal-handoff, and successor-dispatch
contract requires a lifecycle owner. A local standalone runtime without that
owner is therefore not a degraded queue implementation:

- queue-only work is rejected with the existing draft-restore result and no
  durable queue row;
- a direct legacy submit remains supported without creating a durable
  reservation that cannot later be observed or released; and
- a failed direct legacy submit releases its transient reservation before the
  caller can retry.

This is deliberately narrower than the daemon path. It neither weakens its
FIFO/barrier guarantees nor creates a UI-side fallback queue.

## Implementation posture and current state

This is the implementation and validation record for one coherent feature,
not a claim that a partially changed working tree is releasable. The current
tree contains the following slices:

| Slice | Implemented contract | Verification recorded |
| --- | --- | --- |
| Transcript projection | Ordinary sidebar navigation no longer retains the previous session's transcript. | Focused identity tests and three historical-conversation desktop continuations passed. |
| Durable startup status | The server reads one durable queue/reservation/barrier snapshot and returns `durable-startup` only for a durable queued subject. | Decision-matrix and sequencing coverage passed. |
| Lifecycle read coordination | Latest reads are keyed by selected scope and generation; a durable startup answer defers one later readiness read without polling. | Focused controller coverage and the full quality gate passed. |
| Queue-list projection | The queue-list reader is a separate, read-only UI projection with per-scope request coalescing, a monotonic per-selection epoch, fail-closed item correlation, and active-scope retention. | Unit race/retention coverage and desktop proof passed. |
| Queue retry identity | The first claim persists an OpenCode admission id and later claims reuse it. | Controller, queue-store restart, and headless-service coverage passed. |
| Historical owner safety | Generation authority remains fail-closed and barriers remain durable. | Focused authority/restart coverage passed independently of the desktop proof. |
| Legacy no-owner safety | Queue-only work is rejected; direct legacy work cannot strand a durable reservation. | Controller and headless-service coverage passed. |
| Historical desktop exercise | The real-desktop scenario runs its causal trace verifier automatically. | Three consecutive continuations passed with one direct admission, one submit, completed handoff, and no scoped error; a separate fresh-process repetition passed with the same causal evidence. |

The rows above are implemented and verified on the current tree. This is an
implementation record, not a release record: release preparation, tagging,
and publication remain separate operations. A route-local fallback and a
UI-local probe guard do not by themselves establish a second status owner;
they are only adapters around the existing server and orchestrator owners.

### Evidence boundary tightened by the audit

The current historical-conversation scenario correctly proves visible behavior,
but its artifact contains only a workspace label and OpenCode session ids. It
does not itself prove the server-side admission path for the continuation.
Also, a shared developer profile can contain old queue rows and startup
reconciliation errors for other workspaces. Treating every record in the
runtime log as evidence about the scenario would create false failures; simply
ignoring all runtime errors would create false passes.

The remaining desktop work therefore has two separate proofs:

1. a **cold desktop-process proof** that resets only process-local projection
   state while preserving the deliberately historical conversations; and
2. a **causally scoped trace proof** that derives the continuation workspace,
   conversation, run, and admission result from the scenario's exact OpenCode
   session and timeline. It must fail closed if those identities cannot be
   derived. Errors for a different workspace or conversation are retained as
   operational diagnostics, but cannot be attributed to this scenario.

This does not weaken the server-error requirement. It makes the requirement
testable against the operation that the scenario actually caused.

### Status projection decision matrix

The route must make one decision from a single read-only durable snapshot and
the lifecycle request. This matrix is the compatibility contract for both the
desktop coordinator and future callers.

| Lifecycle client/result | Durable queued subject | Route result | Client action |
| --- | --- | --- | --- |
| No lifecycle client | Yes | `durable-startup` snapshot | Render server-owned queued/blocked state; retain one deferred read only. |
| Lifecycle client returns no scoped run | Yes | `durable-startup` snapshot | Same as above. |
| Lifecycle client returns a status | Any | `lifecycle` status | Prefer lifecycle truth; exact-run watch owns later observation. |
| Lifecycle HTTP/auth/protocol/timeout error | Any | Existing typed error | Retain bounded diagnostic evidence; do not fall back. |
| No lifecycle client | No | `lifecycle_unavailable` | Do not fabricate history, queue state, or a retry timer. |
| Lifecycle client returns no scoped run | No | `run_not_found` | Do not fabricate history, queue state, or a retry timer. |

`observationSource` is additive for rolling desktop/server upgrades. A client
that does not receive it must keep the pre-existing lifecycle behavior; only
an explicit `durable-startup` value changes scheduling.

### Decisions tightened by the code audit

The implementation must make the following boundaries explicit. They are not
optional polish; omitting one would either create a second owner or mask an
ambiguous failure as a safe startup result.

1. **A durable fallback is not a transport-error fallback.** The route may
   return a durable snapshot when there is no lifecycle client or when the
   lifecycle owner authoritatively returns no scoped status. A lifecycle HTTP,
   authentication, protocol, or timeout failure remains an error. Returning an
   old queue row after such a failure would make an unknown current lifecycle
   look safely deferred and could hide a live run.
2. **A barrier is a conversation admission fence, not a synthetic historical
   run status.** For `latest`, the snapshot selects the oldest active fence for
   the same workspace and conversation and attaches it only to the selected
   queued successor. An active fence is one in `observed`,
   `evidence_requested`, or `unresolved`; the serialized presentation may say
   pending or unresolved, but the admission rule blocks on all three. An exact
   historical request may read its own fence only to enrich a real lifecycle
   response. An exact request without a durable queue subject retains the
   existing lifecycle-route outcome; this plan does not invent a queued or
   terminal status merely to display an old barrier. A `latest` response with
   no durable subject must not fabricate a status merely because a fence exists.
3. **Desktop readiness is a scheduling hint, never lifecycle truth.** The
   controller may derive a local edge counter when the connection readiness
   value changes and use that edge to issue one new read. This is not a
   server-issued generation or proof of engine health. It may not clear a queue
   row or treat readiness as permission to drain a queue.
4. **A settled latest read has distinct dedupe lifetimes.** Its in-flight
   promise is released in `finally`. A successful non-terminal lifecycle
   result remains settled for that selection; its normal exact-run watch owns later
   observation. A `durable-startup` result retains one current-selection
   deferred record and is eligible for one read only after a later readiness
   edge. A terminal result remains suppressed until its correlated transcript
   hydration either settles or is discarded. A failed read must not create a
   selection-effect retry storm: only an explicit reconnect signal or a later
   readiness edge can make another automatic read.
5. **The historical desktop proof must exercise a real transcript switch.**
   It needs two distinct persisted chats in a disposable workspace, reopening
   the older visible sidebar row, proof that the interlude transcript is absent,
   and a continuation that reaches a new assistant turn without a visible app
   or assistant error. A source-contract test is supporting evidence only.
6. **A visible queue is not automatically a client-cache defect.** The server
   queue store intentionally survives an app, server, or orchestrator restart;
   a fresh desktop process can therefore correctly display a previously
   accepted pending item. UI-only signals such as `runStateBySessionKey`, the
   queue-list read model, and latest-run aliases are process-local and must be
   discarded or replaced by a matching scoped read. Diagnosis and tests must
   first establish whether a displayed item has a current durable queue row.
   The fix must never hide a real server row just to make a reopened chat look
   idle.
7. **The two read models have different jobs but the same identity boundary.**
   The latest-run coordinator reads the current status projection and may
   schedule one bounded readiness follow-up. The queue-list projector lists
   durable rows and may poll only while its *current scoped list* contains a
   waiting row. Neither may publish unless the response still matches the full
   `(workspaceId, conversationId, uiConversationKey, selectionGeneration)`
   captured for that request. The queue-list controller needs an explicit
   selection epoch for this: its current scope key alone cannot distinguish an
   A -> B -> A re-entry. Neither read model owns admission, dispatch, release,
   or retry.

## Verified evidence and boundaries

| Observation | Verified meaning | Correction owner |
| --- | --- | --- |
| A newly selected session briefly displayed six messages from the prior session while its own transcript was empty. | Desktop presentation deliberately retained `lastPaintedMessages` across a different session. This is a cross-scope projection defect, not a server queue row. | Desktop session projection boundary. |
| The affected historical conversation has two durable pending rows with different client-message ids and creation times. | They are two independent user intents, not one client retry or a UI cache artifact. | Server queue/lifecycle coordinator. |
| Both rows wait behind a terminal run with an attached historical owner but no generation record. | Generation authority returned `generation_not_found`; this is intentionally ambiguous and must remain fail-closed. | Orchestrator engine-generation authority, consumed by the server. |
| During startup the app issued repeated latest-run probes and received `lifecycle_unavailable`. | Before this slice, the status route rejected before it read durable queue, reservation, or handoff state. The target is one read-only durable snapshot for a proven queued subject; UI readiness remains only a scheduling input, not an injected read gate. | Server status projection first; desktop read coordinator second. |
| A focused queue test fails when a failed queued submit is retried. | The retry receives a new OpenCode message id because it is derived from a new claim timestamp. This breaks the intended idempotence contract even though it is not proven to have caused the observed UI incident. | Server queue/admission coordinator. |
| A status route assembled queue, reservation, and barrier information through separate store reads. | A concurrent claim/release can make a response describe a queue item and a barrier that did not coexist. The read path is safe only if it returns one durable snapshot. | Server queue-store snapshot reader. |
| Latest-run probing is reachable from selection, explicit selection completion, and reconnect paths. | They need one shared in-flight promise keyed by full selected scope and generation; a scope-only guard cannot represent a settled outcome or selection change. | Desktop lifecycle read coordinator. |
| The queue list is fetched independently from latest-run status and retains rows in a process-local read model. | Its fetch is already coalesced and checks the captured UI conversation key before replacing a scope, but that key is insufficient for an A -> B -> A return to the same conversation. It is not durable state and cannot explain a row after a fresh process unless the server list still returns it. | Queue-list projection boundary. |
| Status and queue responses carry workspace and conversation identities, but the lifecycle controller currently narrows its local status type before publication. | The response identity must be checked at the service/projection boundary before remembering a latest run id or publishing UI state; route/path matching alone is not a sufficient client-side regression guard. | Conversation-service and desktop projection boundary. |

### Audit amendments before release

The following two details are material implementation boundaries discovered by
reviewing the current code. They refine the completed slices; neither permits a
new UI lifecycle owner or a second queue.

1. **A SQLite snapshot is not atomic with an external lifecycle read.**
   `readConversationRunStatusSnapshot` correctly makes the queue row,
   reservation, and handoff barrier mutually coherent inside SQLite. The route
   currently obtains that snapshot before asking the external lifecycle owner,
   however. If it then serializes a successful lifecycle answer together with
   terminalization or handoff details from that earlier snapshot, the response
   can contain two observations from different moments. It must not be
   described as one atomic status. For a lifecycle client, the route must:

   - call lifecycle first and propagate any lifecycle transport/auth/protocol/
     timeout error without a durable fallback;
   - if lifecycle returns a status, take **one new** read-only durable snapshot
     afterwards solely to enrich that same run, or omit the optional durable
     adjunct when no matching post-read subject exists; and
   - if lifecycle returns no scoped status, take one snapshot and use it only
     for the existing `durable-startup`/`run_not_found` decision.

   When no lifecycle client exists, one snapshot remains sufficient for the
   existing `durable-startup`/`lifecycle_unavailable` decision. This preserves
   the no-fallback-on-error rule and gives every serialized durable adjunct a
   clearly named observation point.
2. **A selection-fenced UI projection still needs bounded retention.**
   The queue-list controller prevents a late A response from publishing after
   A -> B -> A because it captures the selection generation. Its backing
   `serverQueuedRuns` signal nevertheless retains projections for prior
   selections, although only the active selection reads them. Those rows are
   not a cache needed for correctness: a later visit must obtain a new scoped
   server answer. The projection owner must retain at most the active selection
   plus an explicitly correlated same-submit row while its admission result is
   being reconciled. On selection change it must evict older presentation rows;
   in-flight reads remain harmless because their full-scope fence discards
   them. This is a bounded presentation cache, not a durable queue mirror.

These amendments make the observation-time and memory-lifetime contracts
testable. They do not alter FIFO admission, durable retry identity, barrier
ownership, or the server's ability to return a real pending row after a later
reopen.

### Follow-up change map

Keep these as two small owner-local changes. They must not be folded into the
composer, transcript controller, or generic runtime recovery.

| Owner | Minimal implementation | Regression proof |
| --- | --- | --- |
| Server conversation-run status route | Move the existing durable snapshot read behind the successful lifecycle read; retain a single snapshot only for lifecycle-absent and lifecycle-null decisions. Keep the existing serializer and response union. | A sequenced lifecycle/store fixture proves success uses the post-read snapshot, null uses one fallback snapshot, and a typed error performs no fallback read. |
| Queue-list presentation owner | Give the existing projection model one explicit active-scope replacement/eviction operation. `SessionView` supplies the selected scope and continues to delegate fetch coalescing to the current controller. | Unit test navigation across many scopes, A -> B -> A late response, and same-submit materialization; one desktop check proves a real durable row still returns after reopen. |

The server change is P0 because it prevents a misleading mixed-time response.
The bounded UI retention is P1 because it is presentation-only after the
server's durable answer is already correct.

## Target ownership

| Concern | Authoritative owner | Desktop role |
| --- | --- | --- |
| Visible transcript and local optimistic row | Session projection boundary | Render only entries proved to belong to the selected conversation; use an identity-neutral loading state otherwise. |
| Queue ordering, reservation, dispatch, retry identity, and release | Server queue/lifecycle coordinator and queue store | Submit an intent and render the returned status. Never create, clear, reorder, or retry durable queue work. |
| Read-only durable status during orchestrator startup | Server conversation-run status projection | Request the current selected scope once; treat a proven durable snapshot as non-error UI state. |
| Read-only queue-list presentation | Server queue-list route | Replace only the currently captured `(workspace, conversation, UI key, selection generation)` list; reject an item whose durable workspace or conversation differs before it can inherit UI identity. |
| Exact engine state and historical owner loss | Orchestrator engine-generation authority | Never infer terminality or owner loss. |
| Runtime readiness transition | Server/orchestrator boundary | Receive a readiness signal and use it only to schedule a fresh scoped read. |

## Invariants

1. Every visible transcript row, optimistic row, spinner, queue badge, and
   retry control has the selected `UiConversationKey`, or has an explicit
   same-submit source-to-destination proof. Ordinary sidebar navigation never
   qualifies for that exception.
2. A pending server queue row remains durable until a server-owned submit,
   explicit cancellation, or terminal failure decision. Selecting a session,
   reconnecting SSE, mounting UI, and retrying a status read change none of it.
3. The server may return a read-only durable snapshot while lifecycle ownership
   is unavailable, but it must not admit work, start an engine, change a
   reservation, or claim terminality in that path.
4. A terminal historical run cannot release a successor merely because a new
   orchestrator has no pool entry. Its exact generation must be proven gone,
   or the barrier remains unresolved.
5. A historical owner without a generation record may be adopted as
   `exited_confirmed` only when its stored PID is proved absent. A present,
   reused, or uninspectable PID remains ambiguous.
6. A queued run receives one durable OpenCode admission message id at its first
   successful queue claim. A later submit retry, controller restart, or
   recovery must reuse it.
7. An unresolved terminal-handoff barrier is durable and bounded. Server
   startup and UI navigation do not recreate a polling loop or implicit retry.
8. Every durable adjunct in a status response is derived from exactly one
   read-only durable snapshot. A lifecycle result is a separate observation;
   when it is present, any durable adjunct is read only after that lifecycle
   observation. A snapshot may contain a barrier only when that barrier is the
   one currently preventing the reported conversation's next admission. A
   response never combines arbitrary durable rows chosen at different database
   moments or labels mixed-time lifecycle/durable evidence as one observation.
9. There is one app-side lifecycle-read coordinator. Selection, reconnect, and
   explicit session selection request work through it; none calls the status
   endpoint directly or independently decides when a deferred read is fresh.
10. The lifecycle status result and every queue-list item are checked against
    the captured workspace and conversation before they update alias memory,
    diagnostics, a visible badge, or transcript recovery. A queue-list item
    is additionally fenced by the captured UI key and selection generation;
    it must not inherit those values from a response for another durable
    conversation. A `latest` request may resolve a different *run id*, but
    never a different conversation.
11. A fresh UI process starts with no local run presentation or queue-list
    rows. Anything it renders after startup is either a local same-submit
    intent or a newly read, identity-matching server result.

## Explicit non-goals

- No generic app-side lifecycle or queue recovery manager.
- No automatic resolution of an ambiguous historical owner.
- No support/admin force-release command in this implementation. Such a command
  needs a separately approved authorization, audit, and irreversible-effects
  contract; it must never be disguised as ordinary retry.
- No persistence of transient UI run presentation as a substitute for durable
  server state.

## Implementation sequence

The phases below are ordered by ownership, not by UI visibility. P0 through
P5 describe the implementation that was required. The final section records
the completed acceptance evidence so a later reader can distinguish verified
implementation from a separate release operation.

### P0 - Freeze causal regressions and durable retry identity (implemented and verified)

The deterministic tests are the regression boundary for the implemented
behavior. Backfill any missing case before changing a failing owner slice.

1. Replace the existing source-contract test that intentionally expects the
   prior transcript to remain visible after an active-to-active session switch.
   Test session A -> empty/loading B and assert that no row, queue presentation,
   or run indicator from A can render under B.
2. Add a selection/controller test with rapid startup selections and delayed
   transcript or lifecycle responses. Only the final selected identity may
   publish a transcript, status, or retry affordance.
3. Add a queue test where the first claimed `prompt_async` submit fails, the same durable item
   is returned to pending, and the second claim reuses the identical OpenCode
   message id. Repeat over a fresh queue-store/controller instance to prove
   restart persistence.
4. Add a server status-route test with lifecycle ownership unavailable and a
   durable queued successor plus an unresolved handoff barrier. Assert a safe
   read-only snapshot, no lifecycle request, no queue mutation, and no provider
   submit.
5. Add a desktop recovery-controller test that consumes that durable startup
   snapshot, renders its queue/handoff presentation, and does not arm or
   re-arm a lifecycle polling timer before readiness changes.
6. Add the complement: lifecycle ownership unavailable with no relevant durable
   queue subject must preserve the existing `lifecycle_unavailable` outcome;
   an owner that authoritatively has no scoped run must preserve
   `run_not_found`. Neither path may synthesize a run or select an arbitrary
   historical queue row.
7. Add snapshot fixtures for both sides of a claim or release boundary. Each
   read must return only queue, reservation, and barrier values from one
   durable state, never a mixed combination. Keep the implementation in one
   read-only SQLite transaction; do not write a fake concurrent unit test for
   a synchronous store. Add a second test with two unresolved barriers:
   `latest` must expose the oldest fence for its own conversation, and an exact queued successor may
   expose only that same conversation's currently blocking fence.
8. Preserve the existing legacy-generation tests: absent PID may establish
   `lost_proven`; present, reused, or uninspectable PID cannot release work.
9. Add a response-correlation test at the conversation-service boundary:
   reject a status result whose workspace or conversation differs from the
   requested scope before it is remembered as the latest run or reaches the
   lifecycle controller. Add the equivalent queue-list fixture with a foreign
   item and assert that it cannot enter the visible projection.
10. Add a cold-process test matrix with an empty local read model: (a) no
   durable row means no queue or busy presentation after historical reopen;
   (b) one durable pending row is shown once, with its server queue id; and
   (c) a durable row for another conversation is never shown. This separates a
   real durable intent from a stale client projection without relying on a
   browser refresh as proof.
11. Add a deterministic queue-list race test: start a list read for A, switch
    to B, return to A, complete the first A read after the re-entry, then
    complete the current A read. Only the current A epoch may replace the list
    or schedule polling. This must cover the same UI key, not merely A -> B.
12. Add a bounded-retention test: visit enough distinct conversations to exceed
    the old local projection count, then assert the UI store retains only the
    active selection and any explicitly correlated same-submit row. Reopen a
    prior conversation and prove that its visible queue row comes from a fresh,
    matching server list rather than retained local presentation.
13. Add a route sequencing test for the three lifecycle cases: successful
    status reads its optional durable adjunct from a post-lifecycle snapshot;
    null status reads one fallback snapshot; typed lifecycle error reads no
    fallback snapshot and returns the same typed error. Include a changed
   reservation/barrier fixture between the external call and the second read.
14. In the no-lifecycle local topology, reject queue-only work before queue
    persistence. Cover a successful direct legacy follow-up and a failed direct
    legacy submit so neither can leave a durable reservation that a missing
    lifecycle owner cannot resolve.

### P1 - Make session projection identity-safe (implemented and verified)

Remove only the cross-conversation visual handoff. Preserve the narrow
same-submit materialization path.

1. Replace cross-session `heldMessages` rendering with an identity-neutral
   loading/skeleton state. The target may show its own accepted transcript and
   its own explicitly correlated optimistic submit, but never the previous
   session's rows.
2. Retain the pending-draft-to-materialized-session handoff only when it carries
   an explicit source and destination `UiConversationKey`, accepted run/client
   message identity, and same-submit proof. Reject it for ordinary navigation.
3. Fence all delayed transcript, latest-run, exact-run, and terminal-recovery
   publications by both current selection generation and full conversation
   identity. A late response may update durable background state, but not the
   selected visual projection after its scope changed.
4. Keep transient `runStateBySessionKey` process-local and keyed. A reopened
   session receives durable queue/lifecycle presentation from the server.
5. Apply the same full identity fence to the queue-list projection. Its
   request coalescing and polling are independent of the lifecycle coordinator,
   but its replacement must verify the captured workspace, durable
   conversation, UI key, and selected generation. Add that selection generation
   to its request scope (or maintain an equivalent monotonic view epoch) so an
   A -> B -> A return cannot accept the first A request. On a changed selection
   it stops polling and discards its result; it must not retain a foreign row as
   a visual placeholder. Filter every returned item against the captured
   durable workspace and conversation before assigning the UI key; a route/path
   scope is not enough defence against a malformed or stale response.
6. Validate status response identity before calling
   `rememberLatestConversationLifecycleRunId` or publishing it. Keep the
   server response fields through the read boundary until this comparison has
   completed; do not rely only on the URL assembled by the client.
7. Do not preserve a parallel foreign-message candidate merely to emit a
   suppression event. The absence of a cross-session handoff is the safety
   mechanism. Keep only bounded selection/projection boundary traces needed to
   diagnose a late publication; do not log normal renders or transcript data.
8. Make the queue-list presentation store bounded. Its owner may keep the
   active selection's matching rows and an exact same-submit row pending its
   first authoritative list result; it must evict rows for every prior
   selection on navigation rather than carrying a growing per-session cache in
   `serverQueuedRuns`. An in-flight response is not retained state: it either
   matches the new full selection or is discarded. Do not evict a matching
   durable row merely because it is old; the server list, not client age,
   remains the authority for that decision.

### P2 - Add a server-owned durable startup status projection (implemented and verified)

The first recovery question during startup is not is the orchestrator ready?
but what durable, read-only state can the server already prove?

1. Introduce one queue-store `readConversationRunStatusSnapshot` resolver for
   a conversation-run status request. It reads the scoped queue row,
   reservation, and admission-blocking terminal-handoff barrier in one
   read-only SQLite snapshot/transaction whenever durable evidence is needed.
   The route must not compose this answer from separate queue-store calls, and
   it must not treat the SQLite transaction as an atomic boundary around the
   external lifecycle request.
2. Add a finite `observationSource` response field with the values `lifecycle`
   and `durable-startup`; do not overload the existing `stale` flag, because it
   also describes a lifecycle observation. For an exact run, return the
   existing safe lifecycle-status shape plus `durable-startup` when durable
   records identify that run. It is read-only and cannot be treated as fresh
   engine observation.
3. Make the route and client correlation contract explicit: every status
   response includes the authoritative workspace and conversation identifiers;
   a `latest` response may substitute only the resolved run id. The client
   rejects a mismatched response as diagnostic evidence and must neither cache
   it nor render it. This is defence in depth, not a replacement for route
   authorization or the server's scoped SQLite query.
4. For `latest`, first identify whether the active reservation maps to a
   readable `pending` or `starting` queue row. If so, that row is the durable
   subject; otherwise use the oldest readable `pending` or `starting` row for
   the conversation. A reservation without a matching queue row is not evidence
   from which to fabricate a lifecycle status. Attach only the oldest active
   (`observed`, `evidence_requested`, or `unresolved`) conversation admission
   fence that actually blocks that successor; never attach a barrier from another workspace
   or conversation, and never choose a historical queue row merely because it
   is newest by timestamp. An exact request without a queue row does not
   receive a synthetic barrier-only status; the current queued successor is
   the projection surface for an admission fence.
5. If no durable record can answer safely, preserve the existing typed route
   outcome (`lifecycle_unavailable` when no lifecycle client exists, or
   `run_not_found` when the owner has no scoped run). Do not add a second
   status union or invent an active or terminal run for a direct unqueued
   execution.
6. The resolver is strictly read-only: no queue claim, barrier transition,
   lifecycle registration, provider call, or engine operation may occur during
   a status request.
7. Prefer a successful lifecycle result when it is available; it is fresher
   evidence than the snapshot. Fall back to the durable snapshot only when the
   lifecycle client is absent or the lifecycle owner returns no scoped status.
   Do **not** fall back after a lifecycle HTTP, authentication, protocol, or
   timeout failure: propagate that typed failure because the current lifecycle
   is unknown. Route safe lifecycle and durable results through the same
   response contract with `observationSource: lifecycle` or `durable-startup`,
   so the app has one status reader rather than parallel startup and steady-state
   APIs.
8. Define the observation order precisely. A SQLite snapshot is internally
   atomic, but it cannot be atomic with `lifecycleClient.status`. With a
   lifecycle client, perform the lifecycle read first. On a non-null lifecycle
   status, take one post-lifecycle snapshot before serializing optional
   reservation/handoff adjuncts and use it only if it still identifies that
   exact run. On a null lifecycle status, take one snapshot for the durable
   fallback decision. On a typed lifecycle failure, return the failure without
   reading a fallback snapshot. With no lifecycle client, take one snapshot for
   the durable/unavailable decision. A test must mutate the fake durable store
   between the lifecycle call and serialization, proving the route cannot splice
   a pre-call barrier or reservation into a newer lifecycle result.

### P3 - Make the desktop lifecycle read coordinator readiness-aware (implemented and verified)

Server data remains authoritative; this phase only prevents speculative reads
and stale presentation.

1. Define one coordinator method that owns every `latest` read. Selection
   effects, explicit selection completion, and SSE reconnect must call that
   method rather than the endpoint independently. Its scope key is the full
   `(workspace, conversation, selected UI session, selectionGeneration)`;
   matching callers join one in-flight promise and a changed selection cannot
   publish its result.
2. Use a controller-local counter derived from a *changed* local server
   readiness value only as a scheduler input. Do not call this a server
   generation, reuse trace context as control flow, or mistake `ready` for
   engine proof. On selection, make one unified status read
   while the server is reachable even if lifecycle startup is incomplete: that
   is the P2 durable-snapshot read. Retain one deferred observation only after
   a `durable-startup` response for `(workspace, conversation,
   selectionGeneration)` and no polling timer. An existing no-subject route
   error is handled by the bounded error marker in step 6, not as deferred
   lifecycle state.
3. Release only the in-flight promise in `finally`. Retain a settled marker for
   an exact selection generation after a successful non-terminal lifecycle
   result so repeated selection/reconnect effects cannot make another status
   burst; its exact-run
   watch owns subsequent observation. Retain one deferred record only for the
   current selected `durable-startup` result. A terminal latest result retains
   its marker through correlated transcript hydration, then releases it only
   when that hydration settles or is discarded.
4. When the server returns `observationSource: durable-startup`, present its
   server-owned queue/handoff state but do not create or re-arm a lifecycle
   watch from it. Record the durable source and local readiness edge in one
   deferred record. Existing no-status route errors remain bounded diagnostic
   evidence; neither outcome marks the conversation failed.
5. On a *later changed* readiness edge, consume the deferred record
   before issuing at most one fresh read, and only when its full selection scope
   remains current. A readiness value that was already `ready` when the durable
   result arrived does not self-loop; only a changed readiness value creates a
   later edge. A reconnect signal may resume only a settled error, never a
   normal settled result. The client does not submit, release, drain, or retry
   terminal handoff in response.
6. Classify a lifecycle HTTP/unavailable error as diagnostic evidence and set a
   settled error marker for that exact selection generation. Do not turn normal
   startup or a route error into a selection-effect retry burst. A later
   explicit reconnect signal or newer readiness edge may clear that
   marker and perform the one next read.

### P4 - Preserve legacy handoff safety and expose it correctly (implemented and verified)

The durable barrier and generation authority already exist. This phase does
not reimplement them; it closes their projection and contract gaps.

1. Keep the existing exact barrier identity: workspace, conversation,
   predecessor run, and owner fingerprint. Persist `resolved` or `unresolved`
   before any queue transition.
2. Surface an unresolved barrier through P2's durable snapshot only with a
   current queue subject blocked by that conversation-level admission fence.
   The UI must present that work as safely queued and blocked by historical
   runtime evidence, not as a fresh provider request or generic unbounded
   thinking. Do not add a barrier-only exact-run UI state in this slice.
3. Keep explicit retry as one server command for the exact unresolved barrier.
   It performs one fenced evidence read. App restart, chat open, SSE reconnect,
   and status reads never invoke it.
4. Preserve the existing fail-closed legacy result: only an absent PID can
   produce `exited_confirmed` and permit normal FIFO drain. Ambiguous evidence
   remains unresolved indefinitely but without automatic polling.
5. Document the operational boundary: resolving permanently ambiguous legacy
   data is not an automatic recovery scenario and remains outside this plan.

### P5 - Persist queued admission identity and add concise diagnostics (implemented and verified)

1. Add a durable queue-row field for the OpenCode admission message id, with a
   migration safe for existing rows. Persist it atomically on the first claim
   before lifecycle registration or provider submission.
2. Reuse that stored id on every later submit attempt. Do not derive retry
   identity from a fresh `startedAt` timestamp. Keep admission-time ordering
   semantics by choosing the id only at first claim.
3. Reuse the existing queue-drain and terminal-handoff traces. Enrich the
   existing claimed/submitted/failed queue transitions with the opaque queue id,
   attempt number, and whether the admission id was newly persisted or reused;
   do not add a second queue lifecycle vocabulary.
4. Keep the coordinator trace names in the existing
   `session-lifecycle-recovery:latest-probe-*` namespace. Add only the missing
   causal outcomes:

```text
session-lifecycle-recovery:latest-probe-deferred
session-lifecycle-recovery:latest-probe-joined
session-lifecycle-recovery:latest-probe-ready
session-lifecycle-recovery:latest-probe-discarded
session-lifecycle-recovery:latest-probe-error
session-queue-projection:refresh-joined
session-queue-projection:refresh-discarded
session-queue-projection:refresh-applied
```

   The error event carries the finite `retrySuppressedForSelection: true`
   field rather than introducing a second error vocabulary. Queue-projection
   events carry only opaque scope ids, the captured selection epoch, result
   kind, item count, and finite discard reason; they never carry prompt text,
   transcript content, paths, URLs, or raw server errors.

   `session-queue-projection:refresh-joined` is sampled to at most one record
   per in-flight full selection scope and is cleared with that flight in
   `finally`. A reactive burst can contain many callers but has one causal
   coalescing decision; recording every join is diagnostic noise, not extra
   evidence. Apply the same one-record-per-flight rule if the latest-run
   coordinator's joined trace is extended or refactored.

5. Do not add a synthetic foreign-transcript candidate just to report a
   suppression event. The absence of cross-scope state is the safety mechanism;
   the bounded selection/projection boundary trace is sufficient evidence.
6. Diagnostics may contain opaque workspace, conversation, run, queue,
   selection, and barrier ids plus finite reason codes. They must exclude prompt
   text, transcript content, paths, URLs, PID/process-birth data, credentials,
   and raw provider errors.
7. Promote the shipped contracts into canonical runtime and conversation
   workflow documentation. This plan remains historical context.

### Focused validation recorded on 2026-08-03

- Queue-list projection tests cover stale A -> B -> A completion, polling
  ownership, same-scope coalescing, prior-generation invisibility, and a
  foreign same-workspace conversation item. The latter is deliberately tested
  because a reused UI key must never make a wrong durable item visible.
- Conversation-service tests reject a status response whose workspace or
  conversation does not match the routed server scope before latest-run alias
  memory is updated.
- The focused projection, session queue, conversation-service, queue-store,
  lifecycle-controller, and headless-service suites are green, as is UI type
  checking. The complete workspace quality gate is green as well, including
  lint, type checks, JavaScript/TypeScript unit and service suites, and Rust.
- Stale app composition assertions were migrated to their current owner
  contracts. The migration retained one narrow composition boundary where it
  matters and moved algorithmic assertions to focused behavioral tests; it did
  not suppress or relax the broad suite.
- Three historical-conversation scenarios completed all visible steps with
  exactly one continuation answer. Each has a causal companion summary; a
  separate fresh-process repetition also passed and satisfies the cold-process
  requirement.
- The causal verifier is now invoked by the historical-conversation launcher
  after it writes its scenario artifact. It writes a redacted companion summary
  and fails the command for an incomplete, queued, duplicate, failed, or
  terminal-handoff-unproven continuation. The same three runs have now passed
  that verifier; the third was started in a new desktop process.

### P6 - Make desktop evidence causal and reproducible (implemented and verified)

Do not make the WebDriver scenario a second lifecycle owner. It drives visible
controls only; a small read-only verifier turns the already recorded redacted
scenario artifact and local server trace into a pass/fail evidence record.

1. Add a focused trace-verifier module, separate from the WebDriver interaction
   helpers. It accepts one historical-conversation artifact and its
   `runtime-info`/trace directory, reads the bounded scenario interval plus a
   fixed short server-settlement grace, and writes a redacted companion summary.
   It must never send a request,
   mutate a queue row, or depend on a global "no errors in the whole profile"
   assertion.
2. Derive the durable scope rather than trusting a client hint: locate the
   scenario's seed and interlude OpenCode session ids, then identify the
   continuation submit after the `historical.continuation.submit` timeline
   offset. Require exactly one workspace and one seed conversation for that
   continuation. Persist only opaque ids, event names, finite outcome codes,
   counts, and timestamps in the companion summary.
3. For the continuation, require exactly one
   `server:conversation-run:admitted` record whose causation has a null queue
   item id, exactly one successful OpenCode submit for that admitted run, and
   one terminal completed reconciliation with `runtimeReadyForSuccessor: true`.
   A queued/blocked/duplicate admission, an unresolved handoff, an ambiguous
   scope, missing trace, or trace parse error is an **inconclusive failure**,
   not a pass.
4. Match server failures only after scope derivation. Any error/failed terminal
   outcome for the continuation run or its exact workspace/conversation is a
   failure. Preserve out-of-scope runtime errors in the summary as a count by
   workspace only; they are not silently discarded and do not change this
   scenario's causal result.
5. Define cold process precisely. A cold proof starts a newly launched desktop
   application process after the documented preflight, while intentionally
   retaining the persisted workspace and historical conversations. A new
   WebDriver attachment to the same app PID is not a cold-process proof. The
   three continuation trials use unique prompts and include at least one such
   cold-process trial; the final evidence records app PID and runtime directory
   per trial.
6. Keep deliberate race coverage deterministic below the desktop layer. The
   WebDriver scenario proves visible historical reopen and continuation; the
   controller test injects A -> B -> A delayed completion. Do not attempt to
   manufacture a browser-network race that cannot be made deterministic.

### P7 - Migrate stale app composition contracts to owner contracts (implemented and verified)

The broad app unit suite still contains source-level assertions that assume a
single `app.tsx` implementation block. That assumption is now false for
runtime readiness, workspace snapshots, queue projection, MCP refresh, and
conversation-read behavior: the app composes dedicated owners. The migration
must preserve the behavioral boundary, not turn the tests into permissive
string searches.

1. Inventory every failing source-contract test by the behavior it names, the
   current implementation owner, and whether a focused behavioral test already
   covers that owner. Do not batch-rewrite by filename or formatting alone.
2. Keep one narrow composition assertion in `app.tsx` for each dependency
   boundary: the app creates the owner and supplies the required callback or
   capability. Move algorithmic assertions to the owner module's tests, where
   formatting and unrelated app composition cannot invalidate them.
3. For an extracted owner, assert the invariant that matters: e.g. scoped
   workspace identity is preserved, a passive read stays passive, a runtime
   action is gated, or a late result cannot publish. A test must fail if the
   production behavior regresses, not merely if a callback is formatted across
   multiple lines.
4. Where an old assertion describes deleted legacy behavior, remove only that
   assertion and add a replacement against the currently supported public
   contract in the same change. It is invalid to use a generic `.*` pattern or
   to suppress a failure solely to make `pnpm check` green.
5. Run the focused test file after each migration, then the complete app unit
   suite. `pnpm check` is the final closure gate; no desktop success or
   scenario artifact substitutes for it.

## Acceptance result (completed 2026-08-03)

The sequence below is retained as the implementation acceptance record. Each
row completed successfully on the current tree. A future regression still
reopens the matching owner slice; it is not solved by adding an app-side retry
or a special-case UI cache.

1. **Route/snapshot contract.** Exercise all six rows of the status projection
   decision matrix, including lifecycle success winning over a stale durable
   row, lifecycle `null` selecting only the scoped queued item, and each typed
   lifecycle failure remaining an error. Assert the read path does not claim,
   submit, release, reopen, or mutate a queue row.
2. **Atomic durable view.** Exercise the reservation-backed latest item,
   ordinary FIFO latest item, an exact queued item, and an exact historical
   run with a direct barrier. The direct barrier may enrich a lifecycle
   response, but by itself must never become `durable-startup`. Confirm that an
   `observed` or `evidence_requested` fence blocks exactly like `unresolved`.
3. **Desktop coordinator.** Prove one in-flight read is joined for the full
   selected key, a late result cannot publish after a selection change, a
   successful lifecycle response stays settled, a durable response resumes at
   most once on a later readiness edge, and a typed error resumes at most once
   after reconnect or a later readiness edge. Verify a missing
   `observationSource` preserves legacy lifecycle scheduling.
   Separately prove the projection store evicts an outgoing selection without
   cancelling a valid matching server request for the newly selected scope.
4. **Queue-list projection and cold start.** Prove an A -> B -> A navigation
   rejects the first A list result even though its workspace, conversation, and
   UI key match the returned A selection. Prove a fresh UI process displays no
   local row until a scoped server list answers, then distinguish an empty
   answer, one matching durable pending item, and a foreign item. Inspect the
   bounded queue-projection traces to establish whether any remaining visible
   item was durable or stale presentation.
5. **Durable retry and legacy recovery.** Prove a failed submit/restart reuses
   its persisted OpenCode admission id, while two queue rows never share one.
   Separately prove a missing generation, a present PID, a reused PID, and an
   uninspectable PID all retain the barrier; only the authority's proven loss
   releases one FIFO successor.
6. **Real desktop behavior and causal evidence.** Run the
   historical-conversation scenario three times with unique messages. Each run
   must create two persisted chats, reopen the older one, show no interlude
   messages or foreign busy state, and produce exactly one continuation answer.
   Run P6's read-only verifier after each artifact. At least one trial must use
   a new desktop process; a browser reattach is not sufficient. Inspect the
   redacted scenario artifact, its causal companion summary, and the matching
   UI/server trace scope after each run.
7. **Release gate.** Rebuild every changed executable boundary, run focused
   tests, then run `pnpm check`. If a pre-existing source-contract test is
   stale, migrate its assertion to the current public contract or remove the
   obsolete assertion only with a replacement behavioral assertion; do not
   bypass the suite, lower its scope, or classify a red check as release-ready.
   The current testing playbook already identifies WebDriverIO as the approved
   desktop E2E surface and Tauri Pilot as legacy. The release record must name
   the actual WebDriverIO scenario and causal companion summary; it must not
   silently treat a source test or raw web server as equivalent evidence.

### Closure evidence

All of the following are recorded as satisfied:

- the decision-matrix route tests and coordinator tests are green;
- queue retry identity and legacy owner-loss tests are green across a store or
  process restart where applicable;
- cold-start and A -> B -> A queue-projection tests prove that a visible row is
  either a matching current durable row or absent, never an old client read;
- three independent historical-conversation continuations are green with no
  app, assistant, causally scoped server, queue, or duplicate-admission error;
  at least one is a cold desktop-process proof and each has a redacted causal
  companion summary;
- `pnpm check` is green without suppressing unrelated checks; and
- canonical runtime/workflow documentation describes the actually shipped
  status, retry, and handoff contracts.

## Verification matrix

| Layer | Required proof |
| --- | --- |
| UI projection/controller | A -> B switch never renders A under B; same-submit optimistic materialization remains visible; stale async results cannot publish into the final selection. The queue-list controller additionally rejects a pre-switch A result after an A -> B -> A return to the same UI key, and retains no historical queue projection after its selection is no longer active. |
| Server status route | An absent lifecycle client or authoritative no-scoped-status result returns only one safe durable scoped snapshot with a distinct observation source; no lifecycle/provider call or queue mutation occurs. Lifecycle transport/auth/protocol/timeout errors remain typed errors and never fall back to durable state. A non-null lifecycle result is enriched only from a snapshot read after that lifecycle observation. No durable subject retains the existing typed `lifecycle_unavailable` or `run_not_found` route result. A lifecycle success wins when available. |
| Queue admission | A failed queue submit and every retry/restart reuse one persisted OpenCode message id, while separate queue rows retain separate identities and FIFO order. |
| Legacy ownership | Two durable legacy rows remain distinct; absent PID releases exactly one FIFO successor; ambiguous evidence remains durable unresolved and cannot auto-release. |
| Restart | Restart over preserved queue and run SQLite data neither loses, duplicates, replays, nor automatically retries a queued intent or handoff barrier. |
| Desktop runtime | The approved real-desktop scenario creates two persisted chats in a disposable workspace, reopens the older visible sidebar row, proves the intervening transcript and indicators are absent, and sends one continuation that produces exactly one new assistant turn with no visible app/assistant error. A read-only trace verifier then derives the exact continuation scope and proves one direct admission, one successful submit, and terminal readiness; it fails closed for missing or ambiguous evidence. Run it three independent times with unique messages and at least one new desktop process. A separate blocked-handoff scenario verifies safe unresolved state without claiming normal recovery. |
| Quality gates | Relevant focused tests, rebuilt server/orchestrator binaries after source changes, the policy-approved fresh desktop scenario for the changed flow, and `pnpm check`. |

## Acceptance criteria

1. A selected conversation never temporarily shows transcript, queue state, or
   run presentation from another conversation.
2. Startup produces one joined initial status read per selected scope and local
   readiness edge. A durable-startup result may cause at most one fresh read on
   a newer readiness edge; an error may cause at most one fresh read on an
   explicit reconnect signal or newer readiness edge. A successful lifecycle
   result remains settled and uses its exact-run watch rather than re-probing;
   a durable-startup snapshot never creates a lifecycle polling burst or 503
   error burst for historical selections.
3. During lifecycle startup, the UI can display proven durable queue/handoff
   state without treating it as fresh runtime evidence.
4. The observed legacy rows remain distinct durable intents. An absent owner
   can unblock FIFO once; ambiguous evidence stays visibly fail-closed.
5. Retrying the same queue row reuses one OpenCode message id across a restart;
   separate rows receive distinct ids.
6. Reopening a historical conversation cannot itself admit, release, submit,
   duplicate, or handoff-retry queued work.
7. Three independent historical-conversation continuations complete in the
   approved real-desktop runner without a UI error, causally scoped server
   error, queue/duplicate admission, or foreign transcript/progress projection.
   Each has a redacted local causal summary; at least one began in a new desktop
   process. The evidence artifacts remain local.
8. A queue-list response that began before an A -> B -> A navigation cannot
   overwrite the re-entered A view. On cold process start, a historical
   conversation shows a queue row only after a matching current server response
   confirms that durable row.
9. A lifecycle response never serializes reservation or handoff information
   from a durable snapshot taken before that lifecycle observation. The local
   queue-list presentation remains bounded across arbitrary navigation and
   cannot become a hidden historical-session cache.
10. Every release names the approved real desktop test runner and contains no
   ambiguity between that runtime proof and lower-level source-contract tests.
