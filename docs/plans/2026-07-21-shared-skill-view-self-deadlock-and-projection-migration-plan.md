---
title: Directory-scoped Shared Runtime and Skill Projection Migration Plan
date: 2026-07-21
status: in_progress
done: false
issue: unlinked
depends_on:
  - docs/plans/2026-07-21-skills-import-only-runtime-boundary-audit.md
  - docs/plans/2026-07-21-skill-runtime-view-cold-start-implementation-plan.md
---

# Directory-scoped Shared Runtime and Skill Projection Migration Plan

## Executive decision

Do not assume that a shared OpenCode server can have only one workspace skill
view. Current upstream OpenCode uses directory-scoped instances for request
routing, config, and skill discovery. Veslo currently defeats that behavior by
injecting one absolute, process-wide `skills.paths` staging directory into the
shared engine.

The intended target, subject to the Phase 0 compatibility gate, is:

```text
one shared OpenCode process
  ├─ workspace A request/session -> directory A -> A sanitized runtime skills
  └─ workspace B request/session -> directory B -> B sanitized runtime skills
```

The process must not receive a request-scoped mutation of its environment or
an absolute switch to another workspace's staging path. Instead, it receives
one static configuration whose skill path is relative to the current upstream
directory context. Veslo materializes an isolated effective view inside each
workspace at that relative path.

If Phase 0 proves that this cannot preserve isolation, discovery freshness, and
session behavior with the shipped OpenCode version, use the existing
dispose/restart-on-idle shared-view model as a safety fallback and use
per-workspace engines or queueing for concurrent work. Do not mix skill views
in one process by mutating a shared absolute staging root.

## Scope

In scope:

- an upstream compatibility spike for directory-scoped skill discovery;
- replacing Veslo's absolute shared skill staging overlay if the spike passes;
- safe migration of legacy policy projections from `veslo-user` to
  `veslo-registry`;
- server-owned runtime-view revision/freshness and explicit diagnostics;
- removal or containment of the current shared-view self-deadlock path;
- focused unit, integration, and manual-runtime verification.

Out of scope:

- changing import-only policy or precedence semantics;
- mutating `skills.paths` or process environment per HTTP request;
- trusting raw global skill roots;
- unrelated MCP/plugin/WSL work;
- a topology rewrite before the compatibility gate has evidence.

## Upstream evidence and boundary

Public OpenCode documentation says that project skills are discovered from the
current working directory up to the git worktree, while global locations are a
separate source. The v2 request/session model carries directory/workspace
context; a session is pinned to its context.

Current upstream source makes this operational:

- workspace middleware resolves a request to a directory/workspace context;
- `InstanceState` caches values by directory;
- skill discovery obtains `ctx.directory` and `ctx.worktree` through that
  instance state;
- `Config` is likewise instance-scoped; relative `skills.paths` entries are
  resolved from the instance directory.

This is strong implementation evidence for a multi-project server, but not a
public promise of a Veslo-specific sanitized-view API. Veslo must verify the
behavior with the exact bundled OpenCode version before making it its runtime
contract.

Relevant upstream sources:

- `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts`
- `packages/opencode/src/effect/instance-state.ts`
- `packages/opencode/src/skill/index.ts`
- `packages/opencode/src/config/config.ts`
- `packages/web/src/content/docs/skills.mdx`

## Confirmed Veslo faults

### Absolute shared staging creates an artificial one-view process

`startOpencode()` stages the selected effective manifest into a generation
under the shared config directory and injects its absolute path through:

```text
OPENCODE_CONFIG_CONTENT.skills.paths = [absolute shared generation path]
```

That value is process environment state. It cannot vary per request, so the
existing shared engine must dispose/restart whenever the selected workspace
changes. This is a Veslo overlay limitation, not evidence that native OpenCode
directory instances cannot coexist.

### The current shared-view guard self-deadlocks

The latest trace proved this sequence:

```text
server register target run
  -> run receives current shared engine owner before proxy selection
  -> proxy needs a different shared skill view
  -> activeForEngineOwner(shared-unsandboxed) sees the target run itself
  -> shared_engine_skill_view_busy / HTTP 409
```

The fixture run was already terminal; the blocker was the newly registered
target run. This must be removed even if directory-scoped mode passes, because
the legacy/recovery shared-view path must not self-block.

