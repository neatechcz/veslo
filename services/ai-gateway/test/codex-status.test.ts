import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CachedCodexCredentialStatusProvider,
  codexUsageStatusFromRateLimits,
  parseRateLimitsFromSessionLog,
} from "../src/usage/codex-status.js";

test("parseRateLimitsFromSessionLog reads Codex token_count rate limits", () => {
  const sessionLog = [
    JSON.stringify({
      timestamp: "2026-04-26T12:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
          },
          rate_limits: {
            limit_id: "codex",
            primary: {
              used_percent: 30,
              window_minutes: 300,
              resets_at: 1777215600,
            },
            secondary: {
              used_percent: 33,
              window_minutes: 10080,
              resets_at: 1777816800,
            },
            plan_type: "plus",
          },
        },
      },
    }),
  ].join("\n");

  assert.deepEqual(parseRateLimitsFromSessionLog(sessionLog), {
    primary: {
      used_percent: 30,
      window_minutes: 300,
      resets_at: 1777215600,
    },
    secondary: {
      used_percent: 33,
      window_minutes: 10080,
      resets_at: 1777816800,
    },
    plan_type: "plus",
  });
});

test("parseRateLimitsFromSessionLog finds nested Codex rate limits with string numbers", () => {
  const sessionLog = [
    JSON.stringify({
      timestamp: "2026-04-28T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: {
          metadata: {
            rate_limits: {
              primary: {
                used_percent: "72.5",
                window_minutes: "300",
                resets_at: "1777370400",
              },
              secondary: {
                used_percent: "41",
                window_minutes: "10080",
                resets_at: "1777816800",
              },
              plan_type: "team",
            },
          },
        },
      },
    }),
  ].join("\n");

  assert.deepEqual(parseRateLimitsFromSessionLog(sessionLog), {
    primary: {
      used_percent: 72.5,
      window_minutes: 300,
      resets_at: 1777370400,
    },
    secondary: {
      used_percent: 41,
      window_minutes: 10080,
      resets_at: 1777816800,
    },
    plan_type: "team",
  });
});

test("parseRateLimitsFromSessionLog ignores top-level rate limits during fallback search", () => {
  const sessionLog = [
    JSON.stringify({
      timestamp: "2026-04-28T10:00:00.000Z",
      type: "event_msg",
      rate_limits: {
        primary: {
          used_percent: 99,
          window_minutes: 300,
          resets_at: 1777370400,
        },
        plan_type: "top-level",
      },
      payload: {
        type: "agent_message",
        message: {
          metadata: {
            rate_limits: {
              primary: {
                used_percent: "72.5",
                window_minutes: "300",
                resets_at: "1777370400",
              },
              plan_type: "team",
            },
          },
        },
      },
    }),
  ].join("\n");

  assert.deepEqual(parseRateLimitsFromSessionLog(sessionLog), {
    primary: {
      used_percent: 72.5,
      window_minutes: 300,
      resets_at: 1777370400,
    },
    secondary: null,
    plan_type: "team",
  });
});

test("parseRateLimitsFromSessionLog skips invalid newer rate limits and finds older valid snapshot", () => {
  const sessionLog = [
    JSON.stringify({
      timestamp: "2026-04-28T09:55:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: {
          metadata: {
            rate_limits: {
              primary: {
                used_percent: "42",
                window_minutes: "300",
                resets_at: "1777370400",
              },
              plan_type: "team",
            },
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-04-28T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: {
          metadata: {
            rate_limits: {
              primary: {
                used_percent: "90",
                window_minutes: "not-a-number",
                resets_at: "1777370400",
              },
              secondary: {},
              plan_type: "team",
            },
          },
        },
      },
    }),
  ].join("\n");

  assert.deepEqual(parseRateLimitsFromSessionLog(sessionLog), {
    primary: {
      used_percent: 42,
      window_minutes: 300,
      resets_at: 1777370400,
    },
    secondary: null,
    plan_type: "team",
  });
});

