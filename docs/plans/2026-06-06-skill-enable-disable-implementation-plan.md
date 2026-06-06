# Skill Enable And Disable Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-skill enable/disable controls to the Skills inventory and prevent disabled skills from being passed to agents.

**Architecture:** Store user/workspace skill disable overrides in Veslo server-owned state, then apply those overrides before any agent-facing skill list or skill resolve result is returned. Keep inventory complete by showing enabled and disabled local, user-global, workspace, organization, and platform skills, with read-only organization/platform skills limited to metadata plus personal enable/disable.

**Tech Stack:** TypeScript, Bun server tests, SolidJS, Tauri commands, WebdriverIO desktop E2E, jsonc-parser, existing Veslo server and app clients.

---

## Preflight

Before touching code:

- Read `docs/plans/2026-06-06-skill-enable-disable-design.md`.
- Read `AGENTS.md`, `packages/app/AGENTS.md`, `packages/server/AGENTS.md`, and `packages/desktop/AGENTS.md`.
- Use @test-driven-development for every behavior change.
- Use @systematic-debugging if a test fails unexpectedly.
- Use @verification-before-completion before claiming the implementation is done.
- When editing `packages/app/src/**/*.tsx`, follow `.opencode/skills/solidjs-patterns/SKILL.md`.
- The current worktree may contain unrelated dirty changes. Run `git status --short` and inspect any file before editing if it already has modifications. Stage and commit only files from the task currently being completed.

## Implementation Decisions

- Store personal disable overrides server-side, not inside skill packages.
- Use disabled rows as the persisted model. Default is enabled.
- Keep registry admin rollout mutation separate from the user-facing switch.
- Treat read-only organization/platform skills as metadata-only rows. Users can toggle them for personal use, but cannot inspect full skill content or mutate the package.
- Add `platform` as a first-class app inventory scope.
- Server runtime routes filter disabled skills by default. Inventory routes use an explicit include-disabled mode.

## Proposed Server Data Shape

Create a small store under the Veslo server data directory:

```ts
export type SkillEnabledScope = "workspace" | "user-global" | "organization" | "platform";

export type SkillEnabledRegistryIdentity = {
  skillId?: string;
  installationId?: string;
  policyId?: string;
  versionId?: string;
  source?: "personal" | "workspace" | "organization" | "platform";
};

export type DisabledSkillRecord = {
  id: string;
  name: string;
  scope: SkillEnabledScope;
  workspaceId?: string;
  path?: string;
  registry?: SkillEnabledRegistryIdentity;
  disabledAt: string;
  disabledBy?: string;
};

export type SkillEnabledOverridesDocument = {
  schemaVersion: 1;
  disabled: DisabledSkillRecord[];
};
```

Use deterministic ids so repeated toggles are idempotent. Prefer this order:

1. `registry.policyId`
2. `registry.installationId`
3. `scope + workspaceId + normalized path`
4. `scope + workspaceId + name`

---

### Task 1: Server Override Store

**Files:**
- Create: `packages/server/src/skill-enabled-overrides.ts`
- Create: `packages/server/src/skill-enabled-overrides.test.ts`
- Modify: `packages/server/src/types.ts`

**Step 1: Write failing store tests**

Add tests for:

- empty missing store returns no disabled records
- disabling a local workspace skill writes one record
- disabling the same record twice is idempotent
- enabling removes the matching record
- registry `policyId` wins over path when building the id
- corrupt JSON returns a typed `ApiError` or falls back only if the chosen local convention already does that elsewhere

