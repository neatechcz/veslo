import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { prepareSkillAdoptionRequest } from "./skill-adoption.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const writeSkill = async (root: string, name = "meeting-notes") => {
  const skillDir = join(root, name);
  await mkdir(join(skillDir, "scripts"), { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Meeting notes\n---\n# ${name}\n`,
    "utf8",
  );
  await writeFile(join(skillDir, "scripts", "run.sh"), "echo ok\n", "utf8");
  return skillDir;
};

describe("skill adoption", () => {
  test("packages an unmanaged local skill for personal registry adoption", async () => {
    const root = await tempDir("veslo-skill-adoption-");
    const skillDir = await writeSkill(root);

    const request = await prepareSkillAdoptionRequest({
      skillDir,
      target: { scope: "personal-global" },
    });

    expect(request.target).toEqual({ scope: "personal-global" });
    expect(request.package.metadata.name).toBe("meeting-notes");
    expect(request.package.files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
  });

  test("packages an unmanaged workspace skill with workspace target metadata", async () => {
    const root = await tempDir("veslo-skill-adoption-workspace-");
    const skillDir = await writeSkill(root, "workspace-helper");

    const request = await prepareSkillAdoptionRequest({
      skillDir,
      target: { scope: "workspace", workspaceId: " ws_1 " },
    });

    expect(request.target).toEqual({ scope: "workspace", workspaceId: "ws_1" });
    expect(request.package.metadata.name).toBe("workspace-helper");
  });

  test("refuses to adopt managed registry skill directories again", async () => {
    const root = await tempDir("veslo-skill-adoption-managed-");
    const skillDir = await writeSkill(root);
    await writeFile(join(skillDir, ".veslo-managed.json"), "{}\n", "utf8");

    await expect(
      prepareSkillAdoptionRequest({
        skillDir,
        target: { scope: "personal-global" },
      }),
    ).rejects.toThrow(/already adopted/);
  });

  test("workspace adoption requires a workspace id", async () => {
    const root = await tempDir("veslo-skill-adoption-target-");
    const skillDir = await writeSkill(root);

    await expect(
      prepareSkillAdoptionRequest({
        skillDir,
        target: { scope: "workspace" },
      }),
    ).rejects.toThrow(/workspaceId/);
  });
});

