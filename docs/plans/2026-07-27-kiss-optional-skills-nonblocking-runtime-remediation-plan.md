---
title: KISS Optional Skills Runtime Remediation Plan
status: proposed
done: false
date: 2026-07-27
issue: unlinked
parent_plan: 2026-07-27-runtime-skill-resilience-decoupling-plan.md
sandbox_scope: deferred
---

# KISS Optional Skills Runtime Remediation Plan

## Business goal

Skills may affect runtime preparation. Veslo may consult or briefly await Skills
only inside the runtime's existing bounded activation budget when that improves
the chance of starting with the intended authorized set. Skills do not own a
separate readiness gate. If the core runtime can start, Skills must never be the
sole reason that it crashes, remains unavailable, rejects an ordinary send, or
enters a recovery loop.

This replaces the overly broad statement "runtime never waits for Skills" with:

> Ordinary activation prefers the authorized Skills set, but always has a
> canonical empty result. A Skills lookup may consume part of the existing
> activation budget; it may not extend that budget, add nested retries, or turn
> a healthy core runtime into a failed runtime.

An explicit Skills install, enable, disable, apply, or reload operation may wait
for and report its own failure. That failure belongs to the Skills operation; it
does not make ordinary conversation runtime unavailable.

The primary acceptance question is deliberately simple:

> If OpenCode and the ordinary conversation path are otherwise usable, can a
> missing, empty, stale, malformed, or temporarily unavailable Skills input by
> itself make the runtime action fail?

The required answer is **no**. The rest of this plan either preserves
authorization safety or makes that answer diagnosable; it is not a separate
product objective.

The business priorities, in order, are:

1. ordinary conversation runtime remains available;
2. revoked or ambient skills are never admitted as a fallback;
3. the intended authorized skills are used when their complete binding is
   already usable within the activation budget;
4. reconciliation makes a newer skill set available later without disturbing
   an active run.

## Business rules

| Situation | Ordinary runtime behavior |
| --- | --- |
| Healthy engine with still-authorized binding | Reuse it |
| Valid serving binding available | Start with exactly that binding |
| No authorized workspace skills | Start with canonical empty binding |
| Serving refresh is still running | Reuse a still-authorized healthy engine; otherwise use canonical empty |
| Binding is missing, incomplete, stale, or invalid | Use canonical empty |
| Skills control plane is unavailable | Reuse a healthy binding whose authorization is still locally provable; otherwise use canonical empty |
| Current binding was revoked | Do not admit a new run to it; replace with a newly authorized binding or empty |
| Explicit Skills apply requests an exact revision | The Skills operation may fail; existing conversation runtime remains usable |

Global skill catalog entries remain management/import choices. They are never
an automatic runtime fallback. A workspace may therefore run with zero skills
whether global catalog entries exist or not.

## Confirmed current defect

The serving identity is already a pair:

```ts
type RuntimeSkillBinding = {
  revision: string;
  authorizationRevision: string;
};
```

The server and orchestrator understand both fields, but the current runtime-view
response, app cache, Tauri IPC, and desktop activation transport only
`skillViewRevision`.

Canonical empty requires both values:

```text
empty-direct-skill-view/v1
empty-direct-skill-authorization/v1
```

Because the authorization revision is lost, the orchestrator does not recognize
canonical empty mode, tries to read a serving manifest, and raises
`skill_view_stale`. App recovery then repeats the same incomplete request.

The first repair is therefore transport consistency, not creating an empty
manifest and not adding another retry.

## Minimal runtime contract

### Complete binding

Use one nullable binding object at every activation boundary:

```ts
type RuntimeSkillBinding = {
  revision: string;
  authorizationRevision: string;
};
```

`null` means that the caller does not currently have a usable serving binding.
It never means that one revision may be sent without the other.

The complete object travels through:

```text
server runtime-view response
-> app workspace binding cache
-> local runtime lifecycle
-> Tauri prepare/activate command
-> desktop activation request
-> orchestrator engine binding
```

Keep the existing runtime-view response shape and add the required
`authorizationRevision`. Do not introduce a new public selection DTO merely for
this repair. Canonical empty is identified by its complete binding pair.

