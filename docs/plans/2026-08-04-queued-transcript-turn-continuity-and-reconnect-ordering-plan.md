---
title: Queued Transcript Turn Continuity and Reconnect Ordering Plan
date: 2026-08-04
status: completed-at-slice-1b-stop-criterion
done: true
scope: enforce causal renderability for live assistant evidence, preserve one continuous user-turn representation from queued acceptance through canonical transcript arrival, and classify reconnect presentation without treating planned resubscription as an outage
related:
  - docs/plans/2026-08-04-production-feedback-continuation-kiss-remediation-plan.md
  - docs/plans/2026-08-04-runtime-degraded-state-ownership-and-diagnostics-plan.md
  - docs/plans/2026-07-18-kiss-message-delivery-and-transcript-projection-plan.md
  - docs/dev/app-map.md
  - docs/dev/testing-playbook.md
  - docs/dev/opencode-workspace-runtime-architecture.md
---

# Queued Transcript Turn Continuity and Reconnect Ordering Plan

## Implementation outcome

Implemented and validated on 2026-08-04 through the plan's Slice 1A and Slice
1B boundary. The E2E-only pooled event-stream gate held the app reconnect across
the exact queued successor claim and admission while the same engine owner and
generation continued processing. The extended real-desktop WebDriverIO scenario
captured every content-free transcript and queue row transition with a
MutationObserver.

The stable-generation acceptance run did not reproduce the reported invalid
DOM: there was no assistant-before-parent causal gap, no adjacent assistant
turn, and no interval where the queued successor lacked both its canonical user
row and an exact queue owner. The successor remained represented by the server
queue row until completion of the observed handoff window.

The first cold-runtime attempt was separately rejected because normal workspace
skill discovery replaced the initial empty-view engine with a resolved-view
generation after gate release. Trace evidence showed the gate itself resumed on
the original owner before that unrelated replacement. Repeating after skill-view
stabilization passed with owner and generation preserved.

Per the explicit Slice 1B stop criterion, Slices 2A, 2B, 3A, and 3B were not
implemented. No production transcript presentation, queue handoff, reconnect,
or hydration semantics were changed from this plan. The production incident is
therefore classified as not yet reproduced rather than inferred from projection
revision counters or code shape.

## Executive verdict

After a queued prompt was admitted, the transcript was reported to briefly show
two assistant turns in a row and to correct itself only after another transcript
event arrived. That is a correctness concern, not a projection-cost concern.
However, the first audit attributed it to projection revision drift, and the
current code and the same trace disprove that diagnosis.

The four reported `revision` values are independent, stage-scoped diagnostic
counters. They advance when each stage observes a different output array
reference; they are not versions of shared canonical content and cannot be
ordered against each other. At the sampled instant all four stages carried the
same array identity and the same eleven transcript messages. The renderer had
not advanced beyond canonical state.

The actionable sequence is instead an incomplete queued-turn handoff:

1. the queued successor run was claimed while the workspace SSE stream was
   reconnecting;
2. an assistant `step-start` part arrived after reconnect, before its message
   metadata and before the causative user message;
3. the SSE writer intentionally created an assistant placeholder in the
   canonical store so part-only delivery still counted as run evidence;
4. the causative user message arrived 1,376 ms later and restored the expected
   user/assistant ordering.

The trace proves a temporarily incomplete canonical turn. It does not yet prove
that duplicate assistant text was painted: during the incomplete interval the
diagnostics report eleven transcript messages but only ten rendered blocks, and
the new assistant text was held until after the user message arrived. Slice 1B
must therefore connect the user's visible incident to an exact DOM row source
before changing semantics.

The KISS repair boundary has two layers. A generic live-renderability guard
prevents any causally unresolved assistant evidence from becoming an orphan
turn, whether the prompt was queued or submitted immediately. The queue handoff
keeps an exact user owner present so that guard does not have to delay a healthy
queued response. Reconnect and background hydration remain separate follow-up
questions unless the reproduction proves that either participates in the gap.

## Evidence from the 2026-08-04 desktop run

