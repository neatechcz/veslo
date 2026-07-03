import type { MicrosoftConnectorId } from "./connectors.js"

const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/organizations/oauth2/v2.0"
const MICROSOFT_AUTHORIZE_URL = `${MICROSOFT_AUTHORITY}/authorize`
const MICROSOFT_TOKEN_URL = `${MICROSOFT_AUTHORITY}/token`

export type StartMicrosoftAuthorizationInput = {
  state: string
  scopes: string[]
  redirectUri: string
  connectorId: MicrosoftConnectorId
}

export type StartMicrosoftAuthorizationResult = {
  authorizeUrl: string
}

export type MicrosoftOAuthGrant = {
  accessToken: string
  refreshToken: string
  expiresAt: string
  scope?: string
}

export type ExchangeMicrosoftCodeInput = {
  code: string
  redirectUri: string
  connectorId: MicrosoftConnectorId
  scopes: string[]
}

export type RefreshMicrosoftTokenInput = {
  refreshToken: string
  connectorId: MicrosoftConnectorId
}

export interface MicrosoftOAuthClient {
  startAuthorization(input: StartMicrosoftAuthorizationInput): Promise<StartMicrosoftAuthorizationResult>
  exchangeCode(input: ExchangeMicrosoftCodeInput): Promise<MicrosoftOAuthGrant>
  refreshToken(input: RefreshMicrosoftTokenInput): Promise<MicrosoftOAuthGrant>
  revokeToken(refreshToken: string): Promise<void>
}

export function createUnavailableMicrosoftOAuthClient(
  message = "microsoft_oauth_not_configured",
): MicrosoftOAuthClient {
  async function reject(): Promise<never> {
    throw new Error(message)
  }

  return {
    startAuthorization: reject,
    exchangeCode: reject,
    refreshToken: reject,
    revokeToken: async () => undefined,
  }
}

export type DefaultMicrosoftOAuthClientDeps = {
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
  now?: () => Date
}

export class DefaultMicrosoftOAuthClient implements MicrosoftOAuthClient {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly deps: DefaultMicrosoftOAuthClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.now = deps.now ?? (() => new Date())
  }

  async startAuthorization(input: StartMicrosoftAuthorizationInput): Promise<StartMicrosoftAuthorizationResult> {
    const authorizeUrl = new URL(MICROSOFT_AUTHORIZE_URL)
    authorizeUrl.searchParams.set("response_type", "code")
    authorizeUrl.searchParams.set("response_mode", "query")
    authorizeUrl.searchParams.set("client_id", this.deps.clientId)
    authorizeUrl.searchParams.set("redirect_uri", input.redirectUri)
    authorizeUrl.searchParams.set("scope", input.scopes.join(" "))
    authorizeUrl.searchParams.set("state", input.state)
    authorizeUrl.searchParams.set("prompt", "consent")

    return {
      authorizeUrl: authorizeUrl.toString(),
    }
  }

  async exchangeCode(input: ExchangeMicrosoftCodeInput): Promise<MicrosoftOAuthGrant> {
    const response = await this.fetchImpl(MICROSOFT_TOKEN_URL, {
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
        redirect_uri: input.redirectUri,
      }),
    })

    return this.parseTokenResponse(response, "microsoft_oauth_exchange_failed", true)
  }

  async refreshToken(input: RefreshMicrosoftTokenInput): Promise<MicrosoftOAuthGrant> {
    const response = await this.fetchImpl(MICROSOFT_TOKEN_URL, {
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

    const grant = await this.parseTokenResponse(response, "microsoft_oauth_refresh_failed", false)
    return {
      ...grant,
      refreshToken: grant.refreshToken || input.refreshToken,
    }
  }

  async revokeToken(_refreshToken: string): Promise<void> {
    return undefined
  }

  private async parseTokenResponse(
    response: Response,
    fallbackError: string,
    requireRefreshToken: boolean,
  ): Promise<MicrosoftOAuthGrant> {
    const payload = (await response.json().catch(() => null)) as {
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
      scope?: unknown
    } | null

    if (!response.ok) {
      throw new Error(fallbackError)
    }

    const accessToken = typeof payload?.access_token === "string" ? payload.access_token : ""
    const refreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : ""
    const expiresInSeconds =
      typeof payload?.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600

    if (!accessToken || (requireRefreshToken && !refreshToken)) {
      throw new Error(`${fallbackError}_invalid_response`)
    }

    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(this.now().getTime() + expiresInSeconds * 1000).toISOString(),
      ...(typeof payload?.scope === "string" ? { scope: payload.scope } : {}),
    }
  }
}
