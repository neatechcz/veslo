---
title: Engine-Generation Historical Continuation Recovery Plan
status: implemented-p0 (macOS preserved-state hardware verification pending)
date: 2026-08-03
issue: unlinked
scope: unblock historical-conversation continuation after a proven dead engine without creating a second runtime owner or retaining stale runtime state as durable conversation truth
related:
  - docs/plans/2026-08-03-runtime-projection-and-legacy-queue-recovery-plan.md
  - docs/dev/conversation-workflow-contract.md
  - docs/dev/opencode-workspace-runtime-architecture.md
  - docs/dev/feedback-diagnostics.md
---

# Engine-Generation Historical Continuation Recovery Plan

## Decision

P0 extends the existing engine-generation authority and server lifecycle
controller. It does not introduce a new runtime lease, queue, scheduler, or
conversation-storage model.

Conversation identity, OpenCode binding, and transcript remain durable
history. Engine owner identity, run state, reservations, handoff barriers, and
UI thinking state remain runtime evidence. Runtime evidence may block a
successor only while the existing generation authority proves that the exact
engine could still own the OpenCode session.

The orchestrator remains the sole authority for engine identity and owner-loss
evidence. The server remains the sole owner of admission, queueing, handoff,
and release. The desktop sends a conversation intent and projects the
server-owned result; it never declares a runtime dead, clears a queue row, or
chooses a recovery branch.

P1 transcript-only continuation is explicitly deferred. It is needed only for
a legacy state that cannot safely reuse the old OpenCode session even after P0
has cross-platform owner evidence. It must not trigger a binding/transcript
rewrite before production evidence proves that fallback is needed.

## Evidence and Boundary

The two feedback exports overlap in time and include the same local server and
orchestrator stream. They are not independent proof of four separate incidents.
Their user-capture scope identifies one workspace, but the raw server stream
also contains other workspaces; an unscoped event must not be attributed to the
feedback author.

For the scoped historical-conversation send, the evidence proves this chain:

1. one existing conversation and OpenCode session were resolved;
2. the active-run check did not return a non-terminal owner;
3. registration returned `RunAlreadyActiveError` for a predecessor of that
   same conversation;
4. the server inserted exactly one queue row at position one.

The code explains the apparent contradiction: registration checks the latest
run as well as active runs, while the earlier active read intentionally omits a
terminal run. A terminal predecessor blocks registration whenever
`runtimeReadyForSuccessor` is not `true`.

The export does **not** currently record the predecessor status, readiness,
engine owner state, generation evidence, or terminal-handoff recovery outcome.
It therefore cannot prove whether the affected readiness was `false` (known
busy) or `null` (unavailable), nor whether an engine was absent. These are
implementation hypotheses that P0 observability must make verifiable.

## Existing Building Blocks

The following are already implemented and must be reused:

- durable engine-generation records with exact owner tuple and confirmed exit;
- guarded `lost_proven` recovery, including active-peer and current-engine
  checks;
- terminal-handoff barriers that survive restart and have explicit retry
  verification;
- server-owned durable queue, reservation, FIFO dispatch, and stable message
  idempotence;
- lifecycle status that carries readiness and owner information;
- transcript and conversation-binding storage physically independent from
  runtime run storage.

The current gaps are narrower:

1. the process-identity inspector deliberately fails closed outside Windows;
2. first admission loses predecessor classification through a narrow 409 and
   queues before the existing recovery path is evaluated;
3. direct admission and queue drain do not share one predecessor decision;
4. startup only sweeps old active rows, not prior-generation terminal owners;
5. feedback diagnostics omit the fields needed to establish the above facts.

## P0 Contracts

### 1. Exact predecessor classification

Add one server-internal `classifyPredecessor` operation. Both first admission
and queue drain call it against `latest/status`, never only `active()`.

