import { expect, test } from "bun:test";

import {
  computeNextAutomationRunAt,
  parseAutomationSchedule,
  parseAutomationRunStatus,
  parseAutomationStatus,
} from "../automations.js";
import { ApiError } from "../errors.js";

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

test("computes missing timezone schedules in UTC", () => {
  expect(computeNextAutomationRunAt(
    { kind: "daily", hour: 9, minute: 0 },
    Date.parse("2026-06-05T08:00:00.000Z"),
  )).toBe("2026-06-05T09:00:00.000Z");

  expect(computeNextAutomationRunAt(
    { kind: "cron", expression: "0 9 * * *" },
    Date.parse("2026-06-05T08:00:00.000Z"),
  )).toBe("2026-06-05T09:00:00.000Z");
});

test("rejects invalid schedule and status payloads", () => {
  expectInvalidPayload(() => parseAutomationSchedule({ kind: "oneShot", runAt: "tomorrow" }), "schedule.runAt");
  expectInvalidPayload(() => parseAutomationSchedule({ kind: "interval", seconds: 10 }), "schedule.seconds");
  expectInvalidPayload(() => parseAutomationSchedule({ kind: "cron", expression: "" }), "schedule.expression");
  expectInvalidPayload(() => parseAutomationStatus("unknown"), "status");
  expectInvalidPayload(() => parseAutomationRunStatus("unknown"), "status");
});

test("rejects invalid timezone and non-canonical ISO instants", () => {
  expectInvalidPayload(
    () => parseAutomationSchedule({ kind: "daily", hour: 9, minute: 0, timezone: "Not/AZone" }),
    "schedule.timezone",
  );
  expectInvalidPayload(
    () => parseAutomationSchedule({ kind: "oneShot", runAt: "2026-06-06T07:00:00Z" }),
    "schedule.runAt",
  );
  expectInvalidPayload(
    () => parseAutomationSchedule({ kind: "oneShot", runAt: "2026-06-06T09:00:00.000+02:00" }),
    "schedule.runAt",
  );
});

test("rejects invalid date ranges during schedule computation", () => {
  expectInvalidPayload(
    () => computeNextAutomationRunAt({ kind: "daily", hour: 9, minute: 0 }, 8.64e15 + 1),
    "fromMs",
  );
  expectInvalidPayload(
    () => computeNextAutomationRunAt({ kind: "interval", seconds: 60 }, 8.64e15),
    "scheduled date",
  );
});

function expectInvalidPayload(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe("invalid_payload");
    expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error("Expected invalid_payload ApiError");
}
