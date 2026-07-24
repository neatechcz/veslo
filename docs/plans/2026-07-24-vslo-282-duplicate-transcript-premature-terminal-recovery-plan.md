---
title: Duplicate Transcript Projection and Premature Terminal Recovery
status: in_progress
done: false
scope: Installed Veslo desktop runs with workspace-local OpenCode database fallback, run-scoped terminal confirmation, transcript projection, and composer recovery
runtime_code_changed: true
e2e_required: false
evidence_reviewed_at: 2026-07-24
---

# Duplicate Transcript Projection and Premature Terminal Recovery

## Codebase ownership constraints

The fix must stay inside the existing ownership boundaries:

```text
OpenCode DB candidate selection  -> server conversation read store
canonical transcript persistence -> server ingest coordinator + host store
run terminality                  -> orchestrator run probe/registry
reservation release              -> server lifecycle controller + queue store
live SSE projection              -> app session event stream/store
terminal hydration               -> app lifecycle recovery + transcript controller
send blocking diagnostics        -> app presentation/composer
```

The plan must preserve the existing host transcript store, ID-based app
upserts, and terminal-delivery coordinator. It must not introduce a second
global transcript store, a process-wide UI deduplicator, or text-based response
deduplication.

## Executive decision

Long assistant output is valid transcript content and is not the defect. The
incident contains two confirmed runtime defects and one renderer hypothesis:

1. an unusable implicit workspace-local OpenCode database can mask the valid
   global database used by the active OpenCode runtime;
2. a non-authoritative inactive observation, especially transient
   `session_idle`, can be persisted as successful completion while the same
   OpenCode loop is still producing assistant messages or tool parts;
3. the visible duplicate has not yet been classified at the first divergent
   message/part/projection identity.

The implementation must fix the confirmed source-selection and terminality
defects first. Projection behavior may be changed only after identity-level
instrumentation classifies the duplicate. Veslo must never deduplicate by text
content.

Acceptance uses focused automated tests, a headless server/orchestrator
multi-step test, and a manually operated live Tauri run. No E2E driver or E2E
fixture is required by this plan. A conservative coalescing guard inside the
existing terminal-delivery owner is allowed without text-based deduplication;
broad projection changes remain gated on Phase 0 identity evidence.

## Locked decisions

These decisions are prerequisites, not implementation questions:

- Preserve the current ownership split. The server owns transcript source
  reads and the host transcript cache; the orchestrator owns run activity and
  durable lifecycle; the app lifecycle recovery owner adopts exact terminal
  snapshots; the existing terminal-delivery coordinator owns visible ordering.
- Explicit OpenCode database configuration is authoritative and fails closed.
  Veslo must not silently read a different user database when an explicit path,
  data directory, or data home is configured but unusable.
- Implicit workspace-local and global databases are fallback candidates. An
  implicit candidate may be skipped when it is absent, unreadable,
  schema-incompatible, or does not contain the exact requested scope.
- Database schema validity alone is not candidate fitness. Exact transcript
  reads require the requested session and directory scope. Conversation lists
  require rows for the requested directory before an implicit candidate wins.
- `session_idle`, engine absence, and session/message 404 are observations, not
  successful terminal authorities.
- Successful completion requires exact-run, post-admission transcript evidence
  plus a stable quiescence confirmation. Failure to obtain such evidence must
  never be converted to `completed`.
- Quiescence state is durable and run-scoped. It cannot live only in a probe
  closure or be keyed by the selected workspace/session in the UI.
- Terminal recovery failure is diagnostic state, not a permanent composer
  lock. Once the exact run is terminally reconciled, a new normal send may
  reach the server even if transcript recovery remains unavailable.
- Existing physical UI store keys are retained unless Phase 0 proves an actual
  cross-scope ID collision. Do not introduce a broad transcript-store key
  migration speculatively.
- Late valid content is never hidden. It is merged by canonical identity or
  diagnosed as a distinct upstream identity; equal text is not proof of replay.

## Current verified baseline

### Transcript source resolution

