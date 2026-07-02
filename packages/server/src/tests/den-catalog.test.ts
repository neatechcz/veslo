import { afterEach, expect, test } from "bun:test";

import { ApiError } from "../errors.js";
import { createOrgMcpRuntimeToken, fetchOrgMcpCatalog, fetchOrgSkillsCatalog } from "../den-catalog.js";

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

test("fetchOrgMcpCatalog rejects OAuth objects with non-string optional fields", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({
      items: [
        {
          id: "google-gmail",
          name: "Google Gmail",
          config: {
            type: "remote",
            url: "https://gmailmcp.googleapis.com/mcp/v1",
            oauth: {
              clientId: "client",
              clientSecret: 123,
              scope: ["bad"],
            },
          },
          source: { scope: "platform" },
        },
      ],
    }), {
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

test("fetchOrgMcpCatalog preserves non-secret headers and server OAuth metadata", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({
      items: [
        {
          id: "google-gmail",
          name: "Google Gmail",
          config: {
            type: "remote",
            url: "https://api.veslo.work/v1/orgs/org_123/integrations/google/google-gmail/mcp",
            oauth: false,
            headers: {
              "X-Veslo-Connector": "google-gmail",
            },
          },
          authorization: {
            type: "veslo-server-oauth",
            provider: "google",
            connectorId: "google-gmail",
            scopes: [
              "https://www.googleapis.com/auth/gmail.readonly",
              "https://www.googleapis.com/auth/gmail.compose",
            ],
            startPath: "/v1/orgs/org_123/integrations/google/google-gmail/oauth/start",
            runtimeTokenPath: "/v1/orgs/org_123/integrations/google/google-gmail/runtime-token",
            statusPath: "/v1/orgs/org_123/integrations/google/connections",
            disconnectPath: "/v1/orgs/org_123/integrations/google/google-gmail/connection",
          },
          source: { scope: "platform" },
          provider: { id: "google", group: "Google" },
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

  const items = await fetchOrgMcpCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  });

  expect(items[0]).toEqual({
    id: "google-gmail",
    name: "Google Gmail",
    config: {
      type: "remote",
      url: "https://api.veslo.work/v1/orgs/org_123/integrations/google/google-gmail/mcp",
      oauth: false,
      headers: {
        "X-Veslo-Connector": "google-gmail",
      },
    },
    authorization: {
      type: "veslo-server-oauth",
      provider: "google",
      connectorId: "google-gmail",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
      startPath: "/v1/orgs/org_123/integrations/google/google-gmail/oauth/start",
      runtimeTokenPath: "/v1/orgs/org_123/integrations/google/google-gmail/runtime-token",
      statusPath: "/v1/orgs/org_123/integrations/google/connections",
      disconnectPath: "/v1/orgs/org_123/integrations/google/google-gmail/connection",
    },
    source: { scope: "platform" },
    provider: { id: "google", group: "Google" },
  });
});

test("fetchOrgMcpCatalog preserves Microsoft provider server OAuth metadata without token material", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({
      items: [
        {
          id: "microsoft-sharepoint",
          name: "Microsoft SharePoint",
          config: {
            type: "remote",
            url: "https://api.veslo.work/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/mcp",
            oauth: false,
            headers: {
              "X-Veslo-Connector": "microsoft-sharepoint",
            },
          },
          authorization: {
            type: "veslo-server-oauth",
            provider: "microsoft",
            connectorId: "microsoft-sharepoint",
            scopes: [
              "openid",
              "profile",
              "offline_access",
              "https://graph.microsoft.com/Files.Read.All",
              "https://graph.microsoft.com/Sites.Read.All",
            ],
            startPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/oauth/start",
            runtimeTokenPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/runtime-token",
            statusPath: "/v1/orgs/org_123/integrations/microsoft/connections",
            disconnectPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/connection",
          },
          source: { scope: "platform" },
          provider: { id: "microsoft", group: "Microsoft" },
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

  const items = await fetchOrgMcpCatalog({
    baseUrl: "https://den.example",
    orgId: "org_123",
    denToken: "token_abc",
  });

  expect(items[0]).toEqual({
    id: "microsoft-sharepoint",
    name: "Microsoft SharePoint",
    config: {
      type: "remote",
      url: "https://api.veslo.work/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/mcp",
      oauth: false,
      headers: {
        "X-Veslo-Connector": "microsoft-sharepoint",
      },
    },
    authorization: {
      type: "veslo-server-oauth",
      provider: "microsoft",
      connectorId: "microsoft-sharepoint",
      scopes: [
        "openid",
        "profile",
        "offline_access",
        "https://graph.microsoft.com/Files.Read.All",
        "https://graph.microsoft.com/Sites.Read.All",
      ],
      startPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/oauth/start",
      runtimeTokenPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/runtime-token",
      statusPath: "/v1/orgs/org_123/integrations/microsoft/connections",
      disconnectPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/connection",
    },
    source: { scope: "platform" },
    provider: { id: "microsoft", group: "Microsoft" },
  });

  const authorization = items[0]?.authorization as (Record<string, unknown> | undefined);
  expect(authorization?.accessToken).toBeUndefined();
  expect(authorization?.refreshToken).toBeUndefined();
  expect(authorization?.runtimeToken).toBeUndefined();
});

test("fetchOrgMcpCatalog rejects inline OAuth client config on server OAuth catalog items", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({
      items: [
        {
          id: "microsoft-sharepoint",
          name: "Microsoft SharePoint",
          config: {
            type: "remote",
            url: "https://api.veslo.work/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/mcp",
            oauth: {
              clientId: "public-client",
              clientSecret: "secret-client",
            },
            headers: {
              "X-Veslo-Connector": "microsoft-sharepoint",
            },
          },
          authorization: {
            type: "veslo-server-oauth",
            provider: "microsoft",
            connectorId: "microsoft-sharepoint",
            scopes: [
              "openid",
              "profile",
              "offline_access",
              "https://graph.microsoft.com/Files.Read.All",
              "https://graph.microsoft.com/Sites.Read.All",
            ],
            startPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/oauth/start",
            runtimeTokenPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/runtime-token",
            statusPath: "/v1/orgs/org_123/integrations/microsoft/connections",
            disconnectPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/connection",
          },
          source: { scope: "platform" },
          provider: { id: "microsoft", group: "Microsoft" },
        },
      ],
    }), {
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

  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({
      items: [
        {
          id: "google-gmail",
          name: "Google Gmail",
          config: {
            type: "remote",
            url: "https://api.veslo.work/v1/orgs/org_123/integrations/google/google-gmail/mcp",
            oauth: {
              clientId: "public-client",
            },
            headers: {
              "X-Veslo-Connector": "google-gmail",
            },
          },
          authorization: {
            type: "veslo-server-oauth",
            provider: "google",
            connectorId: "google-gmail",
            scopes: [
              "https://www.googleapis.com/auth/gmail.readonly",
              "https://www.googleapis.com/auth/gmail.compose",
            ],
            startPath: "/v1/orgs/org_123/integrations/google/google-gmail/oauth/start",
            runtimeTokenPath: "/v1/orgs/org_123/integrations/google/google-gmail/runtime-token",
            statusPath: "/v1/orgs/org_123/integrations/google/connections",
            disconnectPath: "/v1/orgs/org_123/integrations/google/google-gmail/connection",
          },
          source: { scope: "platform" },
          provider: { id: "google", group: "Google" },
        },
      ],
    }), {
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

test("fetchOrgMcpCatalog rejects malformed Microsoft authorization fields and token material", async () => {
  const validAuthorization = {
    type: "veslo-server-oauth",
    provider: "microsoft",
    connectorId: "microsoft-sharepoint",
    scopes: [
      "openid",
      "profile",
      "offline_access",
      "https://graph.microsoft.com/Files.Read.All",
      "https://graph.microsoft.com/Sites.Read.All",
    ],
    startPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/oauth/start",
    runtimeTokenPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/runtime-token",
    statusPath: "/v1/orgs/org_123/integrations/microsoft/connections",
    disconnectPath: "/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/connection",
  };
  const validItem = {
    id: "microsoft-sharepoint",
    name: "Microsoft SharePoint",
    config: {
      type: "remote",
      url: "https://api.veslo.work/v1/orgs/org_123/integrations/microsoft/microsoft-sharepoint/mcp",
      oauth: false,
      headers: {
        "X-Veslo-Connector": "microsoft-sharepoint",
      },
    },
    authorization: validAuthorization,
    source: { scope: "platform" },
    provider: { id: "microsoft", group: "Microsoft" },
  };

  const invalidAuthorizations: unknown[] = [
    { ...validAuthorization, provider: 123 },
    { ...validAuthorization, connectorId: 123 },
    { ...validAuthorization, scopes: "https://graph.microsoft.com/Sites.Read.All" },
    { ...validAuthorization, scopes: ["https://graph.microsoft.com/Sites.Read.All", 123] },
    { ...validAuthorization, runtimeTokenPath: 123 },
    { ...validAuthorization, accessToken: "access-token-secret" },
    { ...validAuthorization, refreshToken: "refresh-token-secret" },
    { ...validAuthorization, runtimeToken: "runtime-token-secret" },
  ];

  for (const authorization of invalidAuthorizations) {
    globalThis.fetch = asFetch(async () =>
      new Response(JSON.stringify({
        items: [
          {
            ...validItem,
            authorization,
          },
        ],
      }), {
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
  }
});

test("fetchOrgMcpCatalog rejects malformed header values", async () => {
  globalThis.fetch = asFetch(async () =>
    new Response(JSON.stringify({
      items: [
        {
          id: "google-gmail",
          name: "Google Gmail",
          config: {
            type: "remote",
            url: "https://api.veslo.work/v1/orgs/org_123/integrations/google/google-gmail/mcp",
            headers: {
              "X-Veslo-Connector": 123,
            },
          },
          source: { scope: "platform" },
        },
      ],
    }), {
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

test("fetchOrgMcpCatalog rejects secret-like catalog headers", async () => {
  for (const headers of [
    { Authorization: "Bearer token" },
    { "X-Veslo-Connector-Token": "runtime-token" },
    { "X-Custom": "{env:VESLO_SECRET}" },
  ]) {
    globalThis.fetch = asFetch(async () =>
      new Response(JSON.stringify({
        items: [
          {
            id: "google-gmail",
            name: "Google Gmail",
            config: {
              type: "remote",
              url: "https://api.veslo.work/v1/orgs/org_123/integrations/google/google-gmail/mcp",
              headers,
            },
            source: { scope: "platform" },
          },
        ],
      }), {
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
  }
});

test("createOrgMcpRuntimeToken posts to Den and returns connector token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = asFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({
      token: "runtime-token-123",
      expiresAt: "2026-06-19T12:00:00.000Z",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const result = await createOrgMcpRuntimeToken({
    baseUrl: "https://den.example/",
    denToken: "token_abc",
    runtimeTokenPath: "/v1/orgs/org_123/integrations/google/google-gmail/runtime-token",
  });

  expect(result).toEqual({
    token: "runtime-token-123",
    expiresAt: "2026-06-19T12:00:00.000Z",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://den.example/v1/orgs/org_123/integrations/google/google-gmail/runtime-token");
  const headers = new Headers(calls[0]?.init?.headers);
  expect(calls[0]?.init?.method).toBe("POST");
  expect(headers.get("authorization")).toBe("Bearer token_abc");
});
