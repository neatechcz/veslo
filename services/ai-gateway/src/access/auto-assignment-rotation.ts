import type { AuditRepository } from "../audit/repository.js";
import type { CredentialRepository } from "../credentials/repository.js";
import { evaluateCodexCredentialEligibility } from "../usage/codex-eligibility.js";
import type { CodexCredentialStatusProvider } from "../usage/codex-status.js";
import { codexStatusSupportsModel } from "../model-policy/capability-verifier.js";
import type { PlatformModelRef } from "../model-policy/repository.js";
import type { AiAccessRepository, UserAiAccessPolicyRecord } from "./repository.js";

export type AutoAssignedCodexCredentialRotationService = {
  repairCodexAccess(input: {
    aiAccess: UserAiAccessPolicyRecord;
    activeModel: PlatformModelRef;
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

type CurrentCredentialAssessment = {
  shouldRotate: boolean;
  supportsActiveModel: boolean | null;
  unavailable: boolean;
};

type ReplacementAssessment = {
  replacement: RotationCandidate | null;
  hasCompatibleCredential: boolean;
  hasTransientFailure: boolean;
};

export class AssignedCredentialModelIncompatibleError extends Error {
  constructor() {
    super("assigned_credential_model_incompatible");
    this.name = "AssignedCredentialModelIncompatibleError";
  }
}

export class AssignedCredentialUnavailableError extends Error {
  constructor() {
    super("assigned_credential_unavailable");
    this.name = "AssignedCredentialUnavailableError";
  }
}

export class AssignedCredentialActiveModelRequiredError extends Error {
  constructor() {
    super("assigned_credential_active_model_required");
    this.name = "AssignedCredentialActiveModelRequiredError";
  }
}

export function createAutoAssignedCodexCredentialRotationService(
  deps: AutoAssignedCodexCredentialRotationDependencies,
): AutoAssignedCodexCredentialRotationService {
  const now = deps.now ?? (() => new Date());

  return {
    async repairCodexAccess(input) {
      if (!input.activeModel?.provider || !input.activeModel.model?.trim()) {
        throw new AssignedCredentialActiveModelRequiredError();
      }
      const aiAccess = input.aiAccess;
      const currentCredentialId = aiAccess.credentialId?.trim() ?? "";
      if (
        !aiAccess.enabled ||
        aiAccess.provider !== "codex_oauth" ||
        !currentCredentialId
      ) {
        return aiAccess;
      }

      if (input.activeModel.provider !== "codex_oauth") {
        throw new AssignedCredentialModelIncompatibleError();
      }

      const current = await assessCurrentCredential(currentCredentialId, input.activeModel);
      if (!current.shouldRotate) {
        return aiAccess;
      }

      const replacements = await assessReplacementCredentials(currentCredentialId, input.activeModel);
      const replacement = replacements.replacement;
      if (!replacement) {
        if (current.unavailable) return aiAccess;
        if (current.supportsActiveModel === true) return aiAccess;
        if (replacements.hasCompatibleCredential) {
          throw new Error("no_eligible_codex_credentials:all_codex_credentials_exhausted");
        }
        if (replacements.hasTransientFailure) throw new AssignedCredentialUnavailableError();
        throw new AssignedCredentialModelIncompatibleError();
      }
      const repaired = await deps.aiAccess.upsertUserAiAccess({
        userId: aiAccess.userId,
        enabled: aiAccess.enabled,
        provider: "codex_oauth",
        credentialId: replacement.credentialId,
        assignmentOrigin: aiAccess.assignmentOrigin,
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

  async function assessCurrentCredential(
    credentialId: string,
    activeModel: PlatformModelRef,
  ): Promise<CurrentCredentialAssessment> {
    const credential = await deps.credentials.getCredentialRecordById(credentialId);
    if (!credential || credential.provider !== "codex_oauth") {
      return { shouldRotate: true, supportsActiveModel: null, unavailable: true };
    }

    if (credential.state !== "healthy") {
      return { shouldRotate: true, supportsActiveModel: null, unavailable: true };
    }

    try {
      const status = await deps.codexStatusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name ?? credential.id,
      });
      if (status.available !== true) {
        throw new AssignedCredentialUnavailableError();
      }
      const supportsActiveModel = codexStatusSupportsModel(status, activeModel.model);
      const eligible = evaluateCodexCredentialEligibility(status, now()).eligible;
      return {
        shouldRotate: !eligible || !supportsActiveModel,
        supportsActiveModel,
        unavailable: false,
      };
    } catch {
      throw new AssignedCredentialUnavailableError();
    }
  }

  async function assessReplacementCredentials(
    excludedCredentialId: string,
    activeModel: PlatformModelRef,
  ): Promise<ReplacementAssessment> {
    const listAdminCredentials = deps.credentials.listAdminCredentials;
    if (!listAdminCredentials) {
      return { replacement: null, hasCompatibleCredential: false, hasTransientFailure: false };
    }

    const credentials = await listAdminCredentials.call(deps.credentials);
    const eligible: RotationCandidate[] = [];
    let hasCompatibleCredential = false;
    let hasTransientFailure = false;

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
        if (status.available !== true) {
          hasTransientFailure = true;
          continue;
        }
        const supportsActiveModel = codexStatusSupportsModel(status, activeModel.model);
        if (!supportsActiveModel) {
          continue;
        }
        hasCompatibleCredential = true;
        if (!evaluateCodexCredentialEligibility(status, now()).eligible) continue;
      } catch {
        hasTransientFailure = true;
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

    return {
      replacement: eligible[0] ?? null,
      hasCompatibleCredential,
      hasTransientFailure,
    };
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
        summary: `Rotated Codex credential for user ${input.userId} from ${input.previousCredentialId} to ${input.nextCredentialId}.`,
      });
    } catch {
      return;
    }
  }
}