| Time | Established observation |
| --- | --- |
| 19:20:42.238 | Workspace SSE changed from `live` to `reconnecting`. |
| 19:20:42.261–42.724 | The server claimed, admitted, and submitted the queued successor run. |
| 19:20:43.310 | SSE returned to `live`; reconnect catch-up explicitly ran without a transcript refresh. |
| 19:20:44.339 | `sse.part.updated` received an assistant `step-start` with `hasMessageBefore: false`; the writer created its placeholder. |
| 19:20:44.339 | Canonical, visible, viewport, and selected projections all referenced the same array identity and the same eleven messages. Their diagnostic counters were 13/13/15/15 because those counters are independent. |
| 19:20:45.601 | Full assistant message metadata arrived; the causative user message was still absent. |
| 19:20:45.622 | The message-block benchmark reported eleven transcript messages but ten rendered blocks. |
| 19:20:45.715 | The causative user message arrived, bringing canonical state to twelve messages. |
| 19:20:47.400 | The held assistant text part was committed after the user message was present. |

Additional observations:

- the reconnect path currently calls catch-up with transcript refresh disabled;
  the incident was not caused by that path replacing the message list;
- the seven-write hydration burst targeted seven different background sessions;
- sidebar prefetch is already derived from loaded top-level and expanded rows,
  and excludes the selected/clicked session plus reserved canonical aliases;
- visible, viewport, and selected transcript arrays are derived projections, not
  independently writable transcript stores;
- viewport diagnostics already record canonical array identity, local-echo
  identity, search/window inputs, and whether output identity changed;
- the existing `same-conversation-queue-roundtrip` WebDriverIO scenario already
  drives run A, queues prompt B, and waits for both runs to settle, but asserts
  only the eventual assistant count rather than every intermediate row order;
- existing transcript rows already expose role and message identity in the DOM.
  Local and server queue list items do not expose their item/owner identity, so
  only those rows may need minimal content-free attributes for the reproduction;
- queue submission currently defines `showOptimisticSubmit` as false whenever
  the send reason is `queue-drain`. Direct server-queue submission uses that
  reason, so it intentionally creates no pending local user row;
- an accepted local queue drain removes its local queued draft; when invoked
  with reason `queue-drain`, the same gate above creates no pending replacement.
  Separately, the server queue projection replaces its scope from an API that
  returns `pending`, `starting`, and `failed` items; a successfully submitted
  item leaves that readable set. Both transitions can therefore remove
  queue-owned presentation before the canonical user event arrives;
- both the queued submit result and server queue items already carry exact
  `clientMessageId`, `reservedRunId`, and `queueItemId` correlation. No protocol
  expansion is needed to create the admission handoff; the missing question is
  whether canonical arrival exposes a directly usable counterpart;
- at first durable queue claim, the server already derives and persists the
  OpenCode user-message ID from the queued client message and reserved run. If
  another correlation field is needed by the app, it should expose that
  existing authority rather than create a new identity scheme;
- part-first placeholder creation is generic in the live SSE writer and has no
  queue predicate. A `step-start` alone is currently filtered from renderable
  blocks, which explains the ten-block trace sample, but other user-visible
  parts could make the same causally unresolved assistant evidence renderable;
- bounded history and hydration may legitimately contain an assistant whose
  parent user row lies outside the loaded window. A general guard therefore has
  to track unresolved live-SSE provenance, not infer invalidity from a missing
  parent in an arbitrary snapshot;
- reconnect presentation currently loses cause information: the state owner has
  finite degraded reasons, but `ReconnectNotice` is only `reconnecting` or
  `reconnected`, and the session toast maps that binary value directly to
  “Reconnecting...”. A planned admission resubscription would therefore look
  like an outage unless it is classified before the notice is emitted;
- the current shared-engine proxy fault control is restricted to shared-engine
  topology. It cannot precisely close an already-active SSE connection for the
  incident's `pooled-per-workspace` topology while leaving the engine, owner,
  generation, and submit path intact;
- killing a pooled child is not an acceptable substitute because it changes
  engine lifecycle and generation state rather than isolating an observation
  gap;
- the current native file-attachment WebDriver scenario is independently red,
  but this reproduction is text-only and does not use its upload helper.

## What is proven and what is not

### Proven

- A queued successor can be admitted across an SSE reconnect.
- SSE event order can expose assistant parts before the causative user message.
- Part-first ingestion creates an assistant placeholder in canonical state by
  design, preserving part-only run evidence.
- Placeholder creation and part-first ordering apply to all live SSE messages,
  not only durable queue submissions.
- The sampled projection counter differences do not express content ordering.
- The causative user row was absent for 1,376 ms after the assistant placeholder
  entered canonical state.
- A later, related user-message write completed the turn.

### Still to prove before the P0 implementation

- The exact DOM state the user perceived as a duplicated answer.
- Whether that row came from a canonical placeholder, the queued/local-submit
  projection, message grouping, or another explicit render item.