Example test shape:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  listDisabledSkills,
  setSkillEnabledState,
} from "./skill-enabled-overrides.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test("setSkillEnabledState disables and re-enables a workspace skill", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-skill-enabled-"));
  tempDirs.push(dataDir);

  await setSkillEnabledState({
    dataDir,
    target: {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
      path: "/workspace/.opencode/skills/research-helper/SKILL.md",
    },
    enabled: false,
    actor: { type: "host" },
  });

  expect(await listDisabledSkills({ dataDir, workspaceId: "ws_1" })).toMatchObject([
    {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
    },
  ]);

  await setSkillEnabledState({
    dataDir,
    target: {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
      path: "/workspace/.opencode/skills/research-helper/SKILL.md",
    },
    enabled: true,
    actor: { type: "host" },
  });

  expect(await listDisabledSkills({ dataDir, workspaceId: "ws_1" })).toEqual([]);
});
```

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter veslo-server exec bun test src/skill-enabled-overrides.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement minimal store**

Implement:

```ts
export type SetSkillEnabledStateInput = {
  dataDir?: string;
  target: DisabledSkillTarget;
  enabled: boolean;
  actor?: Actor;
};

export async function listDisabledSkills(input?: {
  dataDir?: string;
  workspaceId?: string;
  includeGlobal?: boolean;
}): Promise<DisabledSkillRecord[]> {
  // Read `${resolveVesloDataDir(dataDir)}/skill-enabled-overrides.json`.
  // Return all global records plus workspace records matching workspaceId.
}

export async function setSkillEnabledState(input: SetSkillEnabledStateInput): Promise<{
  ok: true;
  enabled: boolean;
  record?: DisabledSkillRecord;
}> {
  // Validate name, scope, and safe optional identity.
  // If enabled=false, upsert deterministic record.
  // If enabled=true, remove deterministic record.
  // Write atomically: temp file then rename.
}

export function disabledSkillRecordMatchesTarget(
  record: DisabledSkillRecord,
  target: DisabledSkillTarget,
): boolean {
  // Use deterministic id equality.
}
```

Use existing helpers:

- `resolveVesloDataDir` from `packages/server/src/audit.ts`
- `ensureDir` from `packages/server/src/utils.ts`
- `validateSkillName` from `packages/server/src/validators.ts`

**Step 4: Run store tests**

Run:

```bash
pnpm --filter veslo-server exec bun test src/skill-enabled-overrides.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/skill-enabled-overrides.ts packages/server/src/skill-enabled-overrides.test.ts packages/server/src/types.ts
git commit -m "feat(server): store skill enabled overrides"
```

---

### Task 2: Server Routes And Runtime Filtering

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/skills.ts`
- Modify: `packages/server/src/types.ts`
- Test: `packages/server/src/server.skill-enabled-overrides.test.ts`
- Test: `packages/server/src/skills.test.ts`

**Step 1: Write failing API and filter tests**

Add server tests for:

- `GET /skills/disabled` returns disabled records
- `PATCH /skills/enabled-state` disables a workspace skill and emits a skills reload event
- `GET /workspace/:id/skills?includeGlobal=true` excludes disabled skills by default
- `GET /workspace/:id/skills?includeGlobal=true&includeDisabled=true` includes disabled skills with `enabled: false`
- `POST /workspace/:id/skills/resolve` ignores disabled skills

Example server test route assertions:

```ts
test("disabled skills are excluded from runtime skill list and resolve", async () => {
  const workspaceRoot = await makeWorkspaceWithSkill("research-helper");
  const server = await startTestServer({ workspaceRoot });

  await fetch(`${server.baseUrl}/skills/enabled-state`, {
    method: "PATCH",
    headers: server.headers,
    body: JSON.stringify({
      enabled: false,
      target: {
        name: "research-helper",
        scope: "workspace",
        workspaceId: server.workspaceId,
        path: `${workspaceRoot}/.opencode/skills/research-helper/SKILL.md`,
      },
    }),
  });

  const runtimeList = await getJson(`${server.baseUrl}/workspace/${server.workspaceId}/skills?includeGlobal=true`);
  expect(runtimeList.items.map((item: { name: string }) => item.name)).not.toContain("research-helper");

  const inventoryList = await getJson(`${server.baseUrl}/workspace/${server.workspaceId}/skills?includeGlobal=true&includeDisabled=true`);
  expect(inventoryList.items.find((item: { name: string }) => item.name === "research-helper")).toMatchObject({
    enabled: false,
  });

  const resolved = await postJson(`${server.baseUrl}/workspace/${server.workspaceId}/skills/resolve`, {
    text: "use research-helper skill",
    includeGlobal: true,
  });
  expect(resolved.match).toBeNull();
});
```

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter veslo-server exec bun test src/skill-enabled-overrides.test.ts src/server.skill-enabled-overrides.test.ts src/skills.test.ts
```

Expected: FAIL because routes and filtering are missing.

**Step 3: Extend skill list types**

In `packages/server/src/types.ts`, extend `SkillItem`:

```ts
export interface SkillItem {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  enabled?: boolean;
  disabledReason?: "user";
  trigger?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  aliases?: string[];
  whenToUse?: string;
  paths?: string[];
}
```

**Step 4: Filter in `listSkills`**

Change `listSkills` to accept options:

```ts
export type ListSkillsOptions = {
  includeGlobal: boolean;
  includeDisabled?: boolean;
  disabledSkills?: DisabledSkillRecord[];
  workspaceId?: string;
};

