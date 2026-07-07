import type { AlertRepository } from "../alerts/repository.js";
import type { AutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js";
import type { AiAccessRepository } from "../access/repository.js";
import type { GatewaySessionResolver } from "../auth/gateway-session.js";
import type { CredentialRepository } from "../credentials/repository.js";
import type { SecretStore } from "../credentials/secret-store.js";
import type { TokenBroker } from "../credentials/token-broker.js";
import type { LeaseBroker } from "../leases/lease-broker.js";
import type {
  AnthropicProviderTransport,
  CodexOAuthProviderTransport,
  OpenAiCompatibleProviderTransport,
  OpenAiProviderTransport,
} from "../providers/transport.js";
import type { UsageRepository } from "../usage/repository.js";

export type ProxyDependencies = {
  aiAccess?: AiAccessRepository;
  alertRepository?: AlertRepository;
  autoAssignedCodexCredentialRotation?: AutoAssignedCodexCredentialRotationService;
  gatewaySessions: GatewaySessionResolver;
  credentials: CredentialRepository;
  secrets: SecretStore;
  usageRepository: UsageRepository;
  leaseBroker: LeaseBroker;
  tokenBroker: TokenBroker;
  openAiTransport: OpenAiProviderTransport;
  anthropicTransport: AnthropicProviderTransport;
  codexOAuthTransport: CodexOAuthProviderTransport;
  openAiCompatibleTransport: OpenAiCompatibleProviderTransport;
};
