# Skill Removal and Restore Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make user, workspace, and organization skill removal work outside the active workspace while keeping every removal auditable and restorable.

**Architecture:** Add a lifecycle-aware skill inventory, route all managed skill removal through registry installations or rollout policies, and make unmanaged filesystem deletion write a Veslo-owned removal snapshot before removing runtime files. The app should target the selected skill location, not the active workspace, and should expose removed entries through a restore workflow.

**Tech Stack:** SolidJS app shell, Tauri desktop commands as fallback, Veslo server TypeScript routes, registry proxy client, Node/Bun tests, WebdriverIO desktop E2E.

---

### Task 1: Inventory Lifecycle Model

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/lib/skill-inventory.ts`
- Modify: `packages/app/src/app/lib/skill-inventory-filters.ts`
- Test: `packages/app/src/app/context/extensions-skill-inventory.test.ts`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`

**Step 1: Write failing tests**

Add tests that expect lifecycle metadata to survive inventory construction and filtering:

```ts
assert.equal(item.globalInstance?.lifecycle, "removed");
assert.equal(item.globalInstance?.registry?.installationId, "install_1");
assert.equal(filterSkillInventoryItems(items, { includeDeleted: false }).length, 0);
assert.equal(filterSkillInventoryItems(items, { includeDeleted: true }).length, 1);
```

Also add a layout contract assertion that removed inventory rows can render a restore affordance:

```ts
assert.match(source, /skills\.restore_skill/);
assert.match(source, /lifecycle === "removed"/);
```

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/extensions-skill-inventory.test.ts src/app/pages/skills-layout-contract.test.ts
```

Expected: failures because lifecycle, registry metadata, and removed-row UI are not modeled yet.

**Step 3: Extend types**

Add these shapes in `packages/app/src/app/types.ts`:

```ts
export type SkillInventoryLifecycle = "active" | "removed";

export type SkillInventoryRegistryMetadata = {
  skillId?: string;
  installationId?: string;
  policyId?: string;
  versionId?: string;
  packageSha256?: string;
  source?: ManagedSkillSource;
  removalPolicy?: "user_removable" | "admin_removable" | "locked";
};
```

Extend `SkillInventoryScope` to include organization:

```ts
export type SkillInventoryScope = "workspace" | "user-global" | "organization";
```

Extend `SkillInstance`:

```ts
lifecycle: SkillInventoryLifecycle;
removedAt?: string;
removedBy?: string;
removeReason?: string;
registry?: SkillInventoryRegistryMetadata;
restoreTarget?: {
  scope: SkillInventoryScope;
  workspaceId?: string;
  orgId?: string;
};
```

**Step 4: Preserve defaults**

In `skill-inventory.ts`, set `lifecycle: skill.lifecycle ?? "active"` when normalizing instances. Preserve registry fields when present. Treat `writable` as false for removed rows unless a restore action explicitly supports them.

**Step 5: Filter removed rows**

In `skill-inventory-filters.ts`, make `includeDeleted` mean `instance.lifecycle === "removed"` is included. Default remains active-only.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/extensions-skill-inventory.test.ts src/app/pages/skills-layout-contract.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/types.ts packages/app/src/app/lib/skill-inventory.ts packages/app/src/app/lib/skill-inventory-filters.ts packages/app/src/app/context/extensions-skill-inventory.test.ts packages/app/src/app/pages/skills-layout-contract.test.ts
git commit -m "feat: model removable skill inventory"
```

### Task 2: Local Removal Journal

**Files:**
- Create: `packages/server/src/skill-removal-journal.ts`
- Create: `packages/server/src/skill-removal-journal.test.ts`
- Modify: `packages/server/src/skills.ts`
- Modify: `packages/server/src/server.ts`

**Step 1: Write failing journal tests**

Test snapshot, list, restore, and conflict behavior:

```ts
const record = await removeSkillWithSnapshot({
  dataDir,
  actor: { type: "host" },
  source: { scope: "workspace", workspaceId: "ws_1", rootDir, skillPath },
  reason: "cleanup",
});

expect(await exists(skillDir)).toBe(false);
expect(record.name).toBe("demo-skill");
expect(record.scope).toBe("workspace");

const restored = await restoreSkillRemoval({ dataDir, removalId: record.id });
expect(restored.path.endsWith("demo-skill/SKILL.md")).toBe(true);
```

Add a conflict test:

```ts
await expect(restoreSkillRemoval({ dataDir, removalId: record.id })).rejects.toThrow(/already exists/);
```

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter veslo-server exec bun test src/skill-removal-journal.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement journal**

Create a module with these exported functions:

```ts
export async function removeSkillWithSnapshot(input: RemoveSkillWithSnapshotInput): Promise<SkillRemovalRecord>;
export async function listSkillRemovals(input: ListSkillRemovalsInput): Promise<SkillRemovalRecord[]>;
export async function restoreSkillRemoval(input: RestoreSkillRemovalInput): Promise<{ path: string }>;
```

Store records under the Veslo server data directory:

```text
skill-removals/
  records/<removalId>.json
  snapshots/<removalId>/<skill directory contents>
```

Use recursive copy before recursive remove. Include directory hash, actor, scope,
target ids, original path, removed timestamp, and reason in the record.

**Step 4: Wire workspace delete**

In `packages/server/src/skills.ts`, add a recoverable variant:

```ts
export async function deleteSkillAtPathRecoverable(
  workspaceRoot: string,
  payload: { name: string; path: string },
  journal: SkillRemovalJournalContext,
): Promise<{ path: string; removalId: string }> {
  const skillPath = await resolveExistingWorkspaceSkillPath(workspaceRoot, payload.name.trim(), payload.path);
  const record = await removeSkillWithSnapshot({
    ...journal,
    source: { scope: "workspace", workspaceId: journal.workspaceId, rootDir: workspaceRoot, skillPath },
  });
  return { path: record.originalDir, removalId: record.id };
}
```

Keep existing non-recoverable helpers available for tests or internal code that
does not have journal context.

**Step 5: Add server routes**

In `server.ts`, add host/client routes for listing and restoring local removals:

```ts
GET /skill-removals
POST /skill-removals/:id/restore
```

Query filters:

```text
scope=user-global|workspace
workspaceId=<id>
includeRestored=true|false
```

Modify `DELETE /workspace/:id/skills/:name` to use the recoverable delete path
for unmanaged filesystem skills.

**Step 6: Run server tests**

Run:

```bash
pnpm --filter veslo-server exec bun test src/skill-removal-journal.test.ts src/server.skill-registry-search.test.ts
```

Expected: PASS.

**Step 7: Rebuild server binary**

Because `packages/server/src` changed, run:

```bash
pnpm --filter veslo-server build:bin
```

Expected: server binary builds successfully.

**Step 8: Commit**

```bash
git add packages/server/src/skill-removal-journal.ts packages/server/src/skill-removal-journal.test.ts packages/server/src/skills.ts packages/server/src/server.ts
git commit -m "feat: snapshot removed local skills"
```

### Task 3: Registry Remove and Restore Store Actions

**Files:**
- Modify: `packages/app/src/app/context/extensions.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Test: `packages/app/src/app/context/extensions-skill-inventory.test.ts`
- Test: `packages/server/src/server.skill-registry-search.test.ts`

**Step 1: Write failing tests**

Add tests that verify:

- registry installation delete calls `deleteRegistrySkillInstallation`
- registry installation restore calls `restoreRegistrySkillInstallation`
- org rollout remove uses `updateRegistrySkillRolloutPolicy` with `enabled: false`
- org rollout restore uses `enabled: true`
- Den token, org id, and user id are included

Example app test shape:

```ts
await store.removeSkillInstance({
  name: "org-helper",
  scope: "organization",
  path: "",
  registry: { policyId: "policy_1", source: "organization", removalPolicy: "admin_removable" },
});

assert.deepEqual(client.updateRegistrySkillRolloutPolicy.calls[0], {
  policyId: "policy_1",
  enabled: false,
  denOrgId: "org-1",
});
```

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/extensions-skill-inventory.test.ts
pnpm --filter veslo-server exec bun test src/server.skill-registry-search.test.ts
```

Expected: FAIL because store actions do not support registry-backed removal.

**Step 3: Add client methods if missing**

Ensure `VesloServerClient` exposes:

```ts
deleteRegistrySkillInstallation(installationId: string, input?: VesloSkillRegistryAuthContext)
restoreRegistrySkillInstallation(installationId: string, input: VesloSkillRegistryRestoreInstallationInput)
updateRegistrySkillRolloutPolicy(policyId: string, input: VesloSkillRegistryUpdateRolloutPolicyInput)
```

Use existing request helpers and `buildDenContextHeaders`.

**Step 4: Implement store actions**

In `extensions.ts`, add separate action paths:

```ts
removeSkillInstance(target: SkillMutationTarget): Promise<SkillSaveResult>
restoreSkillInstance(target: SkillMutationTarget): Promise<SkillSaveResult>
```

Decision order:

1. If `target.registry.installationId`, call registry installation delete/restore.
2. If `target.registry.policyId`, call rollout enable/disable.
3. If `target.scope === "user-global"`, use local user-global removal route.
4. If `target.scope === "workspace"`, use target workspace id/path.
5. Otherwise return a clear unavailable message.

Block `removalPolicy === "locked"`.

**Step 5: Refresh after mutation**

After success:

```ts
await refreshSkillInventory({ force: true });
await refreshHubSkills({ force: true });
```

Mark reload required only when the affected target is the active workspace or
user-global runtime for the active workspace.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/extensions-skill-inventory.test.ts
pnpm --filter veslo-server exec bun test src/server.skill-registry-search.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/context/extensions.ts packages/app/src/app/lib/veslo-server.ts packages/app/src/app/context/extensions-skill-inventory.test.ts packages/server/src/server.skill-registry-search.test.ts
git commit -m "feat: remove and restore managed skills"
```

### Task 4: Non-active Workspace and User-global Removal

**Files:**
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/context/extensions.ts`
- Modify: `packages/app/src/app/lib/tauri.ts`
- Modify: `packages/desktop/src-tauri/src/commands/skills.rs`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`
- Test: `packages/app/src/app/context/extensions-skill-inventory.test.ts`

**Step 1: Write failing tests**

Update the existing active-workspace-only tests to require target workspace
support:

```ts
assert.doesNotMatch(source, /workspaceId !== props\.activeWorkspaceId/);
assert.match(source, /removeMutationTargetForInstance/);
assert.match(source, /instance\.scope === "user-global"/);
```

Add store tests that remove a workspace skill from a non-active local workspace
using that workspace path.

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/skills-layout-contract.test.ts src/app/context/extensions-skill-inventory.test.ts
```

Expected: FAIL because UI and store still gate removal by active workspace.

**Step 3: Retarget UI helpers**

In `skills.tsx`, replace active-workspace delete gating with a helper:

```ts
const removeMutationTargetForInstance = (instance: SkillInstance): SkillMutationTarget | null => {
  if (instance.lifecycle === "removed") return null;
  if (instance.registry?.removalPolicy === "locked") return null;
  if (instance.scope === "user-global") return skillMutationTargetFromInstance(instance);
  if (instance.scope === "workspace" && instance.workspaceId) return skillMutationTargetFromInstance(instance);
  if (instance.scope === "organization" && (instance.registry?.installationId || instance.registry?.policyId)) {
    return skillMutationTargetFromInstance(instance);
  }
  return null;
};
```

Use a separate restore helper for removed rows.

**Step 4: Resolve target workspace in store**

In `extensions.ts`, when removing workspace scope:

```ts
const configuredWorkspace = target.workspaceId
  ? (options.workspaces?.() ?? []).find((workspace) => workspace.id === target.workspaceId)
  : null;
const sourceRoot = configuredWorkspace?.path?.trim() || configuredWorkspace?.directory?.trim() || "";
```

Do not compare target workspace id against active workspace id except for reload
marking.

**Step 5: Add user-global local removal path**

Prefer server routes when connected. Keep Tauri fallback only for local desktop
mode if the server route is unavailable. The fallback must still snapshot before
delete; if that is not possible in Tauri yet, hide fallback deletion and require
server connection.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/skills-layout-contract.test.ts src/app/context/extensions-skill-inventory.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/pages/skills.tsx packages/app/src/app/context/extensions.ts packages/app/src/app/lib/tauri.ts packages/desktop/src-tauri/src/commands/skills.rs packages/app/src/app/pages/skills-layout-contract.test.ts packages/app/src/app/context/extensions-skill-inventory.test.ts
git commit -m "feat: remove skills outside active workspace"
```

### Task 5: Restore Skills UI

**Files:**
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/components/skill-detail-drawer.tsx`
- Modify: `packages/app/src/app/components/skill-version-history.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`
- Test: `packages/app/src/app/components/skill-version-history.test.ts`

**Step 1: Write failing UI contract tests**

Assert the UI exposes:

```ts
assert.match(source, /skills\.restore_skills/);
assert.match(source, /skills\.removed_status/);
assert.match(source, /onRestoreSkill/);
assert.match(skillDetailDrawerSource, /Restore/);
```