export async function listSkills(workspaceRoot: string, includeGlobalOrOptions: boolean | ListSkillsOptions): Promise<SkillItem[]> {
  const options = typeof includeGlobalOrOptions === "boolean"
    ? { includeGlobal: includeGlobalOrOptions }
    : includeGlobalOrOptions;

  // Build items as today.
  // Mark each item enabled=false if a disabled record matches by name/path/scope.
  // Filter disabled items before de-duping when includeDisabled is false, so an enabled
  // workspace override can still appear if a disabled global skill with the same name exists.
}
```

Use a helper that maps server scopes:

```ts
const disabledScopeForSkillItem = (item: SkillItem): "workspace" | "user-global" =>
  item.scope === "project" ? "workspace" : "user-global";
```

**Step 5: Add routes**

Add these before `/workspace/:id/skills/:name`:

```ts
addRoute(routes, "GET", "/skills/disabled", "client", async (ctx) => {
  const workspaceId = trimmedSearchParam(ctx.url.searchParams, "workspaceId");
  return jsonResponse({
    items: await listDisabledSkills({ dataDir: serverDataDir, workspaceId, includeGlobal: true }),
  });
});

addRoute(routes, "PATCH", "/skills/enabled-state", "client", async (ctx) => {
  ensureWritable(config);
  requireClientScope(ctx, "collaborator");
  const body = await readJsonBody(ctx.request);
  const target = requireBodyObject(body, "target") as DisabledSkillTarget;
  const enabled = optionalBodyBoolean(body, "enabled");
  if (enabled === undefined) throw new ApiError(400, "invalid_enabled", "enabled is required");
  const result = await setSkillEnabledState({
    dataDir: serverDataDir,
    target,
    enabled,
    actor: ctx.actor ?? { type: "remote" },
  });
  const workspace = target.workspaceId ? await resolveWorkspace(config, target.workspaceId).catch(() => null) : null;
  if (workspace) {
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name: target.name,
      action: "updated",
      path: target.path,
    });
  }
  return jsonResponse(result);
});
```

Then update:

- `GET /workspace/:id/skills`
- `POST /workspace/:id/skills/resolve`
- `GET /workspace/:id/skills/:name`

to pass disabled records into `listSkills`. Default runtime routes should exclude disabled records. Inventory callers can request `includeDisabled=true`.

**Step 6: Run server tests**

Run:

```bash
pnpm --filter veslo-server exec bun test src/skill-enabled-overrides.test.ts src/server.skill-enabled-overrides.test.ts src/skills.test.ts src/skill-resolver.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/skills.ts packages/server/src/types.ts packages/server/src/server.skill-enabled-overrides.test.ts packages/server/src/skills.test.ts
git commit -m "feat(server): filter disabled skills from runtime lists"
```

---

### Task 3: App Client Types And Inventory Mapping

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/lib/skill-inventory.ts`
- Modify: `packages/app/src/app/lib/skill-inventory-filters.ts`
- Modify: `packages/app/src/app/context/extensions.ts`
- Test: `packages/app/src/app/lib/skill-inventory.test.ts`
- Test: `packages/app/src/app/lib/skill-inventory-filters.test.ts`
- Test: `packages/app/src/app/lib/veslo-server.test.ts`
- Test: `packages/app/src/app/context/extensions-skill-inventory.test.ts`

