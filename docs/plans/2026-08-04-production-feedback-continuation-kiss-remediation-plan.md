---
title: Production Feedback Continuation KISS Remediation Plan
date: 2026-08-04
status: proposed
done: false
scope: two independent production blockers that prevent a follow-up message after a completed conversation; truthful direct-child runtime-stop/state evidence and server-projected submit identity for pending-submit reconciliation
related:
  - docs/plans/2026-08-03-engine-generation-continuation-recovery-plan.md
  - docs/plans/2026-07-18-kiss-message-delivery-and-transcript-projection-plan.md
  - docs/dev/server-owned-composer-submit.md
  - docs/dev/conversation-workflow-contract.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/feedback-diagnostics.md
---

# Production Feedback Continuation KISS Remediation Plan

## Executive verdict

The two 2026-08-04 feedback captures show two independent P0 continuation
failures. They share the same user symptom, but they do not share a root cause
and must not be combined into a new send or lifecycle architecture.

1. **Idle-suspended engine reported as a current engine at three evidence
   boundaries.** The pooled run-activity probe receives a suspended
   `EngineProcess` placeholder, attempts the dead base URL, and returns
   `request_transport_error`. Changing only that probe would expose the
   existing recovery route, but the route and generation authority also treat
   any retained pool snapshot as a live runtime. A suspended snapshot would
   therefore continue to block recovery.
2. **Server-transformed document message cannot match its local pending
   owner.** For a non-image attachment such as PDF or DOCX, the server appends
   `Attached workspace file: <staged path>` to the canonical text and submits
   no inline file part. The local pending row still contains the original text
   plus attachment metadata, so the current text/file fingerprint cannot
   adopt it. The accepted `sending` row can remain after the full assistant
   answer and block every later message. Separately, exact transcript evidence
   is not currently allowed to settle an `outcome-unknown` row.

The runtime correction has two safety prerequisites. The current two-phase
child stop ignores the result of its final timeout, while callers immediately
record `exited_confirmed`; several replacement callers can also delete the old
snapshot and continue into a successor spawn after failed cleanup. Once a
suspended snapshot no longer blocks recovery, either behavior could admit a
successor against a process that never exited. Truthful child-exit confirmation
and successor gating must therefore ship in the same P0 slice.

This repair is deliberately **direct-child only**. A Windows WSL child is a
host wrapper whose exit is not proof that the guest engine exited. WSL runtime
recovery, guest-process identity, and prior WSL generation cleanup are not part
of this incident repair. A ready/idle WSL runtime may continue through its
existing normal running path, but a suspended/crashed WSL snapshot is never
eligible for the new stopped-snapshot recovery path. No claim in this plan
applies host-wrapper PID evidence to a WSL engine.

The KISS repair is correspondingly small:

- make direct-child stop return truthful exit evidence, never confirm an
  unobserved exit, and never spawn a replacement after an unconfirmed stop;
- use one state-aware current-runtime definition in the run probe, recovery
  route, startup sweep, and generation authority;
- let exact canonical transcript evidence adopt both accepted `sending` and
  `outcome-unknown` local rows;
- record the server's already computed OpenCode message id beside the client id
  in the existing bounded run-delivery snapshot, then project that identity
  onto canonical user rows so first-session and existing-session document
  submits reconcile without duplicating the staging algorithm;
- add a direct idle-suspend desktop regression plus first-session and
  existing-session document regressions;
- fix the feedback report parser separately so the next capture exposes these
  states without manual raw-log forensics.

Do not add another lease, queue, runtime recovery owner, timeout-based cleanup,
automatic resend, or broad message-delivery rewrite.

## Evidence from the two captures

Both captures came from Veslo `2026.8.3`. The evidence windows are ten minutes
long and their user reports describe different moments, so the incidents must
remain separate even though the visible result is “cannot continue chatting.”

| Capture | Evidence window (Europe/Prague) | User-visible failure | Proven boundary |
| --- | --- | --- | --- |
| `fb_163950330f8a4b4789e9c62e2e59c977` | 07:39:52–07:49:52 | A message failed after roughly twenty minutes of inactivity. | The server received both retries, but admission stopped at unresolved terminal handoff after the engine had been intentionally suspended. |
| `fb_807eea9d6b3e43eeb70ef3740cd8a78d` | 09:47:12–09:57:10 | A follow-up after a document review showed “A previous message is still synchronizing.” | The follow-up never reached the server submit route; the app rejected it at the local pending-slot boundary. |

Shared negative evidence is also useful:

- AI access checks succeeded; neither blocked follow-up reached provider/model
  execution.
- Cloud feedback upload and encrypted event retrieval worked.
- No evidence supports an auth, billing, model, or document-runtime outage as
  the common cause.
- The two fixes can be shipped and rolled back independently.

