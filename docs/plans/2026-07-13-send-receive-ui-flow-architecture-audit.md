---
title: Send Receive UI Flow Architecture Audit
date: 2026-07-13
status: audit-complete
done: true
repository_snapshot: live veslo-main worktree; pre-existing local changes preserved
runtime_evidence: dev-specific/tauri-pilot/manual-runtime-20260713-141726-pnpm-dev
related_plan:
  - docs/plans/2026-07-13-accepted-run-connectivity-and-transcript-recovery-plan.md
---

# Send -> Receive -> UI Flow Architecture Audit

## Canonical verdict

The core direction is correct and substantially healthier than the old
client-owned transcript model:

```text
composer intent
  -> server-owned submit and durable run
  -> OpenCode execution
  -> SSE for immediate UI rendering
  -> server-owned canonical transcript for recovery
  -> exact-run lifecycle reconciliation for terminal UI state
```

The app is no longer a durable transcript writer. It renders the fast path and
uses the server only as the durable recovery authority. That is the right
ownership boundary.

The main remaining user-facing defect is also clear: an accepted run can lose
its status client after submit and remain visibly active for the app watcher
budget. The current default is 600 observations at five seconds, i.e. roughly
50 minutes before the UI becomes an explicit exhausted observation state. It
does not fabricate a terminal result, which is correct, but the presentation is
effectively the reported infinite `Answering` state.

The existing `Accepted Run Connectivity and Transcript Recovery Plan` owns the
right narrow remediation. This audit validates that plan's ACR02 and ACR03
direction; it should be implemented rather than replaced by a second recovery
architecture.

## Scope and evidence

This was a read-only audit of the current live `veslo-main` worktree. Existing
unrelated modifications were preserved. No runtime was started.

Evidence used:

- current app, server, and orchestrator flow owners;
- the current architecture contract in `docs/dev`;
- latest manual runtime at
  `dev-specific/tauri-pilot/manual-runtime-20260713-141726-pnpm-dev`;
- durable local lifecycle rows for that runtime; and
- focused app and server tests.

The initial primary focused verification passed:

| Surface | Result |
| --- | --- |
| App send, SSE, lifecycle, transcript and conversation-service tests | 130 passing |
| App connection-status, view-prop and transcript-controller tests | 31 passing |
| Server lifecycle, transcript coordinator and conversation-route tests | 84 passing |

The later adjacent-file cache subset is recorded separately under
"Follow-up verification and missing regression tests"; it exposed one
reproducible Windows path-normalization assertion unrelated to the ownership
findings.

The latest runtime exercised two successful sends, including first-session
materialization and a follow-up send. It did not reproduce a local-server
disconnect, so it proves the normal path but not the reported incident's
server-side cause.

## Current ownership map

| Concern | Canonical owner | App role |
| --- | --- | --- |
| Message intent and idempotency | Server submit API with `clientMessageId` | Capture target and show a temporary local user turn |
| Conversation binding and directory | Server | Remember the returned scope for display and recovery |
| Run admission, queueing, abort and terminal status | Orchestrator lifecycle through server | Observe one exact accepted run |
| Live assistant rendering | OpenCode event stream | Upsert messages and parts into the in-memory UI store |
| Durable transcript | Server transcript store | Fetch and hydrate only after recovery/prefetch/read |
| Busy/idle presentation | App presentation model, derived from durable lifecycle plus live state | Never let a lone SSE `idle` terminalize a known durable run |
| Server indicator | Connection snapshot | Present server reachability separately from runtime readiness |

There is one pipeline after a prompt is accepted. A chat and a workspace chat
have different workspace/directory ownership, but both use the same
conversation binding, durable run, SSE rendering, and transcript recovery
pipeline. A pending new chat before the first accepted submit is only local
state; it becomes a real session when the server materializes it.

## Send path

1. The session conversation flow captures the current workspace/session key,
   creates a `clientMessageId`, and creates a single optimistic user-message
   slot. This local echo is intentionally temporary.
2. The send workflow validates the resolved workspace, directory, attachments,
   model/agent intent, and submit correlation.
3. Local normal sends use the server-owned conversation submit endpoint. The
   legacy compatibility bridge is only a guarded fallback when server submit is
   unavailable; it is not the normal local path.
4. The server resolves the authoritative conversation/OpenCode target, admits
   or queues the durable run, then submits to OpenCode. A transport uncertainty
   is retried once with the same `clientMessageId`, so this is idempotent rather
   than a duplicate send.
