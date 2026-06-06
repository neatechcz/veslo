import type { CredentialState } from "../db/schema.js";
import type { CodexUsageStatus } from "./codex-status.js";

export type CodexCapacityCredential = {
  id: string;
  name: string;
  state: CredentialState | null;
  upstreamStatus: CodexUsageStatus | null;
};

export type CodexCapacityWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  measurableCredentials: number;
};

export type CodexCapacityCredentialRecord = {
  id: string;
  name: string;
  state: CredentialState | null;
  fiveHourRemainingPercent: number | null;
  weeklyRemainingPercent: number | null;
  statusAvailable: boolean;
  limitsAvailable: boolean;
};

export type CodexCapacityOverview = {
  codexCredentials: {
    total: number;
    measurable: number;
    unavailable: number;
  };
  fiveHour: CodexCapacityWindow;
  weekly: CodexCapacityWindow;
  credentials: CodexCapacityCredentialRecord[];
};

export function buildCodexCapacityOverview(credentials: CodexCapacityCredential[]): CodexCapacityOverview {
  const codexCredentials = credentials.filter((credential) => credential.state === "healthy" && credential.upstreamStatus !== null);
  const records = codexCredentials.map(toCapacityCredentialRecord);
  const measurable = records.filter((record) => record.limitsAvailable).length;

  return {
    codexCredentials: {
      total: codexCredentials.length,
      measurable,
      unavailable: codexCredentials.length - measurable,
    },
    fiveHour: summarizeWindow(records, "fiveHourRemainingPercent"),
    weekly: summarizeWindow(records, "weeklyRemainingPercent"),
    credentials: records,
  };
}

function toCapacityCredentialRecord(credential: CodexCapacityCredential): CodexCapacityCredentialRecord {
  const status = credential.upstreamStatus;
  const fiveHourUsed = readUsedPercent(status?.limits?.fiveHour?.usedPercent);
  const weeklyUsed = readUsedPercent(status?.limits?.weekly?.usedPercent);

  return {
    id: credential.id,
    name: credential.name,
    state: credential.state,
    fiveHourRemainingPercent: toRemainingPercent(fiveHourUsed),
    weeklyRemainingPercent: toRemainingPercent(weeklyUsed),
    statusAvailable: status?.available === true,
    limitsAvailable: fiveHourUsed !== null || weeklyUsed !== null,
  };
}

function summarizeWindow(
  records: CodexCapacityCredentialRecord[],
  key: "fiveHourRemainingPercent" | "weeklyRemainingPercent",
): CodexCapacityWindow {
  const values = records
    .map((record) => record[key])
    .filter((value): value is number => typeof value === "number");

  if (values.length === 0) {
    return {
      usedPercent: null,
      remainingPercent: null,
      measurableCredentials: 0,
    };
  }

  const remainingPercent = roundPercent(values.reduce((sum, value) => sum + value, 0) / values.length);
  return {
    usedPercent: roundPercent(100 - remainingPercent),
    remainingPercent,
    measurableCredentials: values.length,
  };
}

function readUsedPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? clampPercent(value)
    : null;
}

function toRemainingPercent(usedPercent: number | null): number | null {
  return usedPercent === null ? null : roundPercent(100 - usedPercent);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}
