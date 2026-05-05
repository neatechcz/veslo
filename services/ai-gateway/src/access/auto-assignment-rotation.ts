import type { AuditRepository } from "../audit/repository.js";
import type { CredentialRepository } from "../credentials/repository.js";
import { evaluateCodexCredentialEligibility } from "../usage/codex-eligibility.js";
import type { CodexCredentialStatusProvider } from "../usage/codex-status.js";
import type { AiAccessRepository, UserAiAccessPolicyRecord } from "./repository.js";

export type AutoAssignedCodexCredentialRotationService = {
  repairCodexAccess(input: {
    aiAccess: UserAiAccessPolicyRecord;
    reason?: string;
  }): Promise<UserAiAccessPolicyRecord>;
};

export type AutoAssignedCodexCredentialRotationDependencies = {
  aiAccess: AiAccessRepository;
  credentials: CredentialRepository;
  codexStatusProvider: CodexCredentialStatusProvider;
  audit?: Pick<AuditRepository, "recordEvent">;
  now?: () => Date;
};

type RotationCandidate = {
  credentialId: string;
  name: string;
  activeLeases: number;
};

export function createAutoAssignedCodexCredentialRotationService(
  deps: AutoAssignedCodexCredentialRotationDependencies,
): AutoAssignedCodexCredentialRotationService {
  const now = deps.now ?? (() => new Date());

  return {
    async repairCodexAccess(input) {
      const aiAccess = input.aiAccess;
      const currentCredentialId = aiAccess.credentialId?.trim() ?? "";
      if (
        !aiAccess.enabled ||
        aiAccess.provider !== "codex_oauth" ||
        aiAccess.assignmentOrigin !== "auto_assigned" ||
        !currentCredentialId
      ) {
        return aiAccess;
      }

      const shouldRotate = await shouldRotateCurrentCredential(currentCredentialId);
      if (!shouldRotate) {
        return aiAccess;
      }

      const replacement = await selectReplacementCredential(currentCredentialId);
      if (!replacement) {
        return aiAccess;
      }

      const repaired = await deps.aiAccess.upsertUserAiAccess({
        userId: aiAccess.userId,
        enabled: aiAccess.enabled,
        provider: "codex_oauth",
        credentialId: replacement.credentialId,
        defaultModel: aiAccess.defaultModel,
        allowedModels: aiAccess.allowedModels,
        assignmentOrigin: "auto_assigned",
      });

      await recordRotationAudit({
        userId: aiAccess.userId,
        previousCredentialId: currentCredentialId,
        nextCredentialId: replacement.credentialId,
        reason: input.reason,
      });

      return repaired;
    },
  };

  async function shouldRotateCurrentCredential(credentialId: string): Promise<boolean> {
    const credential = await deps.credentials.getCredentialRecordById(credentialId);
    if (!credential || credential.provider !== "codex_oauth") {
      return true;
    }

    if (credential.state !== "healthy") {
      return true;
    }

    try {
      const status = await deps.codexStatusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name ?? credential.id,
      });
      return !evaluateCodexCredentialEligibility(status, now()).eligible;
    } catch {
      return false;
    }
  }

  async function selectReplacementCredential(excludedCredentialId: string): Promise<RotationCandidate | null> {
    const listAdminCredentials = deps.credentials.listAdminCredentials;
    if (!listAdminCredentials) {
      return null;
    }

    const credentials = await listAdminCredentials.call(deps.credentials);
    const eligible: RotationCandidate[] = [];

    for (const credential of credentials) {
      if (
        credential.id === excludedCredentialId ||
        credential.provider !== "codex_oauth" ||
        credential.state !== "healthy"
      ) {
        continue;
      }

      try {
        const status = await deps.codexStatusProvider.getStatus({
          credentialId: credential.id,
          credentialName: credential.name,
        });
        if (!evaluateCodexCredentialEligibility(status, now()).eligible) {
          continue;
        }
      } catch {
        continue;
      }

      eligible.push({
        credentialId: credential.id,
        name: credential.name,
        activeLeases: credential.activeLeases,
      });
    }

    eligible.sort((left, right) => {
      const leaseDelta = left.activeLeases - right.activeLeases;
      if (leaseDelta !== 0) {
        return leaseDelta;
      }

      const nameDelta = left.name.localeCompare(right.name);
      if (nameDelta !== 0) {
        return nameDelta;
      }

      return left.credentialId.localeCompare(right.credentialId);
    });

    return eligible[0] ?? null;
  }

  async function recordRotationAudit(input: {
    userId: string;
    previousCredentialId: string;
    nextCredentialId: string;
    reason?: string;
  }) {
    try {
      await deps.audit?.recordEvent({
        actorUserId: null,
        entityType: "user",
        entityId: input.userId,
        action: "user.ai_access.auto_rotate",
        result: "ok",
        summary: `Rotated auto-assigned Codex credential for user ${input.userId} from ${input.previousCredentialId} to ${input.nextCredentialId}.`,
      });
    } catch {
      return;
    }
  }
}
