import assert from "node:assert/strict";
import test from "node:test";

import type { AdminCredentialRecord } from "../src/credentials/repository.js";
import {
  runCodexCredentialProbe,
  type CodexCredentialProbeRepository,
} from "../src/ops/codex-credential-probe.js";
import {
  parseCredentialProbeCliArgs,
  runCodexCredentialProbeCli,
  type CodexCredentialProbeCliRuntime,
} from "../src/ops/probe-codex-credentials.js";
import {
  CachedCodexCredentialStatusProvider,
  type CodexCredentialStatusProvider,
  type CodexUsageStatus,
} from "../src/usage/codex-status.js";

const TARGET_MODEL = "gpt-5.6-sol";
const CHECKED_AT = "2026-07-10T12:00:00.000Z";

test("credential coordinator probes every non-deleted Codex credential sequentially in id order", async () => {
  const credentials = [
    credential({ id: "cred_c", name: "C", state: "degraded" }),
    credential({ id: "cred_deleted", name: "Deleted", deletedAt: CHECKED_AT }),
    credential({ id: "cred_other", name: "Other", provider: "openai" }),
    credential({ id: "cred_a", name: "A", state: "healthy" }),
    credential({ id: "cred_b", name: "B", state: "unhealthy" }),
  ];
  const repository = repositoryWith(credentials);
  const callOrder: string[] = [];
  let activeCalls = 0;
  let maxConcurrentCalls = 0;
  const statusProvider: CodexCredentialStatusProvider = {
    async getStatus(input) {
      callOrder.push(input.credentialId);
      activeCalls += 1;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeCalls -= 1;

      if (input.credentialId === "cred_a") {
        return healthyStatus();
      }
      if (input.credentialId === "cred_b") {
        return {
          ...healthyStatus(),
          unsupportedModels: [TARGET_MODEL],
        };
      }
      return unavailableStatus("invalid_grant while refreshing OAuth credential");
    },
  };

  const results = await runCodexCredentialProbe({
    repository,
    statusProvider,
    model: TARGET_MODEL,
    now: () => new Date(CHECKED_AT),
  });

  assert.equal(maxConcurrentCalls, 1);
  assert.deepEqual(callOrder, ["cred_a", "cred_b", "cred_c"]);
  assert.deepEqual(results.map((entry) => entry.credentialId), callOrder);
  assert.deepEqual(results.map((entry) => entry.storedHealth), ["healthy", "unhealthy", "degraded"]);
  assert.deepEqual(results.map((entry) => entry.outcome), ["ok", "unsupported_model", "auth_failed"]);
  assert.equal(results.length, 3);
  assert.doesNotMatch(JSON.stringify(results), /refresh[_-]?token|access[_-]?token|secret/i);
});

test("credential coordinator continues after throws and reports exhaustion and generic failures", async () => {
  const credentials = [
    credential({ id: "cred_a", name: "A" }),
    credential({ id: "cred_b", name: "B" }),
    credential({ id: "cred_c", name: "C" }),
  ];
  const callOrder: string[] = [];
  const statusProvider: CodexCredentialStatusProvider = {
    async getStatus(input) {
      callOrder.push(input.credentialId);
      if (input.credentialId === "cred_a") {
        throw new Error("private upstream failure with access_token=never-print-this");
      }
      if (input.credentialId === "cred_b") {
        return {
          ...healthyStatus(),
          limits: {
            fiveHour: {
              label: "5h",
              usedPercent: 100,
              windowMinutes: 300,
              resetAt: "2026-07-10T13:00:00.000Z",
            },
            weekly: null,
          },
        };
      }
      return healthyStatus();
    },
  };

  const results = await runCodexCredentialProbe({
    repository: repositoryWith(credentials),
    statusProvider,
    model: TARGET_MODEL,
    now: () => new Date(CHECKED_AT),
  });

  assert.deepEqual(callOrder, ["cred_a", "cred_b", "cred_c"]);
  assert.deepEqual(results.map((entry) => entry.outcome), ["probe_failed", "usage_exhausted", "ok"]);
  assert.doesNotMatch(JSON.stringify(results), /never-print-this|access[_-]?token|detail/i);
});