### Projection migration can publish a valid empty manifest

Legacy platform/organization entries in
`.opencode/skills/veslo-user/<name>` carry `.veslo-managed.json`. Current
registry projection writes the same policy entries to
`.opencode/skills/veslo-registry/<name>`. The user-store materializer only
owns `.veslo-user-skill.json`, so it does not remove the legacy policy entries.

Two locked policy candidates are correctly suppressed by the active resolver.
The resulting runtime manifest can therefore contain `entries: []` without
being syntactically invalid. This is a migration defect, not an excuse to
weaken the fail-closed precedence rule.

## Target runtime contract

### Workspace-local sanitized view

For every registered local workspace, Veslo produces one isolated effective
view below a fixed workspace-relative location, for example:

```text
<workspace>/.opencode/.veslo/runtime-skills/<generation>/SKILL.md
```

The exact directory name is an implementation detail, but it must meet all of
these conditions:

- it is inside the registered workspace and never another workspace;
- it is not a default `.opencode/skills` discovery root, preventing raw and
  sanitized copies from racing;
- it is atomically published from the server-owned effective manifest;
- it is addressable by one static relative `skills.paths` config entry from any
  workspace directory;
- it contains only the resolver-selected skills, never management inventory or
  raw global roots.

The shared OpenCode process receives a static overlay such as:

```json
{
  "skills": {
    "paths": [".opencode/.veslo/runtime-skills/current"]
  }
}
```

The relative path is intentionally evaluated by OpenCode's directory-scoped
instance. Veslo must not write an absolute shared staging generation into
`OPENCODE_CONFIG_CONTENT`.

### Raw-project discovery is an explicit compatibility concern

OpenCode's native discovery also sees project `.opencode/skills` and compatible
roots. Veslo must prove that its import-only and conflict policy cannot be
bypassed through those roots. Phase 0 decides one of these supported outcomes:

1. native project discovery plus the sanitized path already matches the
   effective resolver exactly;
2. a static upstream-supported flag/config disables raw project discovery
   without disabling the relative sanitized path; or
3. the model is rejected and Veslo retains isolated processes for divergent
   views.

Veslo must not silently rely on upstream duplicate-name order as a policy
tie-breaker.

### Run ownership

In directory-scoped shared mode, an active run in workspace A does not imply
that a request for B needs to change process-level skills. Both runs may attach
to the same process while retaining distinct OpenCode directory instances.

Still preserve run lifecycle correctness:

- registration before dispatch remains necessary for idempotency and queueing;
- a run may be attached to the shared process after the request's directory,
  workspace identity, and revision are validated;
- no shared-view busy decision may be derived from the newly registered target
  run;
- if the legacy fallback needs an actual process restart, use a pending owner
  (`engineOwnerId: null`) until the switch succeeds, so a run cannot block its
  own admission.

### Revision and freshness

The server remains the authority for a workspace's active runtime view:

```text
materialize/migrate workspace
  -> invalidate active runtime view
  -> resolve effective skills
  -> atomically publish workspace-local sanitized generation
  -> publish revision X
  -> submit/activate validates workspace + revision X
```

The revision is workspace-local. A change in A never replaces B's published
view. The server forwards the revision through its orchestration contract for
diagnostics and fallback staging; a client-provided revision is never trusted
as the authority.

For a currently active OpenCode directory instance, the compatibility spike
must establish how an updated skill generation becomes visible. Accepted
outcomes are a documented/per-directory reload or explicit disposal of that
directory instance. Process-wide restart is not allowed as the normal
invalidation mechanism in directory-scoped mode.

## Phase 0 — Compatibility spike (blocking gate)

### Objective

Prove or reject the directory-scoped model with the exact OpenCode binary
bundled by Veslo. No production topology decision is made from source reading
alone.

### Fixture

Create two isolated git workspaces A and B with distinct named skills and
distinct sanitized runtime views. Start one unmodified OpenCode server and
exercise separate sessions pinned to A and B.

### Cases

1. **Native baseline:** A's session exposes only A's project skill and B's
   session only B's project skill. Exercise sequential and concurrent prompts.
2. **Current Veslo overlay:** set one absolute `skills.paths` staging path and
   prove the path is shared across A/B; this is the control demonstrating the
   current limitation.
