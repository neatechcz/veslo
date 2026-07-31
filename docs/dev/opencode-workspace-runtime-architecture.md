# OpenCode Workspace Runtime Architecture

This is the canonical developer reference for Veslo's OpenCode workspace runtime
architecture. Use it before changing prompt sending, session creation,
workspace switching, local Veslo server lifecycle, orchestrator routing,
sandbox behavior, or any server route that talks to OpenCode.

The historical design and implementation planning documents live in
`docs/plans/2026-06-07-opencode-workspace-runtime-design.md` and
`docs/plans/2026-06-07-opencode-workspace-runtime-implementation-plan.md`.
Those documents explain the decision history. This file is the durable source
of truth for future implementation work.

## Core Rule

OpenCode sessions are created in the correct workspace directory and then remain
bound to that directory through the Veslo conversation.

The app must not create an OpenCode session, choose an OpenCode session id, or
override the OpenCode directory as a side effect of current UI selection. The
app sends intent. Veslo resolves execution.

The identities are deliberately separate: an OpenCode process generation has
one `engineOwnerId`; it may hold multiple directory instances; each directory
instance has a canonical directory key and freshness epoch; sessions are pinned
to a directory; and Veslo runs remain independently attributable to a
conversation, session, and process generation.

## Verified OpenCode Behavior

The bundled OpenCode 1.17.13 compatibility gate was checked with one
`opencode serve` process and multiple temporary directories.

Verified behavior:

- one OpenCode server process can create multiple sessions in different
  directories,
- concurrent shell actions in those sessions run in their own session
  directories,
- an existing session remains pinned to the directory where it was created,
- passing a different directory later does not retarget that existing session.

This is an upstream capability, not a statement that Veslo production supports
multi-workspace shared skills. Veslo must additionally prove policy closure,
per-directory freshness, event routing, and immutable launch-profile placement
before it enables a directory-scoped shared topology.

This verification covered session and shell filesystem behavior. Real model
prompt streaming still needs desktop end-to-end validation when implementation
changes.

## Ownership Boundaries

### Solid App

The app owns user intent and visible UI state.

The app may send:

- workspace id,
- conversation id when continuing a known conversation,
- message content,
- user-selected agent or variant choices.

The app must not send:

- a client-chosen OpenCode session id for a new run,
- a raw OpenCode directory override,
- a run target based only on the currently selected workspace,
- global busy or error state that represents a different workspace run.
- a user, session, automation, or transcript-derived model override. Managed AI
  resolves the effective model from the gateway's global active platform model.

When the user sends the first message, the app should show a prepared local
message and let the runtime attach the workspace and create the conversation in
the background. Workspace activation must not be a UI-blocking precondition for
the send action.

For an existing local conversation, a missing live OpenCode binding before the
server HTTP submit triggers at most one engine-only reachability recovery. That
recovery uses the snapshotted workspace and the original client-message id, but
does not refresh Managed AI configuration or authorization and never reuses a
stale URL. Managed AI remains a server-owned submit concern after a live binding
is available. A later transport replay is a separate, single idempotent retry.

### Send Boundary Validation

The app can validate Veslo-owned send boundary payloads before treating them as
business facts. Runtime preflight results, server-owned conversation submit
requests, and terminal submit responses are validated at runtime and reported
through send trace events when malformed.

The validation mode is controlled by `VITE_VESLO_SEND_BOUNDARY_VALIDATION`:
`off` skips validation, `report` records validation failures without changing
the send result, and `strict` fails closed. The default is `report` so release
builds keep sending even when a malformed background diagnostic payload is
observed.

Validation uses Zod `safeParse`; successful checks are recorded as
`validation-checked` events, and failures are converted to send trace payloads
with `schema`, `validationMode`, `blocking`, `issueCount`, `issues`, and a small
redacted payload summary. The validator must not throw directly.

When running `pnpm dev`, validation output is visible through the existing send
trace surfaces:

- stable gitignored mirror: `.tmp/send-workflow-trace.ndjson`, including
  app-forwarded events plus server and orchestrator send trace events when
  those processes inherit the trace environment
- timestamped runtime archive printed by startup:
  `sendWorkflowTrace=.../send-workflow-trace.ndjson`
- one shared native sink: `[ui:send-workflow-trace-batch] batch persisted`
- in-memory webview buffer: `window.__vesloSendTrace`

For a workspace-specific failure, correlate records using `traceId` and the
redacted `workspacePathId` / `workspaceDirectoryId` fields. They are stable
SHA-256 prefixes for the selected local checkout and request directory, so a
stale workspace registration can be distinguished from a different checkout
without writing local paths into the trace. The server records these on
OpenCode requests and registration; the orchestrator records the corresponding
path ids at registration, workspace resolution, skill-view validation, and
engine spawn. Terminal lifecycle entries also carry the bounded, credential-
redacted `terminalError` and the engine owner tuple.

