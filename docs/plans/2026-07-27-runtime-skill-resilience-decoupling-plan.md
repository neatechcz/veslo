---
title: Direct Skill Sources and Runtime Resilience Plan
status: proposed
done: false
date: 2026-07-27
issue: unlinked
regression_anchor: ba0d764438637b6d25aeb1c7793f3e9b2bdafca0
target_topology: pooled-per-workspace direct-host runtime
sandbox_scope: deferred
---

# Direct Skill Sources and Runtime Resilience Plan

## Goal

Keep the post-`ba0d7644` Skills policy model while restoring the runtime
resilience that existed before Skills materialization became part of engine
startup.

The target model is deliberately simple:

```text
authorized workspace skill directories ─┐
                                        ├─ explicit skills.paths
authorized managed package directories ─┘
                         ↓
             workspace OpenCode instance
                         ↓
       watcher marks stale; idle boundary reloads
```

Workspace-local skills are read directly from their real workspace directories.
They are not recursively copied into AppData and are not linked through a
second projection tree. Managed skills are downloaded or extracted only when
their policy/package revision actually changes, then OpenCode reads those
immutable package directories directly.

The runtime may be healthy while Skills are stale. Ordinary conversation work
must not wait for a fresh Skills snapshot.

## Scope

In scope:

- the default `pooled-per-workspace` direct-host desktop runtime;
- Veslo-owned Skills policy and effective-manifest resolution;
- direct, explicit OpenCode `skills.paths` entries;
- managed/registry package storage and authorization;
- per-workspace change detection and idle reload;
- crash recovery, revocation, convergence, observability, and migration;
- real Tauri verification on Windows.

Out of scope:

- sandbox, WSL, mount, or cross-boundary filesystem compatibility;
- a general symlink/junction projection system;
- enabling ambient/global OpenCode discovery;
- changing permissions or tool-execution sandboxing;
- making an already loaded agent context mutate mid-run.

Sandbox support is deferred. This plan must not infer sandbox compatibility from
direct-host results.

## Evidence and correction to the previous plan

The earlier version correctly identified the resilience failure but chose a
linked projection as the primary replacement for copied generations. The
OpenWork comparison changes that decision.

OpenWork's useful pattern is:

- OpenCode runs with the real workspace as its working directory;
- workspace skills remain in workspace directories;
- runtime configuration/state is kept separately;
- filesystem changes produce a reload request;
- reload is delayed until active work is idle;
- there is no recursive copy on ordinary engine start.

The comparison is directional evidence, not a contract to copy verbatim:

- OpenWork's automatic idle gate is client-coordinated; Veslo needs a
  server/lifecycle-owned admission and reload fence;
- OpenWork fingerprints only `SKILL.md` in its primary watched root; Veslo must
  notice nested scripts, assets, references, creates, renames, and deletes;
- OpenWork's global catalog roots and runtime isolation differ from Veslo's;
- OpenWork does not preserve Veslo's server-owned effective-manifest policy.

Current OpenCode documentation says `skills.paths` recursively scans explicitly
configured directories for `SKILL.md`. The implementation must still prove this
against Veslo's bundled OpenCode version, including the case where a path is one
selected skill directory rather than a parent containing every sibling skill.
That capability gate is required before removing the copied view.

## Executive decision

Replace per-start copied generations with an explicit direct-source serving
set.

```text
desired policy
    ↓ resolve and validate
candidate runtime view (path identities, not copied files)
    ↓ compare-and-swap at safe boundary
serving runtime view
    ↓ sanitized OpenCode config / skills.paths
engine runtime-skill binding
```

There are three source modes:

```ts
type SkillSourceMode =
  | "workspace-direct"
  | "managed-immutable"
  | "empty";
```

There is no universal linked projection. A future compatibility adapter may use
links or mounts only if a runtime cannot read an authorized source directly.
That adapter is not part of this plan.

## Discovery and isolation contract

### OpenCode launch

Every workspace engine:

- runs with `cwd` set to the real workspace;
- uses a separate, Veslo-owned per-workspace OpenCode config/state directory;
- keeps native project configuration disabled;
- keeps external/global Skills discovery disabled;
- receives only a Veslo-generated sanitized configuration;
- receives explicit `skills.paths` for the selected direct source directories;
- never inherits user/global `skills.paths`, skill URLs, or ambient skill roots.

Using the real workspace as `cwd` does not mean trusting its raw `opencode.json`.
Workspace access and configuration authority remain separate concerns.

### Workspace-direct sources

Veslo keeps the existing workspace source contract:

- `<workspace>/.opencode/skills`;
- `<workspace>/.claude/skills`;
- `<workspace>/.agents/skills`;
- `<workspace>/.agent/skills`.

This deliberately differs from OpenWork. A root with the same name under a
user home/global directory remains catalog/import-only and is never activated
implicitly.

The server effective manifest selects concrete skill directories, not whole
unfiltered roots. The generated `skills.paths` should contain the selected
skill directories directly if the bundled OpenCode capability gate proves that
contract. This preserves disable, conflict, precedence, and authorization
semantics without copying or linking the directories.

If the bundled runtime cannot discover an individual selected directory, the
implementation must stop at the capability gate. It must not silently fall back
to exposing an entire source root or reintroducing synchronous recursive copy.

### Managed-immutable sources

Registry or managed content is allowed only after explicit materialization:

```text
managed store/
  <package-id>/
    <content-digest>/
      <skill-name>/SKILL.md
      ...
```

Rules:

- package directories are content-addressed and immutable after verification;
- download/extract happens only when the desired package digest changes;
- successful sync of the same digest is a no-op;
- the serving view points directly to selected immutable skill directories;
- partial downloads and extraction directories never enter `skills.paths`;
- cleanup cannot remove a directory referenced by a serving view or engine
  binding;
- failed refresh leaves the previously authorized immutable package available;
- an authorization revocation fences new admission immediately, even if old
  bytes still exist on disk.

This is materialization at package-change time, not runtime staging at every
start.

### Empty mode

An empty serving view is valid and runtime-ready. It is used when no skill is
authorized, after a revocation when no replacement is ready, or when no valid
source set can be reconstructed.

Empty mode has a complete launch contract; it is not only a state label:

```text
mode = empty
skills.paths = []
skillViewRevision = revision of the empty effective view
openCodeConfigDigest = digest of the sanitized config including []
project config discovery = disabled
external/global discovery = disabled
```

The server may publish an empty effective manifest as policy evidence, but the
direct launch path does not stage that manifest into another directory. It does
not call `stageEngineSkillView()` or require a copied `requireEffectiveManifest`
root. The engine and every admitted run receive an ordinary empty-mode binding
with the empty revision, directory instance epoch, and config digest.

## Path safety contract

Before admitting any direct source, Veslo must:

1. resolve the canonical real path;
2. classify it as a workspace source or verified managed source;
3. for workspace sources, prove containment under the expected authorized
   workspace root;
4. for managed sources, prove containment under the expected package digest;
5. validate the skill name and required manifest;
6. reject missing, partial, staging, temporary, or runtime-generated sources;
7. inspect nested links/junctions and reject escapes from the authorized root;
8. reject any user/global root even if it has a familiar relative suffix;
9. recursively enumerate `SKILL.md` below each selected directory and reject
   any nested entrypoint that is not itself present in the effective view;
10. record a stable source identity without logging sensitive absolute paths by
   default.

This is a discovery-policy boundary, not a filesystem sandbox.

## State and identity model

Do not create a parallel revision platform. Reuse the existing contracts and
add only the missing authorization/config binding.

| Existing contract | Target meaning |
| --- | --- |
| `ActiveRuntimeSkillView.revision` | Canonical effective-view revision covering membership, disabled policy, selected source identity, and last observed content fingerprint |
| transported `skillViewRevision` | The same canonical revision; it is not a second revision |
| active-view internal `generation` | In-process validation/CAS token; it is not persisted or exposed as a public epoch |
| `directoryInstanceEpoch` | Reloaded OpenCode directory-instance generation; extend the lifecycle principle to pooled-per-workspace engines |
| `engineOwnerId` plus process identity | Existing engine process owner used for run attachment and crash reconciliation |
| managed desired/current revision | Package materialization convergence only; it is not the runtime-view revision |
| `authorizationRevision` | Minimal new persisted revision for membership/disable/revocation fences; content-only edits do not change it |
| `openCodeConfigDigest` | Derived value over the complete sanitized config, ordered `skills.paths`, and source modes; it is not independently mutable state |

The model still distinguishes desired policy, a validated candidate, the
serving view, and the exact engine binding, but it does so with one canonical
skill-view revision.

```ts
type ServingSkillSource = {
  skillName: string;
  mode: "workspace-direct" | "managed-immutable";
  sourceId: string;
  sourceRootDigest: string;
  contentRevision: string | null;
  authorizationRevision: string;
};

type ResolvedRuntimeSkillView = {
  schemaVersion: number;
  workspaceId: string;
  skillWorkspaceId: string;
  workspaceRootDigest: string;
  topology: string;
  runtimeContractVersion: string;
  openCodeLaunchProfile: string;
  skillViewRevision: string;
  authorizationRevision: string;
  mode: "direct" | "empty";
  sources: ServingSkillSource[];
  orderedSkillsPaths: string[];
  validatedAt: string;
};

type EngineSkillBinding = {
  engineOwnerId: string;
  processId: number;
  directoryInstanceEpoch: number;
  skillViewRevision: string;
  authorizationRevision: string;
  mode: "direct" | "empty";
  openCodeConfigDigest: string;
};
```

