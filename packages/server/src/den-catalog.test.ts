import { afterEach, expect, test } from "bun:test";

import { ApiError } from "./errors.js";
import { fetchOrgMcpCatalog, fetchOrgSkillsCatalog } from "./den-catalog.js";

const originalFetch = globalThis.fetch;

function asFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return handler as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("fetchOrgSkillsCatalog sends bearer token header", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await fetchOrgSkillsCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://den.example/v1/orgs/org_123/skills/catalog");

  const headers = new Headers(calls[0]?.init?.headers);
  expect(headers.get("authorization")).toBe("Bearer token_abc");
});

test("fetchOrgSkillsCatalog returns empty list from payload", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

  const items = await fetchOrgSkillsCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  });

  expect(items).toEqual([]);
});

test("fetchOrgSkillsCatalog throws ApiError on non-2xx", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({ error: "boom" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));

  await expect(fetchOrgSkillsCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  })).rejects.toMatchObject({
    status: 502,
    code: "den_catalog_fetch_failed",
  });
});

test("fetchOrgSkillsCatalog throws ApiError when fetch rejects", async () => {
  globalThis.fetch = asFetch(async () => {
    throw new Error("offline");
  });

  await expect(fetchOrgSkillsCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  })).rejects.toMatchObject({
    status: 502,
    code: "den_catalog_fetch_failed",
  } satisfies Partial<ApiError>);
});

test("fetchOrgSkillsCatalog throws ApiError on invalid payload shape", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({ items: ["invalid"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

  await expect(fetchOrgSkillsCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  })).rejects.toMatchObject({
    status: 502,
    code: "den_catalog_invalid_payload",
  });
});

test("fetchOrgMcpCatalog sends bearer token header", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await fetchOrgMcpCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://den.example/v1/orgs/org_123/mcp/catalog");

  const headers = new Headers(calls[0]?.init?.headers);
  expect(headers.get("authorization")).toBe("Bearer token_abc");
});

test("fetchOrgMcpCatalog returns empty list from payload", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

  const items = await fetchOrgMcpCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  });

  expect(items).toEqual([]);
});

test("fetchOrgMcpCatalog throws ApiError on invalid payload shape", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({ items: ["invalid"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

  await expect(fetchOrgMcpCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  })).rejects.toMatchObject({
    status: 502,
    code: "den_catalog_invalid_payload",
  });
});
