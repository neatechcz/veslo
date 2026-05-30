const readString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

const parseJsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

type ManagedAiFailure = {
  provider: string | null;
  reason: string | null;
};

const managedCodexFailureCodes = ["no_eligible_codex_credentials", "assigned_credential_unavailable"] as const;

const isManagedCodexFailureCode = (value: string | null) =>
  managedCodexFailureCodes.some((code) => value === code);

const detectManagedAiFailure = (
  value: unknown,
  depth = 0,
  inherited: ManagedAiFailure = { provider: null, reason: null },
): ManagedAiFailure | null => {
  if (depth > 8 || value === null || value === undefined) return null;

  if (typeof value === "string") {
    const parsed = parseJsonValue(value);
    if (parsed !== null) return detectManagedAiFailure(parsed, depth + 1, inherited);
    if (managedCodexFailureCodes.some((code) => value.includes(code))) {
      return inherited;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const provider = readString(record.provider) ?? inherited.provider;
  const reason = readString(record.reason) ?? inherited.reason;
  const code = readString(record.error) ?? readString(record.code) ?? readString(record.errorCode);
  const current = { provider, reason };

  if (code === "no_eligible_codex_credentials" || code === "assigned_credential_unavailable") {
    return current;
  }

  for (const key of ["details", "data", "cause", "responseBody", "body", "response", "upstreamResponse"]) {
    const detected = detectManagedAiFailure(record[key], depth + 1, current);
    if (detected) return detected;
  }

  if (isManagedCodexFailureCode(code) && provider === "codex_oauth") {
    return current;
  }

  return null;
};

export const formatManagedAiAccessError = (error: unknown): string | null => {
  const detected = detectManagedAiFailure(error);
  if (!detected) return null;

  const reason = detected.reason;
  const guidance = (() => {
    if (reason === "all_codex_credentials_exhausted") {
      return "All managed Codex credentials are currently exhausted. Wait for quota to reset or ask an admin to assign a healthy credential, then retry.";
    }
    if (reason === "assigned_credential_unavailable") {
      return "Your assigned Codex credential is unavailable. Ask an admin to refresh or reassign Codex AI access, then retry.";
    }
    return "No eligible Codex credential is available for your account. Ask an admin to assign or refresh Codex AI access, then retry.";
  })();

  const lines = ["AI access unavailable", guidance];
  if (detected.provider) lines.push(`Provider: ${detected.provider}`);
  if (reason) lines.push(`Reason: ${reason}`);
  return lines.join("\n");
};