- Whether the user message was emitted late by the engine, missed during the
  reconnect window and later recovered, or reordered by the transport/client
  writer.
- If the engine emitted it late, whether that ordering is a legitimate upstream
  contract rather than a defect. A legitimate late user event still requires
  the general presentation guard; it does not justify rendering an orphan.
- Which queue path owned prompt B in the incident and which accepted/claimed
  transition removed its last visible row. Absence of a local optimistic row is
  already expected for `queue-drain`; the reproduction must not misdiagnose it
  as a failed pending-slot insertion.
- Whether the eventual canonical user message exposes the accepted client/run/
  queue correlation directly or requires the server to forward one additional
  identity.
- Whether maintaining the queued/local user row through admission lets the
  mandatory guard release immediately, or whether additional accepted identity
  correlation must be exposed first.
- Whether the 19:20:42.238 stream close was an unplanned transport outage, a
  planned stream replacement, or an admission-owned resubscription. Temporal
  proximity to claim is not proof of ownership.

Do not implement a shared revision authority. Do not add reconnect snapshot
mutation until the event-gap origin above is known.

## Required invariants

1. **Continuous user-turn ownership.** From accepted queue admission until a
   matching canonical user message exists, exactly one owned representation of
   that user prompt remains visible: queue projection, local-submit projection,
   or canonical transcript row.
2. **No orphan live assistant turn.** An assistant response for an ordinary
   prompt is not presented ahead of its causative user representation on queued
   or immediate-submit paths. That representation may be canonical or an exact,
   owned optimistic handoff.
3. **Canonical may be incomplete; presentation may not pretend it is complete.**
   The transcript store may ingest part-first SSE evidence, but renderability is
   determined from complete turn ownership rather than raw arrival order.
4. **Part-only evidence remains valid.** Holding an orphan assistant row out of
   presentation must not discard its parts, prevent lifecycle observation, or
   manufacture terminal state.
5. **Exact authority for the queued handoff.** New correctness decisions in
   this path use stable queue, run, client-message, or server-provided
   identities. They do not add a timeout, prompt-text fingerprint, or array
   position as handoff authority. The existing generic fingerprint fallback is
   outside this plan and is neither removed here nor accepted as proof of this
   invariant.
6. **Explicit release authority.** Exact canonical identity replaces the
   handoff; explicit cancellation or failed admission transfers it to the
   existing cancelled/error presentation. Queue-list omission, timeout, or an
   unrelated transcript write cannot silently release it.
7. **Exactly-once handoff.** When canonical user identity arrives, it replaces
   the owned optimistic representation without a duplicate, disappearance, or
   unrelated later write.
8. **Reconnect is monotonic.** If reconnect reconciliation is ultimately
   required, it merges by message and part identity and cannot overwrite newer
   live observations.
9. **Diagnostics remain content-free.** Message IDs, roles, parent-presence,
   placeholder kind, owners, run/queue correlation, counts, and identities are
   allowed; prompt and answer text are not.
10. **Planned resubscription is not an outage.** A user-visible reconnect notice
    requires an unplanned observation loss. If admission intentionally replaces
    or gates a stream, that finite cause is traced but is not presented as a
    connectivity failure.

## KISS implementation plan

### Slice 1A — make the desktop reproduction possible (P0 prerequisite)

The required fault is not currently expressible. Before changing transcript or
queue behavior, add the smallest E2E-only observation gate that can disconnect
an active workspace SSE subscription in `pooled-per-workspace` topology and keep
the app-side subscription unavailable until an explicit release, without
killing or restarting the engine.

1. Keep the control behind the existing E2E fault-injection gate and unavailable
   in normal desktop runs.
2. Make one armed gate workspace-scoped and self-clearing after release. Arming,
   disconnect, blocked reconnect attempts, and release must record content-free
   workspace, connection, owner, and generation correlation.
3. Gate only app-facing event-stream subscriptions. The engine process, pooled
   owner, generation, server queue drain, admitted run, and submit path must
   remain live and unchanged.
4. Drive it as a deterministic barrier rather than a timing race:
   - queue B while A is active;
   - arm the gate and observe the app enter reconnecting state;
   - observe B reach durable `starting`/admitted state through the server-owned
     queue/run boundary, not through the gated app SSE;
   - release the gate and capture reconnect plus transcript delivery.
   Do not use a sleep interval as the correctness mechanism.
5. Prove the control first with a focused real Tauri WebDriverIO check. The
   existing shared-engine proxy failure and pooled-child kill controls are not
   substitutes for this proof.

