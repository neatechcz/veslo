---
title: First-Message Send Request Fanout Audit and Remediation Plan
date: 2026-07-16
status: proposed
done: false
repository_snapshot: commit 8954ea4e0122ac291d357c1b55f0edc633a53eed with scoped dirty working tree
repository_commit: 8954ea4e0122ac291d357c1b55f0edc633a53eed
working_tree_scope: audited owner files clean; unrelated UI and quality-gate edits excluded except for current command definitions
scope: first-message send path, managed-AI startup effects, workspace registration, and initial transcript loading
---

# First-Message Send Request Fanout Audit and Remediation Plan

## Decision

Keep the server-owned conversation submit contract, idempotent retry behavior,
and independent lifecycle recovery intact. Remove only the confirmed redundant
control/configuration work around the first accepted message.

The implementation order is:

1. make request joins and misses observable and lock the healthy-path budget in
   focused tests;
2. register one orchestrator workspace per first-submit request scope;
3. allow a read registration to reuse an already-live app registration;
4. collapse duplicate managed-AI access and configuration work for the same
   stable context;
5. decide separately whether the intentionally defensive initial-transcript
   fallback should be delayed or made abortable.

This document is the implementation authority for these changes. It does not
authorize a rewrite of the send, queue, SSE, or lifecycle architecture.

## Audit boundary and evidence

Source was inspected in the current working tree on 2026-07-16. The newest
retained send trace available in the repository is from 2026-07-14, so its
request timings are evidence of the observed behavior, while current source
is the authority for implementation.

### Reproducible snapshot

The source baseline is commit 8954ea4e0122ac291d357c1b55f0edc633a53eed.
The checkout is intentionally dirty, so this plan distinguishes source
evidence from unrelated local work:

- Included: the clean audited owner paths under app/context and server/src,
  including conversation-service, managed-AI config/access, lifecycle
  controller, conversation submit service, routes/conversations, and server
  composition.
- Included only as command definitions: the current root, app, and server
  package scripts, which define the required full quality gate and binary
  rebuild.
- Excluded: the unrelated app.tsx MCP-auth callback hunk, broad component/UI
  changes, document-runtime/E2E changes, and quality-workflow/documentation
  edits already present in this checkout.
- This plan file is a new untracked documentation artifact. It is not evidence
  that any remediation code has landed.

The relevant trace pair is:

- dev-specific/tauri-pilot/manual-runtime-20260714-205309-a27289f6-pnpm-dev/send-workflow-trace.ui.ndjson
- dev-specific/tauri-pilot/manual-runtime-20260714-205309-a27289f6-pnpm-dev/send-workflow-trace.server.ndjson

Focused regression suites were green at audit time:

- 180 app send/conversation/managed-AI tests;
- 64 server conversation-submit tests;
- 42 selection/lifecycle tests.

The 286 passing tests prove that the present flow is generally functional.
They do not set an exact request-count contract for a cold first message; the
gaps are listed below.

## Healthy first-message request budget

The table applies to a healthy first message in a new local conversation. A
recoverable network failure is deliberately excluded: its retry is covered by
the existing client-message idempotency contract.

| Layer | Required work | Healthy-path budget |
| --- | --- | ---: |
| UI | One accepted composer send | 1 |
| App to Veslo server | POST conversation submit | 1 |
| Server to orchestrator | Register the local workspace for this submit scope | 1 |
| Server to OpenCode | Materialize the new session | 1 |
| Server to OpenCode | Submit the prompt asynchronously | 1 |
| App workspace control | Resolve/register the local workspace for write, then read it | one effective registration |
| Managed-AI access | Read access for one stable identity/routing context | at most 1 in flight |
| Managed-AI config | Read/apply one stable desired configuration fingerprint | at most 1 effective sync |
| Initial transcript | Load only when SSE has not supplied the needed transcript state | 0 or 1, never required for prompt correctness |

"Effective registration" and "effective sync" mean one underlying request
sequence, even if multiple reactive callers await the same promise. A changed
workspace, runtime URL, access identity, or desired provider/model is a new
semantic key and may legitimately cause new work.

## Confirmed non-findings

The following behavior must not be misdiagnosed or removed as duplicate first
message sending:

- The center composer and footer composer are mutually exclusive. A normal
  accepted send reaches the composer callback once, and the sending state
  blocks a second immediate click.
