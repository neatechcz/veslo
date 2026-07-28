---
title: Adjacent Runtime Lifecycle and Cache Findings
status: re-baselined
done: false
date: 2026-07-28
revalidated: 2026-07-28
issue: unlinked
scope: codebase findings adjacent to the local send, workspace skills, and lifecycle incidents
related:
  - docs/plans/2026-07-28-production-runtime-error-causality-audit-plan.md
  - docs/plans/2026-07-28-server-owned-submit-missing-live-binding-recovery-kiss-plan.md
  - docs/plans/2026-07-28-production-runtime-remediation-implementation-plan.md
---

# Adjacent Runtime Lifecycle and Cache Findings

## Purpose

This document records additional findings discovered during a second,
read-only codebase audit. They are related to the local send failure,
workspace-skill staging, runtime readiness, and lifecycle errors, but were not
explicitly covered by the existing production causality or server-owned submit
plans.

This is a findings and remediation-index plan. It is not permission to modify
runtime code, production configuration, or production data. Each finding must
be validated and repaired in its own owner-specific workstream.

E2E is intentionally out of scope. Focused unit/contract tests and a manual
live run are sufficient for this plan's validation gate.

## Re-baseline notice

Every finding this repository owns is now implemented: A, B, C, D, E, G, H, I,
J, and K. Six were already fixed by work that landed while the document was
being written; D, E, I, and K were implemented against this plan. They are kept
as short closed entries so the same audit does not re-raise them.

What remains is F — a naming and state-contract observation, explicitly not a
defect — and L and M, which belong to cloud owners and cannot be validated from
this checkout.

Read the `disposition` line on each finding before doing any work.

`implemented` means the repair contract is satisfied in source and covered by
focused tests. It does not mean the behavior was observed in a live run; the
completion gate below still asks for that.

## Audit boundary

The audit was performed against the current local checkout, which had
uncommitted user changes in the app send path, conversation service, runtime
diagnostics, tests, and plans. Those changes were preserved and not treated as
new work by this document.

Focused tests were run for:

```text
packages/app/src/app/tests/utils/local-runtime-lifecycle.test.ts
packages/app/src/app/tests/context/send-runtime-readiness.test.ts
packages/app/src/app/tests/pages/session-send-workflow.test.ts
```

All passed at audit time (96) and at re-validation (100). The count moved
because the send path gained coverage between the two passes, which is itself
the signal that the audit snapshot had aged.

Green tests still do not close the findings that remain open below: the
highest-risk combinations are not represented by the current fixtures.

## Finding A — runtime recovery succeeds without a live `baseUrl`

disposition: implemented

The reconnect path returned `true` when engine polling produced no `baseUrl`, so
a send-owned preparation could report success without a live binding.

It now returns `false` and records an `engine-info-poll:live-binding-unavailable`
trace. Keep regression cover proving an absent `baseUrl` cannot produce a
send-ready state.

## Finding B — live conversation registration cache ignores runtime generation

disposition: implemented for client/base-URL changes; residual generation observation remains

The live registration cache was reported as keyed only by workspace, directory,
and the `live-opencode` scope, so a replaced runtime could be served a stale
entry.

It is not. The live key includes the OpenCode `baseUrl`; starting a live
registration evicts other settled live entries for the same workspace and
directory; and the cache lives in a `WeakMap` keyed by the server client, so a
different client identity cannot inherit a registration. The base URL is also
needed to build the key, so engine info is resolved before the lookup, not
after it.

Two residuals remain outside this repair: within one client, read-scope keys
accumulate per directory without a bound; and a same-URL engine restart has no
separate app-visible generation identity. The first is slow memory growth; the
second has no reproducing evidence and must not be masked as a solved binding
contract.

## Finding C — known server 409 responses are classified as transport failures

disposition: implemented

Any error that was not a preflight error entered transport replay, so a
deterministic server 409 could trigger a second submit.

The workflow now classifies with `isKnownServerSubmitResponseError()` before
replaying, on both the first error and the retry that follows missing-binding
recovery; a structured response returns through `failKnownServerResponse()`.

