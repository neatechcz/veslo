# Plugin Policy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build plugin-only policy management for OpenCode Plugins with platform, organization, user, and project levels, including hidden locked platform plugins and visible user-removable Superpowers.

**Architecture:** Add plugin-scoped policy, override, and materialization modules on the Veslo server, then expose richer plugin inventory/actions through existing plugin routes. Update the app Plugins surface to consume policy-aware inventory while leaving Skills and MCP/Napojení behavior unchanged.

**Tech Stack:** TypeScript, Bun tests, SolidJS, Veslo server routes, OpenCode plugin config/materialization, Tauri Pilot E2E.

---

## Guardrails

- Do not migrate or refactor Skills.
- Do not migrate or refactor MCP/Napojení.
- Keep implementation names plugin-scoped, for example `PluginPolicy`, not `CapabilityPolicy`.
- Keep **Plugins** as the English product/domain name. **Pluginy** is Czech localization only.
- Preserve existing unmanaged OpenCode plugin config.
- Do not use `packages/web` or raw Vite for runtime verification.
- If `packages/server/src` changes, run `pnpm --filter veslo-server build:bin` before relying on orchestrator-backed flows.

### Task 1: Add Plugin Policy Types And Built-In Platform Policy Fixtures

**Files:**
- Create: `packages/server/src/plugin-policy.ts`
- Create: `packages/server/src/platform-managed-plugins.ts`
- Create: `packages/server/src/tests/plugin-policy.test.ts`
- Modify: `packages/server/src/types.ts`

**Step 1: Write the failing tests**

Create tests that assert:

```ts
import { describe, expect, test } from "bun:test";
import {
  resolveEffectivePluginPolicies,
  visiblePluginPolicies,
} from "../plugin-policy.js";
import {
  OPENCODE_SCHEDULER_PLATFORM_PLUGIN,
  SUPERPOWERS_PLATFORM_PLUGIN,
} from "../platform-managed-plugins.js";

describe("plugin policy model", () => {
  test("scheduler is hidden locked platform policy", () => {
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.owner.kind).toBe("platform");
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.visibility).toBe("hidden-debug-only");
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.enabledPolicy).toBe("locked-on");
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.removalPolicy).toBe("locked");
    expect(OPENCODE_SCHEDULER_PLATFORM_PLUGIN.autoInstall).toBe(true);
  });

  test("superpowers is visible user-removable platform policy", () => {
    expect(SUPERPOWERS_PLATFORM_PLUGIN.owner.kind).toBe("platform");
    expect(SUPERPOWERS_PLATFORM_PLUGIN.visibility).toBe("visible");
    expect(SUPERPOWERS_PLATFORM_PLUGIN.enabledPolicy).toBe("user-toggleable");
    expect(SUPERPOWERS_PLATFORM_PLUGIN.removalPolicy).toBe("user-removable");
    expect(SUPERPOWERS_PLATFORM_PLUGIN.autoInstall).toBe(true);
  });

  test("normal inventory hides hidden platform policies", () => {
    const policies = resolveEffectivePluginPolicies({
      platform: [OPENCODE_SCHEDULER_PLATFORM_PLUGIN, SUPERPOWERS_PLATFORM_PLUGIN],
      organization: [],
      user: [],
      project: [],
      overrides: [],
    });
    expect(visiblePluginPolicies(policies, { debug: false }).map((item) => item.id)).toEqual([
      SUPERPOWERS_PLATFORM_PLUGIN.id,
    ]);
    expect(visiblePluginPolicies(policies, { debug: true }).map((item) => item.id)).toContain(
      OPENCODE_SCHEDULER_PLATFORM_PLUGIN.id,
    );
  });
});
```

**Step 2: Run the failing test**

Run:

```bash
cd packages/server && bun test src/tests/plugin-policy.test.ts
```

Expected: FAIL because the modules do not exist.

**Step 3: Implement the minimal type model**

Add plugin-only types:

```ts
export type PluginOwnerKind = "platform" | "organization" | "user" | "project";
export type PluginVisibility = "visible" | "hidden-debug-only";
export type PluginEnabledPolicy = "locked-on" | "user-toggleable" | "admin-toggleable";
export type PluginRemovalPolicy = "locked" | "admin-removable" | "user-removable";
export type PluginLifecycle = "active" | "disabled" | "removed" | "conflict";

export type PluginPolicy = {
  id: string;
  spec: string;
  displayName: string;
  description?: string;
  owner: { kind: PluginOwnerKind; id: string; label?: string };
  target: "user" | "project";
  visibility: PluginVisibility;
  autoInstall: boolean;
  enabledPolicy: PluginEnabledPolicy;
  removalPolicy: PluginRemovalPolicy;
  source: "policy.platform" | "policy.organization" | "policy.user" | "policy.project" | "config.unmanaged";
};
```