test("codexUsageStatusFromRateLimits exposes 5h and weekly windows", () => {
  const status = codexUsageStatusFromRateLimits(
    {
      primary: {
        used_percent: 30,
        window_minutes: 300,
        resets_at: 1777215600,
      },
      secondary: {
        used_percent: 33,
        window_minutes: 10080,
        resets_at: 1777816800,
      },
      plan_type: "plus",
    },
    "2026-04-26T12:00:00.000Z",
  );

  assert.equal(status.available, true);
  assert.equal(status.source, "codex_exec_rate_limits");
  assert.equal(status.label, "Codex limits available");
  assert.equal(status.planType, "plus");
  assert.equal(status.limits?.fiveHour?.label, "5h");
  assert.equal(status.limits?.fiveHour?.usedPercent, 30);
  assert.equal(status.limits?.weekly?.label, "Weekly");
  assert.equal(status.limits?.weekly?.usedPercent, 33);
});

test("codexUsageStatusFromRateLimits keeps partial 5h and weekly windows distinct", () => {
  const status = codexUsageStatusFromRateLimits(
    {
      primary: {
        used_percent: 88,
        window_minutes: 10080,
        resets_at: 1777816800,
      },
      plan_type: "plus",
    },
    "2026-04-28T10:00:00.000Z",
  );

  assert.equal(status.limits?.fiveHour, null);
  assert.equal(status.limits?.weekly?.label, "Weekly");
  assert.equal(status.limits?.weekly?.usedPercent, 88);
});

test("CachedCodexCredentialStatusProvider reuses recent probe results", async () => {
  let probeCalls = 0;
  let nowMs = Date.parse("2026-04-26T12:00:00.000Z");
  const provider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date(nowMs),
    loadCredentialAuthJson: async () => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt", account_id: "acct" } }),
    probe: async () => {
      probeCalls += 1;
      return {
        checkedAt: new Date(nowMs).toISOString(),
        rateLimits: {
          primary: {
            used_percent: 30,
            window_minutes: 300,
            resets_at: 1777215600,
          },
          secondary: {
            used_percent: 33,
            window_minutes: 10080,
            resets_at: 1777816800,
          },
          plan_type: "plus",
        },
      };
    },
  });

  const first = await provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  });
  const second = await provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  });

  assert.equal(probeCalls, 1);
  assert.deepEqual(second, first);

  nowMs += 6 * 60 * 1000;
  await provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  });

  assert.equal(probeCalls, 2);
});

test("CachedCodexCredentialStatusProvider shares concurrent probes for the same credential", async () => {
  let probeCalls = 0;
  let releaseProbe: (() => void) | undefined;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const provider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date("2026-04-26T12:00:00.000Z"),
    loadCredentialAuthJson: async () => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt", account_id: "acct" } }),
    probe: async () => {
      probeCalls += 1;
      await probeGate;
      return {
        checkedAt: "2026-04-26T12:00:00.000Z",
        rateLimits: {
          primary: {
            used_percent: 30,
            window_minutes: 300,
            resets_at: 1777215600,
          },
          secondary: {
            used_percent: 33,
            window_minutes: 10080,
            resets_at: 1777816800,
          },
          plan_type: "plus",
        },
      };
    },
  });

  const firstStatus = provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  });
  const secondStatus = provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  });

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  releaseProbe?.();

  const [first, second] = await Promise.all([firstStatus, secondStatus]);

  assert.equal(probeCalls, 1);
  assert.deepEqual(second, first);
});

