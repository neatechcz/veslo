import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { DebugLogEvent } from "./debug-log-events.js";
import { resolveVesloDataDir } from "./audit.js";
import { ensureDir, exists, readJsonFile } from "./utils.js";

interface DebugLogFileStateEntry {
  size: number;
  sha256: string;
  updatedAt: number;
}

interface DebugLogFileState {
  files: Record<string, DebugLogFileStateEntry>;
}

function sanitizePathSegment(value: string): string {
  return encodeURIComponent(value.trim() || "unknown");
}

function resolveDebugLogStatePath(workspaceId: string): string {
  return join(resolveVesloDataDir(), "debug-logs", sanitizePathSegment(workspaceId), "file-state.json");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readState(path: string): Promise<DebugLogFileState> {
  const parsed = await readJsonFile<Partial<DebugLogFileState>>(path);
  return {
    files: parsed?.files ?? {},
  };
}

async function writeState(path: string, state: DebugLogFileState): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(state), "utf8");
}

function resolveAgentLabLogsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "agentlab", "logs");
}

function resolveLegacyAuditPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "audit.jsonl");
}

function buildEvent(input: {
  workspaceRoot: string;
  workspaceId: string;
  userId: string;
  orgId: string;
  source: "agentlab" | "audit";
  filePath: string;
  sequenceNo: number;
  rawChunk: string;
  fingerprint: DebugLogFileStateEntry;
}): DebugLogEvent {
  return {
    id: `${input.source}:${input.workspaceId}:${input.sequenceNo}:${input.fingerprint.sha256.slice(0, 12)}`,
    userId: input.userId,
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    source: input.source,
    stream: "file",
    level: "info",
    timestamp: input.fingerprint.updatedAt,
    sequenceNo: input.sequenceNo,
    payload: {
      filePath: relative(input.workspaceRoot, input.filePath),
      content: input.rawChunk,
      byteOffset: input.fingerprint.size - Buffer.byteLength(input.rawChunk, "utf8"),
      byteLength: Buffer.byteLength(input.rawChunk, "utf8"),
      checksum: input.fingerprint.sha256,
    },
  };
}

async function scanFile(
  state: DebugLogFileState,
  input: {
    workspaceRoot: string;
    workspaceId: string;
    userId: string;
    orgId: string;
    source: "agentlab" | "audit";
    filePath: string;
    sequenceNo: number;
  },
): Promise<DebugLogEvent | null> {
  if (!(await exists(input.filePath))) return null;

  const raw = await readFile(input.filePath, "utf8");
  const buffer = Buffer.from(raw, "utf8");
  const fingerprint: DebugLogFileStateEntry = {
    size: buffer.byteLength,
    sha256: sha256(buffer),
    updatedAt: Date.now(),
  };
  const previous = state.files[input.filePath];
  if (previous && previous.size === fingerprint.size && previous.sha256 === fingerprint.sha256) {
    return null;
  }

  const offset = previous && fingerprint.size > previous.size && previous.sha256 !== fingerprint.sha256
    ? previous.size
    : 0;
  const chunk = buffer.slice(offset).toString("utf8");
  state.files[input.filePath] = fingerprint;
  if (!chunk) return null;

  return buildEvent({
    workspaceRoot: input.workspaceRoot,
    workspaceId: input.workspaceId,
    userId: input.userId,
    orgId: input.orgId,
    source: input.source,
    filePath: input.filePath,
    sequenceNo: input.sequenceNo,
    rawChunk: chunk,
    fingerprint,
  });
}

export async function collectFileBackedDebugLogEvents(input: {
  workspaceRoot: string;
  workspaceId: string;
  userId: string;
  orgId: string;
}): Promise<DebugLogEvent[]> {
  const statePath = resolveDebugLogStatePath(input.workspaceId);
  const state = await readState(statePath);
  const events: DebugLogEvent[] = [];
  let sequenceNo = 0;
  let changed = false;

  const agentlabDir = resolveAgentLabLogsDir(input.workspaceRoot);
  if (await exists(agentlabDir)) {
    const entries = (await readdir(agentlabDir))
      .filter((entry) => entry.endsWith(".log"))
      .sort();
    for (const entry of entries) {
      const filePath = join(agentlabDir, entry);
      const event = await scanFile(state, {
        ...input,
        source: "agentlab",
        filePath,
        sequenceNo: sequenceNo + 1,
      });
      sequenceNo += 1;
      if (event) {
        events.push(event);
        changed = true;
      }
    }
  }

  const auditPath = resolveLegacyAuditPath(input.workspaceRoot);
  if (await exists(auditPath)) {
    const event = await scanFile(state, {
      ...input,
      source: "audit",
      filePath: auditPath,
      sequenceNo: sequenceNo + 1,
    });
    if (event) {
      events.push(event);
      changed = true;
    }
  }

  if (changed) {
    await writeState(statePath, state);
  }

  return events;
}
