# Skills: Import-only External Sources and Workspace-automatic Runtime Boundary

## Status

Deep audit summary and implementation contract. This revision closes the
runtime-enforcement and migration decisions identified in review.

Implementation is in progress in this checkout. Phase 1 server/app/Tauri
call-site enforcement, deterministic active precedence, workspace projection,
engine skill staging, and the minimal orchestrator launch contract are
implemented and covered by focused tests. Sidecars are locally prepared and a
real OpenCode `/skill` probe verifies the staged view and global isolation. The
full Tauri pilot remains an explicit exit gate because its current fresh-profile
scenario still times out in the pre-existing inventory refresh lifecycle.

Target repository: `C:\Users\jajse\Desktop\projekty\veslo-main`

Out of scope: sibling Veslo checkouts, Codex's own runtime outside Veslo, and
unrelated plugin/MCP behavior.

## Executive decision

Veslo must not silently promote skills from another agent, a raw user-global
filesystem, or a registry catalog into the active runtime.

The only implicit runtime source is the selected/registered workspace:

- workspace-local `.opencode/skills/**`
- workspace-local `.claude/skills/**` as a compatibility source

Everything else is discovery-only until an explicit import/install action is
confirmed by the user, except for the separate managed-policy authorization
described below:

- Codex user/workspace skills (`.codex/skills`)
- Claude user-global skills (`~/.claude/skills`)
- OpenCode user-global skills (`~/.config/opencode/skills`)
- Agents user/global skills (`~/.agents/skills`, `~/.agent/skills`)
- Veslo user-global store entries not explicitly imported/installed
- organization and platform registry skills
- Hub/catalog candidates

An imported personal skill is storage/provenance, not an engine search root. It
becomes active for a workspace only after Veslo projects it into a
Veslo-owned workspace runtime root and refreshes the runtime inventory. Raw
user-global roots are never engine-visible.

Managed organization/platform rollout is an explicit policy exception, not
catalog visibility: an enabled, approved, concrete rollout materializes a
policy-enforced skill into the selected workspace runtime root. The active
instance must retain `policy-enforced` provenance and must not be presented as
a user import.

## Current implementation audit

### Implemented in the current change set

- Server active runtime listing is separate from broad discovery and resolves
  duplicate names through the fixed precedence contract; ambiguous and locked
  policy/local conflicts fail closed.
- Server import discovery and the Tauri workspace fallback share a bounded root
  rule: climb only to the nearest `.git` boundary, and keep a gitless
  registered workspace as its own sole boundary rather than walking to the
  filesystem/home root.
- Slash-command resolution, workspace resolve routes, app remote/session calls,
  and Tauri local read/list/write paths no longer use raw global roots as an
  active source. Explicit global listing remains management/import inventory.
- Registry personal-global materializations now also reconcile into a
  Veslo-owned projection in every registered local workspace. The existing
  global materialization remains storage-compatible during migration and is
  not engine-visible through the isolated launch environment.
- The orchestrator launch adapter sets `OPENCODE_CONFIG_DIR` and
  `XDG_CONFIG_HOME` to the existing per-workspace config directory while
  preserving inherited data/auth paths. EnginePool lifecycle and launch
  contract regression tests cover suspend/restart behavior.
- Every engine launch reconciles a Veslo-owned `configDir/skill-staging` view
  from the deterministic precedence result. Suppressed policy/equal-precedence
  conflicts are omitted from that view. The view is exposed through the
  explicit `OPENCODE_CONFIG_CONTENT.skills.paths` merge. For a fail-closed
  conflict only, OpenCode's project scope is disabled and the sanitized Veslo
  config copy is reloaded via `OPENCODE_CONFIG`, preventing upstream project
  scanning from bypassing the conflict policy.
- Server, orchestrator, and app inventory paths now emit a `veslo-skill-audit/v1`
  trail when `VESLO_SKILL_AUDIT_LOG_FILE` (or the existing runtime trace file)
  is enabled. The manual fixture under `.tmp/skill-runtime-fixture` exercises
  workspace-auto versus import-only roots without touching real user-global
  directories.
