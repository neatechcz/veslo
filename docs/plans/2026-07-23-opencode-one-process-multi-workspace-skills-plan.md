---
title: One OpenCode Process, Multiple Workspace Skill Contexts
status: proposed
done: false
scope: OpenWork-compatible directory-scoped OpenCode runtime, workspace skills, and Veslo documentation alignment
---

# One OpenCode Process, Multiple Workspace Skill Contexts

## Executive decision

OpenWork's relevant runtime model is:

```text
one OS process: opencode serve
  -> directory instance A -> workspace A skills, tools, filesystem, sessions
  -> directory instance B -> workspace B skills, tools, filesystem, sessions
```

The directory instance is not another OS process. It is OpenCode's cached
per-directory runtime context. The bundled implementation keys the instance
store and skill state by canonical directory, while process-global control-plane
and session bookkeeping still exist. The gates below must prove the required
service and event isolation instead of inferring it from directory routing
alone.

Veslo should support this model only when the bundled OpenCode binary proves
all of the following:

1. two concurrent workspace directories can use distinct effective skill views
   in one process;
2. a skill with the same name in workspace A and B never crosses the directory
   boundary;
3. Veslo's managed/policy skill filtering prevents raw or ambient skills from
   entering the effective view;
4. a published skill update becomes visible through a per-directory reload or
   disposal without restarting or invalidating an unrelated workspace.

The current bundled OpenCode 1.17.13 evidence provides partial static evidence
for the first three properties under a hardened relative-overlay fixture. It
does not yet prove same-name/different-content skills, the full Veslo managed
policy contract, normal-launch raw-skill closure, or prompt execution across
two workspace directories. The current integration script also does not test
explicit per-directory disposal. A separate runtime observation indicates
that `POST /instance/dispose?directory=A` can refresh A while preserving the
process PID and B, but that observation must be made reproducible in the
bundled-binary gate before it is treated as a capability.

Until all capability gates pass, `pooled-per-workspace` remains the
production-safe topology:

```text
workspace A -> one OpenCode process generation -> many sessions/runs
workspace B -> one OpenCode process generation -> many sessions/runs
```

The existing `2026-07-21-shared-skill-view-self-deadlock-and-projection-migration-plan.md`
contains the detailed implementation gate and fallback mechanics. This plan
consolidates that decision against the current documentation and makes the
process/instance/skill contract the canonical comparison point.

## Why this plan exists

The current documentation describes both of these truths:

- OpenCode can route multiple workspaces through one shared process using the
  request `directory` and `x-opencode-directory` boundary.
- Veslo currently stages one effective skill projection for the shared
  unsandboxed process, so changing from workspace A to B changes a process-wide
  skill view.

Those statements are compatible only if the shared process uses a static
relative skill path resolved by OpenCode's directory instance. An absolute
shared staging path reintroduces a global skill view and defeats the upstream
directory boundary.

The plan therefore separates three independent questions:

1. How many OpenCode OS processes are running?
2. Which OpenCode directory instance owns a request/session?
3. Which skills are allowed to be visible in that directory instance?

No conversation or run may be used as a substitute for any of these scopes.

## Terminology and identity contract

| Concept                  | Lifetime                          | Meaning                                                                            | Must not mean                      |
| ------------------------ | --------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| OpenCode process         | process generation                | One `opencode serve` child, PID, port, start time, and `engineOwnerId`             | One conversation or one skill view |
| Directory instance       | OpenCode location lifetime        | Runtime context keyed by canonical engine-side `directory`                         | A second OS process                |
| Workspace                | Veslo registry lifetime           | Product ownership and authorization boundary                                       | The selected UI tab only           |
| Workspace root           | Workspace registry lifetime       | Canonical authorized host path before sandbox/WSL mapping                          | The engine-side directory key      |
| Directory                | Request/session lifetime          | Validated engine-side project root or nested path inside workspace                 | A mutable global engine cwd        |
| OpenCode session         | Conversation lifetime             | Upstream session pinned to its creation directory                                  | A retargetable conversation        |
| Run                      | One accepted execution            | Server lifecycle and abort identity                                                | Engine or session identity         |
| Effective skill revision | Published-view lifetime           | Server-authoritative allowed skill set for one workspace/directory                 | A process-wide setting             |
| Directory instance epoch | One directory-instance generation | Monotonic freshness fence incremented after a successful directory disposal/reload | A process generation or run owner  |