The current resolver selects exactly one path before opening SQLite. Existing
workspace-local `.opencode/opencode.db` wins over the implicit global path.
Schema errors and missing exact sessions return `source=unavailable`; the
resolver does not continue to another implicit candidate.

This means both of the following mask the global database today:

- a local file without the required OpenCode schema;
- a schema-valid local file that is empty or does not contain the requested
  session under the requested directory.

### Lifecycle terminality

The current activity probe returns inactive for more than one condition:

- OpenCode reports `session/status = idle`;
- no engine is available for the workspace;
- selected session/message reads return some 404 paths;
- the latest assistant message appears terminal.

The run registry currently maps every reachable `active=false` result to
`completed` and releases active ownership. The probe does not carry a durable
run-start transcript watermark, so a terminal assistant message from an older
turn in the same OpenCode session can also be mistaken for evidence about the
new run.

### Projection and composer

Snapshot hydration already ignores unavailable snapshots, rejects older
snapshots, upserts messages by message ID, and stores parts by message ID and
part ID. Exact terminal recovery retargets an OpenCode session alias to the
materialized UI session before hydration. The current focused alias/recovery
contract is not green in the live checkout: the accepted-run hydration test
expects one message under the materialized UI session and observes zero. This
is a relevant recovery defect, but it must remain separate from the unproven
renderer duplicate until the live identity trace classifies both paths.

The composer currently has separate disabled/guard branches for button and
Enter. Its blocked trace does not identify the exact blocking predicate, run,
or client message. A lifecycle `busy` value combined with missing streaming
state can prevent a normal send from reaching the server queue.

### Pre-implementation focused baseline on 2026-07-24

- combined focused audit run: 137 passed, 2 skipped, 1 failed;
- the failing case is the accepted-run OpenCode-to-materialized-UI-session
  hydration assertion (`0 !== 1`);
- resolver/prefetch, lifecycle/probe, terminal-delivery, event-stream,
  transcript-controller, and presentation groups otherwise passed;
- `git diff --check`: passed before this plan revision.

These green tests described the pre-change implementation. Some orchestrator
assertions explicitly encode the unsafe `idle -> inactive -> completed`
behavior and must be replaced, not preserved as acceptance.

### Implementation checkpoint

The first implementation slice now covers the source-selection and terminality
owners:

- implicit local/global OpenCode DB candidates are probed read-only with
  operation-specific schema and scope checks; explicit configuration remains
  fail-closed;
- `session_idle`, missing engine, and session/message `404` no longer produce
  successful completion; completion requires a stable post-admission terminal
  message from the exact OpenCode session;
- prompt runs carry a deterministic OpenCode admission `messageID` derived from
  the already durable workspace, engine-session, and client-message identities;
  legacy records without that correlation fall back to the persisted creation
  timestamp and remain fail-closed when evidence is missing;
- terminal candidacy uses the existing durable `waitReason` and
  `lastProgressSignature` fields, so a restart can lose only the first
  observation and can never fabricate completion or release a live owner;
- the existing terminal-delivery coordinator coalesces repeated hydration for
  one exact run while retaining ID-based message/part updates;
- focused app, orchestrator, server, and headless lifecycle tests pass,
  including the transient-idle multi-step integration and follow-up submit;
- the canonical runtime and server contract documentation is updated;
  manual duplicate classification and the sanitized live artifact remain
  outstanding, so `done` remains false.

## Owner and identity contract

| Concern | Authority | Required identity |
| --- | --- | --- |
| OpenCode DB candidate selection | Veslo server read store | workspace, directory, optional exact OpenCode session |
| Host transcript persistence | Veslo server conversation service/store | workspace, conversation, OpenCode session, directory |
| Run admission and terminality | Orchestrator run registry | workspace, conversation, run, OpenCode session, engine generation |
| Terminal transcript recovery | App lifecycle recovery owner | workspace, conversation, run, materialized UI session, OpenCode session alias |
| Visible mutation ordering | Existing terminal-delivery coordinator | exact run plus canonical message/part identity |
| Composer admission | Session/composer flow plus server queue | exact conversation, active run, client message, queue result |

Foreground workspace selection is not an identity authority for any phase.