- Orchestrator staging records whether the engine consumed the effective
  manifest, failed closed because it was absent, or used the legacy discovery
  path (the latter is test-only), together with selected provenance and
  suppressed names.
- Shared-unsandboxed launches now stage the active workspace manifest into the
  shared engine's Veslo-owned config view. Switching the active workspace
  recreates that shared process only when no shared run is active; otherwise
  the switch is rejected fail-closed instead of silently mixing skill views.
- Registry-backed personal-global projections use a dedicated
  `.opencode/skills/veslo-registry` category, separate from the user-store
  `.opencode/skills/veslo-user` category. Same-name entries therefore reach the
  resolver as distinct provenance instead of racing two manifests in one root.
- Runtime skill audit traces redact absolute local paths, staging generations
  retain only a bounded recent set, and reload fallback mounts are attempted
  after timeout/abort as well as HTTP mount errors.
- Runtime preflight now resolves the active workspace skill listing after
  materialization and before `prepareWorkspaceRuntime`, so the effective
  manifest exists before engine staging. Active runtime and import discovery
  pass the registered workspace as an explicit hard boundary; they do not
  inherit a parent checkout's `.git` roots merely because a workspace is
  nested inside that checkout.
- The orchestrator send-workflow mirror uses the same path/query redaction as
  runtime and skill-audit traces, including workspace paths embedded in
  `directory` query parameters.

### Workspace filesystem discovery

`packages/desktop/src-tauri/src/commands/skills.rs` walks from the workspace
directory upward until the git root and currently recognizes:

- `.opencode/skills`
- legacy `.opencode/skill`
- `.claude/skills`

It supports both `<root>/<name>/SKILL.md` and one-level category layouts such
as `<root>/<domain>/<name>/SKILL.md`. It exposes `workspace`, `global`, and
`effective` listing modes. `effective` combines project and global roots and
deduplicates by skill name, with the first discovered name winning.

This is the correct shape for workspace-local automatic availability, but the
`effective` mode is not safe as a general runtime inventory if it includes raw
user-global roots.

### Current global runtime leak

`packages/server/src/skill-roots.ts` defines user-global roots:

- `$XDG_CONFIG_HOME/opencode/skills`
- `~/.config/opencode/skills`
- `~/.claude/skills`
- `~/.agents/skills`
- `~/.agent/skills`

`packages/server/src/skills.ts:listSkills()` can include those roots whenever
`includeGlobal` is true. The app inventory currently calls the scoped global
listing and then adds the Veslo user-global store. As a result, a raw global
skill can become visible as a runtime skill merely because the file exists.

That violates the desired import-only boundary.

### Runtime enforcement call sites

The boundary must be enforced at every runtime entry, not only in the Skills
screen inventory:

- `packages/server/src/conversation-submit-skill-command-resolution.ts` calls
  `listSkills()` with `includeGlobal` and feeds the result to the slash-command
  resolver.
- `packages/server/src/conversation-submit-service.ts` enables global skill
  resolution for local workspaces.
- `packages/server/src/routes/workspace-skills.ts` uses `listSkills()` for
  workspace listing and resolution routes and currently exposes an
  `includeGlobal` choice.
- `packages/desktop/src-tauri/src/commands/skills.rs` has separate `workspace`,
  `global`, and `effective` scopes. `list_local_skills`, `read_local_skill`,
  and path resolution use `effective`, which combines workspace roots with
  global roots.
- `packages/desktop/src-tauri/src/engine/spawn.rs` passes the user's inferred
  `XDG_CONFIG_HOME` to the upstream engine. A server-side inventory change
  therefore does not prove that the engine cannot read raw global skills.
- Remote/session capability and workspace-skill paths have their own global
  listing options and must resolve through the same policy-aware runtime API.

