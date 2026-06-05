import { expect, test } from "bun:test";

import {
  computeNextAutomationRunAt,
  parseAutomationSchedule,
  parseAutomationStatus,
} from "./automations.js";

test("parses one-shot schedule with ISO runAt", () => {
  const schedule = parseAutomationSchedule({
    kind: "oneShot",
    runAt: "2026-06-06T07:00:00.000Z",
    timezone: "Europe/Prague",
  });

  expect(schedule).toEqual({
    kind: "oneShot",
    runAt: "2026-06-06T07:00:00.000Z",
    timezone: "Europe/Prague",
  });
});

test("computes next one-shot run only before completion", () => {
  const schedule = parseAutomationSchedule({
    kind: "oneShot",
    runAt: "2026-06-06T07:00:00.000Z",
  });

  expect(computeNextAutomationRunAt(schedule, Date.parse("2026-06-05T07:00:00.000Z"))).toBe("2026-06-06T07:00:00.000Z");
  expect(computeNextAutomationRunAt(schedule, Date.parse("2026-06-07T07:00:00.000Z"))).toBe("2026-06-06T07:00:00.000Z");
});

test("computes daily and weekly next run times", () => {
  expect(computeNextAutomationRunAt(
    { kind: "daily", hour: 9, minute: 0, timezone: "Europe/Prague" },
    Date.parse("2026-06-05T06:00:00.000Z"),
  )).toBe("2026-06-05T07:00:00.000Z");

  expect(computeNextAutomationRunAt(
    { kind: "weekly", weekday: 1, hour: 9, minute: 0, timezone: "Europe/Prague" },
    Date.parse("2026-06-05T06:00:00.000Z"),
  )).toBe("2026-06-08T07:00:00.000Z");
});

test("computes cron next run in timezone", () => {
  expect(computeNextAutomationRunAt(
    { kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Prague" },
    Date.parse("2026-06-05T08:30:00.000Z"),
  )).toBe("2026-06-08T07:00:00.000Z");
});

test("rejects invalid schedule and status payloads", () => {
  expect(() => parseAutomationSchedule({ kind: "oneShot", runAt: "tomorrow" })).toThrow("schedule.runAt");
  expect(() => parseAutomationSchedule({ kind: "interval", seconds: 10 })).toThrow("schedule.seconds");
  expect(() => parseAutomationSchedule({ kind: "cron", expression: "" })).toThrow("schedule.expression");
  expect(() => parseAutomationStatus("unknown")).toThrow("status");
});