App-side send trace payloads are sanitized before they enter the webview
buffer or the shared native workflow trace. Raw paths, URLs, prompts,
credential fields, and nested equivalents are replaced with a fixed redacted
value. App and composer local buffers feed that sink once; the sink coalesces
short batches before crossing Tauri IPC, so diagnostics do not create one native
write per renderer event. Runtime performance events use the same bounded
delivery rule, while UI-effect incident and benchmark records enter the shared
workflow sink instead of opening their own native IPC lane. Both queues flush
on renderer teardown. Correlate app events by `traceId` and
stable workspace identifiers; never recover a path from diagnostics.

For a failed send, the app also retains at most 16 persisted workspace-keyed
failure snapshots in `window.__vesloSendFailureSnapshots`. Each keeps the first
observed failure and the final terminal failure using only trace ID, event,
phase, code, status, and the pre-HTTP marker. Stored values are normalized on
read and never include a message, local path, URL, prompt, or credential.

Server workflow and skill-audit NDJSON use the same boundary: sensitive
payload keys and path/URL/credential-bearing exception text are replaced before
the entry is written or mirrored. Keep endpoint paths, status, stable IDs, and
trace IDs for correlation; do not bypass this writer with an ad-hoc JSON log.

Desktop cold activation also writes native phases directly into the UI NDJSON
channel with the initiating `traceId`: `desktop-runtime:prepare:entered`,
`queue-acquired`, orchestrator registration, orchestrator activation, optional
activation fallback, fresh-start, and final completion. These rows contain
durations and stable workspace ids only. They distinguish a desktop-side wait
before the orchestrator receives a request from OpenCode spawn or health time,
even if another send later becomes the webview's active trace.

An expected transient close of an OpenCode `/event` stream is recorded as
`orchestrator:event-stream:closed`, with `shutdown` and a stable close reason;
it is not a `proxy-upstream:error` and does not make the engine unhealthy.
Successful send-result rows do not serialize global runtime error text. Rejected
rows retain only the safe `runtimeErrorPresent` boolean.

Useful validation failure events include:

- `sendPrompt:runtime-preflight:validation-failed`
- `sendPrompt:runtime-recovery:validation-failed`
- `sendPrompt:server-submit-existing-request:validation-failed`
- `sendPrompt:server-submit-existing-result:validation-failed`
- `sendPrompt:server-submit-first-result:validation-failed`

To inspect the buffer from DevTools:

```js
window.__vesloSendTrace?.filter((entry) =>
  String(entry.event ?? "").includes("validation-"),
);
```

Strict validation failures are fail-closed for fields needed to continue
safely: workspace/session/run ids, client message ids, submit status, queue
ids, and draft disposition. Diagnostic-only payloads, such as debug trace
entries, must not block a send only because they contain extra or partially
shaped data.

Do not use the app-side validator as a generic provider-stream parser. OpenCode
events and AI gateway provider responses can vary by provider and should be
validated only at small Veslo-owned envelopes or correlation points unless a
specific provider contract is being tested.

### Veslo Server

Veslo server owns the app-facing conversation and run boundary.

Responsibilities:

- validate the workspace id,
- validate and normalize the workspace directory,
- create or resolve the Veslo conversation,
- create or resolve the bound OpenCode session,
- persist the mapping from Veslo conversation to OpenCode session,
- create a run record before submitting work to OpenCode,
- reject conversation ids that belong to another workspace,
- reject directories outside the authorized workspace roots,
- strip client-supplied OpenCode routing fields from mutation bodies.

When a local workspace call is routed through the orchestrator mount
(`/workspace/:id/opencode/...`), the server must first ensure the orchestrator
knows the workspace by idempotently registering the local workspace identity.
This applies to first-message `/session` creation as well as later run submit
calls. Passive app browse state or `POST /workspaces/local` alone is not enough
proof that the orchestrator router has mounted the workspace.

The server route shape should remain workspace-scoped:

- `POST /workspace/:id/conversations`
- `GET /workspace/:id/conversations`
- `GET /workspace/:id/sessions/:sessionOrConversationId/transcript`
- `POST /workspace/:id/conversations/:conversationId/runs`
- `POST /workspace/:id/conversations/:conversationId/abort`
- `GET /workspace/:id/conversations/:conversationId/runs/latest`