| Classification | Required evidence | Server action |
| --- | --- | --- |
| `ready` | No predecessor, or terminal predecessor with readiness `true`. | Admit normally. |
| `active_exact_owner` | Non-terminal predecessor from lifecycle owner. | Retain one ordinary queue item behind that run. |
| `terminal_owner_lost_proven` | Terminal predecessor plus existing generation authority `lost_proven` result. | Mark only the matching owner lost, re-read status, and admit through the existing binding. |
| `terminal_handoff_unresolved` | Terminal predecessor lacks readiness and owner recovery cannot prove loss. | Persist/retain the existing barrier, stop ordinary queue-drain retries, and return a clear recovery-required result. |
| `lifecycle_error` | Lifecycle transport/auth/protocol error. | Return the existing typed error; do not substitute stale durable state. |

The classifier may call the existing terminal-runtime-handoff recovery once
when the lifecycle result meets its existing guarded preconditions. It must
then re-read lifecycle status before deciding. A successful recovery never
releases a different run, different engine owner, or active peer.

For a new user message, `terminal_handoff_unresolved` is not a normal queue
outcome: preserve the local draft and return the typed recovery-required
result. For an already durable queue item from an earlier version, retain the
intent but transition it into its existing durable unresolved barrier state;
do not repeat normal drain polling or manufacture more queue rows.

### 2. Cross-platform owner-loss evidence

The existing Windows process-birth implementation remains valid. P0 adds a
production exact-process inspector for the platforms Veslo ships:

- macOS: use a small native helper backed by `libproc` `proc_pidinfo` with
  `PROC_PIDTBSDINFO`, and derive the opaque birth token from
  `pbi_start_tvsec` plus `pbi_start_tvusec`; a shell-only `ps` timestamp is
  not sufficient proof;
- Linux: combine `/proc/sys/kernel/random/boot_id` with field 22 (`starttime`)
  of `/proc/<pid>/stat` to form the opaque birth token; a PID or `kill(pid, 0)`
  alone is not proof;
- Windows: retain the current exact process start-time token;
- unsupported or inaccessible environments: return `unknown`, never `absent`.

The platform helper must expose only an opaque birth token to TypeScript. Its
contract is `alive(same token)`, `absent`, or `unknown`; a mismatched token is
the positive PID-reuse result, not evidence that the expected owner is dead.
It does not publish commands, paths, process arguments, or credentials. Unit
tests inject the helper so all three outcomes, including PID reuse, are
deterministic on every development platform.

Shutdown ordering stays within the existing generation authority: record
`stopping` before requesting child shutdown, record `exited_confirmed` only
after child exit or exact absence is confirmed, and never let a restart mark a
live or PID-reused process as lost.

### 3. Prior-generation startup sweep

Before the lifecycle surface accepts new work, sweep generation records from a
previous orchestrator instance that still have attached terminal runs:

1. inspect the exact owner tuple using the cross-platform helper;
2. on `absent`, use the existing generation authority to create/confirm the
   exited evidence and mark only matching runs lost;
3. on `alive` or `unknown`, retain the exact barrier and leave it for the
   shared classifier; and
4. never infer owner death from a new empty engine pool, a changed PID, or a
   timeout.

This is an extension of the current generation authority, not a second
runtime-lease table. It makes a completed old conversation reusable after a
verified restart while preserving the fail-closed behavior for an unproven
owner.

### 4. Admission and queue ordering

Direct admission must classify the predecessor before allocating a new run or
creating a normal queue item. If registration still races with a predecessor,
the 409 path invokes the same classifier and retries registration at most once
after `terminal_owner_lost_proven`.

Queue drain uses the same classifier. Its only polling state is
`active_exact_owner`; an unresolved terminal handoff becomes a durable blocked
state with no automatic drain loop. Explicit retry verification remains one
server-owned operation and reuses the original client-message id.

No server response owns a desktop selection epoch. Server responses carry only
durable workspace/conversation/run/queue identities and lifecycle evidence.
The desktop captures its local selection epoch around a request and discards a
late response that no longer matches the selected scope.

## P0 Observability First

