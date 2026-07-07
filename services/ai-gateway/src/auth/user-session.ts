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

const DEFAULT_USER_SESSION_CACHE_TTL_MS = 30_000

export type DenUserSessionResolverDeps = {
  denApiBase: string
  fetchImpl?: typeof fetch
  now?: () => number
  sessionCacheTtlMs?: number
}

function hashSessionCacheToken(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

function cloneSession(session: UserSession): UserSession {
  return {
    token: session.token,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
  }
}

export class DenUserSessionResolver implements UserSessionResolver {
  private readonly denApiBase: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sessionCacheTtlMs: number
  private readonly positiveCache = new Map<string, { expiresAt: number; session: UserSession }>()
  private readonly inFlight = new Map<string, Promise<UserSession | null>>()

  constructor(deps: DenUserSessionResolverDeps) {
    this.denApiBase = deps.denApiBase.replace(/\/+$/, "")
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.now = deps.now ?? (() => Date.now())
    this.sessionCacheTtlMs = Math.max(0, deps.sessionCacheTtlMs ?? DEFAULT_USER_SESSION_CACHE_TTL_MS)
  }

  async resolveSession(token: string): Promise<UserSession | null> {
    const trimmedToken = token.trim()
    if (!trimmedToken) {
      return null
    }

    const cacheKey = hashSessionCacheToken(trimmedToken)
    const cached = this.positiveCache.get(cacheKey)
    const at = this.now()
    if (cached && cached.expiresAt > at) {
      return cloneSession(cached.session)
    }
    if (cached) {
      this.positiveCache.delete(cacheKey)
    }

    const inFlight = this.inFlight.get(cacheKey)
    if (inFlight) {
      const session = await inFlight
      return session ? cloneSession(session) : null
    }

    const lookup = this.resolveSessionFromDen(trimmedToken, cacheKey)
    this.inFlight.set(cacheKey, lookup)
    try {
      const session = await lookup
      return session ? cloneSession(session) : null
    } finally {
      if (this.inFlight.get(cacheKey) === lookup) {
        this.inFlight.delete(cacheKey)
      }
    }
  }

  private async resolveSessionFromDen(trimmedToken: string, cacheKey: string): Promise<UserSession | null> {
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

    const session = {
      token: trimmedToken,
      user: {
        id: userId,
        email: email || undefined,
        name: name || undefined,
      },
    }
    if (this.sessionCacheTtlMs > 0) {
      this.positiveCache.set(cacheKey, {
        expiresAt: this.now() + this.sessionCacheTtlMs,
        session,
      })
    }
    return session
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