### Incident A: exact runtime chain

The first capture establishes this order:

1. The engine owner started at 07:15 and the last useful conversation progress
   was recorded around 07:33:58.
2. At 07:45:03 the engine pool logged `engine idle, suspending`, stopped the
   child with `SIGTERM`, and retained the pool entry in `suspended` state.
3. Background OpenCode proxy reads then failed with 503, which is expected for
   a stopped engine and is not itself the bug.
4. At 07:47:35 and 07:47:41 the user made two follow-up attempts. Both Veslo
   submit HTTP requests completed, but their typed result was blocked and the
   draft was restored.
5. The predecessor classifier saw the old terminal run as stale with
   `runtimeReadyForSuccessor: null`, `engineOwnerState: attached`, and
   `unavailableReason: request_transport_error`.
6. Admission returned `blocked_terminal_handoff_unresolved`. No OpenCode submit
   and no provider request followed.

### Incident B: exact app chain

The second capture establishes a different boundary:

1. The prior document-review conversation and its assistant output were
   already visible.
2. The exact synchronizing text is emitted only when
   `trySetPendingSubmittedDraftForKey` returns `occupied`.
3. A failed local row would be replaceable, so the retained row was either
   `sending` or `outcome-unknown`.
4. The branch returns before `sendPromptAsync`; the capture contains no
   conversation submit for the follow-up and no lifecycle admission attempt.
5. The ten-minute capture begins after the original document submit, so it
   cannot distinguish an accepted row whose document fingerprint did not
   adopt from an `outcome-unknown` row that was never eligible for cleanup.

The capture alone cannot select between those two local states. The code audit
resolves the document half independently: an accepted non-image document is
deterministically transformed into a shape the current matcher cannot adopt.
A production-shaped fixture must freeze that contract without guessing a
broader match rule.

## Current-code audit

### A. Runtime ownership has a state-definition mismatch and an exit-proof gap

The existing durable ownership split is already the right one:

- `EnginePool.suspend` intends to stop the child and keep a `suspended`
  snapshot.
- `EnginePool.getRunning` returns only `ready`/`idle` processes and already
  returns `null` after suspend.
- `createRunActivityProbe` maps a missing engine to `no_current_engine` and
  separately maps an attempted-request failure to
  `request_transport_error`.
- the shared-engine topology wires its probe through `getRunning`;
- exact generation evidence and terminal-handoff recovery already exist;
- the server invokes that guarded recovery only for a stale terminal owner
  reported as `no_current_engine`, then re-reads lifecycle status before
  admitting a successor.

The pooled topology is the outlier in three places:

1. the run-activity probe is wired with `pool.get(workspaceId)`, so it contacts
   a suspended placeholder and reports a network failure;
2. the terminal-handoff recovery route uses the same snapshot lookup and
   rejects any owner-bearing entry as `runtime_active` before asking generation
   authority; and
3. generation evidence receives `currentPoolEntry: true` for that snapshot and
   returns `live_or_ambiguous`, even when its durable record is already
   `exited_confirmed`.

The prior-generation startup sweep uses the same Boolean pool-entry concept
and must share the corrected state-aware definition. Otherwise live recovery
and restart recovery would disagree about the same suspended owner.

There is also a latent proof-integrity defect. The child stop helper waits for
`SIGTERM`, sends `SIGKILL` after a timeout, but ignores whether the second wait
observed an exit. It returns success-shaped `void`; suspend and several other
pool cleanup paths then call the generation `afterExit` hook and persist
`exited_confirmed`. A process that survives both waits can therefore receive a
false durable death certificate. The retained pool entry currently masks that
defect. Making suspended entries non-current without repairing stop evidence
would activate it.

The stop result is also an admission fence, not only a persistence decision.
Stale respawn and skill-view replacement remove the old entry before cleanup,
and their cleanup errors are currently logged and swallowed before the spawn
flight continues. Health-driven replacement has the same successor risk. The
shared direct engine also uses the CLI-local helper and confirms exit from
dispose/unhealthy cleanup. Every owner-changing caller must therefore treat
`exit_unconfirmed` as a hard stop: retain the old owner as current/ambiguous,
return failure, and create no successor.

The supported proof in this slice is the process represented by a `direct`
child. The engine pool explicitly permits a `wsl` wrapper to exit while its
guest endpoint remains under health monitoring, so wrapper exit and wrapper
PID absence are not engine-exit evidence. The new recovery classifier must
reject that topology as unsupported/fail-closed. This plan neither fixes nor
tests WSL lifecycle recovery.

This is not evidence that `request_transport_error` should mean “dead engine.”
A transport failure can also describe a slow, partitioned, starting, or still
live owner. Loosening the server guard would violate the fail-closed runtime
contract and could admit a competing successor.

### B. Pending presentation can hide without relinquishing ownership