The implementation must classify each call site by explicit intent:

1. `import-discovery`: broad read-only scan of external roots and catalogs;
2. `management-inventory`: Veslo UI/admin view including candidates, imported
   entries, conflicts, and provenance;
3. `active-runtime-resolution`: only workspace runtime roots plus approved
   managed materializations.

No call site may infer active runtime membership from a generic `includeGlobal`
boolean or from the existence of a file in a user-global root.

### Current import discovery

`packages/server/src/skill-import-candidates.ts` already has the right broad
source coverage for an explicit import UI.

User-level candidates:

- `~/.codex/skills`
- `~/.claude/skills`
- `~/.config/opencode/skills`
- `~/.agents/skills`
- `~/.agent/skills`

Workspace-level candidates:

- `<workspace>/.codex/skills`
- `<workspace>/.claude/skills`
- `<workspace>/.opencode/skills`
- `<workspace>/.agents/skills`
- `<workspace>/.agent/skills`

The scanner returns candidate metadata and does not activate a candidate by
itself. The current contract derives the target from source location:

- user-global candidates import into the Veslo user-global store;
- workspace candidates import into the selected workspace OpenCode root.

There is no general Hub-to-user-global target today. The revised plan keeps
these existing target semantics; a target picker is explicitly out of scope
unless a separate product change adds target authorization and API support.
`importSkillCandidates()` performs the explicit copy with conflict checks.

The remaining design gap is that runtime listing and import discovery currently
share too much filesystem vocabulary. A source being discoverable must not make
it runtime-active. Workspace imports also need a Veslo marker/manifest so the
projection and later cleanup are distinguishable from user-authored files.

### Registry and materialization

The managed source model in `packages/server/src/types.ts` distinguishes:

- `personal`
- `workspace`
- `organization`
- `platform`

`packages/server/src/workspace-skill-set.ts` resolves enabled, in-scope,
approved installations and rollout policies. `packages/server/src/skill-materializer.ts`
then writes managed packages into Veslo-owned roots and records markers/manifests.

The current resolver/materializer path is capable of making organization and
platform policy results active during synchronization, including
`personal-global` targets. This plan chooses the managed-policy exception:
catalog visibility alone is inert, while an enabled, approved rollout with a
concrete version and target is an explicit administrative authorization to
materialize a `policy-enforced` workspace skill. Locked platform skills remain
supported under that state and must be labeled as policy-enforced.

Personal-global registry materializations must be migrated away from raw global
engine roots. The registry remains the source of truth: user-owned personal
entries use `all-local-workspaces`, while managed entries use their explicit
workspace/rollout target set. Existing Veslo-managed global directories may be
migrated or removed only when their markers/manifests prove ownership; unrelated
user-authored global directories must never be deleted.

## Target runtime model

The active Veslo runtime is the union of two runtime classes, with managed
policy as an explicit provenance subtype:

1. `workspace-auto`
   - skills physically located in the active/registered workspace runtime roots
   - immediately available when the workspace is opened

2. `veslo-imported`
   - skills explicitly imported by the user, or explicitly authorized by a
     managed organization/platform rollout
   - personal imports are stored in the Veslo user-global store with
     `all-local-workspaces` scope and projected into the active local workspace
     runtime root before engine start
   - managed-policy skills are materialized directly into the eligible
     workspace runtime root
   - available only after successful materialization and refresh

`veslo-imported` instances must carry one of `user-imported` or
`policy-enforced` provenance. A raw user-global filesystem root is never an
active runtime source, even when it is listed in a registry or exists on disk.

For local workspaces, the trusted runtime root remains the workspace's
`.opencode/skills` tree (including Veslo-owned subdirectories) and the
documented `.claude/skills` compatibility root. For remote workspaces, the
same rule is enforced on the remote Veslo server's workspace root; the local
client's global filesystem is irrelevant.

Raw external roots are never active merely because they exist:

```text
external filesystem / registry / Hub
              |
              v
       import candidate
              |
       explicit confirmation
              |
              v
   Veslo-owned target + manifest
              |
              v
       policy resolver
              |
              v
      engine staging view
              |
              v
       active runtime inventory / engine
```

## Scope matrix

| Source | Discover automatically | Active automatically | Importable | Target after import |
| --- | --- | --- | --- | --- |
| Workspace `.opencode/skills` | yes | yes | optional | workspace |
| Workspace `.claude/skills` | yes, compatibility | yes, compatibility | optional | workspace |
| Workspace `.codex/skills` | candidate only | no | yes | workspace |
| Workspace `.agents/.agent/skills` | candidate only | no | yes | workspace |
| User-global Claude/OpenCode/Agents roots | candidate only | no | yes | user-global storage, `all-local-workspaces` projection |
| User-global Codex root | candidate only | no | yes | user-global storage, `all-local-workspaces` projection |
| Veslo user-global store | list imported entries only | projected into every registered local workspace after import | n/a | storage/provenance only |
| Organization registry | catalog candidate; enabled rollout is managed policy | no by default; yes for explicit approved rollout | yes | declared workspace/rollout target set |
| Platform registry | catalog candidate; enabled rollout is managed policy | no by default; yes for explicit approved rollout | yes | declared workspace/rollout target set |
| Hub/catalog | candidate only | no | yes | selected workspace only |

The trusted workspace-root decision is explicit: `.opencode/skills` and
workspace `.claude/skills` remain automatic; workspace `.codex`, `.agents`, and
`.agent` remain import-only. The existing upward search from the active
directory to the nearest `.git` root is preserved and becomes part of the
runtime resolver contract, rather than being silently narrowed to one folder.

## Runtime enforcement and migration

This work is deliberately split into two phases. Storage and policy migration
must not start until every active-runtime entry point uses the same resolver.

### Phase 1: one policy-aware runtime resolver

Introduce a single server/Tauri runtime contract, for example
`resolveActiveWorkspaceSkills(workspace, context)`, whose output contains only
workspace runtime entries and their provenance. Its input must include the
workspace identity/type and an explicit intent (`active-runtime-resolution`,
`management-inventory`, or `import-discovery`); no generic `includeGlobal`
boolean may select active roots.

Convert all of these paths to that contract:

- server slash-command resolution and local submit defaults;
- workspace skill list/resolve/read routes;
- remote/session capability skill listings;
- app active inventory loading (global candidates remain a separate view);
- Tauri `list_local_skills`, `read_local_skill`, path validation, and fallback
  calls that currently use `effective`;
- engine startup and reload.

The resolver must preserve the current workspace traversal semantics: start at
the active directory and walk upward through the nearest `.git` root, with
deterministic root and entry ordering. It must reject raw user-global paths
even when a caller supplies an old `includeGlobal=true` flag.

### Phase 1a: engine isolation spike and launch contract

The chosen isolation mechanism is a Veslo-owned per-workspace OpenCode config
home passed as `XDG_CONFIG_HOME` to the spawned engine. Veslo generates an
allow-listed runtime config overlay there; the overlay contains only approved
workspace skill roots and the non-skill config required by the current
workspace. `XDG_DATA_HOME` preserves the launcher's current inferred path and
is recorded in the launch contract; this plan does not migrate or delete auth
data. Auth state is not copied from or exposed through a user's raw global
config home. The engine may retain the workspace as its current directory for
project access only when upstream skill discovery can be restricted; otherwise
the engine-visible staging/isolated working-directory rule below takes
precedence.

The spike must prove whether MCP, plugin, provider, and other required config
can be represented in that overlay without reintroducing ambient global skill
roots. If an upstream config feature is needed to express the skill allow-list,
use it inside the same Veslo-owned config home; do not fall back to the user's
XDG config home. The launch contract is not accepted until an actual spawned
engine process passes a regression fixture showing that a raw global skill is
unavailable while workspace skills, auth, MCP, and plugins still work.

