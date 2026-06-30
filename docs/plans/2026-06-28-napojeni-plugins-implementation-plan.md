# Napojení And Pluginy Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename the user-facing MCP integrations area to Napojení and restore OpenCode plugin management as a separate dashboard tab named Pluginy.

**Architecture:** Keep the existing MCP implementation as the Napojení page and reconnect the existing plugin management view as a separate dashboard branch. Do not change the server plugin API or OpenCode config format; this is primarily routing, composition, copy, and regression coverage.

**Tech Stack:** SolidJS app, existing Veslo server plugin domain client, Node source-contract tests with `tsx/esm`, app i18n parity checks, Tauri Pilot desktop smoke verification.

---

## Pre-Flight

Use a clean worktree because the main checkout often contains unrelated user work:

```bash
git fetch --all --prune
git worktree add ../Veslo-napojeni-plugins -b codex/napojeni-plugins HEAD
cd ../Veslo-napojeni-plugins
```

Before any desktop runtime or desktop E2E run, follow `docs/dev/testing-playbook.md` preflight: find Veslo dev/test processes from this repo, stop internally started stale instances, verify none remain, then launch the intended runtime.

## Task 1: Lock Dashboard Route Behavior

**Files:**
- Modify: `packages/app/src/app/tests/controllers/app-startup-controller.test.ts`
- Modify: `packages/app/src/app/controllers/app-startup-controller.ts`

**Step 1: Write the failing route test**

Update the first test in `packages/app/src/app/tests/controllers/app-startup-controller.test.ts` so plugins is no longer an MCP alias:

```ts
test("dashboard route tabs preserve real plugin and mcp destinations", () => {
  assert.equal(resolveDashboardRouteTab("skills"), "skills");
  assert.equal(resolveDashboardRouteTab("plugins"), "plugins");
  assert.equal(resolveDashboardRouteTab("mcp"), "mcp");
  assert.equal(resolveDashboardRouteTab("missing"), "scheduled");

  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/dashboard/plugins",
      onboardingStep: "welcome",
      isTauriRuntime: true,
    }),
    { type: "dashboard-route", tab: "plugins", canonicalize: false },
  );
  assert.deepEqual(
    resolveAppStartupRouteDecision({
      rawPath: "/dashboard/mcp",
      onboardingStep: "welcome",
      isTauriRuntime: true,
    }),
    { type: "dashboard-route", tab: "mcp", canonicalize: false },
  );
});
```

**Step 2: Run the test to verify it fails**

Run from `packages/app`:

```bash
pnpm exec node --test --import=tsx/esm src/app/tests/controllers/app-startup-controller.test.ts
```

Expected: FAIL because `resolveDashboardRouteTab("plugins")` still returns `mcp`.

**Step 3: Write the minimal implementation**

In `packages/app/src/app/controllers/app-startup-controller.ts`, remove the legacy alias:

```ts
export function resolveDashboardRouteTab(value?: string | null): DashboardTab {
  const normalized = trim(value).toLowerCase();
  if (dashboardTabs.has(normalized as DashboardTab)) {
    return normalized as DashboardTab;
  }
  return "scheduled";
}
```

**Step 4: Run the test to verify it passes**

Run:

```bash
pnpm exec node --test --import=tsx/esm src/app/tests/controllers/app-startup-controller.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/tests/controllers/app-startup-controller.test.ts packages/app/src/app/controllers/app-startup-controller.ts
git commit -m "feat(app): restore plugin dashboard route"
```

## Task 2: Separate Plugin And Napojení Navigation Semantics

**Files:**
- Modify: `packages/app/src/app/tests/pages/dashboard-menu-navigation.test.ts`
- Modify: `packages/app/src/app/pages/dashboard-menu-navigation.ts`
- Modify: `packages/app/src/app/components/dashboard-tab-rail.tsx`
- Modify: `packages/app/src/app/tests/pages/settings-tabs-layout.test.ts`

**Step 1: Write failing navigation tests**

In `packages/app/src/app/tests/pages/dashboard-menu-navigation.test.ts`, replace the current plugins/MCP equivalence test with:

```ts
test("treats plugins and napojeni as separate dashboard destinations", () => {
  assert.equal(typeof resolveDashboardTabSelectionAction, "function");
  if (typeof resolveDashboardTabSelectionAction !== "function") return;

  const result = resolveDashboardTabSelectionAction({
    currentTab: "plugins",
    nextTab: "mcp",
    selectedSessionId: "sess-123",
  });

  assert.deepEqual(result, { kind: "open-dashboard-tab", tab: "mcp" });
});
```