- A new conversation necessarily performs two distinct OpenCode operations:
  POST session materialization followed by POST session prompt_async. The
  audited trace has one of each, not two prompts.
- The client reuses clientMessageId for recoverable submit retries. The server
  attempt store and queue layer make this replay safe; this is not permission
  to remove retries.
- The lifecycle controller's active peek/register/reconciliation and the UI
  lifecycle watch are separate resilience layers. They do not submit a second
  prompt, and the UI in-flight guard prevents parallel lifecycle polling.

## Findings

### FMS01 — active managed-AI configuration sync can fan out

**Priority:** P1
**Owners:** packages/app/src/app/context/managed-ai-runtime-config.ts and
packages/app/src/app/context/send-runtime-readiness.ts
**Status:** confirmed in current source and supported by retained trace

The active-workspace reactive effect unconditionally starts:

~~~text
syncActiveWorkspaceManagedAiConfig({ isCancelled: () => cancelled })
~~~

The global generation counter at managed-ai-runtime-config.ts around line 929
prevents stale results from being applied. It does not cancel a request that
has already started, does not coalesce equal work, and does not scope
supersession per configuration fingerprint.

The measured cold-start/first-submit window is explicitly bounded from the
first active-workspace preflight at 18:53:47.734 through the first patch
completion at 18:53:58.001. It contains five read-current operations:

| Time | Config source | Note |
| --- | --- | --- |
| 18:53:47.745 | project config file | first actual read; 18:53:47.734 is only preflight |
| 18:53:48.201 | Veslo server config | server-capable path becomes available |
| 18:53:52.701 | Veslo server config | overlaps first submit |
| 18:53:53.715 | Veslo server config | overlaps first submit |
| 18:53:57.743 | Veslo server config | precedes the only patch |

The full retained trace contains twelve read-current operations: one project
config read and eleven Veslo-server config reads. It contains one patch-done
event, at 18:53:58.001. This proves substantial reactive fanout, but not that
every one of the five early reads is semantically redundant: routing,
capability, and managed-profile inputs change during that window.

The remediation target is therefore not an artificial "twelve reads become
one" rule. For each unchanged semantic configuration fingerprint there must be
one flight and one underlying read/apply sequence; a real fingerprint change
may start another flight. FMSP01 must make that distinction visible in a fresh
trace.

The send-readiness path can add further reads: it checks usability, invokes
sync when needed, then checks usability again. The exact warm-send count needs
a new focused test, but the source permits a check -> sync read/write -> check
shape.

**Required result:** equal active-workspace effect runs join one in-flight
sync; a send joins a matching active sync instead of starting equivalent
configuration work; a changed desired configuration remains observable and is
not suppressed.

### FMS02 — managed-AI access single-flight has an empty-key and key-transition hole

**Priority:** P1
**Owner:** packages/app/src/app/context/managed-ai-access-store.ts
**Status:** confirmed duplicate endpoint traffic; exact triggering transition
needs instrumentation

loadManagedAiAccessSingleFlight only retains an in-flight promise when its
cache key is non-empty. It also holds a single global slot, rather than an
in-flight map keyed by the stable access context.

The server trace contains two concurrent requests for the same
/api/me/ai-access endpoint without a workspace context:

| Request start | Request completion | Duration |
| --- | --- | ---: |
| 18:53:46.193 | about 18:53:54.254 | 8,061 ms |
| 18:53:47.836 | about 18:53:54.253 | 6,417 ms |

They begin before the user sends the prompt. They are therefore background
cold-start traffic, not a duplicate prompt request. The existing trace does
not carry the access cache key, so it cannot prove whether the cause was an
empty key, a key transition, or both.

**Required result:** callers with the same fully identified access/routing
context join exactly one load. The chosen FMSP04 policy is to defer a load
until that context is stable; no synthetic pending-context key is permitted.

### FMS03 — server registers the same orchestrator workspace twice for one first submit

**Priority:** P2
**Owner:** packages/server/src/server.ts
**Status:** confirmed in current source and retained trace

ensureOrchestratorWorkspaceRegistered at approximately line 1228 sends
POST orchestrator /workspaces every time
fetchOpencodeJsonWithOrchestratorFallback is called against an orchestrator
base URL. The first submit calls that wrapper once for POST /session and once
for POST /session/:id/prompt_async.

For one trace id, the retained server trace shows:

| Time | Operation |
| --- | --- |
| 18:53:53.724–18:53:53.753 | First workspace registration |
| 18:53:53.756–18:53:53.799 | Session materialization |
| 18:53:53.893–18:53:53.907 | Second identical workspace registration |
| 18:53:53.908–18:53:53.982 | Prompt submission |

The registration endpoint is idempotent, so the behavior is not corrupting
the session. It is nevertheless an avoidable round trip on every new
conversation.

**Required result:** the materialization and prompt pair share one successful
workspace registration within the same accepted conversation-submit request.
A later independent request must still re-register, so daemon restart and
workspace changes are detected normally.

### FMS04 — app registration cache treats live and read registration as unrelated

**Priority:** P2
**Owner:** packages/app/src/app/context/conversation-service.ts
**Status:** confirmed in current source; request count requires new
app-control tracing or a focused fake-client test

ensureConversationReadWorkspaceRegistered caches the same local
workspace/directory under two different keys:

~~~text
... + "live-opencode"
... + "read"
~~~

The send preflight requests the live variant. After new-session
materialization, transcript selection requests the read variant. The latter
cannot reuse the already resolved live registration and can perform another
engineInfo plus listWorkspaces sequence. The registry normally prevents a
second addLocalWorkspace, but the control calls are still redundant.

**Required result:** a read request may reuse an already-resolved live
registration for the same client/workspace/directory. A live write request
must never reuse a read-only result, because the live path has stricter
runtime URL validation.

### FMS05 — initial offline transcript fallback can start work that live SSE soon makes unnecessary

**Priority:** P2, decision-gated
**Owners:** packages/app/src/app/context/session-selection-controller.ts and
packages/app/src/app/app.tsx
**Status:** observed and intentionally defensive; not a confirmed correctness
bug

After materialization, session selection can begin its offline transcript
fallback before the accepted-submit/live transcript update arrives. In the
retained trace:

- fallback starts at 18:53:54.731;
- a live transcript is observed at 18:53:55.373;
- the fallback result is deliberately discarded because live data won.

The fallback protects against delayed or lost SSE. Removing it would trade a
small request reduction for a real stale/empty-transcript failure mode.

**Required result:** no semantic change until a product/reliability decision
is recorded. If optimized, preserve fallback when live data fails to arrive;
do not make SSE the sole source of first-message transcript correctness.

## Implementation slices

### FMSP01 — establish request-count observability and tests

**Status:** done: false
**Owners:**

- packages/app/src/app/context/managed-ai-access-store.ts
- packages/app/src/app/context/managed-ai-runtime-config.ts
- packages/app/src/app/context/conversation-service.ts
- packages/server/src/server.ts
- existing focused test files listed below

Use the existing send-workflow trace as the only opt-in. Do not rely on a
server --verbose flag: it does not enable send tracing.

For desktop acceptance, set both variables before starting the desktop wrapper:

~~~powershell
$env:VITE_VESLO_SEND_WORKFLOW_TRACE = "1"
$env:VESLO_SEND_WORKFLOW_TRACE = "1"
$env:VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE = "$PWD\.tmp\first-message-fanout.ndjson"
pnpm --filter @neatech/veslo dev
~~~

The first variable enables app-side trace production; the second enables
native/server trace-file writes. The desktop development wrapper currently
defaults both to enabled, but acceptance must set them explicitly. Its printed
split UI/server trace paths and the configured mirror are the evidence source.

Add one trace-gated, low-cardinality flight event at each join boundary, not
at every reactive caller:

- managed-AI access load;
- active managed-AI configuration sync;
- app workspace registration;
- server orchestrator workspace registration.

Every event uses this payload shape:

~~~json
{
  "event": "<owner>:flight",
  "action": "start | join | settle | reject",
  "flightId": "opaque-process-local-id",
  "caller": "active-effect | send-readiness | submit | read",
  "scope": "http-submit | background | app",
  "traceId": "existing-send-trace-id-or-null"
}
~~~

flightId is allocated from a process-local map entry. The semantic fingerprint
stays in memory and is never emitted. New events must not include a raw
workspace path, endpoint, token, authorization revision/value, prompt text, or
header. Existing trace events retain their current schema.

Add request-count tests with fake clients/fetchers. The test contract is:

1. one healthy first submit produces one server submit, one OpenCode session
   create, one OpenCode prompt_async, and one orchestrator registration;
2. a repeated same-key managed-AI access/config request joins the first
   promise;
