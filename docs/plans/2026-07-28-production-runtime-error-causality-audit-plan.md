---
title: Multi-Incident Production Diagnostics Causality Audit
status: proposed
done: false
date: 2026-07-28
issue: unlinked
scope: read-only causality audit for the latest production diagnostics and cloud logs
related:
  - docs/plans/2026-07-28-server-owned-submit-missing-live-binding-recovery-kiss-plan.md
  - docs/plans/2026-07-28-den-audit-event-schema-collision-remediation-plan.md
  - docs/plans/2026-07-27-kiss-optional-skills-nonblocking-runtime-remediation-plan.md
---

# Multi-Incident Production Diagnostics Causality Audit

## Purpose

This document is the index for several production diagnostic incidents observed
on 2026-07-28. It is an audit and verification plan, not a shared remediation
plan. Its purpose is to prevent unrelated errors from being merged into one
vague "runtime unavailable" explanation and to preserve enough evidence for
the owner-specific fixes.

The audit is intentionally read-only. It does not restart production services,
change production configuration, repair the database, or modify application
runtime code.

The desktop application remains the runtime under test. The cloud services are
treated as sync, lifecycle, AI gateway, web, and diagnostics infrastructure;
they are not assumed to be the owner of a local OpenCode engine.

## Evidence boundary

The latest diagnostic capture was read from the production debug-log ingest
path. It contained a local desktop send attempt for workspace
`ws-639a5b643580` and a second attempt for `ws-a6a8ced5f2e1`.

The first attempt showed:

```text
engineReady=false
hasClient=false
engine-info:end outcome=ok hasBaseUrl=false
conversation-read:live-opencode-unavailable
conversation-workspace-unavailable-id
submitConversationFromVesloWriteApi:unavailable
server-submit-existing-unavailable
sent=false
busy=false
streaming=false
```

No conversation-submit HTTP request was recorded for either failed send. This
is important: the server did not reject these prompts. The app returned before
crossing the server submit boundary.

The production checkout observed over SSH was at `bf093f2e1`. The current local
checkout was at `8f19d03e` / `v2026.7.18`. Cloud evidence therefore must be
compared with the deployed commit before declaring a local fix released.

## Evidence provenance

The following metadata is safe to retain in the repository. Raw diagnostic
payloads, prompts, credentials, auth headers, and full user filesystem paths
must remain outside Git.

| Field | Sanitized record |
| --- | --- |
| Capture id | `95d00390-b1b3-42ad-9c97-2943dcfa74d6` |
| Capture time window | `2026-07-28T11:43:21Z` – `2026-07-28T11:43:35.712Z` |
| Capture source | Production Den debug-log ingest, user diagnostic capture |
| Workspace ids | `ws-639a5b643580`, `ws-a6a8ced5f2e1` |
| Capture summary | `capturedBytes=94602`, `capturedEvents=156`, dropped counts `0` |
| Terminal reason | `user_stopped` |
| Production checkout | `bf093f2e1` |
| Local comparison checkout | `8f19d03e`, `v2026.7.18` |
| Query method | Read-only SSH + Docker/Compose logs + sanitized debug-log query |
| Raw payload retention | Not committed; redacted at read time |
| Stable event/trace export | Not retained in this record; follow-up required |

This provenance record proves which capture and deployment snapshot the local
send claims refer to. It does not prove that every cloud log listed below came
from the same desktop build or deployment generation. Each incident therefore
has its own deployment identity status.

## Deployment identity matrix

| Component | Identity available in this audit | Identity status |
| --- | --- | --- |
| Desktop Veslo application | Capture metadata does not retain the installed desktop build | Missing; must be captured on the next live run |
| Bundled Veslo server sidecar | Not retained in the cloud capture | Missing |
| Bundled orchestrator | Not retained in the cloud capture | Missing |
| Local OpenCode runtime | Workspace/engine generation not retained as a stable deployment identity | Missing; runtime cause remains open |
| Production Veslo checkout | `bf093f2e1` | Observed over SSH |
| Den image/container | Container was observed, but image digest was not retained | Incomplete |
| AI Gateway image/container | Container was observed, but image digest was not retained | Incomplete |
| Web deployment | Web asset generation and deployed commit were not retained | Missing |

The local desktop send conclusion is therefore bounded: the capture proves the
pre-HTTP missing-binding behavior, but it does not prove that the cloud
checkout, sidecars, and installed desktop were from one release generation.

## Confidence taxonomy

Use these labels consistently:

- **Code-path confirmed:** the current repository contains the described
  branch or schema contract.
- **Production evidence observed:** the described value or event was observed
  in a sanitized production capture or read-only production query.
- **Cross-component causality confirmed:** the code path and production event
  are correlated by stable capture/trace/deployment identity, and no earlier
  boundary explains the symptom.
