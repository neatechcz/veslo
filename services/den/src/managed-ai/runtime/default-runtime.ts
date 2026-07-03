import { DefaultBindingSelector } from "../leases/binding-selector.js"
import { LeaseBroker } from "../leases/lease-broker.js"
import { MySqlLeaseRepository } from "../leases/mysql-repository.js"
import type { LeaseRepository } from "../leases/repository.js"
import type { OrganizationBillingRepository } from "../../billing/repository.js"
import { findUserOrganization, resolveActiveUserOrganizations } from "../../http/org-auth.js"
import {
  createAutoAssignedCodexCredentialRotationService,
  type AutoAssignedCodexCredentialRotationService,
} from "../access/auto-assignment-rotation.js"
import { MySqlAiAccessRepository } from "../access/mysql-repository.js"
import type { AiAccessRepository } from "../access/repository.js"
import { MySqlAlertRepository } from "../alerts/mysql-repository.js"
import type { AlertRepository } from "../alerts/repository.js"
import { MySqlAuditRepository } from "../audit/mysql-repository.js"
import type { AuditRepository } from "../audit/repository.js"
import { DefaultTokenBroker } from "../credentials/default-token-broker.js"
import { MySqlCredentialRepository } from "../credentials/mysql-repository.js"
import { MySqlSecretStore } from "../credentials/mysql-secret-store.js"
import {
  DefaultOpenAiOAuthClient,
  createUnavailableOpenAiOAuthClient,
  type OpenAiOAuthClient,
} from "../credentials/openai-oauth.js"
import type { CredentialRepository } from "../credentials/repository.js"
import { DenGatewaySessionResolver } from "../auth/gateway-session.js"
import { DenUserSessionResolver, type UserSessionResolver } from "../auth/user-session.js"
import type { SecretStore } from "../credentials/secret-store.js"
import { createManagedAiDb, managedAiDb, resolveManagedAiDb } from "../db.js"
import { env } from "../../env.js"
import { AnthropicTransport } from "../providers/anthropic-transport.js"
import { CodexOAuthInferenceProxyTransport } from "../providers/codex-oauth-inference-proxy-transport.js"
import { OpenAiCompatibleTransport } from "../providers/openai-compatible-transport.js"
import { OpenAiTransport } from "../providers/openai-transport.js"
import type { CodexOAuthProviderTransport } from "../providers/transport.js"
import { CachedCodexCredentialStatusProvider, type CodexCredentialStatusProvider } from "../usage/codex-status.js"
import { MySqlUsageRepository } from "../usage/mysql-repository.js"
import type { UsageRepository } from "../usage/repository.js"

export type RuntimeState = {
  aiAccess: AiAccessRepository
  alerts: AlertRepository
  audit: AuditRepository
  credentials: CredentialRepository
  secrets: SecretStore
  leases: LeaseRepository
  usage: UsageRepository
  codexStatusProvider: CodexCredentialStatusProvider
  organizationBilling: OrganizationBillingRepository
}

export type DefaultRuntimeOptions = {
  db?: any
  databaseUrl?: string
  secretKey?: string
  organizationBilling?: OrganizationBillingRepository
}

export function createDefaultRuntimeState(options: DefaultRuntimeOptions = {}): RuntimeState {
  const db = resolveManagedAiDb(options, {
    managedAiDb,
    createManagedAiDb,
  })
  if (!db) {
    throw new Error("managed_ai_database_not_configured")
  }

  const secretKey = options.secretKey ?? env.managedAi.secretKey
  if (!secretKey) {
    throw new Error("managed_ai_secret_key_not_configured")
  }
  if (!options.organizationBilling) {
    throw new Error("organization_billing_repository_not_configured")
  }

  const credentials = new MySqlCredentialRepository(db)
  const secrets = new MySqlSecretStore(db, secretKey)

  return {
    aiAccess: new MySqlAiAccessRepository(db),
    alerts: new MySqlAlertRepository(db),
    audit: new MySqlAuditRepository(db),
    credentials,
    secrets,
    leases: new MySqlLeaseRepository(db),
    usage: new MySqlUsageRepository(db),
    organizationBilling: options.organizationBilling,
    codexStatusProvider: new CachedCodexCredentialStatusProvider({
      loadCredentialAuthJson: async (credentialId) => {
        const credential = await credentials.getCredentialRecordById(credentialId)
        if (!credential) {
          return null
        }

        const secret = await secrets.get(credential.secretRef).catch(() => null)
        return secret?.kind === "codex_auth_json" ? secret.authJson : null
      },
    }),
  }
}