For accepted local runs, the server registers active AI gateway run context
before OpenCode submission and keeps that context until lifecycle reconciliation
observes a terminal or missing run state, or until submit fails before the run
can proceed. The provider-start watchdog records diagnostics only; it must not
clear active gateway context while the run may still make later provider
requests. This keeps `traceId`, `runId`, `workspaceId`, conversation id, and
OpenCode session id attached to AI gateway proxy events through the whole send
workflow.

Managed-AI authorization is bound at the same server-owned run boundary. A
workspace-scoped access prime associates the authenticated organization with a
workspace identity already validated by the local server. Run admission copies
that actor-plus-organization binding into active run context. Provider requests
then resolve authorization from the registered OpenCode session and active run,
not from caller-supplied organization or workspace headers. Concurrent runs for
different organizations therefore keep distinct authorization and accounting
scope, and missing or ambiguous multi-organization binding fails closed.

Server-controlled writes must remain expressible through Veslo server APIs.
Avoid adding Tauri-only filesystem mutations for behavior that changes
`.opencode/` state.

### Orchestrator

The orchestrator owns execution strategy and process routing.

It supports pooled-per-workspace as the production topology and retains an
explicit unsandboxed shared fallback for diagnostics. An experimental
directory-scoped shared process exists behind a second explicit opt-in; it is
not a current default and must not be treated as production support:

- pooled workspace engine process,
- explicit `shared-unsandboxed` diagnostic fallback with one process-wide view,
- `shared-directory-scoped` experimental shard only with
  `VESLO_DISABLE_SANDBOX=1`, `VESLO_SHARED_OPENCODE_ENGINE=1`, and
  `VESLO_SHARED_OPENCODE_DIRECTORY_SCOPED=1`.

The experimental shard uses the static relative skill path
`.opencode/.veslo/runtime-skills/current`, resolved by OpenCode from the
canonical workspace-root directory. Veslo publishes that workspace-local view,
closes admission for that directory during an update, and uses directory-scoped
disposal to advance its epoch. A workspace with process-level OpenCode config
(provider, MCP, plugin, or other launch settings) is not profile-compatible
with the first shard and remains pooled rather than mutating the shared
process's launch environment.

Pooled and shared launches deliberately use different projection profiles, but
both disable native project discovery so raw project skills cannot bypass the
effective manifest. A pooled engine receives a workspace-private projection of
allowed `.opencode` agents, commands, modes, plugins, and `AGENTS.md` into its
OpenCode config directory, plus explicit absolute `skills.paths` entries for
the validated directories selected by the effective manifest. It never exposes
raw global skill roots or arbitrary `skills.paths` from inherited configuration.
The experimental shared directory process still receives only Veslo's sanitized
configuration and its separately published effective skill view, with no
workspace launch-capability projection.

The active workspace skill roots are `<workspace>/.opencode/skills`,
`.claude/skills`, `.agents/skills`, and `.agent/skills`. Global OpenCode,
Claude, and agent roots are management/import sources only; the active runtime
resolver uses `includeGlobal: false`. In particular, `%LOCALAPPDATA%/.claude`
is not an implicit engine source. A `.claude/skills` directory inside the
selected workspace is intentionally workspace-local for compatibility.

Before a pooled launch consumes a direct path, the orchestrator validates the
manifest's canonical skill name, entrypoint, source classification, physical
containment in one of those workspace roots, and nested link containment. A
nested `SKILL.md` that is not itself selected by the effective manifest is
rejected before OpenCode can recursively discover it. The pooled launch has no
copied skill generation or generation lease; its binding is the validated,
ordered direct path list and the effective-view revision.

The server and orchestrator additionally share one workspace-source lease at
`<workspace>/.opencode/.veslo/workspace-skill-lease`. Any Veslo-owned mutation
that can change the effective skill view (materialization, user projection,
install, edit, delete, restore, enable-state, import, or provisioning) holds
that lease through the matching effective-manifest publish. Pooled direct-path
validation and shared directory-view publication hold the same lease before
reading a manifest source. This prevents Veslo-owned mutation from exposing a
partially replaced skill directory.

Ownership is token- and process-fenced, and liveness is proven by a heartbeat:
the holder bumps the owner record's mtime about once a second. A waiter reclaims
the lease when the owning process is gone or when its heartbeat has stopped for
well beyond that interval. The heartbeat is what makes recovery safe against pid
reuse, which a liveness probe alone cannot detect. An ownerless acquisition, or a
recovery fence left behind by a process that died mid-recovery, is likewise
reclaimed on age, so a single crash cannot wedge a workspace permanently.

The revision covers a skill's whole directory, not only its entrypoint: the
entrypoint keeps a content hash while nested files contribute size and mtime, so
resolving a view stays cheap. Anything less would call a view unchanged after an
edit to a nested script or schema, even though the direct engine can read that
file after launch.

