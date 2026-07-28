---
title: Production Runtime Remediation Implementation Plan
status: proposed
done: false
date: 2026-07-28
issue: unlinked
scope: owner-separated implementation and disposition of the 2026-07-28 runtime incidents
source_audits:
  - docs/plans/2026-07-28-production-runtime-error-causality-audit-plan.md
  - docs/plans/2026-07-28-server-owned-submit-missing-live-binding-recovery-kiss-plan.md
related:
  - docs/plans/2026-07-28-den-audit-event-schema-collision-remediation-plan.md
  - docs/plans/2026-07-27-kiss-optional-skills-nonblocking-runtime-remediation-plan.md
---

# Production Runtime Remediation Implementation Plan

## Purpose and tracking protocol

This is one execution-coordination document, not a claim that the listed
incidents have one cause or one release cycle. PRR01 is the immediate desktop
repair. The remaining steps are independent production workstreams with an
explicit final disposition.

Every agent works on one PRR step at a time. Each step starts with:

```text
state: pending
done: false
```

An agent may set `done: true` only after recording its acceptance evidence and
one of these final states:

```text
implemented
production-verified
disproved
externally-blocked
superseded
tracked-separately
```

`implemented` means the scoped repository change is complete; it does not
claim a production deployment. `externally-blocked` and `tracked-separately`
require the blocking owner and handoff artifact. The document-level `done`
becomes true when every step has one of these final dispositions, not only
when every incident has a shipped code fix.

Production configuration, database, and deployment changes require explicit
authority. Agents may prepare, verify, and document them, but must not invent
tokens, alter a database, restart services, or change deployments without that
authority.

Desktop E2E is explicitly waived for this workstream at the requester's
direction. Use focused tests, typechecks, static checks, and safe diagnostic
captures. The requester will perform installed-app and development-runtime
validation separately; an agent must record that evidence when it is supplied,
but it does not block the narrow repository implementation.

## Shared invariants

1. A connected Veslo server is not proof that local OpenCode is ready.
2. A local write never reuses a stale OpenCode URL or a read-only registration.
3. Browsing, passive reads, and abort stay non-starting actions.
4. Pre-HTTP missing-binding recovery and post-HTTP transport replay are
   separate, bounded mechanisms.
5. Managed AI configuration and runtime authorization remain server-owned
   submit concerns; engine-only recovery must not duplicate them.
6. Diagnostics use safe identities, digests, status codes, and lengths, never
   raw prompts, credentials, secret-bearing URLs, or raw user paths.
7. A hypothesis is never used as the cause of another incident.

## Sequencing and ownership lanes

```text
Lane A: PRR02 observability gap audit -> PRR01 desktop send repair
Lane B: PRR04 authorized token operation
Lane C: PRR05 Den schema plan
Lane D: PRR03 lifecycle evidence -> optional code change
Lane E: PRR06 web deployment identity -> PRR07 source diagnosis
Lane F: PRR08 evidence-gated Skills correlation
```

PRR02 begins with a field-map audit that is the entry gate for PRR01; its
minimal trace/redaction closure follows only after that map shows a real gap.
PRR01 and the change-producing part of PRR02 must not be implemented in
parallel. PRR03 may reuse PRR02 evidence but must first inspect the existing
lifecycle result. PRR05 follows its dedicated Den schema plan; this document
records only its chosen owner boundary and disposition.

## PRR01 — Existing-session missing-live-binding recovery

state: implemented
done: true

Owner: desktop app/runtime boundary

### Objective

Repair the reproduced existing local conversation send failure where
server-owned submit exits before HTTP because there is no live OpenCode base
URL.

### Required implementation

1. Extend the existing internal server-submit preflight error with a safe
   optional code and `httpAttempted` marker. Emit
   `local_live_binding_unavailable` only for a local Tauri write whose live
   registration lacks a usable base URL before HTTP.
2. At the conversation-service outer `conversationWorkspaceByDirectory` map,
   preserve and verify identity-safe settlement: a `null` or rejected
   workspace-resolution promise removes only its own map entry; successful
   resolution remains memoized. This is distinct from the lower registration
   flight cache and is required so the retry makes a fresh engine-info and
   registration attempt. The acceptance test must exercise that failed-first,
   recovered-second sequence rather than merely assert a cache implementation.
3. Expose a narrow `ensureLocalRuntimeReachableForSend` dependency to the
   session-send workflow and inject it from the app composition root. Do not
   expose or call full `prepareSendRuntimeForSend` in this recovery branch.