The current app model also contains most of the desired behavior:

- Composer hands one immutable draft to one pending row.
- `clientMessageId` remains the server idempotency identity.
- render replacement uses explicit compatible client metadata first, then one
  unique scoped post-baseline text/mode/file fingerprint.
- ambiguous or absent matches fail closed.
- failed rows are editable/replaceable, while uncertain delivery cannot be
  blindly resent.

The contradiction is local:

- render replacement calls the transcript matcher for every non-error row, so
  an `outcome-unknown` local echo can disappear when its canonical row exists;
- durable cleanup calls `decidePendingSubmittedTranscriptAdoption` only when
  the row is `sending`;
- that decision additionally accepts only `admission === accepted`;
- an `outcome-unknown` transport result normally retains `admission: pending`;
- the hidden row therefore remains in the session-key map and
  `trySetPendingSubmittedDraftForKey` correctly refuses to overwrite it.

The slot is behaving consistently with its input. The bug is that exact
canonical evidence is not allowed to settle the uncertain local presentation
owner.

### C. Document correlation should use the identity the server already owns

The app matcher already has the right precedence:

- exact compatible `clientMessageId` identity first; then
- a scoped post-baseline content fingerprint as a fail-closed fallback.

The server already creates a unique OpenCode user-message id for every admitted
prompt run before upstream dispatch. At the same boundary it creates the
existing bounded run-delivery snapshot, which already stores workspace,
conversation, run, OpenCode session, and Veslo `clientMessageId`, but not the
already computed OpenCode message id. The missing contract is therefore small:
store that additional content-free id in the existing snapshot and use it in
canonical read projection. Transcript user rows already expose the OpenCode
message id but do not currently carry the matching Veslo client identity into
`message.info`.

The snapshot's later diagnostic updates are deliberately best-effort, but the
new identity insert cannot be. If product reconciliation depends on this pair,
the initial bounded identity record must succeed before OpenCode dispatch or
the submit must fail without dispatch. Later router/app/terminal counters keep
their existing best-effort semantics. This avoids turning a swallowed 50 ms
diagnostic write failure into another invisible permanent pending row.

That bounded delivery snapshot is a smaller and more general correlation source
than reproducing attachment staging in the app. It is created before the
OpenCode dispatch, so it works for existing sessions, first-message
create+submit, and a response that became `outcome-unknown`. Identity is
recovered from server-owned admission data plus the canonical message id, not
from the client response.

The content fallback currently compares:

- normalized text and compatible mode;
- workspace file path/label/filename;
- attachment filename and MIME type while ignoring data-URL bytes;
- exactly one scoped, post-baseline canonical candidate.

That fallback remains valid for text, inline images, and explicit Composer
workspace-file parts. It is not the canonical shape of an uploaded non-image
document. For a PDF/DOCX attachment, the existing server staging path produces
one text part:

```text
<original prompt text>
Attached workspace file: <exact staged relative path>
```

No inline file part is emitted. The pending row contains the original Composer
attachment, so the existing content fallback cannot match this shape. The
repair must not make that fallback guess a server-generated path, duplicate
the staging filename/digest algorithm, or accept arbitrary `Attached workspace
file:` text. Instead, the canonical read layer should project
`clientMessageId` only when one exact stored OpenCode message id maps to one
canonical user row. Missing, duplicate, or conflicting mappings remain
unannotated and therefore fail closed. The real document transform still needs
a production-shaped fixture so the identity fix is proven against the shape
that caused the incident rather than against an artificial file part.

### D. Feedback summary currently conceals the decisive evidence

The generated summaries reported no signals, anomalies, or runs even though
the first export contains explicit predecessor classification and admission
blocking events. Almost every event was counted as unscoped.

The cause is incomplete normalization of a permanently mixed input. The same
exports contain both legacy strings prefixed with `[veslo:send-workflow]`,
`[veslo:runtime-trace]`, or `[veslo:ai-gateway]` and current OTel JSON envelopes
with the event in `body` and scope in `attributes`. The report recognizes the
legacy branch but not the decisive OTel lifecycle branch. Neither format is a
temporary migration fallback that may be removed.

This did not cause either product failure, but it turned a bounded support
operation into manual raw-log archaeology. It is a small supportability fix
and should follow the two P0 repairs without blocking them.

## Required invariants

1. Only exact generation authority may prove a supported direct-child runtime
   owner gone. WSL wrapper evidence is outside this contract and stays
   fail-closed whenever that topology is visible.
2. `exited_confirmed` may be written only after the exact direct child emitted
   an exit event or exact direct-process inspection proved absence. Sending
   `SIGTERM`/`SIGKILL` or exhausting a stop timeout is not exit evidence.
3. No timeout, 503, connection refusal, missing in-memory entry, or stale flag
   alone may release an owner or admit a successor.