test("credential coordinator recognizes invalid grant, login, invalid token, and reused refresh auth failures", async () => {
  const authFailures = new Map<string, string>([
    ["cred_a", "invalid_grant"],
    ["cred_b", "Codex login required"],
    ["cred_c", "authentication token invalid"],
    ["cred_d", "refresh token has already been used"],
  ]);
  const credentials = Array.from(authFailures.keys(), (id) => credential({ id, name: id }));

  const results = await runCodexCredentialProbe({
    repository: repositoryWith(credentials),
    statusProvider: {
      async getStatus(input) {
        return unavailableStatus(authFailures.get(input.credentialId) ?? "unknown failure");
      },
    },
    model: TARGET_MODEL,
    now: () => new Date(CHECKED_AT),
  });

  assert.deepEqual(results.map((entry) => entry.outcome), [
    "auth_failed",
    "auth_failed",
    "auth_failed",
    "auth_failed",
  ]);
});

test("credential coordinator classifies other unavailable statuses as probe failures", async () => {
  const results = await runCodexCredentialProbe({
    repository: repositoryWith([credential({ id: "cred_a", name: "A" })]),
    statusProvider: {
      async getStatus() {
        return unavailableStatus("Codex status probe timed out.");
      },
    },
    model: TARGET_MODEL,
    now: () => new Date(CHECKED_AT),
  });

  assert.equal(results[0]?.outcome, "probe_failed");
});

test("credential coordinator distinguishes failed, unsupported, and exhausted probes that retain rate limits", async () => {
  const credentials = [
    credential({ id: "cred_unsupported", name: "Unsupported" }),
    credential({ id: "cred_failed", name: "Failed" }),
    credential({ id: "cred_exhausted", name: "Exhausted" }),
  ];
  const statusProvider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date(CHECKED_AT),
    loadCredentialAuthJson: async () => JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { refresh_token: "rt", account_id: "acct" },
    }),
    probe: async ({ credentialId }) => ({
      checkedAt: CHECKED_AT,
      rateLimits: {
        primary: {
          used_percent: credentialId === "cred_exhausted" ? 100 : 20,
          window_minutes: 300,
          resets_at: 1783692000,
        },
        secondary: null,
        plan_type: "plus",
      },
      ok: false,
      detail: credentialId === "cred_unsupported"
        ? "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
        : "Codex subprocess exited before completing the requested probe.",
    }),
  });

  const results = await runCodexCredentialProbe({
    repository: repositoryWith(credentials),
    statusProvider,
    model: TARGET_MODEL,
    now: () => new Date(CHECKED_AT),
  });

  assert.deepEqual(results.map((entry) => entry.credentialId), [
    "cred_exhausted",
    "cred_failed",
    "cred_unsupported",
  ]);
  assert.deepEqual(results.map((entry) => entry.outcome), [
    "usage_exhausted",
    "probe_failed",
    "unsupported_model",
  ]);
});

test("probe CLI accepts exactly one optional pnpm separator and validates the model strictly", () => {
  assert.deepEqual(parseCredentialProbeCliArgs([]), { model: TARGET_MODEL });
  assert.deepEqual(parseCredentialProbeCliArgs(["--model", "gpt-5.6-sol.preview_1"]), {
    model: "gpt-5.6-sol.preview_1",
  });
  assert.deepEqual(parseCredentialProbeCliArgs(["--", "--model", TARGET_MODEL]), { model: TARGET_MODEL });

  assert.throws(() => parseCredentialProbeCliArgs(["--", "--", "--model", TARGET_MODEL]), /Invalid probe arguments/);
  assert.throws(() => parseCredentialProbeCliArgs(["--model"]), /Invalid probe arguments/);
  assert.throws(() => parseCredentialProbeCliArgs(["--model", TARGET_MODEL, "--model", TARGET_MODEL]), /Invalid probe arguments/);
  assert.throws(() => parseCredentialProbeCliArgs(["--model", "GPT-5.6-SOL"]), /Invalid Codex model id/);
});