5. On an accepted result, the app records the run id, promotes the optimistic
   message state, starts visible run presentation, and admits the exact
   `(workspaceId, conversationId, runId)` to lifecycle recovery.

The first-session handoff is the most complicated variant because one logical
send crosses a pending local session id, a materialized UI session id, a server
conversation id, and an OpenCode session id. The code deliberately carries
all of them and fences stale navigation. This complexity is justified, but it
is a boundary that needs direct regression coverage.

## Receive and UI projection path

### Fast path: SSE is the renderer

`message.updated` and `message.part.updated` events are accepted only for a
known or foreground stream session. They update the in-memory messages/parts
store immediately. Text deltas are appended where possible and a missing
parent message gets a placeholder, so the assistant response can appear before
the full message snapshot arrives.

The UI derives its run indicator from three layers, in order of authority:

1. exact durable lifecycle diagnostics for the accepted run;
2. live engine/SSE session status; and
3. local optimistic send state.

This is a good design. An SSE `session.idle` or non-abort `session.error` for a
known lifecycle run is deferred to lifecycle reconciliation instead of clearing
the spinner immediately. It prevents premature idle/flicker when an engine
event and durable run status arrive in a different order.

### Durable path: transcript recovery is server-owned

The retired client transcript-write route returns a typed `410`. The server
performs terminal canonical transcript ingest and the app requests exact
transcript recovery only when it needs durable catch-up. The server coordinator
serializes concurrent terminal/recovery requests by workspace, directory, and
OpenCode session, with bounded canonical reads at 0, 2, and 8 seconds.

The app retargets a recovered snapshot from the OpenCode session identity back
to the UI session identity before hydration. This is necessary for first-chat
materialization and is covered by focused tests.

The current worktree also protects a live assistant part from being replaced by
an equally sized passive snapshot with no parts. That is a useful narrow guard.
Non-empty snapshots still replace the live part by design, so a future stronger
merge rule would need an explicit revision/freshness contract; it should not
be invented as an ad-hoc text merge now.

## Runtime trace result

The latest manual runtime shows the intended normal sequence twice:

```text
first-session submit -> server admits run -> SSE assistant message/parts
                     -> SSE idle deferred -> durable completion
                     -> server terminal transcript ingest -> UI becomes idle

existing-session submit -> server admits run -> SSE assistant message/parts
                        -> SSE idle deferred -> durable completion
                        -> server terminal transcript ingest -> UI becomes idle
```

The first run completed in about 7.4 seconds and the follow-up run in about
52.5 seconds. Both final durable rows are `completed`; neither was abandoned,
failed, or left active. The longer run caused 51 one-second server lifecycle
reconcile reads (attempts 0 through 50). Across both runs the server recorded
59 reconcile reads and 59 scheduled reconcile timers.

This confirms that SSE rendered assistant output before terminal lifecycle
settlement and that the terminal ingest path ran. It also demonstrates the
cost of the current polling-based server lifecycle reconciler; it is a
performance/complexity concern, not a normal-path correctness failure.

## Findings

### SR01 - P1: accepted run has no bounded connectivity handoff after its status client disappears

**Confirmed.** After an accepted submit, the app watches the exact durable run.
Status reads are deliberately passive: a `status-poll` does not start a local
Veslo server. If the client is absent, it returns no status and the watcher
keeps the accepted run alive. The UI's active lifecycle/optimistic state keeps
the run indicator visible.

That policy is correct for arbitrary background reads, but insufficient for
the one run the user has just successfully submitted. The user-visible state
becomes:

```text
accepted -> server/client disappears -> exact status unavailable
         -> submitted/Answering stays visible -> 600 x 5 s watcher budget
```

Do not change all passive status polls to start the server. The KISS repair is
one explicitly admitted, exact-run recovery attempt with a dedupe key. If it
cannot restore a client, show a recoverable connection state and stop implying
that the answer is actively generating. Reconnect, explicit Retry, or reselect
may resume the exact run observation.

This is ACR02 in the related plan.

### SR02 - P2: terminal transcript recovery has bounded server retries but no explicit app retry schedule

**Confirmed as a recovery gap, not a second durable-owner defect.** The server
coordinator already performs a bounded three-read recovery and coalesces a
terminal ingest with an app recovery request. That is the correct first-line
mechanism.

After that recovery returns `null` or throws, the app clears its hydration lock
and traces the failure. It does not schedule another exact recovery itself; a
later latest-run probe, reconnect, or reselect can make a new attempt. A user
who stays on the same older session can therefore have a completed answer
remain absent until another trigger occurs.

