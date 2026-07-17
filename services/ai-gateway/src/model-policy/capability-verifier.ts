import type { CredentialRepository } from "../credentials/repository.js";
import type { SecretStore } from "../credentials/secret-store.js";
import { listCodexModelCatalog } from "../providers/codex-model-catalog.js";
import type { OpenAiCompatibleProviderTransport } from "../providers/transport.js";
import { ProviderTransportError } from "../providers/transport.js";
import type { CodexCredentialStatusProvider, CodexUsageStatus } from "../usage/codex-status.js";
import type { PlatformModelRef } from "./repository.js";

export type PlatformModelCapabilityVerifier = {
  checkHealthyCredentialForModel(model: PlatformModelRef): Promise<ModelCapabilityCheckResult>;
  checkHealthyCredentialsForModels(models: PlatformModelRef[]): Promise<ModelCapabilityBatchResult[]>;
  checkCredentialForModel(credentialId: string, model: PlatformModelRef): Promise<ModelCapabilityCheckResult>;
  hasHealthyCredentialForModel(model: PlatformModelRef): Promise<boolean>;
  invalidateCredential(credentialId?: string): void;
};

export type ModelCapabilityCheckResult =
  | { status: "supported"; credentialId: string }
  | { status: "unsupported" }
  | { status: "transient"; reason: string };

export type ModelCapabilityBatchResult =
  | { model: PlatformModelRef; status: "supported"; credentialId: string }
  | {
      model: PlatformModelRef;
      status: "unsupported";
      reason: "no_healthy_credential" | "model_unsupported";
    }
  | { model: PlatformModelRef; status: "transient"; reason: string };

type CapabilityCacheEntry = { expiresAt: number; result: ModelCapabilityCheckResult };

const DEFAULT_CAPABILITY_CONCURRENCY = 4;
// A Codex credential probe can take several seconds while it refreshes OAuth
// state and reads rate-limit evidence. Five seconds rejects healthy production
// credentials before their probe can complete.
const DEFAULT_CAPABILITY_TIMEOUT_MS = 15_000;
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
    async checkHealthyCredentialsForModels(models) {
      if (models.length === 0) return [];
      const listAdminCredentials = deps.credentials.listAdminCredentials;
      if (!listAdminCredentials) {
        return transientBatchResults(models, "credential_lookup_unavailable");
      }

      let credentials;
      try {
        credentials = await listAdminCredentials.call(deps.credentials);
      } catch {
        return transientBatchResults(models, "credential_lookup_failed");
      }

      const results = new Map<string, ModelCapabilityBatchResult>();
      const state = new Map<string, BatchModelState>();
      const jobs: BatchCredentialJob[] = [];
      const modelsByProvider = new Map<PlatformModelRef["provider"], PlatformModelRef[]>();
      for (const model of models) {
        const providerModels = modelsByProvider.get(model.provider) ?? [];
        providerModels.push(model);
        modelsByProvider.set(model.provider, providerModels);
      }

      for (const [provider, providerModels] of modelsByProvider) {
        const candidates = credentials.filter((credential) =>
          credential.provider === provider && credential.state === "healthy" && !credential.deletedAt
        );
        if (candidates.length === 0) {
          for (const model of providerModels) {
            results.set(modelRefKey(model), { model, status: "unsupported", reason: "no_healthy_credential" });
          }
          continue;
        }
        if (provider === "openai" || provider === "anthropic") {
          for (const model of providerModels) {
            results.set(modelRefKey(model), { model, status: "supported", credentialId: candidates[0]!.id });
          }
          continue;
        }

        for (const model of providerModels) {
          state.set(modelRefKey(model), {
            model,
            supportedCredentialId: null,
            sawAuthoritativeEvidence: false,
            transientReasons: new Set<string>(),
          });
        }
        for (const credential of candidates) {
          jobs.push({
            credentialId: credential.id,
            credentialName: credential.name,
            provider,
            models: providerModels,
          });
        }
      }

      if (jobs.length === 0) {
        return models.map((model) => results.get(modelRefKey(model))!);
      }

      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, overallTimeoutMs);
      let nextJobIndex = 0;
      let unresolvedModels = state.size;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const job = jobs[nextJobIndex++];
          if (!job) return;
          const outcome = await settleOnAbort(
            probeCredentialModels(job, controller.signal),
            controller.signal,
          );
          if (!outcome) return;

          for (const model of job.models) {
            const modelState = state.get(modelRefKey(model));
            if (!modelState || modelState.supportedCredentialId) continue;
            if (outcome.status === "transient") {
              modelState.transientReasons.add(outcome.reason);
              continue;
            }
            modelState.sawAuthoritativeEvidence = true;
            if (outcome.supportedModels.has(model.model)) {
              modelState.supportedCredentialId = job.credentialId;
              unresolvedModels -= 1;
            }
          }

          if (unresolvedModels === 0) {
            controller.abort();
            return;
          }
        }
      };

      try {
        await Promise.all(
          Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
        );
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }

      for (const modelState of state.values()) {
        if (modelState.supportedCredentialId) {
          results.set(modelRefKey(modelState.model), {
            model: modelState.model,
            status: "supported",
            credentialId: modelState.supportedCredentialId,
          });
        } else if (timedOut) {
          results.set(modelRefKey(modelState.model), {
            model: modelState.model,
            status: "transient",
            reason: "capability_check_timeout",
          });
        } else if (modelState.transientReasons.size > 0) {
          results.set(modelRefKey(modelState.model), {
            model: modelState.model,
            status: "transient",
            reason: selectTransientReason(modelState.transientReasons),
          });
        } else {
          results.set(modelRefKey(modelState.model), {
            model: modelState.model,
            status: "unsupported",
            reason: modelState.sawAuthoritativeEvidence ? "model_unsupported" : "no_healthy_credential",
          });
        }
      }

      return models.map((model) => results.get(modelRefKey(model))!);
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

  async function probeCredentialModels(
    job: BatchCredentialJob,
    signal: AbortSignal,
  ): Promise<BatchCredentialProbeResult> {
    if (job.provider === "codex_oauth") {
      try {
        const status = await deps.codexStatusProvider.getStatus({
          credentialId: job.credentialId,
          credentialName: job.credentialName,
          signal,
        });
        if (status.available !== true) {
          return { status: "transient", reason: "capability_evidence_unavailable" };
        }
        return {
          status: "authoritative",
          supportedModels: new Set(filterUnsupportedCodexModels(listCodexModelCatalog(), status)),
        };
      } catch {
        return { status: "transient", reason: "capability_evidence_unavailable" };
      }
    }

    if (!deps.openAiCompatibleTransport.listModels) {
      return { status: "transient", reason: "model_discovery_unavailable" };
    }
    let credential: Awaited<ReturnType<CredentialRepository["getCredentialRecordById"]>>;
    try {
      credential = await deps.credentials.getCredentialRecordById(job.credentialId);
    } catch {
      return { status: "transient", reason: "credential_lookup_failed" };
    }
    if (!credential) return { status: "transient", reason: "credential_lookup_failed" };
    let secret: Awaited<ReturnType<SecretStore["get"]>>;
    try {
      secret = await deps.secrets.get(credential.secretRef);
    } catch {
      return { status: "transient", reason: "credential_lookup_failed" };
    }
    if (secret.kind !== "openai_compatible_api_key") {
      return { status: "transient", reason: "credential_lookup_failed" };
    }
    try {
      const discovery = await deps.openAiCompatibleTransport.listModels({
        apiKey: secret.apiKey,
        baseUrl: secret.baseUrl,
        signal,
      });
      return {
        status: "authoritative",
        supportedModels: new Set(normalizeDiscoveredModels(discovery.models)),
      };
    } catch (error) {
      return { status: "transient", reason: capabilityProbeErrorReason(error) };
    }
  }
}