For the experimental shared-directory topology, staging proves each copy atomic
after the fact, not only before it. Comparing a
source tree's signature either side of the copy is what catches a writer that
edits a file in place: such a change copies without error and would otherwise
yield a generation mixing pre- and post-edit content, with nothing raised. A
single disturbance is absorbed by the staging retry; a source that keeps moving
fails as `skill_view_changed`. The published manifest is re-read after staging
for the same reason — the server may have republished while the generation was
being built.

Engine staging takes a second, narrower filesystem lock on the staging root,
always inside the workspace lease and never the other way round; helpers invoked
while it is held use the explicit unlocked variants. That lock follows the same
liveness and recovery protocol as the workspace lease — heartbeat by owner-file
mtime, reclaim on a dead owner, a stopped heartbeat, an ownerless directory, or
a stale recovery fence. Both locks need every one of those paths: a lock
directory and its owner record are two separate filesystem operations, so a
crash between them leaves a lock nobody can prove ownership of, and without
age-based reclaim that single crash wedges the staging root permanently.

The lease is re-entrant within one process: a code path that already holds it for
a workspace runs nested acquisitions inline. Acquiring it twice for the same
workspace root would otherwise queue the inner acquisition behind the outer one
while the outer one waits for the inner task — a cycle that never resolves.
Callers that take leases for several workspaces at once must deduplicate and
order them by resolved path, not by workspace id, since two ids can name one root.

Activation timeouts are budgeted against each other on purpose: the daemon may
wait up to 30s for this lease and up to 60s for an OpenCode cold start, so the
desktop's activation request allows more than their sum. A desktop ceiling below
the daemon's own budget would report a healthy-but-slow activation as a failure
while it kept running inside the daemon.

Legacy workspace config directories are detection-only during activation. Veslo
records the legacy identity for diagnostics, leaves the old tree untouched, and
creates the new config directory from the current workspace mirror and managed
dependency setup. Runtime staging generations, locks, tools, and unknown files
are never copied as migration state.

Directory placement is pinned when a workspace first enters the experimental
shard and remains immutable for that orchestrator generation. Editing a
workspace config cannot retarget an existing session or run between pooled and
shared processes; applying a different placement requires a controlled runtime
restart/drain. Directory view publication, registration, and refresh are
single-flight per workspace root. A failed publish restores the last ready
lifecycle state, while a failed disposal keeps admission closed and retries
after the active work has drained. Skill staging and generation cleanup are
also single-flight per staging root, including the copy from a completed
generation into a published directory view. The filesystem lock is fenced by
an operation token and process identity; a live owner is never displaced by
an age-based timeout. Foreground engine activation and crash recovery share
the same per-workspace spawn flight, and the resulting engine owner id is
carried through the generation lease.

Runtime prepare is a readiness contract. After a fresh orchestrator daemon start,
the desktop runtime must activate the target workspace engine before returning a
ready engine snapshot; the app should not paper over an absent workspace engine
with generic UI retries.

Before requested local runtime preparation, the app may read the already
published serving binding and pass its complete `revision` plus
`authorizationRevision` pair to native activation. This
read never discovers Skills or writes the serving manifest. Candidate
resolution, validation, promotion, and registry materialization stay in the
server-owned background reconciler, so a healthy engine may keep serving its
existing view while Skills policy is stale or refreshing. The read is
best-effort and coalesced; ordinary activation does not run a stale-view refresh
and restart loop. Missing, partial, stale, or invalid binding input is resolved
by the orchestrator to the complete canonical empty binding, so a Skills fault
alone does not make conversation runtime unavailable.

The serving-binding read completes before native activation captures its input.
It does not wait for candidate reconciliation or Skills freshness. If that read
fails, activation receives the complete canonical empty binding rather than a
missing binding; this prevents an empty first engine followed immediately by a
second authorized engine and the resulting event-stream reconnect.

After an engine is ready, an ordinary conversation send reads only the last
published serving binding (from memory or the atomically published manifest).
Ordinary composer text is always sent as `prompt_async`; Veslo does not infer a
Skill command or ask for confirmation from matching text. OpenCode decides
whether an available Skill applies, while an explicit slash command remains a
command admission. The send path must not rescan Skills, rewrite a manifest, or wait for refresh work that a
watcher/policy reconciler has already scheduled. If no serving manifest exists,
the direct resolver starts the canonical empty binding while background
publication remains independent of the send.

The skill view and authorization revisions are enforced as one pair in the
default pooled topology, on reuse as well as on spawn. A caller that starts an
engine passes the complete server-owned binding to the direct-path resolver.
The resolver either validates that exact pair or selects canonical empty with
`skills.paths = []`; it never substitutes a different non-empty binding.

