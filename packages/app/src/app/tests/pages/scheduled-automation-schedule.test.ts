import assert from "node:assert/strict";
import test from "node:test";

import { buildSchedule } from "../../pages/scheduled-automation-schedule.js";

const baseOptions = {
  timeValue: "09:00",
  days: ["mo", "tu", "we", "th", "fr", "sa", "su"],
  intervalHours: 6,
  runAtDate: "2026-06-07",
  runAtTime: "09:00",
  quickMinutes: 0,
};

test("buildSchedule preserves local timezone for daily wall-clock schedules", () => {
  assert.deepEqual(buildSchedule("daily", baseOptions, "Europe/Prague"), {
    kind: "daily",
    hour: 9,
    minute: 0,
    timezone: "Europe/Prague",
  });
});

test("buildSchedule maps single Sunday weekly schedules to weekday 7", () => {
  assert.deepEqual(buildSchedule("daily", { ...baseOptions, days: ["su"] }, "Europe/Prague"), {
    kind: "weekly",
    weekday: 7,
    hour: 9,
    minute: 0,
    timezone: "Europe/Prague",
  });
});

test("buildSchedule emits cron schedules for multi-day subsets", () => {
  assert.deepEqual(buildSchedule("daily", { ...baseOptions, days: ["mo", "we", "fr"] }, "Europe/Prague"), {
    kind: "cron",
    expression: "0 9 * * 1,3,5",
    timezone: "Europe/Prague",
  });
});

test("buildSchedule builds interval and one-shot schedules", () => {
  assert.deepEqual(buildSchedule("interval", baseOptions, "Europe/Prague"), {
    kind: "interval",
    seconds: 21_600,
  });
  const oneShot = buildSchedule("oneShot", baseOptions, "Europe/Prague");
  assert.equal(oneShot?.kind, "oneShot");
  assert.equal(Number.isFinite(Date.parse(oneShot?.kind === "oneShot" ? oneShot.runAt : "")), true);
});
