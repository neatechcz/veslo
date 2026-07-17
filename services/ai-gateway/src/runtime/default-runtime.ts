import { MySqlAiAccessMutation, MySqlAiAccessRepository } from "../access/mysql-repository.js";
import { createAutoAssignedCodexCredentialRotationService } from "../access/auto-assignment-rotation.js";
import type { AiAccessMutation, AiAccessRepository } from "../access/repository.js";
import { MySqlAlertRepository } from "../alerts/mysql-repository.js";
import type { AlertRepository } from "../alerts/repository.js";
import { MySqlAuditRepository } from "../audit/mysql-repository.js";
import type { AuditRepository } from "../audit/repository.js";
import { DenGatewaySessionResolver } from "../auth/gateway-session.js";
import { DenUserSessionResolver } from "../auth/user-session.js";
import { DenManagedAiEntitlementResolver } from "../billing/den-managed-ai-entitlement-resolver.js";
import { DefaultTokenBroker } from "../credentials/default-token-broker.js";
import { MySqlCredentialRepository } from "../credentials/mysql-repository.js";
import { MySqlSecretStore } from "../credentials/mysql-secret-store.js";
import { DefaultOpenAiOAuthClient, type OpenAiOAuthClient } from "../credentials/openai-oauth.js";
import type { CredentialRepository } from "../credentials/repository.js";
import type { SecretStore } from "../credentials/secret-store.js";
import { createDb, type AiGatewayDb } from "../db/index.js";
import { env } from "../env.js";
import {
  MySqlAdminCredentialActionRepository,
  MySqlAdminCredentialReadRepository,
  MySqlAdminSessionReadRepository,
  type AdminServiceDependencies,
} from "../http/admin.js";
import type { ProxyDependencies } from "../http/proxy.js";
import type { ReadinessDependencies } from "../http/readiness.js";
import type { UserCredentialDependencies } from "../http/user-credentials.js";
import { DefaultBindingSelector } from "../leases/binding-selector.js";
import { LeaseBroker } from "../leases/lease-broker.js";
import { MySqlLeaseRepository } from "../leases/mysql-repository.js";
import type { LeaseRepository } from "../leases/repository.js";
import { MySqlPlatformModelPolicyMutation, MySqlPlatformModelPolicyRepository } from "../model-policy/mysql-repository.js";
import type { PlatformModelPolicyMutation, PlatformModelPolicyRepository } from "../model-policy/repository.js";
import { createPlatformModelCapabilityVerifier } from "../model-policy/capability-verifier.js";
import { AnthropicTransport } from "../providers/anthropic-transport.js";
import { CodexOAuthInferenceProxyTransport } from "../providers/codex-oauth-inference-proxy-transport.js";
import { CachedCodexCredentialStatusProvider } from "../usage/codex-status.js";
import { OpenAiTransport } from "../providers/openai-transport.js";
import { OpenAiCompatibleTransport } from "../providers/openai-compatible-transport.js";
import { MySqlUsageRepository } from "../usage/mysql-repository.js";
import type { UsageRepository } from "../usage/repository.js";

export type RuntimeState = {
  db: AiGatewayDb;
  aiAccess: AiAccessRepository;
  aiAccessMutation: AiAccessMutation;
  alerts: AlertRepository;
  audit: AuditRepository;
  credentials: CredentialRepository;
  secrets: SecretStore;
  leases: LeaseRepository;
  modelPolicy: PlatformModelPolicyRepository;
  modelPolicyMutation: PlatformModelPolicyMutation;
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
    db,
    aiAccess: new MySqlAiAccessRepository(db),
    aiAccessMutation: new MySqlAiAccessMutation(db),
    alerts: new MySqlAlertRepository(db),
    audit: new MySqlAuditRepository(db),
    credentials: new MySqlCredentialRepository(db),
    secrets: new MySqlSecretStore(db, secretKey),
    leases: new MySqlLeaseRepository(db),
    modelPolicy: new MySqlPlatformModelPolicyRepository(db),
    modelPolicyMutation: new MySqlPlatformModelPolicyMutation(db),
    usage: new MySqlUsageRepository(db),
  };
}

export function createDefaultAdminDependencies(
  runtime: RuntimeState,
): AdminServiceDependencies {
  const codexStatusProvider = createCodexStatusProvider(runtime);
  const openAiCompatibleTransport = new OpenAiCompatibleTransport();
  return {
    credentialReadRepository: new MySqlAdminCredentialReadRepository(runtime.db),
    credentialActionRepository: new MySqlAdminCredentialActionRepository(runtime.db),
    credentialWriteRepository: runtime.credentials as NonNullable<AdminServiceDependencies["credentialWriteRepository"]>,
    credentialSecretLookupRepository: runtime.credentials,
    sessionReadRepository: new MySqlAdminSessionReadRepository(runtime.db),
    aiAccessRepository: runtime.aiAccess,
    aiAccessMutation: runtime.aiAccessMutation,
    alertRepository: runtime.alerts,
    usageRepository: runtime.usage,
    auditRepository: runtime.audit,
    secretStore: runtime.secrets,
    codexStatusProvider,
    openAiCompatibleTransport,
    modelPolicyRepository: runtime.modelPolicy,
    modelPolicyMutation: runtime.modelPolicyMutation,
    modelCapabilities: createPlatformModelCapabilityVerifier({
      credentials: runtime.credentials,
      secrets: runtime.secrets,
      codexStatusProvider,
      openAiCompatibleTransport,
    }),
  };
}

export function createDefaultProxyDependencies(
  runtime: RuntimeState,
  overrides: Partial<Pick<ProxyDependencies, "gatewaySessions" | "openAiTransport" | "anthropicTransport" | "codexOAuthTransport" | "openAiCompatibleTransport">> & {
    managedAiEntitlement?: ProxyDependencies["managedAiEntitlement"];
    openAiOAuth?: OpenAiOAuthClient;
    now?: () => Date;
  } = {},
): ProxyDependencies {
  const openAiOAuth = overrides.openAiOAuth ?? createDefaultOpenAiOAuthClient();
  const codexStatusProvider = createCodexStatusProvider(runtime, overrides.now);

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
    managedAiEntitlement: overrides.managedAiEntitlement
      ?? new DenManagedAiEntitlementResolver({ denApiBase: env.denApiBase }),
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
    modelPolicy: runtime.modelPolicy,
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
  const openAiCompatibleTransport = new OpenAiCompatibleTransport();
  const codexStatusProvider = createCodexStatusProvider(runtime);
  return {
    credentials: runtime.credentials,
    aiAccess: runtime.aiAccess,
    modelPolicy: runtime.modelPolicy,
    modelCapabilities: createPlatformModelCapabilityVerifier({
      credentials: runtime.credentials,
      secrets: runtime.secrets,
      codexStatusProvider,
      openAiCompatibleTransport,
    }),
  };
}

function createCodexStatusProvider(runtime: RuntimeState, now?: () => Date) {
  return new CachedCodexCredentialStatusProvider({
    loadCredentialAuthJson: async (credentialId) => {
      const record = await runtime.credentials.getCredentialRecordById(credentialId);
      if (!record) return null;
      const secret = await runtime.secrets.get(record.secretRef);
      return secret.kind === "codex_auth_json" ? secret.authJson : null;
    },
    saveCredentialAuthJson: async (credentialId, authJson) => {
      const record = await runtime.credentials.getCredentialRecordById(credentialId);
      if (!record) return;
      await runtime.secrets.replace(record.secretRef, { kind: "codex_auth_json", authJson });
    },
    now,
  });
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
