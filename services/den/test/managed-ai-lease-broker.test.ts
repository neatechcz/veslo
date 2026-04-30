import assert from "node:assert/strict"
import test from "node:test"

import type {
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  ListEligibleBindingsInput,
  ListRecentCredentialUsageInput,
} from "../src/managed-ai/credentials/repository.js"
import { DefaultBindingSelector, type BindingSelector } from "../src/managed-ai/leases/binding-selector.js"
import { LeaseBroker } from "../src/managed-ai/leases/lease-broker.js"
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../src/managed-ai/leases/repository.js"
import type { UpstreamFailureKind } from "../src/managed-ai/leases/error-classifier.js"
import type { CodexCredentialStatusProvider, CodexUsageStatus } from "../src/managed-ai/usage/codex-status.js"

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

class TestCredentialRepository implements CredentialRepository {
  public readonly listEligibleBindingsCalls: ListEligibleBindingsInput[] = []
  public readonly listRecentCredentialUsageCalls: ListRecentCredentialUsageInput[] = []
  public readonly listActiveLeasesByCredentialCalls: string[][] = []

  constructor(
    private readonly bindings: CredentialBinding[],
    private readonly records: CredentialRecord[] = [],
    private readonly usage: Array<{ credentialId: string; totalTokens: number; requestCount: number }> = [],
    private readonly activeLeases: Array<{ credentialId: string; activeLeases: number }> = [],
  ) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    return this.records.find((record) => record.id === credentialRecordId) ?? null
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return []
  }

  async listEligibleBindings(input: ListEligibleBindingsInput): Promise<CredentialBinding[]> {
    this.listEligibleBindingsCalls.push(input)
    return this.bindings.filter((binding) => {
      return binding.ownerUserId === input.ownerUserId &&
        binding.provider === input.provider &&
        (!input.excludeBindingId || binding.id !== input.excludeBindingId)
    })
  }

  async listRecentCredentialUsage(input: ListRecentCredentialUsageInput) {
    this.listRecentCredentialUsageCalls.push(input)
    return this.usage.filter((entry) => input.credentialIds.includes(entry.credentialId))
  }

  async listActiveLeasesByCredential(credentialIds: string[]) {
    this.listActiveLeasesByCredentialCalls.push(credentialIds)
    return this.activeLeases.filter((entry) => credentialIds.includes(entry.credentialId))
  }

  async markCredentialState(): Promise<void> {}
}

class TestCodexStatusProvider implements CodexCredentialStatusProvider {
  public readonly calls: Array<{ credentialId: string; credentialName: string }> = []

  constructor(private readonly statuses: Map<string, CodexUsageStatus | Error>) {}

  async getStatus(input: { credentialId: string; credentialName: string }): Promise<CodexUsageStatus> {
    this.calls.push(input)
    const result = this.statuses.get(input.credentialId)
    if (result instanceof Error) {
      throw result
    }
    return result ?? codexStatus()
  }
}

function codexBinding(
  id: string,
  credentialRecordId = `cred_${id}`,
  createdAt = "2026-04-01T00:00:00.000Z",
): CredentialBinding {
  return {
    id,
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialRecordId,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  }
}

function codexRecord(id: string, name = id): CredentialRecord {
  return {
    id,
    name,
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialType: "oauth",
    state: "healthy",
    secretRef: `secret_${id}`,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    lastFailureAt: null,
  }
}

function codexStatus(input: {
  available?: boolean
  fiveHourUsedPercent?: number | null
  weeklyUsedPercent?: number | null
  resetAt?: string | null
  label?: string
} = {}): CodexUsageStatus {
  return {
    available: input.available ?? true,
    source: input.fiveHourUsedPercent === undefined && input.weeklyUsedPercent === undefined
      ? "codex_exec_no_rate_limits"
      : "codex_exec_rate_limits",
    label: input.label ?? "Codex OK, limits unknown",
    checkedAt: "2026-04-30T10:00:00.000Z",
    limits: input.fiveHourUsedPercent === undefined && input.weeklyUsedPercent === undefined
      ? null
      : {
          fiveHour: input.fiveHourUsedPercent === undefined
            ? null
            : {
                label: "5h",
                usedPercent: input.fiveHourUsedPercent,
                windowMinutes: 300,
                resetAt: input.resetAt ?? "2026-04-30T11:00:00.000Z",
              },
          weekly: input.weeklyUsedPercent === undefined
            ? null
            : {
                label: "weekly",
                usedPercent: input.weeklyUsedPercent,
                windowMinutes: 10080,
                resetAt: input.resetAt ?? "2026-04-30T11:00:00.000Z",
              },
        },
  }
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

test("codex_oauth selector skips exhausted bindings when another eligible credential exists", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_exhausted", "cred_exhausted", "2026-04-01T00:00:00.000Z"),
      codexBinding("binding_healthy", "cred_healthy", "2026-04-02T00:00:00.000Z"),
    ],
    [
      codexRecord("cred_exhausted", "exhausted"),
      codexRecord("cred_healthy", "healthy"),
    ],
  )
  const statusProvider = new TestCodexStatusProvider(new Map([
    ["cred_exhausted", codexStatus({ fiveHourUsedPercent: 100 })],
    ["cred_healthy", codexStatus({ fiveHourUsedPercent: 20 })],
  ]))
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: statusProvider,
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  })

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_codex",
    bindingOwnerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    sessionId: "session_codex",
  })

  assert.equal(bindingId, "binding_healthy")
  assert.deepEqual(statusProvider.calls, [
    { credentialId: "cred_exhausted", credentialName: "exhausted" },
    { credentialId: "cred_healthy", credentialName: "healthy" },
  ])
})