Add at most one separately bounded exact-run retry after the first bounded
server recovery exhausts. Do not add a global transcript poller, UI-side
transcript writer, or fallback to the active workspace.

This is ACR03 in the related plan.

### SR03 - P2: normal server lifecycle reconciliation polls every second for the entire run

**Confirmed.** The server starts its reconcile loop shortly after acceptance,
then polls lifecycle status every second for up to 600 attempts. The latest
runtime shows the cost directly: one 52-second run required 51 durable status
reads.

The loop presently buys correctness: terminal status drives queue draining and
the server-owned terminal transcript ingest. Do not replace it during the
accepted-run repair. Once SR01 and SR02 are stable, the existing event-driven
lifecycle direction is the right follow-up to remove normal-path polling while
retaining this exact polling reconciler as a bounded fallback.

### SR04 - P3: retired app transcript-ingest scaffolding remains resident

**Confirmed.** The app has no active client snapshot writer, and tests enforce
that. Yet the transcript controller still retains client-ingest timers,
deletion bookkeeping, and a payload builder that have no scheduling or writer
consumer. SSE removal events still populate part of that bookkeeping.

This is not a durable-data correctness problem, but it is dead ownership
residue and can retain deletion metadata for the lifetime of the session store.
After the recovery work is verified, remove the unused client-ingest state and
its calls in one mechanical cleanup with a static no-writer regression test.

### SR05 - P3: terminal-recovery observability is split between persistent workflow traces and an in-memory browser trace

**Confirmed.** The durable server trace records run ids, terminal status, and
terminal ingest. The app lifecycle controller records detailed observations to
an in-window ring buffer/console trace, while the persistent send-workflow
trace does not consistently carry the originating send trace through later
lifecycle polls and hydration.

For an incident like the reported connect-then-disconnect loop, the run id can
still join evidence, but diagnosis is slower than it needs to be. Add one
privacy-safe persistent event for the admitted-run recovery boundary: run
identity, connection snapshot, attempt, bounded-start outcome, and terminal
hydration outcome. Do not log prompt text or transcript content.

## Follow-up: adjacent ownership and overwrite audit

This second, deliberately skeptical pass validates an important distinction:
the app is **not** a durable transcript writer, but it does have several
independent writers of the *rendered in-memory transcript cache*. That is a
real UI ownership boundary and it is not centralized behind one arbitration
point.

| Cache writer | Shape | Correct role | Collision risk |
| --- | --- | --- | --- |
| Foreground SSE | Incremental message/part upsert and text delta | Immediate render path | Can be replaced later by a whole-list snapshot |
| Direct OpenCode `session.messages` reads | Whole transcript replacement | Explicit live-session browse and reconnect catch-up | Can finish after newer SSE activity |
| Server transcript snapshot hydration | Whole transcript replacement | Passive browse/prefetch and exact terminal recovery | A passive older payload can look newer by fetch time |
| Workspace snapshot restore | Whole store replacement on workspace switch | Local UI continuity | Only a bounded switch-time hardening concern today |

The first three all target the same `messages[sessionId]` and
`parts[messageId]` render cache. This does **not** invalidate server durable
ownership. It does mean that the UI needs a small, explicit rule for deciding
which incoming cache result is still eligible to replace a live render.

### SR06 - P1: direct live transcript reads can overwrite newer foreground SSE state

**Confirmed source overlap; timing race not reproduced in the normal runtime.**
The selection controller captures a live OpenCode `session.messages` response
and then calls `setMessagesForSession`, which replaces the list and the parts
for every returned message. Its stale guard protects navigation/selection
identity, but it does not compare the per-session SSE observation version
captured before the read. The same whole-list replacement exists in active
live fallback, `loadEarlierMessages`, and foreground reconnect catch-up.

Consequently this ordering is possible:

```text
live full read starts -> SSE receives newer assistant delta/part
                      -> live full read returns -> whole cache is replaced
```

The offline snapshot branch already has the right *kind* of guard: it rejects
the result when the SSE observation version changed while the read was in
flight. The direct live branches lack that equivalent fence. Add it there;
do not introduce a second transcript store or a generic merge algorithm.

### SR07 - P1: passive server snapshot hydration can replace non-empty live parts without a canonical revision

**Confirmed source overlap.** `hydrateTranscriptSnapshot` rejects unavailable,
older-by-`fetchedAt`, and unexpectedly shorter snapshots. It also preserves an
observed part when the passive snapshot has no parts. It intentionally still
adopts a non-empty snapshot part.

