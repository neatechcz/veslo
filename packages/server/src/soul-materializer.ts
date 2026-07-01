import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { localUserResourceOwner, organizationResourceOwner, workspaceResourceOwner } from "./resource-owner.js";
import { readJsoncFile, updateJsoncTopLevel } from "./jsonc.js";
import { currentSoulVersion, type SoulDocument, type SoulScope } from "./soul-memory.js";
import type { ResourceOwner } from "./types.js";
import { opencodeConfigPath } from "./workspace-files.js";
import { ensureDir, exists } from "./utils.js";
import { SOUL_INSTRUCTIONS, SOUL_MANIFEST_PATH } from "./soul-runtime.js";

const MANIFEST_SCHEMA_VERSION = 1;
const MANAGED_BY = "veslo-soul-materializer";

const SOURCE_FILES: ReadonlyArray<{
  scope: SoulScope;
  relativePath: typeof SOUL_INSTRUCTIONS[number];
}> = [
  { scope: "organization", relativePath: ".opencode/soul-company.md" },
  { scope: "user", relativePath: ".opencode/soul-user.md" },
  { scope: "workspace", relativePath: ".opencode/soul-workspace.md" },
];

export type SoulMaterializationManifestFile = {
  path: string;
  scope: SoulScope;
  ownerId: string | null;
  documentId: string | null;
  currentVersionId: string | null;
  sourceVersionId: string | null;
  contentSha256: string;
  managedBy: typeof MANAGED_BY;
  materializedAt: string;
};

export type SoulMaterializationManifest = {
  schemaVersion: 1;
  generatedAt: string;
  managedBy: typeof MANAGED_BY;
  composition: {
    order: SoulScope[];
    currentVersionIds: Record<SoulScope, string | null>;
    effectiveSha256: string;
  };
  files: SoulMaterializationManifestFile[];
};

export type SoulMaterializationConflict = {
  path: string;
  relativePath: string;
  reason: "unmanaged_target_exists" | "managed_target_modified" | "managed_target_missing";
};

type SoulMaterializationFileResult = SoulMaterializationManifestFile & {
  absolutePath: string;
  owner: ResourceOwner | null;
};

export type SoulMaterializationSuccess = {
  ok: true;
  status: "current" | "pending";
  workspaceRoot: string;
  effectiveContent: string;
  manifestPath: string;
  instructionsPath: string;
  files: SoulMaterializationFileResult[];
  pending: boolean;
  reloadRequired: boolean;
  manualSyncRequired: false;
  requiresAction?: never;
};

export type SoulMaterializationFailure = {
  ok: false;
  reason: "conflict" | "config_error" | "manifest_error" | "write_error";
  message: string;
  path?: string;
  conflicts?: SoulMaterializationConflict[];
  pending: boolean;
  manualSyncRequired: false;
  requiresAction:
    | "preserve_unmanaged_soul_file"
    | "restore_managed_soul_file"
    | "fix_opencode_config"
    | "fix_soul_manifest"
    | "inspect_materialization_error";
};

export type SoulMaterializationResult = SoulMaterializationSuccess | SoulMaterializationFailure;

export type MaterializeEffectiveSoulInput = {
  workspaceRoot: string;
  organization?: SoulDocument | null;
  user?: SoulDocument | null;
  workspace?: SoulDocument | null;
  workspaceActive?: boolean;
};

type SourceSnapshot = {
  scope: SoulScope;
  relativePath: typeof SOUL_INSTRUCTIONS[number];
  absolutePath: string;
  document: SoulDocument | null;
  content: string;
  versionId: string | null;
};

export function soulMaterializationManifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, SOUL_MANIFEST_PATH);
}

export async function readSoulMaterializationManifest(
  workspaceRoot: string,
): Promise<SoulMaterializationManifest | null> {
  const path = soulMaterializationManifestPath(workspaceRoot);
  if (!(await exists(path))) return null;
  return validateSoulMaterializationManifest(JSON.parse(await readFile(path, "utf8")));
}

