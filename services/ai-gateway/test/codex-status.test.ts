import assert from "node:assert/strict";
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
