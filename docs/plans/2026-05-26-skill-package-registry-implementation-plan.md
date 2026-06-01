# Skill Package Registry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a server-backed, versioned skill package registry with restore, approval, search, and deterministic runtime materialization for personal, workspace, organization, and system scopes.

**Architecture:** Den or the cloud control plane owns the canonical skill registry, immutable package versions, approvals, search indexes, and share links. The local Veslo server owns runtime materialization into real filesystem skill directories before an agent can use a workspace. The desktop app consumes registry, installation, version history, approval, and materialization state through server APIs instead of assuming the active workspace is the only editable target.

**Tech Stack:** TypeScript Veslo server APIs, SolidJS app, Tauri desktop startup/runtime hooks, content-addressed package storage in the cloud backend, local Veslo server filesystem materialization, Node test runner app/server tests, desktop WebdriverIO E2E for runtime behavior.

---

## Product Decision

Skills are packages, not single Markdown files. A skill version is an immutable snapshot of the whole skill directory, including `SKILL.md`, scripts, code, assets, examples, and metadata.

The server registry is the source of truth. Runtime filesystem copies are managed materializations that exist only because OpenCode and compatible agents need real files on disk.

For shared organization workspaces, all users must run the same effective skill versions. Do not rely on each user's personal global skill directory to determine company workspace behavior. Organization workspaces use a pinned or release-channel skill set resolved by the server and materialized locally before the workspace runtime starts.

## Distribution Options

### Option A: Commit Skill Package Files Into Workspace Git

Pros:
- Git alone reproduces the workspace.
- Offline behavior is straightforward.
- Code review can include skill file diffs.

Cons:
- Skill updates become noisy repository churn.
- Organization/system approval is hard to enforce after files are copied.
- Personal global skills cannot be represented cleanly.
- Hundreds of skills make every repo heavier.
- Restoring deleted skills depends on repo history, not product history.

Use only for explicitly workspace-owned, project-specific skills where the repo is intentionally the source of truth.

### Option B: Server Materializes Latest Skills Into Every Workspace

Pros:
- Central approval, backup, restore, and search are clean.
- Updates can roll out without touching Git.
- No duplicate package blobs server-side.

Cons:
- A workspace clone is incomplete until Veslo syncs it.
- If updates happen in the middle of a run, behavior can change unexpectedly.
- Shared workspace consistency needs explicit pinning and lock state.

This is good for personal global skills, but not enough by itself for org-shared workspaces.

### Option C: Server Registry + Workspace Skill Set Lockfile + Runtime Materialization

Pros:
- The server owns packages, versions, approvals, restore, and search.
- The workspace records desired skill set identity and revision without committing package payloads.
- All users of a shared workspace get the same resolved versions.
- Local files are generated before agent runtime and can be repaired.
- Updates can be controlled by org release channels.

Cons:
- Requires materialization state, lockfile reconciliation, and conflict handling.
- Offline first-run for an unsynced workspace cannot use missing managed skills.
- The app must explain pending updates and reload boundaries.

Recommended. Implement this.

## Runtime Rules

- Never mutate managed skill files during an active agent run.
- Sync managed skills before starting or reattaching a workspace runtime.
- If a registry update arrives while a run is active, mark it pending and apply after idle/reload.
- If a workspace path is unavailable, keep desired state server-side and mark local materialization pending.
- Personal global skills can track latest user version.
- Organization and system skills track latest approved version only through policy.
- Organization-shared workspaces must use a pinned skill set revision or approved release channel.
- Personal global skills must not shadow organization-managed skill names in organization workspaces unless org policy explicitly allows it.
- Materialized files are disposable; server versions and local pre-change backups are the restore source.

## Managed Filesystem Layout

Preferred workspace materialization:

```text
<workspace>/.opencode/skills/veslo-managed/<skill-name>/SKILL.md
<workspace>/.opencode/skills/veslo-managed/<skill-name>/<other files>
<workspace>/.opencode/skills/veslo-managed/.veslo-materialization.json
<workspace>/.opencode/veslo.skills.lock.json
```

Preferred personal global materialization:

```text
<global skill root>/veslo-managed/<skill-name>/SKILL.md
<global skill root>/veslo-managed/<skill-name>/<other files>
<global skill root>/veslo-managed/.veslo-materialization.json
```