4. An unconfirmed owner stop blocks both durable exit confirmation and every
   replacement/successor spawn that depends on that stop.
5. The server remains the only durable admission and queue owner.
6. Exact canonical transcript evidence may remove local presentation state;
   it may not manufacture admission, resend a prompt, or mutate transcript.
7. Server-projected client identity must come only from one exact durable
   OpenCode-message-to-client-message mapping; content is never used to create
   or repair that identity.
8. An uncertain row with no unique canonical match remains visible and keeps
   its slot. It must never disappear on age, assistant output, or generic idle.
9. Failed rows remain editable and replaceable; uncertain rows remain
   non-resendable until reconciled.
10. Every regression must prove one user action produces at most one server
   submit and one assistant turn.
11. Diagnostics remain content-free: no prompt text, transcript text, document
   contents, raw tokens, or credentials in new events or reports.

## KISS implementation plan

### Slice 1 — truthful stop evidence and state-aware runtime recovery (P0)

**Owners:** the existing child-stop helper, engine pool, shared direct engine,
orchestrator lifecycle composition, and generation authority. No new runtime
owner or persistence table is introduced. WSL engine recovery is excluded.

#### 1A. Make child stop report what was actually observed

1. Replace the success-shaped `Promise<void>` stop contract with a typed direct-
   child result or rejection that distinguishes `exit_observed` from
   `exit_unconfirmed`. Attach the exit observer before signalling and re-check
   `exitCode`/`signalCode` so an exit between the signal and wait cannot be
   missed. Both the `SIGTERM` wait and the post-`SIGKILL` wait must settle the
   same result; `child.kill()` returning, returning `false`, or not throwing is
   not proof of exit. If the CLI-local helper cannot be tested cleanly, extract
   only this primitive and result type into a focused module.
2. Call generation `afterExit`/`confirmExit` only after the helper or direct
   child exit handler observed an exit. Keep notification deduplication for the
   race where both observe the same event.
3. On `exit_unconfirmed`, do not mark the pool entry `suspended`, do not persist
   `exited_confirmed`, do not delete the current owner, and do not return a
   successful dispose/replacement result. The durable `stopping` state plus the
   retained current snapshot is sufficient; no new state is required.
4. Treat the stop result as a successor gate. Stale respawn, skill-view restart,
   LRU eviction, health-driven restart, and any same-slot replacement must
   abort before spawn when the prior direct child did not exit. Logging and
   swallowing an unconfirmed cleanup is forbidden on those paths.
5. Audit every production caller of the helper and classify it explicitly:

   - pool owner changes: suspend, forget, stale respawn, skill-view restart,
     LRU eviction, health-driven kill, spawn-health cleanup, and generation-
     activation cleanup;
   - shared direct engine: dispose, unhealthy cleanup, and spawn cleanup;
   - process shutdown without a successor: pool kill-all and raw orchestrator
     child shutdown.

   All callers must consume the typed result. Owner-changing callers must not
   create a successor from `exit_unconfirmed`; shutdown callers must report the
   unconfirmed stop without manufacturing lifecycle evidence.
6. A later direct child exit event may finish the existing `stopping`
   generation and unblock a later retry. A WSL wrapper exit may not use this
   rule.
7. Add deterministic tests for already-exited, first-phase exit, second-phase
   exit, both-phase timeout, kill throw/false return, the signal-to-listener
   race, and a late direct exit after an unconfirmed stop. Only observed direct
   exits may produce `exited_confirmed`, and every unconfirmed replacement case
   must assert zero successor spawns.

#### 1B. Define “current runtime” once and use it at every evidence boundary

1. Introduce one narrow classifier for pool evidence with explicit outcomes:
   `running` (`ready`/`idle`, preserving existing normal direct and WSL use),
   `starting` (pooled `spawning` or shared pending start),
   `stopped_snapshot` (direct `suspended`/`crashed` snapshot), `absent`, or
   `unsupported_wrapper_snapshot` (WSL `suspended`/`crashed`). Keep
   `EnginePool.get` as the raw snapshot API.
2. Wire the pooled run-activity probe through only the classifier's `running`
   engine. A suspended snapshot must produce `no_current_engine` without
   building or dispatching an HTTP request; a starting state is not allowed to
   answer for the recorded run owner.
3. Use the same definition in the terminal-handoff recovery route. Its
   `runtime_active` guard must reject a running/starting runtime, not an
   owner-bearing suspended snapshot.
4. Make generation authority consume the same classified current-runtime
   evidence rather than an unqualified Boolean “pool entry.” A current
   `running`, `starting`, or `unsupported_wrapper_snapshot` evidence stays
   `live_or_ambiguous`; a supported direct `stopped_snapshot` does not override
   truthful `exited_confirmed` evidence or prevent exact direct-process
   inspection of a `stopping` record.