The shipped classifier treats client responses (`400` through `499`) as known
outcomes, including skill-view conflicts, while a server-side `5xx` remains
eligible for the existing one-shot idempotent transport replay. This preserves
the no-replay invariant for deterministic rejection without turning a temporary
upstream response into a terminal client failure.

## Finding D — orchestrator directory skill lifecycle has no removal path

disposition: implemented

The instance map and the directory-to-workspace binding were only ever written,
so a removed or repointed workspace kept its skill-view state and a reused path
inherited the previous epoch.

`DirectorySkillViewLifecycle.unregister()` now drops the entry, cancels any
scheduled completion retry, and advances a generation tombstone without
discarding an in-flight queue. The orchestrator uses retirement when a workspace
is bound to a new directory instance: it serializes after a pending initial
publish, waits for active work to drain, and disposes the old instance before
removing the previous binding. This prevents a late publication from
resurrecting state or retaining an OpenCode directory cache for a reused path.

There is still no workspace-delete endpoint on the orchestrator, so retirement
is driven by rebinding rather than by an explicit removal event. That is the
only removal signal this owner actually receives today.

## Finding E — app runtime skill bindings have no cleanup or generation identity

disposition: implemented

The binding map was keyed by workspace id alone, never evicted, and carried no
identity beyond the two revisions, so a stale binding could outlive its subject
and a slow preparation could publish over a newer one.

Three changes close it. A binding now records the workspace path it was resolved
for, and a read that supplies a different path is answered as absent so the
caller re-resolves. Each preparation takes a monotonic per-workspace epoch and
publishes only while that epoch is still current, so a late arrival cannot
overwrite a newer result. Forgetting a workspace evicts its binding and advances
its epoch tombstone, which matters most for scratch workspaces created and
discarded repeatedly inside one app lifetime.

The cache invalidates on client or base-URL changes. It has no explicit
app-visible engine-generation identity for a same-URL restart; retain that as a
separate residual observation until it has concrete reproducing evidence.

## Finding F — `connected` and send-ready are distinct but weakly represented

disposition: open — design observation, not a defect

### Evidence

`startWorkspaceApiReadinessProbe()` marks a workspace `connected` while the
workspace API probe is still pending and retains `connected` with a waiting
message when the probe returns false or fails.

This is an intentional non-blocking UI policy and is not itself classified as
a direct defect. However, the state name is stronger than the guarantee it
provides.

### Impact

Other consumers can interpret `connected` as:

```text
engine process + route + workspace API + send readiness
```

while the implementation guarantees only a weaker process/route state. This
creates a state-contract hazard similar to the false-positive `baseUrl`
recovery above.

### Required repair contract

Keep non-blocking API probing, but represent the state dimensions explicitly:

```text
processReady
routeReady
workspaceApiReady
sendReady
```

If a full state split is too large, at minimum document and enforce that
`connected` cannot be used as a send gate. Send must use the scoped runtime
readiness result and live binding, not the generic connection state.

## Finding G — missing-binding recovery can trust a stale healthy preflight

disposition: implemented

The recovery branch reused the existing mutable send preflight without
invalidating it, so the readiness owner's already-healthy fast path could turn
the single recovery attempt into a no-op that still reported success.

The branch now sets `forceRecovery = true`, `runtimeHealthOk = false`, and
`enginePrepared = false` on the snapshotted preflight before calling
`ensureLocalRuntimeReachableForSend()`. Keep regression cover proving the
engine-only owner is actually invoked when the preflight arrives healthy.

## Finding H — an unavailable retry can be mistaken for transport uncertainty

disposition: implemented

Replay was entered from a missing result, so an `undefined` unavailable result
could cause a third submit attempt with no transport error observed.

Replay is now gated on a `transportErrorObserved` boolean set only inside a
`catch`, so neither `null` nor `undefined` reaches it. No general result
framework was introduced.

## Finding I — outer workspace-resolution settlement lacks its race acceptance tests

disposition: implemented

The conversation-service removes a `null` or rejected outer
`conversationWorkspaceByDirectory` promise only when that exact promise is still
the map value. The identity comparison was always the correct shape; what was
missing was the acceptance proving it.

