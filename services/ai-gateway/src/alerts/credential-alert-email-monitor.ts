import { createHash } from "node:crypto";

import type { AlertRecord } from "./repository.js";
import type { AuditEventRecord, AuditRepository } from "../audit/repository.js";

const EMAIL_SENT_ACTION = "credential_alert.email.sent";
const EMAIL_FAILED_ACTION = "credential_alert.email.failed";
const EMAIL_SENT_ENTITY_TYPE = "credential_alert_email";
const EMAIL_THROTTLE_ENTITY_TYPE = "credential_alert_email_throttle";
const EMAIL_DEDUPE_EVENT_LIMIT = 5000;
const DEFAULT_THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CredentialAlertRecipient = {
  userId?: string | null;
  email: string;
  name?: string | null;
};

export type CredentialAlertEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type CredentialAlertEmailMonitorDeps = {
  listAlerts: () => Promise<AlertRecord[]>;
  listPlatformAdminRecipients: () => Promise<CredentialAlertRecipient[]>;
  listFallbackRecipients: () => Promise<string[]>;
  sendEmail: (input: CredentialAlertEmailInput) => Promise<void>;
  audit: Pick<AuditRepository, "recordEvent" | "listEvents">;
  now?: () => Date;
  throttleWindowMs?: number;
  state?: { sentKeys: Set<string> };
};

export type CredentialAlertEmailMonitorResult = {
  evaluatedAlerts: number;
  emailsSent: number;
  recipients: number;
  skipped?: boolean;
};

export function createCredentialAlertEmailMonitorRunner(
  deps: CredentialAlertEmailMonitorDeps,
): () => Promise<CredentialAlertEmailMonitorResult> {
  let inFlight: Promise<CredentialAlertEmailMonitorResult> | null = null;
  const state = deps.state ?? { sentKeys: new Set<string>() };

  return () => {
    if (inFlight) {
      return Promise.resolve({ evaluatedAlerts: 0, emailsSent: 0, recipients: 0, skipped: true });
    }

    const run = runCredentialAlertEmailMonitor({ ...deps, state }).finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  };
}

