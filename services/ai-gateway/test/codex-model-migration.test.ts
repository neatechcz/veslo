import assert from "node:assert/strict";
import test from "node:test";

import {
  runCodexModelMigration,
  type CodexPolicyMigrationStore,
  type CodexPolicySnapshot,
} from "../src/ops/codex-model-migration.js";
import {
  parseMigrationCliArgs,
  runCodexModelMigrationCli,
} from "../src/ops/migrate-codex-model.js";

const TARGET_MODEL = "gpt-5.6-sol";

type StoredPolicy = CodexPolicySnapshot & {
  updatedAt: Date;
};

class InMemoryCodexPolicyMigrationStore implements CodexPolicyMigrationStore {
  previewCalls = 0;
  applyCalls = 0;
  writeCount = 0;

  constructor(readonly rows: StoredPolicy[]) {}

  async preview(): Promise<CodexPolicySnapshot[]> {
    this.previewCalls += 1;
    return this.rows.map(toSnapshot);
  }

  async apply(input: { model: string; now: Date }): Promise<CodexPolicySnapshot[]> {
    this.applyCalls += 1;
    const snapshots = this.rows.map(toSnapshot);
    const allowedModelsJson = JSON.stringify([input.model]);
    const changedIds = new Set(
      snapshots
        .filter((row) => row.defaultModel !== input.model || row.allowedModelsJson !== allowedModelsJson)
        .map((row) => row.id),
    );

    if (changedIds.size > 0) {
      this.writeCount += 1;
      for (const row of this.rows) {
        if (!changedIds.has(row.id)) continue;
        row.defaultModel = input.model;
        row.allowedModelsJson = allowedModelsJson;
        row.updatedAt = input.now;
      }
    }

    return snapshots;
  }
}

test("dry run reports matching policy counts without applying a write", async () => {
  const store = new InMemoryCodexPolicyMigrationStore([
    policy({ id: "policy_enabled", enabled: true, defaultModel: "gpt-5.5" }),
    policy({
      id: "policy_disabled",
      enabled: false,
      defaultModel: TARGET_MODEL,
      allowedModelsJson: JSON.stringify([TARGET_MODEL]),
    }),
  ]);

  const summary = await runCodexModelMigration({ store, model: TARGET_MODEL, apply: false });

  assert.deepEqual(summary, {
    mode: "dry-run",
    model: TARGET_MODEL,
    matchedCount: 2,
    changedCount: 1,
    enabledCount: 1,
    disabledCount: 1,
  });
  assert.equal(store.previewCalls, 1);
  assert.equal(store.applyCalls, 0);
  assert.equal(store.writeCount, 0);
});

test("apply migrates enabled and disabled policies while preserving their assignments", async () => {
  const before = [
    policy({
      id: "policy_enabled",
      userId: "user_enabled",
      enabled: true,
      credentialId: "credential_enabled",
      assignmentOrigin: "admin_assigned",
      defaultModel: "gpt-5.5",
    }),
    policy({
      id: "policy_disabled",
      userId: "user_disabled",
      enabled: false,
      credentialId: "credential_disabled",
      assignmentOrigin: "auto_assigned",
      defaultModel: "gpt-5.4",
      allowedModelsJson: JSON.stringify(["gpt-5.4", "gpt-5.5"]),
    }),
  ];
  const preserved = before.map(({ id, userId, enabled, credentialId, assignmentOrigin }) => ({
    id,
    userId,
    enabled,
    credentialId,
    assignmentOrigin,
  }));
  const store = new InMemoryCodexPolicyMigrationStore(before);
  const now = new Date("2026-07-10T10:00:00.000Z");

  const summary = await runCodexModelMigration({ store, model: TARGET_MODEL, apply: true, now });

  assert.deepEqual(summary, {
    mode: "apply",
    model: TARGET_MODEL,
    matchedCount: 2,
    changedCount: 2,
    enabledCount: 1,
    disabledCount: 1,
  });
  assert.deepEqual(
    store.rows.map(({ id, userId, enabled, credentialId, assignmentOrigin }) => ({
      id,
      userId,
      enabled,
      credentialId,
      assignmentOrigin,
    })),
    preserved,
  );
  assert.deepEqual(store.rows.map((row) => row.defaultModel), [TARGET_MODEL, TARGET_MODEL]);
  assert.deepEqual(store.rows.map((row) => row.allowedModelsJson), [
    JSON.stringify([TARGET_MODEL]),
    JSON.stringify([TARGET_MODEL]),
  ]);
  assert.deepEqual(store.rows.map((row) => row.updatedAt), [now, now]);
  assert.equal(store.writeCount, 1);
});

