import type { CredentialRepository } from "../credentials/repository.js";
import type { SecretStore } from "../credentials/secret-store.js";
import { listCodexModelCatalog } from "../providers/codex-model-catalog.js";
import type { OpenAiCompatibleProviderTransport } from "../providers/transport.js";
import type { CodexCredentialStatusProvider, CodexUsageStatus } from "../usage/codex-status.js";
import type { PlatformModelRef } from "./repository.js";

export type PlatformModelCapabilityVerifier = {
  checkHealthyCredentialForModel(model: PlatformModelRef): Promise<ModelCapabilityCheckResult>;
  checkCredentialForModel(credentialId: string, model: PlatformModelRef): Promise<ModelCapabilityCheckResult>;
  hasHealthyCredentialForModel(model: PlatformModelRef): Promise<boolean>;
  invalidateCredential(credentialId?: string): void;
};

export type ModelCapabilityCheckResult =
  | { status: "supported"; credentialId: string }
  | { status: "unsupported" }
  | { status: "transient"; reason: string };

type CapabilityCacheEntry = { expiresAt: number; result: ModelCapabilityCheckResult };

const DEFAULT_CAPABILITY_CONCURRENCY = 4;
const DEFAULT_CAPABILITY_TIMEOUT_MS = 5_000;
const DEFAULT_CAPABILITY_CACHE_TTL_MS = 15_000;

export function createPlatformModelCapabilityVerifier(deps: {
  credentials: CredentialRepository;
  secrets: SecretStore;
  codexStatusProvider: CodexCredentialStatusProvider;
  openAiCompatibleTransport: OpenAiCompatibleProviderTransport;
  concurrency?: number;
  overallTimeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}): PlatformModelCapabilityVerifier {
  const concurrency = positiveInteger(deps.concurrency, DEFAULT_CAPABILITY_CONCURRENCY);
  const overallTimeoutMs = positiveInteger(deps.overallTimeoutMs, DEFAULT_CAPABILITY_TIMEOUT_MS);
  const cacheTtlMs = positiveInteger(deps.cacheTtlMs, DEFAULT_CAPABILITY_CACHE_TTL_MS);
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CapabilityCacheEntry>();

  const verifier: PlatformModelCapabilityVerifier = {
    async checkHealthyCredentialForModel(model) {
      const listAdminCredentials = deps.credentials.listAdminCredentials;
      if (!listAdminCredentials) return { status: "transient", reason: "credential_lookup_unavailable" };
      let credentials;
      try {
        credentials = await listAdminCredentials.call(deps.credentials);
      } catch {
        return { status: "transient", reason: "credential_lookup_failed" };
      }
      const candidates = credentials.filter((credential) =>
        credential.provider === model.provider && credential.state === "healthy" && !credential.deletedAt
      );
      if (candidates.length === 0) return { status: "unsupported" };
      if (model.provider === "openai" || model.provider === "anthropic") {
        return { status: "supported", credentialId: candidates[0]!.id };
      }

      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, overallTimeoutMs);
      let nextIndex = 0;
      let supported: ModelCapabilityCheckResult | null = null;
      let sawTransient = false;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const index = nextIndex++;
          const credential = candidates[index];
          if (!credential) return;
          const result = await checkCredential(credential.id, credential.name, model, controller.signal);
          if (result.status === "supported") {
            supported = result;
            controller.abort();
            return;
          }
          if (result.status === "transient") sawTransient = true;
        }
      };
      const workers = Promise.all(
        Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
      );
      const aborted = new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([workers, aborted]);
      clearTimeout(timeout);
      if (supported) return supported;
      if (timedOut) return { status: "transient", reason: "capability_check_timeout" };
      await workers;
      return sawTransient
        ? { status: "transient", reason: "capability_evidence_unavailable" }
        : { status: "unsupported" };
    },
    async hasHealthyCredentialForModel(model) {
      return (await verifier.checkHealthyCredentialForModel(model)).status === "supported";
    },
    async checkCredentialForModel(credentialId, model) {
      const listAdminCredentials = deps.credentials.listAdminCredentials;
      if (!listAdminCredentials) return { status: "transient", reason: "credential_lookup_unavailable" };
      let credentials;
      try {
        credentials = await listAdminCredentials.call(deps.credentials);
      } catch {
        return { status: "transient", reason: "credential_lookup_failed" };
      }
      const credential = credentials.find((candidate) =>
        candidate.id === credentialId
        && candidate.provider === model.provider
        && candidate.state === "healthy"
        && !candidate.deletedAt
      );
      if (!credential) return { status: "unsupported" };
      if (model.provider === "openai" || model.provider === "anthropic") {
        return { status: "supported", credentialId };
      }

      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, overallTimeoutMs);
      try {
        const check = checkCredential(credential.id, credential.name, model, controller.signal);
        const deadline = new Promise<null>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(null), { once: true });
        });
        const result = await Promise.race([check, deadline]);
        return timedOut || result === null
          ? { status: "transient", reason: "capability_check_timeout" }
          : result;
      } finally {
        clearTimeout(timeout);
      }
    },
    invalidateCredential(credentialId) {
      if (!credentialId) {
        cache.clear();
        return;
      }
      for (const key of cache.keys()) {
        if (key.startsWith(`${credentialId}\u0000`)) cache.delete(key);
      }
    },
  };
  return verifier;

  async function checkCredential(
    credentialId: string,
    credentialName: string,
    model: PlatformModelRef,
    signal: AbortSignal,
  ): Promise<ModelCapabilityCheckResult> {
    const key = `${credentialId}\u0000${model.provider}\u0000${model.model}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.result;
    if (cached) cache.delete(key);
    let result: ModelCapabilityCheckResult;
    try {
      if (model.provider === "codex_oauth") {
        const status = await deps.codexStatusProvider.getStatus({ credentialId, credentialName, signal });
        result = status.available !== true
          ? { status: "transient", reason: "capability_evidence_unavailable" }
          : codexStatusSupportsModel(status, model.model)
            ? { status: "supported", credentialId }
            : { status: "unsupported" };
      } else {
        const credential = await deps.credentials.getCredentialRecordById(credentialId);
        if (!credential) return { status: "transient", reason: "credential_lookup_failed" };
        const secret = await deps.secrets.get(credential.secretRef);
        if (secret.kind !== "openai_compatible_api_key") return { status: "unsupported" };
        result = await openAiCompatibleCredentialSupportsModel({
          transport: deps.openAiCompatibleTransport,
          secret,
          model: model.model,
          signal,
        })
          ? { status: "supported", credentialId }
          : { status: "unsupported" };
      }
    } catch {
      result = { status: "transient", reason: "capability_evidence_unavailable" };
    }
    if (!signal.aborted) cache.set(key, { expiresAt: now() + cacheTtlMs, result });
    return result;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
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
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!input.transport.listModels) return false;
  const discovery = await input.transport.listModels({
    apiKey: input.secret.apiKey,
    baseUrl: input.secret.baseUrl,
    signal: input.signal,
  });
  return normalizeDiscoveredModels(discovery.models).includes(input.model);
}
