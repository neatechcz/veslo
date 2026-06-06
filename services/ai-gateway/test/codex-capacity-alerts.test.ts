import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexCapacityAlertEmail,
  buildCodexCapacityAlerts,
  shouldEmailCodexCapacityAlert,
} from "../src/alerts/codex-capacity-alerts.js";
import type { CodexCapacityOverview } from "../src/usage/codex-capacity.js";

function createCapacity(overrides: Partial<CodexCapacityOverview> = {}): CodexCapacityOverview {
  return {
    codexCredentials: {
      total: 2,
      measurable: 2,
      unknown: 0,
      unavailable: 0,
    },
    fiveHour: {
      usedPercent: 0,
      remainingPercent: 100,
      measurableCredentials: 2,
    },
    weekly: {
      usedPercent: 0,
      remainingPercent: 100,
      measurableCredentials: 2,
    },
    credentials: [
      {
        id: "cred_codex_1",
        name: "Codex Team One",
        state: "healthy",
        fiveHourRemainingPercent: 8,
        weeklyRemainingPercent: 42,
        statusAvailable: true,
        limitsAvailable: true,
      },
      {
        id: "cred_codex_2",
        name: "Codex Team Two",
        state: "healthy",
        fiveHourRemainingPercent: 12,
        weeklyRemainingPercent: 44,
        statusAvailable: true,
        limitsAvailable: true,
      },
    ],
    ...overrides,
  };
}

test("Codex capacity alerting emits highest crossed 80/90/95/100 thresholds per window", () => {
  const alerts = buildCodexCapacityAlerts(createCapacity({
    fiveHour: {
      usedPercent: 96,
      remainingPercent: 4,
      measurableCredentials: 2,
    },
    weekly: {
      usedPercent: 100,
      remainingPercent: 0,
      measurableCredentials: 2,
    },
  }), "2026-06-06T12:00:00.000Z");

  assert.deepEqual(alerts.map((alert) => ({
    id: alert.id,
    title: alert.title,
    severity: alert.severity,
    source: alert.source,
    status: alert.status,
  })), [
    {
      id: "alert_codex_capacity_five_hour_95",
      title: "Codex 5h limit capacity at 95%",
      severity: "critical",
      source: "codex-capacity",
      status: "active",
    },
    {
      id: "alert_codex_capacity_weekly_100",
      title: "Codex weekly limit capacity exhausted",
      severity: "critical",
      source: "codex-capacity",
      status: "active",
    },
  ]);
  assert.match(alerts[0]?.runbook ?? "", /Codex Team One.*5h 8% remaining.*weekly 42% remaining/);
  assert.match(alerts[1]?.runbook ?? "", /Functional Codex credentials: 2/);
});

test("Codex capacity alerting emits critical visibility alert when no functional limits are visible", () => {
  const alerts = buildCodexCapacityAlerts(createCapacity({
    codexCredentials: {
      total: 2,
      measurable: 0,
      unknown: 1,
      unavailable: 1,
    },
    fiveHour: {
      usedPercent: null,
      remainingPercent: null,
      measurableCredentials: 0,
    },
    weekly: {
      usedPercent: null,
      remainingPercent: null,
      measurableCredentials: 0,
    },
    credentials: [
      {
        id: "cred_unknown",
        name: "Codex Unknown",
        state: "healthy",
        fiveHourRemainingPercent: null,
        weeklyRemainingPercent: null,
        statusAvailable: true,
        limitsAvailable: false,
      },
      {
        id: "cred_unavailable",
        name: "Codex Unavailable",
        state: "healthy",
        fiveHourRemainingPercent: null,
        weeklyRemainingPercent: null,
        statusAvailable: false,
        limitsAvailable: false,
      },
    ],
  }), "2026-06-06T12:00:00.000Z");

  assert.deepEqual(alerts.map((alert) => ({
    id: alert.id,
    title: alert.title,
    severity: alert.severity,
    source: alert.source,
  })), [{
    id: "alert_codex_capacity_limits_unavailable",
    title: "Codex limit visibility unavailable",
    severity: "critical",
    source: "codex-capacity-visibility",
  }]);
  assert.match(alerts[0]?.runbook ?? "", /server cannot see Codex limits/i);
  assert.match(alerts[0]?.runbook ?? "", /Codex Unknown.*limits unknown/);
  assert.match(alerts[0]?.runbook ?? "", /Codex Unavailable.*status unavailable/);
});

test("Codex capacity emails are urgent for 95 percent and critical for 100 percent or invisible limits", () => {
  const capacity = createCapacity({
    fiveHour: {
      usedPercent: 95,
      remainingPercent: 5,
      measurableCredentials: 2,
    },
  });
  const [alert] = buildCodexCapacityAlerts(capacity, "2026-06-06T12:00:00.000Z");
  assert.ok(alert);
  assert.equal(shouldEmailCodexCapacityAlert(alert), true);

  const email = buildCodexCapacityAlertEmail(alert, capacity);
  assert.equal(email.subject, "[URGENT] Codex 5h limit capacity at 95%");
  assert.match(email.text, /Codex Team One: 5h 8% remaining, weekly 42% remaining/);
  assert.match(email.text, /Functional Codex credentials: 2 total, 2 measured, 0 unknown, 0 unavailable/);

  const [criticalAlert] = buildCodexCapacityAlerts(createCapacity({
    fiveHour: {
      usedPercent: 100,
      remainingPercent: 0,
      measurableCredentials: 2,
    },
  }), "2026-06-06T12:00:00.000Z");
  assert.ok(criticalAlert);
  assert.equal(buildCodexCapacityAlertEmail(criticalAlert, capacity).subject, "[CRITICAL] Codex 5h limit capacity exhausted");
});