Persist path identities only as needed for local recovery. Stable IDs and
digests are the external/logging contract.

### Compare-and-swap publication

Every invalidation increments the existing internal validation generation. A
candidate captures that generation plus the expected skill and authorization
revisions. Before publication, compare-and-swap verifies:

- candidate generation still equals the current validation generation;
- expected `skillViewRevision` and `authorizationRevision` are still current;
- workspace, topology, launch profile, and policy identity still match;
- every source still satisfies path and authorization checks;
- no newer candidate or revocation fence superseded it.

A slow old validation must never overwrite a newer serving view.

## Runtime readiness and Skills freshness

These are independent state machines.

```ts
type RuntimeState =
  | "starting"
  | "ready"
  | "degraded"
  | "stopped";

type SkillsState =
  | "current"
  | "stale"
  | "refreshing"
  | "revoked"
  | "unavailable";
```

Required invariants:

- `runtime.ready` never means `skills.current`;
- a healthy engine remains usable while Skills are stale or refreshing;
- a fresh engine may start from a valid serving view or empty mode without
  synchronizing Skills first;
- content changes do not interrupt an active run;
- authorization revocation blocks new admission to the revoked set;
- ordinary sends use the serving view and do not demand the desired revision;
- explicit Skills operations may require an exact policy revision.

## Materialization convergence contract

The server materialization status must be idempotent and revision-driven:

1. successful sync of desired revision `R` records `currentRevision = R` and
   `reloadRequired = false` after the corresponding serving view is active;
2. asking again for `R` performs no download, extraction, publication, reload,
   or invalidation;
3. ordinary runtime start never calls materialization;
4. invalidation occurs only when desired policy/package revision or authorized
   source identity changes;
5. `pending` means a newer desired revision actually exists;
6. `reloadRequired` means a validated serving view differs from the engine
   binding;
7. publication and engine reload are separate states;
8. status polling is read-only and cannot create work;
9. continuous source edits are coalesced and bounded, not converted into a
   retry loop.

## Direct-source change detection

Each workspace has a recursive watcher over only its authorized workspace skill
directories. The watcher must detect changes to:

- `SKILL.md`;
- nested scripts, assets, references, and templates;
- file creation, deletion, rename, and directory replacement;
- changes to nested link/junction targets relevant to containment.

Filesystem events and server policy events feed the same invalidation owner.
Enable, disable, remove, restore, managed-package revision, authorization,
workspace identity, and effective-manifest changes must schedule reconciliation
even if no watched file changes.

Watcher events are hints. Correctness comes from revalidation and a full
fingerprint before publication/reload. Missed or overflowed watcher events set
the source stale and schedule a bounded rescan.

### Live-content contract

Because workspace source files are live, a runtime-view revision is not an
immutable byte snapshot. `EngineSkillBinding` binds authorization, ordered
paths, sanitized config, and OpenCode directory instance. It does not bind the
bytes of mutable workspace files.

The product contract is intentionally:

- editing a workspace skill never interrupts an attached run;
- Veslo does not promise that a script, asset, or skill loaded after the edit
  will see the old bytes;
- cached discovery/instructions become predictably current after the next safe
  directory reload;
- managed package sources remain byte-immutable for the lifetime of a binding;
- deterministic run-level workspace bytes would require a snapshot or
  filesystem isolation and are outside this direct-source plan.

The bundled-runtime gate must characterize when `SKILL.md`, the skill tool, and
nested resources are read before this behavior is documented as durable. The
gate records observations; it must not silently claim byte pinning that the
runtime does not provide.

## Reload and active-run boundary

The lifecycle owner, not only the UI, enforces this sequence:

```text
source/policy change observed
  -> mark Skills stale
  -> validate candidate runtime view in background
  -> if an active run exists, keep engine binding unchanged
  -> when idle, close new admission for that workspace
  -> compare-and-swap serving view
  -> dispose/reload that workspace OpenCode instance
  -> verify engine binding equals the serving view
  -> reopen admission
```

The gate covers running, compacting, waiting-for-permission, waiting-for-answer,
queued dispatch, and admission-in-progress states. Reload of one workspace must
not affect another workspace.