## Phase 0 — Evidence and duplicate classification

Before changing projection semantics, use the existing bounded diagnostics at
write, lifecycle, and render boundaries. Do not log response text, tool arguments, absolute user
paths, credentials, or file contents.

Record the following envelope for each visible assistant mutation:

```text
workspaceId
directoryHash
conversationId
runId
clientMessageId
uiSessionId
opencodeSessionId
messageId
partId
eventId
eventSource          # live-sse | terminal-hydration | host-cache | local-echo
writeOwner
canonicalRevision
projectionRevision
terminalFenceState
```

The live run must classify the first duplicate as exactly one of:

```text
same canonical identity projected twice
different canonical identities with equal visible content
late live event after terminal hydration
delta replay
second UI projection or local echo
renderer-only churn with stable canonical state
not reproduced
```

The first, third, fourth, fifth, or sixth classifications authorize a Veslo
projection fix. Different canonical OpenCode identities with equal text remain
distinct content and are diagnosed without text-based suppression.

## Phase 1 — Scope-aware transcript candidate resolver

### Candidate classes and fallback policy

Build ordered candidates with explicit provenance:

1. workspace-scoped explicit DB path;
2. workspace-scoped explicit data directory/data home;
3. process-wide explicit DB path/data directory/data home;
4. implicit workspace-local `.opencode/opencode.db`;
5. implicit global OpenCode database.

Candidates 1–3 are authoritative. Select the highest-precedence configured
candidate and fail closed if it is missing, unreadable, schema-incompatible, or
does not contain the requested scope. Do not continue to implicit candidates.

Candidates 4–5 are fallbacks. Evaluate them in order and continue after an
unusable candidate.

### Candidate fitness

Every candidate is opened read-only and evaluated without mutation. Fitness is
operation-specific:

1. file exists and is readable;
2. SQLite can be opened read-only;
3. for conversation listing, the `session` table and listing columns exist;
4. for limited/complete transcript reads and canonical ingest, the `session`,
   `message`, and `part` tables and required columns exist;
5. for exact transcript reads, the exact session exists under an accepted
   directory variant;
6. for conversation lists, at least one row exists for the requested directory;
7. the requested query can be executed without unsupported-schema errors.

For an implicit list where all usable candidates contain zero scoped rows,
return an empty list from the highest-precedence schema-valid candidate and
record that no scoped rows were found. For an exact transcript where no
implicit candidate contains the session, return `source=unavailable` with a
sanitized multi-candidate diagnostic.

### Diagnostics and cache behavior

Return:

- selected candidate provenance;
- whether fallback occurred;
- sanitized rejection reason per attempted candidate;
- selected source fingerprint derived from provenance, file metadata, and
  schema version, without exposing the raw path to normal UI logs.

Only a usable successful transcript may become a warm transcript snapshot.
Unavailable results may be request-coalesced briefly but must not become a warm
empty snapshot. A cache entry is invalid when the selected source fingerprint
changes or a live host transcript append invalidates the exact scope.

The host transcript store remains first for already-ingested conversations.
This phase changes only the OpenCode source fallback used when the host store
needs source data.

## Phase 2 — Durable exact-run terminal confirmation

### Probe result vocabulary

Replace the ambiguous boolean result with a discriminated outcome:

```text
active
terminal_candidate
unreachable
missing
```

- `busy`, `retry`, an open assistant message, active tool part, new text, or a
  changed post-admission watermark is `active`.
- `session_idle` is at most `terminal_candidate`.
- an engine that is absent/unhealthy is `unreachable`; exact generation-loss
  handling remains responsible for terminal failure.
- session/message 404 is `missing`, never successful completion.
- a terminal assistant message is a candidate only when it is newer than the
  run's admission watermark.

### Admission watermark

Before forwarding the mutating OpenCode submit, Veslo derives a deterministic
OpenCode user-message identity from the exact workspace, engine session, and
already durable `clientMessageId`, then forwards it as `messageID`. The run
record already persists the same `clientMessageId`, so the probe can reconstruct
the admission fence after restart without adding duplicate watermark columns.
Legacy runs without a client message identity use their persisted creation time
as a weaker compatibility fence and cannot complete from an old terminal
message when that timestamp is unavailable.

