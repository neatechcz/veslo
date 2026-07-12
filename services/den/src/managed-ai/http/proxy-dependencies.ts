import type { OrganizationBillingRepository } from "../../billing/repository.js"
import type { OrganizationSummary } from "../../http/org-auth.js"
import type { AiAccessRepository } from "../access/repository.js"
import type { AutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js"
import type { GatewaySessionResolver } from "../auth/gateway-session.js"
import type { CredentialRepository } from "../credentials/repository.js"
import type { SecretStore } from "../credentials/secret-store.js"
import type { TokenBroker } from "../credentials/token-broker.js"
import type { LeaseBroker } from "../leases/lease-broker.js"
import type {
  AnthropicProviderTransport,
  CodexOAuthProviderTransport,
  OpenAiCompatibleProviderTransport,
  OpenAiProviderTransport,
} from "../providers/transport.js"
import type { UsageRepository } from "../usage/repository.js"

export type ProxyDependencies = {
  /** Production is retired. legacy_rollback is an explicit rollback-only mode. */
  denInferenceMode: "retired" | "legacy_rollback"
  aiAccess?: AiAccessRepository
  autoAssignedCodexCredentialRotation?: AutoAssignedCodexCredentialRotationService
  gatewaySessions: GatewaySessionResolver
  organizationAccess?: {
    listUserOrganizations(userId: string): Promise<OrganizationSummary[]>
    findUserOrganization?(userId: string, orgId: string): Promise<OrganizationSummary | null>
  }
  organizationBilling?: Pick<OrganizationBillingRepository, "deriveEntitlement">
  credentials: CredentialRepository
  secrets: SecretStore
  usageRepository: UsageRepository
  leaseBroker: LeaseBroker
  tokenBroker: TokenBroker
  openAiTransport: OpenAiProviderTransport
  anthropicTransport: AnthropicProviderTransport
  codexOAuthTransport: CodexOAuthProviderTransport
  openAiCompatibleTransport: OpenAiCompatibleProviderTransport
}