### Ordinary activation fallback

Ordinary activation may use a serving-binding preparation already available at
the activation boundary, or await one bounded attempt within the existing outer
activation budget. It does not owe Skills a separate timeout and it does not
start nested Skills refresh or recovery retries. Once the outer activation path
must choose, lack of a usable Skills result resolves to canonical empty rather
than to a runtime failure.

Resolution order:

```text
1. reuse a healthy engine when its complete binding is still authorized;
2. otherwise use the complete current serving binding when it is immediately
   valid;
3. otherwise use the complete canonical empty binding;
4. schedule or coalesce background reconciliation when its owner is available.
```

Missing one half of a non-empty binding is invalid input. It must never launch
as authorized. Ordinary activation replaces it with canonical empty before
engine lookup/spawn. An explicit exact-revision Skills operation may instead
reject it.

There is no second persisted LKG pointer in this KISS repair. The serving
manifest already is the durable server-owned selection, while a separately
persisted orchestrator LKG would duplicate authorization state and could revive
a revoked skill while the Skills control plane is unavailable. Availability is
preserved by canonical empty instead.

Canonical empty launch is manifest-free and always produces:

```text
skillViewRevision = empty-direct-skill-view/v1
authorizationRevision = empty-direct-skill-authorization/v1
skills.paths = []
external/global discovery = disabled
raw project OpenCode configuration = disabled
```

### Revocation

Disable, removal, or policy revocation is different from content staleness.

For a revoked non-empty binding:

1. persist the revocation fence before accepting another run;
2. reject new admission to the old engine binding;
3. allow an already attached run to reach its defined terminal boundary;
4. replace the engine at idle with a newly authorized binding or canonical
   empty;
5. verify the replacement binding before reopening admission.

A stale content revision may continue temporarily on a healthy engine. A
revoked authorization revision may not accept a new run.

## Implementation steps

### KSR01 - Repair binding transport

- add required `authorizationRevision` to the existing server runtime-view DTO;
- store `RuntimeSkillBinding`, not a revision string, in app workspace state;
- pass the complete nullable binding through local runtime lifecycle and Tauri
  commands;
- send both activation headers/fields to the orchestrator;
- parse and retain both values in engine state and run admission state;
- add contract tests at every boundary so either dropped half fails the test.

### KSR02 - Add safe ordinary fallback

- centralize ordinary binding resolution at the orchestrator activation owner;
- consume at most one bounded best-effort preparation result inside the existing
  activation budget, without creating a separate Skills readiness gate;
- convert missing/incomplete/stale/invalid preparation to canonical empty
  before engine lookup/spawn;
- remove the `skill_view_stale -> forceRefresh -> prepare again` sequence from
  ordinary activation and recovery;
- coalesce background reconciliation instead of starting another activation
  flight;
- keep exact revision failure only on explicit Skills apply/reload operations.

### KSR03 - Preserve authorization safety

- require a complete currently authorized binding before healthy-engine reuse;
- prevent new admission to a revoked engine binding;
- replace at idle with an authorized binding or canonical empty;
- verify that global/ambient skills remain absent in every fallback path.

### KSR04 - Add only decision-grade logging

Emit one structured event per activation decision:

```text
runtime-skill-resolution
  operationId
  workspaceId
  requestedRevision
  requestedAuthorizationRevision
  result = healthy-engine | serving | empty
  resolvedRevision
  resolvedAuthorizationRevision
  fallbackReason
  reconciliationScheduled
  engineOwnerId
  enginePid
```

The event must distinguish normal `no_authorized_skills` from degraded fallback
such as `binding_incomplete`, `binding_stale`, `manifest_invalid`,
`authorization_revoked`, or `control_plane_unavailable`.

Tauri/native errors retain safe structured `code`, `phase`, and binding fields
while filesystem paths remain redacted. Repeated health polls do not replace or
hide the first resolution decision.

## Acceptance criteria

### Automated business coverage

1. No workspace skills: canonical empty engine starts and an ordinary runtime
   action can proceed, whether or not global catalog skills exist.