The ownership relationship is one-to-many in shared mode and normally
one-to-one in pooled mode:

```text
engineOwnerId (one process generation)
  ├── directoryInstanceKey A + epoch A2
  │     └── workspace A -> opencodeSessionId -> conversationId / runId
  └── directoryInstanceKey B + epoch B1
        └── workspace B -> opencodeSessionId -> conversationId / runId
```

`engineOwnerId` is only the process-generation fence. It is not a
directory-instance ID and must not be used as a one-to-one skill owner in the
directory-scoped target. `directoryInstanceKey` is the canonical normalized
engine-side directory used for skill, filesystem, session, and event routing.
It must be derived from the authorized canonical host `workspaceRoot` through
the same direct/WSL/sandbox path mapping used by the actual OpenCode request.
Windows case, UNC/extended paths, symlinks/junctions, and WSL mappings must not
create two keys for one authorized workspace or one key for two workspaces.
`directoryInstanceEpoch` separates the cached state before and after a
directory-scoped disposal even when the process PID and `engineOwnerId` remain
unchanged. It is a freshness/trace fence, not a replacement for process
ownership.

The request directory must be validated from the Veslo workspace binding. A
caller-supplied directory or a currently selected UI workspace must not retarget
an existing OpenCode session.

## Runtime topology comparison

| Scenario               | OpenWork-compatible target                     | Veslo pooled fallback          | Current Veslo shared mode                      |
| ---------------------- | ---------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| One workspace          | one process, one directory instance            | one process, one engine slot   | one process, one shared skill view             |
| Workspace A + B        | one process, two directory instances           | two processes, two skill views | one process, one switchable skill view         |
| Sessions inside A      | share A's directory instance and skill context | share A's engine generation    | share current global view                      |
| Same skill name in A/B | isolated by directory instance                 | isolated by process/generation | unsafe when views differ                       |
| Skill update in A      | per-directory reload/dispose required          | restart/rebuild A generation   | process-wide view switch/restart               |
| Active A + new B run   | allowed if directory isolation passes          | allowed                        | rejected or incorrectly requires a view switch |

The target is not “one engine per conversation”. The target is either:

```text
one process + many directory instances + many sessions/runs
```

or, while the compatibility gate is not met:

```text
one workspace slot + one process generation + many sessions/runs
```

### Workspace root versus nested request directory

Veslo distinguishes the registered `workspaceRoot` from a request's nested
`directory`. OpenCode 1.17.13 uses the request directory/header to select the
directory instance, and relative `skills.paths` entries are resolved from that
instance directory. Therefore a nested request such as
`workspace/packages/foo` cannot be assumed to use a runtime root relative to
the registered workspace root.

The initial shared capability contract is intentionally KISS:

1. `directoryInstanceKey` for skill/config identity is the canonical engine-side
   mapping of the registered workspace root;
2. a nested working directory may be used only if the OpenCode request/session
   contract preserves the root instance while keeping the nested cwd behavior;
3. the compatibility gate must test a nested request explicitly;
4. if OpenCode would create a nested skill instance or resolve the relative
   runtime root under `packages/foo`, that request is not eligible for the
   shared shard and must use the pooled workspace process, or be normalized to
   the workspace root only when session and tool semantics remain correct.

The implementation must never silently retarget an existing session merely to
make a relative skill path resolve.

### Process-level launch policy and shared eligibility

OpenCode launch flags and environment are process-level. They cannot be enabled
for workspace A and disabled for workspace B inside the same process. A shared
process therefore may contain only workspaces with the same launch-policy
profile:

```text
shared shard
  -> trusted/unsandboxed workspaces
  -> same native project-scan policy
  -> same external skill policy
  -> same config/plugin compatibility
  -> directory-specific effective skill views

incompatible workspace
  -> pooled-per-workspace process
```

`ensureDirectorySkillView(workspaceRoot, revision)` is not sufficient by itself
to solve process-level policy differences. Placement into a compatible shared
shard must happen before engine admission. A workspace with a policy conflict,
sandbox requirement, unsupported source root, or incompatible project config
must fail over to its own pooled process rather than changing shared process
flags per request.

## Skill source contract

Veslo must keep the source categories explicit:

