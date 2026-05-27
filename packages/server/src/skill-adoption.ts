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