### Run admission tuple

Before dispatch, the run is atomically attached to:

```text
workspaceId
engineOwnerId
directoryInstanceEpoch
skillViewRevision
authorizationRevision
openCodeConfigDigest
```

If engine ownership or the serving view changes between selection and attachment,
admission retries or fails with a typed transient error. It never dispatches
under a tuple different from the one recorded.

## Freshness versus revocation

### Content stale

For an authorized source whose contents changed:

- the current engine and active run continue;
- ordinary sends may continue on the current engine binding until the safe
  reload;
- background validation/reconciliation is bounded;
- failure is visible but does not stop a healthy engine.

### Authorization revoked

For disable/removal, workspace identity change, policy change, or managed
package revocation:

- advance and persist `authorizationRevision` immediately;
- close new admission to the revoked serving view;
- do not reuse the revoked view for cold start or crash recovery;
- let an already attached run finish unless another safety policy requires
  termination;
- publish a replacement or empty serving view at the safe boundary;
- reopen admission only after the replacement engine binding is verified.

Authorization state must be persisted locally enough that temporary Skills
control-plane unavailability cannot resurrect a known-revoked source.

## Crash recovery

- A healthy engine is never killed because a source refresh failed.
- If an engine crashes with an attached run, that run terminalizes according to
  the conversation lifecycle contract; it is not silently moved to another
  skill set.
- Replacement starts from the latest locally valid, authorized serving view, or
  empty mode.
- Recovery never performs recursive workspace skill staging.
- Managed packages must pass current-contract validation before reuse.
- Legacy copied generations are not adopted as direct sources.

## Bounded reconciliation

Reconciliation is keyed by workspace and current validation generation. Initial
production defaults are explicit and testable:

- single-flight per workspace;
- debounce filesystem/policy bursts for 750 ms;
- allow at most three failed validation attempts per 30 seconds;
- back off for 1, 2, and 4 seconds with bounded jitter;
- open the circuit for 30 seconds after the budget is exhausted;
- a newer validation generation cancels/supersedes older work immediately and
  may start a new bounded budget;
- duplicate errors for the same validation generation are coalesced;
- successful quiet-period validation resets the breaker;
- runtime start and ordinary send never wait for the loop.

## Request policies

### `prefer-serving`

Default for runtime start, recovery, and ordinary conversation sends:

- reuse a healthy engine and its binding;
- otherwise start from the latest authorized serving view;
- otherwise start in empty mode;
- schedule stale work asynchronously.

### `require-policy-revision`

Used only for explicit Skills operations that promise exact activation, such as
enable/disable, install/update, or a user-requested reload. If the requested
revision is not active, return typed state without destroying a healthy engine.

## Ownership

### Server

Owns policy, validation generation, effective manifest, authorization/revocation,
materialization convergence, candidate validation requests, and the public
Skills state.

### Orchestrator

Owns sanitized OpenCode configuration, direct path validation, engine process
ownership, serving-view persistence, engine bindings, workspace-scoped reload, and
crash recovery.

### Conversation lifecycle

Owns active-run truth, the admission/reload fence, atomic run tuple attachment,
and terminalization after engine failure.

### Desktop and app

Display scoped state and request actions. They do not decide whether a workspace
is idle and do not implement correctness-critical retries.

## Failure matrix

| Failure | Runtime behavior | Skills behavior |
| --- | --- | --- |
| Workspace file changes during start | Engine starts/reuses serving or empty set | Mark stale; rescan later |
| Workspace file continuously changes | Engine remains usable | Bounded retry, then unstable |
| Selected path disappears | Existing run continues if already attached | Validate replacement/empty at idle |
| Managed download/extract fails | Existing authorized package or empty mode | Degraded, bounded retry |
| Same managed revision is requested | No runtime work | Current, no-op |
| Policy revision changes | Healthy engine stays until safe boundary | Candidate validation |
| Authorization is revoked | New admission fences immediately | Replacement/empty required |
| Old validation finishes late | Current serving view remains | Candidate discarded by CAS |
| Watcher overflows/misses events | Engine remains usable | Full bounded rescan |
| Engine crashes | Attached runs terminalize; replacement starts | Use authorized set or empty |
| Skills control plane unavailable | Conversation path uses local serving/empty set | Stale/unavailable |
| Conversation API unavailable | Send fails as an API failure | Not misreported as Skills failure |
| Ambient global skill exists | No runtime effect | Never enters explicit paths |

## Implementation phases

### RSR00 - Lock the regression and capability contract

- reproduce the post-`ba0d7644` start/refresh failures;
- record copy-related `ENOENT`, `skill_view_changed`, 409, restart, and run
  terminalization evidence;
