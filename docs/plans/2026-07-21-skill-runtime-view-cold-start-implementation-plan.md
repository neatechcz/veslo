---
title: Skill Runtime View and Cold-start Listing Plan
date: 2026-07-21
status: proposed
done: false
issue: unlinked
depends_on:
  - docs/plans/2026-07-21-skills-import-only-runtime-boundary-audit.md
---

# Skill Runtime View and Cold-start Listing Plan

## Goal

Make the effective skill view a single, server-owned, revisioned snapshot that
is prepared before engine launch and reused by every runtime consumer. Browse
may warm that snapshot in the background, but the first message must not repeat
filesystem discovery merely because it enters the send path.

The desired lifecycle is:

```text
browse / boot warmup
        |
        v
server ensureActiveRuntimeSkillView(workspace)
        |
        +--> shared/per-workspace engine staging
        +--> /skills UI runtime list
        +--> /skills/resolve
        +--> server-owned submit resolver
        +--> manifest endpoint
```

## Scope

In scope:

- shared-engine staging and its active-workspace manifest contract;
- server-side active skill snapshot, single-flight, revision, invalidation and
  freshness detection;
- runtime listing, resolve and server-owned submit call sites;
- client browse/boot/activation prefetch and send-time joining;
- lifecycle logging and focused tests.

Out of scope:

- changing the import-only source policy;
- changing skill precedence or registry rollout semantics;
- broad management inventory UX;
- replacing the OpenCode engine or redesigning shared-engine topology;
- unrelated MCP, plugin or document-runtime work.

Prerequisite: the import-only boundary plan must first resolve projection-root
ownership. `ensure materialized` cannot be treated as reliable while registry
projection and the user-global store can still target the same physical root
with different manifests or markers.

## Executive decisions

1. The shared engine must never stage from its scratch workspace. It must stage
   the active workspace's effective manifest or fail closed.
2. `ensureActiveRuntimeSkillView(workspace)` is the only source of truth for
   active runtime skills.
3. `/skills`, `/skills/resolve`, server-owned submit resolution, and engine
   staging consume the same snapshot. None of them performs an independent
   active filesystem scan.
4. Browse-time prefetch is an optimization and lifecycle wrapper, not a source
   of freshness truth. The server snapshot owns freshness.
5. Management inventory remains separate. It may list global roots and all
   workspaces, but it must never be used as the runtime snapshot.
6. A shared engine has an explicit skill-view owner and revision. `running` is
   not sufficient state for deciding whether a request may reuse it.
7. A manifest is usable only through an atomic revision handshake: the server
   publishes complete revision X, the orchestrator requests X, verifies X, and
   stages only X.
8. Runtime prefetch owns the order `ensure materialized -> invalidate -> ensure
   active view`; a view prepared before materialization is not ready.

## Current problem

The current gate normally performs a materialization status request and then an
active listing before `prepareWorkspaceRuntime()`. The active listing scans the
workspace and rewrites `.opencode/veslo.runtime.skills.json`.

Several consumers can then repeat the same work:

- `refreshSkills({ force: true })` may overlap the gate's direct `listSkills()`;
- `/workspace/:id/skills/resolve` calls the active resolver;
- server-owned submit resolution calls the active resolver again;
- recovery sends intentionally use a separate fresh-runtime flight;
- shared-engine staging reads the manifest but must be given the correct
  workspace rather than its scratch directory.

The browse inventory effect is not the fix. It is broad UI work over global
roots and all local workspaces, and it does not produce the policy-resolved
runtime snapshot.

## Runtime contract

### Active runtime snapshot

Introduce a server-owned type equivalent to:

```ts
type ActiveRuntimeSkillView = {
  workspaceId: string;
  workspaceRoot: string;
  revision: string;
  generatedAt: string;
  sourceFingerprint: string;
  manifestPath: string;
  skills: SkillItem[];
};
```

`revision` is a deterministic hash of the resolver contract version, workspace
identity, source fingerprint, disabled-state revision and materialization
revision. It must not be based on generation time or process identity.

The snapshot contains only the deterministic effective result. Suppressed and
fail-closed conflicts are represented in diagnostics, never as engine-visible
entries.

### Single-flight

The server keeps one in-flight promise per `(workspaceId,
normalizedWorkspaceRoot)` tuple. Concurrent callers join it. A newer
invalidation or fingerprint must not be overwritten by an older in-flight
result.