The implementation must first verify that the runtime recognizes one-level-deep category skill folders. If not, fall back to direct `<root>/<skill-name>` materialization with a per-skill `.veslo-managed.json` marker.

Do not overwrite unmanaged user files unless the user explicitly adopts them into Veslo-managed registry ownership.

---

## Phase 1: Package Model And Local Package Utilities

### Task 1: Add Package Types And Manifest Model

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Create: `packages/app/src/app/lib/skill-package.ts`
- Test: `packages/app/src/app/lib/skill-package.test.ts`
- Create: `packages/server/src/skill-package-model.ts`
- Test: `packages/server/src/skill-package-model.test.ts`

**Step 1: Write failing package model tests**

Cover:
- a package requires `SKILL.md`
- package file paths must be relative
- `..` path traversal is rejected
- duplicate normalized paths are rejected
- executable metadata is preserved
- package hash changes when any file content changes

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-package
pnpm --filter veslo-server test -- skill-package-model
```

Expected: fail because helpers do not exist.

**Step 2: Implement shared model helpers**

Add canonical shapes:

```ts
export type SkillPackageFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  executable?: boolean;
  text?: string;
};

export type SkillPackageManifest = {
  schemaVersion: 1;
  entrypoint: "SKILL.md";
  files: SkillPackageFile[];
  packageSha256: string;
  metadata: {
    name: string;
    description?: string;
    trigger?: string;
    tags?: string[];
    language?: string;
  };
};
```

Keep the server model authoritative. The app model can mirror response types for UI rendering.

**Step 3: Run tests and typecheck**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-package
pnpm --filter veslo-server test -- skill-package-model
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/app/src/app/types.ts packages/app/src/app/lib/skill-package.ts packages/app/src/app/lib/skill-package.test.ts packages/server/src/skill-package-model.ts packages/server/src/skill-package-model.test.ts
git commit -m "feat: add skill package model"
```

### Task 2: Build Skill Directory Pack And Unpack Helpers

**Files:**
- Create: `packages/server/src/skill-packages.ts`
- Test: `packages/server/src/skill-packages.test.ts`
- Modify: `packages/server/src/skills.ts`

**Step 1: Write failing tests**

Create temp skill directories with:
- `SKILL.md`
- nested scripts
- binary asset
- ignored system files such as `.DS_Store`

Assert pack output includes every valid file and rejects invalid paths.

Run:

```bash
pnpm --filter veslo-server test -- skill-packages
```

Expected: fail.

**Step 2: Implement pack/unpack**

Implement:
- `packSkillDirectory(skillDir: string): Promise<SkillPackageArchive>`
- `unpackSkillPackage(input): Promise<void>`
- content hashing
- deterministic path ordering
- file count and size limits
- atomic unpack through temp directory + rename

Do not delete existing `skills.ts` behavior yet. Add package helpers alongside it.

**Step 3: Run tests**

Run:

```bash
pnpm --filter veslo-server test -- skill-packages skills
pnpm --filter veslo-server build
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/server/src/skill-packages.ts packages/server/src/skill-packages.test.ts packages/server/src/skills.ts
git commit -m "feat: pack complete skill directories"
```

---

## Phase 2: Cloud Registry Contract

### Task 3: Define Registry API Contract