| Source                             | Native OpenCode visibility                                                                                                            | Required handling                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Workspace-local `.opencode/skills` | Yes, for that directory instance                                                                                                      | Preserve directory-scoped discovery and policy filtering                                          |
| Workspace-local `.claude/skills`   | Native external discovery is disabled by Veslo's current `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`; selected entries can still be staged   | Either include it only through the sanitized manifest or explicitly restore/test native discovery |
| Workspace-local `.agents/skills`   | Upstream supports it, but Veslo's current runtime staging intentionally excludes it and the external flag suppresses native discovery | Explicitly support and stage it, or explicitly exclude it from the runtime contract               |
| Veslo managed/registry skill       | Yes only after approved materialization                                                                                               | Publish a workspace-local sanitized runtime view with revision                                    |
| User-global skill                  | Only when policy explicitly allows it                                                                                                 | Never treat catalog visibility as engine permission                                               |
| Remote/cloud capability            | No native `/skill` visibility                                                                                                         | Execute through the remote capability contract                                                    |
| Suppressed/conflicting skill       | No                                                                                                                                    | Fail closed; never let filesystem order choose the winner                                         |

The server-owned skill catalog and the OpenCode-native skill catalog are not
the same object:

```text
registry/filesystem sources
  -> Veslo discovery and policy resolution
  -> effectiveSkillRevision
  -> engine-visible workspace-local view
  -> OpenCode directory instance
```

The UI may show inventory metadata that is not currently engine-visible. A
prompt may use only the server-published revision attached to its workspace.

### Blocking policy-closure decision

The one-process target must choose exactly one of these contracts before Phase
3A:

1. **Native project discovery contract:** `.opencode/skills`, `.claude/skills`,
   and `.agents/skills` are valid runtime sources. Veslo's effective resolver
   must include every source OpenCode can discover, with explicit precedence
   and duplicate handling.
2. **Sanitized effective-view contract:** native project discovery is disabled
   for the engine, and every allowed local, managed, and policy skill is copied
   into the workspace-local sanitized root. A skill omitted from the manifest
   must not be visible through another native root.

The current integration test uses `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so it
only exercises the second contract's hardened fixture. It is not evidence that
the normal Veslo launch is closed against raw project skills. In OpenCode
1.17.13, `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` suppresses the native external
`.claude` and `.agents` project/global roots; it does not by itself suppress
native `.opencode/skills` discovery or the configured `skills.paths` overlay.
Selected `.claude` content can therefore remain engine-visible through Veslo
staging even while native `.claude` discovery is disabled. The exact launch
contract must be tested, not inferred from the variable name. Phase 2B remains
the default until this decision and its normal-launch test pass.

## Current Veslo baseline

The following current behavior is retained as evidence and fallback:

- `pooled-per-workspace` owns at most one OpenCode process generation per
  workspace slot and supports many conversations in that workspace;
- `shared-unsandboxed` owns one process for multiple workspaces but currently
  uses a process-wide absolute skill projection;
- `ensureSharedSkillView()` therefore serializes workspace view changes and
  rejects a conflicting change while an active run is attached;
- the run owner must remain pending until shared fallback view selection has
  succeeded, otherwise the target run can block its own view switch;
- server skill materialization already provides managed markers, revisions,
  conflict detection, backups, and workspace-scoped invalidation;
- the existing integration gate is
  `packages/orchestrator/scripts/opencode-directory-scoped-skills.integration.mjs`.

The existing `2026-07-22-one-workspace-one-engine-many-conversations-plan.md`
remains valid as the fail-closed fallback and lifecycle plan. Its statement
that one process must not serve multiple workspaces is a current topology
decision, not a permanent rejection of OpenCode directory-scoped instances.

## Phase 0 — Documentation and evidence alignment

Before changing runtime topology, align the canonical docs with the following
facts:

1. `opencode-workspace-runtime-architecture.md` must distinguish process,
   directory instance, session, and run. Its current statement that one shared
   process may serve simultaneous workspace directories must be labeled as a
   capability-gated target, not current production skill-view support.
2. `skill-registry-and-distribution.md` must state that materialization is a
   workspace-local effective view, not a process-global skill registry.
3. `engineering-quality-gates.md` and `testing-playbook.md` must identify the
   directory-scoped integration gate as a bundled-binary compatibility test.
4. The 2026-07-21 shared-view plan and this plan must agree on the Phase 0
   result and the fallback topology.
5. The 2026-07-22 plan must not be marked as evidence that OpenCode cannot
   host multiple directory instances; it only defines the currently safe Veslo
   production mode.
6. The 2026-07-21 plan's statement that no per-directory disposal contract was
   found must remain historical until the explicit disposal sequence is added
   to the bundled integration artifact. A manual observation alone must not
   silently change the gate result.

No documentation may claim that shared mode supports parallel workspace skills
until the freshness and Tauri acceptance gates below pass.

## Phase 1 — Keep the fallback correct

This phase is required regardless of whether directory-scoped mode eventually
passes.

1. Keep pooled-per-workspace as the default safe topology.
2. Keep one engine slot and one process generation per workspace.
3. Keep `engineOwnerId` as the process-generation fence, not the workspace ID.
4. Keep `effectiveSkillRevision` server-owned and fail closed on stale or
   unavailable views.
5. Keep the shared fallback's pending-owner admission ordering.
6. Return structured `409` responses for a real conflicting shared-view run.
7. Never mutate one absolute shared `skills.paths` directory in place while a
   run is active.

This phase must preserve parallel sessions inside one workspace and parallel
workspace runs through separate pooled engines.

## Phase 2 — Three correctness gates plus one scaling characterization

Run every gate against the exact bundled OpenCode binary, not an arbitrary PATH
installation. Use two isolated Git workspaces and a deterministic provider.
Each workspace must contain the same skill names with different marker content:

```text
workspace A:
  same-name -> marker A
  managed-same-name -> managed marker A