**Step 1: Write failing app model tests**

Add tests for:

- `buildSkillInventory` accepts a `platform` skill instance
- materialization metadata with `source: "platform"` maps to scope `platform`
- disabled records from the server mark matching inventory instances `enabled: false`
- platform rows are searchable/filterable by scope
- read-only platform rows default to `readable: false` and `writable: false`

Example inventory test:

```ts
test("platform managed materialization becomes a platform inventory instance", () => {
  const items = buildSkillInventory({
    globalSkills: [
      {
        name: "platform-review",
        path: "/global/veslo-managed/platform-review/SKILL.md",
        scope: "platform",
        registry: {
          policyId: "policy_platform_review",
          source: "platform",
          removalPolicy: "locked",
        },
        readable: false,
        writable: false,
      },
    ],
    workspaceSkillsByWorkspaceId: {},
    hubSkills: [],
  });

  expect(items[0]?.globalInstance).toMatchObject({
    scope: "platform",
    enabled: true,
    readable: false,
    writable: false,
  });
});
```

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: FAIL in the new tests because `platform` and enabled state are not supported everywhere.

**Step 3: Update app types**

In `packages/app/src/app/types.ts`:

```ts
export type SkillInventoryScope = "workspace" | "user-global" | "organization" | "platform";

export type SkillInstance = {
  // existing fields
  enabled: boolean;
  enabledSource?: "default" | "user-override" | "registry";
  readable: boolean;
  writable: boolean;
};
```

**Step 4: Update `skill-inventory.ts`**

- Add `platform` to `SKILL_SCOPES`.
- Default `enabled` to `skill.enabled ?? true`.
- If registry source is `organization` or `platform`, force read-only defaults:

```ts
const isReadOnlyManagedScope = (scope: SkillInventoryScope) =>
  scope === "organization" || scope === "platform";

const readable = skill.readable ?? !isReadOnlyManagedScope(scope);
const writable = lifecycle === "removed" ? false : skill.writable ?? (!defaultManagedReadOnly && defaultWritable);
```

Be careful not to make normal user-global skills unreadable.

**Step 5: Update server client**

Add types and methods in `packages/app/src/app/lib/veslo-server.ts`:

```ts
export type VesloDisabledSkillItem = {
  id: string;
  name: string;
  scope: "workspace" | "user-global" | "organization" | "platform";
  workspaceId?: string;
  path?: string;
  registry?: SkillInventoryRegistryMetadata;
  disabledAt: string;
};

listDisabledSkills: (input?: { workspaceId?: string }) =>
  requestJson<{ items: VesloDisabledSkillItem[] }>(baseUrl, buildDisabledSkillsPath(input), { token, hostToken });

setSkillEnabledState: (input: { target: SkillMutationTarget; enabled: boolean }) =>
  requestJson<{ ok: true; enabled: boolean }>(baseUrl, "/skills/enabled-state", {
    token,
    hostToken,
    method: "PATCH",
    body: input,
  });
```

Add tests in `veslo-server.test.ts` that assert the request path and PATCH body.

**Step 6: Update `extensions.ts` inventory refresh**

In `refreshSkillInventory`:

- Load disabled skills from `vesloClient.listDisabledSkills({ workspaceId: activeWorkspaceId })` when connected.
- Build a disabled index keyed with the same priority as the server.
- While attaching materialization metadata, map registry source to inventory scope:

```ts
const scopeFromRegistrySource = (
  source: SkillInventorySkillInput["registry"] extends infer R ? never : never,
  fallback: SkillInventorySkillInput["scope"],
) => {
  if (source === "organization") return "organization";
  if (source === "platform") return "platform";
  return fallback;
};
```

Use real local types rather than the illustrative conditional above.

- Mark matching skills:

```ts
return {
  ...skill,
  scope: scopeFromRegistrySource(registry.source, skill.scope),
  enabled: !disabledIndex.has(disabledKeyForSkill(skill, registry)),
  enabledSource: disabledIndex.has(...) ? "user-override" : "default",
  readable: registry.source === "organization" || registry.source === "platform" ? false : skill.readable,
  writable: registry.source === "organization" || registry.source === "platform" ? false : skill.writable,
};
```

**Step 7: Run app model tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS for app unit tests.

**Step 8: Commit**

```bash
git add packages/app/src/app/types.ts packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/skill-inventory.ts packages/app/src/app/lib/skill-inventory-filters.ts packages/app/src/app/context/extensions.ts packages/app/src/app/lib/skill-inventory.test.ts packages/app/src/app/lib/skill-inventory-filters.test.ts packages/app/src/app/lib/veslo-server.test.ts packages/app/src/app/context/extensions-skill-inventory.test.ts
git commit -m "feat(app): model disabled and platform skills"
```

---

### Task 4: Skills Page Switches And Read-Only Gating

**Files:**
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/components/skill-detail-drawer.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Test: `packages/app/src/app/pages/skills-layout-contract.test.ts`
- Test: `packages/app/src/app/app-overlay-i18n.test.ts`

**Step 1: Write failing UI contract tests**

Add source-level tests that assert:

- card and table rows include `data-testid="skill-enabled-switch"`
- bulk buttons include `skills-bulk-enable-button` and `skills-bulk-disable-button`
- `platform` label key exists
- read-only actions are gated by `readable` and `writable`

Example source assertion:

```ts
test("skills page renders enable switches for inventory cards and table rows", () => {
  const source = readFileSync(resolve(__dirname, "skills.tsx"), "utf8");
  assert.match(source, /data-testid="skill-enabled-switch"/);
  assert.match(source, /setSkillEnabledState/);
});
```

**Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: FAIL until UI strings and switches exist.

**Step 3: Add SkillsView props**

Extend `SkillsViewProps`:

```ts
setSkillEnabledState: (target: SkillMutationTarget, enabled: boolean) => Promise<SkillSaveResult>;
batchSetSkillEnabledState?: (targets: SkillMutationTarget[], enabled: boolean) => Promise<SkillSaveResult>;
```

Wire these from `createExtensionsStore` through `app.tsx` where other skill mutation props are passed.

**Step 4: Add single-row switch handler**

In `skills.tsx`:

```ts
const [enablePendingIds, setEnablePendingIds] = createSignal<Set<string>>(new Set());

const setInventoryInstanceEnabled = async (instance: SkillInstance, enabled: boolean) => {
  const id = skillInventoryInstanceId(instance);
  setEnablePendingIds((prev) => new Set(prev).add(id));
  try {
    const result = await props.setSkillEnabledState(skillMutationTargetFromInstance(instance), enabled);
    setToast(result.message ?? translate(enabled ? "skills.enabled" : "skills.disabled"));
    props.refreshSkillInventory({ force: true });
    props.refreshSkills({ force: true });
  } catch (error) {
    setToast(error instanceof Error ? error.message : translate("skills.enabled_toggle_failed"));
  } finally {
    setEnablePendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }
};
```

**Step 5: Render switches**

Add switch controls in `renderInventoryCard` and table rows:

```tsx
<label
  class="inline-flex items-center gap-2"
  onClick={(event) => event.stopPropagation()}
>
  <span class="sr-only">{translate(input.instance.enabled ? "skills.disable_skill" : "skills.enable_skill")}</span>
  <input
    data-testid="skill-enabled-switch"
    type="checkbox"
    role="switch"
    checked={input.instance.enabled}
    disabled={enablePendingIds().has(selectionId())}
    onChange={(event) => void setInventoryInstanceEnabled(input.instance, event.currentTarget.checked)}
  />
</label>
```

Use existing visual design classes or a small local switch style. Keep dimensions stable.

**Step 6: Add disabled badge and platform label**

Add i18n keys:

- `skills.enabled`
- `skills.disabled`
- `skills.enable_skill`
- `skills.disable_skill`
- `skills.enabled_toggle_failed`
- `skills.detail_scope_platform`
- `skills.bulk_enable`
- `skills.bulk_disable`
- `skills.read_only_metadata_only`

Update `scopeLabel()` and detail location scope handling to include `platform`.

**Step 7: Gate read-only actions**

Make these false for read-only organization/platform rows:

- reveal location
- edit
- copy/move
- install to workspace
- publish/request approval from local
- delete/remove
- full-content read

Use `instance.readable === false` and `instance.writable === false`, not only scope checks. Detail drawer can still open as metadata-only.

**Step 8: Add bulk enable/disable**

Add selected target memos:

```ts
const selectedEnableTargets = createMemo(() =>
  selectedInventoryRows()
    .map((row) => skillMutationTargetFromInstance(row.instance))
);
```

Add buttons:

```tsx
<Button data-testid="skills-bulk-enable-button" onClick={() => void setSelectedSkillsEnabled(true)}>
  {translate("skills.bulk_enable")}
</Button>
<Button data-testid="skills-bulk-disable-button" onClick={() => void setSelectedSkillsEnabled(false)}>
  {translate("skills.bulk_disable")}
</Button>
```

These are allowed for mixed read-only/writable selections. Existing transfer/remove actions keep their current scope restrictions.

**Step 9: Run app UI tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 10: Commit**

```bash
git add packages/app/src/app/pages/skills.tsx packages/app/src/app/components/skill-detail-drawer.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/pages/skills-layout-contract.test.ts packages/app/src/app/app-overlay-i18n.test.ts
git commit -m "feat(app): add skill enable switches"
```

---

### Task 5: Session Capabilities Disabled State

**Files:**
- Modify: `packages/app/src/app/lib/session-capabilities.ts`
- Modify: the component that renders session capability skills if it needs a status field
- Test: `packages/app/src/app/lib/session-capabilities.test.ts` or nearest existing session capabilities test

**Step 1: Write failing test**

Add a test that disabled skills stay visible as disabled in the session capabilities snapshot:

```ts
test("buildSessionSkillRows marks disabled skills", () => {
  const rows = buildSessionSkillRows([
    {
      name: "platform-review",
      status: "global",
      workspaceInstances: [],
      globalInstance: {
        id: "platform:platform-review",
        name: "platform-review",
        scope: "platform",
        path: "",
        source: "unknown",
        enabled: false,
        readable: false,
        writable: false,
      },
    },
  ]);

  assert.equal(rows[0]?.status, "disabled");
});
```

**Step 2: Run test and verify failure**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: FAIL because skill capability rows have no status.

**Step 3: Add row status**

Extend `SessionSkillCapabilityRow`:

```ts
status: "available" | "disabled";
```

Map `instance.enabled === false` to `disabled`.

If the UI currently assumes every row is available, update rendering to show the disabled label without making the right menu noisy.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/session-capabilities.ts packages/app/src/app/lib/session-capabilities.test.ts
git commit -m "feat(app): show disabled skill capabilities"
```

---

### Task 6: Desktop E2E Coverage

**Files:**
- Create: `packages/e2e/specs/skill-enable-disable.e2e.ts`
- Modify: `packages/e2e/helpers/skill-registry-fixture.ts`
- Possibly modify: `packages/e2e/specs/session-capabilities.spec.ts`

**Step 1: Extend registry fixture**

Add a platform rollout fixture:

```ts
const platformRolloutTool = fixtureSkill({
  name: "platform-rollout-tool",
  skillId: "skill_e2e_platform_rollout_tool",
  installationId: "rollout:policy_e2e_platform_rollout_tool",
  versionId: "version_platform_rollout_tool_1",
  source: "platform",
  description: "Platform rollout tool materialized into user skills.",
});
```

Update types so `FixtureSkill["source"]` includes `"platform"`.

Return a policy with:

```ts
{
  id: "policy_e2e_platform_rollout_tool",
  skillId: platformRolloutTool.skillId,
  versionId: platformRolloutTool.versionId,
  target: "user-global",
  audience: "all-platform-users",
  catalogScope: "platform",
  enabled: true,
  updatePolicy: "pinned",
  removalPolicy: "locked",
}
```

**Step 2: Write failing E2E test**

Create a spec that:

1. starts the registry fixture
2. syncs global materialization
3. opens `/dashboard/skills`
4. confirms local, organization, and platform rows are visible
5. toggles platform row off
6. verifies it remains visible with disabled state
7. calls server API and confirms `platform-rollout-tool` is in disabled skills
8. calls runtime `GET /workspace/:id/skills?includeGlobal=true` and confirms it is excluded
9. calls inventory `GET /workspace/:id/skills?includeGlobal=true&includeDisabled=true` or the app inventory path and confirms it remains visible

Use selectors:

```ts
const platformSelector =
  '[data-skill-inventory-name="platform-rollout-tool"][data-skill-inventory-scope="platform"]';