2. No global skill enters `skills.paths` merely because the workspace has no
   authorized skill.
3. Valid non-empty serving binding: both revisions reach the engine and only
   authorized ordered paths are active.
4. Canonical empty response: both canonical revisions reach the orchestrator;
   no manifest is required and no `skill_view_stale` occurs.
5. Non-empty binding missing `authorizationRevision`: it never starts as
   authorized; ordinary activation uses canonical empty.
6. Missing/invalid serving manifest: ordinary activation uses canonical empty
   and schedules one background reconciliation.
7. Skills control plane unavailable while the core runtime and Conversation API
   remain available: ordinary runtime reuses a still-provably-authorized healthy
   binding or uses canonical empty, and does not surface a Skills activation
   failure.
8. One transient Skills delay may consume only the existing activation budget;
   there is no nested force-refresh/recovery retry storm.
9. Explicit exact-revision Skills apply may fail without stopping or poisoning
   the existing ordinary conversation runtime.
10. Revoked running non-empty engine accepts no new run; after the active run
    boundary it is replaced by a newly authorized binding or canonical empty.
11. A healthy engine with a non-matching or revoked authorization binding is
    never reused for new admission.
12. Ambient/global skill roots remain excluded for serving and empty
    fallback.
13. Every activation emits one `runtime-skill-resolution` event that explains
    the chosen business outcome.

### Real desktop evidence

Keep the desktop gate focused on the user-visible business contract:

- cold start and an ordinary runtime action with an empty workspace;
- an ordinary runtime action with a valid non-empty workspace binding;
- one broken or unavailable Skills-input case that still starts canonical
  empty;
- trace evidence that none of these paths enters a stale-view retry storm or
  injects an ambient global skill.

Revocation fencing, complete-pair transport, missing-manifest behavior, and the
global-catalog distinction are deterministic owner-level contracts and remain
required automated coverage. They do not each require a separate desktop
scenario for this KISS repair.

Use the real Tauri runtime and the repository desktop preflight. Rebuild the
server binary before relying on server-backed desktop evidence. Finish the
source handoff with `pnpm check`.

## Deferred from this KISS repair

These may be useful follow-up work, but they are not required to restore the
business contract:

- replacing the existing runtime-view API with a new selection DTO;
- changing zero-skill candidate storage or publication internals;
- renaming candidate cleanup/discard telemetry;
- provider-start watchdog and lifecycle poll logging changes;
- general health-poll coalescing;
- full managed-package/watcher architecture from the parent plan;
- sandbox, WSL, links, mounts, or projection compatibility.

Existing misleading logs should not block this repair when the new
`runtime-skill-resolution` event gives a complete activation decision.

## Scope test

The following are required because they directly protect the business rule:

- complete revision plus authorization binding transport;
- canonical empty as a normal, manifest-free runtime selection;
- ordinary fallback before engine lookup or spawn;
- revocation fencing and ambient/global exclusion;
- one decision-grade activation event;
- automated and real-desktop proof for empty, valid, and broken Skills input.

The following are implementation guardrails, not additional business promises:

- one outer-budget preparation opportunity and no nested retry loop;
- background reconciliation after an empty or stale decision;
- exact candidate lifecycle telemetry;
- owner-level tests for deterministic authorization details.

If a guardrail can be simplified while preserving availability, authorization,
and diagnostic evidence, prefer the simpler implementation. Do not delay this
repair for a new Skills platform, projection system, persisted LKG model, or
watcher redesign.

## Completion rule

Keep `status: proposed` and `done: false` until automated business coverage,
server binary verification, and real desktop evidence pass.

Then set `status: completed` and `done: true`, update durable runtime/server-app
documentation, and perform a separate retrospective audit of:

- the final diff and owner boundaries;
- dropped or duplicated retries;
- authorization and ambient-discovery safety;
- focused tests, `pnpm check`, and real Tauri traces;
- whether every acceptance criterion is backed by evidence rather than plan
  wording.

Only after that retrospective passes may the implementation goal be marked
complete.