- record the exact bundled OpenCode semantic version and binary SHA-256 in the
  gate artifact;
- use absolute Windows paths to prove root-level `SKILL.md` discovery from one
  individually selected workspace skill, multiple selected skill directories,
  and one managed immutable skill directory;
- prove nested scripts/assets remain accessible and characterize `SKILL.md`,
  skill-tool, and resource reads before/during/after an active run and dispose;
- prove a disabled sibling, an unauthorized nested `SKILL.md`, inherited paths,
  raw project config, and user-global roots are absent;
- launch two real pooled-per-workspace OpenCode processes and prove edits,
  reload, inventory, and failure in one do not affect the other;
- persist the ordered paths and sanitized config digest in the artifact;
- make this a hard dependency of RSR03. RSR01 and other independent resilience
  work may proceed, but direct-path cutover must stop if this gate fails.

### RSR01 - Fix materialization convergence

- make same-revision sync idempotent;
- make status polling read-only;
- set `reloadRequired: false` once the corresponding serving view is active;
- remove ordinary runtime start from materialization triggers;
- add counters proving repeated status/start/send do no Skills work.

### RSR02 - Reuse runtime-view identities and add direct validation

- keep `ActiveRuntimeSkillView.revision`/`skillViewRevision` canonical;
- reuse the active-view generation as the internal candidate CAS token;
- retain `directoryInstanceEpoch` as the reload-instance revision and extend
  that lifecycle contract to pooled-per-workspace engines;
- add only `authorizationRevision`, ordered paths/config digest, and the exact
  engine binding missing from current run reservations;
- add per-skill direct path validation and source classification;
- reject unauthorized nested `SKILL.md` entries before OpenCode can recursively
  discover them;
- persist locally valid authorized serving state;
- implement the explicit `skills.paths: []` empty launch contract.

### RSR03 - Switch workspace skills to direct paths

- generate sanitized config with explicit selected skill directories;
- preserve their deterministic effective-manifest order and include the exact
  ordered list plus source modes in `openCodeConfigDigest`;
- keep project and external discovery disabled;
- remove workspace recursive copy from engine start and refresh;
- retain existing four workspace source roots through the effective manifest;
- verify collisions, disable, and precedence still match server policy;
- remove/rework the synchronous app
  `syncWorkspaceSkillMaterializationBeforeRuntime` /
  `prepareWorkspaceSkillRuntimeView` activation dependency;
- remove pooled `stageEngineSkillView()` and `requireEffectiveManifest` from
  direct/empty launch;
- retire staging-specific `skill_view_changed` / `skill_view_stale` activation
  retry handling after no caller can emit those copy-race failures;
- stop boot/status polling from manufacturing `reloadRequired` work.

### RSR04 - Decouple managed package materialization

- store verified managed packages by content digest;
- materialize only on actual package revision change;
- point serving views directly to selected immutable package directories;
- fence partial state and revoked packages;
- add binding-aware cleanup.

### RSR05 - Add recursive watcher and safe idle reload

- watch all authorized nested skill content;
- route server policy invalidations into the same workspace reconciler;
- coalesce events and recover from watcher overflow;
- implement the explicit reconciliation budget and cancellation rules;
- make the lifecycle owner enforce workspace idle/admission fencing;
- adapt the existing directory lifecycle principle for actual
  pooled-per-workspace engine processes rather than assuming the experimental
  shared-directory implementation covers them;
- reload only the affected workspace engine/directory instance;
- verify the engine binding before reopening admission.

### RSR06 - Add revocation and crash recovery

- distinguish content stale from authorization revoked;
- persist the revocation fence;
- prevent revoked cold-start recovery;
- recover from authorized direct sources or empty mode;
- terminalize attached runs deterministically after engine crash.

### RSR07 - Migrate and document

- dual-read legacy state for diagnostics only;
- stop writing new copied staging generations after the direct gate is enabled;
- do not adopt legacy copied generations as trusted direct sources;
- keep an already running legacy engine until idle, then replace it;
- delete old staging data only after no engine/run lease references it;
- update durable architecture and feature docs after verification;
- retain this plan as implementation history.

### RSR08 - Make every runtime failure locally diagnosable

- add the phase/reason diagnostic contract below to existing trace owners;
- propagate one operation ID across app, server, orchestrator, engine launch,
  admission, and reconciliation;
- expose the current phase and last terminal failure in the existing workspace
  runtime debug report and support diagnostic capture;
- add deterministic failure-injection coverage for every critical phase;
- prove expected deferral/supersession is distinguishable from a real failure;
- prove diagnostics are redacted, bounded, and cannot break the runtime path.

