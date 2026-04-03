import { DenGatewaySessionResolver } from "../auth/gateway-session.js";
import { DenUserSessionResolver } from "../auth/user-session.js";
import { DefaultTokenBroker } from "../credentials/default-token-broker.js";
import { MySqlCredentialRepository } from "../credentials/mysql-repository.js";
import { MySqlSecretStore } from "../credentials/mysql-secret-store.js";
import { DefaultOpenAiOAuthClient, type OpenAiOAuthClient } from "../credentials/openai-oauth.js";
import type { CredentialRepository } from "../credentials/repository.js";
import type { SecretStore } from "../credentials/secret-store.js";
import { createDb, type AiGatewayDb } from "../db/index.js";
import { env } from "../env.js";
import type { ProxyDependencies } from "../http/proxy.js";
import type { UserCredentialDependencies } from "../http/user-credentials.js";
import { DefaultBindingSelector } from "../leases/binding-selector.js";
import { LeaseBroker } from "../leases/lease-broker.js";
import { MySqlLeaseRepository } from "../leases/mysql-repository.js";
import type { LeaseRepository } from "../leases/repository.js";
import { AnthropicTransport } from "../providers/anthropic-transport.js";
import { OpenAiTransport } from "../providers/openai-transport.js";
import { MySqlUsageRepository } from "../usage/mysql-repository.js";
import type { UsageRepository } from "../usage/repository.js";

export type RuntimeState = {
  credentials: CredentialRepository;
  secrets: SecretStore;
  leases: LeaseRepository;
  usage: UsageRepository;
};

export type DefaultRuntimeOptions = {
  db?: AiGatewayDb;
  databaseUrl?: string;
  secretKey?: string;
};

export function createDefaultRuntimeState(options: DefaultRuntimeOptions = {}): RuntimeState {
  const db = options.db ?? createDb(options.databaseUrl ?? env.databaseUrl).db;
  const secretKey = options.secretKey ?? env.secretKey;

  return {
    credentials: new MySqlCredentialRepository(db),
    secrets: new MySqlSecretStore(db, secretKey),
    leases: new MySqlLeaseRepository(db),
    usage: new MySqlUsageRepository(db),
  };
}

export function createDefaultProxyDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<ProxyDependencies, "gatewaySessions" | "openAiTransport" | "anthropicTransport">> & {
    openAiOAuth?: OpenAiOAuthClient;
    now?: () => Date;
  } = {},
): ProxyDependencies {
  const notConfiguredFetch: typeof fetch = async () => {
    throw new Error("provider_transport_not_configured");
  };
  const openAiOAuth = overrides.openAiOAuth ?? createDefaultOpenAiOAuthClient();

  return {
    gatewaySessions: overrides.gatewaySessions ?? new DenGatewaySessionResolver({ denApiBase: env.denApiBase }),
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
  };
}

export function createDefaultUserCredentialDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<UserCredentialDependencies, "sessionResolver" | "openAiOAuth">> = {},
): UserCredentialDependencies {
  return {
    sessionResolver: overrides.sessionResolver ?? new DenUserSessionResolver({ denApiBase: env.denApiBase }),
    openAiOAuth: overrides.openAiOAuth ?? createDefaultOpenAiOAuthClient(),
    credentials: runtime.credentials,
    secrets: runtime.secrets,
  };
}

function createDefaultOpenAiOAuthClient() {
  return new DefaultOpenAiOAuthClient({
    clientId: env.openAiOAuth.clientId,
    clientSecret: env.openAiOAuth.clientSecret,
    redirectBase: env.openAiOAuth.redirectBase,
  });
}
