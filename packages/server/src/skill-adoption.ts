import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { SkillPackageArchive } from "./skill-packages.js";
import { packSkillDirectory } from "./skill-packages.js";
import { exists } from "./utils.js";
import { validateSkillName } from "./validators.js";

export type SkillAdoptionScope = "personal-global" | "workspace";

export type SkillAdoptionTarget = {
  scope: SkillAdoptionScope;
  workspaceId?: string;
};

export type SkillAdoptionRequest = {
  skillDir: string;
  target: SkillAdoptionTarget;
  package: SkillPackageArchive;
};

export type SkillAdoptionRegistryScope = "user" | "workspace";

export type SkillAdoptionRegistryClient = {
  createSkill(input: {
    scope: SkillAdoptionRegistryScope;
    name: string;
    displayName?: string;
    description?: string;
    workspaceId?: string;
  }): Promise<{ skillId: string }>;
  createVersion(input: {
    skillId: string;
    package: SkillPackageArchive;
  }): Promise<{ versionId: string }>;
  createInstallation(input: {
    scope: SkillAdoptionRegistryScope;
    skillId: string;
    versionId: string;
    workspaceId?: string;
    updatePolicy?: "pinned";
  }): Promise<{ installationId: string }>;
};

export type SkillAdoptionResult = SkillAdoptionRequest & {
  skillId: string;
  versionId: string;
  installationId: string;
};

const MANAGED_MARKER_FILE = ".veslo-managed.json";

const normalizeSkillDir = (skillDir: string): string => {
  const normalized = skillDir.trim();
  if (!normalized) {
    throw new Error("Skill adoption requires a skill directory");
  }
  return normalized;
};

const assertUnmanagedSkillDir = async (skillDir: string): Promise<void> => {
  if (await exists(join(skillDir, MANAGED_MARKER_FILE))) {
    throw new Error("Managed registry skills are already adopted");
  }
};

const assertSkillEntrypoint = async (skillDir: string): Promise<void> => {
  const entrypointPath = join(skillDir, "SKILL.md");
  if (!(await exists(entrypointPath))) {
    throw new Error("Skill adoption requires SKILL.md");
  }
  await readFile(entrypointPath, "utf8");
};

const validateAdoptionTarget = (target: SkillAdoptionTarget): SkillAdoptionTarget => {
  if (target.scope !== "personal-global" && target.scope !== "workspace") {
    throw new Error("Skill adoption target scope must be personal-global or workspace");
  }
  const workspaceId = target.workspaceId?.trim();
  if (target.scope === "workspace" && !workspaceId) {
    throw new Error("Workspace skill adoption requires a workspaceId");
  }
  return {
    scope: target.scope,
    ...(workspaceId ? { workspaceId } : {}),
  };
};

export async function prepareSkillAdoptionRequest(input: {
  skillDir: string;
  target: SkillAdoptionTarget;
}): Promise<SkillAdoptionRequest> {
  const skillDir = normalizeSkillDir(input.skillDir);
  const target = validateAdoptionTarget(input.target);
  validateSkillName(basename(skillDir));
  await assertSkillEntrypoint(skillDir);
  await assertUnmanagedSkillDir(skillDir);
  const archive = await packSkillDirectory(skillDir);
  return {
    skillDir,
    target,
    package: archive,
  };
}

const registryScopeForTarget = (target: SkillAdoptionTarget): SkillAdoptionRegistryScope =>
  target.scope === "workspace" ? "workspace" : "user";

export async function adoptSkillIntoRegistry(input: {
  skillDir: string;
  target: SkillAdoptionTarget;
  registry: SkillAdoptionRegistryClient;
}): Promise<SkillAdoptionResult> {
  const adoption = await prepareSkillAdoptionRequest({
    skillDir: input.skillDir,
    target: input.target,
  });
  const scope = registryScopeForTarget(adoption.target);
  const createdSkill = await input.registry.createSkill({
    scope,
    name: adoption.package.metadata.name,
    description: adoption.package.metadata.description,
    ...(adoption.target.workspaceId ? { workspaceId: adoption.target.workspaceId } : {}),
  });
  const createdVersion = await input.registry.createVersion({
    skillId: createdSkill.skillId,
    package: adoption.package,
  });
  const createdInstallation = await input.registry.createInstallation({
    scope,
    skillId: createdSkill.skillId,
    versionId: createdVersion.versionId,
    updatePolicy: "pinned",
    ...(adoption.target.workspaceId ? { workspaceId: adoption.target.workspaceId } : {}),
  });

  return {
    ...adoption,
    skillId: createdSkill.skillId,
    versionId: createdVersion.versionId,
    installationId: createdInstallation.installationId,
  };
}