The cache key is the tuple `(workspaceId, normalizedWorkspaceRoot)`, not only a
path, the current process working directory, or the shared-engine scratch path.
The identity is required because the same path may have a different disabled
state, ownership context or registered policy.

### Freshness

Use explicit invalidation plus a lightweight source fingerprint. The fingerprint
must include the active workspace skill roots, entrypoint file metadata, managed
materialization metadata and disabled-state revision. A short bounded TTL is a
fallback for edits made outside Veslo; it must not replace invalidation.

The first implementation should avoid a filesystem watcher. It should perform a
cheap metadata fingerprint and reuse parsed skills when the fingerprint is
unchanged.

### Invalidation

Invalidate the affected workspace snapshot after:

- workspace skill import or write;
- workspace skill delete or restore;
- user-global projection into a workspace;
- organization/platform materialization sync;
- disabled/enabled state changes;
- removal journal changes affecting active resolution;
- managed manifest changes.

Manual edits inside workspace roots are detected by the fingerprint/TTL path.

### Invalidation ownership matrix

| Mutation owner | Affected scope | Required action |
| --- | --- | --- |
| Workspace skill import/write/delete/restore | One registered local workspace | Invalidate that `(workspaceId, root)` |
| User-global store change | Every eligible registered local workspace receiving the projection | Invalidate all projected local workspaces |
| Organization/platform workspace materialization | The targeted workspace(s) only | Invalidate each targeted local workspace |
| Organization/platform global materialization | Every eligible local projection | Invalidate all affected local workspaces |
| Disabled/enabled state change | Workspace target, plus global target when applicable | Invalidate the exact affected set |
| Removal journal mutation | The workspace/global scope represented by the record | Invalidate the corresponding set |
| Remote workspace mutation | Remote workspace only | Never project or invalidate local runtime views |

The invalidation service owns this fan-out. Individual UI callers must not
guess the affected workspace set.

Workspace lifecycle invalidation is also mandatory:

- evict when a workspace is removed or forgotten;
- evict the old key when its registered root changes;
- evict the old key when workspace identity, ownership or policy context is
  replaced during re-registration.

The new registration must start with a fresh `(workspaceId, root)` snapshot;
the old snapshot must never be reused across those identity boundaries.

## Phase 0 — Shared-engine staging gate

### Objective

Guarantee that a shared OpenCode process never consumes the scratch workspace's
missing or stale manifest.

### Changes

- Make shared engine start receive an explicit `skillWorkspace` and snapshot
  revision.
- Extend the shared-engine state with `skillWorkspaceId`, normalized
  `skillWorkspaceRoot` and `skillViewRevision`.
- Resolve the requested workspace view from every activate/proxy request before
  selecting a shared engine. The request workspace, not the last shared owner,
  is authoritative.
- If the shared engine is idle and the requested view differs, dispose and
  restart it with the requested workspace and revision. A request-scoped reload
  is not assumed unless the upstream engine explicitly supports it.
- If an active run uses the current shared process and the requested view differs,
  reject with `shared_engine_skill_view_busy` and do not mutate the owner.
- Before spawn, require the effective manifest for that workspace and exact
  requested revision. A new process may start only after the revision handshake
  succeeds.
- Keep `requireEffectiveManifest: true`; absence is an explicit
  `skill_manifest_unavailable` failure, not legacy discovery.
- Do not update the shared skill owner during passive browse. Only an actual
  engine activation/request may change it.
- Preserve the existing rule that switching a shared view while active runs
  exist is rejected instead of mixing views.
- Record the snapshot revision and staging source in redacted runtime traces.

### Required tests

- shared scratch workspace has no manifest, active workspace does: staging uses
  the active workspace;
- request for workspace B while shared engine owns A causes an idle restart with
  B's exact revision;
- the same request during an active run returns `shared_engine_skill_view_busy`;
- a revision mismatch between server publication and spawn fails closed;
- missing active manifest fails closed;
- workspace switch does not silently mix two views in one process;
- passive browse does not dispose or restart a shared engine;
- active-run protection still rejects a view switch.
- two concurrent requests for different workspaces are serialized and each
  proxy receives an engine tagged with its requested workspace and revision.

### Shared-view transaction

Shared view selection is one mutex/single-flight transaction:

```text
select requested view
        -> verify expected revision
        -> dispose/restart if idle and different
        -> return engine tagged with same view
```

The proxy path must re-check the returned engine's workspace ID, normalized root
and revision after the await. If ownership changed while waiting, it must not
send the request through that engine; it retries through the serialized owner
or returns an explicit stale/busy response.