The spike output is a documented launch contract: exact config/data paths,
environment variables, generated overlay inputs, reload behavior, and cleanup
rules. The contract must explicitly state that the current inferred
`XDG_DATA_HOME` is preserved verbatim and that any future auth-data migration is
a separate plan. A server-only or UI-only test is insufficient evidence for
this gate.

### Engine-visible skill view

Precedence is enforced physically, not only in metadata. Before every engine
start/reload, Veslo builds a workspace-owned staging view from the final
effective directories returned by the policy resolver. The generated engine
config points to that staging root only. Suppressed, shadowed, and
fail-closed-conflict directories are omitted from the staging view and must not
be reachable through any configured skill root.

The launcher must also prove that the upstream engine does not perform an
additional ambient scan of the workspace `.opencode/skills`, `.claude/skills`,
or user-global roots. If the upstream engine always scans a default root, the
launch overlay must replace that root with the staging view (using the
upstream-supported explicit skill-root/config mechanism or an isolated launch
overlay); if that is impossible while the current directory is the workspace,
the engine must run from an isolated runtime working directory with the project
path provided through the upstream-supported project/workspace setting. Passing
the whole workspace skill tree is forbidden. Rebuild the view on import,
policy, workspace, and conflict changes. The staged manifest records the
selected source for every visible skill and the reason every suppressed skill
is absent.

### Engine launch and lifecycle guardrails

The skill boundary is an adapter around the existing engine launcher, not a
rewrite of engine lifecycle. Unless the Phase 1a spike proves otherwise, do not
change the existing engine command, arguments, supervisor, retry policy,
health checks, shutdown handling, session correlation, auth transport, or
workspace process ownership. The adapter may prepare a config/staging
generation before start or reload and pass its path through the launch
contract; it must not introduce an independent engine process or a second
lifecycle controller.

Staging updates use a two-phase commit:

1. build and validate a new generation in a temporary Veslo-owned directory;
2. atomically publish the generation pointer and invoke the existing reload or
   restart path exactly as it is currently used.

If preparation or validation fails, keep the last known-good generation and
fail closed for the new skill change. Never start an engine against a partial
directory. Retain a generation while a process may still reference it and
clean it only after the existing stop/restart lifecycle confirms it is unused.
Every generation records workspace ID, resolver revision, source manifest,
engine PID/session correlation, and cleanup status for diagnostics.

Required lifecycle regression matrix:

| Scenario | Required invariant |
| --- | --- |
| cold start with workspace, imported, organization, and raw-global fixtures | one existing engine process starts; only the staged winners are visible |
| import while engine is running | existing reload/restart contract is used; no second unmanaged process appears |
| uninstall or organization revoke | new generation omits the skill; old generation is retained until safe cleanup |
| workspace switch | old projection and generation are not visible in the new workspace; process ownership/session IDs remain correct |
| engine crash during staging or reload | supervisor recovery behavior is unchanged; recovery uses the last valid/current generation only |
| failed staging, malformed skill, or conflict | no partial generation is launched; prior known-good runtime remains intact |
| auth, MCP, plugin, provider, and session lifecycle | existing configuration and correlation behavior is unchanged |
| restart/reload after app restart | generation manifests and cleanup are reconciled without stale skill visibility |
| concurrent import/policy refresh | one deterministic published generation wins; no torn or mixed skill view |

These tests are mandatory around the real Tauri/engine process. Unit tests of
the resolver or a server-only route do not establish lifecycle safety.

### Phase 2: storage projection, policy activation, and migration

Adopt the following closed decision for personal-global skills:

1. The Veslo user-global store is storage/provenance only.
2. A personal import has the explicit scope `all-local-workspaces`: it is
   projected into every registered local Veslo workspace when that workspace is
   opened or reloaded. Remote workspaces are never implicit projection targets.
   There is no hidden per-workspace target picker for this personal scope.