Add platform defaults:

```ts
export const OPENCODE_SCHEDULER_PLATFORM_PLUGIN: PluginPolicy = {
  id: "platform.opencode-scheduler",
  spec: "opencode-scheduler",
  displayName: "OpenCode Scheduler",
  owner: { kind: "platform", id: "veslo-platform", label: "Veslo" },
  target: "user",
  visibility: "hidden-debug-only",
  autoInstall: true,
  enabledPolicy: "locked-on",
  removalPolicy: "locked",
  source: "policy.platform",
};

export const SUPERPOWERS_PLATFORM_PLUGIN: PluginPolicy = {
  id: "platform.superpowers",
  spec: "superpowers@git+https://github.com/obra/superpowers.git",
  displayName: "Superpowers",
  owner: { kind: "platform", id: "veslo-platform", label: "Veslo" },
  target: "user",
  visibility: "visible",
  autoInstall: true,
  enabledPolicy: "user-toggleable",
  removalPolicy: "user-removable",
  source: "policy.platform",
};
```

**Step 4: Run the test**

Run:

```bash
cd packages/server && bun test src/tests/plugin-policy.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/plugin-policy.ts packages/server/src/platform-managed-plugins.ts packages/server/src/tests/plugin-policy.test.ts packages/server/src/types.ts
git commit -m "feat: add plugin policy model"
```

### Task 2: Add Plugin Override Store For Enable/Remove State

**Files:**
- Create: `packages/server/src/plugin-policy-store.ts`
- Create: `packages/server/src/tests/plugin-policy-store.test.ts`
- Modify: `packages/server/src/types.ts`

**Step 1: Write the failing tests**

Cover:

- disabled Superpowers records persist
- removed Superpowers records persist
- locked scheduler cannot be disabled or removed
- store validates plugin ids and scopes

Use a temporary data dir and assert the JSON file name is plugin-specific, for example `plugin-policy-overrides.json`.

**Step 2: Run the failing test**

```bash
cd packages/server && bun test src/tests/plugin-policy-store.test.ts
```

Expected: FAIL because the store does not exist.

**Step 3: Implement the store**

Mirror the safety shape used by skill enabled overrides, but keep it plugin-only:

```ts
export type PluginPolicyOverride = {
  id: string;
  pluginId: string;
  action: "disabled" | "removed";
  scope: "user" | "project" | "organization";
  workspaceId?: string;
  orgId?: string;
  actor?: string;
  createdAt: string;
};
```

Expose:

- `listPluginPolicyOverrides`
- `setPluginEnabledState`
- `setPluginRemovedState`
- `pluginPolicyOverrideMatches`

The store must reject mutation when the target policy has `enabledPolicy: "locked-on"` or `removalPolicy: "locked"`.

**Step 4: Run the test**

```bash
cd packages/server && bun test src/tests/plugin-policy-store.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/server/src/plugin-policy-store.ts packages/server/src/tests/plugin-policy-store.test.ts packages/server/src/types.ts
git commit -m "feat: store plugin policy overrides"
```

### Task 3: Add Plugin Materialization With Ownership Markers

**Files:**
- Create: `packages/server/src/plugin-materializer.ts`
- Create: `packages/server/src/tests/plugin-materializer.test.ts`
- Modify: `packages/server/src/plugins.ts`
- Modify: `packages/server/src/workspace-files.ts`

**Step 1: Write the failing tests**

Cover:

- materializes enabled policy plugins into OpenCode-compatible runtime state
- writes a managed plugin manifest for config-spec plugins such as package/git specs
- writes a root manifest and per-plugin marker for generated file plugins
- leaves unmanaged OpenCode plugin entries untouched
- removes stale managed plugin materializations
- reports conflict when an unmanaged matching plugin exists and ownership cannot be proven

**Step 2: Run the failing test**

```bash
cd packages/server && bun test src/tests/plugin-materializer.test.ts
```

Expected: FAIL because the materializer does not exist.