## Migration and rollback

Migration is workspace-scoped and resumable:

1. Resolve the current effective manifest.
2. Validate selected workspace and managed source directories.
3. Build a candidate runtime view without copying workspace files.
4. Keep the current engine and legacy generation while work is active.
5. At idle, fence admission, publish the serving view, and reload.
6. Verify OpenCode inventory and engine binding before reopening admission.
7. Mark the workspace migrated.
8. Clean legacy generations only after lease verification.

Rollback disables direct serving-view publication for new reloads and reuses the
last already validated legacy engine/generation where still authorized. It must
not reintroduce materialization on every ordinary start/send, and it must never
override a revocation fence.

## Observability

Do not add a parallel logging subsystem. Extend the existing send-workflow
trace, skill audit trace, engine-spawn diagnostics, workspace runtime debug
report, and support diagnostic capture with one shared schema.

### Cross-process operation timeline

Every activation, spawn, reconcile, reload, revocation, and run admission gets a
stable `runtimeSkillOperationId`. The ID is created by the first owner and
propagated through app -> server -> orchestrator -> engine/admission calls.
Nested retries/actions also carry `parentOperationId` and an attempt number so a
later health or admission symptom cannot hide the original failure.

Each owner emits bounded `start`, `settle`, or `error` events with:

```ts
type RuntimeSkillDiagnosticEvent = {
  schema: "veslo-runtime-skills/v1";
  runtimeSkillOperationId: string;
  parentOperationId?: string;
  attempt: number;
  sequence: number;
  timestamp: string;
  durationMs?: number;
  owner: "app" | "server" | "orchestrator" | "opencode" | "lifecycle";
  phase: RuntimeSkillPhase;
  outcome: "ok" | "degraded" | "deferred" | "superseded" | "failed";
  reasonCode?: RuntimeSkillReasonCode;
  workspaceId: string;
  skillViewRevision?: string;
  authorizationRevision?: string;
  directoryInstanceEpoch?: number;
  engineOwnerId?: string;
  processId?: number;
  openCodeConfigDigest?: string;
};
```

The `start` breadcrumb is appended to the existing local diagnostic sink before
the risky operation begins. `settle`/`error` follows in `finally` or the process
exit handler. If a process dies without a terminal event, the unmatched start
event is itself the evidence. Per-owner sequence numbers establish ordering
without assuming synchronized wall clocks.

The minimum phase ladder is:

```text
app.runtime-preflight
server.materialization-status
server.effective-view-resolve
server.effective-view-publish
managed.download
managed.verify
managed.promote
orchestrator.direct-path-validate
orchestrator.config-build
orchestrator.engine-spawn
orchestrator.opencode-health
lifecycle.reload-drain
lifecycle.reload-dispose
lifecycle.reload-verify
lifecycle.run-admission-bind
watcher.event
watcher.rescan
cleanup.release
```

At any hang or crash, the last emitted phase identifies the boundary that did
not settle. A phase watchdog records `elapsedMs` and the last successful phase;
it is diagnostic only and must not kill a healthy engine unless the existing
lifecycle contract independently requires that action.

Engine exit diagnostics attach exit code/signal plus bounded, redacted stdout
and stderr tails to the spawn/health phase. If the server or orchestrator is
unreachable, the desktop/bootstrap owner still records the attempted boundary;
the aggregated report explicitly marks the missing owner instead of returning
an empty diagnostic.

### Stable reason codes

Errors must not collapse into a generic "runtime failed" message. At minimum,
classify:

- `conversation_api_unavailable`;
- `skills_control_plane_unavailable`;
- `materialization_revision_pending`;
- `effective_view_missing` / `effective_view_invalid`;
- `direct_path_missing` / `direct_path_outside_authorized_root`;
- `direct_path_nested_skill_rejected` / `direct_path_link_escape`;
- `managed_download_failed` / `managed_digest_mismatch` /
  `managed_package_partial`;
- `config_build_failed` / `config_digest_mismatch`;
- `engine_spawn_failed` / `engine_exited_before_health` /
  `opencode_health_timeout`;
- `reload_active_run_deferred` / `reload_dispose_failed` /
  `reload_verification_failed`;
- `admission_engine_owner_changed` / `admission_binding_changed`;
- `candidate_superseded` / `authorization_revoked`;
- `watcher_overflow` / `reconcile_budget_exhausted`;
- `cleanup_source_still_bound`.

Expected `deferred` and `superseded` outcomes are not logged as crashes or
user-facing failures.

### Per-workspace diagnostic snapshot

