import {
  normalizeSubagentRoleKey,
  type SubagentLocale,
} from "./subagent-decoration-model.js";

const SUBAGENT_DECORATIONS_SCHEMA_VERSION = 1 as const;
const SUBAGENT_DECORATIONS_TYPE = "subagent-decorations" as const;

type SubagentDecorationLocalizedName = Record<SubagentLocale, string>;

export type SubagentDecorationPersistentRole = {
  roleKey: string;
  roleLabel: string;
  firstNameByLocale: SubagentDecorationLocalizedName;
};

export type SubagentDecorationPersistentSession = {
  sessionId: string;
  workspaceId: string;
  parentSessionId: string;
  roleKey: string;
  roleLabel: string;
  color: string;
  occurrenceIndex: number;
};

export type SubagentDecorationsPersistenceV1 = {
  schemaVersion: 1;
  type: "subagent-decorations";
  roles: SubagentDecorationPersistentRole[];
  sessions: SubagentDecorationPersistentSession[];
};

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readLocalizedName(value: unknown): SubagentDecorationLocalizedName | null {
  const record = readRecord(value);
  if (!record) return null;

  const cs = normalizeLabel(record.cs);
  const en = normalizeLabel(record.en);
  if (!cs || !en) return null;
  return { cs, en };
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeOccurrenceIndex(value: unknown): number | null {
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : null;
}

function normalizePersistence(value: unknown): SubagentDecorationsPersistenceV1 | null {
  const record = readRecord(value);
  if (!record) return null;

  if (record.schemaVersion !== SUBAGENT_DECORATIONS_SCHEMA_VERSION) return null;
  if (record.type !== SUBAGENT_DECORATIONS_TYPE) return null;

  const hasRolesField = Object.prototype.hasOwnProperty.call(record, "roles");
  const hasSessionsField = Object.prototype.hasOwnProperty.call(record, "sessions");
  if (hasRolesField && !Array.isArray(record.roles)) return null;
  if (hasSessionsField && !Array.isArray(record.sessions)) return null;

  const roleList = Array.isArray(record.roles) ? record.roles : [];
  const sessionList = Array.isArray(record.sessions) ? record.sessions : [];

  const roles: SubagentDecorationPersistentRole[] = [];
  const seenRoleKeys = new Set<string>();

  for (const rawRole of roleList) {
    const roleRecord = readRecord(rawRole);
    if (!roleRecord) continue;

    const roleKey = normalizeSubagentRoleKey(roleRecord.roleKey);
    const roleLabel = normalizeLabel(roleRecord.roleLabel);
    const firstNameByLocale = readLocalizedName(roleRecord.firstNameByLocale);

    if (!roleKey || !roleLabel || !firstNameByLocale) continue;
    if (seenRoleKeys.has(roleKey)) continue;

    seenRoleKeys.add(roleKey);
    roles.push({
      roleKey,
      roleLabel,
      firstNameByLocale,
    });
  }

  if (roles.length === 0) return null;

  roles.sort((left, right) => {
    if (left.roleKey !== right.roleKey) return left.roleKey.localeCompare(right.roleKey);
    if (left.roleLabel !== right.roleLabel) return left.roleLabel.localeCompare(right.roleLabel);
    if (left.firstNameByLocale.cs !== right.firstNameByLocale.cs) {
      return left.firstNameByLocale.cs.localeCompare(right.firstNameByLocale.cs);
    }
    if (left.firstNameByLocale.en !== right.firstNameByLocale.en) {
      return left.firstNameByLocale.en.localeCompare(right.firstNameByLocale.en);
    }
    return 0;
  });

  const sessions: SubagentDecorationPersistentSession[] = [];
  const seenSessionIds = new Set<string>();
  for (const rawSession of sessionList) {
    const sessionRecord = readRecord(rawSession);
    if (!sessionRecord) continue;

    const sessionId = normalizeId(sessionRecord.sessionId);
    const workspaceId = normalizeId(sessionRecord.workspaceId);
    const parentSessionId = normalizeId(sessionRecord.parentSessionId);
    const roleKey = normalizeSubagentRoleKey(sessionRecord.roleKey);
    const roleLabel = normalizeLabel(sessionRecord.roleLabel);
    const color = normalizeColor(sessionRecord.color);
    const occurrenceIndex = normalizeOccurrenceIndex(sessionRecord.occurrenceIndex);

    if (!sessionId || !workspaceId || !parentSessionId || !roleKey || !roleLabel || !color || !occurrenceIndex) {
      continue;
    }
    if (seenSessionIds.has(sessionId)) continue;
    seenSessionIds.add(sessionId);

    sessions.push({
      sessionId,
      workspaceId,
      parentSessionId,
      roleKey,
      roleLabel,
      color,
      occurrenceIndex,
    });
  }

  sessions.sort((left, right) => {
    if (left.workspaceId !== right.workspaceId) return left.workspaceId.localeCompare(right.workspaceId);
    if (left.parentSessionId !== right.parentSessionId) {
      return left.parentSessionId.localeCompare(right.parentSessionId);
    }
    if (left.roleKey !== right.roleKey) return left.roleKey.localeCompare(right.roleKey);
    if (left.occurrenceIndex !== right.occurrenceIndex) return left.occurrenceIndex - right.occurrenceIndex;
    return left.sessionId.localeCompare(right.sessionId);
  });

  return {
    schemaVersion: SUBAGENT_DECORATIONS_SCHEMA_VERSION,
    type: SUBAGENT_DECORATIONS_TYPE,
    roles,
    sessions,
  };
}

export function emptySubagentDecorationsPersistence(): SubagentDecorationsPersistenceV1 {
  return {
    schemaVersion: SUBAGENT_DECORATIONS_SCHEMA_VERSION,
    type: SUBAGENT_DECORATIONS_TYPE,
    roles: [],
    sessions: [],
  };
}

export function parseSubagentDecorationsPersistence(raw: string | null): SubagentDecorationsPersistenceV1 | null {
  if (!raw || !raw.trim()) return null;
  try {
    return normalizePersistence(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeSubagentDecorationsPersistence(
  value: SubagentDecorationsPersistenceV1,
): string | null {
  const normalized = normalizePersistence(value);
  if (!normalized) return null;
  if (normalized.roles.length === 0 && normalized.sessions.length === 0) return null;
  return JSON.stringify(normalized);
}