4. In the existing-session server-owned submit branch, catch only the exact
   preflight code with `httpAttempted=false`, then call the narrow engine-only
   dependency once for the snapshotted target workspace.
5. On successful engine reachability, retry the complete server-owned submit
   once with the original request, conversation identity, trace id, and
   `clientMessageId`.
6. Keep backend provisional-run ownership and operation busy-lock release
   unconditional: promote, dispose, and release exactly once regardless of UI
   selection changes. Restrict the UI-current guard to visible error,
   composer, and currently displayed conversation presentation only.
7. Preserve the existing transport replay as an independent one-replay path.
   Never share a retry counter or create a loop.

### Rollback trigger

Stop rollout and revert the PRR01 branch as one atomic change if either focused
or supplied live evidence shows any of the following:

1. more than one accepted/OpenCode prompt for one `clientMessageId`;
2. engine-only recovery starts for any reason other than the exact safe
   pre-HTTP code;
3. recovery invokes Managed AI bootstrap/configuration or full send
   preparation;
4. a backend provisional ownership record or operation busy lock remains after
   terminal handling; or
5. a transport failure consumes more than the existing one replay.

The revert keeps the stale-binding fence and restores the previous terminal
unavailable behavior; it must never restore stale URL reuse.

### Non-goals

- no stale URL fallback;
- no recovery for missing target/client, generic registration failure, remote
  submit, Managed AI preflight failure, or terminal server result;
- no first-message or compatibility-run race repair in this step;
- no Managed AI bootstrap/configuration from the recovery branch.

### Acceptance evidence

1. One shared preflight first returns missing binding and, after test runtime
   startup, performs fresh engine-info and workspace registration on retry.
2. Existing local session send does one engine-only recovery and succeeds with
   the same `clientMessageId`, without using compatibility run submission.
3. Recovery never invokes Managed AI bootstrap/configuration or full send
   preparation.
4. Recovery failure releases backend provisional/busy ownership once and
   cannot loop, even when the UI switched conversations.
5. Managed AI preflight failure, remote submit, missing target/client, and
   generic unavailable make zero engine-only recovery calls.
6. Combined sequence test: missing binding -> engine recovery -> transport
   exception -> exactly one same-key transport replay. It proves one engine
   recovery, one transport replay, a stable `clientMessageId`, and no loop.
7. Focused app tests, affected app typecheck, lint, and applicable static
   checks pass. Broader repository quality-gate findings are recorded
   separately when they are outside this send-path change.

Installed-app and development-runtime validation are requester-owned evidence
for a later `production-verified` disposition; they are not an E2E gate for
the scoped implementation.

### Implementation evidence

- The app now uses the exact `local_live_binding_unavailable` pre-HTTP code
  only on the existing server-submit path.
- A `null` or rejected outer workspace-resolution flight evicts only itself;
  successful resolutions remain shared.
- Recovery has a narrow engine-only dependency, preserves the original
  `clientMessageId`, and leaves one transport replay independent.
- The engine-only runtime port now explicitly bypasses the runtime controller's
  Managed-AI configuration gate. Normal requested runtime starts still retain
  that gate; a focused controller test proves the two paths remain distinct.
- Runtime reachability now fails closed until a usable live OpenCode URL is
  present; a server response is terminal rather than a transport-replay
  candidate, and a changed live URL receives a fresh registration.
- The original backend send is admitted after a UI switch, while its stale
  composer and last-prompt effects are skipped for the newly visible target.
-  The affected app suites now pass 170 focused tests covering conversation
  service, send readiness, existing-session submit, pending-draft cleanup,
  lifecycle recovery, trace correlation, and managed-AI config freshness.
  The app/server/orchestrator typechecks and `git diff --check` also passed on
  2026-07-28. The broad UI unit gate remains outside this evidence: it has
  dozens of pre-existing stale source-contract expectations for the already
  modularized app shell. They are tracked as repository quality debt rather
  than silently rewritten by this send-path change.

PRR01 is `implemented` / `done: true`. Requester-supplied installed-app or
development-runtime validation may later change its disposition to
`production-verified`; it is explicitly not an E2E gate for this repository
change.

## PRR02 — Observability gap audit before trace changes

state: implemented
done: true

Owner: desktop diagnostics with server/orchestrator trace integration

### Objective

