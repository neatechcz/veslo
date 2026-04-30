import assert from "node:assert/strict";
import test from "node:test";

import type {
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  ListEligibleBindingsInput,
} from "../src/credentials/repository.js";
import { DefaultBindingSelector } from "../src/leases/binding-selector.js";
import { LeaseBroker } from "../src/leases/lease-broker.js";
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../src/leases/repository.js";
import type { CodexCredentialStatusProvider, CodexUsageStatus } from "../src/usage/codex-status.js";

class TestCredentialRepository implements CredentialRepository {
  public readonly listEligibleBindingsCalls: ListEligibleBindingsInput[] = [];
  public readonly listRecentCredentialUsageCalls: Array<{
    credentialIds: string[];
    since: Date;
  }> = [];
  public readonly listActiveLeasesByCredentialCalls: string[][] = [];

  constructor(
    private readonly bindings: CredentialBinding[],
    private readonly records: CredentialRecord[] = [],
    private readonly usage: Array<{ credentialId: string; totalTokens: number; requestCount: number }> = [],
    private readonly activeLeases: Array<{ credentialId: string; activeLeases: number }> = [],
  ) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    return this.records.find((record) => record.id === credentialRecordId) ?? null;
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    const binding = this.bindings.find((entry) => entry.id === bindingId);
    if (!binding) {
      return null;
    }

    return this.getCredentialRecordById(binding.credentialRecordId);
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return [];
  }

  async listEligibleBindings(input: ListEligibleBindingsInput): Promise<CredentialBinding[]> {
    this.listEligibleBindingsCalls.push(input);
    return this.bindings.filter((binding) => {
      return binding.ownerUserId === input.ownerUserId
        && binding.provider === input.provider
        && (!input.excludeBindingId || binding.id !== input.excludeBindingId);
    });
  }

  async listRecentCredentialUsage(input: {
    credentialIds: string[];
    since: Date;
  }): Promise<Array<{ credentialId: string; totalTokens: number; requestCount: number }>> {
    this.listRecentCredentialUsageCalls.push(input);
    return this.usage.filter((entry) => input.credentialIds.includes(entry.credentialId));
  }

  async listActiveLeasesByCredential(credentialIds: string[]): Promise<Array<{ credentialId: string; activeLeases: number }>> {
    this.listActiveLeasesByCredentialCalls.push(credentialIds);
    return this.activeLeases.filter((entry) => credentialIds.includes(entry.credentialId));
  }

  async markCredentialState(): Promise<void> {}
}

