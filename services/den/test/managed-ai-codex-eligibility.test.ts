import assert from "node:assert/strict"
import { test } from "node:test"

import { evaluateCodexCredentialEligibility } from "../src/managed-ai/usage/codex-eligibility.js"
import type { CodexUsageStatus } from "../src/managed-ai/usage/codex-status.js"

const NOW = new Date("2026-04-28T10:00:00.000Z")

function availableStatus(overrides: Partial<CodexUsageStatus> = {}): CodexUsageStatus {
  return {
    available: true,
    source: "codex_exec_rate_limits",
    label: "Codex limits available",
    detail: null,
    checkedAt: NOW.toISOString(),
    limits: {
      fiveHour: null,
      weekly: null,
    },
    ...overrides,
  }
}

function unavailableStatus(detail: string): CodexUsageStatus {
  return {
    available: false,
    source: "unavailable",
    label: "Codex limits unavailable",
    detail,
    checkedAt: NOW.toISOString(),
    limits: {
      fiveHour: null,
      weekly: null,
    },
  }
}

test("five-hour usedPercent 100 is exhausted", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    availableStatus({
      limits: {
        fiveHour: {
          label: "5h",
          usedPercent: 100,
          windowMinutes: 300,
          resetAt: "2026-04-28T11:00:00.000Z",
        },
        weekly: null,
      },
    }),
    NOW,
  )

  assert.equal(eligibility.eligible, false)
  assert.equal(eligibility.state, "exhausted")
  assert.equal(eligibility.resetAt, "2026-04-28T11:00:00.000Z")
})

test("weekly usedPercent 100 is exhausted", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    availableStatus({
      limits: {
        fiveHour: null,
        weekly: {
          label: "Weekly",
          usedPercent: 100,
          windowMinutes: 10080,
          resetAt: "2026-05-05T10:00:00.000Z",
        },
      },
    }),
    NOW,
  )

  assert.equal(eligibility.eligible, false)
  assert.equal(eligibility.state, "exhausted")
  assert.equal(eligibility.resetAt, "2026-05-05T10:00:00.000Z")
})

test("reset time in the past is not exhausted by stale status alone", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    availableStatus({
      limits: {
        fiveHour: {
          label: "5h",
          usedPercent: 100,
          windowMinutes: 300,
          resetAt: "2026-04-28T09:59:59.000Z",
        },
        weekly: null,
      },
    }),
    NOW,
  )

  assert.deepEqual(eligibility, {
    eligible: true,
    state: "eligible",
    reason: null,
  })
})

test("unknown limits are eligible", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    availableStatus({
      source: "codex_exec_no_rate_limits",
      label: "Codex OK, limits unknown",
      detail: "codex | OK | tokens used | 1,499",
      limits: {
        fiveHour: null,
        weekly: null,
      },
    }),
    NOW,
  )

  assert.deepEqual(eligibility, {
    eligible: true,
    state: "eligible",
    reason: null,
  })
})

test("unavailable status with invalid_grant is permanently ineligible", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    unavailableStatus("invalid_grant: refresh token expired"),
    NOW,
  )

  assert.equal(eligibility.eligible, false)
  assert.equal(eligibility.state, "unavailable")
  assert.equal(eligibility.resetAt, null)
})

test("unavailable status with invalid token is permanently ineligible", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    unavailableStatus("ERROR: invalid token"),
    NOW,
  )

  assert.equal(eligibility.eligible, false)
  assert.equal(eligibility.state, "unavailable")
  assert.equal(eligibility.resetAt, null)
})

test("unavailable status with codex login required is permanently ineligible", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    unavailableStatus("Error: Please run `codex login`.\nAuthentication required."),
    NOW,
  )

  assert.equal(eligibility.eligible, false)
  assert.equal(eligibility.state, "unavailable")
  assert.equal(eligibility.resetAt, null)
})

test("unavailable status with transient ERROR stderr is eligible", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    unavailableStatus("ERROR: network timeout while contacting api.openai.com"),
    NOW,
  )

  assert.deepEqual(eligibility, {
    eligible: true,
    state: "eligible",
    reason: null,
  })
})

test("unavailable status with generic probe failure is eligible", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    unavailableStatus("Codex status probe timed out."),
    NOW,
  )

  assert.deepEqual(eligibility, {
    eligible: true,
    state: "eligible",
    reason: null,
  })
})

test("unavailable status with codex probe failed fallback is eligible", () => {
  const eligibility = evaluateCodexCredentialEligibility(
    unavailableStatus("Codex probe failed."),
    NOW,
  )

  assert.deepEqual(eligibility, {
    eligible: true,
    state: "eligible",
    reason: null,
  })
})