Use the tracing already present before adding another correlation system, and
close only demonstrated safety or causality gaps.

### Required implementation

1. Before PRR01 implementation, produce a field map:

   ```text
   required field -> existing owner/event -> actual gap -> minimum change
   ```

   Cover trace/operation correlation, workspace identity/digest, engine owner
   tuple, runtime-skill operation id, server/orchestrator submit trace,
   deployment identity, `httpAttempted`, first failure, and final disposition.

2. Audit every participating app, server, orchestrator, and native trace for
   raw workspace path, workdir, config directory, engine URL, prompt, token,
   and secret-bearing URL leakage. Existing redaction must be verified, not
   presumed.
3. Record a short PRR01 handoff naming the already available correlation and
   redaction fields that its implementation must reuse.
4. After PRR01, add only fields the map proves missing. Reuse existing trace
   IDs and operation IDs; do not introduce a parallel tracing pipeline.
5. Preserve safe first and final failure snapshots so a late generic failure
   cannot overwrite the causal one.

### Initial field map and PRR01 handoff

| Required field          | Existing owner/event                                       | Actual gap                                        | Minimum PRR01 change                                                 |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| Trace correlation       | app send trace, server/orchestrator submit trace           | none for this incident                            | reuse the existing `traceId`                                         |
| Workspace identity      | app workspace id; server/orchestrator redacted path ids    | app trace previously emitted raw path fields      | central app sanitizer redacts path, URL, prompt, and credential data |
| Engine binding          | server/orchestrator engine owner and directory epoch tuple | not required before HTTP                          | do not add a duplicate app tuple                                     |
| Runtime skill operation | orchestrator skill operation id                            | unrelated to missing live binding                 | do not attribute this incident to Skills                             |
| Pre-HTTP boundary       | server-submit preflight error                              | previously lost precise cause across app workflow | carry safe code and `httpAttempted=false` in app trace               |
| First/final failure     | app timed steps and terminal events                        | no per-workspace persistent snapshot              | keep as a PRR02 owner-scoped follow-up, not a PRR01 tracing rewrite  |

The PRR01 implementation must reuse the existing trace id and safe workspace
identities. It must neither log paths, prompts, tokens, nor introduce a second
correlation pipeline.

### Current audit evidence (not completion disposition)

- App workflow traces now sanitize their buffer and shared native workflow
  trace payloads at one boundary. The two legacy local-buffer writers
  (composer and session page) now use that same sanitizer before mirroring an
  entry. App and composer buffers now feed the shared native workflow sink
  once rather than issuing duplicate Tauri log IPC calls for every event. The
  sink coalesces up to 24 entries or 75ms before one native IPC call, while the
  desktop writer persists each entry as a separate redacted NDJSON line.
  Desktop stderr retains only a safe `persisted` summary for those batches;
  it never duplicates the payload outside the redacted NDJSON boundary.
- Managed-AI authorization prime now forwards the already active safe send
  `traceId` to the local gateway proxy. The proxy uses it only when no active
  run context exists, so its pre-submit request can be correlated without
  overriding the authoritative active-run trace.
- Server workflow and skill-audit NDJSON now use one recursive sanitizer before
  file, mirror, or trace-console serialization. It redacts path/URL/credential
  fields and matching exception text while retaining IDs, endpoint paths, and
  status for correlation.
- Orchestrator path redaction no longer preserves a recognizable local path
  tail. The native desktop runtime writer was also audited: it already applies
  recursive payload redaction before its NDJSON file/mirror boundary. Detached
  orchestrator stderr diagnostics now use a workspace identity and redacted
  error/warning fields instead of a raw workspace path or service URL. The
  shared opt-in native flow-log boundary now redacts HTTP URLs, workspace/path
  fields, response bodies, transport details, and error tails before stderr.
- The app retains a bounded, persisted per-workspace snapshot containing only
  the first failure and final terminal failure's safe trace ID, event, phase,
  code, status, and pre-HTTP marker. The snapshot is normalized again when
  read from storage and is exposed in the existing runtime debug snapshot.
- The affected app diagnostics suites, the focused server sanitization and
  lifecycle-mapping suites, and the native trace writer suite passed on
  2026-07-28. The server binary was rebuilt. The native suite confirms that
  batching keeps one redacted NDJSON event per line and never mirrors a trace
  payload to stderr.