If the pre-dispatch transcript probe is unavailable, mark the baseline as
unknown. An unknown baseline cannot use an old terminal assistant message as
proof of completion. It may become terminal only after observing a new
post-dispatch message identity or another explicit run-correlated completion
signal.

### Durable candidate state

The preferred durable fields are already present in the run record:

```text
clientMessageId
createdAt
waitReason
lastProgressSignature
completedAt
```

Initial validation contract (not a timer-based production default):

- one coherent lifecycle observation combines the OpenCode status read with a
  successful exact-session message read;
- the latest assistant message is terminal, newer than the run admission
  watermark, and has no active tool part;
- a transient `session_idle` without that post-admission terminal snapshot keeps
  the run and reservation active;
- if the lifecycle poll cadence later proves that OpenCode can emit more work
  after such a snapshot, add a durable candidate/quiescence state rather than
  guessing a timeout in the registry.

The admission watermark and no-new-activity condition are mandatory. Missing
evidence never becomes `completed`; explicit abort, engine loss, or upstream
error remain the only non-success terminal paths.

Do not mark a reachable, possibly still-running OpenCode loop as `failed` only
because a guessed confirmation timeout expired. The timeout path must first
use an explicit abort/engine-loss/error contract, or remain a visible
non-terminal confirmation state with a safe recovery/stop path. In every case
it must never write `completed` from missing evidence and must not release the
queue owner while the upstream run may still be producing content.

On process restart, reconciliation resumes from the persisted candidate state.
A stale owner generation, missing engine, or engine-loss callback cannot be
converted into successful completion.

### Late activity after terminality

If exact-session activity newer than the confirmed terminal watermark appears
after terminalization:

1. emit a structured lifecycle conflict containing the exact run and identity
   envelope;
2. invalidate the matching host/prefetch transcript snapshot;
3. request one exact transcript recovery;
4. merge canonical entities through the existing hydration and
   terminal-delivery owners;
5. never suppress distinct IDs merely because text is equal.

The durable terminal status is not silently reopened in this plan. If evidence
shows OpenCode routinely emits post-confirmation work beyond this contract,
terminal reopening requires a separate lifecycle design.

## Phase 3 — Idempotent canonical projection

Retain the current physical store shape. The logical envelope has two layers:

```text
scope:  workspace + directory + OpenCode session (+ run where relevant)
entity: message ID; part entity = message ID + part ID
```

Within one exact materialized UI session:

- repeated hydration of the same message/part IDs creates one visible entity;
  legitimate streaming updates to that entity remain allowed;
- live and hydrated entities with the same IDs merge/update once;
- an OpenCode session alias is retargeted to the materialized UI session before
  hydration and must not create a second UI session;
- terminal hydration cannot erase newer live parts unless it is explicitly
  marked terminal-authoritative for the exact run;
- a late live event passes through an explicit late-activity/conflict path and
  cannot silently bypass the terminal-delivery run fence;
- different canonical IDs are retained and diagnosed even when visible text is
  equal.

Do not add composite physical keys unless Phase 0 proves that OpenCode IDs
collide across live scopes in the same app store. If such a collision is
proven, stop this phase and write a separate migration plan.

## Phase 4 — Composer admission and recovery safety

Introduce one pure block-reason resolver shared by button, Enter, and any
programmatic submit path. It returns one of:

```text
none
empty_draft
recovery_identity_unavailable
lifecycle_busy
local_submit_inflight
send_now_inflight
server_unavailable
```

Preserve the current normal-send contract: `busy && !streaming` remains a
client-side block while an exact run is genuinely active. This plan must not
silently turn every normal send into a queue submission. The required fix is
that a falsely completed or terminally reconciled run clears the stale busy
owner, allowing the next normal send. Any policy change that permits normal
sends while another run is active is a separate queue/admission plan.

An unavailable terminal transcript does not imply
`recovery_identity_unavailable` when workspace, conversation, run, and session
identities are already known. Exact terminal status clears matching optimistic
and busy presentation state even if hydration later reports unavailable.

