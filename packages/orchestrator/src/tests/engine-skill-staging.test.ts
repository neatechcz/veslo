import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { stageEngineSkillView } from "../engine-skill-staging.js";

const roots: string[] = [];

async function fixture(): Promise<{ workspace: string; stagingRoot: string }> {
  const root = join(process.cwd(), ".tmp-engine-skill-staging-" + crypto.randomUUID());
  roots.push(root);
  const workspace = join(root, "workspace");
  const stagingRoot = join(root, "runtime", "skills");
  await mkdir(join(workspace, ".opencode", "skills", "local-tool"), { recursive: true });
  await mkdir(join(workspace, ".opencode", "skills", "veslo-user", "local-tool"), { recursive: true });
  await mkdir(join(workspace, ".opencode", "skills", "veslo-user", "personal-tool"), { recursive: true });
  await mkdir(join(workspace, ".opencode", "skills", "veslo-managed", "policy-tool"), { recursive: true });
  await mkdir(join(workspace, ".opencode", "skills", "veslo-managed", "local-policy-collision"), { recursive: true });
  await mkdir(join(workspace, ".opencode", "skills", "local-policy-collision"), { recursive: true });
  await writeFile(join(workspace, ".opencode", "skills", "local-tool", "SKILL.md"), "local\n");
  await writeFile(join(workspace, ".opencode", "skills", "veslo-user", "local-tool", "SKILL.md"), "imported\n");
  await writeFile(join(workspace, ".opencode", "skills", "veslo-user", "personal-tool", "SKILL.md"), "personal\n");
  await writeFile(join(workspace, ".opencode", "skills", "veslo-managed", "policy-tool", "SKILL.md"), "policy\n");
  await writeFile(join(workspace, ".opencode", "skills", "veslo-managed", "local-policy-collision", "SKILL.md"), "policy\n");
  await writeFile(join(workspace, ".opencode", "skills", "local-policy-collision", "SKILL.md"), "local\n");
  await writeFile(join(workspace, ".opencode", "skills", "veslo-user", "local-tool", ".veslo-managed.json"), JSON.stringify({ source: "personal" }));
  await writeFile(join(workspace, ".opencode", "skills", "veslo-user", "personal-tool", ".veslo-managed.json"), JSON.stringify({ source: "personal" }));
  await writeFile(join(workspace, ".opencode", "skills", "veslo-managed", "policy-tool", ".veslo-managed.json"), JSON.stringify({ source: "platform" }));
  await writeFile(join(workspace, ".opencode", "skills", "veslo-managed", "local-policy-collision", ".veslo-managed.json"), JSON.stringify({ source: "organization" }));
  return { workspace, stagingRoot };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("engine skill staging", () => {
  test("materializes only deterministic effective candidates and suppresses conflicts", async () => {
    const input = await fixture();
    const result = await stageEngineSkillView(input);
    expect(result.materialized).toEqual(["local-policy-collision", "local-tool", "personal-tool", "policy-tool"]);
    expect(result.suppressed).toEqual([]);
    expect(await readFile(join(result.stagingRoot, "local-tool", "SKILL.md"), "utf8")).toBe("local\n");
    expect(await readFile(join(result.stagingRoot, "policy-tool", "SKILL.md"), "utf8")).toBe("policy\n");
  });

  test("reconciles stale entries on the next generation", async () => {
    const input = await fixture();
    const first = await stageEngineSkillView(input);
    await rm(join(input.workspace, ".opencode", "skills", "veslo-user", "personal-tool"), { recursive: true, force: true });
    const result = await stageEngineSkillView(input);
    expect(result.materialized).not.toContain("personal-tool");
    expect(await Bun.file(join(result.stagingRoot, "personal-tool", "SKILL.md")).exists()).toBe(false);
    expect(await Bun.file(join(first.stagingRoot, "personal-tool", "SKILL.md")).exists()).toBe(true);
  });

  test("runtime launches can consume only the server effective-skill manifest", async () => {
    const input = await fixture();
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaceRoot: input.workspace,
        entries: [
          {
            name: "personal-tool",
            path: join(input.workspace, ".opencode", "skills", "veslo-user", "personal-tool", "SKILL.md"),
            source: "user-imported",
          },
        ],
      }),
      "utf8",
    );
    const result = await stageEngineSkillView({ ...input, requireEffectiveManifest: true });
    expect(result.materialized).toEqual(["personal-tool"]);
  });

  test("locked policy collisions are physically suppressed from the engine view", async () => {
    const input = await fixture();
    await writeFile(
      join(input.workspace, ".opencode", "skills", "veslo-managed", "local-policy-collision", ".veslo-managed.json"),
      JSON.stringify({ source: "organization", removalPolicy: "locked" }),
    );
    const result = await stageEngineSkillView(input);
    expect(result.materialized).not.toContain("local-policy-collision");
    expect(result.suppressed).toContainEqual({ name: "local-policy-collision", reason: "policy-conflict" });
    expect(await Bun.file(join(result.stagingRoot, "local-policy-collision", "SKILL.md")).exists()).toBe(false);
  });

  test("does not scan .agents as a runtime source", async () => {
    const input = await fixture();
    await mkdir(join(input.workspace, ".agents", "skills", "ambient-agent"), { recursive: true });
    await writeFile(join(input.workspace, ".agents", "skills", "ambient-agent", "SKILL.md"), "ambient\n");
    const result = await stageEngineSkillView(input);
    expect(result.materialized).not.toContain("ambient-agent");
  });

  test("cleans stale staging generations while retaining the current view", async () => {
    const input = await fixture();
    for (let index = 0; index < 5; index += 1) await stageEngineSkillView(input);
    const generations = await readdir(join(input.stagingRoot, "generations"), { withFileTypes: true });
    expect(generations.filter((entry) => entry.isDirectory()).length).toBeLessThanOrEqual(3);
    expect(await Bun.file(join(input.stagingRoot, "current.json")).exists()).toBe(true);
  });
});
