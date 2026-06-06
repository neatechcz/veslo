import assert from "node:assert/strict"
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CachedCodexCredentialStatusProvider,
  codexUsageStatusFromRateLimits,
  parseRateLimitsFromSessionLog,
} from "../src/managed-ai/usage/codex-status.js"

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
  ].join("\n")

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
  })
})

test("parseRateLimitsFromSessionLog reads current Codex payload rate limits", () => {
  const sessionLog = [
    JSON.stringify({
      timestamp: "2026-06-06T03:46:56.983Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 18976,
            cached_input_tokens: 3456,
            output_tokens: 612,
            reasoning_output_tokens: 516,
            total_tokens: 19588,
          },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: "codex",
          primary: {
            used_percent: 8,
            window_minutes: 300,
            resets_at: 1780735110,
          },
          secondary: {
            used_percent: 46,
            window_minutes: 10080,
            resets_at: 1781147826,
          },
          plan_type: "pro",
        },
      },
    }),
  ].join("\n")

  assert.deepEqual(parseRateLimitsFromSessionLog(sessionLog), {
    primary: {
      used_percent: 8,
      window_minutes: 300,
      resets_at: 1780735110,
    },
    secondary: {
      used_percent: 46,
      window_minutes: 10080,
      resets_at: 1781147826,
    },
    plan_type: "pro",
  })
})

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
  ].join("\n")

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
  })
})

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
  )

  assert.equal(status.available, true)
  assert.equal(status.source, "codex_exec_rate_limits")
  assert.equal(status.label, "Codex limits available")
  assert.equal(status.planType, "plus")
  assert.equal(status.limits?.fiveHour?.label, "5h")
  assert.equal(status.limits?.fiveHour?.usedPercent, 30)
  assert.equal(status.limits?.weekly?.label, "Weekly")
  assert.equal(status.limits?.weekly?.usedPercent, 33)
})

test("CachedCodexCredentialStatusProvider reports healthy probes with unknown limits", async () => {
  const provider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date("2026-04-28T10:00:00.000Z"),
    loadCredentialAuthJson: async () => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt" } }),
    probe: async () => ({
      checkedAt: "2026-04-28T10:00:00.000Z",
      rateLimits: null,
      ok: true,
      detail: "codex | OK | tokens used | 1,499",
    }),
  })

  const status = await provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  })

  assert.equal(status.available, true)
  assert.equal(status.source, "codex_exec_no_rate_limits")
  assert.equal(status.label, "Codex OK, limits unknown")
  assert.equal(status.detail, "codex | OK | tokens used | 1,499")
  assert.equal(status.limits?.fiveHour, null)
  assert.equal(status.limits?.weekly, null)
})

test("CachedCodexCredentialStatusProvider maps Codex usage-limit stderr to exhausted 5h limits", async () => {
  const detail =
    "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:38 AM."
  const provider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date("2026-06-06T06:24:41.343Z"),
    loadCredentialAuthJson: async () => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt" } }),
    probe: async () => ({
      checkedAt: "2026-06-06T06:24:41.343Z",
      rateLimits: null,
      ok: false,
      detail,
    }),
  })

  const status = await provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Vaclav CODEX",
  })

  assert.equal(status.available, true)
  assert.equal(status.source, "codex_exec_rate_limits")
  assert.equal(status.label, "Codex limits available")
  assert.equal(status.detail, detail)
  assert.equal(status.limits?.fiveHour?.label, "5h")
  assert.equal(status.limits?.fiveHour?.usedPercent, 100)
  assert.equal(status.limits?.fiveHour?.windowMinutes, 300)
  assert.equal(status.limits?.fiveHour?.resetAt, null)
  assert.equal(status.limits?.weekly, null)
})

test("CachedCodexCredentialStatusProvider keeps successful probe status when temporary cleanup fails", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "veslo-codex-status-cleanup-test-"))
  const commandPath = path.join(rootDir, "fake-codex.cjs")
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "refresh-token",
      account_id: "acct",
    },
  })

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
  )
  await chmod(commandPath, 0o755)

  try {
    const provider = new CachedCodexCredentialStatusProvider({
      ttlMs: 5 * 60 * 1000,
      now: () => new Date("2026-04-26T12:00:00.000Z"),
      loadCredentialAuthJson: async () => authJson,
      command: commandPath,
      workDir: rootDir,
      timeoutMs: 5000,
    })

    const status = await provider.getStatus({
      credentialId: "cred_codex_1",
      credentialName: "Credential cred_codex_1",
    })

    assert.equal(status.available, true)
    assert.equal(status.source, "codex_exec_rate_limits")
    assert.equal(status.limits?.fiveHour?.usedPercent, 30)
  } finally {
    await makeTreeWritable(rootDir)
    await rm(rootDir, { recursive: true, force: true })
  }
})

async function makeTreeWritable(root: string): Promise<void> {
  await chmod(root, 0o700).catch(() => {})
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(root, entry.name)
      if (entry.isDirectory()) {
        await makeTreeWritable(resolved)
      } else {
        await chmod(resolved, 0o600).catch(() => {})
      }
    }),
  )
}
