import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { listSkills } from "./skills.js";
import type { DisabledSkillRecord } from "./types.js";

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

test("listSkills filters disabled skills before de-duping duplicate names", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-disabled-dedupe-"));
  const homeDir = await mkdtemp(join(tmpdir(), "veslo-skills-disabled-dedupe-home-"));
  tempDirs.push(workspaceRoot, homeDir);

  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await mkdir(join(workspaceRoot, ".opencode", "skills", "shared-skill"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".opencode", "skills", "shared-skill", "SKILL.md"),
    "---\nname: shared-skill\ndescription: Disabled workspace skill\n---\n\n# Workspace\n",
    "utf8",
  );
  await mkdir(join(homeDir, ".config", "opencode", "skills", "shared-skill"), { recursive: true });
  await writeFile(
    join(homeDir, ".config", "opencode", "skills", "shared-skill", "SKILL.md"),
    "---\nname: shared-skill\ndescription: Enabled global skill\n---\n\n# Global\n",
    "utf8",
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const disabledSkills: DisabledSkillRecord[] = [
      {
        id: "workspace:ws_1:shared-skill",
        name: "shared-skill",
        scope: "workspace",
        workspaceId: "ws_1",
        path: join(workspaceRoot, ".opencode", "skills", "shared-skill", "SKILL.md"),
        disabledAt: new Date(0).toISOString(),
      },
    ];

    const items = await listSkills(workspaceRoot, {
      includeGlobal: true,
      disabledSkills,
      workspaceId: "ws_1",
    });

    expect(items.map((item) => ({ name: item.name, scope: item.scope, path: item.path }))).toEqual([
      {
        name: "shared-skill",
        scope: "global",
        path: join(homeDir, ".config", "opencode", "skills", "shared-skill", "SKILL.md"),
      },
    ]);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("listSkills path matching keeps disabled scope boundaries", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-disabled-scope-"));
  tempDirs.push(workspaceRoot);

  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  await mkdir(join(workspaceRoot, ".opencode", "skills", "workspace-skill"), { recursive: true });
  const workspaceSkillPath = join(workspaceRoot, ".opencode", "skills", "workspace-skill", "SKILL.md");
  await writeFile(
    workspaceSkillPath,
    "---\nname: workspace-skill\ndescription: Workspace skill\n---\n\n# Workspace\n",
    "utf8",
  );

  const items = await listSkills(workspaceRoot, {
    includeGlobal: false,
    disabledSkills: [
      {
        id: "wrong-scope",
        name: "workspace-skill",
        scope: "user-global",
        path: workspaceSkillPath,
        disabledAt: new Date(0).toISOString(),
      },
    ],
    workspaceId: "ws_1",
  });

  expect(items).toHaveLength(1);
  expect(items[0]?.enabled).not.toBe(false);
});
