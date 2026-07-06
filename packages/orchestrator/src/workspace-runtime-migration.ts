import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type WorkspaceConfigDirMigrationInput = {
  dataDir: string;
  workspaceId: string;
  legacyWorkspaceIds?: string[] | null;
};

export type WorkspaceConfigDirMigrationResult = {
  migrated: boolean;
  targetDir: string;
  sourceDir: string | null;
  sourceWorkspaceId: string | null;
  reason: "migrated" | "target_exists" | "source_missing" | "invalid_input";
};

function normalizeId(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function migrateLegacyWorkspaceConfigDir(
  input: WorkspaceConfigDirMigrationInput,
): Promise<WorkspaceConfigDirMigrationResult> {
  const dataDir = input.dataDir.trim();
  const workspaceId = normalizeId(input.workspaceId);
  const targetDir = join(dataDir, "opencode-config", workspaceId);
  if (!dataDir || !workspaceId) {
    return {
      migrated: false,
      targetDir,
      sourceDir: null,
      sourceWorkspaceId: null,
      reason: "invalid_input",
    };
  }

  if (await isDirectory(targetDir)) {
    return {
      migrated: false,
      targetDir,
      sourceDir: null,
      sourceWorkspaceId: null,
      reason: "target_exists",
    };
  }

  const legacyIds = Array.from(
    new Set((input.legacyWorkspaceIds ?? []).map(normalizeId).filter(Boolean)),
  ).filter((id) => id !== workspaceId);
  for (const legacyId of legacyIds) {
    const sourceDir = join(dataDir, "opencode-config", legacyId);
    if (!(await isDirectory(sourceDir))) continue;

    await mkdir(join(dataDir, "opencode-config"), { recursive: true });
    await cp(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: false });
    return {
      migrated: true,
      targetDir,
      sourceDir,
      sourceWorkspaceId: legacyId,
      reason: "migrated",
    };
  }

  return {
    migrated: false,
    targetDir,
    sourceDir: null,
    sourceWorkspaceId: null,
    reason: "source_missing",
  };
}
