# Session Capabilities Right Menu Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show the Skills and MCP servers available to the currently selected chat in the session right menu, scoped by that chat's workspace directory.

**Architecture:** Add a small session capabilities model plus a per-directory loader/cache. Reuse the existing Skills inventory/listing path and MCP config listing path, then render a read-only panel in the session right sidebar. The selected chat directory is authoritative; do not fall back to the active workspace when it is missing.

**Tech Stack:** SolidJS, TypeScript, Tauri commands, Veslo server client, Node test runner, WebdriverIO desktop E2E.

---

### Task 1: MCP Effective Listing Helper

**Files:**
- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/mcp.ts`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/mcp.test.ts`

**Step 1: Write the failing tests**

Add tests to `packages/app/src/app/mcp.test.ts` for effective project plus global MCP merging:

```ts
import { mergeMcpServerEntries } from "./mcp.js";

test("mergeMcpServerEntries includes global MCP and lets project override by name", () => {
  const result = mergeMcpServerEntries(
    [
      { name: "global-only", config: { type: "remote", url: "https://global.example" }, source: "config.global" },
      { name: "shared", config: { type: "remote", url: "https://global-shared.example" }, source: "config.global" },
    ],
    [
      { name: "shared", config: { type: "remote", url: "https://project-shared.example" }, source: "config.project" },
      { name: "project-only", config: { type: "local", command: ["node", "server.js"] }, source: "config.project" },
    ],
  );

  assert.deepEqual(result.map((entry) => `${entry.name}:${entry.source}`), [
    "global-only:config.global",
    "shared:config.project",
    "project-only:config.project",
  ]);
});
```

**Step 2: Run the test and verify it fails**

Run from repo root:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/mcp.test.ts
```

Expected: FAIL because `mergeMcpServerEntries` does not exist and `McpServerEntry` has no `source`.

**Step 3: Add source metadata and helper**

In `packages/app/src/app/types.ts`, extend `McpServerEntry`:

```ts
export type McpServerEntry = {
  name: string;
  config: McpServerConfig;
  source?: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
};
```

In `packages/app/src/app/mcp.ts`, add:

```ts
export function mergeMcpServerEntries(
  globalEntries: McpServerEntry[],
  projectEntries: McpServerEntry[],
): McpServerEntry[] {
  const projectNames = new Set(projectEntries.map((entry) => entry.name));
  return [
    ...globalEntries
      .filter((entry) => !projectNames.has(entry.name))
      .map((entry) => ({ ...entry, source: entry.source ?? "config.global" as const })),
    ...projectEntries.map((entry) => ({ ...entry, source: entry.source ?? "config.project" as const })),
  ];
}
```

Also add an async helper that reads `readOpencodeConfig("global", projectDir)` and `readOpencodeConfig("project", projectDir)`, parses both with `parseMcpServersFromContent`, and merges them with `mergeMcpServerEntries`.

Update `packages/app/src/app/app.tsx` local `refreshMcpServers()` to use this helper so the dashboard MCP menu and the future right-menu panel share the same local effective listing.

When mapping `vesloClient.listMcp()` results, preserve `source` and `disabledByTools`.

**Step 4: Run the focused test**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/mcp.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/types.ts packages/app/src/app/mcp.ts packages/app/src/app/app.tsx packages/app/src/app/mcp.test.ts
git commit -m "feat(app): share effective mcp listing"
```

---

### Task 2: Session Capabilities Model

**Files:**
- Create: `packages/app/src/app/lib/session-capabilities.ts`
- Test: `packages/app/src/app/lib/session-capabilities.test.ts`

**Step 1: Write the failing tests**