**Step 3: Implement minimal materialization**

Support both OpenCode plugin forms:

- Config-spec plugins, such as npm/git specs, are merged into the OpenCode `plugin` array.
- File plugins are written under a plugin-specific managed root.

Use plugin-specific ownership records, for example:

- project managed file root: `<workspace>/.opencode/plugins/veslo-managed`
- user managed file root: `<user OpenCode config>/plugins/veslo-managed`
- project managed spec manifest: `<workspace>/.opencode/veslo/plugins/managed-plugin-specs.json`
- user managed spec manifest: `<user Veslo data dir>/plugins/managed-plugin-specs.json`
- managed file root manifest: `.veslo-plugin-materialization.json`
- managed file marker: `.veslo-managed-plugin.json`

For config-spec plugins, update the `plugin` array by merging unmanaged user entries with desired managed entries. Use the previous managed spec manifest to remove stale managed entries safely. Do not remove a plugin spec from config if it was not previously recorded as Veslo-managed.

For file plugins, do not remove unmanaged files. Only remove stale files listed in the previous manifest and carrying Veslo markers.

**Step 4: Connect existing listing to managed metadata**

Extend `listPlugins` so it can return unmanaged config/file entries plus policy/materialized entries without changing Skills or MCP behavior.

**Step 5: Run the test**

```bash
cd packages/server && bun test src/tests/plugin-materializer.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/server/src/plugin-materializer.ts packages/server/src/tests/plugin-materializer.test.ts packages/server/src/plugins.ts packages/server/src/workspace-files.ts
git commit -m "feat: materialize managed plugins safely"
```

### Task 4: Expand Server Plugin Routes

**Files:**
- Modify: `packages/server/src/routes/plugins.ts`
- Modify: `packages/server/src/tests/server.plugins-routes.test.ts`
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/server.ts`

**Step 1: Write the failing route tests**

Add tests for routes:

- `GET /workspace/:id/plugins?includeGlobal=true&debug=false`
- `GET /workspace/:id/plugins?debug=true`
- `POST /workspace/:id/plugins/materialization/sync`
- `POST /workspace/:id/plugins/:pluginId/enabled`
- `DELETE /workspace/:id/plugins/:pluginId`
- `POST /workspace/:id/plugins/:pluginId/restore`

Assert locked scheduler disable/remove returns a 4xx response and does not mutate state.

**Step 2: Run the failing route tests**

```bash
cd packages/server && bun test src/tests/server.plugins-routes.test.ts
```

Expected: FAIL for missing routes/contracts.

**Step 3: Implement route contracts**

Keep legacy add/remove behavior available for unmanaged project plugin specs. Add policy-aware actions for managed plugin ids.

Inventory response should include enough metadata for UI:

```ts
export type PluginInventoryItem = {
  id: string;
  spec: string;
  displayName: string;
  owner: ResourceOwner;
  scope: "platform" | "organization" | "user" | "project";
  target: "user" | "project";
  source: PluginPolicy["source"];
  visibility: PluginVisibility;
  enabled: boolean;
  lifecycle: PluginLifecycle;
  removalPolicy: PluginRemovalPolicy;
  enabledPolicy: PluginEnabledPolicy;
  managed: boolean;
  debugOnly?: boolean;
  conflict?: string;
};
```

**Step 4: Run server plugin tests**

```bash
cd packages/server && bun test src/tests/server.plugins-routes.test.ts src/tests/plugin-policy.test.ts src/tests/plugin-policy-store.test.ts src/tests/plugin-materializer.test.ts
```

Expected: PASS.

**Step 5: Build server binary**

```bash
pnpm --filter veslo-server build:bin
```

Expected: command exits 0 and updates the server binary.

**Step 6: Commit**

```bash
git add packages/server/src/routes/plugins.ts packages/server/src/tests/server.plugins-routes.test.ts packages/server/src/types.ts packages/server/src/server.ts
git commit -m "feat: expose plugin policy routes"
```

### Task 5: Update App Plugin Client Contracts

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server/types.ts`
- Modify: `packages/app/src/app/lib/veslo-server-domains/plugins.ts`
- Modify: `packages/app/src/app/tests/lib/veslo-server.test.ts`
- Modify: `packages/app/src/app/tests/context/extensions-plugin-client-contract.test.ts`

**Step 1: Write failing client contract tests**

Assert the plugins facade supports:

- list with `debug`
- sync materialization
- set enabled
- remove by managed plugin id
- restore by managed plugin id
- legacy add unmanaged plugin spec

**Step 2: Run failing tests**

```bash
cd packages/app && node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/context/extensions-plugin-client-contract.test.ts
```

Expected: FAIL for missing client methods/types.

**Step 3: Implement client contracts**

Keep legacy aliases if existing callers still use them, but make new code call the plugin domain facade.

**Step 4: Run client tests**

```bash
cd packages/app && node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts src/app/tests/context/extensions-plugin-client-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/veslo-server/types.ts packages/app/src/app/lib/veslo-server-domains/plugins.ts packages/app/src/app/tests/lib/veslo-server.test.ts packages/app/src/app/tests/context/extensions-plugin-client-contract.test.ts
git commit -m "feat: add plugin policy client contract"
```

### Task 6: Replace App Plugin State With Policy-Aware Inventory

**Files:**
- Modify: `packages/app/src/app/context/extensions.ts`
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/system-state.ts`
- Create: `packages/app/src/app/tests/context/extensions-plugin-policy.test.ts`

**Step 1: Write failing context tests**

Cover:

- normal refresh hides hidden platform scheduler
- debug refresh includes hidden platform scheduler
- Superpowers appears as a visible platform plugin
- disable/remove calls managed policy endpoints for managed plugins
- unmanaged project plugin add/remove still uses legacy spec endpoints
- `isPluginInstalledByName` treats policy-managed active plugins as installed

**Step 2: Run failing test**

```bash
cd packages/app && node --test --import=tsx/esm src/app/tests/context/extensions-plugin-policy.test.ts
```

Expected: FAIL because plugin context still stores only string specs.

**Step 3: Implement state shape**

Introduce app-side inventory state:

```ts
export type PluginInventoryCard = {
  id: string;
  spec: string;
  displayName: string;
  scope: "platform" | "organization" | "user" | "project";
  enabled: boolean;
  lifecycle: "active" | "disabled" | "removed" | "conflict";
  managed: boolean;
  visibility: "visible" | "hidden-debug-only";
  removalPolicy: "locked" | "admin-removable" | "user-removable";
  enabledPolicy: "locked-on" | "user-toggleable" | "admin-toggleable";
  debugOnly?: boolean;
};
```

Keep `pluginList` compatibility only where existing sidebar logic still needs string specs; derive it from active inventory rather than making it the source of truth.

**Step 4: Run context tests**

```bash
cd packages/app && node --test --import=tsx/esm src/app/tests/context/extensions-plugin-policy.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/context/extensions.ts packages/app/src/app/types.ts packages/app/src/app/system-state.ts packages/app/src/app/tests/context/extensions-plugin-policy.test.ts
git commit -m "feat: track plugin policy inventory in app state"
```

### Task 7: Update Plugins UI

**Files:**
- Modify: `packages/app/src/app/pages/plugins.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/constants.ts`
- Create: `packages/app/src/app/tests/pages/plugins-policy-layout.test.ts`

**Step 1: Write failing UI source tests**

Assert:

- the page groups rows by Platform, Organization, User, Project
- hidden debug-only rows require `developerMode`
- scheduler is not in `SUGGESTED_PLUGINS`
- Superpowers is a visible platform row, not only a suggested manual install
- locked rows do not render enable/remove controls

**Step 2: Run failing UI tests**

```bash
cd packages/app && node --test --import=tsx/esm src/app/tests/pages/plugins-policy-layout.test.ts
```

Expected: FAIL until props/state/UI are updated.

**Step 3: Implement UI**

Update the Plugins page to render policy-aware rows. Use `developerMode` prop to include hidden platform rows only in debug mode. Keep manual add for unmanaged user/project plugins where allowed.

Do not show `opencode-scheduler` as a suggested plugin. Superpowers should appear from platform policy inventory.

**Step 4: Run UI tests**

```bash
cd packages/app && node --test --import=tsx/esm src/app/tests/pages/plugins-policy-layout.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/plugins.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/app.tsx packages/app/src/app/constants.ts packages/app/src/app/tests/pages/plugins-policy-layout.test.ts
git commit -m "feat: show policy-managed plugins"
```

### Task 8: Add Localization

**Files:**
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Modify: `packages/app/src/app/tests/reload-banner-i18n.test.ts` or create a focused i18n parity test if needed

**Step 1: Write failing localization parity test**

Assert every new `plugins.*` key is present in English, Czech, and Chinese locale files.

**Step 2: Run failing localization test**

```bash
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: FAIL for missing keys.