test("a second apply reports no changes and does not write or update timestamps", async () => {
  const store = new InMemoryCodexPolicyMigrationStore([
    policy({ id: "policy_enabled", enabled: true, defaultModel: "gpt-5.5" }),
    policy({ id: "policy_disabled", enabled: false, defaultModel: "gpt-5.5" }),
  ]);
  const firstNow = new Date("2026-07-10T10:00:00.000Z");
  const secondNow = new Date("2026-07-10T11:00:00.000Z");

  await runCodexModelMigration({ store, model: TARGET_MODEL, apply: true, now: firstNow });
  const timestampsAfterFirstApply = store.rows.map((row) => row.updatedAt);
  const writeCountAfterFirstApply = store.writeCount;
  const summary = await runCodexModelMigration({ store, model: TARGET_MODEL, apply: true, now: secondNow });

  assert.equal(summary.changedCount, 0);
  assert.equal(store.writeCount, writeCountAfterFirstApply);
  assert.deepEqual(store.rows.map((row) => row.updatedAt), timestampsAfterFirstApply);
});

test("summary is limited to mode, model, and aggregate counts", async () => {
  const store = new InMemoryCodexPolicyMigrationStore([
    policy({
      userId: "secret-looking-user",
      credentialId: "credential-with-secret-looking-id",
      assignmentOrigin: "admin_assigned",
    }),
  ]);

  const summary = await runCodexModelMigration({ store, model: TARGET_MODEL, apply: false });
  const serialized = JSON.stringify(summary);

  assert.deepEqual(Object.keys(summary), [
    "mode",
    "model",
    "matchedCount",
    "changedCount",
    "enabledCount",
    "disabledCount",
  ]);
  assert.doesNotMatch(serialized, /credential|user|assignment|secret|token|database/i);
});

test("model ids must match the guarded lowercase model-id format", async () => {
  const store = new InMemoryCodexPolicyMigrationStore([]);

  for (const model of ["", "GPT-5.6-SOL", "gpt/5.6", `g${"x".repeat(128)}`]) {
    await assert.rejects(
      runCodexModelMigration({ store, model, apply: true }),
      /Invalid Codex model id/,
    );
  }
  assert.equal(store.applyCalls, 0);
});

test("CLI arguments default to dry run and the managed Codex default model", () => {
  assert.deepEqual(parseMigrationCliArgs([]), {
    apply: false,
    model: TARGET_MODEL,
  });
  assert.deepEqual(parseMigrationCliArgs(["--apply", "--model", "gpt-5.6-sol.preview_1"]), {
    apply: true,
    model: "gpt-5.6-sol.preview_1",
  });
  assert.throws(() => parseMigrationCliArgs(["--unknown"]), /Invalid migration arguments/);
  assert.throws(() => parseMigrationCliArgs(["--model"]), /Invalid migration arguments/);
  assert.throws(() => parseMigrationCliArgs(["--model", "GPT-5.6-SOL"]), /Invalid Codex model id/);
});

test("CLI uses the configured database, emits one safe JSON summary, and always closes", async () => {
  const store = new InMemoryCodexPolicyMigrationStore([
    policy({ id: "policy_enabled", enabled: true, defaultModel: "gpt-5.5" }),
  ]);
  const openedUrls: string[] = [];
  const output: string[] = [];
  let closeCount = 0;

  await runCodexModelMigrationCli([], {
    databaseUrl: "mysql://user:password@private.example/ai_gateway",
    openStore: (databaseUrl) => {
      openedUrls.push(databaseUrl);
      return {
        store,
        close: async () => {
          closeCount += 1;
        },
      };
    },
    writeOutput: (line) => output.push(line),
  });

  assert.deepEqual(openedUrls, ["mysql://user:password@private.example/ai_gateway"]);
  assert.equal(closeCount, 1);
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0] ?? ""), {
    mode: "dry-run",
    model: TARGET_MODEL,
    matchedCount: 1,
    changedCount: 1,
    enabledCount: 1,
    disabledCount: 0,
  });
  assert.doesNotMatch(output[0] ?? "", /password|private\.example|database/i);
});

test("CLI closes the database and emits no summary when the migration fails", async () => {
  let closeCount = 0;
  const output: string[] = [];
  const failingStore: CodexPolicyMigrationStore = {
    async preview() {
      return [];
    },
    async apply() {
      throw new Error("transaction failed for mysql://user:password@private.example/ai_gateway");
    },
  };

  await assert.rejects(
    runCodexModelMigrationCli(["--apply"], {
      databaseUrl: "mysql://user:password@private.example/ai_gateway",
      openStore: () => ({
        store: failingStore,
        close: async () => {
          closeCount += 1;
        },
      }),
      writeOutput: (line) => output.push(line),
    }),
    /transaction failed/,
  );

  assert.equal(closeCount, 1);
  assert.deepEqual(output, []);
});

function policy(overrides: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: "policy_1",
    userId: "user_1",
    enabled: true,
    credentialId: "credential_1",
    defaultModel: "gpt-5.5",
    allowedModelsJson: JSON.stringify(["gpt-5.5"]),
    assignmentOrigin: "admin_assigned",
    updatedAt: new Date("2026-07-10T09:00:00.000Z"),
    ...overrides,
  };
}

function toSnapshot(row: StoredPolicy): CodexPolicySnapshot {
  return {
    id: row.id,
    userId: row.userId,
    enabled: row.enabled,
    credentialId: row.credentialId,
    defaultModel: row.defaultModel,
    allowedModelsJson: row.allowedModelsJson,
    assignmentOrigin: row.assignmentOrigin,
  };
}
