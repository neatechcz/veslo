import { Router } from "express";

import type { AiAccessRepository } from "../access/repository.js";
import type { CredentialRepository } from "../credentials/repository.js";
import type { PlatformModelPolicyRepository, PlatformModelRef } from "../model-policy/repository.js";
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
  const [providerReachability, credentials, aiAccessPolicies, modelPolicy] = await Promise.all([
    checkProviderReachability(deps),
    checkCredentials(deps.credentials),
    checkAiAccessPolicies(deps.aiAccess),
    checkModelPolicy(deps.modelPolicy),
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
): Promise<ReadinessPayload["checks"]["credentials"]> {
  try {
    const ids = await credentials.listHealthyCredentialRecordIds();
    return {
      ok: ids.length > 0,
      healthyCredentialCount: ids.length,
      reason: ids.length > 0 ? undefined : "no_healthy_credentials",
    };
  } catch {
    return {
      ok: false,
      healthyCredentialCount: 0,
      reason: "credential_repository_unavailable",
    };
  }
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
    return {
      ok: count > 0,
      enabledPolicyCount: count,
      reason: count > 0 ? undefined : "no_enabled_ai_access_policies",
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