Both cases are now covered. Rejection settlement was already tested. The
supersession race now is too: a newer resolution is installed for the same key
while the older one is still in flight, and the older one settling is proven not
to evict it. That is the case the identity comparison exists for.

## Finding J — the preflight error contract is duplicated across owners

disposition: implemented

The send workflow recreated a structural preflight error type and recognised it
through the string value of `error.name`, so an unrelated error with the same
name could enter recovery and a rename could silently break recognition.

The conversation-service owner now exports
`isConversationServerSubmitPreflightError()`, an `instanceof` guard, and the
send workflow imports it. No `error.name` comparison remains on that path. This
is exactly the KISS remediation proposed here — one shared guard at the owner
boundary, no repository-wide result abstraction.

## Finding K — lifecycle error mapping is duplicated and exposes upstream internals

disposition: implemented

**K1 — the upstream body crossed the API boundary.** The mappers put the
orchestrator request path and the complete upstream body into `ApiError.details`,
and `formatError()` copies `details` straight into the client response. The
server is not guaranteed loopback-only, because a bridge host can be bound with
the same auth, so this was internal topology leaving the process.

The response now carries only `upstreamStatus`. The path and a bounded body
excerpt moved to `lifecycleRequestDiagnostic()`, which the existing sanitized
lifecycle error trace records. A regression test serialises a mapped error and
asserts the workdir, upstream path, and internal fields are absent.

**K2 — three copies, one dead.** All three are replaced by one shared
`lifecycle-error-mapping` module, and the unreferenced composition-root copy is
gone.

The classification was carried over unchanged, deliberately. Consolidating
identical code cannot alter behavior, but *refining* a lifecycle code still
waits for the `/runs/:runId` evidence: adding a distinction before that evidence
exists would invent one nobody has demonstrated. The shared module says so at
its definition, so the next reader does not have to rediscover the constraint.

## Finding L — Den and standalone AI Gateway both own the capacity monitor

disposition: open — not verifiable from this repository

Neither service lives in this checkout, so this pass could neither confirm nor
refute it. Validate with the named cloud owner before any change.

### Evidence

Den and standalone AI Gateway contain practically identical Codex capacity
alert monitor implementations. Both services can start their copy when their
respective Managed AI and email configuration is present.

Current canonical documentation names standalone AI Gateway as the active
managed-AI and alert-email owner and describes Den inference as retired except
for explicit rollback behavior. The Den startup path nevertheless starts its
capacity alert loop whenever legacy Managed AI storage is enabled; it is not
guarded by an explicit rollback-only inference mode.

The two packages also carry independent Managed AI repositories, audit state,
and Codex dependency versions, so their behavior can drift even while the
monitor source still looks equivalent.

### Impact

If both services are configured, they can independently evaluate and send the
same operational capacity alert using separate deduplication state. This is a
duplicate-notification and ownership risk, not part of desktop send recovery.

### Required ownership decision

Choose one active owner. Based on the current documented architecture, the
KISS default is:

```text
standalone AI Gateway = active capacity monitor owner
Den = no active monitor unless an explicit rollback mode owns the whole path
```

Do not solve this by sharing mutable runtime state between the services. Either
remove the retired Den monitor after its rollback window or place it behind an
explicit, tested rollback-only switch.

### Required tests or operational evidence

1. Normal production configuration starts exactly one capacity monitor.
2. Rollback configuration names which service owns the monitor.
3. Starting both services cannot silently enable two senders.
4. Canonical Managed AI documentation matches the executable startup guard.

## Finding M — alert deduplication scans an arbitrary generic audit window

disposition: open — not verifiable from this repository

Same boundary as Finding L. Validate with the cloud owner.

### Evidence

The Codex capacity monitor in both services and the AI Gateway credential alert
monitor load the latest 5,000 generic audit events and filter action, entity,
and time in application memory.

The repositories order by newest event and apply the limit before the monitor
filters for the relevant sent-email action. If more than 5,000 unrelated audit
events are written during the throttle window, a still-relevant email event can
fall outside the fetched slice and the monitor can send it again.

### Impact

