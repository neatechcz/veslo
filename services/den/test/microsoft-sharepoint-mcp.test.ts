import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { errorMiddleware } from "../src/http/errors.js"
import type { MicrosoftOAuthClient } from "../src/microsoft/oauth.js"
import {
  InMemoryMicrosoftConnectionStore,
  UnavailableMicrosoftConnectionStore,
  type MicrosoftConnectionStore,
} from "../src/microsoft/store.js"
import { createSignedMicrosoftRuntimeToken } from "../src/microsoft/state.js"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@localhost:3306/veslo_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:8788",
})

const STATE_SECRET = "microsoft_state_secret_01234567890123456789"
const NOW = Date.parse("2026-07-02T10:00:00.000Z")
const CONNECTOR_ID = "microsoft-sharepoint"
const GRAPH_BASE_URL = "https://graph.example/v1.0"
const SHAREPOINT_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "https://graph.microsoft.com/Files.Read.All",
  "https://graph.microsoft.com/Sites.Read.All",
]

type GraphCall = {
  url: string
  method: string
  authorization: string | null
  body: string | null
}

function createOrgContext(orgId: string) {
  return {
    session: {
      user: {
        id: "user_1",
        email: "user@example.com",
        emailVerified: true,
        name: "User One",
      },
    },
    organization: {
      id: orgId,
      name: "Org One",
      slug: "org-one",
      ownerUserId: "user_1",
    },
    membershipId: "membership_1",
    orgRole: "member" as const,
    isPlatformAdmin: false,
  }
}

async function startServer(input: {
  store?: MicrosoftConnectionStore
  oauth?: MicrosoftOAuthClient
  now?: () => number
  fetchImpl?: typeof fetch
  microsoftGraphMaxContentBytes?: number
} = {}) {
  const store = input.store ?? new InMemoryMicrosoftConnectionStore()
  const now = input.now ?? (() => NOW)
  const refreshCalls: string[] = []
  const oauth = input.oauth ?? {
    startAuthorization: async () => ({ authorizeUrl: "https://login.example/authorize" }),
    exchangeCode: async () => ({
      accessToken: "exchanged_access",
      refreshToken: "exchanged_refresh",
      expiresAt: "2030-06-19T12:00:00.000Z",
    }),
    refreshToken: async (refreshInput: { refreshToken: string }) => {
      refreshCalls.push(refreshInput.refreshToken)
      return {
        accessToken: "refreshed_access",
        refreshToken: "refreshed_refresh",
        expiresAt: "2030-06-19T12:00:00.000Z",
        scope: SHAREPOINT_SCOPES.join(" "),
      }
    },
    revokeToken: async () => undefined,
  }
  const { createMicrosoftRouter } = await import("../src/http/microsoft.js")

  const app2 = express()
  app2.use(express.json())
  app2.use(
    "/v1",
    createMicrosoftRouter({
      stateSecret: STATE_SECRET,
      successRedirectUrl: "https://app.veslo.work/settings/integrations/microsoft",
      authorize: async (req) => createOrgContext(req.params.orgId),
      store,
      oauth,
      now,
      fetchImpl: input.fetchImpl,
      microsoftGraphBaseUrl: GRAPH_BASE_URL,
      microsoftGraphMaxContentBytes: input.microsoftGraphMaxContentBytes,
    }),
  )
  app2.use(errorMiddleware)

  const server = app2.listen(0, "127.0.0.1")
  await once(server, "listening")

  return {
    port: (server.address() as AddressInfo).port,
    store,
    refreshCalls,
    runtimeToken: (orgId = "org_1") => createSignedMicrosoftRuntimeToken({
      orgId,
      userId: "user_1",
      connectorId: CONNECTOR_ID,
      secret: STATE_SECRET,
      now,
    }),
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}

async function connectStore(store: MicrosoftConnectionStore, grant: {
  accessToken?: string
  refreshToken?: string
  expiresAt?: string
} = {}) {
  await store.upsertConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId: CONNECTOR_ID,
    scopes: SHAREPOINT_SCOPES,
    grant: {
      accessToken: grant.accessToken ?? "stored_access",
      refreshToken: grant.refreshToken ?? "stored_refresh",
      expiresAt: grant.expiresAt ?? "2030-06-19T12:00:00.000Z",
    },
  })
}