export async function readSoulMaterializationStatus(
  workspaceRoot: string,
): Promise<SoulMaterializationResult | undefined> {
  const manifestPath = soulMaterializationManifestPath(workspaceRoot);
  let manifest: SoulMaterializationManifest | null;
  try {
    manifest = await readSoulMaterializationManifest(workspaceRoot);
  } catch (error) {
    return failure("manifest_error", {
      message: errorMessage(error, "Soul materialization manifest is invalid"),
      path: manifestPath,
      requiresAction: "fix_soul_manifest",
    });
  }
  if (!manifest) return undefined;

  const conflicts = await managedFileConflicts(workspaceRoot, manifest);
  if (conflicts.length > 0) {
    return conflictFailure(conflicts);
  }

  const files = manifest.files.map((file) => ({
    ...file,
    absolutePath: join(workspaceRoot, file.path),
    owner: soulFileResourceOwner(file.scope, file.ownerId),
  }));
  const contents = await Promise.all(files.map(async (file) => {
    try {
      return normalizeExistingManagedContent(await readFile(file.absolutePath, "utf8"));
    } catch {
      return "";
    }
  }));

  return {
    ok: true,
    status: "current",
    workspaceRoot,
    effectiveContent: contents.filter((content) => content.length > 0).join("\n\n"),
    manifestPath,
    instructionsPath: opencodeConfigPath(workspaceRoot),
    files,
    pending: false,
    reloadRequired: true,
    manualSyncRequired: false,
  };
}

export async function materializeEffectiveSoul(input: MaterializeEffectiveSoulInput): Promise<SoulMaterializationResult> {
  const workspaceRoot = input.workspaceRoot;
  const manifestPath = soulMaterializationManifestPath(workspaceRoot);
  const instructionsPath = opencodeConfigPath(workspaceRoot);
  const snapshots = buildSourceSnapshots(input);
  const effectiveContent = snapshots
    .map((snapshot) => snapshot.content)
    .filter((content) => content.length > 0)
    .join("\n\n");

  let previousManifest: SoulMaterializationManifest | null;
  try {
    previousManifest = await readSoulMaterializationManifest(workspaceRoot);
  } catch (error) {
    return failure("manifest_error", {
      message: errorMessage(error, "Soul materialization manifest is invalid"),
      path: manifestPath,
      requiresAction: "fix_soul_manifest",
    });
  }

  const conflicts = await targetConflicts(workspaceRoot, snapshots, previousManifest);
  if (conflicts.length > 0) {
    return conflictFailure(conflicts);
  }

  const materializedAt = new Date().toISOString();
  const files = snapshots.map((snapshot) => manifestFileForSnapshot(snapshot, materializedAt));

  if (input.workspaceActive === true) {
    return {
      ok: true,
      status: "pending",
      workspaceRoot,
      effectiveContent,
      manifestPath,
      instructionsPath,
      files,
      pending: true,
      reloadRequired: true,
      manualSyncRequired: false,
    };
  }

  try {
    await ensureSoulInstructions(instructionsPath);
  } catch (error) {
    return failure("config_error", {
      message: errorMessage(error, "Failed to update OpenCode Soul instructions"),
      path: instructionsPath,
      requiresAction: "fix_opencode_config",
    });
  }

  const manifest = manifestForFiles(files, effectiveContent, materializedAt);

  try {
    await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
    for (const snapshot of snapshots) {
      await writeManagedFile(snapshot.absolutePath, snapshot.content);
    }
    await ensureDir(dirname(manifestPath));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    return failure("write_error", {
      message: errorMessage(error, "Failed to write Soul runtime files"),
      path: manifestPath,
      requiresAction: "inspect_materialization_error",
    });
  }

  return {
    ok: true,
    status: "current",
    workspaceRoot,
    effectiveContent,
    manifestPath,
    instructionsPath,
    files,
    pending: false,
    reloadRequired: true,
    manualSyncRequired: false,
  };
}

function buildSourceSnapshots(input: MaterializeEffectiveSoulInput): SourceSnapshot[] {
  const documents: Record<SoulScope, SoulDocument | null> = {
    organization: input.organization ?? null,
    user: input.user ?? null,
    workspace: input.workspace ?? null,
  };
  return SOURCE_FILES.map((source) => {
    const document = documents[source.scope];
    const version = document ? currentSoulVersion(document) : null;
    return {
      scope: source.scope,
      relativePath: source.relativePath,
      absolutePath: join(input.workspaceRoot, source.relativePath),
      document,
      content: version?.content ?? "",
      versionId: version?.id ?? null,
    };
  });
}