3. a changed semantic key starts a new request;
4. a failed in-flight operation is removed so the next call can retry;
5. a read arriving while a matching live registration is pending awaits that
   same promise;
6. a failed live registration cannot satisfy a later read registration.

Do not add a production-only timer or a broad debounce merely to make the
test counts pass.

### FMSP02 — scope server orchestrator registration to one submit request

**Status:** done: false
**Owners:**

- packages/server/src/routes/conversations.ts
- packages/server/src/conversation-submit-service.ts
- packages/server/src/conversation-service.ts
- packages/server/src/conversation-run-lifecycle-controller.ts
- packages/server/src/server.ts

Create an opaque, short-lived registration scope in the HTTP
POST /workspace/:id/conversations/submit handler. It must traverse the full
immediate submit chain:

~~~text
route handler
  -> ConversationSubmitService.submit(scope)
    -> ConversationService.createConversation(scope)
      -> createOpenCodeSession(scope)
        -> fetchOpencodeJsonWithOrchestratorFallback(scope)
    -> submitResolvedRun(scope)
      -> ConversationRunLifecycleController.submitRun(scope)
        -> submitAcceptedRun(scope)
          -> submitOpenCode(scope)
            -> submitConversationRunToOpenCode(scope)
              -> fetchOpencodeJsonWithOrchestratorFallback(scope)
~~~

Extend the corresponding input/port types, including
ConversationRunLifecycleSubmitInput and
ConversationRunLifecycleSubmitOpenCodeInput. Passing the scope only through
conversation service or submit service is insufficient: the lifecycle
controller otherwise drops it before prompt_async.

Within that scope, memoize a successful/in-flight registration by:

~~~text
normalized daemon URL + workspace id + normalized workspace path
~~~

The second caller awaits the same promise. Clear a failed promise immediately.
Do not use a process-lifetime "workspace is registered" cache, and do not
share the scope with unrelated HTTP submits. A new request gets a new scope,
which keeps daemon restart, server restart, and changed workspace state
observable without special invalidation machinery.

The fallback-to-orchestrator branch must use the same scope when it belongs to
the same immediate submit.

Do not persist, serialize, or capture the scope in a durable queue item,
queue-drain timer, or lifecycle reconciliation task. If an accepted submit is
queued and prompt_async is later issued by drainConversationQueue, that
background work receives no original HTTP scope and performs its own normal
registration. Reconciliation likewise never inherits an expired HTTP scope.
Non-submit OpenCode actions retain their existing independent registration
behavior unless they receive a separately created scope.

Required tests in packages/server/src/tests/server-conversations.test.ts or a
small focused server test:

- a first materialize-and-submit sequence registers once, then calls session
  and prompt_async once each;
- two separate submits register independently;
- a failed registration is not memoized as success;
- an orchestrator fallback within the same scope does not add a second
  successful registration;
- clientMessageId replay still does not create a second OpenCode prompt.
- a queued prompt and lifecycle reconciliation cannot observe or serialize the
  original HTTP scope; the later background submit gets a distinct flightId.

### FMSP03 — make app read registration a safe subset of live registration

**Status:** done: false
**Owner:** packages/app/src/app/context/conversation-service.ts

Retain the existing per-client registration cache and current live-runtime
validation. Change only lookup asymmetry:

- a live request checks and writes the live cache entry only;
- a read request checks the live cache entry first, then its own read entry;
- a read registration that resolves through the live entry returns the same
  server workspace id without another engineInfo/listWorkspaces call.

Never reverse the relationship. A write must not reuse a read-only result
that could lack a current OpenCode runtime base URL.

Required tests in packages/app/src/app/tests/context/conversation-service.test.ts:

- live then read for one client/workspace/directory calls engineInfo and
  listWorkspaces once;
- start live registration, hold its engineInfo/listWorkspaces promise, then
  issue read registration before it settles; read must await the exact live
  promise and must not start a second control sequence;
- read then live still performs the live validation;
- a rejected or empty live registration cannot satisfy read; read performs its
  own registration path and never returns a stale id;
- a different directory or a different client does not leak a cached id;
- existing host-token refresh behavior remains intact.

### FMSP04 — make managed-AI access loading key-safe and multi-key single-flight

**Status:** done: false
**Owner:** packages/app/src/app/context/managed-ai-access-store.ts

Replace the single mutable in-flight slot with a map of meaningful access
context keys to promises. Delete an entry only if the settling promise is
still the map value for that key.