Implement these events before changing recovery behavior:

- `predecessor-classified` with workspace, conversation, predecessor run,
  classification, readiness, owner state, generation-evidence kind, and finite
  reason code;
- `terminal-handoff-recovery` with attempt, requested/result outcome, and
  post-recovery readiness;
- `admission-decision` with direct/queued/blocked result and the exact
  client-message/queue ids;
- `queue-drain-decision` with the same classification and whether a later poll
  was scheduled;
- `prior-generation-sweep` with bounded counts and reason-code totals.

All events omit prompt text, transcript text, raw paths, endpoints, tokens,
and provider payloads. The feedback exporter must:

1. derive the primary workspace from the user-capture correlation;
2. label events outside that workspace as out-of-scope rather than mixing them
   into the incident summary;
3. recognize lifecycle registration conflicts and terminal-handoff decisions
   as signals/anomalies; and
4. report missing predecessor fields explicitly instead of implying that a
   queue conflict was fully explained.

## P0 Implementation Steps

1. Add focused unit tests that capture the current loss of terminal
   predecessor information at direct admission and the difference between
   `active()` and `latest/status`.
2. Add the observability events and feedback-export grouping above. Verify a
   fixture containing overlapping workspace logs produces one scoped finding
   plus separately counted out-of-scope events.
3. Implement the platform process-identity helper and its Windows/macOS/Linux
   contracts: `libproc` on macOS, boot-id plus `/proc/<pid>/stat` on Linux, and
   the existing start-time token on Windows. Do not enable automatic owner-loss
   on a platform until its exact inspector test passes.
4. Extend the existing generation authority with the prior-instance terminal
   owner sweep and exact shutdown ordering. Reuse existing owner/generation
   records; do not add a lease or duplicate authority.
5. Implement `classifyPredecessor` inside the existing server lifecycle
   controller and route both direct admission and queue drain through it.
6. Make the direct 409 race path preserve/return the classification and retry
   registration once only after a proven loss. Make unresolved state terminal
   for a new submit and durable-blocked for an existing queue item.
7. Update the canonical runtime and feedback diagnostic documentation with the
   new decision states, explicit retry semantics, platform support, and data
   boundaries.

## P1 Decision Gate: Transcript-Only Continuation

After P0 has shipped to macOS and diagnostics have measured real outcomes,
review only records classified `terminal_handoff_unresolved` because evidence
is inherently unavailable, not records caused by a missing implementation.

If that path is material, write a separate implementation plan for a
server-owned recovery operation that creates a new OpenCode session from a
bounded canonical transcript. It must decide whether the recovered session is
a visible child conversation or requires a logical multi-segment conversation
model. The present binding uses a stable conversation identity derived from an
OpenCode session, so in-place rebinding is not an acceptable shortcut.

Until this decision is separately approved, P1 returns a clear terminal
recovery-required result and preserves the user's draft. It does not silently
discard the message, show indefinite thinking, or create a second session.

## Deferred Cleanup

Runtime-row retention is a separate P2+ cleanup, not a claim about current
behavior. After P0, define a bounded janitor for terminal run and completed
recovery metadata. It must never delete transcript, binding, conversation, or
user-visible history. Choose its duration only with a diagnostic-retention
decision; do not couple it to admission correctness.

Queue-drain cadence is also separate. The current server drain interval and
the app-side lifecycle observer are different mechanisms. Establish their
product requirements from one canonical document before changing either one.

## Verification Matrix

The real desktop scenario is WebDriverIO over the Tauri runtime. Focused tests
support crash and process-identity boundaries that cannot be made deterministic
through visible UI alone.