test("CachedCodexCredentialStatusProvider persists refreshed Codex auth JSON from probes", async () => {
  const savedAuthJson: Array<{ credentialId: string; authJson: string }> = [];
  const provider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date("2026-04-26T12:00:00.000Z"),
    loadCredentialAuthJson: async () => JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: "old-refresh-token",
        account_id: "acct",
      },
    }),
    saveCredentialAuthJson: async (credentialId, authJson) => {
      savedAuthJson.push({ credentialId, authJson });
    },
    probe: async () => ({
      checkedAt: "2026-04-26T12:00:00.000Z",
      updatedAuthJson: JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "new-refresh-token",
          account_id: "acct",
        },
      }),
      rateLimits: {
        primary: {
          used_percent: 30,
          window_minutes: 300,
          resets_at: 1777215600,
        },
        secondary: null,
        plan_type: "plus",
      },
    }),
  });

  await provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  });

  assert.deepEqual(savedAuthJson, [
    {
      credentialId: "cred_codex_1",
      authJson: JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          refresh_token: "new-refresh-token",
          account_id: "acct",
        },
      }),
    },
  ]);
});

test("CachedCodexCredentialStatusProvider does not rewrite unchanged Codex auth JSON", async () => {
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "same-refresh-token",
      account_id: "acct",
    },
  });
  const savedAuthJson: string[] = [];
  const provider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date("2026-04-26T12:00:00.000Z"),
    loadCredentialAuthJson: async () => authJson,
    saveCredentialAuthJson: async (_credentialId, nextAuthJson) => {
      savedAuthJson.push(nextAuthJson);
    },
    probe: async () => ({
      checkedAt: "2026-04-26T12:00:00.000Z",
      updatedAuthJson: authJson,
      rateLimits: {
        primary: {
          used_percent: 30,
          window_minutes: 300,
          resets_at: 1777215600,
        },
        secondary: null,
        plan_type: "plus",
      },
    }),
  });

  await provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  });

  assert.deepEqual(savedAuthJson, []);
});

