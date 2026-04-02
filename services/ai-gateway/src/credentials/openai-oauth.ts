export type StartOpenAiAuthorizationInput = {
  userId: string
}

export type StartOpenAiAuthorizationResult = {
  authorizeUrl: string
}

export type ExchangeOpenAiCodeInput = {
  code: string
  userId: string
}

export type OpenAiOAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: string
}

export interface OpenAiOAuthClient {
  startAuthorization(input: StartOpenAiAuthorizationInput): Promise<StartOpenAiAuthorizationResult>
  exchangeCode(input: ExchangeOpenAiCodeInput): Promise<OpenAiOAuthTokens>
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
    authorizeUrl.searchParams.set("state", input.userId)

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
}