function binding(id: string): CredentialBinding {
  return {
    id,
    ownerUserId: "user_1",
    provider: "openai",
    credentialRecordId: `cred_${id}`,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}

function codexBinding(id: string, credentialRecordId = `cred_${id}`, createdAt = "2026-04-01T00:00:00.000Z"): CredentialBinding {
  return {
    id,
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialRecordId,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
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
  };
}

function status(input: {
  available?: boolean;
  fiveHourUsedPercent?: number | null;
  weeklyUsedPercent?: number | null;
  resetAt?: string | null;
  label?: string;
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
  };
}

class TestCodexStatusProvider implements CodexCredentialStatusProvider {
  public readonly calls: Array<{ credentialId: string; credentialName: string }> = [];

  constructor(private readonly statuses: Map<string, CodexUsageStatus | Error>) {}

  async getStatus(input: { credentialId: string; credentialName: string }): Promise<CodexUsageStatus> {
    this.calls.push(input);
    const result = this.statuses.get(input.credentialId);
    if (result instanceof Error) {
      throw result;
    }
    return result ?? status();
  }
}

class TestLeaseRepository implements LeaseRepository {
  private readonly leasesByKey = new Map<string, SessionLease>();
  private leaseIdCounter = 0;
  public createCalls = 0;
  public rebindCalls = 0;

  async getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null> {
    return this.leasesByKey.get(leaseKey(input)) ?? null;
  }

  async createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    const key = leaseKey(input);
    const existing = this.leasesByKey.get(key);
    if (existing) {
      return existing;
    }

    this.createCalls += 1;
    const created: SessionLease = {
      id: `lease_${++this.leaseIdCounter}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    };

    this.leasesByKey.set(key, created);
    return created;
  }

  async rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    const key = leaseKey(input);
    const existing = this.leasesByKey.get(key);
    if (!existing || existing.activeBindingId !== input.expectedCurrentBindingId) {
      return null;
    }

    this.rebindCalls += 1;
    const rebound: SessionLease = {
      ...existing,
      activeBindingId: input.nextBindingId,
    };

    this.leasesByKey.set(key, rebound);
    return rebound;
  }
}

function leaseKey(input: ResolveLeaseInput): string {
  return `${input.ownerUserId}:${input.provider}:${input.sessionId}`;
}

test("rotates initial binding selection across eligible bindings in the same pool", async () => {
  const selector = new DefaultBindingSelector(
    new TestCredentialRepository([
      binding("binding_alpha"),
      binding("binding_beta"),
      binding("binding_gamma"),
    ]),
  );

  const first = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_1",
  });
  const second = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_2",
  });
  const third = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_3",
  });
  const fourth = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_4",
  });

  assert.deepEqual([first, second, third, fourth], [
    "binding_alpha",
    "binding_beta",
    "binding_gamma",
    "binding_alpha",
  ]);
});

test("replacement selection excludes the failed binding", async () => {
  const repository = new TestCredentialRepository([
    binding("binding_alpha"),
    binding("binding_beta"),
    binding("binding_gamma"),
  ]);
  const selector = new DefaultBindingSelector(repository);

  const replacement = await selector.selectReplacementBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_rebind",
    previousBindingId: "binding_alpha",
  });

  assert.equal(replacement, "binding_beta");
  assert.deepEqual(repository.listEligibleBindingsCalls, [
    {
      ownerUserId: "user_1",
      provider: "openai",
      excludeBindingId: "binding_alpha",
    },
  ]);
});

test("codex_oauth skips exhausted credentials when another healthy binding exists", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_exhausted", "cred_exhausted", "2026-04-01T00:00:00.000Z"),
      codexBinding("binding_healthy", "cred_healthy", "2026-04-02T00:00:00.000Z"),
    ],
    [
      codexRecord("cred_exhausted", "exhausted"),
      codexRecord("cred_healthy", "healthy"),
    ],
  );
  const statusProvider = new TestCodexStatusProvider(new Map([
    ["cred_exhausted", status({ fiveHourUsedPercent: 100 })],
    ["cred_healthy", status({ fiveHourUsedPercent: 20 })],
  ]));
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: statusProvider,
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  });

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    sessionId: "session_codex",
  });

  assert.equal(bindingId, "binding_healthy");
  assert.deepEqual(statusProvider.calls, [
    { credentialId: "cred_exhausted", credentialName: "exhausted" },
    { credentialId: "cred_healthy", credentialName: "healthy" },
  ]);
});

test("codex_oauth keeps unknown limit credentials selectable", async () => {
  const repository = new TestCredentialRepository(
    [codexBinding("binding_unknown", "cred_unknown")],
    [codexRecord("cred_unknown", "unknown")],
  );
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: new TestCodexStatusProvider(new Map([
      ["cred_unknown", status()],
    ])),
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  });

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    sessionId: "session_codex",
  });

  assert.equal(bindingId, "binding_unknown");
});

test("codex_oauth throws when all candidates are exhausted", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_exhausted_a", "cred_exhausted_a"),
      codexBinding("binding_exhausted_b", "cred_exhausted_b"),
    ],
    [
      codexRecord("cred_exhausted_a", "exhausted a"),
      codexRecord("cred_exhausted_b", "exhausted b"),
    ],
  );
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: new TestCodexStatusProvider(new Map([
      ["cred_exhausted_a", status({ fiveHourUsedPercent: 100 })],
      ["cred_exhausted_b", status({ weeklyUsedPercent: 100 })],
    ])),
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  });

  await assert.rejects(
    selector.selectInitialBinding({
      ownerUserId: "user_1",
      bindingOwnerUserId: "platform:codex_oauth",
      provider: "codex_oauth",
      sessionId: "session_codex",
    }),
    /no_eligible_codex_credentials:all_codex_credentials_exhausted/,
  );
});

test("codex_oauth required binding remains selectable when assigned status is unknown or provider errors", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_required_unknown", "cred_required_unknown"),
      codexBinding("binding_required_error", "cred_required_error"),
      codexBinding("binding_fallback", "cred_fallback"),
    ],
    [
      codexRecord("cred_required_unknown", "required unknown"),
      codexRecord("cred_required_error", "required error"),
      codexRecord("cred_fallback", "fallback"),
    ],
  );
  const statusProvider = new TestCodexStatusProvider(new Map([
    ["cred_required_unknown", status()],
    ["cred_required_error", new Error("probe failed")],
    ["cred_fallback", status({ fiveHourUsedPercent: 20 })],
  ]));
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: statusProvider,
  });

  const unknown = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    requiredBindingId: "binding_required_unknown",
    provider: "codex_oauth",
    sessionId: "session_codex",
  });
  const providerError = await selector.selectReplacementBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    requiredBindingId: "binding_required_error",
    provider: "codex_oauth",
    sessionId: "session_codex",
    previousBindingId: "binding_required_error",
  });

  assert.equal(unknown, "binding_required_unknown");
  assert.equal(providerError, "binding_required_error");
  assert.deepEqual(repository.listEligibleBindingsCalls, []);
  assert.deepEqual(repository.listRecentCredentialUsageCalls, []);
  assert.deepEqual(statusProvider.calls, [
    { credentialId: "cred_required_unknown", credentialName: "required unknown" },
    { credentialId: "cred_required_error", credentialName: "required error" },
  ]);
});

test("codex_oauth required binding fails explicitly when assigned credential is permanently unavailable", async () => {
  const selector = new DefaultBindingSelector({
    credentials: new TestCredentialRepository(
      [codexBinding("binding_required", "cred_required")],
      [codexRecord("cred_required", "required")],
    ),
    codexStatusProvider: new TestCodexStatusProvider(new Map([
      ["cred_required", {
        ...status({ available: false, label: "HTTP error: 401 Unauthorized" }),
        detail: "refresh token revoked",
      }],
    ])),
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  });

  await assert.rejects(
    selector.selectInitialBinding({
      ownerUserId: "user_1",
      bindingOwnerUserId: "platform:codex_oauth",
      requiredBindingId: "binding_required",
      provider: "codex_oauth",
      sessionId: "session_required_unavailable",
    }),
    /no_eligible_codex_credentials:assigned_credential_exhausted/,
  );
});

test("codex_oauth selector probes candidate status with bounded concurrency", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseStatuses: (() => void) | null = null;
  const statusesReleased = new Promise<void>((resolve) => {
    releaseStatuses = resolve;
  });
  const statusProvider: CodexCredentialStatusProvider = {
    async getStatus() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight === 4) {
        releaseStatuses?.();
      }

      await statusesReleased;
      inFlight -= 1;
      return status({ fiveHourUsedPercent: 20 });
    },
  };
  const selector = new DefaultBindingSelector({
    credentials: new TestCredentialRepository(
      [
        codexBinding("binding_a", "cred_a"),
        codexBinding("binding_b", "cred_b"),
        codexBinding("binding_c", "cred_c"),
        codexBinding("binding_d", "cred_d"),
        codexBinding("binding_e", "cred_e"),
        codexBinding("binding_f", "cred_f"),
      ],
      [
        codexRecord("cred_a", "a"),
        codexRecord("cred_b", "b"),
        codexRecord("cred_c", "c"),
        codexRecord("cred_d", "d"),
        codexRecord("cred_e", "e"),
        codexRecord("cred_f", "f"),
      ],
    ),
    codexStatusProvider: statusProvider,
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  });

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    sessionId: "session_codex_concurrency",
  });

  assert.equal(bindingId, "binding_a");
  assert.ok(maxInFlight > 1);
  assert.ok(maxInFlight <= 4);
});

test("codex_oauth required binding fails explicitly when assigned credential is exhausted", async () => {
  const leases = new TestLeaseRepository();
  const broker = new LeaseBroker(
    leases,
    new DefaultBindingSelector({
      credentials: new TestCredentialRepository(
        [
          codexBinding("binding_required", "cred_required"),
          codexBinding("binding_fallback", "cred_fallback"),
        ],
        [
          codexRecord("cred_required", "required"),
          codexRecord("cred_fallback", "fallback"),
        ],
      ),
      codexStatusProvider: new TestCodexStatusProvider(new Map([
        ["cred_required", status({ fiveHourUsedPercent: 100 })],
        ["cred_fallback", status({ fiveHourUsedPercent: 20 })],
      ])),
      now: () => new Date("2026-04-30T10:00:00.000Z"),
    }),
  );

  await assert.rejects(
    broker.getOrCreateActiveLease({
      ownerUserId: "user_1",
      bindingOwnerUserId: "platform:codex_oauth",
      requiredBindingId: "binding_required",
      provider: "codex_oauth",
      sessionId: "session_required_exhausted",
    }),
    /no_eligible_codex_credentials:assigned_credential_exhausted/,
  );
  assert.equal(leases.createCalls, 0);
});

test("codex_oauth existing lease on required binding is rejected when assigned credential becomes exhausted", async () => {
  const leases = new TestLeaseRepository();
  await leases.createLeaseIfMissing({
    ownerUserId: "user_1",
    provider: "codex_oauth",
    sessionId: "session_existing_required",
    activeBindingId: "binding_required",
  });
  const broker = new LeaseBroker(
    leases,
    new DefaultBindingSelector({
      credentials: new TestCredentialRepository(
        [codexBinding("binding_required", "cred_required")],
        [codexRecord("cred_required", "required")],
      ),
      codexStatusProvider: new TestCodexStatusProvider(new Map([
        ["cred_required", status({ weeklyUsedPercent: 100 })],
      ])),
      now: () => new Date("2026-04-30T10:00:00.000Z"),
    }),
  );

  await assert.rejects(
    broker.getOrCreateActiveLease({
      ownerUserId: "user_1",
      bindingOwnerUserId: "platform:codex_oauth",
      requiredBindingId: "binding_required",
      provider: "codex_oauth",
      sessionId: "session_existing_required",
    }),
    /no_eligible_codex_credentials:assigned_credential_exhausted/,
  );
});

test("codex_oauth existing lease is not rebound to an exhausted required binding", async () => {
  const leases = new TestLeaseRepository();
  await leases.createLeaseIfMissing({
    ownerUserId: "user_1",
    provider: "codex_oauth",
    sessionId: "session_existing_other",
    activeBindingId: "binding_other",
  });
  const broker = new LeaseBroker(
    leases,
    new DefaultBindingSelector({
      credentials: new TestCredentialRepository(
        [
          codexBinding("binding_other", "cred_other"),
          codexBinding("binding_required", "cred_required"),
        ],
        [
          codexRecord("cred_other", "other"),
          codexRecord("cred_required", "required"),
        ],
      ),
      codexStatusProvider: new TestCodexStatusProvider(new Map([
        ["cred_required", status({ fiveHourUsedPercent: 100 })],
      ])),
      now: () => new Date("2026-04-30T10:00:00.000Z"),
    }),
  );

  await assert.rejects(
    broker.getOrCreateActiveLease({
      ownerUserId: "user_1",
      bindingOwnerUserId: "platform:codex_oauth",
      requiredBindingId: "binding_required",
      provider: "codex_oauth",
      sessionId: "session_existing_other",
    }),
    /no_eligible_codex_credentials:assigned_credential_exhausted/,
  );
  assert.equal(leases.rebindCalls, 0);
});

test("codex_oauth sorts eligible candidates by active leases from the focused repository API", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_busy", "cred_busy", "2026-04-01T00:00:00.000Z"),
      codexBinding("binding_idle", "cred_idle", "2026-04-02T00:00:00.000Z"),
    ],
    [
      codexRecord("cred_busy", "busy"),
      codexRecord("cred_idle", "idle"),
    ],
    [],
    [
      { credentialId: "cred_busy", activeLeases: 2 },
      { credentialId: "cred_idle", activeLeases: 0 },
    ],
  );
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: new TestCodexStatusProvider(new Map()),
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  });

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    sessionId: "session_codex_leases",
  });

  assert.equal(bindingId, "binding_idle");
  assert.deepEqual(repository.listActiveLeasesByCredentialCalls, [["cred_busy", "cred_idle"]]);
});

test("codex_oauth keeps a candidate selectable when status probing throws", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_probe_error", "cred_probe_error", "2026-04-01T00:00:00.000Z"),
      codexBinding("binding_busy", "cred_busy", "2026-04-02T00:00:00.000Z"),
    ],
    [
      codexRecord("cred_probe_error", "probe error"),
      codexRecord("cred_busy", "busy"),
    ],
    [],
    [
      { credentialId: "cred_probe_error", activeLeases: 0 },
      { credentialId: "cred_busy", activeLeases: 1 },
    ],
  );
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: new TestCodexStatusProvider(new Map([
      ["cred_probe_error", new Error("probe failed")],
      ["cred_busy", status({ fiveHourUsedPercent: 20 })],
    ])),
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  });

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    sessionId: "session_codex_probe_error",
  });

  assert.equal(bindingId, "binding_probe_error");
});

test("codex_oauth uses binding id as deterministic final tie-breaker", async () => {
  const repository = new TestCredentialRepository(
    [
      codexBinding("binding_zulu", "cred_zulu", "2026-04-01T00:00:00.000Z"),
      codexBinding("binding_alpha", "cred_alpha", "2026-04-01T00:00:00.000Z"),
    ],
    [
      codexRecord("cred_zulu", "zulu"),
      codexRecord("cred_alpha", "alpha"),
    ],
  );
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: new TestCodexStatusProvider(new Map()),
    now: () => new Date("2026-04-30T10:00:00.000Z"),
  });

  const bindingId = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    sessionId: "session_codex_tie",
  });

  assert.equal(bindingId, "binding_alpha");
});