export async function runCredentialAlertEmailMonitor(
  deps: CredentialAlertEmailMonitorDeps,
): Promise<CredentialAlertEmailMonitorResult> {
  const now = deps.now?.() ?? new Date();
  const alerts = (await deps.listAlerts()).filter(shouldEmailCredentialAlert);
  const recipients = await resolveRecipients(deps);

  if (alerts.length === 0 || recipients.length === 0) {
    return { evaluatedAlerts: alerts.length, emailsSent: 0, recipients: recipients.length };
  }

  const sentKeys = await listAlreadySentKeys(deps.audit, now, deps.throttleWindowMs ?? DEFAULT_THROTTLE_WINDOW_MS);
  for (const key of deps.state?.sentKeys ?? []) sentKeys.add(key);

  let emailsSent = 0;
  const failures: Error[] = [];

  for (const alert of alerts) {
    const email = buildCredentialAlertEmail(alert);
    for (const recipient of recipients) {
      const alertKey = buildAlertRecipientKey(alert.id, recipient.email);
      const throttleKey = buildThrottleKey(alert, recipient.email);
      if (sentKeys.has(alertKey) || sentKeys.has(throttleKey)) continue;

      try {
        await deps.sendEmail({ to: recipient.email, ...email });
        emailsSent += 1;
        sentKeys.add(alertKey);
        sentKeys.add(throttleKey);
        deps.state?.sentKeys.add(alertKey);
        deps.state?.sentKeys.add(throttleKey);
        await recordSent(deps.audit, alert, recipient.email, alertKey, throttleKey);
      } catch (error) {
        failures.push(toError(error));
        await recordFailedBestEffort(deps.audit, alert, recipient.email, alertKey, error);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to send ${failures.length} credential alert email${failures.length === 1 ? "" : "s"}: ${failures.map((error) => error.message).join("; ")}`);
  }

  return { evaluatedAlerts: alerts.length, emailsSent, recipients: recipients.length };
}

export function shouldEmailCredentialAlert(alert: AlertRecord): boolean {
  if (alert.status !== "active") return false;
  if (alert.source === "codex-capacity" || alert.source === "codex-capacity-visibility") return false;
  if (alert.credentialId) return true;
  return [
    "credential-health",
    "provider-auth",
    "provider-rate-limit",
    "gateway-operations",
    "provider-availability",
  ].includes(alert.source);
}

export function buildCredentialAlertEmail(alert: AlertRecord) {
  const severity = alert.severity.toUpperCase();
  const subject = `[${severity}] Veslo credential alert: ${alert.title}`;
  const reason = readAlertReason(alert);
  const lines = [
    alert.title,
    "",
    `Severity: ${alert.severity}`,
    `Source: ${alert.source}`,
    `Credential: ${alert.credentialId ?? "credential pool"}`,
    reason ? `Reason: ${reason}` : null,
    `First seen: ${alert.firstSeenAt}`,
    `Last seen: ${alert.lastSeenAt}`,
    "",
    alert.runbook,
  ].filter((line): line is string => typeof line === "string");

  const text = lines.join("\n");
  return {
    subject,
    text,
    html: text.split("\n").map((line) => line ? `<p>${escapeHtml(line)}</p>` : "<br>").join(""),
  };
}

async function resolveRecipients(deps: CredentialAlertEmailMonitorDeps): Promise<CredentialAlertRecipient[]> {
  try {
    const platform = uniqueRecipients(await deps.listPlatformAdminRecipients());
    if (platform.length > 0) return platform;
  } catch (error) {
    console.error("credential_alert_platform_admin_recipient_lookup_failed", error);
  }

  return uniqueRecipients((await deps.listFallbackRecipients()).map((email) => ({ email })));
}

async function listAlreadySentKeys(
  audit: Pick<AuditRepository, "listEvents">,
  now: Date,
  throttleWindowMs: number,
): Promise<Set<string>> {
  if (!audit.listEvents) return new Set();
  const minimumTimestampMs = now.getTime() - throttleWindowMs;
  const events = await audit.listEvents({ limit: EMAIL_DEDUPE_EVENT_LIMIT });
  return new Set(
    events
      .filter((event) => event.action === EMAIL_SENT_ACTION)
      .filter((event) => event.entityType === EMAIL_SENT_ENTITY_TYPE || event.entityType === EMAIL_THROTTLE_ENTITY_TYPE)
      .filter((event) => isRecentEvent(event, minimumTimestampMs))
      .map((event) => event.entityId),
  );
}

async function recordSent(
  audit: Pick<AuditRepository, "recordEvent">,
  alert: AlertRecord,
  recipient: string,
  alertKey: string,
  throttleKey: string,
) {
  await audit.recordEvent({
    actorUserId: "system",
    entityType: EMAIL_SENT_ENTITY_TYPE,
    entityId: alertKey,
    action: EMAIL_SENT_ACTION,
    result: "ok",
    summary: `Sent ${alert.title} credential alert email to ${recipient}.`,
  });
  await audit.recordEvent({
    actorUserId: "system",
    entityType: EMAIL_THROTTLE_ENTITY_TYPE,
    entityId: throttleKey,
    action: EMAIL_SENT_ACTION,
    result: "ok",
    summary: `Recorded ${alert.title} credential alert throttle for ${recipient}.`,
  });
}

async function recordFailedBestEffort(
  audit: Pick<AuditRepository, "recordEvent">,
  alert: AlertRecord,
  recipient: string,
  alertKey: string,
  error: unknown,
) {
  try {
    await audit.recordEvent({
      actorUserId: "system",
      entityType: EMAIL_SENT_ENTITY_TYPE,
      entityId: alertKey,
      action: EMAIL_FAILED_ACTION,
      result: "error",
      summary: `Failed to send ${alert.title} credential alert email to ${recipient}: ${toError(error).message}`,
    });
  } catch {
    return;
  }
}

function uniqueRecipients(input: CredentialAlertRecipient[]): CredentialAlertRecipient[] {
  const seen = new Set<string>();
  const recipients: CredentialAlertRecipient[] = [];
  for (const entry of input) {
    const email = entry.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    recipients.push({ ...entry, email });
  }
  return recipients;
}

function buildAlertRecipientKey(alertId: string, recipient: string) {
  return `alert:${alertId}:${hashRecipient(recipient)}`;
}

function buildThrottleKey(alert: AlertRecord, recipient: string) {
  const credentialKey = alert.credentialId ?? "credential-pool";
  return `credential:${credentialKey}:${hashText(normalizeReason(readAlertReason(alert) ?? alert.title))}:${hashRecipient(recipient)}`;
}

function readAlertReason(alert: AlertRecord): string | null {
  const reason = (alert as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

function normalizeReason(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashRecipient(value: string) {
  return hashText(value.trim().toLowerCase()).slice(0, 20);
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecentEvent(event: AuditEventRecord, minimumTimestampMs: number) {
  const timestampMs = Date.parse(event.timestamp);
  return Number.isFinite(timestampMs) && timestampMs >= minimumTimestampMs;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
