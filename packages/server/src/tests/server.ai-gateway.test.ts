import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { brotliCompressSync } from "node:zlib";

import { REDACTED_SECRET_VALUE, startServer } from "../server.js";

const AI_GATEWAY_HEADERS_TIMEOUT_ENV = "VESLO_AI_GATEWAY_PROXY_HEADERS_TIMEOUT_MS";

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
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 5000,
    },
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

async function withEnvVar<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      workspaceId: string | null;
      sendTraceId: string | null;
      openCodeSessionId: string | null;
      sessionAffinity: string | null;
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
        workspaceId: typeof req.headers["x-veslo-workspace-id"] === "string" ? req.headers["x-veslo-workspace-id"] : null,
        sendTraceId: typeof req.headers["x-veslo-send-trace-id"] === "string" ? req.headers["x-veslo-send-trace-id"] : null,
        openCodeSessionId: typeof req.headers["x-session-id"] === "string" ? req.headers["x-session-id"] : null,
        sessionAffinity: typeof req.headers["x-session-affinity"] === "string" ? req.headers["x-session-affinity"] : null,
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
                "x-veslo-workspace-id": "ws_1",
                "x-veslo-send-trace-id": "send-trace-should-not-forward",
                "x-session-id": "opencode-local-session",
                "x-session-affinity": "opencode-local-affinity",
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
                workspaceId: null,
                sendTraceId: null,
                openCodeSessionId: null,
                sessionAffinity: null,
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

  test("server proxies ai-gateway codex_oauth chat completions route", async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
      gatewayToken: string | null;
      sessionId: string | null;
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
        body: rawBody ? JSON.parse(rawBody) : null,
      });

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl_codex_123",
        object: "chat.completion",
        model: "gpt-5.4",
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
              method: "POST",
              headers: {
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session_codex_123",
              },
              body: JSON.stringify({
                model: "gpt-5.4",
                messages: [{ role: "user", content: "Hello" }],
              }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
              id: "chatcmpl_codex_123",
              object: "chat.completion",
              model: "gpt-5.4",
            });

            expect(requests).toEqual([
              {
                method: "POST",
                pathname: "/providers/codex_oauth/v1/chat/completions",
                authorization: "Bearer gateway-access-token",
                gatewayToken: null,
                sessionId: "session_codex_123",
                body: {
                  model: "gpt-5.4",
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
      await once(upstream, "close");
    }
  });

  test("server reports upstream codex_oauth html blocks as gateway diagnostics", async () => {
    const upstream = createServer((_req, res) => {
      res.statusCode = 403;
      res.statusMessage = "Forbidden";
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("x-request-id", "upstream-request-123");
      res.end("<!doctype html><html><head><title>Blocked</title></head><body>Blocked by gateway gateway-access-token</body></html>");
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
              method: "POST",
              headers: {
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session_codex_blocked_123",
                "x-veslo-account-id": "user_123",
                "x-veslo-den-org-id": "org_123",
              },
              body: JSON.stringify({
                model: "gpt-5.4",
                messages: [{ role: "user", content: "Hello" }],
              }),
            });

            expect(response.status).toBe(502);
            expect(response.headers.get("content-type")).toContain("application/json");

            const payload = await response.json() as {
              code: string;
              message: string;
              details: {
                requestId: string;
                provider: string;
                model: string;
                sessionId: string;
                userId: string;
                orgId: string;
                upstreamStatus: number;
                upstreamStatusText: string;
                upstreamRequestId: string;
                upstreamContentType: string;
                upstreamResponse: string;
              };
            };

            expect(payload.code).toBe("ai_gateway_upstream_failed");
            expect(payload.message).toBe("AI gateway upstream request failed");
            expect(payload.details.requestId).toBeString();
            expect(payload.details.provider).toBe("codex_oauth");
            expect(payload.details.model).toBe("gpt-5.4");
            expect(payload.details.sessionId).toBe("session_codex_blocked_123");
            expect(payload.details.userId).toBe("user_123");
            expect(payload.details.orgId).toBe("org_123");
            expect(payload.details.upstreamStatus).toBe(403);
            expect(payload.details.upstreamStatusText).toBe("Forbidden");
            expect(payload.details.upstreamRequestId).toBe("upstream-request-123");
            expect(payload.details.upstreamContentType).toBe("text/html; charset=utf-8");
            expect(payload.details.upstreamResponse).toContain("<title>Blocked</title>");
            expect(payload.details.upstreamResponse).not.toContain("gateway-access-token");
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      upstream.close();
      await once(upstream, "close");
    }
  });

  test("server reports truncated diagnostics for oversized upstream ai-gateway errors", async () => {
    const oversizedMarker = "tail-marker-should-not-be-read";
    const oversizedBody = `${"blocked ".repeat(20_000)}${oversizedMarker}`;
    const upstream = createServer((_req, res) => {
      res.statusCode = 502;
      res.statusMessage = "Bad Gateway";
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("content-length", String(Buffer.byteLength(oversizedBody, "utf8")));
      res.end(oversizedBody);
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
              method: "POST",
              headers: {
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session_oversized_error_123",
              },
              body: JSON.stringify({
                model: "gpt-5.5",
                messages: [{ role: "user", content: "Hello" }],
              }),
            });

            expect(response.status).toBe(502);
            const payload = await response.json() as {
              details: {
                upstreamResponse: string;
                upstreamResponseTruncated?: boolean;
              };
            };
            expect(payload.details.upstreamResponseTruncated).toBe(true);
            expect(payload.details.upstreamResponse.length).toBeLessThan(2_000);
            expect(payload.details.upstreamResponse).not.toContain(oversizedMarker);
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      upstream.close();
      await once(upstream, "close");
    }
  });

  test("server streams oversized successful ai-gateway json responses without parsing them", async () => {
    const body = JSON.stringify({
      id: "chatcmpl_large_json_123",
      object: "chat.completion",
      choices: [
        {
          message: {
            role: "assistant",
            content: "large-json ".repeat(20_000),
          },
        },
      ],
    });
    const upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("content-length", String(Buffer.byteLength(body, "utf8")));
      res.setHeader("x-upstream-marker", "large-json");
      res.end(body);
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
              method: "POST",
              headers: {
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session_large_json_123",
              },
              body: JSON.stringify({
                model: "gpt-5.5",
                messages: [{ role: "user", content: "Hello" }],
              }),
            });

            expect(response.status).toBe(200);
            expect(response.headers.get("x-upstream-marker")).toBe("large-json");
            expect(await response.text()).toBe(body);
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      upstream.close();
      await once(upstream, "close");
    }
  });

  test("server strips compression headers from streamed ai-gateway responses", async () => {
    const requests: Array<{
      acceptEncoding: string | null;
    }> = [];
    const eventStream = 'data: {"id":"chatcmpl_stream_123"}\n\n';
    const compressedEventStream = brotliCompressSync(Buffer.from(eventStream, "utf8"));

    const upstream = createServer(async (req, res) => {
      requests.push({
        acceptEncoding: typeof req.headers["accept-encoding"] === "string" ? req.headers["accept-encoding"] : null,
      });

      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("content-encoding", "br");
      res.setHeader("content-length", String(compressedEventStream.byteLength));
      res.end(compressedEventStream);
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
              method: "POST",
              headers: {
                "accept-encoding": "br",
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session_stream_123",
              },
              body: JSON.stringify({
                model: "gpt-5.5",
                messages: [{ role: "user", content: "Hello" }],
                stream: true,
              }),
            });

            expect(response.status).toBe(200);
            expect(response.headers.get("content-encoding")).toBeNull();
            expect(await response.text()).toBe(eventStream);
            expect(requests).toEqual([{ acceptEncoding: "identity" }]);
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      upstream.close();
      await once(upstream, "close");
    }
  });

  test("server forwards streaming ai-gateway request bodies before the client finishes uploading", async () => {
    let upstreamReceivedFirstChunk!: Promise<void>;
    let resolveUpstreamReceivedFirstChunk!: () => void;
    upstreamReceivedFirstChunk = new Promise((resolve) => {
      resolveUpstreamReceivedFirstChunk = resolve;
    });

    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.once("data", () => {
        resolveUpstreamReceivedFirstChunk();
      });
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl_streamed_request_123",
        object: "chat.completion",
        model: JSON.parse(rawBody).model,
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());
          const encoder = new TextEncoder();
          let controller!: ReadableStreamDefaultController<Uint8Array>;
          const body = new ReadableStream<Uint8Array>({
            start(nextController) {
              controller = nextController;
              controller.enqueue(encoder.encode('{"model":"gpt-5.5","messages":[{"role":"user","content":"'));
            },
          });

          try {
            const responsePromise = fetch(
              `http://127.0.0.1:${server.port}/ai-gateway/providers/codex_oauth/v1/chat/completions`,
              {
                method: "POST",
                headers: {
                  authorization: "Bearer client-token",
                  "content-type": "application/json",
                  "x-veslo-gateway-token": "gateway-access-token",
                  "x-veslo-session-id": "session_streamed_request_123",
                },
                body,
                duplex: "half",
              } as RequestInit & { duplex: "half" },
            );

            const reachedUpstreamBeforeUploadFinished = await Promise.race([
              upstreamReceivedFirstChunk.then(() => true),
              delay(250).then(() => false),
            ]);

            controller.enqueue(encoder.encode('Hello"}],"stream":true}'));
            controller.close();

            const response = await responsePromise;
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
              id: "chatcmpl_streamed_request_123",
              object: "chat.completion",
              model: "gpt-5.5",
            });
            expect(reachedUpstreamBeforeUploadFinished).toBe(true);
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      upstream.close();
      await once(upstream, "close");
    }
  });

  test("server proxies ai-gateway openai_compatible chat completions route", async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
      gatewayToken: string | null;
      sessionId: string | null;
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
        body: rawBody ? JSON.parse(rawBody) : null,
      });

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl_custom_123",
        object: "chat.completion",
        model: "custom-model",
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/openai_compatible/v1/chat/completions`, {
              method: "POST",
              headers: {
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session_custom_123",
              },
              body: JSON.stringify({
                model: "custom-model",
                messages: [{ role: "user", content: "Hello" }],
              }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
              id: "chatcmpl_custom_123",
              object: "chat.completion",
              model: "custom-model",
            });

            expect(requests).toEqual([
              {
                method: "POST",
                pathname: "/providers/openai_compatible/v1/chat/completions",
                authorization: "Bearer gateway-access-token",
                gatewayToken: null,
                sessionId: "session_custom_123",
                body: {
                  model: "custom-model",
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
      await once(upstream, "close");
    }
  });

  test("server proxies ai-gateway codex_oauth gpt-5.5 chat completions unchanged", async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
      gatewayToken: string | null;
      sessionId: string | null;
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
        body: rawBody ? JSON.parse(rawBody) : null,
      });

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl_codex_55_123",
        object: "chat.completion",
        model: "gpt-5.5",
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/providers/codex_oauth/v1/chat/completions`, {
              method: "POST",
              headers: {
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session_codex_55_123",
              },
              body: JSON.stringify({
                model: "gpt-5.5",
                messages: [{ role: "user", content: "Hello" }],
              }),
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
              id: "chatcmpl_codex_55_123",
              object: "chat.completion",
              model: "gpt-5.5",
            });

            expect(requests).toEqual([
              {
                method: "POST",
                pathname: "/providers/codex_oauth/v1/chat/completions",
                authorization: "Bearer gateway-access-token",
                gatewayToken: null,
                sessionId: "session_codex_55_123",
                body: {
                  model: "gpt-5.5",
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
      await once(upstream, "close");
    }
  });

  test("server proxies mounted ai-gateway provider routes", async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
      gatewayToken: string | null;
      sessionId: string | null;
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
        body: rawBody ? JSON.parse(rawBody) : null,
      });

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl_mounted_123",
        object: "chat.completion",
        model: "gpt-5.4",
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer({
            ...createTestConfig(),
            workspaces: [
              {
                id: "ws_1",
                name: "Workspace",
                path: "/tmp/veslo-mounted-ai-gateway",
                workspaceType: "local" as const,
              },
            ],
          });

          try {
            const response = await fetch(
              `http://127.0.0.1:${server.port}/w/ws_1/ai-gateway/providers/codex_oauth/v1/chat/completions`,
              {
                method: "POST",
                headers: {
                  authorization: "Bearer client-token",
                  "content-type": "application/json",
                  "x-veslo-gateway-token": "gateway-access-token",
                  "x-veslo-session-id": "session_codex_mounted_123",
                },
                body: JSON.stringify({
                  model: "gpt-5.4",
                  messages: [{ role: "user", content: "Hello" }],
                }),
              },
            );

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
              id: "chatcmpl_mounted_123",
              object: "chat.completion",
              model: "gpt-5.4",
            });

            expect(requests).toEqual([
              {
                method: "POST",
                pathname: "/providers/codex_oauth/v1/chat/completions",
                authorization: "Bearer gateway-access-token",
                gatewayToken: null,
                sessionId: "session_codex_mounted_123",
                body: {
                  model: "gpt-5.4",
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
      await once(upstream, "close");
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

  test("server redacts bare caller auth tokens from upstream ai-access failures", async () => {
    const upstream = createServer((_req, res) => {
      res.statusCode = 403;
      res.statusMessage = "Forbidden";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: "blocked",
        detail: "token den-user-token was rejected by policy",
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
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

            expect(response.status).toBe(502);
            const payload = await response.json() as {
              details: {
                upstreamResponse: string;
              };
            };
            expect(payload.details.upstreamResponse).toContain(REDACTED_SECRET_VALUE);
            expect(payload.details.upstreamResponse).not.toContain("den-user-token");
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      upstream.close();
      await once(upstream, "close");
    }
  });

  test("server proxies ai-gateway readiness to the readiness endpoint instead of health", async () => {
    const requests: Array<{
      method: string;
      pathname: string;
      authorization: string | null;
    }> = [];

    const upstream = createServer((req, res) => {
      requests.push({
        method: req.method ?? "GET",
        pathname: req.url ?? "/",
        authorization: req.headers.authorization ?? null,
      });

      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: false,
        service: "ai-gateway",
        status: "not_ready",
        checks: {
          providerReachability: { ok: false, probes: [] },
          credentials: { ok: true, healthyCredentialCount: 1 },
          aiAccessPolicies: { ok: true, enabledPolicyCount: 1 },
        },
      }));
    });
    const upstreamPort = await listenTestServer(upstream);

    try {
      await withManagedAiEnv(
        {
          managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}`,
        },
        async () => {
          const server = startServer(createTestConfig());

          try {
            const response = await fetch(`http://127.0.0.1:${server.port}/ai-gateway/readiness`, {
              headers: {
                authorization: "Bearer client-token",
                "x-veslo-gateway-authorization": "Bearer den-user-token",
              },
            });

            expect(response.status).toBe(503);
            const payload = await response.json() as { status: string; ok: boolean };
            expect(payload.ok).toBe(false);
            expect(payload.status).toBe("not_ready");
            expect(requests).toEqual([
              {
                method: "GET",
                pathname: "/readiness",
                authorization: "Bearer den-user-token",
              },
            ]);
          } finally {
            stopTestServer(server);
          }
        },
      );
    } finally {
      upstream.close();
      await once(upstream, "close");
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

  test("server preserves the ai-access gateway token while redacting provider secrets", async () => {
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

      expect(serialized).not.toContain("provider-refresh-token");
      expect(serialized).not.toContain("sk-live-openai");
      expect(serialized).not.toContain("nested-access-token");
      expect(payload.accessToken).toBe("gateway-access-token");
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

  test("server returns 504 when ai gateway upstream never sends response headers", async () => {
    await withEnvVar(AI_GATEWAY_HEADERS_TIMEOUT_ENV, "300", async () => {
      const upstream = createServer((_req, _res) => {
        // Keep the socket open without response headers to simulate a wedged
        // managed AI gateway/provider before the streaming response starts.
      });
      const upstreamPort = await listenTestServer(upstream);

      await withManagedAiEnv({ managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}` }, async () => {
        const server = startServer(createTestConfig());

        try {
          const start = Date.now();
          const response = await fetch(
            `http://127.0.0.1:${server.port}/ai-gateway/providers/codex_oauth/v1/chat/completions`,
            {
              method: "POST",
              headers: {
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session-timeout",
              },
              body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hello" }] }),
            },
          );
          const elapsed = Date.now() - start;
          const body = await response.json() as { code?: string; details?: { timeoutMs?: number } };

          expect(response.status).toBe(504);
          expect(body.code).toBe("ai_gateway_timeout");
          expect(body.details?.timeoutMs).toBe(300);
          expect(elapsed).toBeLessThan(5_000);
        } finally {
          stopTestServer(server);
          upstream.closeAllConnections();
          upstream.close();
          await once(upstream, "close");
        }
      });
    });
  });

  test("ai gateway headers timeout does not cut streaming response bodies", async () => {
    await withEnvVar(AI_GATEWAY_HEADERS_TIMEOUT_ENV, "300", async () => {
      const upstream = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => {
          res.end("data: two\n\n");
        }, 450);
      });
      const upstreamPort = await listenTestServer(upstream);

      await withManagedAiEnv({ managedAiBaseUrl: `http://127.0.0.1:${upstreamPort}` }, async () => {
        const server = startServer(createTestConfig());

        try {
          const response = await fetch(
            `http://127.0.0.1:${server.port}/ai-gateway/providers/codex_oauth/v1/chat/completions`,
            {
              method: "POST",
              headers: {
                authorization: "Bearer client-token",
                "content-type": "application/json",
                "x-veslo-gateway-token": "gateway-access-token",
                "x-veslo-session-id": "session-stream",
              },
              body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hello" }] }),
            },
          );

          expect(response.status).toBe(200);
          const text = await response.text();
          expect(text).toContain("data: one");
          expect(text).toContain("data: two");
        } finally {
          stopTestServer(server);
          upstream.closeAllConnections();
          upstream.close();
          await once(upstream, "close");
        }
      });
    });
  });
});
