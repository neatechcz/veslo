import type { AdminCredentialRecord, ListAdminCredentialsInput } from "../credentials/repository.js";
import { CODEX_OAUTH_PROVIDER } from "../providers/ids.js";
import {
  evaluateCodexCredentialEligibility,
  isCodexPermanentCredentialFailureStatusText,
} from "../usage/codex-eligibility.js";
import type { CodexCredentialStatusProvider, CodexUsageStatus } from "../usage/codex-status.js";
import { assertValidCodexModelId } from "./codex-model-migration.js";

export type CodexCredentialProbeOutcome =
  | "ok"
  | "unsupported_model"
  | "usage_exhausted"
  | "auth_failed"
  | "probe_failed";

export type CodexCredentialProbeResult = {
  credentialId: string;
  displayName: string;
  storedHealth: AdminCredentialRecord["state"];
  outcome: CodexCredentialProbeOutcome;
  statusLabel: string;
  elapsedMs: number;
};

export interface CodexCredentialProbeRepository {
  listAdminCredentials(input?: ListAdminCredentialsInput): Promise<AdminCredentialRecord[]>;
}

export async function runCodexCredentialProbe(input: {
  repository: CodexCredentialProbeRepository;
  statusProvider: CodexCredentialStatusProvider;
  model: string;
  now?: () => Date;
}): Promise<CodexCredentialProbeResult[]> {
  assertValidCodexModelId(input.model);
  const now = input.now ?? (() => new Date());
  const credentials = (await input.repository.listAdminCredentials({ includeDeleted: true }))
    .filter((credential) => credential.provider === CODEX_OAUTH_PROVIDER && !credential.deletedAt)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const results: CodexCredentialProbeResult[] = [];

  for (const credential of credentials) {
    const startedAt = now().getTime();
    let outcome: CodexCredentialProbeOutcome = "probe_failed";

    try {
      const status = await input.statusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name,
      });
      outcome = classifyProbeStatus(status, input.model, now());
    } catch {
      outcome = "probe_failed";
    }

    results.push({
      credentialId: credential.id,
      displayName: credential.name,
      storedHealth: credential.state,
      outcome,
      statusLabel: safeStatusLabel(outcome),
      elapsedMs: Math.max(0, now().getTime() - startedAt),
    });
  }

  return results;
}

function classifyProbeStatus(
  status: CodexUsageStatus,
  model: string,
  now: Date,
): CodexCredentialProbeOutcome {
  if (status.unsupportedModels?.includes(model)) {
    return "unsupported_model";
  }

  const eligibility = evaluateCodexCredentialEligibility(status, now);
  if (eligibility.state === "exhausted") {
    return "usage_exhausted";
  }
  if (isAuthenticationFailure(status)) {
    return "auth_failed";
  }
  if (eligibility.state === "unavailable") {
    return "probe_failed";
  }
  return status.probeSucceeded === true ? "ok" : "probe_failed";
}

function isAuthenticationFailure(status: CodexUsageStatus): boolean {
  const statusText = [status.label, status.detail].filter(Boolean).join(" | ");
  return isCodexPermanentCredentialFailureStatusText(statusText);
}

function safeStatusLabel(outcome: CodexCredentialProbeOutcome): string {
  switch (outcome) {
    case "ok":
      return "Codex probe succeeded";
    case "unsupported_model":
      return "Requested model unsupported";
    case "usage_exhausted":
      return "Codex usage exhausted";
    case "auth_failed":
      return "Codex authentication failed";
    case "probe_failed":
      return "Codex probe failed";
  }
}
