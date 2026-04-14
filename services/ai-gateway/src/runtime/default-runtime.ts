import { MySqlAiAccessRepository } from "../access/mysql-repository.js";
import type { AiAccessRepository } from "../access/repository.js";
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
import { CodexCliWorkerTransport } from "../providers/codex-cli-worker-transport.js";
import { OpenAiTransport } from "../providers/openai-transport.js";
import { MySqlUsageRepository } from "../usage/mysql-repository.js";
import type { UsageRepository } from "../usage/repository.js";

export type RuntimeState = {
  aiAccess: AiAccessRepository;
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
    aiAccess: new MySqlAiAccessRepository(db),
    credentials: new MySqlCredentialRepository(db),
    secrets: new MySqlSecretStore(db, secretKey),
    leases: new MySqlLeaseRepository(db),
    usage: new MySqlUsageRepository(db),
  };
}

export function createDefaultProxyDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<ProxyDependencies, "gatewaySessions" | "openAiTransport" | "anthropicTransport" | "codexOAuthTransport">> & {
    openAiOAuth?: OpenAiOAuthClient;
    now?: () => Date;
  } = {},
): ProxyDependencies {
  const openAiOAuth = overrides.openAiOAuth ?? createDefaultOpenAiOAuthClient();

  return {
    aiAccess: runtime.aiAccess,
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
    openAiTransport: overrides.openAiTransport ?? new OpenAiTransport(),
    anthropicTransport: overrides.anthropicTransport ?? new AnthropicTransport(),
    codexOAuthTransport: overrides.codexOAuthTransport ?? new CodexCliWorkerTransport(),
  };
}

export function createDefaultUserCredentialDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<UserCredentialDependencies, "sessionResolver">> = {},
): UserCredentialDependencies {
  return {
    sessionResolver: overrides.sessionResolver ?? new DenUserSessionResolver({ denApiBase: env.denApiBase }),
    aiAccess: runtime.aiAccess,
  };
}

function createDefaultOpenAiOAuthClient() {
  return new DefaultOpenAiOAuthClient({
    clientId: env.openAiOAuth.clientId,
    clientSecret: env.openAiOAuth.clientSecret,
    redirectBase: env.openAiOAuth.redirectBase,
  });
}
