import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionMcpRows,
  buildSessionSkillRows,
  createSessionCapabilitiesCache,
  normalizeSessionCapabilityDirectory,
} from "./session-capabilities.js";

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

test("buildSessionMcpRows preserves failed status detail", () => {
  const rows = buildSessionMcpRows(
    [{ name: "broken", config: { type: "remote", url: "https://broken.example" }, source: "config.project" }],
    { broken: { status: "failed", error: "connection refused" } },
  );

  assert.deepEqual(rows.map((row) => `${row.name}:${row.status}:${row.statusDetail}`), [
    "broken:failed:connection refused",
  ]);
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
