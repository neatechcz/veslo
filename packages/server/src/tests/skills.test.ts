import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { listActiveWorkspaceSkills, listSkills } from "../skills.js";
import type { DisabledSkillRecord } from "../types.js";

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

test("listActiveWorkspaceSkills resolves workspace .agents skills through the effective view", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-agents-runtime-"));
  tempDirs.push(workspaceRoot);

  await mkdir(join(workspaceRoot, ".agents", "skills", "agents-runtime"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".agents", "skills", "agents-runtime", "SKILL.md"),
    "---\nname: agents-runtime\ndescription: Workspace agent compatibility skill\n---\n\n# Agents runtime\n",
    "utf8",
  );

  const skills = await listActiveWorkspaceSkills(workspaceRoot);

  expect(skills).toHaveLength(1);
  expect(skills[0]).toMatchObject({
    name: "agents-runtime",
    path: join(workspaceRoot, ".agents", "skills", "agents-runtime", "SKILL.md"),
    scope: "project",
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

test("listSkills discovers materialized user-global skills under XDG_CONFIG_HOME", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeDir = await mkdtemp(join(tmpdir(), "veslo-skills-xdg-home-"));
  const xdgConfigHome = await mkdtemp(join(tmpdir(), "veslo-skills-xdg-config-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-xdg-workspace-"));
  tempDirs.push(homeDir, xdgConfigHome, workspaceRoot);

  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;

  try {
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    const skillDir = join(xdgConfigHome, "opencode", "skills", "veslo-managed", "veslo-docx");
    const skillPath = join(skillDir, "SKILL.md");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      skillPath,
      [
        "---",
        "name: veslo-docx",
        "description: Create, edit, analyze, convert, and validate Word DOCX documents using standard skill execution.",
        "aliases:",
        "  - MS Word",
        "  - Microsoft Word",
        "when_to_use: Use for Word and DOCX document workflows.",
        "---",
        "",
        "# DOCX creation, editing, and analysis",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(skillDir, ".veslo-managed.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          installationId: "rollout:policy_platform_docx",
          skillId: "skill_platform_docx",
          name: "veslo-docx",
          versionId: "version_platform_docx_1",
          packageSha256: "a".repeat(64),
          target: "personal-global",
          source: "platform",
          removalPolicy: "locked",
          skillDir,
          materializedAt: new Date(0).toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const items = await listSkills(workspaceRoot, { includeGlobal: true });

    expect(items).toContainEqual(
      expect.objectContaining({
        name: "veslo-docx",
        scope: "global",
        description: "Create, edit, analyze, convert, and validate Word DOCX documents using standard skill execution.",
        aliases: ["MS Word", "Microsoft Word"],
        whenToUse: "Use for Word and DOCX document workflows.",
        registry: expect.objectContaining({
          policyId: "policy_platform_docx",
          skillId: "skill_platform_docx",
          versionId: "version_platform_docx_1",
          source: "platform",
          removalPolicy: "locked",
        }),
      }),
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
  }
});

test("listActiveWorkspaceSkills never promotes a raw user-global skill", async () => {
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const homeDir = await mkdtemp(join(tmpdir(), "veslo-active-skills-home-"));
  const xdgConfigHome = await mkdtemp(join(tmpdir(), "veslo-active-skills-xdg-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-active-skills-workspace-"));
  tempDirs.push(homeDir, xdgConfigHome, workspaceRoot);

  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  try {
    await mkdir(join(workspaceRoot, ".opencode", "skills", "workspace-only"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".opencode", "skills", "workspace-only", "SKILL.md"),
      "---\nname: workspace-only\ndescription: Workspace-only skill\n---\n",
      "utf8",
    );
    await mkdir(join(xdgConfigHome, "opencode", "skills", "raw-global"), { recursive: true });
    await writeFile(
      join(xdgConfigHome, "opencode", "skills", "raw-global", "SKILL.md"),
      "---\nname: raw-global\ndescription: Must not be active\n---\n",
      "utf8",
    );

    const items = await listActiveWorkspaceSkills(workspaceRoot);
    expect(items.map((item) => item.name)).toEqual(["workspace-only"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
});

test("active workspace resolution stops at the registered workspace root", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "veslo-active-skills-parent-repo-"));
  const workspaceRoot = join(repoRoot, ".tmp", "fixture-workspace");
  tempDirs.push(repoRoot);

  await mkdir(join(repoRoot, ".git"), { recursive: true });
  await mkdir(join(repoRoot, ".opencode", "skills", "parent-only"), { recursive: true });
  await writeFile(
    join(repoRoot, ".opencode", "skills", "parent-only", "SKILL.md"),
    "---\nname: parent-only\ndescription: Must stay outside the registered workspace\n---\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, ".opencode", "skills", "fixture-only"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".opencode", "skills", "fixture-only", "SKILL.md"),
    "---\nname: fixture-only\ndescription: Registered workspace skill\n---\n",
    "utf8",
  );

  const items = await listActiveWorkspaceSkills(workspaceRoot);
  expect(items.map((item) => item.name)).toEqual(["fixture-only"]);
});

test("active skill precedence keeps workspace-local over a user projection", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-precedence-local-"));
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  const localDir = join(workspaceRoot, ".opencode", "skills", "shared-tool");
  const projectedDir = join(workspaceRoot, ".opencode", "skills", "veslo-user", "shared-tool");
  await mkdir(localDir, { recursive: true });
  await mkdir(projectedDir, { recursive: true });
  await writeFile(join(localDir, "SKILL.md"), "---\nname: shared-tool\ndescription: local\n---\n\n# Local\n", "utf8");
  await writeFile(join(projectedDir, "SKILL.md"), "---\nname: shared-tool\ndescription: imported\n---\n\n# Imported\n", "utf8");
  await writeFile(join(projectedDir, ".veslo-managed.json"), JSON.stringify({ installationId: "imported-1", source: "personal" }), "utf8");

  const items = await listActiveWorkspaceSkills(workspaceRoot);
  expect(items).toHaveLength(1);
  expect(items[0]?.path).toBe(join(localDir, "SKILL.md"));
});

test("active skill precedence fails closed for a locked policy/local collision", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-precedence-locked-"));
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  const localDir = join(workspaceRoot, ".opencode", "skills", "locked-tool");
  const policyDir = join(workspaceRoot, ".opencode", "skills", "veslo-managed", "locked-tool");
  await mkdir(localDir, { recursive: true });
  await mkdir(policyDir, { recursive: true });
  await writeFile(join(localDir, "SKILL.md"), "---\nname: locked-tool\ndescription: local\n---\n\n# Local\n", "utf8");
  await writeFile(join(policyDir, "SKILL.md"), "---\nname: locked-tool\ndescription: policy\n---\n\n# Policy\n", "utf8");
  await writeFile(join(policyDir, ".veslo-managed.json"), JSON.stringify({ installationId: "policy-1", source: "organization", removalPolicy: "locked" }), "utf8");

  expect(await listActiveWorkspaceSkills(workspaceRoot)).toEqual([]);
});

test("active skill precedence lets an admin-removable policy yield to local authorship", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-precedence-removable-"));
  tempDirs.push(workspaceRoot);
  await mkdir(join(workspaceRoot, ".opencode", "skills", "removable-tool"), { recursive: true });
  await mkdir(join(workspaceRoot, ".opencode", "skills", "veslo-managed", "removable-tool"), { recursive: true });
  await writeFile(join(workspaceRoot, ".opencode", "skills", "removable-tool", "SKILL.md"), "---\nname: removable-tool\ndescription: local\n---\n", "utf8");
  await writeFile(join(workspaceRoot, ".opencode", "skills", "veslo-managed", "removable-tool", "SKILL.md"), "---\nname: removable-tool\ndescription: policy\n---\n", "utf8");
  await writeFile(join(workspaceRoot, ".opencode", "skills", "veslo-managed", "removable-tool", ".veslo-managed.json"), JSON.stringify({ installationId: "policy-1", source: "organization", removalPolicy: "user_removable" }), "utf8");

  const items = await listActiveWorkspaceSkills(workspaceRoot);
  expect(items).toHaveLength(1);
  expect(items[0]?.path).toContain(join("removable-tool", "SKILL.md"));
  expect(items[0]?.path).not.toContain(join("veslo-managed", "removable-tool"));
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

test("listSkills path matching applies platform disabled records to materialized global skills", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await mkdtemp(join(tmpdir(), "veslo-skills-disabled-platform-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skills-disabled-platform-workspace-"));
  tempDirs.push(homeDir, workspaceRoot);
  process.env.HOME = homeDir;

  try {
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
    const skillDir = join(homeDir, ".config", "opencode", "skills", "platform-skill");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: platform-skill\ndescription: Platform skill\n---\n\n# Platform\n",
      "utf8",
    );

    const disabledSkills = [
      {
        id: "platform-disabled",
        name: "platform-skill",
        scope: "platform" as const,
        path: skillPath,
        disabledAt: new Date(0).toISOString(),
      },
    ];

    const filtered = await listSkills(workspaceRoot, {
      includeGlobal: true,
      disabledSkills,
      workspaceId: "ws_1",
    });
    expect(filtered).toEqual([]);

    const included = await listSkills(workspaceRoot, {
      includeGlobal: true,
      includeDisabled: true,
      disabledSkills,
      workspaceId: "ws_1",
    });
    expect(included).toHaveLength(1);
    expect(included[0]?.enabled).toBe(false);
    expect(included[0]?.disabledReason).toBe("user");
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
