import { MicrosoftGraphClient, MicrosoftGraphError } from "./graph.js"

type JsonRecord = Record<string, unknown>
type JsonRpcId = string | number | null

type JsonRpcRequest = {
  jsonrpc?: unknown
  method?: unknown
  params?: unknown
  id?: unknown
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
  id: JsonRpcId
}

type SharePointMcpInput = {
  graph: MicrosoftGraphClient
  body: unknown
}

const MCP_PROTOCOL_VERSION = "2024-11-05"

const SHAREPOINT_TOOL_NAMES = [
  "sharepoint.search",
  "sharepoint.listSites",
  "sharepoint.listDrives",
  "sharepoint.listChildren",
  "sharepoint.getItem",
  "sharepoint.getContent",
] as const

type SharePointToolName = (typeof SHAREPOINT_TOOL_NAMES)[number]

const SHAREPOINT_SEARCH_ENTITY_TYPES = ["driveItem", "site", "list", "listItem"] as const

const WRITE_TOOL_PATTERN = /^sharepoint\.(create|update|delete|remove|move|copy|upload|patch|put|set|write)/i

export async function dispatchSharePointMcpRequest(input: SharePointMcpInput): Promise<JsonRpcResponse | null> {
  const request = asRecord(input.body) as JsonRpcRequest | null
  const id = jsonRpcId(request?.id)
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return jsonRpcError(id, -32600, "invalid_request")
  }

  try {
    if (request.method === "initialize") {
      return jsonRpcResult(id, {
        protocolVersion: requestedProtocolVersion(request.params),
        serverInfo: {
          name: "veslo-microsoft-sharepoint",
          version: "0.1.0",
        },
        capabilities: {
          tools: {},
        },
      })
    }
    if (request.method === "notifications/initialized") {
      return null
    }
    if (request.method === "ping") {
      return jsonRpcResult(id, {})
    }
    if (request.method === "tools/list") {
      return jsonRpcResult(id, { tools: SHAREPOINT_TOOLS })
    }
    if (request.method === "tools/call") {
      const result = await callSharePointTool(input.graph, request.params)
      return jsonRpcResult(id, {
        content: [{
          type: "text",
          text: JSON.stringify(result),
        }],
      })
    }
    return jsonRpcError(id, -32601, "method_not_found", { method: request.method })
  } catch (error) {
    if (error instanceof JsonRpcDispatchError) {
      return jsonRpcError(id, error.code, error.message, error.data)
    }
    if (error instanceof MicrosoftGraphError) {
      return jsonRpcError(id, graphJsonRpcCode(error), error.message, graphErrorData(error))
    }
    throw error
  }
}

const SHAREPOINT_TOOLS = [
  {
    name: "sharepoint.search",
    description: "Search SharePoint sites and drive items with Microsoft Graph.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        entityTypes: { type: "array", items: { type: "string" } },
        from: { type: "number" },
        size: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "sharepoint.listSites",
    description: "List SharePoint sites visible to the connected Microsoft account.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        top: { type: "number" },
      },
    },
  },
  {
    name: "sharepoint.listDrives",
    description: "List document libraries for a SharePoint site.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string" },
      },
      required: ["siteId"],
    },
  },
  {
    name: "sharepoint.listChildren",
    description: "List children for a SharePoint drive folder or drive root.",
    inputSchema: {
      type: "object",
      properties: {
        driveId: { type: "string" },
        itemId: { type: "string" },
        top: { type: "number" },
      },
      required: ["driveId"],
    },
  },
  {
    name: "sharepoint.getItem",
    description: "Get compact metadata for a SharePoint drive item.",
    inputSchema: {
      type: "object",
      properties: {
        driveId: { type: "string" },
        itemId: { type: "string" },
      },
      required: ["driveId", "itemId"],
    },
  },
  {
    name: "sharepoint.getContent",
    description: "Fetch small SharePoint file content as base64 within the configured byte limit.",
    inputSchema: {
      type: "object",
      properties: {
        driveId: { type: "string" },
        itemId: { type: "string" },
      },
      required: ["driveId", "itemId"],
    },
  },
]

