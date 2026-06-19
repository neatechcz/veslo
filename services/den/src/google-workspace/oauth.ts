import type { GoogleWorkspaceConnectorId } from "./connectors.js"

export type StartGoogleWorkspaceAuthorizationInput = {
  state: string
  scopes: string[]
  redirectUri: string
  connectorId: GoogleWorkspaceConnectorId
}

export type StartGoogleWorkspaceAuthorizationResult = {
  authorizeUrl: string
}

export type GoogleWorkspaceOAuthGrant = {
  accessToken: string
  refreshToken: string
  expiresAt: string
  scope?: string
}

export type ExchangeGoogleWorkspaceCodeInput = {
  code: string
  redirectUri: string
  connectorId: GoogleWorkspaceConnectorId
  scopes: string[]
}

export type RefreshGoogleWorkspaceTokenInput = {
  refreshToken: string
  connectorId: GoogleWorkspaceConnectorId
}

export interface GoogleWorkspaceOAuthClient {
  startAuthorization(input: StartGoogleWorkspaceAuthorizationInput): Promise<StartGoogleWorkspaceAuthorizationResult>
  exchangeCode(input: ExchangeGoogleWorkspaceCodeInput): Promise<GoogleWorkspaceOAuthGrant>
  refreshToken(input: RefreshGoogleWorkspaceTokenInput): Promise<GoogleWorkspaceOAuthGrant>
  revokeToken(refreshToken: string): Promise<void>
}

export function createUnavailableGoogleWorkspaceOAuthClient(
  message = "google_workspace_oauth_not_configured",
): GoogleWorkspaceOAuthClient {
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

export type DefaultGoogleWorkspaceOAuthClientDeps = {
  clientId: string
  clientSecret: string
  fetchImpl?: typeof fetch
  now?: () => Date
}

export class DefaultGoogleWorkspaceOAuthClient implements GoogleWorkspaceOAuthClient {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(private readonly deps: DefaultGoogleWorkspaceOAuthClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.now = deps.now ?? (() => new Date())
  }

  async startAuthorization(input: StartGoogleWorkspaceAuthorizationInput) {
    const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
    authorizeUrl.searchParams.set("response_type", "code")
    authorizeUrl.searchParams.set("client_id", this.deps.clientId)
    authorizeUrl.searchParams.set("redirect_uri", input.redirectUri)
    authorizeUrl.searchParams.set("scope", input.scopes.join(" "))
    authorizeUrl.searchParams.set("state", input.state)
    authorizeUrl.searchParams.set("access_type", "offline")
    authorizeUrl.searchParams.set("prompt", "consent")
    authorizeUrl.searchParams.set("include_granted_scopes", "true")

    return {
      authorizeUrl: authorizeUrl.toString(),
    }
  }

  async exchangeCode(input: ExchangeGoogleWorkspaceCodeInput): Promise<GoogleWorkspaceOAuthGrant> {
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
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

    return this.parseTokenResponse(response, "google_workspace_oauth_exchange_failed", true)
  }

  async refreshToken(input: RefreshGoogleWorkspaceTokenInput): Promise<GoogleWorkspaceOAuthGrant> {
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
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

    const grant = await this.parseTokenResponse(response, "google_workspace_oauth_refresh_failed", false)
    return {
      ...grant,
      refreshToken: grant.refreshToken || input.refreshToken,
    }
  }

  async revokeToken(refreshToken: string): Promise<void> {
    if (!refreshToken.trim()) {
      return
    }
    const response = await this.fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: refreshToken }),
    })
    if (!response.ok) {
      throw new Error(`google_workspace_oauth_revoke_failed_${response.status}`)
    }
  }

  private async parseTokenResponse(
    response: Response,
    fallbackError: string,
    requireRefreshToken: boolean,
  ): Promise<GoogleWorkspaceOAuthGrant> {
    const payload = (await response.json().catch(() => null)) as {
      access_token?: unknown
      refresh_token?: unknown
      expires_in?: unknown
      scope?: unknown
      error?: unknown
      error_description?: unknown
    } | null

    if (!response.ok) {
      const message =
        typeof payload?.error_description === "string"
          ? payload.error_description
          : typeof payload?.error === "string"
            ? payload.error
            : fallbackError
      throw new Error(message)
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
