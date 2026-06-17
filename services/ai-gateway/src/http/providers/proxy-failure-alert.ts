import type { AlertRepository } from "../../alerts/repository.js";
import type { CredentialRepository } from "../../credentials/repository.js";

export type ProviderProxyFailureAlertInput = {
  alertRepository?: AlertRepository;
  credentials?: Pick<CredentialRepository, "getCredentialRecordByBindingId">;
  credentialId?: string | null;
  bindingId?: string | null;
  provider: string;
  sessionId: string;
  error: unknown;
};

export async function recordProviderProxyFailureAlert(input: ProviderProxyFailureAlertInput): Promise<void> {
  const reason = classifyProviderProxyFailure(input.error);
  if (!reason || !input.alertRepository?.recordProviderFailure) {
    return;
  }

  const credentialId = input.credentialId ?? (await resolveCredentialId(input.credentials, input.bindingId));
  if (!credentialId) {
    return;
  }

  await input.alertRepository.recordProviderFailure({
    credentialId,
    provider: input.provider,
    sessionId: input.sessionId,
    reason,
  });
}

export function classifyProviderProxyFailure(error: unknown): string | null {
  const detail = readErrorDetail(error);
  if (!detail) {
    return null;
  }

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

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function getString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