**Exit criterion:** a focused capture proves that the pooled workspace SSE
connection stayed gated across B's claim/admission and then reconnected while
the same engine owner and generation continued processing the accepted run. If
this cannot be made deterministic, Slice 1B is blocked and no production
behavior change starts.

### Slice 1B — prove the visible row and the event gap (P0)

1. Extend the existing `same-conversation-queue-roundtrip` WebDriverIO scenario
   rather than building a parallel queue harness:
   - start run A;
   - submit prompt B while A is active so B is queued;
   - use the proven Slice 1A control across B's claim/admission;
   - observe B's assistant part arriving before B's user message;
   - install a test-side `MutationObserver` before submitting B and record a
     content-free snapshot whenever transcript or queue row roles/identities
     change, rather than relying on WebDriver polling or the final assistant
     count.
2. Reuse the existing projection boundaries, viewport input tuple, store-write
   owners, row identities, and message-block fingerprints before adding new
   instrumentation.
3. Add only the missing content-free correlation needed to distinguish:
   - canonical message versus local/queued render item;
   - real message metadata versus a part-created placeholder;
   - parent identity present, absent, or not yet known;
   - local versus server queue item, send reason, and optimistic-submit gate;
   - queue item, accepted run, client message, and eventual canonical message;
   - queue-row removal, server projection replacement, pending-submit creation,
     adoption, and removal.
   Add minimal queue-owner/item attributes only if existing traces cannot bind a
   visible list item to this correlation; do not expose draft text to the test.
4. Determine all relevant boundaries rather than assuming the repair owner:
   - which queue owner disappeared without an atomic visible handoff;
   - whether the engine emitted the user event late or the reconnect path
     observed it late;
   - if the engine emitted it late, whether that is a supported upstream order;
   - why the production stream entered reconnecting: unplanned close, planned
     replacement, or admission-owned resubscription. The E2E fault's deliberate
     close must be tagged separately and cannot answer this production question.

**Exit criterion:** one capture proves the exact invalid visible row, its owner,
the queue and pending-submit lifecycle of B, and the first boundary that
delivered events out of order. If the DOM never contains the reported duplicate
or orphan turn, the plan stops here and the report is treated as not yet
reproduced rather than inferred from revision counters.

### Slice 2A — enforce live causal renderability (P0, general safety)

Once Slice 1B reproduces the invalid DOM state, this guard is mandatory even if
the queued handoff is sufficient in that scenario. The live SSE writer accepts
out-of-order assistant evidence generically, so presentation needs a generic
safety boundary too. If Slice 1B does not reproduce the report, its stop
criterion still applies and no production guard is inferred from code shape
alone.

1. Record a transient, content-free `causal-pending` owner when live SSE ingests:
   - an assistant part before its message metadata; or
   - ordinary assistant metadata whose exact parent user turn is not yet
     represented.
   Preserve the message and every part in canonical storage and lifecycle
   observation.
2. Apply the guard at the presentation projection before progress grouping. A
   causal-pending assistant becomes renderable only when its exact parent user
   message or an exact accepted handoff owner represents that turn.
3. Clear causal-pending state only from exact user/handoff identity. Do not use
   arrival delay, text similarity, array adjacency, or a later unrelated write.
   Keep it across stream reconnect/generation replacement; evict it only with
   the entire scoped transcript or after exact causal resolution.
4. Scope this state to live ingestion. Hydrated or paginated history is not
   hidden merely because a parent lies outside the loaded window, and explicit
   synthetic error rows retain their existing provenance and presentation.
5. Treat legitimate engine-late ordering as an expected use of the guard: hold
   presentation, retain evidence, and release when the causal owner arrives.
   It does not activate reconnect transcript mutation by itself.

**Exit criterion:** on queued and immediate-submit live paths, part/message-first
assistant evidence remains observable internally but cannot produce a rendered
ordinary assistant turn until the exact causal user owner is represented.
Bounded historical snapshots retain their current visible rows.

### Slice 2B — preserve queued-turn continuity (P0)

1. Make queue acceptance an atomic presentation handoff rather than globally
   enabling optimistic rendering for every `queue-drain` call:
   - a direct server-queued send installs a handoff owner from the submitted
     draft and the accepted `clientMessageId`, `reservedRunId`, and
     `queueItemId`;
   - an accepted local queue drain does not remove its queued draft until that
     same handoff owner is installed;
   - server projection omission after `submitted` is not, by itself, authority
     to remove the handoff.