5. Use the same classified evidence when the prior-generation startup sweep
   has a current in-memory snapshot. This plan does not reinterpret an
   untyped historical WSL wrapper PID as direct-engine evidence and makes no
   new WSL restart-recovery guarantee.
6. Do not change the run probe's transport-error mapping and do not broaden the
   server classifier's `no_current_engine` recovery predicate.
7. Preserve the generation-mismatch rule: a different running generation must
   still report `owner_generation_mismatch`, never `no_current_engine` or idle.
8. Add focused authority/route cases for truthful `exited_confirmed` plus a
   direct suspended snapshot (recoverable), the same record plus direct
   running/starting evidence (blocked), `stopping` plus alive/unknown direct
   inspection (fail-closed), plus a WSL stopped snapshot that remains
   unsupported and blocked from this recovery path without changing normal
   ready/idle WSL use.

#### 1C. Prove the newly connected recovery chain

No existing test covers suspend followed by a later lifecycle probe and
terminal-handoff recovery. Add a new integration test for the complete chain:

   ```text
   terminal run with attached direct owner
     -> intentional pool suspend with observed direct child exit
     -> suspended snapshot retained for diagnostics
     -> latest lifecycle read reports no_current_engine
     -> server requests exact terminal-handoff recovery
     -> exact owner is marked lost
     -> fresh lifecycle read is ready
     -> one successor is admitted
   ```

Add two negative twins: when direct stop is unconfirmed and exact inspection
reports alive/unknown, the pool does not publish a safely suspended runtime and
no successor reaches OpenCode; when the stopped snapshot is WSL-backed, the
new recovery path returns unsupported/fail-closed regardless of host-wrapper
exit state.

**Exit criterion:** a supported direct suspended engine is not contacted or
treated as active, but it can unblock a successor only after truthful durable
or exact direct-process exit evidence. An actual transport failure,
unconfirmed stop, or stopped WSL wrapper snapshot remains fail-closed in this
slice.

### Slice 2 — reconcile uncertain local delivery from exact transcript identity (P0)

**Owners:** existing bounded run-delivery snapshot, canonical transcript read
projection, and app pending-submit reconciliation. No new queue, submit owner,
or persistence table is introduced.

#### 2A. Project the identity the server already owns

1. Extend the existing run-delivery snapshot payload with optional
   `opencodeMessageId`. This is an additive JSON field, not a new table or SQL
   migration. Keep the existing TTL, size limit, workspace/conversation/run
   key, and pruning.
2. Split initial identity persistence from later best-effort delivery
   diagnostics. Immediately after the server computes the prompt's OpenCode
   message id, persist the complete snapshot identity before lifecycle/OpenCode
   dispatch. Do not catch-and-continue on this initial write: failure returns a
   typed recoverable submit failure, releases any provisional reservation, and
   asserts zero upstream dispatch. Router/app/terminal snapshot updates remain
   best-effort and may not erase, rewrite, or invalidate the immutable identity
   pair. Repeating the exact same identity is idempotent; reusing the same
   workspace/conversation/run key with a different client or OpenCode message
   id is a hard conflict and also dispatches nothing.
3. Add one narrow snapshot read method that returns only complete recorded
   prompt identity pairs for a workspace/conversation: exact
   `opencodeMessageId` plus exact `clientMessageId`. Ignore missing or expired
   identity pairs. The diagnostic `recording: incomplete` flag is orthogonal
   and must not invalidate an identity that was completely persisted before
   dispatch. Do not expose prompt content, attachment names, paths, or provider
   data.
4. During canonical transcript projection, annotate a canonical **user** row's
   `message.info.clientMessageId` only when its exact OpenCode message id has
   one unique recorded mapping in the same workspace and conversation. Never
   annotate assistant/tool rows, never match by text, and leave missing,
   duplicate, cross-scope, or conflicting mappings unannotated.
5. Treat this as read metadata, not transcript mutation. Do not rewrite stored
   OpenCode messages or add a second identity store. Existing historical rows
   with incomplete mapping remain unannotated and fail closed.
6. Cover both submit shapes:

   - existing-session submit, where the client stages attachments first; and
   - first-session create+submit, where the server stages raw non-image
     attachments after deriving the OpenCode session id.

   The identity projection must not depend on receiving the original HTTP
   response, so it also works after a response becomes `outcome-unknown`.

#### 2B. Let exact identity settle the pending owner

1. Keep the app matcher's existing precedence: exact compatible client
   identity first, then its existing scoped content fingerprint. Do not add a
   permissive document-text/path matcher and do not duplicate the server's
   staging filename or digest algorithm in the app.
