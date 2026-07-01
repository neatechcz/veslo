import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveVesloDataDir } from "./audit.js";
import type { SoulDocument, SoulScope, SoulVersion } from "./soul-memory.js";
import { exists } from "./utils.js";

export type SoulCacheInput = {
  dataDir?: string;
};

export type CacheSoulDocumentInput = SoulCacheInput & {
  document: SoulDocument;
};

export type ReadCachedSoulDocumentInput = SoulCacheInput & {
  scope: SoulScope;
  ownerId: string;
};

export type SoulPendingEditDraft = {
  scope: SoulScope;
  ownerId: string;
  content: string;
  changeSummary: string;
  baseVersionId: string | null;
  createdAt: string;
  createdBy: string;
};

export type SoulPendingEdit = SoulPendingEditDraft & {
  id: string;
  denSynced: false;
};

export type WritePendingSoulEditInput = SoulCacheInput & {
  edit: SoulPendingEditDraft & {
    id?: string;
  };
};

export type ClearPendingSoulEditsInput = SoulCacheInput & {
  scope: SoulScope;
  ownerId: string;
};

const PENDING_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const LEGACY_OWNER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SOUL_SCOPES: readonly SoulScope[] = ["organization", "user", "workspace"];
const SOUL_VERSION_SOURCES: ReadonlyArray<SoulVersion["source"]> = ["manual", "api", "heartbeat", "restore", "system"];

const resolveDataDir = (dataDir?: string): string => {
  const trimmed = dataDir?.trim();
  return trimmed ? resolve(trimmed) : resolveVesloDataDir();
};

export function soulCacheRoot(dataDir?: string): string {
  return join(resolveDataDir(dataDir), "soul-cache");
}

export function soulCachePath(input: ReadCachedSoulDocumentInput): string {
  return join(soulCacheRoot(input.dataDir), input.scope, `${ownerIdPathPart(input.ownerId)}.json`);
}

function legacySoulCachePath(input: ReadCachedSoulDocumentInput): string | null {
  const ownerId = normalizeOwnerId(input.ownerId);
  if (!LEGACY_OWNER_ID_PATTERN.test(ownerId)) return null;
  return join(soulCacheRoot(input.dataDir), input.scope, `${ownerId}.json`);
}

export function soulPendingCacheDir(dataDir?: string): string {
  return join(soulCacheRoot(dataDir), "pending");
}

export function soulPendingEditPath(input: SoulCacheInput & { pendingEditId: string }): string {
  return join(soulPendingCacheDir(input.dataDir), `${normalizePendingId(input.pendingEditId)}.json`);
}

function normalizeOwnerId(ownerId: string): string {
  const normalized = ownerId.trim();
  if (!normalized) {
    throw new Error("Soul cache owner id is invalid");
  }
  return normalized;
}

function ownerIdPathPart(ownerId: string): string {
  const normalized = normalizeOwnerId(ownerId);
  const encoded = Buffer.from(normalized, "utf8").toString("base64url");
  if (encoded.length <= 160) return encoded;
  return `sha256_${createHash("sha256").update(normalized).digest("hex")}`;
}

function normalizePendingId(pendingEditId: string): string {
  const normalized = pendingEditId.trim();
  if (!PENDING_ID_PATTERN.test(normalized)) {
    throw new Error("Soul pending edit id is invalid");
  }
  return normalized;
}

function validateSoulDocumentForCache(document: SoulDocument): SoulDocument {
  if (
    !document
    || typeof document !== "object"
    || typeof document.id !== "string"
    || typeof document.ownerId !== "string"
    || !(document.currentVersionId === null || typeof document.currentVersionId === "string")
    || typeof document.heartbeatEnabled !== "boolean"
    || !Array.isArray(document.versions)
  ) {
    throw new Error("Soul cache document is invalid");
  }
  normalizeOwnerId(document.ownerId);
  if (!SOUL_SCOPES.includes(document.scope)) {
    throw new Error("Soul cache document scope is invalid");
  }
  if (!document.id.trim()) {
    throw new Error("Soul cache document id is invalid");
  }
  const versions = document.versions.map(validateSoulVersionForCache);
  const versionIds = new Set<string>();
  for (const version of versions) {
    if (versionIds.has(version.id)) {
      throw new Error("Soul cache document versions are invalid");
    }
    versionIds.add(version.id);
  }
  if (document.currentVersionId !== null && !versionIds.has(document.currentVersionId)) {
    throw new Error("Soul cache current version is invalid");
  }
  return { ...document, versions };
}