Add one source-contract assertion to `packages/app/src/app/tests/pages/settings-tabs-layout.test.ts` so the dashboard tab rail includes plugins:

```ts
assert.match(dashboardTabRailSource, /\{\s*kind:\s*"dashboard",\s*tab:\s*"plugins"\s*\}/);
assert.match(dashboardTabRailSource, /case\s+"plugins":(?:(?!\s*(?:case\s+"|default\s*:))[\s\S])*t\("nav\.plugins", currentLocale\(\)\)/);
```

**Step 2: Run tests to verify they fail**

Run from `packages/app`:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/tests/pages/dashboard-menu-navigation.test.ts \
  src/app/tests/pages/settings-tabs-layout.test.ts
```

Expected: FAIL because navigation still normalizes plugins to MCP and the settings tab rail does not include plugins.

**Step 3: Write the minimal implementation**

In `packages/app/src/app/pages/dashboard-menu-navigation.ts`, remove `normalizeDashboardNavTab` and compare `currentTab` and `nextTab` directly:

```ts
const currentTab = input.currentTab;
const nextTab = input.nextTab;
```

In `packages/app/src/app/components/dashboard-tab-rail.tsx`:

- extend `DashboardTabRailDashboardTab` to include `"plugins"`
- add `{ kind: "dashboard", tab: "plugins" }` after the MCP item
- add a `case "plugins": return t("nav.plugins", currentLocale())`
- remove the active alias that marks MCP active when the active tab is plugins

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/tests/pages/dashboard-menu-navigation.test.ts \
  src/app/tests/pages/settings-tabs-layout.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/tests/pages/dashboard-menu-navigation.test.ts \
  packages/app/src/app/pages/dashboard-menu-navigation.ts \
  packages/app/src/app/components/dashboard-tab-rail.tsx \
  packages/app/src/app/tests/pages/settings-tabs-layout.test.ts
git commit -m "feat(app): separate napojeni and plugin navigation"
```

## Task 3: Reconnect The Existing Plugin View

**Files:**
- Modify: `packages/app/src/app/tests/extensions-screen-simplification.test.ts`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/extensions.tsx`

**Step 1: Write failing dashboard composition tests**

Replace the plugin-removal assertions in `packages/app/src/app/tests/extensions-screen-simplification.test.ts` with source-contract tests for the new split:

```ts
const dashboardSource = readFileSync(new URL("../pages/dashboard.tsx", import.meta.url), "utf8");

test("napojeni screen remains mcp-only and explains mcp connections", () => {
  assert.doesNotMatch(extensionsSource, /import PluginsView/);
  assert.match(extensionsSource, /extensions\.title/);
  assert.match(extensionsSource, /extensions\.subtitle/);
  assert.match(extensionsSource, /<McpView/);
});

test("dashboard renders plugin view on the plugins tab", () => {
  assert.match(dashboardSource, /import PluginsView from "\.\/plugins";/);
  assert.match(dashboardSource, /<Match when=\{props\.tab === "plugins"\}>[\s\S]*<PluginsView/);
  assert.match(dashboardSource, /canEditPlugins=\{props\.canEditPlugins\}/);
  assert.match(dashboardSource, /addPlugin=\{props\.addPlugin\}/);
  assert.match(dashboardSource, /removePlugin=\{props\.removePlugin\}/);
});
```

**Step 2: Run tests to verify they fail**

Run from `packages/app`:

```bash
pnpm exec node --test --import=tsx/esm src/app/tests/extensions-screen-simplification.test.ts
```

Expected: FAIL because dashboard still renders `ExtensionsView` for both `plugins` and `mcp`.

**Step 3: Write the minimal implementation**

In `packages/app/src/app/pages/dashboard.tsx`:

- import `PluginsView` from `./plugins`
- keep the `mcp` match rendering `ExtensionsView`
- add a separate `plugins` match rendering `PluginsView`
- pass the existing plugin props already present on `DashboardViewProps`

The new branch should follow the existing prop wiring shape:

```tsx
<Match when={props.tab === "plugins"}>
  <PluginsView
    busy={props.busy}
    activeWorkspaceRoot={props.activeWorkspaceRoot}
    canEditPlugins={props.canEditPlugins}
    canUseGlobalScope={props.canUseGlobalPluginScope}
    accessHint={props.pluginsAccessHint}
    pluginScope={props.pluginScope}
    setPluginScope={props.setPluginScope}
    pluginConfigPath={props.pluginConfigPath}
    pluginList={props.pluginList}
    pluginInput={props.pluginInput}
    setPluginInput={props.setPluginInput}
    pluginStatus={props.pluginStatus}
    activePluginGuide={props.activePluginGuide}
    setActivePluginGuide={props.setActivePluginGuide}
    isPluginInstalled={props.isPluginInstalled}
    suggestedPlugins={props.suggestedPlugins}
    refreshPlugins={props.refreshPlugins}
    addPlugin={props.addPlugin}
    removePlugin={props.removePlugin}
  />