2. Express adoption eligibility in the pure reconciliation decision:

   - accepted `sending` rows are eligible, as today;
   - `outcome-unknown` rows are eligible because an exact canonical client
     identity proves that this submission reached durable transcript;
   - pre-admission ordinary `sending`, `error`, diagnostic-mismatch, wrong
     scope, no-match, and ambiguous rows remain ineligible.

3. Change only the canonical-adoption cleanup effect so it invokes the pure
   decision for `sending` and `outcome-unknown` rows. Remove the row only when
   the decision returns `adopt` for the same pending id and session key.
4. Do not broaden any other `sending` gate. In particular, leave unchanged:

   - materialized-submit queue-drain suppression;
   - pending-session/transcript display hold;
   - run-presentation `optimisticSending` ownership;
   - workspace send warm-up presentation;
   - idle-grace run-state reset; and
   - failed-message editability.

5. Keep render suppression and ownership cleanup as separate decisions, but
   make both use the same pure matcher. Do not clear on accepted HTTP alone.
6. Preserve `trySetPendingSubmittedDraftForKey` behavior. It should continue
   to block a follow-up while an uncertain unmatched row exists and allow the
   follow-up only after exact adoption removes that row.
7. Preserve the existing explicit queue-cancellation behavior that can remove
   a matching non-`sending` row, including `outcome-unknown`. Canonical adoption
   adds another evidence-backed removal path; it does not create a new class of
   destructive transition.

#### 2C. Freeze the production document shape and transitions

1. Build fixtures through both real server boundaries:

   - existing Composer attachment -> client-staged relative path -> server
     request resolution -> canonical text-only user message; and
   - first-session raw attachment -> server preparation/staging -> request
     resolution -> canonical text-only user message.

   Assert the exact `Attached workspace file: <staged relative path>` transform
   and that non-image documents produce no inline file part. Then project the
   durable identity and prove the app adopts the canonical row without relying
   on a synthetic file part or a guessed path.
2. Add transition tests:

   - accepted existing-session PDF/DOCX + exact projected identity -> adopt and
     release the slot;
   - accepted first-session PDF/DOCX + exact projected identity -> adopt and
     release the remapped pending slot;
   - `outcome-unknown` document + exact projected identity -> adopt and release
     without resend;
   - identity attached to the wrong session/message -> remain occupied;
   - missing, duplicate, or conflicting identity mapping -> remain occupied;
   - initial identity persistence failure -> typed recoverable failure, exact
     reservation cleanup, and zero OpenCode dispatch;
   - exact identity replay -> idempotent success; conflicting replay -> hard
     conflict and zero OpenCode dispatch;
   - later diagnostic `recording: incomplete` -> immutable exact identity still
     projects and may reconcile;
   - content-only document transform with no identity -> remain occupied rather
     than accepting an arbitrary staged path;
   - failed or diagnostic-mismatched rows -> never adopt; and
   - a late cleanup may remove only the exact pending id it evaluated after a
     first-session key remap.
3. Record one content-free reconciliation event containing pending state,
   eligibility, result, match kind, candidate count, and finite unresolved
   reason. Do not include draft text, staged paths, filenames, or message
   contents.

**Exit criterion:** once the exact canonical user row carries the exact durable
client identity, no invisible local row can continue to reserve the session
slot; without that identity or another existing exact match, the uncertain row
still fails closed.

### Slice 3 — make production feedback summaries understand current logs (P1)

**Owner:** existing feedback diagnostic report only.

1. Extract one normalized trace-line parser used by both local summary and
   production-report paths.
2. Accept both supported inputs:

   - legacy Veslo-prefixed trace strings;
   - current OTel JSON envelopes, taking event from `body` and allowlisted data
     from `attributes`.

   Treat both as permanent supported formats because current captures contain
   both concurrently; do not delete or deprecate the legacy branch as part of
   this work.
3. Read workspace/conversation/run/client identities from the normalized
   allowlisted attributes and retain the existing capture-workspace scoping.
4. Add fixtures for `terminal_handoff_unresolved`,
   `blocked_terminal_handoff_unresolved`, `no_current_engine`,
   `request_transport_error`, and the new pending-adoption decision.
5. Count malformed inner trace envelopes explicitly instead of silently
   treating them as ordinary unscoped events. Characterize the observed
   Windows-path serialization case before changing the runtime logger.
6. Retain current redaction, bounds, operation caps, and encrypted-storage
   behavior.

**Exit criterion:** a fixture shaped like the two production exports reports
the affected workspace, run, reason, and blocking decision without reading raw
message content.

## Verification matrix

Focused tests support the real desktop scenarios; they do not replace them.
The desktop preflight and real Tauri/WebDriverIO rules from the testing
playbook apply.