The existing workspace runtime debug report exposes a redacted snapshot:

```ts
type RuntimeSkillDiagnosticSnapshot = {
  workspaceId: string;
  runtimeState: RuntimeState;
  skillsState: SkillsState;
  currentOperationId: string | null;
  currentPhase: RuntimeSkillPhase | null;
  currentPhaseStartedAt: string | null;
  lastSuccessfulPhase: RuntimeSkillPhase | null;
  firstFailure: {
    at: string;
    operationId: string;
    owner: string;
    phase: RuntimeSkillPhase;
    reasonCode: RuntimeSkillReasonCode;
  } | null;
  lastFailure: {
    at: string;
    operationId: string;
    owner: string;
    phase: RuntimeSkillPhase;
    reasonCode: RuntimeSkillReasonCode;
    message: string;
  } | null;
  skillViewRevision: string | null;
  authorizationRevision: string | null;
  directoryInstanceEpoch: number | null;
  engineOwnerId: string | null;
  processId: number | null;
  openCodeConfigDigest: string | null;
  orderedSkillPathIds: string[];
  reconcile: {
    attempt: number;
    budgetRemaining: number;
    nextRetryAt: string | null;
    circuitOpenUntil: string | null;
  };
};
```

This snapshot is updated on transitions and preserved across a failed spawn or
reload long enough for support capture. It stores stable/redacted path IDs, not
raw absolute paths, tokens, skill contents, config bodies, or environment
values. Developer diagnostics may provide an explicit local-only path mapping;
cloud/support payloads remain redacted.

`firstFailure` is immutable for one operation chain. Later cascaded failures
update `lastFailure` but never replace the recorded root phase/reason.

### Required event context

Structured events additionally include, where relevant:

- workspace, skill-workspace, topology, runtime-contract, launch-profile, app
  build, and bundled OpenCode version/SHA identity;
- validation generation and CAS result;
- policy/effective-view/content revisions and source mode;
- ordered redacted path IDs and sanitized config digest;
- validation/containment result and rejection reason;
- managed package ID/digest and materialization outcome;
- watcher sequence, overflow/rescan marker, debounce/backoff/breaker state;
- reload fence state and classified active-run blockers;
- run admission binding before/after comparison;
- authorization fence and admission close/reopen timestamps;
- cleanup reason and referenced binding count;
- source-side, managed-store, config-build, spawn, or OpenCode-side `ENOENT`.

Repeated failures for one workspace, validation generation, phase, and reason
code are coalesced. A suppressed-count summary is emitted when the state changes
or the circuit closes.

Metrics should answer:

- Did an ordinary start/send trigger any materialization or recursive copy?
- Which ordered view and binding did the engine actually serve?
- How long was Skills stale while runtime stayed ready?
- Was reload delayed by a real active run?
- Did a stale candidate lose CAS as expected?
- Did any global or unselected sibling skill enter OpenCode inventory?
- Did a revocation admit a new run on the revoked set? Expected: no.
- What was the last successful phase, which owner failed next, and with which
  stable reason code?
- Can one support snapshot distinguish server resolution, path validation,
  config construction, process spawn, OpenCode health, reload, and admission
  failures without reproducing the issue?

## Verification plan

### Focused automated coverage

- direct-path containment and nested-link escape tests;
- effective-manifest to deterministic, ordered individual `skills.paths` tests;
- explicit empty-mode `skills.paths: []`, isolation flags, config digest, engine
  binding, and run-admission tests;
- unauthorized nested `SKILL.md` rejection tests;
- ambient/global/sibling exclusion tests;
- materialization status idempotence tests;
- validation-generation CAS and stale candidate tests;
- recursive fingerprint/watcher tests for nested assets and renames;
- filesystem and server-policy invalidation convergence tests;
- bounded reconciliation and breaker tests;
- managed package integrity and binding-aware cleanup tests;
- revocation fence and crash recovery tests;
- atomic run admission tuple race tests;
- workspace-scoped pooled-process reload isolation tests;
- bundled-runtime characterization tests for skill discovery/cache/resource
  reads during an active run;
- failure injection at every diagnostic phase, asserting operation correlation,
  terminal owner/phase/reason, last-failure snapshot, redaction, and log
  coalescing.

### Required real Tauri scenarios

Run against the pooled-per-workspace Windows direct-host desktop runtime:

1. **Edit during first send**
   - continuously edit a nested workspace skill asset;
   - start a conversation immediately;
   - prove the send completes without staging/409/restart loop;
   - prove the updated skill activates after idle reload.

