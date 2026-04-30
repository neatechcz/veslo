import assert from "node:assert/strict";
import test from "node:test";

import type {
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  ListEligibleBindingsInput,
} from "../src/credentials/repository.js";
import { DefaultBindingSelector } from "../src/leases/binding-selector.js";
import type { CodexCredentialStatusProvider, CodexUsageStatus } from "../src/usage/codex-status.js";

class TestCredentialRepository implements CredentialRepository {
  public readonly listEligibleBindingsCalls: ListEligibleBindingsInput[] = [];
  public readonly listRecentCredentialUsageCalls: Array<{
    credentialIds: string[];
    since: Date;
  }> = [];

  constructor(
    private readonly bindings: CredentialBinding[],
    private readonly records: CredentialRecord[] = [],
    private readonly usage: Array<{ credentialId: string; totalTokens: number; requestCount: number }> = [],
  ) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    return this.records.find((record) => record.id === credentialRecordId) ?? null;
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

  constructor(private readonly statuses: Map<string, CodexUsageStatus>) {}

  async getStatus(input: { credentialId: string; credentialName: string }): Promise<CodexUsageStatus> {
    this.calls.push(input);
    return this.statuses.get(input.credentialId) ?? status();
  }
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

test("codex_oauth required binding returns without fallback or utilization filtering", async () => {
  const repository = new TestCredentialRepository(
    [codexBinding("binding_fallback", "cred_fallback")],
    [codexRecord("cred_fallback", "fallback")],
  );
  const statusProvider = new TestCodexStatusProvider(new Map([
    ["cred_required", status({ fiveHourUsedPercent: 100 })],
  ]));
  const selector = new DefaultBindingSelector({
    credentials: repository,
    codexStatusProvider: statusProvider,
  });

  const initial = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    requiredBindingId: "binding_required",
    provider: "codex_oauth",
    sessionId: "session_codex",
  });
  const replacement = await selector.selectReplacementBinding({
    ownerUserId: "user_1",
    bindingOwnerUserId: "platform:codex_oauth",
    requiredBindingId: "binding_required",
    provider: "codex_oauth",
    sessionId: "session_codex",
    previousBindingId: "binding_required",
  });

  assert.equal(initial, "binding_required");
  assert.equal(replacement, "binding_required");
  assert.deepEqual(repository.listEligibleBindingsCalls, []);
  assert.deepEqual(repository.listRecentCredentialUsageCalls, []);
  assert.deepEqual(statusProvider.calls, []);
});