Create `packages/app/src/app/lib/session-capabilities.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionMcpRows,
  buildSessionSkillRows,
  normalizeSessionCapabilityDirectory,
} from "./session-capabilities.js";

test("normalizeSessionCapabilityDirectory does not fall back to the active workspace", () => {
  assert.equal(normalizeSessionCapabilityDirectory("  /workspaces/chat-a  "), "/workspaces/chat-a");
  assert.equal(normalizeSessionCapabilityDirectory(""), "");
});

test("buildSessionSkillRows shows the effective workspace skill over the global duplicate", () => {
  const rows = buildSessionSkillRows([
    {
      name: "research",
      status: "mixed",
      description: "Global research",
      globalInstance: {
        id: "global:research",
        name: "research",
        scope: "user-global",
        path: "/home/user/.config/opencode/skills/research/SKILL.md",
        description: "Global research",
        source: "opencode",
        readable: true,
        writable: true,
      },
      workspaceInstances: [
        {
          id: "workspace:ws-a:research",
          name: "research",
          scope: "workspace",
          workspaceId: "ws-a",
          workspaceLabel: "Workspace A",
          path: "/workspaces/a/.opencode/skills/research/SKILL.md",
          description: "Workspace research",
          source: "opencode",
          readable: true,
          writable: true,
        },
      ],
    },
    {
      name: "hub-only",
      status: "hub-only",
      workspaceInstances: [],
      hubItem: {
        name: "hub-only",
        source: { owner: "x", repo: "y", ref: "main", path: "skills/hub-only" },
      },
    },
  ]);

  assert.deepEqual(rows.map((row) => `${row.name}:${row.scope}:${row.description}`), [
    "research:workspace:Workspace research",
  ]);
});

test("buildSessionMcpRows carries status and source", () => {
  const rows = buildSessionMcpRows(
    [
      { name: "browser", config: { type: "remote", url: "https://mcp.example" }, source: "config.global" },
      { name: "local-tools", config: { type: "local", command: ["node", "server.js"] }, source: "config.project" },
    ],
    { browser: { status: "connected" } },
  );

  assert.deepEqual(rows.map((row) => `${row.name}:${row.scope}:${row.status}:${row.detail}`), [
    "browser:global:connected:https://mcp.example",
    "local-tools:workspace:disconnected:node server.js",
  ]);
});
```

**Step 2: Run the test and verify it fails**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-capabilities.test.ts
```

Expected: FAIL because the model file does not exist.

**Step 3: Implement the model**

Create `packages/app/src/app/lib/session-capabilities.ts` with exported row types and helpers:

```ts
import type { McpServerEntry, McpStatusMap, SkillInventoryItem, SkillInstance } from "../types";

export type SessionCapabilityScope = "workspace" | "global";

export type SessionSkillCapabilityRow = {
  id: string;
  name: string;
  scope: SessionCapabilityScope;
  description?: string;
  trigger?: string;
  path: string;
};

export type SessionMcpCapabilityRow = {
  id: string;
  name: string;
  scope: SessionCapabilityScope;
  type: "remote" | "local";
  detail?: string;
  status: string;
};

export function normalizeSessionCapabilityDirectory(value: string | null | undefined) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function rowFromSkillInstance(instance: SkillInstance): SessionSkillCapabilityRow {
  return {
    id: instance.id,
    name: instance.name,
    scope: instance.scope === "user-global" ? "global" : "workspace",
    description: instance.description,
    trigger: instance.trigger,
    path: instance.path,
  };
}

export function buildSessionSkillRows(items: SkillInventoryItem[]): SessionSkillCapabilityRow[] {
  return items.flatMap((item) => {
    if (item.workspaceInstances.length > 0) return item.workspaceInstances.map(rowFromSkillInstance);
    if (item.globalInstance) return [rowFromSkillInstance(item.globalInstance)];
    return [];
  });
}

export function buildSessionMcpRows(entries: McpServerEntry[], statuses: McpStatusMap): SessionMcpCapabilityRow[] {
  return entries.map((entry) => ({
    id: entry.name,
    name: entry.name,
    scope: entry.source === "config.global" ? "global" : "workspace",
    type: entry.config.type,
    detail: entry.config.type === "remote" ? entry.config.url : entry.config.command?.join(" "),
    status: entry.config.enabled === false ? "disabled" : statuses[entry.name]?.status ?? "disconnected",
  }));
}
```

Adjust exact fields as needed during implementation, but keep the public behavior covered by the tests.

**Step 4: Run the focused test**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-capabilities.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/session-capabilities.ts packages/app/src/app/lib/session-capabilities.test.ts
git commit -m "feat(app): add session capabilities model"
```

---

### Task 3: Per-Directory Loader And Cache

**Files:**
- Modify: `packages/app/src/app/lib/session-capabilities.ts`
- Modify: `packages/app/src/app/app.tsx`
- Test: `packages/app/src/app/lib/session-capabilities.test.ts`

**Step 1: Write the failing tests**

Extend `session-capabilities.test.ts` with a loader/cache test that proves the selected chat directory is the cache key and no active workspace fallback occurs:

```ts
import { createSessionCapabilitiesCache } from "./session-capabilities.js";

test("session capabilities cache loads by selected chat directory", async () => {
  const calls: string[] = [];
  const cache = createSessionCapabilitiesCache(async (scope) => {
    calls.push(scope.directory);
    return {
      directory: scope.directory,
      skills: [{ id: scope.directory, name: `skill:${scope.directory}`, scope: "workspace", path: `${scope.directory}/SKILL.md` }],
      mcp: [{ id: scope.directory, name: `mcp:${scope.directory}`, scope: "workspace", type: "remote", status: "connected" }],
    };
  });

  const first = await cache.load({ directory: "/workspaces/a" });
  const second = await cache.load({ directory: "/workspaces/a" });
  const third = await cache.load({ directory: "/workspaces/b" });

  assert.equal(first.skills[0]?.name, "skill:/workspaces/a");
  assert.equal(second.skills[0]?.name, "skill:/workspaces/a");
  assert.equal(third.skills[0]?.name, "skill:/workspaces/b");
  assert.deepEqual(calls, ["/workspaces/a", "/workspaces/b"]);
});
```

**Step 2: Run the test and verify it fails**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-capabilities.test.ts
```

Expected: FAIL because `createSessionCapabilitiesCache` does not exist.

**Step 3: Implement loader/cache primitives**

Add to `session-capabilities.ts`:

```ts
export type SessionCapabilitiesSnapshot = {
  directory: string;
  skills: SessionSkillCapabilityRow[];
  mcp: SessionMcpCapabilityRow[];
  loadedAt?: number;
};

export type SessionCapabilitiesScope = {
  directory: string;
  workspaceId?: string;
  workspaceLabel?: string;
  workspaceType?: "local" | "remote";
};

export function createSessionCapabilitiesCache(
  loadFresh: (scope: SessionCapabilitiesScope) => Promise<Omit<SessionCapabilitiesSnapshot, "loadedAt">>,
) {
  const cache = new Map<string, SessionCapabilitiesSnapshot>();

  return {
    clear() {
      cache.clear();
    },
    async load(scope: SessionCapabilitiesScope, options?: { force?: boolean }) {
      const directory = normalizeSessionCapabilityDirectory(scope.directory);
      if (!directory) throw new Error("Workspace directory for this chat is not loaded yet.");
      if (!options?.force) {
        const cached = cache.get(directory);
        if (cached) return cached;
      }
      const fresh = await loadFresh({ ...scope, directory });
      const snapshot = { ...fresh, directory, loadedAt: Date.now() };
      cache.set(directory, snapshot);
      return snapshot;
    },
  };
}
```

In `packages/app/src/app/app.tsx`, wire a Solid signal for the current snapshot:

- derive selected chat directory from `selectedSession()` using `resolveSessionDirectory(selectedSession())`
- do not call `preferredSessionWorkspaceRoot()` for this feature
- resolve a matching workspace from `workspaceStore.workspaces()` by normalized path/directory
- load local Skills with `listLocalSkillsScoped("", "global")` plus `listLocalSkillsScoped(directory, "workspace")`
- build skill inventory with `buildSkillInventory({ globalSkills, workspaceSkillsByWorkspaceId, hubSkills: [] })`
- load local MCP with the helper from Task 1
- load remote Skills/MCP through `vesloClient.listSkills(workspace.id, { includeGlobal: true })` and `vesloClient.listMcp(workspace.id)` when the selected chat maps to a connected remote workspace
- resolve MCP runtime statuses with `client().mcp.status({ directory })` only when a matching runtime client is available

Use a request version counter so slower loads from a previously selected chat cannot overwrite the current chat's snapshot.

**Step 4: Run focused tests**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/session-capabilities.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/session-capabilities.ts packages/app/src/app/lib/session-capabilities.test.ts packages/app/src/app/app.tsx
git commit -m "feat(app): load session capabilities by chat directory"
```

---

### Task 4: Right Sidebar UI

**Files:**
- Create: `packages/app/src/app/components/session/session-capabilities-panel.tsx`
- Test: `packages/app/src/app/components/session/session-capabilities-panel.test.ts`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/pages/session-sidebar-navigation-layout.test.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Step 1: Write the failing component contract test**

Create `packages/app/src/app/components/session/session-capabilities-panel.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session-capabilities-panel.tsx", import.meta.url), "utf8");

test("session capabilities panel renders Skills and MCP sections with test ids", () => {
  assert.match(source, /data-testid="session-capabilities-panel"/);
  assert.match(source, /data-testid="session-capabilities-skills"/);
  assert.match(source, /data-testid="session-capabilities-mcp"/);
  assert.match(source, /session\.capabilities_skills/);
  assert.match(source, /session\.capabilities_mcp/);
});
```

Update `session-sidebar-navigation-layout.test.ts` to require `<SessionCapabilitiesPanel` inside `rightSidebar`.