2. **Active run plus skill edit**
   - keep a run active or waiting for permission;
   - change `SKILL.md` and a nested script;
   - prove the run is not interrupted and reload waits for idle.

3. **Selected skill isolation**
   - place selected and disabled sibling skills in one source root;
   - prove only selected skills enter OpenCode inventory;
   - add user-global `.claude`, `.agents`, and OpenCode skills and prove none
     appear.

4. **Managed package failure and recovery**
   - make a new package revision unavailable or corrupt;
   - prove ordinary conversation remains usable on authorized current/empty
     state;
   - restore it and prove one materialization plus one safe reload.

5. **Revocation during active run**
   - revoke a serving skill while a run is active;
   - prove the attached run is not interrupted;
   - prove new admission cannot use the revoked set;
   - prove replacement/empty mode applies after idle.

6. **Engine crash**
   - crash the engine during an attached run;
   - prove deterministic terminalization;
   - prove replacement starts without workspace staging and accepts a new run.

7. **Multi-workspace isolation**
   - run two workspaces with different selected skills;
   - edit/reload one;
   - prove the other engine, inventory, and runs are unaffected.

8. **Skills control-plane outage**
   - keep conversation API and local orchestrator available while Skills
     publication is unavailable;
   - prove ordinary send uses serving/empty state;
   - restore publication and prove bounded convergence.

The outage scenario must not claim a send succeeds when the conversation API
itself is unavailable.

Every real Tauri scenario must retain one correlated operation timeline and
assert that a deliberately induced failure or deferral is attributable to the
correct owner, last successful phase, terminal phase, and stable reason code.
This evidence is part of the scenario result, not a best-effort debugging note.

## Acceptance criteria

- Ordinary engine start and send perform zero recursive workspace skill copies.
- Workspace skills are read from validated real workspace directories.
- Managed skills materialize only when their package digest changes.
- Repeating the same materialization revision is a true no-op.
- `runtime.ready` is independent of `skills.current`.
- A missing, changing, or corrupt skill source does not stop a healthy engine.
- The hard gate passes against the exact bundled OpenCode version and SHA using
  absolute Windows per-skill paths and two real pooled processes before RSR03
  begins.
- Direct paths preserve server-selected disable, collision, and precedence
  behavior; unselected siblings do not leak into inventory.
- The effective view owns one deterministic ordered `skills.paths` list; the
  same order and source modes are covered by `openCodeConfigDigest`.
- A selected skill cannot recursively expose an unauthorized nested
  `SKILL.md`.
- Empty mode launches with explicit `skills.paths: []`, full isolation flags,
  a canonical empty revision, and an ordinary engine/run binding without
  staging.
- Raw project config, global roots, inherited `skills.paths`, and skill URLs do
  not enter the runtime.
- Nested scripts/assets trigger stale state and activate after safe reload.
- Workspace-direct bindings are explicitly path/config/authorization bindings,
  not immutable byte snapshots; bundled-runtime evidence documents what live
  content may change during an attached run.
- Active runs, permission prompts, and admissions-in-progress block reload.
- Reload and serving-view changes are scoped to one workspace.
- Every new run is attributable to one exact engine/view binding.
- Revocation blocks new use immediately and cannot be bypassed by offline crash
  recovery.
- Continuous edits cannot create an unbounded reconcile or log loop.
- Old candidates cannot overwrite newer desired state.
- Runtime diagnostics identify every failed activation/reconcile/reload by one
  operation ID, owner, last successful phase, failing phase, and stable reason
  code without requiring reproduction.
- The workspace runtime debug report retains a redacted last-failure snapshot,
  exact engine/view binding, and reconciliation budget state after a failed
  spawn or reload.
- Expected deferral and supersession are never reported as crashes, and repeated
  failures cannot create an unbounded diagnostic loop.
- All eight real Tauri scenarios pass.
- Final source handoff passes the repository quality gate.
- No sandbox compatibility claim is made.

## Non-goals

- A universal live-link or junction abstraction.
- Immutable snapshots of mutable workspace source bytes.
- Reloading an agent context in the middle of a run.
- Ambient discovery from user-global skill directories.
- Treating Skills freshness as engine health.
- Hiding conversation API outages behind Skills fallback wording.
- Supporting or testing sandbox/WSL behavior in this phase.

## Completion rule

Keep `status: proposed` and `done: false` until implementation and the real
direct-host Tauri scenarios prove both sides of the contract:

1. runtime remains usable during source churn, package failure, and Skills
   control-plane unavailability; and
2. direct sources preserve Veslo policy isolation, managed-package integrity,
   revocation safety, and exact run attribution.

Only then promote durable behavior into canonical docs and mark this plan done.