async function callSharePointTool(graph: MicrosoftGraphClient, params: unknown) {
  const payload = asRecord(params)
  const toolName = typeof payload?.name === "string" ? payload.name : ""
  const args = asRecord(payload?.arguments) ?? {}

  if (!toolName) {
    throw new JsonRpcDispatchError(-32602, "invalid_params", { missing: "name" })
  }
  if (WRITE_TOOL_PATTERN.test(toolName)) {
    throw new JsonRpcDispatchError(-32601, "unsupported_sharepoint_write_tool", {
      tool: toolName,
      readOnly: true,
    })
  }
  if (!isSharePointToolName(toolName)) {
    throw new JsonRpcDispatchError(-32601, "tool_not_found", { tool: toolName })
  }

  switch (toolName) {
    case "sharepoint.search":
      return searchSharePoint(graph, args)
    case "sharepoint.listSites":
      return listSites(graph, args)
    case "sharepoint.listDrives":
      return listDrives(graph, args)
    case "sharepoint.listChildren":
      return listChildren(graph, args)
    case "sharepoint.getItem":
      return getItem(graph, args)
    case "sharepoint.getContent":
      return getContent(graph, args)
  }
}

async function searchSharePoint(graph: MicrosoftGraphClient, args: JsonRecord) {
  const query = requiredString(args, "query")
  const entityTypes = searchEntityTypes(args)
  const from = optionalInteger(args, "from")
  const request: JsonRecord = {
    entityTypes,
    query: { queryString: query },
    size: optionalInteger(args, "size") ?? 10,
  }
  if (from !== null) {
    request.from = from
  }
  const body = {
    requests: [request],
  }

  const payload = await graph.postJson<JsonRecord>("/search/query", body)
  return withNextLink({
    items: compactSearchHits(payload),
  }, payload)
}

function requestedProtocolVersion(params: unknown) {
  const requestParams = asRecord(params)
  const protocolVersion = requestParams?.protocolVersion
  return typeof protocolVersion === "string" && protocolVersion.trim()
    ? protocolVersion
    : MCP_PROTOCOL_VERSION
}

function searchEntityTypes(args: JsonRecord) {
  const entityTypes = optionalStringArray(args, "entityTypes") ?? ["driveItem", "site"]
  const allowed = SHAREPOINT_SEARCH_ENTITY_TYPES as readonly string[]
  if (entityTypes.some((item) => !allowed.includes(item))) {
    throw new JsonRpcDispatchError(-32602, "invalid_params", {
      invalid: "entityTypes",
      allowed: [...SHAREPOINT_SEARCH_ENTITY_TYPES],
    })
  }
  return entityTypes
}

async function listSites(graph: MicrosoftGraphClient, args: JsonRecord) {
  const query = optionalString(args, "query") ?? "*"
  const params = new URLSearchParams({ search: query })
  appendOptionalTop(params, args)
  const payload = await graph.getJson<JsonRecord>(pathWithQuery("/sites", params))

  return withNextLink({
    items: graphValue(payload).map(compactSite),
  }, payload)
}

async function listDrives(graph: MicrosoftGraphClient, args: JsonRecord) {
  const siteId = requiredString(args, "siteId")
  const payload = await graph.getJson<JsonRecord>(`/sites/${graphSegment(siteId)}/drives`)

  return withNextLink({
    items: graphValue(payload).map(compactDrive),
  }, payload)
}

async function listChildren(graph: MicrosoftGraphClient, args: JsonRecord) {
  const driveId = requiredString(args, "driveId")
  const itemId = optionalString(args, "itemId")
  const params = new URLSearchParams()
  appendOptionalTop(params, args)
  const basePath = itemId
    ? `/drives/${graphSegment(driveId)}/items/${graphSegment(itemId)}/children`
    : `/drives/${graphSegment(driveId)}/root/children`
  const payload = await graph.getJson<JsonRecord>(pathWithQuery(basePath, params))

  return withNextLink({
    items: graphValue(payload).map(compactDriveItem),
  }, payload)
}

async function getItem(graph: MicrosoftGraphClient, args: JsonRecord) {
  const driveId = requiredString(args, "driveId")
  const itemId = requiredString(args, "itemId")
  const payload = await graph.getJson<JsonRecord>(`/drives/${graphSegment(driveId)}/items/${graphSegment(itemId)}`)

  return {
    item: compactDriveItem(payload),
  }
}

async function getContent(graph: MicrosoftGraphClient, args: JsonRecord) {
  const driveId = requiredString(args, "driveId")
  const itemId = requiredString(args, "itemId")
  const content = await graph.getBytes(`/drives/${graphSegment(driveId)}/items/${graphSegment(itemId)}/content`)

  return {
    item: {
      driveId,
      itemId,
    },
    contentType: content.contentType,
    size: content.bytes.byteLength,
    contentBase64: Buffer.from(content.bytes).toString("base64"),
  }
}

