import { Router } from "express";

import type { AiAccessRepository } from "../access/repository.js";
import type { CredentialRepository } from "../credentials/repository.js";
import type { PlatformModelPolicyRepository, PlatformModelRef } from "../model-policy/repository.js";
import type { PlatformModelCapabilityVerifier } from "../model-policy/capability-verifier.js";
import { classifyProviderProxyFailure } from "./providers/proxy-failure-alert.js";

export type ReadinessProviderProbe = {
  provider: string;
  url: string;
};

export type ReadinessDependencies = {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  credentials: Pick<CredentialRepository, "listHealthyCredentialRecordIds">;
  aiAccess?: Pick<AiAccessRepository, "countEnabledPolicies">;
  modelPolicy: Pick<PlatformModelPolicyRepository, "getPolicy">;
  modelCapabilities: PlatformModelCapabilityVerifier;
  probes?: ReadinessProviderProbe[];
  timeoutMs?: number;
  now?: () => Date;
};

export type ReadinessPayload = {
  ok: boolean;
  service: "ai-gateway";
  status: "ready" | "not_ready";
  checkedAt: string;
  checks: {
    providerReachability: {
      ok: boolean;
      probes: Array<{
        provider: string;
        ok: boolean;
        status?: number;
        reason?: string;
      }>;
    };
    credentials: {
      ok: boolean;
      healthyCredentialCount: number;
      reason?: string;
    };
    aiAccessPolicies: {
      ok: boolean;
      enabledPolicyCount: number;
      reason?: string;
    };
    modelPolicy: {
      ok: boolean;
      activeModel: PlatformModelRef | null;
      reason?: string;
    };
  };
};

const DEFAULT_READINESS_TIMEOUT_MS = 5_000;

const DEFAULT_PROVIDER_PROBES: ReadinessProviderProbe[] = [
  { provider: "openai", url: "https://api.openai.com/v1/models" },
  { provider: "anthropic", url: "https://api.anthropic.com/v1/models" },
  { provider: "codex_oauth", url: "https://chatgpt.com/" },
];

export function createReadinessRouter(deps: ReadinessDependencies) {
  const router = Router();

  router.get("/readiness", async (_req, res) => {
    const payload = await checkReadiness(deps);
    res.status(payload.ok ? 200 : 503).json(payload);
  });

  return router;
}

export async function checkReadiness(deps: ReadinessDependencies): Promise<ReadinessPayload> {
  const [providerReachability, modelPolicy] = await Promise.all([
    checkProviderReachability(deps),
    checkModelPolicy(deps.modelPolicy),
  ]);
  const [aiAccessPolicies, credentials] = await Promise.all([
    checkAiAccessPolicies(deps.aiAccess),
    checkCredentials(
      deps.credentials,
      deps.modelCapabilities,
      modelPolicy.activeModel,
    ),
  ]);

  const ok = providerReachability.ok && credentials.ok && aiAccessPolicies.ok && modelPolicy.ok;

  return {
    ok,
    service: "ai-gateway",
    status: ok ? "ready" : "not_ready",
    checkedAt: (deps.now?.() ?? new Date()).toISOString(),
    checks: {
      providerReachability,
      credentials,
      aiAccessPolicies,
      modelPolicy,
    },
  };
}

async function checkProviderReachability(deps: ReadinessDependencies): Promise<ReadinessPayload["checks"]["providerReachability"]> {
  const probes = deps.probes ?? DEFAULT_PROVIDER_PROBES;
  const results = await Promise.all(probes.map((probe) => runProviderProbe(probe, deps)));
  return {
    ok: results.length > 0 && results.every((entry) => entry.ok),
    probes: results,
  };
}

async function runProviderProbe(
  probe: ReadinessProviderProbe,
  deps: ReadinessDependencies,
): Promise<ReadinessPayload["checks"]["providerReachability"]["probes"][number]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(probe.url, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      signal: controller.signal,
    });

    if (response.status < 500) {
      return {
        provider: probe.provider,
        ok: true,
        status: response.status,
      };
    }

    return {
      provider: probe.provider,
      ok: false,
      status: response.status,
      reason: `provider_http_${response.status}`,
    };
  } catch (error) {
    return {
      provider: probe.provider,
      ok: false,
      reason: classifyProviderProxyFailure(error) ?? "network_fetch_failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkCredentials(
  credentials: Pick<CredentialRepository, "listHealthyCredentialRecordIds">,
  modelCapabilities: PlatformModelCapabilityVerifier,
  activeModel: PlatformModelRef | null,
): Promise<ReadinessPayload["checks"]["credentials"]> {
  let ids: string[];
  try {
    ids = await credentials.listHealthyCredentialRecordIds();
  } catch {
    return {
      ok: false,
      healthyCredentialCount: 0,
      reason: "credential_repository_unavailable",
    };
  }

  let compatible = ids.length > 0;
  if (activeModel && compatible) {
    try {
      compatible = (await modelCapabilities.checkHealthyCredentialForModel(activeModel)).status === "supported";
    } catch {
      compatible = false;
    }
  }
  return {
    ok: compatible,
    healthyCredentialCount: ids.length,
    reason: ids.length === 0
      ? "no_healthy_credentials"
      : compatible
        ? undefined
        : "no_healthy_credential_for_active_model",
  };
}

async function checkAiAccessPolicies(
  aiAccess: Pick<AiAccessRepository, "countEnabledPolicies"> | undefined,
): Promise<ReadinessPayload["checks"]["aiAccessPolicies"]> {
  if (!aiAccess?.countEnabledPolicies) {
    return {
      ok: false,
      enabledPolicyCount: 0,
      reason: "ai_access_policy_repository_unavailable",
    };
  }

  try {
    const count = await aiAccess.countEnabledPolicies();
    if (count <= 0) {
      return {
        ok: false,
        enabledPolicyCount: count,
        reason: "no_enabled_ai_access_policies",
      };
    }

    return {
      ok: true,
      enabledPolicyCount: count,
    };
  } catch {
    return {
      ok: false,
      enabledPolicyCount: 0,
      reason: "ai_access_policy_repository_unavailable",
    };
  }
}

async function checkModelPolicy(
  modelPolicy: Pick<PlatformModelPolicyRepository, "getPolicy">,
): Promise<ReadinessPayload["checks"]["modelPolicy"]> {
  try {
    const policy = await modelPolicy.getPolicy();
    if (!policy) {
      return {
        ok: false,
        activeModel: null,
        reason: "platform_model_policy_not_configured",
      };
    }

    return {
      ok: true,
      activeModel: policy.activeModel,
    };
  } catch {
    return {
      ok: false,
      activeModel: null,
      reason: "platform_model_policy_lookup_failed",
    };
  }
}