- **Hypothesis:** plausible interpretation that still needs correlation,
  source-mapped evidence, or reproduction.

"Confirmed" in this document means code-path confirmed unless it explicitly
says cross-component causality confirmed.

## Causality classification

| Symptom | Direct cause | Confidence | Owner |
| --- | --- | --- | --- |
| `Server-owned conversation submit is unavailable` | A non-blocking browse activation marks the workspace connected without starting OpenCode; existing-session send then requires a live OpenCode base URL and returns before HTTP submit. | Code-path confirmed; production evidence observed; cross-component causality for this capture confirmed up to the missing URL. The reason the engine had no URL remains open. | Desktop app / local runtime boundary |
| `/runs/latest` returns 503 | The local Veslo server has no usable lifecycle owner for that request, or its configured lifecycle owner is unavailable. | Code-path confirmed; production branch unresolved because the response body was not retained. | Local Veslo server / orchestrator lifecycle |
| `den_internal_token_missing` | An empty/absent token is converted to `null` and rejected by AI Gateway. | Code-path confirmed; production token state observed by safe length probe; matching-value verification pending. | Production configuration / AI Gateway |
| Den `audit_event` query failure | Managed-AI repository selects newer audit columns from a table whose deployed schema is older. | Code-path confirmed; production schema observed; cross-component causality confirmed. | Den schema ownership / migration |
| `Failed to find Server Action` | A stale client/server action deployment mismatch is a plausible trigger. | Production evidence observed; hypothesis, not a shared cause for the other web errors. | Web deployment |
| `digest` null access | A separate Next request/runtime failure. Its relation to the Server Action error is unproven. | Production evidence observed; hypothesis. | Web deployment |
| `workers` undefined access | A separate Next request/runtime failure. Its relation to the Server Action and `digest` errors is unproven. | Production evidence observed; hypothesis. | Web deployment |
| `skill_view_changed` during activation | A separate skill snapshot/staging race. It was not present as the direct reason in the latest failed-send capture. | Separate incident; no correlation in this capture. | Workspace skill staging |

## Verified causal chain A: local send is attempted before runtime readiness

### Current behavior

The send-target path activates a workspace with origin
`send-target:selected-session-workspace`. That origin belongs to the passive
local browse set in `workspace-activation-controller.ts`.

The browse implementation explicitly avoids starting, switching, or reloading
an engine. It can still update the UI connection state to `connected` and
return a successful browse activation.

The existing-session send branch then tries the server-owned conversation write
before the normal local runtime preparation path has established an engine
binding. `conversation-service.ts` requires a live OpenCode registration for a
local write. When `engineInfo()` has no `baseUrl`, the resolver correctly
refuses to reuse a stale or read-only registration and returns unavailable.

The UI flattens that result to:

```text
Server-owned conversation submit is unavailable for this local session.
```

### Code evidence

- `packages/app/src/app/context/workspace-activation-controller.ts` includes
  `send-target:selected-session-workspace` among non-blocking local browse
  origins.
- `packages/app/src/app/context/workspace.ts` documents that browsing is
  non-blocking and must not start an engine.
- `packages/app/src/app/context/workspace-send-target.ts` invokes activation
  with that send-target origin.
- `packages/app/src/app/context/conversation-service.ts` requires a live
  OpenCode `baseUrl` for local writes and rejects an absent binding.
- `packages/app/src/app/pages/session-send-workflow.ts` handles the missing
  result as the generic server-owned-submit error.

### Why this is not a cloud submit rejection

The trace has a connected Veslo server client, but `hasBaseUrl=false` and no
conversation-submit request. Therefore the failure occurs in the local
pre-HTTP binding phase. A server-side retry or cloud restart cannot repair this
specific sequence.

This does not yet prove why the local engine had no URL. The remaining local
runtime hypotheses are cold start not completed, engine crash or early exit,
engine disposal during workspace transition, stale host runtime ownership, or
another readiness race. The current capture proves the missing live binding,
not which of these caused it.

### Required invariant

Passive browsing may remain non-blocking for navigation and reads. A send
operation must not treat a passive browse result as runtime-ready. Before a
local write, the send-owned path must either:

1. perform bounded runtime preparation and establish a fresh live binding, or
2. return a typed, actionable local-runtime-unavailable reason.

The existing KISS implementation plan for the bounded pre-HTTP recovery is
tracked separately in
`2026-07-28-server-owned-submit-missing-live-binding-recovery-kiss-plan.md`.

That related plan is not treated as completed or as proof of a fix. It must
preserve the negative workspace-resolution result, use engine-only recovery,
and keep the snapshotted send target stable while recovery runs.

## Causal chain B: `/runs/latest` 503