Assert localized keys exist in English, Czech, and Chinese.

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/skills-layout-contract.test.ts src/app/components/skill-version-history.test.ts
```

Expected: FAIL because restore UI is missing.

**Step 3: Add restore entry points**

In `skills.tsx`:

- add a `Restore skills` button near inventory filters
- make the existing deleted filter visible and understandable
- render removed rows with a `Removed` badge
- show restore button for removed rows
- route restore clicks to `props.restoreSkillInstance(target)`

**Step 4: Update detail drawer actions**

Add restore actions to location rows and overview:

```ts
export type SkillDetailAction = "copy" | "move" | "publish" | "requestApproval" | "restore" | "delete";
onRestoreSkill?: (input: SkillDetailActionInput) => void;
```

Use exact location input, not only the skill-level metadata.

**Step 5: Add confirmation copy**

Remove confirmation text should include target impact. Restore confirmation
should include destination and conflict warning.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/skills-layout-contract.test.ts src/app/components/skill-version-history.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/pages/skills.tsx packages/app/src/app/components/skill-detail-drawer.tsx packages/app/src/app/components/skill-version-history.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/pages/skills-layout-contract.test.ts packages/app/src/app/components/skill-version-history.test.ts
git commit -m "feat: add skill restore interface"
```

### Task 6: Desktop E2E Coverage

**Files:**
- Create or modify: `packages/e2e/specs/skills-removal-restore.e2e.ts`
- Modify: `docs/dev/testing-playbook.md` only if the test workflow changes

**Step 1: Write failing E2E tests**

Cover:

1. user skill remove and restore
2. non-active workspace skill remove and restore
3. locked org skill cannot be removed

Use stable selectors already present on the skills inventory and add new
selectors where needed:

```ts
await $('[data-testid="skill-restore-button"]').click();
await expect($('[data-skill-inventory-name="demo-skill"]')).toBeDisplayed();
```

**Step 2: Run E2E preflight**

Follow `docs/dev/testing-playbook.md`:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/skills-removal-restore.e2e.ts
```

Expected before implementation: FAIL at missing UI/action.

**Step 3: Add missing selectors and fixtures**

If the test needs fixtures, create temporary user and workspace skill directories
inside the E2E temp workspace. Mock registry responses for org owner and locked
policy cases through existing test server patterns.

**Step 4: Run E2E**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/skills-removal-restore.e2e.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/e2e/specs/skills-removal-restore.e2e.ts packages/app/src/app/pages/skills.tsx docs/dev/testing-playbook.md
git commit -m "test: cover skill removal restore flows"
```

### Task 7: Documentation and Final Verification

**Files:**
- Modify: `docs/features/skill-registry-and-distribution.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/app-map.md` only if new files are canonical entry points

**Step 1: Update durable docs**

Document:

- remove vs permanent package deletion
- local removal journal
- restore semantics
- organization owner behavior
- locked policy behavior

**Step 2: Run focused checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/context/extensions-skill-inventory.test.ts src/app/pages/skills-layout-contract.test.ts src/app/components/skill-version-history.test.ts
pnpm --filter veslo-server exec bun test src/skill-removal-journal.test.ts src/server.skill-registry-search.test.ts
pnpm --filter veslo-server build:bin
```

Expected: all commands pass.

**Step 3: Run desktop E2E**

Follow the testing playbook preflight, then run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/skills-removal-restore.e2e.ts
```

Expected: PASS.

**Step 4: Commit docs and any final fixes**

```bash
git add docs/features/skill-registry-and-distribution.md docs/dev/state-and-config-reference.md docs/dev/app-map.md
git commit -m "docs: document skill removal restore behavior"
```

**Step 5: Final status**

Run:

```bash
git status --short
```

Expected: no uncommitted files.

## Open Implementation Decisions

- If registry does not expose deleted installation listing yet, add that to the
  registry API before full restore UI ships. Until then, local UI can restore
  only records it already has in inventory metadata.
- If org role names vary, centralize `isOrganizationOwnerOrAdmin` behind Den
  auth helpers rather than checking raw strings in UI components.
- If user-global unmanaged deletion cannot be made recoverable through Tauri
  fallback, require connected local Veslo server for that action.

## Execution Options

Plan complete and saved. Two execution options:

**1. Subagent-Driven (this session)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Parallel Session (separate)** - open a new session with executing-plans, batch execution with checkpoints.

Which approach?
