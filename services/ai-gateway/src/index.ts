import express from "express";
import { pathToFileURL } from "node:url";

import { DenUserSessionResolver } from "./auth/user-session.js";
import { DefaultTokenBroker } from "./credentials/default-token-broker.js";
import { EncryptedSecretStore } from "./credentials/encrypted-secret-store.js";
import { DefaultOpenAiOAuthClient } from "./credentials/openai-oauth.js";
import type { CredentialBinding, CredentialRecord, CredentialRepository } from "./credentials/repository.js";
import { env } from "./env.js";
import { createAdminRouter, createDefaultAdminService, type AdminService } from "./http/admin.js";
import { createProxyRouter, type ProxyDependencies } from "./http/proxy.js";
import { createUserCredentialsRouter, type UserCredentialDependencies } from "./http/user-credentials.js";
import { DefaultBindingSelector } from "./leases/binding-selector.js";
import { LeaseBroker } from "./leases/lease-broker.js";
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "./leases/repository.js";
import { AnthropicTransport } from "./providers/anthropic-transport.js";
import { OpenAiTransport } from "./providers/openai-transport.js";

export type AppDependencies = {
  admin?: AdminService;
  proxy?: ProxyDependencies;
  userCredentials?: UserCredentialDependencies;
};

class InMemoryCredentialRepository implements CredentialRepository {
  private nextCredentialCounter = 0;
  private nextBindingCounter = 0;

  constructor(private readonly recordsByBindingId: Map<string, CredentialRecord>) {
    this.nextBindingCounter = this.recordsByBindingId.size;
    this.nextCredentialCounter = this.listUniqueRecords().length;
  }

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    for (const record of this.recordsByBindingId.values()) {
      if (record.id === credentialRecordId) {
        return record;
      }
    }

    return null;
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return this.listUniqueRecords()
      .filter((record) => record.state === "healthy")
      .map((record) => record.id);
  }

  async listEligibleBindings(input: {
    ownerUserId: string;
    provider: string;
    excludeBindingId?: string;
  }): Promise<CredentialBinding[]> {
    return Array.from(this.recordsByBindingId.entries())
      .filter(([bindingId, record]) => {
        if (record.state !== "healthy") return false;
        if (record.ownerUserId !== input.ownerUserId) return false;
        if (record.provider !== input.provider) return false;
        if (input.excludeBindingId && bindingId === input.excludeBindingId) return false;
        return true;
      })
      .map(([bindingId, record]) => ({
        id: bindingId,
        ownerUserId: record.ownerUserId,
        provider: record.provider,
        credentialRecordId: record.id,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    return this.recordsByBindingId.get(bindingId) ?? null;
  }

  async createUserCredential(input: {
    ownerUserId: string;
    provider: string;
    credentialType: "api_key" | "oauth";
    secretRef: string;
  }): Promise<CredentialRecord> {
    const createdAt = new Date();
    const credentialRecord: CredentialRecord = {
      id: `cred_${++this.nextCredentialCounter}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialType: input.credentialType,
      state: "healthy",
      secretRef: input.secretRef,
      createdAt,
      updatedAt: createdAt,
      lastFailureAt: null,
    };

    this.recordsByBindingId.set(`binding_${++this.nextBindingCounter}`, credentialRecord);
    return credentialRecord;
  }

  async listUserCredentials(input: { ownerUserId: string; provider: string }): Promise<CredentialRecord[]> {
    return this.listUniqueRecords().filter((record) => {
      return record.ownerUserId === input.ownerUserId && record.provider === input.provider;
    });
  }

  async revokeUserCredential(input: {
    ownerUserId: string;
    provider: string;
    credentialId: string;
  }): Promise<CredentialRecord | null> {
    const record = await this.getCredentialRecordById(input.credentialId);
    if (!record || record.ownerUserId !== input.ownerUserId || record.provider !== input.provider) {
      return null;
    }

    const revoked: CredentialRecord = {
      ...record,
      state: "revoked",
      updatedAt: new Date(),
    };

    for (const [bindingId, candidate] of this.recordsByBindingId.entries()) {
      if (candidate.id === input.credentialId) {
        this.recordsByBindingId.set(bindingId, revoked);
      }
    }

    return revoked;
  }

  async markCredentialState(input: { credentialRecordId: string; state: CredentialRecord["state"] }): Promise<void> {
    for (const [bindingId, record] of this.recordsByBindingId.entries()) {
      if (record.id !== input.credentialRecordId) continue;
      this.recordsByBindingId.set(bindingId, {
        ...record,
        state: input.state,
        updatedAt: new Date(),
        lastFailureAt: input.state === "healthy" ? null : new Date(),
      });
    }
  }

  private listUniqueRecords(): CredentialRecord[] {
    const uniqueRecords = new Map<string, CredentialRecord>();
    for (const record of this.recordsByBindingId.values()) {
      uniqueRecords.set(record.id, record);
    }
    return Array.from(uniqueRecords.values());
  }
}

class InMemoryLeaseRepository implements LeaseRepository {
  private readonly leasesByKey = new Map<string, SessionLease>();
  private leaseIdCounter = 0;

  async getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null> {
    return this.leasesByKey.get(leaseKey(input)) ?? null;
  }

  async createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    const key = leaseKey(input);
    const existing = this.leasesByKey.get(key);
    if (existing) {
      return existing;
    }

    const created: SessionLease = {
      id: `lease_${++this.leaseIdCounter}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    };

    this.leasesByKey.set(key, created);
    return created;
  }

  async rebindSessionLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    return this.rebindLease(input);
  }

  async rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    const key = leaseKey(input);
    const existing = this.leasesByKey.get(key);
    if (!existing || existing.activeBindingId !== input.expectedCurrentBindingId) {
      return null;
    }

    const rebound: SessionLease = {
      ...existing,
      activeBindingId: input.nextBindingId,
    };

    this.leasesByKey.set(key, rebound);
    return rebound;
  }
}