**Chosen policy:** do not issue an access request until the access/routing
context has a non-empty stable key. Do not invent a pending key from empty
identity fields. The effect must leave no in-flight entry and schedule no
retry while context is unknown; the first transition to a stable key starts
one normal load.

The stable map key is the complete access key passed to the requester,
including the resolved runtime-workspace suffix when it changes the endpoint's
semantics. It is an internal value only and must not be emitted in a trace.
Do not treat an empty string as a globally shareable identity or as a
persistent failure state.

Required tests in packages/app/src/app/tests/context/managed-ai-access-store.test.ts:

- two equal non-empty keys join;
- an empty/unknown context causes zero requester calls and no retry;
- the first stable-context transition starts one load, and repeated reactive
  runs for that stable context join it;
- different keys run independently;
- completion or rejection removes only its own entry;
- a key transition does not produce two loads for the same final stable
  context.

### FMSP05 — single-flight active managed-AI configuration by desired fingerprint

**Status:** done: false
**Owners:** packages/app/src/app/context/managed-ai-runtime-config.ts and
packages/app/src/app/context/send-runtime-readiness.ts

Derive a semantic configuration fingerprint before starting active-workspace
sync. The caller reason is deliberately not part of the key: active-effect and
send-readiness must join when their target intent is identical.

The fingerprint must contain these normalized input groups:

| Group | Required members |
| --- | --- |
| Target identity | app workspace id, workspace type, normalized root/directory, requested target identity, resolved Veslo workspace mapping or an explicit unresolved state |
| Eligibility/source | desktop-runtime flag, workspace-default-model readiness, explicit-default-model flag, Veslo connection state, config read/write capabilities, and whether the source is project config or Veslo server config |
| Desired config | default provider/model, managed profile provider/model/revision, and managed-access state that changes the write decision |
| Routing | resolved provider base URL, resolved engine base URL, requires-engine-base-url flag, configured/effective sandbox state, engine child kind, and sandbox fallback |
| Authorization | DEN auth revision plus one-way internal fingerprints of the server client token and effective gateway access token |

No raw token, raw endpoint, or raw workspace root may be put in a trace. The
internal fingerprint can include normalized values and one-way token hashes;
FMSP01 exposes only its opaque flightId.

Maintain a per-fingerprint in-flight map:

- equal effect reruns join the same promise;
- a changed fingerprint starts a new operation;
- a settled failure is removable and retryable;
- stale completion must still not overwrite newer state.

The existing global generation guard may remain as a final stale-application
guard, but it must not be the only concurrency mechanism. If practical, make
the guard fingerprint-aware so activity for one workspace cannot needlessly
invalidate an unrelated one.

Change send readiness to await or consume the result of a matching
configuration sync rather than unconditionally performing a second
independent configuration read. A post-sync verification read is allowed only
when the sync could have changed configuration or the result cannot prove the
required state. Document that reason in the test name.

Required tests in packages/app/src/app/tests/context/managed-ai-runtime-config.test.ts:

- repeated reactive invocations with one fingerprint cause one config read and
  at most one patch;
- a changed workspace/root, provider/model, routing endpoint or
  requires-engine-base-url state produces a new sync;
- a changed DEN authorization revision, effective access-token fingerprint,
  server workspace mapping, or config capability/source produces a new sync;
- a failed sync can retry;
- send readiness joins the active matching sync;
- an already-correct configuration does not patch;
- stale completion cannot overwrite the newer fingerprint's state.

### FMSP06 — decide whether to optimize the initial transcript fallback

**Status:** done: false — decision required before implementation
**Owners:** packages/app/src/app/context/session-selection-controller.ts and
packages/app/src/app/app.tsx

Choose one of these bounded designs after measuring the fresh trace from
FMSP01:

1. **Keep the current fallback.** Accept one occasional redundant read as the
   cost of recovering from absent SSE.
2. **Add a bounded new-session grace window.** Only for a just-materialized,
   accepted first submit, wait briefly for the live transcript before starting
   fallback. Historical selection, deep links, and recovery paths continue to
   fall back immediately.
3. **Make the fallback abortable.** Pass an AbortSignal through the read API
   and abort the still-pending client request when a qualifying live transcript
   arrives. Preserve fallback when no live update arrives.