workspace B:
  same-name -> marker B
  managed-same-name -> managed marker B
```

The gates are independent. Passing A does not imply passing B or C. The
one-process capability is enabled only when all three pass.

Every result is bound to a capability fingerprint containing the bundled
binary path and SHA-256, reported OpenCode version, platform/architecture,
launch-policy profile, and gate-schema version. A result from a different
binary or profile is evidence only; it must not enable the capability.

### Gate A — Directory isolation and execution

This gate answers whether one process can safely host multiple directory
instances.

1. Start one bundled OpenCode process and record its PID.
2. Create sessions pinned to A and B.
3. List skills for A and B and verify same-name content/locations are distinct.
4. Run actual prompts for A and B concurrently through a deterministic
   provider; `/skill` listing alone is insufficient.
5. Verify the provider receives the correct workspace marker for each prompt.
6. Verify an A session supplied with directory B remains pinned to A or is
   explicitly rejected; it must never be retargeted to B.
7. Keep an active run in both A and B and verify event, abort, and transcript
   routing remains directory/session scoped. For every event type used by
   Veslo lifecycle handling, prove that it either carries an authoritative
   directory or resolves through an immutable session-to-directory binding.
   An event with neither identity must fail closed instead of using the
   foreground workspace.
8. Restart the same process state and verify session IDs remain bound to their
   original directories.
9. Repeat A with a nested request directory such as `workspace/packages/foo`
   and record whether OpenCode preserves the workspace-root skill instance or
   creates a nested one. The result determines shared eligibility for nested
   requests.

Gate A proves routing and isolation, not Veslo policy closure or freshness.

### Gate B — Veslo policy closure

This gate answers whether OpenCode can see only the skills Veslo intends to
expose. Each compatible profile must run A and B concurrently in one process in
both environments:

1. **Normal Veslo launch environment:** the exact environment produced by
   `buildEngineSkillIsolationEnv`, `buildEngineSkillViewEnv`, and the current
   conflict policy.
2. **Hardened conflict environment:** the environment with
   `OPENCODE_DISABLE_PROJECT_CONFIG=1` used when a conflict requires fail-closed
   native project discovery.

It must also run a negative placement case where A requires the normal profile
and B requires the hardened profile. They must never enter the same process:
B is routed to a different compatible shard or to pooled-per-workspace before
engine admission. Gate B does not permit per-request mutation of process env.

Required cases:

1. a raw project skill omitted from the published manifest is absent in both
   environments, or the contract explicitly declares it allowed and includes
   it in the manifest;
2. global `.config/opencode`, `.claude`, `.agents`, and `.agent` skills are
   absent unless the selected source contract explicitly allows them;
3. workspace `.opencode/skills`, `.claude/skills`, and `.agents/skills` follow
   the explicit source decision above;
4. managed/policy collisions are suppressed before OpenCode discovery;
5. the same managed skill name with different A/B content resolves to the
   correct workspace revision;
6. a duplicate locked policy artifact blocks publication and never relies on
   OpenCode filesystem order;
7. remote/cloud skills do not appear in native `/skill` inventory;
8. the published effective manifest, `/skill` inventory, and actual prompt
   execution agree.

If normal launch exposes an omitted raw skill, Gate B fails. This is a hard
blocker for a sanitized effective-view contract, not a warning.

### Gate C — Per-directory disposal and freshness

This gate answers whether a skill update can refresh one directory instance
without disturbing another. It must use the explicit endpoint, not only repeat
`GET /skill`:

Positive scoped-disposal case:

1. A has a session but no active run; B has an active provider stream.
2. A and B have the same skill name with different markers.
3. Close A admission with an explicit directory reload state
   (`ready -> draining -> reloading`) before publishing a new effective skill
   revision only for A. A new run racing with the reload must remain pending or
   receive a structured retryable response; it must not enter the old epoch.
4. Confirm A is stale before disposal and B still serves its old revision.
5. Call `POST /instance/dispose?directory=A`.
6. Confirm the OpenCode PID is unchanged.
7. Confirm A creates/loads a new directory instance, exposes the new skill
   revision/content, increments `directoryInstanceEpoch`, and returns to
   `ready` admission.
8. Confirm B's instance, epoch, skill revision, session, and active run are
   unchanged.
9. Confirm B's provider stream continues while A is disposed/reloaded.
10. Reuse the existing A session and confirm it remains bound to A and observes
    the new revision. If transparent reuse is unsupported, Gate C fails for the
    hot-update target rather than silently replacing or retargeting the
    session.
11. Confirm a session created in A cannot be used to access B after disposal.
12. Repeat the sequence with A and B reversed.

Negative active-run case:

1. A has an active run and B has an independent active run/stream.
2. Publish an A-only skill revision.
3. Request disposal/reload for A.
4. Verify disposal is deferred or rejected with a structured retryable state;
   it must not kill or silently rebind the active A run.
5. Verify B continues unchanged.
6. After A becomes idle, perform the positive scoped-disposal case and verify
   the new epoch/revision.

The gate passes only if this is repeatable against the bundled binary and
records the endpoint, PID, directory, old revision, and new revision. A fresh
`GET /skill` without disposal is explicitly not sufficient.

### Gate D — Scaling characterization

Gate D is initially an operational characterization, not a correctness gate.
Measure 2, 5, and 10 workspaces with both the target shared process and the
pooled fallback:

- OpenCode process/PID count;
- directory-instance count and cache eviction behavior;
- first-request/startup latency per workspace;
- steady-state memory and CPU;
- idle suspension and LRU behavior;
- A-only disposal while B has an active run;
- event stream and provider overlap under concurrent work.

Directory-instance count and eviction must be measured through explicit
instance-created/disposed evidence or equivalent debug instrumentation, not
inferred only from successful requests.

Promote a numeric limit to a blocking acceptance criterion only after the
product chooses explicit RAM, latency, and concurrency budgets.

## Phase 3A — Target implementation if Gates A, B, and C pass

Only after the three correctness gates pass:

1. materialize the sanitized runtime root inside each workspace;
2. configure one static relative `skills.paths` entry;
3. stop selecting a process-wide skill-view owner for normal requests;
4. keep process ownership only for health, crash cleanup, capacity, and run
   attribution;
5. route every request and event by canonical engine-side directory with an
   immutable session-binding fallback for events that omit directory;
6. invalidate or dispose only the changed directory instance using the tested
   `POST /instance/dispose?directory=<canonical-directory>` contract;
7. keep the old pooled/fallback path behind an explicit capability gate;
8. record process PID plus `engineOwnerId`, canonical host workspace root,
   engine-side directory instance key/epoch, workspace ID, shard ID, and skill
   revision in traces;
9. preserve the selected Gate B source contract in the launch environment and
   never silently re-enable native project discovery.

The normal shared path must never mutate process environment or absolute
`skills.paths` per HTTP request.

## Phase 3B — Fallback if any correctness gate fails

If Gate A, B, or C fails:

1. retain pooled-per-workspace as the default and supported parallel topology;
2. retain shared-unsandboxed only as an explicit compatibility/diagnostic mode;
3. keep one process-wide skill view in that fallback, but label it honestly;
4. reject conflicting active A/B view use with typed `409` rather than hiding
   it behind a generic `502`;
5. never claim that one shared process supports independent hot-updated
   workspace skills;
6. revisit the failed gate only after an OpenCode upgrade, a source-policy
   change, or a new reload contract.

## Phase 3C — Capability-gated hybrid and future shared shards

The first shared rollout must not force every workspace into one global
process. Use placement policy:

```text
trusted + unsandboxed + policy-compatible workspace
  -> eligible shared directory-scoped shard