function leaseKey(input: ResolveLeaseInput): string {
  return `${input.ownerUserId}:${input.provider}:${input.sessionId}`;
}

type DefaultRuntimeState = {
  credentials: InMemoryCredentialRepository;
  secrets: EncryptedSecretStore;
  leases: InMemoryLeaseRepository;
};

function createDefaultRuntimeState(): DefaultRuntimeState {
  const credentials = new InMemoryCredentialRepository(
    new Map([
      [
        "default_binding",
        {
          id: "cred_default_1",
          ownerUserId: "system_default",
          provider: "openai",
          credentialType: "api_key",
          state: "healthy",
          secretRef: "secret_default_1",
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          lastFailureAt: null,
        },
      ],
    ]),
  );
  const secrets = new EncryptedSecretStore(env.secretKey, {
    secret_default_1: {
      kind: "api_key",
      apiKey: "dev_default_api_key",
    },
  });

  return {
    credentials,
    secrets,
    leases: new InMemoryLeaseRepository(),
  };
}

function createDefaultProxyDependencies(runtime: DefaultRuntimeState): ProxyDependencies {
  const leaseBroker = new LeaseBroker(
    runtime.leases,
    new DefaultBindingSelector(runtime.credentials),
  );
  const notConfiguredFetch: typeof fetch = async () => {
    throw new Error("provider_transport_not_configured");
  };

  return {
    leaseBroker,
    tokenBroker: new DefaultTokenBroker({
      credentials: runtime.credentials,
      secrets: runtime.secrets,
    }),
    openAiTransport: new OpenAiTransport({ fetchImpl: notConfiguredFetch }),
    anthropicTransport: new AnthropicTransport({ fetchImpl: notConfiguredFetch }),
  };
}

function createDefaultUserCredentialDependencies(runtime: DefaultRuntimeState): UserCredentialDependencies {
  return {
    sessionResolver: new DenUserSessionResolver({ denApiBase: env.denApiBase }),
    openAiOAuth: new DefaultOpenAiOAuthClient({
      clientId: env.openAiOAuth.clientId,
      clientSecret: env.openAiOAuth.clientSecret,
      redirectBase: env.openAiOAuth.redirectBase,
    }),
    credentials: runtime.credentials,
    secrets: runtime.secrets,
  };
}

export function createApp(deps: AppDependencies = {}) {
  const app = express();
  const runtime = createDefaultRuntimeState();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "ai-gateway" });
  });

  app.use(createAdminRouter(deps.admin ?? createDefaultAdminService(env.denApiBase)));
  app.use(createUserCredentialsRouter(deps.userCredentials ?? createDefaultUserCredentialDependencies(runtime)));
  app.use(createProxyRouter(deps.proxy ?? createDefaultProxyDependencies(runtime)));

  return app;
}

export function startServer() {
  const app = createApp();
  return app.listen(env.port, env.host, () => {
    console.log(`ai-gateway listening on http://${env.host}:${env.port}`);
  });
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startServer();
}