That last behaviour is necessary for an exact terminal recovery: the durable
server result must be allowed to correct stale event data. It is unsafe as a
general rule for a passive prefetch or browse snapshot, because `fetchedAt` is
the read/cache time rather than a transcript revision. An earlier non-empty
payload that arrives later can therefore replace a richer live SSE part.

The KISS repair is an explicit hydration mode, not a global "SSE always wins"
merge:

- a passive prefetch/browse snapshot is discarded when SSE observation changed
  since that read began (or when it targets the active live session); and
- exact terminal recovery remains allowed only under its existing exact-run
  identity fence.

A server-issued transcript generation/watermark would be the stronger future
contract, but is not required for this first UI fence.

### SR08 - P1 decision: live-read authority becomes sticky for the whole workspace

**Confirmed; not automatically a bug.** After the first successful send or
compact in a workspace, `live-transcript-read-policy` records one allowance by
workspace. It retains the originating session/run only as metadata, never
expires/revokes the allowance, and uses that workspace-wide boolean to choose
direct OpenCode reads for active scoped session browsing.

This policy is what makes SR06 reachable beyond the originally admitted run.
It may be intentional for a workspace whose runtime is now known to be live,
but it is a larger authority scope than its event name suggests. Make one
product/ownership decision before changing it:

- explicitly document that all active-session browsing in an admitted
  workspace is runtime-owned for the remaining app lifetime; or
- scope or bound the allowance to the admitted session/run.

Do not restore the old broad rule that any ready runtime permits live reads.
That would lose the current protection against cold-starting a runtime merely
to browse history.

### SR09 - P2: the server still has a second persistent transcript writer outside the canonical coordinator

**Confirmed.** The client-facing snapshot-write route is correctly retired,
and the terminal/recovery coordinator serializes canonical complete writes.
However, a cold `conversationService.loadTranscript` does a normal engine/host
read and persists a `sqlite` result with `appendTranscript` when the durable
host store has no row. That lazy seed is outside the coordinator's identity
mutex and uses the generic, non-complete append path.

SQLite serializes individual transactions, but it does not establish authority
between a stale lazy seed and a concurrent canonical complete ingest. A late
lazy append can therefore regress a part payload that the canonical ingest
just wrote. This is server-owned, not an argument to reintroduce a UI writer.

The small server-side repair is to route the cold seed through the same
identity coordinator/mutex or prevent it from replacing a canonical
watermark. Add a concurrency test for exactly that cold-read versus terminal
ingest ordering.

### SR10 - P2: two UI error heuristics bypass lifecycle status arbitration

**Confirmed.** Invalid-tool and Chrome-MCP-completed error handlers directly
write scoped session status to `idle` and notify busy state. The normal SSE
terminal path first asks whether lifecycle owns the admitted run, so it avoids
this conflict; these local error heuristics do not use that gate.

The present run-presentation priority model usually keeps an exact durable
run visibly active, so this is not evidence of a second concurrent execution.
It is nevertheless a conflicting presentation writer and can make status,
sidebar activity, and queue hints disagree transiently. If changed, route the
heuristic through an explicit lifecycle failure observation rather than writing
`idle` directly. Treat that as a separate behavioural decision, not as part of
the connectivity repair.

### Lower-priority hardening observations

- An old SSE stream generation is cleaned up before replacement, but cleanup
  flushes its already queued events. There is no final generation check at
  event application. This is a bounded stale-event ordering risk; no failing
  test or runtime reproduction currently proves it.
- The server prefetch cache starts a new high-limit load when a lower-limit
  load is already in flight. Both can still write the cache when they finish;
  a late smaller result can temporarily replace the warm entry. The next
  high-limit consumer refetches, so this is a cache-quality issue rather than
  durable corruption.
- Workspace snapshot restore replaces the render store by design. Background
  workspace SSE intentionally does not mutate the active transcript, which is
  the important isolation. A switch-time generation fence would be defensive
  hardening only.
- `messages` and `parts` are keyed by raw session/message id in the UI store,
  rather than by a workspace-qualified key. Current workspace-cache isolation
  and UUID-like ids make this non-observable today, but it is architectural
  debt to keep in mind if concurrent workspace transcripts ever become visible.

### What remains correctly UI-owned

The following are presentation state, not competing durability owners:

- the temporary optimistic user-message overlay and local submit state;
- foreground SSE application to the render cache;
- sidebar activity tokens/projection, which are derived/read-only visual
  arbitration and do not write run or transcript truth;