2. Feed that owner through the existing local-submit and viewport projection if
   its single-slot contract can hold it safely. If the slot is occupied, keep
   the exact queue-owned row until the transfer succeeds; do not overwrite the
   existing pending submission, create a second transcript pipeline, or write a
   synthetic user row into canonical server state.
3. Reconcile the optimistic user representation only when an exact accepted
   client/run/message identity is observed. If the current protocol does not
   carry a usable identity through canonical user arrival, expose the server's
   already persisted OpenCode message correlation. Do not create a second
   identity scheme or promote the existing prompt/fingerprint fallback into
   authority for this handoff.
4. Queue disappearance alone must never remove the last representation of the
   accepted user turn.
5. Release or transition the handoff only on exact canonical adoption or an
   explicit cancelled/failed outcome already owned by the queue/run lifecycle.
   Do not create timeout cleanup for an outcome-unknown handoff.
6. Preserve fail-closed behavior for ambiguous identity: do not delete or merge
   rows based on similar text, timing, or position. Slice 2A continues holding
   causally unresolved assistant presentation until exact ownership exists.

**Exit criterion:** across every recorded frame of queue → admitted → running →
canonical handoff, prompt B has exactly one user representation and Slice 2A can
release its assistant without an orphan turn or an avoidable visible delay.

### Slice 3A — classify reconnect presentation (P1, conditional)

1. Use the production capture from Slice 1B to classify the 19:20:42.238 close.
   Do not infer admission ownership from its 23 ms proximity to queue claim.
2. If admission intentionally gates or replaces the stream, extend the existing
   reconnect-presentation owner with a finite transition cause such as
   `admission-resubscribe`. Keep it diagnosable, but do not emit the binary
   `reconnecting` notice or outage toast for that planned operation.
3. Preserve the current outage notice for an unplanned transport close. Do not
   hide real delayed-message risk merely because it happened near admission.
4. Tag the Slice 1A E2E gate as a deliberate test fault. Its reconnect notice is
   test evidence only and cannot establish production banner policy.
5. If admission does not own the close, make no banner change in this plan.

**Exit criterion:** a normal queued admission never impersonates a connectivity
outage, while a genuinely unplanned stream loss still enters the finite
reconnect/degraded presentation and remains observable.

### Slice 3B — harden reconnect only if it owns the event gap (P1, conditional)

1. If Slice 1B proves the engine emitted the user event but the client missed it
   across reconnect, define the smallest bounded catch-up needed for active
   sessions.
2. Reconcile a fetched snapshot by message and part identity. Do not replace by
   position and do not treat a shorter bounded window as deletion evidence.
3. Fence publication with the session's live-observation version so a snapshot
   started before newer SSE writes cannot overwrite them.
4. If the engine legitimately emitted the user event late, rely on Slice 2A for
   safety and Slice 2B for smooth queued continuity; leave reconnect transcript
   refresh disabled.

**Exit criterion:** either reconnect is proven not to require transcript
mutation, or its identity merge recovers the missed user row without replacing
newer live state.

### Slice 4 — evaluate background hydration separately (P1)

1. Keep the current exclusion of selected/clicked sessions and reserved aliases.
2. Treat one write per requested background session as expected until profiling
   shows unnecessary interest or repeated hydration of the same fresh snapshot.
3. If there is measurable cost, reduce duplicated interest or no-op hydration;
   do not couple this work to queued-turn correctness.
4. Retain whole-collection write owner/reason diagnostics and verify that
   background hydration cannot mutate the active reserved transcript.

**Exit criterion:** either the current demand-derived prefetch is accepted as
bounded behavior, or a separately measured optimization reduces redundant work
without changing active transcript semantics.

## Verification matrix