3. On opening or reloading each registered local workspace, Veslo projects
   personal skills into a Veslo-owned workspace runtime category (for example
   `.opencode/skills/veslo-user/<name>`), with a per-entry manifest.
4. The engine is started with the workspace runtime roots; it is not granted
   the user's raw XDG/OpenCode/Claude/Agents skill roots.
5. Removing an import or changing workspace removes only the matching
   Veslo-owned projection after manifest verification. It must not remove the
   source in the user store or any unmanaged folder.
6. Existing `personal-global` registry materializations are migrated to the
   same workspace projection. Old global materializations are cleaned up only
   when their Veslo marker/manifest proves ownership; otherwise they are
   reported for manual review.

Workspace-local source imports remain bound to their source workspace, while
user-global personal imports use `all-local-workspaces`. Registry policy
installations keep their explicit workspace target or rollout target set; they
do not inherit the personal all-local scope.

Managed organization/platform rollout remains the explicit policy exception:
an approved, enabled, concrete rollout materializes directly into the eligible
workspace runtime category and is recorded as `policy-enforced`. Registry
catalog visibility and unresolved rollouts remain non-active candidates.

Organizational skills therefore follow this rule:

- catalog visibility or an unapproved organization installation is an import
  candidate only;
- an organization installation with explicit approval and a concrete target is
  an administrative authorization and becomes `policy-enforced`;
- an enabled rollout with a resolved version and declared target set is also
  `policy-enforced`;
- revoke, disable, expiry, or target change removes or rebuilds only the
  verified managed projection.

Organization policy never makes a raw organization/global filesystem root an
engine input and never masquerades as a user-imported skill.

Registry state semantics are fixed as follows:

| Registry state | Authorization | Runtime result |
| --- | --- | --- |
| `catalog` | none | candidate only |
| user-accepted personal install from a user-global source | user acceptance; scope `all-local-workspaces` | `user-imported` projection in every registered local workspace |
| user-accepted workspace-source install | user acceptance; source workspace target | `user-imported` projection in that workspace |
| organization-created install with `approved=true` and a concrete workspace target | administrative authorization | `policy-enforced` projection in that workspace |
| organization-created install without approval or target | incomplete authorization | candidate pending target/approval |
| enabled approved rollout with a resolved version and target | managed policy authorization | `policy-enforced` workspace projection |
| revoked, disabled, expired, or target-changed installation | authorization withdrawn/changed | remove the old verified projection, then materialize the new target only after refresh |

An organization-created installation is therefore an authorization only when
its approval and target are explicit; otherwise it remains a candidate. Existing
`personal-global` installations migrate according to this table: user-owned
ones become `all-local-workspaces` projections, while approved
organization/platform ones become target-bound policy-enforced projections.
Revoke and target changes are manifest-driven lifecycle events, not silent file
copies.

Phase exit gates:

- Phase 1 is complete only when server, app, Tauri, engine-start, and
  remote/session paths all use the policy-aware resolver and the raw-global
  fixture is rejected by inventory, slash resolution, and an actual engine run.
- Phase 2 is complete only when projection manifests, migration/cleanup, policy
  provenance, uninstall, workspace switching, and restart behavior pass the
  acceptance tests below.

## Required implementation changes

### 1. Separate discovery APIs from runtime APIs

Keep broad source scanning for `listSkillImportCandidates()`. Add or expose a
runtime-specific listing mode that returns only:

- workspace-local automatic roots, and
- Veslo-owned projected imports and approved managed-policy materializations in
  the active workspace.

Do not use a raw `effective = project + all global roots` listing to build the
active runtime inventory.

### 2. Change app inventory loading

In `packages/app/src/app/context/extensions.ts`:

- remove raw global roots from the active runtime inventory path;
- keep the Veslo user-global store as management/provenance data, not as an
  engine-active root;
- load projected workspace entries and policy-enforced workspace entries into
  the active inventory;
- keep workspace-local automatic listing for every registered local workspace;
- continue loading import candidates separately;
- mark projection and inventory refresh after a successful import/materialization.

