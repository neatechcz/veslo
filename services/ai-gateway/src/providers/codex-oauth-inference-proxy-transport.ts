import {
  headersToRecord,
  ProviderTransportError,
  readProviderResponseBody,
  type CodexChatCompletionsTransportInput,
  type CodexOAuthProviderTransport,
  type ProviderTransportResponse,
} from "./transport.js";
import type { TokenUsageAccounting } from "../usage/token-accounting.js";

const CODEX_RESPONSES_PATH = "/backend-api/codex/responses";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com";
const DEFAULT_INSTRUCTIONS = "You are a helpful coding assistant.";

export type CodexOAuthInferenceProxyTransportDeps = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export class CodexOAuthInferenceProxyTransport implements CodexOAuthProviderTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: CodexOAuthInferenceProxyTransportDeps = {}) {
    this.baseUrl = (
      deps.baseUrl ??
      process.env.AI_GATEWAY_CODEX_OAUTH_INFERENCE_BASE_URL ??
      process.env.AI_GATEWAY_CODEX_OAUTH_BASE_URL ??
      DEFAULT_CODEX_BASE_URL
    ).replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async chatCompletions(input: CodexChatCompletionsTransportInput): Promise<ProviderTransportResponse> {
    const auth = readCodexAuth(input.authJson);
    const requestBody = getRecord(input.body);
    const wantsStream = getBoolean(requestBody, "stream") === true;
    const responsesRequest = toCodexResponsesRequest(input.body);

    const response = await this.fetchImpl(resolveResponsesUrl(this.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.accessToken}`,
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
      },
      body: JSON.stringify(responsesRequest),
    });

    const headers = headersToRecord(response.headers);
    if (!response.ok) {
      const body = await readProviderResponseBody(response);
      throw new ProviderTransportError(getUpstreamErrorMessage(body) ?? `codex_oauth_upstream_${response.status}`, {
        statusCode: response.status,
        code: getUpstreamErrorCode(body),
        body,
        headers,
      });
    }

    const parsedResponse = parseCodexResponsesSse(await response.text(), getString(requestBody, "model"));
    const body = wantsStream ? toChatCompletionSse(parsedResponse) : toChatCompletionBody(parsedResponse);

    return {
      status: response.status,
      body,
      headers: {
        ...headers,
        "content-type": wantsStream ? "text/event-stream" : "application/json",
      },
      usage: parsedResponse.usage ?? undefined,
    };
  }
}

type CodexResponsesParsed = {
  id: string;
  created: number;
  model: string;
  textDeltas: string[];
  toolCalls: ChatCompletionToolCall[];
  usage: TokenUsageAccounting | null;
};

type ChatCompletionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

function resolveResponsesUrl(baseUrl: string): string {
  if (baseUrl.endsWith(CODEX_RESPONSES_PATH)) {
    return baseUrl;
  }

  return `${baseUrl}${CODEX_RESPONSES_PATH}`;
}

function toCodexResponsesRequest(body: unknown): Record<string, unknown> {
  const request = getRecord(body);
  if (!request) {
    throw new ProviderTransportError("codex_oauth_invalid_request_body", {
      statusCode: 400,
      code: "codex_oauth_invalid_request_body",
      body: { error: "codex_oauth_invalid_request_body" },
    });
  }

  const model = getString(request, "model");
  if (!model) {
    throw new ProviderTransportError("codex_oauth_model_required", {
      statusCode: 400,
      code: "codex_oauth_model_required",
      body: { error: "codex_oauth_model_required" },
    });
  }

  const messages = readArray(request.messages);
  const responsesRequest: Record<string, unknown> = {
    model,
    instructions: readInstructions(messages),
    input: readResponsesInput(messages),
    stream: true,
    store: false,
  };

  const tools = readResponsesTools(readArray(request.tools));
  if (tools.length > 0) {
    responsesRequest.tools = tools;
  }

  const toolChoice = readResponsesToolChoice(request.tool_choice);
  if (toolChoice !== null) {
    responsesRequest.tool_choice = toolChoice;
  }

  const maxOutputTokens = readFiniteNumber(request.max_completion_tokens) ?? readFiniteNumber(request.max_tokens);
  if (maxOutputTokens !== null) {
    responsesRequest.max_output_tokens = maxOutputTokens;
  }

  const temperature = readFiniteNumber(request.temperature);
  if (temperature !== null) {
    responsesRequest.temperature = temperature;
  }

  const topP = readFiniteNumber(request.top_p);
  if (topP !== null) {
    responsesRequest.top_p = topP;
  }

  const parallelToolCalls = getBoolean(request, "parallel_tool_calls");
  if (parallelToolCalls !== null) {
    responsesRequest.parallel_tool_calls = parallelToolCalls;
  }

  const reasoning = getRecord(request.reasoning);
  if (reasoning) {
    responsesRequest.reasoning = reasoning;
  }

  return responsesRequest;
}

function readInstructions(messages: unknown[]): string {
  const instructions = messages
    .map((message) => getRecord(message))
    .filter((message): message is Record<string, unknown> => {
      const role = getString(message, "role");
      return role === "system" || role === "developer";
    })
    .map((message) => readContentText(message.content))
    .filter((text) => text.length > 0);

  return instructions.length > 0 ? instructions.join("\n\n") : DEFAULT_INSTRUCTIONS;
}

function readResponsesInput(messages: unknown[]): unknown[] {
  const input: unknown[] = [];

  for (const value of messages) {
    const message = getRecord(value);
    const role = getString(message, "role");
    if (!message || role === "system" || role === "developer") {
      continue;
    }

    if (role === "user") {
      const text = readContentText(message.content);
      if (text.length > 0) {
        input.push({ role: "user", content: [{ type: "input_text", text }] });
      }
      continue;
    }

    if (role === "assistant") {
      const text = readContentText(message.content);
      if (text.length > 0) {
        input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      }

      for (const toolCall of readAssistantToolCalls(message.tool_calls)) {
        input.push(toolCall);
      }
      continue;
    }

    if (role === "tool") {
      const callId = getString(message, "tool_call_id") ?? getString(message, "call_id");
      if (callId) {
        input.push({
          type: "function_call_output",
          call_id: callId,
          output: readContentText(message.content),
        });
      }
    }
  }

  return input;
}

function readAssistantToolCalls(value: unknown): unknown[] {
  const toolCalls: unknown[] = [];
  for (const toolCall of readArray(value)) {
    const record = getRecord(toolCall);
    const fn = getRecord(record?.function);
    const name = getString(fn, "name");
    if (!record || !name) {
      continue;
    }

    toolCalls.push({
      type: "function_call",
      call_id: getString(record, "id") ?? `call_${name}`,
      name,
      arguments: getRawString(fn, "arguments") ?? "",
    });
  }

  return toolCalls;
}

function readContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    const record = getRecord(content);
    return getRawString(record, "text") ?? "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      const record = getRecord(part);
      const type = getString(record, "type");
      if (type === "text" || type === "input_text" || type === "output_text") {
        return getRawString(record, "text") ?? "";
      }

      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function readResponsesTools(tools: unknown[]): unknown[] {
  return tools
    .map((tool) => {
      const record = getRecord(tool);
      if (getString(record, "type") !== "function") {
        return null;
      }

      const fn = getRecord(record?.function);
      const name = getString(fn, "name") ?? getString(record, "name");
      if (!name) {
        return null;
      }

      const responsesTool: Record<string, unknown> = {
        type: "function",
        name,
      };

      const description = getString(fn, "description") ?? getString(record, "description");
      if (description) {
        responsesTool.description = description;
      }

      const parameters = fn?.parameters ?? record?.parameters;
      if (parameters) {
        responsesTool.parameters = parameters;
      }

      const strict = getBoolean(fn, "strict") ?? getBoolean(record, "strict");
      if (strict !== null) {
        responsesTool.strict = strict;
      }

      return responsesTool;
    })
    .filter((tool): tool is Record<string, unknown> => tool !== null);
}

function readResponsesToolChoice(value: unknown): unknown | null {
  if (typeof value === "string") {
    return value;
  }

  const record = getRecord(value);
  if (!record) {
    return null;
  }

  const fn = getRecord(record.function);
  const name = getString(fn, "name");
  if (getString(record, "type") === "function" && name) {
    return { type: "function", name };
  }

  return null;
}

function parseCodexResponsesSse(body: string, fallbackModel: string | null): CodexResponsesParsed {
  const parsed: CodexResponsesParsed = {
    id: "resp_codex_oauth",
    created: Math.floor(Date.now() / 1000),
    model: fallbackModel ?? "unknown",
    textDeltas: [],
    toolCalls: [],
    usage: null,
  };
  const toolCallsByKey = new Map<string, ChatCompletionToolCall & { index: number }>();

  for (const event of parseSseEvents(body)) {
    const data = getRecord(event.data);
    if (!data) {
      continue;
    }

    const response = getRecord(data.response);
    if (response) {
      parsed.id = getString(response, "id") ?? parsed.id;
      parsed.created = readFiniteNumber(response.created_at) ?? parsed.created;
      parsed.model = getString(response, "model") ?? parsed.model;
      parsed.usage = readResponsesUsage(response.usage) ?? parsed.usage;
    }

    const type = getString(data, "type") ?? event.event;
    if (type === "response.output_text.delta") {
      const delta = getRawString(data, "delta");
      if (delta !== null) {
        parsed.textDeltas.push(delta);
      }
      continue;
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = getRecord(data.item);
      if (item && getString(item, "type") === "function_call") {
        upsertFunctionCall(toolCallsByKey, data, item);
      }
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      const toolCall = getFunctionCallByData(toolCallsByKey, data);
      const delta = getRawString(data, "delta");
      if (toolCall && delta !== null) {
        toolCall.function.arguments += delta;
      }
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const toolCall = getFunctionCallByData(toolCallsByKey, data);
      const args = getRawString(data, "arguments");
      if (toolCall && args !== null) {
        toolCall.function.arguments = args;
      }
    }
  }

  parsed.toolCalls = [...toolCallsByKey.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ index: _index, ...toolCall }) => toolCall);

  return parsed;
}

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    if (dataLines.length === 0) {
      continue;
    }

    const rawData = dataLines.join("\n");
    if (rawData === "[DONE]") {
      continue;
    }

    try {
      events.push({ event, data: JSON.parse(rawData) });
    } catch {
      events.push({ event, data: rawData });
    }
  }

  return events;
}

function upsertFunctionCall(
  toolCallsByKey: Map<string, ChatCompletionToolCall & { index: number }>,
  data: Record<string, unknown>,
  item: Record<string, unknown>,
): void {
  const key = getFunctionCallKey(data, item);
  const existing = toolCallsByKey.get(key);
  const name = getString(item, "name") ?? existing?.function.name;
  if (!name) {
    return;
  }

  const toolCall = existing ?? {
    index: readFiniteNumber(data.output_index) ?? toolCallsByKey.size,
    id: getString(item, "call_id") ?? getString(item, "id") ?? key,
    type: "function" as const,
    function: {
      name,
      arguments: "",
    },
  };
  toolCall.id = getString(item, "call_id") ?? toolCall.id;
  toolCall.function.name = name;

  const args = getRawString(item, "arguments");
  if (args !== null) {
    toolCall.function.arguments = args;
  }

  toolCallsByKey.set(key, toolCall);
}

function getFunctionCallByData(
  toolCallsByKey: Map<string, ChatCompletionToolCall & { index: number }>,
  data: Record<string, unknown>,
): (ChatCompletionToolCall & { index: number }) | null {
  const key =
    getString(data, "item_id") ??
    getString(data, "output_item_id") ??
    (readFiniteNumber(data.output_index) !== null ? `index:${readFiniteNumber(data.output_index)}` : null);
  if (key && toolCallsByKey.has(key)) {
    return toolCallsByKey.get(key) ?? null;
  }

  if (toolCallsByKey.size === 1) {
    return [...toolCallsByKey.values()][0] ?? null;
  }

  return null;
}

function getFunctionCallKey(data: Record<string, unknown>, item: Record<string, unknown>): string {
  return (
    getString(item, "id") ??
    getString(data, "item_id") ??
    getString(data, "output_item_id") ??
    (readFiniteNumber(data.output_index) !== null ? `index:${readFiniteNumber(data.output_index)}` : "index:0")
  );
}

function toChatCompletionBody(parsed: CodexResponsesParsed): Record<string, unknown> {
  const toolCalls = parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined;
  const body: Record<string, unknown> = {
    id: parsed.id,
    object: "chat.completion",
    created: parsed.created,
    model: parsed.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls ? null : parsed.textDeltas.join(""),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
  };

  const usage = toOpenAiUsage(parsed.usage);
  if (usage) {
    body.usage = usage;
  }

  return body;
}

function toChatCompletionSse(parsed: CodexResponsesParsed): string {
  const events: string[] = [];
  const writeChunk = (chunk: Record<string, unknown>) => {
    events.push(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  const makeChunk = (choice: Record<string, unknown>): Record<string, unknown> => ({
    id: parsed.id,
    object: "chat.completion.chunk",
    created: parsed.created,
    model: parsed.model,
    choices: [choice],
  });

  writeChunk(makeChunk({ index: 0, delta: { role: "assistant" }, finish_reason: null }));

  for (const delta of parsed.textDeltas) {
    writeChunk(makeChunk({ index: 0, delta: { content: delta }, finish_reason: null }));
  }

  parsed.toolCalls.forEach((toolCall, index) => {
    writeChunk(
      makeChunk({
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...toolCall,
            },
          ],
        },
        finish_reason: null,
      }),
    );
  });

  writeChunk(
    makeChunk({
      index: 0,
      delta: {},
      finish_reason: parsed.toolCalls.length > 0 ? "tool_calls" : "stop",
    }),
  );
  events.push("data: [DONE]\n\n");

  return events.join("");
}

function toOpenAiUsage(usage: TokenUsageAccounting | null): Record<string, unknown> | null {
  if (!usage) {
    return null;
  }

  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cachedTokens,
    },
  };
}

function readResponsesUsage(value: unknown): TokenUsageAccounting | null {
  const usage = getRecord(value);
  if (!usage) {
    return null;
  }

  const inputTokens = readFiniteNumber(usage.input_tokens) ?? 0;
  const outputTokens = readFiniteNumber(usage.output_tokens) ?? 0;
  const cachedTokens = readFiniteNumber(getRecord(usage.input_tokens_details)?.cached_tokens) ?? 0;
  const totalTokens = readFiniteNumber(usage.total_tokens) ?? inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
  };
}

function readCodexAuth(authJson: string | null | undefined): { accessToken: string; accountId: string | null } {
  const raw = authJson?.trim() ?? "";
  if (!raw) {
    throw new ProviderTransportError("codex_oauth_auth_json_required", {
      statusCode: 503,
      code: "codex_oauth_auth_json_required",
      body: { error: "codex_oauth_auth_json_required" },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderTransportError("codex_oauth_auth_json_invalid", {
      statusCode: 503,
      code: "codex_oauth_auth_json_invalid",
      body: { error: "codex_oauth_auth_json_invalid" },
    });
  }

  const record = getRecord(parsed);
  const tokens = getRecord(record?.tokens);
  const accessToken = getString(tokens, "access_token") ?? getString(record, "access_token");
  if (!accessToken) {
    throw new ProviderTransportError("codex_oauth_access_token_required", {
      statusCode: 503,
      code: "codex_oauth_access_token_required",
      body: { error: "codex_oauth_access_token_required" },
    });
  }

  return {
    accessToken,
    accountId: getString(tokens, "account_id") ?? getString(record, "account_id"),
  };
}

function getUpstreamErrorCode(body: unknown): string | undefined {
  const error = getRecord(getRecord(body)?.error);
  const record = getRecord(body);
  const code = error?.code ?? record?.code ?? record?.type;
  return typeof code === "string" ? code : undefined;
}

function getUpstreamErrorMessage(body: unknown): string | undefined {
  const error = getRecord(getRecord(body)?.error);
  const record = getRecord(body);
  const message = error?.message ?? record?.detail ?? record?.message;
  return typeof message === "string" ? message : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getRawString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function getBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