**Files:**
- Modify: `docs/dev/veslo-server-app-contract.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Create: `docs/features/skill-registry-and-distribution.md`
- Create: `packages/server/src/skill-registry-types.ts`
- Test: `packages/server/src/skill-registry-types.test.ts`

**Step 1: Write the contract**

Document routes expected from the cloud registry service:

```text
GET    /v1/skills
POST   /v1/skills
GET    /v1/skills/:skillId
POST   /v1/skills/:skillId/versions
GET    /v1/skills/:skillId/versions
GET    /v1/skill-versions/:versionId/package
POST   /v1/skill-installations
PATCH  /v1/skill-installations/:installationId
DELETE /v1/skill-installations/:installationId
POST   /v1/skill-installations/:installationId/restore
GET    /v1/workspaces/:workspaceId/skill-set
PATCH  /v1/workspaces/:workspaceId/skill-set
POST   /v1/skills/:skillId/review-requests
POST   /v1/skill-review-requests/:requestId/approve
POST   /v1/skill-review-requests/:requestId/reject
GET    /v1/skills/search
```

Document auth and scopes:
- personal user
- workspace collaborator/admin
- org skill admin
- platform admin

**Step 2: Add runtime type validators**

Add narrow validators for registry responses used by the local Veslo server and app.

Run:

```bash
pnpm --filter veslo-server test -- skill-registry-types
```

Expected: pass after validators exist.

**Step 3: Commit**

```bash
git add docs/dev/veslo-server-app-contract.md docs/dev/state-and-config-reference.md docs/features/skill-registry-and-distribution.md packages/server/src/skill-registry-types.ts packages/server/src/skill-registry-types.test.ts
git commit -m "docs: define skill registry API contract"
```

### Task 4: Add Local Server Registry Client

**Files:**
- Create: `packages/server/src/skill-registry-client.ts`
- Test: `packages/server/src/skill-registry-client.test.ts`
- Modify: `packages/server/src/config.ts`
- Modify: `packages/server/README.md`

**Step 1: Write failing client tests**

Mock `fetch` and cover:
- bearer token forwarding
- org id forwarding
- package download
- search query encoding
- 401/403/404 error normalization

Run:

```bash
pnpm --filter veslo-server test -- skill-registry-client
```

Expected: fail.

**Step 2: Implement client**

Config keys:
- `VESLO_SKILL_REGISTRY_BASE_URL`
- `VESLO_SKILL_REGISTRY_TOKEN`
- existing Den base/token fallback if product chooses Den as the registry host

**Step 3: Run tests and build**

Run:

```bash
pnpm --filter veslo-server test -- skill-registry-client config
pnpm --filter veslo-server build
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/server/src/skill-registry-client.ts packages/server/src/skill-registry-client.test.ts packages/server/src/config.ts packages/server/README.md
git commit -m "feat: add skill registry client"
```

---

## Phase 3: Registry Persistence In The Cloud Backend

This phase likely belongs in the Den/cloud backend repository. Keep this plan as the contract if the backend lives outside this repo.

### Task 5: Add Cloud Database Schema

**Files:**
- Create in cloud backend: `migrations/<timestamp>_skill_registry.sql`
- Create in cloud backend: `src/skills/schema.ts`
- Test in cloud backend: `src/skills/schema.test.ts`

**Step 1: Add schema tests**

Assert constraints:
- `skill_versions` are immutable
- approved org/system installations reference approved versions
- soft-deleted skills remain restorable
- blob hashes are unique
- tenant isolation prevents cross-org reads

**Step 2: Create tables**

Required tables:

```text
skills
skill_versions
skill_version_files
skill_blobs
skill_installations
workspace_skill_sets
workspace_skill_set_entries
skill_materializations
skill_review_requests
skill_approvals
skill_share_links
skill_search_documents
skill_audit_events
```

Important fields:
- `skill_versions.status`: draft, pending_review, approved, rejected, archived
- `skill_installations.update_policy`: pinned, latest_user, latest_approved, release_channel
- `workspace_skill_sets.revision`
- `workspace_skill_sets.release_channel`
- `skill_materializations.desired_version_id`
- `skill_materializations.actual_version_id`

**Step 3: Add retention and purge policy**

Soft-delete by default. Hard purge only for admins and only after retention.

**Step 4: Commit in cloud backend**

```bash
git add migrations src/skills
git commit -m "feat: add skill registry schema"
```

### Task 6: Implement Cloud Registry Routes

**Files:**
- Create in cloud backend: `src/skills/routes.ts`
- Create in cloud backend: `src/skills/packages.ts`
- Create in cloud backend: `src/skills/approvals.ts`
- Create in cloud backend: `src/skills/search.ts`
- Test in cloud backend: `src/skills/*.test.ts`

**Step 1: Write route tests**

Cover:
- upload package creates immutable version
- editing creates a new version
- delete only soft-deletes installation by default
- restore can target original or new location
- org/system publish requires approval
- approved version rollout updates desired state

**Step 2: Implement content-addressed storage**

Store files by hash. Store version manifests in DB. Do not duplicate blobs across versions.

**Step 3: Implement approval flow**

Org admin approval controls org scope. Platform admin approval controls system scope. Approval always applies to one version.

**Step 4: Implement registry events**

Emit events:
- `skill.version.created`
- `skill.version.approved`
- `skill.installation.changed`
- `workspace.skill_set.changed`
- `skill.deleted`
- `skill.restored`

Clients consume these through SSE/WebSocket or polling.

**Step 5: Commit in cloud backend**

```bash
git add src/skills
git commit -m "feat: implement skill registry routes"
```

---

## Phase 4: Workspace Skill Sets And Lockfiles

### Task 7: Add Workspace Skill Set Model

**Files:**
- Create: `packages/server/src/workspace-skill-set.ts`
- Test: `packages/server/src/workspace-skill-set.test.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/app/src/app/types.ts`

**Step 1: Write failing tests**

Cover:
- personal workspace can include personal global skills
- organization workspace resolves org/system skills to approved versions
- pinned workspace skill set produces stable effective list
- personal globals cannot shadow org-managed names unless policy allows
- conflict output identifies blocked names

Run:

```bash
pnpm --filter veslo-server test -- workspace-skill-set
pnpm --filter @neatech/veslo-ui test:unit -- workspace-skill-set
```

Expected: fail.

**Step 2: Implement resolver**

Expected inputs:
- workspace identity
- user identity
- org identity
- registry installations
- local unmanaged inventory
- policy

Expected output:
- effective managed skills
- blocked conflicts
- required materializations
- reload requirement

**Step 3: Run tests**

Run:

```bash
pnpm --filter veslo-server test -- workspace-skill-set
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/server/src/workspace-skill-set.ts packages/server/src/workspace-skill-set.test.ts packages/server/src/types.ts packages/app/src/app/types.ts
git commit -m "feat: resolve workspace skill sets"
```

### Task 8: Add Lockfile Read/Write

**Files:**
- Create: `packages/server/src/workspace-skill-lockfile.ts`
- Test: `packages/server/src/workspace-skill-lockfile.test.ts`
- Modify: `packages/server/src/workspace-files.ts`
- Modify: `docs/features/skill-registry-and-distribution.md`

**Step 1: Write failing tests**

Cover:
- lockfile path is `<workspace>/.opencode/veslo.skills.lock.json`
- invalid lockfile is rejected with repairable error
- lockfile preserves skill set revision and version hashes
- lockfile can be compared with server desired state

**Step 2: Implement lockfile helpers**

Shape:

```json
{
  "schemaVersion": 1,
  "workspaceId": "workspace-id",
  "skillSetId": "skill-set-id",
  "skillSetRevision": "rev",
  "entries": [
    {
      "skillId": "skill-id",
      "installationId": "installation-id",
      "versionId": "version-id",
      "name": "skill-name",
      "packageSha256": "sha"
    }
  ]
}
```

**Step 3: Decide Git behavior**

Document that lockfile should be committed for organization-shared workspaces. Managed package payloads should not be committed unless the organization explicitly opts into vendored skills.

**Step 4: Commit**

```bash
git add packages/server/src/workspace-skill-lockfile.ts packages/server/src/workspace-skill-lockfile.test.ts packages/server/src/workspace-files.ts docs/features/skill-registry-and-distribution.md
git commit -m "feat: add workspace skill lockfile"
```

---

## Phase 5: Runtime Materialization

### Task 9: Add Local Package Cache

**Files:**
- Create: `packages/server/src/skill-package-cache.ts`
- Test: `packages/server/src/skill-package-cache.test.ts`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Write failing tests**

Cover:
- package blobs stored by hash under Veslo data dir
- cache verifies hashes before use
- corrupted blob is redownloaded
- cache prune preserves referenced packages

**Step 2: Implement cache**

Default path:

```text
${VESLO_DATA_DIR or ~/.veslo/veslo-server}/skill-package-cache/
```

**Step 3: Run tests**

```bash
pnpm --filter veslo-server test -- skill-package-cache
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/server/src/skill-package-cache.ts packages/server/src/skill-package-cache.test.ts docs/dev/state-and-config-reference.md
git commit -m "feat: cache skill packages locally"
```

### Task 10: Add Materializer

**Files:**
- Create: `packages/server/src/skill-materializer.ts`
- Test: `packages/server/src/skill-materializer.test.ts`
- Modify: `packages/server/src/skills.ts`

**Step 1: Write failing tests**

Cover:
- materializes full package tree
- writes manifest marker
- atomic replacement
- refuses to overwrite unmanaged skill directory
- creates backup before replacing managed directory
- removes stale managed skills no longer in desired set
- preserves unmanaged skills

**Step 2: Implement materialization**

Implement:
- `materializeSkillPackageToRoot`
- `materializeWorkspaceSkillSet`
- `materializePersonalGlobalSkillSet`
- managed marker validation
- backup creation under Veslo data dir

**Step 3: Verify nested category runtime support**

Add a focused runtime discovery test for `veslo-managed/<name>/SKILL.md`. If the agent runtime cannot load nested category skills, change materializer to direct `<root>/<name>` directories with markers.

**Step 4: Run tests**

```bash
pnpm --filter veslo-server test -- skill-materializer skills
pnpm --filter veslo-server build
```

Expected: pass.

**Step 5: Commit**

```bash
git add packages/server/src/skill-materializer.ts packages/server/src/skill-materializer.test.ts packages/server/src/skills.ts
git commit -m "feat: materialize managed skill packages"
```

### Task 11: Expose Materialization API

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/server.skill-materialization.test.ts`
- Modify: `packages/server/README.md`
- Modify: `docs/dev/veslo-server-app-contract.md`

**Step 1: Write failing route tests**

Routes:

```text
GET  /skills/materialization
POST /skills/materialization/sync-global
POST /workspace/:id/skills/materialization/sync
GET  /workspace/:id/skills/materialization
```

Cover:
- client can read status
- host auth required for filesystem writes
- sync downloads desired packages and writes runtime files
- active run returns pending/reload-required state instead of mutating files

**Step 2: Implement routes**

Use registry client, workspace skill set resolver, cache, and materializer.

**Step 3: Run tests and rebuild binary**

```bash
pnpm --filter veslo-server test -- server.skill-materialization
pnpm --filter veslo-server build:bin
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/server.skill-materialization.test.ts packages/server/README.md docs/dev/veslo-server-app-contract.md
git commit -m "feat: expose skill materialization API"
```

---

## Phase 6: Startup, Activation, And Update Events

### Task 12: Sync Before Workspace Runtime Start

**Files:**
- Modify: `packages/app/src/app/context/workspace.ts`
- Modify: `packages/app/src/app/stores/engine-store.ts`
- Modify: `packages/app/src/app/context/extensions.ts`
- Test: `packages/app/src/app/context/workspace-skill-sync.test.ts`
- Test: `packages/app/src/app/stores/engine-store.test.ts`

**Step 1: Write failing tests**

Cover:
- workspace activation calls materialization sync before engine start
- no mutation during active run
- pending update surfaces reload-required state
- unavailable workspace path records pending materialization

**Step 2: Implement activation hook**

Before starting or reattaching the engine for a workspace:
1. ask server for materialization status
2. sync if needed and safe
3. write lockfile if organization/shared workspace policy requires it
4. proceed only after required materialization succeeds

**Step 3: Run tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- workspace-skill-sync engine-store
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/app/src/app/context/workspace.ts packages/app/src/app/stores/engine-store.ts packages/app/src/app/context/extensions.ts packages/app/src/app/context/workspace-skill-sync.test.ts packages/app/src/app/stores/engine-store.test.ts
git commit -m "feat: sync skills before workspace runtime start"
```

### Task 13: Add Registry Update Listener

**Files:**
- Create: `packages/app/src/app/lib/skill-registry-events.ts`
- Test: `packages/app/src/app/lib/skill-registry-events.test.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/context/extensions.ts`

**Step 1: Write failing tests**

Cover:
- event invalidates inventory
- idle workspace applies update
- active workspace marks update pending
- failed event stream falls back to polling

**Step 2: Implement event handling**

Consume registry SSE/WebSocket if available. Fall back to periodic polling keyed by registry revision.

**Step 3: Run tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-registry-events
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/app/src/app/lib/skill-registry-events.ts packages/app/src/app/lib/skill-registry-events.test.ts packages/app/src/app/app.tsx packages/app/src/app/context/extensions.ts
git commit -m "feat: listen for skill registry updates"
```

---

## Phase 7: App Registry UI

### Task 14: Replace Active Workspace Actions With Instance Actions

**Files:**
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/context/extensions.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`
- Test: `packages/app/src/app/context/extensions-skill-registry.test.ts`

**Step 1: Write failing tests**

Cover:
- edit works by installation id, not active workspace
- share works by skill/version id
- delete menu is under `...`
- delete removes selected installation only
- inactive workspace skill can be edited or removed

**Step 2: Implement registry-backed action targets**

Add actions:
- edit package version
- share version/current channel
- remove installation
- restore installation

Keep legacy filesystem actions only as fallback for unmanaged skills.

**Step 3: Run tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skills-layout-contract extensions-skill-registry
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/app/src/app/pages/skills.tsx packages/app/src/app/context/extensions.ts packages/app/src/app/lib/veslo-server.ts packages/app/src/app/pages/skills-layout-contract.test.ts packages/app/src/app/context/extensions-skill-registry.test.ts
git commit -m "feat: make skill actions registry-targeted"
```

### Task 15: Add Skill Detail Drawer

**Files:**
- Create: `packages/app/src/app/components/skill-detail-drawer.tsx`
- Test: `packages/app/src/app/components/skill-detail-drawer.test.ts`
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Step 1: Write failing UI contract tests**

Tabs:
- Overview
- Locations
- Versions
- Sharing
- Audit

Actions:
- Copy to...
- Move to...
- Publish to organization...
- Request system approval...
- Restore version...
- Delete from this location...

**Step 2: Implement drawer**

Use dense operational UI. No marketing copy. Large skill lists must remain scannable.

**Step 3: Run tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-detail-drawer skills-layout-contract
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/app/src/app/components/skill-detail-drawer.tsx packages/app/src/app/components/skill-detail-drawer.test.ts packages/app/src/app/pages/skills.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat: add skill detail drawer"
```

### Task 16: Add Bulk Inventory Mode

**Files:**
- Modify: `packages/app/src/app/pages/skills.tsx`
- Create: `packages/app/src/app/lib/skill-inventory-filters.ts`
- Test: `packages/app/src/app/lib/skill-inventory-filters.test.ts`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`

**Step 1: Write failing filter tests**

Cover:
- filter by workspace
- filter by scope
- filter by approval status
- filter deleted/restorable
- text filter over local indexed metadata
- select all current filter

**Step 2: Implement table/list toggle**

Cards remain for small browsing. Dense table mode is default when item count is high.

**Step 3: Add bulk toolbar**

Actions:
- copy to...
- move to...
- publish/request approval...
- remove selected locations...
- restore selected...

**Step 4: Run tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-inventory-filters skills-layout-contract
pnpm typecheck
```

Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/skills.tsx packages/app/src/app/lib/skill-inventory-filters.ts packages/app/src/app/lib/skill-inventory-filters.test.ts packages/app/src/app/pages/skills-layout-contract.test.ts
git commit -m "feat: add bulk skill inventory mode"
```

---

## Phase 8: Copy, Move, Delete, Restore, And Publish Flows

### Task 17: Add Safe Copy And Move Operations

**Files:**
- Create: `packages/app/src/app/lib/skill-location-actions.ts`
- Test: `packages/app/src/app/lib/skill-location-actions.test.ts`
- Modify: `packages/app/src/app/context/extensions.ts`
- Modify: `packages/app/src/app/pages/skills.tsx`

**Step 1: Write failing action tests**

Cover:
- copy creates new installation for same version
- move creates target installation before deleting source
- conflict defaults to skip
- overwrite creates backup/snapshot first
- rename creates new skill slug/version relation

**Step 2: Implement review dialog model**

Before execution, show:
- affected skills
- target locations
- conflicts
- delete/restore implications
- reload impact

**Step 3: Run tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-location-actions
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/app/src/app/lib/skill-location-actions.ts packages/app/src/app/lib/skill-location-actions.test.ts packages/app/src/app/context/extensions.ts packages/app/src/app/pages/skills.tsx
git commit -m "feat: add safe skill location actions"
```

### Task 18: Add Version History And Restore

**Files:**
- Create: `packages/app/src/app/components/skill-version-history.tsx`
- Test: `packages/app/src/app/components/skill-version-history.test.ts`
- Modify: `packages/app/src/app/components/skill-detail-drawer.tsx`
- Modify: `packages/app/src/app/lib/veslo-server.ts`

**Step 1: Write failing tests**

Cover:
- shows immutable versions
- can compare current and previous package manifests
- restore selected version into original location
- restore selected version into another workspace
- deleted installation appears in Recently deleted

**Step 2: Implement restore UI**

Restore must create a new installation/update event rather than mutating old history.

**Step 3: Run tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-version-history
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/app/src/app/components/skill-version-history.tsx packages/app/src/app/components/skill-version-history.test.ts packages/app/src/app/components/skill-detail-drawer.tsx packages/app/src/app/lib/veslo-server.ts
git commit -m "feat: add skill version restore UI"
```

### Task 19: Add Org And System Approval UI

**Files:**
- Create: `packages/app/src/app/components/skill-review-dialog.tsx`
- Test: `packages/app/src/app/components/skill-review-dialog.test.ts`
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Step 1: Write failing tests**

Cover:
- user can request organization publish
- org admin can approve/reject org version
- user can request system publish
- platform admin can approve/reject system version
- package diff shows non-Markdown files

**Step 2: Implement request/review flows**

Approval UI must show:
- metadata diff
- file tree diff
- executable/script warnings
- target scope
- changelog/reason

**Step 3: Run tests**

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-review-dialog
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/app/src/app/components/skill-review-dialog.tsx packages/app/src/app/components/skill-review-dialog.test.ts packages/app/src/app/pages/skills.tsx packages/app/src/app/lib/veslo-server.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat: add skill approval UI"
```

---

## Phase 9: Search And Filtering

### Task 20: Add Server Search Contract And Client

**Files:**
- Modify: `packages/server/src/skill-registry-client.ts`
- Test: `packages/server/src/skill-registry-client.test.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Test: `packages/app/src/app/lib/veslo-server.test.ts`
- Modify: `docs/features/skill-registry-and-distribution.md`

**Step 1: Write failing tests**

Cover query parameters:
- `q`
- `workspaceId`
- `scope`
- `owner`
- `approvalStatus`
- `includeDeleted`
- `language`

**Step 2: Implement client wrappers**

Search returns scored results and matched fields. The app should not implement semantic search locally.

**Step 3: Run tests**

```bash
pnpm --filter veslo-server test -- skill-registry-client
pnpm --filter @neatech/veslo-ui test:unit -- veslo-server
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/server/src/skill-registry-client.ts packages/server/src/skill-registry-client.test.ts packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/veslo-server.test.ts docs/features/skill-registry-and-distribution.md
git commit -m "feat: add skill search client"
```

### Task 21: Implement Multilingual Search In Cloud Backend

This task belongs in the cloud backend if search lives there.

**Files:**
- Create in cloud backend: `src/skills/search-indexer.ts`
- Create in cloud backend: `src/skills/search-route.ts`
- Test in cloud backend: `src/skills/search.test.ts`

**Step 1: Write search tests**

Examples:
- Czech query `zapis ze schuzky` finds English meeting-minutes skill
- workspace filter narrows results
- deleted skills are hidden unless requested
- private user skill does not leak to another user
- org skill is visible only to org members

**Step 2: Implement indexing**

Index:
- name
- description
- trigger
- `SKILL.md`
- text/code files under size limit
- tags
- generated aliases
- embeddings, if available

**Step 3: Implement query expansion**

Use server-side translation/query expansion from UI language to English. Store expansion terms for audit/debugging.

**Step 4: Commit in cloud backend**

```bash
git add src/skills/search-indexer.ts src/skills/search-route.ts src/skills/search.test.ts
git commit -m "feat: add multilingual skill search"
```

---

## Phase 10: Desktop E2E And Runtime Verification

### Task 22: Add Desktop E2E For Materialized Skills

**Files:**
- Create: `packages/e2e/specs/skill-registry-materialization.e2e.ts`
- Modify: `docs/dev/testing-playbook.md`

**Step 1: Write E2E**

Cover:
- start app with a managed global skill
- activate workspace
- verify materialized files exist
- verify agent/runtime skill list sees the skill
- approve/update skill version
- verify active run defers update
- verify idle/reload applies update

**Step 2: Run desktop preflight**

Follow `docs/dev/testing-playbook.md`. Terminate relevant existing dev/test instances from this repo before running.

**Step 3: Run E2E**

```bash
pnpm --filter @neatech/veslo-e2e test -- skill-registry-materialization
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/e2e/specs/skill-registry-materialization.e2e.ts docs/dev/testing-playbook.md
git commit -m "test: verify skill registry materialization"
```

### Task 23: Add Shared Workspace Consistency E2E

**Files:**
- Create: `packages/e2e/specs/shared-workspace-skill-lock.e2e.ts`
- Modify: `docs/features/skill-registry-and-distribution.md`

**Step 1: Write E2E**

Simulate two users or two local profiles:
- both open the same organization workspace clone
- both resolve the same skill set revision
- user A receives org-approved update
- user B receives the same version before runtime start
- personal global skill with same name is blocked from shadowing org-managed skill

**Step 2: Run E2E**

```bash
pnpm --filter @neatech/veslo-e2e test -- shared-workspace-skill-lock
```

Expected: pass.

**Step 3: Commit**

```bash
git add packages/e2e/specs/shared-workspace-skill-lock.e2e.ts docs/features/skill-registry-and-distribution.md
git commit -m "test: verify shared workspace skill consistency"
```

---

## Phase 11: Migration And Backward Compatibility

### Task 24: Adopt Existing Filesystem Skills Into Registry

**Files:**
- Create: `packages/server/src/skill-adoption.ts`
- Test: `packages/server/src/skill-adoption.test.ts`
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/context/extensions.ts`

**Step 1: Write failing tests**

Cover:
- unmanaged local skill can be adopted into personal registry
- unmanaged workspace skill can be adopted into workspace registry
- adoption packs all files
- existing unmanaged files are not overwritten
- adoption creates initial version and installation

**Step 2: Implement adoption flow**

UI labels:
- `Adopt into Veslo registry`
- `Keep unmanaged`

**Step 3: Run tests**

```bash
pnpm --filter veslo-server test -- skill-adoption
pnpm --filter @neatech/veslo-ui test:unit -- skills-layout-contract
pnpm typecheck
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/server/src/skill-adoption.ts packages/server/src/skill-adoption.test.ts packages/app/src/app/pages/skills.tsx packages/app/src/app/context/extensions.ts
git commit -m "feat: adopt existing skills into registry"
```

### Task 25: Update Documentation

**Files:**
- Modify: `docs/dev/documentation-map.md`
- Modify: `docs/dev/app-map.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/features/extensions-and-integrations.md`
- Modify: `docs/features/skill-registry-and-distribution.md`

**Step 1: Update docs**

Document:
- registry source of truth
- managed materialization
- shared workspace lock behavior
- restore model
- approval model
- search model
- unmanaged filesystem fallback

**Step 2: Run doc checks if available**

```bash
pnpm typecheck
git diff --check
```

Expected: pass.

**Step 3: Commit**

```bash
git add docs/dev/documentation-map.md docs/dev/app-map.md docs/dev/state-and-config-reference.md docs/features/extensions-and-integrations.md docs/features/skill-registry-and-distribution.md
git commit -m "docs: document skill registry behavior"
```

---

## Verification Checklist

Run before claiming completion:

```bash
pnpm --filter veslo-server test
pnpm --filter @neatech/veslo-ui test:unit
pnpm typecheck
pnpm --filter veslo-server build:bin
git diff --check
```

For runtime behavior:

```bash
pnpm --filter @neatech/veslo-e2e test -- skill-registry-materialization
pnpm --filter @neatech/veslo-e2e test -- shared-workspace-skill-lock
```

Use the real Tauri desktop runtime for final verification. Do not use UI-only dev servers for runtime confidence.

## Rollout Strategy

1. Ship registry read-only inventory alongside existing filesystem inventory.
2. Add adoption so existing skills can enter the registry.
3. Enable personal global package backup and restore.
4. Enable workspace materialization for opted-in workspaces.
5. Enable organization workspace skill sets and lockfiles.
6. Enable org approval and org catalog.
7. Enable system approval and system catalog.
8. Enable automatic update events and reload prompts.
9. Enable bulk operations after restore and audit are reliable.

## Open Questions Before Implementation

- Is the cloud registry Den, standalone Skill Registry, or part of another backend?
- Should organization workspaces commit `.opencode/veslo.skills.lock.json` by default?
- Should managed package payloads ever be vendored into Git for regulated/offline customers?
- Which roles can approve organization skills?
- Which role is platform admin for system-global skills?
- What is the maximum package size and file count for initial release?
- Should org-shared workspaces allow personal global skills at all, or only non-conflicting personal skills?
- Which search provider will generate multilingual expansion and embeddings?