**Step 2: Run the tests and verify they fail**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/session-capabilities-panel.test.ts src/app/pages/session-sidebar-navigation-layout.test.ts
```

Expected: FAIL because the panel does not exist and is not wired into the right sidebar.

**Step 3: Implement the panel**

Create `session-capabilities-panel.tsx` as a compact read-only panel:

- props: `state`, `skills`, `mcp`, `error`, optional `onRefresh`
- collapsible sections for Skills and MCP
- show local loading/empty/error states
- show badges for `Workspace` / `Global`
- use `Package`, `Plug2`, and `ChevronDown` from `lucide-solid`
- keep text sizes compact and stable for the 280 px right sidebar

Add i18n keys in all three locale files:

```ts
"session.capabilities": "Capabilities",
"session.capabilities_skills": "Skills",
"session.capabilities_mcp": "MCP",
"session.capabilities_loading": "Loading...",
"session.capabilities_unavailable": "Workspace for this chat is not loaded yet.",
"session.capabilities_no_skills": "No Skills available.",
"session.capabilities_no_mcp": "No MCP servers configured.",
"session.capabilities_scope_workspace": "Workspace",
"session.capabilities_scope_global": "Global",
```

Use equivalent Czech and Chinese translations.

**Step 4: Wire the panel into `session.tsx`**

Modify `SessionViewProps` to accept the session capabilities state from `app.tsx`.

Import and render `<SessionCapabilitiesPanel />` below `<ArtifactsPanel />` inside `rightSidebarContent`. Keep `ArtifactsPanel` unchanged.

**Step 5: Run focused tests**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/session-capabilities-panel.test.ts src/app/pages/session-sidebar-navigation-layout.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/components/session/session-capabilities-panel.tsx packages/app/src/app/components/session/session-capabilities-panel.test.ts packages/app/src/app/pages/session.tsx packages/app/src/app/pages/session-sidebar-navigation-layout.test.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat(app): show session capabilities in right menu"
```

---

### Task 5: Desktop E2E Coverage

**Files:**
- Create: `packages/e2e/specs/session-capabilities.spec.ts`

**Step 1: Write the failing E2E spec**

Create an isolated-profile spec similar to `skills-global-inventory.e2e.ts`:

- seed a global skill under `.tmp-veslo-home/.config/opencode/skills/e2e-global-session-skill/SKILL.md`
- seed a workspace skill under `.tmp-veslo-home/workspaces/visual-workspace/.opencode/skills/e2e-workspace-session-skill/SKILL.md`
- seed global MCP in `.tmp-veslo-home/.config/opencode/opencode.jsonc`
- seed workspace MCP in `.tmp-veslo-home/workspaces/visual-workspace/opencode.jsonc`
- open `/session`
- create or select a chat in the seeded workspace
- open the right sidebar if it is not visible
- assert the panel shows the global and workspace Skills/MCP
- assert the Hub-only section does not appear

Use `data-testid` selectors from Task 4.

**Step 2: Run the desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If the output is an internally started dev/test process from this repo, stop it:

```bash
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Then verify:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Expected: no matching Veslo dev/test runtime remains.

**Step 3: Build and run the focused desktop E2E**

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/session-capabilities.spec.ts
```

Expected: FAIL before implementation is complete, PASS after Tasks 1-4.

**Step 4: Commit**

```bash
git add packages/e2e/specs/session-capabilities.spec.ts
git commit -m "test(e2e): cover session right-menu capabilities"
```

---

### Task 6: Docs And Full Verification

**Files:**
- Modify: `docs/features/session-runtime.md`

**Step 1: Update docs**

Add a short section under the session runtime right-sidebar/artifacts area:

```md
## Right Menu Capabilities

The session right menu shows a read-only summary of Skills and MCP servers available to the selected chat's workspace directory. This summary is scoped by the selected chat directory, not by the currently active runtime workspace. It includes installed workspace capabilities plus globally inherited capabilities and excludes Hub-only catalog items.
```

**Step 2: Run app checks**

Run from repo root:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/mcp.test.ts src/app/lib/session-capabilities.test.ts src/app/components/session/session-capabilities-panel.test.ts src/app/pages/session-sidebar-navigation-layout.test.ts
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: all PASS.

**Step 3: Run the focused desktop E2E**

Run the Desktop Test Runtime Preflight from Task 5, then:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/session-capabilities.spec.ts
```

Expected: PASS.

**Step 4: Commit docs and any verification-only fixes**

```bash
git add docs/features/session-runtime.md
git commit -m "docs: document session right-menu capabilities"
```

**Step 5: Final sanity**

Run:

```bash
git status --short
```

Expected: only pre-existing unrelated changes remain, or the worktree is clean.
