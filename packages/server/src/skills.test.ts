import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { listSkills } from "./skills.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

test("listSkills skips malformed skill entries instead of failing the entire listing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-list-"));
  tempDirs.push(workspaceRoot);

  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await mkdir(join(workspaceRoot, ".opencode", "skills", "valid-skill"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".opencode", "skills", "valid-skill", "SKILL.md"),
    "---\nname: valid-skill\ndescription: valid skill\n---\n\n# Valid Skill\n",
    "utf8",
  );

  // Simulate corrupted skill layout where SKILL.md path exists as a directory.
  await mkdir(join(workspaceRoot, ".opencode", "skills", "broken-skill", "SKILL.md"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, ".opencode", "skills", "malformed-skill"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, ".opencode", "skills", "malformed-skill", "SKILL.md"),
    "---\nname: malformed-skill\ndescription: [broken\n---\n\n# Broken\n",
    "utf8",
  );

  const items = await listSkills(workspaceRoot, false);
  expect(items.map((item) => item.name)).toEqual(["valid-skill"]);
});