export type ProxyDependencies = {
  aiAccess: AiAccessRepository
  autoAssignedCodexCredentialRotation: AutoAssignedCodexCredentialRotationService
  gatewaySessions: DenGatewaySessionResolver
  organizationAccess: {
    listUserOrganizations: typeof resolveActiveUserOrganizations
    findUserOrganization: typeof findUserOrganization
  }
  organizationBilling: OrganizationBillingRepository
  credentials: CredentialRepository
  secrets: SecretStore
  usageRepository: UsageRepository
  leaseBroker: LeaseBroker
  tokenBroker: DefaultTokenBroker
  openAiTransport: OpenAiTransport
  anthropicTransport: AnthropicTransport
  codexOAuthTransport: CodexOAuthProviderTransport
  openAiCompatibleTransport: OpenAiCompatibleTransport
}

export function createDefaultProxyDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<ProxyDependencies, "gatewaySessions" | "openAiTransport" | "anthropicTransport" | "codexOAuthTransport" | "openAiCompatibleTransport">> & {
    openAiOAuth?: OpenAiOAuthClient
    now?: () => Date
  } = {},
): ProxyDependencies {
  const notConfiguredFetch: typeof fetch = async () => {
    throw new Error("provider_transport_not_configured")
  }
  const openAiOAuth = overrides.openAiOAuth ?? createDefaultOpenAiOAuthClient()

  return {
    aiAccess: runtime.aiAccess,
    autoAssignedCodexCredentialRotation: createAutoAssignedCodexCredentialRotationService({
      aiAccess: runtime.aiAccess,
      credentials: runtime.credentials,
      codexStatusProvider: runtime.codexStatusProvider,
      audit: runtime.audit,
      now: overrides.now,
    }),
    gatewaySessions: overrides.gatewaySessions ?? new DenGatewaySessionResolver(),
    organizationAccess: {
      listUserOrganizations: resolveActiveUserOrganizations,
      findUserOrganization,
    },
    organizationBilling: runtime.organizationBilling,
    credentials: runtime.credentials,
    secrets: runtime.secrets,
    usageRepository: runtime.usage,
    leaseBroker: new LeaseBroker(
      runtime.leases,
      new DefaultBindingSelector({
        credentials: runtime.credentials,
        codexStatusProvider: runtime.codexStatusProvider,
        now: overrides.now,
      }),
    ),
    tokenBroker: new DefaultTokenBroker({
      credentials: runtime.credentials,
      secrets: runtime.secrets,
      now: overrides.now,
      refreshOpenAiOAuth: async ({ secret }) => ({
        kind: "openai_oauth",
        ...(await openAiOAuth.refreshToken({
          refreshToken: secret.refreshToken,
        })),
      }),
    }),
    openAiTransport: overrides.openAiTransport ?? new OpenAiTransport({ fetchImpl: notConfiguredFetch }),
    anthropicTransport: overrides.anthropicTransport ?? new AnthropicTransport({ fetchImpl: notConfiguredFetch }),
    codexOAuthTransport: overrides.codexOAuthTransport ?? new CodexOAuthInferenceProxyTransport(),
    openAiCompatibleTransport: overrides.openAiCompatibleTransport ?? new OpenAiCompatibleTransport(),
  }
}

export type UserCredentialDependencies = {
  sessionResolver: UserSessionResolver
  aiAccess: AiAccessRepository
  autoAssignedCodexCredentialRotation: AutoAssignedCodexCredentialRotationService
}

export function createDefaultUserCredentialDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<UserCredentialDependencies, "sessionResolver">> = {},
): UserCredentialDependencies {
  return {
    sessionResolver: overrides.sessionResolver ?? new DenUserSessionResolver(),
    aiAccess: runtime.aiAccess,
    autoAssignedCodexCredentialRotation: createAutoAssignedCodexCredentialRotationService({
      aiAccess: runtime.aiAccess,
      credentials: runtime.credentials,
      codexStatusProvider: runtime.codexStatusProvider,
      audit: runtime.audit,
    }),
  }
}

function createDefaultOpenAiOAuthClient() {
  const config = env.managedAi.openAi
  if (!config.clientId || !config.clientSecret || !config.redirectBase) {
    return createUnavailableOpenAiOAuthClient()
  }

  return new DefaultOpenAiOAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectBase: config.redirectBase,
  })
}