For an existing local conversation, a connected Veslo server without a live
OpenCode base URL is a pre-HTTP binding failure, not a reason to reuse a stale
registration. The server-submit boundary reports that exact safe condition to
the app. The app may perform one engine-only reachability recovery for the
snapshotted workspace, then repeat the same idempotent server submit with its
original `clientMessageId`. This recovery never runs Managed AI bootstrap or
full send preparation. It also never waits for a serving-binding or Skills read:
it reuses a matching in-memory binding or passes canonical empty to native
activation, while serving-view refresh stays background work. A later transport failure remains a separate one-replay
mechanism; a second preflight failure or unavailable result does not create a
retry loop. A structured server response is terminal and is not treated as a
transport failure eligible for replay. Browsing, status reads, and abort remain
non-starting actions.

The backend send owns its provisional run and accepted-run transition even when
the user changes the visible conversation while it is in flight. The old send
must still be admitted, watched, or disposed, but it must not clear the newly
visible composer's draft or overwrite its last-prompt UI state.

Enforcing this only at spawn would leave the contract trivially bypassable,
because the common case is reuse. Each pooled engine therefore records the
revision it was actually launched from, and a caller arriving with a different one
does not simply get the running process. While no run owns that engine it is
replaced with one launched from the new view; while a run does own it the request
records the newer revision as pending and admission verifies the actual engine
binding before dispatch. This
keeps the active run alive without allowing a caller promised the newer revision
to dispatch into the older binding. The first later idle ensure replaces only
that workspace process with the pending view. Joining an in-flight spawn is held
to the same check: the flight may have
been started with no handshake at all, so its result is reconciled like any other
reuse. This preserves active work without sharing a process across pooled
workspaces.

The bundled direct-path compatibility gate is fail-closed: a failed selected
path, managed-path, workspace-isolation, ambient-exclusion, or nested-asset
check exits non-zero for the exact bundled OpenCode binary/version/hash. Runtime
skill audit traces record the operation id, engine owner, validation phase,
serving and expected revisions, ordered redacted path ids, and sanitized OpenCode
config digest. Validation failures include a stable reason code and never require
logging full local source paths.

Only a caller holding a live server handshake may supply a non-empty revision.
A pool-internal crash respawn has no authorization handshake, so it starts with
the canonical explicit empty binding. The next server-owned request may replace
that process with the current authorized serving binding. This prevents an old
manifest on disk from resurrecting a revision that the server has revoked.

The daemon port is a contract, not a hint. When a caller passes `--daemon-port`
or `VESLO_DAEMON_PORT`, that caller polls exactly that port for `/health` and has
no channel to learn about a fallback, so the daemon binds it or refuses to start
with an explicit conflict error. Silently listening elsewhere converts a port
conflict into an unexplained health timeout. Only a caller that requested no
specific port gets an OS-allocated one. A bind failure at listen time is reported
explicitly for the same reason: unhandled, it surfaces to the desktop as nothing
more than "process exited before health became ready".

Opening or browsing a workspace, including sidebar/database hydration, must not
start an OpenCode engine. On the app side, a requested local runtime prepare
stays serialized until native prepare, orchestrator workspace activation, and
routed reconnect have all finished. A foreground send/session recovery may
join an in-progress requested prepare, but must not create a second fresh
engine for the same workspace.

Workspace route release must also invalidate in-flight routed-client ensures.
Recovery, port rotation, and stale-route cleanup all depend on release meaning
"the previous route cannot reappear later" rather than only deleting the
currently cached entry.

The run/conversation model must not depend on sandbox availability. Sandbox is
an isolation strategy, not the only mechanism for parallel workspace execution.

For transcript recovery, the server remains the source-selection and host-cache
owner. Explicit OpenCode database configuration is authoritative; implicit
workspace-local and global databases are read-only fallback candidates. A
candidate is usable only when its operation-specific schema and exact
workspace-directory/session scope are readable. A stale or empty local
`.opencode/opencode.db` therefore cannot shadow the valid global database.

### Run delivery diagnostics

An admitted local `prompt_async` run has one optional, bounded server-owned
delivery snapshot. It joins existing run identity with three observations:
the router's count of session-bearing events, the app's aggregated
acceptance/store commits, and the terminal recovery/presentation result. It is
diagnostic evidence only: it neither stores transcript content nor replaces
OpenCode's canonical transcript, lifecycle ownership, live SSE, or terminal
hydration.