async function postMcp(server: { port: number; runtimeToken: () => string }, body: unknown, token = server.runtimeToken()) {
  return fetch(`http://127.0.0.1:${server.port}/v1/orgs/org_1/integrations/microsoft/${CONNECTOR_ID}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-veslo-connector-token": token } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function callTool(server: { port: number; runtimeToken: () => string }, name: string, args: Record<string, unknown>, id = 1) {
  const response = await postMcp(server, {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
    id,
  })
  assert.equal(response.status, 200)
  const envelope = await response.json() as {
    jsonrpc?: string
    result?: { content?: Array<{ type?: string; text?: string }> }
    error?: unknown
    id?: unknown
  }
  assert.equal(envelope.jsonrpc, "2.0")
  assert.equal(envelope.error, undefined)
  assert.equal(envelope.id, id)
  const text = envelope.result?.content?.[0]?.text
  assert.equal(typeof text, "string")
  return JSON.parse(text) as Record<string, unknown>
}

async function readJsonRpcError(response: Response) {
  assert.equal(response.status, 200)
  const envelope = await response.json() as {
    jsonrpc?: string
    error?: {
      code?: number
      message?: string
      data?: Record<string, unknown>
    }
  }
  assert.equal(envelope.jsonrpc, "2.0")
  assert.ok(envelope.error)
  return envelope.error
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  })
}

function createGraphFetch(handler: (call: GraphCall) => Response | Promise<Response>) {
  const calls: GraphCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === "string" ? init.body : null
    const call = {
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body,
    }
    calls.push(call)
    return handler(call)
  }
  return { fetchImpl, calls }
}

test("microsoft SharePoint MCP rejects requests without a valid runtime token", async () => {
  const server = await startServer()

  try {
    const response = await postMcp(server, { jsonrpc: "2.0", method: "tools/list", id: 1 }, "")

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "microsoft_runtime_token_invalid" })
  } finally {
    await server.close()
  }
})

test("microsoft SharePoint MCP requires an existing grant", async () => {
  const server = await startServer()

  try {
    const response = await postMcp(server, { jsonrpc: "2.0", method: "tools/list", id: 1 })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), {
      error: "microsoft_connection_required",
      connectorId: CONNECTOR_ID,
    })
  } finally {
    await server.close()
  }
})

test("microsoft SharePoint MCP reports unavailable grant storage clearly", async () => {
  const server = await startServer({
    store: new UnavailableMicrosoftConnectionStore(),
  })

  try {
    const response = await postMcp(server, { jsonrpc: "2.0", method: "tools/list", id: 1 })

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: "microsoft_token_secret_not_configured",
      connectorId: CONNECTOR_ID,
    })
  } finally {
    await server.close()
  }
})

test("microsoft SharePoint MCP tools/list exposes read-only tools", async () => {
  const server = await startServer()

  try {
    await connectStore(server.store)

    const response = await postMcp(server, { jsonrpc: "2.0", method: "tools/list", id: "list" })

    assert.equal(response.status, 200)
    const envelope = await response.json() as {
      jsonrpc?: string
      result?: { tools?: Array<{ name?: string }> }
      id?: unknown
    }
    assert.equal(envelope.jsonrpc, "2.0")
    assert.equal(envelope.id, "list")
    assert.deepEqual(envelope.result?.tools?.map((tool) => tool.name), [
      "sharepoint.search",
      "sharepoint.listSites",
      "sharepoint.listDrives",
      "sharepoint.listChildren",
      "sharepoint.getItem",
      "sharepoint.getContent",
    ])
  } finally {
    await server.close()
  }
})

test("microsoft SharePoint MCP dispatches read-only tools to Microsoft Graph with compact payloads", async () => {
  const graph = createGraphFetch((call) => {
    assert.equal(call.authorization, "Bearer stored_access")
    const url = new URL(call.url)
    if (call.method === "POST" && url.pathname === "/v1.0/search/query") {
      assert.match(call.body ?? "", /roadmap/)
      return jsonResponse({
        value: [{
          hitsContainers: [{
            hits: [{
              hitId: "hit_1",
              summary: "Roadmap summary",
              resource: {
                id: "item_1",
                name: "Roadmap.docx",
                webUrl: "https://contoso.sharepoint.com/roadmap",
                size: 1234,
                parentReference: { driveId: "drive_1", id: "parent_1", siteId: "site_1" },
                file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
              },
            }],
          }],
        }],
        "@odata.nextLink": "https://graph.example/search-next",
      })
    }
    if (call.method === "GET" && url.pathname === "/v1.0/sites") {
      assert.equal(url.searchParams.get("search"), "contoso")
      return jsonResponse({
        value: [{
          id: "site_1",
          name: "contoso",
          displayName: "Contoso",
          webUrl: "https://contoso.sharepoint.com/sites/contoso",
        }],
        "@odata.nextLink": "https://graph.example/sites-next",
      })
    }
    if (call.method === "GET" && url.pathname === "/v1.0/sites/site_1/drives") {
      return jsonResponse({
        value: [{
          id: "drive_1",
          name: "Documents",
          driveType: "documentLibrary",
          webUrl: "https://contoso.sharepoint.com/documents",
        }],
      })
    }
    if (call.method === "GET" && url.pathname === "/v1.0/drives/drive_1/items/folder_1/children") {
      return jsonResponse({
        value: [{
          id: "child_1",
          name: "Notes.txt",
          webUrl: "https://contoso.sharepoint.com/notes",
          size: 12,
          file: { mimeType: "text/plain" },
        }],
      })
    }
    if (call.method === "GET" && url.pathname === "/v1.0/drives/drive_1/items/item_1") {
      return jsonResponse({
        id: "item_1",
        name: "Roadmap.docx",
        webUrl: "https://contoso.sharepoint.com/roadmap",
        size: 1234,
        file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        parentReference: { driveId: "drive_1", id: "parent_1", siteId: "site_1" },
      })
    }
    if (call.method === "GET" && url.pathname === "/v1.0/drives/drive_1/items/item_1/content") {
      return new Response("hello sharepoint", {
        headers: {
          "content-type": "text/plain",
        },
      })
    }
    throw new Error(`unexpected Graph request ${call.method} ${url.pathname}`)
  })
  const server = await startServer({ fetchImpl: graph.fetchImpl })

  try {
    await connectStore(server.store)

    const search = await callTool(server, "sharepoint.search", { query: "roadmap", size: 5 }, "search")
    assert.deepEqual(search, {
      items: [{
        id: "item_1",
        name: "Roadmap.docx",
        webUrl: "https://contoso.sharepoint.com/roadmap",
        summary: "Roadmap summary",
        size: 1234,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        parentReference: { driveId: "drive_1", id: "parent_1", siteId: "site_1" },
      }],
      nextLink: "https://graph.example/search-next",
    })

    const sites = await callTool(server, "sharepoint.listSites", { query: "contoso" }, "sites")
    assert.deepEqual(sites, {
      items: [{
        id: "site_1",
        name: "contoso",
        displayName: "Contoso",
        webUrl: "https://contoso.sharepoint.com/sites/contoso",
      }],
      nextLink: "https://graph.example/sites-next",
    })

    const drives = await callTool(server, "sharepoint.listDrives", { siteId: "site_1" }, "drives")
    assert.deepEqual(drives, {
      items: [{
        id: "drive_1",
        name: "Documents",
        driveType: "documentLibrary",
        webUrl: "https://contoso.sharepoint.com/documents",
      }],
    })

    const children = await callTool(server, "sharepoint.listChildren", {
      driveId: "drive_1",
      itemId: "folder_1",
    }, "children")
    assert.deepEqual(children, {
      items: [{
        id: "child_1",
        name: "Notes.txt",
        webUrl: "https://contoso.sharepoint.com/notes",
        size: 12,
        mimeType: "text/plain",
      }],
    })

    const item = await callTool(server, "sharepoint.getItem", {
      driveId: "drive_1",
      itemId: "item_1",
    }, "item")
    assert.deepEqual(item, {
      item: {
        id: "item_1",
        name: "Roadmap.docx",
        webUrl: "https://contoso.sharepoint.com/roadmap",
        size: 1234,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        parentReference: { driveId: "drive_1", id: "parent_1", siteId: "site_1" },
      },
    })

    const content = await callTool(server, "sharepoint.getContent", {
      driveId: "drive_1",
      itemId: "item_1",
    }, "content")
    assert.deepEqual(content, {
      item: {
        driveId: "drive_1",
        itemId: "item_1",
      },
      contentType: "text/plain",
      size: 16,
      contentBase64: Buffer.from("hello sharepoint").toString("base64"),
    })

    assert.deepEqual(graph.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
      "POST /v1.0/search/query",
      "GET /v1.0/sites",
      "GET /v1.0/sites/site_1/drives",
      "GET /v1.0/drives/drive_1/items/folder_1/children",
      "GET /v1.0/drives/drive_1/items/item_1",
      "GET /v1.0/drives/drive_1/items/item_1/content",
    ])
  } finally {
    await server.close()
  }
})

test("microsoft SharePoint MCP refreshes expired grants before Graph calls", async () => {
  const graph = createGraphFetch((call) => {
    assert.equal(call.authorization, "Bearer refreshed_access")
    return jsonResponse({ value: [] })
  })
  const server = await startServer({ fetchImpl: graph.fetchImpl })

  try {
    await connectStore(server.store, {
      accessToken: "expired_access",
      refreshToken: "expired_refresh",
      expiresAt: "2026-07-02T09:58:00.000Z",
    })

    await callTool(server, "sharepoint.listSites", { query: "contoso" }, "refresh")

    assert.deepEqual(server.refreshCalls, ["expired_refresh"])
    const refreshed = await server.store.getGrant({
      orgId: "org_1",
      userId: "user_1",
      connectorId: CONNECTOR_ID,
    })
    assert.equal(refreshed?.accessToken, "refreshed_access")
    assert.equal(refreshed?.refreshToken, "refreshed_refresh")
  } finally {
    await server.close()
  }
})

test("microsoft SharePoint MCP maps Graph 403 to insufficient permission", async () => {
  const graph = createGraphFetch(() => jsonResponse({
    error: {
      code: "accessDenied",
      message: "Access denied",
    },
  }, 403))
  const server = await startServer({ fetchImpl: graph.fetchImpl })

  try {
    await connectStore(server.store)

    const response = await postMcp(server, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "sharepoint.listSites",
        arguments: { query: "contoso" },
      },
      id: "forbidden",
    })
    const error = await readJsonRpcError(response)

    assert.equal(error.code, -32003)
    assert.equal(error.message, "microsoft_graph_insufficient_permission")
    assert.deepEqual(error.data, {
      status: 403,
      graphCode: "accessDenied",
      graphMessage: "Access denied",
    })
  } finally {
    await server.close()
  }
})

test("microsoft SharePoint MCP rejects unsupported methods and write-like tool names", async () => {
  const server = await startServer()

  try {
    await connectStore(server.store)

    const unsupportedMethod = await postMcp(server, {
      jsonrpc: "2.0",
      method: "resources/list",
      id: "method",
    })
    const methodError = await readJsonRpcError(unsupportedMethod)
    assert.equal(methodError.code, -32601)
    assert.equal(methodError.message, "method_not_found")
    assert.deepEqual(methodError.data, { method: "resources/list" })

    const writeTool = await postMcp(server, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "sharepoint.deleteItem",
        arguments: { driveId: "drive_1", itemId: "item_1" },
      },
      id: "write",
    })
    const writeError = await readJsonRpcError(writeTool)
    assert.equal(writeError.code, -32601)
    assert.equal(writeError.message, "unsupported_sharepoint_write_tool")
    assert.deepEqual(writeError.data, {
      tool: "sharepoint.deleteItem",
      readOnly: true,
    })
  } finally {
    await server.close()
  }
})

test("microsoft SharePoint MCP enforces the content byte limit", async () => {
  const graph = createGraphFetch(() => new Response("too much content", {
    headers: {
      "content-type": "text/plain",
    },
  }))
  const server = await startServer({
    fetchImpl: graph.fetchImpl,
    microsoftGraphMaxContentBytes: 8,
  })

  try {
    await connectStore(server.store)

    const response = await postMcp(server, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "sharepoint.getContent",
        arguments: {
          driveId: "drive_1",
          itemId: "item_1",
        },
      },
      id: "content-limit",
    })
    const error = await readJsonRpcError(response)

    assert.equal(error.code, -32013)
    assert.equal(error.message, "microsoft_graph_response_too_large")
    assert.deepEqual(error.data, {
      status: 413,
      maxContentBytes: 8,
    })
  } finally {
    await server.close()
  }
})