The server route has two relevant failure classes:

1. no lifecycle client is configured, producing `lifecycle_unavailable`; or
2. a configured lifecycle client cannot reach its orchestrator owner.

The production capture records the 503 status but not the response body. It is
therefore not valid to claim from the capture alone that the lifecycle token is
missing, nor that the orchestrator process is dead.

The event is nevertheless secondary for the failed send described above:
there was no accepted conversation submit and therefore no server-owned run
whose latest lifecycle state could be read.

### Verification required before implementation is marked complete

- Capture the sanitized `/runs/latest` response code and error code, never
  tokens or URLs containing credentials.
- Read-only verify whether the local server created its lifecycle client from
  `VESLO_ORCHESTRATOR_URL` and `VESLO_ORCHESTRATOR_LIFECYCLE_TOKEN`.
- Correlate the request with the local engine generation and workspace id.
- Keep `lifecycle_unavailable` distinct from `run_not_found` and from an
  OpenCode engine-not-ready condition.

## Causal chain C: AI Gateway to Den token

The AI Gateway credential-alert monitor calls the Den admin recipient lookup.
The AI Gateway environment parser trims the shared internal token and converts
an empty value to `null`. The admin client then throws
`den_internal_token_missing` with HTTP 503.

The production container had both expected variable names present, but a safe
non-secret length check indicated that their values were empty. This agrees
with the repeated production error. It is production evidence for an empty
runtime token, not proof that the two sides contain matching values; the
matching-value check must be performed without exposing either value.

Relevant contracts:

- Den expects `DEN_AI_GATEWAY_INTERNAL_TOKEN`.
- AI Gateway expects `AI_GATEWAY_DEN_INTERNAL_TOKEN`.
- `packaging/owned-server/compose.yml` maps both names from the production env
  file.
- `services/ai-gateway/src/http/admin.ts` explicitly throws
  `den_internal_token_missing` when the token is absent.

The monitor catches this failure and attempts its configured fallback recipient
path. It is operationally significant because credential alerts may not be
delivered, but it is not the direct cause of the local prompt being rejected.

## Causal chain D: Den `audit_event` schema drift

The managed-AI capacity monitor calls `listAlreadySentEmailKeys()`, which reads
up to 5000 events from `audit_event` on every monitor run.

The managed-AI repository expects the newer audit contract:

```text
id, actor_user_id, entity_type, entity_id, action, result, summary, created_at
```

The production table has the older core Den contract:

```text
id, org_id, worker_id, actor_user_id, action, payload, created_at
```

The query therefore references columns that do not exist. This is a durable
schema ownership/migration defect, not a transient MySQL failure.

The codebase currently contains both:

- `services/den/src/managed-ai/schema.ts`, defining the newer contract; and
- `services/den/src/db/schema.ts` plus the original Den bootstrap, defining the
  older table under the same physical name.

The audit must not silently fix this by adding columns to the old table. Before
implementation, ownership must be chosen explicitly: migrate the table to one
canonical contract, or give managed-AI its own table name and migration. The
choice must account for existing audit data and all readers/writers.

The remediation is tracked separately in
`2026-07-28-den-audit-event-schema-collision-remediation-plan.md`.

## Causal chain E: independent Next.js web hypotheses

The web logs include:

```text
Failed to find Server Action
Cannot read properties of null (reading 'digest')
Cannot read properties of undefined (reading 'workers')
```

These must not be treated as one verified causal chain. They are separate
observations until a request id, asset generation, deployed commit, or
source-mapped event connects them.

### E1 — Server Action lookup failure

`Failed to find Server Action` explicitly supports the hypothesis that a request
came from an older or newer web deployment than the server handling it. This is
a high-value deployment hypothesis, not a confirmed root cause without web
asset/deployment correlation.

### E2 — `digest` null access

`Cannot read properties of null (reading 'digest')` is a separate runtime error
until evidence shows it was thrown while handling the same Server Action
request. It may share a Next.js deployment boundary, but that is not proven.

### E3 — `workers` undefined access

`Cannot read properties of undefined (reading 'workers')` is another separate
runtime error until its request and source-mapped function are identified. The
available log does not prove that it shares a cause with E1 or E2.

The three web hypotheses require their own deployment matrix and should not
block completion of the desktop send audit.

## Non-causes and misleading signals

The following were observed but are not causal for the failed local send:

- `/health` returned 200; this proves process health, not local OpenCode engine
  readiness.
- `/api/me/ai-access` returned 200; access metadata does not prove a live local
  conversation runtime.
- Proxy ACME renewal messages are informational.
- Worker-manager startup/health is unrelated to the local desktop OpenCode
  binding.
- The diagnostic capture itself completed successfully and had no dropped
  events.
