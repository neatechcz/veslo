import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  EMPTY_DIRECT_AUTHORIZATION_REVISION,
  EMPTY_DIRECT_SKILL_VIEW_REVISION,
  claimEngineSkillGeneration,
  __engineSkillStagingTestHooks,
  promoteDirectorySkillView,
  publishDirectorySkillView,
  resolveDirectEngineSkillView,
  resolveOrdinaryDirectEngineSkillView,
  releaseEngineSkillGeneration,
  stageEngineSkillView,
} from "../engine-skill-staging.js";
import { withWorkspaceSkillLease } from "../workspace-skill-lease.js";

const roots: string[] = [];

async function fixture(): Promise<{ workspace: string; stagingRoot: string }> {
  const root = join(
    process.cwd(),
    ".tmp-engine-skill-staging-" + crypto.randomUUID(),
  );
  roots.push(root);
  const workspace = join(root, "workspace");
  const stagingRoot = join(root, "runtime", "skills");
  await mkdir(join(workspace, ".opencode", "skills", "local-tool"), {
    recursive: true,
  });
  await mkdir(
    join(workspace, ".opencode", "skills", "veslo-user", "local-tool"),
    { recursive: true },
  );
  await mkdir(
    join(workspace, ".opencode", "skills", "veslo-user", "personal-tool"),
    { recursive: true },
  );
  await mkdir(
    join(workspace, ".opencode", "skills", "veslo-managed", "policy-tool"),
    { recursive: true },
  );
  await mkdir(
    join(
      workspace,
      ".opencode",
      "skills",
      "veslo-managed",
      "local-policy-collision",
    ),
    { recursive: true },
  );
  await mkdir(
    join(workspace, ".opencode", "skills", "local-policy-collision"),
    { recursive: true },
  );
  await writeFile(
    join(workspace, ".opencode", "skills", "local-tool", "SKILL.md"),
    "local\n",
  );
  await mkdir(
    join(
      workspace,
      ".opencode",
      "skills",
      "local-tool",
      "scripts",
      "ooxml",
      "schemas",
      "ISO-IEC29500-4_2016",
    ),
    { recursive: true },
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "local-tool",
      "scripts",
      "ooxml",
      "schemas",
      "ISO-IEC29500-4_2016",
      "shared-customXmlDataProperties.xsd",
    ),
    "schema\n",
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "veslo-user",
      "local-tool",
      "SKILL.md",
    ),
    "imported\n",
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "veslo-user",
      "personal-tool",
      "SKILL.md",
    ),
    "personal\n",
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "veslo-managed",
      "policy-tool",
      "SKILL.md",
    ),
    "policy\n",
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "veslo-managed",
      "local-policy-collision",
      "SKILL.md",
    ),
    "policy\n",
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "local-policy-collision",
      "SKILL.md",
    ),
    "local\n",
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "veslo-user",
      "local-tool",
      ".veslo-managed.json",
    ),
    JSON.stringify({ source: "personal" }),
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "veslo-user",
      "personal-tool",
      ".veslo-managed.json",
    ),
    JSON.stringify({ source: "personal" }),
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "veslo-managed",
      "policy-tool",
      ".veslo-managed.json",
    ),
    JSON.stringify({ source: "platform" }),
  );
  await writeFile(
    join(
      workspace,
      ".opencode",
      "skills",
      "veslo-managed",
      "local-policy-collision",
      ".veslo-managed.json",
    ),
    JSON.stringify({ source: "organization" }),
  );
  return { workspace, stagingRoot };
}

