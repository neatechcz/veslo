import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { listSkills } from "../skills.js";
import {
  deleteUserGlobalSkill,
  listUserGlobalSkills,
  materializeUserGlobalSkillsForWorkspace,
  readUserGlobalSkill,
  upsertUserGlobalSkill,
  userGlobalMaterializedSkillsRoot,
} from "../user-skill-store.js";

const tempDirs: string[] = [];

async function createTempRoot(label: string) {
  const dir = await mkdtemp(join(tmpdir(), `veslo-user-skill-store-${label}-`));
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

test("stores user-global skills as normalized markdown records", async () => {
  const dataDir = await createTempRoot("data");

  const result = await upsertUserGlobalSkill(
    {
      name: "audit-helper",
      description: "Audit helper",
      content: "# Audit helper\n\nUse this for audit notes.\n",
    },
    dataDir,
  );

  expect(result.action).toBe("added");
  expect(result.item).toMatchObject({
    name: "audit-helper",
    description: "Audit helper",
    enabled: true,
    scope: "user-global",
    source: "veslo-user-store",
  });
  expect(result.item.path).toBe("veslo-user-store://audit-helper");

  const items = await listUserGlobalSkills(dataDir);
  expect(items.map((item) => item.name)).toEqual(["audit-helper"]);

  const stored = await readUserGlobalSkill("audit-helper", dataDir);
  expect(stored.content).toContain("name: audit-helper");
  expect(stored.content).toContain("description: Audit helper");
  expect(stored.content).toContain("# Audit helper");
});

test("materializes enabled user-global skills into a workspace-managed category", async () => {
  const dataDir = await createTempRoot("data");
  const workspaceRoot = await createTempRoot("workspace");
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });

  await upsertUserGlobalSkill(
    {
      name: "portable-helper",
      description: "Portable helper",
      content: "# Portable helper\n\nUse this helper in any workspace.\n",
    },
    dataDir,
  );

  const first = await materializeUserGlobalSkillsForWorkspace({ workspaceRoot, dataDir });
  expect(first.reloadRequired).toBe(true);
  expect(first.conflicts).toEqual([]);
  expect(first.materializedSkills.map((entry) => entry.name)).toEqual(["portable-helper"]);

  const materializedPath = join(
    userGlobalMaterializedSkillsRoot(workspaceRoot),
    "portable-helper",
    "SKILL.md",
  );
  const content = await readFile(materializedPath, "utf8");
  expect(content).toContain("name: portable-helper");

  const listed = await listSkills(workspaceRoot, false);
  expect(listed.map((item) => item.name)).toEqual(["portable-helper"]);

  const second = await materializeUserGlobalSkillsForWorkspace({ workspaceRoot, dataDir });
  expect(second.reloadRequired).toBe(false);

  await deleteUserGlobalSkill("portable-helper", dataDir);
  const removed = await materializeUserGlobalSkillsForWorkspace({ workspaceRoot, dataDir });
  expect(removed.reloadRequired).toBe(true);
  expect(removed.removedSkillNames).toEqual(["portable-helper"]);
});

test("materializes user-global skill support files and restores them when missing", async () => {
  const dataDir = await createTempRoot("data");
  const workspaceRoot = await createTempRoot("workspace");
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });

  await upsertUserGlobalSkill(
    {
      name: "portable-helper",
      description: "Portable helper",
      content: "# Portable helper\n\nUse this helper in any workspace.\n",
      files: [
        {
          path: "scripts/helper.sh",
          content: Buffer.from("#!/usr/bin/env bash\necho helper\n", "utf8"),
        },
      ],
    },
    dataDir,
  );

  const first = await materializeUserGlobalSkillsForWorkspace({ workspaceRoot, dataDir });
  const helperPath = join(
    userGlobalMaterializedSkillsRoot(workspaceRoot),
    "portable-helper",
    "scripts",
    "helper.sh",
  );

  expect(first.reloadRequired).toBe(true);
  expect(await readFile(helperPath, "utf8")).toContain("echo helper");

  const second = await materializeUserGlobalSkillsForWorkspace({ workspaceRoot, dataDir });
  expect(second.reloadRequired).toBe(false);

  await rm(helperPath, { force: true });
  const repaired = await materializeUserGlobalSkillsForWorkspace({ workspaceRoot, dataDir });

  expect(repaired.reloadRequired).toBe(true);
  expect(await readFile(helperPath, "utf8")).toContain("echo helper");
});

test("does not materialize over an existing workspace skill with the same name", async () => {
  const dataDir = await createTempRoot("data");
  const workspaceRoot = await createTempRoot("workspace");
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await mkdir(join(workspaceRoot, ".opencode", "skills", "audit-helper"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".opencode", "skills", "audit-helper", "SKILL.md"),
    "---\nname: audit-helper\ndescription: Workspace owned helper\n---\n\n# Workspace owned helper\n",
    "utf8",
  );

  await upsertUserGlobalSkill(
    {
      name: "audit-helper",
      description: "User-global helper",
      content: "# User-global helper\n",
    },
    dataDir,
  );

  const result = await materializeUserGlobalSkillsForWorkspace({ workspaceRoot, dataDir });

  expect(result.reloadRequired).toBe(false);
  expect(result.materializedSkills).toEqual([]);
  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0]).toMatchObject({
    code: "local-skill-conflict",
    name: "audit-helper",
  });
});

test("does not overwrite an unmanaged directory inside the user materialization category", async () => {
  const dataDir = await createTempRoot("data");
  const workspaceRoot = await createTempRoot("workspace");
  const unmanagedDir = join(workspaceRoot, ".opencode", "skills", "veslo-user", "audit-helper");
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await mkdir(unmanagedDir, { recursive: true });
  await writeFile(
    join(unmanagedDir, "SKILL.md"),
    "---\nname: audit-helper\ndescription: Unmanaged helper\n---\n\n# Unmanaged helper\n",
    "utf8",
  );

  await upsertUserGlobalSkill(
    {
      name: "audit-helper",
      description: "User-global helper",
      content: "# User-global helper\n",
    },
    dataDir,
  );

  const result = await materializeUserGlobalSkillsForWorkspace({ workspaceRoot, dataDir });
  const content = await readFile(join(unmanagedDir, "SKILL.md"), "utf8");

  expect(result.reloadRequired).toBe(false);
  expect(result.materializedSkills).toEqual([]);
  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0]).toMatchObject({
    code: "local-skill-conflict",
    name: "audit-helper",
    localPath: unmanagedDir,
  });
  expect(content).toContain("# Unmanaged helper");
});
