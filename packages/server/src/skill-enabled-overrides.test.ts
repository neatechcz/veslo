import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { ApiError } from "./errors.js";
import {
  disabledSkillRecordMatchesTarget,
  listDisabledSkills,
  setSkillEnabledState,
} from "./skill-enabled-overrides.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test("listDisabledSkills returns no records when the store is missing", async () => {
  const dataDir = await tempDir();

  expect(await listDisabledSkills({ dataDir, workspaceId: "ws_1" })).toEqual([]);
});

test("setSkillEnabledState disables a workspace skill and writes one record", async () => {
  const dataDir = await tempDir();
  const skillPath = "/workspace/.opencode/skills/research-helper/SKILL.md";
  const normalizedSkillPath = posix.normalize(skillPath);

  const result = await setSkillEnabledState({
    dataDir,
    target: {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
      path: skillPath,
    },
    enabled: false,
    actor: { type: "host" },
  });

  const records = await listDisabledSkills({ dataDir, workspaceId: "ws_1" });
  const persisted = JSON.parse(await readFile(join(dataDir, "skill-enabled-overrides.json"), "utf8"));

  expect(result.ok).toBe(true);
  expect(result.enabled).toBe(false);
  expect(result.record).toMatchObject({
    name: "research-helper",
    scope: "workspace",
    workspaceId: "ws_1",
    path: normalizedSkillPath,
  });
  expect(records).toMatchObject([
    {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
      path: normalizedSkillPath,
    },
  ]);
  expect(persisted.disabled).toHaveLength(1);
});

test("disabling the same skill twice is idempotent", async () => {
  const dataDir = await tempDir();
  const input = {
    dataDir,
    target: {
      name: "research-helper",
      scope: "workspace" as const,
      workspaceId: "ws_1",
      path: "/workspace/.opencode/skills/research-helper/SKILL.md",
    },
    enabled: false,
    actor: { type: "host" as const },
  };

  await setSkillEnabledState(input);
  await setSkillEnabledState(input);

  const records = await listDisabledSkills({ dataDir, workspaceId: "ws_1" });
  expect(records).toHaveLength(1);
  expect(records[0]?.name).toBe("research-helper");
});

test("parallel disables preserve every disabled skill record", async () => {
  const dataDir = await tempDir();
  const targets = Array.from({ length: 24 }, (_, index) => {
    const name = `parallel-skill-${index}`;
    return {
      name,
      scope: "workspace" as const,
      workspaceId: "ws_1",
      path: `/workspace/.opencode/skills/${name}/SKILL.md`,
    };
  });

  await Promise.all(
    targets.map((target) =>
      setSkillEnabledState({
        dataDir,
        target,
        enabled: false,
        actor: { type: "host" },
      })
    ),
  );

  const records = await listDisabledSkills({ dataDir, workspaceId: "ws_1" });
  expect(records.map((record) => record.name).sort()).toEqual(targets.map((target) => target.name).sort());
});

test("setSkillEnabledState enabling removes the matching disabled record", async () => {
  const dataDir = await tempDir();
  const target = {
    name: "research-helper",
    scope: "workspace" as const,
    workspaceId: "ws_1",
    path: "/workspace/.opencode/skills/research-helper/SKILL.md",
  };

  await setSkillEnabledState({
    dataDir,
    target,
    enabled: false,
    actor: { type: "host" },
  });

  const result = await setSkillEnabledState({
    dataDir,
    target,
    enabled: true,
    actor: { type: "host" },
  });

  expect(result).toEqual({ ok: true, enabled: true });
  expect(await listDisabledSkills({ dataDir, workspaceId: "ws_1" })).toEqual([]);
});

test("registry policy id wins over path when matching records", async () => {
  const dataDir = await tempDir();

  await setSkillEnabledState({
    dataDir,
    target: {
      name: "org-helper",
      scope: "organization",
      workspaceId: "ws_1",
      path: "/workspace/.opencode/skills/org-helper/SKILL.md",
      registry: { policyId: "policy_1", installationId: "install_1", source: "organization" },
    },
    enabled: false,
    actor: { type: "host" },
  });

  await setSkillEnabledState({
    dataDir,
    target: {
      name: "org-helper",
      scope: "organization",
      workspaceId: "ws_1",
      path: "/other/.opencode/skills/org-helper/SKILL.md",
      registry: { policyId: "policy_1", installationId: "install_2", source: "organization" },
    },
    enabled: false,
    actor: { type: "host" },
  });

  const records = await listDisabledSkills({ dataDir, workspaceId: "ws_1" });
  expect(records).toHaveLength(1);
  expect(disabledSkillRecordMatchesTarget(records[0]!, {
    name: "org-helper",
    scope: "organization",
    workspaceId: "ws_1",
    path: "/third/.opencode/skills/org-helper/SKILL.md",
    registry: { policyId: "policy_1" },
  })).toBe(true);
});

