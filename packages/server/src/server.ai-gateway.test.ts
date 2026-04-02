import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

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

describe("ai gateway proxy routes", () => {
  test("server proxies ai-gateway credential routes with caller auth", async () => {
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
        credential: {
          id: "cred_1",
          provider: "anthropic",
          credentialType: "api_key",
          state: "healthy",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
          lastFailureAt: null,
        },
      }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const previousBaseUrl = process.env.VESLO_AI_GATEWAY_BASE_URL;
    process.env.VESLO_AI_GATEWAY_BASE_URL = `http://127.0.0.1:${upstreamPort}`;

    const server = startServer(createTestConfig());

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/anthropic/api-keys`, {
        method: "POST",
        headers: {
          authorization: "Bearer client-token",
          "content-type": "application/json",
          "x-veslo-gateway-authorization": "Bearer den-user-token",
          "x-veslo-client-id": "desktop-app",
          "x-veslo-host-token": "should-not-forward",
        },
        body: JSON.stringify({ apiKey: "sk-ant-secret" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        credential: {
          id: "cred_1",
          provider: "anthropic",
          credentialType: "api_key",
          state: "healthy",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
          lastFailureAt: null,
        },
      });

      expect(requests).toEqual([
        {
          method: "POST",
          pathname: "/api/providers/anthropic/api-keys",
          authorization: "Bearer den-user-token",
          hostToken: null,
          clientId: null,
          body: { apiKey: "sk-ant-secret" },
        },
      ]);
    } finally {
      server.stop(true);
      upstream.close();
      await once(upstream, "close");
      if (previousBaseUrl === undefined) {
        delete process.env.VESLO_AI_GATEWAY_BASE_URL;
      } else {
        process.env.VESLO_AI_GATEWAY_BASE_URL = previousBaseUrl;
      }
    }
  });

  test("server redacts gateway access tokens and never returns provider secrets", async () => {
    const upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        accessToken: "gateway-access-token",
        refreshToken: "provider-refresh-token",
        credentials: [
          {
            id: "cred_1",
            provider: "openai",
            credentialType: "oauth",
            state: "healthy",
            apiKey: "sk-live-openai",
            nested: {
              accessToken: "nested-access-token",
            },
          },
        ],
      }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const previousBaseUrl = process.env.VESLO_AI_GATEWAY_BASE_URL;
    process.env.VESLO_AI_GATEWAY_BASE_URL = `http://127.0.0.1:${upstreamPort}`;

    const server = startServer(createTestConfig());

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/openai/credentials`, {
        headers: {
          authorization: "Bearer client-token",
          "x-veslo-gateway-authorization": "Bearer den-user-token",
        },
      });

      expect(response.status).toBe(200);

      const payload = await response.json() as {
        accessToken: string;
        refreshToken: string;
        credentials: Array<{
          apiKey: string;
          nested: { accessToken: string };
        }>;
      };
      const serialized = JSON.stringify(payload);

      expect(serialized).not.toContain("gateway-access-token");
      expect(serialized).not.toContain("provider-refresh-token");
      expect(serialized).not.toContain("sk-live-openai");
      expect(serialized).not.toContain("nested-access-token");
      expect(payload.accessToken).toBe(REDACTED_SECRET_VALUE);
      expect(payload.refreshToken).toBe(REDACTED_SECRET_VALUE);
      expect(payload.credentials[0]?.apiKey).toBe(REDACTED_SECRET_VALUE);
      expect(payload.credentials[0]?.nested.accessToken).toBe(REDACTED_SECRET_VALUE);
    } finally {
      server.stop(true);
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
