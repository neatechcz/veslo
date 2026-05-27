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

test("listSkills returns shared parser metadata for local skills", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-metadata-"));
  tempDirs.push(workspaceRoot);

  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await mkdir(join(workspaceRoot, ".opencode", "skills", "research-helper"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".opencode", "skills", "research-helper", "SKILL.md"),
    [
      "---",
      "name: research-helper",
      "description:   Research helper   ",
      "aliases:",
      "  - research",
      "  - source lookup",
      "paths: docs/**",
      "disable-model-invocation: yes",
      "user-invocable: no",
      "when_to_use: Prefer this for source-backed requests.",
      "---",
      "",
      "# Research helper",
      "",
      "## When to use",
      "- Use for source-backed research requests.",
      "",
    ].join("\n"),
    "utf8",
  );

  const items = await listSkills(workspaceRoot, false);

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    name: "research-helper",
    description: "Research helper",
    scope: "project",
    trigger: "Use for source-backed research requests.",
    disableModelInvocation: true,
    userInvocable: false,
    aliases: ["research", "source lookup"],
    whenToUse: "Prefer this for source-backed requests.",
    paths: ["docs/**"],
  });
});
