import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createServer as createNetServer, type AddressInfo } from "node:net";

import { REDACTED_SECRET_VALUE, startServer } from "./server.js";

function createTestConfig() {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto" as const, timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli" as const,
    hostTokenSource: "cli" as const,
    logFormat: "pretty" as const,
    logRequests: false,
  };
}

async function withManagedAiEnv<T>(
  env: {
    managedAiBaseUrl?: string;
    legacyAiGatewayBaseUrl?: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const previousManagedAiBaseUrl = process.env.VESLO_MANAGED_AI_BASE_URL;
  const previousLegacyAiGatewayBaseUrl = process.env.VESLO_AI_GATEWAY_BASE_URL;

  if (env.managedAiBaseUrl === undefined) {
    delete process.env.VESLO_MANAGED_AI_BASE_URL;
  } else {
    process.env.VESLO_MANAGED_AI_BASE_URL = env.managedAiBaseUrl;
  }

  if (env.legacyAiGatewayBaseUrl === undefined) {
    delete process.env.VESLO_AI_GATEWAY_BASE_URL;
  } else {
    process.env.VESLO_AI_GATEWAY_BASE_URL = env.legacyAiGatewayBaseUrl;
  }

  try {
    return await fn();
  } finally {
    if (previousManagedAiBaseUrl === undefined) {
      delete process.env.VESLO_MANAGED_AI_BASE_URL;
    } else {
      process.env.VESLO_MANAGED_AI_BASE_URL = previousManagedAiBaseUrl;
    }

    if (previousLegacyAiGatewayBaseUrl === undefined) {
      delete process.env.VESLO_AI_GATEWAY_BASE_URL;
    } else {
      process.env.VESLO_AI_GATEWAY_BASE_URL = previousLegacyAiGatewayBaseUrl;
    }
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");
  return port;
}

async function listenTestServer(server: ReturnType<typeof createServer>): Promise<number> {
  const port = await reserveLoopbackPort();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return port;
}

function stopTestServer(server: ReturnType<typeof startServer>): void {
  (server as unknown as { stop: (closeActiveConnections?: boolean) => void }).stop(true);
}

describe("ai gateway proxy routes", () => {
  test("server proxies ai-gateway provider routes to the managed ai base url with gateway token and session id", async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
      gatewayToken: string | null;
      sessionId: string | null;
      hostToken: string | null;
      clientId: string | null;
      body: unknown;
    }> = [];

    const upstream = createServer(async (req, res) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "GET",
        pathname: req.url ?? "/",
        authorization: req.headers.authorization ?? null,
        gatewayToken: typeof req.headers["x-veslo-gateway-token"] === "string" ? req.headers["x-veslo-gateway-token"] : null,
        sessionId: typeof req.headers["x-veslo-session-id"] === "string" ? req.headers["x-veslo-session-id"] : null,
        hostToken: typeof req.headers["x-veslo-host-token"] === "string" ? req.headers["x-veslo-host-token"] : null,
        clientId: typeof req.headers["x-veslo-client-id"] === "string" ? req.headers["x-veslo-client-id"] : null,
        body: rawBody ? JSON.parse(rawBody) : null,
      });

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl_123",
        object: "chat.completion",
        model: "gpt-4o-mini",
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    const legacyUpstream = createServer((_req, res) => {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "wrong_upstream", message: "legacy ai gateway should not be used" }));
    });
    const legacyPort = await listenTestServer(legacyUpstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
          legacyAiGatewayBaseUrl: `http://127.0.0.1:${legacyPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/openai/v1/chat/completions`, {
              method: "POST",
              headers: {
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session_123",
                "x-veslo-client-id": "desktop-app",
                "x-veslo-host-token": "should-not-forward",
              },
              body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "Hello" }],
              }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
              id: "chatcmpl_123",
              object: "chat.completion",
              model: "gpt-4o-mini",
            });

            expect(requests).toEqual([
              {
                method: "POST",
                pathname: "/providers/openai/v1/chat/completions",
                authorization: "Bearer gateway-access-token",
                gatewayToken: null,
                sessionId: "session_123",
                hostToken: null,
                clientId: null,
                body: {
                  model: "gpt-4o-mini",
                  messages: [{ role: "user", content: "Hello" }],
                },
              },
            ]);
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      upstream.close();
      legacyUpstream.close();
      await once(upstream, "close");
      await once(legacyUpstream, "close");
    }
  });

  test("server proxies ai-gateway user ai access routes to the managed ai base url with caller auth", async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
      hostToken: string | null;
      clientId: string | null;
      body: unknown;
    }> = [];

    const upstream = createServer(async (req, res) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "GET",
        pathname: req.url ?? "/",
        authorization: req.headers.authorization ?? null,
        hostToken: typeof req.headers["x-veslo-host-token"] === "string" ? req.headers["x-veslo-host-token"] : null,
        clientId: typeof req.headers["x-veslo-client-id"] === "string" ? req.headers["x-veslo-client-id"] : null,
        body: rawBody ? JSON.parse(rawBody) : null,
      });

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        aiAccess: {
          id: "ai_access_user_123",
          userId: "user_123",
          enabled: true,
          provider: "openai",
          defaultModel: "gpt-4o-mini",
          allowedModels: ["gpt-4o-mini"],
          updatedAt: "2026-04-08T10:00:00.000Z",
        },
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    const legacyUpstream = createServer((_req, res) => {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "wrong_upstream", message: "legacy ai gateway should not be used" }));
    });
    const legacyPort = await listenTestServer(legacyUpstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
          legacyAiGatewayBaseUrl: `http://127.0.0.1:${legacyPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/me/ai-access`, {
              headers: {
                authorization: "Bearer client-token",
                "x-veslo-gateway-authorization": "Bearer den-user-token",
                "x-veslo-client-id": "desktop-app",
                "x-veslo-host-token": "should-not-forward",
              },
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
              aiAccess: {
                id: "ai_access_user_123",
                userId: "user_123",
                enabled: true,
                provider: "openai",
                defaultModel: "gpt-4o-mini",
                allowedModels: ["gpt-4o-mini"],
                updatedAt: "2026-04-08T10:00:00.000Z",
              },
            });

            expect(requests).toEqual([
              {
                method: "GET",
                pathname: "/api/me/ai-access",
                authorization: "Bearer den-user-token",
                hostToken: null,
                clientId: null,
                body: null,
              },
            ]);
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      upstream.close();
      legacyUpstream.close();
      await once(upstream, "close");
      await once(legacyUpstream, "close");
    }
  });

  test("server prefers VESLO_MANAGED_AI_BASE_URL over VESLO_AI_GATEWAY_BASE_URL", async () => {
    const managedRequests: string[] = [];
    const legacyRequests: string[] = [];

    const managedUpstream = createServer((_req, res) => {
      managedRequests.push("managed");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        aiAccess: {
          id: "ai_access_user_123",
          userId: "user_123",
          enabled: true,
          provider: "openai",
          defaultModel: "gpt-4o-mini",
          allowedModels: ["gpt-4o-mini"],
          updatedAt: "2026-04-08T10:00:00.000Z",
        },
      }));
    });
    const managedPort = await listenTestServer(managedUpstream);

    const legacyUpstream = createServer((_req, res) => {
      legacyRequests.push("legacy");
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "legacy should not be used" }));
    });
    const legacyPort = await listenTestServer(legacyUpstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${managedPort}`,
          legacyAiGatewayBaseUrl: `http://127.0.0.1:${legacyPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/me/ai-access`, {
              headers: {
                authorization: "Bearer client-token",
                "x-veslo-gateway-authorization": "Bearer den-user-token",
              },
            });

            expect(response.status).toBe(200);
            expect(managedRequests).toEqual(["managed"]);
            expect(legacyRequests).toEqual([]);
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      managedUpstream.close();
      legacyUpstream.close();
      await once(managedUpstream, "close");
      await once(legacyUpstream, "close");
    }
  });

  test("server redacts gateway access tokens and never returns provider secrets", async () => {
    const upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        accessToken: "gateway-access-token",
        refreshToken: "provider-refresh-token",
        aiAccess: {
          id: "ai_access_123",
          userId: "user_123",
          enabled: true,
          provider: "openai",
          defaultModel: "gpt-4o-mini",
          allowedModels: ["gpt-4o-mini"],
        },
        nested: {
          apiKey: "sk-live-openai",
          accessToken: "nested-access-token",
        },
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    const previousBaseUrl = process.env.VESLO_AI_GATEWAY_BASE_URL;
    process.env.VESLO_AI_GATEWAY_BASE_URL = `http://127.0.0.1:${upstreamPort}`;

    const server = startServer(createTestConfig());

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/me/ai-access`, {
        headers: {
          authorization: "Bearer client-token",
          "x-veslo-gateway-authorization": "Bearer den-user-token",
        },
      });

      expect(response.status).toBe(200);

      const payload = await response.json() as {
        accessToken: string;
        refreshToken: string;
        aiAccess: {
          defaultModel: string;
        };
        nested: {
          apiKey: string;
          accessToken: string;
        };
      };
      const serialized = JSON.stringify(payload);

      expect(serialized).not.toContain("gateway-access-token");
      expect(serialized).not.toContain("provider-refresh-token");
      expect(serialized).not.toContain("sk-live-openai");
      expect(serialized).not.toContain("nested-access-token");
      expect(payload.accessToken).toBe(REDACTED_SECRET_VALUE);
      expect(payload.refreshToken).toBe(REDACTED_SECRET_VALUE);
      expect(payload.aiAccess.defaultModel).toBe("gpt-4o-mini");
      expect(payload.nested.apiKey).toBe(REDACTED_SECRET_VALUE);
      expect(payload.nested.accessToken).toBe(REDACTED_SECRET_VALUE);
    } finally {
      stopTestServer(server);
      upstream.close();
      await once(upstream, "close");
      if (previousBaseUrl === undefined) {
        delete process.env.VESLO_AI_GATEWAY_BASE_URL;
      } else {
        process.env.VESLO_AI_GATEWAY_BASE_URL = previousBaseUrl;
      }
    }
  });
});