The snapshot is created at lifecycle admission, before the OpenCode dispatch,
so early events can be observed without waiting for the submit response. A
router observation is accepted only for an active run whose workspace,
OpenCode session, and full engine generation match exactly. The snapshot keeps
only a one-way generation fingerprint, never an engine URL; a report from a
replacement process marks the old diagnostic incomplete without increasing its
event count. Unknown or late events remain unbound; they are never assigned
from the selected conversation.
The app may report one early aggregate and one final aggregate upsert, followed
by one terminal presentation outcome per run, all best effort and without
retries. It may report only renderer-owned hydration and presentation;
lifecycle and canonical-recovery values are server-owned and the app-report
API rejects them. Presentation is calculated only from assistant message IDs
observed while that exact run was active, so a visible older turn cannot
satisfy a later run. If no run-bound assistant message was observed,
presentation is `unknown`, not a claim that output was missing.

The server records a terminal lifecycle even when canonical transcript recovery
cannot start, with recovery `unavailable`. Router observations are flushed per
run on its terminal session event, while normal proxy teardown flushes any
remaining runs on that stream. Each snapshot merge is one SQLite transaction
and diagnostics are bounded for both terminal and non-terminal runs. A
competing diagnostic SQLite writer fails fast on its short bounded lock timeout
instead of waiting for the normal send timeout.
`recorded` means that the server persisted its snapshot; a
missing optional app/router section is explicit absence of that observer, not
proof that the observer successfully reported. Snapshot-write failures do not
change the semantic sending, routing, transcript-ingest, or rendering result.

Developers can inspect the bounded result through:

`GET /workspace/:id/conversations/:conversationId/runs/:runId/delivery`

The endpoint is read-only and non-starting. It returns `not_recorded` for a
legacy/no-diagnostic run and `incomplete` when a surviving snapshot could not
record every optional stage. The store retains at most 64 terminal snapshots
per workspace for seven days and contains no prompt text, transcript parts,
local paths, URLs, tool payloads, or credentials.

The orchestrator treats `session_idle`, missing engine state, and a session or
message `404` as observations rather than successful terminality. A fresh
`prompt_async` run receives a separate OpenCode-compatible ascending
`messageID` only when it is actually admitted; queued work receives that id at
dequeue, not when it first enters the queue. The same exact id is forwarded to
OpenCode and persisted with the orchestrator run so lifecycle probes can reject
older terminal messages after restart. It must not use a namespace-style id:
OpenCode 1.17.x compares message ids lexicographically when deciding whether a
terminal assistant turn is newer, and a non-ascending caller id can re-enter
the model loop after `finish=stop`. A run becomes successfully terminal only
after stable post-admission terminal assistant evidence from the exact OpenCode
session. The app keeps live SSE projection and terminal hydration under the
existing ID-based store and terminal-delivery owner; repeat hydration for one
exact run is coalesced, while distinct canonical message/part ids are never
removed by text comparison.

### Desktop Shell

The desktop shell owns the local Veslo server process lifecycle.

Engine startup is single-owner. Debug scratch autostart must reserve the same
startup queue as explicit workspace startup and skip when an explicit startup
is already active or ready. A runtime prepare keeps that reservation through
daemon boot and target-workspace activation. Two concurrent orchestrator
daemons can split workspace registration from the lifecycle endpoint used by
the local server, so desktop boot must never allow that race.

The local Veslo server must be able to reach a ready state without an active
workspace. Starting, recovering, or refreshing the local server must not be a
side effect of switching the visible workspace.

Fresh desktop profiles have no configured workspace yet. The desktop shell must
therefore allow a managed `veslo-server` restart with an empty workspace list,
using the app data directory as a stable process cwd. Registered local workspace
paths are passed as explicit server arguments, but they must not become the
server process cwd; a denied protected-folder prompt for one project must not
block app-service startup or hide the rest of Veslo's project/session data.
Private chat workspace creation must also create the app-owned private
workspace root before validating or registering the nested scratch directory, so
the first `Chat` click cannot dead-end on a missing parent directory.

`Invalid bearer token` between the app and the local Veslo server is a local
connection-state failure. It is not a message failure or a conversation failure.
The app and desktop shell should recover the current server URL and client token
before retrying operations that have not yet created irreversible work.

## Runtime Modes

### Configured vs Effective Sandbox

The current desktop provider path is host-only. Managed provider config always
uses the loopback Veslo server URL; an advertised `engineUrl` or configured WSL
capability is diagnostic state only and must not change provider routing or
cause an engine reload. WSL bridge routing is not part of the active runtime
contract.

`/capabilities.sandbox` is the configured local server capability. It must not
be treated as proof that the currently running engine is actually sandboxed.

The effective runtime state comes from the engine child kind:

- `childKind=wsl` means the engine is running through the Windows WSL2 sandbox
  and WSL path aliasing can be used.