| Scenario | Required proof |
| --- | --- |
| Confirmed direct-child stop | An observed first- or second-phase direct exit records `exited_confirmed` once and only once. |
| Unconfirmed direct-child stop | Exhausting both waits records no confirmed exit, retains the current owner, does not publish a safely suspended engine, and causes zero successor spawns. |
| Late direct exit after timeout | The later real direct-child exit may confirm the exact generation and permit a later retry; the preceding timeout may not. |
| WSL wrapper | Ready/idle WSL use is unchanged; a WSL suspended/crashed snapshot is unsupported/fail-closed and wrapper exit or PID absence never exercises direct-child recovery. |
| Suspended direct pooled snapshot | Run-activity probe returns `no_current_engine`, performs zero HTTP calls, recovery does not reject it as `runtime_active`, and generation authority evaluates truthful direct-child evidence. |
| Running owner transport failure | Still returns `request_transport_error`; server does not infer death or admit a successor. |
| Different running generation | Still returns `owner_generation_mismatch`; the replacement engine cannot answer for the old owner. |
| Exact generation absent | Existing authority marks only the matching owner lost; server re-reads lifecycle and admits exactly one successor. |
| Generation live, reused, or unknown | Recovery remains unresolved and no successor reaches OpenCode. |
| Canonical identity projection | One exact durable OpenCode-message/client-message pair annotates only its scoped canonical user row; missing, duplicate, conflicting, assistant, and cross-scope cases remain unannotated. |
| Identity persistence failure | A failed initial identity write returns a typed recoverable failure, leaves no false accepted pending owner, and performs zero OpenCode dispatches; later diagnostic update failures remain non-blocking. |
| Accepted local row | A unique scoped canonical client identity adopts it; absent or ambiguous evidence retains it. |
| Outcome-unknown local row | A unique scoped canonical client identity adopts it without resend; absent or ambiguous evidence keeps the warning and slot. |
| Existing-session document | A production-shaped PDF/DOCX becomes canonical text plus exact staged-path lines and no inline file part; projected identity adopts it without app-side path inference. |
| First-session document | Server-side raw-attachment staging produces the same canonical text-only shape; projected identity survives session-key remap and releases the exact pending slot. |
| Unchanged sending gates | Queue drain, transcript hold, run presentation, warm-up, idle reset, and editability retain their existing `sending` semantics. |
| Follow-up after reconciliation | The second message reaches the server exactly once and produces one assistant turn; no synchronizing toast appears. |
| Feedback report | Concurrent OTel and legacy fixtures produce one normalized finding and preserve workspace scoping/redaction without removing either parser branch. |

### Required real-desktop regressions

1. **Idle-suspend continuation.** Extend the existing historical-continuation
   WebDriverIO lane. Seed and complete one conversation, intentionally suspend
   its **direct** pooled engine through the existing orchestrator dispose
   boundary (or a test-only shortened idle policy), require observed child
   exit, reopen/retain the same conversation, and send a follow-up. Assert one
   submit, one new assistant turn, no recovery-required UI, and trace evidence
   for `no_current_engine` followed by proven recovery. The scenario must assert
   `childKind: direct`; it is not a WSL test. Do not wait the production idle
   duration in CI and do not add a second lifecycle fault owner.
2. **First-session document then follow-up.** Start from an unpublished
   session, attach a small deterministic supported document as the first
   message, wait for the complete assistant answer and identity-annotated
   canonical user row, then send a text follow-up. Assert no synchronizing
   toast, exactly one second submit, and one new assistant turn. This freezes
   the server-side staging path that client-side staging metadata cannot cover.
3. **Existing-session document then follow-up.** In a pre-existing conversation,
   attach the same document, wait for canonical adoption, and send a follow-up.
   Assert the same single-submit/single-turn contract so both staging owners
   remain covered.
4. **Outcome-unknown reconciliation.** If existing E2E fault controls can drop
   the client response only after server acceptance, add that variant to the
   document flow. Otherwise keep this boundary in pure/component tests rather
   than adding a broad production fault endpoint solely for the test.

Use WebDriverIO over the Tauri desktop runtime. Do not add or run a Tauri Pilot
scenario.

### Focused and repository gates

Run, in order:

1. focused run-delivery snapshot identity, canonical read projection,
   pending-submit reconciliation, and exact document-transform tests;
2. focused child-stop timeout, engine-pool, run-activity-probe,
   generation-authority, and lifecycle-controller tests, including the new
   suspend-to-recovery chain;
3. feedback diagnostic report tests;
4. orchestrator build/typecheck and the required server binary rebuild before
   integration testing, because Slice 2 changes server projection/persistence
   code;
5. `pnpm check:services` for the built server/orchestrator boundary;
6. the direct idle-suspend and both document real-desktop WebDriverIO scenarios
   after the required single-tenant preflight; and
7. `pnpm check` for the final source handoff.

## Rollout order

1. Ship Slice 1 and Slice 2 together as the user-facing P0. They touch
   independent owners but together close both observed “cannot continue”
   families.