async function targetConflicts(
  workspaceRoot: string,
  snapshots: SourceSnapshot[],
  manifest: SoulMaterializationManifest | null,
): Promise<SoulMaterializationConflict[]> {
  const managedPaths = new Set(
    (manifest?.files ?? [])
      .filter((file) => file.managedBy === MANAGED_BY)
      .map((file) => file.path),
  );
  const conflicts: SoulMaterializationConflict[] = [];
  for (const snapshot of snapshots) {
    const targetExists = await exists(snapshot.absolutePath);
    if (managedPaths.has(snapshot.relativePath)) {
      if (!targetExists) {
        conflicts.push({
          path: snapshot.absolutePath,
          relativePath: snapshot.relativePath,
          reason: "managed_target_missing",
        });
        continue;
      }
      const entry = manifest?.files.find((file) => file.path === snapshot.relativePath);
      if (entry && !(await existingFileMatchesManifest(snapshot.absolutePath, entry))) {
        conflicts.push({
          path: snapshot.absolutePath,
          relativePath: snapshot.relativePath,
          reason: "managed_target_modified",
        });
      }
      continue;
    }
    if (!targetExists) continue;
    conflicts.push({
      path: snapshot.absolutePath,
      relativePath: snapshot.relativePath,
      reason: "unmanaged_target_exists",
    });
  }
  for (const conflict of await managedFileConflicts(workspaceRoot, manifest, managedPaths)) {
    if (!conflicts.some((existing) => existing.relativePath === conflict.relativePath)) {
      conflicts.push(conflict);
    }
  }
  return conflicts;
}

async function managedFileConflicts(
  workspaceRoot: string,
  manifest: SoulMaterializationManifest | null,
  onlyPaths?: Set<string>,
): Promise<SoulMaterializationConflict[]> {
  const conflicts: SoulMaterializationConflict[] = [];
  for (const entry of manifest?.files ?? []) {
    if (onlyPaths && !onlyPaths.has(entry.path)) continue;
    const absolutePath = join(workspaceRoot, entry.path);
    if (!(await exists(absolutePath))) {
      conflicts.push({
        path: absolutePath,
        relativePath: entry.path,
        reason: "managed_target_missing",
      });
      continue;
    }
    if (!(await existingFileMatchesManifest(absolutePath, entry))) {
      conflicts.push({
        path: absolutePath,
        relativePath: entry.path,
        reason: "managed_target_modified",
      });
    }
  }
  return conflicts;
}

async function existingFileMatchesManifest(path: string, entry: SoulMaterializationManifestFile): Promise<boolean> {
  const content = await readFile(path, "utf8");
  if (sha256(content) === entry.contentSha256) return true;
  return sha256(normalizeExistingManagedContent(content)) === entry.contentSha256;
}

async function ensureSoulInstructions(configPath: string): Promise<void> {
  const { data } = await readJsoncFile<Record<string, unknown>>(configPath, {});
  const existing = data.instructions;
  const instructions = Array.isArray(existing)
    ? [...existing]
    : typeof existing === "string"
      ? [existing]
      : [];

  let changed = !Array.isArray(existing);
  for (const instruction of SOUL_INSTRUCTIONS) {
    if (!instructions.some((entry) => typeof entry === "string" && entry === instruction)) {
      instructions.push(instruction);
      changed = true;
    }
  }

  if (changed) {
    await updateJsoncTopLevel(configPath, { instructions });
  }
}

function manifestFileForSnapshot(snapshot: SourceSnapshot, materializedAt: string): SoulMaterializationFileResult {
  const document = snapshot.document;
  const ownerId = document?.ownerId ?? null;
  return {
    path: snapshot.relativePath,
    absolutePath: snapshot.absolutePath,
    scope: snapshot.scope,
    ownerId,
    owner: soulFileResourceOwner(snapshot.scope, ownerId),
    documentId: document?.id ?? null,
    currentVersionId: document?.currentVersionId ?? null,
    sourceVersionId: snapshot.versionId,
    contentSha256: sha256(normalizeManagedFileContent(snapshot.content)),
    managedBy: MANAGED_BY,
    materializedAt,
  };
}

function manifestForFiles(
  files: SoulMaterializationFileResult[],
  effectiveContent: string,
  generatedAt: string,
): SoulMaterializationManifest {
  const manifestFiles = files.map(({ absolutePath: _absolutePath, owner: _owner, ...file }) => file);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt,
    managedBy: MANAGED_BY,
    composition: {
      order: ["organization", "user", "workspace"],
      currentVersionIds: {
        organization: manifestFiles.find((file) => file.scope === "organization")?.currentVersionId ?? null,
        user: manifestFiles.find((file) => file.scope === "user")?.currentVersionId ?? null,
        workspace: manifestFiles.find((file) => file.scope === "workspace")?.currentVersionId ?? null,
      },
      effectiveSha256: sha256(effectiveContent),
    },
    files: manifestFiles,
  };
}