```

**Step 3: Run desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If matches are internally started dev/test processes from this repo, stop them:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

**Step 4: Build real desktop E2E binary**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e
```

Expected: build succeeds.

**Step 5: Run focused E2E spec**

Run:

```bash
cd packages/e2e
pnpm test --spec ./specs/skill-enable-disable.e2e.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/e2e/specs/skill-enable-disable.e2e.ts packages/e2e/helpers/skill-registry-fixture.ts packages/e2e/specs/session-capabilities.spec.ts
git commit -m "test(e2e): cover skill enable disable"
```

---

### Task 7: Durable Documentation And Verification

**Files:**
- Modify: `docs/features/skill-registry-and-distribution.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/veslo-server-app-contract.md`
- Possibly modify: `docs/dev/app-map.md` only if new app surfaces are added

**Step 1: Update canonical docs**

Document:

- personal enable/disable override semantics
- platform inventory visibility
- read-only metadata-only organization/platform skills
- disabled skills API
- difference between personal opt-out and admin rollout mutation
- runtime filtering before agent-facing skill lists and resolve

**Step 2: Run focused checks**

Run:

```bash
pnpm --filter veslo-server exec bun test src/skill-enabled-overrides.test.ts src/server.skill-enabled-overrides.test.ts src/skills.test.ts src/skill-resolver.test.ts
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 3: Rebuild server binary**

Repo instructions require rebuilding the server binary after `packages/server/src` changes.

Run the instructed command first:

```bash
pnpm --filter openwork-server build:bin
```

If pnpm reports that no package matches `openwork-server`, run the actual package name observed in this repo:

```bash
pnpm --filter veslo-server build:bin
```

Expected: server binary build succeeds.

**Step 4: Run desktop E2E**

Run desktop preflight from `docs/dev/testing-playbook.md`, then:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/skill-enable-disable.e2e.ts
```

Expected: PASS.

**Step 5: Commit docs**

```bash
git add docs/features/skill-registry-and-distribution.md docs/dev/state-and-config-reference.md docs/dev/veslo-server-app-contract.md docs/dev/app-map.md
git commit -m "docs: document skill enable overrides"
```

**Step 6: Final status**

Run:

```bash
git status --short
```

Expected: only unrelated pre-existing user changes remain, or the worktree is clean except intentionally untracked local artifacts.

Report:

- commands run
- pass/fail status
- any E2E or binary rebuild gaps
- commit hashes created

---

## Completion Checklist

- [ ] All skills inventory includes platform as a first-class scope.
- [ ] Every skill row/card has an enabled switch.
- [ ] Disabled skills remain visible in inventory.
- [ ] Disabled skills are excluded from agent-facing list and resolve.
- [ ] `GET /skills/disabled` or the chosen equivalent API returns disabled skills.
- [ ] Read-only organization/platform skills can only be personally enabled/disabled.
- [ ] Read-only organization/platform skills do not expose full content or mutation actions.
- [ ] Bulk enable/disable works for mixed selections.
- [ ] Server binary rebuilt after server source changes.
- [ ] Real Tauri E2E spec passes.
- [ ] Canonical docs updated.