function compactSearchHits(payload: JsonRecord) {
  return graphValue(payload).flatMap((result) => {
    const containers = arrayFrom(asRecord(result)?.hitsContainers)
    return containers.flatMap((container) => {
      const hits = arrayFrom(asRecord(container)?.hits)
      return hits.flatMap((hit) => {
        const hitRecord = asRecord(hit)
        const resource = asRecord(hitRecord?.resource)
        if (!resource) {
          return []
        }
        const compact = compactDriveItem(resource)
        const summary = optionalStringValue(hitRecord?.summary)
        if (summary) {
          compact.summary = summary
        }
        return [compact]
      })
    })
  })
}

function compactSite(input: unknown) {
  const record = asRecord(input) ?? {}
  return compactFields(record, ["id", "name", "displayName", "webUrl", "createdDateTime", "lastModifiedDateTime"])
}

function compactDrive(input: unknown) {
  const record = asRecord(input) ?? {}
  return compactFields(record, ["id", "name", "driveType", "webUrl", "createdDateTime", "lastModifiedDateTime"])
}

function compactDriveItem(input: unknown): JsonRecord {
  const record = asRecord(input) ?? {}
  const compact = compactFields(record, [
    "id",
    "name",
    "webUrl",
    "size",
    "createdDateTime",
    "lastModifiedDateTime",
  ])
  const file = asRecord(record.file)
  const folder = asRecord(record.folder)
  const parentReference = asRecord(record.parentReference)

  if (typeof file?.mimeType === "string") {
    compact.mimeType = file.mimeType
  }
  if (typeof folder?.childCount === "number") {
    compact.folder = { childCount: folder.childCount }
  }
  if (parentReference) {
    compact.parentReference = compactFields(parentReference, ["driveId", "driveType", "id", "path", "siteId"])
  }
  return compact
}

function compactFields(record: JsonRecord, keys: string[]) {
  const compact: JsonRecord = {}
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      compact[key] = value
    }
  }
  return compact
}

function withNextLink<T extends JsonRecord>(result: T, payload: JsonRecord) {
  const nextLink = payload["@odata.nextLink"]
  if (typeof nextLink === "string") {
    return {
      ...result,
      nextLink,
    }
  }
  return result
}

function graphValue(payload: JsonRecord) {
  return arrayFrom(payload.value)
}

function pathWithQuery(path: string, params: URLSearchParams) {
  const query = params.toString()
  return query ? `${path}?${query}` : path
}

function appendOptionalTop(params: URLSearchParams, args: JsonRecord) {
  const top = optionalInteger(args, "top")
  if (top !== null) {
    params.set("$top", String(top))
  }
}

function graphSegment(value: string) {
  return encodeURIComponent(value)
}

function requiredString(args: JsonRecord, key: string) {
  const value = optionalString(args, key)
  if (!value) {
    throw new JsonRpcDispatchError(-32602, "invalid_params", { missing: key })
  }
  return value
}

function optionalString(args: JsonRecord, key: string) {
  return optionalStringValue(args[key])
}

function optionalStringValue(value: unknown) {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed || null
}

function optionalInteger(args: JsonRecord, key: string) {
  const value = args[key]
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new JsonRpcDispatchError(-32602, "invalid_params", { invalid: key })
  }
  return value
}

function optionalStringArray(args: JsonRecord, key: string) {
  const value = args[key]
  if (value === undefined || value === null) {
    return null
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new JsonRpcDispatchError(-32602, "invalid_params", { invalid: key })
  }
  return value.map((item) => item.trim())
}

function arrayFrom(value: unknown) {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as JsonRecord
}

function isSharePointToolName(value: string): value is SharePointToolName {
  return (SHAREPOINT_TOOL_NAMES as readonly string[]).includes(value)
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    result,
    id,
  }
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    error: data === undefined ? { code, message } : { code, message, data },
    id,
  }
}

function jsonRpcId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null ? value : null
}

function graphJsonRpcCode(error: MicrosoftGraphError) {
  if (error.status === 401) {
    return -32001
  }
  if (error.status === 403) {
    return -32003
  }
  if (error.status === 404) {
    return -32004
  }
  if (error.status === 413) {
    return -32013
  }
  if (error.status === 429) {
    return -32029
  }
  if (error.status >= 500) {
    return -32050
  }
  return -32000
}

function graphErrorData(error: MicrosoftGraphError) {
  const data: JsonRecord = {
    status: error.status,
  }
  if (error.graphCode) {
    data.graphCode = error.graphCode
  }
  if (error.graphMessage) {
    data.graphMessage = error.graphMessage
  }
  if (error.maxContentBytes !== null) {
    data.maxContentBytes = error.maxContentBytes
  }
  return data
}

class JsonRpcDispatchError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "JsonRpcDispatchError"
    this.code = code
    this.data = data
  }
}
