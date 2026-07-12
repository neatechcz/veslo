import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiCompatibleTransport } from "../src/providers/openai-compatible-transport.js";
import { ProviderTransportError } from "../src/providers/transport.js";

const INPUT = {
  apiKey: "secret-model-key",
  baseUrl: "https://models.example.test/v1",
};

function assertTransportError(error: unknown, code: string, statusCode: number) {
  return error instanceof ProviderTransportError
    && error.code === code
    && error.statusCode === statusCode;
}

test("model discovery aborts at its bounded timeout", async () => {
  const transport = new OpenAiCompatibleTransport({
    timeoutMs: 10,
    resolveHostname: async () => ["93.184.216.34"],
    fetchImpl: ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as typeof fetch,
  });

  await assert.rejects(
    transport.listModels(INPUT),
    (error) => assertTransportError(error, "openai_compatible_models_timeout", 504),
  );
});

test("model discovery rejects oversized response bodies before JSON parsing", async () => {
  const transport = new OpenAiCompatibleTransport({
    maxModelResponseBytes: 32,
    resolveHostname: async () => ["93.184.216.34"],
    fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: "x".repeat(100) }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await assert.rejects(
    transport.listModels(INPUT),
    (error) => assertTransportError(error, "openai_compatible_models_response_too_large", 502),
  );
});

test("model discovery rejects redirects without forwarding bearer credentials", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const transport = new OpenAiCompatibleTransport({
    resolveHostname: async () => ["93.184.216.34"],
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, {
        status: 302,
        headers: { location: "https://redirected.example.test/models" },
      });
    }) as typeof fetch,
  });

  await assert.rejects(
    transport.listModels(INPUT),
    (error) => assertTransportError(error, "openai_compatible_models_redirect_blocked", 502),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.redirect, "manual");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)?.authorization, "Bearer secret-model-key");
});

test("model discovery rejects literal and DNS-resolved private or reserved targets", async () => {
  let fetchCalls = 0;
  const transport = new OpenAiCompatibleTransport({
    resolveHostname: async (hostname: string) =>
      hostname === "private.example.test" ? ["10.20.30.40"] : ["93.184.216.34"],
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await assert.rejects(
    transport.listModels({ ...INPUT, baseUrl: "https://203.0.113.10/v1" }),
    (error) => assertTransportError(error, "openai_compatible_models_target_not_allowed", 400),
  );
  await assert.rejects(
    transport.listModels({ ...INPUT, baseUrl: "https://private.example.test/v1" }),
    (error) => assertTransportError(error, "openai_compatible_models_target_not_allowed", 400),
  );
  assert.equal(fetchCalls, 0);
});

test("model discovery allows the existing explicit development loopback path", async () => {
  let resolverCalls = 0;
  const transport = new OpenAiCompatibleTransport({
    resolveHostname: async () => {
      resolverCalls += 1;
      return ["127.0.0.1"];
    },
    fetchImpl: (async () => new Response(JSON.stringify({
      data: [{ id: "local/model" }],
    }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  assert.deepEqual(await transport.listModels({
    apiKey: "local-key",
    baseUrl: "http://127.0.0.1:11434/v1",
  }), { models: ["local/model"] });
  assert.equal(resolverCalls, 0);
});

test("model discovery preserves transient DNS failures as service unavailable", async () => {
  const transport = new OpenAiCompatibleTransport({
    resolveHostname: async () => {
      throw new Error("dns unavailable");
    },
    fetchImpl: (async () => assert.fail("fetch must not run after DNS failure")) as typeof fetch,
  });

  await assert.rejects(
    transport.listModels(INPUT),
    (error) => assertTransportError(error, "openai_compatible_models_dns_failed", 503),
  );
});
