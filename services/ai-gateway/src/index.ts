import express from "express";
import { pathToFileURL } from "node:url";

import { DefaultTokenBroker } from "./credentials/default-token-broker.js";
import { EncryptedSecretStore } from "./credentials/encrypted-secret-store.js";
import type { CredentialRecord, CredentialRepository } from "./credentials/repository.js";
import { env } from "./env.js";
import { createAdminRouter, createDefaultAdminService, type AdminService } from "./http/admin.js";
import { createProxyRouter, type ProxyDependencies } from "./http/proxy.js";
import { LeaseBroker, type BindingSelector } from "./leases/lease-broker.js";
import type { LeaseRepository, RebindSessionLeaseInput, SessionLease } from "./leases/repository.js";

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
  private readonly leasesBySession = new Map<string, SessionLease>();
  private leaseIdCounter = 0;

  async getActiveLeaseBySessionId(sessionId: string): Promise<SessionLease | null> {
    return this.leasesBySession.get(sessionId) ?? null;
  }

  async createSessionLeaseIfMissing(input: { sessionId: string; activeBindingId: string }): Promise<SessionLease> {
    const existing = this.leasesBySession.get(input.sessionId);
    if (existing) {
      return existing;
    }

    const created: SessionLease = {
      id: `lease_${++this.leaseIdCounter}`,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    };

    this.leasesBySession.set(input.sessionId, created);
    return created;
  }

  async rebindSessionLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    const existing = this.leasesBySession.get(input.sessionId);
    if (!existing || existing.activeBindingId !== input.expectedCurrentBindingId) {
      return null;
    }

    const rebound: SessionLease = {
      ...existing,
      activeBindingId: input.nextBindingId,
    };

    this.leasesBySession.set(input.sessionId, rebound);
    return rebound;
  }
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
  const leaseBroker = new LeaseBroker(new InMemoryLeaseRepository(), {
    async selectInitialBinding() {
      return "default_binding";
    },
    async selectReplacementBinding(input) {
      return input.previousBindingId;
    },
  } satisfies BindingSelector);

  return {
    leaseBroker,
    tokenBroker: new DefaultTokenBroker({
      credentials,
      secrets,
    }),
    transport: {
      async chatCompletions() {
        throw new Error("provider_transport_not_configured");
      },
    },
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