conflicting policy, sandbox, source roots, or config
  -> pooled-per-workspace process
```

For an eligible shared shard:

1. select the shard before engine admission using its immutable launch-policy
   profile;
2. use one static relative `skills.paths` contract;
3. replace process-wide `ensureSharedSkillView()` ownership with
   `ensureDirectorySkillView(workspaceRoot, revision)`;
4. close admission for the affected directory, publish the workspace view
   atomically, wait for its active runs to reach the allowed reload state,
   dispose only that directory instance, increment its epoch, and reopen
   admission; unrelated directories remain ready throughout;
5. keep `engineOwnerId` for process health, crash recovery, and run attribution,
   not for skill-view ownership;
6. route incompatible workspaces to pooled engines without changing the
   shared shard's launch environment.

Shard sizing is a later operational decision driven by Gate D. Do not make a
single process responsible for an unbounded number of workspaces: a process
crash must not unnecessarily terminate every active workspace run.

## Phase 4 — Server, app, and event contracts

The runtime implementation must expose enough state to distinguish the modes:

```text
engineTopology: pooled-per-workspace | shared-directory-scoped | shared-fallback
engineShardId: immutable launch-policy-compatible shared process group, when applicable
engineLaunchPolicyProfile: immutable sandbox/config/skill-discovery compatibility key
engineOwnerId: process generation
workspaceRoot: canonical authorized host path
directoryInstanceKey: canonical engine-side directory used by OpenCode
directoryInstanceEpoch: freshness generation after scoped disposal
workspaceId: Veslo workspace
skillViewRevision: server-published effective revision
```

Event routing must follow:

```text
one process event stream
  -> authoritative event.directory, otherwise immutable session binding
  -> workspace/directory channel
  -> opencodeSessionId
  -> conversationId/runId