- `childKind=direct` means the engine is running directly on the host, even when
  the configured backend is `windows-wsl2`.
- missing `childKind` is unknown/configured state, not proof of a WSL runtime.

The app resolves this through
`packages/app/src/app/lib/runtime-sandbox-state.ts`. Prompt preflight, managed AI
routing, directory query path mode, debug traces, and Settings devtools should
use that effective state. Settings devtools also show both configured and
effective values, including `sandboxFallback`, so a Windows machine without a
ready WSL sandbox is auditable as `configured=windows-wsl2` and
`effective=none`.

### Without Sandbox

Use this mode when sandboxing is unavailable or disabled.

The bundled OpenCode binary can host multiple directory instances, but current
Veslo production behavior is still pooled-per-workspace. The
`shared-unsandboxed` override is a compatibility/diagnostic fallback with a
single process-wide skill view; it must reject a conflicting active view rather
than claim independent parallel workspace skills. A future shared shard may
serve compatible directories only when its source-policy, refresh, event, and
placement gates pass. None of these unsandboxed modes provide filesystem
isolation beyond host permissions.

Current desktop launches explicitly set `VESLO_DISABLE_SANDBOX=1`; they do not
probe, provision, or fall back from WSL. The normal topology remains
pooled-per-workspace: every workspace owns one direct host engine slot and all
conversations in that workspace share that slot. The process-wide
`shared-unsandboxed` engine is only a development/diagnostic override when
`VESLO_SHARED_OPENCODE_ENGINE=1` is explicitly configured. Fresh desktop
profiles and legacy implicit shared preferences migrate to the pooled topology;
an explicit override is recorded as `topologySource=explicit-diagnostic`.

### With Sandbox

Use this mode when workspace isolation is enabled.

Expected behavior:

- the sandbox implementation from `origin/local/sandbox-merge` is the reference
  direction,
- the orchestrator may start workspace-scoped engine processes,
- sandboxed execution still uses the same Veslo conversation and run boundary,
- switching the visible workspace never retargets a running conversation.

Do not build a separate conversation model only for sandboxed execution.

## First Message Flow

For a local server-owned submit, the desktop first ensures only the admission
daemon/control transport. This does not activate an OpenCode workspace engine.
The app then recreates the locally owned Veslo server once so it inherits that
daemon generation's lifecycle URL and token before it submits a run. A healthy
server from before daemon admission is not lifecycle-compatible: reusing it
would skip run registration and make the orchestrator reject owner attachment.
Concurrent status reads for the same normalized workspace join one native
`engine_info` request, but completed reads are never cached, so later calls
observe the current orchestrator generation.

1. The user writes a message in a new or existing conversation.
2. The app records pending submission state locally, shows run progress, and
   renders a transient local echo of the user's message. The echo is not a
   durable transcript record or proof of admission. Render replacement and
   confirmed pending cleanup remain separate decisions.
3. The app sends a Veslo intent to the workspace-scoped server API. The server
   owns workspace registration, engine admission, and the exact binding used
   for dispatch; a cold OpenCode engine is not a reason for the app to reject
   the write before that boundary.
4. Veslo server validates the workspace and directory.
5. Veslo server creates the conversation when needed.
6. Veslo server ensures orchestrator workspace registration when the effective
   OpenCode route uses the orchestrator workspace mount.
7. Veslo server creates or resolves the bound OpenCode session.
8. Veslo server creates the run record and derives a stable canonical user-message
   id from the workspace and `clientMessageId`. The derived id is distinct from
   the raw client id; run and queue ids remain separate.
9. The orchestrator resolves the execution target.
10. Before dispatch, the orchestrator creates or selects one process generation
    and atomically attaches its owner tuple (`engineOwnerId`, PID, start time,
    base URL) to the server reservation. A pending or stale owner is fail-closed
    and cannot reach OpenCode.
11. OpenCode receives the request for the bound session and directory. Veslo
    keeps its client admission identity out of the OpenCode request body.
12. Engine-loss callbacks carry the same owner tuple; the server only releases
    reservations whose generation matches exactly. A callback racing owner
    persistence is held briefly and reconciled when the response headers arrive.
13. After a submitted admission, the app attaches the workspace event stream
    for live projection of comments and tool steps. Stream attachment is not
    authority for write success: a transient attach failure keeps the admitted
    run and is recovered through the durable transcript/run path.
14. Events and transcript data are mirrored back to the conversation and run.

Passive transcript snapshots may fill gaps after selection, prefetch, or recovery,
but they must not erase non-empty message parts already observed through the live
event stream unless an explicit removal event has done so first.