**Step 3: Add localized strings**

Use English **Plugins**. Use Czech **Pluginy**. Keep MCP/Napojení wording separate from Plugins wording.

**Step 4: Run localization test**

```bash
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/tests/reload-banner-i18n.test.ts
git commit -m "feat: localize plugin policy UI"
```

### Task 9: Update Canonical Documentation

**Files:**
- Modify: `docs/features/extensions-and-integrations.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/veslo-server-app-contract.md`
- Modify: `docs/dev/documentation-map.md`
- Reference: `docs/plans/2026-07-05-plugin-policy-design.md`

**Step 1: Write the docs update**

Document:

- Plugins are OpenCode plugins.
- Pluginy is Czech localization.
- Skills and MCP/Napojení are unchanged.
- PluginPolicy is plugin-only in this phase.
- Platform hidden locked plugins are debug-only.
- Superpowers is visible and user-removable.
- Scheduler is hidden locked and not disableable/removable.

**Step 2: Run docs grep checks**

```bash
rg -n "Pluginy|Napojení|PluginPolicy|opencode-scheduler|Superpowers" docs/features/extensions-and-integrations.md docs/dev/state-and-config-reference.md docs/dev/veslo-server-app-contract.md docs/dev/documentation-map.md docs/plans/2026-07-05-plugin-policy-design.md
```

Expected: output shows Pluginy only as Czech localization, and PluginPolicy described as plugin-only.

**Step 3: Commit**

```bash
git add docs/features/extensions-and-integrations.md docs/dev/state-and-config-reference.md docs/dev/veslo-server-app-contract.md docs/dev/documentation-map.md
git commit -m "docs: document plugin policy model"
```

### Task 10: Add Desktop E2E Coverage

**Files:**
- Create: `packages/e2e/specs/plugins-policy.pilot.ts`
- Modify: `packages/e2e/package.json`
- Reference: `docs/dev/testing-playbook.md`
- Reference: `docs/dev/development-startup.md`

**Step 1: Write the failing Tauri Pilot test**

Scenario should:

- start the real desktop app through the Tauri Pilot flow
- open Plugins
- verify scheduler is absent in normal mode
- verify Superpowers is visible
- enable debug mode with `?debug`
- verify scheduler appears as hidden/system/locked
- verify locked scheduler has no disable/remove action

**Step 2: Run the failing E2E test**

Follow the desktop preflight from the testing playbook first. Then run:

```bash
cd packages/e2e && node --import=tsx/esm ./specs/plugins-policy.pilot.ts
```

Expected: FAIL until the UI and route behavior are complete.

**Step 3: Implement package script**

Add:

```json
"test:pilot:plugins-policy": "node --import=tsx/esm ./specs/plugins-policy.pilot.ts"
```

**Step 4: Run the E2E test**

```bash
pnpm --filter @neatech/veslo-e2e test:pilot:plugins-policy
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/e2e/specs/plugins-policy.pilot.ts packages/e2e/package.json
git commit -m "test: cover plugin policy in desktop e2e"
```

### Task 11: Final Verification And Graph Update

**Files:**
- No new source files unless verification reveals a defect.

**Step 1: Run server tests**

```bash
pnpm --filter veslo-server test
```

Expected: PASS.

**Step 2: Run server typecheck and binary build**

```bash
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server build:bin
```

Expected: both PASS.

**Step 3: Run app unit/type checks**

```bash
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 4: Run desktop plugin E2E**

Use the real Tauri runtime and preflight from `docs/dev/testing-playbook.md`.

```bash
pnpm --filter @neatech/veslo-e2e test:pilot:plugins-policy
```

Expected: PASS.

**Step 5: Update graphify if available**

```bash
command -v graphify >/dev/null && graphify update . || true
```

Expected: graph update succeeds when the CLI is installed; otherwise continue.

**Step 6: Review final diff**

```bash
git status --short
git diff --stat
```

Expected: only intended plugin-policy implementation files are changed.

**Step 7: Final commit**

If any verification-only fixes remain uncommitted:

```bash
git add <changed-files>
git commit -m "fix: finish plugin policy verification"
```

Expected: clean intended implementation branch except unrelated pre-existing worktree changes.