test("codex_oauth selector throws an explicit error when all candidates are exhausted", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_exhausted_a", "cred_exhausted_a"),
      codexBinding("binding_exhausted_b", "cred_exhausted_b"),
    ],
    [
      codexRecord("cred_exhausted_a", "exhausted a"),
      codexRecord("cred_exhausted_b", "exhausted b"),
    ],
  )
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: new TestCodexStatusProvider(new Map([
      ["cred_exhausted_a", codexStatus({ fiveHourUsedPercent: 100 })],
      ["cred_exhausted_b", codexStatus({ weeklyUsedPercent: 100 })],
    ])),
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  })

  await assert.rejects(
    selector.selectInitialBinding({
      ownerUserId: "user_codex",
      bindingOwnerUserId: "platform:codex_oauth",
      provider: "codex_oauth",
      sessionId: "session_codex",
    }),
    /no_eligible_codex_credentials:all_codex_credentials_exhausted/,
  )
})

test("codex_oauth selector keeps unknown limits and provider errors selectable", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_probe_error", "cred_probe_error", "2026-04-01T00:00:00.000Z"),
      codexBinding("binding_unknown", "cred_unknown", "2026-04-02T00:00:00.000Z"),
      codexBinding("binding_busy", "cred_busy", "2026-04-03T00:00:00.000Z"),
    ],
    [
      codexRecord("cred_probe_error", "probe error"),
      codexRecord("cred_unknown", "unknown"),
      codexRecord("cred_busy", "busy"),
    ],
    [],
    [
      { credentialId: "cred_probe_error", activeLeases: 1 },
      { credentialId: "cred_unknown", activeLeases: 0 },
      { credentialId: "cred_busy", activeLeases: 2 },
    ],
  )
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: new TestCodexStatusProvider(new Map([
      ["cred_probe_error", new Error("probe failed")],
      ["cred_unknown", codexStatus()],
      ["cred_busy", codexStatus({ fiveHourUsedPercent: 20 })],
    ])),
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  })

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_codex",
    bindingOwnerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    sessionId: "session_codex_unknown",
  })

  assert.equal(bindingId, "binding_unknown")
  assert.deepEqual(repository.listActiveLeasesByCredentialCalls, [[
    "cred_probe_error",
    "cred_unknown",
    "cred_busy",
  ]])
})

test("codex_oauth selector sorts by active leases, recent tokens, creation time, then id", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_more_tokens", "cred_more_tokens", "2026-04-01T00:00:00.000Z"),
      codexBinding("binding_newer", "cred_newer", "2026-04-02T00:00:00.000Z"),
      codexBinding("binding_alpha", "cred_alpha", "2026-04-01T00:00:00.000Z"),
      codexBinding("binding_busy", "cred_busy", "2026-04-01T00:00:00.000Z"),
    ],
    [
      codexRecord("cred_more_tokens", "more tokens"),
      codexRecord("cred_newer", "newer"),
      codexRecord("cred_alpha", "alpha"),
      codexRecord("cred_busy", "busy"),
    ],
    [
      { credentialId: "cred_more_tokens", totalTokens: 25, requestCount: 1 },
      { credentialId: "cred_newer", totalTokens: 5, requestCount: 1 },
      { credentialId: "cred_alpha", totalTokens: 5, requestCount: 1 },
    ],
    [
      { credentialId: "cred_busy", activeLeases: 1 },
    ],
  )
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: new TestCodexStatusProvider(new Map()),
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  })

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_codex",
    bindingOwnerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    sessionId: "session_codex_sort",
  })

  assert.equal(bindingId, "binding_alpha")
  assert.equal(repository.listRecentCredentialUsageCalls.length, 1)
  assert.deepEqual(repository.listRecentCredentialUsageCalls[0]?.credentialIds, [
    "cred_more_tokens",
    "cred_newer",
    "cred_alpha",
    "cred_busy",
  ])
  assert.equal(
    repository.listRecentCredentialUsageCalls[0]?.since.toISOString(),
    "2026-04-29T10:00:00.000Z",
  )
})

test("codex_oauth required binding bypasses utilization filtering", async () => {
  const repository = new TestCredentialRepository(
    [codexBinding("binding_fallback", "cred_fallback")],
    [codexRecord("cred_fallback", "fallback")],
  )
  const statusProvider = new TestCodexStatusProvider(new Map([
    ["cred_required", codexStatus({ fiveHourUsedPercent: 100 })],
  ]))
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: statusProvider,
  })

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_codex",
    bindingOwnerUserId: "platform:codex_oauth",
    requiredBindingId: "binding_required",
    provider: "codex_oauth",
    sessionId: "session_codex_required",
  })

  assert.equal(bindingId, "binding_required")
  assert.deepEqual(repository.listEligibleBindingsCalls, [])
  assert.deepEqual(repository.listRecentCredentialUsageCalls, [])
  assert.deepEqual(statusProvider.calls, [])
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