function soulFileResourceOwner(
  scope: SoulScope,
  ownerId: string | null,
): ResourceOwner | null {
  if (!ownerId) return null;
  if (scope === "organization") {
    return organizationResourceOwner({ orgId: ownerId, label: "Organization" });
  }
  if (scope === "user") {
    return localUserResourceOwner({ userId: ownerId, label: "User" });
  }
  return workspaceResourceOwner({ workspaceId: ownerId });
}

async function writeManagedFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, normalizeManagedFileContent(content), "utf8");
}

function normalizeManagedFileContent(content: string): string {
  return content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
}

function normalizeExistingManagedContent(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

function validateSoulMaterializationManifest(value: unknown): SoulMaterializationManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Soul materialization manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error("Soul materialization manifest schemaVersion must be 1");
  }
  if (record.managedBy !== MANAGED_BY) {
    throw new Error("Soul materialization manifest managedBy is invalid");
  }
  const generatedAt = stringOrNull(record.generatedAt);
  if (!generatedAt) {
    throw new Error("Soul materialization manifest generatedAt is required");
  }
  if (!record.composition || typeof record.composition !== "object") {
    throw new Error("Soul materialization manifest composition is invalid");
  }
  const composition = record.composition as Record<string, unknown>;
  const order = Array.isArray(composition.order)
    ? composition.order.filter((item): item is SoulScope => isSoulScope(item))
    : [];
  if (order.length !== 3 || order.join("|") !== "organization|user|workspace") {
    throw new Error("Soul materialization manifest composition order is invalid");
  }
  const currentVersionIds = composition.currentVersionIds && typeof composition.currentVersionIds === "object"
    ? composition.currentVersionIds as Record<string, unknown>
    : {};
  const effectiveSha256 = stringOrNull(composition.effectiveSha256);
  if (!effectiveSha256) {
    throw new Error("Soul materialization manifest effectiveSha256 is required");
  }
  if (!Array.isArray(record.files)) {
    throw new Error("Soul materialization manifest files must be an array");
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt,
    managedBy: MANAGED_BY,
    composition: {
      order,
      currentVersionIds: {
        organization: stringOrNull(currentVersionIds.organization),
        user: stringOrNull(currentVersionIds.user),
        workspace: stringOrNull(currentVersionIds.workspace),
      },
      effectiveSha256,
    },
    files: record.files.map(validateManifestFile),
  };
}

function validateManifestFile(value: unknown): SoulMaterializationManifestFile {
  if (!value || typeof value !== "object") {
    throw new Error("Soul materialization manifest file entry must be an object");
  }
  const record = value as Record<string, unknown>;
  const path = stringOrNull(record.path);
  const scope = isSoulScope(record.scope) ? record.scope : null;
  const contentSha256 = stringOrNull(record.contentSha256);
  const materializedAt = stringOrNull(record.materializedAt);
  if (!path || !scope || !contentSha256 || !materializedAt || record.managedBy !== MANAGED_BY) {
    throw new Error("Soul materialization manifest file entry is invalid");
  }
  return {
    path,
    scope,
    ownerId: stringOrNull(record.ownerId),
    documentId: stringOrNull(record.documentId),
    currentVersionId: stringOrNull(record.currentVersionId),
    sourceVersionId: stringOrNull(record.sourceVersionId),
    contentSha256,
    managedBy: MANAGED_BY,
    materializedAt,
  };
}

function isSoulScope(value: unknown): value is SoulScope {
  return value === "organization" || value === "user" || value === "workspace";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function failure(
  reason: SoulMaterializationFailure["reason"],
  input: Omit<SoulMaterializationFailure, "ok" | "reason" | "pending" | "manualSyncRequired">,
): SoulMaterializationFailure {
  return {
    ok: false,
    reason,
    pending: false,
    manualSyncRequired: false,
    ...input,
  };
}

function conflictFailure(conflicts: SoulMaterializationConflict[]): SoulMaterializationFailure {
  const requiresAction = conflicts.every((conflict) => conflict.reason === "managed_target_missing")
    ? "restore_managed_soul_file"
    : "preserve_unmanaged_soul_file";
  return failure("conflict", {
    message: "Refusing to overwrite Soul runtime files without confirmed Veslo ownership.",
    conflicts,
    requiresAction,
  });
}