test("probe CLI package argument shape reaches the database boundary and emits only safe fields", async () => {
  const databaseUrl = "mysql://operator:password@private.example/ai_gateway";
  const secretKey = "private-secret-key-that-must-never-be-printed";
  const opened: Array<{ databaseUrl: string; secretKey: string; model: string }> = [];
  const output: string[] = [];
  let closeCount = 0;
  const runtime = runtimeWith({
    credentials: [
      credential({ id: "cred_b", name: "Second", state: "unhealthy" }),
      credential({ id: "cred_a", name: "First", state: "healthy" }),
    ],
    statuses: new Map([
      ["cred_a", healthyStatus()],
      ["cred_b", unavailableStatus("Codex status probe timed out with access_token=never-print")],
    ]),
    onClose: () => {
      closeCount += 1;
    },
  });

  const exitCode = await runCodexCredentialProbeCli(["--", "--model", TARGET_MODEL], {
    databaseUrl,
    secretKey,
    openRuntime(input) {
      opened.push(input);
      return runtime;
    },
    writeOutput(line) {
      output.push(line);
    },
  });

  assert.deepEqual(opened, [{ databaseUrl, secretKey, model: TARGET_MODEL }]);
  assert.equal(closeCount, 1);
  assert.equal(exitCode, 1);
  assert.equal(output.length, 1);

  const summary = JSON.parse(output[0] ?? "") as Record<string, unknown>;
  assert.deepEqual(Object.keys(summary), ["model", "total", "passed", "failed", "credentials"]);
  assert.deepEqual(
    (summary.credentials as Array<Record<string, unknown>>).map((entry) => Object.keys(entry)),
    [
      ["credentialId", "displayName", "storedHealth", "outcome", "statusLabel", "elapsedMs"],
      ["credentialId", "displayName", "storedHealth", "outcome", "statusLabel", "elapsedMs"],
    ],
  );
  assert.deepEqual(
    (summary.credentials as Array<Record<string, unknown>>).map((entry) => entry.outcome),
    ["ok", "probe_failed"],
  );
  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.doesNotMatch(output[0] ?? "", /operator|password|private\.example|access[_-]?token|never-print|secretKey|databaseUrl/i);
});

test("probe CLI closes the database and emits nothing when credential listing fails", async () => {
  let closeCount = 0;
  const output: string[] = [];
  const runtime: CodexCredentialProbeCliRuntime = {
    repository: {
      async listAdminCredentials() {
        throw new Error("database failed at mysql://operator:password@private.example/ai_gateway");
      },
    },
    statusProvider: {
      async getStatus() {
        return healthyStatus();
      },
    },
    async close() {
      closeCount += 1;
    },
  };

  await assert.rejects(
    runCodexCredentialProbeCli([], {
      databaseUrl: "mysql://operator:password@private.example/ai_gateway",
      secretKey: "private-secret-key-that-must-never-be-printed",
      openRuntime: () => runtime,
      writeOutput: (line) => output.push(line),
    }),
    /database failed/,
  );

  assert.equal(closeCount, 1);
  assert.deepEqual(output, []);
});

function credential(overrides: Partial<AdminCredentialRecord> = {}): AdminCredentialRecord {
  return {
    id: "cred_1",
    name: "Codex credential",
    provider: "codex_oauth",
    type: "oauth",
    state: "healthy",
    scope: "platform:codex_oauth",
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: CHECKED_AT,
    lastFailureAt: null,
    cachedTokens: 0,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
    ...overrides,
  };
}

function repositoryWith(credentials: AdminCredentialRecord[]): CodexCredentialProbeRepository {
  return {
    async listAdminCredentials() {
      return credentials;
    },
  };
}

function healthyStatus(): CodexUsageStatus {
  return {
    available: true,
    probeSucceeded: true,
    source: "codex_exec_rate_limits",
    label: "Codex limits available",
    detail: null,
    checkedAt: CHECKED_AT,
    limits: {
      fiveHour: {
        label: "5h",
        usedPercent: 10,
        windowMinutes: 300,
        resetAt: "2026-07-10T13:00:00.000Z",
      },
      weekly: null,
    },
  };
}

function unavailableStatus(detail: string): CodexUsageStatus {
  return {
    available: false,
    source: "unavailable",
    label: "Codex limits unavailable",
    detail,
    checkedAt: CHECKED_AT,
    limits: {
      fiveHour: null,
      weekly: null,
    },
  };
}

function runtimeWith(input: {
  credentials: AdminCredentialRecord[];
  statuses: Map<string, CodexUsageStatus>;
  onClose(): void;
}): CodexCredentialProbeCliRuntime {
  return {
    repository: repositoryWith(input.credentials),
    statusProvider: {
      async getStatus(statusInput) {
        return input.statuses.get(statusInput.credentialId) ?? healthyStatus();
      },
    },
    async close() {
      input.onClose();
    },
  };
}
