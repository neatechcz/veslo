import type { AlertRepository } from "../../alerts/repository.js";
import type { CredentialRepository } from "../../credentials/repository.js";
import type { CredentialState } from "../../db/schema.js";

export type ProviderProxyFailureAlertInput = {
  alertRepository?: AlertRepository;
  credentials?: Pick<CredentialRepository, "getCredentialRecordByBindingId">;
  credentialId?: string | null;
  bindingId?: string | null;
  provider: string;
  sessionId: string;
  error: unknown;
};

export type ProviderCredentialFailureAlertInput = {
  alertRepository?: AlertRepository;
  credentialId?: string | null;
  provider: string;
  sessionId: string;
  reason: string;
};

export type MarkProviderCredentialFailureInput = {
  credentials?: Pick<CredentialRepository, "getCredentialRecordByBindingId" | "markCredentialState">;
  bindingId?: string | null;
  reason: string;
  state?: CredentialState;
};

export async function recordProviderProxyFailureAlert(input: ProviderProxyFailureAlertInput): Promise<void> {
  const reason = classifyProviderProxyFailure(input.error);
  if (!reason) {
    return;
  }

  const credentialId = input.credentialId ?? (await resolveCredentialId(input.credentials, input.bindingId));
  await recordProviderCredentialFailureAlert({
    alertRepository: input.alertRepository,
    credentialId,
    provider: input.provider,
    sessionId: input.sessionId,
    reason,
  });
}

export async function recordProviderCredentialFailureAlert(
  input: ProviderCredentialFailureAlertInput,
): Promise<void> {
  if (!input.alertRepository?.recordProviderFailure) {
    return;
  }

  const credentialId = input.credentialId;
  if (!credentialId) {
    return;
  }

  try {
    await input.alertRepository.recordProviderFailure({
      credentialId,
      provider: input.provider,
      sessionId: input.sessionId,
      reason: input.reason,
    });
  } catch (error) {
    console.error("provider_credential_alert_record_failed", error);
  }
}

export async function markProviderCredentialFailure(input: MarkProviderCredentialFailureInput): Promise<void> {
  if (!input.credentials?.markCredentialState || !input.credentials.getCredentialRecordByBindingId || !input.bindingId) {
    return;
  }

  try {
    const credential = await input.credentials.getCredentialRecordByBindingId(input.bindingId);
    if (!credential) {
      return;
    }

    await input.credentials.markCredentialState({
      credentialRecordId: credential.id,
      state: input.state ?? credentialFailureState(input.reason),
      reason: input.reason,
    });
  } catch (error) {
    console.error("provider_credential_failure_mark_failed", error);
  }
}

export function readUpstreamFailureReason(input: {
  kind?: string;
  statusCode?: number;
  code?: string;
}): string {
  return normalizeFailureCode(input.code) ?? input.kind ?? (input.statusCode ? `http_${input.statusCode}` : "upstream_failure");
}

export function classifyProviderProxyFailure(error: unknown): string | null {
  const detail = readErrorDetail(error);
  if (!detail) {
    return null;
  }

  const statusCode = readStatusCode(error);
  const code = normalizeFailureCode(readFailureCode(error));

  if (/(und_err_connect_timeout|connect timeout|etimedout|timeout)/i.test(detail)) {
    return "network_connect_timeout";
  }

  if (/(enotfound|eai_again|dns)/i.test(detail)) {
    return "network_dns_failure";
  }

  if (/(econnreset|econnrefused|epipe|socket hang up)/i.test(detail)) {
    return "network_connection_failed";
  }

  if (/fetch failed/i.test(detail)) {
    return "network_fetch_failed";
  }

  if (code && isAuthReason(code)) {
    return code;
  }

  if (statusCode === 401 || statusCode === 403) {
    return "authentication_error";
  }

  if (code && isRateLimitReason(code)) {
    return code;
  }

  if (statusCode === 429) {
    return "rate_limit_exceeded";
  }

  if (statusCode && statusCode >= 500) {
    return code ?? "upstream_5xx";
  }

  return null;
}

async function resolveCredentialId(
  credentials: Pick<CredentialRepository, "getCredentialRecordByBindingId"> | undefined,
  bindingId: string | null | undefined,
): Promise<string | null> {
  if (!credentials?.getCredentialRecordByBindingId || !bindingId) {
    return null;
  }

  try {
    return (await credentials.getCredentialRecordByBindingId(bindingId))?.id ?? null;
  } catch {
    return null;
  }
}

function readErrorDetail(error: unknown): string {
  const record = getRecord(error);
  const cause = getRecord(record?.cause);
  return [
    getString(record, "name"),
    getString(record, "message"),
    getString(record, "code"),
    getString(cause, "name"),
    getString(cause, "message"),
    getString(cause, "code"),
  ]
    .filter(Boolean)
    .join(" ");
}

function readFailureCode(error: unknown): string | null {
  const record = getRecord(error);
  const cause = getRecord(record?.cause);
  return getString(record, "code") ?? getString(cause, "code");
}

function readStatusCode(error: unknown): number | null {
  const record = getRecord(error);
  const cause = getRecord(record?.cause);
  return getNumber(record, "statusCode") ?? getNumber(cause, "statusCode");
}

function normalizeFailureCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  return normalized || null;
}

function credentialFailureState(reason: string): CredentialState {
  return isRateLimitReason(reason) ? "degraded" : "unhealthy";
}

function isAuthReason(reason: string): boolean {
  return (
    reason.includes("invalid_grant") ||
    reason.includes("revoked_token") ||
    reason.includes("invalid_api_key") ||
    reason.includes("authentication_error") ||
    reason.includes("auth")
  );
}

function isRateLimitReason(reason: string): boolean {
  return (
    reason.includes("rate_limit") ||
    reason.includes("quota") ||
    reason.includes("insufficient_quota")
  );
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function getString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
