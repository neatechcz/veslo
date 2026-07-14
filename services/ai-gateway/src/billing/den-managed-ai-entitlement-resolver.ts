import { digestBearerTokenForCache } from "../auth/token-cache-key.js"

export type ManagedAiEntitlementDecision = {
  orgId: string
  canUseManagedAi: boolean
}

export type ManagedAiEntitlementResolver = {
  resolve(input: { token: string; requestedOrgId: string | null }): Promise<ManagedAiEntitlementDecision>
}

export class ManagedAiEntitlementLookupError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code)
    this.name = "ManagedAiEntitlementLookupError"
  }
}

type DenManagedAiEntitlementResolverOptions = {
  denApiBase: string
  fetchImpl?: typeof fetch
  now?: () => number
  cacheTtlMs?: number
  cacheMaxEntries?: number
  timeoutMs?: number
}

const DEFAULT_ENTITLEMENT_CACHE_TTL_MS = 15_000
const DEFAULT_ENTITLEMENT_CACHE_MAX_ENTRIES = 4_096
const DEFAULT_ENTITLEMENT_TIMEOUT_MS = 5_000
const SAFE_CONTEXT_ERRORS = new Map<string, number>([
  ["org_context_required", 400],
  ["organization_forbidden", 403],
  ["organization_required", 404],
])

function cloneDecision(decision: ManagedAiEntitlementDecision): ManagedAiEntitlementDecision {
  return { ...decision }
}

function unavailable(): ManagedAiEntitlementLookupError {
  return new ManagedAiEntitlementLookupError("managed_ai_entitlement_unavailable", 503)
}

export class DenManagedAiEntitlementResolver implements ManagedAiEntitlementResolver {
  private readonly denApiBase: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly cacheTtlMs: number
  private readonly cacheMaxEntries: number
  private readonly timeoutMs: number
  private readonly cache = new Map<string, { expiresAt: number; decision: ManagedAiEntitlementDecision }>()
  private readonly inFlight = new Map<string, Promise<ManagedAiEntitlementDecision>>()

  constructor(options: DenManagedAiEntitlementResolverOptions) {
    this.denApiBase = options.denApiBase.replace(/\/+$/, "")
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now())
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_ENTITLEMENT_CACHE_TTL_MS)
    this.cacheMaxEntries = Math.max(1, Math.floor(options.cacheMaxEntries ?? DEFAULT_ENTITLEMENT_CACHE_MAX_ENTRIES))
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_ENTITLEMENT_TIMEOUT_MS))
  }

  async resolve(input: { token: string; requestedOrgId: string | null }): Promise<ManagedAiEntitlementDecision> {
    const token = input.token.trim()
    if (!token) throw unavailable()
    const requestedOrgId = input.requestedOrgId?.trim() || null
    const cacheKey = `${digestBearerTokenForCache(token)}\0${requestedOrgId ?? ""}`
    const at = this.now()
    this.pruneCache(at)
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > at) return cloneDecision(cached.decision)
    if (cached) this.cache.delete(cacheKey)

    const current = this.inFlight.get(cacheKey)
    if (current) return cloneDecision(await current)

    const lookup = this.lookupFromDen({ token, requestedOrgId })
    this.inFlight.set(cacheKey, lookup)
    try {
      const decision = await lookup
      if (this.cacheTtlMs > 0) {
        this.pruneCache(this.now())
        while (this.cache.size >= this.cacheMaxEntries) {
          const oldestKey = this.cache.keys().next().value
          if (typeof oldestKey !== "string") break
          this.cache.delete(oldestKey)
        }
        this.cache.set(cacheKey, {
          expiresAt: this.now() + this.cacheTtlMs,
          decision: cloneDecision(decision),
        })
      }
      return cloneDecision(decision)
    } finally {
      if (this.inFlight.get(cacheKey) === lookup) this.inFlight.delete(cacheKey)
    }
  }

  private async lookupFromDen(input: {
    token: string
    requestedOrgId: string | null
  }): Promise<ManagedAiEntitlementDecision> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    timeout.unref?.()
    try {
      const response = await this.fetchImpl(`${this.denApiBase}/v1/managed-ai/entitlement`, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.token}`,
          ...(input.requestedOrgId ? { "x-veslo-org-id": input.requestedOrgId } : {}),
        },
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const code = typeof payload?.error === "string" ? payload.error : ""
        const safeStatus = SAFE_CONTEXT_ERRORS.get(code)
        if (safeStatus && response.status === safeStatus) {
          throw new ManagedAiEntitlementLookupError(code, safeStatus)
        }
        throw unavailable()
      }

      const orgId = typeof payload?.orgId === "string" ? payload.orgId.trim() : ""
      if (!orgId || typeof payload?.canUseManagedAi !== "boolean") throw unavailable()
      if (input.requestedOrgId && orgId !== input.requestedOrgId) throw unavailable()
      return { orgId, canUseManagedAi: payload.canUseManagedAi }
    } catch (error) {
      if (error instanceof ManagedAiEntitlementLookupError) throw error
      throw unavailable()
    } finally {
      clearTimeout(timeout)
    }
  }

  private pruneCache(at: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= at) this.cache.delete(key)
    }
  }
}
