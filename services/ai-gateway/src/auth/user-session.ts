export type UserSession = {
  token: string
  user: {
    id: string
    email?: string
    name?: string
  }
}

export interface UserSessionResolver {
  resolveSession(token: string): Promise<UserSession | null>
}

export type DenUserSessionResolverDeps = {
  denApiBase: string
  fetchImpl?: typeof fetch
}

export class DenUserSessionResolver implements UserSessionResolver {
  private readonly denApiBase: string
  private readonly fetchImpl: typeof fetch

  constructor(deps: DenUserSessionResolverDeps) {
    this.denApiBase = deps.denApiBase.replace(/\/+$/, "")
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  async resolveSession(token: string): Promise<UserSession | null> {
    const trimmedToken = token.trim()
    if (!trimmedToken) {
      return null
    }

    const response = await this.fetchImpl(`${this.denApiBase}/v1/me`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${trimmedToken}`,
      },
    })

    if (!response.ok) {
      return null
    }

    const payload = (await response.json()) as {
      user?: {
        id?: unknown
        email?: unknown
        name?: unknown
      }
    }
    const userId = typeof payload?.user?.id === "string" ? payload.user.id.trim() : ""
    if (!userId) {
      return null
    }

    const email = typeof payload?.user?.email === "string" ? payload.user.email.trim() : ""
    const name = typeof payload?.user?.name === "string" ? payload.user.name.trim() : ""

    return {
      token: trimmedToken,
      user: {
        id: userId,
        email: email || undefined,
        name: name || undefined,
      },
    }
  }
}

export function readBearerToken(header: string | null | undefined): string | null {
  if (!header) {
    return null
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token || null
}
