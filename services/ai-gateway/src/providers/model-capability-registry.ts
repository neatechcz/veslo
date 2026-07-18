import { type AiGatewayProvider, CODEX_OAUTH_PROVIDER } from "./ids.js";

export const CODEX_OAUTH_MODEL_CAPABILITY_REGISTRY_VERSION = "2026-07-17";

export type GatewayModelCapabilityStatus = "known" | "unknown";

export type GatewayModelCapabilityDescriptor = {
  provider: AiGatewayProvider;
  model: string;
  registryVersion: string;
  capabilityStatus: GatewayModelCapabilityStatus;
  attachment?: boolean;
  modalities?: { input: string[] };
};

// This registry is deliberately conservative. A provider/model must have a
// reviewed capability source before it can claim attachment or image support.
// Unknown entries remain eligible for text inference when separately authorized,
// but server-side attachment validation will fail closed.
const CODEX_OAUTH_MODEL_CAPABILITIES: readonly GatewayModelCapabilityDescriptor[] = [
  {
    provider: CODEX_OAUTH_PROVIDER,
    model: "gpt-5.6-sol",
    registryVersion: CODEX_OAUTH_MODEL_CAPABILITY_REGISTRY_VERSION,
    capabilityStatus: "known" as const,
    attachment: true,
    modalities: { input: ["text", "image"] },
  },
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
].map((entry) => typeof entry === "string"
  ? {
      provider: CODEX_OAUTH_PROVIDER,
      model: entry,
      registryVersion: CODEX_OAUTH_MODEL_CAPABILITY_REGISTRY_VERSION,
      capabilityStatus: "unknown" as const,
    }
  : entry);

export function listGatewayModelCapabilityDescriptors(
  provider?: AiGatewayProvider | null,
): GatewayModelCapabilityDescriptor[] {
  const descriptors = provider === undefined || provider === null || provider === CODEX_OAUTH_PROVIDER
    ? CODEX_OAUTH_MODEL_CAPABILITIES
    : [];
  return descriptors.map(cloneDescriptor);
}

export function resolveGatewayModelCapabilityDescriptor(input: {
  provider: AiGatewayProvider;
  model: string;
}): GatewayModelCapabilityDescriptor {
  const model = input.model.trim();
  const known = listGatewayModelCapabilityDescriptors(input.provider)
    .find((entry) => entry.model === model);
  return known ?? {
    provider: input.provider,
    model,
    registryVersion: input.provider === CODEX_OAUTH_PROVIDER
      ? CODEX_OAUTH_MODEL_CAPABILITY_REGISTRY_VERSION
      : "unregistered",
    capabilityStatus: "unknown",
  };
}

function cloneDescriptor(input: GatewayModelCapabilityDescriptor): GatewayModelCapabilityDescriptor {
  return {
    ...input,
    ...(input.modalities ? { modalities: { input: [...input.modalities.input] } } : {}),
  };
}