test("CachedCodexCredentialStatusProvider persists auth JSON written by the Codex subprocess", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "veslo-codex-status-test-"));
  const commandPath = path.join(rootDir, "fake-codex.cjs");
  const savedAuthJson: Array<{ credentialId: string; authJson: string }> = [];
  const oldAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "old-refresh-token",
      account_id: "acct",
    },
  });
  const newAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "new-refresh-token",
      account_id: "acct",
    },
  });

  await writeFile(
    commandPath,
    [
      "#!/usr/bin/env node",
      'const { mkdirSync, writeFileSync } = require("node:fs");',
      'const path = require("node:path");',
      `writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), ${JSON.stringify(`${newAuthJson}\n`)});`,
      'const sessionDir = path.join(process.env.CODEX_HOME, "sessions", "2026", "04", "26");',
      "mkdirSync(sessionDir, { recursive: true });",
      "const event = {",
      '  timestamp: "2026-04-26T12:00:00.000Z",',
      '  type: "event_msg",',
      "  payload: {",
      '    type: "token_count",',
      "    info: {",
      "      rate_limits: {",
      "        primary: { used_percent: 30, window_minutes: 300, resets_at: 1777215600 },",
      "        secondary: null,",
      '        plan_type: "plus",',
      "      },",
      "    },",
      "  },",
      "};",
      'writeFileSync(path.join(sessionDir, "probe.jsonl"), `${JSON.stringify(event)}\\n`);',
      'console.log("OK");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(commandPath, 0o755);

  try {
    const provider = new CachedCodexCredentialStatusProvider({
      ttlMs: 5 * 60 * 1000,
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      loadCredentialAuthJson: async () => oldAuthJson,
      saveCredentialAuthJson: async (credentialId, authJson) => {
        savedAuthJson.push({ credentialId, authJson });
      },
      command: commandPath,
      workDir: rootDir,
      timeoutMs: 5000,
    });

    const status = await provider.getStatus({
      credentialId: "cred_codex_1",
      credentialName: "Credential cred_codex_1",
    });

    assert.equal(status.available, true);
    assert.deepEqual(savedAuthJson, [
      {
        credentialId: "cred_codex_1",
        authJson: newAuthJson,
      },
    ]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("CachedCodexCredentialStatusProvider keeps successful probe status when temporary cleanup fails", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "veslo-codex-status-cleanup-test-"));
  const commandPath = path.join(rootDir, "fake-codex.cjs");
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "refresh-token",
      account_id: "acct",
    },
  });

  await writeFile(
    commandPath,
    [
      "#!/usr/bin/env node",
      'const { chmodSync, mkdirSync, writeFileSync } = require("node:fs");',
      'const path = require("node:path");',
      'const sessionDir = path.join(process.env.CODEX_HOME, "sessions", "2026", "04", "26");',
      "mkdirSync(sessionDir, { recursive: true });",
      "const event = {",
      '  timestamp: "2026-04-26T12:00:00.000Z",',
      '  type: "event_msg",',
      "  payload: {",
      '    type: "token_count",',
      "    info: {",
      "      rate_limits: {",
      "        primary: { used_percent: 30, window_minutes: 300, resets_at: 1777215600 },",
      "        secondary: null,",
      '        plan_type: "plus",',
      "      },",
      "    },",
      "  },",
      "};",
      'writeFileSync(path.join(sessionDir, "probe.jsonl"), `${JSON.stringify(event)}\\n`);',
      'const lockedDir = path.join(process.env.CODEX_HOME, "cleanup-blocked");',
      "mkdirSync(lockedDir, { recursive: true });",
      'writeFileSync(path.join(lockedDir, "kept.txt"), "kept");',
      "chmodSync(lockedDir, 0o500);",
      'console.log("OK");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(commandPath, 0o755);

  try {
    const provider = new CachedCodexCredentialStatusProvider({
      ttlMs: 5 * 60 * 1000,
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      loadCredentialAuthJson: async () => authJson,
      command: commandPath,
      workDir: rootDir,
      timeoutMs: 5000,
    });

    const status = await provider.getStatus({
      credentialId: "cred_codex_1",
      credentialName: "Credential cred_codex_1",
    });

    assert.equal(status.available, true);
    assert.equal(status.source, "codex_exec_rate_limits");
    assert.equal(status.limits?.fiveHour?.usedPercent, 30);
  } finally {
    await makeTreeWritable(rootDir);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("CachedCodexCredentialStatusProvider reports healthy probes with unknown limits", async () => {
  const provider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date("2026-04-28T10:00:00.000Z"),
    loadCredentialAuthJson: async () => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt", account_id: "acct" } }),
    probe: async () => ({
      checkedAt: "2026-04-28T10:00:00.000Z",
      rateLimits: null,
      ok: true,
      detail: "codex | OK | tokens used | 1,499",
    }),
  });

  const status = await provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  });

  assert.equal(status.available, true);
  assert.equal(status.source, "codex_exec_no_rate_limits");
  assert.equal(status.label, "Codex OK, limits unknown");
  assert.equal(status.detail, "codex | OK | tokens used | 1,499");
  assert.equal(status.limits?.fiveHour, null);
  assert.equal(status.limits?.weekly, null);
});

test("CachedCodexCredentialStatusProvider keeps credentials available when one Codex model is unsupported", async () => {
  const provider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date("2026-06-04T15:14:57.039Z"),
    loadCredentialAuthJson: async () => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt", account_id: "acct" } }),
    probe: async () => ({
      checkedAt: "2026-06-04T15:14:57.039Z",
      rateLimits: null,
      ok: false,
      detail: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
    }),
  });

  const status = await provider.getStatus({
    credentialId: "cred_codex_vaclav",
    credentialName: "Vaclav CODEX",
  });

  assert.equal(status.available, true);
  assert.equal(status.source, "codex_exec_no_rate_limits");
  assert.equal(status.label, "Codex OK, limits unknown");
  assert.equal(status.detail, "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.");
  assert.deepEqual(status.unsupportedModels, ["gpt-5.3-codex"]);
});

async function makeTreeWritable(root: string): Promise<void> {
  await chmod(root, 0o700).catch(() => {});
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await makeTreeWritable(resolved);
      } else {
        await chmod(resolved, 0o600).catch(() => {});
      }
    }),
  );
}
