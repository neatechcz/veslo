# Global Skills Inventory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Skills page an app-wide inventory of Hub, all-workspace, and workspace-specific skills while leaving Settings unchanged.

**Architecture:** Add explicit skill discovery modes so global skills and workspace-local skills are collected separately. Normalize raw skill instances into grouped inventory records in the app layer, then update the Skills page to render installed skills globally instead of from the active workspace. Keep existing Hub fetch/install plumbing, but require an explicit install target when installing from the global Skills page.

**Tech Stack:** SolidJS, TypeScript, Tauri commands in Rust, Veslo server TypeScript APIs, Node test runner/Vitest-style app tests, WebdriverIO desktop E2E when UI actions become runtime-sensitive.

---

## Preconditions

- Do not resolve unrelated merge conflicts as part of this work.
- Do not remove the existing Settings overview in this implementation.
- Do not start a UI-only dev server.
- For desktop verification, use the real Tauri runtime flow from `docs/dev/testing-playbook.md`.
- Start with TDD for each behavior slice.

## Task 1: Add Local Skill Discovery Modes

**Files:**
- Modify: `packages/desktop/src-tauri/src/commands/skills.rs`
- Modify: `packages/app/src/app/lib/tauri.ts`
- Test: `packages/desktop/src-tauri/src/commands/skills.rs`

**Step 1: Write failing Rust tests for root selection**

Add tests around helper functions so discovery can distinguish:

- workspace-only roots
- global-only roots
- runtime-effective roots

Expected helper shape:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillListScope {
    Workspace,
    Global,
    Effective,
}
```

Expected tests:

```rust
#[test]
fn skill_list_scope_workspace_excludes_global_roots() {
    assert_eq!(SkillListScope::from_str("workspace").unwrap(), SkillListScope::Workspace);
}

#[test]
fn skill_list_scope_global_excludes_project_roots() {
    assert_eq!(SkillListScope::from_str("global").unwrap(), SkillListScope::Global);
}

#[test]
fn skill_list_scope_effective_preserves_existing_behavior() {
    assert_eq!(SkillListScope::from_str("effective").unwrap(), SkillListScope::Effective);
}
```

**Step 2: Run the focused Rust tests**

Run:

```bash
pnpm --filter @neatech/veslo-desktop test
```

Expected: fails until scope parsing/helpers exist. If the package has no direct Rust unit command, use the nearest desktop test command documented in `docs/dev/testing-playbook.md`.

**Step 3: Implement scope-aware root collection**

Change `collect_skill_roots(project_dir: &str)` to accept a scope:

```rust
fn collect_skill_roots(project_dir: &str, scope: SkillListScope) -> Result<Vec<PathBuf>, String> {
    let project_dir = project_dir.trim();
    if project_dir.is_empty() && scope != SkillListScope::Global {
        return Err("projectDir is required".to_string());
    }

    let mut roots = Vec::new();
    if matches!(scope, SkillListScope::Workspace | SkillListScope::Effective) {
        let project_path = PathBuf::from(project_dir);
        roots.extend(collect_project_skill_roots(&project_path));
    }
    if matches!(scope, SkillListScope::Global | SkillListScope::Effective) {
        roots.extend(collect_global_skill_roots());
    }

    dedupe_paths(roots)
}
```

Keep existing `list_local_skills(project_dir)` behavior by making it call the
new mode with `effective`.

Add a new command:

```rust
#[tauri::command]
pub fn list_local_skills_scoped(project_dir: String, scope: String) -> Result<Vec<LocalSkillCard>, String> {
    let scope = SkillListScope::from_str(scope.trim())?;
    let skill_roots = collect_skill_roots(project_dir.trim(), scope)?;
    list_skill_cards_from_roots(skill_roots)
}
```

**Step 4: Add TypeScript wrapper**

In `packages/app/src/app/lib/tauri.ts`:

```ts
export type LocalSkillListScope = "workspace" | "global" | "effective";