test("disabled records do not expose actor token hashes", async () => {
  const dataDir = await tempDir();

  await setSkillEnabledState({
    dataDir,
    target: {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
      path: "/workspace/.opencode/skills/research-helper/SKILL.md",
    },
    enabled: false,
    actor: { type: "remote", tokenHash: "secret-token-hash", scope: "owner", clientId: "client_1" },
  });

  const records = await listDisabledSkills({ dataDir, workspaceId: "ws_1" });
  const persisted = await readFile(join(dataDir, "skill-enabled-overrides.json"), "utf8");

  expect(typeof records[0]?.disabledBy).toBe("string");
  expect(JSON.stringify(records)).not.toContain("tokenHash");
  expect(JSON.stringify(records)).not.toContain("secret-token-hash");
  expect(persisted).not.toContain("tokenHash");
  expect(persisted).not.toContain("secret-token-hash");
});

test("long remote actor client ids do not invalidate persisted disabled records", async () => {
  const dataDir = await tempDir();
  const longClientId = "client_" + "x".repeat(300);

  await setSkillEnabledState({
    dataDir,
    target: {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
      path: "/workspace/.opencode/skills/research-helper/SKILL.md",
    },
    enabled: false,
    actor: { type: "remote", tokenHash: "secret-token-hash", scope: "owner", clientId: longClientId },
  });

  const records = await listDisabledSkills({ dataDir, workspaceId: "ws_1" });
  const persisted = await readFile(join(dataDir, "skill-enabled-overrides.json"), "utf8");

  expect(records).toHaveLength(1);
  expect(records[0]?.name).toBe("research-helper");
  expect(records[0]?.disabledBy?.length ?? 0).toBeLessThanOrEqual(256);
  expect(persisted).not.toContain(longClientId);
  expect(JSON.stringify(records)).not.toContain("tokenHash");
  expect(JSON.stringify(records)).not.toContain("secret-token-hash");
  expect(persisted).not.toContain("tokenHash");
  expect(persisted).not.toContain("secret-token-hash");
});

test("setSkillEnabledState rejects relative skill paths", async () => {
  const dataDir = await tempDir();

  await expect(setSkillEnabledState({
    dataDir,
    target: {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
      path: "workspace/.opencode/skills/research-helper/SKILL.md",
    },
    enabled: false,
  })).rejects.toThrow("absolute");
});

test("setSkillEnabledState rejects paths that do not point to SKILL.md", async () => {
  const dataDir = await tempDir();

  await expect(setSkillEnabledState({
    dataDir,
    target: {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
      path: "/workspace/.opencode/skills/research-helper/README.md",
    },
    enabled: false,
  })).rejects.toThrow("SKILL.md");
});

test("setSkillEnabledState rejects skill paths whose parent directory does not match the skill name", async () => {
  const dataDir = await tempDir();

  await expect(setSkillEnabledState({
    dataDir,
    target: {
      name: "research-helper",
      scope: "workspace",
      workspaceId: "ws_1",
      path: "/workspace/.opencode/skills/other-helper/SKILL.md",
    },
    enabled: false,
  })).rejects.toThrow("Skill path parent directory must match skill name");
});

test("corrupt JSON returns a typed ApiError", async () => {
  const dataDir = await tempDir();
  await writeFile(join(dataDir, "skill-enabled-overrides.json"), "{not json\n", "utf8");

  try {
    await listDisabledSkills({ dataDir, workspaceId: "ws_1" });
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).code).toBe("invalid_json");
    return;
  }

  throw new Error("Expected invalid_json ApiError");
});

async function tempDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-skill-enabled-"));
  tempDirs.push(dataDir);
  return dataDir;
}
