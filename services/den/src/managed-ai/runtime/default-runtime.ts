import { DefaultBindingSelector } from "../leases/binding-selector.js"
import { LeaseBroker } from "../leases/lease-broker.js"
import { MySqlLeaseRepository } from "../leases/mysql-repository.js"
import type { LeaseRepository } from "../leases/repository.js"
import { MySqlAiAccessRepository } from "../access/mysql-repository.js"
import type { AiAccessRepository } from "../access/repository.js"
import { DefaultTokenBroker } from "../credentials/default-token-broker.js"
import { MySqlCredentialRepository } from "../credentials/mysql-repository.js"
import { MySqlSecretStore } from "../credentials/mysql-secret-store.js"
import { DefaultOpenAiOAuthClient, type OpenAiOAuthClient } from "../credentials/openai-oauth.js"
import type { CredentialRepository } from "../credentials/repository.js"
import { DenGatewaySessionResolver } from "../auth/gateway-session.js"
import { DenUserSessionResolver, type UserSessionResolver } from "../auth/user-session.js"
import type { SecretStore } from "../credentials/secret-store.js"
import { createManagedAiDb, managedAiDb, resolveManagedAiDb } from "../db.js"
import { env } from "../../env.js"
import { AnthropicTransport } from "../providers/anthropic-transport.js"
import { OpenAiTransport } from "../providers/openai-transport.js"
import { MySqlUsageRepository } from "../usage/mysql-repository.js"
import type { UsageRepository } from "../usage/repository.js"

export type RuntimeState = {
  aiAccess: AiAccessRepository
  credentials: CredentialRepository
  secrets: SecretStore
  leases: LeaseRepository
  usage: UsageRepository
}

export type DefaultRuntimeOptions = {
  db?: any
  databaseUrl?: string
  secretKey?: string
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

  return {
    aiAccess: new MySqlAiAccessRepository(db),
    credentials: new MySqlCredentialRepository(db),
    secrets: new MySqlSecretStore(db, secretKey),
    leases: new MySqlLeaseRepository(db),
    usage: new MySqlUsageRepository(db),
  }
}

export type ProxyDependencies = {
  aiAccess: AiAccessRepository
  gatewaySessions: DenGatewaySessionResolver
  credentials: CredentialRepository
  usageRepository: UsageRepository
  leaseBroker: LeaseBroker
  tokenBroker: DefaultTokenBroker
  openAiTransport: OpenAiTransport
  anthropicTransport: AnthropicTransport
}

export function createDefaultProxyDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<ProxyDependencies, "gatewaySessions" | "openAiTransport" | "anthropicTransport">> & {
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
    gatewaySessions: overrides.gatewaySessions ?? new DenGatewaySessionResolver(),
    credentials: runtime.credentials,
    usageRepository: runtime.usage,
    leaseBroker: new LeaseBroker(
      runtime.leases,
      new DefaultBindingSelector(runtime.credentials),
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
  }
}

export type UserCredentialDependencies = {
  sessionResolver: UserSessionResolver
  aiAccess: AiAccessRepository
}

export function createDefaultUserCredentialDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<UserCredentialDependencies, "sessionResolver">> = {},
): UserCredentialDependencies {
  return {
    sessionResolver: overrides.sessionResolver ?? new DenUserSessionResolver(),
    aiAccess: runtime.aiAccess,
  }
}

function createDefaultOpenAiOAuthClient() {
  const config = env.managedAi.openAi
  if (!config.clientId || !config.clientSecret || !config.redirectBase) {
    throw new Error("managed_ai_openai_oauth_not_configured")
  }

  return new DefaultOpenAiOAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectBase: config.redirectBase,
  })
}
