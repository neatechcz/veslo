export type VesloDeploymentService = "api" | "ai" | "app" | "admin" | "workers";

export type VesloDeploymentEndpoints = {
  deploymentDomain: string;
  apiBaseUrl: string;
  aiBaseUrl: string;
  appBaseUrl: string;
  adminBaseUrl: string;
  workersBaseUrl: string;
  workersDomainSuffix: string;
};

export const DEFAULT_VESLO_DEPLOYMENT_DOMAIN = "veslo.work";

const SERVICE_PREFIXES = new Set<VesloDeploymentService>(["api", "ai", "app", "admin", "workers"]);

function hostFromDeploymentValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.hostname.trim().toLowerCase().replace(/\.+$/, "");
  } catch {
    return trimmed
      .split(/[/?#]/, 1)[0]
      .trim()
      .toLowerCase()
      .replace(/\.+$/, "");
  }
}

export function normalizeVesloDeploymentDomain(value: string | null | undefined): string {
  const host = hostFromDeploymentValue(value ?? "");
  if (!host) return DEFAULT_VESLO_DEPLOYMENT_DOMAIN;

  const [firstLabel, ...rest] = host.split(".");
  if (SERVICE_PREFIXES.has(firstLabel as VesloDeploymentService) && rest.length > 0) {
    return rest.join(".") || DEFAULT_VESLO_DEPLOYMENT_DOMAIN;
  }

  return host;
}

export function deploymentServiceUrl(
  service: VesloDeploymentService,
  deploymentDomain?: string | null,
): string {
  return `https://${service}.${normalizeVesloDeploymentDomain(deploymentDomain)}`;
}

export function resolveVesloDeploymentEndpoints(
  deploymentDomain?: string | null,
): VesloDeploymentEndpoints {
  const normalizedDomain = normalizeVesloDeploymentDomain(deploymentDomain);
  return {
    deploymentDomain: normalizedDomain,
    apiBaseUrl: deploymentServiceUrl("api", normalizedDomain),
    aiBaseUrl: deploymentServiceUrl("ai", normalizedDomain),
    appBaseUrl: deploymentServiceUrl("app", normalizedDomain),
    adminBaseUrl: deploymentServiceUrl("admin", normalizedDomain),
    workersBaseUrl: deploymentServiceUrl("workers", normalizedDomain),
    workersDomainSuffix: `workers.${normalizedDomain}`,
  };
}
