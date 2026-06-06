import assert from "node:assert/strict";
import test from "node:test";

import type {
  SkillInstance,
  SkillInventoryItem,
  SkillInventoryStatus,
  WorkspaceSkillRegistryInstallation,
} from "../types";
import {
  filterSkillInventoryItems,
  selectAllSkillInventoryIdsForCurrentFilter,
} from "./skill-inventory-filters.js";

type InventoryItemWithMetadata = SkillInventoryItem & {
  deletedAt?: string | null;
  registryInstallation?: WorkspaceSkillRegistryInstallation;
};

type SkillInstanceWithMetadata = SkillInstance & {
  deletedAt?: string | null;
  registryInstallation?: WorkspaceSkillRegistryInstallation;
};

const installation = (input: {
  installationId: string;
  name: string;
  approved?: boolean;
  enabled?: boolean;
  workspaceId?: string | null;
}): WorkspaceSkillRegistryInstallation => ({
  installationId: input.installationId,
  skillId: `${input.name}-skill`,
  name: input.name,
  versionId: `${input.name}-v1`,
  packageSha256: `${input.name}-sha`,
  enabled: input.enabled ?? true,
  source: input.workspaceId ? "workspace" : "organization",
  installedAt: "2026-05-27T00:00:00.000Z",
  orgId: "org-1",
  workspaceId: input.workspaceId ?? null,
  approved: input.approved,
});

const instance = (
  input: Partial<SkillInstanceWithMetadata> & Pick<SkillInstance, "id" | "name" | "path" | "scope">,
): SkillInstanceWithMetadata => ({
  description: `${input.name} description`,
  trigger: `${input.name} trigger`,
  source: "opencode",
  enabled: true,
  readable: true,
  writable: true,
  ...input,
});

const item = (
  input: Partial<InventoryItemWithMetadata> & Pick<SkillInventoryItem, "name" | "status">,
): InventoryItemWithMetadata => ({
  description: `${input.name} description`,
  trigger: `${input.name} trigger`,
  workspaceInstances: [],
  ...input,
});

const inventory = (): InventoryItemWithMetadata[] => [
  item({
    name: "deploy",
    description: "Deploy Alpha service",
    trigger: "release alpha",
    status: "workspace-only",
    workspaceInstances: [
      instance({
        id: "workspace:ws-alpha:deploy:/alpha/deploy/SKILL.md",
        name: "deploy",
        scope: "workspace",
        workspaceId: "ws-alpha",
        workspaceLabel: "Alpha",
        path: "/alpha/deploy/SKILL.md",
        registryInstallation: installation({
          installationId: "install-deploy-alpha",
          name: "deploy",
          approved: true,
          workspaceId: "ws-alpha",
        }),
      }),
      instance({
        id: "workspace:ws-beta:deploy:/beta/deploy/SKILL.md",
        name: "deploy",
        scope: "workspace",
        workspaceId: "ws-beta",
        workspaceLabel: "Beta",
        path: "/beta/deploy/SKILL.md",
        registryInstallation: installation({
          installationId: "install-deploy-beta",
          name: "deploy",
          approved: false,
          workspaceId: "ws-beta",
        }),
      }),
    ],
  }),
  item({
    name: "research",
    description: "Research the product catalog",
    status: "global",
    globalInstance: instance({
      id: "user-global:global:research:/global/research/SKILL.md",
      name: "research",
      scope: "user-global",
      path: "/global/research/SKILL.md",
      trigger: "market scan",
    }),
  }),
  item({
    name: "planning",
    description: "Roadmap planning from hub",
    status: "hub-only",
    hubItem: {
      name: "planning",
      description: "Roadmap planning from hub",
      trigger: "plan roadmap",
      source: {
        owner: "neatech",
        repo: "veslo-skills",
        ref: "main",
        path: "skills/planning",
      },
    },
  }),
  item({
    name: "legacy",
    description: "Restorable legacy skill",
    status: "workspace-only",
    deletedAt: "2026-05-01T00:00:00.000Z",
    workspaceInstances: [
      instance({
        id: "workspace:ws-alpha:legacy:/alpha/legacy/SKILL.md",
        name: "legacy",
        scope: "workspace",
        workspaceId: "ws-alpha",
        workspaceLabel: "Alpha",
        path: "/alpha/legacy/SKILL.md",
        deletedAt: "2026-05-01T00:00:00.000Z",
      }),
    ],
  }),
];

