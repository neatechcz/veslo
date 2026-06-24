import { MySqlAiAccessRepository } from "../access/mysql-repository.js";
import { createAutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js";
import type { AiAccessRepository } from "../access/repository.js";
import { MySqlAlertRepository } from "../alerts/mysql-repository.js";
import type { AlertRepository } from "../alerts/repository.js";
import { MySqlAuditRepository } from "../audit/mysql-repository.js";
import type { AuditRepository } from "../audit/repository.js";
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
import type { ReadinessDependencies } from "../http/readiness.js";
import type { UserCredentialDependencies } from "../http/user-credentials.js";
import { DefaultBindingSelector } from "../leases/binding-selector.js";
import { LeaseBroker } from "../leases/lease-broker.js";
import { MySqlLeaseRepository } from "../leases/mysql-repository.js";
import type { LeaseRepository } from "../leases/repository.js";
import { AnthropicTransport } from "../providers/anthropic-transport.js";
import { CodexOAuthInferenceProxyTransport } from "../providers/codex-oauth-inference-proxy-transport.js";
import { CachedCodexCredentialStatusProvider, type CodexCredentialStatusProvider } from "../usage/codex-status.js";
import { OpenAiTransport } from "../providers/openai-transport.js";
import { OpenAiCompatibleTransport } from "../providers/openai-compatible-transport.js";
import { MySqlUsageRepository } from "../usage/mysql-repository.js";
import type { UsageRepository } from "../usage/repository.js";

export type RuntimeState = {
  aiAccess: AiAccessRepository;
  alerts: AlertRepository;
  audit: AuditRepository;
  codexStatusProvider?: CodexCredentialStatusProvider;
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
  const aiAccess = new MySqlAiAccessRepository(db);
  const alerts = new MySqlAlertRepository(db);
  const audit = new MySqlAuditRepository(db);
  const credentials = new MySqlCredentialRepository(db);
  const secrets = new MySqlSecretStore(db, secretKey);
  const leases = new MySqlLeaseRepository(db);
  const usage = new MySqlUsageRepository(db);

  return {
    aiAccess,
    alerts,
    audit,
    codexStatusProvider: createRuntimeCodexStatusProvider({ credentials, secrets }),
    credentials,
    secrets,
    leases,
    usage,
  };
}

function createRuntimeCodexStatusProvider(input: {
  credentials: CredentialRepository;
  secrets: SecretStore;
  now?: () => Date;
}): CodexCredentialStatusProvider {
  return new CachedCodexCredentialStatusProvider({
    loadCredentialAuthJson: async (credentialId) => {
      const record = await input.credentials.getCredentialRecordById(credentialId);
      if (!record) {
        return null;
      }

      const secret = await input.secrets.get(record.secretRef);
      return secret.kind === "codex_auth_json" ? secret.authJson : null;
    },
    saveCredentialAuthJson: async (credentialId, authJson) => {
      const record = await input.credentials.getCredentialRecordById(credentialId);
      if (!record) {
        return;
      }
      await input.secrets.replace(record.secretRef, {
        kind: "codex_auth_json",
        authJson,
      });
    },
    now: input.now,
  });
}

export function createDefaultProxyDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<ProxyDependencies, "gatewaySessions" | "openAiTransport" | "anthropicTransport" | "codexOAuthTransport" | "openAiCompatibleTransport">> & {
    openAiOAuth?: OpenAiOAuthClient;
    now?: () => Date;
  } = {},
): ProxyDependencies {
  const openAiOAuth = overrides.openAiOAuth ?? createDefaultOpenAiOAuthClient();
  const codexStatusProvider = runtime.codexStatusProvider ??
    createRuntimeCodexStatusProvider({
      credentials: runtime.credentials,
      secrets: runtime.secrets,
      now: overrides.now,
    });

  return {
    aiAccess: runtime.aiAccess,
    alertRepository: runtime.alerts,
    autoAssignedCodexCredentialRotation: createAutoAssignedCodexCredentialRotationService({
      aiAccess: runtime.aiAccess,
      credentials: runtime.credentials,
      codexStatusProvider,
      audit: runtime.audit,
      now: overrides.now,
    }),
    gatewaySessions: overrides.gatewaySessions ?? new DenGatewaySessionResolver({ denApiBase: env.denApiBase }),
    credentials: runtime.credentials,
    secrets: runtime.secrets,
    usageRepository: runtime.usage,
    leaseBroker: new LeaseBroker(
      runtime.leases,
      new DefaultBindingSelector({
        credentials: runtime.credentials,
        codexStatusProvider,
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
    openAiTransport: overrides.openAiTransport ?? new OpenAiTransport(),
    anthropicTransport: overrides.anthropicTransport ?? new AnthropicTransport(),
    codexOAuthTransport: overrides.codexOAuthTransport ?? new CodexOAuthInferenceProxyTransport(),
    openAiCompatibleTransport: overrides.openAiCompatibleTransport ?? new OpenAiCompatibleTransport(),
  };
}

export function createDefaultReadinessDependencies(runtime: RuntimeState): ReadinessDependencies {
  return {
    credentials: runtime.credentials,
    aiAccess: runtime.aiAccess,
  };
}

export function createDefaultUserCredentialDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<UserCredentialDependencies, "sessionResolver">> = {},
): UserCredentialDependencies {
  const codexStatusProvider = runtime.codexStatusProvider ??
    createRuntimeCodexStatusProvider({
      credentials: runtime.credentials,
      secrets: runtime.secrets,
    });

  return {
    sessionResolver: overrides.sessionResolver ?? new DenUserSessionResolver({ denApiBase: env.denApiBase }),
    aiAccess: runtime.aiAccess,
    autoAssignedCodexCredentialRotation: createAutoAssignedCodexCredentialRotationService({
      aiAccess: runtime.aiAccess,
      credentials: runtime.credentials,
      codexStatusProvider,
      audit: runtime.audit,
    }),
  };
}

function createDefaultOpenAiOAuthClient() {
  return new DefaultOpenAiOAuthClient({
    clientId: env.openAiOAuth.clientId,
    clientSecret: env.openAiOAuth.clientSecret,
    redirectBase: env.openAiOAuth.redirectBase,
  });
}
