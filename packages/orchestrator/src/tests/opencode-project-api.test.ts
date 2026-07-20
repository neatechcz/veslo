import { describe, expect, test } from "bun:test";

import {
  createOpenCodeMcpRuntimePrimeFlights,
  observeOpenCodeMcpRuntimePrime,
  primeOpenCodeMcpRuntime,
  probeOpenCodeProjectApi,
} from "../opencode-project-api.js";

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probeOpenCodeProjectApi", () => {
  test("reports available when project, config, and provider endpoints respond", async () => {
    const urls: string[] = [];
    const result = await probeOpenCodeProjectApi({
      baseUrl: "http://127.0.0.1:7001",
      directory: "/repo/app",
      fetchImpl: async (url) => {
        urls.push(String(url));
        return response(200);
      },
    });

    expect(result.available).toBe(true);
    expect(result.project.ok).toBe(true);
    expect(result.config?.ok).toBe(true);
    expect(result.provider?.ok).toBe(true);
    expect(urls).toEqual([
      "http://127.0.0.1:7001/project",
      "http://127.0.0.1:7001/config?directory=%2Frepo%2Fapp",
      "http://127.0.0.1:7001/provider?directory=%2Frepo%2Fapp",
    ]);
  });

  test("reports unavailable when project endpoint is missing", async () => {
    const result = await probeOpenCodeProjectApi({
      baseUrl: "http://127.0.0.1:7001/",
      directory: "/repo/app",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/project")) return response(404);
        return response(200);
      },
    });

    expect(result.available).toBe(false);
    expect(result.project.status).toBe(404);
    expect(result.config).toBeUndefined();
    expect(result.provider).toBeUndefined();
  });

  test("turns fetch errors into unavailable probe results", async () => {
    const result = await probeOpenCodeProjectApi({
      baseUrl: "http://127.0.0.1:7001",
      directory: "/repo/app",
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result.available).toBe(false);
    expect(result.project.error).toContain("connection refused");
  });

  test("primes MCP through the directory-scoped status endpoint without throwing", async () => {
    const urls: string[] = [];
    const result = await primeOpenCodeMcpRuntime({
      baseUrl: "http://127.0.0.1:7001/",
      directory: "/repo/app",
      fetchImpl: async (url) => {
        urls.push(String(url));
        return response(200);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      baseUrl: "http://127.0.0.1:7001",
      directory: "/repo/app",
    });
    expect(urls).toEqual(["http://127.0.0.1:7001/mcp?directory=%2Frepo%2Fapp"]);
  });

  test("reports an MCP prime transport failure instead of rejecting", async () => {
    const result = await primeOpenCodeMcpRuntime({
      baseUrl: "http://127.0.0.1:7001",
      directory: "/repo/app",
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("connection refused");
  });

  test("joins an activation MCP prime for the matching workspace", async () => {
    let resolvePrime!: (result: { ok: boolean; baseUrl: string; directory: string }) => void;
    let calls = 0;
    const flights = createOpenCodeMcpRuntimePrimeFlights({
      prime: async () => {
        calls += 1;
        return await new Promise((resolve) => {
          resolvePrime = resolve;
        });
      },
    });

    const owner = flights.start({
      workspaceId: "ws-a",
      baseUrl: "http://127.0.0.1:7001",
      directory: "/repo/a",
    });
    const joined = flights.start({
      workspaceId: "ws-a",
      baseUrl: "http://127.0.0.1:7001",
      directory: "/repo/a",
    });
    expect(owner.owner).toBe(true);
    expect(joined.owner).toBe(false);
    expect(calls).toBe(0);

    await Promise.resolve();
    expect(calls).toBe(1);
    expect(flights.join("ws-a")).toBe(owner.promise);
    resolvePrime({ ok: true, baseUrl: "http://127.0.0.1:7001", directory: "/repo/a" });
    await expect(joined.promise).resolves.toMatchObject({ ok: true });
    await Promise.resolve();
    expect(flights.join("ws-a")).toBeNull();
  });

  test("observes a pending MCP prime without blocking the caller", async () => {
    let resolvePrime!: (result: { ok: boolean; baseUrl: string; directory: string }) => void;
    const pending = new Promise<{ ok: boolean; baseUrl: string; directory: string }>((resolve) => {
      resolvePrime = resolve;
    });
    const observed: Array<{ ok: boolean; baseUrl: string; directory: string }> = [];

    observeOpenCodeMcpRuntimePrime(pending, (result) => observed.push(result));

    expect(observed).toEqual([]);
    resolvePrime({ ok: true, baseUrl: "http://127.0.0.1:4096", directory: "/repo" });
    await Promise.resolve();
    expect(observed).toEqual([{ ok: true, baseUrl: "http://127.0.0.1:4096", directory: "/repo" }]);
  });
});