2. Ship Slice 3 in the same release only if its focused fixtures remain a small
   isolated report change; otherwise follow immediately as P1. It is not an
   admission dependency.
3. After verification, update the canonical runtime, composer-submit, and
   feedback-diagnostics docs with the precise settled contracts. Keep this
   plan as history.
4. Inspect the next production feedback export for the named signals. A clean
   export must distinguish “no incident observed” from “parser did not
   recognize current log format.”

No SQL/data migration is required. The engine state, generation records,
conversation queue, pending app model, and feedback storage schema remain
unchanged; the existing bounded delivery-snapshot JSON gains one optional
content-free identity field.

## Acceptance criteria

1. After intentional idle suspension of a direct pooled engine, a follow-up in
   the same completed conversation succeeds without restarting Veslo and
   creates exactly one successor run.
2. Direct suspend, forget, replacement, shutdown, shared-engine cleanup, and
   health-kill paths never write `exited_confirmed` unless the exact direct
   child exit was observed or exact direct-process inspection proved absence.
   An exhausted stop timeout remains current/fail-closed.
3. An unconfirmed owner stop causes zero replacement/successor spawns. A later
   observed direct exit may permit a later retry; the timeout itself may not.
4. A supported direct suspended pool snapshot is never queried or rejected as
   a current runtime by the probe, recovery route, startup sweep, or generation
   authority, while direct running/starting evidence still blocks recovery.
   A WSL stopped snapshot is excluded and remains fail-closed without changing
   its existing ready/idle path.
5. A real request transport error is never promoted to proof of owner loss.
6. Exact direct-generation checks remain the only path that releases an attached
   terminal owner.
7. The server projects `clientMessageId` only from one exact durable
   OpenCode-message mapping in the same workspace/conversation and never from
   content similarity.
8. The initial identity pair is persisted before OpenCode dispatch. If that
   write fails, the submit fails recoverably with zero upstream dispatch;
   later delivery diagnostics remain best-effort.
9. Both the existing-session client-staged and first-session server-staged
   PDF/DOCX transforms produce canonical text plus exact staged-path lines and
   no inline file part; their canonical user rows reconcile through the exact
   projected identity without app-side path inference.
10. After an identity-annotated canonical document/user message appears, its
   matching local `sending` or `outcome-unknown` presentation row cannot
   invisibly retain the session slot.
11. No-match and ambiguous uncertain submissions remain visible, non-resendable,
   and fail-closed.
12. Queue drain, transcript hold, run presentation, warm-up, idle reset, and
   editability keep their existing sending-state behavior; only the canonical
   adoption cleanup effect broadens eligibility.
13. A first-message or later document review can be followed by another message
   in the same chat with no synchronizing toast, one server submit, and one
   assistant turn.
14. Feedback summaries support concurrent OTel and legacy events, preserve
   capture workspace scoping, and expose the finite blocking reason without
   content.
15. Focused tests, service integration, the three required Tauri/WebDriverIO
   regressions, and `pnpm check` pass.

## Explicit non-goals

- treating every `request_transport_error` as a dead engine;
- WSL guest-process identity, WSL wrapper shutdown semantics, WSL lifecycle
  recovery, or claiming that host-wrapper exit proves guest-engine exit;
- deleting suspended pool snapshots or changing their persistence semantics;
- treating a delivered signal, kill request, or elapsed stop timeout as a
  confirmed process exit;
- introducing a runtime lease, second queue, heartbeat authority, or UI-owned
  recovery state machine;
- automatic retry/resend of an outcome-unknown prompt;
- duplicating server attachment staging/path derivation in the app;
- matching arbitrary `Attached workspace file:` text without exact identity;
- clearing pending state on a timer, assistant activity, generic terminal
  status, or same-looking text without one unique scoped candidate;
- implementing the proposed `MessageDeliveryController` and discriminated
  transcript-render-item migration from the broader 2026-07-18 plan;
- transcript-only continuation or conversation rebinding;
- changing request-poll cadence, config PATCH churn, log-volume policy,
  screenshot capture, or feedback storage as part of this repair;
- rewriting the logger because of one malformed inner line before a focused
  serializer reproducer exists.

## Why this is the KISS boundary

Both production failures are contract mismatches at already existing
boundaries:

```text
stop request
  --must not become--> confirmed exit without observed termination

unconfirmed owner stop
  --must not become--> replacement/successor spawn

suspended pool snapshot
  --must not become--> current running/starting runtime evidence

exact durable OpenCode-message/client-message identity
  --must project onto--> its canonical user row

unique identity-annotated canonical user message
  --must settle--> matching non-error local presentation owner
```

Repairing those boundaries reuses all durable owners already in the codebase.
It closes the observed failures without relaxing safety, adding persistence,
or moving lifecycle authority into the UI.
