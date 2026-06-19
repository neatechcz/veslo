import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { listCommands } from "../commands.js";
import { addMcp, listMcp } from "../mcp.js";
import { addPlugin, listPlugins } from "../plugins.js";
import {
  localUserResourceOwner,
  managedSkillSourceResourceOwner,
  resourceOwnerKey,
  workspaceResourceOwner,
} from "../resource-owner.js";
import { listSkills } from "../skills.js";
import { listUserGlobalSkills, upsertUserGlobalSkill } from "../user-skill-store.js";

const tempDirs: string[] = [];

async function createTempRoot(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `veslo-resource-owner-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace inventory resources expose the same owner envelope", async () => {
  const workspaceRoot = await createTempRoot("workspace");
  const owner = workspaceResourceOwner({
    workspaceId: "ws_owner",
    root: workspaceRoot,
    label: "Owner workspace",
  });

  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await mkdir(join(workspaceRoot, ".opencode", "skills", "audit-helper"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".opencode", "skills", "audit-helper", "SKILL.md"),
    "---\nname: audit-helper\ndescription: Audit helper\n---\n\n# Audit helper\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, ".opencode", "commands"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".opencode", "commands", "audit.md"),
    "---\nname: audit\ndescription: Audit command\n---\n\nRun the audit.\n",
    "utf8",
  );
  await addMcp(workspaceRoot, "audit-mcp", {
    type: "local",
    command: ["node", "server.js"],
    enabled: true,
  });
  await addPlugin(workspaceRoot, "file:./plugins/audit.js");

  const mcp = await listMcp(workspaceRoot, { workspaceOwner: owner });
  const skills = await listSkills(workspaceRoot, false, { workspaceOwner: owner });
  const plugins = await listPlugins(workspaceRoot, false, { workspaceOwner: owner });
  const commands = await listCommands(workspaceRoot, "workspace", { workspaceOwner: owner });

  expect(mcp.find((item) => item.name === "audit-mcp")?.owner).toEqual(owner);
  expect(skills.find((item) => item.name === "audit-helper")?.owner).toEqual(owner);
  expect(plugins.items.find((item) => item.spec === "file:./plugins/audit.js")?.owner).toEqual(owner);
  expect(commands.find((item) => item.name === "audit")?.owner).toEqual(owner);
  expect(resourceOwnerKey(owner)).toBe("workspace:ws_owner");
});

test("user-global skill store exposes a user owner envelope", async () => {
  const dataDir = await createTempRoot("data");
  const owner = localUserResourceOwner({ userId: "user_1", label: "Local user" });

  await upsertUserGlobalSkill(
    {
      name: "portable-helper",
      description: "Portable helper",
      content: "# Portable helper\n",
    },
    dataDir,
    { owner },
  );

  const items = await listUserGlobalSkills(dataDir, { owner });

  expect(items).toHaveLength(1);
  expect(items[0]?.owner).toEqual(owner);
  expect(resourceOwnerKey(owner)).toBe("user:user_1");
});

test("managed skill sources resolve to the shared owner envelope", () => {
  expect(managedSkillSourceResourceOwner("personal", { userId: "user_1" })).toEqual({
    kind: "user",
    id: "user_1",
  });
  expect(managedSkillSourceResourceOwner("workspace", { workspaceId: "ws_1" })).toEqual({
    kind: "workspace",
    id: "ws_1",
  });
  expect(managedSkillSourceResourceOwner("organization", { orgId: "org_1" })).toEqual({
    kind: "organization",
    id: "org_1",
  });
  expect(managedSkillSourceResourceOwner("platform")).toEqual({
    kind: "platform",
    id: "veslo-platform",
  });
});
