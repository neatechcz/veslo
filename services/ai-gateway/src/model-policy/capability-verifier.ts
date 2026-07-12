import type { CredentialRepository } from "../credentials/repository.js";
import type { SecretStore } from "../credentials/secret-store.js";
import { listCodexModelCatalog } from "../providers/codex-model-catalog.js";
import type { OpenAiCompatibleProviderTransport } from "../providers/transport.js";
import type { CodexCredentialStatusProvider, CodexUsageStatus } from "../usage/codex-status.js";
import type { PlatformModelRef } from "./repository.js";

export type PlatformModelCapabilityVerifier = {
  hasHealthyCredentialForModel(model: PlatformModelRef): Promise<boolean>;
};

export function createPlatformModelCapabilityVerifier(deps: {
  credentials: CredentialRepository;
  secrets: SecretStore;
  codexStatusProvider: CodexCredentialStatusProvider;
  openAiCompatibleTransport: OpenAiCompatibleProviderTransport;
}): PlatformModelCapabilityVerifier {
  return {
    async hasHealthyCredentialForModel(model) {
      const credentials = await deps.credentials.listAdminCredentials?.();
      if (!credentials) return false;
      const candidates = credentials.filter((credential) =>
        credential.provider === model.provider
        && credential.state === "healthy"
        && !credential.deletedAt
      );
      for (const credential of candidates) {
        if (await isCredentialCompatible(credential.id, credential.name, model)) return true;
      }
      return false;
    },
  };

  async function isCredentialCompatible(
    credentialId: string,
    credentialName: string,
    model: PlatformModelRef,
  ): Promise<boolean> {
    if (model.provider === "openai" || model.provider === "anthropic") return true;
    if (model.provider === "codex_oauth") {
      const status = await deps.codexStatusProvider.getStatus({ credentialId, credentialName });
      return codexStatusSupportsModel(status, model.model);
    }
    const credential = await deps.credentials.getCredentialRecordById(credentialId);
    if (!credential) return false;
    const secret = await deps.secrets.get(credential.secretRef);
    if (secret.kind !== "openai_compatible_api_key") return false;
    return openAiCompatibleCredentialSupportsModel({
      transport: deps.openAiCompatibleTransport,
      secret,
      model: model.model,
    });
  }
}

export function codexStatusSupportsModel(status: CodexUsageStatus, model: string): boolean {
  if (status.available !== true || !listCodexModelCatalog().includes(model)) return false;
  const unsupported = new Set((status.unsupportedModels ?? []).map((value) => value.trim()).filter(Boolean));
  return !unsupported.has(model);
}

export function normalizeDiscoveredModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
}

export function filterUnsupportedCodexModels(models: string[], status: CodexUsageStatus | null): string[] {
  const unsupported = new Set((status?.unsupportedModels ?? []).map((value) => value.trim()).filter(Boolean));
  return unsupported.size === 0 ? models : models.filter((model) => !unsupported.has(model));
}

export async function openAiCompatibleCredentialSupportsModel(input: {
  transport: OpenAiCompatibleProviderTransport;
  secret: Extract<Awaited<ReturnType<SecretStore["get"]>>, { kind: "openai_compatible_api_key" }>;
  model: string;
}): Promise<boolean> {
  if (!input.transport.listModels) return false;
  const discovery = await input.transport.listModels({
    apiKey: input.secret.apiKey,
    baseUrl: input.secret.baseUrl,
  });
  return normalizeDiscoveredModels(discovery.models).includes(input.model);
}