</Match>
```

In `packages/app/src/app/pages/extensions.tsx`, keep it MCP-only and update only copy/layout needed by Task 4.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm exec node --test --import=tsx/esm src/app/tests/extensions-screen-simplification.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/app/tests/extensions-screen-simplification.test.ts \
  packages/app/src/app/pages/dashboard.tsx \
  packages/app/src/app/pages/extensions.tsx
git commit -m "feat(app): restore plugin dashboard tab"
```

## Task 4: Rename Extensions Copy To Napojení

**Files:**
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Modify: `packages/app/src/app/tests/pages/settings-tabs-layout.test.ts`
- Modify: `packages/app/src/app/tests/pages/dashboard-sidebar-navigation-layout.test.ts`

**Step 1: Write failing locale tests**

In `packages/app/src/app/tests/pages/settings-tabs-layout.test.ts`, update locale expectations:

```ts
assert.match(enLocaleSource, /"nav\.extensions": "Connections"/);
assert.match(csLocaleSource, /"nav\.extensions": "Napojení"/);
assert.match(enLocaleSource, /"nav\.plugins": "Plugins"/);
assert.match(csLocaleSource, /"nav\.plugins": "Pluginy"/);
```

In `packages/app/src/app/tests/pages/dashboard-sidebar-navigation-layout.test.ts`, update the mobile nav assertion so it expects both Napojení and Pluginy navigation keys:

```ts
assert.match(
  source,
  /<nav class="md:hidden border-t border-dls-border bg-dls-surface">[\s\S]*\{t\("nav\.soul", currentLocale\(\)\)\}[\s\S]*\{t\("nav\.skills", currentLocale\(\)\)\}[\s\S]*\{t\("nav\.extensions", currentLocale\(\)\)\}[\s\S]*\{t\("nav\.plugins", currentLocale\(\)\)\}/,
);
```

**Step 2: Run tests to verify they fail**

Run from `packages/app`:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/tests/pages/settings-tabs-layout.test.ts \
  src/app/tests/pages/dashboard-sidebar-navigation-layout.test.ts
```

Expected: FAIL because locale values and mobile nav still use the old Extensions-only model.

**Step 3: Write the minimal implementation**

In locale files:

- change `nav.extensions` to `Connections` in English and `Napojení` in Czech
- add `nav.plugins` as `Plugins` in English and `Pluginy` in Czech
- update `extensions.title` to match the user-facing Napojení/Connections label
- update `extensions.subtitle` to explicitly mention MCP servers and external apps
- update Chinese with matching keys so i18n parity passes

Recommended copy:

```ts
"nav.extensions": "Connections",
"nav.plugins": "Plugins",
"extensions.title": "Connections",
"extensions.subtitle": "Connect Veslo to external apps and services through MCP servers.",
```

```ts
"nav.extensions": "Napojení",
"nav.plugins": "Pluginy",
"extensions.title": "Napojení",
"extensions.subtitle": "Napojte Veslo na vnější aplikace a služby přes MCP servery.",
```

In `packages/app/src/app/pages/dashboard.tsx`, add the Pluginy mobile button next to Napojení and adjust the mobile grid columns so text does not compress:

```tsx
class={`mx-auto max-w-5xl px-4 py-3 grid gap-2 ${props.developerMode ? "grid-cols-5" : "grid-cols-4"}`}
```

Use `Cpu` for Pluginy if already imported; otherwise import it from `lucide-solid`.

**Step 4: Run tests to verify they pass**

Run:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/tests/pages/settings-tabs-layout.test.ts \
  src/app/tests/pages/dashboard-sidebar-navigation-layout.test.ts
pnpm test:i18n
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  packages/app/src/i18n/locales/en.ts \
  packages/app/src/i18n/locales/cs.ts \
  packages/app/src/i18n/locales/zh.ts \
  packages/app/src/app/tests/pages/settings-tabs-layout.test.ts \
  packages/app/src/app/tests/pages/dashboard-sidebar-navigation-layout.test.ts \
  packages/app/src/app/pages/dashboard.tsx
git commit -m "feat(app): rename extensions to napojeni"
```

