import type { CodexCapacityOverview, CodexCapacityWindow } from "../usage/codex-capacity.js";
import type { AlertRecord } from "./repository.js";

const CODEX_CAPACITY_THRESHOLDS = [100, 95, 90, 80] as const;

type CodexCapacityThreshold = (typeof CODEX_CAPACITY_THRESHOLDS)[number];
type CodexCapacityWindowKey = "fiveHour" | "weekly";

export type CodexCapacityAlertEmail = {
  subject: string;
  html: string;
  text: string;
};

export function buildCodexCapacityAlerts(
  capacity: CodexCapacityOverview,
  now: string | Date = new Date(),
): AlertRecord[] {
  const timestamp = toIsoString(now);
  if (capacity.codexCredentials.total > 0 && capacity.codexCredentials.measurable === 0) {
    return [buildLimitVisibilityAlert(capacity, timestamp)];
  }

  const alerts: AlertRecord[] = [];
  for (const key of ["fiveHour", "weekly"] as const) {
    const threshold = highestCrossedThreshold(capacity[key]);
    if (!threshold) {
      continue;
    }
    alerts.push(buildThresholdAlert(capacity, key, threshold, timestamp));
  }
  return alerts;
}

export function shouldEmailCodexCapacityAlert(alert: AlertRecord): boolean {
  if (alert.source === "codex-capacity-visibility") {
    return true;
  }
  const threshold = readAlertThreshold(alert);
  return threshold === 95 || threshold === 100;
}

export function buildCodexCapacityAlertEmail(
  alert: AlertRecord,
  capacity: CodexCapacityOverview,
): CodexCapacityAlertEmail {
  const prefix = alert.id.endsWith("_95") ? "[URGENT]" : "[CRITICAL]";
  const subject = `${prefix} ${alert.title}`;
  const credentialLines = capacity.credentials.length > 0
    ? capacity.credentials.map((credential) => `- ${formatCredentialCapacity(credential)}`)
    : ["- No functional Codex credentials are reporting capacity."];
  const summary = `Functional Codex credentials: ${capacity.codexCredentials.total} total, ${capacity.codexCredentials.measurable} measured, ${capacity.codexCredentials.unknown} unknown, ${capacity.codexCredentials.unavailable} unavailable.`;
  const text = [
    alert.title,
    "",
    summary,
    `5h: ${formatWindow(capacity.fiveHour)}.`,
    `Weekly: ${formatWindow(capacity.weekly)}.`,
    "",
    "Credential capacities:",
    ...credentialLines,
    "",
    alert.runbook,
  ].join("\n");

  return {
    subject,
    text,
    html: text
      .split("\n")
      .map((line) => line ? `<p>${escapeHtml(line)}</p>` : "<br>")
      .join(""),
  };
}

function buildLimitVisibilityAlert(capacity: CodexCapacityOverview, timestamp: string): AlertRecord {
  return {
    id: "alert_codex_capacity_limits_unavailable",
    title: "Codex limit visibility unavailable",
    severity: "critical",
    source: "codex-capacity-visibility",
    status: "active",
    credentialId: null,
    affectedSessions: 0,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    owner: null,
    runbook: [
      "The server cannot see Codex limits for any functional Codex credential.",
      credentialInventorySummary(capacity),
      "Check Codex auth.json access, Codex CLI status probing, and server egress before new requests exhaust the pool silently.",
    ].join(" "),
  };
}

function buildThresholdAlert(
  capacity: CodexCapacityOverview,
  key: CodexCapacityWindowKey,
  threshold: CodexCapacityThreshold,
  timestamp: string,
): AlertRecord {
  const label = key === "fiveHour" ? "5h" : "weekly";
  return {
    id: `alert_codex_capacity_${key === "fiveHour" ? "five_hour" : "weekly"}_${threshold}`,
    title: threshold === 100
      ? `Codex ${label} limit capacity exhausted`
      : `Codex ${label} limit capacity at ${threshold}%`,
    severity: threshold >= 95 ? "critical" : threshold >= 90 ? "high" : "medium",
    source: "codex-capacity",
    status: "active",
    credentialId: null,
    affectedSessions: 0,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    owner: null,
    runbook: [
      `Functional Codex credentials: ${capacity.codexCredentials.total}.`,
      `${label} usage is ${formatPercent(capacity[key].usedPercent)} used across ${capacity[key].measurableCredentials} measured credential${capacity[key].measurableCredentials === 1 ? "" : "s"}.`,
      credentialInventorySummary(capacity),
    ].join(" "),
  };
}

function highestCrossedThreshold(window: CodexCapacityWindow): CodexCapacityThreshold | null {
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== "number") {
    return null;
  }
  return CODEX_CAPACITY_THRESHOLDS.find((threshold) => usedPercent >= threshold) ?? null;
}

function readAlertThreshold(alert: AlertRecord): CodexCapacityThreshold | null {
  const raw = alert.id.match(/_(100|95|90|80)$/)?.[1];
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return CODEX_CAPACITY_THRESHOLDS.includes(parsed as CodexCapacityThreshold)
    ? parsed as CodexCapacityThreshold
    : null;
}

function credentialInventorySummary(capacity: CodexCapacityOverview): string {
  if (capacity.credentials.length === 0) {
    return "Credential capacities: none.";
  }
  return `Credential capacities: ${capacity.credentials.map(formatCredentialCapacity).join("; ")}.`;
}

function formatCredentialCapacity(credential: CodexCapacityOverview["credentials"][number]): string {
  const visibility = credential.limitsAvailable
    ? "limits visible"
    : credential.statusAvailable ? "limits unknown" : "status unavailable";
  return `${credential.name || credential.id}: 5h ${formatRemaining(credential.fiveHourRemainingPercent)}, weekly ${formatRemaining(credential.weeklyRemainingPercent)} (${visibility})`;
}

function formatWindow(window: CodexCapacityWindow): string {
  if (typeof window.usedPercent !== "number") {
    return "unknown";
  }
  return `${formatPercent(window.usedPercent)} used, ${formatPercent(window.remainingPercent)} remaining`;
}

function formatRemaining(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}% remaining` : "unknown";
}

function formatPercent(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "unknown";
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
