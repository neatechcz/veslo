import { join } from "node:path";

import { readJsoncFile } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";

export const SOUL_INSTRUCTIONS = [
  ".opencode/soul-company.md",
  ".opencode/soul-user.md",
  ".opencode/soul-workspace.md",
] as const;

export const SOUL_MANIFEST_PATH = ".opencode/veslo/soul-manifest.json";

export function soulMemoryPaths(workspaceRoot: string): string[] {
  return SOUL_INSTRUCTIONS.map((relativePath) => join(workspaceRoot, relativePath));
}

export function soulMaterializationApprovalPaths(workspaceRoot: string): string[] {
  return [
    opencodeConfigPath(workspaceRoot),
    ...soulMemoryPaths(workspaceRoot),
    join(workspaceRoot, SOUL_MANIFEST_PATH),
  ];
}

export function configIncludesSoulInstruction(config: Record<string, unknown>): boolean {
  const targets = [...SOUL_INSTRUCTIONS];
  const instructions = config.instructions;
  const matchesSoulInstruction = (entry: unknown) =>
    typeof entry === "string" && targets.some((target) => entry.includes(target));
  if (typeof instructions === "string") {
    return matchesSoulInstruction(instructions);
  }
  if (Array.isArray(instructions)) {
    return instructions.some(matchesSoulInstruction);
  }
  return false;
}

export async function readOpencodeConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  return data;
}