function validateSoulVersionForCache(version: SoulVersion): SoulVersion {
  if (
    !version
    || typeof version !== "object"
    || typeof version.id !== "string"
    || typeof version.content !== "string"
    || typeof version.changeSummary !== "string"
    || typeof version.createdAt !== "string"
    || typeof version.createdBy !== "string"
    || !SOUL_VERSION_SOURCES.includes(version.source)
    || !(version.baseVersionId === null || typeof version.baseVersionId === "string")
    || !(version.restoreSourceVersionId === null || typeof version.restoreSourceVersionId === "string")
  ) {
    throw new Error("Soul cache document versions are invalid");
  }
  return version;
}

function validateCachedSoulDocument(document: SoulDocument, scope: SoulScope, ownerId: string): SoulDocument {
  const validated = validateSoulDocumentForCache(document);
  if (validated.scope !== scope || validated.ownerId !== ownerId) {
    throw new Error("Cached Soul document does not match requested scope and owner");
  }
  return validated;
}

function validatePendingEdit(edit: SoulPendingEdit): SoulPendingEdit {
  normalizePendingId(edit.id);
  normalizeOwnerId(edit.ownerId);
  if (!["organization", "user", "workspace"].includes(edit.scope)) {
    throw new Error("Soul pending edit scope is invalid");
  }
  if (edit.denSynced !== false) {
    throw new Error("Soul pending edit must not be marked as Den-synced");
  }
  if (
    !edit.content.trim()
    || !edit.changeSummary.trim()
    || !edit.createdAt.trim()
    || !edit.createdBy.trim()
    || !(edit.baseVersionId === null || typeof edit.baseVersionId === "string")
  ) {
    throw new Error("Soul pending edit is invalid");
  }
  return edit;
}

export async function cacheSoulDocument(input: CacheSoulDocumentInput): Promise<string> {
  const document = validateSoulDocumentForCache(input.document);
  const path = soulCachePath({ dataDir: input.dataDir, scope: document.scope, ownerId: document.ownerId });
  await mkdir(join(soulCacheRoot(input.dataDir), document.scope), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return path;
}

export async function readCachedSoulDocument(input: ReadCachedSoulDocumentInput): Promise<SoulDocument | null> {
  const ownerId = normalizeOwnerId(input.ownerId);
  let path = soulCachePath({ ...input, ownerId });
  if (!(await exists(path))) {
    const legacyPath = legacySoulCachePath({ ...input, ownerId });
    if (!legacyPath || !(await exists(legacyPath))) return null;
    path = legacyPath;
  }

  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SoulDocument;
    return validateCachedSoulDocument(parsed, input.scope, ownerId);
  } catch {
    return null;
  }
}

export async function writePendingSoulEdit(input: WritePendingSoulEditInput): Promise<SoulPendingEdit> {
  const edit = validatePendingEdit({
    ...input.edit,
    id: input.edit.id ?? `pending_${randomUUID()}`,
    denSynced: false,
  });
  const path = soulPendingEditPath({ dataDir: input.dataDir, pendingEditId: edit.id });
  await mkdir(soulPendingCacheDir(input.dataDir), { recursive: true });
  await writeFile(path, `${JSON.stringify(edit, null, 2)}\n`, "utf8");
  return edit;
}

export async function listPendingSoulEdits(input: SoulCacheInput = {}): Promise<SoulPendingEdit[]> {
  const dir = soulPendingCacheDir(input.dataDir);
  if (!(await exists(dir))) return [];

  const edits: SoulPendingEdit[] = [];
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  for (const entry of entries) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, entry), "utf8")) as SoulPendingEdit;
      edits.push(validatePendingEdit(parsed));
    } catch {
      continue;
    }
  }

  return edits;
}

export async function clearPendingSoulEdits(input: ClearPendingSoulEditsInput): Promise<number> {
  const dir = soulPendingCacheDir(input.dataDir);
  if (!(await exists(dir))) return 0;

  const ownerId = normalizeOwnerId(input.ownerId);
  let removed = 0;
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));

  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as SoulPendingEdit;
      const edit = validatePendingEdit(parsed);
      if (edit.scope !== input.scope || edit.ownerId !== ownerId) continue;
      await rm(path, { force: true });
      removed += 1;
    } catch {
      continue;
    }
  }

  return removed;
}
