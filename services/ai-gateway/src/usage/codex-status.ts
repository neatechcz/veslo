export type CodexUsageStatusSource = "codex_status" | "codex_login_status" | "unavailable";

export type CodexUsageStatus = {
  available: boolean;
  source: CodexUsageStatusSource;
  label: string;
  detail?: string | null;
  checkedAt?: string | null;
};

export type CodexCredentialStatusInput = {
  credentialId: string;
  credentialName: string;
};

export interface CodexCredentialStatusProvider {
  getStatus(input: CodexCredentialStatusInput): Promise<CodexUsageStatus>;
}

export class UnavailableCodexCredentialStatusProvider implements CodexCredentialStatusProvider {
  async getStatus(): Promise<CodexUsageStatus> {
    return {
      available: false,
      source: "unavailable",
      label: "Codex limits unavailable",
      detail: "Codex status probe is not configured.",
    };
  }
}

export function parseCodexStatusText(
  text: string,
  checkedAt: string,
): CodexUsageStatus {
  const normalized = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const limitLine = normalized.find((line) => /limit|remaining|reset|usage/i.test(line));

  return {
    available: true,
    source: "codex_status",
    label: limitLine || normalized[0] || "Codex status available",
    detail: normalized.length > 0 ? normalized.slice(0, 6).join(" | ") : null,
    checkedAt,
  };
}