The recommended starting point is option 3 only if the server/client transport
can genuinely cancel useful work before the request is committed. Otherwise
option 2 is simpler and more predictable. Neither option may remove the
fallback or use an unbounded wait.

Required tests in packages/app/src/app/tests/context/session-selection-controller.test.ts:

- live transcript before the threshold skips/cancels fallback;
- absent or delayed SSE still loads fallback;
- a live update for another session does not cancel this session's fallback;
- the selected-session and transcript ownership rules remain unchanged.

## Explicit non-goals and guardrails

- Do not send OpenCode requests directly from the app. Conversation/run
  mutations remain server-owned.
- Do not merge session creation and prompt submission; they are separate
  OpenCode operations with different contracts.
- Do not remove clientMessageId retries, submit attempt storage, queue drain
  locking, or lifecycle recovery to reduce observed traffic.
- Do not add a permanent orchestrator-registration cache. It would hide daemon
  restart and state loss.
- Do not retain an HTTP registration scope in a queue record, timer closure, or
  lifecycle reconciliation input.
- Do not make all unknown managed-AI users share an empty cache key.
- Do not turn a source-level count assertion into a brittle timing assertion.
  Tests must control promises/fetches and prove joins directly.
- Do not change transcript fallback before FMSP06 has an explicit decision and
  its failure-mode tests.

## Current test gaps

| Gap | Required coverage |
| --- | --- |
| Server registration | The current server tests verify registration before session creation but do not carry a scope through route, submit service, lifecycle input, and submit port to assert exactly one registration across materialize plus prompt. |
| Managed-AI access | Current tests cover one identical normal key, not the chosen empty-context deferral or routing-context transition. |
| Managed-AI config | Current tests invoke sync directly; they do not model reactive rerun fanout, send joining active work, or all routing/auth/mapping fingerprint dimensions. |
| App registration | Current tests do not prove that a read arriving during pending live registration awaits that exact promise or rejects a failed live result. |
| First-message budget | No focused contract enumerates the full healthy first-message request fanout. |
| Transcript fallback | Current coverage does not establish a cancellation/grace policy because no policy has been selected. |

## Validation and acceptance

Run focused suites from the repository root as each slice lands. Every test
path below is relative to its filtered package:

~~~powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/pages/session-conversation-flow.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/managed-ai-access-store.test.ts src/app/tests/context/managed-ai-runtime-config.test.ts

pnpm --filter veslo-server exec bun test src/tests/conversation-submit-service.test.ts src/tests/server-conversations.test.ts

pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/session-lifecycle-recovery.test.ts src/app/tests/context/session-selection-controller.test.ts

pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-server typecheck
git diff --check
~~~

Before manual desktop tracing, the full repository quality gate and the
server binary/desktop sidecar refresh are mandatory:

~~~powershell
pnpm check
pnpm --filter veslo-server build:bin
$env:VESLO_SIDECAR_FORCE_BUILD = "1"
try { pnpm --filter @neatech/veslo run prepare:sidecar } finally { Remove-Item Env:\VESLO_SIDECAR_FORCE_BUILD -ErrorAction SilentlyContinue }
~~~

Then start a fresh desktop runtime with the explicit trace opt-in defined in
FMSP01, open one local managed-AI workspace, and send one short first prompt.
Use the trace paths printed by the desktop wrapper or the configured mirror;
do not use a generic --verbose flag as a substitute. Record the trace id and
verify:

1. exactly one accepted submit, one session create, and one prompt_async;
2. exactly one orchestrator workspace registration within that submit scope;
3. every one semantic-flight id has one start, zero or more joins, and one
   settle/reject event;
4. no concurrent duplicate managed-AI access read for the same stable
   context;
5. no duplicate active managed-AI config sync for the same fingerprint;
6. no duplicate app workspace control sequence caused solely by live-to-read
   cache separation;
7. queued drain/reconciliation traces have a distinct background scope and
   never reuse the HTTP submit flight id;
8. lifecycle state still reaches admitted/running/terminal normally;
9. the retry test still produces at most one upstream prompt for a replayed
   clientMessageId.

FMSP06 has a separate acceptance test after its decision. It is not required
to close FMSP01 through FMSP05.

## Completion definition

This plan is complete only when FMSP01 through FMSP05 are implemented, their
focused tests pass, and a fresh trace demonstrates the healthy-path request
budget. FMSP06 remains explicitly open until its reliability tradeoff is
chosen; it must not be marked done merely because the other fanout fixes land.
