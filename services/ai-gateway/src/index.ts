import express from "express";
import { pathToFileURL } from "node:url";

import { DefaultTokenBroker } from "./credentials/default-token-broker.js";
import { EncryptedSecretStore } from "./credentials/encrypted-secret-store.js";
import type { CredentialBinding, CredentialRecord, CredentialRepository } from "./credentials/repository.js";
import { env } from "./env.js";
import { createAdminRouter, createDefaultAdminService, type AdminService } from "./http/admin.js";
import { createProxyRouter, type ProxyDependencies } from "./http/proxy.js";
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
};

class InMemoryCredentialRepository implements CredentialRepository {
  constructor(private readonly recordsByBindingId: Map<string, CredentialRecord>) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    for (const record of this.recordsByBindingId.values()) {
      if (record.id === credentialRecordId) {
        return record;
      }
    }

    return null;
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return Array.from(this.recordsByBindingId.values())
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

  async markCredentialState(input: { credentialRecordId: string; state: CredentialRecord["state"] }): Promise<void> {
    for (const [bindingId, record] of this.recordsByBindingId.entries()) {
      if (record.id !== input.credentialRecordId) continue;
      this.recordsByBindingId.set(bindingId, {
        ...record,
        state: input.state,
      });
    }
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

function createDefaultProxyDependencies(): ProxyDependencies {
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
  const leaseBroker = new LeaseBroker(
    new InMemoryLeaseRepository(),
    new DefaultBindingSelector(credentials),
  );
  const notConfiguredFetch: typeof fetch = async () => {
    throw new Error("provider_transport_not_configured");
  };

  return {
    leaseBroker,
    tokenBroker: new DefaultTokenBroker({
      credentials,
      secrets,
    }),
    openAiTransport: new OpenAiTransport({ fetchImpl: notConfiguredFetch }),
    anthropicTransport: new AnthropicTransport({ fetchImpl: notConfiguredFetch }),
  };
}

export function createApp(deps: AppDependencies = {}) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "ai-gateway" });
  });

  app.use(createAdminRouter(deps.admin ?? createDefaultAdminService(env.denApiBase)));
  app.use(createProxyRouter(deps.proxy ?? createDefaultProxyDependencies()));

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