When several sends share the same unmaterialized pending chat, the app keeps
one in-flight materialization for that pending-session key. Followers wait for
the first submit's server-owned handoff, then submit against the resulting
session. They must not each create an independent conversation.

Composer is the only owner of the live editor value. It snapshots one immutable
revision per send. When pending submission state or a local queued item accepts
that snapshot, Composer clears the exact revision immediately, including before
runtime warmup or server admission completes. If no local owner accepts it, a
typed result may change the editor only while that submitted revision is still
current. Session flow does not independently clear a newly mounted or newer
Composer draft.

For new responses, `clientMessageId` remains an app/server idempotency field.
The app adopts a local echo only when one scoped post-baseline user transcript
candidate is unambiguous. Compatible client metadata wins; otherwise normalized
text and attachment/file identity are used. The render projection may replace
local echo with that transcript content before pending cleanup runs.

Run presentation may not reset from a transient scoped `idle` observation while
the same session has fresh durable lifecycle evidence of `submitted`, `running`,
or `blocked`; terminal or stale lifecycle evidence releases that guard.
Both `session.idle` and `session.status: idle` enter that lifecycle arbitration
before they can update the scoped session status, for foreground and background
workspace streams alike.

The session capabilities sidebar projects the app-owned shared skill inventory;
it never triggers its own filesystem scan. Full inventory refresh, including
all configured local workspaces, is requested when the Skills dashboard opens
and after explicit skill mutations. Ordinary workspace activation must not
start that full background scan or delay the first session interaction. It may
schedule a bounded global-plus-active-workspace refresh for the sidebar, but
that work remains detached from runtime preparation and prompt sending.

If any step fails, store the failure at the narrowest correct level:

- local server connection failure,
- workspace attach failure,
- conversation creation failure,
- OpenCode session creation failure,
- run submission failure,
- model/provider failure.

Avoid generic "send failed" state when the failing layer is known.

## Workspace Switching

Workspace switching changes only what the user is looking at.

It must not:

- change the OpenCode session of an existing conversation,
- change the directory of an existing conversation,
- abort or restart a run in another workspace,
- move a global busy/error state into the newly selected workspace.

The selected workspace is display context. The run's workspace and directory are
part of the persisted conversation/run state.

When a scoped sidebar session belongs to the already-active workspace and that
workspace has been explicitly allowed for live transcript reads by the send/run
flow, selecting it should read the active live session directly. Host-first
offline transcript browsing remains the fallback for foreign workspace browsing,
browse-only/runtime-unavailable state, and sessions whose workspace has not been
live-read enabled.

## Error Handling Rules

- Local server unavailable: surface local runtime readiness and retry recovery.
- Invalid bearer token: refresh local server connection state, then retry only
  operations that have not created irreversible work.
- Workspace unavailable: keep the prepared message and show workspace attach
  progress or failure.
- Workspace folder access denied by the OS: create a folder-access permission
  request for the denied workspace path at the point of failure. The user grants
  access through the native folder picker, then Veslo refreshes the workspace
  config and retries or reattaches the runtime.
- OpenCode session creation failure: mark the conversation/run as failed for
  that workspace.
- Submit failure after run creation: mark the run failed; do not blindly create
  another run.
- Active run conflict: reject or surface the active run id; do not submit a
  second active run to the same conversation.
- Stale/no-progress active run: a queued successor must not make a generic
  stale or no-progress active run fail early. Queue drain hands it to the
  ordinary exact-run lifecycle reconciler. A run with a known unreachable
  engine is terminalized once its useful-progress timestamp exceeds the
  one-minute grace window, so a lost local engine cannot retain a conversation
  reservation indefinitely; other stale states remain conservative.
- Startup orphan: an active reservation whose only state is an unknown open
  assistant message with no useful progress for the startup grace window is
  terminalized immediately. This narrow recovery prevents a pre-restart
  orphan from keeping the new process in a long reconciliation poll loop.

## Validation Requirements

Changes to this architecture require real desktop validation when they affect
user-visible runtime behavior.

Minimum coverage for implementation work:

- server tests for conversation binding, directory validation, body stripping,
  and cross-workspace rejection,
- orchestrator tests for shared-process and sandbox execution selection,
- app tests proving prompt send goes through Veslo conversation APIs,
- desktop or Tauri-pilot coverage for local server startup and recovery,
- Tauri-pilot scenario for two concurrent workspace directories without
  sandbox,
- Tauri-pilot scenario for sandboxed execution when the sandbox feature is part
  of the change.

If `packages/server/src` changes, rebuild the server binary with:

```bash
pnpm --filter veslo-server build:bin
```

If desktop behavior depends on the server change, refresh sidecars and validate
against the rebuilt binary.
