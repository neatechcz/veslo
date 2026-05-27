import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillInventory, skillMutationTargetFromInstance } from "./skill-inventory.js";

const hubSkill = (name: string, description = `${name} from hub`) => ({
  name,
  description,
  trigger: `${name} trigger`,
  source: {
    owner: "neatech",
    repo: "veslo-skills",
    ref: "main",
    path: `skills/${name}`,
  },
});

test("global skills are not repeated under workspaces", () => {
  const items = buildSkillInventory({
    globalSkills: [{ name: "research", path: "/global/research/SKILL.md", scope: "user-global" }],
    workspaceSkillsByWorkspaceId: {
      ws1: {
        workspace: { id: "ws1", label: "Veslo", kind: "local" },
        skills: [],
      },
    },
    hubSkills: [],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.name, "research");
  assert.equal(items[0]?.status, "global");
  assert.equal(items[0]?.globalInstance?.id, "user-global:global:research:/global/research/SKILL.md");
  assert.equal(items[0]?.workspaceInstances.length, 0);
});

test("workspace-only skills record their workspace", () => {
  const items = buildSkillInventory({
    globalSkills: [],
    workspaceSkillsByWorkspaceId: {
      ws1: {
        workspace: { id: "ws1", label: "Veslo", path: "/workspaces/veslo", kind: "local" },
        skills: [
          {
            name: "deploy",
            path: "/workspaces/veslo/.opencode/skills/deploy/SKILL.md",
            scope: "workspace",
          },
        ],
      },
    },
    hubSkills: [],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.name, "deploy");
  assert.equal(items[0]?.status, "workspace-only");
  assert.equal(items[0]?.workspaceInstances.length, 1);
  assert.equal(items[0]?.workspaceInstances[0]?.id, "workspace:ws1:deploy:/workspaces/veslo/.opencode/skills/deploy/SKILL.md");
  assert.equal(items[0]?.workspaceInstances[0]?.workspaceId, "ws1");
  assert.equal(items[0]?.workspaceInstances[0]?.workspaceLabel, "Veslo");
});

test("global plus workspace-local skills with the same name are mixed", () => {
  const items = buildSkillInventory({
    globalSkills: [
      {
        name: "research",
        path: "/global/research/SKILL.md",
        scope: "user-global",
        description: "Global research",
      },
    ],
    workspaceSkillsByWorkspaceId: {
      ws1: {
        workspace: { id: "ws1", label: "Veslo", kind: "local" },
        skills: [
          {
            name: "research",
            path: "/workspaces/veslo/.opencode/skills/research/SKILL.md",
            scope: "workspace",
            description: "Workspace research",
          },
        ],
      },
    },
    hubSkills: [],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.status, "mixed");
  assert.equal(items[0]?.description, "Global research");
  assert.equal(items[0]?.globalInstance?.path, "/global/research/SKILL.md");
  assert.equal(items[0]?.workspaceInstances.length, 1);
  assert.equal(items[0]?.workspaceInstances[0]?.path, "/workspaces/veslo/.opencode/skills/research/SKILL.md");
});

test("hub-only skills appear without installed instances", () => {
  const items = buildSkillInventory({
    globalSkills: [],
    workspaceSkillsByWorkspaceId: {},
    hubSkills: [hubSkill("planning", "Planning from hub")],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.name, "planning");
  assert.equal(items[0]?.status, "hub-only");
  assert.equal(items[0]?.description, "Planning from hub");
  assert.equal(items[0]?.hubItem?.name, "planning");
  assert.equal(items[0]?.globalInstance, undefined);
  assert.equal(items[0]?.workspaceInstances.length, 0);
});

test("hub matches attach to installed skill inventory items", () => {
  const items = buildSkillInventory({
    globalSkills: [
      {
        name: "research",
        path: "/global/research/SKILL.md",
        scope: "user-global",
        description: "Installed research",
      },
    ],
    workspaceSkillsByWorkspaceId: {},
    hubSkills: [hubSkill("research", "Hub research")],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.name, "research");
  assert.equal(items[0]?.status, "global");
  assert.equal(items[0]?.description, "Installed research");
  assert.equal(items[0]?.hubItem?.description, "Hub research");
});

test("items and workspace instances are sorted deterministically", () => {
  const items = buildSkillInventory({
    globalSkills: [{ name: "zeta", path: "/global/zeta/SKILL.md", scope: "user-global" }],
    workspaceSkillsByWorkspaceId: {
      ws2: {
        workspace: { id: "ws2", label: "Beta", kind: "local" },
        skills: [{ name: "alpha", path: "/beta/alpha/SKILL.md", scope: "workspace" }],
      },
      ws1: {
        workspace: { id: "ws1", label: "Alpha", kind: "local" },
        skills: [{ name: "alpha", path: "/alpha/alpha/SKILL.md", scope: "workspace" }],
      },
    },
    hubSkills: [hubSkill("middle")],
  });

  assert.deepEqual(
    items.map((item) => item.name),
    ["alpha", "middle", "zeta"],
  );
  assert.deepEqual(
    items[0]?.workspaceInstances.map((instance) => instance.workspaceLabel),
    ["Alpha", "Beta"],
  );
});

test("skill mutation targets keep exact instance scope, path, and workspace", () => {
  const items = buildSkillInventory({
    globalSkills: [{ name: "research", path: "/global/research/SKILL.md", scope: "user-global" }],
    workspaceSkillsByWorkspaceId: {
      ws1: {
        workspace: { id: "ws1", label: "Veslo", kind: "local" },
        skills: [
          {
            name: "research",
            path: "/workspaces/veslo/.opencode/skills/research/SKILL.md",
            scope: "workspace",
          },
        ],
      },
    },
    hubSkills: [],
  });

  const item = items[0];
  assert.ok(item?.globalInstance);
  assert.equal(item.workspaceInstances.length, 1);
  assert.deepEqual(skillMutationTargetFromInstance(item.globalInstance), {
    name: "research",
    path: "/global/research/SKILL.md",
    scope: "user-global",
  });
  assert.deepEqual(skillMutationTargetFromInstance(item.workspaceInstances[0]!), {
    name: "research",
    path: "/workspaces/veslo/.opencode/skills/research/SKILL.md",
    scope: "workspace",
    workspaceId: "ws1",
  });
});

test("managed materialized skill instances are read-only until registry mutation APIs are connected", () => {
  const items = buildSkillInventory({
    globalSkills: [],
    workspaceSkillsByWorkspaceId: {
      ws1: {
        workspace: { id: "ws1", label: "Veslo", kind: "local" },
        skills: [
          {
            name: "managed-research",
            path: "/workspaces/veslo/.opencode/skills/veslo-managed/managed-research/SKILL.md",
            scope: "workspace",
          },
        ],
      },
    },
    hubSkills: [],
  });

  assert.equal(items[0]?.workspaceInstances[0]?.writable, false);
});