- connection/reachability presentation; and
- per-workspace in-memory cache restore.

The dead client transcript-ingest bookkeeping described in SR04 is neither a
valid UI concern nor an active writer. Its deletion ledgers are still populated
by SSE removals, while the builder/clear path has no active consumer, so it
should remain a mechanical cleanup after the correctness slices.

### Follow-up verification and missing regression tests

Focused app tests for event streaming, selection, hydration, lifecycle,
live-read policy, and sidebar activity passed **81/81**. They verify the
offline snapshot/SSE observation fence and the lifecycle priority rules, but
do not drive an in-flight direct `session.messages` read that loses to a newer
SSE part, nor a passive non-empty server snapshot that does so.

The focused server coordinator/store/prefetch set had **38 passing tests**.
One existing route-prefetch test fails reproducibly on Windows because it
expects the original mixed-case temporary directory while the response returns
the canonical lower-case slash-normalized directory. That assertion is
unrelated to transcript authority and means this server test subset is not a
fully green baseline until the test/contract is reconciled. It does not change
the SR09 finding, which has no current concurrency regression test.

## Connection state and the red server indicator

The current connection layer now models two different facts:

| Fact | Meaning |
| --- | --- |
| Server reachability | The Veslo server can be contacted and authenticated (or is deliberately limited) |
| Runtime readiness | The local orchestrator/engine/proxy chain is ready, starting, degraded, or unavailable |

This separation is architecturally correct. A reachable server with a warming
engine must not be presented as a red disconnected server. The sidebar's
connection projection can show the first fact as connected and the second as
starting/degraded.

Keep this distinction at the display boundary. Send and lifecycle recovery
still need their stricter operational checks; a green reachability badge alone
is not proof that an OpenCode run can be submitted.

## KISS implementation order

1. Implement ACR02 only: one admitted-run, bounded local-client recovery and a
   truthful recoverable UI state when it fails.
2. Implement ACR03 only: one exact terminal transcript recovery retry, fenced
   by the same workspace/conversation/run identity.
3. Add one separate render-cache fence slice for SR06 and SR07: capture the
   per-session SSE observation version at the start of each direct full read;
   discard a passive result when it changed; and retain the exact-run terminal
   recovery exception. Do not combine this with ACR retry logic.
4. Decide SR08 explicitly. Keep the present workspace-wide policy only if its
   authority scope is intentional; otherwise bound it to the admitted
   session/run without broadening runtime reads.
5. Add the missing failure-path test that drives accepted submit, loses the
   status client, exercises the one recovery, then asserts no infinite active
   presentation. Add a second test for a terminal transcript recovery that
   succeeds only on the bounded retry. Add two cache tests: direct live read
   losing to a later SSE part, and passive non-empty hydration losing to a
   later SSE part while exact terminal recovery remains authoritative.
6. Route the server cold transcript seed through the canonical coordinator (or
   give it the same watermark fence), with a deliberate late-seed versus
   canonical-ingest concurrency test.
7. Capture a real desktop trace of the macOS disconnect scenario. It must show
   whether the server process, client token, runtime chain, or SSE route fails
   first; the current normal runtime cannot establish that cause.
8. Only then decide whether event-driven server lifecycle work is worth the
   added surface area. Keep the current reconciler as fallback.
9. Remove the dead client-ingest scaffolding in a separate cleanup slice.

## Non-negotiable guardrails

- Keep one app lifecycle recovery owner; do not create a second catch-up loop.
- Keep the server as the only durable transcript writer.
- Keep SSE as the immediate render path, not terminal truth.
- Never start/restart a local server from every passive status poll.
- Never resolve a recovery against whichever workspace happens to be active.
- Never clear a known accepted run solely because an SSE `idle` arrives.
- Keep correlation on exact workspace, conversation, run, directory, UI-session,
  OpenCode-session, and client-message identities.

## Audit conclusion

The send/receive/UI architecture is directionally sound, but the second pass
shows that "the app is not a durable writer" is not enough as a complete UI
ownership rule. The immediate incident remains one missing bounded
connectivity transition at the accepted-run boundary, followed by one narrow
terminal-transcript retry. Those changes directly address the reported
infinite-answering and missing-final-answer classes of failure.

Separately, the UI needs a small render-cache eligibility fence so an old full
read cannot overwrite newer SSE rendering, and the server needs one canonical
writer gate for its cold transcript seed. These are narrow ownership repairs,
not a reason for a broad rewrite, a client durable writer, or a global polling
loop.