| Scenario | Required proof |
| --- | --- |
| Pooled SSE fault-control preflight | One active workspace stream remains gated across claim/admission, then reconnects while engine process, owner, generation, admitted run, and submit path remain continuous. |
| Active run A, queued prompt B | B remains represented exactly once from queue acceptance through canonical user arrival. |
| B admitted during SSE reconnect | The extended same-conversation queue scenario records every DOM row transition; no frame presents B's assistant as an orphan turn, even if assistant parts arrive first. |
| Direct server-queued prompt | Accepted draft becomes an exact handoff owner before the server queue projection can disappear. |
| Accepted local queue drain | Local queue removal and handoff installation are atomic; an occupied pending slot retains the queue owner. |
| Pending-submit lifecycle | The capture records the `queue-drain` optimistic gate and any later handoff adoption or removal owner. |
| Part before message metadata | Canonical store and lifecycle retain the part; presentation follows the turn-completeness invariant. |
| Immediate, non-queued part/message-first delivery | Live causal-pending evidence is held until the exact user owner exists; queue state is not required for safety. |
| Engine legitimately emits the user event late | No orphan assistant is rendered, no reconnect mutation is added, and presentation releases on exact causal ownership. |
| Bounded history starts with an assistant row | The row remains visible because historical parent absence is not treated as live causal-pending state. |
| Canonical user identity arrives | Handoff ownership is reconciled exactly once using accepted identity correlation; the legacy fingerprint fallback is not acceptance proof. |
| Explicit queue/run failure or cancellation | Handoff moves to the existing error/cancelled outcome without waiting for canonical user arrival. |
| Ambiguous or missing correlation | The UI fails closed and retains owned state; it does not guess, delete, or duplicate. |
| Planned admission resubscription, if proven | Transition is traced with a finite internal cause and produces no outage toast. |
| Unplanned SSE loss | Existing reconnect/degraded presentation and user notice remain visible. |
| Reconnect snapshot, if enabled | Identity merge preserves newer live writes and never infers deletion from a bounded window. |
| Background hydration burst | Only background interests are hydrated; the active reserved transcript is unchanged. |
| Diagnostics | Correlation and row ownership are observable without prompt or answer content. |

The primary acceptance proof is the real desktop WebDriverIO scenario. Focused
lower-level tests should support it by covering part-before-message ingestion,
immediate and queued causal-pending renderability, bounded historical windows,
queue/local/canonical ownership transfer, identity ambiguity, reconnect cause
classification, and any conditional reconnect merge. They do not replace the
desktop proof.

The focused text-only queue scenario is the acceptance lane for this plan. Its
result must be reported independently from the currently failing native
file-attachment scenario; this plan does not claim that the entire WebDriverIO
suite is green.

## Explicit non-goals

- creating a shared semantic revision from the four diagnostic allocation
  counters;
- asserting `presented revision <= canonical revision`, because those counters
  do not describe one ordered sequence;
- tuning projection allocations before the turn-continuity invariant holds;
- changing queue admission, generation ownership, model execution, or lifecycle
  terminal semantics;
- discarding part-only assistant evidence or treating missing metadata as a
  failed run;
- matching queued and canonical messages by prompt text, attachment shape,
  timing, or array position;
- globally removing the existing fallback fingerprint reconciliation used by
  other submit paths;
- requiring every hydrated or paginated assistant row to have its parent inside
  the currently loaded transcript window;
- treating the shared-engine proxy failure or a pooled-child kill as proof of a
  pooled active-SSE observation gap;
- treating the deliberate Slice 1A test gate as proof that production admission
  intentionally interrupts SSE;
- fixing the unrelated native WebDriver file-attachment failure or requiring
  the full desktop scenario suite to be green before this text-only acceptance
  lane can run;
- enabling reconnect transcript refresh without proof that reconnect owns the
  event gap;
- removing background hydration or rewriting the transcript store;
- introducing the broader discriminated transcript-render-item migration from
  the 2026-07-18 plan as a prerequisite.

## Rollout and rollback

- Slice 1A is a narrowly gated test-control prerequisite and must be separately
  revertible. No production transcript behavior changes before it is proven.
- Slice 1B is diagnostic and test-only and can land independently after Slice
  1A.
- Slice 2A is the general P0 safety guard. Slice 2B is the queued continuity
  repair; each must be independently revertible and verified together.
- Slice 3A lands only if production admission is proven to own a planned stream
  transition. Slice 3B lands only if reconnect is proven to own the missed-event
  gap.
- Slice 4 is an independent performance slice and must not be required for the
  correctness acceptance test.
- Any durable runtime or public behavior change must update the owning canonical
  documentation alongside implementation; this plan remains historical design
  context.

## Why this is the KISS boundary

```text
live assistant evidence
  --must wait for--> one exact causal user-turn owner

accepted queued prompt
  --must keep--> that owner continuously visible

assistant fragment
  --must not present as--> an orphan ordinary turn

part-first SSE evidence
  --may enter--> canonical storage and lifecycle observation
  --without forcing--> an invalid presentation

reconnect catch-up
  --is added only when--> the reconnect gap is proven

planned admission resubscription
  --must be traced without impersonating--> an outage

background hydration
  --is measured separately from--> queued-turn correctness
```