### 3. Preserve explicit source provenance

Every candidate and active instance must retain:

- source agent (`codex`, `claude`, `opencode`, `agents`, `veslo`, `hub`);
- source location (`user-global` or `workspace`);
- source path or registry identity;
- target scope and workspace ID;
- whether the instance is automatic, `user-imported`, or `policy-enforced`;
- projection/materialization manifest ID and lifecycle state.

Add the required schema/manifest fields and a migration for existing user-store
and workspace-copy entries. Store the normalized source path only in the local
Veslo manifest for audit/cleanup; do not sync it to a registry or remote
workspace, and show only a redacted/root label in the UI. A raw source path is
never an engine input.

The UI must not present a raw discovered candidate as an active runtime skill.

### 4. Make registry activation explicit

Organization/platform/personal registry records should be treated as catalog or
installation candidates until an accepted target is created. The explicit
managed-policy exception is an enabled, approved, concrete rollout with a
workspace target; it materializes as `policy-enforced`. Materialization must
remain auditable and must never write a raw global engine root.

### 5. Prevent duplicate candidate noise

Workspace `.opencode` and `.claude` skills that are already automatic should
not be offered as ordinary import actions for the same workspace unless the UI
explicitly offers "copy to user-global". External `.codex`, `.agents`, and
`.agent` candidates should remain importable.

For active runtime conflicts, do not rely on filesystem enumeration order. Use
this fixed precedence policy:

| Conflict | Result |
| --- | --- |
| workspace-local user-authored vs `user-imported` projection | workspace-local wins; imported projection is shadowed and audited |
| locked `policy-enforced` vs workspace-local user-authored | fail closed; no same-name variant is active until the policy conflict is resolved, and the local file is never overwritten |
| admin-removable `policy-enforced` vs workspace-local user-authored | workspace-local wins; policy projection is suppressed and the policy remains removable/auditable |
| locked `policy-enforced` vs `user-imported` projection | locked policy wins; imported projection is suppressed and audited |
| admin-removable `policy-enforced` vs `user-imported` projection | policy wins unless an explicit admin removal/target change disables it |
| equal-precedence duplicates | fail closed; no arbitrary winner |

The same precedence function and test vectors must be shared by server, Tauri,
and the actual engine launch projection. A suppressed or failed-closed entry
must expose all sources, policy state, target, and remediation in management
inventory; it must never be silently selected by slash resolution.

### 6. Preserve conflict safety

Keep the existing safeguards:

- no overwrite of unmanaged target directories;
- explicit target scope and workspace ID;
- duplicate-name conflict reporting;
- organization-managed skill shadowing rules;
- materialization manifest and backup behavior;
- reload/inventory refresh after mutation.

## Acceptance criteria

1. Creating `~/.codex/skills/foo/SKILL.md` does not make `foo` active in Veslo.
2. Creating `~/.claude/skills/foo/SKILL.md` does not make `foo` active in Veslo.
3. The same Codex/Claude/Agents skills appear in the import-candidate view.
4. Importing one personal candidate stores provenance globally but activates it
   only through a Veslo-owned projection in every registered local workspace
   when opened; it is never implicitly projected to a remote workspace.
5. A workspace `.opencode/skills/foo/SKILL.md` is immediately available after
   opening that workspace.
6. A workspace `.claude/skills/foo/SKILL.md` follows the documented workspace
   compatibility rule and is immediately available.
7. Workspace `.codex`, `.agents`, and `.agent` skills remain import-only unless
   the product explicitly expands the trusted workspace-root policy.
8. Organization/platform skills are not active merely because they are visible
   or returned by a catalog; an enabled, approved, concrete rollout is the
   documented `policy-enforced` exception.
9. An authorized rollout materializes to its declared workspace/rollout target
   set and becomes active only after refresh, with policy provenance.
