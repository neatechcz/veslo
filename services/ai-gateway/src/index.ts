import express from "express";
import { pathToFileURL } from "node:url";

import type { UpstreamAuth } from "./credentials/token-broker.js";
import { env } from "./env.js";
import { createProxyRouter, type ProxyDependencies } from "./http/proxy.js";
import { LeaseBroker, type BindingSelector } from "./leases/lease-broker.js";
import type { LeaseRepository, RebindSessionLeaseInput, SessionLease } from "./leases/repository.js";

export type AppDependencies = {
  proxy?: ProxyDependencies;
};

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
    tokenBroker: {
      async getUpstreamAuth(): Promise<UpstreamAuth> {
        throw new Error("token_broker_not_configured");
      },
    },
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
