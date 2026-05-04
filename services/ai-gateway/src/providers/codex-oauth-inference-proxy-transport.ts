import {
  headersToRecord,
  ProviderTransportError,
  readProviderResponseBody,
  type CodexChatCompletionsTransportInput,
  type CodexOAuthProviderTransport,
  type ProviderTransportResponse,
} from "./transport.js";

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
      "https://api.openai.com"
    ).replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async chatCompletions(input: CodexChatCompletionsTransportInput): Promise<ProviderTransportResponse> {
    const auth = readCodexAuth(input.authJson);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.accessToken}`,
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
      },
      body: JSON.stringify(input.body),
    });

    const body = await readProviderResponseBody(response);
    const headers = headersToRecord(response.headers);
    if (!response.ok) {
      throw new ProviderTransportError(getUpstreamErrorMessage(body) ?? `codex_oauth_upstream_${response.status}`, {
        statusCode: response.status,
        code: getUpstreamErrorCode(body),
        body,
        headers,
      });
    }

    return {
      status: response.status,
      body,
      headers,
    };
  }
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
  const code = error?.code;
  return typeof code === "string" ? code : undefined;
}

function getUpstreamErrorMessage(body: unknown): string | undefined {
  const error = getRecord(getRecord(body)?.error);
  const message = error?.message;
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