- The earlier `OpenCode reload failed` GlitchTip event is not sufficient
  evidence for this send failure because a later reload succeeded.

## Observability gaps exposed by the audit

The current logging makes the user-visible symptom possible to find but makes
the decision path unnecessarily hard to prove.

The app should record, in sanitized form:

```text
send target workspace
activation policy: browse | runtime
engine readiness
has live baseUrl
typed unavailable reason
HTTP submit attempted: yes | no
lifecycle lookup result
recovery attempt and ordinal
final disposition
```

The following must never be logged:

- OpenCode base URLs containing secrets or tokens,
- auth headers,
- prompt contents,
- raw environment values,
- full filesystem paths when they contain user-sensitive data.

The current generic `null` result from the conversation write boundary should
be preserved internally as a typed reason before changing user-facing text.
Otherwise later diagnostics can only reconstruct the cause indirectly from
several preceding events.

## Verification matrix

| Check | Evidence needed | Status |
| --- | --- | --- |
| Existing local send with passive browse activation | No base URL, no HTTP submit, typed local binding reason | Observed, typed reason not yet present |
| Existing local send after runtime preparation | Fresh base URL and exactly one accepted submit | Pending implementation/live run |
| Missing lifecycle configuration | Sanitized `/runs/latest` body with `lifecycle_unavailable` | Pending |
| Unreachable lifecycle owner | Sanitized upstream error and correlation to orchestrator | Pending |
| AI Gateway token | Both sides contain non-empty matching secret without logging values | Empty runtime value observed; matching-value proof pending |
| Den audit schema | Migration/schema inspection and all repository owners identified | Confirmed drift; repair design pending |
| Server Action deployment mismatch | Same deployed commit/browser asset generation or source-mapped event | Hypothesis; pending |
| `digest` request/function | Request correlation and source-mapped stack | Hypothesis; pending |
| `workers` request/function | Request correlation and source-mapped stack | Hypothesis; pending |
| Skill view change | Matching skill revision/staging trace for the same failed operation | Not established in latest capture |

## Implementation boundaries

The eventual fixes must remain separated by owner:

1. **Desktop/app send path:** establish runtime readiness before local write and
   preserve typed pre-HTTP failure reasons.
2. **Local Veslo server/lifecycle:** distinguish missing lifecycle owner,
   upstream lifecycle failure, and no run.
3. **Production configuration:** provision the shared AI Gateway/Den token
   without committing or logging it.
4. **Den database:** resolve `audit_event` ownership and add an explicit,
   backwards-aware migration or table split.
5. **Web deployment:** eliminate stale Server Action/client asset overlap and
   verify the deployed commit.
6. **Skill staging:** investigate only with a matching revision/staging trace;
   do not use it as an explanation for unrelated `baseUrl` failures.

## Incident index and independent status

| Incident | Remediation artifact | Current status |
| --- | --- | --- |
| Desktop pre-HTTP local binding | `2026-07-28-server-owned-submit-missing-live-binding-recovery-kiss-plan.md` | Separate proposed plan; not implemented |
| Local lifecycle 503 classification | Follow-up server diagnostics plan required | Audit evidence incomplete |
| AI Gateway/Den internal token | Production configuration issue/issue required | Empty runtime value observed; repair not authorized here |
| Den `audit_event` collision | `2026-07-28-den-audit-event-schema-collision-remediation-plan.md` | Separate proposed plan; not implemented |
| Next Server Action lookup | Web deployment issue required | Hypothesis pending deployment correlation |
| Next `digest` error | Separate web issue required | Hypothesis pending request correlation |
| Next `workers` error | Separate web issue required | Hypothesis pending source mapping |
| Skill view staging race | Existing skills plans/issues | Not correlated to this capture |

Completion of this audit does not imply completion of any row in this table.

## Completion gate for this audit

Mark the audit `done: true` independently of remediation once:

- each symptom is classified as code-path confirmed, production evidence
  observed, cross-component causality confirmed, or hypothesis;
- each incident has provenance sufficient to reproduce the read-only query or
  explicitly records the missing provenance;
- the desktop send capture is tied to a capture id, time window, workspace id,
  and available deployment identity;
- the deployment matrix distinguishes desktop, sidecar, orchestrator, Den,
  AI Gateway, and web identities;
- independent incidents have an owner and a separate issue/plan or are
  explicitly marked as awaiting one;
- the plan states what is not proven and does not claim that a remediation was
  applied.

Remediation completion remains in the linked owner-specific plans. In
particular, this audit does not wait for the desktop runtime fix, token repair,
Den migration, or web deployment repair.

E2E is intentionally not part of this audit plan. Desktop/live-run validation
can be performed separately after the narrow implementation changes are ready.