afterEach(async () => {
  __engineSkillStagingTestHooks.setBeforeCandidateCopy(null);
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("engine skill staging", () => {
  test("uses a canonical empty binding when no effective manifest exists", async () => {
    const input = await fixture();
    await rm(join(input.workspace, ".opencode", "veslo.runtime.skills.json"), { force: true });

    const view = await resolveDirectEngineSkillView({ workspace: input.workspace });

    expect(view).toMatchObject({
      revision: EMPTY_DIRECT_SKILL_VIEW_REVISION,
      authorizationRevision: EMPTY_DIRECT_AUTHORIZATION_REVISION,
      skillPaths: [],
      source: "empty",
      selected: [],
    });
  });

  test("an explicit empty recovery binding ignores a stale serving manifest", async () => {
    const input = await fixture();

    const view = await resolveDirectEngineSkillView({
      workspace: input.workspace,
      expectedRevision: EMPTY_DIRECT_SKILL_VIEW_REVISION,
      expectedAuthorizationRevision: EMPTY_DIRECT_AUTHORIZATION_REVISION,
    });

    expect(view).toMatchObject({
      revision: EMPTY_DIRECT_SKILL_VIEW_REVISION,
      authorizationRevision: EMPTY_DIRECT_AUTHORIZATION_REVISION,
      skillPaths: [],
      source: "empty",
    });
  });

  test.if(process.platform === "win32")(
    "resolves a serving manifest when Tauri supplies an extended-length workspace path",
    async () => {
      const input = await fixture();
      const revision = "direct-view-extended-path";
      const authorizationRevision = "authorization-extended-path";
      await writeFile(
        join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
        JSON.stringify({
          schemaVersion: 3,
          workspaceRoot: input.workspace,
          revision,
          authorizationRevision,
          entries: [{
            name: "local-tool",
            path: join(input.workspace, ".opencode", "skills", "local-tool", "SKILL.md"),
            source: "workspace-local",
          }],
        }),
        "utf8",
      );

      const view = await resolveDirectEngineSkillView({
        workspace: `\\\\?\\${input.workspace}`,
        expectedRevision: revision,
        expectedAuthorizationRevision: authorizationRevision,
      });

      expect(view).toMatchObject({
        revision,
        authorizationRevision,
        source: "effective-manifest",
        selected: [{ name: "local-tool" }],
      });
    },
  );

  test("ordinary runtime falls back to canonical empty for missing or partial bindings", async () => {
    const input = await fixture();

    await expect(resolveOrdinaryDirectEngineSkillView({
      workspace: input.workspace,
    })).resolves.toMatchObject({
      result: "empty",
      fallbackReason: "binding_missing",
      view: {
        revision: EMPTY_DIRECT_SKILL_VIEW_REVISION,
        authorizationRevision: EMPTY_DIRECT_AUTHORIZATION_REVISION,
        skillPaths: [],
      },
    });

    await expect(resolveOrdinaryDirectEngineSkillView({
      workspace: input.workspace,
      expectedRevision: "direct-view-a",
    })).resolves.toMatchObject({
      result: "empty",
      fallbackReason: "binding_incomplete",
      view: { skillPaths: [] },
    });
  });

  test("ordinary runtime falls back to canonical empty when a requested manifest is stale", async () => {
    const input = await fixture();

    await expect(resolveOrdinaryDirectEngineSkillView({
      workspace: input.workspace,
      expectedRevision: "missing-view",
      expectedAuthorizationRevision: "missing-authorization",
    })).resolves.toMatchObject({
      result: "empty",
      fallbackReason: "skill_view_stale",
      view: {
        revision: EMPTY_DIRECT_SKILL_VIEW_REVISION,
        authorizationRevision: EMPTY_DIRECT_AUTHORIZATION_REVISION,
        skillPaths: [],
      },
    });
  });

  test("ordinary runtime identifies an explicit canonical empty binding as no authorized skills", async () => {
    const input = await fixture();

    await expect(resolveOrdinaryDirectEngineSkillView({
      workspace: input.workspace,
      expectedRevision: EMPTY_DIRECT_SKILL_VIEW_REVISION,
      expectedAuthorizationRevision: EMPTY_DIRECT_AUTHORIZATION_REVISION,
    })).resolves.toMatchObject({
      result: "empty",
      fallbackReason: "no_authorized_skills",
      view: {
        revision: EMPTY_DIRECT_SKILL_VIEW_REVISION,
        authorizationRevision: EMPTY_DIRECT_AUTHORIZATION_REVISION,
        skillPaths: [],
      },
    });
  });

  test("resolves individual selected source directories without creating a staging generation", async () => {
    const input = await fixture();
    const localSkill = join(input.workspace, ".opencode", "skills", "local-tool", "SKILL.md");
    const personalSkill = join(input.workspace, ".opencode", "skills", "veslo-user", "personal-tool", "SKILL.md");
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 3,
        workspaceRoot: input.workspace,
        revision: "direct-view-a",
        authorizationRevision: "authorization-a",
        entries: [
          { name: "local-tool", path: localSkill, source: "workspace-local" },
          { name: "personal-tool", path: personalSkill, source: "user-imported" },
        ],
      }),
      "utf8",
    );

    const view = await resolveDirectEngineSkillView({
      workspace: input.workspace,
      expectedRevision: "direct-view-a",
    });

    expect(view).toMatchObject({
      revision: "direct-view-a",
      authorizationRevision: "authorization-a",
      source: "effective-manifest",
      selected: [
        { name: "local-tool", sourcePath: localSkill, className: "workspace-local" },
        { name: "personal-tool", sourcePath: personalSkill, className: "user-imported" },
      ],
    });
    expect(view.skillPaths).toEqual([
      join(input.workspace, ".opencode", "skills", "local-tool"),
      join(input.workspace, ".opencode", "skills", "veslo-user", "personal-tool"),
    ]);
    await expect(resolveDirectEngineSkillView({
      workspace: input.workspace,
      expectedAuthorizationRevision: "authorization-other",
    })).rejects.toThrow("skill_authorization_stale");
  });

  test("validates an explicit candidate manifest without reading or replacing serving LKG", async () => {
    const input = await fixture();
    const localSkill = join(input.workspace, ".opencode", "skills", "local-tool", "SKILL.md");
    const servingPath = join(input.workspace, ".opencode", "veslo.runtime.skills.json");
    const candidatePath = join(input.workspace, ".opencode", `veslo.runtime.skills.candidate.${"a".repeat(64)}.json`);
    await writeFile(servingPath, JSON.stringify({
      schemaVersion: 3, workspaceRoot: input.workspace, revision: "serving", authorizationRevision: "serving-auth", entries: [],
    }), "utf8");
    await writeFile(candidatePath, JSON.stringify({
      schemaVersion: 3, workspaceRoot: input.workspace, revision: "candidate", authorizationRevision: "candidate-auth",
      entries: [{ name: "local-tool", path: localSkill, source: "workspace-local" }],
    }), "utf8");

    const view = await resolveDirectEngineSkillView({
      workspace: input.workspace,
      manifestPath: candidatePath,
      expectedRevision: "candidate",
      expectedAuthorizationRevision: "candidate-auth",
    });

    expect(view.selected).toEqual([{ name: "local-tool", sourcePath: localSkill, className: "workspace-local" }]);
    expect(JSON.parse(await readFile(servingPath, "utf8")).revision).toBe("serving");
  });

  test("admits an immutable managed source only below the configured digest store", async () => {
    const input = await fixture();
    const managedStore = join(dirname(input.workspace), "skill-package-store");
    const digest = "a".repeat(64);
    const skillPath = join(managedStore, digest, "managed-tool", "SKILL.md");
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "managed\n", "utf8");
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 3,
        workspaceRoot: input.workspace,
        revision: "managed-direct-view",
        authorizationRevision: "managed-authorization",
        entries: [{ name: "managed-tool", path: skillPath, source: "policy-enforced" }],
      }),
      "utf8",
    );

    await expect(resolveDirectEngineSkillView({ workspace: input.workspace }))
      .rejects.toThrow("outside_authorized_root");
    await expect(resolveDirectEngineSkillView({
      workspace: input.workspace,
      managedSkillStoreRoot: managedStore,
    })).resolves.toMatchObject({ skillPaths: [dirname(skillPath)] });
  });

  test("rejects an unselected nested SKILL.md before direct OpenCode discovery", async () => {
    const input = await fixture();
    const skillDir = join(input.workspace, ".opencode", "skills", "local-tool");
    const skillPath = join(skillDir, "SKILL.md");
    await mkdir(join(skillDir, "nested"), { recursive: true });
    await writeFile(join(skillDir, "nested", "SKILL.md"), "nested\n", "utf8");
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 2,
        workspaceRoot: input.workspace,
        revision: "direct-view-nested",
        entries: [{ name: "local-tool", path: skillPath, source: "workspace-local" }],
      }),
      "utf8",
    );

    await expect(resolveDirectEngineSkillView({ workspace: input.workspace }))
      .rejects.toThrow("direct_path_nested_skill_rejected");
  });

  test("rejects a partially invalid manifest instead of serving its remaining paths as that revision", async () => {
    const input = await fixture();
    const localSkill = join(input.workspace, ".opencode", "skills", "local-tool", "SKILL.md");
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 3,
        workspaceRoot: input.workspace,
        revision: "direct-view-partial",
        authorizationRevision: "authorization-partial",
        entries: [
          { name: "local-tool", path: localSkill, source: "workspace-local" },
          { name: "missing-tool", path: join(input.workspace, ".opencode", "skills", "missing-tool", "SKILL.md"), source: "workspace-local" },
        ],
      }),
      "utf8",
    );

    await expect(resolveDirectEngineSkillView({ workspace: input.workspace }))
      .rejects.toThrow("skill_view_invalid: missing-tool:missing_source");
  });

  test("rejects a directory link cycle before direct OpenCode discovery", async () => {
    const input = await fixture();
    const skillDir = join(input.workspace, ".opencode", "skills", "local-tool");
    const skillPath = join(skillDir, "SKILL.md");
    await symlink(skillDir, join(skillDir, "cycle"), "junction");
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 2,
        workspaceRoot: input.workspace,
        revision: "direct-view-cycle",
        entries: [{ name: "local-tool", path: skillPath, source: "workspace-local" }],
      }),
      "utf8",
    );

    await expect(resolveDirectEngineSkillView({ workspace: input.workspace }))
      .rejects.toThrow("direct_path_link_cycle");
  });

  test("materializes only deterministic effective candidates and suppresses conflicts", async () => {
    const input = await fixture();
    const result = await stageEngineSkillView(input);
    expect(result.materialized).toEqual([
      "local-policy-collision",
      "local-tool",
      "personal-tool",
      "policy-tool",
    ]);
    expect(result.suppressed).toEqual([]);
    expect(
      await readFile(
        join(result.stagingRoot, "local-tool", "SKILL.md"),
        "utf8",
      ),
    ).toBe("local\n");
    expect(
      await readFile(
        join(result.stagingRoot, "policy-tool", "SKILL.md"),
        "utf8",
      ),
    ).toBe("policy\n");
  });

  test("reconciles stale entries on the next generation", async () => {
    const input = await fixture();
    const first = await stageEngineSkillView(input);
    await rm(
      join(
        input.workspace,
        ".opencode",
        "skills",
        "veslo-user",
        "personal-tool",
      ),
      { recursive: true, force: true },
    );
    const result = await stageEngineSkillView(input);
    expect(result.materialized).not.toContain("personal-tool");
    expect(
      await Bun.file(
        join(result.stagingRoot, "personal-tool", "SKILL.md"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(first.stagingRoot, "personal-tool", "SKILL.md"),
      ).exists(),
    ).toBe(true);
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
            path: join(
              input.workspace,
              ".opencode",
              "skills",
              "veslo-user",
              "personal-tool",
              "SKILL.md",
            ),
            source: "user-imported",
          },
        ],
      }),
      "utf8",
    );
    const result = await stageEngineSkillView({
      ...input,
      requireEffectiveManifest: true,
    });
    expect(result.materialized).toEqual(["personal-tool"]);
  });

  test("fails closed when the server revision does not match the manifest", async () => {
    const input = await fixture();
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 2,
        workspaceRoot: input.workspace,
        revision: "published-view",
        entries: [],
      }),
      "utf8",
    );

    await expect(
      stageEngineSkillView({
        ...input,
        requireEffectiveManifest: true,
        expectedRevision: "different-view",
      }),
    ).rejects.toThrow("skill_view_stale");
  });

  test("locked policy collisions are physically suppressed from the engine view", async () => {
    const input = await fixture();
    await writeFile(
      join(
        input.workspace,
        ".opencode",
        "skills",
        "veslo-managed",
        "local-policy-collision",
        ".veslo-managed.json",
      ),
      JSON.stringify({ source: "organization", removalPolicy: "locked" }),
    );
    const result = await stageEngineSkillView(input);
    expect(result.materialized).not.toContain("local-policy-collision");
    expect(result.suppressed).toContainEqual({
      name: "local-policy-collision",
      reason: "policy-conflict",
    });
    expect(
      await Bun.file(
        join(result.stagingRoot, "local-policy-collision", "SKILL.md"),
      ).exists(),
    ).toBe(false);
  });

  test("admits a workspace .agents skill as a workspace-local source", async () => {
    const input = await fixture();
    await mkdir(join(input.workspace, ".agents", "skills", "ambient-agent"), {
      recursive: true,
    });
    await writeFile(
      join(input.workspace, ".agents", "skills", "ambient-agent", "SKILL.md"),
      "ambient\n",
    );
    const result = await stageEngineSkillView(input);
    expect(result.materialized).toContain("ambient-agent");
  });

  test("materializes an .agents skill when the server effective manifest explicitly includes it", async () => {
    const input = await fixture();
    const skillPath = join(
      input.workspace,
      ".agents",
      "skills",
      "agents-manifest",
      "SKILL.md",
    );
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "agents manifest skill\n", "utf8");
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 2,
        workspaceRoot: input.workspace,
        revision: "agents-manifest-view",
        entries: [
          {
            name: "agents-manifest",
            path: skillPath,
            source: "workspace-local",
          },
        ],
      }),
      "utf8",
    );

    const result = await stageEngineSkillView({
      ...input,
      requireEffectiveManifest: true,
      expectedRevision: "agents-manifest-view",
    });

    expect(result.source).toBe("effective-manifest");
    expect(result.materialized).toEqual(["agents-manifest"]);
    expect(
      await readFile(
        join(result.stagingRoot, "agents-manifest", "SKILL.md"),
        "utf8",
      ),
    ).toBe("agents manifest skill\n");
  });

  test("rejects a manifest entry whose source is outside the workspace skill roots", async () => {
    const input = await fixture();
    const externalSkill = join(input.stagingRoot, "external", "foreign-skill");
    await mkdir(externalSkill, { recursive: true });
    const externalEntrypoint = join(externalSkill, "SKILL.md");
    await writeFile(externalEntrypoint, "must stay external\n");
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 2,
        workspaceRoot: input.workspace,
        revision: "external-entry",
        entries: [
          {
            name: "foreign-skill",
            path: externalEntrypoint,
            source: "workspace-local",
          },
        ],
      }),
    );

    const result = await stageEngineSkillView({
      ...input,
      requireEffectiveManifest: true,
      expectedRevision: "external-entry",
    });

    expect(result.materialized).toEqual([]);
    expect(result.suppressed).toContainEqual({
      name: "foreign-skill",
      reason: "outside_authorized_root",
    });
    expect(
      await Bun.file(
        join(result.stagingRoot, "foreign-skill", "SKILL.md"),
      ).exists(),
    ).toBe(false);
  });

  test("recovers a lock owned by a provably dead process", async () => {
    const input = await fixture();
    const lockDir = join(input.stagingRoot, ".lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        token: "dead-owner",
        processId: -1,
        processInstanceId: "dead-instance",
        processStartedAt: 0,
        stagingOperationId: "dead-operation",
        acquiredAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      }),
    );

    const result = await stageEngineSkillView(input);

    expect(result.materialized).toContain("local-tool");
    expect(await Bun.file(lockDir).exists()).toBe(false);
  });

  test("an in-place nested edit during the copy is reported as a changed view", async () => {
    const input = await fixture();
    let mutations = 0;
    __engineSkillStagingTestHooks.setBeforeCandidateCopy(async (candidate) => {
      // A sync client or editor rewriting a nested file without removing it.
      // `cp` succeeds, so only an after-the-fact check can catch the tear.
      // Keep writing so every retry sees it and the failure is conclusive.
      mutations += 1;
      await mkdir(join(candidate.sourceDir, "assets"), { recursive: true });
      await writeFile(
        join(candidate.sourceDir, "assets", "schema.json"),
        JSON.stringify({ changed: mutations, at: Date.now() }),
        "utf8",
      );
    });

    await expect(stageEngineSkillView(input)).rejects.toThrow(
      /skill_view_changed/,
    );
    expect(mutations).toBeGreaterThan(1);
  });

  test("a settled source still stages after a transient in-place edit", async () => {
    const input = await fixture();
    let mutated = false;
    __engineSkillStagingTestHooks.setBeforeCandidateCopy(async (candidate) => {
      if (mutated) return;
      mutated = true;
      await mkdir(join(candidate.sourceDir, "assets"), { recursive: true });
      await writeFile(
        join(candidate.sourceDir, "assets", "schema.json"),
        JSON.stringify({ changed: true }),
        "utf8",
      );
    });

    // One disturbance must not fail the launch; the retry is the remedy.
    const result = await stageEngineSkillView(input);
    expect(result.materialized).toContain("local-tool");
  });

  test("recovers a staging lock whose owner pid is alive but whose heartbeat stopped", async () => {
    const input = await fixture();
    const lockDir = join(input.stagingRoot, ".lock");
    await mkdir(lockDir, { recursive: true });
    const ownerFile = join(lockDir, "owner.json");
    // A live pid the lock does not actually belong to — what pid reuse looks
    // like to a waiter. Only the stopped heartbeat reveals it.
    await writeFile(
      ownerFile,
      JSON.stringify({
        schemaVersion: 1,
        token: "reused-pid-owner",
        processId: process.pid,
        processInstanceId: "some-other-orchestrator",
        processStartedAt: 0,
        stagingOperationId: "abandoned-operation",
        acquiredAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      }),
    );
    await utimes(ownerFile, new Date(0), new Date(0));

    const result = await stageEngineSkillView(input);

    expect(result.materialized).toContain("local-tool");
    expect(await Bun.file(lockDir).exists()).toBe(false);
  });

  test("recovers a staging lock left without a readable owner record", async () => {
    const input = await fixture();
    const lockDir = join(input.stagingRoot, ".lock");
    await mkdir(lockDir, { recursive: true });
    // A crash between creating the lock directory and writing its owner record.
    await utimes(lockDir, new Date(0), new Date(0));

    const result = await stageEngineSkillView(input);

    expect(result.materialized).toContain("local-tool");
    expect(await Bun.file(lockDir).exists()).toBe(false);
  });

  test("a recovery fence left by a crashed recovery does not wedge the staging root", async () => {
    const input = await fixture();
    const lockDir = join(input.stagingRoot, ".lock");
    const fenceDir = join(lockDir, ".recovery");
    await mkdir(fenceDir, { recursive: true });
    // Age the fence before the lock: creating a child bumps the parent's mtime.
    await utimes(fenceDir, new Date(0), new Date(0));
    await utimes(lockDir, new Date(0), new Date(0));

    const result = await stageEngineSkillView(input);

    expect(result.materialized).toContain("local-tool");
    expect(await Bun.file(lockDir).exists()).toBe(false);
  });

  test("keeps a generation leased to an engine until explicit release", async () => {
    const input = await fixture();
    const staged = await stageEngineSkillView({
      ...input,
      engineOwnerId: "engine-owner-a",
    });
    expect(staged.generationLease).toBeDefined();
    const lease = staged.generationLease!;

    await claimEngineSkillGeneration(lease, process.pid);
    const leased = JSON.parse(
      await readFile(
        join(lease.generationRoot, ".veslo-engine-skill-generation.json"),
        "utf8",
      ),
    );
    expect(leased.state).toBe("leased");
    expect(leased.childPid).toBe(process.pid);

    await releaseEngineSkillGeneration(lease);
    const released = JSON.parse(
      await readFile(
        join(lease.generationRoot, ".veslo-engine-skill-generation.json"),
        "utf8",
      ),
    );
    expect(released.state).toBe("released");
  });

  test("never treats an unclaimed generation as an orphaned engine lease", async () => {
    const input = await fixture();
    const staged = await stageEngineSkillView({
      ...input,
      engineOwnerId: "engine-owner-a",
    });
    const recordPath = join(
      staged.stagingRoot,
      ".veslo-engine-skill-generation.json",
    );
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(
      recordPath,
      JSON.stringify({
        ...record,
        processId: -1,
        state: "ready",
        updatedAt: new Date(0).toISOString(),
      }),
    );

    await stageEngineSkillView(input);

    expect(
      await Bun.file(
        join(staged.stagingRoot, "local-tool", "SKILL.md"),
      ).exists(),
    ).toBe(true);
  });

  test("cleans stale staging generations while retaining the current view", async () => {
    const input = await fixture();
    for (let index = 0; index < 5; index += 1)
      await stageEngineSkillView(input);
    const generations = await readdir(join(input.stagingRoot, "generations"), {
      withFileTypes: true,
    });
    expect(
      generations.filter((entry) => entry.isDirectory()).length,
    ).toBeLessThanOrEqual(3);
    expect(
      await Bun.file(join(input.stagingRoot, "current.json")).exists(),
    ).toBe(true);
  });

  test("serializes concurrent staging without copy failures", async () => {
    const input = await fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => stageEngineSkillView(input)),
    );

    const latest = results.at(-1)!;
    expect(
      await readFile(
        join(
          latest.stagingRoot,
          "local-tool",
          "scripts",
          "ooxml",
          "schemas",
          "ISO-IEC29500-4_2016",
          "shared-customXmlDataProperties.xsd",
        ),
        "utf8",
      ),
    ).toBe("schema\n");
    expect(
      await readFile(
        join(latest.stagingRoot, "local-tool", "SKILL.md"),
        "utf8",
      ),
    ).toBe("local\n");
  });

  test("waits for a server-owned workspace skill mutation before copying", async () => {
    const input = await fixture();
    const events: string[] = [];
    let releaseMutation: (() => void) | undefined;
    let mutationStartedResolve: (() => void) | undefined;
    const mutationStarted = new Promise<void>((resolveStarted) => {
      mutationStartedResolve = resolveStarted;
    });
    const mutationGate = new Promise<void>((resolveMutation) => {
      releaseMutation = resolveMutation;
    });

    const mutation = withWorkspaceSkillLease(
      input.workspace,
      "registry-skill-materialization",
      async () => {
        events.push("mutation:start");
        mutationStartedResolve?.();
        await mutationGate;
        events.push("mutation:end");
      },
    );
    await mutationStarted;

    __engineSkillStagingTestHooks.setBeforeCandidateCopy(async () => {
      events.push("staging:copy");
    });
    const staging = stageEngineSkillView(input);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    expect(events).toEqual(["mutation:start"]);

    releaseMutation?.();
    await mutation;
    await staging;
    expect(events).toContain("mutation:end");
    expect(events.indexOf("staging:copy")).toBeGreaterThan(
      events.indexOf("mutation:end"),
    );
  });

  test("retries when materialization replaces a source during staging", async () => {
    const input = await fixture();
    const sourceDir = join(
      input.workspace,
      ".opencode",
      "skills",
      "local-tool",
    );
    const replacementDir = join(input.workspace, ".replacement-local-tool");
    await mkdir(join(replacementDir, "scripts"), { recursive: true });
    await writeFile(join(replacementDir, "SKILL.md"), "replacement\n");
    await writeFile(
      join(replacementDir, "scripts", "replacement.txt"),
      "replacement\n",
    );

    let replaced = false;
    __engineSkillStagingTestHooks.setBeforeCandidateCopy(async (candidate) => {
      if (replaced || candidate.name !== "local-tool") return;
      replaced = true;
      await rename(sourceDir, `${sourceDir}.backup`);
      await rename(replacementDir, sourceDir);
    });

    const result = await stageEngineSkillView(input);

    expect(replaced).toBe(true);
    expect(
      await readFile(
        join(result.stagingRoot, "local-tool", "SKILL.md"),
        "utf8",
      ),
    ).toBe("replacement\n");
    expect(
      await readFile(
        join(result.stagingRoot, "local-tool", "scripts", "replacement.txt"),
        "utf8",
      ),
    ).toBe("replacement\n");
  });

  test("publishes a stable workspace-local root for a specific effective revision", async () => {
    const input = await fixture();
    const skillPath = join(
      input.workspace,
      ".opencode",
      "skills",
      "local-tool",
      "SKILL.md",
    );
    await writeFile(
      join(input.workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 2,
        workspaceRoot: input.workspace,
        revision: "revision-a",
        entries: [
          { name: "local-tool", path: skillPath, source: "workspace-local" },
        ],
      }),
      "utf8",
    );
    const runtimeRoot = join(
      input.workspace,
      ".opencode",
      ".veslo",
      "runtime-skills",
      "current",
    );
    const published = await publishDirectorySkillView({
      workspace: input.workspace,
      runtimeRoot,
      skillViewRevision: "revision-a",
    });

    expect(published.runtimeRoot).toBe(runtimeRoot);
    expect(
      await readFile(join(runtimeRoot, "local-tool", "SKILL.md"), "utf8"),
    ).toBe("local\n");
    const marker = JSON.parse(
      await readFile(
        join(runtimeRoot, ".veslo-engine-skill-staging.json"),
        "utf8",
      ),
    );
    expect(marker.skillViewRevision).toBe("revision-a");
  });

  test("retains the previous root when promotion and rollback both fail", async () => {
    const input = await fixture();
    const runtimeRoot = join(
      input.workspace,
      ".opencode",
      ".veslo",
      "runtime-skills",
      "current",
    );
    const pendingRoot = join(
      input.workspace,
      ".opencode",
      ".veslo",
      "runtime-skills",
      "pending",
    );
    const previousRoot = join(
      input.workspace,
      ".opencode",
      ".veslo",
      "runtime-skills",
      "previous",
    );
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(pendingRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "marker.txt"), "previous view\n");
    await writeFile(join(pendingRoot, "marker.txt"), "pending view\n");

    await expect(
      promoteDirectorySkillView(
        { runtimeRoot, pendingRoot, previousRoot },
        {
          renamePath: async (source, target) => {
            if (source === pendingRoot && target === runtimeRoot)
              throw new Error("promotion failed");
            if (source === previousRoot && target === runtimeRoot)
              throw new Error("rollback failed");
            await rename(source, target);
          },
        },
      ),
    ).rejects.toThrow("promotion failed");

    expect(await readFile(join(previousRoot, "marker.txt"), "utf8")).toBe(
      "previous view\n",
    );
    await expect(
      readFile(join(pendingRoot, "marker.txt"), "utf8"),
    ).rejects.toThrow();
  });
});