Every blocked attempt records:

```text
blockReason
workspaceId
conversationId
runId
clientMessageId
uiSessionId
opencodeSessionId
sending
busy
streaming
recoveryState
```

Do not include draft text. A normal follow-up accepted after exact terminal
reconciliation proves that composer recovery is healthy even while the prior
transcript is being retried. A queued follow-up while another run is active is
not an acceptance requirement here.

## Automated test matrix

No E2E driver is required. These tests are mandatory before manual live
acceptance.

### Server read-store and cache tests

1. Schema-invalid implicit local DB falls through to a valid global exact
   transcript.
2. Schema-valid but empty implicit local DB falls through to a global session.
3. Schema-valid local DB with another directory/session falls through for the
   exact requested scope.
4. Invalid explicit DB configuration fails closed and never reads global data.
5. Missing/unusable local and global candidates return sanitized attempted
   provenance and truthful `source=unavailable`.
6. Implicit conversation listing chooses the first candidate with scoped rows;
   all-valid-empty returns a truthful empty result.
7. Unavailable reads do not become warm empty snapshots.
8. A source fingerprint change invalidates the cached source snapshot.
9. Listing validation does not require transcript tables, while exact recovery
   validation does.

### Orchestrator lifecycle tests

1. `idle -> new assistant/tool progress -> idle` keeps the run active and
   restarts the candidate window.
2. Two stable candidate observations with unchanged post-admission terminal
   watermark complete exactly once.
3. A terminal assistant message that predates admission cannot complete the
   current run.
4. Engine absence and session/message 404 never produce `completed`.
5. Engine generation loss still produces exact failed/lost terminality.
6. Restart during a candidate window resumes durable confirmation without
   resetting identity or fabricating completion.
7. Missing terminal evidence never produces `completed`; timeout handling
   follows the explicit abort/engine-loss policy and does not release a live
   upstream owner speculatively.
8. Concurrent runs in other conversations are unaffected by one candidate,
   timeout, abort, or engine loss.

### Server/orchestrator multi-step integration

Use compiled server and orchestrator processes with a deterministic local
OpenCode/provider fixture, but no UI:

1. submit run A and capture its exact admission watermark;
2. return idle, then tool/assistant progress, then idle;
3. prove A remains active across the transient idle;
4. confirm stable terminality and exact transcript recovery;
5. queue run B during A and prove it starts only after A's terminal release;
6. repeat with engine loss and prove it fails rather than completes;
7. restart the orchestrator during terminal candidacy and prove recovery from
   durable candidate state.

### App/store tests

1. Repeated exact hydration creates no second visible message or part; normal
   streaming updates to an existing entity remain possible.
2. Live event plus terminal hydration with the same IDs produces one canonical
   visible entity.
3. OpenCode alias hydration lands under the materialized UI session only.
4. Older terminal hydration cannot overwrite a newer accepted run.
5. Distinct IDs with equal text are retained and diagnosed, not deduplicated.
6. Terminal recovery unavailable clears matching optimistic/busy state.
7. A normal follow-up after exact terminal reconciliation reaches the server;
   a genuinely active `busy && !streaming` run keeps the existing client-side
   admission policy.
8. Button and Enter emit the same exact block reason and identity envelope.

## Manual live-run validation without E2E

Use the real dev or installed Tauri runtime after the standard single-tenant
preflight. The operator drives the UI manually; no Tauri Pilot or E2E fixture is
used.

Use an isolated test profile and isolated OpenCode data home. Never mutate or
depend on the user's real global OpenCode database. Prepare:

- one implicit workspace-local DB that is either schema-invalid or
  schema-valid without the target session;
- one valid isolated global DB containing the exact target session;
- a deterministic local provider capable of an observable
  `idle -> progress -> idle` multi-step sequence;
- diagnostic capture enabled with text/path redaction.

Validation sequence:

1. Start the real Tauri runtime and record app/server/orchestrator/OpenCode
   versions and isolated profile identity.
