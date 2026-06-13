import { describe, expect, test } from "bun:test";

import { probeOpenCodeProjectApi } from "../opencode-project-api.js";

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
});
