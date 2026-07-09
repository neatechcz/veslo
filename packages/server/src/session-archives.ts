import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";

import { ensureDir } from "./utils.js";

export type SessionArchiveRecord = {
  sessionId: string;
  archivedAt: number;
  titleSnapshot: string;
  workspaceIdAtArchive?: string;
  workspaceLabelSnapshot?: string;
  resolvedDirectoryAtArchive?: string;
  projectRootAtArchive?: string;
  projectLabelSnapshot?: string;
  parentSessionId?: string | null;
  createdAtSnapshot?: number | null;
  updatedAtSnapshot?: number | null;
  workspaceIdentity?: string;
};

const defaultArchiveStoreDir = () =>
  resolve(process.env.VESLO_SESSION_ARCHIVES_DIR?.trim() || join(homedir(), ".veslo", "veslo-server", "session-archives"));

const normalizeRecord = (record: SessionArchiveRecord): SessionArchiveRecord => ({
  sessionId: record.sessionId.trim(),
  archivedAt: Number.isFinite(record.archivedAt) ? record.archivedAt : Date.now(),
  titleSnapshot: record.titleSnapshot?.trim() ?? "",
  workspaceIdAtArchive: record.workspaceIdAtArchive?.trim() || undefined,
  workspaceLabelSnapshot: record.workspaceLabelSnapshot?.trim() || undefined,
  resolvedDirectoryAtArchive: record.resolvedDirectoryAtArchive?.trim() || undefined,
  projectRootAtArchive: record.projectRootAtArchive?.trim() || undefined,
  projectLabelSnapshot: record.projectLabelSnapshot?.trim() || undefined,
  parentSessionId:
    typeof record.parentSessionId === "string" ? (record.parentSessionId.trim() || null) : (record.parentSessionId ?? null),
  createdAtSnapshot: Number.isFinite(record.createdAtSnapshot ?? NaN) ? record.createdAtSnapshot ?? null : null,
  updatedAtSnapshot: Number.isFinite(record.updatedAtSnapshot ?? NaN) ? record.updatedAtSnapshot ?? null : null,
  workspaceIdentity: record.workspaceIdentity?.trim() || undefined,
});

const sortRecords = (records: SessionArchiveRecord[]) =>
  [...records].sort((left, right) => right.archivedAt - left.archivedAt);

const archiveRecordDirectory = (
  record: Pick<SessionArchiveRecord, "resolvedDirectoryAtArchive" | "projectRootAtArchive">,
) => record.resolvedDirectoryAtArchive?.trim() || record.projectRootAtArchive?.trim() || "";

const archiveRecordKey = (
  record: Pick<
    SessionArchiveRecord,
    "sessionId" | "workspaceIdAtArchive" | "workspaceIdentity" | "resolvedDirectoryAtArchive" | "projectRootAtArchive"
  >,
) => {
  const directory = archiveRecordDirectory(record);
  const base = [
    record.workspaceIdAtArchive?.trim() || record.workspaceIdentity?.trim() || "",
    record.sessionId.trim(),
  ];
  return (directory ? [...base, directory] : base).join("\0");
};

const matchesDeleteScope = (
  record: SessionArchiveRecord,
  sessionId: string,
  workspaceId?: string | null,
  workspaceIdentity?: string | null,
  directory?: string | null,
) => {
  if (record.sessionId !== sessionId) return false;
  const scopedDirectory = directory?.trim() ?? "";
  if (scopedDirectory && archiveRecordDirectory(record) !== scopedDirectory) return false;
  const scopedWorkspaceId = workspaceId?.trim() ?? "";
  const scopedWorkspaceIdentity = workspaceIdentity?.trim() ?? "";
  if (!scopedWorkspaceId && !scopedWorkspaceIdentity) return true;
  const recordWorkspaceId = record.workspaceIdAtArchive?.trim() ?? "";
  if (scopedWorkspaceId && recordWorkspaceId) {
    return recordWorkspaceId === scopedWorkspaceId;
  }
  const recordWorkspaceIdentity = record.workspaceIdentity?.trim() ?? "";
  if (scopedWorkspaceIdentity && recordWorkspaceIdentity) {
    return recordWorkspaceIdentity === scopedWorkspaceIdentity;
  }
  return false;
};

export function createSessionArchiveStore(options?: { dir?: string }) {
  const dir = resolve(options?.dir?.trim() || defaultArchiveStoreDir());

  const ownerPath = (ownerKey: string) => {
    const digest = createHash("sha256").update(ownerKey).digest("hex");
    return join(dir, `${digest}.json`);
  };

  const readOwnerRecords = async (ownerKey: string): Promise<SessionArchiveRecord[]> => {
    const path = ownerPath(ownerKey);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return sortRecords(
        parsed
          .filter((value): value is SessionArchiveRecord => Boolean(value && typeof value === "object"))
          .map((value) => normalizeRecord(value))
          .filter((value) => Boolean(value.sessionId)),
      );
    } catch {
      return [];
    }
  };

  const writeOwnerRecords = async (ownerKey: string, records: SessionArchiveRecord[]) => {
    const path = ownerPath(ownerKey);
    const tempPath = `${path}.tmp`;
    await ensureDir(dirname(path));
    await writeFile(tempPath, `${JSON.stringify(sortRecords(records), null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  };

  return {
    async list(ownerKey: string): Promise<SessionArchiveRecord[]> {
      return readOwnerRecords(ownerKey);
    },
    async put(ownerKey: string, input: SessionArchiveRecord): Promise<SessionArchiveRecord[]> {
      const record = normalizeRecord(input);
      const existing = await readOwnerRecords(ownerKey);
      const key = archiveRecordKey(record);
      const next = existing.filter((entry) => archiveRecordKey(entry) !== key);
      next.push(record);
      await writeOwnerRecords(ownerKey, next);
      return sortRecords(next);
    },
    async delete(
      ownerKey: string,
      sessionId: string,
      options?: { workspaceId?: string | null; workspaceIdentity?: string | null; directory?: string | null },
    ): Promise<SessionArchiveRecord[]> {
      const normalizedId = sessionId.trim();
      const existing = await readOwnerRecords(ownerKey);
      const next = existing.filter((entry) =>
        !matchesDeleteScope(entry, normalizedId, options?.workspaceId, options?.workspaceIdentity, options?.directory)
      );
      await writeOwnerRecords(ownerKey, next);
      return sortRecords(next);
    },
  };
}