test("filters by text query across item, instance, and hub metadata", () => {
  assert.deepEqual(
    filterSkillInventoryItems(inventory(), { query: "alpha service" }).map((entry) => entry.name),
    ["deploy"],
  );
  assert.deepEqual(
    filterSkillInventoryItems(inventory(), { query: "market scan" }).map((entry) => entry.name),
    ["research"],
  );
  assert.deepEqual(
    filterSkillInventoryItems(inventory(), { query: "veslo-skills planning" }).map((entry) => entry.name),
    ["planning"],
  );
});

test("filters by workspace and narrows workspace instances to that workspace", () => {
  const [deploy] = filterSkillInventoryItems(inventory(), { workspaceId: "ws-alpha" });

  assert.equal(deploy?.name, "deploy");
  assert.equal(deploy.workspaceInstances.length, 1);
  assert.equal(deploy.workspaceInstances[0]?.workspaceId, "ws-alpha");
});

test("filters by inventory status and scope", () => {
  assert.deepEqual(
    filterSkillInventoryItems(inventory(), { statuses: ["hub-only"] }).map((entry) => entry.name),
    ["planning"],
  );
  assert.deepEqual(
    filterSkillInventoryItems(inventory(), { scopes: ["user-global"] }).map((entry) => entry.name),
    ["research"],
  );
  assert.deepEqual(
    filterSkillInventoryItems(inventory(), { scopes: ["workspace"], includeDeleted: true }).map((entry) => entry.name),
    ["deploy", "legacy"],
  );
});

test("filters by represented approval metadata without requiring base inventory type changes", () => {
  const approved = filterSkillInventoryItems(inventory(), { approval: "approved" });
  assert.deepEqual(
    approved.map((entry) => entry.name),
    ["deploy"],
  );
  assert.deepEqual(
    approved[0]?.workspaceInstances.map((entry) => entry.workspaceId),
    ["ws-alpha"],
  );

  const unapproved = filterSkillInventoryItems(inventory(), { approval: "unapproved" });
  assert.deepEqual(
    unapproved.map((entry) => entry.name),
    ["deploy"],
  );
  assert.deepEqual(
    unapproved[0]?.workspaceInstances.map((entry) => entry.workspaceId),
    ["ws-beta"],
  );
});

test("excludes represented deleted entries unless includeDeleted is true", () => {
  assert.deepEqual(
    filterSkillInventoryItems(inventory(), {}).map((entry) => entry.name),
    ["deploy", "research", "planning"],
  );
  assert.deepEqual(
    filterSkillInventoryItems(inventory(), { includeDeleted: true }).map((entry) => entry.name),
    ["deploy", "research", "planning", "legacy"],
  );
});

test("select all current filter returns stable item and instance ids in visible order", () => {
  assert.deepEqual(selectAllSkillInventoryIdsForCurrentFilter(inventory(), { query: "deploy" }), [
    "instance:workspace:ws-alpha:deploy:/alpha/deploy/SKILL.md",
    "instance:workspace:ws-beta:deploy:/beta/deploy/SKILL.md",
  ]);

  assert.deepEqual(selectAllSkillInventoryIdsForCurrentFilter(inventory(), { statuses: ["hub-only"] }), [
    "item:planning",
  ]);

  assert.deepEqual(selectAllSkillInventoryIdsForCurrentFilter(inventory(), { workspaceId: "ws-beta" }), [
    "instance:workspace:ws-beta:deploy:/beta/deploy/SKILL.md",
  ]);
});

test("keeps the input inventory immutable while returning filtered item copies", () => {
  const original = inventory();
  const result = filterSkillInventoryItems(original, { workspaceId: "ws-alpha" });

  assert.equal(result[0]?.workspaceInstances.length, 1);
  assert.equal(original[0]?.workspaceInstances.length, 2);
  assert.notEqual(result[0], original[0]);
});