| Scenario | Required proof |
| --- | --- |
| Existing historical conversation, old owner proven absent | Fresh desktop process reopens it and directly submits one new message through the existing binding. Exactly one assistant turn appears; no queue/thinking projection is inherited. |
| Prior owner live | A second runtime does not start a competing engine or submit into the same session. One existing queue item remains the only ordinary queue state. |
| Legacy unknown owner | A new send does not create a normal queue item. The UI retains the draft and shows the terminal recovery-required state. |
| Direct registration race | The server classifies the latest predecessor, retries at most once after proven loss, and never duplicates the OpenCode message id. |
| Existing queued row behind unresolved terminal run | Queue drain writes one durable blocked state and stops automatic drain retries; one explicit retry verification is available. |
| Restart sweep | Only owner tuples proven absent are marked lost. A live, PID-reused, or unknown owner stays protected. |
| Feedback export | Overlapping logs are scoped to the capture workspace; a registration conflict and absent handoff evidence appear as named findings. |
| macOS preserved-state restart | A fresh macOS desktop binary, preserved data, and a real restart prove exact process-identity absence before a historical continuation is admitted. |
| Selection A -> B -> A | Late lifecycle/queue responses never render another conversation's thinking or queue state. |

Required lanes:

1. orchestrator generation-authority and platform-inspector tests, including
   injected absent/alive/PID-reused/unknown outcomes;
2. server lifecycle-controller and queue-store tests over preserved SQLite
   state, direct admission, the 409 race, and queue drain;
3. feedback exporter tests for scoped capture grouping and new anomaly classes;
4. a focused WebDriverIO scenario over a freshly built Tauri runtime with
   preserved historical state and a forced fresh process;
5. a macOS runner or controlled macOS hardware execution for the
   preserved-state restart proof; and
6. `pnpm check` after focused lanes pass.

## P0 Acceptance Criteria

1. The implementation reuses the existing generation authority; no parallel
   runtime lease, second queue, or UI lifecycle owner exists.
2. On macOS, Linux, and Windows, a process is marked lost only after the
   platform-specific exact identity mechanism proves absence.
3. A historical conversation whose prior owner is proven absent continues in
   the existing OpenCode session after a fresh Veslo process, with one direct
   admission and one visible assistant turn.
4. A live, PID-reused, inaccessible, or otherwise unknown owner cannot be
   force-released or submitted to concurrently.
5. A new send behind unknown legacy evidence is not represented as a normal
   queued/thinking message. Its draft remains recoverable with a finite,
   server-owned terminal result.
6. The direct admission path and queue drain use one predecessor classifier
   and retain existing FIFO and client-message idempotence guarantees.
7. Feedback diagnostics distinguish scoped admission conflicts, predecessor
   readiness, generation evidence, and recovery outcome without retaining user
   text.

## Non-Goals

- Declaring owner death from an empty in-memory pool, a timeout, or a PID alone.
- Deleting or rebinding existing conversation/transcript storage in P0.
- Replacing the server-owned queue or moving its lifecycle logic into the UI.
- Changing queue-drain cadence as a side effect of continuation recovery.
- Implementing transcript segment recovery before P0 data demonstrates it is
  needed.

## Implementation Record (2026-08-03)

P0 is implemented with the existing generation authority rather than a new
lease. The server now performs one shared predecessor classification for direct
admission, registration conflict, and queue drain; an unproven historical
terminal owner returns a finite recovery-required result for a new draft and
becomes the existing durable unresolved barrier only for an already accepted
queue item. A proven loss gets one fresh lifecycle read and at most one
registration retry with the same client and OpenCode message identities.

The orchestrator now sweeps prior-generation terminal owners before serving
lifecycle work, and the production inspector has exact process-birth tokens on
Windows, macOS, and Linux. Feedback export groups the incident by one valid
user-capture workspace correlation and labels all other workspace evidence as
out of scope. It also reports predecessor classification, recovery result, and
generation-evidence kind without retaining message text.

Verification completed locally: focused lifecycle, generation, feedback, and
preserved-state server tests; compiled server/orchestrator oracle; and
`pnpm check`. The remaining acceptance lane is a fresh macOS Tauri binary over
preserved production-like state. It requires macOS hardware or a macOS runner
and has not been represented as completed by this Windows checkout.
