import assert from "node:assert/strict"
import test from "node:test"

import type { BindingSelector } from "../src/managed-ai/leases/binding-selector.js"
import { LeaseBroker } from "../src/managed-ai/leases/lease-broker.js"
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../src/managed-ai/leases/repository.js"
import type { UpstreamFailureKind } from "../src/managed-ai/leases/error-classifier.js"

type Provider = ResolveLeaseInput["provider"]

function leaseKey(input: ResolveLeaseInput): string {
  return `${input.ownerUserId}:${input.provider}:${input.sessionId}`
}

function scope(ownerUserId: string, provider: Provider, sessionId: string): ResolveLeaseInput {
  return {
    ownerUserId,
    provider,
    sessionId,
  }
}

function normalizeLeaseScope(input: unknown): ResolveLeaseInput {
  if (
    typeof input === "object" &&
    input !== null &&
    "ownerUserId" in input &&
    typeof input.ownerUserId === "string" &&
    "provider" in input &&
    (input.provider === "openai" || input.provider === "anthropic") &&
    "sessionId" in input &&
    typeof input.sessionId === "string"
  ) {
    return input
  }

  throw new Error("lease_scope_required")
}

function normalizeCreateInput(input: CreateSessionLeaseInput): Required<CreateSessionLeaseInput> {
  if (typeof input.ownerUserId === "string" && typeof input.provider === "string") {
    return {
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    }
  }

  const resolved = normalizeLeaseScope(input.sessionId)
  return {
    ownerUserId: resolved.ownerUserId,
    provider: resolved.provider,
    sessionId: resolved.sessionId,
    activeBindingId: input.activeBindingId,
  }
}

function normalizeRebindInput(input: RebindSessionLeaseInput): Required<RebindSessionLeaseInput> {
  if (typeof input.ownerUserId === "string" && typeof input.provider === "string") {
    return {
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      sessionId: input.sessionId,
      expectedCurrentBindingId: input.expectedCurrentBindingId,
      nextBindingId: input.nextBindingId,
    }
  }

  const resolved = normalizeLeaseScope(input.sessionId)
  return {
    ownerUserId: resolved.ownerUserId,
    provider: resolved.provider,
    sessionId: resolved.sessionId,
    expectedCurrentBindingId: input.expectedCurrentBindingId,
    nextBindingId: input.nextBindingId,
  }
}

class InMemoryLeaseRepository implements LeaseRepository {
  private readonly leasesByKey = new Map<string, SessionLease>()
  private leaseIdCounter = 0
  private forcedCasMismatch:
    | {
        key: string
        winnerBindingId: string
      }
    | null = null

  public createCalls = 0
  public rebindCalls = 0
  public lastRebindInput: RebindSessionLeaseInput | null = null

  forceNextCasMismatch(input: ResolveLeaseInput, winnerBindingId: string): void {
    this.forcedCasMismatch = { key: leaseKey(input), winnerBindingId }
  }

  async getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null> {
    return this.leasesByKey.get(leaseKey(input)) ?? null
  }

  async createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    const normalized = normalizeCreateInput(input)
    const key = leaseKey(normalized)
    const existing = this.leasesByKey.get(key)
    if (existing) {
      return existing
    }

    this.createCalls += 1
    const created: SessionLease = {
      id: `lease_${++this.leaseIdCounter}`,
      ownerUserId: normalized.ownerUserId,
      provider: normalized.provider,
      sessionId: normalized.sessionId,
      activeBindingId: normalized.activeBindingId,
    }
    this.leasesByKey.set(key, created)
    return created
  }

  async rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    const normalized = normalizeRebindInput(input)
    const key = leaseKey(normalized)
    this.rebindCalls += 1
    this.lastRebindInput = normalized

    const current = this.leasesByKey.get(key)
    if (!current) {
      throw new Error(`lease_missing:${key}`)
    }

    if (this.forcedCasMismatch && this.forcedCasMismatch.key === key) {
      const winner = this.forcedCasMismatch
      this.forcedCasMismatch = null
      const externallyUpdated: SessionLease = {
        ...current,
        activeBindingId: winner.winnerBindingId,
      }
      this.leasesByKey.set(key, externallyUpdated)
      return null
    }

    if (current.activeBindingId !== normalized.expectedCurrentBindingId) {
      return null
    }

    const updated: SessionLease = { ...current, activeBindingId: normalized.nextBindingId }
    this.leasesByKey.set(key, updated)
    return updated
  }

  async getActiveLeaseBySessionId(sessionId: string): Promise<SessionLease | null> {
    return this.getActiveLease(normalizeLeaseScope(sessionId))
  }

  async createSessionLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    return this.createLeaseIfMissing(input)
  }

  async rebindSessionLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    return this.rebindLease(input)
  }
}

function createSelector() {
  let initialCounter = 0
  let replacementCounter = 1

  const calls = {
    initial: 0,
    replacement: 0,
  }

  const selector: BindingSelector = {
    async selectInitialBinding(input: ResolveLeaseInput) {
      calls.initial += 1
      initialCounter += 1
      return `${input.ownerUserId}:${input.provider}:${input.sessionId}:binding_${initialCounter}`
    },
    async selectReplacementBinding(input) {
      calls.replacement += 1
      replacementCounter += 1
      return `${input.ownerUserId}:${input.provider}:replacement_${replacementCounter}:after_${input.previousBindingId}`
    },
  }

  return { selector, calls }
}

async function triggerFailure(
  broker: LeaseBroker,
  leaseScope: ResolveLeaseInput,
  currentBindingId: string,
  failureKind: UpstreamFailureKind,
) {
  return broker.handleFailure({
    ...leaseScope,
    currentBindingId,
    failureKind,
  })
}

test("creates sticky provider-scoped leases", async () => {
  const repository = new InMemoryLeaseRepository()
  const { selector, calls } = createSelector()
  const broker = new LeaseBroker(repository, selector)
  const openAiScope = scope("user_dual", "openai", "session_shared")
  const anthropicScope = scope("user_dual", "anthropic", "session_shared")

  const first = await broker.getOrCreateActiveLease(openAiScope)
  const second = await broker.getOrCreateActiveLease(openAiScope)
  const anthropicLease = await broker.getOrCreateActiveLease(anthropicScope)

  assert.equal(first.id, second.id)
  assert.equal(first.activeBindingId, "user_dual:openai:session_shared:binding_1")
  assert.equal(anthropicLease.activeBindingId, "user_dual:anthropic:session_shared:binding_2")
  assert.equal(repository.createCalls, 2)
  assert.equal(calls.initial, 2)
})

test("rebinds after a permanent credential failure", async () => {
  const repository = new InMemoryLeaseRepository()
  const { selector, calls } = createSelector()
  const broker = new LeaseBroker(repository, selector)
  const leaseScope = scope("user_d", "openai", "session_d")

  const lease = await broker.getOrCreateActiveLease(leaseScope)
  const rebound = await triggerFailure(broker, leaseScope, lease.activeBindingId, "permanent_credential")

  assert.equal(repository.rebindCalls, 1)
  assert.equal(calls.replacement, 1)
  assert.equal(repository.lastRebindInput?.ownerUserId, "user_d")
  assert.equal(repository.lastRebindInput?.provider, "openai")
  assert.equal(repository.lastRebindInput?.expectedCurrentBindingId, "user_d:openai:session_d:binding_1")
  assert.equal(
    rebound.activeBindingId,
    "user_d:openai:replacement_2:after_user_d:openai:session_d:binding_1",
  )
})