- deduplication correctness depends on unrelated audit volume;
- each polling interval transfers and allocates thousands of irrelevant rows;
- splitting the Den managed-AI audit table alone does not repair this query
  contract.

### Required repair contract

Query the persistence owner by relevant action/entity and minimum timestamp,
with an appropriate index and bounded result. If that cannot be added in the
current schema migration, track it as an explicit follow-up rather than
increasing the arbitrary limit.

This is a cloud persistence/alerting workstream. It must not enlarge the
desktop runtime patch.

## Findings deliberately not classified as defects

The ordinary skill preflight's fallback to an explicit empty runtime skill view
is covered by current tests and the optional-Skills policy. It is a deliberate
fail-open compatibility behavior. It remains a product tradeoff, but this
document does not turn it into a defect without evidence that required skills
were silently lost.

The existing per-flight cleanup in
`syncWorkspaceSkillMaterializationBeforeRuntime()` is also correct for active
promises. The additional binding cleanup finding concerns completed bindings,
not the in-flight promise map.

## Priority and ownership

| Priority           | Finding                                                 | Primary owner                          | Relationship                               |
| ------------------ | ------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| Implemented        | A — recovery succeeds without `baseUrl`                 | Desktop runtime lifecycle              | Closed; keep regression cover              |
| Implemented        | B — registration cache ignores runtime generation       | App conversation service               | Closed; read-key growth folded into E      |
| Implemented        | C — known 409 replayed as transport                     | App send workflow                      | Closed; keep the broader classifier        |
| Implemented        | G — recovery trusts cached healthy preflight            | App runtime readiness/send workflow    | Closed; keep regression cover              |
| Implemented        | H — unavailable retry enters transport replay           | App send workflow                      | Closed                                     |
| Implemented        | J — duplicated preflight error contract                 | App conversation service/send workflow | Closed; shared guard at the owner          |
| Implemented        | K — upstream body leak plus mapper duplication          | Server lifecycle boundary              | Closed; one shared mapper, safe response   |
| Implemented        | D — orchestrator directory lifecycle has no unregister  | Orchestrator                           | Closed; retirement on rebind               |
| Implemented        | E — app runtime skill binding has no cleanup/generation | App skill materialization              | Closed; absorbed B's residual              |
| Implemented        | I — supersession race test missing                      | App conversation service               | Closed                                     |
| Low/Medium         | F — connected/send-ready semantic mismatch              | App workspace state                    | Documentation/state contract follow-up     |
| High operational   | L — duplicate Den/Gateway monitor ownership             | Den and AI Gateway                     | Separate cloud owner decision              |
| Medium operational | M — generic 5,000-event dedupe scan                     | AI Gateway/Den persistence             | Separate query/index workstream            |

## Recommended implementation order

1. Decide whether F requires a state-model split or only a strict send-gate
   contract. This is a design decision, not a repair.
2. Resolve L and M in an independent cloud alerting/persistence workstream.

Everything else is implemented and covered. Refining a lifecycle code still
waits for the `/runs/:runId` evidence — the shared mapper preserved the existing
classification precisely so that decision stays open.

Do not combine the Den schema migration or production token repair with these
desktop/orchestrator changes.

The merged production remediation document should distinguish repository
implementation from requester-owned live validation. A step may reach an
`implemented` disposition after its scoped automated gate; a later manual run
can promote the evidence to `production-verified`. Do not keep an otherwise
implemented desktop repair indefinitely `pending` while also claiming that the
manual runtime run is not an implementation gate.

## Completion gate

Keep `done: false` until each open finding has one of:

- an owner-specific implementation plan;
- a linked issue with a bounded repair scope; or
- an explicit decision that the behavior is intentional and documented.

A finding whose disposition is `implemented` satisfies this gate once its
regression cover is confirmed; it needs no owner plan.

Only F, L, and M remain. F needs a decision rather than a repair; L and M need
their cloud owners.

One live confirmation is still outstanding for the repository work: a real
lifecycle failure response must be observed to carry no upstream body and no
orchestrator path. Everything else is covered by focused tests, and the
implementations were verified against the full server, orchestrator, and app
suites with no new failures.
