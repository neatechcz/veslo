import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSchedule } from "./scheduled-automation-schedule";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scheduledSource = () => readFileSync(join(__dirname, "scheduled.tsx"), "utf8");
const scheduleHelperSource = () => readFileSync(join(__dirname, "scheduled-automation-schedule.ts"), "utf8");

test("ScheduledTasksView keeps server automations on API handlers instead of prompt/session routing", () => {
  const source = scheduledSource();

  assert.match(source, /automations:\s*VesloAutomation\[\]/);
  assert.match(source, /createAutomation:\s*\(/);
  assert.match(source, /runAutomation:\s*\(/);
  assert.match(source, /deleteAutomation:\s*\(/);
  assert.match(source, /legacyScheduledJobs:\s*ScheduledJob\[\]/);
  assert.match(source, /legacyScheduledJobs/);

  const primaryCreate = source.match(/const handleCreateAutomation[\s\S]*?};/);
  assert.ok(primaryCreate);
  assert.match(primaryCreate[0], /props\.createAutomation/);
  assert.doesNotMatch(primaryCreate[0], /props\.setPrompt|props\.createSessionAndOpen/);

  const primaryRun = source.match(/const runAutomationNow[\s\S]*?};/);
  assert.ok(primaryRun);
  assert.match(primaryRun[0], /props\.runAutomation/);
  assert.doesNotMatch(primaryRun[0], /props\.setPrompt|props\.createSessionAndOpen/);
});

test("ScheduledTasksView builds server-compatible weekly schedules and gates legacy fallback", () => {
  const source = scheduledSource();
  const helperSource = scheduleHelperSource();

  assert.match(helperSource, /id:\s*"su"[\s\S]*?weekday:\s*7/);
  assert.doesNotMatch(helperSource, /id:\s*"su"[\s\S]*?weekday:\s*0/);
  assert.match(source, /if\s*\(props\.sourceReady\)\s*return false;/);
  assert.match(source, /scheduled\.label_fallback_title/);
  assert.doesNotMatch(source, /scheduled\.label_projects|scheduled\.placeholder_folder/);
});

test("buildSchedule preserves local timezone for recurring wall-clock schedules", () => {
  const baseOptions = {
    timeValue: "09:00",
    days: ["mo", "tu", "we", "th", "fr", "sa", "su"],
    intervalHours: 6,
    runAtDate: "2026-06-07",
    runAtTime: "09:00",
    quickMinutes: 0,
  };

  assert.deepEqual(buildSchedule("daily", baseOptions, "Europe/Prague"), {
    kind: "daily",
    hour: 9,
    minute: 0,
    timezone: "Europe/Prague",
  });

  assert.deepEqual(buildSchedule("daily", { ...baseOptions, days: ["su"] }, "Europe/Prague"), {
    kind: "weekly",
    weekday: 7,
    hour: 9,
    minute: 0,
    timezone: "Europe/Prague",
  });

  assert.deepEqual(buildSchedule("daily", { ...baseOptions, days: ["mo", "we", "fr"] }, "Europe/Prague"), {
    kind: "cron",
    expression: "0 9 * * 1,3,5",
    timezone: "Europe/Prague",
  });

  assert.deepEqual(buildSchedule("interval", baseOptions, "Europe/Prague"), {
    kind: "interval",
    seconds: 21600,
  });
});