## Phase 1 — Server-owned active view

### Objective

Move all active runtime listing and resolution behind one server service.

### Changes

- Add `ensureActiveRuntimeSkillView(workspace, options)` beside the existing
  active resolver.
- Move precedence resolution, manifest publication and audit emission into that
  service.
- Return the cached snapshot on a revision/fingerprint hit.
- Publish the manifest and snapshot atomically. Write a complete revision to a
  temporary file, rename it into place, then publish the in-memory snapshot.
  Never expose a partially written manifest.
- If the atomic write fails (for example, a read-only workspace), return the
  explicit `skill_manifest_unavailable` error. Keep the last valid snapshot for
  an already running engine, but fail closed for a new engine start.
- Support `ensureActiveRuntimeSkillView(workspace, expectedRevision?)`; an
  expected revision mismatch is a hard failure for a new engine start.
- Expose a lightweight runtime-view endpoint for the client, returning revision,
  readiness, counts and active entries without re-running discovery.
- Keep broad `includeGlobal=true` management listing separate and explicitly
  excluded from runtime consumers.

### Consumer migration

- `GET /workspace/:id/skills?includeGlobal=false` reads the snapshot.
- `POST /workspace/:id/skills/resolve` reads the snapshot.
- `conversation-submit-skill-command-resolution.ts` reads the snapshot.
- materialization and manifest routes invalidate/reuse the snapshot rather than
  creating an independent active listing.
- engine staging consumes the manifest generated by the snapshot.

### Revision transport and handshake

The server and orchestrator are separate processes, so the revision must travel
over the existing workspace activation/proxy contract:

```text
client -> server: runtime-view revision X
server -> orchestrator: activate/proxy workspace + expectedRevision X
orchestrator: atomically reads and verifies manifest revision X
orchestrator -> server: engine owner {workspaceId, root, revision X}
server -> client: ready, or explicit skill_view_stale(X, actualRevision)
```

The client obtains X from the runtime-view preparation response and includes it
in the activate/proxy request. A missing, stale or mismatched revision returns
an explicit `skill_view_stale` response; the client must invalidate and rerun
materialization-ordered preparation before retrying. The orchestrator must not
silently substitute its last owner or a newer unrelated revision.

### Required tests

- concurrent list/resolve/submit calls perform one discovery;
- the service-level discovery counter proves one recompute for one
  `(workspaceId, root, revision)` rather than relying on trace text;
- a cache hit does not rewrite the manifest;
- a new revision invalidates all three consumers;
- equal-precedence and locked conflicts remain fail-closed;
- raw global roots never enter the snapshot;
- recovery/fresh-runtime calls use the same snapshot contract.

### Materialization ordering

The runtime preparation owner must not expose a view before registry-backed
materialization is settled. The preparation contract is:

```text
ensure materialized
        |
        v
invalidate workspace snapshot
        |
        v
ensure active runtime view
        |
        v
publish revision X and hand X to engine staging
```

The client prefetch helper must call this preparation sequence, not call the
runtime-view endpoint in isolation. An alternative is one server-side atomic
`prepareWorkspaceRuntimeSkillView` endpoint that owns all three steps; both
forms must produce the same revisioned result.

If materialization fails, no new revision is published. A currently running
engine may keep its last valid view, but a new engine start must fail closed.

## Phase 2 — Client browse and lifecycle prefetch

### Objective

Remove avoidable listing latency from the first message without making the
client's `ready` flag a freshness authority.

### Changes

- Add a per-workspace client flight that calls the lightweight runtime-view
  endpoint.
- Start it non-blocking after passive local browse and during local boot warmup,
  but only through the materialization-ordered preparation sequence above.
- Make activation and `ensureEngineForWorkspace` join the same flight.
- Make send readiness wait only when the snapshot is missing, stale or still
  pending. It must not call `client.listSkills()` independently.
- Let `refreshSkills()` consume the active snapshot for the active workspace;
  keep `refreshSkillInventory()` as a separate broad UI operation.
- On server invalidation, mark the client state stale rather than pretending
  that the previous boolean `skillsLoaded` is still valid.
- A client `ready` state is advisory only. Before a send, the server revision or
  fingerprint must still be checked or joined.

### Required tests