```

An event that has neither a validated directory nor a known immutable session
binding is quarantined/reconciled as an identity error. No foreground-selected
workspace fallback is allowed for background events, session refresh, skill
inventory, abort, or lifecycle terminalization.

## Acceptance matrix

| Case                                  | Expected result                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A alone                               | Correct A skills and one active A engine/context                                                   |
| B alone after A                       | Correct B skills; no A skill leakage                                                               |
| A + B concurrent                      | One process only in directory-scoped mode, two processes in pooled fallback                        |
| Same skill name A/B                   | Correct marker for each directory                                                                  |
| Parallel A1/A2                        | Both use A view and remain independently abortable                                                 |
| Parallel A/B                          | Actual prompt execution overlaps; no process-wide skill switch in target mode                      |
| Nested request directory              | Root instance/skill behavior is explicit; incompatible nested requests use pooled fallback         |
| Raw omitted skill, normal launch      | Absent under the selected policy contract; otherwise Gate B fails                                  |
| Raw omitted skill, hardened launch    | Absent                                                                                             |
| `.agents/skills`                      | Explicitly supported and staged, or explicitly excluded and proven absent                          |
| Managed collision A/B                 | Correct managed marker and revision in each directory                                              |
| Update A while B runs                 | `POST /instance/dispose?directory=A` refreshes A only; PID and B stay unchanged                    |
| Update A while A runs                 | Disposal is deferred/rejected; active A run is not killed or rebound                               |
| New A run races with A reload         | Pending/retryable until the new A epoch is ready; never enters the old epoch                       |
| A disposal after idle                 | A epoch increments; B epoch and revision do not change                                             |
| Existing A session after disposal     | Remains bound to A and observes the new revision                                                   |
| Event without directory               | Routes only through an immutable session binding; otherwise fails closed                           |
| Normal-profile A + hardened-profile B | Never share one process; placement selects another shard or pooled engine                          |
| Global skill                          | Visible only when policy allows it                                                                 |
| Suppressed/raw skill                  | Not engine-visible                                                                                 |
| Engine crash                          | New `engineOwnerId`; old runs reconcile as lost; sessions remain directory-bound                   |
| App restart                           | Workspace, directory, session, run, and revision bindings recover without cross-workspace adoption |

Scaling characterization must additionally record the process/PID count,
directory-instance count, startup latency, memory, idle suspension, and
concurrent A-disposal/B-run behavior for 2, 5, and 10 workspaces. These values
are evidence for topology selection until product budgets are defined.

## Required verification

Before changing the canonical topology:

- run `node packages/orchestrator/scripts/opencode-directory-scoped-skills.integration.mjs`;
- run the expanded bundled skill gate in normal and hardened launch modes;
- run `node packages/orchestrator/scripts/opencode-workspace-concurrency.integration.mjs`;
- run the one-workspace/many-conversations integration scenario;
- run focused server, orchestrator, and app tests;
- run `pnpm check` for source changes;
- execute the real Tauri matrix for A/B sequential and concurrent work;
- capture PID, directory, session ID, engine owner, revision, and reload reason
  in the runtime trace;
- record the bundled binary hash, version, platform/architecture, launch-policy
  profile, and gate-schema version;
- verify direct Windows paths plus any supported UNC, symlink/junction, and WSL
  mapping cases cannot alias directory-instance ownership;
- verify `git diff --check`.

## Definition of done

This plan is complete only when one of these two outcomes is documented:

### Directory-scoped shared mode accepted

- one OpenCode process serves A and B;
- Gate A proves actual prompt/session/run isolation, including same-name skills;
- Gate B proves the selected Veslo source/policy closure in normal and hardened
  launch environments and rejects mixed-profile same-process placement;
- Gate C proves `POST /instance/dispose?directory=A` refreshes A without
  changing the PID or interrupting B;
- no process-wide skill-view switch occurs for normal requests;
- shared placement is restricted to one immutable launch-policy-compatible
  shard; incompatible workspaces use pooled engines;
- nested-directory behavior is explicit and does not silently retarget a
  session;
- the process/instance/session/run trace schema records the 1:N owner relation
  plus directory epoch;
- the accepted runtime binary and launch profile match the recorded capability
  fingerprint;
- scaling characterization exists for 2, 5, and 10 workspaces;
- Tauri acceptance passes;
- canonical docs describe the process/instance/session/run model.

### Fail-closed pooled mode retained

- pooled-per-workspace is explicitly documented as the supported topology;
- shared mode is clearly labeled compatibility/diagnostic fallback;
- conflicting shared skill views produce structured errors;
- the selected `.opencode`/`.claude`/`.agents` source contract is explicit;
- no documentation promises OpenWork-like parallel multi-workspace skill
  behavior;
- the next re-evaluation trigger is an OpenCode upgrade or reload contract.

## References

- `docs/dev/opencode-workspace-runtime-architecture.md`
- `docs/features/skill-registry-and-distribution.md`
- `docs/dev/engineering-quality-gates.md`
- `docs/dev/testing-playbook.md`
- `docs/plans/2026-07-21-shared-skill-view-self-deadlock-and-projection-migration-plan.md`
- `docs/plans/2026-07-21-skill-runtime-view-cold-start-implementation-plan.md`
- `docs/plans/2026-07-22-one-workspace-one-engine-many-conversations-plan.md`
- `packages/orchestrator/scripts/opencode-directory-scoped-skills.integration.mjs`
- `packages/orchestrator/scripts/opencode-workspace-concurrency.integration.mjs`
- [OpenCode 1.17.13 skill loader](https://github.com/anomalyco/opencode/blob/v1.17.13/packages/opencode/src/skill/index.ts)
- [OpenCode 1.17.13 directory routing](https://github.com/anomalyco/opencode/blob/v1.17.13/packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts)
- [OpenCode 1.17.13 instance disposal](https://github.com/anomalyco/opencode/blob/v1.17.13/packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts)
- [OpenCode 1.17.13 InstanceStore](https://github.com/anomalyco/opencode/blob/v1.17.13/packages/opencode/src/project/instance-store.ts)
- [OpenCode skill discovery](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/skill/index.ts)
- [OpenCode skills documentation](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/skills.mdx)
