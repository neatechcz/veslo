import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSessionMcpRows,
  buildSessionSkillRows,
  createSessionCapabilitiesCache,
  filterSessionSkillInventoryByScope,
  normalizeSessionCapabilityDirectory,
  resolveSessionCapabilitySessionSource,
} from "../../lib/session-capabilities.js";

test("normalizeSessionCapabilityDirectory does not fall back to the active workspace", () => {
  assert.equal(normalizeSessionCapabilityDirectory("  /workspaces/chat-a  "), "/workspaces/chat-a");
  assert.equal(normalizeSessionCapabilityDirectory("/"), "/");
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
        enabled: true,
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
          enabled: true,
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

  assert.deepEqual(rows.map((row) => `${row.name}:${row.scope}:${row.description}:${row.enabled}`), [
    "research:workspace:Workspace research:true",
  ]);
});

test("buildSessionSkillRows preserves disabled skill state and inherited scopes", () => {
  const rows = buildSessionSkillRows([
    {
      name: "veslo-automations",
      status: "global",
      globalInstance: {
        id: "platform:veslo-automations",
        name: "veslo-automations",
        scope: "platform",
        path: "/managed/veslo-automations/SKILL.md",
        source: "opencode",
        enabled: false,
        disabledReason: "user",
        readable: false,
        writable: false,
      },
      workspaceInstances: [],
    },
  ]);

  assert.deepEqual(rows.map((row) => `${row.name}:${row.scope}:${row.enabled}:${row.disabledReason}`), [
    "veslo-automations:global:false:user",
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

test("buildSessionMcpRows preserves failed status detail", () => {
  const rows = buildSessionMcpRows(
    [{ name: "broken", config: { type: "remote", url: "https://broken.example" }, source: "config.project" }],
    { broken: { status: "failed", error: "connection refused" } },
  );

  assert.deepEqual(rows.map((row) => `${row.name}:${row.status}:${row.statusDetail}`), [
    "broken:failed:connection refused",
  ]);
});

test("filterSessionSkillInventoryByScope uses app-wide inventory for selected session workspace", () => {
  const scoped = filterSessionSkillInventoryByScope(
    [
      {
        name: "global-only",
        status: "global",
        globalInstance: {
          id: "global:global-only",
          name: "global-only",
          scope: "user-global",
          path: "/home/user/.config/opencode/skills/global-only/SKILL.md",
          source: "opencode",
          enabled: true,
          readable: true,
          writable: true,
        },
        workspaceInstances: [],
      },
      {
        name: "research",
        status: "mixed",
        globalInstance: {
          id: "global:research",
          name: "research",
          scope: "user-global",
          path: "/home/user/.config/opencode/skills/research/SKILL.md",
          description: "Global research",
          source: "opencode",
          enabled: true,
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
            enabled: true,
            readable: true,
            writable: true,
          },
          {
            id: "workspace:ws-b:research",
            name: "research",
            scope: "workspace",
            workspaceId: "ws-b",
            workspaceLabel: "Workspace B",
            path: "/workspaces/b/.opencode/skills/research/SKILL.md",
            description: "Other workspace research",
            source: "opencode",
            enabled: true,
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
    ],
    { workspaceId: "ws-a", directory: "/workspaces/a" },
  );

  assert.deepEqual(buildSessionSkillRows(scoped).map((row) => `${row.name}:${row.scope}:${row.description ?? ""}`), [
    "global-only:global:",
    "research:workspace:Workspace research",
  ]);
});

test("resolveSessionCapabilitySessionSource falls back to sidebar DB session before workspace activation", () => {
  const source = resolveSessionCapabilitySessionSource({
    selectedSessionId: "sess-a",
    selectedSession: { id: "sess-a", directory: "" },
    workspaceGroups: [
      {
        workspace: { id: "ws-a", path: "/workspaces/a" },
        sessions: [{ id: "sess-a", directory: "/workspaces/a" }],
      },
    ],
    resolveDirectory: (session) => session.directory ?? "",
  });

  assert.equal(source?.session.directory, "/workspaces/a");
  assert.deepEqual(source?.workspace, { id: "ws-a", path: "/workspaces/a" });
});

test("resolveSessionCapabilitySessionSource can use a selected id with a persisted directory override", () => {
  const source = resolveSessionCapabilitySessionSource({
    selectedSessionId: "sess-a",
    selectedSession: null,
    workspaceGroups: [],
    resolveDirectory: (session) => session.id === "sess-a" ? "/workspaces/a" : "",
  });

  assert.deepEqual(source?.session, { id: "sess-a", directory: "/workspaces/a" });
});

test("app session capabilities project local skills from the shared inventory surface without refreshing it", () => {
  const source = readFileSync(new URL("../../context/session-capabilities-store.ts", import.meta.url), "utf8");

  assert.match(source, /filterSessionSkillInventoryByScope\(deps\.skillInventory\(\),/);
  assert.doesNotMatch(source, /refreshSkillInventory/);
  assert.doesNotMatch(source, /listLocalSkillsScoped\(directory,\s*"workspace"\)/);
});

test("app shell bootstraps the shared local skill inventory outside the session sidebar", () => {
  const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

  assert.match(
    appSource,
    /const activeLocalSkillInventoryContext = createMemo\(\(\) => \{[\s\S]*workspaceType === "local" && workspaceId && workspaceRoot[\s\S]*createEffect\([\s\S]*on\(activeLocalSkillInventoryContext,[\s\S]*void refreshSkillInventory\(\)\.catch\(\(error: unknown\) =>[\s\S]*"skills\.refreshInventory\.bootstrap"/,
    "the app shell should react to a local workspace context and populate the shared inventory while the session sidebar remains read-only",
  );
});

test("session capabilities cache loads by selected chat directory", async () => {
  const calls: string[] = [];
  const cache = createSessionCapabilitiesCache(async (scope) => {
    calls.push(scope.directory);
    return {
      directory: scope.directory,
      skills: [
        {
          id: scope.directory,
          name: `skill:${scope.directory}`,
          scope: "workspace",
          path: `${scope.directory}/SKILL.md`,
          enabled: true,
        },
      ],
      mcp: [
        {
          id: scope.directory,
          name: `mcp:${scope.directory}`,
          scope: "workspace",
          type: "remote",
          status: "connected",
        },
      ],
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

test("session capabilities cache rejects sessions without a directory", async () => {
  const cache = createSessionCapabilitiesCache(async (scope) => ({
    directory: scope.directory,
    skills: [],
    mcp: [],
  }));

  await assert.rejects(
    () => cache.load({ directory: "" }),
    /Workspace directory for this chat is not loaded yet\./,
  );
});

test("session capabilities cache supports force reload and clear", async () => {
  let calls = 0;
  const cache = createSessionCapabilitiesCache(async (scope) => {
    calls += 1;
    return {
      directory: scope.directory,
      skills: [
        {
          id: `${scope.directory}:${calls}`,
          name: `skill:${calls}`,
          scope: "workspace",
          path: `${scope.directory}/SKILL.md`,
          enabled: true,
        },
      ],
      mcp: [],
    };
  });

  assert.equal((await cache.load({ directory: "/workspaces/a" })).skills[0]?.name, "skill:1");
  assert.equal((await cache.load({ directory: "/workspaces/a" })).skills[0]?.name, "skill:1");
  assert.equal((await cache.load({ directory: "/workspaces/a" }, { force: true })).skills[0]?.name, "skill:2");
  cache.clear();
  assert.equal((await cache.load({ directory: "/workspaces/a" })).skills[0]?.name, "skill:3");
});

test("session capabilities cache ignores stale same-directory writes", async () => {
  const resolvers: Array<() => void> = [];
  const cache = createSessionCapabilitiesCache(
    (scope) =>
      new Promise((resolve) => {
        const index = resolvers.length + 1;
        resolvers.push(() =>
          resolve({
            directory: scope.directory,
            skills: [
              {
                id: `${scope.directory}:${index}`,
                name: `skill:${index}`,
                scope: "workspace",
                path: `${scope.directory}/SKILL.md`,
                enabled: true,
              },
            ],
            mcp: [],
          }),
        );
      }),
  );

  const first = cache.load({ directory: "/workspaces/a" }, { force: true });
  const second = cache.load({ directory: "/workspaces/a" }, { force: true });
  assert.equal(resolvers.length, 2);

  resolvers[1]?.();
  assert.equal((await second).skills[0]?.name, "skill:2");

  resolvers[0]?.();
  assert.equal((await first).skills[0]?.name, "skill:1");

  assert.equal((await cache.load({ directory: "/workspaces/a" })).skills[0]?.name, "skill:2");
});