## Task 5: Refresh Docs For The Split

**Files:**
- Modify: `docs/features/extensions-and-integrations.md`
- Modify: `docs/dev/app-map.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Update docs**

In `docs/features/extensions-and-integrations.md`:

- describe Napojení as the MCP/external-app page
- describe Pluginy as the OpenCode plugin management page
- keep the source-of-truth split between MCP and OpenCode plugins

In `docs/dev/app-map.md`:

- clarify that `extensions.tsx` is the Napojení/MCP shell
- clarify that `plugins.tsx` is rendered as the Pluginy dashboard tab

In `docs/dev/state-and-config-reference.md`:

- keep OpenCode config as the shared storage for MCP and plugins
- state that UI separates Napojení and Pluginy even though both write OpenCode config

**Step 2: Run a docs/source sanity check**

Run from the repo root:

```bash
rg -n "Extensions|Rozšíření|Pluginy|Napojení|plugins route normalizes|plugins-to-mcp" docs/features docs/dev packages/app/src/app/tests packages/app/src/i18n/locales
```

Expected: Any remaining `Extensions` wording is either English locale text intentionally changed to `Connections`, historical docs under `docs/plans`, or code identifiers not worth renaming in this slice.

**Step 3: Commit**

```bash
git add docs/features/extensions-and-integrations.md docs/dev/app-map.md docs/dev/state-and-config-reference.md
git commit -m "docs: document napojeni and plugin split"
```

## Task 6: Verify App And Desktop Behavior

**Files:**
- Test only unless a failure reveals a defect

**Step 1: Run focused app tests**

Run from `packages/app`:

```bash
pnpm exec node --test --import=tsx/esm \
  src/app/tests/controllers/app-startup-controller.test.ts \
  src/app/tests/pages/dashboard-menu-navigation.test.ts \
  src/app/tests/pages/settings-tabs-layout.test.ts \
  src/app/tests/pages/dashboard-sidebar-navigation-layout.test.ts \
  src/app/tests/extensions-screen-simplification.test.ts \
  src/app/tests/context/extensions-plugin-client-contract.test.ts \
  src/app/tests/lib/veslo-server.test.ts \
  src/app/tests/lib/veslo-server-route-manifest-contract.test.ts
pnpm test:i18n
pnpm typecheck
```

Expected: PASS.

**Step 2: Run server plugin route regression**

Run from `packages/server`:

```bash
bun test src/tests/server.plugins-routes.test.ts src/tests/resource-owner.test.ts
```

Expected: PASS.

**Step 3: Rebuild server binary only if server code changed**

This plan should not change `packages/server/src`. If server code changes unexpectedly, run:

```bash
pnpm --filter veslo-server build:bin
```

Expected: successful server binary build.

**Step 4: Run desktop smoke through Tauri Pilot**

Follow `docs/dev/testing-playbook.md` preflight first. Then run a focused desktop smoke from the repo root:

```bash
pnpm test:e2e:ui:smoke
```

Expected: PASS against the real Tauri runtime. During manual/pilot inspection, confirm:

- dashboard shows Napojení for the MCP/external-app page
- Napojení page includes MCP/external-app explanatory copy
- dashboard shows Pluginy as a separate destination
- Pluginy opens the existing plugin input and suggested plugin controls
- selecting Napojení from Pluginy does not return to the session unless the same active destination is reselected

**Step 5: Update graphify if available**

Run from the repo root:

```bash
command -v graphify >/dev/null 2>&1 && graphify update . || true
```

Expected: graph updated if the CLI is available; no task failure if graphify is unavailable.

**Step 6: Final commit if verification required fixes**

If verification required follow-up fixes, commit them separately:

```bash
git add <fixed-files>
git commit -m "fix(app): stabilize napojeni plugin split"
```

If no fixes were needed, do not create an empty commit.
