import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionMcpRows,
  buildSessionSkillRows,
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
