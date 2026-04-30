import assert from "node:assert/strict"
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