- browse starts prefetch without starting an engine;
- prefetch always settles materialization before publishing the active view;
- send during prefetch joins one request;
- send after a ready snapshot performs no active listing;
- browse of workspace B cannot publish a view for workspace A;
- failed prefetch has the existing safe send-time fallback;
- a manual `SKILL.md` edit between cache hit and send forces fingerprint/TTL
  detection and a new server revision;
- UI inventory refresh and runtime prefetch may run concurrently without
  duplicate active discovery.

## Phase 3 — Lifecycle logging

Add structured, redacted events for:

- `runtime-skill-view:start`;
- `runtime-skill-view:cache-hit`;
- `runtime-skill-view:cache-miss`;
- `runtime-skill-view:join-in-flight`;
- `runtime-skill-view:invalidated`;
- `runtime-skill-view:published`;
- `runtime-skill-view:stale`;
- `engine-skill-staging:manifest-ready` or `manifest-missing`.

Every event should include only workspace ID, topology, reason, revision,
candidate/active counts and duration. Absolute workspace, manifest and source
paths remain redacted.

The traces must distinguish:

- browse prefetch;
- boot warmup;
- activation;
- normal send;
- recovery/fresh-runtime send;
- shared-engine view switch.

## Verification plan

### Focused automated verification

- server active-view/cache/fingerprint/invalidation tests;
- server route and conversation-submit resolver tests;
- client/server/orchestrator revision transport and stale-response tests;
- app runtime-flight and workspace lifecycle tests;
- orchestrator staging/shared-engine tests;
- type checks for server, app and orchestrator;
- `git diff --check`.

### Manual runtime verification

Using the existing `.tmp` skill fixture:

1. Start the development runtime.
2. Browse a workspace and wait without sending.
3. Confirm the runtime-view prefetch completes in the trace.
4. Send the first message and confirm there is no second active discovery.
5. Send a plain text message that exercises server-owned skill resolution.
6. Open Settings → Skills and confirm inventory refresh does not trigger a
   runtime manifest rebuild when the snapshot is still current.
7. Switch workspaces while the shared engine is idle and verify the new view.
8. Repeat the switch during an active run and verify the explicit protection.
9. Edit a workspace `SKILL.md` manually and confirm fingerprint/TTL marks the
   view stale on the next send.
10. Verify the idle shared switch performs the selected restart/reload contract
    and starts only with the requested revision.

## Acceptance criteria

- Shared engine never stages from scratch or an unrelated workspace.
- One current server snapshot is reused by list, resolve, submit and staging.
- Concurrent callers produce one active discovery per workspace revision.
- Revision is deterministic for the same resolver contract, workspace identity,
  source fingerprint, disabled revision and materialization revision.
- Revision transport is explicit across client, server and orchestrator; a
  mismatch returns `skill_view_stale` instead of silently reusing another view.
- The server discovery test hook/counter, not only trace text, proves one
  recompute for concurrent list/resolve/submit callers.
- A ready snapshot means the first send does not perform another active scan.
- Explicit mutations invalidate the correct workspace snapshot.
- Workspace removal, root changes and identity/policy re-registration evict the
  old snapshot key before a new one can be used.
- Manual workspace edits are detected within the bounded freshness window.
- A failed recompute leaves the last valid view available to an already running
  engine, while a new start fails closed.
- An atomic manifest-write failure returns `skill_manifest_unavailable` and
  never publishes a partial revision.
- The synchronous fallback runs the same materialization, invalidation, ensure,
  atomic-publish and revision-handshake sequence as the normal path.
- Shared-engine state exposes requested workspace identity and view revision;
  serialized idle switches restart/reload deterministically and active-run
  switches reject.
- Browse prefetch never starts or restarts an engine by itself.
- Recovery sends remain isolated fresh-runtime flights but reuse the same active
  view contract.
- Management inventory remains broad and independent from runtime activation.
- Logs expose cache hits, joins, invalidations and lifecycle reasons without
  leaking local paths.

## Rollout and rollback

Roll out Phase 0 behind the existing fail-closed staging behavior first. Then
enable the server snapshot consumers behind a diagnostic flag until route and
submit parity is verified. Finally enable client browse prefetch.

If the snapshot service fails, the safe fallback is one synchronous
`ensure materialized -> invalidate -> ensure active view -> atomic publish`
recompute for the requested workspace. It must use the same service contract,
single-flight and revision handshake as the normal path; it must not call the
raw resolver directly. Do not fall back to raw global roots or scratch-workspace
discovery. If client prefetch misbehaves, disable only the prefetch wrapper;
retain the server snapshot and shared-engine manifest gate.