3. **Relative overlay:** use one static relative `skills.paths` entry with an
   isolated runtime root in each workspace. Verify A/B each expose their own
   sanitized skill, including concurrent requests.
4. **Global isolation:** seed an ambient global skill and verify it remains
   absent with Veslo's isolation environment.
5. **Raw project leakage:** seed a raw workspace skill intentionally omitted
   by the sanitized manifest. Verify it cannot enter `available_skills` or be
   loaded through the `skill` tool.
6. **Duplicate policy:** seed an internally duplicated locked policy artifact.
   Verify the migration gate blocks publication rather than letting OpenCode
   choose an order.
7. **Freshness:** modify A's published view; verify B is unchanged and measure
   whether a new A session, a current A session, or a per-directory disposal is
   required before the new skill list is visible.
8. **Session pinning:** attempt a request whose session identity and supplied
   directory disagree; verify OpenCode retains the session's pinned context.

### Exit criteria

The directory-scoped architecture may proceed only if all are true:

- concurrent A/B sessions expose no cross-workspace skill;
- no raw global or suppressed workspace candidate bypasses Veslo policy;
- session and request routing preserve workspace identity;
- an update path exists without restarting or corrupting unrelated B;
- behavior is repeatable in a focused automated test, not only manual output.

If any criterion fails, record the exact upstream behavior, retain fail-closed
process isolation, and continue with the fallback section below.

## Phase 0 result — bundled OpenCode 1.17.13

The reproducible gate is
`packages/orchestrator/scripts/opencode-directory-scoped-skills.integration.mjs`.
It runs against the desktop sidecar, not PATH. On 2026-07-21 it established:

- a static relative overlay resolves separately for A and B in one process;
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` suppresses deliberately seeded raw
  `.opencode/skills` entries while preserving the relative overlay;
- a write to A's already discovered runtime root is not visible to the live A
  directory instance; B remains isolated, but no per-directory reload or
  disposal contract was found.

Therefore the Phase 0 hot-update criterion is **not met**. The directory-
scoped mode remains disabled; implementation follows Phase 2B until a future
bundled OpenCode exposes a safe per-directory invalidation mechanism. The
script reports this explicitly as `fallbackRequired: true`.

## Phase 1 — Projection-root migration (independent P0)

This phase does not depend on Phase 0 and must complete before relying on any
active-view cache or directory-local runtime root.

1. Materialize the desired `veslo-registry` projection first.
2. Inspect legacy `veslo-user` entries.
3. Never touch an entry with `.veslo-user-skill.json`.
4. For a legacy `.veslo-managed.json` entry, remove it only after the matching
   `veslo-registry` entry is present and equivalent by installation ID, skill
   ID, version ID, package hash, source, removal policy, and package content.
5. If the marker or content differs, retain artifacts, emit a typed migration
   conflict, and fail runtime-view publication closed.
6. Invalidate and publish the workspace active view only after successful
   migration. A freshly generated empty manifest caused by Veslo-owned
   duplication is an error, not a valid ready state.

The migration must be idempotent, audited, and use recoverable managed backups
where appropriate.

## Phase 2A — Implement directory-scoped shared mode (only if Phase 0 passes)

1. Replace shared `skill-staging` generations under the process config
   directory with one workspace-local sanitized runtime root per workspace.
2. Replace absolute `skills.paths` injection with one static relative entry.
3. Ensure the launch environment disables only the ambient roots needed for
   import-only policy. Do not use a process-global setting that destroys the
   upstream directory instance mechanism without a passing substitute.
4. Remove the normal-path `ensureSharedSkillView` dispose/restart decision.
   A request validates directory/workspace/revision but does not select a
   global skill owner.
5. Keep a process owner only for health, crash cleanup, capacity, and run
   attribution. It is not a skill-view owner.
6. Implement the Phase-0-proven per-directory invalidation/reload behavior.
   It must affect only the changed workspace.
7. Preserve the fallback path behind an explicit capability/feature gate until
   the manual runtime matrix is green.

## Phase 2B — Fallback if Phase 0 fails

1. Keep the current one-view-per-process staging model.
2. Fix the self-deadlock by registering shared-fallback runs with a pending
   owner. Attach only after successful idle selection/staging.
3. An actual attached run for A rejects an incompatible B switch with a
   structured `shared_engine_skill_view_busy` 409.
4. For concurrent workspace work, choose either queueing or a per-workspace
   engine. Never mutate the shared process's absolute skill path in place.

This fallback is correct but is not the preferred outcome because it imposes
unnecessary process restarts or rejects concurrent multi-workspace use.

## Phase 3 — Server/API contract

1. Thread server-generated `skillViewRevision` through submit and activation
   requests. It is an assertion about the workspace-local published view, not
   a request to mutate global process configuration.
2. Preserve structured local lifecycle failures as HTTP 409:
   `skill_view_stale`, `shared_engine_skill_view_busy`, and
   `shared_engine_skill_view_stale` where the fallback is active.
3. Keep real upstream failures mapped to `opencode_request_failed` / 502.
4. UI restores the draft and renders the structured reason. It must not retry
   a non-retryable 409 through another transport.
5. Trace workspace ID, directory-instance mode, revision, source of skill
   view, and response code; redact local paths.

## Required coverage

### Compatibility and OpenCode integration

- all eight Phase 0 cases run against Veslo's bundled binary;
- one process handles concurrent A/B sessions without cross-skill leakage;
- a static absolute overlay demonstrably fails the isolation control;
- a static relative overlay passes only if raw discovery is also contained;
- per-directory skill update leaves the unrelated workspace unchanged.

### Veslo migration and runtime views

- equivalent legacy managed policy projections migrate exactly once;
- user-store entries remain untouched;
- divergent legacy/current entries produce typed conflict and no new empty
  view;
- no runtime root includes raw global skills or a suppressed candidate;
- workspace A invalidation/revision cannot publish into workspace B.

### Lifecycle and transport

- directory-scoped mode allows A/B runs on one process without any shared skill
  view switch;
- fallback pending-owner path allows an idle target switch but blocks a real
  attached conflicting run;
- duplicate submissions still reuse/queue before dispatch;
- server-owned submit propagates revision and retains local 409 codes.

### Completion gate

- focused server/orchestrator/app tests;
- type checks for all changed packages;
- `git diff --check`;
- manual development runtime matrix for A/B sequential, A/B concurrent,
  migration, raw-global isolation, and update freshness.

## Acceptance criteria

## Implementation checkpoint — 2026-07-21

- Phase 0 is automated against the bundled `1.17.13` sidecar and selected the
  fallback because directory-instance skill discovery is not fresh after a
  runtime-root update.
- Phase 1 now migrates only equivalent legacy managed projections, retains a
  recoverable backup, and rejects divergent projections before publishing an
  active runtime view.
- Phase 2B registers a shared-fallback run with no engine owner, then attaches
  it after shared-view selection. The target run therefore cannot block its
  own idle switch.
- In the same fallback, `GET /event` selects and stages the target view before
  opening its long-lived SSE connection. It reads the revision only from the
  already-published workspace manifest, so the following server-owned submit
  observes the same view instead of causing a second restart/reconnect.
- Phase 3 forwards the server-owned active-view revision on submit requests
  and preserves local shared-view/stale 409 responses instead of wrapping them
  as generic upstream 502 failures.

`done` remains false until the manual desktop matrix has verified an idle A→B
switch with `/event` opened before the first prompt (no second restart or
reconnect), a real active-A rejection for B, projection migration, and UI handling
of the structured 409 responses.

- The selected architecture is based on a reproducible bundled-binary test,
  not an assumption about process-global configuration.
- If directory-scoped mode passes, one shared process serves distinct workspace
  skill views without restart, cross-workspace leakage, or self-deadlock.
- If it fails, fallback topology remains fail-closed and no self-owned run can
  block its own admission.
- Successful sync leaves no duplicated registry/platform policy entry between
  `veslo-user` and `veslo-registry`.
- Veslo never treats an empty manifest created by its own projection duplication
  as a ready runtime view.
- Every normal submit is attributable to one workspace and one server-owned
  revision, and local 409 causes remain observable at the UI boundary.

## Rollout and rollback

Phase 0 and Phase 1 are independent gates. Do not enable directory-scoped
shared mode until both pass.

Roll out directory-scoped mode behind an explicit capability gate with runtime
tracing. On any cross-skill, raw-discovery, or freshness violation, disable the
gate and fall back to process-isolated staging; retain migration safeguards and
structured diagnostics. Never roll back by reintroducing ambient global roots
or by silently selecting a conflicting skill by filesystem order.