- Broader gates were inspected rather than hidden: the repository-wide UI unit
  gate remains blocked by unrelated stale app source-contract tests; the full
  server suite has two existing stale-run integration failures; the Rust gate
  stops at four unrelated formatting differences; and the architecture gate
  stops at four pre-existing header-literal audit findings. The complete
  monorepo typecheck and `git diff --check` pass.

PRR02 is `implemented` / `done: true`. It introduces no new retry or fallback
behavior and remains separate from any future incident-specific trace capture.

### Acceptance evidence

1. The field map and PRR01 handoff are committed in this step's fix note or
   documentation update.
2. Raw-path/workdir/config-directory/engine-URL redaction gaps are either
   fixed with focused tests or explicitly handed off to their owner.
3. If code changes are needed, focused tests prove new fields and sensitive
   fields absent; otherwise the audit can close without a tracing rewrite.
4. Required package checks pass for any changed package.

## PRR03 — Classify lifecycle status evidence before changing its contract

state: pending
done: false

Owner: local Veslo server and orchestrator lifecycle boundary

### Objective

Classify the observed post-acceptance lifecycle 503 without treating it as a
pre-submit runtime admission failure.

### Required implementation

1. Capture a sanitized response code/body and correlated trace for the
   production or controlled reproduction request to
   `GET /workspace/:id/conversations/:conversationId/runs/:runId`, where
   `runId=latest` is the latest-run shortcut.
2. Compare that evidence with the current classes already implemented for no
   lifecycle client, upstream lifecycle failure, and run-not-found.
3. Add a more specific external safe code only if the evidence proves that an
   existing internal distinction is being flattened and the distinction changes
   operational action. Do not add `engine_not_ready` to this endpoint without
   direct evidence.
4. Keep `runs/latest` post-acceptance only: it must not start an engine or
   become a second runtime-admission API.

### Acceptance evidence

1. The incident is classified as existing-code behavior with a documented
   operational action, an implemented safe-code refinement, disproved, or
   externally blocked.
2. Any server-source change has focused tests, typecheck, binary rebuild, and
   the relevant quality gate.
3. App lifecycle presentation remains distinct from missing live binding.

### Initial source audit (not a production disposition)

The parameterized route is present and accepts `runId=latest` as its latest-run
shortcut. Its current observable classes are:

| Condition                         | Current response                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| lifecycle client is absent        | `503 lifecycle_unavailable` with an owner-not-configured message                              |
| lifecycle request returns 503     | `503 lifecycle_unavailable` with the upstream status retained only in safe server diagnostics |
| lifecycle request returns 404     | `404 lifecycle_not_found`                                                                     |
| lifecycle returns no matching run | `404 run_not_found`                                                                           |

This confirms the reported external flattening, but does not prove which class
caused a production incident or that a new client-visible code changes an
operator action. PRR03 therefore remains pending a sanitized
production or controlled-route capture; no `engine_not_ready` code is added.

### 2026-07-28 local dev capture

Two app-side `runId=latest` probes timed out after six seconds while the server
continued to reconcile the accepted run. Neither timed-out request produced a
matching server `conversation-run-status:start` event. Later status requests
for the same workspace reached the server and settled in 39–74ms. This capture
therefore does not reproduce `503 lifecycle_unavailable` or justify a server
contract change; it localizes the observed delay to the client/native transport
or renderer before the server boundary. The run itself completed normally.

## PRR04 — Restore AI Gateway/Den token operation

state: pending
done: false

Owner: production configuration and AI Gateway/Den operations

### Objective

Restore credential-alert recipient lookup through the smallest authorized
operational repair.

### Required implementation

1. Safely compare the presence/hash of both expected values without exposing
   either secret.
2. Under authorized change control, provision matching values and restart only
   the directly affected services.
3. Run a controlled recipient lookup probe and retain only sanitized result,
   deployment generation, and operator record.

### Acceptance evidence

1. Approved production change record identifies owner and deployment identity
   without recording the secret.
2. The controlled probe succeeds and the affected path no longer emits
   `den_internal_token_missing`.
3. Sanitized capture proves no token value was logged.

No new missing-versus-empty runtime readiness contract is required unless the
current safe operational evidence proves insufficient.

## PRR05 — Den managed-AI audit table split

state: implemented
done: true

Owner: Den database and managed-AI persistence

### Objective

Keep core Den `audit_event` unchanged and align the stale Den managed-AI
consumer with the already migrated AI Gateway-owned
`ai_gateway_audit_event` table.