export async function listLocalSkillsScoped(
  projectDir: string,
  scope: LocalSkillListScope,
): Promise<LocalSkillCard[]> {
  return invoke<LocalSkillCard[]>("list_local_skills_scoped", { projectDir, scope });
}
```

**Step 5: Run tests and commit**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: pass.

Commit:

```bash
git add packages/desktop/src-tauri/src/commands/skills.rs packages/app/src/app/lib/tauri.ts
git commit -m "feat: split local skill discovery scopes"
```

## Task 2: Create Skill Inventory Model

**Files:**
- Create: `packages/app/src/app/lib/skill-inventory.ts`
- Test: `packages/app/src/app/lib/skill-inventory.test.ts`
- Modify: `packages/app/src/app/types.ts`

**Step 1: Write failing grouping tests**

Create tests for:

- global skill appears once
- workspace-only skill records its workspace
- global plus workspace-local same name becomes `mixed`
- Hub-only skill becomes `hub-only`
- Hub plus installed skill attaches `hubItem`

Example test:

```ts
test("global skills are not repeated under workspaces", () => {
  const items = buildSkillInventory({
    globalSkills: [{ name: "research", path: "/global/research/SKILL.md", scope: "user-global" }],
    workspaceSkillsByWorkspaceId: {
      ws1: {
        workspace: { id: "ws1", label: "Veslo" },
        skills: [],
      },
    },
    hubSkills: [],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.name, "research");
  assert.equal(items[0]?.status, "global");
  assert.equal(items[0]?.workspaceInstances.length, 0);
});
```

**Step 2: Run the failing test**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-inventory
```

Expected: fail because model does not exist.

**Step 3: Implement model and normalizer**

Add types:

```ts
export type SkillInventoryScope = "workspace" | "user-global";
export type SkillInventoryStatus = "global" | "workspace-only" | "mixed" | "hub-only";

export type SkillInventoryWorkspace = {
  id: string;
  label: string;
  path?: string;
  kind: "local" | "remote";
};

export type SkillInstance = {
  id: string;
  name: string;
  scope: SkillInventoryScope;
  workspaceId?: string;
  workspaceLabel?: string;
  path: string;
  description?: string;
  trigger?: string;
  source: "opencode" | "claude" | "agents" | "hub" | "unknown";
  readable: boolean;
  writable: boolean;
};

export type SkillInventoryItem = {
  name: string;
  description?: string;
  trigger?: string;
  globalInstance?: SkillInstance;
  workspaceInstances: SkillInstance[];
  hubItem?: HubSkillCard;
  status: SkillInventoryStatus;
};
```

Implement `buildSkillInventory(...)` as a pure function. Sort by name and sort
workspace instances by workspace label.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-inventory
pnpm typecheck
```

Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/skill-inventory.ts packages/app/src/app/lib/skill-inventory.test.ts packages/app/src/app/types.ts
git commit -m "feat: add global skill inventory model"
```

## Task 3: Add Inventory Loading To Extensions Store

**Files:**
- Modify: `packages/app/src/app/context/extensions.ts`
- Test: `packages/app/src/app/context/extensions-skill-inventory.test.ts` or nearest existing context test

**Step 1: Write failing store behavior test**

Test that the store exposes:

- `skillInventory`
- `skillInventoryStatus`
- `refreshSkillInventory`

The test should mock:

- two local workspaces
- global skill list
- workspace skill list
- hub skill list

Expected: global skill appears once, workspace skill appears under one workspace.

**Step 2: Run failing test**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- extensions-skill-inventory
```

Expected: fail because store API does not exist.

**Step 3: Implement store signals**

Add signals:

```ts
const [skillInventory, setSkillInventory] = createSignal<SkillInventoryItem[]>([]);
const [skillInventoryStatus, setSkillInventoryStatus] = createSignal<string | null>(null);
```

Add `refreshSkillInventory(options?: { force?: boolean })`.

For phase 1 local collection:

- read global skills once via `listLocalSkillsScoped("", "global")`
- for each local workspace, read `listLocalSkillsScoped(workspace.path, "workspace")`
- for remote workspace, add an unavailable workspace state for future UI if needed
- call existing `refreshHubSkills` or reuse loaded `hubSkills()`
- pass all data into `buildSkillInventory`

Do not remove existing `refreshSkills`. Current active-workspace flows may still
use it until the page migration is complete.

**Step 4: Wire store return shape**

Return:

```ts
skillInventory,
skillInventoryStatus,
refreshSkillInventory,
```

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- extensions-skill-inventory
pnpm typecheck
```

Expected: pass.

**Step 6: Commit**

```bash
git add packages/app/src/app/context/extensions.ts packages/app/src/app/context/extensions-skill-inventory.test.ts
git commit -m "feat: load app-wide skill inventory"
```

## Task 4: Pass Inventory Data To Dashboard Skills Page

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/skills.tsx`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`

**Step 1: Write failing layout contract tests**

Add assertions:

- Skills page props include inventory data
- Skills page no longer describes itself as current-workspace-only
- Settings overview remains mounted from Settings
- Hub placeholder still exists

**Step 2: Run failing tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skills-layout-contract
```

Expected: fail until props and copy are updated.

**Step 3: Add props**

In `SkillsViewProps`, add:

```ts
skillInventory: SkillInventoryItem[];
skillInventoryStatus: string | null;
refreshSkillInventory: (options?: { force?: boolean }) => void;
workspaces: WorkspaceInfo[];
```

Keep existing active-workspace props temporarily for edit/install compatibility.

**Step 4: Refresh inventory on navigation**

In dashboard tab refresh logic, when `currentTab === "skills"`, call:

```ts
await Promise.all([
  props.refreshSkillInventory(),
  props.refreshHubSkills(),
]);
```

Do not remove `refreshSkills` until active-workspace-only UI dependencies are
gone or migrated.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skills-layout-contract
pnpm typecheck
```

Expected: pass.

**Step 6: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/skills.tsx packages/app/src/app/pages/skills-layout-contract.test.ts
git commit -m "feat: pass global inventory to skills page"
```

## Task 5: Render Installed Global Inventory

**Files:**
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`

**Step 1: Write failing UI contract tests**

Assert these rendered concepts exist in source:

- Installed view uses `skillInventory`
- Global/all-workspaces label
- Workspace-only label
- Override label
- By workspace view does not render global skills under every workspace

**Step 2: Run failing tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skills-layout-contract
```

Expected: fail until the UI uses inventory.

**Step 3: Add view state**

In `skills.tsx`:

```ts
type SkillsInventoryView = "installed" | "by-workspace" | "hub";
type SkillsInventoryFilter = "all" | "global" | "workspace" | "overrides";
```

Default view: `installed`.

**Step 4: Replace installed list rendering**

Use `props.skillInventory` for installed rendering. Keep Hub rendering from
`props.hubSkills`.

Card rules:

- `global`: badge "All workspaces"
- `workspace-only`: show count and expandable workspace labels
- `mixed`: badge "Override" plus global label
- `hub-only`: only in Hub view unless search/filter includes Hub

**Step 5: Add By Workspace rendering**

Build derived rows from `skillInventory.flatMap(item.workspaceInstances)`.

Do not include `globalInstance` in workspace rows.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skills-layout-contract
pnpm typecheck
```

Expected: pass.

**Step 7: Commit**

```bash
git add packages/app/src/app/pages/skills.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/pages/skills-layout-contract.test.ts
git commit -m "feat: render global skills inventory"
```

## Task 6: Make Hub Install Target Explicit

**Files:**
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/context/extensions.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`

**Step 1: Write failing test**

Assert that Hub install opens target selection instead of directly installing
into the active workspace.

**Step 2: Run failing test**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skills-layout-contract
```

Expected: fail until target picker exists.

**Step 3: Add target picker state**

In `skills.tsx`:

```ts
const [installTargetSkill, setInstallTargetSkill] = createSignal<HubSkillCard | null>(null);
const [selectedInstallScope, setSelectedInstallScope] = createSignal<"global" | "workspace">("workspace");
const [selectedInstallWorkspaceId, setSelectedInstallWorkspaceId] = createSignal<string | null>(null);
```

Target options:

- All workspaces
- Each writable local workspace
- Remote workspaces disabled unless server write support is explicit

**Step 4: Keep implementation conservative**

If global write is not implemented yet, disable "All workspaces" with a clear
message. The design supports it, but phase-1 backend can choose to ship the
picker with only workspace targets enabled.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skills-layout-contract
pnpm typecheck
```

Expected: pass.

**Step 6: Commit**

```bash
git add packages/app/src/app/pages/skills.tsx packages/app/src/app/context/extensions.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/pages/skills-layout-contract.test.ts
git commit -m "feat: require skill install target selection"
```

## Task 7: Add Instance-Safe Edit And Delete Wiring

**Files:**
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/context/extensions.ts`
- Modify: `packages/app/src/app/lib/skill-inventory.ts`
- Test: `packages/app/src/app/lib/skill-inventory.test.ts`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`

**Step 1: Write failing tests**

Assert that edit/delete callbacks carry an instance id or path/scope, not just
`name`.

**Step 2: Run failing tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-inventory skills-layout-contract
```

Expected: fail until callbacks use instances.

**Step 3: Add instance target type**

```ts
export type SkillMutationTarget = {
  name: string;
  path: string;
  scope: "workspace" | "user-global";
  workspaceId?: string;
};
```

**Step 4: Adapt read/save/delete**

Add new store methods while keeping old ones temporarily:

```ts
readSkillInstance(target: SkillMutationTarget): Promise<...>
saveSkillInstance(target: SkillMutationTarget, content: string): Promise<void>
deleteSkillInstance(target: SkillMutationTarget): Promise<void>
```

Global write/delete can be disabled if no safe backend path is present yet.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit -- skill-inventory skills-layout-contract
pnpm typecheck
```

Expected: pass.

**Step 6: Commit**

```bash
git add packages/app/src/app/pages/skills.tsx packages/app/src/app/context/extensions.ts packages/app/src/app/lib/skill-inventory.ts packages/app/src/app/lib/skill-inventory.test.ts packages/app/src/app/pages/skills-layout-contract.test.ts
git commit -m "feat: target skill mutations by instance"
```

## Task 8: Document Shipped Behavior

**Files:**
- Modify: `docs/features/extensions-and-integrations.md`
- Modify: `docs/features/settings-and-preferences.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Update feature docs**

Document:

- Skills is app-wide inventory.
- Settings still contains legacy overview during transition.
- Global skills are user-global runtime skills, not org skills.
- Organization promotion is future work.

**Step 2: Run docs-adjacent checks**

Run:

```bash
pnpm typecheck
```

Expected: pass.

**Step 3: Commit**

```bash
git add docs/features/extensions-and-integrations.md docs/features/settings-and-preferences.md docs/dev/state-and-config-reference.md
git commit -m "docs: document global skills inventory"
```

## Task 9: Desktop Verification

**Files:**
- No code changes expected.
- Optional E2E add if the previous tasks expose stable selectors:
  `packages/e2e/specs/skills-global-inventory.e2e.ts`

**Step 1: Preflight**

Follow `docs/dev/testing-playbook.md`:

- detect running Veslo dev/test processes from this repo
- terminate internally started dev/test instances
- verify no relevant process remains
- launch the intended desktop runtime

**Step 2: Manual fixture**

Create or use test workspaces with:

- one user-global skill
- one workspace-only skill
- one same-name workspace override

**Step 3: Verify UI**

Expected:

- global skill appears once
- workspace-only skill lists its workspace
- override is labeled
- Hub still renders existing catalog/placeholder
- Settings overview still exists

**Step 4: Run automated checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-e2e test
```

Expected: pass, or document any environment-specific skipped E2E reason.

**Step 5: Commit E2E if added**

```bash
git add packages/e2e/specs/skills-global-inventory.e2e.ts
git commit -m "test: cover global skills inventory in desktop"
```

## Final Verification Checklist

- Skills page is not active-workspace-only.
- Hub behavior still uses the existing prepared marketplace flow.
- Settings overview remains unchanged.
- Global skills are not repeated for every workspace.
- Workspace-specific skills and overrides are visible.
- Mutations are instance-safe or disabled until instance-safe support exists.
- Remote workspace limitations are explicit.
- Typecheck passes.
- Relevant unit tests pass.
- Desktop runtime verification is completed or explicitly blocked with reason.