10. A raw global skill is absent from UI inventory, cannot be resolved by the
    slash-command resolver, is not available in the actual engine process, and
    is not returned by remote/session capability paths.
11. Duplicate names use deterministic precedence; equal-precedence conflicts
    fail closed and identify every source, target, and conflict reason.
12. The generic nearest-`.git` traversal remains covered for explicit legacy
    callers, while active runtime, import discovery, and mutations use the
    registered workspace as a hard boundary; deterministic ordering is covered
    by server and Tauri tests.
13. User-store/workspace-copy manifests preserve provenance, support migration,
    and do not expose source paths as engine roots.
14. Explicit uninstall or workspace change removes only verified stale Veslo
    projections; unmanaged files and the user-global source remain intact.
15. The engine isolation launch contract preserves required auth, MCP, plugin,
    and provider behavior while excluding raw global skill roots.
16. The engine-visible skill root contains only final resolver winners;
    suppressed, shadowed, and fail-closed directories are physically absent
    from the launch staging view.
17. Registry transitions obey the state table: catalog is inert, explicit user
    acceptance projects a user import, approved targeted organization installs
    and rollouts project policy-enforced skills, and revoke/disable cleans only
    verified projections.
18. The precedence table produces identical server, Tauri, and engine outcomes
    for workspace-local, user-imported, locked-policy, and removable-policy
    conflicts.
19. The launch contract preserves the launcher's current inferred
    `XDG_DATA_HOME` verbatim; auth-data migration is not performed by this plan.
20. The real Tauri runtime verifies workspace-auto availability and import-only
    behavior for Codex, Claude, and Agents fixtures.
21. Lifecycle tests prove that skill staging does not add a second supervisor,
    alter retry/shutdown/session ownership, or regress auth/MCP/plugin/provider
    behavior.
22. Failed staging, crash/restart, workspace switch, revoke/uninstall, and
    concurrent refresh leave no partial or stale engine-visible generation.

## Verification plan

Preferred coverage is a real desktop/Tauri scenario supplemented by focused
server tests:

- candidate discovery finds all five user roots and all five workspace roots;
- runtime listing excludes raw user-global roots;
- slash-command resolution and remote/session capability listing exclude them;
- the actual spawned engine cannot discover a raw global fixture through its
  environment or upstream default search paths;
- the isolated per-workspace config overlay preserves required auth, MCP,
  plugin, and provider behavior;
- the engine staging view exposes only resolver winners and cannot rediscover
  suppressed or fail-closed directories from the workspace tree;
- workspace listing remains immediately available;
- importing a user candidate writes the Veslo user-global store and projects it
  into every newly opened registered local workspace runtime root;
- remote workspaces do not receive an implicit personal projection;
- importing a workspace candidate writes the selected workspace target;
- registry visibility alone does not materialize a package;
- explicit authorized rollout materializes and refreshes a policy-enforced
  workspace entry;
- catalog, user-accepted install, organization-approved install, rollout,
  revoke, disable, and target-change transitions match the registry state table;
- duplicate/conflicting names are surfaced with provenance and deterministic
  fail-closed behavior;
- precedence vectors match in server resolution, Tauri projection, and the
  actual engine process;
- migration removes only marker-owned old global materializations;
- restart/reload preserves only workspace-auto and projected Veslo-imported
  runtime entries;
- uninstall and workspace switch leave no stale runtime projection.
- the launch contract records and preserves the inferred `XDG_DATA_HOME` path
  without performing auth-data migration.
- the lifecycle regression matrix passes against the real Tauri/engine process.

The implementation must follow the repo's desktop verification flow. Do not use
a UI-only web server as a substitute for the Tauri runtime.

## Non-goals

- Do not delete or disable the external-source import UI.
- Do not merge Codex/Claude/Agents skill formats into one opaque source.
- Do not silently copy every discovered skill into Veslo storage.
- Do not remove workspace `.claude` compatibility without a separate product
  decision.
- Do not broaden the change into MCP/plugin runtime policy.