type BatchModelState = {
  model: PlatformModelRef;
  supportedCredentialId: string | null;
  sawAuthoritativeEvidence: boolean;
  transientReasons: Set<string>;
};

type BatchCredentialJob = {
  credentialId: string;
  credentialName: string;
  provider: PlatformModelRef["provider"];
  models: PlatformModelRef[];
};

type BatchCredentialProbeResult =
  | { status: "authoritative"; supportedModels: Set<string> }
  | { status: "transient"; reason: string };

function transientBatchResults(models: PlatformModelRef[], reason: string): ModelCapabilityBatchResult[] {
  return models.map((model) => ({ model, status: "transient", reason }));
}

function modelRefKey(model: PlatformModelRef): string {
  return `${model.provider}\u0000${model.model}`;
}

function selectTransientReason(reasons: Set<string>): string {
  const priority = [
    "model_discovery_target_not_allowed",
    "model_discovery_timeout",
    "model_discovery_unavailable",
    "model_discovery_failed",
    "credential_lookup_failed",
    "capability_evidence_unavailable",
  ];
  return priority.find((reason) => reasons.has(reason)) ?? [...reasons].sort()[0] ?? "capability_evidence_unavailable";
}

function capabilityProbeErrorReason(error: unknown): string {
  if (error instanceof ProviderTransportError) {
    if (error.statusCode === 504 || error.code === "openai_compatible_models_timeout") {
      return "model_discovery_timeout";
    }
    if (error.statusCode === 503 || error.code === "openai_compatible_models_dns_failed") {
      return "model_discovery_unavailable";
    }
    if (error.statusCode === 400 || error.code === "openai_compatible_models_target_not_allowed") {
      return "model_discovery_target_not_allowed";
    }
    return "model_discovery_failed";
  }
  return "model_discovery_failed";
}

async function settleOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  return new Promise<T | null>((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      },
    );
  });
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
