import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  importSkillCandidates,
  listSkillImportCandidates,
} from "../skill-import-candidates.js";
import { materializeUserGlobalSkillsForWorkspace, readUserGlobalSkill } from "../user-skill-store.js";
import type { WorkspaceInfo } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const writeSkill = async (dir: string, name: string, description: string, extraFiles: Record<string, string> = {}) => {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      `# ${name}`,
      "",
      "## When to use",
      `Use ${name} when needed.`,
      "",
    ].join("\n"),
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const target = join(skillDir, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
};

const createWorkspace = async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-skill-import-workspace-"));
  const homeDir = await mkdtemp(join(tmpdir(), "veslo-skill-import-home-"));
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-skill-import-data-"));
  tempDirs.push(workspaceRoot, homeDir, dataDir);
  await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  const workspace: WorkspaceInfo = {
    id: "ws_1",
    name: "Test Workspace",
    path: workspaceRoot,
    workspaceType: "local",
  };
  return { workspaceRoot, homeDir, dataDir, workspaces: [workspace] };
};

test("listSkillImportCandidates discovers Codex user and workspace candidates with automatic targets", async () => {
  const context = await createWorkspace();
  await writeSkill(join(context.homeDir, ".codex", "skills"), "codex-user-helper", "Codex user helper");
  await writeSkill(join(context.workspaceRoot, ".codex", "skills"), "codex-workspace-helper", "Codex workspace helper");

  const candidates = await listSkillImportCandidates(context);

  expect(candidates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "codex-user-helper",
        sourceAgent: "codex",
        sourceLocation: "user-global",
        status: "ready",
        target: { scope: "user-global" },
      }),
      expect.objectContaining({
        name: "codex-workspace-helper",
        sourceAgent: "codex",
        sourceLocation: "workspace",
        status: "ready",
        target: {
          scope: "workspace",
          workspaceId: "ws_1",
          workspaceName: "Test Workspace",
        },
      }),
    ]),
  );
});

test("importSkillCandidates imports user-level candidates into Veslo user skill store with extra files", async () => {
  const context = await createWorkspace();
  await writeSkill(join(context.homeDir, ".codex", "skills"), "codex-helper", "Codex helper", {
    "scripts/run.sh": "echo imported\n",
  });

  const candidates = await listSkillImportCandidates(context);
  const candidate = candidates.find((item) => item.name === "codex-helper");
  expect(candidate).toMatchObject({
    status: "needs-review",
    target: { scope: "user-global" },
  });

  const result = await importSkillCandidates({
    ...context,
    actor: { type: "host", scope: "owner" },
    candidateIds: [candidate!.id],
  });

  expect(result.results).toEqual([
    expect.objectContaining({
      candidateId: candidate!.id,
      ok: true,
      name: "codex-helper",
      target: { scope: "user-global" },
    }),
  ]);

  const stored = await readUserGlobalSkill("codex-helper", context.dataDir);
  expect(stored.item).toMatchObject({ name: "codex-helper", scope: "user-global" });

  await materializeUserGlobalSkillsForWorkspace({
    workspaceRoot: context.workspaceRoot,
    workspaceId: "ws_1",
    dataDir: context.dataDir,
  });

  await expect(
    readFile(
      join(context.workspaceRoot, ".opencode", "skills", "veslo-user", "codex-helper", "scripts", "run.sh"),
      "utf8",
    ),
  ).resolves.toBe("echo imported\n");
});

test("importSkillCandidates imports workspace candidates into the workspace OpenCode skill root", async () => {
  const context = await createWorkspace();
  await writeSkill(join(context.workspaceRoot, ".claude", "skills"), "claude-helper", "Claude helper", {
    "assets/prompt.txt": "workspace asset\n",
  });

  const candidates = await listSkillImportCandidates(context);
  const candidate = candidates.find((item) => item.name === "claude-helper");
  expect(candidate).toMatchObject({
    sourceAgent: "claude",
    target: { scope: "workspace", workspaceId: "ws_1" },
  });

  const result = await importSkillCandidates({
    ...context,
    actor: { type: "host", scope: "owner" },
    candidateIds: [candidate!.id],
  });

  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({
    candidateId: candidate!.id,
    ok: true,
    name: "claude-helper",
    target: { scope: "workspace", workspaceId: "ws_1" },
  });
  await expect(
    readFile(join(context.workspaceRoot, ".opencode", "skills", "claude-helper", "assets", "prompt.txt"), "utf8"),
  ).resolves.toBe("workspace asset\n");
});

test("importSkillCandidates rejects conflicts without overwriting existing Veslo targets", async () => {
  const context = await createWorkspace();
  await writeSkill(join(context.homeDir, ".codex", "skills"), "existing-helper", "Codex helper");
  await writeSkill(join(context.workspaceRoot, ".opencode", "skills"), "existing-helper", "Existing workspace helper");

  const candidates = await listSkillImportCandidates(context);
  const candidate = candidates.find((item) => item.name === "existing-helper" && item.sourceAgent === "codex");
  expect(candidate).toMatchObject({
    status: "conflict",
    conflict: expect.objectContaining({ code: "target-exists" }),
  });

  const result = await importSkillCandidates({
    ...context,
    actor: { type: "host", scope: "owner" },
    candidateIds: [candidate!.id],
  });

  expect(result.results).toEqual([
    expect.objectContaining({
      candidateId: candidate!.id,
      ok: false,
      code: "target-exists",
    }),
  ]);
});
