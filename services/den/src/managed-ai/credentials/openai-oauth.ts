import { OpenAiOAuthRefreshError } from "./default-token-broker.js"

export type StartOpenAiAuthorizationInput = {
  state: string
}

export type StartOpenAiAuthorizationResult = {
  authorizeUrl: string
}

export type ExchangeOpenAiCodeInput = {
  code: string
}

export type OpenAiOAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: string
}

export type RefreshOpenAiTokenInput = {
  refreshToken: string
}

export interface OpenAiOAuthClient {
  startAuthorization(input: StartOpenAiAuthorizationInput): Promise<StartOpenAiAuthorizationResult>
  exchangeCode(input: ExchangeOpenAiCodeInput): Promise<OpenAiOAuthTokens>
  refreshToken(input: RefreshOpenAiTokenInput): Promise<OpenAiOAuthTokens>
}

export type DefaultOpenAiOAuthClientDeps = {
  clientId: string
  clientSecret: string
  redirectBase: string
  fetchImpl?: typeof fetch
  now?: () => Date
}

export class DefaultOpenAiOAuthClient implements OpenAiOAuthClient {
  private readonly redirectBase: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly deps: DefaultOpenAiOAuthClientDeps) {
    this.redirectBase = deps.redirectBase.replace(/\/+$/, "")
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.now = deps.now ?? (() => new Date())
  }

  async startAuthorization(input: StartOpenAiAuthorizationInput): Promise<StartOpenAiAuthorizationResult> {
    const authorizeUrl = new URL("https://auth.openai.com/oauth/authorize")
    authorizeUrl.searchParams.set("response_type", "code")
    authorizeUrl.searchParams.set("client_id", this.deps.clientId)
    authorizeUrl.searchParams.set("redirect_uri", this.redirectBase)
    authorizeUrl.searchParams.set("scope", "openid offline_access")
    authorizeUrl.searchParams.set("state", input.state)

    return {
      authorizeUrl: authorizeUrl.toString(),
    }
  }

  async exchangeCode(input: ExchangeOpenAiCodeInput): Promise<OpenAiOAuthTokens> {
    const response = await this.fetchImpl("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: this.deps.clientId,
        client_secret: this.deps.clientSecret,
        redirect_uri: this.redirectBase,
      }),
    })

    const payload = (await response.json().catch(() => null)) as {
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
      error?: unknown
      error_description?: unknown
    } | null

    if (!response.ok) {
      const message =
        typeof payload?.error_description === "string"
          ? payload.error_description
          : typeof payload?.error === "string"
            ? payload.error
            : "openai_oauth_exchange_failed"
      throw new Error(message)
    }

    const accessToken = typeof payload?.access_token === "string" ? payload.access_token : ""
    const refreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : ""
    const expiresInSeconds =
      typeof payload?.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600

    if (!accessToken || !refreshToken) {
      throw new Error("openai_oauth_exchange_invalid_response")
    }

    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(this.now().getTime() + expiresInSeconds * 1000).toISOString(),
    }
  }

  async refreshToken(input: RefreshOpenAiTokenInput): Promise<OpenAiOAuthTokens> {
    const response = await this.fetchImpl("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        client_id: this.deps.clientId,
        client_secret: this.deps.clientSecret,
      }),
    })

    const payload = (await response.json().catch(() => null)) as {
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
      error?: unknown
      error_description?: unknown
    } | null

    if (!response.ok) {
      const code = typeof payload?.error === "string" ? payload.error : undefined
      const message =
        typeof payload?.error_description === "string"
          ? payload.error_description
          : code ?? "openai_oauth_refresh_failed"

      throw new OpenAiOAuthRefreshError(classifyRefreshError(response.status, code), message)
    }

    const accessToken = typeof payload?.access_token === "string" ? payload.access_token : ""
    const refreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : input.refreshToken
    const expiresInSeconds =
      typeof payload?.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600

    if (!accessToken) {
      throw new OpenAiOAuthRefreshError("transient_upstream", "openai_oauth_refresh_invalid_response")
    }

    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(this.now().getTime() + expiresInSeconds * 1000).toISOString(),
    }
  }
}

function classifyRefreshError(
  statusCode: number,
  code: string | undefined,
): "refreshable_auth" | "permanent_credential" | "transient_upstream" {
  if (code === "invalid_grant") {
    return "permanent_credential"
  }

  if (statusCode >= 500 || statusCode === 429) {
    return "transient_upstream"
  }

  return "refreshable_auth"
}
