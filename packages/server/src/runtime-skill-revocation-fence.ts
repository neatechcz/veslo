import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveVesloDataDir } from "./audit.js";

type FenceDocument = {
  schemaVersion: 1;
  deniedAuthorizationRevisions: string[];
};

function fencePath(dataDir: string | undefined, workspaceId: string): string {
  const root = dataDir?.trim() ? resolve(dataDir) : resolveVesloDataDir();
  // Workspace IDs are server identities, but retaining only a conservative
  // filename alphabet keeps this fence safe even for imported old configs.
  const safeId = workspaceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(root, "runtime-skill-revocation-fences", `${safeId}.json`);
}

async function readFence(dataDir: string | undefined, workspaceId: string): Promise<FenceDocument> {
  try {
    const parsed = JSON.parse(await readFile(fencePath(dataDir, workspaceId), "utf8")) as Partial<FenceDocument>;
    return {
      schemaVersion: 1,
      deniedAuthorizationRevisions: Array.isArray(parsed.deniedAuthorizationRevisions)
        ? parsed.deniedAuthorizationRevisions.filter((value): value is string => typeof value === "string" && Boolean(value))
        : [],
    };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { schemaVersion: 1, deniedAuthorizationRevisions: [] };
    }
    // A corrupt or unreadable fence is never permission to resurrect a
    // revoked binding. Callers fail closed when this propagates.
    throw error;
  }
}

export async function fenceRuntimeSkillAuthorization(input: {
  dataDir?: string;
  workspaceId: string;
  authorizationRevision: string;
}): Promise<void> {
  const revision = input.authorizationRevision.trim();
  if (!revision) return;
  const path = fencePath(input.dataDir, input.workspaceId);
  const document = await readFence(input.dataDir, input.workspaceId);
  if (document.deniedAuthorizationRevisions.includes(revision)) return;
  document.deniedAuthorizationRevisions.push(revision);
  // Never forget a known revocation. These hashes are compact, policy changes
  // are rare, and truncation could resurrect an old persisted manifest.
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** A validated promotion may explicitly authorize a state hash seen before. */
export async function allowRuntimeSkillAuthorization(input: {
  dataDir?: string;
  workspaceId: string;
  authorizationRevision: string;
  commitGuard?: () => void;
}): Promise<void> {
  const revision = input.authorizationRevision.trim();
  if (!revision) return;
  const path = fencePath(input.dataDir, input.workspaceId);
  const document = await readFence(input.dataDir, input.workspaceId);
  const next = document.deniedAuthorizationRevisions.filter((value) => value !== revision);
  if (next.length === document.deniedAuthorizationRevisions.length) return;
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    await writeFile(temp, `${JSON.stringify({ ...document, deniedAuthorizationRevisions: next }, null, 2)}\n`, "utf8");
    input.commitGuard?.();
    renameSync(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function isRuntimeSkillAuthorizationFenced(input: {
  dataDir?: string;
  workspaceId: string;
  authorizationRevision: string;
}): Promise<boolean> {
  const revision = input.authorizationRevision.trim();
  if (!revision) return false;
  return (await readFence(input.dataDir, input.workspaceId)).deniedAuthorizationRevisions.includes(revision);
}