### Required implementation

Execute the dedicated schema collision remediation plan. This master plan does
not reopen a shared-table migration alternative or introduce a second migration
runner.

### Acceptance evidence

The local source and contract portion is complete: Den audit and alert
repositories use the AI Gateway-owned table, while the existing AI Gateway
migration remains the only forward deployment path. A focused repository
contract drives both managed-AI repositories through their actual read/write
table selections and rejects the core Den table. Focused Den and AI Gateway
schema/migration tests and both service typechecks passed on 2026-07-28.

Production migration and monitor evidence remain requester/operations-owned
verification for the dedicated plan; they do not reopen the completed local
owner-boundary implementation.

## PRR06 — Establish web deployment identity and Server Action compatibility

state: pending
done: false

Owner: web deployment/release boundary

### Objective

Prove or disprove a stale browser asset/server action deployment mismatch
before attempting a web runtime code fix.

### Required implementation

1. Capture safe browser asset/build generation, server commit, and release
   identity with a relevant Server Action failure.
2. Verify cache/CDN invalidation and rollout behavior for mixed generations.
3. If mismatch is proven, apply the smallest deployment/cache remedy and add
   its release guard. Otherwise hand off a source-mapped action failure as a
   separate defect.

### Acceptance evidence

1. One relevant failure has correlated browser and server deployment identity.
2. A controlled release check proves the selected mitigation, or evidence
   disproves the mismatch.
3. No claim is made about `digest` or `workers` from this result alone.

## PRR07 — Diagnose independent `digest` and `workers` errors

state: pending
done: false

Owner: web runtime

### Objective

Classify each null/undefined web error independently before changing behavior.

### Required implementation

1. Obtain safe request correlation and source-map/release resolution for each
   error family.
2. Determine input-contract, deployment artifact, backend-field, or local-code
   root cause independently for each family.
3. Implement separate minimal repairs only after classification.

### Acceptance evidence

Each error has a distinct root-cause evidence package and focused regression
coverage, or is explicitly `disproved`, `externally-blocked`, or
`tracked-separately` with its evidence gap.

## PRR08 — Verify fail-open Skills boundary and correlate staging only

state: pending
done: false

Owner: workspace skill staging/runtime boundary

### Objective

Verify that the current app-side fail-open serving-binding behavior keeps
ordinary runtime available, while treating orchestrator skill staging
`skill_view_changed` as a separate incident that requires its own matching
operation evidence.

### Required implementation

1. Add or verify focused evidence that an unavailable/invalid serving view at
   the app boundary resolves through the existing fail-open binding behavior
   and does not block ordinary runtime.
2. Use the PRR02 field map to correlate orchestrator staging
   `skill_view_changed` with skill/authorization revision, directory/engine
   generation, operation ID, and activation terminal result.
3. Reproduce or capture a matching direct orchestrator staging failure.
4. Only when confirmed, select the applicable existing Skills remediation
   workstream. Do not add fallback or retry behavior here by default.

### Acceptance evidence

Focused fail-open evidence proves that app-side Skills do not block ordinary
runtime. A matching orchestrator trace then either proves or disproves staging
causality for a specific operation. Any follow-up remains non-blocking for
ordinary runtime and is tracked under the selected Skills plan.

### Current source evidence (not completion disposition)

- The app's serving-view refresh failure test resolves to the canonical empty
  binding and permits ordinary runtime activation.
- Direct staging tests distinguish a transient nested edit that settles and
  stages successfully from a persistent nested edit reported as
  `skill_view_changed`.
- The existing code already carries runtime skill operation ID, revisions, and
  directory/engine generation through the server-orchestrator boundary.
- On 2026-07-28, the focused app fail-open suite (8 tests), server serving-LKG
  and revocation suite (14 tests), and direct orchestrator staging suite (34
  tests) all passed. This proves the local non-blocking boundary, not causality
  for an unrelated incident without a matching operation trace.

No supplied incident contains a matching operation trace for the reported
`skill_view_changed`, so no causal link or new retry/fallback is claimed.
PRR08 remains `pending` / `done: false` pending that evidence.

## Document completion gate

The document-level `done` becomes true only when PRR01 through PRR08 each have
`done: true` and a final state with its evidence. It does not require every
workstream to be implemented or production-verified; a proved non-cause,
authorized external blocker, superseded plan, or explicit separate tracker is
a valid final disposition.