2. Confirm the invalid local candidate is skipped and the exact global source
   fingerprint is selected.
3. Submit a tool-using prompt and capture workspace, conversation, run,
   OpenCode session, message, part, event, and projection revisions.
4. Confirm transient idle does not clear the active run, release its
   reservation, or start its queued successor.
5. Confirm stable exact terminal evidence releases the run exactly once.
6. Retry terminal hydration twice and verify canonical message/part counts do
   not increase.
7. Classify any visible duplicate using the Phase 0 vocabulary.
8. Force transcript recovery unavailable after exact terminality and submit a
   normal follow-up; confirm the request reaches the server. Do not use this
   step to change the policy for sending while another run is genuinely active.
9. Repeat with a much longer response only as a stress variation. Response
   length is not the variable under diagnosis.

Store a sanitized artifact containing the identity timeline, candidate
diagnostics, lifecycle transitions, projection revisions, composer block
reasons, and final classification. Do not store response text or raw paths.

## Acceptance criteria

- Invalid implicit workspace-local DB candidates no longer mask a valid global
  exact transcript source.
- Invalid explicit configuration fails closed without reading unrelated global
  data.
- Schema-valid but scope-empty implicit DB candidates do not mask the exact
  session available in a later candidate.
- Unavailable reads are truthful, sanitized, and never cached as a warm empty
  transcript.
- `session_idle`, engine absence, and session/message 404 cannot directly write
  successful completion.
- Completion requires stable post-admission exact-run evidence and survives an
  orchestrator restart without losing its fence.
- Transient idle followed by progress keeps the same run and reservation active.
- Missing terminal evidence never becomes successful completion; timeout and
  queue release follow an explicit upstream abort/engine-loss policy.
- Each canonical message/part identity has at most one visible entity; normal
  streaming updates remain possible, and equal text with distinct canonical
  IDs is not silently removed.
- Repeating terminal hydration does not add visible entities.
- Late activity is diagnosed, invalidates stale snapshots, and is merged
  without bypassing the terminal-delivery owner.
- Transcript recovery failure does not permanently block the next normal send.
- Button and Enter expose the same exact send-block reason.
- Focused automated tests and the headless multi-step integration are green.
- Manual live validation produces a sanitized artifact and either reproduces a
  classified duplicate or records `not reproduced`.

## Canonical documentation updates required after implementation

Before setting `done: true`, update canonical documentation for:

- implicit versus explicit OpenCode DB source policy;
- source fallback and sanitized diagnostics;
- durable terminal-candidate semantics and timeout behavior;
- normal-send server queue admission while another run is active;
- live diagnostic fields and safe artifact handling.

This plan remains historical implementation guidance after those canonical
documents are updated.

## Explicit non-goals

- Assistant response length is not a bug.
- No E2E scenario or E2E fixture is required.
- No change to engine count or workspace pooling topology is implied.
- No text-based deduplication is allowed.
- No user database is deleted, rewritten, migrated, or repaired silently.
- No broad UI transcript-store key migration is allowed without collision
  evidence.
- No foreground-workspace fallback may substitute for exact run/session scope.
- The earlier OpenCode reload-failed event is not treated as causal without a
  new identity-level trace.

## Implementation order and completion gate

1. Review the existing bounded diagnostics and reproduce/classify the visible duplicate;
   add fields only if the live trace shows an actual identity gap.
2. Implement and test the scope-aware DB candidate resolver.
3. Use the deterministic admission watermark and existing durable candidate fields.
4. Replace boolean inactivity with the discriminated probe/state machine.
5. Add the headless multi-step server/orchestrator test.
6. Keep the conservative exact-run hydration coalescing guard; apply broader
   projection corrections only when Phase 0 identity evidence authorizes them.
7. Unify composer admission/block reasons and verify server queue handoff.
8. Run focused suites, typechecks, `git diff --check`, and the manual live run.
9. Update canonical docs and attach the sanitized live artifact.

`done: true` is allowed only when every acceptance criterion is evidenced. A
manual live run alone, green unit tests alone, or failure to reproduce the
duplicate without the Phase 0 instrumentation is insufficient.
